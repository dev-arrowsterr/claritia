# Claritia

Tests that write and fix themselves. Describe a user flow in plain English, and Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes.

This repo holds the marketing site (`/` on tryclaritia.com) and the app (app.tryclaritia.com). The vision lives in `docs/vision.md`, Phase 1 in `docs/plan.md`, the homepage plan in `docs/homepage.md`, and the brand notes in `docs/brand.md`.

## What works today (Weeks 1–6)

- Sign in with Google, GitHub or an email link. Your first sign-in makes a workspace.
- The first screen asks for a site address and an optional test login, then makes the project and its `staging` environment.
- Settings: rename or delete a project, add environments, edit their address, add and delete secrets, rename the workspace, sign out.
- Secret values are sealed with AES-256-GCM on the server (`src/lib/seal.ts`) before they reach the database. Members see secret names only. The values table has no access for signed-in users at all.
- Tests: a list grouped by use case, and an editor with plain-English steps (Do, Check, or Use a block). Enter adds a step, Backspace on an empty step removes it, Alt+Up/Down or the drag handle moves it, Cmd+S saves.
- Each test has four tabs: Steps, YAML (editable, same format as `.claritia/tests/*.yaml`, see `src/lib/testfile.ts`), Code (the Playwright lock) and History (every saved version, with restore).
- Blocks: reusable steps such as signing in, used in tests with `- use: sign-in`. A block in use can't be deleted.
- Saves only go through over the version you opened, so two people can't overwrite each other without knowing. Leaving with unsaved changes asks first.
- Code tab: the test's Playwright code (the lock), editable. It's checked on save against what Claritia can run (`src/lib/lock.ts`): page actions, element actions, keyboard, and expect checks, with secrets as `process.env.NAME`. Claritia never runs it as JavaScript.
- Runs: **Run** starts a run on the project's environment. The runner (`worker/`) opens a fresh Chromium, carries out each step, retries a failed step once, and saves a video, a trace, a screenshot after each step and the page's console. The run page updates live, jumps the video to a step when you click it, and opens the trace in Playwright's Trace Viewer.
- Runs can't reach private network addresses, and secret values are hidden in errors, console logs and traces.
- AI writer: **Run** works on a test with no code. For each step with no code, the runner sends Claude the step, the page's accessibility tree, its form fields and a screenshot (`worker/writer.ts`). Claude replies with Playwright lines. Each line is checked against the same allowed list as the Code tab, then run. A line that fails goes back to Claude with the error, up to five tries per step. Passing code is saved to the test (`save_written_lock`, only if nobody changed the test during the run), so the next run replays it with no AI calls. A step whose words change is written again. The run page shows a live view of the browser, a Written tag and the code for each step.
- Run page tabs: Screenshots, Console, Network (every request with its status and time, failures in red) and Emails (mail that reached the run's test inboxes), plus Trace.
- Test page tabs: Steps, YAML, Code, Preview (the latest run's video with its steps) and Run log (every run of the test).
- Test inboxes: each project has an inbox id. `inbox.address('signup')` in a test is a fresh address for that run, like `a1b2c3d4-signup-1f2e3d@inbox.tryclaritia.com`. `inbox.code('signup')` and `inbox.link('signup', /verify/)` wait up to a minute for the email and read the code or link from it. `await inbox.waitFor('signup', /Welcome/)` waits for a subject. The writer uses these when a step signs up or needs a code. Mail is kept 7 days.
- First screens: the start screen can fill in a demo site (`demo.playwright.dev/todomvc`), and an empty test list offers "Try" tests to start from.
- Plans: Free, Starter ($49) and Team ($199), from `src/lib/plans.ts`. Settings shows the plan, cloud minutes, AI credits and projects used this period, with Upgrade (Stripe Checkout) and Manage billing (Stripe's billing page). Limits hold in the database: a new project past the plan's limit is refused, a run can't start once the cloud minutes are used, and the runner stops writing once the AI credits are used.
- Healer: when a step's saved code fails even after its retry, the runner sends Claude the old code, the error and the page as it is now, keeping the lines that already ran. If the new code gets the step through, the step passes with a Healed tag and the fix goes to **Approvals** as a diff. The test's code only changes when someone approves it (saved as a normal version with their name). If what the step needs is gone, or a check is plainly false, Claude says so and the step fails with that reason. A slow page that passes on its retry never calls Claude. Each fix uses AI credits like writing does.
- `tryclaritia.com/llms.txt` and `tryclaritia.com/pricing.md` describe Claritia and its pricing for AI agents.
- Time to a first passing test is tracked: `workspaces.first_pass_at` is set by the first passing run. See "Launch numbers" below.

## The runner

A separate Render service built from `worker/Dockerfile`. It needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and the same `SECRETS_KEY` as the web service. `WORKER_SLOTS` (default 2) sets how many runs it does at once. Run files go to the private `runs` bucket in Supabase Storage.

The AI writer needs `ANTHROPIC_API_KEY` on the runner. `CLAUDE_MODEL` (default `claude-opus-5-5`) and `CLAUDE_EFFORT` (`low`, `medium` or `high`, default `medium`) are optional. Calls use adaptive thinking, structured output, prompt caching on the instructions, and the server-side fallback beta (`fallbacks: "default"`), which re-runs a declined request on another Claude model.

Local checks that need Chromium:

```bash
CHROMIUM_PATH=/path/to/chrome node scripts/runner-check.ts   # the runner against a local site
CHROMIUM_PATH=/path/to/chrome node scripts/worker-check.ts   # the run handler with a stand-in database
CHROMIUM_PATH=/path/to/chrome node scripts/writer-check.ts   # the AI writer with a scripted stand-in for Claude
CHROMIUM_PATH=/path/to/chrome node scripts/inbox-check.ts    # sign-up with an emailed code and link, and the network log
CHROMIUM_PATH=/path/to/chrome node scripts/heal-check.ts     # the Healer on a page that changed, a page that lost a button, and a slow page
```

### What the AI writer costs (all prices "check")

Claude Opus 5.5 at $4 per million input tokens and $20 per million output tokens. One writer call sends about 7,000 tokens (instructions, page tree, fields, screenshot) and gets back 1,000 to 2,000 (thinking plus the lines): about $0.05 to $0.07. A step takes 1 to 2 calls, so writing a new step costs about $0.10. Replaying saved code costs nothing. Live frames are deleted when a run ends, so they add no storage.

Assuming each team writes or rewrites 150 steps a month:

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude tokens (writer) | about $750 | about $7,500 |
| New servers | $0 | $0 |
| **Added each month** | **about $750** | **about $7,500** |

### What the Healer adds to the bill (all prices "check")

A fix takes 1 to 2 Claude calls, about $0.10. Assuming each team gets 10 fixes a month as their apps change:

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude tokens (Healer) | about $50 | about $500 |
| New servers | $0 | $0 |
| **Added each month** | **about $50** | **about $500** |

### What Weeks 5 and 6 add to the bill (all prices "check")

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Resend receiving (test inboxes) | $0 on your current plan (check) | a paid Resend plan for the mail volume, about $20 (check) |
| Stripe fees | 2.9% + $0.30 a charge: about $90 on 50 teams at $49 | about $1,900 on 500 teams averaging $120 |
| Storage for network logs and email | about $0 | about $1 |
| New servers | $0 | $0 |
| **Added each month** | **about $90** | **about $1,920** |

Stripe's fee comes out of revenue, so it grows only with paying customers.

## Setup

1. **Supabase:** run each file in `supabase/migrations` in order (SQL Editor). Under Authentication → URL Configuration, set the Site URL to `https://app.tryclaritia.com` and add `https://app.tryclaritia.com/**` and `http://localhost:3000/**` to the redirect list. Under Providers, turn on Google and GitHub.
2. **Render:** add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SECRETS_KEY` (32+ random characters, never change it once secrets are saved). The web service also needs `SUPABASE_SECRET_KEY` for the mail and Stripe webhooks.
3. **Test inboxes (Resend):** in Resend, add the domain `inbox.tryclaritia.com`, turn on receiving, and add the MX record it shows at the domain registrar. Add a webhook for the `email.received` event to `https://app.tryclaritia.com/api/inbox/resend`. Put a full-access API key in `RESEND_API_KEY` on the web service. No webhook secret is needed: the app fetches each email back from Resend with the key before it saves it.
4. **Billing (Stripe):** set `STRIPE_SECRET_KEY` on the web service. That's all: prices come from `src/lib/plans.ts`, and the first checkout makes the webhook to `/api/billing/webhook` in Stripe, and the first "Manage billing" makes the billing page. The webhook needs no signing secret, because each event is fetched back from Stripe with the secret key before it's used.

## Local development

```bash
cp .env.example .env.local   # fill it in
npm install
npm run dev                  # http://localhost:3000
```

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run test:db   # leak tests: needs a local Postgres, set DATABASE_URL to a superuser connection
npm run build
```

## Deploy

One Render service (`claritia`) serves both domains. `src/proxy.ts` sends `/` on `tryclaritia.com` to the site, and everything on `app.tryclaritia.com` to the app (`/start` for now). `www.` goes to the bare domain.

Add `tryclaritia.com`, `www.tryclaritia.com` and `app.tryclaritia.com` under the web service's Custom Domains, then add the DNS records Render shows at your domain registrar.

## Launch numbers

Time from sign-up to a first passing test, per workspace (run in the Supabase SQL editor):

```sql
select w.name, w.created_at, w.first_pass_at, w.first_pass_at - w.created_at as time_to_pass
from workspaces w order by w.created_at desc;
```

