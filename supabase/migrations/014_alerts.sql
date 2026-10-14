-- Alerts: Slack and email when a test fails for real, or a fix from the Healer waits for approval.
-- Flaky failures (re-run first) and setup problems don't alert, and neither do runs a person started by hand.
-- Each alert is queued here; every minute the server sends what's queued, one message per project.

create table if not exists public.alert_settings (
  project_id uuid primary key references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The Slack incoming webhook address, sealed by the server like other secrets. Never readable by people.
  slack_sealed text,
  -- What people see of it: the end of the address.
  slack_hint text,
  emails text[] not null default '{}' check (cardinality(emails) <= 20),
  on_failure boolean not null default true,
  on_heal boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.alert_settings enable row level security;
create policy "members read" on public.alert_settings for select using (is_member(workspace_id));
revoke all on public.alert_settings from anon, authenticated;
grant select (project_id, workspace_id, slack_hint, emails, on_failure, on_heal, updated_at) on public.alert_settings to authenticated;

create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  kind text not null check (kind in ('failure', 'heal')),
  run_id uuid references public.runs (id) on delete cascade,
  heal_id uuid references public.heals (id) on delete cascade,
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  sent_at timestamptz,
  error text
);
create index if not exists alert_events_unsent on public.alert_events (created_at) where sent_at is null;
alter table public.alert_events enable row level security;
revoke all on public.alert_events from anon, authenticated;

-- Save a project's alert settings. The server seals the Slack address first; null keeps the saved one.
create or replace function public.save_alert_settings(p_project uuid, p_emails text[], p_on_failure boolean, p_on_heal boolean, p_slack_sealed text default null, p_slack_hint text default null, p_clear_slack boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  e text;
begin
  select workspace_id into ws from projects where id = p_project;
  if ws is null or not is_member(ws) then
    raise exception 'Project not found';
  end if;
  foreach e in array coalesce(p_emails, '{}') loop
    if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Not an email address: %', e;
    end if;
  end loop;
  insert into alert_settings (project_id, workspace_id, slack_sealed, slack_hint, emails, on_failure, on_heal, updated_at)
  values (p_project, ws, p_slack_sealed, p_slack_hint, coalesce(p_emails, '{}'), p_on_failure, p_on_heal, now())
  on conflict (project_id) do update set
    slack_sealed = case when p_clear_slack then null else coalesce(excluded.slack_sealed, alert_settings.slack_sealed) end,
    slack_hint = case when p_clear_slack then null else coalesce(excluded.slack_hint, alert_settings.slack_hint) end,
    emails = excluded.emails,
    on_failure = excluded.on_failure,
    on_heal = excluded.on_heal,
    updated_at = now();
end;
$$;

-- Whether a project has anywhere to send alerts.
create or replace function public.alerts_on(p_project uuid, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from alert_settings
    where project_id = p_project
      and (slack_sealed is not null or cardinality(emails) > 0)
      and case when p_kind = 'failure' then on_failure else on_heal end
  );
$$;

-- A run that failed for real: an app bug, a failure the Judge couldn't sort, or a flaky test that failed again on
-- its re-run. A first flaky failure waits for its re-run. Runs started by hand don't alert; the person is watching.
create or replace function public.runs_alert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  started_by text := new.trigger;
begin
  if new.status <> 'failed' or (new.verdict = 'flaky' and new.retry_of is null) or new.verdict = 'setup' then
    return null;
  end if;
  if new.trigger = 'retry' then
    select trigger into started_by from runs where id = new.retry_of;
  end if;
  if coalesce(started_by, 'manual') = 'manual' or not alerts_on(new.project_id, 'failure') then
    return null;
  end if;
  insert into alert_events (workspace_id, project_id, kind, run_id) values (new.workspace_id, new.project_id, 'failure', new.id);
  return null;
end;
$$;
create trigger runs_alert after update of status on public.runs
for each row when (old.status is distinct from new.status and new.status = 'failed') execute function public.runs_alert();

create or replace function public.heals_alert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if alerts_on(new.project_id, 'heal') then
    insert into alert_events (workspace_id, project_id, kind, heal_id) values (new.workspace_id, new.project_id, 'heal', new.id);
  end if;
  return null;
end;
$$;
create trigger heals_alert after insert on public.heals
for each row execute function public.heals_alert();

insert into public.app_config (key, value) values ('alerts_url', '') on conflict (key) do nothing;

-- Ask the server to send queued alerts. Uses the same secret as the GitHub sync.
create or replace function public.alerts_send() returns void
language plpgsql security definer set search_path = public as $$
declare
  url text;
  secret text;
begin
  select value into url from app_config where key = 'alerts_url';
  select value into secret from app_config where key = 'github_sync_secret';
  if coalesce(url, '') = '' or to_regproc('net.http_post') is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
  using url, jsonb_build_object('content-type', 'application/json', 'x-claritia-sync', secret);
end;
$$;

-- Every minute: schedules, the runner, open GitHub checks, and queued alerts.
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
  if exists (select 1 from alert_events where sent_at is null) then
    perform alerts_send();
  end if;
end;
$$;

revoke execute on function public.save_alert_settings(uuid, text[], boolean, boolean, text, text, boolean) from public, anon;
grant execute on function public.save_alert_settings(uuid, text[], boolean, boolean, text, text, boolean) to authenticated;
revoke execute on function public.alerts_on(uuid, text) from public, anon, authenticated;
revoke execute on function public.runs_alert() from public, anon, authenticated;
revoke execute on function public.heals_alert() from public, anon, authenticated;
revoke execute on function public.alerts_send() from public, anon, authenticated;
revoke execute on function public.minute_tick() from public, anon, authenticated;
