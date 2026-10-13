# Claritia plan: AI end-to-end testing

**One line:** Describe a user flow in plain English. Claritia turns it into a Playwright test, runs it on every push, and fixes it when the UI changes.

**Who it's for first:** startups and small product teams (2 to 30 engineers) who ship fast, have no QA team, and hate fixing broken tests. Second: solo devs and vibe coders using Claude Code or Cursor.

**Model to follow:** Momentic (AI test platform, usage credits) plus TestSprite (agent inside the IDE). BrowserStack-style infrastructure and QA Wolf-style services come later, on top of the platform.

## Stack (same as Omniscient)

| Piece | Where |
|---|---|
| Web app and marketing site (Next.js) | Render web service, proxy splits `app.` from the main domain |
| Test runner (Playwright in Docker) | Render background workers |
| Job queue | Postgres table with `FOR UPDATE SKIP LOCKED` (no extra service at first) |
| Database, sign-in | Supabase |
| Videos, traces, screenshots | Cloudflare R2 (no download fees) |
| AI | Anthropic API: a small fast model for steps, a bigger one for writing and sorting failures |
| Billing | Stripe |

## The product in layers

1. **Test engine**: Playwright runner in Docker, job queue, retries, parallel runs, timeouts. Video, screenshots, trace and console logs saved for every run.
2. **The AI agent (the edge)**: plain English to steps, explore mode, tests from a PRD, self-healing with a fix to approve, plain-English checks, failure sorting (bug, flake, setup), step caching, and a knowledge base of product rules.
3. **Developer workflow**: YAML tests in the customer's repo, CLI, GitHub Action with a PR comment, MCP server for Claude Code and Cursor, export to plain Playwright.
4. **Platform**: dashboard with history and flaky tracking, schedules with Slack and email alerts, test inboxes and SMS numbers, saved logins, environments with secrets, a tunnel for localhost and private staging, a Chrome recorder.
5. **More kinds of testing**: API, visual compare, accessibility, basic speed, mobile web sizes, then native apps.
6. **Browser grid**: many browsers and regions in parallel. Rent from a provider first.
7. **Enterprise**: SSO, roles, audit logs, SOC 2, runners in the customer's cloud.
8. **Managed service**: "we write and keep your top 50 flows green" as a paid add-on.

## Roadmap

| Phase | Time | Build | Goal |
|---|---|---|---|
| 1. Core loop | Weeks 1–6 | Layer 1, plain English to steps, run viewer, sign-up, billing, homepage | A stranger runs their first test in 5 minutes |
| 2. Stickiness | Months 2–4 | Self-healing, failure sorting, step caching, schedules, Slack alerts, CLI, GitHub Action | Tests stay green for weeks with no upkeep |
| 3. Agent era | Months 4–6 | MCP server, explore mode, tests from a PRD, test inboxes, tunnel | Claude Code and Cursor users adopt Claritia |
| 4. Expand | Months 6–12 | API tests, visual checks, accessibility, Chrome recorder, managed service | Bigger deals per customer |
| 5. Scale | Year 2 | Browser grid, mobile, enterprise, SOC 2 | Mid-market and enterprise contracts |

Step caching moves into Phase 1 if AI cost per run tops $0.05 in beta.

## Phase 1 in detail

### Screens (app)

Sidebar: Tests, Runs, Environments, Settings. The `fire` dot sits on Runs when a test is failing.

1. **Sign in**: Google or GitHub, or an email link. First sign-in makes a workspace and a first project.
2. **First screen (ToolIntro)**: `// fig. 00 — start here`, "Test your app in plain English", a URL box, "Try" examples ("Sign up and land on the dashboard", "Add an item to the cart and check out"), three feature cards (Describe, Run, Watch).
3. **Tests**: table of tests with name, last result tag, last run time, and run count. Buttons: "New test", "Run all".
4. **New test / test page**: name, start URL, environment, and the steps as plain-English lines (one per row, drag to reorder). "Run" button. Each step shows its last result tag. The YAML view sits one tab away.
5. **Run viewer**: step list on the left with tags and times. Video on the right with a scrub bar that jumps to each step. Tabs under it: Screenshots, Console, Network, Trace (download). A failed step shows the error and the screenshot at that moment.
6. **Runs**: history table with test, result, time, length, and who or what started it.
7. **Environments**: base URL and secrets (encrypted, shown as dots) for staging and production.
8. **Settings**: workspace name, members, plan and usage (steps this month), billing via Stripe.

