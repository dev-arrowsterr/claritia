-- Nurture emails (docs/marketing-platform.md M4, first step): a sequence of emails with waits between them, written
-- by AI or by hand, each approved by a person before it can go out. Contacts join from a segment or a form, leave
-- when they reach a stage, unsubscribe or are suppressed, and every email passes the send guard (039_email.sql).
--   ai_cache: AI answers by their inputs, so the same request never calls the model twice.
--   nurtures, nurture_steps: a step points at its own email. Editing a step makes a new email and clears its
--     approval, so mail already in line keeps the approved words.
--   nurture_enrollments: one per contact and nurture, with the next step and when it's due.

-- AI cache ----------------------------------------------------------------------------------------------------

create table if not exists public.ai_cache (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  key text not null check (key ~ '^[0-9a-f]{64}$'),
  output jsonb not null,
  model text not null check (length(model) <= 80),
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now(),
  primary key (workspace_id, kind, key)
);
alter table public.ai_cache enable row level security;
revoke all on public.ai_cache from anon, authenticated;

-- Nurtures ----------------------------------------------------------------------------------------------------

create table if not exists public.nurtures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'live', 'paused')),
  -- {kind: 'segment', segment_id} or {kind: 'form', form_id}
  trigger jsonb not null default '{}' check (jsonb_typeof(trigger) = 'object'),
  topic_id uuid references public.topics (id) on delete set null,
  -- Who it's for, what it offers and what's true about the product: the AI writes only from this.
  brief text not null default '' check (length(brief) <= 8000),
  exit_stages text[] not null default '{sql,opportunity,customer}',
  live_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists nurtures_ws on public.nurtures (workspace_id, created_at desc);
alter table public.nurtures enable row level security;
create policy "members read" on public.nurtures for select using (is_member(workspace_id));
revoke all on public.nurtures from anon;
revoke insert, update, delete on public.nurtures from authenticated;

create table if not exists public.nurture_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  nurture_id uuid not null references public.nurtures (id) on delete cascade,
  position int not null check (position between 0 and 49),
  wait_days int not null default 2 check (wait_days between 0 and 90),
  email_id uuid not null references public.emails (id),
  ai boolean not null default false,
  -- What the AI says a person should check before approving (claims it couldn't tie to the brief).
  review_notes text[] not null default '{}',
  approved_at timestamptz,
  approved_by uuid,
  updated_at timestamptz not null default now(),
  unique (nurture_id, position) deferrable initially deferred
);
alter table public.nurture_steps enable row level security;
create policy "members read" on public.nurture_steps for select using (is_member(workspace_id));
revoke all on public.nurture_steps from anon;
revoke insert, update, delete on public.nurture_steps from authenticated;

create table if not exists public.nurture_enrollments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  nurture_id uuid not null references public.nurtures (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'done', 'exited')),
  -- The position of the next step to send.
  step int not null default 0,
  next_at timestamptz not null default now(),
  exit_reason text check (exit_reason in ('reached_stage', 'unsubscribed', 'suppressed', 'deleted', 'removed')),
  entered_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (nurture_id, contact_id)
);
create index if not exists nurture_enrollments_due on public.nurture_enrollments (next_at) where status = 'active';
alter table public.nurture_enrollments enable row level security;
create policy "members read" on public.nurture_enrollments for select using (is_member(workspace_id));
revoke all on public.nurture_enrollments from anon;
revoke insert, update, delete on public.nurture_enrollments from authenticated;

-- Members: build, approve, go live ---------------------------------------------------------------------------

