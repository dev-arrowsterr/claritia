-- Sending (docs/conversion-weeks.md week 9, docs/marketing-platform.md M3): verified domains, sending settings,
-- emails and one row per message, SES events, and the guard every message passes at the moment it's handed to SES.
--   sending_domains: a domain the workspace sends from, with the DNS records to add and each one's state.
--   send_settings: one row per workspace. From, physical address, frequency cap, quiet hours, rate, pause.
--   emails: what's sent (week 10 adds blocks and templates). Links are listed once, so a click token only carries
--           the message and the link's place.
--   email_messages: one per recipient. queued → sending → sent → delivered, or skipped, failed, bounced, complained.
--           A message that may have reached SES is never sent again: if the worker stops mid-send it turns
--           'unknown', and a double send never happens.
--   email_events: SES events, clicks and unsubscribes. SNS deliveries are deduped by their message id.

-- Domains -----------------------------------------------------------------------------------------------------

create table if not exists public.sending_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and length(domain) <= 253),
  -- The custom MAIL FROM (SPF and bounces) and the link host, both under the domain.
  mail_from text not null,
  tracking_host text not null,
  dkim_tokens text[] not null default '{}',
  -- [{key, type, name, value, required, status: verified | waiting | wrong, seen?}]
  records jsonb not null default '[]' check (jsonb_typeof(records) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  error text check (length(error) <= 500),
  checked_at timestamptz,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
-- SES identities are account-wide, so a domain belongs to one workspace.
create unique index if not exists sending_domains_domain on public.sending_domains (domain);
create index if not exists sending_domains_ws on public.sending_domains (workspace_id);
alter table public.sending_domains enable row level security;
create policy "members read" on public.sending_domains for select using (is_member(workspace_id));
revoke all on public.sending_domains from anon;
revoke insert, update, delete on public.sending_domains from authenticated;

-- Settings ----------------------------------------------------------------------------------------------------

create table if not exists public.send_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  from_name text check (length(from_name) <= 80),
  from_email text check (length(from_email) <= 254 and (from_email is null or from_email ~ '^[^\s@]+@[^\s@]+$')),
  reply_to text check (length(reply_to) <= 254 and (reply_to is null or reply_to ~ '^[^\s@]+@[^\s@]+$')),
  -- CAN-SPAM: a physical address in every marketing email.
  address text check (length(address) <= 300),
  cap_count int not null default 3 check (cap_count between 1 and 50),
  cap_days int not null default 7 check (cap_days between 1 and 60),
  -- Quiet hours in the contact's time zone, as whole hours. Equal means none.
  quiet_start int not null default 21 check (quiet_start between 0 and 23),
  quiet_end int not null default 8 check (quiet_end between 0 and 23),
  -- For contacts with no time zone.
  timezone text not null default 'UTC' check (length(timezone) <= 60),
  per_second int not null default 14 check (per_second between 1 and 200),
  per_day int not null default 50000 check (per_day between 1 and 10000000),
  paused boolean not null default false,
  paused_reason text check (length(paused_reason) <= 300),
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.send_settings enable row level security;
create policy "members read" on public.send_settings for select using (is_member(workspace_id));
revoke all on public.send_settings from anon;
revoke insert, update, delete on public.send_settings from authenticated;

-- Emails and messages -----------------------------------------------------------------------------------------

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('broadcast', 'journey', 'one_to_one', 'test')),
  subject text not null check (length(subject) between 1 and 300),
  preheader text check (length(preheader) <= 300),
  html text not null check (length(html) <= 500000),
  text text not null check (length(text) <= 200000),
  -- The links in html, in order. A click token names a message and a place in this list.
  links text[] not null default '{}' check (cardinality(links) <= 500),
  from_name text check (length(from_name) <= 80),
  from_email text check (length(from_email) <= 254),
  topic_id uuid references public.topics (id) on delete set null,
  -- Marketing emails carry the footer and one-click unsubscribe and pass consent, cap and quiet hours.
  marketing boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists emails_ws on public.emails (workspace_id, created_at desc);
alter table public.emails enable row level security;
create policy "members read" on public.emails for select using (is_member(workspace_id));
revoke all on public.emails from anon;
revoke insert, update, delete on public.emails from authenticated;

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email_id uuid not null references public.emails (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  to_email text not null check (length(to_email) <= 254),
  -- One message per email and contact (or address), so a retried queue call never adds a second.
  dedupe text not null check (length(dedupe) <= 300),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'skipped', 'failed', 'unknown')),
  skip_reason text check (length(skip_reason) <= 40),
  error text check (length(error) <= 500),
  attempts int not null default 0,
  send_after timestamptz not null default now(),
  claimed_at timestamptz,
  ses_message_id text unique,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced text check (bounced in ('hard', 'soft')),
  complained_at timestamptz,
  first_click_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, dedupe)
);
create index if not exists email_messages_ready on public.email_messages (workspace_id, send_after) where status = 'queued';
create index if not exists email_messages_sending on public.email_messages (claimed_at) where status = 'sending';
create index if not exists email_messages_contact on public.email_messages (contact_id, sent_at desc) where contact_id is not null;
create index if not exists email_messages_email on public.email_messages (email_id);
create index if not exists email_messages_sent on public.email_messages (workspace_id, sent_at desc) where sent_at is not null;
alter table public.email_messages enable row level security;
create policy "members read" on public.email_messages for select using (is_member(workspace_id));
revoke all on public.email_messages from anon;
revoke insert, update, delete on public.email_messages from authenticated;

