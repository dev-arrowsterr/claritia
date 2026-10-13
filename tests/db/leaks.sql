-- Leak tests. Each check raises an error when someone can see or do what they shouldn't.
-- People: Ann owns Acme, Ben is a member of Acme, Cat runs another workspace, Eve is signed in with no workspace yet.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

insert into auth.users values
  ('a0000000-0000-0000-0000-000000000000', 'ann@acme.com'),
  ('b0000000-0000-0000-0000-000000000000', 'ben@acme.com'),
  ('c0000000-0000-0000-0000-000000000000', 'cat@other.com'),
  ('e0000000-0000-0000-0000-000000000000', 'eve@gmail.com');
insert into workspaces (id, name) values
  ('11111111-0000-0000-0000-000000000000', 'Acme'),
  ('22222222-0000-0000-0000-000000000000', 'Other');
insert into workspace_members (workspace_id, user_id, role) values
  ('11111111-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000', 'owner'),
  ('11111111-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000', 'member'),
  ('22222222-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000', 'owner');
insert into projects (id, workspace_id, name) values
  ('a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'acme-app'),
  ('c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'cat-app');
insert into environments (id, project_id, workspace_id, name, base_url) values
  ('a2000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'staging', 'https://staging.acme.com'),
  ('c2000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'staging', 'https://staging.other.com');
insert into env_secrets (id, environment_id, workspace_id, name) values
  ('a3000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'LOGIN_PASSWORD'),
  ('c3000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'LOGIN_PASSWORD');
insert into env_secret_values (secret_id, sealed) values
  ('a3000000-0000-0000-0000-000000000000', 'v1:acme-sealed'),
  ('c3000000-0000-0000-0000-000000000000', 'v1:cat-sealed');
insert into blocks (id, project_id, workspace_id, name, steps) values
  ('a4000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'acme-sign-in', '[{"id":"s1","kind":"do","text":"Sign in"}]'),
  ('c4000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'cat-sign-in', '[]');
insert into tests (id, project_id, workspace_id, name, steps) values
  ('a5000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'acme-checkout', '[{"id":"s1","kind":"do","text":"Add a hoodie"}]'),
  ('c5000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'cat-test', '[]');

insert into runs (id, workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, status) values
  ('c6000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', 'c5000000-0000-0000-0000-000000000000', 'cat-test', 1, 'c2000000-0000-0000-0000-000000000000', 'staging', 'https://staging.other.com', 'x', 'passed');
insert into run_steps (run_id, workspace_id, position, kind, label) values ('c6000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 1, 'do', 'cat-step');
insert into storage.objects (bucket_id, name) values
  ('runs', '11111111-0000-0000-0000-000000000000/r1/video.webm'),
  ('runs', '22222222-0000-0000-0000-000000000000/r2/video.webm');

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'LEAK TEST FAILED: %', what; end if;
end $$;
create function pg_temp.fails(sql text, what text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'LEAK TEST FAILED: % (it worked)', what;
exception when others then
  if sqlerrm like 'LEAK TEST FAILED%' then raise; end if;
end $$;
-- Counts rows a statement touched, so a write blocked by row level security (0 rows) can be told apart.
create function pg_temp.touched(sql text) returns int language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- Rows a query can see. Being turned away counts as seeing none.
create function pg_temp.visible(sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute sql into n;
  return n;
exception when insufficient_privilege then
  return 0;
end $$;
create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, false);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- Ben (member, Acme) -------------------------------------------------------------------
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from workspaces) = 1, 'Ben sees another workspace');
select pg_temp.check((select count(*) from projects) = 1 and exists (select 1 from projects where name = 'acme-app'), 'Ben can''t see only his own projects');
select pg_temp.check((select count(*) from environments) = 1, 'Ben sees another workspace''s environments');
select pg_temp.check((select count(*) from env_secrets) = 1, 'Ben sees another workspace''s secret names');
select pg_temp.fails($$select * from env_secret_values$$, 'Ben reads sealed secret values');
select pg_temp.check(pg_temp.touched($$update workspaces set name = 'x' where id = '11111111-0000-0000-0000-000000000000'$$) = 0, 'Ben, a member, renames the workspace');
select pg_temp.check(pg_temp.touched($$update projects set name = 'hacked' where id = 'c1000000-0000-0000-0000-000000000000'$$) = 0, 'Ben renames Cat''s project');
select pg_temp.check(pg_temp.touched($$delete from projects where id = 'c1000000-0000-0000-0000-000000000000'$$) = 0, 'Ben deletes Cat''s project');
select pg_temp.check(pg_temp.touched($$delete from env_secrets where id = 'c3000000-0000-0000-0000-000000000000'$$) = 0, 'Ben deletes Cat''s secret');
select pg_temp.fails($$insert into projects (workspace_id, name) values ('22222222-0000-0000-0000-000000000000', 'planted')$$, 'Ben adds a project to Cat''s workspace');
-- The trigger files the row under the project's real workspace, so row level security turns it away.
select pg_temp.fails($$insert into environments (project_id, workspace_id, name, base_url) values ('c1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'planted', 'https://evil.com')$$, 'Ben adds an environment to Cat''s project');
select pg_temp.fails($$update environments set project_id = 'c1000000-0000-0000-0000-000000000000' where id = 'a2000000-0000-0000-0000-000000000000'$$, 'Ben moves his environment into Cat''s project');
select pg_temp.fails($$insert into env_secrets (environment_id, workspace_id, name) values ('a2000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'RAW')$$, 'Ben writes a secret name without the server');
select pg_temp.fails($$select set_secret('c2000000-0000-0000-0000-000000000000', 'LOGIN_PASSWORD', 'v1:overwrite')$$, 'Ben overwrites Cat''s secret');
select pg_temp.fails($$select set_secret('a2000000-0000-0000-0000-000000000000', 'PLAIN', 'not-sealed')$$, 'Ben saves a secret the server did not seal');
select pg_temp.fails($$select set_secret('a2000000-0000-0000-0000-000000000000', 'bad name', 'v1:x')$$, 'Ben saves a secret with a bad name');
select pg_temp.check(set_secret('a2000000-0000-0000-0000-000000000000', 'LOGIN_EMAIL', 'v1:ok') is not null, 'Ben can''t save a secret in his own environment');
select pg_temp.check(pg_temp.touched($$insert into projects (workspace_id, name) values ('11111111-0000-0000-0000-000000000000', 'ben-app')$$) = 1, 'Ben can''t add a project to Acme');
select pg_temp.check(ensure_workspace() = '11111111-0000-0000-0000-000000000000', 'Ben gets a new workspace instead of Acme');
-- Tests, blocks and versions
select pg_temp.check((select count(*) from tests) = 1 and (select count(*) from blocks) = 1, 'Ben sees another workspace''s tests or blocks');
select pg_temp.check((select count(*) from test_versions) = 1, 'Ben sees another workspace''s test versions');
select pg_temp.check(pg_temp.touched($$update tests set name = 'hacked' where id = 'c5000000-0000-0000-0000-000000000000'$$) = 0, 'Ben renames Cat''s test');
select pg_temp.check(pg_temp.touched($$delete from blocks where id = 'c4000000-0000-0000-0000-000000000000'$$) = 0, 'Ben deletes Cat''s block');
select pg_temp.fails($$insert into tests (project_id, workspace_id, name) values ('c1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'planted')$$, 'Ben adds a test to Cat''s project');
select pg_temp.fails($$insert into blocks (project_id, workspace_id, name) values ('c1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'planted')$$, 'Ben adds a block to Cat''s project');
select pg_temp.fails($$update tests set project_id = 'c1000000-0000-0000-0000-000000000000' where id = 'a5000000-0000-0000-0000-000000000000'$$, 'Ben moves his test into Cat''s project');
select pg_temp.fails($$insert into test_versions (test_id, workspace_id, version, name, use_case, priority, steps) values ('a5000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 99, 'fake', 'x', 'low', '[]')$$, 'Ben writes a fake version');
select pg_temp.fails($$update test_versions set name = 'rewritten'$$, 'Ben rewrites history');
select pg_temp.fails($$delete from test_versions$$, 'Ben deletes history');
select pg_temp.fails($$insert into tests (project_id, name, steps) values ('a1000000-0000-0000-0000-000000000000', 'bad', '[{"id":"s1","kind":"run_sql","text":"x"}]')$$, 'Ben saves a step of an unknown kind');
select pg_temp.fails($$insert into tests (project_id, name, steps) values ('a1000000-0000-0000-0000-000000000000', 'bad', '"not a list"')$$, 'Ben saves steps that are not a list');
select pg_temp.fails($$insert into blocks (project_id, name, steps) values ('a1000000-0000-0000-0000-000000000000', 'nested', '[{"id":"s1","kind":"use","block":"a4000000-0000-0000-0000-000000000000"}]')$$, 'Ben puts a block inside a block');
-- Saving a change makes a new version with Ben as the author. Renaming nothing makes none.
update tests set steps = '[{"id":"s1","kind":"do","text":"Add a hoodie"},{"id":"s2","kind":"check","text":"The cart shows 1 item"},{"id":"s3","kind":"use","block":"a4000000-0000-0000-0000-000000000000"}]' where id = 'a5000000-0000-0000-0000-000000000000';
select pg_temp.check((select version from tests where id = 'a5000000-0000-0000-0000-000000000000') = 2, 'Changing steps did not bump the version');
select pg_temp.check((select author_id from test_versions where version = 2) = 'b0000000-0000-0000-0000-000000000000', 'A version has the wrong author');
update tests set steps = steps where id = 'a5000000-0000-0000-0000-000000000000';
select pg_temp.check((select count(*) from test_versions) = 2, 'Saving with no change made a new version');
-- Runs
select pg_temp.check(not exists (select 1 from runs) and not exists (select 1 from run_steps), 'Ben sees Cat''s runs');
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')$$, 'Ben starts a run of a test with no code');
reset role;
update tests set lock = 'test(''x'', async ({ page }) => {});' where id = 'a5000000-0000-0000-0000-000000000000';
set role authenticated;
select pg_temp.fails($$select start_run('c5000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben runs Cat''s test');
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben runs his test against Cat''s environment');
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 'schedule')$$, 'Ben starts a run pretending to be the scheduler');
select pg_temp.check(start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000') is not null, 'Ben can''t start a run of his own test');
select pg_temp.check((select count(*) from run_steps) = 3, 'A new run doesn''t get one row per step');
select pg_temp.check((select label from run_steps where position = 3) = 'Use acme-sign-in', 'A block step is labeled wrong');
select pg_temp.check((select label from run_steps where position = 2) = 'Check: The cart shows 1 item', 'A check step is labeled wrong');
select pg_temp.check((select created_by from runs) = 'b0000000-0000-0000-0000-000000000000' and (select status from runs) = 'queued', 'A new run has the wrong owner or status');
select pg_temp.fails($$update runs set status = 'passed'$$, 'Ben marks his own run as passed');
select pg_temp.fails($$update run_steps set status = 'passed'$$, 'Ben marks a step as passed');
select pg_temp.fails($$insert into runs (workspace_id, project_id, test_name, test_version, environment_name, base_url, lock, status) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'fake', 1, 'x', 'https://x.com', 'x', 'passed')$$, 'Ben writes a fake passing run');
select pg_temp.fails($$delete from runs$$, 'Ben deletes run history');
select pg_temp.fails($$select * from claim_run('ben')$$, 'Ben claims a run like the runner');
select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000') from generate_series(1, 4);
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')$$, 'Ben queues a sixth run at once');
select pg_temp.check((select count(*) from storage.objects) = 1 and (select name from storage.objects) like '11111111-%', 'Ben reads another workspace''s run files');
-- A save that expected an old version touches nothing, so the editor can tell someone else saved first.
select pg_temp.check(pg_temp.touched($$update tests set name = 'late' where id = 'a5000000-0000-0000-0000-000000000000' and version = 1$$) = 0, 'A stale save overwrote a newer version');
select pg_temp.check(pg_temp.touched($$insert into environments (project_id, name, base_url) values ('a1000000-0000-0000-0000-000000000000', 'production', 'https://acme.com')$$) = 1, 'Ben can''t add an environment to his own project');
select pg_temp.check((select workspace_id from environments where name = 'production') = '11111111-0000-0000-0000-000000000000', 'A new environment is filed under the wrong workspace');
reset role;

-- Cat (owner, Other) -------------------------------------------------------------------
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check(not exists (select 1 from projects where workspace_id = '11111111-0000-0000-0000-000000000000'), 'Cat sees Acme''s projects');
select pg_temp.check(not exists (select 1 from env_secrets where name = 'LOGIN_EMAIL'), 'Cat sees Acme''s secret names');
select pg_temp.check(not exists (select 1 from tests where name like 'acme%') and not exists (select 1 from test_versions where name like 'acme%'), 'Cat sees Acme''s tests or their history');
select pg_temp.check((select count(*) from runs) = 1 and (select count(*) from run_steps) = 1, 'Cat sees Acme''s runs');
select pg_temp.check((select count(*) from storage.objects) = 1 and (select name from storage.objects) like '22222222-%', 'Cat reads Acme''s run files');
select pg_temp.check((select count(*) from workspace_members) = 1, 'Cat sees Acme''s members');
reset role;

-- Eve (signed in, no workspace yet) ----------------------------------------------------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from projects) = 0, 'Eve sees projects before joining anything');
select pg_temp.check(ensure_workspace() is not null, 'Eve gets no workspace on first sign-in');
select pg_temp.check((select name from workspaces) = 'eve''s workspace', 'Eve''s workspace has the wrong name');
select pg_temp.check((select role from workspace_members) = 'owner', 'Eve is not the owner of her new workspace');
reset role;

-- Signed out ---------------------------------------------------------------------------
select pg_temp.as_user('');
set role anon;
select pg_temp.check(pg_temp.visible($$select count(*) from projects$$) = 0, 'A signed-out visitor sees projects');
select pg_temp.fails($$select ensure_workspace()$$, 'A signed-out visitor makes a workspace');
select pg_temp.fails($$select is_member('11111111-0000-0000-0000-000000000000')$$, 'A signed-out visitor calls is_member');
select pg_temp.fails($$select set_secret('a2000000-0000-0000-0000-000000000000', 'X', 'v1:x')$$, 'A signed-out visitor saves a secret');
reset role;

-- The runner claims the oldest waiting run first, and a quiet runner's run is taken again.
set role service_role;
reset role;
select pg_temp.check((select test_name from claim_run('w1')) = 'acme-checkout', 'The runner didn''t get the oldest waiting run');
select pg_temp.check((select count(*) from runs where status = 'running') = 1, 'Claiming didn''t mark the run as running');
update runs set locked_at = now() - interval '11 minutes' where status = 'running';
select pg_temp.check((select attempts from claim_run('w2')) = 2, 'A run from a quiet runner wasn''t taken again');

-- Values are kept, and deleting a secret's name deletes its value.
select pg_temp.check((select count(*) from env_secret_values) = 3, 'Sealed values went missing');
delete from env_secrets where id = 'a3000000-0000-0000-0000-000000000000';
select pg_temp.check(not exists (select 1 from env_secret_values where secret_id = 'a3000000-0000-0000-0000-000000000000'), 'Deleting a secret leaves its value behind');

\o
select 'All leak tests passed' as result;
