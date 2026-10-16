-- Sources: every tool contacts come from, through one pipeline (docs/conversion-weeks.md weeks 3 to 7,
-- docs/contact-sources.md). A source is one connected tool in a workspace. Its records link to ours by the tool's
-- own id (source_links), each pull keeps a cursor per object, hooks are staged before they're applied, and every
-- change in or out is one row in the sync log. Credentials live apart, where only the server reaches them.

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(name) between 1 and 120),
  -- The account on the other side (a HubSpot portal id, a Salesforce org id, a Mailchimp account), shown on the card.
  account text check (length(account) <= 200),
  status text not null default 'active' check (status in ('active', 'paused', 'error', 'disconnected')),
  -- objects: { contacts: both|in|off, companies: in|off, lists: in|off, suppressions: in|off }, every_min, basis,
  -- push_new: all|lifecycle|none, follow_deletes
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  cursors jsonb not null default '{}' check (jsonb_typeof(cursors) = 'object'),
  -- Contacts changed after this were not pushed yet: "<updated_at>|<id>".
  push_cursor text,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  -- Columns seen in the last pulls, with a sample value, for the mapping screen: { contact: { col: sample } }.
  columns jsonb not null default '{}' check (jsonb_typeof(columns) = 'object'),
  last_error text check (length(last_error) <= 1000),
  errors_in_row int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind)
);
create index if not exists sources_due on public.sources (next_run_at) where status = 'active';
create index if not exists sources_account on public.sources (kind, account);
alter table public.sources enable row level security;
create policy "members read" on public.sources for select using (is_member(workspace_id));
revoke all on public.sources from anon;
revoke insert, update, delete on public.sources from authenticated;

create table if not exists public.source_secrets (
  source_id uuid primary key references public.sources (id) on delete cascade,
  sealed text not null,
  -- The secret a tool signs its webhooks with, or the token in a hook URL; sealed.
  hook_sealed text,
  updated_at timestamptz not null default now()
);
alter table public.source_secrets enable row level security;
revoke all on public.source_secrets from anon, authenticated;

create table if not exists public.source_links (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  object text not null check (object in ('contact', 'company', 'list')),
  external_id text not null check (length(external_id) between 1 and 200),
  local_id uuid not null,
  -- The mapped values both sides last agreed on; a change that comes back with the same values is an echo.
  last_values jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (source_id, object, external_id)
);
create unique index if not exists source_links_local on public.source_links (source_id, object, local_id) where deleted_at is null;
create index if not exists source_links_record on public.source_links (local_id);
alter table public.source_links enable row level security;
create policy "members read" on public.source_links for select using (is_member(workspace_id));
revoke all on public.source_links from anon;
revoke insert, update, delete on public.source_links from authenticated;

create table if not exists public.source_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  object text not null check (length(object) <= 40),
  direction text not null check (direction in ('in', 'out')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  pulled int not null default 0,
  written int not null default 0,
  skipped int not null default 0,
  errors int not null default 0,
  error text check (length(error) <= 1000)
);
create index if not exists source_runs_source on public.source_runs (source_id, started_at desc);
alter table public.source_runs enable row level security;
create policy "members read" on public.source_runs for select using (is_member(workspace_id));
revoke all on public.source_runs from anon;
revoke insert, update, delete on public.source_runs from authenticated;

create table if not exists public.sync_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  object text not null check (length(object) <= 40),
  local_id uuid,
  external_id text check (length(external_id) <= 200),
  action text not null check (action in ('create', 'update', 'delete', 'suppress', 'error')),
  fields text[] not null default '{}',
  error text check (length(error) <= 1000),
  retried_at timestamptz,
  at timestamptz not null default now()
);
create index if not exists sync_log_ws on public.sync_log (workspace_id, at desc);
create index if not exists sync_log_source on public.sync_log (source_id, at desc);
create index if not exists sync_log_errors on public.sync_log (source_id, at desc) where action = 'error';
alter table public.sync_log enable row level security;
create policy "members read" on public.sync_log for select using (is_member(workspace_id));
revoke all on public.sync_log from anon;
revoke insert, update, delete on public.sync_log from authenticated;

