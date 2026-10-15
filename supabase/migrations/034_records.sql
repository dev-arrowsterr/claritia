-- Records (docs/conversion-parity.md Parts 4 and 7): the customizable core under Contacts, Leads, Companies and
-- custom objects.
--   Field types: text, long text, number, currency, percent, date, date and time, select, multi-select, checkbox,
--   URL, email, phone, user and relation. Fields have a position, a group and a "required" switch.
--   Every value remembers its source (field_sources). Which source may overwrite which is set per field
--   (field_order, by source class: manual, crm, form, product, import, vendor, ai). A lower source fills blanks only.
--   field_history keeps each change with its source and import, for the timeline and for undo.
--   Custom objects hold records with custom fields, linked to contacts, companies and each other.
--   Saved views keep filters, columns (order and width), sort, grouping and table or board, shared or personal.
--   suppressions: addresses that must never get marketing email, filled before any import's contacts.

-- Sources and which one wins ----------------------------------------------------------------------------------

create table if not exists public.source_kinds (
  kind text primary key check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  class text not null check (class in ('manual', 'crm', 'form', 'product', 'import', 'vendor', 'ai'))
);
alter table public.source_kinds enable row level security;
create policy "everyone reads" on public.source_kinds for select using (true);
revoke all on public.source_kinds from anon;
revoke insert, update, delete on public.source_kinds from authenticated;
insert into public.source_kinds (kind, class) select k, 'crm' from unnest(array['hubspot', 'salesforce', 'omniscient', 'pipedrive', 'zoho', 'dynamics', 'attio',
  'close', 'copper', 'freshsales', 'monday', 'affinity', 'outreach', 'salesloft']) k on conflict do nothing;
insert into public.source_kinds (kind, class) select k, 'form' from unnest(array['form', 'typeform', 'tally', 'jotform', 'fillout', 'formstack', 'webflow',
  'framer', 'wordpress', 'wix', 'calendly', 'chilipiper', 'calcom', 'savvycal', 'zoom', 'cvent', 'luma', 'eventbrite', 'goldcast', 'livestorm', 'on24',
  'linkedin', 'meta', 'google_ads']) k on conflict do nothing;
insert into public.source_kinds (kind, class) select k, 'product' from unnest(array['api', 'segment', 'rudderstack', 'posthog', 'mixpanel', 'amplitude',
  'stripe', 'shopify', 'chargebee', 'paddle', 'recurly', 'zendesk', 'front', 'intercom', 'snowflake', 'bigquery', 'databricks', 'redshift', 'clickhouse',
  'postgres', 'mysql']) k on conflict do nothing;
insert into public.source_kinds (kind, class) select k, 'import' from unnest(array['import', 'csv', 'excel', 'sheets', 'airtable', 'notion', 'vcard', 'paste',
  'marketo', 'pardot', 'eloqua', 'mailchimp', 'activecampaign', 'klaviyo', 'brevo', 'customerio', 'iterable', 'braze', 'constantcontact', 'kit',
  'mailerlite', 'campaignmonitor', 'sendgrid', 'loops']) k on conflict do nothing;
insert into public.source_kinds (kind, class) select k, 'vendor' from unnest(array['apollo', 'zoominfo', 'lusha', 'cognism', 'clay', 'clearbit', 'salesnav'])
  k on conflict do nothing;
insert into public.source_kinds (kind, class) values ('manual', 'manual'), ('ai', 'ai') on conflict do nothing;

create or replace function public.source_class(p_kind text) returns text
language sql stable set search_path = public as $$
  select coalesce((select class from source_kinds where kind = p_kind), 'import');
$$;

-- Which source classes may overwrite a field, best first. Key '*' is the workspace default.
create table if not exists public.field_order (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object text not null default 'contact' check (object ~ '^[a-z][a-z0-9_]{0,39}$'),
  key text not null check (length(key) <= 42),
  classes text[] not null check (classes <@ array['manual', 'crm', 'form', 'product', 'import', 'vendor', 'ai'] and cardinality(classes) between 1 and 7),
  primary key (workspace_id, object, key)
);
alter table public.field_order enable row level security;
create policy "members read" on public.field_order for select using (is_member(workspace_id));
revoke all on public.field_order from anon;
revoke insert, update, delete on public.field_order from authenticated;

-- The order for each key of one object in one workspace, as jsonb: { "*": [...], "<key>": [...] }.
create or replace function public.field_classes(p_ws uuid, p_object text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('*', to_jsonb(array['manual', 'crm', 'form', 'product', 'import', 'vendor', 'ai']))
         || coalesce((select jsonb_object_agg(key, to_jsonb(classes)) from field_order where workspace_id = p_ws and object = p_object), '{}');
$$;

-- Merge new values into old ones. A value applies when the old one is blank, or the new source's class ranks at
-- least as high as the old value's source for that key. Returns { vals, src, changes: [{key, old, new, old_source}] }.
create or replace function public.merge_values(p_classes jsonb, p_source text, p_import uuid, p_old jsonb, p_src jsonb, p_new jsonb)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  k text;
  v jsonb;
  oldv jsonb;
  vals jsonb := coalesce(p_old, '{}');
  src jsonb := coalesce(p_src, '{}');
  changes jsonb := '[]';
  order_k jsonb;
  new_class text := source_class(p_source);
  new_rank int;
  old_rank int;
begin
  for k, v in select * from jsonb_each(coalesce(p_new, '{}')) loop
    continue when v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb;
    oldv := vals->k;
    order_k := coalesce(p_classes->k, p_classes->'*');
    select o.n into new_rank from jsonb_array_elements_text(order_k) with ordinality o(c, n) where o.c = new_class;
    select o.n into old_rank from jsonb_array_elements_text(order_k) with ordinality o(c, n) where o.c = source_class(coalesce(src->k->>'s', 'import'));
    if oldv is null or oldv = 'null'::jsonb or oldv = '""'::jsonb or coalesce(new_rank, 99) <= coalesce(old_rank, 99) then
      if oldv is distinct from v then
        changes := changes || jsonb_build_object('key', k, 'old', oldv, 'new', v, 'old_source', src->k);
        vals := vals || jsonb_build_object(k, v);
      end if;
      src := src || jsonb_build_object(k, jsonb_strip_nulls(jsonb_build_object('s', p_source, 'at', now(), 'i', p_import)));
    end if;
  end loop;
  return jsonb_build_object('vals', vals, 'src', src, 'changes', changes);
end;
$$;

-- Fields ------------------------------------------------------------------------------------------------------

alter table public.fields drop constraint if exists fields_type_check;
alter table public.fields drop constraint if exists fields_object_check;
update public.fields set type = 'select' where type = 'enum';
update public.fields set type = 'checkbox' where type = 'bool';
alter table public.fields add constraint fields_type_check check (type in ('text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime',
  'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'user', 'relation'));
alter table public.fields add constraint fields_object_check check (object ~ '^[a-z][a-z0-9_]{0,39}$');
-- config: currency code, decimals, relation target and whether it takes many.
alter table public.fields add column if not exists config jsonb not null default '{}' check (jsonb_typeof(config) = 'object');
alter table public.fields add column if not exists position int not null default 0;
alter table public.fields add column if not exists required boolean not null default false;
alter table public.fields add column if not exists group_name text check (length(group_name) <= 60);
alter table public.fields add column if not exists updated_at timestamptz not null default now();
update public.fields f set position = x.n from (select id, row_number() over (partition by workspace_id, object order by created_at) as n from public.fields) x
  where x.id = f.id and f.position = 0;

-- Built-in fields: a new label, hidden, and for pick lists (lead status) their options.
create table if not exists public.field_settings (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object text not null check (object ~ '^[a-z][a-z0-9_]{0,39}$'),
  key text not null check (length(key) <= 40),
  label text check (length(label) between 1 and 80),
  hidden boolean not null default false,
  options jsonb check (options is null or (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 100)),
  primary key (workspace_id, object, key)
);
alter table public.field_settings enable row level security;
create policy "members read" on public.field_settings for select using (is_member(workspace_id));
revoke all on public.field_settings from anon;
revoke insert, update, delete on public.field_settings from authenticated;

-- The record page's sections: [{ "name": "About", "keys": ["title", "f.plan"] }, …]. Keys not listed go last.
create table if not exists public.object_layouts (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object text not null check (object ~ '^[a-z][a-z0-9_]{0,39}$'),
  sections jsonb not null check (jsonb_typeof(sections) = 'array' and length(sections::text) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, object)
);
alter table public.object_layouts enable row level security;
create policy "members read" on public.object_layouts for select using (is_member(workspace_id));
revoke all on public.object_layouts from anon;
revoke insert, update, delete on public.object_layouts from authenticated;

-- Custom objects ----------------------------------------------------------------------------------------------

create table if not exists public.objects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$' and key not in ('contact', 'company', 'lead', 'deal', 'account', 'visitor', 'segment')),
  label text not null check (length(label) between 1 and 60),
  plural text not null check (length(plural) between 1 and 60),
  icon text not null default 'box' check (length(icon) <= 30),
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);
alter table public.objects enable row level security;
create policy "members read" on public.objects for select using (is_member(workspace_id));
revoke all on public.objects from anon;
revoke insert, update, delete on public.objects from authenticated;

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object_id uuid not null references public.objects (id) on delete cascade,
  name text not null check (length(name) between 1 and 300),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  field_sources jsonb not null default '{}',
  source_ids jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists records_object on public.records (object_id, updated_at desc) where deleted_at is null;
create index if not exists records_source_ids on public.records using gin (source_ids);
alter table public.records enable row level security;
create policy "members read" on public.records for select using (is_member(workspace_id) and deleted_at is null);
revoke all on public.records from anon;
revoke insert, update, delete on public.records from authenticated;

-- Relation fields: one row per link. from_object and to_object are 'contact', 'company' or a custom object key.
create table if not exists public.record_links (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  field_id uuid not null references public.fields (id) on delete cascade,
  from_object text not null,
  from_id uuid not null,
  to_object text not null,
  to_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (field_id, from_id, to_id)
);
create index if not exists record_links_to on public.record_links (to_id);
alter table public.record_links enable row level security;
create policy "members read" on public.record_links for select using (is_member(workspace_id));
revoke all on public.record_links from anon;
revoke insert, update, delete on public.record_links from authenticated;

-- Contacts and companies: sources per value, merges ---------------------------------------------------------

alter table public.contacts drop constraint if exists contacts_source_check;
alter table public.contacts add constraint contacts_source_check check (source ~ '^[a-z][a-z0-9_]{1,40}$');
alter table public.contacts add column if not exists field_sources jsonb not null default '{}';
alter table public.contacts add column if not exists source_ids jsonb not null default '{}';
alter table public.contacts add column if not exists merged_into uuid;
alter table public.contacts add column if not exists import_id uuid;
create index if not exists contacts_source_ids on public.contacts using gin (source_ids);
create index if not exists contacts_import on public.contacts (import_id) where import_id is not null;
alter table public.companies add column if not exists field_sources jsonb not null default '{}';
alter table public.companies add column if not exists source_ids jsonb not null default '{}';
alter table public.companies add column if not exists owner_user_id uuid;
alter table public.companies add column if not exists merged_into uuid;
alter table public.companies add column if not exists deleted_at timestamptz;
alter table public.consents add column if not exists import_id uuid;
alter table public.contact_events add column if not exists import_id uuid;

-- Week 1's field_writes become field_sources: the latest write per key.
update public.contacts c set field_sources = x.src from (
  select contact_id, jsonb_object_agg(key, jsonb_build_object('s', source, 'at', at)) as src from (
    select distinct on (contact_id, key) contact_id, key, source, at from public.field_writes order by contact_id, key, at desc) w
  group by contact_id) x
where x.contact_id = c.id and c.field_sources = '{}';

-- Every change, with who or what made it. Import rows are kept 30 days (for undo), the rest 13 months.
create table if not exists public.field_history (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object text not null,
  record_id uuid not null,
  key text not null,
  old jsonb,
  new jsonb,
  old_source jsonb,
  source text not null,
  by uuid,
  import_id uuid,
  at timestamptz not null default now()
);
create index if not exists field_history_record on public.field_history (record_id, at desc);
create index if not exists field_history_import on public.field_history (import_id) where import_id is not null;
alter table public.field_history enable row level security;
create policy "members read" on public.field_history for select using (is_member(workspace_id));
revoke all on public.field_history from anon;
revoke insert, update, delete on public.field_history from authenticated;

-- Suppressions --------------------------------------------------------------------------------------------------

create table if not exists public.suppressions (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email_clean text not null check (length(email_clean) <= 254),
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'cleaned', 'manual')),
  source text not null check (length(source) <= 40),
  import_id uuid,
  at timestamptz not null default now(),
  primary key (workspace_id, email_clean)
);
alter table public.suppressions enable row level security;
create policy "members read" on public.suppressions for select using (is_member(workspace_id));
revoke all on public.suppressions from anon;
revoke insert, update, delete on public.suppressions from authenticated;

