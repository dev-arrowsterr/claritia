-- Tunnels: `npx claritia tunnel 3000` connects a developer's machine to the relay with a workspace API key. While it's
-- connected, runs and explorations in that workspace whose address is localhost reach the developer's machine through
-- it, and only the ports the developer named. The relay records each tunnel here and keeps last_seen_at fresh.

create table if not exists public.tunnels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  api_key_id uuid references public.api_keys (id) on delete cascade,
  ports int[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disconnected_at timestamptz
);
create index if not exists tunnels_open on public.tunnels (workspace_id, last_seen_at desc) where disconnected_at is null;
alter table public.tunnels enable row level security;
create policy "members read" on public.tunnels for select using (is_member(workspace_id));
revoke all on public.tunnels from anon;
revoke insert, update, delete on public.tunnels from authenticated;

-- The workspace's open tunnel, if one was seen in the last minute. For the runner.
create or replace function public.open_tunnel(p_workspace uuid) returns setof tunnels
language sql stable security definer set search_path = public as $$
  select * from tunnels
  where workspace_id = p_workspace and disconnected_at is null and last_seen_at > now() - interval '1 minute'
  order by connected_at desc
  limit 1;
$$;

revoke execute on function public.open_tunnel(uuid) from public, anon, authenticated;
grant execute on function public.open_tunnel(uuid) to service_role;
