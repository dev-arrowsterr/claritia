-- Website Intelligence, part 1 (docs/m1-website-intelligence.md Part 4.1): sites, devices, sessions and events.
-- claritia-collect writes these with the service role; members read their own workspace's rows. Events are split
-- into one table per day, made a week ahead and dropped after the longest retention, so old data leaves in one step.
-- The identity tables (persons, evidence, links) come in 022.

-- Sites ------------------------------------------------------------------------

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The registrable domain, cleaned by the server (acme.com, not www.acme.com).
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  extra_domains text[] not null default '{}' check (cardinality(extra_domains) <= 20),
  -- Goes in the script tag, so it isn't secret. It only lets a page send events for this site.
  site_key text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- Sent by the customer's proxy so collect trusts the visitor IP it forwards.
  proxy_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- How events arrive, as collect last saw it: proxy, a_record, cname, direct.
  install_mode text check (install_mode in ('proxy', 'a_record', 'cname', 'direct')),
  -- {"strict": ["CA-QC"], "off": ["RU"]}: regions this site treats more strictly than the default.
  policy_overrides jsonb not null default '{}',
  private_paths text[] not null default '{}' check (cardinality(private_paths) <= 100),
  url_param_allow text[] not null default '{utm_source,utm_medium,utm_campaign,utm_term,utm_content,gclid,fbclid,ref,page,q}',
  city_level boolean not null default true,
  honor_dnt boolean not null default false,
  event_retention_days int not null default 90 check (event_retention_days between 30 and 180),
  paused boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, domain)
);
alter table public.sites enable row level security;
create policy "members read" on public.sites for select using (is_member(workspace_id));
revoke all on public.sites from anon;
revoke insert, update, delete on public.sites from authenticated;

-- Add a site. Owners only; the server cleans the domain first.
create or replace function public.add_site(p_workspace uuid, p_domain text, p_extra_domains text[] default '{}')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sid uuid;
begin
  if not is_owner(p_workspace) then
    raise exception 'Only the workspace owner can add sites';
  end if;
  if (select count(*) from sites where workspace_id = p_workspace) >= 20 then
    raise exception 'A workspace can have up to 20 sites';
  end if;
  insert into sites (workspace_id, domain, extra_domains)
  values (p_workspace, lower(p_domain), coalesce(p_extra_domains, '{}'))
  returning id into sid;
  insert into audit_log (workspace_id, actor, action, target) values (p_workspace, auth.uid(), 'site.add', lower(p_domain));
  return sid;
exception when unique_violation then
  raise exception '% is already a site in this workspace', lower(p_domain);
end;
$$;

-- Change a site's settings. Owners only. Null leaves a setting as it is.
create or replace function public.update_site(p_site uuid, p_extra_domains text[] default null, p_private_paths text[] default null,
  p_url_param_allow text[] default null, p_policy_overrides jsonb default null, p_city_level boolean default null,
  p_honor_dnt boolean default null, p_event_retention_days int default null, p_paused boolean default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from sites where id = p_site;
  if ws is null or not is_owner(ws) then
    raise exception 'Site not found';
  end if;
  update sites set
    extra_domains = coalesce(p_extra_domains, extra_domains),
    private_paths = coalesce(p_private_paths, private_paths),
    url_param_allow = coalesce(p_url_param_allow, url_param_allow),
    policy_overrides = coalesce(p_policy_overrides, policy_overrides),
    city_level = coalesce(p_city_level, city_level),
    honor_dnt = coalesce(p_honor_dnt, honor_dnt),
    event_retention_days = coalesce(p_event_retention_days, event_retention_days),
    paused = coalesce(p_paused, paused)
  where id = p_site;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'site.update', p_site::text);
end;
$$;

-- Remove a site and everything collected on it. Owners only.
create or replace function public.remove_site(p_site uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  dom text;
begin
  select workspace_id, domain into ws, dom from sites where id = p_site;
  if ws is null or not is_owner(ws) then
    raise exception 'Site not found';
  end if;
  delete from events where session_id in (select id from sessions where site_id = p_site);
  delete from sessions where site_id = p_site;
  delete from sites where id = p_site;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'site.remove', dom);
end;
$$;

-- Devices -------------------------------------------------------------------------
-- One browser on one site, known by the signed _clr_id cookie (docs/identity.md Part 4).

create table if not exists public.devices (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  state text not null default 'fresh' check (state in ('fresh', 'probable', 'linked', 'shared', 'tainted', 'internal', 'opted_out')),
  state_since timestamptz not null default now(),
  tainted_until timestamptz,
  no_backfill boolean not null default false,
  consent text check (consent in ('granted', 'denied', 'unknown')),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  sessions int not null default 0
);
create index if not exists devices_ws_state on public.devices (workspace_id, state);
create index if not exists devices_ws_seen on public.devices (workspace_id, last_seen);
alter table public.devices enable row level security;
create policy "members read" on public.devices for select using (is_member(workspace_id));
revoke all on public.devices from anon;
revoke insert, update, delete on public.devices from authenticated;

