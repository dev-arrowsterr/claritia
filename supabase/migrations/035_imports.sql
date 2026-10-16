-- Imports at full size (docs/conversion-weeks.md week 2): files of any size through storage, progress that
-- survives a restart, unsubscribes and bounces in before any contact, and undo for 30 days.
--   Files live in the private "imports" bucket under <workspace id>/<upload id>/<file name>. Members upload into
--   their own workspace's folder and read it back; the server reads it to import. Files go after 30 days.
--   An import runs in the web app when the file is small, and as an import_file job on claritia-intel otherwise.
--   The job saves how many rows it finished; a restart reads the file again and skips them (writes are upserts).
--   Undo removes contacts the import made that nobody changed since, and puts back values it overwrote, while
--   the value still reads what the import wrote. Suppressions stay: an unsubscribe is never undone.

insert into storage.buckets (id, name, public) values ('imports', 'imports', false) on conflict (id) do nothing;
create policy "members read import files" on storage.objects for select to authenticated
  using (bucket_id = 'imports' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload import files" on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and is_member(((storage.foldername(name))[1])::uuid));

alter table public.imports drop constraint if exists imports_status_check;
alter table public.imports add constraint imports_status_check check (status in ('queued', 'running', 'done', 'failed', 'undoing', 'undone'));
alter table public.imports add column if not exists kind text not null default 'file' check (kind in ('file', 'paste', 'source', 'api', 'migration'));
alter table public.imports add column if not exists source_id uuid;
alter table public.imports add column if not exists size bigint;
alter table public.imports add column if not exists sheet text check (length(sheet) <= 120);
-- { rows, total, stage } while it runs.
alter table public.imports add column if not exists progress jsonb not null default '{}';
-- Rows finished so far; a restart skips them.
alter table public.imports add column if not exists rows_done int not null default 0;
alter table public.imports add column if not exists errors_path text;
alter table public.imports add column if not exists undo_until timestamptz;
alter table public.imports add column if not exists undone_at timestamptz;

-- Start an import. Small files run at once ('running'); big ones wait for the job ('queued').
drop function if exists public.imports_start(uuid, uuid, text, jsonb);
create or replace function public.imports_start(p_ws uuid, p_user uuid, p_file_name text, p_mapping jsonb, p_kind text default 'file',
  p_path text default null, p_size bigint default null, p_sheet text default null, p_queued boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  id uuid;
begin
  if p_path is not null and split_part(p_path, '/', 1) <> p_ws::text then
    raise exception 'File not found';
  end if;
  insert into imports (workspace_id, created_by, file_name, mapping, kind, file_path, size, sheet, status)
  values (p_ws, p_user, left(p_file_name, 200), coalesce(p_mapping, '{}'), p_kind, p_path, p_size, p_sheet, case when p_queued then 'queued' else 'running' end)
  returning imports.id into id;
  if p_queued then
    perform enqueue_job(p_ws, 'import_file', id::text, jsonb_build_object('import_id', id), 0, 8);
  end if;
  return id;
end;
$$;

-- The job takes a queued import (or picks up its own after a restart).
create or replace function public.import_claim(p_import uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i imports%rowtype;
begin
  update imports set status = 'running' where id = p_import and status in ('queued', 'running') returning * into i;
  if i.id is null then
    return null;
  end if;
  return to_jsonb(i);
end;
$$;

create or replace function public.import_progress(p_import uuid, p_rows_done int, p_progress jsonb) returns void
language sql security definer set search_path = public as $$
  update imports set rows_done = greatest(rows_done, p_rows_done), progress = coalesce(p_progress, progress) where id = p_import and status = 'running';
$$;

drop function if exists public.imports_finish(uuid, text, jsonb, text);
create or replace function public.imports_finish(p_import uuid, p_status text, p_counts jsonb, p_error text default null, p_errors_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  actor uuid;
  totals jsonb;
begin
  -- Created and changed come from the database, so a restarted import counts each contact once.
  select jsonb_build_object(
    'created', (select count(*) from contacts c where c.import_id = p_import),
    'changed', (select count(distinct h.record_id) from field_history h where h.import_id = p_import and h.object = 'contact'))
  into totals;
  update imports set status = p_status, counts = coalesce(p_counts, '{}') || totals, error = left(p_error, 2000), finished_at = now(), errors_path = p_errors_path,
    progress = progress || jsonb_build_object('stage', p_status), undo_until = case when p_status = 'done' then now() + interval '30 days' end
  where id = p_import and status = 'running' returning workspace_id, created_by into ws, actor;
  if ws is not null then
    insert into audit_log (workspace_id, actor, action, target, data) values (ws, actor, 'contacts.import', p_import::text, coalesce(p_counts, '{}') || totals);
  end if;
end;
$$;

-- Unsubscribes, bounces and complaints, in before contacts. A stronger reason never gives way to a weaker one.
create or replace function public.suppress(p_ws uuid, p_source text, p_rows jsonb, p_import uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'Send up to 10,000 at a time';
  end if;
  insert into suppressions (workspace_id, email_clean, reason, source, import_id)
  select distinct on (lower(r.email_clean)) p_ws, lower(r.email_clean), r.reason, p_source, p_import
  from jsonb_to_recordset(p_rows) as r(email_clean text, reason text)
  where coalesce(r.email_clean, '') <> '' and r.reason in ('unsubscribed', 'bounced', 'complained', 'cleaned', 'manual')
  order by lower(r.email_clean), array_position(array['complained', 'unsubscribed', 'manual', 'bounced', 'cleaned'], r.reason)
  on conflict (workspace_id, email_clean) do update set
    reason = case when array_position(array['complained', 'unsubscribed', 'manual', 'bounced', 'cleaned'], excluded.reason)
                       < array_position(array['complained', 'unsubscribed', 'manual', 'bounced', 'cleaned'], suppressions.reason)
                  then excluded.reason else suppressions.reason end,
    at = least(suppressions.at, excluded.at);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- For the preview: which of these emails are contacts already, and which are suppressed.
create or replace function public.import_lookup(p_ws uuid, p_emails text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'existing', coalesce((select jsonb_agg(email_clean) from contacts where workspace_id = p_ws and deleted_at is null and email_clean = any(p_emails)), '[]'),
    'suppressed', coalesce((select jsonb_agg(email_clean) from suppressions where workspace_id = p_ws and email_clean = any(p_emails)), '[]'),
    'erased', coalesce((select jsonb_agg(e) from unnest(p_emails) e where exists (select 1 from erasures x where x.workspace_id = p_ws and x.value_hash = sha256(convert_to(e, 'UTF8')))), '[]'));
$$;

-- Undo: ask (members), then the job (or a test) runs it.
create or replace function public.import_undo(p_import uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  i imports%rowtype;
begin
  select * into i from imports where id = p_import;
  if i.id is null or not is_member(i.workspace_id) then
    raise exception 'Import not found';
  end if;
  if i.status <> 'done' or i.undo_until is null or i.undo_until < now() then
    raise exception 'This import can''t be undone';
  end if;
  update imports set status = 'undoing' where id = p_import;
  perform enqueue_job(i.workspace_id, 'import_undo', p_import::text, jsonb_build_object('import_id', p_import), 0, 3);
  insert into audit_log (workspace_id, actor, action, target) values (i.workspace_id, auth.uid(), 'contacts.import_undo', p_import::text);
end;
$$;

create or replace function public.import_undo_run(p_import uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i imports%rowtype;
  removed int := 0;
  restored int := 0;
  h record;
  cur jsonb;
  n int;
begin
  select * into i from imports where id = p_import for update;
  if i.id is null or i.status <> 'undoing' then
    raise exception 'Import not found';
  end if;

  -- Contacts it made that nobody touched after: no change from anyone else, no consent or event from elsewhere.
  delete from contacts c
  where c.import_id = p_import
    and not exists (select 1 from field_history x where x.record_id = c.id and x.import_id is distinct from p_import)
    and not exists (select 1 from consents k where k.contact_id = c.id and k.import_id is distinct from p_import)
    and not exists (select 1 from contact_events e where e.contact_id = c.id and e.import_id is distinct from p_import)
    and not exists (select 1 from segment_members m where m.contact_id = c.id)
    and not exists (select 1 from record_links l where l.from_id = c.id or l.to_id = c.id);
  get diagnostics removed = row_count;

  -- Values it overwrote, put back while they still read what it wrote.
  for h in
    select distinct on (x.record_id, x.key) x.record_id, x.key, x.old, x.new, x.old_source
    from field_history x join contacts c on c.id = x.record_id
    where x.import_id = p_import and x.object = 'contact' and c.deleted_at is null
    order by x.record_id, x.key, x.id desc
  loop
    select contact_vals(c)->h.key into cur from contacts c where c.id = h.record_id;
    continue when cur is distinct from h.new;
    if h.key like 'f.%' then
      update contacts set fields = case when h.old is null then fields - substr(h.key, 3) else fields || jsonb_build_object(substr(h.key, 3), h.old) end,
        field_sources = case when h.old_source is null then field_sources - h.key else field_sources || jsonb_build_object(h.key, h.old_source) end,
        updated_at = now()
      where id = h.record_id;
    else
      execute format('update contacts set %I = $1::%s, field_sources = case when $2::jsonb is null then field_sources - $3 else field_sources || jsonb_build_object($3, $2::jsonb) end, updated_at = now() where id = $4',
        case h.key when 'company' then 'company_id' when 'owner' then 'owner_user_id' else h.key end,
        case when h.key in ('company', 'owner') then 'uuid' else 'text' end)
      using h.old #>> '{}', h.old_source, h.key, h.record_id;
    end if;
    insert into field_history (workspace_id, object, record_id, key, old, new, source)
    values (i.workspace_id, 'contact', h.record_id, h.key, h.new, h.old, 'import_undo');
    restored := restored + 1;
  end loop;

  delete from consents where import_id = p_import;
  get diagnostics n = row_count;
  update imports set status = 'undone', undone_at = now(), counts = counts || jsonb_build_object('undo_removed', removed, 'undo_restored', restored)
  where id = p_import;
  return jsonb_build_object('removed', removed, 'restored', restored, 'consents', n);
end;
$$;

-- Old files go after 30 days (the undo window); the import's record stays.
create or replace function public.imports_files_to_prune() returns setof text
language sql stable security definer set search_path = public as $$
  select file_path from imports where file_path is not null and created_at < now() - interval '30 days'
  union all
  select errors_path from imports where errors_path is not null and created_at < now() - interval '30 days';
$$;

create or replace function public.imports_files_pruned(p_paths text[]) returns void
language sql security definer set search_path = public as $$
  update imports set file_path = null where file_path = any(p_paths);
  update imports set errors_path = null where errors_path = any(p_paths);
$$;

revoke execute on function public.imports_start(uuid, uuid, text, jsonb, text, text, bigint, text, boolean) from public, anon, authenticated;
revoke execute on function public.import_claim(uuid) from public, anon, authenticated;
revoke execute on function public.import_progress(uuid, int, jsonb) from public, anon, authenticated;
revoke execute on function public.suppress(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.import_lookup(uuid, text[]) from public, anon, authenticated;
revoke execute on function public.import_undo_run(uuid) from public, anon, authenticated;
revoke execute on function public.imports_files_to_prune() from public, anon, authenticated;
revoke execute on function public.imports_files_pruned(text[]) from public, anon, authenticated;
revoke execute on function public.imports_finish(uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.imports_finish(uuid, text, jsonb, text, text) to service_role;
grant execute on function public.imports_start(uuid, uuid, text, jsonb, text, text, bigint, text, boolean) to service_role;
grant execute on function public.import_claim(uuid) to service_role;
grant execute on function public.import_progress(uuid, int, jsonb) to service_role;
grant execute on function public.suppress(uuid, text, jsonb, uuid) to service_role;
grant execute on function public.import_lookup(uuid, text[]) to service_role;
grant execute on function public.import_undo_run(uuid) to service_role;
grant execute on function public.imports_files_to_prune() to service_role;
grant execute on function public.imports_files_pruned(text[]) to service_role;
revoke execute on function public.import_undo(uuid) from public, anon;
grant execute on function public.import_undo(uuid) to authenticated;
