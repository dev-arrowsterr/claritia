-- A runner that sleeps between runs, so it costs nothing while idle.
-- The database wakes it: when a run is queued it calls the runner's address (pg_net), and every minute it fires due
-- schedules itself (pg_cron) and wakes the runner if anything has been waiting. Without pg_net or pg_cron (local
-- tests, or a runner that never sleeps) all of this does nothing and the runner works as before.

-- Settings only the server reads. The runner's wake address goes here.
create table if not exists public.app_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
insert into public.app_config (key, value) values ('runner_wake_url', '') on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

-- Call the runner's address, at most every 20 seconds. Calling a runner that's awake does nothing.
create or replace function public.wake_runner() returns void
language plpgsql security definer set search_path = public as $$
declare
  url text;
  last timestamptz;
begin
  select value into url from app_config where key = 'runner_wake_url';
  if coalesce(url, '') = '' or to_regproc('net.http_get') is null then
    return;
  end if;
  select updated_at into last from app_config where key = 'runner_last_wake';
  if last is not null and last > now() - interval '20 seconds' then
    return;
  end if;
  insert into app_config (key, value, updated_at) values ('runner_last_wake', '', now())
  on conflict (key) do update set updated_at = now();
  execute 'select net.http_get($1)' using url;
end;
$$;

-- Every queued run wakes the runner: manual runs, re-runs and scheduled runs alike.
create or replace function public.runs_wake() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'queued' then
    perform wake_runner();
  end if;
  return null;
end;
$$;
create trigger runs_wake after insert or update of status on public.runs
for each row execute function public.runs_wake();

-- Once a minute: fire due schedules, and wake the runner if a run has been waiting, in case a wake was missed.
create or replace function public.minute_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform fire_due_schedules();
  if exists (select 1 from runs where status = 'queued' and created_at < now() - interval '20 seconds') then
    perform wake_runner();
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('claritia-minute', '* * * * *', 'select public.minute_tick()');
  end if;
end $$;

revoke execute on function public.wake_runner() from public, anon, authenticated;
revoke execute on function public.runs_wake() from public, anon, authenticated;
revoke execute on function public.minute_tick() from public, anon, authenticated;
