-- The AI writer: a run can start on a test with no code. The runner writes code for each step that has none,
-- runs it, and saves the passing code back to the test, so later runs replay it with no AI calls.

alter table public.run_steps add column if not exists intent text;
alter table public.run_steps add column if not exists written boolean not null default false;
alter table public.run_steps add column if not exists code text;
alter table public.runs add column if not exists live_path text;
alter table public.runs add column if not exists ai_calls int not null default 0;
alter table public.runs add column if not exists ai_input_tokens int not null default 0;
alter table public.runs add column if not exists ai_output_tokens int not null default 0;
alter table public.runs add column if not exists lock_saved boolean not null default false;

-- Start a run of a test on one of its project's environments. Steps with no code are written during the run.
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
  if jsonb_array_length(coalesce(t.steps, '[]')) = 0 then
    raise exception 'Add a step to this test first';
  end if;
  select count(*) into busy from runs where workspace_id = t.workspace_id and status in ('queued', 'running');
  if busy >= 5 then
    raise exception 'Five runs are already waiting or running in this workspace. Try again when one finishes.';
  end if;

  insert into runs (workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, trigger, created_by)
  values (t.workspace_id, t.project_id, t.id, t.name, t.version, e.id, e.name, e.base_url, coalesce(t.lock, ''), p_trigger, auth.uid())
  returning id into rid;

  -- One row per step, named the way the editor shows it. The intent is what the writer reads: the step's text,
  -- or a block's steps one per line.
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
  update runs set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1, started_at = coalesce(started_at, now()), live_path = null
  where id = r.id
  returning * into r;
  update run_steps set status = 'pending', error = null, started_ms = null, duration_ms = null, retried = false, written = false, code = null where run_id = r.id;
  return next r;
end;
$$;

-- Save the code the runner wrote. Only when the test hasn't changed since the run started, so a person's edits always win.
create or replace function public.save_written_lock(p_run uuid, p_lock text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  v int;
begin
  select * into r from runs where id = p_run;
  if r.id is null or r.test_id is null or coalesce(p_lock, '') = '' or length(p_lock) > 200000 then
    return false;
  end if;
  update tests set lock = p_lock
  where id = r.test_id and version = r.test_version and coalesce(lock, '') = r.lock
  returning version into v;
  if v is null then
    return false;
  end if;
  update test_versions set author_email = 'Claritia' where test_id = r.test_id and version = v;
  update runs set lock_saved = true where id = p_run;
  return true;
end;
$$;

revoke execute on function public.save_written_lock(uuid, text) from public, anon, authenticated;
grant execute on function public.save_written_lock(uuid, text) to service_role;
