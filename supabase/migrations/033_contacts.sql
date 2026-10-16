-- Contacts (docs/conversion-parity.md 4.1, week 1): contacts, companies, custom fields, consent, topics, the tables
-- segments build on, contact events, imports and saved views for the filter bar.
--   Writes that need a cleaned email (imports, adding or editing a contact) come from the server with the service
--   role, after src/lib/contacts cleans each email. Members read their own workspace's rows, and change them only
--   through the functions here.
--   A contact points to its identity person by cleaned email. The link follows the person through merges,
--   rebuilds and erasure (the trigger on identifiers below). A contact never creates a person.

-- Companies ---------------------------------------------------------------------------------------------------

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete set null,
  domain text check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  name text check (length(name) <= 200),
  industry text check (length(industry) <= 120),
  size text check (length(size) <= 40),
  country text check (country ~ '^[A-Z]{2}$'),
  owner_crm_id text check (length(owner_crm_id) <= 100),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (domain is not null or name is not null)
);
-- One company per domain, or per name when there's no domain.
create unique index if not exists companies_domain on public.companies (workspace_id, domain) where domain is not null;
create unique index if not exists companies_name on public.companies (workspace_id, lower(name)) where domain is null;
create index if not exists companies_account on public.companies (account_id) where account_id is not null;
alter table public.companies enable row level security;
create policy "members read" on public.companies for select using (is_member(workspace_id));
revoke all on public.companies from anon;
revoke insert, update, delete on public.companies from authenticated;

