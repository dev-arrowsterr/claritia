-- Warehouses and databases as sources (docs/contact-sources.md Part 8, docs/conversion-weeks.md week 8). A source
-- is a saved read-only query that runs on a schedule and continues from its last cursor. Its rows become contacts,
-- companies, activity on contacts, or records of a custom object. A row read twice (the cursor overlaps) lands once.

alter table public.source_links drop constraint if exists source_links_object_check;
alter table public.source_links add constraint source_links_object_check check (object in ('contact', 'company', 'list', 'record'));

-- Rows already turned into activity, so a replay adds nothing. Kept as long as the activity (13 months).
create table if not exists public.source_event_keys (
  source_id uuid not null references public.sources (id) on delete cascade,
  key text not null check (length(key) <= 300),
  at timestamptz not null default now(),
  primary key (source_id, key)
);
alter table public.source_event_keys enable row level security;
revoke all on public.source_event_keys from anon, authenticated;

-- Activity from a source: [{key, email_clean, kind, at, data}]. Contacts are found by cleaned email.
create or replace function public.events_ingest(p_source uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  added int;
  unknown int;
begin
  select * into s from sources where id = p_source;
  if s.id is null then
    raise exception 'Source not found';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send up to 5,000 rows at a time';
  end if;
  create temp table if not exists _ev (key text, email_clean text, kind text, at timestamptz, data jsonb, contact_id uuid) on commit drop;
  truncate _ev;
  insert into _ev (key, email_clean, kind, at, data)
  select distinct on (r.key) left(r.key, 300), lower(trim(r.email_clean)), r.kind, coalesce(r.at, now()), coalesce(r.data, '{}')
  from jsonb_to_recordset(p_rows) as r(key text, email_clean text, kind text, at timestamptz, data jsonb)
  where coalesce(r.key, '') <> '' and r.kind ~ '^[a-z][a-z0-9_.]{1,60}$' and r.at is distinct from 'infinity'::timestamptz
    and coalesce(r.at, now()) > now() - interval '13 months' and coalesce(r.at, now()) < now() + interval '1 day';
  update _ev e set contact_id = c.id from contacts c where c.workspace_id = s.workspace_id and c.deleted_at is null and c.email_clean = e.email_clean;
  select count(*) into unknown from _ev where contact_id is null;
  delete from _ev where contact_id is null;
  -- Only keys never seen before.
  with fresh as (
    insert into source_event_keys (source_id, key) select p_source, key from _ev on conflict do nothing returning key
  ), ins as (
    insert into contact_events (workspace_id, contact_id, kind, data, source, at)
    select s.workspace_id, e.contact_id, e.kind, e.data, s.kind, e.at from _ev e join fresh f on f.key = e.key
    returning 1
  )
  select count(*) into added from ins;
  truncate _ev;
  return jsonb_build_object('added', added, 'no_contact', unknown);
end;
$$;

-- Records of a custom object from a source: [{id, name, fields, email_clean}]. A record is found by its id in the
-- source; fields are checked against the object's fields; an email links it to that contact through the object's
-- first relation field to contacts.
create or replace function public.records_ingest(p_source uuid, p_object text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  v_oid uuid;
  link_field uuid;
  r record;
  rid uuid;
  f fields%rowtype;
  k text;
  v jsonb;
  clean jsonb;
  created int := 0;
  updated int := 0;
  ids jsonb := '[]';
  cid uuid;
begin
  select * into s from sources where id = p_source;
  select id into v_oid from objects where workspace_id = s.workspace_id and key = p_object;
  if v_oid is null then
    raise exception 'Object not found';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send up to 5,000 rows at a time';
  end if;
  select id into link_field from fields
  where workspace_id = s.workspace_id and object = p_object and type = 'relation' and config->>'target' = 'contact' order by position, created_at limit 1;
  for r in select * from jsonb_to_recordset(p_rows) as x(id text, name text, fields jsonb, email_clean text) loop
    if coalesce(r.id, '') = '' then
      ids := ids || 'null'::jsonb;
      continue;
    end if;
    clean := '{}';
    for k, v in select * from jsonb_each(coalesce(r.fields, '{}')) loop
      select * into f from fields where workspace_id = s.workspace_id and object = p_object and key = k and type <> 'relation';
      continue when f.id is null;
      begin
        v := field_value(s.workspace_id, f.type, f.options, f.label, v);
      exception when others then
        v := null;
      end;
      if v is not null then clean := clean || jsonb_build_object(k, v); end if;
    end loop;
    select id into rid from records where object_id = v_oid and source_ids->>s.kind = r.id and deleted_at is null limit 1;
    if rid is null then
      insert into records (workspace_id, object_id, name, fields, source_ids, field_sources)
      values (s.workspace_id, v_oid, left(coalesce(nullif(trim(r.name), ''), r.id), 300), clean, jsonb_build_object(s.kind, left(r.id, 200)),
              (select coalesce(jsonb_object_agg('f.' || x, jsonb_build_object('s', s.kind, 'at', now())), '{}') from jsonb_object_keys(clean) x))
      returning id into rid;
      created := created + 1;
    else
      update records set
        name = left(coalesce(nullif(trim(r.name), ''), name), 300),
        fields = fields || clean,
        field_sources = field_sources || (select coalesce(jsonb_object_agg('f.' || x, jsonb_build_object('s', s.kind, 'at', now())), '{}') from jsonb_object_keys(clean) x),
        updated_at = case when fields || clean is distinct from fields or coalesce(nullif(trim(r.name), ''), name) is distinct from name then now() else updated_at end
      where id = rid;
      updated := updated + 1;
    end if;
    if link_field is not null and coalesce(r.email_clean, '') <> '' then
      select id into cid from contacts where workspace_id = s.workspace_id and deleted_at is null and email_clean = lower(trim(r.email_clean));
      if cid is not null then
        insert into record_links (workspace_id, field_id, from_object, from_id, to_object, to_id)
        values (s.workspace_id, link_field, p_object, rid, 'contact', cid) on conflict do nothing;
      end if;
    end if;
    ids := ids || to_jsonb(rid);
  end loop;
  return jsonb_build_object('ids', ids, 'created', created, 'updated', updated);
end;
$$;

create or replace function public.prune_sync() returns void
language sql security definer set search_path = public as $$
  delete from sync_log where at < now() - interval '90 days';
  delete from source_runs where started_at < now() - interval '90 days';
  delete from hook_events where (done_at is not null and done_at < now() - interval '7 days') or received_at < now() - interval '30 days';
  delete from source_event_keys where at < now() - interval '13 months';
$$;

revoke execute on function public.events_ingest(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.records_ingest(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.events_ingest(uuid, jsonb) to service_role;
grant execute on function public.records_ingest(uuid, text, jsonb) to service_role;
