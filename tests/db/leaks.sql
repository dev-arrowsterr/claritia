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
  ('a4000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'acme-sign-in', '[{"id":"s1","kind":"do","text":"Sign in"},{"id":"s2","kind":"check","text":"The dashboard shows"}]'),
  ('c4000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'cat-sign-in', '[]');
insert into tests (id, project_id, workspace_id, name, steps) values
  ('a5000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'acme-checkout', '[{"id":"s1","kind":"do","text":"Add a hoodie"}]'),
  ('c5000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'cat-test', '[]');

insert into runs (id, workspace_id, project_id, test_id, test_name, test_version, environment_id, environment_name, base_url, lock, status) values
  ('c6000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', 'c5000000-0000-0000-0000-000000000000', 'cat-test', 1, 'c2000000-0000-0000-0000-000000000000', 'staging', 'https://staging.other.com', 'x', 'passed');
insert into run_steps (run_id, workspace_id, position, kind, label) values ('c6000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 1, 'do', 'cat-step');
insert into workspace_billing (workspace_id, plan, stripe_customer_id) values ('11111111-0000-0000-0000-000000000000', 'starter', 'cus_acme');
insert into inbox_messages (workspace_id, project_id, to_address, subject, text_body) values
  ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'x-signup@inbox.tryclaritia.com', 'Acme code', 'Your code is 123456'),
  ('22222222-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', 'y-signup@inbox.tryclaritia.com', 'Cat code', 'Your code is 654321');
insert into heals (id, workspace_id, project_id, test_id, test_version, position, step_label, old_code, new_code, error) values
  ('a7000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 1, 1, 'Pay', 'old', 'new', 'broke'),
  ('a7100000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 1, 2, 'Ship', 'old', 'new', 'broke'),
  ('c7000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', 'c5000000-0000-0000-0000-000000000000', 1, 1, 'Cat', 'old', 'new', 'broke');
insert into schedules (id, project_id, workspace_id, environment_id, name, every) values
  ('c9000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000', 'cat-nightly', 'day');
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
-- Fails with a message that matches, so a different error doesn't pass for the right one.
create function pg_temp.fails_with(sql text, pattern text, what text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'LEAK TEST FAILED: % (it worked)', what;
exception when others then
  if sqlerrm like 'LEAK TEST FAILED%' then raise; end if;
  if sqlerrm not like pattern then raise exception 'LEAK TEST FAILED: % (wrong error: %)', what, sqlerrm; end if;
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
-- Plans: Acme is on Starter (3 projects). Ben can't change the plan, and the limit holds.
select pg_temp.check(pg_temp.touched($$insert into projects (workspace_id, name, inbox_id) values ('11111111-0000-0000-0000-000000000000', 'third', 'zzzz')$$) = 1, 'Ben can''t add a third project on Starter');
select pg_temp.fails_with($$insert into projects (workspace_id, name) values ('11111111-0000-0000-0000-000000000000', 'fourth')$$, '%plan includes 3 projects%', 'Ben adds a fourth project on Starter');
select pg_temp.check((select inbox_id from projects where name = 'third') <> 'zzzz', 'Ben picks his own inbox id');
select pg_temp.check(pg_temp.touched($$update projects set inbox_id = (select inbox_id from projects where name = 'acme-app') where name = 'third'$$) <= 1 and (select count(distinct inbox_id) from projects) = 3, 'Ben points a project at another project''s inbox');
select pg_temp.fails($$update workspace_billing set plan = 'team'$$, 'Ben upgrades his own plan');
select pg_temp.fails($$insert into workspace_billing (workspace_id, plan) values ('11111111-0000-0000-0000-000000000000', 'team')$$, 'Ben writes a plan');
select pg_temp.fails($$update workspaces set first_pass_at = now()$$, 'Ben fakes the first passing run time');
select pg_temp.check((select plan from workspace_billing) = 'starter' and (select count(*) from workspace_billing) = 1, 'Ben can''t read only his own plan');
select pg_temp.check((select plan from workspace_usage('11111111-0000-0000-0000-000000000000')) = 'starter' and (select minutes_limit from workspace_usage('11111111-0000-0000-0000-000000000000')) = 2000, 'Ben can''t see his usage');
select pg_temp.fails($$select * from workspace_usage('22222222-0000-0000-0000-000000000000')$$, 'Ben reads Cat''s usage');
-- Fixes from the Healer
select pg_temp.check((select count(*) from heals) = 2 and not exists (select 1 from heals where step_label = 'Cat'), 'Ben can''t see only his own fixes');
select pg_temp.fails($$insert into heals (workspace_id, project_id, test_id, test_version, position, step_label, old_code, new_code, error) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 1, 1, 'x', 'x', 'x', 'x')$$, 'Ben writes a fix himself');
select pg_temp.fails($$update heals set new_code = 'evil'$$, 'Ben edits a fix''s code');
select pg_temp.fails($$select decide_heal('c7000000-0000-0000-0000-000000000000', 'approved')$$, 'Ben approves Cat''s fix');
select pg_temp.fails($$select decide_heal('a7000000-0000-0000-0000-000000000000', 'merged')$$, 'Ben makes up a decision');
select decide_heal('a7000000-0000-0000-0000-000000000000', 'approved');
select pg_temp.check((select status from heals where id = 'a7000000-0000-0000-0000-000000000000') = 'approved' and (select decided_by from heals where id = 'a7000000-0000-0000-0000-000000000000') = 'b0000000-0000-0000-0000-000000000000', 'Ben''s approval isn''t recorded');
select pg_temp.fails_with($$select decide_heal('a7000000-0000-0000-0000-000000000000', 'rejected')$$, '%already approved%', 'Ben decides the same fix twice');
select pg_temp.fails($$select record_heal(id, 1, 'x', 'a', 'b', 'c') from runs limit 1$$, 'Ben records a fix as if he were the runner');
-- Schedules
select pg_temp.check(not exists (select 1 from schedules), 'Ben sees Cat''s schedules');
select pg_temp.fails($$insert into schedules (project_id, environment_id, name, every) values ('a1000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000', 'x', 'day')$$, 'Ben schedules his tests on Cat''s environment');
select pg_temp.fails($$insert into schedules (project_id, environment_id, name, every) values ('c1000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000', 'x', 'day')$$, 'Ben adds a schedule to Cat''s project');
select pg_temp.fails_with($$insert into schedules (project_id, environment_id, name, every, timezone) values ('a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 'x', 'day', 'Mars/Olympus')$$, '%Unknown time zone%', 'Ben saves a made-up time zone');
select pg_temp.check(pg_temp.touched($$insert into schedules (id, project_id, environment_id, name, every, at_hour, at_minute, timezone, next_run_at) values ('a9000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 'nightly', 'day', 2, 30, 'Asia/Tokyo', now() - interval '1 day')$$) = 1, 'Ben can''t add a schedule');
select pg_temp.check((select next_run_at from schedules) > now() and (select workspace_id from schedules) = '11111111-0000-0000-0000-000000000000', 'A new schedule didn''t get its own next run time and workspace');
select pg_temp.check(pg_temp.touched($$update schedules set last_run_at = now() - interval '1 year', last_count = 999 where id = 'a9000000-0000-0000-0000-000000000000'$$) = 1 and (select last_count from schedules) is null, 'Ben fakes when a schedule last ran');
select pg_temp.fails($$select fire_due_schedules()$$, 'Ben fires schedules like the runner');
select pg_temp.fails($$select * from app_config$$, 'Ben reads the server''s settings');
select pg_temp.fails($$update app_config set value = 'https://evil.example'$$, 'Ben points the runner wake-up somewhere else');
select pg_temp.fails($$select wake_runner()$$, 'Ben wakes the runner directly');
select pg_temp.fails($$select minute_tick()$$, 'Ben runs the minute tick');
-- Inboxes
select pg_temp.check((select count(*) from inbox_messages) = 1 and (select subject from inbox_messages) = 'Acme code', 'Ben can''t read only his own inbox');
select pg_temp.fails($$insert into inbox_messages (workspace_id, project_id, to_address) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'fake')$$, 'Ben plants an email');
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
insert into tests (id, project_id, name, steps) values ('a6000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'acme-empty', '[]');
select pg_temp.fails($$select start_run('a6000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')$$, 'Ben starts a run of a test with no steps');
select pg_temp.fails($$select save_written_lock(id, 'test(''x'', async ({ page }) => {});') from runs$$, 'Ben saves code as if the runner wrote it');
select pg_temp.fails($$select start_run('c5000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben runs Cat''s test');
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben runs his test against Cat''s environment');
select pg_temp.fails($$select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 'schedule')$$, 'Ben starts a run pretending to be the scheduler');
select pg_temp.check(start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000') is not null, 'Ben can''t start a run of his own test');
select pg_temp.check((select count(*) from run_steps) = 3, 'A new run doesn''t get one row per step');
select pg_temp.check((select label from run_steps where position = 3) = 'Use acme-sign-in', 'A block step is labeled wrong');
select pg_temp.check((select label from run_steps where position = 2) = 'Check: The cart shows 1 item', 'A check step is labeled wrong');
select pg_temp.check((select intent from run_steps where position = 1) = 'Add a hoodie' and (select intent from run_steps where position = 2) = 'The cart shows 1 item', 'A step''s intent is wrong');
select pg_temp.check((select intent from run_steps where position = 3) = E'Sign in\nCheck: The dashboard shows', 'A block step''s intent doesn''t list the block''s steps');
select pg_temp.check((select lock from runs) = '', 'A run of a test with no code doesn''t start with empty code');
select pg_temp.fails($$select save_written_lock(id, 'test(''x'', async ({ page }) => {});') from runs$$, 'Ben saves code as if the runner wrote it');
select pg_temp.check((select created_by from runs) = 'b0000000-0000-0000-0000-000000000000' and (select status from runs) = 'queued', 'A new run has the wrong owner or status');
select pg_temp.fails($$update runs set status = 'passed'$$, 'Ben marks his own run as passed');
select pg_temp.fails($$update runs set verdict = 'flaky'$$, 'Ben calls his own failure flaky');
select pg_temp.fails($$select retry_run(id) from runs limit 1$$, 'Ben re-runs a run like the runner');
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
select pg_temp.check((select count(*) from inbox_messages) = 1 and (select subject from inbox_messages) = 'Cat code', 'Cat reads Acme''s inbox');
select pg_temp.check(not exists (select 1 from workspace_billing), 'Cat sees Acme''s plan');
select pg_temp.fails_with($$insert into projects (workspace_id, name) values ('22222222-0000-0000-0000-000000000000', 'second')$$, '%plan includes 1 project%', 'Cat adds a second project on Free');
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

-- The runner saves the code it wrote, only while the test is as the run found it.
select pg_temp.check(save_written_lock((select id from runs where status = 'running'), 'test(''acme-checkout'', async ({ page }) => {});'), 'The runner couldn''t save code it wrote');
select pg_temp.check((select lock from tests where id = 'a5000000-0000-0000-0000-000000000000') like 'test(''acme-checkout''%', 'Saved code didn''t reach the test');
select pg_temp.check((select author_email from test_versions where test_id = 'a5000000-0000-0000-0000-000000000000' order by version desc limit 1) = 'Claritia', 'A version saved by the runner isn''t marked as Claritia''s');
select pg_temp.check((select lock_saved from runs where status = 'running'), 'The run doesn''t say its code was saved');
select pg_temp.check(not save_written_lock((select id from runs where status = 'queued' order by created_at limit 1), 'test(''stale'', async ({ page }) => {});'), 'A run of an older version overwrote newer code');
select pg_temp.check((select lock from tests where id = 'a5000000-0000-0000-0000-000000000000') not like '%stale%', 'Stale code reached the test');

-- Values are kept, and deleting a secret's name deletes its value.
select pg_temp.check((select count(*) from env_secret_values) = 3, 'Sealed values went missing');
delete from env_secrets where id = 'a3000000-0000-0000-0000-000000000000';
select pg_temp.check(not exists (select 1 from env_secret_values where secret_id = 'a3000000-0000-0000-0000-000000000000'), 'Deleting a secret leaves its value behind');

-- The runner records a fix; a newer fix for the same step replaces the older one, and the same fix twice is kept once.
select pg_temp.check(record_heal((select id from runs where test_id = 'a5000000-0000-0000-0000-000000000000' order by created_at limit 1), 2, 'Ship', 'old', 'newer', 'broke') is not null, 'The runner can''t record a fix');
select pg_temp.check((select status from heals where id = 'a7100000-0000-0000-0000-000000000000') = 'stale' and (select count(*) from heals where position = 2 and status = 'pending') = 1, 'An older fix for the same step is still waiting');
select pg_temp.check(record_heal((select id from runs where test_id = 'a5000000-0000-0000-0000-000000000000' order by created_at limit 1), 2, 'Ship', 'old', 'newer', 'broke') = (select id from heals where position = 2 and status = 'pending'), 'The same fix was saved twice');

-- Smart retries: a failed run is re-run once, with its steps; a re-run is never re-run; saved code is replayed.
insert into runs (id, workspace_id, project_id, test_id, test_name, test_version, environment_name, base_url, lock, status, lock_saved)
values ('a8000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 'acme-checkout', 1, 'staging', 'https://staging.acme.com', '', 'failed', true);
insert into run_steps (run_id, workspace_id, position, kind, label, intent) values
  ('a8000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 1, 'do', 'Add a hoodie', 'Add a hoodie'),
  ('a8000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 2, 'check', 'Check: Cart has 1', 'Cart has 1');
select pg_temp.check(retry_run('a8000000-0000-0000-0000-000000000000') is not null, 'A flaky run couldn''t be re-run');
select pg_temp.check((select trigger from runs where retry_of = 'a8000000-0000-0000-0000-000000000000') = 'retry' and (select status from runs where retry_of = 'a8000000-0000-0000-0000-000000000000') = 'queued', 'The re-run isn''t a queued retry');
select pg_temp.check((select retried_as from runs where id = 'a8000000-0000-0000-0000-000000000000') = (select id from runs where retry_of = 'a8000000-0000-0000-0000-000000000000'), 'The failed run doesn''t point at its re-run');
select pg_temp.check((select count(*) from run_steps where run_id = (select id from runs where retry_of = 'a8000000-0000-0000-0000-000000000000') and status = 'pending') = 2, 'The re-run didn''t get the steps');
select pg_temp.check((select lock from runs where retry_of = 'a8000000-0000-0000-0000-000000000000') = (select lock from tests where id = 'a5000000-0000-0000-0000-000000000000'), 'The re-run doesn''t replay the code the failed run saved');
select pg_temp.check(retry_run('a8000000-0000-0000-0000-000000000000') is null, 'A run was re-run twice');
select pg_temp.check(retry_run((select id from runs where retry_of = 'a8000000-0000-0000-0000-000000000000')) is null, 'A re-run was re-run');
select pg_temp.check(retry_run((select id from runs where status = 'queued' and retry_of is null limit 1)) is null, 'A run that didn''t fail was re-run');

-- Schedule times, in the schedule's own time zone.
select pg_temp.check(schedule_next('hour', 0, 15, 0, 'UTC', '2026-10-14 10:20:00+00') = '2026-10-14 11:15:00+00', 'Hourly at :15 picked the wrong time');
select pg_temp.check(schedule_next('hour', 0, 15, 0, 'UTC', '2026-10-14 10:05:00+00') = '2026-10-14 10:15:00+00', 'Hourly at :15 skipped this hour');
select pg_temp.check(schedule_next('day', 9, 0, 0, 'Asia/Tokyo', '2026-10-14 01:00:00+00') = '2026-10-15 00:00:00+00', 'Daily at 9:00 Tokyo picked the wrong time');
select pg_temp.check(schedule_next('day', 9, 0, 0, 'Asia/Tokyo', '2026-10-13 23:00:00+00') = '2026-10-14 00:00:00+00', 'Daily at 9:00 Tokyo skipped today');
select pg_temp.check(schedule_next('weekday', 9, 0, 0, 'UTC', '2026-10-17 10:00:00+00') = '2026-10-19 09:00:00+00', 'Weekdays ran on a weekend');
select pg_temp.check(schedule_next('week', 9, 0, 3, 'UTC', '2026-10-14 10:00:00+00') = '2026-10-21 09:00:00+00', 'Weekly on Wednesday picked the wrong day');
select pg_temp.check(schedule_next('day', 2, 30, 0, 'America/New_York', '2026-11-01 05:00:00+00') = '2026-11-01 07:30:00+00', 'Daily missed the clock change');

-- The runner fires due schedules: each queues its tests once, and tests still waiting aren't queued again.
set session_replication_role = replica;
update schedules set next_run_at = now() - interval '1 minute' where id = 'a9000000-0000-0000-0000-000000000000';
set session_replication_role = origin;
select pg_temp.check(fire_due_schedules() >= 1, 'A due schedule didn''t fire');
select pg_temp.check((select count(*) from runs where schedule_id = 'a9000000-0000-0000-0000-000000000000' and trigger = 'schedule' and status = 'queued') = (select count(*) from tests where project_id = 'a1000000-0000-0000-0000-000000000000' and jsonb_array_length(steps) > 0), 'A schedule didn''t queue each of its tests');
select pg_temp.check((select next_run_at from schedules where id = 'a9000000-0000-0000-0000-000000000000') > now() and (select last_count from schedules where id = 'a9000000-0000-0000-0000-000000000000') > 0, 'A fired schedule didn''t move to its next time');
set session_replication_role = replica;
update schedules set next_run_at = now() - interval '1 minute' where id = 'a9000000-0000-0000-0000-000000000000';
set session_replication_role = origin;
select fire_due_schedules();
select pg_temp.check((select last_count from schedules where id = 'a9000000-0000-0000-0000-000000000000') = 0 and (select count(*) from runs where schedule_id = 'a9000000-0000-0000-0000-000000000000') = (select count(*) from tests where project_id = 'a1000000-0000-0000-0000-000000000000' and jsonb_array_length(steps) > 0), 'A schedule queued tests that were still waiting');
select pg_temp.check(fire_due_schedules() = 0, 'A schedule fired before its time');

-- Without pg_net, queuing a run and the minute tick still work, and nothing is called.
update app_config set value = 'https://claritia-runner.fly.dev/' where key = 'runner_wake_url';
select minute_tick();
select pg_temp.check(not exists (select 1 from app_config where key = 'runner_last_wake'), 'A wake-up was recorded with no way to send it');

-- API keys: members make and revoke their own workspace's keys, nobody reads a key's hash,
-- and only the server signs in with a key or starts runs with one.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select create_api_key('11111111-0000-0000-0000-000000000000', 'CI', 'clr_abcd', repeat('a', 64));
select pg_temp.fails($$select create_api_key('22222222-0000-0000-0000-000000000000', 'CI', 'clr_abcd', repeat('b', 64))$$, 'Ben makes a key in Cat''s workspace');
select pg_temp.fails($$select key_hash from api_keys$$, 'Ben reads a key''s hash');
select pg_temp.check((select count(*) from api_keys) = 1, 'Ben can''t see his workspace''s key');
select pg_temp.fails($$insert into api_keys (workspace_id, name, prefix, key_hash) values ('11111111-0000-0000-0000-000000000000', 'x', 'clr_x', repeat('c', 64))$$, 'Ben adds a key without the server');
select pg_temp.fails($$select * from api_key_auth(repeat('a', 64))$$, 'Ben signs in with a key hash');
select pg_temp.fails($$select * from api_start_runs((select id from api_keys limit 1), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid])$$, 'Ben starts runs as the server');
select pg_temp.fails($$select * from api_start_runs((select id from api_keys limit 1), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid], 'mcp', null)$$, 'Ben starts agent runs as the server');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from api_keys) = 0, 'Cat sees Acme''s keys');
select pg_temp.fails($$select revoke_api_key((select id from public.api_keys where workspace_id = '11111111-0000-0000-0000-000000000000'))$$, 'Cat revokes Acme''s key');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select workspace_id from api_key_auth(repeat('a', 64))) = '11111111-0000-0000-0000-000000000000', 'The server can''t find a key''s workspace');
select pg_temp.check(not exists (select 1 from api_key_auth(repeat('f', 64))), 'An unknown key signs in');
select pg_temp.fails_with($$select * from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'c1000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000', array['c5000000-0000-0000-0000-000000000000'::uuid])$$, '%Project not found%', 'An Acme key starts runs in Cat''s project');
select pg_temp.fails_with($$select * from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['c5000000-0000-0000-0000-000000000000'::uuid])$$, '%Test not found%', 'An Acme key runs Cat''s test');
select pg_temp.check((select count(*) from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid])) = 1, 'A key can''t start a run');
select pg_temp.check((select count(*) from runs where trigger = 'api' and api_key_id is not null and created_by = 'b0000000-0000-0000-0000-000000000000') = 1, 'A key''s run doesn''t name its key and who made it');
create temp table mcp_run as select * from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid], 'mcp', 'https://pr-9.acme.dev');
select pg_temp.check((select r.trigger || ' ' || r.base_url from mcp_run x join runs r on r.id = x.run_id) = 'mcp https://pr-9.acme.dev', 'An agent''s run isn''t marked mcp on its own address');
select pg_temp.fails_with($$select * from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid], 'schedule')$$, '%Unknown trigger%', 'A key starts a run marked as a schedule');
select pg_temp.fails_with($$select * from api_start_runs((select id from api_keys where key_hash = repeat('a', 64)), 'a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', array['a5000000-0000-0000-0000-000000000000'::uuid], 'mcp', 'file:///etc/passwd')$$, '%Not a web address%', 'A key runs on something that isn''t a web address');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select revoke_api_key((select id from api_keys limit 1));
reset role;
select pg_temp.check(not exists (select 1 from api_key_auth(repeat('a', 64))), 'A revoked key still signs in');

-- GitHub: installations and checks are written by the server only; links stay inside their workspace.
insert into github_installations (id, workspace_id, account_login) values
  (101, '11111111-0000-0000-0000-000000000000', 'acme'),
  (202, '22222222-0000-0000-0000-000000000000', 'cat');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$insert into github_installations (id, workspace_id, account_login) values (303, '11111111-0000-0000-0000-000000000000', 'x')$$, 'Ben adds an installation without GitHub');
