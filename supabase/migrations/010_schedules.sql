-- Schedules: run a project's tests every hour, every day, on weekdays or every week, on one environment.
-- The runner calls fire_due_schedules() every minute; each due schedule queues its tests and moves to its next time.

create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  environment_id uuid not null references public.environments (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  -- What runs: every test, the tests of one use case, or picked tests.
  scope text not null default 'all' check (scope in ('all', 'use_case', 'tests')),
  use_case text,
  test_ids uuid[] not null default '{}',
  every text not null check (every in ('hour', 'day', 'weekday', 'week')),
  at_hour int not null default 9 check (at_hour between 0 and 23),
  at_minute int not null default 0 check (at_minute between 0 and 59),
  weekday int not null default 1 check (weekday between 0 and 6),
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_count int,
  last_error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists schedules_due on public.schedules (next_run_at) where enabled;
alter table public.schedules enable row level security;
create policy "members all" on public.schedules for all using (is_member(workspace_id)) with check (is_member(workspace_id));
revoke all on public.schedules from anon;

alter table public.runs add column if not exists schedule_id uuid references public.schedules (id) on delete set null;

-- The next time a schedule fires after a moment, in the schedule's own time zone.
-- weekday: 0 is Sunday. 'weekday' runs Monday to Friday.
create or replace function public.schedule_next(p_every text, p_hour int, p_minute int, p_weekday int, p_tz text, p_from timestamptz)
returns timestamptz
language plpgsql stable set search_path = public as $$
declare
  local timestamp := p_from at time zone p_tz;
  cand timestamp;
  i int;
begin
  if p_every = 'hour' then
    cand := date_trunc('hour', local) + make_interval(mins => p_minute);
    if cand <= local then cand := cand + interval '1 hour'; end if;
    return cand at time zone p_tz;
  end if;
  for i in 0..8 loop
    cand := date_trunc('day', local) + make_interval(days => i, hours => p_hour, mins => p_minute);
    if cand > local
       and (p_every = 'day'
            or (p_every = 'weekday' and extract(dow from cand) between 1 and 5)
            or (p_every = 'week' and extract(dow from cand) = p_weekday)) then
      return cand at time zone p_tz;
    end if;
  end loop;
  return null;
end;
$$;

-- Each save files the schedule under its project's workspace, checks the environment belongs to the project
-- and the time zone is real, and works out the next run.
create or replace function public.schedules_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select workspace_id into new.workspace_id from projects where id = new.project_id;
  if new.workspace_id is null then
    raise exception 'Project not found';
  end if;
  if not exists (select 1 from environments where id = new.environment_id and project_id = new.project_id) then
    raise exception 'Pick an environment from this project';
  end if;
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone %', new.timezone;
  end if;
  if new.scope = 'use_case' and coalesce(new.use_case, '') = '' then
    raise exception 'Pick a use case';
  end if;
  if new.scope = 'tests' and coalesce(array_length(new.test_ids, 1), 0) = 0 then
    raise exception 'Pick at least one test';
  end if;
  -- People can't fake when a schedule last ran; only the server (no signed-in user) records that.
  if tg_op = 'UPDATE' and auth.uid() is not null then
    new.created_by := old.created_by;
    new.last_run_at := old.last_run_at;
    new.last_count := old.last_count;
    new.last_error := old.last_error;
  end if;
  new.next_run_at := case when new.enabled then schedule_next(new.every, new.at_hour, new.at_minute, new.weekday, new.timezone, now()) end;
  return new;
end;
$$;
create trigger schedules_prepare before insert or update on public.schedules
for each row execute function public.schedules_prepare();

-- Queue one run of a test. No access checks: start_run and fire_due_schedules check first.
create or replace function public.queue_run(t tests, e environments, p_trigger text, p_by uuid, p_schedule uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
begin
  insert into runs (workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, trigger, created_by, schedule_id)
  values (t.workspace_id, t.project_id, t.id, t.name, t.version, e.id, e.name, e.base_url, coalesce(t.lock, ''), p_trigger, p_by, p_schedule)
  returning id into rid;

  insert into run_steps (run_id, workspace_id, position, step_id, kind, label, intent)
  select rid, t.workspace_id, s.ord, s.step ->> 'id', s.step ->> 'kind',
         case when s.step ->> 'kind' = 'use' then 'Use ' || coalesce((select b.name from blocks b where b.id::text = s.step ->> 'block'), 'missing block')
              when s.step ->> 'kind' = 'check' then 'Check: ' || (s.step ->> 'text')
              else s.step ->> 'text' end,
         case when s.step ->> 'kind' = 'use' then (
                select string_agg(case when bs.step ->> 'kind' = 'check' then 'Check: ' || (bs.step ->> 'text') else bs.step ->> 'text' end, E'\n' order by bs.ord)
                from blocks b, jsonb_array_elements(b.steps) with ordinality as bs(step, ord)
                where b.id::text = s.step ->> 'block')
              else s.step ->> 'text' end
  from jsonb_array_elements(t.steps) with ordinality as s(step, ord);
  return rid;
end;
$$;

-- Start a run of a test on one of its project's environments, within the plan's cloud minutes.
create or replace function public.start_run(p_test uuid, p_env uuid, p_trigger text default 'manual') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tests;
  e environments;
  u record;
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
  if jsonb_array_length(coalesce(t.steps, '[]')) = 0 then
    raise exception 'Add a step to this test first';
  end if;
  select * into u from workspace_usage(t.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    raise exception 'This month''s % cloud minutes are used up. Upgrade in Settings to keep running tests.', u.minutes_limit;
  end if;
  select count(*) into busy from runs where workspace_id = t.workspace_id and status in ('queued', 'running') and trigger in ('manual', 'api', 'mcp');
  if busy >= 5 then
    raise exception 'Five runs are already waiting or running in this workspace. Try again when one finishes.';
  end if;
  return queue_run(t, e, p_trigger, auth.uid());
end;
$$;

-- Fire every schedule that's due: queue its tests (up to 50), skipping tests still waiting from its last fire,
-- and move it to its next time. Two runners firing at once never fire the same schedule twice.
create or replace function public.fire_due_schedules() returns int
language plpgsql security definer set search_path = public as $$
declare
  s schedules;
  e environments;
  t tests;
  u record;
  n int;
  fired int := 0;
begin
  for s in select * from schedules where enabled and next_run_at <= now() order by next_run_at for update skip locked loop
    n := 0;
    select * into e from environments where id = s.environment_id;
    select * into u from workspace_usage(s.workspace_id);
    if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
      update schedules set last_run_at = now(), last_count = 0, last_error = 'This month''s cloud minutes are used up.',
        next_run_at = schedule_next(every, at_hour, at_minute, weekday, timezone, now()) where id = s.id;
      continue;
    end if;
    for t in
      select * from tests
      where project_id = s.project_id
        and jsonb_array_length(coalesce(steps, '[]')) > 0
        and (s.scope = 'all' or (s.scope = 'use_case' and use_case = s.use_case) or (s.scope = 'tests' and id = any (s.test_ids)))
        and not exists (select 1 from runs r where r.test_id = tests.id and r.schedule_id = s.id and r.status in ('queued', 'running'))
      order by use_case, name
      limit 50
    loop
      perform queue_run(t, e, 'schedule', s.created_by, s.id);
      n := n + 1;
    end loop;
    update schedules set last_run_at = now(), last_count = n, last_error = case when n = 0 then 'No tests to run.' end,
      next_run_at = schedule_next(every, at_hour, at_minute, weekday, timezone, now()) where id = s.id;
    fired := fired + 1;
  end loop;
  return fired;
end;
$$;

revoke execute on function public.schedules_prepare() from public, anon, authenticated;
revoke execute on function public.queue_run(tests, environments, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fire_due_schedules() from public, anon, authenticated;
grant execute on function public.fire_due_schedules() to service_role;
revoke execute on function public.schedule_next(text, int, int, int, text, timestamptz) from anon;