-- Saved views: everything a list remembers ------------------------------------------------------------------------

alter table public.saved_views drop constraint if exists saved_views_screen_check;
alter table public.saved_views add constraint saved_views_screen_check check (screen ~ '^(contacts|leads|companies|visitors|accounts|object:[a-z][a-z0-9_]{0,39})$');
-- columns: [{ key, width }] in order; sort: { key, desc }; layout: table or board; group_by: a field key.
alter table public.saved_views add column if not exists columns jsonb check (columns is null or (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 100));
alter table public.saved_views add column if not exists sort jsonb check (sort is null or jsonb_typeof(sort) = 'object');
alter table public.saved_views add column if not exists layout text not null default 'table' check (layout in ('table', 'board'));
alter table public.saved_views add column if not exists group_by text check (length(group_by) <= 42);
-- Personal views belong to one person; shared views (owner_id null) belong to the workspace.
alter table public.saved_views add column if not exists owner_id uuid;
alter table public.saved_views add column if not exists position int not null default 0;
drop policy if exists "members read" on public.saved_views;
drop policy if exists "members add" on public.saved_views;
drop policy if exists "members remove" on public.saved_views;
create policy "members read" on public.saved_views for select using (is_member(workspace_id) and (owner_id is null or owner_id = auth.uid()));
create policy "members add" on public.saved_views for insert with check (is_member(workspace_id) and created_by = auth.uid() and (owner_id is null or owner_id = auth.uid()));
create policy "members change" on public.saved_views for update using (is_member(workspace_id) and (owner_id is null or owner_id = auth.uid()))
  with check (is_member(workspace_id) and (owner_id is null or owner_id = auth.uid()));
create policy "members remove" on public.saved_views for delete using (is_member(workspace_id) and (owner_id is null or owner_id = auth.uid()));
grant update (name, filters, columns, sort, layout, group_by, owner_id, position) on public.saved_views to authenticated;

-- Values ----------------------------------------------------------------------------------------------------------

-- A contact's values as one jsonb, custom fields as "f.<key>".
create or replace function public.contact_vals(c contacts) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'email', c.email, 'first_name', c.first_name, 'last_name', c.last_name, 'title', c.title, 'phone', c.phone, 'country', c.country,
    'region', c.region, 'timezone', c.timezone, 'lifecycle', c.lifecycle, 'lead_status', c.lead_status, 'company', c.company_id::text,
    'owner', c.owner_user_id::text))
    || coalesce((select jsonb_object_agg('f.' || k, v) from jsonb_each(c.fields) e(k, v)), '{}');
$$;

