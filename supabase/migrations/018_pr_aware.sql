-- PR-aware runs: a pull request's check runs only the tests its changed files can affect, picked by fixed rules and
-- Claude Haiku (the server does the picking). The check keeps why each test was picked. A pull request that adds a new
-- flow gets proposed tests for it (source says which pull request). A link can turn picking off to always run all.

alter table public.github_links add column if not exists pick_tests boolean not null default true;
alter table public.github_checks add column if not exists selection jsonb;
alter table public.github_checks add column if not exists ai_calls int not null default 0;
alter table public.test_proposals add column if not exists source text;

drop function if exists public.github_start_check(uuid, text, int, text);

-- Start a check, as before, with only the picked tests when p_test_ids is given. An empty list is a finished check.
create or replace function public.github_start_check(p_link uuid, p_sha text, p_pr int, p_base_url text default null, p_test_ids uuid[] default null, p_selection jsonb default null, p_ai_calls int default 0)
returns setof github_checks
language plpgsql security definer set search_path = public as $$
declare
  l github_links;
  e environments;
  t tests;
  u record;
  c github_checks;
  ids uuid[] := '{}';
  url text;
begin
  select * into l from github_links where id = p_link and enabled;
  if l.id is null then
    return;
  end if;
  select * into e from environments where id = l.environment_id;
  url := coalesce(nullif(trim(p_base_url), ''), e.base_url);
  if url !~ '^https?://[^\s/]+' then
    raise exception 'Not a web address: %', url;
  end if;
  e.base_url := url;
  if exists (select 1 from github_checks where link_id = l.id and head_sha = p_sha and base_url = url and status = 'pending') then
    return;
  end if;

  -- The picker found nothing the change can affect (only docs changed): a finished check, no runs.
  if p_test_ids is not null and cardinality(p_test_ids) = 0 then
    insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, pr_number, base_url, status, conclusion, error, selection, ai_calls)
    values (l.workspace_id, l.id, l.installation_id, l.repo_full_name, p_sha, p_pr, url, 'done', 'neutral', coalesce(p_selection ->> 'reason', 'No tests to run.'), p_selection, coalesce(p_ai_calls, 0))
    returning * into c;
    return next c;
    return;
  end if;

  select * into u from workspace_usage(l.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, pr_number, base_url, status, conclusion, error, selection, ai_calls)
    values (l.workspace_id, l.id, l.installation_id, l.repo_full_name, p_sha, p_pr, url, 'done', 'neutral', 'This month''s cloud minutes are used up.', p_selection, coalesce(p_ai_calls, 0))
    returning * into c;
    return next c;
    return;
  end if;

  for t in
    select * from tests
    where project_id = l.project_id
      and jsonb_array_length(coalesce(steps, '[]')) > 0
      and (l.scope = 'all' or use_case = l.use_case)
      and (p_test_ids is null or id = any (p_test_ids))
    order by use_case, name
    limit 50
  loop
    ids := ids || queue_run(t, e, 'ci', l.created_by);
  end loop;

  insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, pr_number, base_url, run_ids, status, conclusion, error, selection, ai_calls)
  values (l.workspace_id, l.id, l.installation_id, l.repo_full_name, p_sha, p_pr, url, ids,
          case when cardinality(ids) = 0 then 'done' else 'pending' end,
          case when cardinality(ids) = 0 then 'neutral' end,
          case when cardinality(ids) = 0 then 'No tests with steps to run.' end, p_selection, coalesce(p_ai_calls, 0))
  returning * into c;
  return next c;
end;
$$;

-- AI credits count the picking too.
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
          + coalesce((select sum(pl.ai_calls) from plans pl where pl.workspace_id = p_workspace and pl.created_at >= ps), 0)
          + coalesce((select sum(g.ai_calls) from github_checks g where g.workspace_id = p_workspace and g.created_at >= ps), 0))::int,
         (plan_limits(p)).credits,
         (select count(*) from projects pr where pr.workspace_id = p_workspace)::int,
         (plan_limits(p)).projects;
end;
$$;

revoke execute on function public.github_start_check(uuid, text, int, text, uuid[], jsonb, int) from public, anon, authenticated;
grant execute on function public.github_start_check(uuid, text, int, text, uuid[], jsonb, int) to service_role;
revoke execute on function public.workspace_usage(uuid) from public, anon;
grant execute on function public.workspace_usage(uuid) to authenticated, service_role;
