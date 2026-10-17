-- Two-way CRM sync, part 2: which side wins each field, the Claritia score written back, and email and form
-- activity written to the CRM's timeline (HubSpot) or as completed tasks (Salesforce).
--   mappings.wins: when both sides changed a field since they last agreed, 'claritia', 'crm' or 'newest' wins. A
--     change on one side only always goes across.
--   score and score_band: targets that only go out, so a CRM never overwrites the score.
--   activity_out: one row per contact event and source. A row is claimed before the call and never sent twice:
--     one left 'sending' turns 'unknown'.

-- Mappings ----------------------------------------------------------------------------------------------------

alter table public.mappings add column if not exists wins text not null default 'claritia' check (wins in ('claritia', 'crm', 'newest'));
alter table public.mappings drop constraint if exists mappings_target_check;
alter table public.mappings add constraint mappings_target_check check (target ~ '^(skip|email|name|first_name|last_name|title|phone|company|website|country|region|timezone|lifecycle|lead_status|basis|industry|size|domain|score|score_band|f\.[a-z][a-z0-9_]{0,39})$');

create or replace function public.mapping_save(p_source uuid, p_object text, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
begin
  select * into s from sources where id = p_source;
  if s.id is null or not is_owner(s.workspace_id) then
    raise exception 'Only owners can change sources';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Up to 500 columns';
  end if;
  if (select count(*) from jsonb_to_recordset(p_rows) r(col text, target text) where r.target not in ('skip')) <>
     (select count(distinct r.target) from jsonb_to_recordset(p_rows) r(col text, target text) where r.target not in ('skip')) then
    raise exception 'Each field can take one column';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) r(wins text) where r.wins is not null and r.wins not in ('claritia', 'crm', 'newest')) then
    raise exception 'Pick Claritia, CRM or Newest';
  end if;
  delete from mappings where source_id = p_source and object = p_object;
  insert into mappings (workspace_id, source_id, object, col, target, value_map, wins, position)
  select s.workspace_id, p_source, p_object, r.col, r.target, coalesce(r.value_map, '{}'),
         case when r.target in ('score', 'score_band') then 'claritia' else coalesce(r.wins, 'claritia') end, r.n
  from rows from (jsonb_to_recordset(p_rows) as (col text, target text, value_map jsonb, wins text)) with ordinality as r(col, target, value_map, wins, n);
end;
$$;

