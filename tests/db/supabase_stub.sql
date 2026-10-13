-- Just enough of Supabase to run schema.sql and the migrations on a plain Postgres, for tests.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email', current_setting('request.jwt.claim.email', true)) $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
-- Supabase grants everything in public to these roles. Row level security and revokes do the limiting.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
-- Storage: buckets, objects and the folder helper, as Supabase has them.
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated;
grant select on storage.objects to anon, authenticated;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to service_role;
