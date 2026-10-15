-- Identity evidence (docs/identity.md Part 11): what collect heard, before stitching. Collect writes rows with the
-- service role; the stitch job (week 4) cleans the identifiers, checks signed tokens and links devices.
-- Members read rows for the person page.

create table if not exists public.identity_evidence (
  id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id uuid references public.sites (id) on delete cascade,
  device_id uuid,
  session_id uuid,
  -- identify, identify_signed, form, booking, gate, hutk, email_link, page_link, crm, crm_merge, manual_merge
  source text not null check (source in ('identify', 'identify_signed', 'form', 'booking', 'gate', 'hutk', 'email_link',
                                         'page_link', 'crm', 'crm_merge', 'manual_merge')),
  level text not null check (level in ('verified', 'asserted', 'inferred')),
  -- [{"kind": "email" | "user" | "hubspot" | "email_token", "value": "..."}], as heard. Stitch cleans them.
  identifiers jsonb not null check (jsonb_typeof(identifiers) = 'array' and jsonb_array_length(identifiers) between 1 and 4),
  hard_edge boolean not null default false,
  extra jsonb,
  server_at timestamptz not null default now(),
  stitched_at timestamptz,
  -- policy, internal, opted_out, taint, guard, invalid
  ignored text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  primary key (workspace_id, id)
);
create index if not exists identity_evidence_device on public.identity_evidence (workspace_id, device_id, server_at);
create index if not exists identity_evidence_unstitched on public.identity_evidence (server_at) where stitched_at is null;
alter table public.identity_evidence enable row level security;
create policy "members read" on public.identity_evidence for select using (is_member(workspace_id));
revoke all on public.identity_evidence from anon;
revoke insert, update, delete on public.identity_evidence from authenticated;