create or replace function public.source_load(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('source', to_jsonb(s), 'sealed', k.sealed, 'hook_sealed', k.hook_sealed,
    'mappings', coalesce((select jsonb_agg(jsonb_build_object('object', m.object, 'col', m.col, 'target', m.target, 'value_map', m.value_map, 'wins', m.wins) order by m.object, m.position)
                          from mappings m where m.source_id = s.id), '[]'))
  from sources s left join source_secrets k on k.source_id = s.id where s.id = p_id;
$$;

-- The push candidates now carry the score and each value's source and time, for the conflict rule.
create or replace function public.push_candidates(p_source uuid, p_after text, p_limit int default 200, p_ids uuid[] default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select * from sources where id = p_source)
  select coalesce(jsonb_agg(x order by x->>'updated_at', x->>'id'), '[]') from (
    select jsonb_build_object(
      'id', c.id, 'updated_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'email', c.email, 'email_clean', c.email_clean, 'first_name', c.first_name, 'last_name', c.last_name, 'title', c.title, 'phone', c.phone,
      'country', c.country, 'region', c.region, 'timezone', c.timezone, 'lifecycle', c.lifecycle, 'lead_status', c.lead_status, 'fields', c.fields,
      'score', c.score, 'score_band', c.score_band, 'sources', c.field_sources,
      'company_name', co.name, 'company_domain', co.domain,
      'external_id', l.external_id, 'last', l.last_values,
      'suppressed', exists (select 1 from suppressions su where su.workspace_id = c.workspace_id and su.email_clean = c.email_clean)) x
    from s join contacts c on c.workspace_id = s.workspace_id and c.deleted_at is null
    left join companies co on co.id = c.company_id
    left join source_links l on l.source_id = s.id and l.object = 'contact' and l.local_id = c.id and l.deleted_at is null
    where (p_ids is null and (p_after is null or (c.updated_at, c.id::text) > (split_part(p_after, '|', 1)::timestamptz, split_part(p_after, '|', 2))))
       or c.id = any(p_ids)
    order by c.updated_at, c.id
    limit least(p_limit, 1000)
  ) y;
$$;

-- A score change is a change to push.
create or replace function public.contacts_score_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.score is distinct from old.score or new.score_band is distinct from old.score_band then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists contacts_score_touch on public.contacts;
create trigger contacts_score_touch before update of score, score_band on public.contacts for each row execute function public.contacts_score_touch();

create or replace function public.source_settings_ok(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'object'
    and coalesce(p->'objects'->>'contacts', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'companies', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'lists', 'in') in ('in', 'off')
    and coalesce(p->'objects'->>'suppressions', 'in') in ('in', 'off')
    and coalesce(p->>'push_new', 'lifecycle') in ('all', 'lifecycle', 'none')
    and coalesce(p->>'basis', 'none') in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')
    and coalesce(jsonb_typeof(p->'activity'), 'boolean') = 'boolean'
    and coalesce((p->>'every_min')::int, 60) between 2 and 1440;
$$;

-- Activity out ------------------------------------------------------------------------------------------------

alter table public.sources add column if not exists activity_at timestamptz;

create table if not exists public.activity_out (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  event_id uuid not null,
  kind text not null check (length(kind) <= 60),
  contact_id uuid,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'unknown')),
  external_id text check (length(external_id) <= 200),
  error text check (length(error) <= 500),
  claimed_at timestamptz not null default now(),
  primary key (source_id, event_id)
);
create index if not exists activity_out_sending on public.activity_out (claimed_at) where status = 'sending';
alter table public.activity_out enable row level security;
create policy "members read" on public.activity_out for select using (is_member(workspace_id));
revoke all on public.activity_out from anon;
revoke insert, update, delete on public.activity_out from authenticated;

-- Kinds a CRM hears about.
create or replace function public.activity_kinds() returns text[]
language sql immutable as $$ select array['email.sent', 'email.clicked', 'email.unsubscribed', 'form.submitted'] $$;

-- Events from the last 3 days for contacts linked to this source, not yet claimed, with what the CRM shows.
create or replace function public.activity_candidates(p_source uuid, p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select * from sources where id = p_source)
  select coalesce(jsonb_agg(x order by x->>'at', x->>'id'), '[]') from (
    select jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'at', to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'contact_id', e.contact_id,
      'external_id', l.external_id, 'data', e.data,
      'subject', (select em.subject from emails em where em.id = nullif(e.data->>'email_id', '')::uuid and em.workspace_id = e.workspace_id)) x
    from s join contact_events e on e.workspace_id = s.workspace_id and e.kind = any(activity_kinds()) and e.at > now() - interval '3 days'
    join source_links l on l.source_id = s.id and l.object = 'contact' and l.local_id = e.contact_id and l.deleted_at is null
    where not exists (select 1 from activity_out a where a.source_id = s.id and a.event_id = e.id)
    order by e.at, e.id
    limit least(greatest(p_limit, 1), 500)
  ) y;
$$;

-- Claim events before writing them. Returns the ids this call claimed; a second worker gets none of them.
create or replace function public.activity_claim(p_source uuid, p_events jsonb) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  out uuid[];
begin
  select workspace_id into ws from sources where id = p_source;
  if ws is null then return '{}'; end if;
  update activity_out set status = 'unknown', error = 'The worker stopped mid-write; not sent again in case it went out'
  where source_id = p_source and status = 'sending' and claimed_at < now() - interval '10 minutes';
  with ins as (
    insert into activity_out (workspace_id, source_id, event_id, kind, contact_id)
    select ws, p_source, r.id, r.kind, r.contact_id from jsonb_to_recordset(p_events) r(id uuid, kind text, contact_id uuid)
    on conflict (source_id, event_id) do nothing
    returning event_id
  )
  select coalesce(array_agg(event_id), '{}') into out from ins;
  return out;