-- Contacts ----------------------------------------------------------------------------------------------------

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The identity person with this cleaned email. No foreign key: merges and rebuilds rewrite persons, and the
  -- trigger on identifiers keeps this in step.
  person_id uuid,
  email text check (length(email) <= 320),
  email_clean text check (length(email_clean) <= 254),
  email_class text check (email_class in ('work', 'free', 'role', 'own', 'partner')),
  first_name text check (length(first_name) <= 100),
  last_name text check (length(last_name) <= 100),
  title text check (length(title) <= 200),
  phone text check (length(phone) <= 50),
  company_id uuid references public.companies (id) on delete set null,
  country text check (country ~ '^[A-Z]{2}$'),
  -- State or province, as given.
  region text check (length(region) <= 100),
  timezone text check (length(timezone) <= 60),
  lifecycle text check (lifecycle in ('subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'other')),
  lead_status text check (length(lead_status) <= 60),
  owner_user_id uuid,
  owner_crm_id text check (length(owner_crm_id) <= 100),
  source text not null default 'manual' check (source in ('manual', 'import', 'hubspot', 'salesforce', 'omniscient', 'form', 'api')),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  score int check (score between 0 and 100),
  score_band text check (length(score_band) <= 20),
  score_reasons jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (email is null or email_clean is not null)
);
create unique index if not exists contacts_email on public.contacts (workspace_id, email_clean) where deleted_at is null;
create index if not exists contacts_updated on public.contacts (workspace_id, updated_at desc) where deleted_at is null;
create index if not exists contacts_person on public.contacts (workspace_id, person_id) where person_id is not null;
create index if not exists contacts_company on public.contacts (company_id) where company_id is not null;
alter table public.contacts enable row level security;
create policy "members read" on public.contacts for select using (is_member(workspace_id) and deleted_at is null);
revoke all on public.contacts from anon;
revoke insert, update, delete on public.contacts from authenticated;

-- Custom fields. Built-in fields live in src/lib/contacts/fields.ts and can't be reused as keys.
create table if not exists public.fields (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  object text not null check (object in ('contact', 'company')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (length(label) between 1 and 80),
  type text not null check (type in ('text', 'number', 'date', 'enum', 'bool')),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 100),
  crm_map jsonb not null default '{}' check (jsonb_typeof(crm_map) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, object, key)
);
alter table public.fields enable row level security;
create policy "members read" on public.fields for select using (is_member(workspace_id));
revoke all on public.fields from anon;
revoke insert, update, delete on public.fields from authenticated;

-- The latest write of each field by each source, so the contact page shows where a value came from.
create table if not exists public.field_writes (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  key text not null check (length(key) <= 41),
  value jsonb,
  source text not null check (length(source) <= 40),
  at timestamptz not null default now(),
  primary key (contact_id, key, source)
);
alter table public.field_writes enable row level security;
create policy "members read" on public.field_writes for select using (is_member(workspace_id));
revoke all on public.field_writes from anon;
revoke insert, update, delete on public.field_writes from authenticated;

-- Consent and topics ------------------------------------------------------------------------------------------

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  default_on boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists topics_name on public.topics (workspace_id, lower(name));
alter table public.topics enable row level security;
create policy "members read" on public.topics for select using (is_member(workspace_id));
revoke all on public.topics from anon;
revoke insert, update, delete on public.topics from authenticated;

-- A log: the latest row per contact and channel is the one that counts (docs/marketing-platform.md 9.1).
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null check (channel in ('email')),
  basis text not null check (basis in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')),
  status text not null check (status in ('granted', 'withdrawn', 'none')),
  source text not null check (length(source) <= 60),
  wording text check (length(wording) <= 2000),
  at timestamptz not null default now(),
  check ((basis = 'none') = (status = 'none'))
);
create index if not exists consents_contact on public.consents (contact_id, channel, at desc);
alter table public.consents enable row level security;
create policy "members read" on public.consents for select using (is_member(workspace_id));
revoke all on public.consents from anon;
revoke insert, update, delete on public.consents from authenticated;

create table if not exists public.subscriptions (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  status text not null check (status in ('subscribed', 'unsubscribed')),
  at timestamptz not null default now(),
  primary key (contact_id, topic_id)
);
alter table public.subscriptions enable row level security;
create policy "members read" on public.subscriptions for select using (is_member(workspace_id));
revoke all on public.subscriptions from anon;
revoke insert, update, delete on public.subscriptions from authenticated;

-- Segments (filled in week 4) ---------------------------------------------------------------------------------

create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  rules jsonb not null default '{}',
  kind text not null default 'dynamic' check (kind in ('dynamic', 'static')),
  count int not null default 0,
  refreshed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.segments enable row level security;
create policy "members read" on public.segments for select using (is_member(workspace_id));
revoke all on public.segments from anon;
revoke insert, update, delete on public.segments from authenticated;

create table if not exists public.segment_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  segment_id uuid not null references public.segments (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  entered_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (segment_id, contact_id)
);
create index if not exists segment_members_contact on public.segment_members (contact_id);
alter table public.segment_members enable row level security;
create policy "members read" on public.segment_members for select using (is_member(workspace_id));
revoke all on public.segment_members from anon;
revoke insert, update, delete on public.segment_members from authenticated;

-- Contact events, by month ------------------------------------------------------------------------------------
-- Months live in their own schema that nobody but the server reaches; people read through the parent table, where
-- row level security applies. 13 months are kept (docs/account-intelligence.md Part 3), 3 are made ahead.

create schema if not exists partitions;
revoke all on schema partitions from public, anon, authenticated;

create table if not exists public.contact_events (
  id uuid not null default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  data jsonb not null default '{}',
  source text not null check (length(source) <= 40),
  at timestamptz not null default now(),
  primary key (id, at)
) partition by range (at);
create index if not exists contact_events_contact on public.contact_events (contact_id, at desc);
create index if not exists contact_events_ws on public.contact_events (workspace_id, kind, at desc);
alter table public.contact_events enable row level security;
create policy "members read" on public.contact_events for select using (is_member(workspace_id));
revoke all on public.contact_events from anon;
revoke insert, update, delete on public.contact_events from authenticated;

-- Makes the months from 13 back to 3 ahead, and drops older ones. Safe to run any time.
create or replace function public.contact_events_roll() returns void
language plpgsql security definer set search_path = public as $$
declare
  m date;
  name text;
  oldest date := (date_trunc('month', now()) - interval '13 months')::date;
  r record;
begin
  for i in -13..3 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    name := 'contact_events_' || to_char(m, 'YYYY_MM');
    if to_regclass('partitions.' || name) is null then
      execute format('create table partitions.%I partition of public.contact_events for values from (%L) to (%L)', name, m, (m + interval '1 month')::date);
      execute format('alter table partitions.%I enable row level security', name);
      execute format('revoke all on partitions.%I from public, anon, authenticated', name);
    end if;
  end loop;
  for r in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
    where i.inhparent = 'public.contact_events'::regclass and n.nspname = 'partitions' and c.relname ~ '^contact_events_[0-9]{4}_[0-9]{2}$'
  loop
    if to_date(right(r.relname, 7), 'YYYY_MM') < oldest then
      execute format('drop table partitions.%I', r.relname);
    end if;
  end loop;
end;
$$;
select public.contact_events_roll();

-- Imports and saved views -------------------------------------------------------------------------------------

create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  file_name text check (length(file_name) <= 200),
  file_path text,
  -- Column → field, the source of the list, and the consent basis.
  mapping jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  -- rows, created, updated, skipped by reason
  counts jsonb not null default '{}',
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists imports_ws on public.imports (workspace_id, created_at desc);
alter table public.imports enable row level security;
create policy "members read" on public.imports for select using (is_member(workspace_id));
revoke all on public.imports from anon;
revoke insert, update, delete on public.imports from authenticated;

-- Saved filters for Contacts, Visitors and Accounts (src/components/app/FilterBar.tsx). Shared in the workspace.
create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  screen text not null check (screen in ('contacts', 'visitors', 'accounts')),
  name text not null check (length(name) between 1 and 80),
  filters jsonb not null check (jsonb_typeof(filters) = 'array' and jsonb_array_length(filters) <= 20 and length(filters::text) <= 10000),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists saved_views_ws on public.saved_views (workspace_id, screen, created_at);
alter table public.saved_views enable row level security;
create policy "members read" on public.saved_views for select using (is_member(workspace_id));
create policy "members add" on public.saved_views for insert with check (is_member(workspace_id) and created_by = auth.uid());
create policy "members remove" on public.saved_views for delete using (is_member(workspace_id));
revoke all on public.saved_views from anon;
revoke update on public.saved_views from authenticated;

-- Helpers -----------------------------------------------------------------------------------------------------

create or replace function public.try_numeric(v text) returns numeric
language plpgsql immutable as $$
begin
  return case when v ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then v::numeric end;
end;
$$;

create or replace function public.try_timestamptz(v text) returns timestamptz
language plpgsql stable as $$
begin
  if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    return null;
  end if;
  return v::timestamptz;
exception when others then
  return null;
end;
$$;

-- The person a cleaned email belongs to, past any merges.
create or replace function public.person_for_email(p_ws uuid, p_email text) returns uuid
language sql stable security definer set search_path = public as $$
  with recursive chain(id, depth) as (
    select i.person_id, 0 from identifiers i where i.workspace_id = p_ws and i.kind = 'email' and i.value_clean = p_email and i.person_id is not null
    union all
    select p.merged_into, c.depth + 1 from chain c join persons p on p.id = c.id where p.merged_into is not null and c.depth < 20
  )
  select c.id from chain c join persons p on p.id = c.id where p.merged_into is null order by c.depth desc limit 1;
$$;

-- Identity → contacts: when an email identifier gets, changes or loses its person, contacts with that email follow.
create or replace function public.contacts_follow_identifier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.kind = 'email' then
    update contacts set person_id = person_for_email(old.workspace_id, old.value_clean)
    where workspace_id = old.workspace_id and email_clean = old.value_clean and deleted_at is null
      and person_id is distinct from person_for_email(old.workspace_id, old.value_clean);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.kind = 'email' then
    update contacts set person_id = person_for_email(new.workspace_id, new.value_clean)
    where workspace_id = new.workspace_id and email_clean = new.value_clean and deleted_at is null
      and person_id is distinct from person_for_email(new.workspace_id, new.value_clean);
  end if;
  return null;
end;
$$;
drop trigger if exists contacts_follow_identifier on public.identifiers;
create trigger contacts_follow_identifier after insert or delete or update of person_id, value_clean on public.identifiers
  for each row execute function public.contacts_follow_identifier();

-- A merge marks the old person merged_into the survivor; contacts on the old person move with it.
create or replace function public.contacts_follow_merge() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into then
    update contacts set person_id = coalesce(person_for_email(workspace_id, email_clean), new.merged_into)
    where workspace_id = new.workspace_id and person_id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists contacts_follow_merge on public.persons;
create trigger contacts_follow_merge after update of merged_into on public.persons
  for each row execute function public.contacts_follow_merge();

-- An account made for a domain (by the intel worker) links the company with that domain.
create or replace function public.companies_follow_account() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update companies set account_id = new.account_id, updated_at = now()
  where workspace_id = new.workspace_id and domain = new.domain and account_id is null;
  return null;
end;
$$;
drop trigger if exists companies_follow_account on public.account_domains;
create trigger companies_follow_account after insert on public.account_domains
  for each row execute function public.companies_follow_account();

-- Writes (server only) ----------------------------------------------------------------------------------------

-- Add or update contacts by cleaned email. Each row: email, email_clean, email_class, first_name, last_name, title,
-- phone, country, region, timezone, lifecycle, lead_status, company_domain, company_name, fields (object), basis.
-- Blank values never clear what's there. Rows with the same email in one call keep the last one.
-- Returns { created, updated, ids }.
create or replace function public.contacts_upsert(p_ws uuid, p_source text, p_rows jsonb, p_import uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  result jsonb;
begin
  if p_source not in ('manual', 'import', 'hubspot', 'salesforce', 'omniscient', 'form', 'api') then
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
    fields jsonb, basis text, company_id uuid, contact_id uuid, created boolean
  ) on commit drop;
  truncate _rows;
  insert into _rows (n, email, email_clean, email_class, first_name, last_name, title, phone, country, region, timezone, lifecycle,
                     lead_status, company_domain, company_name, fields, basis)
  select distinct on (lower(trim(r.email_clean)))
         r.n, nullif(trim(r.email), ''), lower(trim(r.email_clean)), r.email_class, nullif(trim(r.first_name), ''), nullif(trim(r.last_name), ''),
         nullif(trim(r.title), ''), nullif(trim(r.phone), ''), nullif(upper(trim(r.country)), ''), nullif(trim(r.region), ''), nullif(trim(r.timezone), ''),
         nullif(trim(r.lifecycle), ''), nullif(trim(r.lead_status), ''), nullif(lower(trim(r.company_domain)), ''), nullif(trim(r.company_name), ''),
         coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(r.fields, '{}')) e(k, v) where v <> 'null' and v <> '""'), '{}'),
         nullif(r.basis, '')
  from rows from (jsonb_to_recordset(p_rows) as (email text, email_clean text, email_class text, first_name text, last_name text, title text,
         phone text, country text, region text, timezone text, lifecycle text, lead_status text, company_domain text, company_name text,
         fields jsonb, basis text)) with ordinality as r(email, email_clean, email_class, first_name, last_name, title, phone, country, region,
         timezone, lifecycle, lead_status, company_domain, company_name, fields, basis, n)
  where coalesce(trim(r.email_clean), '') <> ''
  order by lower(trim(r.email_clean)), r.n desc;

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

  with up as (
    insert into contacts (workspace_id, email, email_clean, email_class, first_name, last_name, title, phone, company_id, country, region, timezone,
                          lifecycle, lead_status, source, fields, person_id)
    select p_ws, r.email, r.email_clean, r.email_class, r.first_name, r.last_name, r.title, r.phone, r.company_id, r.country, r.region, r.timezone,
           r.lifecycle, r.lead_status, p_source, r.fields, person_for_email(p_ws, r.email_clean)
    from _rows r
    on conflict (workspace_id, email_clean) where deleted_at is null do update set
      email = coalesce(excluded.email, contacts.email),
      email_class = coalesce(excluded.email_class, contacts.email_class),
      first_name = coalesce(excluded.first_name, contacts.first_name),
      last_name = coalesce(excluded.last_name, contacts.last_name),
      title = coalesce(excluded.title, contacts.title),
      phone = coalesce(excluded.phone, contacts.phone),
      company_id = coalesce(excluded.company_id, contacts.company_id),
      country = coalesce(excluded.country, contacts.country),
      region = coalesce(excluded.region, contacts.region),
      timezone = coalesce(excluded.timezone, contacts.timezone),
      lifecycle = coalesce(excluded.lifecycle, contacts.lifecycle),
      lead_status = coalesce(excluded.lead_status, contacts.lead_status),
      fields = contacts.fields || excluded.fields,
      person_id = coalesce(contacts.person_id, excluded.person_id),
      updated_at = now()
    returning id, email_clean, (xmax = 0) as created
  )
  update _rows r set contact_id = up.id, created = up.created from up where up.email_clean = r.email_clean;

  -- Where each value came from.
  insert into field_writes (workspace_id, contact_id, key, value, source, at)
  select p_ws, r.contact_id, f.key, f.value, p_source, now()
  from _rows r cross join lateral (
    select k as key, v as value from jsonb_each(jsonb_strip_nulls(jsonb_build_object(
      'email', r.email, 'first_name', r.first_name, 'last_name', r.last_name, 'title', r.title, 'phone', r.phone, 'country', r.country,
      'region', r.region, 'timezone', r.timezone, 'lifecycle', r.lifecycle, 'lead_status', r.lead_status, 'company', coalesce(r.company_name, r.company_domain)))) s(k, v)
    union all
    select 'f.' || k, v from jsonb_each(r.fields) s(k, v)
  ) f
  on conflict (contact_id, key, source) do update set value = excluded.value, at = excluded.at;

  -- Consent: a new row only when the basis changes.
  insert into consents (workspace_id, contact_id, channel, basis, status, source)
  select p_ws, r.contact_id, 'email', r.basis, case when r.basis = 'none' then 'none' else 'granted' end, p_source
  from _rows r
  where r.basis in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')
    and r.basis is distinct from (select c.basis from consents c where c.contact_id = r.contact_id and c.channel = 'email' order by c.at desc, c.id limit 1);

  -- The month's events table is made ahead every day; this covers a day the minute job didn't run.
  if to_regclass('partitions.contact_events_' || to_char(now(), 'YYYY_MM')) is null then
    perform contact_events_roll();
  end if;
  insert into contact_events (workspace_id, contact_id, kind, data, source)
  select p_ws, r.contact_id, 'contact.created', jsonb_strip_nulls(jsonb_build_object('import_id', p_import)), p_source from _rows r where r.created;

  select jsonb_build_object(
    'created', count(*) filter (where created),
    'updated', count(*) filter (where not created),
    'ids', coalesce(jsonb_agg(contact_id order by n), '[]'::jsonb)
  ) into result from _rows;
  truncate _rows;
  return result;