-- Sessions ------------------------------------------------------------------------
-- One visit: ends after 30 minutes with nothing new. Cookieless visits have no device, only a daily key.

create table if not exists public.sessions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  cookieless_key bytea,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  policy text not null check (policy in ('strict', 'notice', 'off', 'cookieless')),
  consent text check (consent in ('granted', 'denied', 'unknown')),
  gpc boolean not null default false,
  country text check (length(country) = 2),
  region text,
  city text,
  device_type text check (device_type in ('desktop', 'mobile', 'tablet', 'other')),
  browser text,
  os text,
  landing_path text,
  referrer_host text,
  source text,
  medium text,
  campaign text,
  term text,
  content text,
  ref_class text check (ref_class in ('search', 'ai_assistant', 'review_site', 'social', 'partner', 'email', 'paid', 'direct', 'other')),
  -- The /24 (IPv4) or /48 (IPv6) network. The full address is never stored.
  ip_net cidr check (ip_net is null or (family(ip_net) = 4 and masklen(ip_net) <= 24) or (family(ip_net) = 6 and masklen(ip_net) <= 48)),
  ip_kind text,
  person_id uuid,
  person_level text check (person_level in ('verified', 'asserted', 'probable')),
  person_source text check (person_source in ('live', 'backfill', 'split')),
  account_id uuid,
  account_source text check (account_source in ('crm', 'email', 'learned_network', 'vendor_network', 'manual')),
  network_account_id uuid,
  pageviews int not null default 0,
  engaged_s int not null default 0,
  internal boolean not null default false,
  is_bot boolean not null default false,
  split_from uuid,
  check (device_id is not null or cookieless_key is not null)
);
create index if not exists sessions_ws_started on public.sessions (workspace_id, started_at desc);
create index if not exists sessions_device on public.sessions (device_id, started_at);
create index if not exists sessions_account on public.sessions (workspace_id, account_id, started_at desc) where account_id is not null;
create index if not exists sessions_person on public.sessions (workspace_id, person_id, started_at desc) where person_id is not null;
alter table public.sessions enable row level security;
create policy "members read" on public.sessions for select using (is_member(workspace_id));
revoke all on public.sessions from anon;
revoke insert, update, delete on public.sessions from authenticated;

-- Events ---------------------------------------------------------------------------
-- What happened in a session. One table per day; the id is made in the browser, so a batch sent twice lands once.

create table if not exists public.events (
  id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  day date not null,
  kind text not null check (kind in ('view', 'engage', 'click', 'form', 'identify', 'custom')),
  path text check (length(path) <= 2048),
  title text check (length(title) <= 300),
  data jsonb,
  client_at timestamptz,
  server_at timestamptz not null default now(),
  primary key (day, id)
) partition by range (day);
create index if not exists events_session on public.events (session_id);
create index if not exists events_ws_day on public.events (workspace_id, day);
alter table public.events enable row level security;
create policy "members read" on public.events for select using (is_member(workspace_id));
revoke all on public.events from anon;
revoke insert, update, delete on public.events from authenticated;

-- Day tables from yesterday to a week ahead. Each one is closed to people directly: they read through events.
create or replace function public.make_event_partitions(p_days_ahead int default 7) returns int
language plpgsql security definer set search_path = public as $$
declare
  d date;
  name text;
  made int := 0;
begin
  for d in select generate_series(current_date - 1, current_date + greatest(p_days_ahead, 1), interval '1 day')::date loop
    name := 'events_' || to_char(d, 'YYYYMMDD');
    if to_regclass('public.' || name) is null then
      execute format('create table public.%I partition of public.events for values from (%L) to (%L)', name, d, d + 1);
      execute format('alter table public.%I enable row level security', name);
      execute format('revoke all on public.%I from anon, authenticated', name);
      made := made + 1;
    end if;
  end loop;
  return made;
end;
$$;

-- Day tables older than every site's retention (most is 180 days) are dropped whole. Shorter retentions are cut
-- per site by the retention job.
create or replace function public.drop_old_event_partitions(p_keep_days int default 180) returns int
language plpgsql security definer set search_path = public as $$
declare
  t record;
  dropped int := 0;
begin
  for t in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
    where p.relname = 'events' and c.relname ~ '^events_\d{8}$'
      and to_date(substring(c.relname from 8), 'YYYYMMDD') < current_date - greatest(p_keep_days, 30)
  loop
    execute format('drop table public.%I', t.relname);
    dropped := dropped + 1;
  end loop;
  return dropped;
end;
$$;

select public.make_event_partitions(7);

-- Page groups ---------------------------------------------------------------------
-- Which paths mean pricing, demo, docs and so on. Suggested from a crawl, confirmed by the team.