-- A source column to one of our fields. Empty for a source means the connector's defaults.
create table if not exists public.mappings (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  object text not null check (object in ('contact', 'company')),
  col text not null check (length(col) between 1 and 200),
  target text not null check (target ~ '^(skip|email|name|first_name|last_name|title|phone|company|website|country|region|timezone|lifecycle|lead_status|basis|industry|size|domain|f\.[a-z][a-z0-9_]{0,39})$'),
  value_map jsonb not null default '{}' check (jsonb_typeof(value_map) = 'object'),
  position int not null default 0,
  primary key (source_id, object, col)
);
alter table public.mappings enable row level security;
create policy "members read" on public.mappings for select using (is_member(workspace_id));
revoke all on public.mappings from anon;
revoke insert, update, delete on public.mappings from authenticated;

-- Webhook deliveries, staged as they come and applied by the source_hook job. A delivery seen twice is kept once.
create table if not exists public.hook_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  dedupe text not null check (length(dedupe) <= 300),
  body jsonb not null,
  received_at timestamptz not null default now(),
  done_at timestamptz,
  unique (source_id, dedupe)
);
create index if not exists hook_events_open on public.hook_events (source_id, id) where done_at is null;
alter table public.hook_events enable row level security;
revoke all on public.hook_events from anon, authenticated;

-- Lists from a source become static segments.
alter table public.segments add column if not exists source_id uuid references public.sources (id) on delete set null;
alter table public.segments add column if not exists external_id text check (length(external_id) <= 200);
create unique index if not exists segments_source on public.segments (source_id, external_id) where source_id is not null;

-- Settings ---------------------------------------------------------------------------------------------------