select pg_temp.check((select count(*) from github_installations) = 1, 'Ben sees installations outside Acme');
insert into github_links (id, project_id, installation_id, repo_id, repo_full_name, environment_id) values
  ('ab000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 101, 9001, 'acme/shop', 'a2000000-0000-0000-0000-000000000000');
select pg_temp.fails($$insert into github_links (project_id, installation_id, repo_id, repo_full_name, environment_id) values ('a1000000-0000-0000-0000-000000000000', 202, 9002, 'cat/app', 'a2000000-0000-0000-0000-000000000000')$$, 'Ben links Acme''s project through Cat''s installation');
select pg_temp.fails($$insert into github_links (project_id, installation_id, repo_id, repo_full_name, environment_id) values ('a1000000-0000-0000-0000-000000000000', 101, 9003, 'acme/x', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben links Acme''s project to Cat''s environment');
select pg_temp.fails($$insert into github_checks (workspace_id, link_id, installation_id, repo_full_name, head_sha, base_url) values ('11111111-0000-0000-0000-000000000000', 'ab000000-0000-0000-0000-000000000000', 101, 'acme/shop', repeat('a', 40), 'https://x.com')$$, 'Ben writes a check');
select pg_temp.fails($$select * from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('a', 40), 1)$$, 'Ben starts a check as the server');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from github_links) = 0, 'Cat sees Acme''s GitHub links');
update github_links set enabled = false;
reset role;
select pg_temp.check((select enabled from github_links where id = 'ab000000-0000-0000-0000-000000000000'), 'Cat turned off Acme''s GitHub link');
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select cardinality(run_ids) from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('a', 40), 7)) >= 1, 'A pull request didn''t queue the project''s tests');
select pg_temp.check((select count(*) from runs r join github_checks c on r.id = any (c.run_ids) where c.head_sha = repeat('a', 40) and r.trigger = 'ci' and r.base_url = 'https://staging.acme.com' and r.created_by = 'b0000000-0000-0000-0000-000000000000') >= 1, 'A check''s runs aren''t on the environment, as CI, by the person who linked it');
select pg_temp.check(not exists (select 1 from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('a', 40), 7)), 'The same commit got a second open check');
create temp table preview_check as select * from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('a', 40), 7, 'https://pr-7.acme.vercel.app');
select pg_temp.check((select r.base_url from preview_check c join runs r on r.id = c.run_ids[1]) = 'https://pr-7.acme.vercel.app', 'A preview deploy didn''t run on its own address');
select pg_temp.fails_with($$select * from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('b', 40), 7, 'javascript:alert(1)')$$, '%Not a web address%', 'A check runs on something that isn''t a web address');
update runs set status = 'passed' where id = (select run_ids[1] from preview_check);
-- PR-aware: only the picked tests run, an empty pick is a finished neutral check, and the pick's AI call counts.
create temp table picked_check as select * from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('c', 40), 8, null, array['a5000000-0000-0000-0000-000000000000'::uuid], '{"mode":"picked","reason":"Checkout changed"}', 1);
select pg_temp.check((select cardinality(run_ids) from picked_check) = 1 and (select selection ->> 'mode' from picked_check) = 'picked', 'A picked check didn''t run only the picked test');
create temp table none_check as select * from github_start_check('ab000000-0000-0000-0000-000000000000', repeat('d', 40), 9, null, '{}'::uuid[], '{"mode":"none","reason":"Only docs changed."}', 0);
select pg_temp.check((select status || ' ' || conclusion || ' ' || error from none_check) = 'done neutral Only docs changed.' and (select cardinality(run_ids) from none_check) = 0, 'An empty pick didn''t make a finished neutral check');
select pg_temp.check((select count(*) from github_checks where ai_calls = 1) = 1, 'A pick''s AI call isn''t saved');
select minute_tick();

