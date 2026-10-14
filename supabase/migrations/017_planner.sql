-- The Planner: turns a project's app map, and notes or a PRD someone pastes, into proposed tests grouped by use case.
-- The runner makes the plan with Claude (one call). Proposals wait on the Tests page until someone accepts one,
-- which saves it as a real test, or dismisses it. A plan uses 10 AI credits.

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  notes text not null default '' check (length(notes) <= 30000),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  proposals int not null default 0,
  error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  ai_calls int not null default 0,
  ai_input_tokens int not null default 0,
  ai_output_tokens int not null default 0,
  locked_by text,
  locked_at timestamptz,
  attempts int not null default 0
);
create index if not exists plans_project on public.plans (project_id, created_at desc);
create index if not exists plans_queue on public.plans (status, created_at) where status in ('queued', 'running');
alter table public.plans enable row level security;
create policy "members read" on public.plans for select using (is_member(workspace_id));
revoke all on public.plans from anon;
revoke insert, update, delete on public.plans from authenticated;

create table if not exists public.test_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  plan_id uuid references public.plans (id) on delete set null,
  name text not null check (length(name) between 1 and 120),
  use_case text not null default 'General' check (length(use_case) between 1 and 60),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  -- Steps as the test will have them, without ids: [{kind: do|check, text} | {kind: use, block}].
  steps jsonb not null,
  reason text,
  pages text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  test_id uuid references public.tests (id) on delete set null,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists test_proposals_project on public.test_proposals (project_id, status, created_at desc);
alter table public.test_proposals enable row level security;
create policy "members read" on public.test_proposals for select using (is_member(workspace_id));
revoke all on public.test_proposals from anon;
revoke insert, update, delete on public.test_proposals from authenticated;

-- Ask for a plan. One at a time per project, within the plan's AI credits, and only with a map or notes to plan from.
create or replace function public.start_plan(p_project uuid, p_notes text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pr projects;
  u record;
  pid uuid;
begin
  select * into pr from projects where id = p_project;
  if pr.id is null or not is_member(pr.workspace_id) then
    raise exception 'Project not found';
  end if;
  if length(coalesce(p_notes, '')) > 30000 then
    raise exception 'Notes can be up to 30,000 characters';
  end if;
  if trim(coalesce(p_notes, '')) = '' and not exists (select 1 from app_pages where project_id = p_project) then
    raise exception 'Explore the app in Map first, or paste notes to plan from';
  end if;
  if exists (select 1 from plans where project_id = p_project and status in ('queued', 'running')) then
    raise exception 'A plan for this project is already being made';
  end if;
  select * into u from workspace_usage(pr.workspace_id);
  if u.credits_limit is not null and u.credits_used + 10 > u.credits_limit then
    raise exception 'A plan uses 10 AI credits, and this month''s are nearly used up. Upgrade in Settings to plan more.';
  end if;
  insert into plans (workspace_id, project_id, notes, created_by) values (pr.workspace_id, p_project, coalesce(p_notes, ''), auth.uid())
  returning id into pid;
  return pid;
end;
$$;

create or replace function public.claim_plan(p_worker text) returns setof plans
language plpgsql security definer set search_path = public as $$
declare
  p plans;
begin
  update plans set status = 'error', error = 'The runner stopped three times on this plan.', finished_at = now()
  where status = 'running' and locked_at < now() - interval '10 minutes' and attempts >= 3;
  select * into p from plans
  where status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes')
  order by created_at
  limit 1
  for update skip locked;
  if p.id is null then
    return;
  end if;
  update plans set status = 'running', locked_by = p_worker, locked_at = now(), attempts = attempts + 1, started_at = coalesce(started_at, now())
  where id = p.id
  returning * into p;
  return next p;
end;
$$;

-- Accept a proposal: save it as a test (step ids made here), and mark it accepted.
create or replace function public.accept_proposal(p_proposal uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pr test_proposals;
  steps jsonb;
  tid uuid;
begin
  select * into pr from test_proposals where id = p_proposal for update;
  if pr.id is null or not is_member(pr.workspace_id) then
    raise exception 'Proposal not found';
  end if;
  if pr.status <> 'pending' then
    raise exception 'This proposal was already %', pr.status;
  end if;
  select coalesce(jsonb_agg(s.step || jsonb_build_object('id', left(replace(gen_random_uuid()::text, '-', ''), 8)) order by s.ord), '[]')
  into steps
  from jsonb_array_elements(pr.steps) with ordinality as s(step, ord)
  where s.step ->> 'kind' <> 'use' or exists (select 1 from blocks b where b.id::text = s.step ->> 'block' and b.project_id = pr.project_id);
  insert into tests (project_id, name, use_case, priority, steps)
  values (pr.project_id, pr.name, pr.use_case, pr.priority, steps)
  returning id into tid;
  update test_proposals set status = 'accepted', test_id = tid, decided_by = auth.uid(), decided_at = now() where id = pr.id;
  return tid;
end;
$$;

create or replace function public.dismiss_proposal(p_proposal uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update test_proposals set status = 'dismissed', decided_by = auth.uid(), decided_at = now()
  where id = p_proposal and status = 'pending' and is_member(workspace_id);
  if not found then
    raise exception 'Proposal not found';
  end if;
end;
$$;

-- A new plan wakes the runner, like a run.
create or replace function public.plans_wake() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform wake_runner();
  return null;
end;
$$;
create trigger plans_wake after insert on public.plans
for each row execute function public.plans_wake();

-- AI credits count plans too.
create or replace function public.workspace_usage(p_workspace uuid)
returns table (plan text, period_start timestamptz, period_end timestamptz, minutes_used numeric, minutes_limit int, credits_used int, credits_limit int, projects_used int, projects_limit int)
language plpgsql stable security definer set search_path = public as $$
declare
  b workspace_billing;
  p text;
  ps timestamptz;
  pe timestamptz;
begin
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
         round((coalesce((select sum(r.duration_ms) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0)
              + coalesce((select sum(x.duration_ms) from explorations x where x.workspace_id = p_workspace and x.created_at >= ps), 0)) / 60000.0, 1),
         (plan_limits(p)).minutes,
         (coalesce((select sum(r.ai_calls) from runs r where r.workspace_id = p_workspace and r.created_at >= ps), 0)
          + coalesce((select sum(x.ai_calls) from explorations x where x.workspace_id = p_workspace and x.created_at >= ps), 0)
          + coalesce((select sum(pl.ai_calls) from plans pl where pl.workspace_id = p_workspace and pl.created_at >= ps), 0))::int,
         (plan_limits(p)).credits,
         (select count(*) from projects pr where pr.workspace_id = p_workspace)::int,
         (plan_limits(p)).projects;
end;
$$;

-- Every minute: also wake the runner for a plan that has been waiting.
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
end;
$$;

revoke execute on function public.start_plan(uuid, text) from public, anon;
grant execute on function public.start_plan(uuid, text) to authenticated;
revoke execute on function public.claim_plan(text) from public, anon, authenticated;
grant execute on function public.claim_plan(text) to service_role;
revoke execute on function public.accept_proposal(uuid) from public, anon;
grant execute on function public.accept_proposal(uuid) to authenticated;
revoke execute on function public.dismiss_proposal(uuid) from public, anon;
grant execute on function public.dismiss_proposal(uuid) to authenticated;
revoke execute on function public.plans_wake() from public, anon, authenticated;
revoke execute on function public.workspace_usage(uuid) from public, anon;
grant execute on function public.workspace_usage(uuid) to authenticated, service_role;
revoke execute on function public.minute_tick() from public, anon, authenticated;
