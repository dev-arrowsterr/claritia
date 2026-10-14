-- MCP: agents (Claude Code, Cursor) start runs with an API key like the REST API, marked as 'mcp' runs, and can
-- point them at another address, such as the preview deploy of the change they just made.

drop function if exists public.api_start_runs(uuid, uuid, uuid, uuid[]);

create or replace function public.api_start_runs(p_key uuid, p_project uuid, p_env uuid, p_tests uuid[], p_trigger text default 'api', p_base_url text default null)
returns table (run_id uuid, test_id uuid, test_name text)
language plpgsql security definer set search_path = public as $$
declare
  k api_keys;
  e environments;
  t tests;
  u record;
  busy int;
  wanted int;
  rid uuid;
begin
  if p_trigger not in ('api', 'mcp') then
    raise exception 'Unknown trigger';
  end if;
  select * into k from api_keys where id = p_key and revoked_at is null;
  if k.id is null then
    raise exception 'This API key was revoked';
  end if;
  if not exists (select 1 from projects where id = p_project and projects.workspace_id = k.workspace_id) then
    raise exception 'Project not found';
  end if;
  select * into e from environments where id = p_env and project_id = p_project;
  if e.id is null then
    raise exception 'Environment not found';
  end if;
  if nullif(trim(p_base_url), '') is not null then
    if trim(p_base_url) !~ '^https?://[^\s/]+' then
      raise exception 'Not a web address: %', p_base_url;
    end if;
    e.base_url := trim(p_base_url);
  end if;
  select count(*) into wanted from tests where id = any (p_tests) and project_id = p_project;
  if wanted <> coalesce(cardinality(p_tests), 0) or wanted = 0 then
    raise exception 'Test not found';
  end if;
  if exists (select 1 from tests where id = any (p_tests) and jsonb_array_length(coalesce(steps, '[]')) = 0) then
    raise exception 'Add a step to every test first';
  end if;
  select * into u from workspace_usage(k.workspace_id);
  if u.minutes_limit is not null and u.minutes_used >= u.minutes_limit then
    raise exception 'This month''s % cloud minutes are used up. Upgrade in Settings to keep running tests.', u.minutes_limit;
  end if;
  select count(*) into busy from runs where runs.workspace_id = k.workspace_id and status in ('queued', 'running') and trigger in ('api', 'mcp');
  if busy + wanted > 50 then
    raise exception '% runs from API keys are already waiting or running in this workspace. Up to 50 can wait at once.', busy;
  end if;

  for t in select * from tests where id = any (p_tests) order by use_case, name loop
    rid := queue_run(t, e, p_trigger, k.created_by);
    update runs set api_key_id = k.id where id = rid;
    run_id := rid;
    test_id := t.id;
    test_name := t.name;
    return next;
  end loop;
end;
$$;

revoke execute on function public.api_start_runs(uuid, uuid, uuid, uuid[], text, text) from public, anon, authenticated;
grant execute on function public.api_start_runs(uuid, uuid, uuid, uuid[], text, text) to service_role;
