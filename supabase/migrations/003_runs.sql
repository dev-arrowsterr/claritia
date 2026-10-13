-- Runs: one test run on one environment, with a row per step.
-- People start runs through start_run(), which checks access and snapshots the test.
-- Only the runner (the service role) moves a run along and writes results, so nobody can fake a pass.

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  test_id uuid references public.tests (id) on delete set null,
  test_name text not null,
  test_version int not null,
  environment_id uuid references public.environments (id) on delete set null,
  environment_name text not null,
  base_url text not null,
  lock text not null,
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'ci', 'api', 'mcp')),
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'error', 'canceled')),
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms int,
  video_path text,
  trace_paths text[] not null default '{}',
  console_path text,
  locked_by text,
  locked_at timestamptz,
  attempts int not null default 0
);
create index if not exists runs_project on public.runs (project_id, created_at desc);
create index if not exists runs_test on public.runs (test_id, created_at desc);
create index if not exists runs_queue on public.runs (status, created_at) where status in ('queued', 'running');
alter table public.runs enable row level security;
create policy "members read" on public.runs for select using (is_member(workspace_id));

create table if not exists public.run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  position int not null,
  step_id text,
  kind text not null check (kind in ('do', 'check', 'use')),
  label text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'passed', 'failed', 'skipped')),
  retried boolean not null default false,
  started_ms int,
  duration_ms int,
  error text,
  screenshot_path text,
  unique (run_id, position)
);
alter table public.run_steps enable row level security;
create policy "members read" on public.run_steps for select using (is_member(workspace_id));

-- Start a run of a test's saved code on one of its project's environments.
create or replace function public.start_run(p_test uuid, p_env uuid, p_trigger text default 'manual') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tests;
  e environments;
  rid uuid;
  busy int;
begin
  select * into t from tests where id = p_test;
  if t.id is null or not is_member(t.workspace_id) then
    raise exception 'Test not found';
  end if;
  select * into e from environments where id = p_env and project_id = t.project_id;
  if e.id is null then
    raise exception 'Environment not found';
  end if;
  if p_trigger not in ('manual', 'api', 'mcp') then
    raise exception 'Unknown trigger';
  end if;
  if coalesce(t.lock, '') = '' then
    raise exception 'This test has no Playwright code yet';
  end if;
  select count(*) into busy from runs where workspace_id = t.workspace_id and status in ('queued', 'running');
  if busy >= 5 then
    raise exception 'Five runs are already waiting or running in this workspace. Try again when one finishes.';
  end if;

  insert into runs (workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, trigger, created_by)
  values (t.workspace_id, t.project_id, t.id, t.name, t.version, e.id, e.name, e.base_url, t.lock, p_trigger, auth.uid())
  returning id into rid;

  -- One row per step, named the way the editor shows it.
  insert into run_steps (run_id, workspace_id, position, step_id, kind, label)
  select rid, t.workspace_id, s.ord, s.step ->> 'id', s.step ->> 'kind',
         case when s.step ->> 'kind' = 'use' then 'Use ' || coalesce((select b.name from blocks b where b.id::text = s.step ->> 'block'), 'missing block')
              when s.step ->> 'kind' = 'check' then 'Check: ' || (s.step ->> 'text')
              else s.step ->> 'text' end
  from jsonb_array_elements(t.steps) with ordinality as s(step, ord);
  return rid;
end;
$$;

-- The runner takes the oldest waiting run. A run whose runner went quiet for ten minutes is taken again, up to three tries.
create or replace function public.claim_run(p_worker text) returns setof runs
language plpgsql security definer set search_path = public as $$
declare
  r runs;
begin
  update runs set status = 'error', error = 'The runner stopped three times on this run.', finished_at = now()
  where status = 'running' and locked_at < now() - interval '10 minutes' and attempts >= 3;

  select * into r from runs
  where status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes')
  order by created_at
  limit 1
  for update skip locked;
  if r.id is null then
    return;
  end if;
  update runs set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1, started_at = coalesce(started_at, now())
  where id = r.id
  returning * into r;
  update run_steps set status = 'pending', error = null, started_ms = null, duration_ms = null, retried = false where run_id = r.id;
  return next r;
end;
$$;

-- Run files live in the private "runs" bucket under <workspace id>/<run id>/. Members can read their workspace's files.
insert into storage.buckets (id, name, public) values ('runs', 'runs', false) on conflict (id) do nothing;
create policy "members read run files" on storage.objects for select to authenticated
  using (bucket_id = 'runs' and is_member(((storage.foldername(name))[1])::uuid));

revoke all on public.runs, public.run_steps from anon;
revoke insert, update, delete on public.runs, public.run_steps from authenticated;
revoke execute on function public.start_run(uuid, uuid, text) from public, anon;
grant execute on function public.start_run(uuid, uuid, text) to authenticated;
revoke execute on function public.claim_run(text) from public, anon, authenticated;
grant execute on function public.claim_run(text) to service_role;