create table if not exists public.email_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id uuid references public.email_messages (id) on delete cascade,
  kind text not null check (kind in ('delivered', 'bounced', 'complained', 'rejected', 'delayed', 'clicked', 'unsubscribed')),
  data jsonb not null default '{}',
  -- The SNS message id, so a redelivered notification counts once.
  sns_id text unique check (length(sns_id) <= 100),
  at timestamptz not null default now()
);
create index if not exists email_events_message on public.email_events (message_id, at);
create index if not exists email_events_ws on public.email_events (workspace_id, kind, at desc);
alter table public.email_events enable row level security;
create policy "members read" on public.email_events for select using (is_member(workspace_id));
revoke all on public.email_events from anon;
revoke insert, update, delete on public.email_events from authenticated;

-- Helpers -----------------------------------------------------------------------------------------------------

create or replace function public.send_settings_of(p_ws uuid) returns send_settings
language plpgsql security definer set search_path = public as $$
declare
  s send_settings;
begin
  select * into s from send_settings where workspace_id = p_ws;
  if not found then
    insert into send_settings (workspace_id) values (p_ws) on conflict do nothing;
    select * into s from send_settings where workspace_id = p_ws;
  end if;
  return s;
end;
$$;

-- The local hour in a time zone, or null for a name Postgres doesn't know.
create or replace function public.local_hour(p_at timestamptz, p_tz text) returns int
language plpgsql stable set search_path = public as $$
begin
  return extract(hour from p_at at time zone p_tz)::int;
exception when others then
  return null;
end;
$$;

-- The next moment the local clock reads p_hour:00 in p_tz, after p_at.
create or replace function public.next_local_hour(p_at timestamptz, p_tz text, p_hour int) returns timestamptz
language plpgsql stable set search_path = public as $$
declare
  local timestamp := p_at at time zone p_tz;
  target timestamp := date_trunc('day', local) + make_interval(hours => p_hour);
begin
  if target <= local then
    target := target + interval '1 day';
  end if;
  return target at time zone p_tz;
end;
$$;

-- The sending domain behind an address, when the workspace has verified it (or a parent of it).
create or replace function public.verified_domain_for(p_ws uuid, p_email text) returns sending_domains
language sql stable security definer set search_path = public as $$
  select d.* from sending_domains d
  where d.workspace_id = p_ws and d.status = 'verified'
    and (lower(split_part(p_email, '@', 2)) = d.domain or lower(split_part(p_email, '@', 2)) like '%.' || d.domain)
  order by length(d.domain) desc
  limit 1;
$$;

