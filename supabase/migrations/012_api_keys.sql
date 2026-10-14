-- API keys: a workspace's key for the REST API and the CLI. The server makes the key and stores only its SHA-256;
-- the key itself is shown once. Members see their workspace's keys (never the hash) and can make and revoke them.
-- Runs started with a key go through api_start_runs(), which only the server can call.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  -- The key's first characters, so people can tell keys apart.
  prefix text not null check (length(prefix) between 4 and 20),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_ws on public.api_keys (workspace_id, created_at);
alter table public.api_keys enable row level security;
create policy "members read" on public.api_keys for select using (is_member(workspace_id));
revoke all on public.api_keys from anon, authenticated;
grant select (id, workspace_id, name, prefix, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;

alter table public.runs add column if not exists api_key_id uuid references public.api_keys (id) on delete set null;

-- Save a new key's hash. The server made the key; a member names it.
create or replace function public.create_api_key(p_workspace uuid, p_name text, p_prefix text, p_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  kid uuid;
begin
  if not is_member(p_workspace) then
    raise exception 'Workspace not found';
  end if;
  if (select count(*) from api_keys where workspace_id = p_workspace and revoked_at is null) >= 20 then
    raise exception 'A workspace can have 20 keys. Revoke one first.';
  end if;
  insert into api_keys (workspace_id, name, prefix, key_hash) values (p_workspace, trim(p_name), p_prefix, p_hash)
  returning id into kid;
  return kid;
end;
$$;

create or replace function public.revoke_api_key(p_key uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update api_keys set revoked_at = now() where id = p_key and revoked_at is null and is_member(workspace_id);
  if not found then
    raise exception 'Key not found';
  end if;
end;
$$;

-- The key behind a request. Notes when it was last used, at most once a minute.
create or replace function public.api_key_auth(p_hash text) returns table (key_id uuid, workspace_id uuid, created_by uuid)
language plpgsql security definer set search_path = public as $$
declare
  k api_keys;
begin
  select * into k from api_keys where key_hash = p_hash and revoked_at is null;
  if k.id is null then
    return;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update api_keys set last_used_at = now() where id = k.id;
  end if;
  return query select k.id, k.workspace_id, k.created_by;
end;
$$;

-- Start runs of a project's tests with a key, within the plan's cloud minutes.
-- Up to 50 runs from keys wait or run at once per workspace, so a CI job can run a whole suite.
create or replace function public.api_start_runs(p_key uuid, p_project uuid, p_env uuid, p_tests uuid[])
returns table (run_id uuid, test_id uuid, test_name text)
language plpgsql security definer set search_path = public as $$
declare
  k api_keys;
  e environments;
  t tests;
  u record;
  busy int;
  wanted int;
  rid uuid;
begin
  select * into k from api_keys where id = p_key and revoked_at is null;
  if k.id is null then
    raise exception 'This API key was revoked';
  end if;
  if not exists (select 1 from projects where id = p_project and projects.workspace_id = k.workspace_id) then
    raise exception 'Project not found';
  end if;
  select * into e from environments where id = p_env and project_id = p_project;
  if e.id is null then
    raise exception 'Environment not found';
  end if;
  select count(*) into wanted from tests where id = any (p_tests) and project_id = p_project;
  if wanted <> coalesce(cardinality(p_tests), 0) or wanted = 0 then
    raise exception 'Test not found';
  end if;
  if exists (select 1 from tests where id = any (p_tests) and jsonb_array_length(coalesce(steps, '[]')) = 0) then
    raise exception 'Add a step to every test first';
  end if;
  select * into u from workspace_usage(k.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    raise exception 'This month''s % cloud minutes are used up. Upgrade in Settings to keep running tests.', u.minutes_limit;
  end if;
  select count(*) into busy from runs where runs.workspace_id = k.workspace_id and status in ('queued', 'running') and trigger = 'api';
  if busy + wanted > 50 then
    raise exception '% runs from API keys are already waiting or running in this workspace. Up to 50 can wait at once.', busy;
  end if;

  for t in select * from tests where id = any (p_tests) order by use_case, name loop
    rid := queue_run(t, e, 'api', k.created_by);
    update runs set api_key_id = k.id where id = rid;
    run_id := rid;
    test_id := t.id;
    test_name := t.name;
    return next;
  end loop;
end;
$$;

revoke execute on function public.create_api_key(uuid, text, text, text) from public, anon;
grant execute on function public.create_api_key(uuid, text, text, text) to authenticated;
revoke execute on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.revoke_api_key(uuid) to authenticated;
revoke execute on function public.api_key_auth(text) from public, anon, authenticated;
grant execute on function public.api_key_auth(text) to service_role;
revoke execute on function public.api_start_runs(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.api_start_runs(uuid, uuid, uuid, uuid[]) to service_role;
