-- Forms (docs/marketing-platform.md M6): a builder, an embed and a hosted page, UTM capture, spam checks and consent.
--   forms: the fields (checked in src/lib/forms/schema.ts) and settings. Only a live form takes answers.
--   form_submissions: every answer, spam included (marked with why), with the page, referrer and UTMs.
-- A real submission becomes a contact (source 'form'), a consent row, an optional topic subscription and a
-- 'form.submitted' contact event, which two-way CRMs also get (040_sync.sql).

create table if not exists public.forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  fields jsonb not null default '[]' check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 50),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'live')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists forms_ws on public.forms (workspace_id, created_at desc);
alter table public.forms enable row level security;
create policy "members read" on public.forms for select using (is_member(workspace_id));
revoke all on public.forms from anon;
revoke insert, update, delete on public.forms from authenticated;

create table if not exists public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  form_id uuid not null references public.forms (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  -- utm_source … utm_content, first-touch copies, click ids (gclid, fbclid, li_fat_id, msclkid).
  utm jsonb not null default '{}' check (jsonb_typeof(utm) = 'object'),
  page_url text check (length(page_url) <= 2000),
  referrer text check (length(referrer) <= 2000),
  basis text check (basis in ('opt_in', 'legitimate_interest', 'none')),
  -- Why it was held back: honeypot, too_fast, rate, captcha. Null for a real one.
  spam text check (spam in ('honeypot', 'too_fast', 'rate', 'captcha')),
  ip_hash text check (length(ip_hash) <= 64),
  user_agent text check (length(user_agent) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists form_submissions_form on public.form_submissions (form_id, created_at desc);
create index if not exists form_submissions_ip on public.form_submissions (form_id, ip_hash, created_at desc);
alter table public.form_submissions enable row level security;
create policy "members read" on public.form_submissions for select using (is_member(workspace_id));
revoke all on public.form_submissions from anon;
revoke insert, update, delete on public.form_submissions from authenticated;

-- Members build forms. The builder checks fields and settings (src/lib/forms/schema.ts), and the public page and
-- the submit route read them through the same check, so a bad field is dropped there. The database keeps the
-- size limits and needs an email field.
create or replace function public.form_save(p_ws uuid, p_id uuid, p_name text, p_fields jsonb, p_settings jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  fid uuid;
begin
  if not is_member(p_ws) then raise exception 'Form not found'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name the form'; end if;
  if jsonb_typeof(p_fields) <> 'array' or jsonb_typeof(p_settings) <> 'object' then raise exception 'Bad form'; end if;
  if not exists (select 1 from jsonb_array_elements(p_fields) f where f->>'maps_to' = 'email' and f->>'type' = 'email') then
    raise exception 'A form needs an email field';
  end if;
  if p_settings ? 'topic_id' and nullif(p_settings->>'topic_id', '') is not null
     and not exists (select 1 from topics where id = (p_settings->>'topic_id')::uuid and workspace_id = p_ws) then
    raise exception 'Topic not found';
  end if;
  if p_id is null then
    if (select count(*) from forms where workspace_id = p_ws) >= 200 then raise exception 'Up to 200 forms'; end if;
    insert into forms (workspace_id, name, fields, settings, created_by) values (p_ws, trim(p_name), p_fields, p_settings, auth.uid()) returning id into fid;
  else
    update forms set name = trim(p_name), fields = p_fields, settings = p_settings, updated_at = now() where id = p_id and workspace_id = p_ws returning id into fid;
    if fid is null then raise exception 'Form not found'; end if;
  end if;
  return fid;
end;
$$;

create or replace function public.form_publish(p_id uuid, p_live boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from forms where id = p_id;
  if ws is null or not is_member(ws) then raise exception 'Form not found'; end if;
  update forms set status = case when p_live then 'live' else 'draft' end, updated_at = now() where id = p_id;
end;
$$;

create or replace function public.form_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from forms where id = p_id;
  if ws is null or not is_member(ws) then raise exception 'Form not found'; end if;
  delete from forms where id = p_id;
end;
$$;

-- What the public page and the submit route read (server). Drafts only for the preview.
create or replace function public.form_public(p_id uuid, p_preview boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', f.id, 'workspace_id', f.workspace_id, 'name', f.name, 'fields', f.fields, 'settings', f.settings, 'status', f.status,
    'topic', (select name from topics t where t.id = nullif(f.settings->>'topic_id', '')::uuid))
  from forms f where f.id = p_id and (f.status = 'live' or p_preview);
$$;

-- Record a submission (server). More than 10 from one address in 10 minutes is marked 'rate'. Returns
-- {id, spam}.
create or replace function public.form_submit(p_form uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  f forms;
  spam text := nullif(p_row->>'spam', '');
  sid uuid;
begin
  select * into f from forms where id = p_form and status = 'live';
  if f.id is null then raise exception 'Form not found'; end if;
  if spam is null and coalesce(p_row->>'ip_hash', '') <> ''
     and (select count(*) from form_submissions where form_id = p_form and ip_hash = p_row->>'ip_hash' and created_at > now() - interval '10 minutes') >= 10 then
    spam := 'rate';
  end if;
  insert into form_submissions (workspace_id, form_id, answers, utm, page_url, referrer, basis, spam, ip_hash, user_agent)
  values (f.workspace_id, f.id, coalesce(p_row->'answers', '{}'), coalesce(p_row->'utm', '{}'), left(p_row->>'page_url', 2000), left(p_row->>'referrer', 2000),
          nullif(p_row->>'basis', ''), spam, left(p_row->>'ip_hash', 64), left(p_row->>'user_agent', 300))
  returning id into sid;
  return jsonb_build_object('id', sid, 'spam', spam);
end;
$$;

-- After the contact is written (server): link it, subscribe it to the form's topic on opt-in, and log the event.
create or replace function public.form_submission_link(p_submission uuid, p_contact uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s form_submissions;
  f forms;
  topic uuid;
begin
  select * into s from form_submissions where id = p_submission;
  if s.id is null or s.spam is not null then return; end if;
  if not exists (select 1 from contacts where id = p_contact and workspace_id = s.workspace_id) then raise exception 'Contact not found'; end if;
  select * into f from forms where id = s.form_id;
  update form_submissions set contact_id = p_contact where id = s.id;
  topic := nullif(f.settings->>'topic_id', '')::uuid;
  if topic is not null and s.basis = 'opt_in' then
    insert into subscriptions (workspace_id, contact_id, topic_id, status) values (s.workspace_id, p_contact, topic, 'subscribed')
    on conflict (contact_id, topic_id) do update set status = 'subscribed', at = now();
  end if;
  insert into contact_events (workspace_id, contact_id, kind, data, source)
  values (s.workspace_id, p_contact, 'form.submitted',
          jsonb_build_object('form_id', f.id, 'form_name', f.name, 'submission_id', s.id, 'answers', s.answers, 'utm', s.utm, 'page', s.page_url, 'referrer', s.referrer), 'form');
end;
$$;

revoke execute on function public.form_public(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.form_submit(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.form_submission_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.form_public(uuid, boolean) to service_role;
grant execute on function public.form_submit(uuid, jsonb) to service_role;
grant execute on function public.form_submission_link(uuid, uuid) to service_role;
revoke execute on function public.form_save(uuid, uuid, text, jsonb, jsonb) from public, anon;
revoke execute on function public.form_publish(uuid, boolean) from public, anon;
revoke execute on function public.form_delete(uuid) from public, anon;
grant execute on function public.form_save(uuid, uuid, text, jsonb, jsonb) to authenticated;
grant execute on function public.form_publish(uuid, boolean) to authenticated;
grant execute on function public.form_delete(uuid) to authenticated;
