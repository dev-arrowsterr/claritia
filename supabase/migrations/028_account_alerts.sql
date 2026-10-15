-- Account alerts to Slack (docs/m1-website-intelligence.md 8.3): the webhook is sealed by the server and never
-- readable by people. Rules are written through /api/account-alerts.
alter table public.account_alert_rules add column if not exists slack_sealed text;
alter table public.account_alert_rules add column if not exists slack_hint text;
revoke select on public.account_alert_rules from authenticated;
grant select (id, workspace_id, user_id, rule, channel, quiet_hours, daily_cap, enabled, created_at, slack_hint) on public.account_alert_rules to authenticated;
