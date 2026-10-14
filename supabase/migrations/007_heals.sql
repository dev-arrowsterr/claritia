-- The Healer: when a step's saved code stops working, the runner asks Claude for new code and tries it.
-- A fix that passes is saved here, waiting for a person to approve it. The test's code only changes on approval.

alter table public.run_steps add column if not exists healed boolean not null default false;

create table if not exists public.heals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  test_id uuid not null references public.tests (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  test_version int not null,
  position int not null,
  step_label text not null,
  old_code text not null,
  new_code text not null,
  error text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'stale')),
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz
);
create index if not exists heals_project on public.heals (project_id, status, created_at desc);
create index if not exists heals_test on public.heals (test_id, position, status);
alter table public.heals enable row level security;
create policy "members read" on public.heals for select using (is_member(workspace_id));
revoke all on public.heals from anon;
revoke insert, update, delete on public.heals from authenticated;

-- Approve or reject a fix. Approving only records the decision; the app saves the new code to the test
-- through the normal save, so it gets a version with the person's name on it.
create or replace function public.decide_heal(p_heal uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare
  h heals;
begin
  select * into h from heals where id = p_heal;
  if h.id is null or not is_member(h.workspace_id) then
    raise exception 'Fix not found';
  end if;
  if p_status not in ('approved', 'rejected', 'stale') then
    raise exception 'Unknown decision';
  end if;
  if h.status <> 'pending' then
    raise exception 'This fix was already %', h.status;
  end if;
  update heals set status = p_status, decided_by = auth.uid(), decided_at = now() where id = p_heal;
end;
$$;

-- The runner records a fix. An older fix still waiting for the same step is replaced, and the same fix twice is kept once.
create or replace function public.record_heal(p_run uuid, p_position int, p_label text, p_old text, p_new text, p_error text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  hid uuid;
begin
  select * into r from runs where id = p_run;
  if r.id is null or r.test_id is null then
    return null;
  end if;
  select id into hid from heals where test_id = r.test_id and position = p_position and status = 'pending' and new_code = p_new and test_version = r.test_version;
  if hid is not null then
    return hid;
  end if;
  update heals set status = 'stale', decided_at = now() where test_id = r.test_id and position = p_position and status = 'pending';
  insert into heals (workspace_id, project_id, test_id, run_id, test_version, position, step_label, old_code, new_code, error)
  values (r.workspace_id, r.project_id, r.test_id, r.id, r.test_version, p_position, left(p_label, 500), left(p_old, 20000), left(p_new, 20000), left(p_error, 2000))
  returning id into hid;
  return hid;
end;
$$;

-- The runner starts each step afresh when it claims a run again.
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
  update run_steps set status = 'pending', error = null, started_ms = null, duration_ms = null, retried = false, written = false, healed = false, code = null where run_id = r.id;
  return next r;
end;
$$;

revoke execute on function public.decide_heal(uuid, text) from public, anon;
grant execute on function public.decide_heal(uuid, text) to authenticated;
revoke execute on function public.record_heal(uuid, int, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_heal(uuid, int, text, text, text, text) to service_role;
