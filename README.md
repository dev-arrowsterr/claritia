# Claritia

Tests that write and fix themselves. Describe a user flow in plain English, and Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes.

This repo holds the marketing site (`/` on tryclaritia.com) and the app (app.tryclaritia.com). The vision lives in `docs/vision.md`, Phase 1 in `docs/plan.md`, the homepage plan in `docs/homepage.md`, and the brand notes in `docs/brand.md`.

## What works today (Weeks 1–4)

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

## The runner

A separate Render service built from `worker/Dockerfile`. It needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and the same `SECRETS_KEY` as the web service. `WORKER_SLOTS` (default 2) sets how many runs it does at once. Run files go to the private `runs` bucket in Supabase Storage.

The AI writer needs `ANTHROPIC_API_KEY` on the runner. `CLAUDE_MODEL` (default `claude-opus-5-5`) and `CLAUDE_EFFORT` (`low`, `medium` or `high`, default `medium`) are optional. Calls use adaptive thinking, structured output, prompt caching on the instructions, and the server-side fallback beta (`fallbacks: "default"`), which re-runs a declined request on another Claude model.

Local checks that need Chromium:

```bash
CHROMIUM_PATH=/path/to/chrome node scripts/runner-check.ts   # the runner against a local site
CHROMIUM_PATH=/path/to/chrome node scripts/worker-check.ts   # the run handler with a stand-in database
CHROMIUM_PATH=/path/to/chrome node scripts/writer-check.ts   # the AI writer with a scripted stand-in for Claude
```

### What the AI writer costs (all prices "check")

Claude Opus 5.5 at $4 per million input tokens and $20 per million output tokens. One writer call sends about 7,000 tokens (instructions, page tree, fields, screenshot) and gets back 1,000 to 2,000 (thinking plus the lines): about $0.05 to $0.07. A step takes 1 to 2 calls, so writing a new step costs about $0.10. Replaying saved code costs nothing. Live frames are deleted when a run ends, so they add no storage.

Assuming each team writes or rewrites 150 steps a month:

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude tokens (writer) | about $750 | about $7,500 |
| New servers | $0 | $0 |
| **Added each month** | **about $750** | **about $7,500** |

## Setup

1. **Supabase:** run each file in `supabase/migrations` in order (SQL Editor). Under Authentication → URL Configuration, set the Site URL to `https://app.tryclaritia.com` and add `https://app.tryclaritia.com/**` and `http://localhost:3000/**` to the redirect list. Under Providers, turn on Google and GitHub.
2. **Render:** add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SECRETS_KEY` (32+ random characters, never change it once secrets are saved).

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
