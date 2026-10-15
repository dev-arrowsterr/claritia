-- Identity (docs/identity.md Part 11): people, identifiers, device links, merge proposals and the settings the
-- stitch job reads. The stitch job (claritia-intel) writes all of it with the service role. Members read their own
-- workspace's rows. Accounts, signals and scores come in 024.

-- Settings -------------------------------------------------------------------------------------------------

create table if not exists public.identity_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  -- Emails at these domains mark the device internal (docs/identity.md Part 9).
  own_domains text[] not null default '{}' check (cardinality(own_domains) <= 20),
  partner_domains text[] not null default '{}' check (cardinality(partner_domains) <= 200),
  office_nets cidr[] not null default '{}' check (cardinality(office_nets) <= 50),
  -- The identify secrets (current and next), sealed with SECRETS_KEY. Never granted to people.
  identify_secrets_sealed text,
  updated_at timestamptz not null default now()
);
alter table public.identity_settings enable row level security;
create policy "members read" on public.identity_settings for select using (is_member(workspace_id));
revoke all on public.identity_settings from anon;
revoke insert, update, delete on public.identity_settings from authenticated;
revoke select on public.identity_settings from authenticated;
grant select (workspace_id, own_domains, partner_domains, office_nets, updated_at) on public.identity_settings to authenticated;

-- People ------------------------------------------------------------------------------------------------------

create table if not exists public.persons (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  display_name text,
  primary_email text,
  account_id uuid,
  partner boolean not null default false,
  opted_out boolean not null default false,
  merged_into uuid
);
create index if not exists persons_ws on public.persons (workspace_id, created_at desc);
alter table public.persons enable row level security;
create policy "members read" on public.persons for select using (is_member(workspace_id));
revoke all on public.persons from anon;
revoke insert, update, delete on public.persons from authenticated;

create table if not exists public.person_aliases (
  old_id uuid primary key,
  new_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now()
);
alter table public.person_aliases enable row level security;
create policy "members read" on public.person_aliases for select using (is_member(workspace_id));
revoke all on public.person_aliases from anon;
revoke insert, update, delete on public.person_aliases from authenticated;

create table if not exists public.identifiers (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  person_id uuid,
  kind text not null check (kind in ('email', 'user', 'hubspot')),
  value_raw text,
  value_clean text not null,
  value_hash bytea not null,
  class text check (class in ('work', 'free', 'role', 'own', 'partner')),
  domain text,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, value_clean)
);
create index if not exists identifiers_person on public.identifiers (workspace_id, person_id);
create index if not exists identifiers_hash on public.identifiers (workspace_id, value_hash);
alter table public.identifiers enable row level security;
create policy "members read" on public.identifiers for select using (is_member(workspace_id));
revoke all on public.identifiers from anon;
revoke insert, update, delete on public.identifiers from authenticated;

-- Device links ------------------------------------------------------------------------------------------------

create table if not exists public.device_links (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  device_id uuid not null,
  person_id uuid not null,
  level text not null check (level in ('verified', 'asserted', 'probable')),
  from_at timestamptz not null,
  to_at timestamptz,
  evidence_id uuid not null
);
create index if not exists device_links_device on public.device_links (workspace_id, device_id, from_at desc);
create index if not exists device_links_person on public.device_links (workspace_id, person_id);
-- At most one open link per device.
create unique index if not exists device_links_open on public.device_links (device_id) where to_at is null;
alter table public.device_links enable row level security;
create policy "members read" on public.device_links for select using (is_member(workspace_id));
revoke all on public.device_links from anon;
revoke insert, update, delete on public.device_links from authenticated;

create table if not exists public.merge_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  person_a uuid not null,
  person_b uuid not null,
  reason text not null,
  evidence_id uuid,
  status text not null default 'open' check (status in ('open', 'approved', 'denied')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, person_a, person_b)
);
alter table public.merge_proposals enable row level security;
create policy "members read" on public.merge_proposals for select using (is_member(workspace_id));
revoke all on public.merge_proposals from anon;
revoke insert, update, delete on public.merge_proposals from authenticated;

-- Sessions split when the device's person changes mid-visit (docs/identity.md 7.6). Collect keeps writing to the
-- session it knows; split_to sends those events to the newest part.
alter table public.sessions add column if not exists split_to uuid;

-- Server-only ---------------------------------------------------------------------------------------------------

-- Company data by network, shared across workspaces. No person data.
create table if not exists public.ip_cache (
  key bytea primary key,
  net cidr not null,
  domain text,
  kind text,
  confidence int,
  vendor text,
  fetched_at timestamptz not null default now()
);
alter table public.ip_cache enable row level security;
revoke all on public.ip_cache from anon, authenticated;

create table if not exists public.learned_networks (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  net cidr not null,
  account_id uuid,
  people int not null default 0,
  share numeric,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, net)
);
alter table public.learned_networks enable row level security;
create policy "members read" on public.learned_networks for select using (is_member(workspace_id));
revoke all on public.learned_networks from anon;
revoke insert, update, delete on public.learned_networks from authenticated;

-- Erasure record: the hash of what was erased, so it's never stitched again.
create table if not exists public.erasures (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  value_hash bytea not null,
  at timestamptz not null default now(),
  primary key (workspace_id, value_hash)
);
alter table public.erasures enable row level security;
revoke all on public.erasures from anon, authenticated;

create table if not exists public.email_tokens (
  token_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id text,
  email_id uuid,
  sent_at timestamptz,
  claimed_device uuid,
  claimed_at timestamptz,
  forwarded boolean not null default false
);
alter table public.email_tokens enable row level security;
revoke all on public.email_tokens from anon, authenticated;
