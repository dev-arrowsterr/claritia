-- Tests, blocks (reusable steps) and version history.
-- A test's steps are its intent: plain English, written by people or agents.
-- Its lock is the Playwright code Claritia writes from those steps (from Week 4).
-- Every change to a test's name, steps or lock saves a version.

-- Steps: a JSON array of objects, one per step.
--   {"id": "s1", "kind": "do",    "text": "Add the blue hoodie to the cart"}
--   {"id": "s2", "kind": "check", "text": "The total drops 10%"}
--   {"id": "s3", "kind": "use",   "block": "<block id>"}
create or replace function public.valid_steps(steps jsonb, allow_use boolean) returns boolean
language plpgsql immutable as $$
declare
  s jsonb;
begin
  if jsonb_typeof(steps) is distinct from 'array' or jsonb_array_length(steps) > 200 then
    return false;
  end if;
  for s in select * from jsonb_array_elements(steps) loop
    if jsonb_typeof(s) <> 'object' or jsonb_typeof(s -> 'id') is distinct from 'string' or length(s ->> 'id') not between 1 and 40 then
      return false;
    end if;
    if s ->> 'kind' in ('do', 'check') then
      if jsonb_typeof(s -> 'text') is distinct from 'string' or length(s ->> 'text') > 500 then
        return false;
      end if;
    elsif s ->> 'kind' = 'use' and allow_use then
      if coalesce(s ->> 'block', '') !~ '^[0-9a-f-]{36}$' then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Blocks ---------------------------------------------------------------------

create table if not exists public.blocks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  steps jsonb not null default '[]' check (valid_steps(steps, false)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);
alter table public.blocks enable row level security;
create policy "members all" on public.blocks for all using (is_member(workspace_id)) with check (is_member(workspace_id));

-- Tests ----------------------------------------------------------------------

create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  use_case text not null default 'General' check (length(use_case) between 1 and 60),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  steps jsonb not null default '[]' check (valid_steps(steps, true)),
  lock text check (length(lock) <= 200000),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tests_project on public.tests (project_id, use_case, name);
alter table public.tests enable row level security;
create policy "members all" on public.tests for all using (is_member(workspace_id)) with check (is_member(workspace_id));

-- Every saved change to a test, newest version last. Written by a trigger, read by members.
create table if not exists public.test_versions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version int not null,
  name text not null,
  use_case text not null,
  priority text not null,
  steps jsonb not null,
  lock text,
  author_id uuid,
  author_email text,
  created_at timestamptz not null default now(),
  unique (test_id, version)
);
alter table public.test_versions enable row level security;
create policy "members read" on public.test_versions for select using (is_member(workspace_id));

-- A row's workspace always comes from its project, so nobody can file a test or block under someone else's project.
create or replace function public.project_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select workspace_id into new.workspace_id from projects where id = new.project_id;
  if new.workspace_id is null then
    raise exception 'Project not found';
  end if;
  return new;
end;
$$;
create trigger blocks_workspace before insert or update of project_id on public.blocks
for each row execute function public.project_workspace();
create trigger tests_workspace before insert or update of project_id on public.tests
for each row execute function public.project_workspace();

-- Bump the version when what a test does changes. Moving it to another use case or priority changes nothing it runs.
create or replace function public.test_bump() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.name is distinct from old.name or new.steps is distinct from old.steps or new.lock is distinct from old.lock
     or new.use_case is distinct from old.use_case or new.priority is distinct from old.priority then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;
create trigger tests_bump before update on public.tests
for each row execute function public.test_bump();

create or replace function public.blocks_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger blocks_touch before update on public.blocks
for each row execute function public.blocks_touch();

-- Save a version after a test is made or changed.
create or replace function public.test_save_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.version = old.version then
    return new;
  end if;
  insert into test_versions (test_id, workspace_id, version, name, use_case, priority, steps, lock, author_id, author_email)
  values (new.id, new.workspace_id, new.version, new.name, new.use_case, new.priority, new.steps, new.lock, auth.uid(), auth.jwt() ->> 'email')
  on conflict (test_id, version) do nothing;
  return new;
end;
$$;
create trigger tests_save_version after insert or update on public.tests
for each row execute function public.test_save_version();

revoke all on public.test_versions from anon;
revoke insert, update, delete on public.test_versions from authenticated;
revoke execute on function public.project_workspace() from public, anon, authenticated;
revoke execute on function public.test_save_version() from public, anon, authenticated;
revoke execute on function public.test_bump() from public, anon, authenticated;
revoke execute on function public.blocks_touch() from public, anon, authenticated;

-- Fixed search paths, so these helpers can't be pointed at look-alike tables.
alter function public.valid_steps(jsonb, boolean) set search_path = public;
alter function public.test_bump() set search_path = public;
alter function public.blocks_touch() set search_path = public;
