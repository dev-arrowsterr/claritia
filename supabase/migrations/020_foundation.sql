-- Foundation for the marketing platform (docs/marketing-platform.md, M0).
--   jobs: one queue for background work. Workers claim jobs with skip locked, hold a lease while they work, and
--         finish them. Jobs that share a key never run at the same time, and at most one waits per key, so a burst
--         of events for one device or account becomes one job.
--   workspaces.features: which parts of the app a workspace sees. Existing workspaces keep the testing product.
--   audit_log, privacy_requests: who exported, erased or changed what, for the privacy rules.
--   suite_connections: the workspace's links to Omniscient and Arrowsterr, with the API key sealed by the server.
-- Runs, plans and explorations keep their own claim functions; the new queue is for the new work.

-- Jobs -----------------------------------------------------------------------

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Jobs with the same workspace, kind and key run one at a time, and only one waits. Empty means no limit.
  key text not null default '' check (length(key) <= 200),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  locked_by text,
  locked_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists jobs_one_waiting on public.jobs (workspace_id, kind, key) nulls not distinct
  where status = 'queued' and key <> '';
create index if not exists jobs_ready on public.jobs (kind, run_after) where status = 'queued';
create index if not exists jobs_running on public.jobs (kind, locked_until) where status = 'running';
create index if not exists jobs_finished on public.jobs (finished_at) where status in ('done', 'failed');
alter table public.jobs enable row level security;
revoke all on public.jobs from anon, authenticated;

-- Add a job. With a key, a job already waiting for that key takes the new payload and the earlier start time,
-- so repeated calls collapse into one. Returns the waiting job's id.
create or replace function public.enqueue_job(p_workspace uuid, p_kind text, p_key text default '', p_payload jsonb default '{}',
  p_delay_s int default 0, p_max_attempts int default 5) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  jid uuid;
begin
  insert into jobs (workspace_id, kind, key, payload, run_after, max_attempts)
  values (p_workspace, p_kind, coalesce(p_key, ''), coalesce(p_payload, '{}'), now() + make_interval(secs => greatest(coalesce(p_delay_s, 0), 0)), p_max_attempts)
  on conflict (workspace_id, kind, key) where status = 'queued' and key <> ''
  do update set payload = excluded.payload, run_after = least(jobs.run_after, excluded.run_after)
  returning id into jid;
  return jid;
end;
$$;

-- Take up to p_limit ready jobs of the given kinds. A job whose worker stopped answering (its lease ran out) goes
-- back in line, or fails after its last attempt, or is dropped when a newer job for the same key already waits.
create or replace function public.claim_job(p_kinds text[], p_worker text, p_lease_s int default 300, p_limit int default 1)
returns setof jobs
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_worker, '') = '' then
    raise exception 'A worker name is needed';
  end if;

  -- Leases that ran out.
  update jobs j set
    status = case when j.attempts >= j.max_attempts then 'failed' else 'done' end,
    error = case when j.attempts >= j.max_attempts then 'The worker stopped answering' else 'Replaced by a newer job for the same key' end,
    finished_at = now(), locked_by = null, locked_until = null
  where j.id in (
    select x.id from jobs x
    where x.kind = any(p_kinds) and x.status = 'running' and x.locked_until < now()
      and (x.attempts >= x.max_attempts
           or (x.key <> '' and exists (select 1 from jobs w where w.status = 'queued' and w.kind = x.kind and w.key = x.key
                                       and w.workspace_id is not distinct from x.workspace_id)))
    for update skip locked
  );
  update jobs j set status = 'queued', run_after = now(), locked_by = null, locked_until = null,
    error = 'The worker stopped answering; trying again'
  where j.id in (
    select x.id from jobs x
    where x.kind = any(p_kinds) and x.status = 'running' and x.locked_until < now()
      and (x.key = '' or not exists (select 1 from jobs w where w.status = 'queued' and w.kind = x.kind and w.key = x.key
                                     and w.workspace_id is not distinct from x.workspace_id))
    for update skip locked
  );

  return query
  update jobs j set status = 'running', locked_by = p_worker, attempts = j.attempts + 1,
    locked_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 300), 10))
  where j.id in (
    select x.id from jobs x
    where x.kind = any(p_kinds) and x.status = 'queued' and x.run_after <= now()
      and (x.key = '' or not exists (select 1 from jobs r where r.status = 'running' and r.kind = x.kind and r.key = x.key
                                     and r.workspace_id is not distinct from x.workspace_id))
    order by x.run_after
    limit greatest(least(coalesce(p_limit, 1), 100), 1)
    for update skip locked
  )
  returning j.*;
end;
$$;

-- Keep a long job's lease. False means the lease was lost and the worker should stop.
create or replace function public.extend_job(p_id uuid, p_worker text, p_lease_s int default 300) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update jobs set locked_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 300), 10))
  where id = p_id and status = 'running' and locked_by = p_worker;
  return found;
end;
$$;