### Database (Supabase, first tables)

| Table | Key columns |
|---|---|
| `workspaces` | id, name, plan, stripe_customer_id, steps_used, period_start |
| `members` | workspace_id, user_id, role |
| `projects` | id, workspace_id, name |
| `environments` | id, project_id, name, base_url |
| `secrets` | id, environment_id, key, value_encrypted |
| `tests` | id, project_id, name, start_path, steps (jsonb: list of plain-English lines), yaml, updated_at |
| `runs` | id, test_id, environment_id, status (queued, running, passed, failed, error), trigger (manual, schedule, ci, api), started_at, finished_at, video_key, trace_key |
| `run_steps` | id, run_id, position, text, action (jsonb: the Playwright action the AI chose), status, cached, screenshot_key, error, ms |
| `step_cache` | id, test_id, position, text_hash, page_hash, action (jsonb), hits, last_used_at |
| `jobs` | id, kind, payload, status, attempts, locked_at, run_after |

Row-level security on every table by `workspace_id`, with leak tests like Omniscient's `tests/db/leaks.sql`.

### How a run works

1. The app inserts a `runs` row and a `jobs` row.
2. A worker locks the job, starts a fresh Playwright browser in its container, and opens the start URL with the environment's secrets.
3. For each step: look in `step_cache` by step text and page shape. On a hit, replay the saved action. On a miss, send the step, a trimmed page snapshot (accessibility tree plus visible text) and a screenshot to the model, which returns one action from a fixed list (click, fill, select, press, goto, wait, assert). Run it, then save it to the cache when it passes.
4. Save the video, trace and screenshots to R2. Write each `run_steps` row as it finishes so the viewer updates live.
5. Mark the run passed or failed, count the steps against the plan, and send alerts if set.

## Pricing (draft)

| Plan | Price | Steps a month | Main extras |
|---|---|---|---|
| Free | $0 | 500 | 1 project, video for every run |
| Starter | $49/mo | 5,000 | GitHub Action, Slack alerts, schedules |
| Team | $199/mo | 25,000 | Healing, failure sorting, 5 seats, MCP server |
| Business | Custom | Custom | SSO, private runners, managed test writing |

Extra steps: $5 per 1,000. Cached steps count as a quarter of a step.

## What it costs to run (first estimate, all prices "check")

Assumptions: a typical team runs 5,000 steps a month, 70% replay from cache, an uncached step costs about $0.004 in Claude tokens (3k tokens in with a screenshot, 200 out, on the small model), a step takes about 3 seconds of browser time, and a run saves about 2 MB of video and trace.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude tokens | about $300 | about $3,000 |
| Runner workers (Render) | about $170 (2 workers) | about $510 (6 workers) |
| Web service (Render) | about $25 | about $85 |
| Supabase | about $25 | about $125 |
| R2 storage (videos, 30-day keep) | about $1 | about $8 |
| Email and alerts | about $0 | about $20 |
| **Monthly total** | **about $520** | **about $3,750** |

Without step caching, the Claude line goes up more than 3 times (about $1,000 at Beta, $10,000 at Growth). That is why caching is a Phase 2 must-have.

Next: copy Omniscient's `scripts/cost-model.mjs` into this repo and swap in these numbers so every feature can show its cost.

## Numbers to watch

- Time to first passing test (goal: under 5 minutes)
- Tests still green after 30 days with no edits
- AI cost per run
- False failure rate (goal: under 2% of failures)
- Free to paid conversion

## The hard parts

- **Flaky results**: if Claritia flags fake bugs, teams stop trusting it in a week. Reliability comes before features.
- **AI cost per run**: caching keeps margins healthy.
- **Logins and private sites**: saved sessions, test inboxes and the tunnel solve this. Phase 1 supports username and password logins through secrets.
- **Big labs**: browser agents keep getting better. The edge is the workflow around the agent: repo files, CI gates, healing reviews and history.

## Your steps now

1. Buy the domain (`tryclaritia.com` or similar) and point it at Render.
2. Make the Supabase project and the Render services.
3. Pick 10 design partners, starting with Perceptric clients who ship web apps.
4. Approve the homepage plan in `docs/homepage.md`, then build Phase 1.