end;
$$;

-- Change one contact. p_values holds the fields to set; a key set to null clears it. An email change needs
-- email, email_clean and email_class together, from the server's cleaning.
create or replace function public.contact_update(p_id uuid, p_source text, p_values jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  c contacts%rowtype;
  co uuid;
  k text;
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
                 'lead_status', 'company_domain', 'company_name', 'fields') then
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
    company_id = case when p_values ? 'company_domain' or p_values ? 'company_name' then co else company_id end,
    fields = case when p_values ? 'fields' then jsonb_strip_nulls(fields || (p_values->'fields')) else fields end,
    person_id = case when p_values ? 'email_clean' then person_for_email(c.workspace_id, p_values->>'email_clean') else person_id end,
    updated_at = now()
  where id = c.id;

  insert into field_writes (workspace_id, contact_id, key, value, source, at)
  select distinct on (x.key) c.workspace_id, c.id, x.key, x.v, p_source, now() from (
    select case when e.k in ('company_domain', 'company_name') then 'company' else e.k end as key, e.v, (e.k = 'company_name') as first
    from jsonb_each(p_values - 'fields' - 'email_clean' - 'email_class') e(k, v)
    union all
    select 'f.' || f.k, f.v, false from jsonb_each(coalesce(p_values->'fields', '{}')) f(k, v)
  ) x
  order by x.key, x.first desc
  on conflict (contact_id, key, source) do update set value = excluded.value, at = excluded.at;