create table if not exists public.page_groups (
  site_id uuid not null references public.sites (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  pattern text not null check (pattern ~ '^/' and length(pattern) <= 300),
  grp text not null check (grp in ('pricing', 'demo', 'compare', 'security', 'integrations', 'docs', 'case_study', 'product',
                                   'blog', 'careers', 'legal', 'login', 'private', 'other')),
  competitor text check (length(competitor) <= 100),
  source text not null default 'user' check (source in ('user', 'suggested')),
  primary key (site_id, pattern)
);
alter table public.page_groups enable row level security;
create policy "members read" on public.page_groups for select using (is_member(workspace_id));
revoke all on public.page_groups from anon;
revoke insert, update, delete on public.page_groups from authenticated;

-- Replace a site's page groups. Any member may edit them.
create or replace function public.set_page_groups(p_site uuid, p_groups jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  n int;
begin
  select workspace_id into ws from sites where id = p_site;
  if ws is null or not is_member(ws) then
    raise exception 'Site not found';
  end if;
  if jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) > 500 then
    raise exception 'Up to 500 page groups';
  end if;
  delete from page_groups where site_id = p_site;
  insert into page_groups (site_id, workspace_id, pattern, grp, competitor, source)
  select p_site, ws, g->>'pattern', g->>'grp', nullif(g->>'competitor', ''), coalesce(g->>'source', 'user')
  from jsonb_array_elements(p_groups) g;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Server-only tables ------------------------------------------------------------------

-- The cookieless salt for each day. Deleted after 24 hours, so yesterday's visits can't be linked to today's.
create table if not exists public.salts (day date primary key, salt bytea not null, created_at timestamptz not null default now());
alter table public.salts enable row level security;
revoke all on public.salts from anon, authenticated;

-- Opt-outs per site, by a hash of the device id.
create table if not exists public.opt_outs (
  site_id uuid not null references public.sites (id) on delete cascade,
  device_hash bytea not null,
  created_at timestamptz not null default now(),
  primary key (site_id, device_hash)
);
alter table public.opt_outs enable row level security;
revoke all on public.opt_outs from anon, authenticated;

-- Cross-domain hop tokens already used, kept 10 minutes.
create table if not exists public.hop_nonces (nonce bytea primary key, used_at timestamptz not null default now());
alter table public.hop_nonces enable row level security;
revoke all on public.hop_nonces from anon, authenticated;

-- Rollups -------------------------------------------------------------------------
-- Counts for the screens. site_daily holds no person data.

create table if not exists public.site_daily (
  site_id uuid not null references public.sites (id) on delete cascade,
  workspace_id uuid not null,
  day date not null,
  path text not null default '',
  source text not null default '',
  medium text not null default '',
  campaign text not null default '',
  ref_class text not null default '',
  country text not null default '',
  device_type text not null default '',
  visitors int not null default 0,
  sessions int not null default 0,
  views int not null default 0,
  engaged_s bigint not null default 0,
  bounces int not null default 0,
  primary key (site_id, day, path, source, medium, campaign, ref_class, country, device_type)
);
create index if not exists site_daily_ws on public.site_daily (workspace_id, day);
alter table public.site_daily enable row level security;
create policy "members read" on public.site_daily for select using (is_member(workspace_id));
revoke all on public.site_daily from anon;
revoke insert, update, delete on public.site_daily from authenticated;

create table if not exists public.account_daily (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null,
  day date not null,
  sessions int not null default 0,
  people int not null default 0,
  devices int not null default 0,
  views int not null default 0,
  engaged_s int not null default 0,
  high_views int not null default 0,
  primary key (workspace_id, account_id, day)
);
alter table public.account_daily enable row level security;
create policy "members read" on public.account_daily for select using (is_member(workspace_id));
revoke all on public.account_daily from anon;
revoke insert, update, delete on public.account_daily from authenticated;

-- Daily upkeep ------------------------------------------------------------------------

-- Make the next week's day tables, drop the oldest, rotate the cookieless salt and clear old hop tokens.
create or replace function public.web_daily() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform make_event_partitions(7);
  perform drop_old_event_partitions(180);
  insert into salts (day, salt) values (current_date, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))
  on conflict (day) do nothing;
  delete from salts where day < current_date - 1;
  delete from hop_nonces where used_at < now() - interval '10 minutes';
end;
$$;
select public.web_daily();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('claritia-web-daily', '5 0 * * *', 'select public.web_daily()');
  end if;
end $$;

revoke execute on function public.add_site(uuid, text, text[]) from public, anon;
grant execute on function public.add_site(uuid, text, text[]) to authenticated;
revoke execute on function public.update_site(uuid, text[], text[], text[], jsonb, boolean, boolean, int, boolean) from public, anon;
grant execute on function public.update_site(uuid, text[], text[], text[], jsonb, boolean, boolean, int, boolean) to authenticated;
revoke execute on function public.remove_site(uuid) from public, anon;
grant execute on function public.remove_site(uuid) to authenticated;
revoke execute on function public.set_page_groups(uuid, jsonb) from public, anon;
grant execute on function public.set_page_groups(uuid, jsonb) to authenticated;
revoke execute on function public.make_event_partitions(int) from public, anon, authenticated;
revoke execute on function public.drop_old_event_partitions(int) from public, anon, authenticated;
revoke execute on function public.web_daily() from public, anon, authenticated;
grant execute on function public.make_event_partitions(int) to service_role;
grant execute on function public.drop_old_event_partitions(int) to service_role;
grant execute on function public.web_daily() to service_role;