-- Alerts: settings stay in their workspace, the Slack address is never readable, and only real failures alert.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select save_alert_settings('a1000000-0000-0000-0000-000000000000', array['qa@acme.com'], true, true, 'v1:sealed', 'abcd');
select pg_temp.fails($$select slack_sealed from alert_settings$$, 'Ben reads the sealed Slack address');
select pg_temp.check((select slack_hint from alert_settings where project_id = 'a1000000-0000-0000-0000-000000000000') = 'abcd', 'Ben can''t see his project''s alert settings');
select pg_temp.fails_with($$select save_alert_settings('a1000000-0000-0000-0000-000000000000', array['not an email'], true, true)$$, '%Not an email%', 'Alerts take something that isn''t an email');
select pg_temp.fails($$select * from alert_events$$, 'Ben reads the alert queue');
select pg_temp.fails($$insert into alert_settings (project_id, workspace_id) values ('c1000000-0000-0000-0000-000000000000', '22222222-0000-0000-0000-000000000000')$$, 'Ben writes alert settings without the server');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select save_alert_settings('a1000000-0000-0000-0000-000000000000', array['cat@other.com'], true, true)$$, 'Cat changes Acme''s alerts');
select pg_temp.check((select count(*) from alert_settings) = 0, 'Cat sees Acme''s alert settings');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select slack_sealed from alert_settings where project_id = 'a1000000-0000-0000-0000-000000000000') = 'v1:sealed', 'Saving without a new Slack address lost the old one');
create temp table alert_runs (name text, trig text, verdict text, retry_of_trig text, alerts boolean);
insert into alert_runs values
  ('scheduled app bug', 'schedule', 'app_bug', null, true),
  ('ci unsorted', 'ci', null, null, true),
  ('manual app bug', 'manual', 'app_bug', null, false),
  ('first flaky', 'schedule', 'flaky', null, false),
  ('setup', 'schedule', 'setup', null, false),
  ('flaky again on re-run', 'retry', 'flaky', 'schedule', true),
  ('re-run of a manual run', 'retry', 'app_bug', 'manual', false);
do $$
declare r record; parent uuid; rid uuid;
begin
  for r in select * from alert_runs loop
    parent := null;
    if r.retry_of_trig is not null then
      insert into runs (workspace_id, project_id, test_name, test_version, environment_name, base_url, lock, status, trigger)
      values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', r.name || ' (first)', 1, 'staging', 'https://x.com', '', 'failed', r.retry_of_trig)
      returning id into parent;
    end if;
    insert into runs (workspace_id, project_id, test_name, test_version, environment_name, base_url, lock, status, trigger, retry_of)
    values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', r.name, 1, 'staging', 'https://x.com', '', 'running', r.trig, parent)
    returning id into rid;
    update runs set status = 'failed', verdict = r.verdict where id = rid;
    if (exists (select 1 from alert_events where run_id = rid)) <> r.alerts then
      raise exception 'LEAK TEST FAILED: alert for "%" should be %', r.name, r.alerts;
    end if;
  end loop;
end $$;
insert into heals (workspace_id, project_id, test_id, test_version, position, step_label, old_code, new_code, error)
values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 1, 3, 'Pay', 'old', 'new', 'broke');
select pg_temp.check((select count(*) from alert_events where kind = 'heal') = 1, 'A fix waiting for approval didn''t alert');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select save_alert_settings('a1000000-0000-0000-0000-000000000000', '{}', true, true, null, null, true);
reset role;
select set_config('request.jwt.claim.sub', '', false);
insert into heals (workspace_id, project_id, test_id, test_version, position, step_label, old_code, new_code, error)
values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'a5000000-0000-0000-0000-000000000000', 1, 4, 'Ship', 'old', 'new', 'broke');
select pg_temp.check((select count(*) from alert_events where kind = 'heal') = 1, 'A project with nowhere to send alerts queued one');
select minute_tick();

-- Explorer: members start and stop explorations of their own projects; pages and links are written by the server only.
insert into tests (id, project_id, workspace_id, name, steps) values ('a5100000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '11111111-0000-0000-0000-000000000000', 'no-code-yet', '[{"id":"s1","kind":"do","text":"Sign in"}]');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails_with($$select start_exploration('a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 50, 'a5100000-0000-0000-0000-000000000000')$$, '%needs saved code%', 'A sign-in test with no code was taken');
create temp table x1 as select start_exploration('a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000', 500) as id;
select pg_temp.check((select max_pages from explorations where id = (select id from x1)) = 200, 'An exploration went past 200 pages');
select pg_temp.fails_with($$select start_exploration('a1000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')$$, '%already being explored%', 'Two explorations of one project at once');
select pg_temp.fails($$select start_exploration('c1000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben explores Cat''s project');
select pg_temp.fails($$select start_exploration('a1000000-0000-0000-0000-000000000000', 'c2000000-0000-0000-0000-000000000000')$$, 'Ben explores Cat''s environment');
select pg_temp.fails($$insert into app_pages (workspace_id, project_id, pattern, sample_url) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '/x', 'https://x.com/x')$$, 'Ben writes a page to the map');
select pg_temp.fails($$update explorations set status = 'done'$$, 'Ben marks an exploration done');
select pg_temp.fails($$select * from claim_exploration('me')$$, 'Ben claims an exploration as the runner');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from explorations) = 0, 'Cat sees Acme''s explorations');
select pg_temp.fails($$select cancel_exploration((select id from x1))$$, 'Cat stops Acme''s exploration');
reset role;
select set_config('request.jwt.claim.sub', '', false);
insert into app_pages (workspace_id, project_id, pattern, sample_url) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '/orders/:id', 'https://staging.acme.com/orders/1');
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from app_pages) = 0, 'Cat sees Acme''s app map');
delete from app_pages;
reset role;
select pg_temp.check((select count(*) from app_pages) = 1, 'Cat deleted a page from Acme''s map');
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select count(*) from claim_exploration('runner-1')) = 1, 'The runner can''t take a waiting exploration');
select pg_temp.check((select status from explorations where id = (select id from x1)) = 'running', 'A taken exploration isn''t running');
update explorations set duration_ms = 6 * 60000, ai_calls = 7 where id = (select id from x1);
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select cancel_exploration((select id from x1));
reset role;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select status from explorations where id = (select id from x1)) = 'canceled', 'Ben couldn''t stop his exploration');
select minute_tick();