create or replace function public.nurture_save(p_ws uuid, p_id uuid, p_name text, p_trigger jsonb, p_topic uuid, p_brief text, p_exit text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  nid uuid;
  k text := p_trigger->>'kind';
begin
  if not is_member(p_ws) then raise exception 'Nurture not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name the nurture'; end if;
  if k = 'segment' then
    if not exists (select 1 from segments where id = nullif(p_trigger->>'segment_id', '')::uuid and workspace_id = p_ws) then raise exception 'Pick a segment'; end if;
  elsif k = 'form' then
    if not exists (select 1 from forms where id = nullif(p_trigger->>'form_id', '')::uuid and workspace_id = p_ws) then raise exception 'Pick a form'; end if;
  else
    raise exception 'Pick who joins';
  end if;
  if p_topic is not null and not exists (select 1 from topics where id = p_topic and workspace_id = p_ws) then raise exception 'Topic not found'; end if;
  if exists (select 1 from unnest(coalesce(p_exit, '{}')) s where s not in ('subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'other')) then
    raise exception 'Unknown stage';
  end if;
  if p_id is null then
    if (select count(*) from nurtures where workspace_id = p_ws) >= 100 then raise exception 'Up to 100 nurtures'; end if;
    insert into nurtures (workspace_id, name, trigger, topic_id, brief, exit_stages, created_by)
    values (p_ws, trim(p_name), jsonb_build_object('kind', k, k || '_id', p_trigger->>(k || '_id')), p_topic, coalesce(p_brief, ''), coalesce(p_exit, '{}'), auth.uid())
    returning id into nid;
  else
    update nurtures set name = trim(p_name), trigger = jsonb_build_object('kind', k, k || '_id', p_trigger->>(k || '_id')), topic_id = p_topic,
      brief = coalesce(p_brief, ''), exit_stages = coalesce(p_exit, '{}'), updated_at = now()
    where id = p_id and workspace_id = p_ws returning id into nid;
    if nid is null then raise exception 'Nurture not found'; end if;
    -- The topic rides on each step's email.
    update emails e set topic_id = p_topic from nurture_steps s where s.nurture_id = nid and s.email_id = e.id;
  end if;
  return nid;
end;
$$;

-- Add a step (p_step null) or change one. Every save makes a new email and clears the approval.
create or replace function public.nurture_step_save(p_nurture uuid, p_step uuid, p_wait_days int, p_subject text, p_preheader text, p_html text, p_text text,
  p_links text[], p_ai boolean default false, p_notes text[] default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  n nurtures;
  pos int;
  eid uuid;
  sid uuid;
begin
  select * into n from nurtures where id = p_nurture;
  if n.id is null or not is_member(n.workspace_id) then raise exception 'Nurture not found'; end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'Add a subject'; end if;
  if p_step is null then
    if n.status = 'live' then raise exception 'Pause the nurture to add steps'; end if;
    select coalesce(max(position) + 1, 0) into pos from nurture_steps where nurture_id = n.id;
    if pos > 49 then raise exception 'Up to 50 steps'; end if;
  else
    select position into pos from nurture_steps where id = p_step and nurture_id = n.id;
    if pos is null then raise exception 'Step not found'; end if;
  end if;
  insert into emails (workspace_id, name, kind, subject, preheader, html, text, links, topic_id, marketing, status, created_by)
  values (n.workspace_id, left(n.name || ' · ' || (pos + 1), 200), 'journey', left(trim(p_subject), 300), nullif(left(trim(coalesce(p_preheader, '')), 300), ''),
          coalesce(p_html, ''), coalesce(p_text, ''), coalesce(p_links, '{}'), n.topic_id, true, 'sending', auth.uid())
  returning id into eid;
  if p_step is null then
    insert into nurture_steps (workspace_id, nurture_id, position, wait_days, email_id, ai, review_notes)
    values (n.workspace_id, n.id, pos, coalesce(p_wait_days, 2), eid, coalesce(p_ai, false), coalesce(p_notes, '{}'))
    returning id into sid;
  else
    update nurture_steps set wait_days = coalesce(p_wait_days, wait_days), email_id = eid, ai = coalesce(p_ai, false), review_notes = coalesce(p_notes, '{}'),
      approved_at = null, approved_by = null, updated_at = now()
    where id = p_step returning id into sid;
  end if;
  update nurtures set updated_at = now() where id = n.id;
  return sid;
end;
$$;

create or replace function public.nurture_step_approve(p_step uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s nurture_steps;
begin
  select * into s from nurture_steps where id = p_step;
  if s.id is null or not is_member(s.workspace_id) then raise exception 'Step not found'; end if;
  update nurture_steps set approved_at = now(), approved_by = auth.uid() where id = p_step;
  insert into audit_log (workspace_id, actor, action, target) values (s.workspace_id, auth.uid(), 'nurture.approve', p_step::text);
end;
$$;

-- Remove a step, or move it by one place. Not while live: enrollments count on the order.
create or replace function public.nurture_step_change(p_step uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s nurture_steps;
  n nurtures;
  other uuid;
begin
  select * into s from nurture_steps where id = p_step;
  if s.id is null or not is_member(s.workspace_id) then raise exception 'Step not found'; end if;
  select * into n from nurtures where id = s.nurture_id;
  if n.status = 'live' then raise exception 'Pause the nurture to change its steps'; end if;
  if p_action = 'delete' then
    delete from nurture_steps where id = s.id;
    update nurture_steps set position = position - 1 where nurture_id = n.id and position > s.position;
  elsif p_action in ('up', 'down') then
    select id into other from nurture_steps where nurture_id = n.id and position = s.position + case when p_action = 'up' then -1 else 1 end;
    if other is null then return; end if;
    update nurture_steps set position = s.position where id = other;
    update nurture_steps set position = s.position + case when p_action = 'up' then -1 else 1 end where id = s.id;
  else
    raise exception 'Unknown change';
  end if;
end;
$$;

-- Live needs every step approved and a sender on a verified domain. Paused holds everyone where they are.
create or replace function public.nurture_set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare
  n nurtures;
  s send_settings;
begin
  select * into n from nurtures where id = p_id;
  if n.id is null or not is_member(n.workspace_id) then raise exception 'Nurture not found'; end if;
  if p_status not in ('draft', 'live', 'paused') then raise exception 'Unknown status'; end if;
  if p_status = 'live' then
    if not exists (select 1 from nurture_steps where nurture_id = n.id) then raise exception 'Add a step first'; end if;
    if exists (select 1 from nurture_steps where nurture_id = n.id and approved_at is null) then raise exception 'Approve every step first'; end if;
    select * into s from send_settings where workspace_id = n.workspace_id;
    if s.workspace_id is null or s.from_email is null or verified_domain_for(n.workspace_id, s.from_email) is null then
      raise exception 'Set up sending first (Settings › Sending)';
    end if;
    if coalesce(trim(s.address), '') = '' then raise exception 'Add your physical address first (Settings › Sending)'; end if;
  end if;
  update nurtures set status = p_status, live_at = case when p_status = 'live' then coalesce(live_at, now()) else live_at end, updated_at = now() where id = n.id;
  insert into audit_log (workspace_id, actor, action, target, data) values (n.workspace_id, auth.uid(), 'nurture.status', n.id::text, jsonb_build_object('status', p_status));
  -- Whoever already qualifies joins now; the minute tick picks up the rest.
  if p_status = 'live' then perform nurture_enroll(n.id); end if;
end;
$$;

create or replace function public.nurture_remove_contact(p_enrollment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from nurture_enrollments where id = p_enrollment;
  if ws is null or not is_member(ws) then raise exception 'Not found'; end if;
  update nurture_enrollments set status = 'exited', exit_reason = 'removed', finished_at = now() where id = p_enrollment and status = 'active';
end;
$$;

create or replace function public.nurture_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from nurtures where id = p_id;
  if ws is null or not is_member(ws) then raise exception 'Nurture not found'; end if;
  delete from nurtures where id = p_id;
end;
$$;

-- Server: who joins, and the next step -----------------------------------------------------------------------

-- New members of a live nurture's segment, or people who sent its form since it went live. Returns how many joined.
create or replace function public.nurture_enroll(p_nurture uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  n nurtures;
  first_wait int;
  added int := 0;
  k int;
begin
  for n in select * from nurtures where status = 'live' and (p_nurture is null or id = p_nurture) loop
    select wait_days into first_wait from nurture_steps where nurture_id = n.id order by position limit 1;
    if first_wait is null then continue; end if;
    if n.trigger->>'kind' = 'segment' then
      insert into nurture_enrollments (workspace_id, nurture_id, contact_id, next_at)
      select n.workspace_id, n.id, m.contact_id, now() + make_interval(days => first_wait)
      from segment_members m join contacts c on c.id = m.contact_id and c.deleted_at is null
      where m.segment_id = nullif(n.trigger->>'segment_id', '')::uuid and m.left_at is null
      limit 5000
      on conflict (nurture_id, contact_id) do nothing;
    elsif n.trigger->>'kind' = 'form' then
      insert into nurture_enrollments (workspace_id, nurture_id, contact_id, next_at)
      select distinct n.workspace_id, n.id, e.contact_id, now() + make_interval(days => first_wait)
      from contact_events e join contacts c on c.id = e.contact_id and c.deleted_at is null
      where e.workspace_id = n.workspace_id and e.kind = 'form.submitted' and e.data->>'form_id' = n.trigger->>'form_id' and e.at >= n.live_at
      limit 5000
      on conflict (nurture_id, contact_id) do nothing;
    end if;
    get diagnostics k = row_count;
    added := added + k;
  end loop;
  return added;
end;
$$;

-- Send each due step: check the contact can stay, queue the step's email (the guard runs again at send time), and
-- move on. A step not approved (edited while live) holds for an hour. Returns how many emails were queued.
create or replace function public.nurture_advance(p_limit int default 500) returns int
language plpgsql security definer set search_path = public as $$
declare
  e record;
  st nurture_steps;
  nxt nurture_steps;
  queued int := 0;
  wss uuid[] := '{}';
  w uuid;
begin
  for e in
    select x.*, n.status as n_status, n.exit_stages, n.topic_id, c.deleted_at as c_deleted, c.lifecycle, c.email_clean
    from nurture_enrollments x
    join nurtures n on n.id = x.nurture_id
    left join contacts c on c.id = x.contact_id
    where x.status = 'active' and x.next_at <= now() and n.status = 'live'
    order by x.next_at
    limit greatest(least(coalesce(p_limit, 500), 5000), 1)
    for update of x skip locked
  loop
    if e.c_deleted is not null or e.email_clean is null then
      update nurture_enrollments set status = 'exited', exit_reason = 'deleted', finished_at = now() where id = e.id;
      continue;
    end if;
    if e.lifecycle = any(e.exit_stages) then
      update nurture_enrollments set status = 'exited', exit_reason = 'reached_stage', finished_at = now() where id = e.id;
      continue;
    end if;
    if exists (select 1 from suppressions where workspace_id = e.workspace_id and email_clean = e.email_clean) then
      update nurture_enrollments set status = 'exited', exit_reason = 'suppressed', finished_at = now() where id = e.id;
      continue;
    end if;
    if e.topic_id is not null and exists (select 1 from subscriptions where contact_id = e.contact_id and topic_id = e.topic_id and status = 'unsubscribed') then
      update nurture_enrollments set status = 'exited', exit_reason = 'unsubscribed', finished_at = now() where id = e.id;
      continue;
    end if;
    select * into st from nurture_steps where nurture_id = e.nurture_id and position = e.step;
    if st.id is null then
      update nurture_enrollments set status = 'done', finished_at = now() where id = e.id;
      continue;
    end if;
    if st.approved_at is null then
      update nurture_enrollments set next_at = now() + interval '1 hour' where id = e.id;
      continue;
    end if;
    insert into email_messages (workspace_id, email_id, contact_id, to_email, dedupe)
    values (e.workspace_id, st.email_id, e.contact_id, e.email_clean, 'nurture:' || e.id::text || ':' || e.step::text)
    on conflict (workspace_id, dedupe) do nothing;
    queued := queued + 1;
    if not e.workspace_id = any(wss) then wss := wss || e.workspace_id; end if;
    select * into nxt from nurture_steps where nurture_id = e.nurture_id and position = e.step + 1;
    if nxt.id is null then
      update nurture_enrollments set step = e.step + 1, status = 'done', finished_at = now() where id = e.id;
    else
      update nurture_enrollments set step = e.step + 1, next_at = now() + make_interval(days => nxt.wait_days) where id = e.id;
    end if;
  end loop;
  foreach w in array wss loop
    perform enqueue_job(w, 'send', w::text, '{}', 0, 3);
  end loop;
  return queued;
end;
$$;

-- Server: AI cache ---------------------------------------------------------------------------------------------

create or replace function public.ai_cache_get(p_ws uuid, p_kind text, p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select output from ai_cache where workspace_id = p_ws and kind = p_kind and key = p_key;
$$;

create or replace function public.ai_cache_put(p_ws uuid, p_kind text, p_key text, p_output jsonb, p_model text, p_in int, p_out int) returns void
language sql security definer set search_path = public as $$
  insert into ai_cache (workspace_id, kind, key, output, model, input_tokens, output_tokens)
  values (p_ws, p_kind, p_key, p_output, p_model, coalesce(p_in, 0), coalesce(p_out, 0))
  on conflict (workspace_id, kind, key) do nothing;
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
  perform nurture_advance(500);
  perform sends_due();
  if extract(minute from now())::int % 5 = 0 then
    perform segments_due();
    perform domain_checks_due();
    perform nurture_enroll(null);
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

revoke execute on function public.nurture_enroll(uuid) from public, anon, authenticated;
revoke execute on function public.nurture_advance(int) from public, anon, authenticated;
revoke execute on function public.ai_cache_get(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ai_cache_put(uuid, text, text, jsonb, text, int, int) from public, anon, authenticated;
grant execute on function public.nurture_enroll(uuid) to service_role;
grant execute on function public.nurture_advance(int) to service_role;
grant execute on function public.ai_cache_get(uuid, text, text) to service_role;
grant execute on function public.ai_cache_put(uuid, text, text, jsonb, text, int, int) to service_role;
revoke execute on function public.nurture_save(uuid, uuid, text, jsonb, uuid, text, text[]) from public, anon;
revoke execute on function public.nurture_step_save(uuid, uuid, int, text, text, text, text, text[], boolean, text[]) from public, anon;
revoke execute on function public.nurture_step_approve(uuid) from public, anon;
revoke execute on function public.nurture_step_change(uuid, text) from public, anon;
revoke execute on function public.nurture_set_status(uuid, text) from public, anon;
revoke execute on function public.nurture_remove_contact(uuid) from public, anon;
revoke execute on function public.nurture_delete(uuid) from public, anon;
grant execute on function public.nurture_save(uuid, uuid, text, jsonb, uuid, text, text[]) to authenticated;
grant execute on function public.nurture_step_save(uuid, uuid, int, text, text, text, text, text[], boolean, text[]) to authenticated;
grant execute on function public.nurture_step_approve(uuid) to authenticated;
grant execute on function public.nurture_step_change(uuid, text) to authenticated;
grant execute on function public.nurture_set_status(uuid, text) to authenticated;
grant execute on function public.nurture_remove_contact(uuid) to authenticated;
grant execute on function public.nurture_delete(uuid) to authenticated;