-- Finish a job. A failure tries again later (1, 5, 30 minutes, then 2 and 6 hours, or p_retry_s), until the last
-- attempt; p_retry_s = -1 means don't try again. False means the lease was lost, so nothing changed.
create or replace function public.finish_job(p_id uuid, p_worker text, p_ok boolean, p_error text default null, p_retry_s int default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  j jobs;
  wait int;
begin
  select * into j from jobs where id = p_id and status = 'running' and locked_by = p_worker for update;
  if not found then
    return false;
  end if;
  if p_ok then
    update jobs set status = 'done', error = null, finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return true;
  end if;
  if p_retry_s = -1 or j.attempts >= j.max_attempts
     or (j.key <> '' and exists (select 1 from jobs w where w.status = 'queued' and w.kind = j.kind and w.key = j.key
                                 and w.workspace_id is not distinct from j.workspace_id)) then
    update jobs set status = 'failed', error = left(coalesce(p_error, 'Failed'), 2000), finished_at = now(),
      locked_by = null, locked_until = null where id = p_id;
    return true;
  end if;
  wait := coalesce(p_retry_s, (array[60, 300, 1800, 7200, 21600])[least(j.attempts, 5)]);
  update jobs set status = 'queued', error = left(coalesce(p_error, 'Failed'), 2000), run_after = now() + make_interval(secs => wait),
    locked_by = null, locked_until = null where id = p_id;
  return true;
end;
$$;

-- Finished jobs are kept a week (failed ones a month) for looking into problems.
create or replace function public.prune_jobs() returns void
language sql security definer set search_path = public as $$
  delete from jobs where (status = 'done' and finished_at < now() - interval '7 days')
                      or (status = 'failed' and finished_at < now() - interval '30 days');
$$;

revoke execute on function public.enqueue_job(uuid, text, text, jsonb, int, int) from public, anon, authenticated;
revoke execute on function public.claim_job(text[], text, int, int) from public, anon, authenticated;
revoke execute on function public.extend_job(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, text, boolean, text, int) from public, anon, authenticated;
revoke execute on function public.prune_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_job(uuid, text, text, jsonb, int, int) to service_role;
grant execute on function public.claim_job(text[], text, int, int) to service_role;
grant execute on function public.extend_job(uuid, text, int) to service_role;
grant execute on function public.finish_job(uuid, text, boolean, text, int) to service_role;
grant execute on function public.prune_jobs() to service_role;

-- Features ------------------------------------------------------------------

-- 'testing' shows the testing product; 'marketing' shows the marketing platform. Only the server changes this.
alter table public.workspaces add column if not exists features text[] not null default '{testing}';

-- Audit log -----------------------------------------------------------------

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor uuid,
  action text not null check (length(action) between 1 and 80),
  target text check (length(target) <= 200),
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index if not exists audit_log_ws on public.audit_log (workspace_id, at desc);
alter table public.audit_log enable row level security;
create policy "owners read" on public.audit_log for select using (is_owner(workspace_id));
revoke all on public.audit_log from anon;
revoke insert, update, delete on public.audit_log from authenticated;

-- Privacy requests --------------------------------------------------------------

create table if not exists public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('export', 'erase', 'opt_out', 'correct')),
  -- SHA-256 of the cleaned email. The email itself isn't kept here.
  subject_hash bytea not null,
  requested_by uuid,
  source text not null check (source in ('app', 'api', 'hubspot', 'omniscient')),
  status text not null default 'queued' check (status in ('queued', 'done', 'failed')),
  counts jsonb not null default '{}',
  error text,
  requested_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists privacy_requests_ws on public.privacy_requests (workspace_id, requested_at desc);
alter table public.privacy_requests enable row level security;
create policy "owners read" on public.privacy_requests for select using (is_owner(workspace_id));
revoke all on public.privacy_requests from anon;
revoke insert, update, delete on public.privacy_requests from authenticated;

-- Suite connections -------------------------------------------------------------

create table if not exists public.suite_connections (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  product text not null check (product in ('omniscient', 'arrowsterr')),
  base_url text not null check (base_url ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
  -- The API key, sealed by the server. Never readable by people.
  key_sealed text not null check (key_sealed like 'v1:%'),
  -- What people see of it: the last characters.
  key_hint text,
  -- Arrowsterr only: the brand this workspace tracks there.
  brand text check (length(brand) <= 200),
  status text not null default 'error' check (status in ('ok', 'error')),
  error text,
  checked_at timestamptz,
  connected_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, product)
);
alter table public.suite_connections enable row level security;
create policy "members read" on public.suite_connections for select using (is_member(workspace_id));
revoke all on public.suite_connections from anon, authenticated;
grant select (workspace_id, product, base_url, key_hint, brand, status, error, checked_at, connected_by, created_at)
  on public.suite_connections to authenticated;

-- Every minute -------------------------------------------------------------------
-- Same as before, plus clearing out old finished jobs once an hour.
create or replace function public.minute_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform fire_due_schedules();
  if exists (select 1 from runs where status = 'queued' and created_at < now() - interval '20 seconds')
     or exists (select 1 from explorations where status = 'queued' and created_at < now() - interval '20 seconds')
     or exists (select 1 from plans where status = 'queued' and created_at < now() - interval '20 seconds') then
    perform wake_runner();
  end if;
  if exists (select 1 from github_checks where status = 'pending' and coalesce(synced_at, created_at) < now() - interval '1 minute') then
    perform github_sync();
  end if;
  if exists (select 1 from alert_events where sent_at is null) then
    perform alerts_send();
  end if;
  if extract(minute from now()) = 7 then
    perform prune_jobs();
  end if;
end;
$$;
revoke execute on function public.minute_tick() from public, anon, authenticated;