-- Planner: members ask for plans and accept or dismiss proposals in their own projects; plans and proposals are
-- written by the runner only.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
create temp table p1 as select start_plan('a1000000-0000-0000-0000-000000000000', 'Users can apply coupons at checkout.') as id;
select pg_temp.fails_with($$select start_plan('a1000000-0000-0000-0000-000000000000')$$, '%already being made%', 'Two plans of one project at once');
select pg_temp.fails($$select start_plan('c1000000-0000-0000-0000-000000000000', 'x')$$, 'Ben plans Cat''s project');
select pg_temp.fails($$insert into test_proposals (workspace_id, project_id, name, steps) values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'x', '[]')$$, 'Ben writes a proposal');
select pg_temp.fails($$select * from claim_plan('me')$$, 'Ben claims a plan as the runner');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails_with($$select start_plan('c1000000-0000-0000-0000-000000000000')$$, '%Explore the app in Map first%', 'A plan with no map and no notes was taken');
select pg_temp.check((select count(*) from plans) = 0, 'Cat sees Acme''s plans');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select count(*) from claim_plan('runner-1')) = 1, 'The runner can''t take a waiting plan');
insert into test_proposals (id, workspace_id, project_id, plan_id, name, use_case, priority, steps) values
  ('ac000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', (select id from p1), 'Apply a coupon', 'Checkout', 'high',
   '[{"kind":"use","block":"a4000000-0000-0000-0000-000000000000"},{"kind":"use","block":"c4000000-0000-0000-0000-000000000000"},{"kind":"do","text":"Type SAVE10 into the coupon field"},{"kind":"check","text":"The total drops 10%"}]'),
  ('ac000000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', (select id from p1), 'Remove an item', 'Cart', 'medium', '[{"kind":"do","text":"Remove the hoodie"}]');
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from test_proposals) = 0, 'Cat sees Acme''s proposals');
select pg_temp.fails($$select accept_proposal('ac000000-0000-0000-0000-000000000001')$$, 'Cat accepts Acme''s proposal');
select pg_temp.fails($$select dismiss_proposal('ac000000-0000-0000-0000-000000000002')$$, 'Cat dismisses Acme''s proposal');
reset role;
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
create temp table t1 as select accept_proposal('ac000000-0000-0000-0000-000000000001') as id;
select pg_temp.check((select jsonb_array_length(steps) from tests where id = (select id from t1)) = 3, 'An accepted proposal kept a block from another project');
select pg_temp.check((select bool_and(length(s ->> 'id') = 8) from tests t, jsonb_array_elements(t.steps) s where t.id = (select id from t1)), 'An accepted proposal''s steps have no ids');
select pg_temp.check((select status from test_proposals where id = 'ac000000-0000-0000-0000-000000000001') = 'accepted', 'An accepted proposal isn''t marked accepted');
select pg_temp.fails_with($$select accept_proposal('ac000000-0000-0000-0000-000000000001')$$, '%already accepted%', 'A proposal accepted twice');
select dismiss_proposal('ac000000-0000-0000-0000-000000000002');
select pg_temp.fails($$select accept_proposal('ac000000-0000-0000-0000-000000000002')$$, 'A dismissed proposal was accepted');
reset role;
select set_config('request.jwt.claim.sub', '', false);
update plans set ai_calls = 10 where id = (select id from p1);
select pg_temp.check((select credits_used from workspace_usage('11111111-0000-0000-0000-000000000000')) >= 10, 'A plan''s AI credits aren''t counted');
select minute_tick();

-- Tunnels: members see their own workspace's open tunnels; only the relay writes them and only the runner looks them up.
insert into tunnels (id, workspace_id, ports) values ('ad000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', '{3000}');
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from tunnels) = 0, 'Cat sees Acme''s tunnels');
select pg_temp.fails($$insert into tunnels (workspace_id, ports) values ('22222222-0000-0000-0000-000000000000', '{22}')$$, 'Cat opens a tunnel without the relay');
select pg_temp.fails($$select * from open_tunnel('11111111-0000-0000-0000-000000000000')$$, 'Cat looks up Acme''s tunnel');
reset role;
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from tunnels) = 1, 'Ben can''t see his workspace''s tunnel');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select id from open_tunnel('11111111-0000-0000-0000-000000000000')) = 'ad000000-0000-0000-0000-000000000001', 'The runner can''t find an open tunnel');
update tunnels set last_seen_at = now() - interval '2 minutes' where id = 'ad000000-0000-0000-0000-000000000001';
select pg_temp.check(not exists (select 1 from open_tunnel('11111111-0000-0000-0000-000000000000')), 'A tunnel not seen for 2 minutes still counts as open');

-- Foundation (020): jobs are server-only, features only change on the server, owners read the audit log and privacy
-- requests, and nobody reads a suite connection's sealed key.
insert into suite_connections (workspace_id, product, base_url, key_sealed, key_hint, status) values
  ('11111111-0000-0000-0000-000000000000', 'omniscient', 'https://app.omniscient.example', 'v1:acme-omn', '…a1b2', 'ok'),
  ('22222222-0000-0000-0000-000000000000', 'omniscient', 'https://app.omniscient.example', 'v1:cat-omn', '…c3d4', 'ok');
insert into audit_log (workspace_id, actor, action, target) values
  ('11111111-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000', 'suite.connect', 'omniscient'),
  ('22222222-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000', 'suite.connect', 'omniscient');
insert into privacy_requests (workspace_id, kind, subject_hash, source) values
  ('11111111-0000-0000-0000-000000000000', 'erase', '\x00', 'app'),
  ('22222222-0000-0000-0000-000000000000', 'erase', '\x01', 'app');
