-- GitHub: a workspace connects the Claritia GitHub App, then links a repository to one of its projects.
-- Each pull request (or each preview deploy of one) runs the project's tests and gets a "Claritia" check
-- that fails on a real failure. The server keeps the checks up to date: the database calls it when a run of
-- a check finishes (pg_net), and again every minute while any check is open, in case a call was missed.

-- An installation of the GitHub App, connected to one workspace. Only the server adds them, after GitHub
-- confirms the person who installed it can reach it.
create table if not exists public.github_installations (
  id bigint primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_login text not null,
  account_type text not null default 'User',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists github_installations_ws on public.github_installations (workspace_id);
alter table public.github_installations enable row level security;
create policy "members read" on public.github_installations for select using (is_member(workspace_id));
revoke all on public.github_installations from anon;
revoke insert, update, delete on public.github_installations from authenticated;

-- A repository linked to a project: which environment its pull requests run on (or each preview deploy's
-- own address), and which tests.
create table if not exists public.github_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  installation_id bigint not null references public.github_installations (id) on delete cascade,
  repo_id bigint not null,
  repo_full_name text not null check (repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  -- 'pull_request': every push to a pull request runs on the environment. 'preview': each successful
  -- preview deploy (Vercel, Netlify, Render...) runs on the deploy's own address.
  run_on text not null default 'pull_request' check (run_on in ('pull_request', 'preview')),
  environment_id uuid not null references public.environments (id) on delete cascade,
  scope text not null default 'all' check (scope in ('all', 'use_case')),
  use_case text,
  enabled boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (project_id, repo_id, run_on)
);
create index if not exists github_links_repo on public.github_links (repo_id) where enabled;
alter table public.github_links enable row level security;
create policy "members all" on public.github_links for all using (is_member(workspace_id)) with check (is_member(workspace_id));
revoke all on public.github_links from anon;

-- A link's workspace comes from its project; its environment and installation must belong there too.
create or replace function public.github_links_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select workspace_id into new.workspace_id from projects where id = new.project_id;
  if new.workspace_id is null then
    raise exception 'Project not found';
  end if;
  if not exists (select 1 from environments where id = new.environment_id and project_id = new.project_id) then
    raise exception 'Pick an environment from this project';
  end if;
  if not exists (select 1 from github_installations where id = new.installation_id and workspace_id = new.workspace_id) then
    raise exception 'Connect GitHub to this workspace first';
  end if;
  if new.scope = 'use_case' and coalesce(new.use_case, '') = '' then
    raise exception 'Pick a use case';
  end if;
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
create trigger github_links_prepare before insert or update on public.github_links
for each row execute function public.github_links_prepare();

-- One check on one commit: the runs it started and the GitHub check run that shows them.
create table if not exists public.github_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  link_id uuid not null references public.github_links (id) on delete cascade,
  installation_id bigint not null,
  repo_full_name text not null,
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  pr_number int,
  base_url text not null,
  run_ids uuid[] not null default '{}',
  check_run_id bigint,
  status text not null default 'pending' check (status in ('pending', 'done')),
  conclusion text,
  finished_count int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  synced_at timestamptz
);
create unique index if not exists github_checks_open on public.github_checks (link_id, head_sha, base_url) where status = 'pending';
create index if not exists github_checks_pending on public.github_checks (created_at) where status = 'pending';
create index if not exists github_checks_runs on public.github_checks using gin (run_ids) where status = 'pending';
alter table public.github_checks enable row level security;
create policy "members read" on public.github_checks for select using (is_member(workspace_id));
revoke all on public.github_checks from anon;
revoke insert, update, delete on public.github_checks from authenticated;

-- Start a check: queue the link's tests (up to 50) on the environment, or on a preview deploy's address.
-- Returns nothing when the same commit and address already has an open check. A check that can't run
-- (no tests, cloud minutes used up) is saved as done with the reason, so the server can still post it.
create or replace function public.github_start_check(p_link uuid, p_sha text, p_pr int, p_base_url text default null)
returns setof github_checks
language plpgsql security definer set search_path = public as $$
declare
  l github_links;
  e environments;
  t tests;
  u record;
  c github_checks;
  ids uuid[] := '{}';
  url text;
