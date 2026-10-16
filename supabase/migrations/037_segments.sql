-- Segments (docs/conversion-parity.md Part 10, docs/conversion-weeks.md week 8): a rule tree of AND and OR groups,
-- up to 3 levels, over contact and company fields, custom objects, events, website visits, consent, sources and
-- other segments. A tree compiles to one SQL condition whose values are read from the tree itself as $2, so
-- nothing a person types becomes SQL. Dynamic segments refresh hourly and when saved; joining or leaving is a
-- contact event, which workflows will start from.

alter table public.segments add column if not exists updated_at timestamptz not null default now();
alter table public.segments add column if not exists error text check (length(error) <= 500);

-- The condition for one node. p_path is where the node sits in the tree, so its values are read as $2#>'{path}'.
create or replace function public.segment_sql(p_ws uuid, p_node jsonb, p_path text[], p_depth int) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p text := format('($2#>%L)', p_path::text);
  kind text := coalesce(p_node->>'kind', case when p_node ? 'rules' then 'group' end);
  parts text[] := '{}';
  i int := 0;
  w text;
  v_oid uuid;
  n int;
begin
  if jsonb_typeof(p_node) <> 'object' then
    raise exception 'Rules are not valid';
  end if;
  if kind = 'group' then
    if p_depth > 3 then
      raise exception 'Groups go 3 levels deep';
    end if;
    if jsonb_typeof(p_node->'rules') <> 'array' or jsonb_array_length(p_node->'rules') > 30 then
      raise exception 'Rules are not valid';
    end if;
    if jsonb_array_length(p_node->'rules') = 0 then
      return 'true';
    end if;
    for i in 0..jsonb_array_length(p_node->'rules') - 1 loop
      parts := parts || ('(' || segment_sql(p_ws, p_node->'rules'->i, p_path || array['rules', i::text], p_depth + 1) || ')');
    end loop;
    return array_to_string(parts, case when p_node->>'op' = 'or' then ' or ' else ' and ' end);
  end if;

  if kind = 'field' then
    -- A contact or company field, the same filters the lists use. Their values move to this node's place.
    w := object_where(p_ws, 'contact', jsonb_build_array(p_node - 'kind'));
    return replace(w, '$2->0->', p || '->');
  end if;

  if kind = 'event' then
    if coalesce(p_node->>'event', '') !~ '^[a-z][a-z0-9_.]{1,60}$' then raise exception 'Pick an event'; end if;
    if coalesce(p_node->>'days', '') !~ '^[0-9]{1,4}$' then raise exception 'Enter a number of days'; end if;
    if p_node->>'op' = 'none' then
      return format('not exists (select 1 from contact_events e where e.contact_id = c.id and e.kind = %1$s->>''event'' and e.at >= now() - make_interval(days => (%1$s->>''days'')::int))', p);
    end if;
    if coalesce(p_node->>'count', '1') !~ '^[0-9]{1,4}$' then raise exception 'Enter a number'; end if;
    return format('(select count(*) from contact_events e where e.contact_id = c.id and e.kind = %1$s->>''event'' and e.at >= now() - make_interval(days => (%1$s->>''days'')::int)) >= greatest(coalesce((%1$s->>''count'')::int, 1), 1)', p);
  end if;

  if kind = 'visit' then
    -- Page views on the site by the contact's person; a path may end in * ("/blog/*").
    if coalesce(p_node->>'days', '') !~ '^[0-9]{1,4}$' then raise exception 'Enter a number of days'; end if;
    if coalesce(p_node->>'count', '1') !~ '^[0-9]{1,4}$' then raise exception 'Enter a number'; end if;
    w := format($q$(select count(*) from sessions s join events e on e.session_id = s.id and e.kind = 'view'
        and e.day >= (now() - make_interval(days => (%1$s->>'days')::int))::date
      where c.person_id is not null and s.workspace_id = c.workspace_id and s.person_id = c.person_id and not s.is_bot
        and s.started_at >= now() - make_interval(days => (%1$s->>'days')::int)
        and (coalesce(%1$s->>'path', '') = '' or e.path like replace(replace(replace(replace(%1$s->>'path', '\', '\\'), '%%', '\%%'), '_', '\_'), '*', '%%')))$q$, p);
    if p_node->>'op' = 'none' then
      return w || ' = 0';
    end if;
    return format('%s >= greatest(coalesce((%s->>''count'')::int, 1), 1)', w, p);
  end if;

  if kind = 'consent' then
    w := $q$(not exists (select 1 from suppressions su where su.workspace_id = c.workspace_id and su.email_clean = c.email_clean)
      and coalesce((select k.basis from consents k where k.contact_id = c.id and k.channel = 'email' order by k.at desc, k.id limit 1), 'none') <> 'none')$q$;
    return case p_node->>'state'
      when 'sendable' then w
      when 'not_sendable' then 'not ' || w
      when 'suppressed' then 'exists (select 1 from suppressions su where su.workspace_id = c.workspace_id and su.email_clean = c.email_clean)'
      else null end;
  end if;

  if kind = 'source' then
    if coalesce(p_node->>'source_id', '') !~ '^[0-9a-f-]{36}$' or not exists (select 1 from sources where id = (p_node->>'source_id')::uuid and workspace_id = p_ws) then
      raise exception 'Pick a source';
    end if;
    w := format('exists (select 1 from source_links l where l.local_id = c.id and l.object = ''contact'' and l.deleted_at is null and l.source_id = (%s->>''source_id'')::uuid)', p);
    return case when p_node->>'op' = 'not_in' then 'not ' || w else w end;
  end if;

  if kind = 'object' then
    -- A custom object record linked to the contact (either way round) that matches its own filters.
    select id into v_oid from objects where workspace_id = p_ws and key = p_node->>'object';
    if v_oid is null then raise exception 'Pick an object'; end if;
    w := object_where(p_ws, p_node->>'object', coalesce(p_node->'filters', '[]'));
    w := replace(w, '$2->', format('(%s->''filters'')->', p));
    w := format($q$exists (select 1 from records r where r.object_id = %L and r.deleted_at is null
      and exists (select 1 from record_links l where (l.from_id = r.id and l.to_id = c.id) or (l.from_id = c.id and l.to_id = r.id))
      and (%s))$q$, v_oid, w);
    return case when p_node->>'op' = 'has_not' then 'not ' || w else w end;
  end if;

  raise exception 'Unknown rule';
end;
$$;

create or replace function public.segment_where(p_ws uuid, p_rules jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  w text;
begin
  if length(p_rules::text) > 50000 then
    raise exception 'Too many rules';
  end if;
  w := segment_sql(p_ws, coalesce(p_rules, '{"op":"and","rules":[]}'), '{}', 1);
  if w is null then
    raise exception 'Rules are not valid';
  end if;
  return w;
end;
$$;

-- How many contacts match, and ten of them, while someone builds a segment. Kept to 3 seconds.
create or replace function public.segment_preview(p_ws uuid, p_rules jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w text;
  out jsonb;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  w := segment_where(p_ws, p_rules);
  set local statement_timeout = '3s';
  execute format($q$select jsonb_build_object(
      'count', (select count(*) from contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
                where c.workspace_id = $1 and c.deleted_at is null and (%1$s)),
      'sample', coalesce((select jsonb_agg(x) from (
                select c.id, c.email, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as name, co.name as company
                from contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
                where c.workspace_id = $1 and c.deleted_at is null and (%1$s) order by c.updated_at desc limit 10) x), '[]'))$q$, w)
    into out using p_ws, p_rules;
  return out;
end;
$$;

create or replace function public.segment_save(p_ws uuid, p_id uuid, p_name text, p_rules jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sid uuid := p_id;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name the segment';
  end if;
  perform segment_where(p_ws, p_rules);
  if sid is null then
    insert into segments (workspace_id, name, rules, kind, created_by) values (p_ws, left(trim(p_name), 120), p_rules, 'dynamic', auth.uid()) returning id into sid;
  else
    update segments set name = left(trim(p_name), 120), rules = p_rules, updated_at = now(), error = null
    where id = sid and workspace_id = p_ws and kind = 'dynamic';
    if not found then
      raise exception 'Segment not found';
    end if;
  end if;
  perform enqueue_job(p_ws, 'segment_refresh', sid::text, jsonb_build_object('segment_id', sid), 0, 3);
  return sid;
end;
$$;

create or replace function public.segment_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := (select workspace_id from segments where id = p_id);
begin
  if ws is null or not is_member(ws) then
    raise exception 'Segment not found';
  end if;
  delete from segments where id = p_id;
end;
$$;

-- Bring a dynamic segment's members up to date: who joined, who left, each one a contact event.
create or replace function public.segment_refresh(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g segments%rowtype;
  w text;
  joined int;
  gone int;
begin
  select * into g from segments where id = p_id for update;
  if g.id is null or g.kind <> 'dynamic' then
    return null;
  end if;
  begin
    w := segment_where(g.workspace_id, g.rules);
  exception when others then
    update segments set error = left(sqlerrm, 500), refreshed_at = now() where id = p_id;
    return jsonb_build_object('error', sqlerrm);
  end;
  create temp table if not exists _seg (contact_id uuid primary key) on commit drop;
  truncate _seg;
  execute format('insert into _seg select c.id from contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
                  where c.workspace_id = $1 and c.deleted_at is null and (%s)', w) using g.workspace_id, g.rules;

  with j as (
    insert into segment_members (workspace_id, segment_id, contact_id)
    select g.workspace_id, p_id, s.contact_id from _seg s
    on conflict (segment_id, contact_id) do update set left_at = null, entered_at = now()
    where segment_members.left_at is not null
    returning contact_id
  ), ev as (
    insert into contact_events (workspace_id, contact_id, kind, data, source)
    select g.workspace_id, j.contact_id, 'segment.entered', jsonb_build_object('segment_id', p_id, 'name', g.name), 'segment' from j
    returning 1
  )
  select count(*) into joined from ev;

  with l as (
    update segment_members m set left_at = now()
    where m.segment_id = p_id and m.left_at is null and not exists (select 1 from _seg s where s.contact_id = m.contact_id)
    returning contact_id
  ), ev as (
    insert into contact_events (workspace_id, contact_id, kind, data, source)
    select g.workspace_id, l.contact_id, 'segment.left', jsonb_build_object('segment_id', p_id, 'name', g.name), 'segment' from l
    returning 1
  )
  select count(*) into gone from ev;

  update segments set count = (select count(*) from _seg), refreshed_at = now(), error = null where id = p_id;
  truncate _seg;
  return jsonb_build_object('joined', joined, 'left', gone);
end;
$$;

create or replace function public.segment_refresh_now(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := (select workspace_id from segments where id = p_id);
begin
  if ws is null or not is_member(ws) then
    raise exception 'Segment not found';
  end if;
  perform enqueue_job(ws, 'segment_refresh', p_id::text, jsonb_build_object('segment_id', p_id), 0, 3);
end;
$$;

-- Every dynamic segment once an hour.
create or replace function public.segments_due() returns int
language plpgsql security definer set search_path = public as $$
declare
  s record;
  n int := 0;
begin
  for s in select id, workspace_id from segments where kind = 'dynamic' and (refreshed_at is null or refreshed_at < now() - interval '1 hour') order by refreshed_at nulls first limit 500 loop
    perform enqueue_job(s.workspace_id, 'segment_refresh', s.id::text, jsonb_build_object('segment_id', s.id), 0, 3);
    n := n + 1;
  end loop;
  return n;
end;
$$;

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
  perform sources_due();
  if extract(minute from now())::int % 5 = 0 then
    perform segments_due();
  end if;
  if extract(minute from now()) = 7 then
    perform prune_jobs();
  end if;
  if extract(hour from now()) = 3 and extract(minute from now()) = 17 then
    perform contact_events_roll();
    perform prune_history();
    perform prune_sync();
  end if;
end;
$$;
revoke execute on function public.minute_tick() from public, anon, authenticated;

revoke execute on function public.segment_sql(uuid, jsonb, text[], int) from public, anon, authenticated;
revoke execute on function public.segment_where(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.segment_refresh(uuid) from public, anon, authenticated;
revoke execute on function public.segments_due() from public, anon, authenticated;
grant execute on function public.segment_sql(uuid, jsonb, text[], int) to service_role;
grant execute on function public.segment_where(uuid, jsonb) to service_role;
grant execute on function public.segment_refresh(uuid) to service_role;
grant execute on function public.segments_due() to service_role;
revoke execute on function public.segment_preview(uuid, jsonb) from public, anon;
revoke execute on function public.segment_save(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function public.segment_delete(uuid) from public, anon;
revoke execute on function public.segment_refresh_now(uuid) from public, anon;
grant execute on function public.segment_preview(uuid, jsonb) to authenticated;
grant execute on function public.segment_save(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.segment_delete(uuid) to authenticated;
grant execute on function public.segment_refresh_now(uuid) to authenticated;