select enqueue_job('11111111-0000-0000-0000-000000000000', 'stitch', 'dev-acme', '{}');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check(pg_temp.visible($$select count(*) from jobs$$) = 0, 'Ben sees the jobs queue');
select pg_temp.fails($$insert into jobs (kind) values ('stitch')$$, 'Ben adds a job');
select pg_temp.fails($$select enqueue_job('11111111-0000-0000-0000-000000000000', 'stitch', 'x', '{}')$$, 'Ben queues a job through the function');
select pg_temp.fails($$select * from claim_job('{stitch}', 'ben', 60, 1)$$, 'Ben claims a job');
select pg_temp.fails($$update workspaces set features = '{testing,marketing}'$$, 'Ben turns on features for his workspace');
select pg_temp.check((select count(*) from suite_connections) = 1 and (select key_hint from suite_connections) = '…a1b2', 'Ben can''t see only his own suite connection');
select pg_temp.fails($$select key_sealed from suite_connections$$, 'Ben reads a sealed suite key');
select pg_temp.fails($$insert into suite_connections (workspace_id, product, base_url, key_sealed) values ('11111111-0000-0000-0000-000000000000', 'arrowsterr', 'https://x.example', 'v1:x')$$, 'Ben saves a suite connection without the server');
select pg_temp.fails($$update suite_connections set status = 'ok'$$, 'Ben edits a suite connection');
select pg_temp.check((select count(*) from audit_log) = 0, 'Ben, a member, reads the audit log');
select pg_temp.check((select count(*) from privacy_requests) = 0, 'Ben, a member, reads privacy requests');
select pg_temp.fails($$insert into audit_log (workspace_id, action) values ('11111111-0000-0000-0000-000000000000', 'fake')$$, 'Ben writes the audit log');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from audit_log) = 1, 'Ann, the owner, can''t read only her audit log');
select pg_temp.check((select count(*) from privacy_requests) = 1, 'Ann, the owner, can''t read only her privacy requests');
select pg_temp.fails($$update privacy_requests set status = 'done'$$, 'Ann marks a privacy request done herself');
reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from suite_connections) = 1 and (select key_hint from suite_connections) = '…c3d4', 'Cat sees Acme''s suite connection');
reset role;
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Website intelligence (021): only owners add or change sites, members read their own workspace's visits, and the
-- day tables, salts, opt-outs and hop tokens are closed to people.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
create temp table s1 as select add_site('11111111-0000-0000-0000-000000000000', 'acme.com') as id;
select pg_temp.fails_with($$select add_site('11111111-0000-0000-0000-000000000000', 'acme.com')$$, '%already a site%', 'Ann adds the same site twice');
select pg_temp.fails($$select add_site('11111111-0000-0000-0000-000000000000', 'not a domain')$$, 'Ann adds a site that isn''t a domain');
select pg_temp.fails($$select add_site('22222222-0000-0000-0000-000000000000', 'evil.com')$$, 'Ann adds a site to Cat''s workspace');
reset role;
select set_config('request.jwt.claim.sub', '', false);
insert into sites (id, workspace_id, domain) values ('cd000000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'other.com');
insert into devices (id, workspace_id, site_id) values
  ('ae000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', (select id from s1)),
  ('ce000000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'cd000000-0000-0000-0000-000000000001');
insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy) values
  ('af000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', (select id from s1), 'ae000000-0000-0000-0000-000000000001', now(), now(), 'notice'),
  ('cf000000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'cd000000-0000-0000-0000-000000000001', 'ce000000-0000-0000-0000-000000000001', now(), now(), 'notice');
insert into events (id, workspace_id, session_id, day, kind, path) values
  (gen_random_uuid(), '11111111-0000-0000-0000-000000000000', 'af000000-0000-0000-0000-000000000001', current_date, 'view', '/pricing'),
  (gen_random_uuid(), '22222222-0000-0000-0000-000000000000', 'cf000000-0000-0000-0000-000000000001', current_date, 'view', '/secret-plans');
insert into opt_outs (site_id, device_hash) values ((select id from s1), '\x01');
insert into identity_evidence (id, workspace_id, site_id, device_id, source, level, identifiers) values
  (gen_random_uuid(), '11111111-0000-0000-0000-000000000000', (select id from s1), 'ae000000-0000-0000-0000-000000000001', 'form', 'asserted', '[{"kind":"email","value":"jane@acme.com"}]'),
  (gen_random_uuid(), '22222222-0000-0000-0000-000000000000', 'cd000000-0000-0000-0000-000000000001', 'ce000000-0000-0000-0000-000000000001', 'form', 'asserted', '[{"kind":"email","value":"cat@other.com"}]');
select pg_temp.check((select count(*) from salts) = 1, 'The daily salt wasn''t made');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from sites) = 1 and (select domain from sites) = 'acme.com', 'Ben can''t see only his own sites');
select pg_temp.check((select count(*) from sessions) = 1 and (select count(*) from devices) = 1, 'Ben sees another workspace''s visits');
select pg_temp.check((select count(*) from events) = 1 and (select path from events) = '/pricing', 'Ben sees another workspace''s events');
select pg_temp.fails(format('select count(*) from %I', 'events_' || to_char(current_date, 'YYYYMMDD')), 'Ben reads a day table directly');
select pg_temp.fails($$select add_site('11111111-0000-0000-0000-000000000000', 'ben.com')$$, 'Ben, a member, adds a site');
select pg_temp.fails($$insert into sites (workspace_id, domain) values ('11111111-0000-0000-0000-000000000000', 'planted.com')$$, 'Ben writes a site without the function');
select pg_temp.fails($$select update_site((select id from s1), p_paused => true)$$, 'Ben, a member, pauses the site');
select pg_temp.fails($$select remove_site('cd000000-0000-0000-0000-000000000001')$$, 'Ben removes Cat''s site');
select pg_temp.fails($$insert into events (id, workspace_id, session_id, day, kind) values (gen_random_uuid(), '11111111-0000-0000-0000-000000000000', 'af000000-0000-0000-0000-000000000001', current_date, 'view')$$, 'Ben writes an event');
select pg_temp.fails($$update sessions set person_id = gen_random_uuid()$$, 'Ben edits a session');
select pg_temp.check(pg_temp.visible($$select count(*) from salts$$) = 0, 'Ben reads the cookieless salt');
select pg_temp.check(pg_temp.visible($$select count(*) from opt_outs$$) = 0, 'Ben reads opt-outs');
select pg_temp.check(pg_temp.visible($$select count(*) from hop_nonces$$) = 0, 'Ben reads hop tokens');
select pg_temp.check((select count(*) from identity_evidence) = 1 and (select identifiers->0->>'value' from identity_evidence) = 'jane@acme.com', 'Ben sees another workspace''s identity evidence');
select pg_temp.fails($$insert into identity_evidence (id, workspace_id, source, level, identifiers) values (gen_random_uuid(), '11111111-0000-0000-0000-000000000000', 'form', 'verified', '[{"kind":"email","value":"x@y.com"}]')$$, 'Ben plants identity evidence');
select pg_temp.fails($$update identity_evidence set level = 'verified'$$, 'Ben raises an evidence level');
select pg_temp.fails($$select make_event_partitions(30)$$, 'Ben makes day tables');
select pg_temp.check(set_page_groups((select id from s1), '[{"pattern":"/pricing","grp":"pricing"},{"pattern":"/vs/*","grp":"compare","competitor":"Warmly"}]') = 2, 'Ben, a member, can''t set page groups');
select pg_temp.fails($$select set_page_groups('cd000000-0000-0000-0000-000000000001', '[{"pattern":"/x","grp":"pricing"}]')$$, 'Ben sets Cat''s page groups');
select pg_temp.fails($$select set_page_groups((select id from s1), '[{"pattern":"no-slash","grp":"pricing"}]')$$, 'Ben saves a page group that isn''t a path');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select update_site((select id from s1), p_extra_domains => '{acme.io}', p_event_retention_days => 60);
select pg_temp.check((select extra_domains from sites where id = (select id from s1)) = '{acme.io}' and (select event_retention_days from sites where id = (select id from s1)) = 60, 'Ann''s site settings didn''t save');
select pg_temp.fails($$select update_site((select id from s1), p_event_retention_days => 5)$$, 'Ann sets retention below 30 days');
select pg_temp.check((select count(*) from audit_log where action like 'site.%') >= 2, 'Site changes aren''t in the audit log');
reset role;
select set_config('request.jwt.claim.sub', '', false);
-- The day tables exist ahead, and old ones go.
select pg_temp.check(to_regclass('public.events_' || to_char(current_date + 7, 'YYYYMMDD')) is not null, 'Next week''s day table wasn''t made');
create table public.events_20000101 partition of public.events for values from ('2000-01-01') to ('2000-01-02');
select pg_temp.check(drop_old_event_partitions(180) >= 1 and to_regclass('public.events_20000101') is null, 'An old day table wasn''t dropped');
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select remove_site((select id from s1));
select pg_temp.check((select count(*) from sessions) = 0 and (select count(*) from events) = 0, 'Removing a site left its visits');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Identity (023, 024): members read their own people; nobody writes them directly; undo stays in the workspace;
-- only owners ask for erasure or export, and only owners read exports; identify secrets are never readable.
insert into persons (id, workspace_id, primary_email) values
  ('ab000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'jane@acme.com'),
  ('cb000000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'cat@other.com');
insert into identifiers (id, workspace_id, person_id, kind, value_clean, value_hash) values
  (gen_random_uuid(), '11111111-0000-0000-0000-000000000000', 'ab000000-0000-0000-0000-000000000001', 'email', 'jane@acme.com', '\x01'),
  (gen_random_uuid(), '22222222-0000-0000-0000-000000000000', 'cb000000-0000-0000-0000-000000000001', 'email', 'cat@other.com', '\x02');
insert into identity_settings (workspace_id, own_domains, identify_secrets_sealed) values ('11111111-0000-0000-0000-000000000000', '{acme.com}', 'v1:sealed');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from persons) = 1 and (select count(*) from identifiers) = 1, 'Ben sees another workspace''s people');
select pg_temp.fails($$insert into persons (id, workspace_id) values (gen_random_uuid(), '11111111-0000-0000-0000-000000000000')$$, 'Ben plants a person');
select pg_temp.fails($$update identifiers set person_id = null$$, 'Ben edits identifiers');
select pg_temp.fails($$select identify_secrets_sealed from identity_settings$$, 'Ben reads the identify secrets');
select pg_temp.check((select own_domains from identity_settings) = '{acme.com}', 'Ben can''t read his own identity settings');
select pg_temp.fails($$select unmerge_person('cb000000-0000-0000-0000-000000000001', '{}')$$, 'Ben unmerges Cat''s person');
select pg_temp.fails($$select privacy_request('ab000000-0000-0000-0000-000000000001', 'erase')$$, 'Ben, a member, erases a person');
select pg_temp.check(pg_temp.visible($$select count(*) from ip_cache$$) = 0 and pg_temp.visible($$select count(*) from erasures$$) = 0, 'Ben reads server-only identity tables');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
create temp table pr as select privacy_request('ab000000-0000-0000-0000-000000000001', 'export') as id;
reset role;
select set_config('request.jwt.claim.sub', '', false);
insert into privacy_exports (request_id, workspace_id, data) values ((select id from pr), '11111111-0000-0000-0000-000000000000', '{"person":"jane"}');
select pg_temp.check((select count(*) from jobs where kind = 'privacy') = 1, 'The export wasn''t queued');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from privacy_exports) = 0, 'Ben, a member, reads a privacy export');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from privacy_exports) = 1, 'Ann, the owner, can''t read her export');
reset role;
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Screens (027): read functions stay inside the member's workspace.
insert into accounts (id, workspace_id, domain, name) values
  ('aa000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000000', 'globex.com', 'Globex'),
  ('cc000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'secret-co.com', 'Secret Co');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check(jsonb_array_length(accounts_list('11111111-0000-0000-0000-000000000000')) = 1, 'Ben can''t list his own accounts');
select pg_temp.fails($$select accounts_list('22222222-0000-0000-0000-000000000000')$$, 'Ben lists Cat''s accounts');
select pg_temp.fails($$select account_detail('cc000000-0000-0000-0000-0000000000c1')$$, 'Ben opens Cat''s account');
select pg_temp.fails($$select account_timeline('cc000000-0000-0000-0000-0000000000c1')$$, 'Ben reads Cat''s account timeline');
select pg_temp.fails($$select visitors_live('22222222-0000-0000-0000-000000000000')$$, 'Ben watches Cat''s visitors');
select pg_temp.fails($$select site_health('22222222-0000-0000-0000-000000000000')$$, 'Ben reads Cat''s site keys');
select pg_temp.fails($$select set_icp('22222222-0000-0000-0000-000000000000', '{}')$$, 'Ben sets Cat''s ICP');
select pg_temp.fails($$select account_feedback_add('cc000000-0000-0000-0000-0000000000c1', 'good')$$, 'Ben leaves feedback on Cat''s account');
select account_feedback_add('aa000000-0000-0000-0000-0000000000a1', 'good');
select pg_temp.check((select count(*) from account_feedback) = 1, 'Ben''s feedback wasn''t saved');
reset role;
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Identity settings (029): only the owner sets the domains, and nobody reads the sealed secrets.
insert into identity_settings (workspace_id, identify_secrets_sealed) values ('11111111-0000-0000-0000-000000000000', 'sealed')
  on conflict (workspace_id) do update set identify_secrets_sealed = 'sealed';
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select set_identity_domains('11111111-0000-0000-0000-000000000000', '{acme.com}', '{}')$$, 'Ben, a member, sets the own domains');
select pg_temp.fails($$select set_identity_domains('22222222-0000-0000-0000-000000000000', '{acme.com}', '{}')$$, 'Ben sets Cat''s own domains');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select set_identity_domains('11111111-0000-0000-0000-000000000000', '{ann.io}', '{partner.io}');
select pg_temp.check((select own_domains from identity_settings where workspace_id = '11111111-0000-0000-0000-000000000000') = '{ann.io}', 'Ann, the owner, can''t set her own domains');
reset role;
select pg_temp.check((select identify_secrets_sealed from identity_settings where workspace_id = '11111111-0000-0000-0000-000000000000') = 'sealed', 'Setting domains wiped the secrets');
select set_config('request.jwt.claim.sub', '', false);

-- Person page and Privacy search (030).
insert into persons (id, workspace_id, primary_email) values ('cc000000-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-000000000000', 'hidden@secret-co.com');
insert into identifiers (id, workspace_id, person_id, kind, value_clean, value_hash) values
  ('cc000000-0000-0000-0000-0000000000d2', '22222222-0000-0000-0000-000000000000', 'cc000000-0000-0000-0000-0000000000d1', 'email', 'hidden@secret-co.com', '\x01');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select person_detail('cc000000-0000-0000-0000-0000000000d1')$$, 'Ben opens Cat''s person');