end;
$$;

create or replace function public.imports_start(p_ws uuid, p_user uuid, p_file_name text, p_mapping jsonb) returns uuid
language sql security definer set search_path = public as $$
  insert into imports (workspace_id, created_by, file_name, mapping) values (p_ws, p_user, left(p_file_name, 200), coalesce(p_mapping, '{}')) returning id;
$$;

create or replace function public.imports_finish(p_import uuid, p_status text, p_counts jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  actor uuid;
begin
  update imports set status = p_status, counts = coalesce(p_counts, '{}'), error = left(p_error, 2000), finished_at = now()
  where id = p_import and status = 'running' returning workspace_id, created_by into ws, actor;
  if ws is not null then
    insert into audit_log (workspace_id, actor, action, target, data) values (ws, actor, 'contacts.import', p_import::text, coalesce(p_counts, '{}'));
  end if;
end;
$$;

-- Reads and member actions ------------------------------------------------------------------------------------

-- The filter bar's filters as one SQL condition over contacts c, companies co and accounts a. Values are never put
-- in the text: each condition reads its values from the filters, passed to execute as $2. Field keys come from the
-- built-in list or the workspace's fields. Same meaning as matches() in src/lib/filters.ts.
create or replace function public.contacts_where(p_ws uuid, p_filters jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := '{true}';
  f jsonb;
  i int := 0;
  field text;
  op text;
  typ text;
  expr text;
  vals text;
  v0 text;
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
    if jsonb_typeof(f->'values') is distinct from 'array' and f ? 'values' then
      raise exception 'Filters are not valid';
    end if;
    case field
      when 'email' then typ := 'text'; expr := 'c.email';
      when 'name' then typ := 'text'; expr := $e$nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')$e$;
      when 'first_name' then typ := 'text'; expr := 'c.first_name';
      when 'last_name' then typ := 'text'; expr := 'c.last_name';
      when 'title' then typ := 'text'; expr := 'c.title';
      when 'phone' then typ := 'text'; expr := 'c.phone';
      when 'country' then typ := 'text'; expr := 'c.country';
      when 'region' then typ := 'text'; expr := 'c.region';
      when 'lead_status' then typ := 'text'; expr := 'c.lead_status';
      when 'lifecycle' then typ := 'enum'; expr := 'c.lifecycle';
      when 'source' then typ := 'enum'; expr := 'c.source';
      when 'email_class' then typ := 'enum'; expr := 'c.email_class';
      when 'company' then typ := 'text'; expr := 'co.name';
      when 'company_domain' then typ := 'text'; expr := 'co.domain';
      when 'industry' then typ := 'text'; expr := 'co.industry';
      when 'size' then typ := 'text'; expr := 'co.size';
      when 'fit' then typ := 'number'; expr := 'a.fit';
      when 'score' then typ := 'number'; expr := 'c.score';
      when 'known' then typ := 'bool'; expr := '(c.person_id is not null)';
      when 'created_at' then typ := 'date'; expr := 'c.created_at';
      when 'updated_at' then typ := 'date'; expr := 'c.updated_at';
      else
        if field !~ '^f\.[a-z][a-z0-9_]{0,39}$' then
          raise exception 'Unknown filter field';
        end if;
        select fd.type into typ from fields fd where fd.workspace_id = p_ws and fd.object = 'contact' and fd.key = substr(field, 3);
        if typ is null then
          raise exception 'Unknown filter field';
        end if;
        expr := case typ
          when 'number' then format('try_numeric(c.fields->>%L)', substr(field, 3))
          when 'date' then format('try_timestamptz(c.fields->>%L)', substr(field, 3))
          when 'bool' then format('(c.fields->>%L)::boolean', substr(field, 3))
          else format('(c.fields->>%L)', substr(field, 3)) end;
    end case;

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
      when op = 'empty' then format('(%s is null or %s::text = '''')', expr, expr)
      when op = 'not_empty' then format('(%s is not null and %s::text <> '''')', expr, expr)
      when typ = 'text' and op = 'is' then format('lower(%s) = any(array(select lower(x) from %s x))', expr, vals)
      when typ = 'text' and op = 'is_not' then format('(%s is null or lower(%s) <> all(array(select lower(x) from %s x)))', expr, expr, vals)
      when typ = 'text' and op = 'contains' then
        format($q$exists (select 1 from %s x where %s ilike '%%' || replace(replace(replace(x, '\', '\\'), '%%', '\%%'), '_', '\_') || '%%')$q$, vals, expr)
      when typ = 'enum' and op = 'is' then format('%s = any(array(select %s))', expr, vals)
      when typ = 'enum' and op = 'is_not' then format('(%s is null or %s <> all(array(select %s)))', expr, expr, vals)
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

-- The Contacts table: one page of contacts matching the filters, and how many match in all.
create or replace function public.contacts_list(p_ws uuid, p_filters jsonb default '[]', p_sort text default 'updated_at', p_desc boolean default true,
  p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  w text;
  ord text;
  total bigint;
  rows jsonb;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  w := contacts_where(p_ws, coalesce(p_filters, '[]'));
  ord := case p_sort
    when 'name' then 'lower(coalesce(c.last_name, c.first_name, c.email))'
    when 'email' then 'c.email_clean'
    when 'company' then 'lower(co.name)'
    when 'score' then 'c.score'
    when 'fit' then 'a.fit'
    when 'lifecycle' then 'c.lifecycle'
    when 'created_at' then 'c.created_at'
    else 'c.updated_at' end || case when p_desc then ' desc nulls last' else ' asc nulls last' end || ', c.id';
  execute format('select count(*) from contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
                  where c.workspace_id = $1 and c.deleted_at is null and %s', w)
    into total using p_ws, p_filters;
  execute format($q$select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select c.id, c.email, c.first_name, c.last_name, c.title, c.phone, c.country, c.region, c.lifecycle, c.lead_status, c.source,
             c.score, c.score_band, c.person_id, c.fields, c.created_at, c.updated_at,
             c.email_class, c.company_id, co.name as company_name, co.domain as company_domain, co.industry, co.size, co.account_id, a.fit
      from contacts c left join companies co on co.id = c.company_id left join accounts a on a.id = co.account_id
      where c.workspace_id = $1 and c.deleted_at is null and %s
      order by %s
      limit %s offset %s) x$q$, w, ord, least(greatest(coalesce(p_limit, 100), 1), 1000), greatest(coalesce(p_offset, 0), 0))
    into rows using p_ws, p_filters;
  return jsonb_build_object('total', total, 'rows', rows);
end;
$$;

-- Everything the contact page shows.
create or replace function public.contact_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c contacts%rowtype;
begin
  select * into c from contacts where id = p_id and deleted_at is null;
  if c.id is null or not is_member(c.workspace_id) then
    raise exception 'Contact not found';
  end if;
  return jsonb_build_object(
    'contact', to_jsonb(c) - 'workspace_id' - 'deleted_at',
    'company', (select jsonb_build_object('id', co.id, 'name', co.name, 'domain', co.domain, 'industry', co.industry, 'size', co.size, 'account_id', co.account_id,
                                          'fit', a.fit, 'intent', a.intent, 'stage', a.stage)
                from companies co left join accounts a on a.id = co.account_id where co.id = c.company_id),
    'person', (select jsonb_build_object('id', p.id, 'level', (select l.level from device_links l where l.person_id = p.id and l.to_at is null
                                          order by case l.level when 'verified' then 0 when 'asserted' then 1 else 2 end limit 1))
               from persons p where p.id = c.person_id),
    'writes', coalesce((select jsonb_object_agg(x.key, jsonb_build_object('source', x.source, 'at', x.at)) from (
                select distinct on (w.key) w.key, w.source, w.at from field_writes w where w.contact_id = c.id order by w.key, w.at desc) x), '{}'::jsonb),
    'fields', coalesce((select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', f.options) order by f.created_at)
                        from fields f where f.workspace_id = c.workspace_id and f.object = 'contact'), '[]'::jsonb),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('channel', x.channel, 'basis', x.basis, 'status', x.status, 'source', x.source, 'at', x.at) order by x.at desc)
                          from (select * from consents where contact_id = c.id order by at desc limit 20) x), '[]'::jsonb),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'status', s.status, 'at', s.at) order by t.name)
                        from subscriptions s join topics t on t.id = s.topic_id where s.contact_id = c.id), '[]'::jsonb),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'entered_at', m.entered_at) order by m.entered_at desc)
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

