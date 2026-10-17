-- Lead scoring and routing (docs/marketing-platform.md M7): fit plus engagement, fixed math in SQL. A contact that
-- crosses the threshold becomes an MQL and goes to an owner by the workspace's rules; the score, the stage and the
-- CRM owner go to two-way CRMs with the next push.
--   Fit (0 to 100): the company against the ideal customer (the account's fit when there is one), and the person
--     (work email, title keywords).
--   Engagement (0 to 100): forms, meetings, email clicks and website visits from the last 90 days, each halving in
--     value every half_life_days. Only verified and asserted visits count; a probable link never adds points.
--   Routing: the first rule whose countries, industries and sizes match picks the owner, taking turns when it has
--     several; a contact that already has an owner here or in the CRM keeps them.

alter table public.contacts add column if not exists fit_score int check (fit_score between 0 and 100);
alter table public.contacts add column if not exists engagement_score int check (engagement_score between 0 and 100);
alter table public.contacts add column if not exists scored_at timestamptz;
alter table public.contacts add column if not exists qualified_at timestamptz;

create table if not exists public.lead_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  enabled boolean not null default false,
  threshold int not null default 70 check (threshold between 1 and 100),
  fit_weight numeric not null default 0.5 check (fit_weight between 0 and 1),
  half_life_days int not null default 30 check (half_life_days between 1 and 365),
  weights jsonb not null default '{"form.submitted": 25, "meeting.booked": 40, "email.clicked": 8, "visit": 3, "visit.pricing": 15, "email.unsubscribed": -30}'
    check (jsonb_typeof(weights) = 'object'),
  titles text[] not null default '{}' check (cardinality(titles) <= 50),
  -- {respect_owner, rules: [{name, countries, industries, sizes, owners: [{user_id?, crm_owner_id?, label}]}], default: {owners: [...]}}
  routing jsonb not null default '{"respect_owner": true, "rules": [], "default": {"owners": []}}' check (jsonb_typeof(routing) = 'object'),
  -- Whose turn it is, per rule.
  turns jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.lead_settings enable row level security;
create policy "members read" on public.lead_settings for select using (is_member(workspace_id));
revoke all on public.lead_settings from anon;
revoke insert, update, delete on public.lead_settings from authenticated;

-- The CRM owner goes out with pushes, and comes back from the CRM (040's mapping targets gain owner_crm).
alter table public.mappings drop constraint if exists mappings_target_check;
alter table public.mappings add constraint mappings_target_check check (target ~ '^(skip|email|name|first_name|last_name|title|phone|company|website|country|region|timezone|lifecycle|lead_status|basis|industry|size|domain|score|score_band|owner_crm|f\.[a-z][a-z0-9_]{0,39})$');

create or replace function public.push_candidates(p_source uuid, p_after text, p_limit int default 200, p_ids uuid[] default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select * from sources where id = p_source)
  select coalesce(jsonb_agg(x order by x->>'updated_at', x->>'id'), '[]') from (
    select jsonb_build_object(
      'id', c.id, 'updated_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'email', c.email, 'email_clean', c.email_clean, 'first_name', c.first_name, 'last_name', c.last_name, 'title', c.title, 'phone', c.phone,
      'country', c.country, 'region', c.region, 'timezone', c.timezone, 'lifecycle', c.lifecycle, 'lead_status', c.lead_status, 'fields', c.fields,
      'score', c.score, 'score_band', c.score_band, 'owner_crm', c.owner_crm_id, 'sources', c.field_sources,
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

-- An owner change is a change to push.
create or replace function public.contacts_score_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.score is distinct from old.score or new.score_band is distinct from old.score_band or new.owner_crm_id is distinct from old.owner_crm_id then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists contacts_score_touch on public.contacts;
create trigger contacts_score_touch before update of score, score_band, owner_crm_id on public.contacts for each row execute function public.contacts_score_touch();

-- The CRM's owner for linked contacts, as the pull read it (server).
create or replace function public.contacts_owner_crm_set(p_ws uuid, p_rows jsonb) returns void
language sql security definer set search_path = public as $$
  update contacts c set owner_crm_id = nullif(left(r.owner, 100), '')
  from jsonb_to_recordset(p_rows) r(id uuid, owner text)
  where c.id = r.id and c.workspace_id = p_ws and c.owner_crm_id is distinct from nullif(left(r.owner, 100), '');
$$;

-- Fit ---------------------------------------------------------------------------------------------------------

-- The ideal customer match, the same math as fitV0 in src/lib/web/scores.ts: matched weights over all weights, capped
-- at 30 when a required field misses. Null without rules or data.
create or replace function public.icp_fit(p_rules jsonb, p_industry text, p_size text, p_country text) returns int
language plpgsql immutable set search_path = public as $$
declare
  total numeric := 0;
  hit numeric := 0;
  missed boolean := false;
  k text;
  v text;
  r jsonb;
  w numeric;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then return null; end if;
  foreach k in array array['industries', 'sizes', 'countries'] loop
    r := p_rules->k;
    if r is null or jsonb_typeof(r->'values') <> 'array' or jsonb_array_length(r->'values') = 0 then continue; end if;
    w := coalesce((r->>'weight')::numeric, 0);
    if w <= 0 then continue; end if;
    v := case k when 'industries' then p_industry when 'sizes' then p_size else p_country end;
    total := total + w;
    if v is not null and exists (select 1 from jsonb_array_elements_text(r->'values') x where lower(x) = lower(v)) then
      hit := hit + w;
    elsif coalesce((r->>'required')::boolean, false) then
      missed := true;
    end if;
  end loop;
  if total = 0 then return null; end if;
  return case when missed then least(round(hit / total * 100), 30) else round(hit / total * 100) end;
end;
$$;

-- Scores for some contacts: {contact_id, fit, engagement, total, band, reasons}.
create or replace function public.lead_score_rows(p_ws uuid, p_ids uuid[]) returns table (contact_id uuid, fit int, engagement int, total int, band text, reasons jsonb)
language sql stable security definer set search_path = public as $$
  with s as (select * from lead_settings where workspace_id = p_ws),
  rules as (select rules from icp where workspace_id = p_ws),
  base as (
    select c.id, c.email_class, c.title, c.person_id,
      coalesce(a.fit, icp_fit((select rules from rules), co.industry, co.size, co.country)) as company_fit,
      co.industry, co.size, co.country
    from contacts c
    left join companies co on co.id = c.company_id
    left join accounts a on a.id = co.account_id
    where c.workspace_id = p_ws and c.id = any(p_ids) and c.deleted_at is null
  ),
  person as (
    select b.id,
      (case b.email_class when 'work' then 40 when 'own' then 40 when 'partner' then 20 when 'role' then 20 else 0 end)
      + case when cardinality((select titles from s)) = 0 then 0
             when exists (select 1 from unnest((select titles from s)) t where b.title ilike '%' || t || '%') then 60 else 0 end as pts,
      cardinality((select titles from s)) > 0 as has_titles,
      exists (select 1 from unnest((select titles from s)) t where b.title ilike '%' || t || '%') as title_hit
    from base b
  ),
  ev as (
    select e.contact_id as id, e.kind, e.at
    from contact_events e
    where e.workspace_id = p_ws and e.contact_id = any(p_ids) and e.at > now() - interval '90 days'
      and e.kind in (select jsonb_object_keys((select weights from s)))
    union all
    select b.id, case when x.landing_path ilike '%pricing%' then 'visit.pricing' else 'visit' end, x.started_at
    from base b join sessions x on x.workspace_id = p_ws and x.person_id = b.person_id
    where b.person_id is not null and x.person_level in ('verified', 'asserted') and not x.is_bot and not x.internal
      and x.started_at > now() - interval '90 days'
  ),
  eng2 as (
    select x.id,
      sum(coalesce(((select weights from s)->>x.kind)::numeric, 0) * power(0.5, extract(epoch from now() - x.at) / 86400.0 / (select half_life_days from s))) as raw
    from ev x group by x.id
  ),
  counts as (
    select id, jsonb_object_agg(kind, n) as counts from (select id, kind, count(*) as n from ev group by id, kind) k group by id
  ),
  scored as (
    select b.id,
      case when b.company_fit is null then least(100, round(p.pts * case when p.has_titles then 1 else 2.5 end))::int
           else round(0.6 * b.company_fit + 0.4 * least(100, p.pts * case when p.has_titles then 1 else 2.5 end))::int end as fit,
      greatest(0, least(100, round(coalesce(e.raw, 0))))::int as engagement,
      b.company_fit, b.industry, b.size, b.country, p.title_hit, b.email_class, c.counts
    from base b join person p on p.id = b.id
    left join eng2 e on e.id = b.id
    left join counts c on c.id = b.id
  )
  select x.id, x.fit, x.engagement,
    round((select fit_weight from s) * x.fit + (1 - (select fit_weight from s)) * x.engagement)::int as total,
    case when round((select fit_weight from s) * x.fit + (1 - (select fit_weight from s)) * x.engagement) >= (select threshold from s) then 'hot'
         when round((select fit_weight from s) * x.fit + (1 - (select fit_weight from s)) * x.engagement) >= (select threshold from s) * 0.6 then 'warm'
         else 'cold' end,
    jsonb_strip_nulls(jsonb_build_object(
      'company_fit', x.company_fit, 'industry', x.industry, 'size', x.size, 'country', x.country,
      'work_email', x.email_class in ('work', 'own'), 'title_match', x.title_hit, 'activity', coalesce(x.counts, '{}')))
  from scored x;
$$;

-- Routing -----------------------------------------------------------------------------------------------------

-- Give a newly qualified contact an owner and make them an MQL (server). Returns the rule's name, or null.
create or replace function public.lead_route(p_contact uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c contacts;
  co companies;
  s lead_settings;
  r jsonb;
  owners jsonb;
  pick jsonb;
  idx int := 0;
  rule_name text;
  turn int;
  vals jsonb := '{}';
begin
  select * into c from contacts where id = p_contact and deleted_at is null for update;
  if c.id is null then return null; end if;
  select * into s from lead_settings where workspace_id = c.workspace_id;
  select * into co from companies where id = c.company_id;
  if coalesce((s.routing->>'respect_owner')::boolean, true) and (c.owner_user_id is not null or c.owner_crm_id is not null) then
    owners := null;
    rule_name := 'kept_owner';
  else
    for r in select * from jsonb_array_elements(coalesce(s.routing->'rules', '[]')) loop
      if (jsonb_array_length(coalesce(r->'countries', '[]')) = 0 or exists (select 1 from jsonb_array_elements_text(r->'countries') x where upper(x) = coalesce(co.country, c.country)))
         and (jsonb_array_length(coalesce(r->'industries', '[]')) = 0 or exists (select 1 from jsonb_array_elements_text(r->'industries') x where lower(x) = lower(co.industry)))
         and (jsonb_array_length(coalesce(r->'sizes', '[]')) = 0 or exists (select 1 from jsonb_array_elements_text(r->'sizes') x where lower(x) = lower(co.size)))
         and jsonb_array_length(coalesce(r->'owners', '[]')) > 0 then
        owners := r->'owners';
        rule_name := coalesce(r->>'name', 'Rule ' || (idx + 1));
        exit;
      end if;
      idx := idx + 1;
    end loop;
    if owners is null and jsonb_array_length(coalesce(s.routing->'default'->'owners', '[]')) > 0 then
      owners := s.routing->'default'->'owners';
      rule_name := 'default';
      idx := -1;
    end if;
  end if;
  if owners is not null then
    turn := coalesce((s.turns->>idx::text)::int, 0);
    pick := owners->(turn % jsonb_array_length(owners));
    update lead_settings set turns = turns || jsonb_build_object(idx::text, turn + 1) where workspace_id = c.workspace_id;
    if nullif(pick->>'user_id', '') is not null and exists (select 1 from workspace_members where workspace_id = c.workspace_id and user_id::text = pick->>'user_id') then
      vals := vals || jsonb_build_object('owner', pick->>'user_id');
    end if;
    if nullif(pick->>'crm_owner_id', '') is not null then
      update contacts set owner_crm_id = left(pick->>'crm_owner_id', 100) where id = c.id;
    end if;
  end if;
  if c.lifecycle is null or c.lifecycle in ('subscriber', 'lead') then
    vals := vals || jsonb_build_object('lifecycle', 'mql');
  end if;
  if vals <> '{}' then perform contact_update(c.id, 'scoring', vals); end if;
  update contacts set qualified_at = now() where id = c.id;
  insert into contact_events (workspace_id, contact_id, kind, data, source)
  values (c.workspace_id, c.id, 'lead.qualified', jsonb_strip_nulls(jsonb_build_object('score', c.score, 'rule', rule_name, 'owner', pick)), 'scoring');
  return rule_name;
end;
$$;

-- Scoring runs ------------------------------------------------------------------------------------------------

-- Rescore the contacts that need it in one workspace: never scored, with activity since, or a day old (values fade).
-- Then route the ones that crossed the threshold. Returns {scored, routed}.
create or replace function public.lead_scores_refresh(p_ws uuid, p_limit int default 5000) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s lead_settings;
  ids uuid[];
  n int;
  routed int := 0;
  r record;
begin
  select * into s from lead_settings where workspace_id = p_ws and enabled;
  if s.workspace_id is null then return jsonb_build_object('scored', 0, 'routed', 0); end if;
  select array_agg(id) into ids from (
    select c.id from contacts c
    where c.workspace_id = p_ws and c.deleted_at is null
      and (c.scored_at is null
           or c.scored_at < now() - interval '1 day'
           or exists (select 1 from contact_events e where e.contact_id = c.id and e.at > c.scored_at and e.at > now() - interval '90 days')
           or (c.person_id is not null and exists (select 1 from sessions x where x.workspace_id = p_ws and x.person_id = c.person_id and x.started_at > c.scored_at)))
    order by c.scored_at nulls first
    limit greatest(least(coalesce(p_limit, 5000), 20000), 1)
  ) t;
  if ids is null then return jsonb_build_object('scored', 0, 'routed', 0); end if;
  update contacts c set score = x.total, score_band = x.band, fit_score = x.fit, engagement_score = x.engagement, score_reasons = x.reasons, scored_at = now()
  from lead_score_rows(p_ws, ids) x where c.id = x.contact_id;
  get diagnostics n = row_count;
  for r in select id from contacts where id = any(ids) and score >= s.threshold and qualified_at is null loop
    perform lead_route(r.id);
    routed := routed + 1;
  end loop;
  return jsonb_build_object('scored', n, 'routed', routed);
end;
$$;

create or replace function public.lead_scores_due() returns int
language plpgsql security definer set search_path = public as $$
declare
  w uuid;
  n int := 0;
begin
  for w in select workspace_id from lead_settings where enabled loop
    perform lead_scores_refresh(w, 5000);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Owner screens -----------------------------------------------------------------------------------------------

create or replace function public.lead_settings_save(p_ws uuid, p_values jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can change scoring'; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'Send an object'; end if;
  if p_values ? 'weights' and (jsonb_typeof(p_values->'weights') <> 'object'
     or exists (select 1 from jsonb_each(p_values->'weights') w where jsonb_typeof(w.value) <> 'number' or abs((w.value)::text::numeric) > 100)) then
    raise exception 'Weights are numbers from -100 to 100';
  end if;
  for o in select x from jsonb_array_elements(coalesce(p_values->'routing'->'rules', '[]')) r, jsonb_array_elements(coalesce(r->'owners', '[]')) x
           union all select x from jsonb_array_elements(coalesce(p_values->'routing'->'default'->'owners', '[]')) x loop
    if nullif(o->>'user_id', '') is not null and not exists (select 1 from workspace_members where workspace_id = p_ws and user_id::text = o->>'user_id') then
      raise exception 'Owner: pick a teammate';
    end if;
  end loop;
  insert into lead_settings (workspace_id) values (p_ws) on conflict do nothing;
  update lead_settings set
    enabled = coalesce((p_values->>'enabled')::boolean, enabled),
    threshold = coalesce((p_values->>'threshold')::int, threshold),
    fit_weight = coalesce((p_values->>'fit_weight')::numeric, fit_weight),
    half_life_days = coalesce((p_values->>'half_life_days')::int, half_life_days),
    weights = coalesce(p_values->'weights', weights),
    titles = coalesce(array(select left(trim(t), 60) from jsonb_array_elements_text(p_values->'titles') t where trim(t) <> ''), titles),
    routing = coalesce(p_values->'routing', routing),
    updated_at = now()
  where workspace_id = p_ws;
  insert into audit_log (workspace_id, actor, action, target, data) values (p_ws, auth.uid(), 'scoring.settings', p_ws::text, p_values);
end;
$$;

-- Rescore everyone now (after changing the rules).
create or replace function public.lead_rescore_now(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(p_ws) then raise exception 'Only the workspace owner can rescore'; end if;
  update contacts set scored_at = null where workspace_id = p_ws and deleted_at is null;
  return lead_scores_refresh(p_ws, 20000);
end;
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
    perform lead_scores_due();
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

revoke execute on function public.contacts_owner_crm_set(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lead_score_rows(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.lead_route(uuid) from public, anon, authenticated;
revoke execute on function public.lead_scores_refresh(uuid, int) from public, anon, authenticated;
revoke execute on function public.lead_scores_due() from public, anon, authenticated;
grant execute on function public.contacts_owner_crm_set(uuid, jsonb) to service_role;
grant execute on function public.lead_score_rows(uuid, uuid[]) to service_role;
grant execute on function public.lead_route(uuid) to service_role;
grant execute on function public.lead_scores_refresh(uuid, int) to service_role;
grant execute on function public.lead_scores_due() to service_role;
revoke execute on function public.lead_settings_save(uuid, jsonb) from public, anon;
revoke execute on function public.lead_rescore_now(uuid) from public, anon;
grant execute on function public.lead_settings_save(uuid, jsonb) to authenticated;
grant execute on function public.lead_rescore_now(uuid) to authenticated;