select pg_temp.fails($$select privacy_find('22222222-0000-0000-0000-000000000000', 'hidden@secret-co.com')$$, 'Ben searches Cat''s people');
select pg_temp.fails($$select privacy_find('11111111-0000-0000-0000-000000000000', 'hidden@secret-co.com')$$, 'Ben, a member, runs a privacy search');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check(jsonb_array_length(privacy_find('11111111-0000-0000-0000-000000000000', 'hidden@secret-co.com')) = 0, 'Ann finds Cat''s person from her own workspace');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Contacts (033): members read their own workspace's contacts and everything hung on them; writes that take a
-- cleaned email are server only; member actions stay inside the member's workspace; event months are unreachable.
select contacts_upsert('11111111-0000-0000-0000-000000000000', 'import', '[{"email":"jane@globex.com","email_clean":"jane@globex.com","email_class":"work","company_domain":"globex.com","fields":{"plan":"pro"},"basis":"opt_in"}]');
select contacts_upsert('22222222-0000-0000-0000-000000000000', 'import', '[{"email":"spy@secret-co.com","email_clean":"spy@secret-co.com","email_class":"work","company_domain":"secret-co.com","fields":{"plan":"x"},"basis":"opt_in"}]');
insert into topics (workspace_id, name) values ('22222222-0000-0000-0000-000000000000', 'Cat news');
insert into fields (workspace_id, object, key, label, type) values ('22222222-0000-0000-0000-000000000000', 'contact', 'secret', 'Secret', 'text');
insert into saved_views (workspace_id, screen, name, filters, created_by) values ('22222222-0000-0000-0000-000000000000', 'contacts', 'Cat view', '[]', 'c0000000-0000-0000-0000-000000000000');
create temp table cat_contact as select id from contacts where email_clean = 'spy@secret-co.com';
create temp table ben_contact as select id from contacts where email_clean = 'jane@globex.com';
grant select on cat_contact, ben_contact to authenticated;
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from contacts) = 1 and (select count(*) from companies) = 1, 'Ben sees another workspace''s contacts or companies');
select pg_temp.check((select count(*) from consents) = 1 and (select count(*) from field_writes w join contacts c on c.id = w.contact_id) = (select count(*) from field_writes), 'Ben sees another workspace''s consent or field history');
select pg_temp.check((select count(*) from contact_events) = 1, 'Ben sees another workspace''s contact events');
select pg_temp.check((select count(*) from topics) = 0 and (select count(*) from fields) = 0 and (select count(*) from saved_views) = 0, 'Ben sees Cat''s topics, fields or views');
select pg_temp.check(pg_temp.visible($$select count(*) from partitions.contact_events_$$ || to_char(now(), 'YYYY_MM')) = 0, 'Ben reads an event month directly');
select pg_temp.fails($$update contacts set title = 'x'$$, 'Ben edits contacts directly');
select pg_temp.fails($$insert into contacts (workspace_id, email, email_clean) values ('11111111-0000-0000-0000-000000000000', 'a@b.com', 'a@b.com')$$, 'Ben plants a contact');
select pg_temp.fails($$insert into consents (workspace_id, contact_id, channel, basis, status, source) select '11111111-0000-0000-0000-000000000000', id, 'email', 'opt_in', 'granted', 'app' from ben_contact$$, 'Ben writes consent directly');
select pg_temp.fails($$select contacts_upsert('11111111-0000-0000-0000-000000000000', 'import', '[{"email":"x@y.com","email_clean":"other@person.com"}]')$$, 'Ben writes contacts with an email the server didn''t clean');
select pg_temp.fails($$select contact_update((select id from ben_contact), 'manual', '{"email_clean":"z@z.com"}')$$, 'Ben changes a cleaned email directly');
select pg_temp.fails($$select imports_start('11111111-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000', 'x.csv', '{}')$$, 'Ben starts an import record');
select pg_temp.fails($$select contacts_where('22222222-0000-0000-0000-000000000000', '[]')$$, 'Ben calls the filter builder');
select pg_temp.fails($$select contact_events_roll()$$, 'Ben makes event months');
select pg_temp.fails($$select contacts_list('22222222-0000-0000-0000-000000000000')$$, 'Ben lists Cat''s contacts');
select pg_temp.fails($$select contacts_list('11111111-0000-0000-0000-000000000000', '[{"field":"f.secret","op":"is","values":["x"]}]')$$, 'Ben filters on Cat''s custom field');
select pg_temp.fails($$select contact_detail((select id from cat_contact))$$, 'Ben opens Cat''s contact');
select pg_temp.fails($$select contacts_delete('22222222-0000-0000-0000-000000000000', array[(select id from cat_contact)])$$, 'Ben removes Cat''s contacts');
select pg_temp.check(contacts_delete('11111111-0000-0000-0000-000000000000', array[(select id from cat_contact)]) = 0, 'Ben removes Cat''s contact through his own workspace');
select pg_temp.fails($$select contacts_export_log('22222222-0000-0000-0000-000000000000', 1)$$, 'Ben logs an export in Cat''s workspace');
select pg_temp.fails($$select field_add('22222222-0000-0000-0000-000000000000', 'contact', 'Mine', 'text')$$, 'Ben adds a field to Cat''s workspace');
select pg_temp.fails($$insert into saved_views (workspace_id, screen, name, filters) values ('22222222-0000-0000-0000-000000000000', 'contacts', 'x', '[]')$$, 'Ben saves a view in Cat''s workspace');
select pg_temp.fails($$insert into saved_views (workspace_id, screen, name, filters, created_by) values ('11111111-0000-0000-0000-000000000000', 'contacts', 'x', '[]', 'a0000000-0000-0000-0000-000000000000')$$, 'Ben saves a view as Ann');
insert into saved_views (workspace_id, screen, name, filters) values ('11111111-0000-0000-0000-000000000000', 'contacts', 'Ben view', '[{"field":"lifecycle","op":"is","values":["lead"]}]');
select pg_temp.check(jsonb_array_length(contacts_list('11111111-0000-0000-0000-000000000000')->'rows') = 1, 'Ben can''t list his own contacts');
select pg_temp.check((contact_detail((select id from ben_contact))->'contact'->>'email') = 'jane@globex.com', 'Ben can''t open his own contact');
select pg_temp.check((field_add('11111111-0000-0000-0000-000000000000', 'contact', 'Email', 'text')->>'key') = 'email_2', 'A custom field took a built-in key');
reset role;
select pg_temp.check((select count(*) from contacts where workspace_id = '22222222-0000-0000-0000-000000000000' and deleted_at is null) = 1, 'Cat''s contact was removed');
select pg_temp.check((select count(*) from saved_views where workspace_id = '11111111-0000-0000-0000-000000000000') = 1, 'Ben''s view wasn''t saved');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Records (034): custom objects, records, links, history, suppressions, views and which source wins stay in the
-- workspace; personal views stay with their owner; writes go through functions that check membership.
insert into objects (id, workspace_id, key, label, plural) values
  ('cd000000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000000', 'deal_room', 'Deal room', 'Deal rooms');
insert into records (id, workspace_id, object_id, name) values
  ('cd000000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000000', 'cd000000-0000-0000-0000-0000000000a1', 'Cat secret room');
insert into field_history (workspace_id, object, record_id, key, new, source) values
  ('22222222-0000-0000-0000-000000000000', 'deal_room', 'cd000000-0000-0000-0000-0000000000a2', 'name', '"x"', 'manual');
insert into suppressions (workspace_id, email_clean, reason, source) values ('22222222-0000-0000-0000-000000000000', 'gone@cat.com', 'unsubscribed', 'csv');
insert into field_order (workspace_id, object, key, classes) values ('22222222-0000-0000-0000-000000000000', 'contact', '*', '{crm}');
insert into saved_views (workspace_id, screen, name, filters, created_by, owner_id) values
  ('11111111-0000-0000-0000-000000000000', 'contacts', 'Ann only', '[]', 'a0000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from objects) = 0 and (select count(*) from records) = 0 and (select count(*) from field_history where object = 'deal_room') = 0, 'Ben sees Cat''s objects, records or history');
select pg_temp.check((select count(*) from suppressions) = 0 and (select count(*) from field_order) = 0, 'Ben sees Cat''s suppressions or field order');
select pg_temp.check((select count(*) from saved_views where name = 'Ann only') = 0, 'Ben sees Ann''s personal view');
select pg_temp.check(pg_temp.touched($$update saved_views set name = 'mine' where name = 'Ann only'$$) = 0, 'Ben renames Ann''s personal view');
select pg_temp.fails($$insert into records (workspace_id, object_id, name) values ('22222222-0000-0000-0000-000000000000', 'cd000000-0000-0000-0000-0000000000a1', 'x')$$, 'Ben writes records directly');
select pg_temp.fails($$insert into suppressions (workspace_id, email_clean, reason, source) values ('11111111-0000-0000-0000-000000000000', 'a@b.com', 'manual', 'x')$$, 'Ben writes suppressions directly');
select pg_temp.fails($$select record_set('deal_room', 'cd000000-0000-0000-0000-0000000000a2', 'name', '"mine"')$$, 'Ben edits Cat''s record');
select pg_temp.fails($$select record_detail('cd000000-0000-0000-0000-0000000000a2')$$, 'Ben opens Cat''s record');
select pg_temp.fails($$select records_list('22222222-0000-0000-0000-000000000000', 'deal_room')$$, 'Ben lists Cat''s records');
select pg_temp.fails($$select records_list('11111111-0000-0000-0000-000000000000', 'deal_room')$$, 'Ben lists Cat''s object through his own workspace');
select pg_temp.fails($$select record_create('22222222-0000-0000-0000-000000000000', 'deal_room', 'x')$$, 'Ben adds a record to Cat''s object');
select pg_temp.fails($$select records_delete('22222222-0000-0000-0000-000000000000', 'deal_room', array['cd000000-0000-0000-0000-0000000000a2'::uuid])$$, 'Ben removes Cat''s records');
select pg_temp.check(records_delete('11111111-0000-0000-0000-000000000000', 'deal_room', array['cd000000-0000-0000-0000-0000000000a2'::uuid]) = 0, 'Ben removes Cat''s record through his own workspace');
select pg_temp.fails($$select object_save('22222222-0000-0000-0000-000000000000', 'x', 'X', 'Xs')$$, 'Ben adds an object to Cat''s workspace');
select pg_temp.fails($$select object_delete('11111111-0000-0000-0000-000000000000', 'anything')$$, 'Ben, a member, deletes an object');
select pg_temp.fails($$select field_order_save('11111111-0000-0000-0000-000000000000', 'contact', '*', '{import}')$$, 'Ben, a member, changes which source wins');
select pg_temp.fails($$select field_delete('22222222-0000-0000-0000-000000000000', 'contact', 'secret')$$, 'Ben deletes Cat''s field');
select pg_temp.fails($$select records_bulk_set('22222222-0000-0000-0000-000000000000', 'contact', array[(select id from cat_contact)], 'title', '"x"')$$, 'Ben bulk edits Cat''s contacts');
select pg_temp.fails($$select records_bulk_set('11111111-0000-0000-0000-000000000000', 'contact', array[(select id from cat_contact)], 'title', '"x"')$$, 'Ben bulk edits Cat''s contact through his own workspace');
select pg_temp.fails($$select contacts_merge((select id from ben_contact), (select id from cat_contact))$$, 'Ben merges Cat''s contact into his');
select list_add('11111111-0000-0000-0000-000000000000', null, 'Ben list', array[(select id from cat_contact)]);
select pg_temp.check((select count(*) from segment_members) = 0, 'Ben put Cat''s contact on his list');
select pg_temp.check(workspace_people('22222222-0000-0000-0000-000000000000') is null, 'Ben lists Cat''s teammates');
select pg_temp.fails($$select merge_values('{}', 'manual', null, '{}', '{}', '{}')$$, 'Ben calls the merge helper');
select pg_temp.fails($$select field_value('11111111-0000-0000-0000-000000000000', 'text', '[]', 'x', '"y"')$$, 'Ben calls the value checker');
reset role;
select pg_temp.check((select name from records where id = 'cd000000-0000-0000-0000-0000000000a2') = 'Cat secret room' and (select deleted_at from records where id = 'cd000000-0000-0000-0000-0000000000a2') is null, 'Cat''s record changed');
select pg_temp.check((select title from contacts where email_clean = 'spy@secret-co.com') is null, 'Cat''s contact was edited');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Imports (035): files stay in their workspace's folder; undo stays in the workspace; the import machinery is
-- server only.
insert into storage.buckets (id, name) values ('imports', 'imports') on conflict do nothing;
insert into storage.objects (bucket_id, name) values ('imports', '22222222-0000-0000-0000-000000000000/u1/cat.csv');
insert into imports (id, workspace_id, file_name, status, undo_until) values
  ('ce000000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000000', 'cat.csv', 'done', now() + interval '1 day');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'imports') = 0, 'Ben sees Cat''s import files');
