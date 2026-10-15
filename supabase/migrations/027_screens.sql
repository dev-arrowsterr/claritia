-- Read functions for the Visitors, Accounts and Account screens, plus ICP and feedback writes
-- (docs/m1-website-intelligence.md 4.3, Part 8). Each checks membership and returns only what the screen shows.

create or replace function public.visitors_live(p_ws uuid, p_hours int default 24, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.started_at desc) from (
      select s.id, s.started_at, s.ended_at, s.country, s.city, s.ref_class, s.source, s.referrer_host, s.device_type, s.policy,
             s.account_id, a.name as account_name, a.domain as account_domain, s.account_source,
             s.person_id, p.primary_email as person_email, s.person_level, s.pageviews, s.engaged_s,
             coalesce((select array_agg(x.path) from (select e.path from events e where e.session_id = s.id and e.kind = 'view' order by e.server_at limit 3) x), '{}') as pages
      from sessions s
      left join accounts a on a.id = s.account_id
      left join persons p on p.id = s.person_id
      where s.workspace_id = p_ws and s.started_at > now() - make_interval(hours => least(greatest(p_hours, 1), 720)) and not s.is_bot and not s.internal
      order by s.started_at desc
      limit least(greatest(p_limit, 1), 500)
    ) v
  ), '[]'::jsonb);
end;
$$;

create or replace function public.accounts_list(p_ws uuid, p_view text default 'all', p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.priority desc nulls last, v.last_signal_at desc nulls last) from (
      select a.id, a.name, a.domain, a.fit, a.intent, a.priority, a.stage, a.temperature, a.why_now, a.last_signal_at, a.first_seen,
             a.firmo->>'industry' as industry, a.firmo->>'size' as size, a.firmo->>'country' as country,
             (select count(distinct s.person_id) from sessions s where s.account_id = a.id and s.person_id is not null and s.started_at > now() - interval '30 days') as people,
             (select count(*) from sessions s where s.account_id = a.id and s.started_at > now() - interval '7 days' and not s.is_bot) as sessions_7d,
             (select f.kind from account_feedback f where f.account_id = a.id order by f.created_at desc limit 1) as feedback
      from accounts a
      where a.workspace_id = p_ws
        and case p_view
              when 'hot' then a.temperature = 'hot'
              when 'evaluating' then a.stage = 'evaluating'
              when 'new' then a.first_seen > now() - interval '7 days'
              when 'fit_quiet' then a.fit >= 70 and coalesce(a.last_signal_at, a.first_seen) < now() - interval '30 days'
              else true end
      order by a.priority desc nulls last, a.last_signal_at desc nulls last
      limit least(greatest(p_limit, 1), 1000)
    ) v
  ), '[]'::jsonb);
end;
$$;

create or replace function public.account_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a accounts%rowtype;
begin
  select * into a from accounts where id = p_id;
  if a.id is null or not is_member(a.workspace_id) then
    raise exception 'Account not found';
  end if;
  return jsonb_build_object(
    'account', to_jsonb(a) - 'workspace_id',
    'people', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.last_seen desc) from (
        select p.id, p.primary_email as email, max(s.person_level) as level, max(s.started_at) as last_seen, count(*) as sessions
        from sessions s join persons p on p.id = s.person_id
        where s.account_id = a.id
        group by p.id, p.primary_email
      ) x), '[]'::jsonb),
    'unknown', (select jsonb_build_object('devices', count(distinct coalesce(s.device_id::text, encode(s.cookieless_key, 'hex'))), 'sessions', count(*))
                from sessions s where s.account_id = a.id and s.person_id is null and not s.is_bot),
    'networks', coalesce((
      select jsonb_agg(distinct jsonb_build_object('net', s.ip_net::text, 'source', s.account_source))
      from sessions s where s.account_id = a.id and s.ip_net is not null and s.account_source in ('learned_network', 'vendor_network')), '[]'::jsonb),
    'signals', coalesce((
      select jsonb_agg(jsonb_build_object('kind', g.kind, 'weight', g.weight, 'at', g.at, 'person_id', g.person_id, 'evidence', g.evidence) order by g.at desc)
      from signals g where g.account_id = a.id and g.at > now() - interval '90 days'), '[]'::jsonb),
    'half_lives', coalesce((select jsonb_object_agg(kind, half_life_days) from signal_types where workspace_id = a.workspace_id), '{}'::jsonb),
    'icp', (select rules from icp where workspace_id = a.workspace_id),
    'k', coalesce((select k from intent_params where workspace_id = a.workspace_id), 60)
  );
