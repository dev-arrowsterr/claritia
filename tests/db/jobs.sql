-- The jobs queue (supabase/migrations/020_foundation.sql): dedupe by key, one at a time per key, leases that run
-- out, retries with backoff, and finishing by the wrong worker. Runs as the server.
\set ON_ERROR_STOP on
set client_min_messages = warning;
\o /dev/null

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'JOBS TEST FAILED: %', what; end if;
end $$;

insert into workspaces (id, name) values ('99999999-0000-0000-0000-000000000000', 'Queue test');
create temp table ids (name text primary key, id uuid);

-- Dedupe: three adds with the same key make one waiting job with the last payload and the earliest start.
insert into ids select 'a', enqueue_job('99999999-0000-0000-0000-000000000000', 'stitch', 'dev-1', '{"n":1}', 60);
select pg_temp.check(enqueue_job('99999999-0000-0000-0000-000000000000', 'stitch', 'dev-1', '{"n":2}', 0) = (select id from ids where name = 'a'), 'A second add with the same key made a new job');
select enqueue_job('99999999-0000-0000-0000-000000000000', 'stitch', 'dev-1', '{"n":3}', 600);
select pg_temp.check((select count(*) from jobs where kind = 'stitch') = 1, 'Same key made more than one waiting job');
select pg_temp.check((select payload->>'n' from jobs where kind = 'stitch') = '3', 'The waiting job didn''t take the newest payload');
select pg_temp.check((select run_after <= now() + interval '1 second' from jobs where kind = 'stitch'), 'The waiting job lost its earlier start time');
-- The same key in another workspace, and no key at all, don't collapse.
select enqueue_job(null, 'stitch', 'dev-1', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000000', 'stitch', '', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000000', 'stitch', '', '{}');
select pg_temp.check((select count(*) from jobs where kind = 'stitch') = 4, 'Jobs with no key, or another workspace, collapsed');
delete from jobs;

-- Claiming: only the kinds asked for, only ready jobs, oldest first.
select enqueue_job('99999999-0000-0000-0000-000000000000', 'score', 'acct-1', '{}');
select enqueue_job('99999999-0000-0000-0000-000000000000', 'score', 'acct-later', '{}', 3600);
select enqueue_job('99999999-0000-0000-0000-000000000000', 'other', 'x', '{}');
insert into ids select 'c1', id from claim_job('{score}', 'w1', 60, 10);
select pg_temp.check((select count(*) from ids where name = 'c1') = 1, 'Claimed a job not ready yet, or of another kind');
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'c1')) = 'running'
  and (select attempts from jobs where id = (select id from ids where name = 'c1')) = 1, 'A claimed job isn''t running with one attempt');
select pg_temp.check(not exists (select 1 from claim_job('{score}', 'w2', 60, 10)), 'A second worker took a job already taken');

-- One at a time per key: a new job for a key that is running waits until the running one finishes.
select enqueue_job('99999999-0000-0000-0000-000000000000', 'score', 'acct-1', '{"again":true}');
select pg_temp.check((select count(*) from jobs where key = 'acct-1') = 2, 'An add while running didn''t wait in line');
select pg_temp.check(not exists (select 1 from claim_job('{score}', 'w2', 60, 10)), 'Two jobs for the same key ran at once');
select pg_temp.check(not finish_job((select id from ids where name = 'c1'), 'w2', true), 'Another worker finished a job it didn''t hold');
select pg_temp.check(finish_job((select id from ids where name = 'c1'), 'w1', true), 'The worker couldn''t finish its job');
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'c1')) = 'done', 'A finished job isn''t done');
insert into ids select 'c2', id from claim_job('{score}', 'w2', 60, 10);
select pg_temp.check((select payload->>'again' from jobs where id = (select id from ids where name = 'c2')) = 'true', 'The waiting job for the key didn''t run after the first finished');

-- Retries: a failure waits 1 minute, then 5; the last attempt fails for good.
select finish_job((select id from ids where name = 'c2'), 'w2', false, 'IPinfo said 503');
select pg_temp.check((select status = 'queued' and run_after between now() + interval '55 seconds' and now() + interval '65 seconds' and error = 'IPinfo said 503'
  from jobs where id = (select id from ids where name = 'c2')), 'The first retry doesn''t wait a minute');
