-- Accounts, signals and scores (docs/m1-website-intelligence.md 4.2). claritia-intel writes them with the service
-- role; members read their own workspace's rows. company_cache and domain_aliases are shared company data, with
-- no person data, and only the server reads them.

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null,
  name text,
  logo_url text,
  -- size band, industry, HQ country, founded, 6- and 12-month headcount growth (Coresignal)
  firmo jsonb,
  firmo_at timestamptz,
  owner_user_id uuid,
  omniscient_account_id text,
  hubspot_company_id text,
  fit int check (fit between 0 and 100),
  intent int check (intent between 0 and 100),
  priority numeric,
  stage text check (stage in ('unknown', 'engaged', 'researching', 'evaluating')),
  stage_since timestamptz,
  temperature text check (temperature in ('cold', 'cooling', 'steady', 'warming', 'hot')),
  why_now text,
  last_signal_at timestamptz,
  first_seen timestamptz not null default now(),
  -- shared_network, partner, customer
  flags text[] not null default '{}',
  unique (workspace_id, domain)
);
create index if not exists accounts_priority on public.accounts (workspace_id, priority desc nulls last);
alter table public.accounts enable row level security;
create policy "members read" on public.accounts for select using (is_member(workspace_id));
revoke all on public.accounts from anon;
revoke insert, update, delete on public.accounts from authenticated;

create table if not exists public.account_domains (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null,
  account_id uuid not null references public.accounts (id) on delete cascade,
  source text not null check (source in ('primary', 'alias', 'crm', 'manual')),
  confidence int not null default 100,
  primary key (workspace_id, domain)
);
alter table public.account_domains enable row level security;
create policy "members read" on public.account_domains for select using (is_member(workspace_id));
revoke all on public.account_domains from anon;
revoke insert, update, delete on public.account_domains from authenticated;

create table if not exists public.domain_aliases (
  domain text primary key,
  canonical text not null,
  source text not null default 'redirect',
  checked_at timestamptz not null default now()
);
alter table public.domain_aliases enable row level security;
revoke all on public.domain_aliases from anon, authenticated;

create table if not exists public.company_cache (
  domain text primary key,
  data jsonb not null,
  vendor text not null,
  fetched_at timestamptz not null default now()
);
alter table public.company_cache enable row level security;
revoke all on public.company_cache from anon, authenticated;

create table if not exists public.network_flags (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  net cidr not null,
  flag text not null check (flag in ('office', 'shared', 'partner', 'ignore')),
  by_user uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, net, flag)
);
alter table public.network_flags enable row level security;
create policy "members read" on public.network_flags for select using (is_member(workspace_id));
revoke all on public.network_flags from anon;
revoke insert, update, delete on public.network_flags from authenticated;

-- Signals -------------------------------------------------------------------------------------------------

create table if not exists public.signal_types (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  weight numeric not null check (weight between 0 and 100),
  half_life_days numeric not null check (half_life_days between 1 and 365),
  -- What makes two signals the same: session, day, week or account.
  dedupe text not null check (dedupe in ('session', 'day', 'week', 'account')),
  enabled boolean not null default true,
  primary key (workspace_id, kind)
);
alter table public.signal_types enable row level security;
create policy "members read" on public.signal_types for select using (is_member(workspace_id));
revoke all on public.signal_types from anon;
revoke insert, update, delete on public.signal_types from authenticated;

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  person_id uuid,
  kind text not null,
  weight numeric not null,
  at timestamptz not null,
  dedupe_key text not null,
  evidence jsonb not null,
  unique (workspace_id, dedupe_key)
);
create index if not exists signals_account on public.signals (workspace_id, account_id, at desc);
alter table public.signals enable row level security;
create policy "members read" on public.signals for select using (is_member(workspace_id));
revoke all on public.signals from anon;
revoke insert, update, delete on public.signals from authenticated;

-- Scores --------------------------------------------------------------------------------------------------

create table if not exists public.icp (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  rules jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.icp enable row level security;
create policy "members read" on public.icp for select using (is_member(workspace_id));
revoke all on public.icp from anon;
revoke insert, update, delete on public.icp from authenticated;

create table if not exists public.account_scores (
  account_id uuid not null references public.accounts (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now(),
  fit int,
  intent int,
  priority numeric,
  stage text,
  temperature text,
  why_now jsonb,
  reasons jsonb,
  score_version int not null default 1,
  inputs_hash text,
  primary key (account_id, at)
);
alter table public.account_scores enable row level security;
create policy "members read" on public.account_scores for select using (is_member(workspace_id));
revoke all on public.account_scores from anon;
revoke insert, update, delete on public.account_scores from authenticated;

create table if not exists public.intent_params (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  k numeric not null default 60,
  fitted_at timestamptz
);
alter table public.intent_params enable row level security;
create policy "members read" on public.intent_params for select using (is_member(workspace_id));
revoke all on public.intent_params from anon;
revoke insert, update, delete on public.intent_params from authenticated;

create table if not exists public.account_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('good', 'bad', 'not_icp', 'customer', 'competitor')),
  note text check (length(note) <= 1000),
  created_at timestamptz not null default now()
);
alter table public.account_feedback enable row level security;
create policy "members read" on public.account_feedback for select using (is_member(workspace_id));
revoke all on public.account_feedback from anon;
revoke insert, update, delete on public.account_feedback from authenticated;

-- Account alerts (the delivery itself reuses 014's alert senders).
create table if not exists public.account_alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid,
  rule jsonb not null,
  channel text not null check (channel in ('slack', 'email')),
  quiet_hours jsonb,
  daily_cap int not null default 10 check (daily_cap between 1 and 100),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.account_alert_rules enable row level security;
create policy "members read" on public.account_alert_rules for select using (is_member(workspace_id));
revoke all on public.account_alert_rules from anon;
revoke insert, update, delete on public.account_alert_rules from authenticated;

create table if not exists public.account_alert_log (
  rule_id uuid not null references public.account_alert_rules (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (rule_id, account_id, sent_at)
);
alter table public.account_alert_log enable row level security;
create policy "members read" on public.account_alert_log for select using (is_member(workspace_id));
revoke all on public.account_alert_log from anon;
revoke insert, update, delete on public.account_alert_log from authenticated;
