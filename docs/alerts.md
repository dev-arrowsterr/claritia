# Alerts: Slack and email

Settings → Alerts, per project: a Slack incoming webhook, up to 20 emails, and what to alert on.

| Alerts | Doesn't alert |
|---|---|
| A test that failed for real: an app bug, a failure the Judge couldn't sort, or a flaky test that failed again on its re-run | A first flaky failure (it's re-run first) |
| A fix from the Healer waiting for approval | Setup problems (site down, missing secret) |
| Runs from schedules, pull requests (GitHub) and API keys | Runs a person started by hand |

Alerts are grouped: every minute, each project gets at most one Slack message and one email listing everything queued since the last one. Each failure links to its run; each fix has **Review fix**, which opens it in Approvals, switching to its project, ready to approve in one click. A fix already decided by the time the alert goes out is left out.

**Send test** sends a sample alert to the saved Slack and emails.

## How it works

- `supabase/migrations/014_alerts.sql`: triggers on `runs` and `heals` queue `alert_events` when the project has somewhere to send them. `minute_tick` calls `POST /api/alerts/send` (pg_net, with the same secret as the GitHub sync) while any are queued.
- `src/lib/alertSender.ts` sends one message per project to Slack and to Resend. If every channel fails, it tries again each minute, up to 5 times. If one channel works, the alert counts as sent, so it never repeats there.
- The Slack address is sealed with `SECRETS_KEY` like other secrets. People only see its last 4 characters.

## Setup

1. **Slack** (per project, by the customer): Slack → Apps → **Incoming Webhooks** → Add to a channel → copy the address into Settings → Alerts.
2. **Email** (once): in Resend, verify `tryclaritia.com` for sending (Domains → Add domain → add the DNS records it shows in Hostinger). Alerts come from `Claritia <alerts@tryclaritia.com>`, or set `ALERTS_FROM` on the web app.
3. The database already knows where to send (`app_config.alerts_url` = `https://app.tryclaritia.com/api/alerts/send`).

## Running cost

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Slack | $0 | $0 |
| Email (Resend) | $0 on the free plan (3,000 a month, 100 a day, check) or $20 Pro (50,000 a month, check) | $20 Pro, or $90 Scale past 50,000 a month (check) |
| Servers | $0: runs on the existing Fly web app | $0 |

Grouping by minute keeps the email count low: a schedule that fails 10 tests sends one email, not 10.
