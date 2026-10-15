-- Visitors screen: the device id (for each visitor's stable fun name) and up to 12 pages in order with
-- their time, for the visitor panel (docs/m1-website-intelligence.md 8.4).

create or replace function public.visitors_live(p_ws uuid, p_hours int default 24, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.started_at desc) from (
      select s.id, s.device_id, s.started_at, s.ended_at, s.country, s.city, s.ref_class, s.source, s.referrer_host, s.device_type, s.policy,
             s.account_id, a.name as account_name, a.domain as account_domain, s.account_source,
             s.person_id, p.primary_email as person_email, s.person_level, s.pageviews, s.engaged_s,
             coalesce((select array_agg(x.path order by x.server_at) from (select e.path, e.server_at from events e where e.session_id = s.id and e.kind = 'view' order by e.server_at limit 12) x), '{}') as pages,
             coalesce((select array_agg(x.server_at order by x.server_at) from (select e.server_at from events e where e.session_id = s.id and e.kind = 'view' order by e.server_at limit 12) x), '{}') as page_times
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