select pg_temp.fails($$insert into storage.objects (bucket_id, name) values ('imports', '22222222-0000-0000-0000-000000000000/u2/x.csv')$$, 'Ben uploads into Cat''s folder');
insert into storage.objects (bucket_id, name) values ('imports', '11111111-0000-0000-0000-000000000000/u3/ben.csv');
select pg_temp.check((select count(*) from imports where id = 'ce000000-0000-0000-0000-0000000000a1') = 0, 'Ben sees Cat''s import');
select pg_temp.fails($$select import_undo('ce000000-0000-0000-0000-0000000000a1')$$, 'Ben undoes Cat''s import');
select pg_temp.fails($$select import_undo_run('ce000000-0000-0000-0000-0000000000a1')$$, 'Ben runs an undo');
select pg_temp.fails($$select suppress('11111111-0000-0000-0000-000000000000', 'csv', '[]')$$, 'Ben writes suppressions');
select pg_temp.fails($$select import_lookup('22222222-0000-0000-0000-000000000000', array['spy@secret-co.com'])$$, 'Ben looks up Cat''s contacts');
select pg_temp.fails($$select imports_start('11111111-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000', 'x', '{}')$$, 'Ben starts an import record');
select pg_temp.fails($$select import_claim('ce000000-0000-0000-0000-0000000000a1')$$, 'Ben claims an import');
select pg_temp.fails($$select imports_files_to_prune()$$, 'Ben lists files to prune');
reset role;
select pg_temp.check((select status from imports where id = 'ce000000-0000-0000-0000-0000000000a1') = 'done', 'Cat''s import changed');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Sources (036): Ben (a member) sees Acme's sources but can't change them or read credentials; nobody sees Cat's;
-- the sync machinery is server only.
insert into sources (id, workspace_id, kind, name, account) values
  ('5a000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000000', 'hubspot', 'HubSpot', '1'),
  ('5c000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'hubspot', 'HubSpot', '2');
insert into source_secrets (source_id, sealed, hook_sealed) values
  ('5a000000-0000-0000-0000-0000000000a1', 'v1:acme-token', 'v1:acme-hook'),
  ('5c000000-0000-0000-0000-0000000000c1', 'v1:cat-token', 'v1:cat-hook');
insert into sync_log (workspace_id, source_id, direction, object, action) values
  ('22222222-0000-0000-0000-000000000000', '5c000000-0000-0000-0000-0000000000c1', 'in', 'contact', 'create');
insert into hook_events (workspace_id, source_id, dedupe, body) values
  ('22222222-0000-0000-0000-000000000000', '5c000000-0000-0000-0000-0000000000c1', 'd1', '{}');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from sources) = 1, 'Ben sees only Acme''s source');
select pg_temp.fails($$select * from source_secrets$$, 'Ben reads credentials');
select pg_temp.fails($$select * from hook_events$$, 'Ben reads webhook bodies');
select pg_temp.check((select count(*) from sync_log) = 0, 'Ben sees Cat''s sync log');
select pg_temp.fails($$select source_settings_save('5a000000-0000-0000-0000-0000000000a1', 'x', '{}')$$, 'Ben (a member) changes a source');
select pg_temp.fails($$select source_disconnect('5a000000-0000-0000-0000-0000000000a1')$$, 'Ben disconnects a source');
select pg_temp.fails($$select source_pause('5c000000-0000-0000-0000-0000000000c1', true)$$, 'Ben pauses Cat''s source');
select pg_temp.fails($$select source_sync_now('5c000000-0000-0000-0000-0000000000c1')$$, 'Ben syncs Cat''s source');
select pg_temp.fails($$select mapping_save('5c000000-0000-0000-0000-0000000000c1', 'contact', '[]')$$, 'Ben maps Cat''s source');
select pg_temp.check((select sync_retry(array(select id from sync_log))) = 0, 'Ben retries Cat''s sync log');
select pg_temp.fails($$select source_load('5c000000-0000-0000-0000-0000000000c1')$$, 'Ben loads a source with its credentials');
select pg_temp.fails($$select source_connect('11111111-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000', 'hubspot', 'x', 'y', 'v1:z')$$, 'Ben connects a source');
select pg_temp.fails($$select hook_stage('5c000000-0000-0000-0000-0000000000c1', 'd2', '{}')$$, 'Ben stages a webhook');
select pg_temp.fails($$select push_candidates('5c000000-0000-0000-0000-0000000000c1', null)$$, 'Ben reads push candidates');
select pg_temp.fails($$select companies_upsert('22222222-0000-0000-0000-000000000000', 'hubspot', '[]')$$, 'Ben writes Cat''s companies');
select pg_temp.fails($$select source_links_put('5c000000-0000-0000-0000-0000000000c1', 'contact', '[]')$$, 'Ben writes links');
select pg_temp.fails($$select sync_log_add('5c000000-0000-0000-0000-0000000000c1', '[]')$$, 'Ben writes the sync log');
select pg_temp.fails($$insert into sources (workspace_id, kind, name) values ('11111111-0000-0000-0000-000000000000', 'stripe', 'x')$$, 'Ben inserts a source');
select pg_temp.fails($$select events_ingest('5c000000-0000-0000-0000-0000000000c1', '[]')$$, 'Ben writes activity through a source');
select pg_temp.fails($$select records_ingest('5c000000-0000-0000-0000-0000000000c1', 'x', '[]')$$, 'Ben writes records through a source');
select pg_temp.fails($$select * from source_event_keys$$, 'Ben reads event keys');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select source_settings_save('5c000000-0000-0000-0000-0000000000c1', 'x', '{}')$$, 'Ann changes Cat''s source');
select source_pause('5a000000-0000-0000-0000-0000000000a1', true);
reset role;
select pg_temp.check((select status from sources where id = '5a000000-0000-0000-0000-0000000000a1') = 'paused', 'Ann (an owner) can''t pause her own source');
select pg_temp.check((select count(*) from hook_events where source_id = '5c000000-0000-0000-0000-0000000000c1') = 1, 'Cat''s webhook was touched');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Segments (037): Ben previews, saves and deletes only in Acme; refreshing and compiling rules are server only.
insert into segments (id, workspace_id, name, kind, rules) values
  ('5e000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat''s VIPs', 'dynamic', '{"op":"and","rules":[]}');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select segment_preview('22222222-0000-0000-0000-000000000000', '{"op":"and","rules":[]}')$$, 'Ben previews Cat''s contacts');
select pg_temp.fails($$select segment_save('22222222-0000-0000-0000-000000000000', null, 'x', '{"op":"and","rules":[]}')$$, 'Ben saves a segment in Cat''s workspace');
select pg_temp.fails($$select segment_save('11111111-0000-0000-0000-000000000000', '5e000000-0000-0000-0000-0000000000c1', 'mine now', '{"op":"and","rules":[]}')$$, 'Ben takes over Cat''s segment');
select pg_temp.fails($$select segment_delete('5e000000-0000-0000-0000-0000000000c1')$$, 'Ben deletes Cat''s segment');
select pg_temp.fails($$select segment_refresh_now('5e000000-0000-0000-0000-0000000000c1')$$, 'Ben refreshes Cat''s segment');
select pg_temp.fails($$select segment_refresh('5e000000-0000-0000-0000-0000000000c1')$$, 'Ben runs a refresh');
select pg_temp.fails($$select segment_where('22222222-0000-0000-0000-000000000000', '{"op":"and","rules":[]}')$$, 'Ben compiles rules');
select pg_temp.fails($$select segments_due()$$, 'Ben queues refreshes');
select pg_temp.check((select (segment_preview('11111111-0000-0000-0000-000000000000', '{"op":"and","rules":[]}')->>'count') is not null), 'Ben can''t preview Acme''s contacts');
reset role;
select pg_temp.check((select name from segments where id = '5e000000-0000-0000-0000-0000000000c1') = 'Cat''s VIPs', 'Cat''s segment changed');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Sending (039): Ben (a member) reads Acme's sending but can't change it; nobody reads Cat's; the send pipeline is
-- server only.
insert into sending_domains (id, workspace_id, domain, mail_from, tracking_host, status) values
  ('5f000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000000', 'mail.acme.com', 'bounce.mail.acme.com', 't.mail.acme.com', 'verified'),
  ('5f000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'mail.other.com', 'bounce.mail.other.com', 't.mail.other.com', 'verified');
insert into send_settings (workspace_id, from_email, address) values
  ('11111111-0000-0000-0000-000000000000', 'news@mail.acme.com', '1 Main St'),
  ('22222222-0000-0000-0000-000000000000', 'news@mail.other.com', '2 Side St');
insert into emails (id, workspace_id, name, kind, subject, html, text) values
  ('5f100000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat news', 'broadcast', 'Cat news', '<p>x</p>', 'x');
insert into email_messages (id, workspace_id, email_id, to_email, dedupe, status, ses_message_id) values
  ('5f200000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', '5f100000-0000-0000-0000-0000000000c1', 'cat-friend@x.com', 'c1', 'sent', 'ses-cat-1');
insert into topics (id, workspace_id, name) values ('5f300000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat topic');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from sending_domains) = 1, 'Ben sees a sending domain outside Acme');
select pg_temp.check((select count(*) from send_settings) = 1, 'Ben sees Cat''s sending settings');
select pg_temp.check((select count(*) from emails) = 0, 'Ben sees Cat''s emails');
select pg_temp.check((select count(*) from email_messages) = 0, 'Ben sees Cat''s messages');
select pg_temp.check((select count(*) from email_events) = 0, 'Ben sees Cat''s email events');
select pg_temp.fails($$select sending_domain_add('11111111-0000-0000-0000-000000000000', 'news.acme.com')$$, 'Ben (a member) adds a sending domain');
select pg_temp.fails($$select sending_domain_remove('5f000000-0000-0000-0000-0000000000a1')$$, 'Ben removes a sending domain');
select pg_temp.fails($$select sending_domain_check_now('5f000000-0000-0000-0000-0000000000c1')$$, 'Ben checks Cat''s domain');
select pg_temp.fails($$select send_settings_save('11111111-0000-0000-0000-000000000000', '{"address":"x"}')$$, 'Ben changes sending settings');
select pg_temp.fails($$select send_resume('11111111-0000-0000-0000-000000000000')$$, 'Ben resumes sending');
select pg_temp.fails($$select topic_save('11111111-0000-0000-0000-000000000000', null, 'x', true)$$, 'Ben adds a topic');
select pg_temp.fails($$select topic_delete('5f300000-0000-0000-0000-0000000000c1')$$, 'Ben deletes Cat''s topic');
select pg_temp.fails($$select email_guard('5f200000-0000-0000-0000-0000000000c1')$$, 'Ben runs the guard');
select pg_temp.fails($$select send_claim('22222222-0000-0000-0000-000000000000', 10)$$, 'Ben claims Cat''s messages');
select pg_temp.fails($$select send_done('5f200000-0000-0000-0000-0000000000c1', 'ok', 'x', null)$$, 'Ben records a send');
select pg_temp.fails($$select email_create('11111111-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000', '{}')$$, 'Ben creates an email directly');
select pg_temp.fails($$select email_queue('5f100000-0000-0000-0000-0000000000c1', '{}')$$, 'Ben queues Cat''s email');
select pg_temp.fails($$select email_queue_test('5f100000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-000000000000')$$, 'Ben queues a test');
select pg_temp.fails($$select ses_event_apply('{"kind":"complained","ses_message_id":"ses-cat-1","sns_id":"x"}')$$, 'Ben fakes a complaint');
select pg_temp.fails($$select email_click('5f200000-0000-0000-0000-0000000000c1', 0, true, '{}')$$, 'Ben fakes a click');
select pg_temp.fails($$select email_unsubscribe('5f200000-0000-0000-0000-0000000000c1', 'all')$$, 'Ben unsubscribes Cat''s contact');
select pg_temp.fails($$select email_unsubscribe_info('5f200000-0000-0000-0000-0000000000c1')$$, 'Ben reads unsubscribe info');
select pg_temp.fails($$select sending_domain_update('5f000000-0000-0000-0000-0000000000c1', null, '[]', 'failed')$$, 'Ben updates Cat''s domain');
select pg_temp.fails($$select sending_domain_load('5f000000-0000-0000-0000-0000000000c1')$$, 'Ben loads Cat''s domain');
select pg_temp.fails($$select sends_due()$$, 'Ben starts sends');
select pg_temp.fails($$select domain_checks_due()$$, 'Ben starts domain checks');
select pg_temp.fails($$select complaints_check('22222222-0000-0000-0000-000000000000')$$, 'Ben pauses Cat''s sending');
select pg_temp.fails($$insert into emails (workspace_id, name, kind, subject, html, text) values ('11111111-0000-0000-0000-000000000000', 'x', 'broadcast', 'x', 'x', 'x')$$, 'Ben inserts an email');
select pg_temp.fails($$update send_settings set paused = false$$, 'Ben writes sending settings');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select sending_domain_add('22222222-0000-0000-0000-000000000000', 'evil.other.com')$$, 'Ann adds a domain to Cat''s workspace');
select pg_temp.fails($$select sending_domain_add('11111111-0000-0000-0000-000000000000', 'mail.other.com')$$, 'Ann takes Cat''s domain');
select pg_temp.fails($$select sending_domain_remove('5f000000-0000-0000-0000-0000000000c1')$$, 'Ann removes Cat''s domain');
select pg_temp.fails($$select send_settings_save('22222222-0000-0000-0000-000000000000', '{}')$$, 'Ann changes Cat''s sending');
select pg_temp.fails($$select send_settings_save('11111111-0000-0000-0000-000000000000', '{"timezone":"Mars/Olympus"}')$$, 'Ann saves an unknown time zone');
select sending_domain_add('11111111-0000-0000-0000-000000000000', 'news.acme.com');
select send_settings_save('11111111-0000-0000-0000-000000000000', '{"from_email":"news@mail.acme.com","address":"1 Main St","quiet_start":22,"quiet_end":7,"timezone":"Asia/Tokyo"}');
reset role;
select pg_temp.check((select count(*) from sending_domains where workspace_id = '11111111-0000-0000-0000-000000000000') = 2, 'Ann (an owner) can''t add her own domain');
select pg_temp.check((select count(*) from jobs where kind = 'domain_check') = 1, 'Adding a domain doesn''t queue its check');
select pg_temp.check((select quiet_start = 22 and timezone = 'Asia/Tokyo' from send_settings where workspace_id = '11111111-0000-0000-0000-000000000000'), 'Ann can''t save sending settings');
select pg_temp.check((select status from email_messages where id = '5f200000-0000-0000-0000-0000000000c1') = 'sent', 'Cat''s message changed');
select pg_temp.check((select count(*) from topics where id = '5f300000-0000-0000-0000-0000000000c1') = 1, 'Cat''s topic was deleted');
select set_config('request.jwt.claim.sub', '', false);
delete from jobs;

