-- Smart retries: a run the Judge calls flaky is run once more, as a new run, before the red sticks.
-- The re-run points back at the run it retries, and a re-run is never retried again.

alter table public.runs drop constraint runs_trigger_check;
alter table public.runs add constraint runs_trigger_check check (trigger in ('manual', 'schedule', 'ci', 'api', 'mcp', 'retry'));
alter table public.runs add column if not exists retry_of uuid references public.runs (id) on delete set null;
alter table public.runs add column if not exists retried_as uuid references public.runs (id) on delete set null;

-- Queue the re-run. Only the runner calls this, only for a failed run that isn't a re-run and wasn't re-run yet.
-- If the failed run saved code it wrote, the re-run replays that code instead of writing it again.
create or replace function public.retry_run(p_run uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  t tests;
  nid uuid;
begin
  select * into r from runs where id = p_run for update;
  if r.id is null or r.status <> 'failed' or r.retry_of is not null or r.retried_as is not null then
    return null;
  end if;
  select * into t from tests where id = r.test_id;

  insert into runs (workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, trigger, created_by, retry_of)
  values (r.workspace_id, r.project_id, r.test_id, r.test_name,
          case when r.lock_saved and t.id is not null then t.version else r.test_version end,
          r.environment_id, r.environment_name, r.base_url,
          case when r.lock_saved and t.id is not null then coalesce(t.lock, r.lock) else r.lock end,
          'retry', r.created_by, r.id)
  returning id into nid;

  insert into run_steps (run_id, workspace_id, position, step_id, kind, label, intent)
  select nid, s.workspace_id, s.position, s.step_id, s.kind, s.label, s.intent from run_steps s where s.run_id = r.id;

  update runs set retried_as = nid where id = r.id;
  return nid;
end;
$$;

revoke execute on function public.retry_run(uuid) from public, anon, authenticated;
grant execute on function public.retry_run(uuid) to service_role;