begin
  select * into l from github_links where id = p_link and enabled;
  if l.id is null then
    return;
  end if;
  select * into e from environments where id = l.environment_id;
  url := coalesce(nullif(trim(p_base_url), ''), e.base_url);
  if url !~ '^https?://[^\s/]+' then
    raise exception 'Not a web address: %', url;
  end if;
  e.base_url := url;
  if exists (select 1 from github_checks where link_id = l.id and head_sha = p_sha and base_url = url and status = 'pending') then
    return;
  end if;

  select * into u from workspace_usage(l.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, pr_number, base_url, status, conclusion, error)
    values (l.workspace_id, l.id, l.installation_id, l.repo_full_name, p_sha, p_pr, url, 'done', 'neutral', 'This month''s cloud minutes are used up.')
    returning * into c;
    return next c;
    return;
  end if;

  for t in
    select * from tests
    where project_id = l.project_id
      and jsonb_array_length(coalesce(steps, '[]')) > 0
      and (l.scope = 'all' or use_case = l.use_case)
    order by use_case, name
    limit 50
  loop
    ids := ids || queue_run(t, e, 'ci', l.created_by);
  end loop;

  insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, pr_number, base_url, run_ids, status, conclusion, error)
  values (l.workspace_id, l.id, l.installation_id, l.repo_full_name, p_sha, p_pr, url, ids,
          case when cardinality(ids) = 0 then 'done' else 'pending' end,
          case when cardinality(ids) = 0 then 'neutral' end,
          case when cardinality(ids) = 0 then 'No tests with steps to run.' end)
  returning * into c;
  return next c;
end;
$$;

insert into public.app_config (key, value) values ('github_sync_url', '') on conflict (key) do nothing;
insert into public.app_config (key, value)
values ('github_sync_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Ask the server to bring open checks up to date, at most every 3 seconds.
create or replace function public.github_sync() returns void
language plpgsql security definer set search_path = public as $$
declare
  url text;
  secret text;
  last timestamptz;
begin
  select value into url from app_config where key = 'github_sync_url';
  select value into secret from app_config where key = 'github_sync_secret';
  if coalesce(url, '') = '' or to_regproc('net.http_post') is null then
    return;
  end if;
  select updated_at into last from app_config where key = 'github_last_sync';
  if last is not null and last > now() - interval '3 seconds' then
    return;
  end if;
  insert into app_config (key, value, updated_at) values ('github_last_sync', '', now())
  on conflict (key) do update set updated_at = now();
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
  using url, jsonb_build_object('content-type', 'application/json', 'x-claritia-sync', secret);
end;
$$;

-- A run of an open check finished, or was re-run: update the check.
create or replace function public.runs_github_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('passed', 'failed', 'error', 'canceled')
     and exists (select 1 from github_checks where status = 'pending' and run_ids @> array[coalesce(new.retry_of, new.id)]) then
    perform github_sync();
  end if;
  return null;
end;
$$;
create trigger runs_github_sync after update of status on public.runs
for each row when (old.status is distinct from new.status) execute function public.runs_github_sync();

-- The minute tick also syncs open checks that haven't been synced for a minute.
create or replace function public.minute_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform fire_due_schedules();
  if exists (select 1 from runs where status = 'queued' and created_at < now() - interval '20 seconds') then
    perform wake_runner();
  end if;
  if exists (select 1 from github_checks where status = 'pending' and coalesce(synced_at, created_at) < now() - interval '1 minute') then
    perform github_sync();
  end if;
end;
$$;

revoke execute on function public.github_links_prepare() from public, anon, authenticated;
revoke execute on function public.github_start_check(uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.github_start_check(uuid, text, int, text) to service_role;
revoke execute on function public.github_sync() from public, anon, authenticated;
revoke execute on function public.runs_github_sync() from public, anon, authenticated;
revoke execute on function public.minute_tick() from public, anon, authenticated;