-- Remove contacts. They leave every list at once; the rows stay for the CRM sync to see the delete.
create or replace function public.contacts_delete(p_ws uuid, p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if cardinality(p_ids) > 10000 then
    raise exception 'Remove up to 10,000 contacts at a time';
  end if;
  update contacts set deleted_at = now(), updated_at = now() where workspace_id = p_ws and id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  insert into audit_log (workspace_id, actor, action, data) values (p_ws, auth.uid(), 'contacts.delete', jsonb_build_object('count', n));
  return n;
end;
$$;

-- Exports happen in the browser; this records who exported how many.
create or replace function public.contacts_export_log(p_ws uuid, p_count int, p_filters jsonb default '[]') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  insert into audit_log (workspace_id, actor, action, data)
  values (p_ws, auth.uid(), 'contacts.export', jsonb_build_object('count', p_count, 'filters', coalesce(p_filters, '[]')));
end;
$$;

-- A custom field. Its key comes from the label; built-in keys are taken.
create or replace function public.field_add(p_ws uuid, p_object text, p_label text, p_type text, p_options jsonb default '[]') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  base text;
  k text;
  n int := 1;
  made fields%rowtype;
  reserved text[] := '{email,name,first_name,last_name,title,phone,company,company_domain,country,region,timezone,lifecycle,lead_status,source,score,fit,known,created_at,updated_at,email_class,industry,size,owner,basis,skip}';
begin
  if not is_member(p_ws) then
    raise exception 'Workspace not found';
  end if;
  if length(trim(coalesce(p_label, ''))) not between 1 and 80 then
    raise exception 'Give the field a name';
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
  insert into fields (workspace_id, object, key, label, type, options) values (p_ws, p_object, k, trim(p_label), p_type, coalesce(p_options, '[]'))
  returning * into made;
  return to_jsonb(made) - 'workspace_id';
end;
$$;

-- Every minute ------------------------------------------------------------------------------------------------
-- Same as before, plus the contact event months once a day.
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
  end if;
end;
$$;
revoke execute on function public.minute_tick() from public, anon, authenticated;

-- Grants ------------------------------------------------------------------------------------------------------

revoke execute on function public.contact_events_roll() from public, anon, authenticated;
revoke execute on function public.person_for_email(uuid, text) from public, anon, authenticated;
revoke execute on function public.contacts_follow_identifier() from public, anon, authenticated;
revoke execute on function public.contacts_follow_merge() from public, anon, authenticated;
revoke execute on function public.companies_follow_account() from public, anon, authenticated;
revoke execute on function public.contacts_upsert(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.contact_update(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.imports_start(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.imports_finish(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.contacts_where(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.contact_events_roll() to service_role;
grant execute on function public.contacts_upsert(uuid, text, jsonb, uuid) to service_role;
grant execute on function public.contact_update(uuid, text, jsonb) to service_role;
grant execute on function public.imports_start(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.imports_finish(uuid, text, jsonb, text) to service_role;

revoke execute on function public.contacts_list(uuid, jsonb, text, boolean, int, int) from public, anon;
revoke execute on function public.contact_detail(uuid) from public, anon;
revoke execute on function public.contacts_delete(uuid, uuid[]) from public, anon;
revoke execute on function public.contacts_export_log(uuid, int, jsonb) from public, anon;
revoke execute on function public.field_add(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.contacts_list(uuid, jsonb, text, boolean, int, int) to authenticated;
grant execute on function public.contact_detail(uuid) to authenticated;
grant execute on function public.contacts_delete(uuid, uuid[]) to authenticated;
grant execute on function public.contacts_export_log(uuid, int, jsonb) to authenticated;
grant execute on function public.field_add(uuid, text, text, text, jsonb) to authenticated;