create or replace function public.source_settings_ok(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'object'
    and coalesce(p->'objects'->>'contacts', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'companies', 'in') in ('both', 'in', 'off')
    and coalesce(p->'objects'->>'lists', 'in') in ('in', 'off')
    and coalesce(p->'objects'->>'suppressions', 'in') in ('in', 'off')
    and coalesce(p->>'push_new', 'lifecycle') in ('all', 'lifecycle', 'none')
    and coalesce(p->>'basis', 'none') in ('opt_in', 'soft_opt_in', 'legitimate_interest', 'none')
    and coalesce((p->>'every_min')::int, 60) between 2 and 1440;
$$;

-- Connect (or reconnect) a tool. Server only: the route has already checked the person is an owner.
create or replace function public.source_connect(p_ws uuid, p_user uuid, p_kind text, p_name text, p_account text, p_sealed text,
  p_settings jsonb default '{}', p_hook_sealed text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sid uuid;
  old_account text;
  existed boolean;
begin
  select true, account into existed, old_account from sources where workspace_id = p_ws and kind = p_kind;
  if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id = p_user and role = 'owner') then
    raise exception 'Only owners can connect tools';
  end if;
  if not source_settings_ok(coalesce(p_settings, '{}')) then
    raise exception 'Bad settings';
  end if;
  insert into sources (workspace_id, kind, name, account, settings, created_by, status, next_run_at)
  values (p_ws, p_kind, left(p_name, 120), left(p_account, 200), coalesce(p_settings, '{}'), p_user, 'active', now())
  on conflict (workspace_id, kind) do update set
    name = excluded.name,
    -- Another account on the other side starts over: old links point at the old account.
    cursors = case when sources.account is distinct from excluded.account then '{}' else sources.cursors end,
    push_cursor = case when sources.account is distinct from excluded.account then null else sources.push_cursor end,
    account = excluded.account,
    settings = sources.settings || excluded.settings,
    status = 'active', last_error = null, errors_in_row = 0, next_run_at = now()
  returning id into sid;
  if existed and old_account is distinct from p_account then
    delete from source_links where source_id = sid;
  end if;
  insert into source_secrets (source_id, sealed, hook_sealed) values (sid, p_sealed, p_hook_sealed)
  on conflict (source_id) do update set sealed = excluded.sealed, hook_sealed = coalesce(excluded.hook_sealed, source_secrets.hook_sealed), updated_at = now();
  perform enqueue_job(p_ws, 'source_pull', sid::text, jsonb_build_object('source_id', sid), 0, 5);
  return sid;
end;
$$;

create or replace function public.source_settings_save(p_id uuid, p_name text, p_settings jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
begin
  select * into s from sources where id = p_id;
  if s.id is null or not is_owner(s.workspace_id) then
    raise exception 'Only owners can change sources';
  end if;
  if not source_settings_ok(p_settings) then
    raise exception 'Bad settings';
  end if;
  update sources set name = coalesce(nullif(trim(left(p_name, 120)), ''), name), settings = p_settings,
         next_run_at = least(next_run_at, now() + make_interval(mins => coalesce((p_settings->>'every_min')::int, 60)))
  where id = p_id;
end;
$$;

create or replace function public.source_pause(p_id uuid, p_paused boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
begin
  select * into s from sources where id = p_id;
  if s.id is null or not is_owner(s.workspace_id) then
    raise exception 'Only owners can change sources';
  end if;
  if s.status = 'disconnected' then
    raise exception 'Connect it again first';
  end if;
  update sources set status = case when p_paused then 'paused' else 'active' end, errors_in_row = 0, last_error = case when p_paused then last_error end,
         next_run_at = now()
  where id = p_id;
end;
$$;

-- Disconnect: credentials and links go; contacts and the log stay.
create or replace function public.source_disconnect(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
begin
  select * into s from sources where id = p_id;
  if s.id is null or not is_owner(s.workspace_id) then
    raise exception 'Only owners can change sources';
  end if;
  delete from source_secrets where source_id = p_id;
  delete from source_links where source_id = p_id;
  delete from hook_events where source_id = p_id;
  update sources set status = 'disconnected', cursors = '{}', push_cursor = null where id = p_id;
end;
$$;

create or replace function public.source_sync_now(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
begin
  select * into s from sources where id = p_id;
  if s.id is null or not is_member(s.workspace_id) then
    raise exception 'Source not found';
  end if;
  if s.status not in ('active', 'error') then
    raise exception 'Turn the source on first';
  end if;
  perform enqueue_job(s.workspace_id, 'source_pull', p_id::text, jsonb_build_object('source_id', p_id), 0, 5);
end;
$$;

-- Replace a source's mapping for one object.
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
  delete from mappings where source_id = p_source and object = p_object;
  insert into mappings (workspace_id, source_id, object, col, target, value_map, position)
  select s.workspace_id, p_source, p_object, r.col, r.target, coalesce(r.value_map, '{}'), r.n
  from rows from (jsonb_to_recordset(p_rows) as (col text, target text, value_map jsonb)) with ordinality as r(col, target, value_map, n);
end;
$$;

-- Send failed outgoing changes again.
create or replace function public.sync_retry(p_ids bigint[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int := 0;
  r record;
begin
  for r in
    select l.source_id, l.workspace_id, array_agg(distinct l.local_id) filter (where l.local_id is not null) ids
    from sync_log l where l.id = any(p_ids) and l.action = 'error' and l.retried_at is null and is_member(l.workspace_id)
    group by l.source_id, l.workspace_id
  loop
    perform enqueue_job(r.workspace_id, 'source_pull', r.source_id::text || ':retry', jsonb_build_object('source_id', r.source_id, 'retry', to_jsonb(r.ids)), 0, 3);
    n := n + coalesce(cardinality(r.ids), 0);
  end loop;
  update sync_log set retried_at = now() where id = any(p_ids) and action = 'error' and is_member(workspace_id);
  return n;
end;
$$;

-- The job's side (server only) -------------------------------------------------------------------------------

create or replace function public.source_load(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('source', to_jsonb(s), 'sealed', k.sealed, 'hook_sealed', k.hook_sealed,
    'mappings', coalesce((select jsonb_agg(jsonb_build_object('object', m.object, 'col', m.col, 'target', m.target, 'value_map', m.value_map) order by m.object, m.position)
                          from mappings m where m.source_id = s.id), '[]'))
  from sources s left join source_secrets k on k.source_id = s.id where s.id = p_id;
$$;

-- Tokens refreshed by the job.
create or replace function public.source_secret_save(p_id uuid, p_sealed text) returns void
language sql security definer set search_path = public as $$
  update source_secrets set sealed = p_sealed, updated_at = now() where source_id = p_id;
$$;

-- Which source a vendor's account-wide webhook belongs to.
create or replace function public.source_by_account(p_kind text, p_account text) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from sources where kind = p_kind and account = p_account and status in ('active', 'error');
$$;

create or replace function public.source_cursor_save(p_id uuid, p_object text, p_cursor jsonb) returns void
language sql security definer set search_path = public as $$
  update sources set cursors = case when p_cursor is null then cursors - p_object else jsonb_set(cursors, array[p_object], p_cursor) end where id = p_id;
$$;

create or replace function public.source_push_cursor_save(p_id uuid, p_cursor text) returns void
language sql security definer set search_path = public as $$
  update sources set push_cursor = p_cursor where id = p_id;
$$;

-- A pull ended: when to run next, and the error count that turns a source to Error after 5 failures in a row.
create or replace function public.source_ran(p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update sources set
    last_run_at = now(),
    last_error = left(p_error, 1000),
    errors_in_row = case when p_error is null then 0 else errors_in_row + 1 end,
    status = case when status in ('paused', 'disconnected') then status when p_error is null then 'active' when errors_in_row + 1 >= 5 then 'error' else status end,
    next_run_at = now() + make_interval(mins => coalesce((settings->>'every_min')::int, 60))
  where id = p_id;
end;
$$;

create or replace function public.source_run_log(p_id uuid, p_object text, p_direction text, p_started timestamptz, p_counts jsonb, p_error text) returns void
language sql security definer set search_path = public as $$
  insert into source_runs (workspace_id, source_id, object, direction, started_at, finished_at, pulled, written, skipped, errors, error)
  select s.workspace_id, s.id, p_object, p_direction, p_started, now(), coalesce((p_counts->>'pulled')::int, 0), coalesce((p_counts->>'written')::int, 0),
         coalesce((p_counts->>'skipped')::int, 0), coalesce((p_counts->>'errors')::int, 0), left(p_error, 1000)
  from sources s where s.id = p_id;
$$;

-- Links for these external ids (with the local record's email for contacts), so a page can tell echoes and moves.
create or replace function public.source_links_get(p_source uuid, p_object text, p_external text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(l.external_id, jsonb_build_object('local_id', l.local_id, 'values', l.last_values, 'deleted', l.deleted_at is not null,
    'email_clean', (select c.email_clean from contacts c where c.id = l.local_id and p_object = 'contact' and c.deleted_at is null))), '{}')
  from source_links l where l.source_id = p_source and l.object = p_object and l.external_id = any(p_external);
$$;

-- Set links: [{external_id, local_id, values}]. A record that moved to a new local id takes its link along.
create or replace function public.source_links_put(p_source uuid, p_object text, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := (select workspace_id from sources where id = p_source);
begin
  -- Another external record that held this local id lets go of it (a merge on the other side).
  update source_links l set deleted_at = now(), updated_at = now()
  from jsonb_to_recordset(p_rows) r(external_id text, local_id uuid)
  where l.source_id = p_source and l.object = p_object and l.local_id = r.local_id and l.external_id <> r.external_id and l.deleted_at is null;
  insert into source_links (workspace_id, source_id, object, external_id, local_id, last_values)
  select distinct on (r.external_id) ws, p_source, p_object, r.external_id, r.local_id, r.values
  from jsonb_to_recordset(p_rows) r(external_id text, local_id uuid, values jsonb)
  where r.external_id is not null and r.local_id is not null
  on conflict (source_id, object, external_id) do update set local_id = excluded.local_id, last_values = excluded.last_values, deleted_at = null, updated_at = now();
end;
$$;

-- The other side deleted these. The link goes; the record stays unless the source says to follow deletes and
-- nothing else holds it.
create or replace function public.source_links_delete(p_source uuid, p_object text, p_external text[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  n int;
begin
  select * into s from sources where id = p_source;
  with gone as (
    update source_links set deleted_at = now(), updated_at = now()
    where source_id = p_source and object = p_object and external_id = any(p_external) and deleted_at is null
    returning local_id
  )
  update contacts c set deleted_at = now()
  from gone where p_object = 'contact' and coalesce((s.settings->>'follow_deletes')::boolean, false) and c.id = gone.local_id
    and not exists (select 1 from source_links o where o.local_id = c.id and o.source_id <> p_source and o.deleted_at is null)
    and not exists (select 1 from field_history h where h.record_id = c.id and source_class(h.source) = 'manual');
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.source_columns_save(p_id uuid, p_object text, p_cols jsonb) returns void
language sql security definer set search_path = public as $$
  update sources set columns = jsonb_set(columns, array[p_object],
    (select coalesce(jsonb_object_agg(k, v), '{}') from (select k, v from jsonb_each(coalesce(columns->p_object, '{}') || p_cols) e(k, v) limit 300) x))
  where id = p_id;
$$;

create or replace function public.sync_log_add(p_source uuid, p_rows jsonb) returns void
language sql security definer set search_path = public as $$
  insert into sync_log (workspace_id, source_id, direction, object, local_id, external_id, action, fields, error)
  select s.workspace_id, s.id, r.direction, r.object, r.local_id, left(r.external_id, 200), r.action, coalesce(r.fields, '{}'), left(r.error, 1000)
  from sources s, jsonb_to_recordset(p_rows) r(direction text, object text, local_id uuid, external_id text, action text, fields text[], error text)
  where s.id = p_source;
$$;

-- Contact ids by cleaned email.
create or replace function public.contact_ids_by_email(p_ws uuid, p_emails text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(email_clean, id), '{}') from contacts where workspace_id = p_ws and deleted_at is null and email_clean = any(p_emails);
$$;

-- Companies from a CRM: by domain, else by name; values merge by field order like contacts.
create or replace function public.companies_upsert(p_ws uuid, p_source text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  classes jsonb := field_classes(p_ws, 'company');
  r record;
  cid uuid;
  c companies%rowtype;
  m jsonb;
  ids jsonb := '[]';
  changed int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Send up to 2,000 companies at a time';
  end if;
  for r in select * from jsonb_to_recordset(p_rows) as x(domain text, name text, industry text, size text, country text, fields jsonb, source_id text) loop
    cid := null;
    r.domain := nullif(lower(trim(r.domain)), '');
    if r.domain is not null and r.domain !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then r.domain := null; end if;
    r.name := nullif(trim(left(r.name, 200)), '');
    if r.domain is null and r.name is null then
      ids := ids || 'null'::jsonb;
      continue;
    end if;
    if r.domain is not null then
      insert into companies (workspace_id, domain, name, account_id, source_ids)
      values (p_ws, r.domain, r.name, (select ad.account_id from account_domains ad where ad.workspace_id = p_ws and ad.domain = r.domain),
              case when r.source_id is null then '{}'::jsonb else jsonb_build_object(p_source, r.source_id) end)
      on conflict (workspace_id, domain) where domain is not null do nothing
      returning id into cid;
      if cid is null then select id into cid from companies where workspace_id = p_ws and domain = r.domain; end if;
    else
      insert into companies (workspace_id, name, source_ids) values (p_ws, r.name, case when r.source_id is null then '{}'::jsonb else jsonb_build_object(p_source, r.source_id) end)
      on conflict (workspace_id, lower(name)) where domain is null do nothing
      returning id into cid;
      if cid is null then select id into cid from companies where workspace_id = p_ws and domain is null and lower(name) = lower(r.name); end if;
    end if;
    select * into c from companies where id = cid for update;
    m := merge_values(classes, p_source, null,
      jsonb_strip_nulls(jsonb_build_object('name', c.name, 'industry', c.industry, 'size', c.size, 'country', c.country))
        || coalesce((select jsonb_object_agg('f.' || k, v) from jsonb_each(c.fields) e(k, v)), '{}'),
      c.field_sources,
      jsonb_strip_nulls(jsonb_build_object('name', r.name, 'industry', nullif(trim(left(r.industry, 120)), ''), 'size', nullif(trim(left(r.size, 40)), ''),
        'country', case when upper(trim(r.country)) ~ '^[A-Z]{2}$' then upper(trim(r.country)) end))
        || coalesce((select jsonb_object_agg('f.' || k, v) from jsonb_each(coalesce(r.fields, '{}')) e(k, v) where v <> 'null' and v <> '""'), '{}'));
    update companies set
      name = coalesce(m->'vals'->>'name', name),
      industry = m->'vals'->>'industry',
      size = m->'vals'->>'size',
      country = m->'vals'->>'country',
      fields = coalesce((select jsonb_object_agg(substr(k, 3), v) from jsonb_each(m->'vals') e(k, v) where k like 'f.%'), '{}'),
      field_sources = m->'src',
      source_ids = case when r.source_id is null then source_ids else source_ids || jsonb_build_object(p_source, r.source_id) end,
      updated_at = case when jsonb_array_length(m->'changes') > 0 then now() else updated_at end
    where id = cid;
    if jsonb_array_length(m->'changes') > 0 then
      changed := changed + 1;
      insert into field_history (workspace_id, object, record_id, key, old, new, old_source, source)
      select p_ws, 'company', cid, x->>'key', x->'old', x->'new', x->'old_source', p_source from jsonb_array_elements(m->'changes') x;
    end if;
    ids := ids || to_jsonb(cid);
  end loop;
  return jsonb_build_object('ids', ids, 'changed', changed);
end;
$$;

-- A list from a source as a static segment: members set to exactly these emails (when p_replace), or added.
create or replace function public.source_list_sync(p_source uuid, p_external text, p_name text, p_emails text[], p_replace boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  seg uuid;
begin
  select * into s from sources where id = p_source;
  insert into segments (workspace_id, name, kind, source_id, external_id)
  values (s.workspace_id, left(coalesce(nullif(trim(p_name), ''), 'List'), 120), 'static', p_source, p_external)
  on conflict (source_id, external_id) where source_id is not null do update set name = excluded.name
  returning id into seg;
  insert into segment_members (workspace_id, segment_id, contact_id)
  select s.workspace_id, seg, c.id from contacts c where c.workspace_id = s.workspace_id and c.deleted_at is null and c.email_clean = any(p_emails)
  on conflict (segment_id, contact_id) do update set left_at = null;
  if p_replace then
    update segment_members m set left_at = now()
    where m.segment_id = seg and m.left_at is null
      and not exists (select 1 from contacts c where c.id = m.contact_id and c.email_clean = any(p_emails));
  end if;
  update segments set count = (select count(*) from segment_members where segment_id = seg and left_at is null), refreshed_at = now() where id = seg;
  return seg;
end;
$$;

-- Webhooks: stage a delivery once, then wake the job.
create or replace function public.hook_stage(p_source uuid, p_dedupe text, p_body jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  s sources%rowtype;
  n int;
begin
  select * into s from sources where id = p_source;
  if s.id is null or s.status = 'disconnected' then
    return false;
  end if;
  insert into hook_events (workspace_id, source_id, dedupe, body) values (s.workspace_id, p_source, left(p_dedupe, 300), p_body)
  on conflict (source_id, dedupe) do nothing;
  get diagnostics n = row_count;
  if n > 0 and s.status <> 'paused' then
    perform enqueue_job(s.workspace_id, 'source_hook', p_source::text, jsonb_build_object('source_id', p_source), 2, 8);
  end if;
  return n > 0;
end;
$$;

create or replace function public.hook_events_take(p_source uuid, p_limit int default 500) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'body', body) order by id), '[]')
  from (select id, body from hook_events where source_id = p_source and done_at is null order by id limit least(p_limit, 2000)) x;
$$;

create or replace function public.hook_events_done(p_ids bigint[]) returns void
language sql security definer set search_path = public as $$
  update hook_events set done_at = now() where id = any(p_ids);
$$;

-- Contacts changed since the push cursor, with what the push needs: values, company, link.
create or replace function public.push_candidates(p_source uuid, p_after text, p_limit int default 200, p_ids uuid[] default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select * from sources where id = p_source)
  select coalesce(jsonb_agg(x order by x->>'updated_at', x->>'id'), '[]') from (
    select jsonb_build_object(
      'id', c.id, 'updated_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'email', c.email, 'email_clean', c.email_clean, 'first_name', c.first_name, 'last_name', c.last_name, 'title', c.title, 'phone', c.phone,
      'country', c.country, 'region', c.region, 'timezone', c.timezone, 'lifecycle', c.lifecycle, 'lead_status', c.lead_status, 'fields', c.fields,
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

-- Each minute: sources that are due pull; two-way sources with local changes push.
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
  return n;
end;
$$;

create or replace function public.prune_sync() returns void
language sql security definer set search_path = public as $$
  delete from sync_log where at < now() - interval '90 days';
  delete from source_runs where started_at < now() - interval '90 days';
  delete from hook_events where (done_at is not null and done_at < now() - interval '7 days') or received_at < now() - interval '30 days';
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

do $$
declare
  f text;
begin
  foreach f in array array[
    'source_connect(uuid, uuid, text, text, text, text, jsonb, text)', 'source_load(uuid)', 'source_secret_save(uuid, text)',
    'source_by_account(text, text)', 'source_cursor_save(uuid, text, jsonb)', 'source_push_cursor_save(uuid, text)', 'source_ran(uuid, text)',
    'source_run_log(uuid, text, text, timestamptz, jsonb, text)', 'source_links_get(uuid, text, text[])', 'source_links_put(uuid, text, jsonb)',
    'source_links_delete(uuid, text, text[])', 'sync_log_add(uuid, jsonb)', 'source_columns_save(uuid, text, jsonb)', 'contact_ids_by_email(uuid, text[])', 'companies_upsert(uuid, text, jsonb)',
    'source_list_sync(uuid, text, text, text[], boolean)', 'hook_stage(uuid, text, jsonb)', 'hook_events_take(uuid, int)', 'hook_events_done(bigint[])',
    'push_candidates(uuid, text, int, uuid[])', 'sources_due()', 'prune_sync()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['source_settings_save(uuid, text, jsonb)', 'source_pause(uuid, boolean)', 'source_disconnect(uuid)', 'source_sync_now(uuid)',
    'mapping_save(uuid, text, jsonb)', 'sync_retry(bigint[])'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
