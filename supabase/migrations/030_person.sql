-- Person page and Privacy search (docs/m1-website-intelligence.md 8.7, 8.8; docs/identity.md Part 13, 14).

-- Everything the Person page shows. A merged person answers with the id it moved to.
create or replace function public.person_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p persons%rowtype;
  moved uuid;
begin
  select * into p from persons where id = p_id;
  if p.id is null then
    select new_id into moved from person_aliases where old_id = p_id;
    if moved is not null and exists (select 1 from person_aliases where old_id = p_id and is_member(workspace_id)) then
      return jsonb_build_object('moved_to', moved);
    end if;
    raise exception 'Person not found';
  end if;
  if not is_member(p.workspace_id) then
    raise exception 'Person not found';
  end if;
  if p.merged_into is not null then
    return jsonb_build_object('moved_to', p.merged_into);
  end if;
  return jsonb_build_object(
    'person', jsonb_build_object(
      'id', p.id, 'name', p.display_name, 'email', p.primary_email, 'partner', p.partner, 'opted_out', p.opted_out, 'created_at', p.created_at,
      'level', (select l.level from device_links l where l.person_id = p.id and l.to_at is null
                order by case l.level when 'verified' then 0 when 'asserted' then 1 else 2 end limit 1),
      'account', (select jsonb_build_object('id', a.id, 'name', a.name, 'domain', a.domain) from accounts a where a.id = p.account_id)),
    'identifiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'value', i.value_clean, 'class', i.class, 'created_at', i.created_at,
        'first', (select jsonb_build_object('source', e.source, 'level', e.level, 'at', e.server_at, 'page', e.extra->>'page')
                  from identity_evidence e where e.workspace_id = p.workspace_id and e.revoked_at is null
                    and evidence_names(e.identifiers, i.kind, i.value_clean, i.value_raw)
                  order by e.server_at limit 1)) order by i.created_at)
      from identifiers i where i.workspace_id = p.workspace_id and i.person_id = p.id), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'state', d.state, 'first_seen', d.first_seen, 'last_seen', d.last_seen, 'sessions', d.sessions,
        'browser', (select s.browser from sessions s where s.device_id = d.id order by s.started_at desc limit 1),
        'os', (select s.os from sessions s where s.device_id = d.id order by s.started_at desc limit 1),
        'device_type', (select s.device_type from sessions s where s.device_id = d.id order by s.started_at desc limit 1),
        'links', (select jsonb_agg(jsonb_build_object('level', l.level, 'from', l.from_at, 'to', l.to_at) order by l.from_at)
                  from device_links l where l.device_id = d.id and l.person_id = p.id)) order by d.last_seen desc)
      from devices d where d.workspace_id = p.workspace_id and d.id in (select l.device_id from device_links l where l.workspace_id = p.workspace_id and l.person_id = p.id)), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'source', e.source, 'level', e.level, 'at', e.server_at, 'page', e.extra->>'page', 'device_id', e.device_id,
        'ignored', e.ignored, 'revoked_at', e.revoked_at, 'revoke_reason', e.revoke_reason,
        'linked', exists (select 1 from device_links l where l.evidence_id = e.id and l.person_id = p.id)) order by e.server_at desc)
      from (
        select e.* from identity_evidence e
        where e.workspace_id = p.workspace_id
          and exists (select 1 from identifiers i where i.workspace_id = p.workspace_id and i.person_id = p.id
                      and evidence_names(e.identifiers, i.kind, i.value_clean, i.value_raw))
        order by e.server_at desc limit 100
      ) e), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.started_at desc) from (
        select s.id, s.started_at, s.device_id, s.person_level, s.person_source, s.pageviews, s.engaged_s, s.landing_path, s.ref_class, s.referrer_host, s.country
        from sessions s where s.workspace_id = p.workspace_id and s.person_id = p.id and not s.is_bot
        order by s.started_at desc limit 50
      ) x), '[]'::jsonb)
  );
end;
$$;

-- Privacy search: people with this email (or whose email starts with it). Owners only.
create or replace function public.privacy_find(p_ws uuid, p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q text := lower(trim(coalesce(p_email, '')));
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can do this';
  end if;
  if length(q) < 3 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.exact desc, x.email) from (
      select distinct on (p.id) p.id, i.value_clean as email, p.display_name as name, a.name as account_name, a.domain as account_domain,
             (i.value_clean = q) as exact,
             (select count(*) from sessions s where s.workspace_id = p_ws and s.person_id = p.id) as sessions
      from identifiers i join persons p on p.id = i.person_id and p.merged_into is null
      left join accounts a on a.id = p.account_id
      where i.workspace_id = p_ws and i.kind = 'email'
        and (i.value_clean = q or i.value_clean like replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      order by p.id, (i.value_clean = q) desc
      limit 20
    ) x
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.person_detail(uuid) from public, anon;
revoke execute on function public.privacy_find(uuid, text) from public, anon;
grant execute on function public.person_detail(uuid) to authenticated;
grant execute on function public.privacy_find(uuid, text) to authenticated;
