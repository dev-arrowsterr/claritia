-- Identity undo and privacy (docs/identity.md 7.11, 15): members unmerge, unlink, mark kiosks and decide merge
-- proposals; owners ask for erasure or export. Each call records what it did and queues the work for
-- claritia-intel (rebuild, stitch_evidence, privacy), which holds the stitching logic.

create table if not exists public.privacy_exports (
  request_id uuid primary key references public.privacy_requests (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.privacy_exports enable row level security;
create policy "owners read" on public.privacy_exports for select using (is_owner(workspace_id));
revoke all on public.privacy_exports from anon;
revoke insert, update, delete on public.privacy_exports from authenticated;

-- True when evidence row e names identifier i (as heard, before cleaning, or cleaned).
create or replace function public.evidence_names(e_identifiers jsonb, i_kind text, i_clean text, i_raw text) returns boolean
language sql immutable as $$
  select exists (
    select 1 from jsonb_array_elements(e_identifiers) x
    where x->>'kind' = i_kind and lower(trim(x->>'value')) in (lower(i_clean), lower(trim(coalesce(i_raw, ''))))
  )
$$;

create or replace function public.unmerge_person(p_person uuid, p_identifiers uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  n int;
begin
  select workspace_id into ws from persons where id = p_person;
  if ws is null or not is_member(ws) then
    raise exception 'Person not found';
  end if;
  update identity_evidence e set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'unmerge'
  where e.workspace_id = ws and e.hard_edge and e.revoked_at is null
    and exists (select 1 from identifiers i where i.workspace_id = ws and i.person_id = p_person and i.id = any(p_identifiers)
                and evidence_names(e.identifiers, i.kind, i.value_clean, i.value_raw));
  get diagnostics n = row_count;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'person.unmerge', p_person::text);
  perform enqueue_job(ws, 'rebuild', ws::text, '{}');
  return n;
end;
$$;

create or replace function public.unlink_device(p_device uuid, p_person uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  n int;
begin
  select workspace_id into ws from devices where id = p_device;
  if ws is null or not is_member(ws) then
    raise exception 'Device not found';
  end if;
  update identity_evidence e set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'unlink'
  where e.workspace_id = ws and e.device_id = p_device and e.revoked_at is null
    and exists (select 1 from identifiers i where i.workspace_id = ws and i.person_id = p_person
                and evidence_names(e.identifiers, i.kind, i.value_clean, i.value_raw));
  get diagnostics n = row_count;
  update devices set no_backfill = true where id = p_device;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'device.unlink', p_device::text);
  perform enqueue_job(ws, 'rebuild', ws::text, '{}');
  return n;
end;
$$;

create or replace function public.mark_kiosk(p_device uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
begin
  select workspace_id into ws from devices where id = p_device;
  if ws is null or not is_member(ws) then
    raise exception 'Device not found';
  end if;
  update devices set state = 'tainted', state_since = now(), tainted_until = '9999-12-31T00:00:00Z', no_backfill = true where id = p_device;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'device.kiosk', p_device::text);
  perform enqueue_job(ws, 'rebuild', ws::text, '{}');
end;
$$;

create or replace function public.decide_merge(p_proposal uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  mp merge_proposals%rowtype;
  a jsonb;
  b jsonb;
  eid uuid := gen_random_uuid();
begin
  select * into mp from merge_proposals where id = p_proposal;
  if mp.id is null or not is_member(mp.workspace_id) then
    raise exception 'Proposal not found';
  end if;
  if mp.status <> 'open' then
    raise exception 'This proposal is already decided';
  end if;
  update merge_proposals set status = case when p_approve then 'approved' else 'denied' end, decided_by = auth.uid(), decided_at = now() where id = p_proposal;
  insert into audit_log (workspace_id, actor, action, target) values (mp.workspace_id, auth.uid(), case when p_approve then 'merge.approve' else 'merge.deny' end, p_proposal::text);
  if not p_approve then
    return;
  end if;
  select jsonb_build_object('kind', kind, 'value', value_clean) into a from identifiers where person_id = mp.person_a order by created_at limit 1;
  select jsonb_build_object('kind', kind, 'value', value_clean) into b from identifiers where person_id = mp.person_b order by created_at limit 1;
  if a is null or b is null then
    raise exception 'One of these people no longer exists';
  end if;
  insert into identity_evidence (id, workspace_id, source, level, identifiers, hard_edge, extra)
  values (eid, mp.workspace_id, 'manual_merge', 'verified', jsonb_build_array(a, b), true, jsonb_build_object('proposal', p_proposal, 'by', auth.uid()));
  perform enqueue_job(mp.workspace_id, 'stitch_evidence', eid::text, jsonb_build_object('evidence_id', eid));
end;
$$;

-- Owners ask for an erasure or an export of one person. Returns the request id.
create or replace function public.privacy_request(p_person uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  h bytea;
  rid uuid;
begin
  select workspace_id into ws from persons where id = p_person;
  if ws is null or not is_owner(ws) then
    raise exception 'Only the workspace owner can do this';
  end if;
  if p_kind not in ('erase', 'export') then
    raise exception 'Pick erase or export';
  end if;
  select value_hash into h from identifiers where person_id = p_person order by (kind = 'email') desc, created_at limit 1;
  insert into privacy_requests (workspace_id, kind, subject_hash, requested_by, source)
  values (ws, p_kind, coalesce(h, '\x00'), auth.uid(), 'app') returning id into rid;
  insert into audit_log (workspace_id, actor, action, target) values (ws, auth.uid(), 'privacy.' || p_kind, rid::text);
  perform enqueue_job(ws, 'privacy', rid::text, jsonb_build_object('request_id', rid, 'person_id', p_person, 'kind', p_kind));
  return rid;
end;
$$;

revoke execute on function public.unmerge_person(uuid, uuid[]) from public, anon;
revoke execute on function public.unlink_device(uuid, uuid) from public, anon;
revoke execute on function public.mark_kiosk(uuid) from public, anon;
revoke execute on function public.decide_merge(uuid, boolean) from public, anon;
revoke execute on function public.privacy_request(uuid, text) from public, anon;
grant execute on function public.unmerge_person(uuid, uuid[]) to authenticated;
grant execute on function public.unlink_device(uuid, uuid) to authenticated;
grant execute on function public.mark_kiosk(uuid) to authenticated;
grant execute on function public.decide_merge(uuid, boolean) to authenticated;
grant execute on function public.privacy_request(uuid, text) to authenticated;