-- A custom field's value checked against its type. Returns the value to store, null to clear, or raises.
create or replace function public.field_value(p_ws uuid, p_type text, p_options jsonb, p_label text, p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t text := jsonb_typeof(p_value);
  s text;
  allowed text[];
begin
  if p_value is null or t = 'null' or p_value = '""'::jsonb or p_value = '[]'::jsonb then
    return null;
  end if;
  s := case when t = 'string' then trim(p_value #>> '{}') else p_value #>> '{}' end;
  allowed := array(select coalesce(o->>'value', o #>> '{}') from jsonb_array_elements(coalesce(p_options, '[]')) o);
  case p_type
    when 'number', 'currency', 'percent' then
      if try_numeric(s) is null then raise exception '%: enter a number', p_label; end if;
      return to_jsonb(try_numeric(s));
    when 'date' then
      if s !~ '^\d{4}-\d{2}-\d{2}$' or try_timestamptz(s) is null then raise exception '%: enter a date like 2026-03-31', p_label; end if;
      return to_jsonb(s);
    when 'datetime' then
      if try_timestamptz(s) is null then raise exception '%: enter a date and time', p_label; end if;
      return to_jsonb(try_timestamptz(s));
    when 'checkbox' then
      if lower(s) in ('true', 'yes', '1') then return 'true'::jsonb; end if;
      if lower(s) in ('false', 'no', '0') then return 'false'::jsonb; end if;
      raise exception '%: yes or no', p_label;
    when 'select' then
      if not s = any(allowed) then raise exception '%: pick one of its values', p_label; end if;
      return to_jsonb(s);
    when 'multi_select' then
      if t <> 'array' or exists (select 1 from jsonb_array_elements_text(p_value) x where not x = any(allowed)) then
        raise exception '%: pick from its values', p_label;
      end if;
      return (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements_text(p_value) x);
    when 'url' then
      if s !~* '^https?://[^\s]+$' or length(s) > 2000 then raise exception '%: enter a web address starting with https://', p_label; end if;
      return to_jsonb(s);
    when 'email' then
      if s !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(s) > 320 then raise exception '%: enter an email', p_label; end if;
      return to_jsonb(lower(s));
    when 'phone' then
      if length(s) > 50 then raise exception '%: too long', p_label; end if;
      return to_jsonb(s);
    when 'user' then
      if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id::text = s) then raise exception '%: pick a teammate', p_label; end if;
      return to_jsonb(s);
    when 'long_text' then
      if length(s) > 20000 then raise exception '%: too long', p_label; end if;
      return to_jsonb(s);
    when 'relation' then
      raise exception '%: links are set with record_link', p_label;
    else
      if length(s) > 500 then raise exception '%: too long', p_label; end if;
      return to_jsonb(s);
  end case;
end;
$$;

-- Contacts in (replaces week 1's) -----------------------------------------------------------------------------------

-- Add or update contacts by cleaned email, from any source. Each row: email, email_clean, email_class, first_name,
-- last_name, title, phone, country, region, timezone, lifecycle, lead_status, company_domain, company_name,
-- fields (object), basis, source_id (the record's id in the source). Values merge by field_order; blanks never
-- clear. Erased emails are skipped for every source but people's own (manual, forms). Returns
-- { created, updated, changed, skipped_erased, ids }.
create or replace function public.contacts_upsert(p_ws uuid, p_source text, p_rows jsonb, p_import uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  result jsonb;
  classes jsonb := field_classes(p_ws, 'contact');
  own boolean := source_class(p_source) in ('manual', 'form');
  erased int := 0;
begin
  if p_source !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'Unknown source %', p_source;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Send up to 2,000 contacts at a time';
  end if;
  if p_import is not null and not exists (select 1 from imports where id = p_import and workspace_id = p_ws and status = 'running') then
    raise exception 'Import not found';
  end if;

  create temp table if not exists _rows (
    n int, email text, email_clean text, email_class text, first_name text, last_name text, title text, phone text,
    country text, region text, timezone text, lifecycle text, lead_status text, company_domain text, company_name text,
    fields jsonb, basis text, source_id text, company_id uuid, contact_id uuid, created boolean, m jsonb
  ) on commit drop;
  truncate _rows;
  insert into _rows (n, email, email_clean, email_class, first_name, last_name, title, phone, country, region, timezone, lifecycle,
                     lead_status, company_domain, company_name, fields, basis, source_id)
  select distinct on (lower(trim(r.email_clean)))
         r.n, nullif(trim(r.email), ''), lower(trim(r.email_clean)), r.email_class, nullif(trim(r.first_name), ''), nullif(trim(r.last_name), ''),
         nullif(trim(r.title), ''), nullif(trim(r.phone), ''), nullif(upper(trim(r.country)), ''), nullif(trim(r.region), ''), nullif(trim(r.timezone), ''),
         nullif(trim(r.lifecycle), ''), nullif(trim(r.lead_status), ''), nullif(lower(trim(r.company_domain)), ''), nullif(trim(r.company_name), ''),
         coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(r.fields, '{}')) e(k, v) where v <> 'null' and v <> '""'), '{}'),
         nullif(r.basis, ''), nullif(r.source_id, '')
  from rows from (jsonb_to_recordset(p_rows) as (email text, email_clean text, email_class text, first_name text, last_name text, title text,
         phone text, country text, region text, timezone text, lifecycle text, lead_status text, company_domain text, company_name text,
         fields jsonb, basis text, source_id text)) with ordinality as r(email, email_clean, email_class, first_name, last_name, title, phone, country, region,
         timezone, lifecycle, lead_status, company_domain, company_name, fields, basis, source_id, n)
  where coalesce(trim(r.email_clean), '') <> ''
  order by lower(trim(r.email_clean)), r.n desc;

  if not own then
    delete from _rows r where exists (select 1 from erasures e where e.workspace_id = p_ws and e.value_hash = sha256(convert_to(r.email_clean, 'UTF8')));
    get diagnostics erased = row_count;
  end if;

  -- Companies: by domain, or by name when there's no domain.
  insert into companies (workspace_id, domain, name, account_id)
  select distinct on (company_domain) p_ws, company_domain, company_name,
         (select ad.account_id from account_domains ad where ad.workspace_id = p_ws and ad.domain = r.company_domain)
  from _rows r where company_domain is not null
  order by company_domain, (company_name is null)
  on conflict (workspace_id, domain) where domain is not null
  do update set name = coalesce(companies.name, excluded.name), account_id = coalesce(companies.account_id, excluded.account_id), updated_at = now();
  insert into companies (workspace_id, name)
  select distinct on (lower(company_name)) p_ws, company_name from _rows where company_domain is null and company_name is not null
  on conflict (workspace_id, lower(name)) where domain is null do nothing;
  update _rows r set company_id = c.id from companies c where c.workspace_id = p_ws and r.company_domain is not null and c.domain = r.company_domain;
  update _rows r set company_id = c.id from companies c
  where c.workspace_id = p_ws and r.company_domain is null and r.company_name is not null and c.domain is null and lower(c.name) = lower(r.company_name);

  -- New contacts. A concurrent writer may take an email first; those rows fall through to the update below.
  with ins as (
    insert into contacts (workspace_id, email, email_clean, email_class, first_name, last_name, title, phone, company_id, country, region, timezone,
                          lifecycle, lead_status, source, fields, person_id, import_id, source_ids, field_sources)
    select p_ws, r.email, r.email_clean, r.email_class, r.first_name, r.last_name, r.title, r.phone, r.company_id, r.country, r.region, r.timezone,
           r.lifecycle, r.lead_status, p_source, r.fields, person_for_email(p_ws, r.email_clean), p_import,
           case when r.source_id is null then '{}'::jsonb else jsonb_build_object(p_source, r.source_id) end,
           (select coalesce(jsonb_object_agg(k, jsonb_strip_nulls(jsonb_build_object('s', p_source, 'at', now(), 'i', p_import))), '{}')
            from jsonb_object_keys(jsonb_strip_nulls(jsonb_build_object('email', r.email, 'first_name', r.first_name, 'last_name', r.last_name,
              'title', r.title, 'phone', r.phone, 'country', r.country, 'region', r.region, 'timezone', r.timezone, 'lifecycle', r.lifecycle,
              'lead_status', r.lead_status, 'company', r.company_id::text))
              || coalesce((select jsonb_object_agg('f.' || fk, fv) from jsonb_each(r.fields) f(fk, fv)), '{}')) k)
    from _rows r
    where not exists (select 1 from contacts c where c.workspace_id = p_ws and c.email_clean = r.email_clean and c.deleted_at is null)
    on conflict (workspace_id, email_clean) where deleted_at is null do nothing
    returning id, email_clean
  )
  update _rows r set contact_id = ins.id, created = true from ins where ins.email_clean = r.email_clean;

  -- Existing contacts: lock, then merge by field order.
  perform 1 from contacts c join _rows r on c.workspace_id = p_ws and c.email_clean = r.email_clean and c.deleted_at is null
  where r.contact_id is null for update of c;
  update _rows r set contact_id = c.id, created = false,
         m = merge_values(classes, p_source, p_import, contact_vals(c), c.field_sources,
               jsonb_strip_nulls(jsonb_build_object('email', r.email, 'first_name', r.first_name, 'last_name', r.last_name, 'title', r.title,
                 'phone', r.phone, 'country', r.country, 'region', r.region, 'timezone', r.timezone, 'lifecycle', r.lifecycle,
                 'lead_status', r.lead_status, 'company', r.company_id::text))
               || coalesce((select jsonb_object_agg('f.' || fk, fv) from jsonb_each(r.fields) f(fk, fv)), '{}'))
  from contacts c
  where r.contact_id is null and c.workspace_id = p_ws and c.email_clean = r.email_clean and c.deleted_at is null;

  update contacts c set
    email = coalesce(r.m->'vals'->>'email', c.email),
    email_class = coalesce(c.email_class, r.email_class),
    first_name = r.m->'vals'->>'first_name',
    last_name = r.m->'vals'->>'last_name',
    title = r.m->'vals'->>'title',
    phone = r.m->'vals'->>'phone',
    country = r.m->'vals'->>'country',
    region = r.m->'vals'->>'region',
    timezone = r.m->'vals'->>'timezone',
    lifecycle = r.m->'vals'->>'lifecycle',
    lead_status = r.m->'vals'->>'lead_status',
    company_id = (r.m->'vals'->>'company')::uuid,
    fields = coalesce((select jsonb_object_agg(substr(k, 3), v) from jsonb_each(r.m->'vals') e(k, v) where k like 'f.%'), '{}'),
    field_sources = r.m->'src',
    source_ids = case when r.source_id is null then c.source_ids else c.source_ids || jsonb_build_object(p_source, r.source_id) end,
    person_id = coalesce(c.person_id, person_for_email(p_ws, c.email_clean)),
    updated_at = case when jsonb_array_length(r.m->'changes') > 0 then now() else c.updated_at end
  from _rows r
  where c.id = r.contact_id and not r.created;

  insert into field_history (workspace_id, object, record_id, key, old, new, old_source, source, import_id)
  select p_ws, 'contact', r.contact_id, x->>'key', x->'old', x->'new', x->'old_source', p_source, p_import
  from _rows r cross join lateral jsonb_array_elements(r.m->'changes') x
  where not r.created;

  -- Consent: a new row only when the basis changes.
  insert into consents (workspace_id, contact_id, channel, basis, status, source, import_id)
  select p_ws, r.contact_id, 'email', r.basis, case when r.basis = 'none' then 'none' else 'granted' end, p_source, p_import
  from _rows r
  where r.contact_id is not null and r.basis in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')
    and r.basis is distinct from (select c.basis from consents c where c.contact_id = r.contact_id and c.channel = 'email' order by c.at desc, c.id limit 1);

  -- The month's events table is made ahead every day; this covers a day the minute job didn't run.
  if to_regclass('partitions.contact_events_' || to_char(now(), 'YYYY_MM')) is null then
    perform contact_events_roll();
  end if;
  insert into contact_events (workspace_id, contact_id, kind, data, source, import_id)
  select p_ws, r.contact_id, 'contact.created', jsonb_strip_nulls(jsonb_build_object('import_id', p_import)), p_source, p_import from _rows r where r.created;

  select jsonb_build_object(
    'created', count(*) filter (where created),
    'updated', count(*) filter (where not created),
    'changed', count(*) filter (where not created and jsonb_array_length(m->'changes') > 0),
    'skipped_erased', erased,
    'ids', coalesce(jsonb_agg(contact_id order by n) filter (where contact_id is not null), '[]'::jsonb)
  ) into result from _rows;
  truncate _rows;
  return result;
end;
$$;

-- Change one contact by hand (the server cleans emails first). p_values holds the keys to set; null clears.
-- A person's edit always applies and becomes the value's source.
create or replace function public.contact_update(p_id uuid, p_source text, p_values jsonb, p_by uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  c contacts%rowtype;
  co uuid;
  k text;
  v_old jsonb;
  v_new jsonb;
  f fields%rowtype;
  v jsonb;
  custom jsonb := '{}';
begin
  select * into c from contacts where id = p_id and deleted_at is null for update;
  if c.id is null then
    raise exception 'Contact not found';
  end if;
  if jsonb_typeof(p_values) <> 'object' then
    raise exception 'Nothing to change';
  end if;
  for k in select jsonb_object_keys(p_values) loop
    if k not in ('email', 'email_clean', 'email_class', 'first_name', 'last_name', 'title', 'phone', 'country', 'region', 'timezone', 'lifecycle',
                 'lead_status', 'company_domain', 'company_name', 'owner', 'fields') then
      raise exception 'Unknown field %', k;
    end if;
  end loop;
  if p_values ? 'email_clean' then
    if coalesce(p_values->>'email_clean', '') = '' then
      raise exception 'A contact needs an email';
    end if;
    if exists (select 1 from contacts where workspace_id = c.workspace_id and email_clean = p_values->>'email_clean' and id <> c.id and deleted_at is null) then
      raise exception 'Another contact has this email';
    end if;
  end if;
  if p_values ? 'owner' and nullif(p_values->>'owner', '') is not null
     and not exists (select 1 from workspace_members where workspace_id = c.workspace_id and user_id::text = p_values->>'owner') then
    raise exception 'Owner: pick a teammate';
  end if;
  if p_values ? 'lifecycle' and nullif(p_values->>'lifecycle', '') is not null
     and p_values->>'lifecycle' not in ('subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'other') then
    raise exception 'Pick a lifecycle stage';
  end if;
  -- Custom fields, checked against their types and required switch.
  for k, v in select * from jsonb_each(coalesce(p_values->'fields', '{}')) loop
    select * into f from fields where workspace_id = c.workspace_id and object = 'contact' and key = k;
    if f.id is null then
      raise exception 'Unknown field %', k;
    end if;
    v := field_value(c.workspace_id, f.type, f.options, f.label, v);
    if v is null and f.required then
      raise exception '% is required', f.label;
    end if;
    custom := custom || jsonb_build_object(k, coalesce(v, 'null'::jsonb));
  end loop;
  if p_values ? 'company_domain' or p_values ? 'company_name' then
    if nullif(p_values->>'company_domain', '') is not null then
      insert into companies (workspace_id, domain, name, account_id)
      values (c.workspace_id, p_values->>'company_domain', nullif(p_values->>'company_name', ''),
              (select account_id from account_domains where workspace_id = c.workspace_id and domain = p_values->>'company_domain'))
      on conflict (workspace_id, domain) where domain is not null do update set name = coalesce(companies.name, excluded.name)
      returning id into co;
    elsif nullif(p_values->>'company_name', '') is not null then
      select id into co from companies where workspace_id = c.workspace_id and domain is null and lower(name) = lower(p_values->>'company_name');
      if co is null then
        insert into companies (workspace_id, name) values (c.workspace_id, p_values->>'company_name') returning id into co;
      end if;
    end if;
  end if;

  v_old := contact_vals(c);
  update contacts set
    email = case when p_values ? 'email' then p_values->>'email' else email end,
    email_clean = case when p_values ? 'email_clean' then p_values->>'email_clean' else email_clean end,
    email_class = case when p_values ? 'email_class' then p_values->>'email_class' else email_class end,
    first_name = case when p_values ? 'first_name' then nullif(trim(p_values->>'first_name'), '') else first_name end,
    last_name = case when p_values ? 'last_name' then nullif(trim(p_values->>'last_name'), '') else last_name end,
    title = case when p_values ? 'title' then nullif(trim(p_values->>'title'), '') else title end,
    phone = case when p_values ? 'phone' then nullif(trim(p_values->>'phone'), '') else phone end,
    country = case when p_values ? 'country' then nullif(upper(trim(p_values->>'country')), '') else country end,
    region = case when p_values ? 'region' then nullif(trim(p_values->>'region'), '') else region end,
    timezone = case when p_values ? 'timezone' then nullif(trim(p_values->>'timezone'), '') else timezone end,
    lifecycle = case when p_values ? 'lifecycle' then nullif(p_values->>'lifecycle', '') else lifecycle end,
    lead_status = case when p_values ? 'lead_status' then nullif(trim(p_values->>'lead_status'), '') else lead_status end,
    owner_user_id = case when p_values ? 'owner' then nullif(p_values->>'owner', '')::uuid else owner_user_id end,
    company_id = case when p_values ? 'company_domain' or p_values ? 'company_name' then co else company_id end,
    fields = jsonb_strip_nulls(fields || custom),
    person_id = case when p_values ? 'email_clean' then person_for_email(c.workspace_id, p_values->>'email_clean') else person_id end,
    updated_at = now()
  where id = c.id
  returning contact_vals(contacts) into v_new;

  -- Changed keys: history and sources.
  insert into field_history (workspace_id, object, record_id, key, old, new, old_source, source, by)
  select c.workspace_id, 'contact', c.id, x.kk, v_old->x.kk, v_new->x.kk, c.field_sources->x.kk, p_source, p_by
  from (select jsonb_object_keys(v_old) union select jsonb_object_keys(v_new)) x(kk)
  where (v_old->x.kk) is distinct from (v_new->x.kk);
  update contacts set field_sources = field_sources
    || coalesce((select jsonb_object_agg(x.kk, jsonb_strip_nulls(jsonb_build_object('s', p_source, 'at', now(), 'by', p_by)))
                 from (select jsonb_object_keys(v_old) union select jsonb_object_keys(v_new)) x(kk)
                 where (v_old->x.kk) is distinct from (v_new->x.kk) and v_new ? x.kk), '{}')
    - array(select x.kk from (select jsonb_object_keys(v_old) union select jsonb_object_keys(v_new)) x(kk) where not v_new ? x.kk)
  where id = c.id;
end;
$$;

-- One value on any record from the app's inline edit: contacts (all but email), companies, custom records.
-- p_key is a built-in key or "f.<custom key>". Relation fields take an array of record ids.
create or replace function public.record_set(p_object text, p_id uuid, p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  f fields%rowtype;
  v jsonb;
  v_old jsonb;
begin
  if p_object = 'contact' then
    select workspace_id into ws from contacts where id = p_id and deleted_at is null;
  elsif p_object = 'company' then
    select workspace_id into ws from companies where id = p_id and deleted_at is null;
  else
    select r.workspace_id into ws from records r join objects o on o.id = r.object_id where r.id = p_id and o.key = p_object and r.deleted_at is null;
  end if;
  if ws is null or not is_member(ws) then
    raise exception 'Record not found';
  end if;

  if p_key like 'f.%' then
    select * into f from fields where workspace_id = ws and object = p_object and key = substr(p_key, 3);
    if f.id is null then
      raise exception 'Unknown field';
    end if;
    if f.type = 'relation' then
      if jsonb_typeof(p_value) not in ('array', 'null') or jsonb_array_length(coalesce(p_value, '[]')) > 500 then
        raise exception '%: pick records', f.label;
      end if;
      if not coalesce((f.config->>'multiple')::boolean, false) and jsonb_array_length(coalesce(p_value, '[]')) > 1 then
        raise exception '%: pick one record', f.label;
      end if;
      delete from record_links where field_id = f.id and from_id = p_id;
      insert into record_links (workspace_id, field_id, from_object, from_id, to_object, to_id)
      select ws, f.id, p_object, p_id, f.config->>'target', x::uuid from jsonb_array_elements_text(coalesce(p_value, '[]')) x
      where case f.config->>'target'
              when 'contact' then exists (select 1 from contacts where id = x::uuid and workspace_id = ws and deleted_at is null)
              when 'company' then exists (select 1 from companies where id = x::uuid and workspace_id = ws)
              else exists (select 1 from records r join objects o on o.id = r.object_id where r.id = x::uuid and r.workspace_id = ws and o.key = f.config->>'target')
            end
      on conflict do nothing;
      return;
    end if;
    v := field_value(ws, f.type, f.options, f.label, p_value);
    if v is null and f.required then
      raise exception '% is required', f.label;
    end if;
    if p_object = 'contact' then
      perform contact_update(p_id, 'manual', jsonb_build_object('fields', jsonb_build_object(f.key, coalesce(v, 'null'::jsonb))), auth.uid());
      return;
    elsif p_object = 'company' then
      select fields->f.key into v_old from companies where id = p_id;
      update companies set fields = jsonb_strip_nulls(fields || jsonb_build_object(f.key, coalesce(v, 'null'::jsonb))),
        field_sources = field_sources || jsonb_build_object(p_key, jsonb_build_object('s', 'manual', 'at', now(), 'by', auth.uid())), updated_at = now()
      where id = p_id;
    else
      select fields->f.key into v_old from records where id = p_id;
      update records set fields = jsonb_strip_nulls(fields || jsonb_build_object(f.key, coalesce(v, 'null'::jsonb))),
        field_sources = field_sources || jsonb_build_object(p_key, jsonb_build_object('s', 'manual', 'at', now(), 'by', auth.uid())), updated_at = now()
      where id = p_id;
    end if;
    if v_old is distinct from v then
      insert into field_history (workspace_id, object, record_id, key, old, new, source, by) values (ws, p_object, p_id, p_key, v_old, v, 'manual', auth.uid());
    end if;
    return;
  end if;

  if p_object = 'contact' then
    if p_key in ('email', 'email_clean', 'email_class', 'company_domain') then
      raise exception 'Change the email or company website from the edit form';
    end if;
    if p_key = 'company' then
      perform contact_update(p_id, 'manual', jsonb_build_object('company_name', p_value #>> '{}'), auth.uid());
    else
      perform contact_update(p_id, 'manual', jsonb_build_object(p_key, p_value #>> '{}'), auth.uid());
    end if;
  elsif p_object = 'company' then
    if p_key not in ('name', 'industry', 'size', 'country', 'owner') then
      raise exception 'Unknown field %', p_key;
    end if;
    select to_jsonb(case p_key when 'name' then name when 'industry' then industry when 'size' then size when 'country' then country else owner_user_id::text end)
      into v_old from companies where id = p_id;
    if p_key = 'owner' and nullif(p_value #>> '{}', '') is not null and not exists (select 1 from workspace_members where workspace_id = ws and user_id::text = p_value #>> '{}') then
      raise exception 'Owner: pick a teammate';
    end if;
    if p_key = 'name' and nullif(trim(p_value #>> '{}'), '') is null and (select domain from companies where id = p_id) is null then
      raise exception 'A company needs a name or a domain';
    end if;
    update companies set
      name = case when p_key = 'name' then nullif(trim(p_value #>> '{}'), '') else name end,
      industry = case when p_key = 'industry' then nullif(trim(p_value #>> '{}'), '') else industry end,
      size = case when p_key = 'size' then nullif(trim(p_value #>> '{}'), '') else size end,
      country = case when p_key = 'country' then nullif(upper(trim(p_value #>> '{}')), '') else country end,
      owner_user_id = case when p_key = 'owner' then nullif(p_value #>> '{}', '')::uuid else owner_user_id end,
      field_sources = field_sources || jsonb_build_object(p_key, jsonb_build_object('s', 'manual', 'at', now(), 'by', auth.uid())),
      updated_at = now()
    where id = p_id;
    insert into field_history (workspace_id, object, record_id, key, old, new, source, by) values (ws, 'company', p_id, p_key, v_old, p_value, 'manual', auth.uid());
  else
    if p_key <> 'name' then
      raise exception 'Unknown field %', p_key;
    end if;
    if nullif(trim(p_value #>> '{}'), '') is null then
      raise exception 'Give it a name';
    end if;
    select to_jsonb(name) into v_old from records where id = p_id;
    update records set name = left(trim(p_value #>> '{}'), 300), updated_at = now(),
      field_sources = field_sources || jsonb_build_object('name', jsonb_build_object('s', 'manual', 'at', now(), 'by', auth.uid()))
    where id = p_id;
    insert into field_history (workspace_id, object, record_id, key, old, new, source, by) values (ws, p_object, p_id, 'name', v_old, p_value, 'manual', auth.uid());
  end if;
end;
$$;

-- The same value on many records (bulk edit). Returns how many changed.
create or replace function public.records_bulk_set(p_ws uuid, p_object text, p_ids uuid[], p_key text, p_value jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  rid uuid;
  n int := 0;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if cardinality(p_ids) > 10000 then
    raise exception 'Change up to 10,000 records at a time';
  end if;
  foreach rid in array p_ids loop
    perform record_set(p_object, rid, p_key, p_value);
    n := n + 1;
  end loop;
  insert into audit_log (workspace_id, actor, action, target, data) values (p_ws, auth.uid(), 'records.bulk_set', p_object, jsonb_build_object('key', p_key, 'count', n));
  return n;
end;
$$;

-- Merge two contacts: the kept one fills its blanks from the other; consent, events, lists, links and source ids
-- move over; the other is marked merged.
create or replace function public.contacts_merge(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  k contacts%rowtype;
  d contacts%rowtype;
begin
  select * into k from contacts where id = p_keep and deleted_at is null for update;
  select * into d from contacts where id = p_drop and deleted_at is null for update;
  if k.id is null or d.id is null or k.workspace_id <> d.workspace_id or not is_member(k.workspace_id) or k.id = d.id then
    raise exception 'Contact not found';
  end if;
  update contacts set
    first_name = coalesce(first_name, d.first_name), last_name = coalesce(last_name, d.last_name), title = coalesce(title, d.title),
    phone = coalesce(phone, d.phone), country = coalesce(country, d.country), region = coalesce(region, d.region),
    timezone = coalesce(timezone, d.timezone), lifecycle = coalesce(lifecycle, d.lifecycle), lead_status = coalesce(lead_status, d.lead_status),
    company_id = coalesce(company_id, d.company_id), owner_user_id = coalesce(owner_user_id, d.owner_user_id),
    fields = d.fields || fields, field_sources = d.field_sources || field_sources, source_ids = d.source_ids || source_ids,
    person_id = coalesce(person_id, d.person_id), updated_at = now()
  where id = k.id;
  update consents set contact_id = k.id where contact_id = d.id;
  update contact_events set contact_id = k.id where contact_id = d.id;
  update segment_members m set contact_id = k.id where m.contact_id = d.id
    and not exists (select 1 from segment_members x where x.segment_id = m.segment_id and x.contact_id = k.id);
  update record_links l set from_id = k.id where l.from_id = d.id
    and not exists (select 1 from record_links x where x.field_id = l.field_id and x.from_id = k.id and x.to_id = l.to_id);
  update record_links l set to_id = k.id where l.to_id = d.id
    and not exists (select 1 from record_links x where x.field_id = l.field_id and x.from_id = l.from_id and x.to_id = k.id);
  update contacts set deleted_at = now(), merged_into = k.id, updated_at = now() where id = d.id;
  insert into field_history (workspace_id, object, record_id, key, old, new, source, by)
  values (k.workspace_id, 'contact', k.id, 'merged', to_jsonb(d.email), to_jsonb(k.email), 'manual', auth.uid());
  insert into audit_log (workspace_id, actor, action, target, data) values (k.workspace_id, auth.uid(), 'contacts.merge', k.id::text, jsonb_build_object('dropped', d.id));
end;
$$;

-- Custom objects and their records --------------------------------------------------------------------------------

create or replace function public.object_save(p_ws uuid, p_key text, p_label text, p_plural text, p_icon text default 'box') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k text := coalesce(nullif(p_key, ''), left(trim(both '_' from regexp_replace(lower(trim(p_label)), '[^a-z0-9]+', '_', 'g')), 36));
  o objects%rowtype;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if k !~ '^[a-z]' then
    k := 'o_' || k;
  end if;
  insert into objects (workspace_id, key, label, plural, icon) values (p_ws, k, trim(p_label), trim(p_plural), coalesce(nullif(p_icon, ''), 'box'))
  on conflict (workspace_id, key) do update set label = excluded.label, plural = excluded.plural, icon = excluded.icon
  returning * into o;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'object.save', k);
  return to_jsonb(o) - 'workspace_id';
end;
$$;

create or replace function public.object_delete(p_ws uuid, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can do this';
  end if;
  delete from record_links where workspace_id = p_ws and (from_object = p_key or to_object = p_key);
  delete from fields where workspace_id = p_ws and object = p_key;
  delete from saved_views where workspace_id = p_ws and screen = 'object:' || p_key;
  delete from objects where workspace_id = p_ws and key = p_key;
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'object.delete', p_key);
end;
$$;

create or replace function public.record_create(p_ws uuid, p_object text, p_name text, p_fields jsonb default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  o objects%rowtype;
  f fields%rowtype;
  vals jsonb := '{}';
  v jsonb;
  rid uuid;
begin
  select * into o from objects where workspace_id = p_ws and key = p_object;
  if o.id is null or not is_member(p_ws) then
    raise exception 'Object not found';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Give it a name';
  end if;
  for f in select * from fields where workspace_id = p_ws and object = p_object and type <> 'relation' loop
    v := field_value(p_ws, f.type, f.options, f.label, coalesce(p_fields, '{}')->f.key);
    if v is null and f.required then
      raise exception '% is required', f.label;
    end if;
    if v is not null then
      vals := vals || jsonb_build_object(f.key, v);
    end if;
  end loop;
  insert into records (workspace_id, object_id, name, fields, field_sources, created_by)
  values (p_ws, o.id, left(trim(p_name), 300), vals,
          (select coalesce(jsonb_object_agg(k, jsonb_build_object('s', 'manual', 'at', now(), 'by', auth.uid())), '{}') from jsonb_object_keys(vals || '{"name":1}') k),
          auth.uid())
  returning records.id into rid;
  return rid;
end;
$$;

create or replace function public.records_delete(p_ws uuid, p_object text, p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if p_object = 'contact' then
    return contacts_delete(p_ws, p_ids);
  elsif p_object = 'company' then
    update companies set deleted_at = now(), updated_at = now() where workspace_id = p_ws and id = any(p_ids) and deleted_at is null;
  else
    update records r set deleted_at = now(), updated_at = now() from objects o
    where o.id = r.object_id and o.workspace_id = p_ws and o.key = p_object and r.id = any(p_ids) and r.deleted_at is null;
  end if;
  get diagnostics n = row_count;
  delete from record_links where workspace_id = p_ws and (from_id = any(p_ids) or to_id = any(p_ids));
  insert into audit_log (workspace_id, actor, action, target, data) values (p_ws, auth.uid(), 'records.delete', p_object, jsonb_build_object('count', n));
  return n;
end;
$$;

-- Fields: add, change, remove, order ------------------------------------------------------------------------------

drop function if exists public.field_add(uuid, text, text, text, jsonb);
create or replace function public.field_add(p_ws uuid, p_object text, p_label text, p_type text, p_options jsonb default '[]',
  p_config jsonb default '{}', p_required boolean default false, p_group text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  base text;
  k text;
  n int := 1;
  made fields%rowtype;
  reserved text[] := '{email,name,first_name,last_name,title,phone,company,company_domain,domain,country,region,timezone,lifecycle,lead_status,source,score,fit,intent,stage,known,created_at,updated_at,email_class,industry,size,owner,basis,skip,segment,contacts}';
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if p_object not in ('contact', 'company') and not exists (select 1 from objects where workspace_id = p_ws and key = p_object) then
    raise exception 'Object not found';
  end if;
  if length(trim(coalesce(p_label, ''))) not between 1 and 80 then
    raise exception 'Give the field a name';
  end if;
  if p_type in ('select', 'multi_select') and jsonb_array_length(coalesce(p_options, '[]')) = 0 then
    raise exception 'Add at least one option';
  end if;
  if p_type = 'relation' and coalesce(p_config->>'target', '') not in ('contact', 'company')
     and not exists (select 1 from objects where workspace_id = p_ws and key = p_config->>'target') then
    raise exception 'Pick what it links to';
  end if;
  base := left(trim(both '_' from regexp_replace(lower(trim(p_label)), '[^a-z0-9]+', '_', 'g')), 36);
  if base !~ '^[a-z]' then
    base := 'f_' || base;
  end if;
  base := left(trim(trailing '_' from base), 36);
  k := base;
  while k = any(reserved) or exists (select 1 from fields where workspace_id = p_ws and object = p_object and key = k) loop
    n := n + 1;
    k := base || '_' || n;
  end loop;
  insert into fields (workspace_id, object, key, label, type, options, config, required, group_name, position)
  values (p_ws, p_object, k, trim(p_label), p_type, coalesce(p_options, '[]'), coalesce(p_config, '{}'), coalesce(p_required, false), nullif(trim(p_group), ''),
          coalesce((select max(position) + 1 from fields where workspace_id = p_ws and object = p_object), 1))
  returning * into made;
  return to_jsonb(made) - 'workspace_id';
end;
$$;

-- Change a custom field's label, options, required switch, group or settings. The type and key stay.
create or replace function public.field_update(p_ws uuid, p_object text, p_key text, p_label text, p_options jsonb, p_config jsonb, p_required boolean, p_group text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  update fields set label = coalesce(nullif(trim(p_label), ''), label), options = coalesce(p_options, options), config = config || coalesce(p_config, '{}'),
    required = coalesce(p_required, required), group_name = nullif(trim(coalesce(p_group, group_name, '')), ''), updated_at = now()
  where workspace_id = p_ws and object = p_object and key = p_key;
  if not found then
    raise exception 'Field not found';
  end if;
end;
$$;

-- Remove a custom field and its values everywhere.
create or replace function public.field_delete(p_ws uuid, p_object text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  fid uuid;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
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

-- Order custom fields: keys in their new order.
create or replace function public.fields_order(p_ws uuid, p_object text, p_keys text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  update fields f set position = x.n, updated_at = now()
  from unnest(p_keys) with ordinality x(k, n) where f.workspace_id = p_ws and f.object = p_object and f.key = x.k;
end;
$$;

-- A built-in field's label, hidden switch and options (lead status stages).
create or replace function public.field_settings_save(p_ws uuid, p_object text, p_key text, p_label text, p_hidden boolean, p_options jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if p_key in ('email', 'name') and coalesce(p_hidden, false) then
    raise exception 'This field can''t be hidden';
  end if;
  insert into field_settings (workspace_id, object, key, label, hidden, options)
  values (p_ws, p_object, p_key, nullif(trim(p_label), ''), coalesce(p_hidden, false), p_options)
  on conflict (workspace_id, object, key) do update set label = excluded.label, hidden = excluded.hidden, options = coalesce(excluded.options, field_settings.options);
end;
$$;

create or replace function public.layout_save(p_ws uuid, p_object text, p_sections jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  insert into object_layouts (workspace_id, object, sections, updated_at) values (p_ws, p_object, p_sections, now())
  on conflict (workspace_id, object) do update set sections = excluded.sections, updated_at = now();
end;
$$;

-- Which source wins, per field (or '*' for all). Owners only: it decides what imports and syncs may overwrite.
create or replace function public.field_order_save(p_ws uuid, p_object text, p_key text, p_classes text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then
    raise exception 'Only the workspace owner can do this';
  end if;
  if p_classes is null then
    delete from field_order where workspace_id = p_ws and object = p_object and key = p_key;
  else
    insert into field_order (workspace_id, object, key, classes) values (p_ws, p_object, p_key, p_classes)
    on conflict (workspace_id, object, key) do update set classes = excluded.classes;
  end if;
end;
$$;

-- Teammates, for owner and user fields.
create or replace function public.workspace_people(p_ws uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_member(p_ws) then coalesce((
    select jsonb_agg(jsonb_build_object('id', m.user_id, 'email', u.email, 'role', m.role) order by u.email)
    from workspace_members m join auth.users u on u.id = m.user_id where m.workspace_id = p_ws), '[]'::jsonb) end;
$$;

-- Static lists ------------------------------------------------------------------------------------------------------

create or replace function public.list_add(p_ws uuid, p_list uuid, p_name text, p_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sid uuid := p_list;
  n int;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if sid is null then
    insert into segments (workspace_id, name, kind, created_by) values (p_ws, trim(p_name), 'static', auth.uid()) returning id into sid;
  elsif not exists (select 1 from segments where id = sid and workspace_id = p_ws and kind = 'static') then
    raise exception 'List not found';
  end if;
  insert into segment_members (workspace_id, segment_id, contact_id)
  select p_ws, sid, c.id from contacts c where c.workspace_id = p_ws and c.id = any(p_ids) and c.deleted_at is null
  on conflict (segment_id, contact_id) do update set left_at = null, entered_at = case when segment_members.left_at is null then segment_members.entered_at else now() end;
  update segments set count = (select count(*) from segment_members where segment_id = sid and left_at is null), refreshed_at = now() where id = sid;
  return sid;
end;
$$;

create or replace function public.list_remove(p_ws uuid, p_list uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) or not exists (select 1 from segments where id = p_list and workspace_id = p_ws and kind = 'static') then
    raise exception 'List not found';
  end if;
  update segment_members set left_at = now() where segment_id = p_list and contact_id = any(p_ids) and left_at is null;
  update segments set count = (select count(*) from segment_members where segment_id = p_list and left_at is null), refreshed_at = now() where id = p_list;
end;
$$;

-- Filters for every object ------------------------------------------------------------------------------------------

-- The filter bar's filters as one SQL condition. Contacts read as c (with companies co, accounts a), companies as co
-- (with accounts a), custom records as r. Values are never put in the text: each condition reads them from the
-- filters, passed to execute as $2. Same meaning as matches() in src/lib/filters.ts.
create or replace function public.object_where(p_ws uuid, p_object text, p_filters jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := '{true}';
  f jsonb;
  i int := 0;
  field text;
  op text;
  typ text;
  ftype text;
  expr text;
  vals text;
  v0 text;
  t text := case p_object when 'contact' then 'c' when 'company' then 'co' else 'r' end;
  fid uuid;
begin
  if p_filters is null or p_filters = 'null'::jsonb then
    return 'true';
  end if;
  if jsonb_typeof(p_filters) <> 'array' or jsonb_array_length(p_filters) > 20 then
    raise exception 'Filters are not valid';
  end if;
  for f in select * from jsonb_array_elements(p_filters) loop
    field := f->>'field';
    op := f->>'op';
    typ := null;
    expr := null;
    if jsonb_typeof(f->'values') is distinct from 'array' and f ? 'values' then
      raise exception 'Filters are not valid';
    end if;
    if field ~ '^f\.[a-z][a-z0-9_]{0,39}$' then
      select fd.type, fd.id into ftype, fid from fields fd where fd.workspace_id = p_ws and fd.object = p_object and fd.key = substr(field, 3);
      if ftype is null then
        raise exception 'Unknown filter field';
      end if;
      typ := case
        when ftype in ('number', 'currency', 'percent') then 'number'
        when ftype in ('date', 'datetime') then 'date'
        when ftype = 'checkbox' then 'bool'
        when ftype in ('select', 'user') then 'enum'
        when ftype = 'multi_select' then 'multi'
        when ftype = 'relation' then 'link'
        else 'text' end;
      expr := case typ
        when 'number' then format('try_numeric(%s.fields->>%L)', t, substr(field, 3))
        when 'date' then format('try_timestamptz(%s.fields->>%L)', t, substr(field, 3))
        when 'bool' then format('(%s.fields->>%L)::boolean', t, substr(field, 3))
        when 'multi' then format('(%s.fields->%L)', t, substr(field, 3))
        when 'link' then format('array(select l.to_id::text from record_links l where l.field_id = %L and l.from_id = %s.id)', fid, t)
        else format('(%s.fields->>%L)', t, substr(field, 3)) end;
    elsif p_object = 'contact' then
      case field
        when 'email' then typ := 'text'; expr := 'c.email';
        when 'name' then typ := 'text'; expr := $e$nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')$e$;
        when 'first_name' then typ := 'text'; expr := 'c.first_name';
        when 'last_name' then typ := 'text'; expr := 'c.last_name';
        when 'title' then typ := 'text'; expr := 'c.title';
        when 'phone' then typ := 'text'; expr := 'c.phone';
        when 'country' then typ := 'text'; expr := 'c.country';
        when 'region' then typ := 'text'; expr := 'c.region';
        when 'lead_status' then typ := 'enum'; expr := 'c.lead_status';
        when 'lifecycle' then typ := 'enum'; expr := 'c.lifecycle';
        when 'source' then typ := 'enum'; expr := 'c.source';
        when 'email_class' then typ := 'enum'; expr := 'c.email_class';
        when 'owner' then typ := 'enum'; expr := 'c.owner_user_id::text';
        when 'company' then typ := 'text'; expr := 'co.name';
        when 'company_domain' then typ := 'text'; expr := 'co.domain';
        when 'industry' then typ := 'text'; expr := 'co.industry';
        when 'size' then typ := 'text'; expr := 'co.size';
        when 'fit' then typ := 'number'; expr := 'a.fit';
        when 'intent' then typ := 'number'; expr := 'a.intent';
        when 'score' then typ := 'number'; expr := 'c.score';
        when 'known' then typ := 'bool'; expr := '(c.person_id is not null)';
        when 'segment' then typ := 'link'; expr := 'array(select m.segment_id::text from segment_members m where m.contact_id = c.id and m.left_at is null)';
        when 'created_at' then typ := 'date'; expr := 'c.created_at';
        when 'updated_at' then typ := 'date'; expr := 'c.updated_at';
        else raise exception 'Unknown filter field';
      end case;
    elsif p_object = 'company' then
      case field
        when 'name' then typ := 'text'; expr := 'coalesce(co.name, co.domain)';
        when 'domain' then typ := 'text'; expr := 'co.domain';
        when 'industry' then typ := 'text'; expr := 'co.industry';
        when 'size' then typ := 'text'; expr := 'co.size';
        when 'country' then typ := 'text'; expr := 'co.country';
        when 'owner' then typ := 'enum'; expr := 'co.owner_user_id::text';
        when 'fit' then typ := 'number'; expr := 'a.fit';
        when 'intent' then typ := 'number'; expr := 'a.intent';
        when 'stage' then typ := 'enum'; expr := 'a.stage';
        when 'contacts' then typ := 'number'; expr := '(select count(*) from contacts x where x.company_id = co.id and x.deleted_at is null)';
        when 'created_at' then typ := 'date'; expr := 'co.created_at';
        when 'updated_at' then typ := 'date'; expr := 'co.updated_at';
        else raise exception 'Unknown filter field';
      end case;
    else
      case field
        when 'name' then typ := 'text'; expr := 'r.name';
        when 'created_at' then typ := 'date'; expr := 'r.created_at';
        when 'updated_at' then typ := 'date'; expr := 'r.updated_at';
        else raise exception 'Unknown filter field';
      end case;
    end if;

    vals := format('jsonb_array_elements_text($2->%s->''values'')', i);
    v0 := format('($2->%s->''values''->>0)', i);
    if op in ('gte', 'lte') and coalesce(f->'values'->>0, '') !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception 'Enter a number';
    end if;
    if op in ('within', 'before') and coalesce(f->'values'->>0, '') !~ '^[0-9]{1,5}$' then
      raise exception 'Enter a number of days';
    end if;
    if op in ('is', 'is_not', 'contains') and coalesce(jsonb_array_length(f->'values'), 0) = 0 then
      raise exception 'Pick a value';
    end if;

    parts := parts || case
      when op = 'empty' and typ = 'multi' then format('coalesce(jsonb_array_length(%s), 0) = 0', expr)
      when op = 'not_empty' and typ = 'multi' then format('coalesce(jsonb_array_length(%s), 0) > 0', expr)
      when op = 'empty' and typ = 'link' then format('cardinality(%s) = 0', expr)
      when op = 'not_empty' and typ = 'link' then format('cardinality(%s) > 0', expr)
      when op = 'empty' then format('(%s is null or %s::text = '''')', expr, expr)
      when op = 'not_empty' then format('(%s is not null and %s::text <> '''')', expr, expr)
      when typ = 'text' and op = 'is' then format('lower(%s) = any(array(select lower(x) from %s x))', expr, vals)
      when typ = 'text' and op = 'is_not' then format('(%s is null or lower(%s) <> all(array(select lower(x) from %s x)))', expr, expr, vals)
      when typ = 'text' and op = 'contains' then
        format($q$exists (select 1 from %s x where %s ilike '%%' || replace(replace(replace(x, '\', '\\'), '%%', '\%%'), '_', '\_') || '%%')$q$, vals, expr)
      when typ = 'enum' and op = 'is' then format('%s = any(array(select %s))', expr, vals)
      when typ = 'enum' and op = 'is_not' then format('(%s is null or %s <> all(array(select %s)))', expr, expr, vals)
      when typ = 'multi' and op = 'is' then format('coalesce(%s, ''[]'') ?| array(select %s)', expr, vals)
      when typ = 'multi' and op = 'is_not' then format('not (coalesce(%s, ''[]'') ?| array(select %s))', expr, vals)
      when typ = 'link' and op = 'is' then format('%s && array(select %s)', expr, vals)
      when typ = 'link' and op = 'is_not' then format('not (%s && array(select %s))', expr, vals)
      when typ = 'number' and op = 'gte' then format('%s >= %s::numeric', expr, v0)
      when typ = 'number' and op = 'lte' then format('%s <= %s::numeric', expr, v0)
      when typ = 'date' and op = 'within' then format('%s >= now() - make_interval(days => %s::int)', expr, v0)
      when typ = 'date' and op = 'before' then format('%s < now() - make_interval(days => %s::int)', expr, v0)
      when typ = 'bool' and op = 'is' then format('coalesce(%s, false) = (%s = ''true'')', expr, v0)
      else null end;
    if parts[array_upper(parts, 1)] is null then
      raise exception 'This filter does not work on that field';
    end if;
    i := i + 1;
  end loop;
  return array_to_string(parts, ' and ');
end;
$$;

-- Week 1's name stays for contacts.
create or replace function public.contacts_where(p_ws uuid, p_filters jsonb) returns text
language sql stable security definer set search_path = public as $$
  select object_where(p_ws, 'contact', p_filters);
$$;

-- One page of any object's records matching the filters, and how many match in all.
create or replace function public.records_list(p_ws uuid, p_object text, p_filters jsonb default '[]', p_sort text default 'updated_at',
  p_desc boolean default true, p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  w text;
  ord text;
  sortf text := coalesce(p_sort, 'updated_at');
  total bigint;
  rows jsonb;
  v_oid uuid;
  base text;
  sel text;
  lim text := least(greatest(coalesce(p_limit, 100), 1), 1000)::text || ' offset ' || greatest(coalesce(p_offset, 0), 0)::text;
  t text := case p_object when 'contact' then 'c' when 'company' then 'co' else 'r' end;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if p_object not in ('contact', 'company') then
    select id into v_oid from objects where workspace_id = p_ws and key = p_object;
    if v_oid is null then
      raise exception 'Object not found';
    end if;
  end if;
  w := object_where(p_ws, p_object, coalesce(p_filters, '[]'));
  -- Sort by a built-in column or a custom field (as number when it reads as one, then as text).
  if sortf ~ '^f\.[a-z][a-z0-9_]{0,39}$' then
    ord := format('try_numeric(%1$s.fields->>%2$L) %3$s nulls last, lower(%1$s.fields->>%2$L) %3$s nulls last', t, substr(sortf, 3), case when p_desc then 'desc' else 'asc' end);
  else
    ord := case p_object
      when 'contact' then case sortf
        when 'name' then 'lower(coalesce(c.last_name, c.first_name, c.email))' when 'email' then 'c.email_clean' when 'company' then 'lower(co.name)'
        when 'score' then 'c.score' when 'fit' then 'a.fit' when 'lifecycle' then 'c.lifecycle' when 'lead_status' then 'c.lead_status'
        when 'title' then 'lower(c.title)' when 'country' then 'c.country' when 'created_at' then 'c.created_at' else 'c.updated_at' end
      when 'company' then case sortf
        when 'name' then 'lower(coalesce(co.name, co.domain))' when 'domain' then 'co.domain' when 'fit' then 'a.fit' when 'intent' then 'a.intent'
        when 'contacts' then 'contacts' when 'created_at' then 'co.created_at' else 'co.updated_at' end
      else case sortf when 'name' then 'lower(r.name)' when 'created_at' then 'r.created_at' else 'r.updated_at' end
    end || case when p_desc then ' desc nulls last' else ' asc nulls last' end;
  end if;
  ord := ord || ', ' || t || '.id';

  if p_object = 'contact' then
    base := 'contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
             where c.workspace_id = $1 and c.deleted_at is null';
    sel := 'c.id, c.email, c.first_name, c.last_name, c.title, c.phone, c.country, c.region, c.lifecycle, c.lead_status, c.source,
            c.score, c.score_band, c.person_id, c.fields, c.created_at, c.updated_at, c.owner_user_id as owner, c.field_sources,
            c.email_class, c.company_id, co.name as company_name, co.domain as company_domain, co.industry, co.size, co.account_id, a.fit, a.intent';
  elsif p_object = 'company' then
    base := 'companies co left join accounts a on a.id = co.account_id where co.workspace_id = $1 and co.deleted_at is null';
    sel := 'co.id, co.name, co.domain, co.industry, co.size, co.country, co.owner_user_id as owner, co.fields, co.field_sources, co.account_id,
            co.created_at, co.updated_at, a.fit, a.intent, a.stage,
            (select count(*) from contacts x where x.company_id = co.id and x.deleted_at is null) as contacts';
  else
    base := format('records r where r.workspace_id = $1 and r.object_id = %L and r.deleted_at is null', v_oid);
    sel := 'r.id, r.name, r.fields, r.field_sources, r.created_at, r.updated_at';
  end if;
  execute format('select count(*) from %s and %s', base, w) into total using p_ws, p_filters;
  execute format('select coalesce(jsonb_agg(x), ''[]''::jsonb) from (select %s from %s and %s order by %s limit %s) x', sel, base, w, ord, lim)
    into rows using p_ws, p_filters;
  -- Relation fields come back as arrays of { id, name } per record.
  if exists (select 1 from fields where workspace_id = p_ws and object = p_object and type = 'relation') and jsonb_array_length(rows) > 0 then
    rows := (select jsonb_agg(x || jsonb_build_object('links', coalesce((
              select jsonb_object_agg(f.key, (select coalesce(jsonb_agg(jsonb_build_object('id', l.to_id, 'object', l.to_object, 'name',
                  case l.to_object when 'contact' then (select coalesce(nullif(trim(concat_ws(' ', k.first_name, k.last_name)), ''), k.email) from contacts k where k.id = l.to_id)
                                   when 'company' then (select coalesce(m.name, m.domain) from companies m where m.id = l.to_id)
                                   else (select rr.name from records rr where rr.id = l.to_id) end)), '[]')
                from record_links l where l.field_id = f.id and l.from_id = (x->>'id')::uuid))
              from fields f where f.workspace_id = p_ws and f.object = p_object and f.type = 'relation'), '{}')) order by n)
             from jsonb_array_elements(rows) with ordinality e(x, n));
  end if;
  return jsonb_build_object('total', total, 'rows', rows);
end;
$$;

-- Week 1's call for contacts stays.
create or replace function public.contacts_list(p_ws uuid, p_filters jsonb default '[]', p_sort text default 'updated_at', p_desc boolean default true,
  p_limit int default 100, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = public as $$
  select records_list(p_ws, 'contact', p_filters, p_sort, p_desc, p_limit, p_offset);
$$;

-- How many records sit in each value of a pick list, for the board's column counts.
create or replace function public.records_group_counts(p_ws uuid, p_object text, p_filters jsonb, p_group text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  w text;
  g text;
  base text;
  res jsonb;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  w := object_where(p_ws, p_object, coalesce(p_filters, '[]'));
  if p_group ~ '^f\.[a-z][a-z0-9_]{0,39}$' then
    g := format('%s.fields->>%L', case p_object when 'contact' then 'c' when 'company' then 'co' else 'r' end, substr(p_group, 3));
  elsif p_object = 'contact' and p_group in ('lead_status', 'lifecycle', 'country', 'source') then
    g := 'c.' || p_group;
  elsif p_object = 'contact' and p_group = 'owner' then
    g := 'c.owner_user_id::text';
  elsif p_object = 'company' and p_group in ('industry', 'size', 'country') then
    g := 'co.' || p_group;
  else
    raise exception 'Can''t group by that field';
  end if;
  base := case p_object
    when 'contact' then 'contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id where c.workspace_id = $1 and c.deleted_at is null'
    when 'company' then 'companies co left join accounts a on a.id = co.account_id where co.workspace_id = $1 and co.deleted_at is null'
    else format('records r where r.workspace_id = $1 and r.object_id = %L and r.deleted_at is null', (select id from objects where workspace_id = p_ws and key = p_object)) end;
  execute format('select coalesce(jsonb_object_agg(coalesce(g, ''''), n), ''{}'') from (select %s as g, count(*) as n from %s and %s group by 1) x', g, base, w)
    into res using p_ws, p_filters;
  return res;
end;
$$;

-- Record pages ------------------------------------------------------------------------------------------------------

create or replace function public.contact_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c contacts%rowtype;
begin
  select * into c from contacts where id = p_id;
  if c.id is null or not is_member(c.workspace_id) then
    raise exception 'Contact not found';
  end if;
  if c.deleted_at is not null then
    if c.merged_into is not null then
      return jsonb_build_object('moved_to', c.merged_into);
    end if;
    raise exception 'Contact not found';
  end if;
  return jsonb_build_object(
    'contact', to_jsonb(c) - 'workspace_id' - 'deleted_at' || jsonb_build_object('owner', c.owner_user_id),
    'company', (select jsonb_build_object('id', co.id, 'name', co.name, 'domain', co.domain, 'industry', co.industry, 'size', co.size, 'account_id', co.account_id,
                                          'fit', a.fit, 'intent', a.intent, 'stage', a.stage)
                from companies co left join accounts a on a.id = co.account_id where co.id = c.company_id),
    'person', (select jsonb_build_object('id', p.id, 'level', (select l.level from device_links l where l.person_id = p.id and l.to_at is null
                                          order by case l.level when 'verified' then 0 when 'asserted' then 1 else 2 end limit 1))
               from persons p where p.id = c.person_id),
    'writes', coalesce((select jsonb_object_agg(k, jsonb_build_object('source', v->>'s', 'at', v->>'at')) from jsonb_each(c.field_sources) e(k, v)), '{}'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('key', h.key, 'old', h.old, 'new', h.new, 'source', h.source, 'by', h.by, 'at', h.at) order by h.at desc)
                         from (select * from field_history where record_id = c.id order by at desc limit 100) h), '[]'::jsonb),
    'fields', coalesce((select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', f.options, 'config', f.config,
                                                            'required', f.required, 'group', f.group_name) order by f.position, f.created_at)
                        from fields f where f.workspace_id = c.workspace_id and f.object = 'contact'), '[]'::jsonb),
    'links', coalesce((select jsonb_object_agg(f.key, (select coalesce(jsonb_agg(jsonb_build_object('id', l.to_id, 'object', l.to_object, 'name',
                  case l.to_object when 'contact' then (select coalesce(nullif(trim(concat_ws(' ', k.first_name, k.last_name)), ''), k.email) from contacts k where k.id = l.to_id)
                                   when 'company' then (select coalesce(m.name, m.domain) from companies m where m.id = l.to_id)
                                   else (select rr.name from records rr where rr.id = l.to_id) end)), '[]')
                from record_links l where l.field_id = f.id and l.from_id = c.id))
              from fields f where f.workspace_id = c.workspace_id and f.object = 'contact' and f.type = 'relation'), '{}'::jsonb),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('channel', x.channel, 'basis', x.basis, 'status', x.status, 'source', x.source, 'at', x.at) order by x.at desc)
                          from (select * from consents where contact_id = c.id order by at desc limit 20) x), '[]'::jsonb),
    'suppressed', (select jsonb_build_object('reason', s.reason, 'source', s.source, 'at', s.at) from suppressions s
                   where s.workspace_id = c.workspace_id and s.email_clean = c.email_clean),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'status', s.status, 'at', s.at) order by t.name)
                        from subscriptions s join topics t on t.id = s.topic_id where s.contact_id = c.id), '[]'::jsonb),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'entered_at', m.entered_at) order by m.entered_at desc)
                          from segment_members m join segments g on g.id = m.segment_id where m.contact_id = c.id and m.left_at is null), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'data', e.data, 'source', e.source, 'at', e.at) order by e.at desc)
                        from (select * from contact_events where contact_id = c.id order by at desc limit 100) e), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at desc) from (
                select s.id, s.started_at, s.pageviews, s.engaged_s, s.landing_path, s.ref_class, s.referrer_host, s.country,
                       coalesce((select array_agg(e.path order by e.server_at) from (select e.path, e.server_at from events e where e.session_id = s.id and e.kind = 'view'
                                 order by e.server_at limit 8) e), '{}') as pages
                from sessions s where c.person_id is not null and s.workspace_id = c.workspace_id and s.person_id = c.person_id and not s.is_bot
                order by s.started_at desc limit 30) x), '[]'::jsonb)
  );
end;
$$;

create or replace function public.company_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  co companies%rowtype;
begin
  select * into co from companies where id = p_id and deleted_at is null;
  if co.id is null or not is_member(co.workspace_id) then
    raise exception 'Company not found';
  end if;
  return jsonb_build_object(
    'company', to_jsonb(co) - 'workspace_id' - 'deleted_at' || jsonb_build_object('owner', co.owner_user_id),
    'account', (select jsonb_build_object('id', a.id, 'fit', a.fit, 'intent', a.intent, 'stage', a.stage, 'temperature', a.temperature, 'why_now', a.why_now)
                from accounts a where a.id = co.account_id),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email, 'first_name', x.first_name, 'last_name', x.last_name,
                                                              'title', x.title, 'lifecycle', x.lifecycle) order by x.updated_at desc)
                          from (select * from contacts where company_id = co.id and deleted_at is null order by updated_at desc limit 200) x), '[]'::jsonb),
    'fields', coalesce((select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', f.options, 'config', f.config,
                                                            'required', f.required, 'group', f.group_name) order by f.position, f.created_at)
                        from fields f where f.workspace_id = co.workspace_id and f.object = 'company'), '[]'::jsonb),
    'writes', coalesce((select jsonb_object_agg(k, jsonb_build_object('source', v->>'s', 'at', v->>'at')) from jsonb_each(co.field_sources) e(k, v)), '{}'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('key', h.key, 'old', h.old, 'new', h.new, 'source', h.source, 'by', h.by, 'at', h.at) order by h.at desc)
                         from (select * from field_history where record_id = co.id order by at desc limit 100) h), '[]'::jsonb)
  );
end;
$$;

create or replace function public.record_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r records%rowtype;
  o objects%rowtype;
begin
  select * into r from records where id = p_id and deleted_at is null;
  select * into o from objects where id = r.object_id;
  if r.id is null or not is_member(r.workspace_id) then
    raise exception 'Record not found';
  end if;
  return jsonb_build_object(
    'record', to_jsonb(r) - 'workspace_id' - 'deleted_at',
    'object', to_jsonb(o) - 'workspace_id',
    'fields', coalesce((select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', f.options, 'config', f.config,
                                                            'required', f.required, 'group', f.group_name) order by f.position, f.created_at)
                        from fields f where f.workspace_id = r.workspace_id and f.object = o.key), '[]'::jsonb),
    'links', coalesce((select jsonb_object_agg(f.key, (select coalesce(jsonb_agg(jsonb_build_object('id', l.to_id, 'object', l.to_object, 'name',
                  case l.to_object when 'contact' then (select coalesce(nullif(trim(concat_ws(' ', k.first_name, k.last_name)), ''), k.email) from contacts k where k.id = l.to_id)
                                   when 'company' then (select coalesce(m.name, m.domain) from companies m where m.id = l.to_id)
                                   else (select rr.name from records rr where rr.id = l.to_id) end)), '[]')
                from record_links l where l.field_id = f.id and l.from_id = r.id))
              from fields f where f.workspace_id = r.workspace_id and f.object = o.key and f.type = 'relation'), '{}'::jsonb),
    -- Records elsewhere that link to this one.
    'backlinks', coalesce((select jsonb_agg(jsonb_build_object('field', f.label, 'object', l.from_object, 'id', l.from_id)) from record_links l join fields f on f.id = l.field_id
                           where l.to_id = r.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('key', h.key, 'old', h.old, 'new', h.new, 'source', h.source, 'by', h.by, 'at', h.at) order by h.at desc)
                         from (select * from field_history where record_id = r.id order by at desc limit 100) h), '[]'::jsonb)
  );
end;
$$;

-- Find records by name, for relation pickers.
create or replace function public.records_search(p_ws uuid, p_object text, p_q text, p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q text := '%' || replace(replace(replace(coalesce(trim(p_q), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  lim int := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  return coalesce(case p_object
    when 'contact' then (select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)) from (
      select id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name from contacts
      where workspace_id = p_ws and deleted_at is null and (email ilike q or concat_ws(' ', first_name, last_name) ilike q) order by updated_at desc limit lim) x)
    when 'company' then (select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)) from (
      select id, coalesce(name, domain) as name from companies where workspace_id = p_ws and deleted_at is null and (name ilike q or domain ilike q)
      order by updated_at desc limit lim) x)
    else (select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)) from (
      select r.id, r.name from records r join objects o on o.id = r.object_id where o.workspace_id = p_ws and o.key = p_object and r.deleted_at is null and r.name ilike q
      order by r.updated_at desc limit lim) x)
  end, '[]'::jsonb);
end;
$$;

-- Every minute ----------------------------------------------------------------------------------------------------
-- Same as before, plus clearing old history once a day: import rows after 30 days, the rest after 13 months.
create or replace function public.prune_history() returns void
language sql security definer set search_path = public as $$
  delete from field_history where (import_id is not null and at < now() - interval '30 days') or at < now() - interval '13 months';
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
  if extract(minute from now()) = 7 then
    perform prune_jobs();
  end if;
  if extract(hour from now()) = 3 and extract(minute from now()) = 17 then
    perform contact_events_roll();
    perform prune_history();
  end if;
end;
$$;
revoke execute on function public.minute_tick() from public, anon, authenticated;

-- Grants ------------------------------------------------------------------------------------------------------------

revoke execute on function public.source_class(text) from public, anon;
revoke execute on function public.field_classes(uuid, text) from public, anon, authenticated;
revoke execute on function public.merge_values(jsonb, text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.contact_vals(contacts) from public, anon, authenticated;
revoke execute on function public.field_value(uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke execute on function public.contacts_upsert(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.contact_update(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.object_where(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.contacts_where(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.prune_history() from public, anon, authenticated;
grant execute on function public.source_class(text) to authenticated;
grant execute on function public.contacts_upsert(uuid, text, jsonb, uuid) to service_role;
grant execute on function public.contact_update(uuid, text, jsonb, uuid) to service_role;
drop function if exists public.contact_update(uuid, text, jsonb);

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'record_set(text, uuid, text, jsonb)', 'records_bulk_set(uuid, text, uuid[], text, jsonb)', 'contacts_merge(uuid, uuid)',
    'object_save(uuid, text, text, text, text)', 'object_delete(uuid, text)', 'record_create(uuid, text, text, jsonb)', 'records_delete(uuid, text, uuid[])',
    'field_add(uuid, text, text, text, jsonb, jsonb, boolean, text)', 'field_update(uuid, text, text, text, jsonb, jsonb, boolean, text)',
    'field_delete(uuid, text, text)', 'fields_order(uuid, text, text[])', 'field_settings_save(uuid, text, text, text, boolean, jsonb)',
    'layout_save(uuid, text, jsonb)', 'field_order_save(uuid, text, text, text[])', 'workspace_people(uuid)', 'list_add(uuid, uuid, text, uuid[])',
    'list_remove(uuid, uuid, uuid[])', 'records_list(uuid, text, jsonb, text, boolean, int, int)', 'contacts_list(uuid, jsonb, text, boolean, int, int)',
    'records_group_counts(uuid, text, jsonb, text)', 'contact_detail(uuid)', 'company_detail(uuid)', 'record_detail(uuid)', 'records_search(uuid, text, text, int)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