-- Sync, part 2 (040): activity claims are server only; nobody reads another workspace's activity rows.
insert into activity_out (workspace_id, source_id, event_id, kind, status) values
  ('22222222-0000-0000-0000-000000000000', '5c000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-0000000000c1', 'email.sent', 'sent');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from activity_out) = 0, 'Ben sees Cat''s activity');
select pg_temp.fails($$select activity_candidates('5c000000-0000-0000-0000-0000000000c1', 10)$$, 'Ben reads Cat''s activity candidates');
select pg_temp.fails($$select activity_claim('5c000000-0000-0000-0000-0000000000c1', '[]')$$, 'Ben claims activity');
select pg_temp.fails($$select activity_done('5c000000-0000-0000-0000-0000000000c1', '[]')$$, 'Ben finishes activity');
select pg_temp.fails($$select mapping_save('5c000000-0000-0000-0000-0000000000c1', 'contact', '[{"col":"email","target":"email","wins":"crm"}]')$$, 'Ben sets who wins on Cat''s source');
reset role;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails($$select mapping_save('5a000000-0000-0000-0000-0000000000a1', 'contact', '[{"col":"email","target":"email","wins":"everyone"}]')$$, 'Ann saves a made-up winner');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Forms (041): members build forms in their own workspace only; answers and the submit path are server only.
insert into forms (id, workspace_id, name, fields, status) values
  ('61000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat form', '[{"key":"email","label":"Email","type":"email","maps_to":"email"}]', 'live');
insert into form_submissions (id, workspace_id, form_id, answers) values
  ('62000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', '61000000-0000-0000-0000-0000000000c1', '{"email":"friend@cat.com"}');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from forms) = 0, 'Ben sees Cat''s forms');
select pg_temp.check((select count(*) from form_submissions) = 0, 'Ben sees Cat''s form answers');
select pg_temp.fails($$select form_save('22222222-0000-0000-0000-000000000000', null, 'x', '[{"key":"email","label":"E","type":"email","maps_to":"email"}]', '{}')$$, 'Ben makes a form in Cat''s workspace');
select pg_temp.fails($$select form_save('11111111-0000-0000-0000-000000000000', '61000000-0000-0000-0000-0000000000c1', 'mine', '[{"key":"email","label":"E","type":"email","maps_to":"email"}]', '{}')$$, 'Ben takes over Cat''s form');
select pg_temp.fails($$select form_publish('61000000-0000-0000-0000-0000000000c1', false)$$, 'Ben takes down Cat''s form');
select pg_temp.fails($$select form_delete('61000000-0000-0000-0000-0000000000c1')$$, 'Ben deletes Cat''s form');
select pg_temp.fails($$select form_public('61000000-0000-0000-0000-0000000000c1', true)$$, 'Ben reads a form through the server path');
select pg_temp.fails($$select form_submit('61000000-0000-0000-0000-0000000000c1', '{}')$$, 'Ben writes an answer directly');
select pg_temp.fails($$select form_submission_link('62000000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-000000000000')$$, 'Ben links an answer');
select pg_temp.fails($$insert into forms (workspace_id, name) values ('11111111-0000-0000-0000-000000000000', 'x')$$, 'Ben inserts a form');
select form_save('11111111-0000-0000-0000-000000000000', null, 'Acme demo', '[{"key":"email","label":"E","type":"email","maps_to":"email"}]', '{}');
reset role;
select pg_temp.check((select count(*) from forms where workspace_id = '11111111-0000-0000-0000-000000000000') = 1, 'Ben (a member) can''t build a form in Acme');
select pg_temp.check((select status from forms where id = '61000000-0000-0000-0000-0000000000c1') = 'live', 'Cat''s form changed');
select set_config('request.jwt.claim.sub', '', false);

-- Nurture (042): members build in their own workspace only; enrolling, advancing and the AI cache are server only.
insert into nurtures (id, workspace_id, name, trigger) values ('63000000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat nurture', '{}');
insert into emails (id, workspace_id, name, kind, subject, html, text) values ('63100000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', 'Cat step', 'journey', 'Hi', 'x', 'x');
insert into nurture_steps (id, workspace_id, nurture_id, position, email_id) values ('63200000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000000', '63000000-0000-0000-0000-0000000000c1', 0, '63100000-0000-0000-0000-0000000000c1');
insert into ai_cache (workspace_id, kind, key, output, model) values ('22222222-0000-0000-0000-000000000000', 'nurture_draft', repeat('a', 64), '{"secret":"cat"}', 'm');
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.check((select count(*) from nurtures) = 0, 'Ben sees Cat''s nurtures');
select pg_temp.check((select count(*) from nurture_steps) = 0, 'Ben sees Cat''s steps');
select pg_temp.fails($$select * from ai_cache$$, 'Ben reads the AI cache');
select pg_temp.fails($$select nurture_step_approve('63200000-0000-0000-0000-0000000000c1')$$, 'Ben approves Cat''s step');
select pg_temp.fails($$select nurture_step_save('63000000-0000-0000-0000-0000000000c1', '63200000-0000-0000-0000-0000000000c1', 1, 'mine', '', 'x', 'x', '{}')$$, 'Ben rewrites Cat''s step');
select pg_temp.fails($$select nurture_step_change('63200000-0000-0000-0000-0000000000c1', 'delete')$$, 'Ben deletes Cat''s step');
select pg_temp.fails($$select nurture_set_status('63000000-0000-0000-0000-0000000000c1', 'paused')$$, 'Ben pauses Cat''s nurture');
select pg_temp.fails($$select nurture_delete('63000000-0000-0000-0000-0000000000c1')$$, 'Ben deletes Cat''s nurture');
select pg_temp.fails($$select nurture_save('22222222-0000-0000-0000-000000000000', null, 'x', '{"kind":"segment"}', null, '', '{}')$$, 'Ben makes a nurture in Cat''s workspace');
select pg_temp.fails($$select nurture_enroll(null)$$, 'Ben enrolls people');
select pg_temp.fails($$select nurture_advance(10)$$, 'Ben sends nurture steps');
select pg_temp.fails($$select ai_cache_get('22222222-0000-0000-0000-000000000000', 'nurture_draft', repeat('a', 64))$$, 'Ben reads Cat''s AI cache');
select pg_temp.fails($$select ai_cache_put('22222222-0000-0000-0000-000000000000', 'nurture_draft', repeat('b', 64), '{}', 'm', 0, 0)$$, 'Ben writes the AI cache');
reset role;
select pg_temp.check((select approved_at is null from nurture_steps where id = '63200000-0000-0000-0000-0000000000c1'), 'Cat''s step was approved');
select set_config('request.jwt.claim.sub', '', false);

-- Cloud minutes: once Acme has used its 2,000, nobody there can start a run.
insert into runs (workspace_id, project_id, test_name, test_version, environment_name, base_url, lock, status, duration_ms)
values ('11111111-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', 'long', 1, 'staging', 'https://x.com', '', 'passed', 2000 * 60000);
select pg_temp.as_user('b0000000-0000-0000-0000-000000000000');
set role authenticated;
select pg_temp.fails_with($$select start_run('a5000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')$$, '%cloud minutes are used up%', 'Ben starts a run past the plan''s cloud minutes');
reset role;
select pg_temp.check((select minutes_used from workspace_usage('11111111-0000-0000-0000-000000000000')) >= 2000, 'The server can''t read a workspace''s usage');

\o
select 'All leak tests passed' as result;
