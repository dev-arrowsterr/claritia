-- The Explorer and the app map. Explore crawls a project's environment with a few browsers at once, following links
-- on the same site, and saves each kind of page it finds: its address pattern, title, forms, main buttons, a
-- screenshot, and (from Claude) a name and what people do there. Pages found again are updated, so the map grows.
-- An exploration uses cloud minutes and AI credits like a run.

create table if not exists public.explorations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  environment_id uuid references public.environments (id) on delete set null,
  environment_name text not null,
  base_url text not null,
  -- A test whose saved code signs in first, so the Explorer sees the pages behind the sign-in.
  sign_in_test_id uuid references public.tests (id) on delete set null,
  max_pages int not null default 50 check (max_pages between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'canceled')),
  pages_found int not null default 0,
  error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms int,
  ai_calls int not null default 0,
  ai_input_tokens int not null default 0,
  ai_output_tokens int not null default 0,
  locked_by text,
  locked_at timestamptz,
  attempts int not null default 0
);
create index if not exists explorations_project on public.explorations (project_id, created_at desc);
create index if not exists explorations_queue on public.explorations (status, created_at) where status in ('queued', 'running');
alter table public.explorations enable row level security;
create policy "members read" on public.explorations for select using (is_member(workspace_id));
revoke all on public.explorations from anon;
revoke insert, update, delete on public.explorations from authenticated;

create table if not exists public.app_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  exploration_id uuid references public.explorations (id) on delete set null,
  -- The page's address with ids swapped for :id, like /orders/:id. One row per pattern.
  pattern text not null check (length(pattern) between 1 and 500),
  sample_url text not null,
  title text,
  name text,
  purpose text,
  status_code int,
  -- Headings, forms (with their fields) and main buttons, for the Planner.
  elements jsonb not null default '{}',
  screenshot_path text,
  depth int not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (project_id, pattern)
);
alter table public.app_pages enable row level security;
create policy "members read" on public.app_pages for select using (is_member(workspace_id));
create policy "members delete" on public.app_pages for delete using (is_member(workspace_id));
revoke all on public.app_pages from anon;
revoke insert, update on public.app_pages from authenticated;

create table if not exists public.app_links (
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_page uuid not null references public.app_pages (id) on delete cascade,
  to_page uuid not null references public.app_pages (id) on delete cascade,
  primary key (from_page, to_page)
);
create index if not exists app_links_project on public.app_links (project_id);
alter table public.app_links enable row level security;
create policy "members read" on public.app_links for select using (is_member(workspace_id));
revoke all on public.app_links from anon;
revoke insert, update, delete on public.app_links from authenticated;