end;
$$;

-- Results: [{id, status: sent | failed | unknown, external_id?, error?}]. Failures are logged in the sync log.
create or replace function public.activity_done(p_source uuid, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  update activity_out a set status = r.status, external_id = left(r.external_id, 200), error = left(r.error, 500)
  from jsonb_to_recordset(p_rows) r(id uuid, status text, external_id text, error text)
  where a.source_id = p_source and a.event_id = r.id and a.status = 'sending' and r.status in ('sent', 'failed', 'unknown');
  insert into sync_log (workspace_id, source_id, direction, object, local_id, external_id, action, fields, error)
  select a.workspace_id, a.source_id, 'out', 'activity', a.contact_id, left(a.external_id, 200),
         case when r.status = 'sent' then 'create' else 'error' end, array[a.kind], left(r.error, 1000)
  from jsonb_to_recordset(p_rows) r(id uuid, status text, external_id text, error text)
  join activity_out a on a.source_id = p_source and a.event_id = r.id;
  update sources set activity_at = now() where id = p_source;
end;
$$;

-- Each minute: pulls when due, pushes when contacts changed, and activity when there are new events. Two-way CRMs
-- write activity unless settings.activity is false.
create or replace function public.sources_due() returns int
language plpgsql security definer set search_path = public as $$
declare
  s record;
  n int := 0;
begin
  for s in select id, workspace_id from sources where status = 'active' and next_run_at <= now() order by next_run_at limit 500 loop
    perform enqueue_job(s.workspace_id, 'source_pull', s.id::text, jsonb_build_object('source_id', s.id), 0, 5);
    update sources set next_run_at = now() + make_interval(mins => coalesce((settings->>'every_min')::int, 60)) where id = s.id;
    n := n + 1;
  end loop;
  for s in
    select so.id, so.workspace_id from sources so
    where so.status = 'active' and (so.settings->'objects'->>'contacts') = 'both'
      and exists (select 1 from contacts c where c.workspace_id = so.workspace_id and c.deleted_at is null
                  and (so.push_cursor is null or c.updated_at > split_part(so.push_cursor, '|', 1)::timestamptz))
    limit 500
  loop
    perform enqueue_job(s.workspace_id, 'crm_push', s.id::text, jsonb_build_object('source_id', s.id), 0, 5);
    n := n + 1;
  end loop;
  for s in
    select so.id, so.workspace_id from sources so
    where so.status = 'active' and so.kind in ('hubspot', 'salesforce') and coalesce((so.settings->>'activity')::boolean, true)
      and (so.activity_at is null or so.activity_at < now() - interval '1 hour'
           or exists (select 1 from contact_events e where e.workspace_id = so.workspace_id and e.kind = any(activity_kinds())
                      and e.at > so.activity_at - interval '1 minute'))
    limit 500
  loop
    perform enqueue_job(s.workspace_id, 'crm_activity', s.id::text, jsonb_build_object('source_id', s.id), 0, 5);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.prune_sync() returns void
language sql security definer set search_path = public as $$
  delete from sync_log where at < now() - interval '90 days';
  delete from source_runs where started_at < now() - interval '90 days';
  delete from hook_events where (done_at is not null and done_at < now() - interval '7 days') or received_at < now() - interval '30 days';
  delete from activity_out where claimed_at < now() - interval '7 days';
$$;

-- Grants ------------------------------------------------------------------------------------------------------

revoke execute on function public.contacts_score_touch() from public, anon, authenticated;
revoke execute on function public.activity_candidates(uuid, int) from public, anon, authenticated;
revoke execute on function public.activity_claim(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.activity_done(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.activity_candidates(uuid, int) to service_role;
grant execute on function public.activity_claim(uuid, jsonb) to service_role;
grant execute on function public.activity_done(uuid, jsonb) to service_role;
