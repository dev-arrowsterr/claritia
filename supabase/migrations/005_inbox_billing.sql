-- Test inboxes, network logs, plans and usage.

-- Inboxes -------------------------------------------------------------------------------
-- Each project gets a random inbox id. Mail to <inbox id>-<anything>@inbox.tryclaritia.com lands in that project.
alter table public.projects add column if not exists inbox_id text;
update public.projects set inbox_id = substr(md5(gen_random_uuid()::text), 1, 8) where inbox_id is null;
alter table public.projects alter column inbox_id set not null;
create unique index if not exists projects_inbox on public.projects (inbox_id);

-- The inbox id is always made here, and never changes, so nobody can point their inbox at another project's mail.
create or replace function public.project_inbox() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.inbox_id := substr(md5(gen_random_uuid()::text), 1, 8);
  else
    new.inbox_id := old.inbox_id;
  end if;
  return new;
end;
$$;
create trigger projects_inbox before insert or update of inbox_id on public.projects
for each row execute function public.project_inbox();

create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  to_address text not null,
  from_address text,
  subject text,
  text_body text,
  html_body text,
  received_at timestamptz not null default now()
);
create index if not exists inbox_messages_to on public.inbox_messages (project_id, to_address, received_at desc);
alter table public.inbox_messages enable row level security;
create policy "members read" on public.inbox_messages for select using (is_member(workspace_id));
revoke all on public.inbox_messages from anon;
revoke insert, update, delete on public.inbox_messages from authenticated;

-- Network log: one file per run, like the console.
alter table public.runs add column if not exists network_path text;

-- Plans and usage ------------------------------------------------------------------------
-- Billing lives in its own table, so owners who can rename a workspace can't change its plan. Only Stripe's webhook writes it.
create table if not exists public.workspace_billing (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'starter', 'team', 'business')),
  status text,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  period_start timestamptz,
  period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.workspace_billing enable row level security;
create policy "members read" on public.workspace_billing for select using (is_member(workspace_id));
revoke all on public.workspace_billing from anon;
revoke insert, update, delete on public.workspace_billing from authenticated;

-- When a workspace first had a passing run, to track time from sign-up to a passing test.
alter table public.workspaces add column if not exists first_pass_at timestamptz;
revoke update on public.workspaces from authenticated;
grant update (name) on public.workspaces to authenticated;

-- What each plan includes. Null means no limit.
create or replace function public.plan_limits(p_plan text, out projects int, out minutes int, out credits int)
language sql immutable set search_path = public as $$
  select case p_plan when 'free' then 1 when 'starter' then 3 else null end,
         case p_plan when 'free' then 300 when 'starter' then 2000 when 'team' then 10000 else null end,
         case p_plan when 'free' then 200 when 'starter' then 2000 when 'team' then 10000 else null end;
$$;

-- This period's usage: cloud minutes from run lengths, AI credits from writer calls.
-- A paid plan's period follows Stripe; everyone else's is the calendar month.
create or replace function public.workspace_usage(p_workspace uuid)
returns table (plan text, period_start timestamptz, period_end timestamptz, minutes_used numeric, minutes_limit int, credits_used int, credits_limit int, projects_used int, projects_limit int)
language plpgsql stable security definer set search_path = public as $$
declare
  b workspace_billing;
  p text;
  ps timestamptz;
  pe timestamptz;
begin
  -- Signed-in people see their own workspaces. Only the server (no signed-in user) sees any workspace.
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
         round(coalesce((select sum(r.duration_ms) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0) / 60000.0, 1),
         (plan_limits(p)).minutes,
         coalesce((select sum(r.ai_calls) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0)::int,
         (plan_limits(p)).credits,
         (select count(*) from projects pr where pr.workspace_id = p_workspace)::int,
         (plan_limits(p)).projects;
end;
$$;

-- A new project fits the plan.
create or replace function public.project_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  u record;
begin
  select * into u from workspace_usage(new.workspace_id);
  if u.projects_limit is not null and u.projects_used >= u.projects_limit then
    raise exception 'Your plan includes % %. Upgrade in Settings to add more.', u.projects_limit, case when u.projects_limit = 1 then 'project' else 'projects' end;
  end if;
  return new;
end;
$$;
create trigger projects_limit before insert on public.projects
for each row execute function public.project_limit();

-- Start a run of a test on one of its project's environments, within the plan's cloud minutes.
create or replace function public.start_run(p_test uuid, p_env uuid, p_trigger text default 'manual') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tests;
  e environments;
  u record;
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
  select * into u from workspace_usage(t.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    raise exception 'This month''s % cloud minutes are used up. Upgrade in Settings to keep running tests.', u.minutes_limit;
  end if;
  select count(*) into busy from runs where workspace_id = t.workspace_id and status in ('queued', 'running');
  if busy >= 5 then
    raise exception 'Five runs are already waiting or running in this workspace. Try again when one finishes.';
  end if;

  insert into runs (workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, trigger, created_by)
  values (t.workspace_id, t.project_id, t.id, t.name, t.version, e.id, e.name, e.base_url, coalesce(t.lock, ''), p_trigger, auth.uid())
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

revoke execute on function public.project_inbox() from public, anon, authenticated;
revoke execute on function public.project_limit() from public, anon, authenticated;
revoke execute on function public.workspace_usage(uuid) from public, anon;
grant execute on function public.workspace_usage(uuid) to authenticated, service_role;
