-- New workspaces start on the marketing platform.
alter table public.workspaces alter column features set default '{marketing}';