end;
$$;

create or replace function public.account_timeline(p_id uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from accounts where id = p_id;
  if ws is null or not is_member(ws) then
    raise exception 'Account not found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.started_at desc) from (
      select s.id, s.started_at, s.ended_at, s.person_id, p.primary_email as person_email, s.person_level, s.person_source,
             s.ref_class, s.referrer_host, s.country, s.engaged_s, s.account_source,
             coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'path', e.path, 'at', e.server_at, 'data', e.data) order by e.server_at)
                       from events e where e.session_id = s.id and e.kind in ('view', 'form', 'identify')), '[]'::jsonb) as events,
             coalesce((select jsonb_agg(g.kind) from signals g where g.account_id = p_id and g.evidence->>'session_id' = s.id::text), '[]'::jsonb) as signals
      from sessions s left join persons p on p.id = s.person_id
      where s.account_id = p_id and not s.is_bot
      order by s.started_at desc
      limit least(greatest(p_limit, 1), 200)
    ) v
  ), '[]'::jsonb);
end;
$$;

create or replace function public.site_health(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.created_at) from (
      select st.id, st.domain, st.extra_domains, st.site_key, st.proxy_secret, st.install_mode, st.last_event_at, st.paused, st.created_at,
             (select count(*) from sessions s where s.site_id = st.id and s.started_at > now() - interval '24 hours' and not s.is_bot) as sessions_24h,
             (select count(*) filter (where s.person_id is not null) from sessions s where s.site_id = st.id and s.started_at > now() - interval '24 hours' and not s.is_bot) as identified_24h,
             (select count(*) filter (where s.account_id is not null) from sessions s where s.site_id = st.id and s.started_at > now() - interval '24 hours' and not s.is_bot) as with_account_24h
      from sites st where st.workspace_id = p_ws
    ) v
  ), '[]'::jsonb);
end;
$$;

-- ICP rules. Any member may set them; every account is rescored.
create or replace function public.set_icp(p_ws uuid, p_rules jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if jsonb_typeof(p_rules) <> 'object' or length(p_rules::text) > 20000 then
    raise exception 'These ICP rules are not valid';
  end if;
  insert into icp (workspace_id, rules, updated_at) values (p_ws, p_rules, now())
  on conflict (workspace_id) do update set rules = excluded.rules, updated_at = now();
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'icp.update', p_ws::text);
  perform enqueue_job(p_ws, 'score_account', a.id::text, jsonb_build_object('account_id', a.id), 5) from accounts a where a.workspace_id = p_ws;
end;
$$;

-- Rep feedback on an account (docs/account-intelligence.md 8.5).
create or replace function public.account_feedback_add(p_account uuid, p_kind text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from accounts where id = p_account;
  if ws is null or not is_member(ws) then
    raise exception 'Account not found';
  end if;
  insert into account_feedback (workspace_id, account_id, user_id, kind, note) values (ws, p_account, auth.uid(), p_kind, nullif(trim(p_note), ''));
end;
$$;

revoke execute on function public.visitors_live(uuid, int, int) from public, anon;
revoke execute on function public.accounts_list(uuid, text, int) from public, anon;
revoke execute on function public.account_detail(uuid) from public, anon;
revoke execute on function public.account_timeline(uuid, int) from public, anon;
revoke execute on function public.site_health(uuid) from public, anon;
revoke execute on function public.set_icp(uuid, jsonb) from public, anon;
revoke execute on function public.account_feedback_add(uuid, text, text) from public, anon;
grant execute on function public.visitors_live(uuid, int, int) to authenticated;
grant execute on function public.accounts_list(uuid, text, int) to authenticated;
grant execute on function public.account_detail(uuid) to authenticated;
grant execute on function public.account_timeline(uuid, int) to authenticated;
grant execute on function public.site_health(uuid) to authenticated;
grant execute on function public.set_icp(uuid, jsonb) to authenticated;
grant execute on function public.account_feedback_add(uuid, text, text) to authenticated;
