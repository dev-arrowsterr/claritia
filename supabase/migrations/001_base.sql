-- Claritia base: workspaces, members, projects, environments and secrets.
-- Members reach their workspace's rows through row level security.
-- Secret values are sealed by the server before they arrive here, and no signed-in user can read them back.

-- Workspaces and members -----------------------------------------------------

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  created_at timestamptz not null default now()
);
alter table public.workspaces enable row level security;

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user on public.workspace_members (user_id);
alter table public.workspace_members enable row level security;

create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid());
$$;

create or replace function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role = 'owner');
$$;

-- The caller's workspace. Makes one, with the caller as owner, on first sign-in.
create or replace function public.ensure_workspace() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  email text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  select workspace_id into ws from workspace_members where user_id = auth.uid() order by created_at limit 1;
  if ws is not null then
    return ws;
  end if;
  select u.email into email from auth.users u where u.id = auth.uid();
  insert into workspaces (name)
  values (coalesce(nullif(split_part(coalesce(email, ''), '@', 1), ''), 'My') || '''s workspace')
  returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
  return ws;
end;
$$;

drop policy if exists "members read" on public.workspaces;
create policy "members read" on public.workspaces for select using (is_member(id));
drop policy if exists "owners rename" on public.workspaces;
create policy "owners rename" on public.workspaces for update using (is_owner(id)) with check (is_owner(id));

drop policy if exists "members read" on public.workspace_members;
create policy "members read" on public.workspace_members for select using (is_member(workspace_id));

-- Projects -------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  created_at timestamptz not null default now()
);
create index if not exists projects_ws on public.projects (workspace_id, created_at);
alter table public.projects enable row level security;

drop policy if exists "members all" on public.projects;
create policy "members all" on public.projects for all using (is_member(workspace_id)) with check (is_member(workspace_id));

-- Environments: where a project's tests run (staging, production, a preview URL) -----

create table if not exists public.environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  base_url text not null check (base_url ~ '^https?://[^\s/]+'),
  created_at timestamptz not null default now(),
  unique (project_id, name)
);
alter table public.environments enable row level security;

-- A row's workspace always comes from its parent, so nobody can file a row under someone else's project.
create or replace function public.environment_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select workspace_id into new.workspace_id from projects where id = new.project_id;
  if new.workspace_id is null then
    raise exception 'Project not found';
  end if;
  return new;
end;
$$;
drop trigger if exists environment_workspace on public.environments;
create trigger environment_workspace before insert or update of project_id on public.environments
for each row execute function public.environment_workspace();

drop policy if exists "members all" on public.environments;
create policy "members all" on public.environments for all using (is_member(workspace_id)) with check (is_member(workspace_id));

-- Secrets: names are visible to members, sealed values are not --------------------

create table if not exists public.env_secrets (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment_id, name)
);
alter table public.env_secrets enable row level security;

drop policy if exists "members read" on public.env_secrets;
create policy "members read" on public.env_secrets for select using (is_member(workspace_id));
drop policy if exists "members delete" on public.env_secrets;
create policy "members delete" on public.env_secrets for delete using (is_member(workspace_id));

-- No policies: only the server's runner reads these, with the secret key.
create table if not exists public.env_secret_values (
  secret_id uuid primary key references public.env_secrets (id) on delete cascade,
  sealed text not null
);
alter table public.env_secret_values enable row level security;
revoke all on public.env_secret_values from anon, authenticated;

-- Add or replace a secret. The value arrives already sealed by the server.
create or replace function public.set_secret(p_env uuid, p_name text, p_sealed text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws uuid;
  sid uuid;
begin
  select workspace_id into ws from environments where id = p_env;
  if ws is null or not is_member(ws) then
    raise exception 'Environment not found';
  end if;
  if p_sealed is null or p_sealed !~ '^v1:' then
    raise exception 'Secret must be sealed by the server';
  end if;
  insert into env_secrets (environment_id, workspace_id, name)
  values (p_env, ws, p_name)
  on conflict (environment_id, name) do update set updated_at = now()
  returning id into sid;
  insert into env_secret_values (secret_id, sealed) values (sid, p_sealed)
  on conflict (secret_id) do update set sealed = excluded.sealed;
  return sid;
end;
$$;

revoke execute on function public.set_secret(uuid, text, text) from public, anon;
revoke execute on function public.ensure_workspace() from public, anon;
grant execute on function public.set_secret(uuid, text, text) to authenticated;
grant execute on function public.ensure_workspace() to authenticated;

-- Helpers for row level security: signed-in callers only. The trigger function is never called directly.
revoke execute on function public.environment_workspace() from public, anon, authenticated;
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