-- The guard (docs/marketing-platform.md M3 and 9.1). Null means send now. Otherwise {reason}, and for quiet hours
-- {reason: 'quiet', retry_at}. Called again for each message at the moment it's handed to SES, so a suppression or
-- unsubscribe that lands while it waits in line still stops it.
create or replace function public.email_guard(p_message uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m email_messages;
  e emails;
  s send_settings;
  c contacts;
  basis_row consents;
  sub_status text;
  topic_on boolean;
  tz text;
  h int;
  sent_recent int;
begin
  select * into m from email_messages where id = p_message;
  if not found then return jsonb_build_object('reason', 'missing'); end if;
  select * into e from emails where id = m.email_id;
  select * into s from send_settings where workspace_id = m.workspace_id;
  if s.workspace_id is null then return jsonb_build_object('reason', 'no_settings'); end if;
  if s.paused then return jsonb_build_object('reason', 'paused'); end if;
  if verified_domain_for(m.workspace_id, coalesce(e.from_email, s.from_email, '')) is null then
    return jsonb_build_object('reason', 'no_domain');
  end if;

  -- Every kind, tests included: suppressions and erasures.
  if exists (select 1 from suppressions where workspace_id = m.workspace_id and email_clean = lower(m.to_email)) then
    return jsonb_build_object('reason', 'suppressed');
  end if;
  if exists (select 1 from erasures where workspace_id = m.workspace_id and value_hash = sha256(convert_to(lower(m.to_email), 'UTF8'))) then
    return jsonb_build_object('reason', 'erased');
  end if;

  -- A test goes only to a member of the workspace, at their sign-in address.
  if e.kind = 'test' then
    if not exists (select 1 from workspace_members wm join auth.users u on u.id = wm.user_id
                   where wm.workspace_id = m.workspace_id and lower(u.email) = lower(m.to_email)) then
      return jsonb_build_object('reason', 'not_member');
    end if;
    return null;
  end if;

  if m.contact_id is null then return jsonb_build_object('reason', 'no_contact'); end if;
  select * into c from contacts where id = m.contact_id;
  if c.id is null or c.deleted_at is not null then return jsonb_build_object('reason', 'no_contact'); end if;
  if c.email_clean is distinct from lower(m.to_email) then return jsonb_build_object('reason', 'email_changed'); end if;

  if not e.marketing then return null; end if;
  if coalesce(trim(s.address), '') = '' then return jsonb_build_object('reason', 'no_address'); end if;

  -- Lawful basis (9.1): opt-in or soft opt-in anywhere; legitimate interest or no record only in the US.
  select * into basis_row from consents where contact_id = c.id and channel = 'email' order by at desc, id desc limit 1;
  if basis_row.id is not null and basis_row.status = 'withdrawn' then return jsonb_build_object('reason', 'withdrawn'); end if;
  if basis_row.id is not null and basis_row.basis = 'none' then return jsonb_build_object('reason', 'no_basis'); end if;
  if (basis_row.id is null or basis_row.basis = 'legitimate_interest') and coalesce(c.country, '') <> 'US' then
    return jsonb_build_object('reason', 'no_basis');
  end if;

  if e.topic_id is not null then
    select status into sub_status from subscriptions where contact_id = c.id and topic_id = e.topic_id;
    select default_on into topic_on from topics where id = e.topic_id;
    if sub_status = 'unsubscribed' or (sub_status is null and not coalesce(topic_on, false)) then
      return jsonb_build_object('reason', 'not_subscribed');
    end if;
  end if;

  select count(*) into sent_recent from email_messages x join emails xe on xe.id = x.email_id
  where x.contact_id = c.id and xe.marketing and xe.kind <> 'test' and x.id <> m.id
    and x.sent_at > p_now - make_interval(days => s.cap_days);
  if sent_recent >= s.cap_count then return jsonb_build_object('reason', 'cap'); end if;

  if s.quiet_start <> s.quiet_end then
    tz := coalesce(nullif(c.timezone, ''), s.timezone);
    if local_hour(p_now, tz) is null then tz := s.timezone; end if;
    if local_hour(p_now, tz) is null then tz := 'UTC'; end if;
    h := local_hour(p_now, tz);
    if (s.quiet_start < s.quiet_end and h >= s.quiet_start and h < s.quiet_end)
       or (s.quiet_start > s.quiet_end and (h >= s.quiet_start or h < s.quiet_end)) then
      return jsonb_build_object('reason', 'quiet', 'retry_at', next_local_hour(p_now, tz, s.quiet_end));
    end if;
  end if;
  return null;
end;
$$;

-- Owner screens -----------------------------------------------------------------------------------------------

create or replace function public.send_settings_save(p_ws uuid, p_values jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  tz text := coalesce(nullif(trim(p_values->>'timezone'), ''), 'UTC');
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can change sending'; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'Send an object'; end if;
  if local_hour(now(), tz) is null then raise exception 'Unknown time zone: %', tz; end if;
  perform send_settings_of(p_ws);
  update send_settings set
    from_name = nullif(trim(p_values->>'from_name'), ''),
    from_email = nullif(lower(trim(p_values->>'from_email')), ''),
    reply_to = nullif(lower(trim(p_values->>'reply_to')), ''),
    address = nullif(trim(p_values->>'address'), ''),
    cap_count = coalesce((p_values->>'cap_count')::int, cap_count),
    cap_days = coalesce((p_values->>'cap_days')::int, cap_days),
    quiet_start = coalesce((p_values->>'quiet_start')::int, quiet_start),
    quiet_end = coalesce((p_values->>'quiet_end')::int, quiet_end),
    timezone = tz,
    updated_at = now()
  where workspace_id = p_ws;
  insert into audit_log (workspace_id, actor, action, target, data) values (p_ws, auth.uid(), 'sending.settings', p_ws::text, p_values);
end;
$$;

create or replace function public.send_resume(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can resume sending'; end if;
  update send_settings set paused = false, paused_reason = null, paused_at = null, updated_at = now() where workspace_id = p_ws and paused;
  if found then
    insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'sending.resume', p_ws::text);
    perform enqueue_job(p_ws, 'send', p_ws::text, '{}', 0, 3);
  end if;
end;
$$;

create or replace function public.sending_domain_add(p_ws uuid, p_domain text) returns sending_domains
language plpgsql security definer set search_path = public as $$
declare
  d text := lower(trim(both '.' from trim(coalesce(p_domain, ''))));
  made sending_domains;
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can add a sending domain'; end if;
  if d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' or length(d) > 240 then raise exception 'Not a domain: %', p_domain; end if;
  if (select count(*) from sending_domains where workspace_id = p_ws) >= 20 then raise exception 'Up to 20 sending domains'; end if;
  if exists (select 1 from sending_domains where domain = d) then raise exception 'That domain is already added to a workspace'; end if;
  insert into sending_domains (workspace_id, domain, mail_from, tracking_host, created_by)
  values (p_ws, d, 'bounce.' || d, 't.' || d, auth.uid())
  returning * into made;
  perform send_settings_of(p_ws);
  perform enqueue_job(p_ws, 'domain_check', made.id::text, jsonb_build_object('domain_id', made.id), 0, 5);
  insert into audit_log (workspace_id, actor, action, target) values (p_ws, auth.uid(), 'sending.domain_add', d);
  return made;
end;
$$;

create or replace function public.sending_domain_check_now(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from sending_domains where id = p_id;
  if ws is null or not is_member(ws) then raise exception 'Domain not found'; end if;
  perform enqueue_job(ws, 'domain_check', p_id::text, jsonb_build_object('domain_id', p_id), 0, 5);
end;
$$;

-- Removing a domain leaves its SES identity for the worker to delete (domain_remove job).
create or replace function public.sending_domain_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  d sending_domains;
begin
  select * into d from sending_domains where id = p_id;
  if d.id is null or not is_owner(d.workspace_id) then raise exception 'Domain not found'; end if;
  delete from sending_domains where id = p_id;
  perform enqueue_job(d.workspace_id, 'domain_remove', d.domain, jsonb_build_object('domain', d.domain), 0, 5);
  insert into audit_log (workspace_id, actor, action, target) values (d.workspace_id, auth.uid(), 'sending.domain_remove', d.domain);
end;
$$;

create or replace function public.topic_save(p_ws uuid, p_id uuid, p_name text, p_default_on boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can change topics'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name the topic'; end if;
  if p_id is null then
    if (select count(*) from topics where workspace_id = p_ws) >= 50 then raise exception 'Up to 50 topics'; end if;
    insert into topics (workspace_id, name, default_on) values (p_ws, trim(p_name), coalesce(p_default_on, false)) returning id into tid;
  else
    update topics set name = trim(p_name), default_on = coalesce(p_default_on, default_on) where id = p_id and workspace_id = p_ws returning id into tid;
    if tid is null then raise exception 'Topic not found'; end if;
  end if;
  return tid;
end;
$$;

create or replace function public.topic_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from topics where id = p_id;
  if ws is null or not is_owner(ws) then raise exception 'Topic not found'; end if;
  delete from topics where id = p_id;
end;
$$;

-- Server: domains -----------------------------------------------------------------------------------------------

-- The worker's view of a domain to check.
create or replace function public.sending_domain_load(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(d) from sending_domains d where d.id = p_id;
$$;

create or replace function public.sending_domain_update(p_id uuid, p_dkim text[], p_records jsonb, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('pending', 'verified', 'failed') then raise exception 'Bad status'; end if;
  update sending_domains set
    dkim_tokens = coalesce(p_dkim, dkim_tokens),
    records = coalesce(p_records, records),
    status = p_status,
    error = left(p_error, 500),
    checked_at = now(),
    verified_at = case when p_status = 'verified' then coalesce(verified_at, now()) else null end
  where id = p_id;
end;
$$;

-- Pending domains every 10 minutes for 3 days, then hourly; verified ones once a day, since records can break.
create or replace function public.domain_checks_due() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, workspace_id from sending_domains
    where (status <> 'verified' and created_at > now() - interval '3 days' and coalesce(checked_at, created_at) < now() - interval '10 minutes')
       or (status <> 'verified' and created_at <= now() - interval '3 days' and coalesce(checked_at, created_at) < now() - interval '1 hour')
       or (status = 'verified' and coalesce(checked_at, created_at) < now() - interval '1 day')
    order by checked_at nulls first
    limit 200
  loop
    perform enqueue_job(r.workspace_id, 'domain_check', r.id::text, jsonb_build_object('domain_id', r.id), 0, 5);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Server: queue and send ------------------------------------------------------------------------------------------

-- Make an email (server). Links are listed by the caller, in the order they appear in html.
create or replace function public.email_create(p_ws uuid, p_user uuid, p_values jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  eid uuid;
begin
  insert into emails (workspace_id, name, kind, subject, preheader, html, text, links, from_name, from_email, topic_id, marketing, created_by)
  values (p_ws, coalesce(nullif(p_values->>'name', ''), p_values->>'subject'), p_values->>'kind', p_values->>'subject', p_values->>'preheader',
          p_values->>'html', p_values->>'text', coalesce(array(select jsonb_array_elements_text(p_values->'links')), '{}'),
          nullif(p_values->>'from_name', ''), nullif(lower(p_values->>'from_email'), ''), nullif(p_values->>'topic_id', '')::uuid,
          coalesce((p_values->>'marketing')::boolean, true), p_user)
  returning id into eid;
  if (select topic_id from emails where id = eid) is not null
     and not exists (select 1 from topics t join emails e on e.topic_id = t.id where e.id = eid and t.workspace_id = p_ws) then
    raise exception 'Topic not found';
  end if;
  return eid;
end;
$$;

-- Queue an email to contacts (server). Contacts with no email are left out; a repeat call adds nothing.
create or replace function public.email_queue(p_email uuid, p_contacts uuid[], p_send_after timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare
  e emails;
  n int;
begin
  select * into e from emails where id = p_email;
  if e.id is null then raise exception 'Email not found'; end if;
  if e.kind = 'test' then raise exception 'Use email_queue_test for tests'; end if;
  if cardinality(p_contacts) > 10000 then raise exception 'Queue up to 10,000 at a time'; end if;
  insert into email_messages (workspace_id, email_id, contact_id, to_email, dedupe, send_after)
  select e.workspace_id, e.id, c.id, c.email_clean, e.id::text || ':' || c.id::text, coalesce(p_send_after, now())
  from contacts c
  where c.id = any(p_contacts) and c.workspace_id = e.workspace_id and c.deleted_at is null and c.email_clean is not null
  on conflict (workspace_id, dedupe) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update emails set status = 'sending', updated_at = now() where id = e.id and status in ('draft', 'scheduled');
    perform enqueue_job(e.workspace_id, 'send', e.workspace_id::text, '{}', greatest(0, extract(epoch from coalesce(p_send_after, now()) - now())::int), 3);
  end if;
  return n;
end;
$$;

-- A test to the member who asked, at their sign-in address (server; the route checks who's asking).
create or replace function public.email_queue_test(p_email uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e emails;
  addr text;
  mid uuid;
begin
  select * into e from emails where id = p_email and kind = 'test';
  if e.id is null then raise exception 'Email not found'; end if;
  select lower(u.email) into addr from auth.users u join workspace_members wm on wm.user_id = u.id
  where u.id = p_user and wm.workspace_id = e.workspace_id;
  if addr is null then raise exception 'Only members get tests'; end if;
  insert into email_messages (workspace_id, email_id, to_email, dedupe)
  values (e.workspace_id, e.id, addr, e.id::text || ':' || addr)
  on conflict (workspace_id, dedupe) do nothing
  returning id into mid;
  perform enqueue_job(e.workspace_id, 'send', e.workspace_id::text, '{}', 0, 3);
  return mid;
end;
$$;

-- Hand the worker up to p_limit messages that pass the guard right now, each marked 'sending'. Messages in quiet
-- hours move to the next allowed time; ones that fail the guard are skipped with the reason. A paused workspace and
-- one past its daily limit get none. A message left 'sending' for 10 minutes turns 'unknown' and is never resent.
create or replace function public.send_claim(p_ws uuid, p_limit int default 14) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s send_settings;
  room int;
  m record;
  g jsonb;
  out jsonb := '[]';
  d sending_domains;
begin
  update email_messages set status = 'unknown', error = 'The worker stopped mid-send; not sent again in case it went out'
  where workspace_id = p_ws and status = 'sending' and claimed_at < now() - interval '10 minutes';

  select * into s from send_settings where workspace_id = p_ws;
  if s.workspace_id is null or s.paused then return out; end if;
  room := s.per_day - (select count(*) from email_messages where workspace_id = p_ws and sent_at > now() - interval '1 day');
  if room <= 0 then return out; end if;

  for m in
    select x.id, x.to_email, x.contact_id, x.email_id from email_messages x
    where x.workspace_id = p_ws and x.status = 'queued' and x.send_after <= now()
    order by x.send_after, x.id
    limit least(greatest(coalesce(p_limit, 14), 1), room, 200)
    for update skip locked
  loop
    g := email_guard(m.id);
    if g is null then
      update email_messages set status = 'sending', claimed_at = now(), attempts = attempts + 1 where id = m.id;
      select * into d from verified_domain_for(p_ws, coalesce((select from_email from emails where id = m.email_id), s.from_email));
      out := out || jsonb_build_array((
        select jsonb_build_object(
          'id', m.id, 'to', m.to_email, 'contact_id', m.contact_id, 'email_id', e.id, 'kind', e.kind, 'marketing', e.marketing,
          'subject', e.subject, 'preheader', e.preheader, 'html', e.html, 'text', e.text, 'links', to_jsonb(e.links),
          'from_name', coalesce(e.from_name, s.from_name), 'from_email', coalesce(e.from_email, s.from_email),
          'reply_to', s.reply_to, 'address', s.address, 'topic', (select name from topics where id = e.topic_id),
          'mail_from', d.mail_from, 'per_second', s.per_second)
        from emails e where e.id = m.email_id));
    elsif g->>'reason' = 'quiet' then
      update email_messages set send_after = (g->>'retry_at')::timestamptz where id = m.id;
    else
      update email_messages set status = 'skipped', skip_reason = g->>'reason' where id = m.id;
    end if;
  end loop;
  return out;
end;
$$;

-- The worker's answer for one message. ok: SES took it. retry: SES said no for now (throttled, 5xx), so it goes back
-- in line, up to 3 tries. Neither: failed for good. An unclear answer (timeout) is 'unknown': never resent.
create or replace function public.send_done(p_id uuid, p_outcome text, p_ses_id text default null, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  m email_messages;
begin
  select * into m from email_messages where id = p_id for update;
  if m.id is null or m.status <> 'sending' then return; end if;
  if p_outcome = 'ok' then
    update email_messages set status = 'sent', sent_at = now(), ses_message_id = p_ses_id, error = null where id = p_id;
    if m.contact_id is not null then
      insert into contact_events (workspace_id, contact_id, kind, data, source)
      values (m.workspace_id, m.contact_id, 'email.sent', jsonb_build_object('email_id', m.email_id, 'message_id', m.id), 'email');
    end if;
  elsif p_outcome = 'retry' and m.attempts < 3 then
    update email_messages set status = 'queued', claimed_at = null, error = left(p_error, 500), send_after = now() + make_interval(secs => 60 * m.attempts) where id = p_id;
  elsif p_outcome = 'unknown' then
    update email_messages set status = 'unknown', error = left(coalesce(p_error, 'No clear answer from SES'), 500) where id = p_id;
  else
    update email_messages set status = 'failed', error = left(coalesce(p_error, 'Failed'), 500) where id = p_id;
  end if;
end;
$$;

-- Workspaces with messages ready get a send job (one at a time per workspace).
create or replace function public.sends_due() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select distinct x.workspace_id from email_messages x
    join send_settings s on s.workspace_id = x.workspace_id and not s.paused
    where x.status = 'queued' and x.send_after <= now()
    limit 500
  loop
    perform enqueue_job(r.workspace_id, 'send', r.workspace_id::text, '{}', 0, 3);
    n := n + 1;
  end loop;
  -- Stuck sends in paused or idle workspaces still turn 'unknown'.
  update email_messages set status = 'unknown', error = 'The worker stopped mid-send; not sent again in case it went out'
  where status = 'sending' and claimed_at < now() - interval '10 minutes';
  return n;
end;
$$;

-- Server: SES events, clicks, unsubscribes ------------------------------------------------------------------------

-- Pause a workspace when complaints pass 0.2% of 7 days' sends (with 500 or more sent), or 10 land in a day.
create or replace function public.complaints_check(p_ws uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  sent int;
  bad int;
  day_bad int;
begin
  select count(*) into sent from email_messages where workspace_id = p_ws and sent_at > now() - interval '7 days';
  select count(*) into bad from email_events where workspace_id = p_ws and kind = 'complained' and at > now() - interval '7 days';
  select count(*) into day_bad from email_events where workspace_id = p_ws and kind = 'complained' and at > now() - interval '1 day';
  if (sent >= 500 and bad * 1000 >= sent * 2) or day_bad >= 10 then
    update send_settings set paused = true, paused_at = now(),
      paused_reason = format('Spam complaints reached %s of %s sent in 7 days', bad, sent)
    where workspace_id = p_ws and not paused;
    if found then
      insert into audit_log (workspace_id, action, target, data) values (p_ws, 'sending.paused', p_ws::text, jsonb_build_object('complaints', bad, 'sent', sent));
    end if;
    return true;
  end if;
  return false;
end;
$$;

-- One SES event, already checked (SNS signature) and parsed by the route:
-- {sns_id, ses_message_id, kind: delivered | bounced | complained | rejected | delayed, bounce: hard | soft, at, detail}
create or replace function public.ses_event_apply(p_event jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  m email_messages;
  e emails;
  k text := p_event->>'kind';
  at_ timestamptz := coalesce((p_event->>'at')::timestamptz, now());
  soft int;
begin
  if k not in ('delivered', 'bounced', 'complained', 'rejected', 'delayed') then return 'ignored'; end if;
  select * into m from email_messages where ses_message_id = p_event->>'ses_message_id' for update;
  if m.id is null then return 'unknown_message'; end if;
  begin
    insert into email_events (workspace_id, message_id, kind, data, sns_id, at)
    values (m.workspace_id, m.id, k, coalesce(p_event->'detail', '{}') || jsonb_strip_nulls(jsonb_build_object('bounce', p_event->>'bounce')), p_event->>'sns_id', at_);
  exception when unique_violation then
    return 'duplicate';
  end;
  select * into e from emails where id = m.email_id;

  if k = 'delivered' then
    update email_messages set status = case when status = 'sent' then 'delivered' else status end, delivered_at = coalesce(delivered_at, at_) where id = m.id;
  elsif k = 'rejected' then
    update email_messages set status = 'rejected' where id = m.id;
  elsif k = 'bounced' then
    update email_messages set status = 'bounced', bounced = coalesce(p_event->>'bounce', 'hard') where id = m.id;
    if coalesce(p_event->>'bounce', 'hard') = 'hard' then
      perform suppress(m.workspace_id, 'ses', jsonb_build_array(jsonb_build_object('email_clean', lower(m.to_email), 'reason', 'bounced')));
    else
      select count(*) into soft from email_events v join email_messages vm on vm.id = v.message_id
      where v.workspace_id = m.workspace_id and v.kind = 'bounced' and v.data->>'bounce' = 'soft'
        and lower(vm.to_email) = lower(m.to_email) and v.at > now() - interval '30 days';
      if soft >= 3 then
        perform suppress(m.workspace_id, 'ses', jsonb_build_array(jsonb_build_object('email_clean', lower(m.to_email), 'reason', 'bounced')));
      end if;
    end if;
  elsif k = 'complained' then
    update email_messages set status = 'complained', complained_at = coalesce(complained_at, at_) where id = m.id;
    perform suppress(m.workspace_id, 'ses', jsonb_build_array(jsonb_build_object('email_clean', lower(m.to_email), 'reason', 'complained')));
    if m.contact_id is not null then
      insert into consents (workspace_id, contact_id, channel, basis, status, source)
      select m.workspace_id, m.contact_id, 'email', coalesce(c.basis, 'opt_in'), 'withdrawn', 'complaint'
      from (select (select basis from consents where contact_id = m.contact_id and channel = 'email' and basis <> 'none' order by at desc limit 1) as basis) c;
    end if;
    perform complaints_check(m.workspace_id);
  end if;

  if m.contact_id is not null and k in ('delivered', 'bounced', 'complained') then
    insert into contact_events (workspace_id, contact_id, kind, data, source, at)
    values (m.workspace_id, m.contact_id, 'email.' || k, jsonb_build_object('email_id', m.email_id, 'message_id', m.id), 'email', at_);
  end if;
  return 'ok';
end;
$$;

-- A click on link p_link of a message (server; the route checked the token and the user agent). Returns the link
-- to go to. Scanner clicks are logged but don't count: a click in the first 10 seconds after sending, or the third
-- click on one message within 5 seconds, is a mail filter opening every link.
create or replace function public.email_click(p_message uuid, p_link int, p_human boolean, p_data jsonb default '{}') returns text
language plpgsql security definer set search_path = public as $$
declare
  m email_messages;
  url text;
  human boolean := p_human;
begin
  select * into m from email_messages where id = p_message;
  if m.id is null then return null; end if;
  select links[p_link + 1] into url from emails where id = m.email_id;
  if url is null then return null; end if;
  if m.sent_at is null or m.sent_at > now() - interval '10 seconds'
     or (select count(*) from email_events where message_id = m.id and kind = 'clicked' and at > now() - interval '5 seconds') >= 2 then
    human := false;
  end if;
  insert into email_events (workspace_id, message_id, kind, data)
  values (m.workspace_id, m.id, 'clicked', coalesce(p_data, '{}') || jsonb_build_object('link', p_link, 'human', human));
  if human and m.first_click_at is null then
    update email_messages set first_click_at = now() where id = m.id;
    if m.contact_id is not null then
      insert into contact_events (workspace_id, contact_id, kind, data, source)
      values (m.workspace_id, m.contact_id, 'email.clicked', jsonb_build_object('email_id', m.email_id, 'message_id', m.id, 'url', url), 'email');
    end if;
  end if;
  return url;
end;
$$;

-- Unsubscribe from a message's link (server; the route checked the token). p_scope 'topic' leaves other topics on;
-- 'all' (and any email with no topic) suppresses the address. A test email logs it and changes nothing.
create or replace function public.email_unsubscribe(p_message uuid, p_scope text default 'all') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m email_messages;
  e emails;
  scope text := case when p_scope = 'topic' then 'topic' else 'all' end;
begin
  select * into m from email_messages where id = p_message;
  if m.id is null then return null; end if;
  select * into e from emails where id = m.email_id;
  if e.topic_id is null then scope := 'all'; end if;
  insert into email_events (workspace_id, message_id, kind, data) values (m.workspace_id, m.id, 'unsubscribed', jsonb_build_object('scope', scope, 'test', e.kind = 'test'));
  update email_messages set unsubscribed_at = coalesce(unsubscribed_at, now()) where id = m.id;
  if e.kind = 'test' then
    return jsonb_build_object('scope', scope, 'topic', (select name from topics where id = e.topic_id), 'test', true);
  end if;
  if scope = 'topic' and m.contact_id is not null then
    insert into subscriptions (workspace_id, contact_id, topic_id, status) values (m.workspace_id, m.contact_id, e.topic_id, 'unsubscribed')
    on conflict (contact_id, topic_id) do update set status = 'unsubscribed', at = now();
  else
    perform suppress(m.workspace_id, 'unsubscribe', jsonb_build_array(jsonb_build_object('email_clean', lower(m.to_email), 'reason', 'unsubscribed')));
    if m.contact_id is not null then
      insert into consents (workspace_id, contact_id, channel, basis, status, source)
      select m.workspace_id, m.contact_id, 'email', coalesce(c.basis, 'opt_in'), 'withdrawn', 'unsubscribe'
      from (select (select basis from consents where contact_id = m.contact_id and channel = 'email' and basis <> 'none' order by at desc limit 1) as basis) c;
    end if;
  end if;
  if m.contact_id is not null then
    insert into contact_events (workspace_id, contact_id, kind, data, source)
    values (m.workspace_id, m.contact_id, 'email.unsubscribed', jsonb_build_object('email_id', m.email_id, 'message_id', m.id, 'scope', scope), 'email');
  end if;
  return jsonb_build_object('scope', scope, 'topic', (select name from topics where id = e.topic_id), 'test', false);
end;
$$;

-- What the unsubscribe page shows before the click.
create or replace function public.email_unsubscribe_info(p_message uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('topic', t.name, 'from', coalesce(e.from_name, s.from_name), 'done', m.unsubscribed_at is not null)
  from email_messages m join emails e on e.id = m.email_id
  left join topics t on t.id = e.topic_id
  left join send_settings s on s.workspace_id = m.workspace_id
  where m.id = p_message;
$$;

-- Every minute ------------------------------------------------------------------------------------------------

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
  perform sends_due();
  if extract(minute from now())::int % 5 = 0 then
    perform segments_due();
    perform domain_checks_due();
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

-- Grants ------------------------------------------------------------------------------------------------------

revoke execute on function public.send_settings_of(uuid) from public, anon, authenticated;
revoke execute on function public.local_hour(timestamptz, text) from public, anon;
revoke execute on function public.next_local_hour(timestamptz, text, int) from public, anon;
revoke execute on function public.verified_domain_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.email_guard(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.sending_domain_load(uuid) from public, anon, authenticated;
revoke execute on function public.sending_domain_update(uuid, text[], jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.domain_checks_due() from public, anon, authenticated;
revoke execute on function public.email_create(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.email_queue(uuid, uuid[], timestamptz) from public, anon, authenticated;
revoke execute on function public.email_queue_test(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.send_claim(uuid, int) from public, anon, authenticated;
revoke execute on function public.send_done(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.sends_due() from public, anon, authenticated;
revoke execute on function public.complaints_check(uuid) from public, anon, authenticated;
revoke execute on function public.ses_event_apply(jsonb) from public, anon, authenticated;
revoke execute on function public.email_click(uuid, int, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.email_unsubscribe(uuid, text) from public, anon, authenticated;
revoke execute on function public.email_unsubscribe_info(uuid) from public, anon, authenticated;
grant execute on function public.send_settings_of(uuid) to service_role;
grant execute on function public.verified_domain_for(uuid, text) to service_role;
grant execute on function public.email_guard(uuid, timestamptz) to service_role;
grant execute on function public.sending_domain_load(uuid) to service_role;
grant execute on function public.sending_domain_update(uuid, text[], jsonb, text, text) to service_role;
grant execute on function public.domain_checks_due() to service_role;
grant execute on function public.email_create(uuid, uuid, jsonb) to service_role;
grant execute on function public.email_queue(uuid, uuid[], timestamptz) to service_role;
grant execute on function public.email_queue_test(uuid, uuid) to service_role;
grant execute on function public.send_claim(uuid, int) to service_role;
grant execute on function public.send_done(uuid, text, text, text) to service_role;
grant execute on function public.sends_due() to service_role;
grant execute on function public.complaints_check(uuid) to service_role;
grant execute on function public.ses_event_apply(jsonb) to service_role;
grant execute on function public.email_click(uuid, int, boolean, jsonb) to service_role;
grant execute on function public.email_unsubscribe(uuid, text) to service_role;
grant execute on function public.email_unsubscribe_info(uuid) to service_role;

revoke execute on function public.send_settings_save(uuid, jsonb) from public, anon;
revoke execute on function public.send_resume(uuid) from public, anon;
revoke execute on function public.sending_domain_add(uuid, text) from public, anon;
revoke execute on function public.sending_domain_check_now(uuid) from public, anon;
revoke execute on function public.sending_domain_remove(uuid) from public, anon;
revoke execute on function public.topic_save(uuid, uuid, text, boolean) from public, anon;
revoke execute on function public.topic_delete(uuid) from public, anon;
grant execute on function public.send_settings_save(uuid, jsonb) to authenticated;
grant execute on function public.send_resume(uuid) to authenticated;
grant execute on function public.sending_domain_add(uuid, text) to authenticated;
grant execute on function public.sending_domain_check_now(uuid) to authenticated;
grant execute on function public.sending_domain_remove(uuid) to authenticated;
grant execute on function public.topic_save(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.topic_delete(uuid) to authenticated;
