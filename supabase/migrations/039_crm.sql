-- Claritia migration 039: the CRM (Contacts, Companies, Opportunities), the team and sending domains.
-- Opportunities are a built-in object on the records tables: every workspace has one, it can't be removed, and its
-- standard fields can't be deleted. CRMs fill it through opportunities_ingest. Run after 038. Safe to run more than once.

alter table public.objects add column if not exists system boolean not null default false;
alter table public.fields add column if not exists system boolean not null default false;

-- Opportunities --------------------------------------------------------------------------------------------------

create or replace function public.crm_seed(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into objects (workspace_id, key, label, plural, icon, system) values (p_ws, 'opportunity', 'Opportunity', 'Opportunities', 'dollar', true)
  on conflict (workspace_id, key) do update set system = true;
  insert into fields (workspace_id, object, key, label, type, options, config, position, system) values
    (p_ws, 'opportunity', 'amount', 'Amount', 'currency', '[]', '{"currency":"USD","decimals":0}', 1, true),
    (p_ws, 'opportunity', 'stage', 'Stage', 'select',
     '[{"value":"qualification","label":"Qualification","kind":"open"},{"value":"discovery","label":"Discovery","kind":"open"},
       {"value":"proposal","label":"Proposal","kind":"open"},{"value":"negotiation","label":"Negotiation","kind":"open"},
       {"value":"won","label":"Won","kind":"won"},{"value":"lost","label":"Lost","kind":"lost"}]', '{}', 2, true),
    (p_ws, 'opportunity', 'close_date', 'Close date', 'date', '[]', '{}', 3, true),
    (p_ws, 'opportunity', 'probability', 'Win chance', 'percent', '[]', '{}', 4, true),
    (p_ws, 'opportunity', 'company', 'Company', 'relation', '[]', '{"target":"company"}', 5, true),
    (p_ws, 'opportunity', 'contacts', 'Contacts', 'relation', '[]', '{"target":"contact","multiple":true}', 6, true),
    (p_ws, 'opportunity', 'owner', 'Owner', 'text', '[]', '{}', 7, true),
    (p_ws, 'opportunity', 'pipeline', 'Pipeline', 'text', '[]', '{}', 8, true),
    (p_ws, 'opportunity', 'next_step', 'Next step', 'text', '[]', '{}', 9, true),
    (p_ws, 'opportunity', 'crm_url', 'CRM link', 'url', '[]', '{}', 10, true)
  on conflict (workspace_id, object, key) do update set system = true;
end;
$$;

select public.crm_seed(id) from public.workspaces;

create or replace function public.workspaces_seed_crm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform crm_seed(new.id);
  return new;
end;
$$;
drop trigger if exists workspaces_seed_crm on public.workspaces;
create trigger workspaces_seed_crm after insert on public.workspaces for each row execute function public.workspaces_seed_crm();

-- Built-in objects and fields stay.
create or replace function public.object_delete(p_ws uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can do this';
  end if;
  if exists (select 1 from objects where workspace_id = p_ws and key = p_key and system) then
    raise exception 'This object is built in';
  end if;
  delete from record_links where workspace_id = p_ws and (from_object = p_key or to_object = p_key);
  delete from fields where workspace_id = p_ws and object = p_key;
  delete from saved_views where workspace_id = p_ws and screen = 'object:' || p_key;
  delete from objects where workspace_id = p_ws and key = p_key;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'object.delete', p_key);
end;
$$;

create or replace function public.field_delete(p_ws uuid, p_object text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  fid uuid;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if exists (select 1 from fields where workspace_id = p_ws and object = p_object and key = p_key and system) then
    raise exception 'This field is built in';
  end if;
  delete from fields where workspace_id = p_ws and object = p_object and key = p_key returning id into fid;
  if fid is null then
    raise exception 'Field not found';
  end if;
  if p_object = 'contact' then
    update contacts set fields = fields - p_key, field_sources = field_sources - ('f.' || p_key) where workspace_id = p_ws and fields ? p_key;
  elsif p_object = 'company' then
    update companies set fields = fields - p_key, field_sources = field_sources - ('f.' || p_key) where workspace_id = p_ws and fields ? p_key;
  else
    update records r set fields = fields - p_key, field_sources = field_sources - ('f.' || p_key) from objects o
    where o.id = r.object_id and o.workspace_id = p_ws and o.key = p_object and r.fields ? p_key;
  end if;
  delete from field_order where workspace_id = p_ws and object = p_object and key = 'f.' || p_key;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'field.delete', p_object || '.' || p_key);
end;
$$;

-- Opportunities from a CRM: [{id, name, fields, stage_label, stage_kind, company, contacts}]. `id` is the CRM's id;
-- `company` and `contacts` are the CRM's ids for records this source already synced. A stage the list doesn't have
-- yet is added, so the board shows it. A missing company or contacts key leaves the links as they are; an empty one
-- clears them.
create or replace function public.opportunities_ingest(p_source uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  v_oid uuid;
  f_company uuid;
  f_contacts uuid;
  it jsonb;
  rid uuid;
  f fields%rowtype;
  k text;
  v jsonb;
  clean jsonb;
  stage text;
  created int := 0;
  updated int := 0;
  skipped int := 0;
begin
  select * into s from sources where id = p_source;
  if s.id is null then
    raise exception 'Source not found';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send up to 1,000 rows at a time';
  end if;
  perform crm_seed(s.workspace_id);
  select id into v_oid from objects where workspace_id = s.workspace_id and key = 'opportunity';
  select id into f_company from fields where workspace_id = s.workspace_id and object = 'opportunity' and key = 'company';
  select id into f_contacts from fields where workspace_id = s.workspace_id and object = 'opportunity' and key = 'contacts';

  for it in select value from jsonb_array_elements(p_rows) loop
    if coalesce(it->>'id', '') = '' then
      skipped := skipped + 1;
      continue;
    end if;
    stage := nullif(trim(coalesce(it#>>'{fields,stage}', '')), '');
    if stage is not null then
      update fields set options = options || jsonb_build_array(jsonb_build_object(
          'value', left(stage, 80),
          'label', left(coalesce(nullif(trim(it->>'stage_label'), ''), stage), 80),
          'kind', case when it->>'stage_kind' in ('won', 'lost') then it->>'stage_kind' else 'open' end)),
        updated_at = now()
      where workspace_id = s.workspace_id and object = 'opportunity' and key = 'stage' and jsonb_array_length(options) < 100
        and not exists (select 1 from jsonb_array_elements(options) o where coalesce(o->>'value', o #>> '{}') = left(stage, 80));
    end if;
    clean := '{}';
    for k, v in select * from jsonb_each(coalesce(it->'fields', '{}')) loop
      select * into f from fields where workspace_id = s.workspace_id and object = 'opportunity' and key = k and type <> 'relation';
      continue when f.id is null;
      begin
        v := field_value(s.workspace_id, f.type, f.options, f.label, v);
      exception when others then
        v := null;
      end;
      if v is not null then clean := clean || jsonb_build_object(k, v); end if;
    end loop;

    select id into rid from records where object_id = v_oid and source_ids->>s.kind = it->>'id' and deleted_at is null limit 1;
    if rid is null then
      insert into records (workspace_id, object_id, name, fields, source_ids, field_sources)
      values (s.workspace_id, v_oid, left(coalesce(nullif(trim(it->>'name'), ''), 'Opportunity ' || (it->>'id')), 300), clean,
              jsonb_build_object(s.kind, left(it->>'id', 200)),
              (select coalesce(jsonb_object_agg('f.' || x, jsonb_build_object('s', s.kind, 'at', now())), '{}') from jsonb_object_keys(clean) x))
      returning id into rid;
      created := created + 1;
    else
      update records set
        name = left(coalesce(nullif(trim(it->>'name'), ''), name), 300),
        fields = fields || clean,
        field_sources = field_sources || (select coalesce(jsonb_object_agg('f.' || x, jsonb_build_object('s', s.kind, 'at', now())), '{}') from jsonb_object_keys(clean) x),
        updated_at = case when fields || clean is distinct from fields or coalesce(nullif(trim(it->>'name'), ''), name) is distinct from name then now() else updated_at end
      where id = rid;
      updated := updated + 1;
    end if;

    if it ? 'company' then
      delete from record_links where field_id = f_company and from_id = rid;
      insert into record_links (workspace_id, field_id, from_object, from_id, to_object, to_id)
      select s.workspace_id, f_company, 'opportunity', rid, 'company', l.local_id
      from source_links l
      where l.source_id = p_source and l.object = 'company' and l.external_id = it->>'company' and l.deleted_at is null
      limit 1
      on conflict do nothing;
    end if;
    if it ? 'contacts' and jsonb_typeof(it->'contacts') = 'array' then
      delete from record_links where field_id = f_contacts and from_id = rid;
      insert into record_links (workspace_id, field_id, from_object, from_id, to_object, to_id)
      select distinct s.workspace_id, f_contacts, 'opportunity', rid, 'contact', l.local_id
      from source_links l
      where l.source_id = p_source and l.object = 'contact' and l.deleted_at is null
        and l.external_id in (select jsonb_array_elements_text(it->'contacts'))
      on conflict do nothing;
    end if;
  end loop;
  return jsonb_build_object('created', created, 'updated', updated, 'skipped', skipped);
end;
$$;

create or replace function public.source_settings_ok(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'object'
    and coalesce(p->'objects'->>'contacts', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'companies', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'opportunities', 'in') in ('in', 'off')
    and coalesce(p->'objects'->>'lists', 'in') in ('in', 'off')
    and coalesce(p->'objects'->>'suppressions', 'in') in ('in', 'off')
    and coalesce(p->>'push_new', 'lifecycle') in ('all', 'lifecycle', 'none')
    and coalesce(p->>'basis', 'none') in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')
    and coalesce((p->>'every_min')::int, 60) between 2 and 1440;
$$;

-- The CRM deleted these opportunities.
create or replace function public.opportunities_remove(p_source uuid, p_ids text[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  gone uuid[];
begin
  select * into s from sources where id = p_source;
  if s.id is null then
    raise exception 'Source not found';
  end if;
  with d as (
    update records r set deleted_at = now(), updated_at = now() from objects o
    where o.id = r.object_id and o.workspace_id = s.workspace_id and o.key = 'opportunity'
      and r.deleted_at is null and r.source_ids->>s.kind = any(p_ids)
    returning r.id
  )
  select coalesce(array_agg(id), '{}') into gone from d;
  delete from record_links where workspace_id = s.workspace_id and from_id = any(gone);
  return coalesce(array_length(gone, 1), 0);
end;
$$;

-- Opportunities linked to a company or a contact, for their pages.
create or replace function public.opportunities_for(p_object text, p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'amount', r.fields->'amount', 'stage', r.fields->>'stage',
    'close_date', r.fields->>'close_date', 'updated_at', r.updated_at) order by r.fields->>'close_date' desc nulls last, r.updated_at desc), '[]')
  from records r
  join objects o on o.id = r.object_id and o.key = 'opportunity'
  where r.deleted_at is null and is_member(r.workspace_id)
    and r.id in (select l.from_id from record_links l where l.to_id = p_id and l.to_object = p_object and l.from_object = 'opportunity');
$$;

-- Team -----------------------------------------------------------------------------------------------------------
-- Same as Omniscient: signing in with an invited email joins the workspace. No link needed.

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (length(email) <= 320),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  accepted_at timestamptz,
  unique (workspace_id, email)
);
alter table public.invites enable row level security;
drop policy if exists "members read" on public.invites;
create policy "members read" on public.invites for select using (is_member(workspace_id));
revoke all on public.invites from anon;
revoke insert, update, delete on public.invites from authenticated;

create or replace function public.invite_member(p_ws uuid, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can invite people';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email doesn''t look right';
  end if;
  if exists (select 1 from workspace_members m join auth.users u on u.id = m.user_id where m.workspace_id = p_ws and lower(u.email) = e) then
    raise exception '% is already on the team', e;
  end if;
  insert into invites (workspace_id, email, invited_by) values (p_ws, e, auth.uid())
  on conflict (workspace_id, email) do update set invited_by = excluded.invited_by, created_at = now(), expires_at = now() + interval '30 days', accepted_at = null;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'team.invite', e);
end;
$$;

create or replace function public.cancel_invite(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from invites where id = p_id;
  if ws is null or not is_owner(ws) then
    raise exception 'Invite not found';
  end if;
  delete from invites where id = p_id;
end;
$$;

create or replace function public.member_remove(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can remove people';
  end if;
  if exists (select 1 from workspace_members where workspace_id = p_ws and user_id = p_user and role = 'owner') then
    raise exception 'The owner can''t be removed';
  end if;
  delete from workspace_members where workspace_id = p_ws and user_id = p_user;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'team.remove', p_user::text);
end;
$$;

create or replace function public.team(p_ws uuid) returns table (user_id uuid, email text, role text, joined_at timestamptz, pending boolean, invite_id uuid)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at, false, null::uuid
  from workspace_members m join auth.users u on u.id = m.user_id
  where m.workspace_id = p_ws and is_member(p_ws)
  union all
  select null, i.email, 'member', i.created_at, true, i.id
  from invites i
  where i.workspace_id = p_ws and i.accepted_at is null and i.expires_at > now() and is_member(p_ws)
  order by 5, 4;
$$;

-- Your workspace: one that invited your email, the first you're in, or a new one.
create or replace function public.ensure_workspace() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  joined uuid;
  v_email text;
  inv record;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  select u.email into v_email from auth.users u where u.id = auth.uid();
  for inv in select * from invites i where lower(i.email) = lower(v_email) and i.accepted_at is null and i.expires_at > now() order by i.created_at loop
    insert into workspace_members (workspace_id, user_id, role) values (inv.workspace_id, auth.uid(), 'member') on conflict do nothing;
    update invites set accepted_at = now() where id = inv.id;
    joined := coalesce(joined, inv.workspace_id);
  end loop;
  select workspace_id into ws from workspace_members where user_id = auth.uid() order by created_at limit 1;
  if ws is not null then
    return ws;
  end if;
  insert into workspaces (name)
  values (coalesce(nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'My') || '''s workspace')
  returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
  return ws;
end;
$$;

-- Sending domains ------------------------------------------------------------------------------------------------
-- The domains email goes out from. Checking DNS comes with the send pipeline; until then a domain is unverified.

create table if not exists public.sending_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and length(domain) <= 253),
  status text not null default 'unverified' check (status in ('unverified', 'verified', 'failed')),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, domain)
);
alter table public.sending_domains enable row level security;
drop policy if exists "members read" on public.sending_domains;
create policy "members read" on public.sending_domains for select using (is_member(workspace_id));
revoke all on public.sending_domains from anon;
revoke insert, update, delete on public.sending_domains from authenticated;

create or replace function public.sending_domain_add(p_ws uuid, p_domain text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d text := lower(trim(both '.' from regexp_replace(trim(coalesce(p_domain, '')), '^(https?://)?(www\.)?([^/]+).*$', '\3', 'i')));
  v_id uuid;
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can add domains';
  end if;
  if d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'Enter a domain like mail.example.com';
  end if;
  insert into sending_domains (workspace_id, domain) values (p_ws, d) on conflict (workspace_id, domain) do nothing returning sending_domains.id into v_id;
  if v_id is null then
    raise exception '% is already added', d;
  end if;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'domain.add', d);
  return v_id;
end;
$$;

create or replace function public.sending_domains_delete(p_ws uuid, p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can remove domains';
  end if;
  delete from sending_domains where workspace_id = p_ws and id = any(p_ids);
  get diagnostics n = row_count;
  insert into audit_log (workspace_id, actor, action, target, data) values (p_ws, auth.uid(), 'domain.delete', 'sending_domains', jsonb_build_object('count', n));
  return n;
end;
$$;

-- Grants ---------------------------------------------------------------------------------------------------------

revoke execute on function public.crm_seed(uuid) from public, anon, authenticated;
revoke execute on function public.workspaces_seed_crm() from public, anon, authenticated;
revoke execute on function public.opportunities_ingest(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.opportunities_remove(uuid, text[]) from public, anon, authenticated;
grant execute on function public.opportunities_ingest(uuid, jsonb) to service_role;
grant execute on function public.opportunities_remove(uuid, text[]) to service_role;
revoke execute on function public.opportunities_for(text, uuid) from public, anon;
grant execute on function public.opportunities_for(text, uuid) to authenticated;
revoke execute on function public.invite_member(uuid, text) from public, anon;
revoke execute on function public.cancel_invite(uuid) from public, anon;
revoke execute on function public.member_remove(uuid, uuid) from public, anon;
revoke execute on function public.team(uuid) from public, anon;
revoke execute on function public.sending_domain_add(uuid, text) from public, anon;
revoke execute on function public.sending_domains_delete(uuid, uuid[]) from public, anon;
grant execute on function public.invite_member(uuid, text) to authenticated;
grant execute on function public.cancel_invite(uuid) to authenticated;
grant execute on function public.member_remove(uuid, uuid) to authenticated;
grant execute on function public.team(uuid) to authenticated;
grant execute on function public.sending_domain_add(uuid, text) to authenticated;
grant execute on function public.sending_domains_delete(uuid, uuid[]) to authenticated;
