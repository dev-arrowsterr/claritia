-- The Judge: each failed run is sorted into an app bug, a flaky test or a setup problem, with a one-line reason.
alter table public.runs add column if not exists verdict text check (verdict in ('app_bug', 'flaky', 'setup'));
alter table public.runs add column if not exists verdict_reason text;