update jobs set run_after = now() where id = (select id from ids where name = 'c2');
select from claim_job('{score}', 'w2', 60, 10);
select finish_job((select id from ids where name = 'c2'), 'w2', false, 'again');
select pg_temp.check((select run_after > now() + interval '4 minutes' from jobs where id = (select id from ids where name = 'c2')), 'The second retry doesn''t wait 5 minutes');
update jobs set run_after = now(), attempts = max_attempts - 1 where id = (select id from ids where name = 'c2');
select from claim_job('{score}', 'w2', 60, 10);
select finish_job((select id from ids where name = 'c2'), 'w2', false, 'still broken');
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'c2')) = 'failed', 'The last attempt didn''t fail for good');
-- Don't try again at all.
insert into ids select 'n', enqueue_job('99999999-0000-0000-0000-000000000000', 'score', 'acct-2', '{}');
select from claim_job('{score}', 'w1', 60, 10);
select finish_job((select id from ids where name = 'n'), 'w1', false, 'bad input', -1);
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'n')) = 'failed', 'A job marked not to retry was retried');

-- Leases: a worker that stops answering loses its job, which goes back in line and runs again.
insert into ids select 'l', enqueue_job('99999999-0000-0000-0000-000000000000', 'lookup', 'net-1', '{}');
select from claim_job('{lookup}', 'dead', 60, 1);
select pg_temp.check(extend_job((select id from ids where name = 'l'), 'dead', 120), 'The worker couldn''t keep its lease');
update jobs set locked_until = now() - interval '1 second' where id = (select id from ids where name = 'l');
insert into ids select 'l2', id from claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check((select id from ids where name = 'l2') = (select id from ids where name = 'l'), 'A job with a lapsed lease wasn''t taken again');
select pg_temp.check((select attempts from jobs where id = (select id from ids where name = 'l')) = 2, 'A retaken job didn''t count the attempt');
select pg_temp.check(not finish_job((select id from ids where name = 'l'), 'dead', true), 'The worker that lost the lease still finished the job');
select pg_temp.check(not extend_job((select id from ids where name = 'l'), 'dead', 60), 'The worker that lost the lease still kept it');
select finish_job((select id from ids where name = 'l'), 'alive', true);
-- A lapsed job whose key already has a newer job waiting is dropped, and the newer one runs.
insert into ids select 'old', enqueue_job('99999999-0000-0000-0000-000000000000', 'lookup', 'net-2', '{"v":"old"}');
select from claim_job('{lookup}', 'dead', 60, 1);
select enqueue_job('99999999-0000-0000-0000-000000000000', 'lookup', 'net-2', '{"v":"new"}');
update jobs set locked_until = now() - interval '1 second' where id = (select id from ids where name = 'old');
insert into ids select 'new', id from claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check((select payload->>'v' from jobs where id = (select id from ids where name = 'new')) = 'new', 'The newer job for the key didn''t run');
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'old')) = 'done', 'The replaced job wasn''t closed');
-- A lapsed job on its last attempt fails instead of running again.
insert into ids select 'last', enqueue_job('99999999-0000-0000-0000-000000000000', 'lookup', 'net-3', '{}', 0, 1);
select from claim_job('{lookup}', 'dead', 60, 1);
update jobs set locked_until = now() - interval '1 second' where id = (select id from ids where name = 'last');
select from claim_job('{lookup}', 'alive', 60, 1);
select pg_temp.check((select status from jobs where id = (select id from ids where name = 'last')) = 'failed', 'A lapsed job on its last attempt ran again');

-- Old finished jobs are cleared.
update jobs set finished_at = now() - interval '8 days' where status = 'done';
select prune_jobs();
select pg_temp.check(not exists (select 1 from jobs where status = 'done'), 'Old finished jobs weren''t cleared');
select pg_temp.check(exists (select 1 from jobs where status = 'failed'), 'Recent failed jobs were cleared');

delete from jobs;
delete from workspaces where id = '99999999-0000-0000-0000-000000000000';
\o
select 'All jobs tests passed' as result;