-- Start an exploration of one of the project's environments. One at a time per project, within the plan.
create or replace function public.start_exploration(p_project uuid, p_env uuid, p_max_pages int default 50, p_sign_in_test uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pr projects;
  e environments;
  u record;
  xid uuid;
begin
  select * into pr from projects where id = p_project;
  if pr.id is null or not is_member(pr.workspace_id) then
    raise exception 'Project not found';
  end if;
  select * into e from environments where id = p_env and project_id = p_project;
  if e.id is null then
    raise exception 'Environment not found';
  end if;
  if p_sign_in_test is not null and not exists (select 1 from tests where id = p_sign_in_test and project_id = p_project and coalesce(lock, '') <> '') then
    raise exception 'The sign-in test needs saved code: run it once first';
  end if;
  if exists (select 1 from explorations where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'This project is already being explored';
  end if;
  select * into u from workspace_usage(pr.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    raise exception 'This month''s % cloud minutes are used up. Upgrade in Settings to keep exploring.', u.minutes_limit;
  end if;
  insert into explorations (workspace_id, project_id, environment_id, environment_name, base_url, sign_in_test_id, max_pages, created_by)
  values (pr.workspace_id, p_project, e.id, e.name, e.base_url, p_sign_in_test, least(greatest(coalesce(p_max_pages, 50), 1), 200), auth.uid())
  returning id into xid;
  return xid;
end;
$$;

create or replace function public.cancel_exploration(p_exploration uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update explorations set status = 'canceled', finished_at = now()
  where id = p_exploration and status in ('queued', 'running') and is_member(workspace_id);
  if not found then
    raise exception 'Nothing to stop';
  end if;
end;
$$;

-- The runner takes the oldest waiting exploration, or one whose runner went quiet for ten minutes (up to three tries).
create or replace function public.claim_exploration(p_worker text) returns setof explorations
language plpgsql security definer set search_path = public as $$
declare
  x explorations;
begin
  update explorations set status = 'error', error = 'The runner stopped three times on this exploration.', finished_at = now()
  where status = 'running' and locked_at < now() - interval '10 minutes' and attempts >= 3;
  select * into x from explorations
  where status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes')
  order by created_at
  limit 1
  for update skip locked;
  if x.id is null then
    return;
  end if;
  update explorations set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1, started_at = coalesce(started_at, now())
  where id = x.id
  returning * into x;
  return next x;
end;
$$;

-- A new exploration wakes the sleeping runner, like a run.
create or replace function public.explorations_wake() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'queued' then
    perform wake_runner();
  end if;
  return null;
end;
$$;
create trigger explorations_wake after insert on public.explorations
for each row execute function public.explorations_wake();

-- Cloud minutes and AI credits count explorations too.
create or replace function public.workspace_usage(p_workspace uuid)
returns table (plan text, period_start timestamptz, period_end timestamptz, minutes_used numeric, minutes_limit int, credits_used int, credits_limit int, projects_used int, projects_limit int)
language plpgsql stable security definer set search_path = public as $$
declare
  b workspace_billing;
  p text;
  ps timestamptz;
  pe timestamptz;
begin
  if not (is_member(p_workspace) or auth.uid() is null) then
    raise exception 'Workspace not found';
  end if;
  select * into b from workspace_billing where workspace_id = p_workspace;
  p := coalesce(b.plan, 'free');
  if p <> 'free' and b.period_start is not null and b.period_end > now() then
    ps := b.period_start;
    pe := b.period_end;
  else
    ps := date_trunc('month', now());
    pe := ps + interval '1 month';
  end if;
  return query
  select p, ps, pe,
         round((coalesce((select sum(r.duration_ms) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0)
              + coalesce((select sum(x.duration_ms) from explorations x where x.workspace_id = p_workspace and x.created_at >= ps), 0)) / 60000.0, 1),
         (plan_limits(p)).minutes,
         (coalesce((select sum(r.ai_calls) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0)
          + coalesce((select sum(x.ai_calls) from explorations x where x.workspace_id = p_workspace and x.created_at >= ps), 0))::int,
         (plan_limits(p)).credits,
         (select count(*) from projects pr where pr.workspace_id = p_workspace)::int,
         (plan_limits(p)).projects;
end;
$$;

-- Every minute: also wake the runner for an exploration that has been waiting.
create or replace function public.minute_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform fire_due_schedules();
  if exists (select 1 from runs where status = 'queued' and created_at < now() - interval '20 seconds')
     or exists (select 1 from explorations where status = 'queued' and created_at < now() - interval '20 seconds') then
    perform wake_runner();
  end if;
  if exists (select 1 from github_checks where status = 'pending' and coalesce(synced_at, created_at) < now() - interval '1 minute') then
    perform github_sync();
  end if;
  if exists (select 1 from alert_events where sent_at is null) then
    perform alerts_send();
  end if;
end;
$$;

revoke execute on function public.start_exploration(uuid, uuid, int, uuid) from public, anon;
grant execute on function public.start_exploration(uuid, uuid, int, uuid) to authenticated;
revoke execute on function public.cancel_exploration(uuid) from public, anon;
grant execute on function public.cancel_exploration(uuid) to authenticated;
revoke execute on function public.claim_exploration(text) from public, anon, authenticated;
grant execute on function public.claim_exploration(text) to service_role;
revoke execute on function public.explorations_wake() from public, anon, authenticated;
revoke execute on function public.workspace_usage(uuid) from public, anon;
grant execute on function public.workspace_usage(uuid) to authenticated, service_role;
revoke execute on function public.minute_tick() from public, anon, authenticated;
