# Claritia: build plan for the buyer enablement platform

Goal: one platform that sees every buyer, knows every account, shows each account the right content, acts at the right time, and learns what works. One orchestrator agent moves each account from first visit to a booked sales meeting.

Companion docs:
- `docs/identity.md`: identity stitching in full
- `docs/brand.md`: look and copy

---

## 0. Summary

| Phase | Weeks | Modules | What a customer can do at the end |
|---|---|---|---|
| 1 Account Intelligence | 1–9 | M0 Foundation, M1 Website Intelligence, M2 Buyer Analytics, M3 Account Intelligence Agent | Install a script, connect HubSpot, see who visits, see revenue by source, get a daily hot list and weekly briefs |
| 2 Action | 10–12 | M6 Action Agent | Approve agent-written emails and tasks, sent from the rep's inbox |
| 3 Buyer Experience | 13–17 | M4 Content Library and Experiences, M5 Page Builder and Account Pages | Send binge tracks and per-account pages, scored by reading time |
| 4 Outcome Optimization | 18–20 | M7 Orchestrator and Outcome Review | Let the agent run the loop per account and improve the playbook each week |
| 5 Later | 21–28 | M8 Site Personalization, M9 Site Chat Agent, M10 Intent Feeds, M11 Salesforce | Fill the remaining gaps in the market |

| Monthly bill | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Phases 1–4 | $4,934 | $46,210 |
| With Phase 5 | $5,334 | $50,210 |

Section 9 has the full cost breakdown.

---

## 1. Architecture

### 1.1 Apps

| App | Where | Size | Job |
|---|---|---|---|
| `claritia-web` | Fly nrt | 512 MB, then 2 × 1 GB | Next.js app, API, account pages and experiences (host-based routing), webhooks |
| `claritia-collect` (new) | Fly nrt | 2 × 256 MB, then 3 × 512 MB | Public event intake: `/s.js`, `/e`, `/i` |
| `claritia-agent` (the runner, renamed) | Fly nrt | 1 GB, then 3 × 2 GB | Job worker: syncs, lookups, AI calls, sends, crawls, page renders. Playwright stays here. |
| `claritia-relay` | Fly nrt | 256 MB | Kept for the testing product |
| Supabase `claritia` | Tokyo | Pro + Medium, then Large | Postgres, Auth, Storage, pg_cron, pg_net, pgvector |
| ClickHouse Cloud | Growth only | check | Raw events at Growth scale |

### 1.2 Data flow

```
 Visitor browser ──claritia.js──► claritia-collect ──COPY──► events (partitioned)
        │                              │                         │
        │                              └─► jobs: ip_lookup,       └─ pg_cron hourly ─► rollups
        │                                  stitch, signal
 HubSpot ◄──── sync, webhooks, writes ────► claritia-web / claritia-agent
                                                  │
                                    jobs queue (claim_job, skip locked)
                                                  │
              ┌─────────────┬──────────────┬──────┴───────┬──────────────┬──────────────┐
           ip_lookup     hubspot_sync   score/brief    action_send   content_ingest  orchestrate
              │              │              │              │              │              │
              └──────────────┴──────► accounts, persons, signals, scores ◄┴──────────────┘
                                                  │
                         Approvals · Alerts (Slack, email) · Dashboards · MCP · API
```

### 1.3 Rules every module follows

1. **A wrong signal costs more than a missing one.** Identity, scoring and actions only use hard evidence. Guesses carry a Probable tag and never trigger a send.
2. **Every send or publish goes through Approvals** until the team turns on auto-run for that action type.
3. **AI calls go through the decision cache.** If the inputs haven't changed, the model isn't called.
4. **Deterministic first.** Counts, scores and stages are computed in SQL where they can be. AI writes reasons, briefs, drafts and pages.
5. **Every table has RLS** and a leak test in `tests/db/leaks.sql`.
6. **Brand rules from CLAUDE.md:** square containers, `rounded-md` controls, square tags, no `<select>` or browser pop-ups, minimal copy, `ToolIntro` on first screens.
7. **Every feature lists its monthly cost** at Beta and Growth, with "check" on unconfirmed prices.

### 1.4 Code layout

```
collect/                 new Fly app (Hono, postgres.js)
  server.ts  ingest.ts  bots.ts  ipnet.ts  script/ (claritia.js source, esbuild)
src/lib/web/             sessions, rollups, analytics queries, attribution
src/lib/identity/        evidence, stitch, rebuild, erasure
src/lib/hubspot/         oauth, client (rate limited), sync, webhooks, writeback
src/lib/accounts/        fit, intent, stage, brief prompts and schemas
src/lib/actions/         action types, guardrails, gmail, graph, tokens
src/lib/content/         ingest, extract, tag, embed, recommend
src/lib/pages/           block schema, renderer, generator, domains
src/lib/agent/           orchestrator tools, loop, playbook, outcome review
worker/jobs/             one handler file per job kind
supabase/migrations/     020 to 032 (listed per module)
tests/                   unit and integration tests per module
scripts/*-check.ts       real-browser checks per module (like recorder-check.ts)
```

---

## 2. Phase 1: Account Intelligence (weeks 1–9)

### M0. Foundation (week 1)

**Problem it solves:** today each job type has its own claim function, and there is no account or person model.

**Migration `020_foundation.sql`:**

```sql
jobs (id uuid pk, workspace_id, kind text, key text, payload jsonb, status text default 'queued',
      run_after timestamptz default now(), attempts int default 0, max_attempts int default 5,
      locked_by text, locked_until timestamptz, error text, created_at, finished_at)
  unique (workspace_id, kind, key) where status in ('queued','running')   -- dedupe and debounce
claim_job(p_kinds text[], p_worker text, p_lease_s int) returns setof jobs  -- for update skip locked
finish_job(p_id, p_ok bool, p_error text, p_retry_after_s int)

accounts (id, workspace_id, domain, name, hubspot_company_id, owner_user_id, fit int, intent int,
          stage text, stage_since, temperature text, last_signal_at, created_at)
  unique (workspace_id, domain)
signals  (id, workspace_id, account_id, person_id, kind text, weight numeric, source text,
          at timestamptz, data jsonb)
  index (workspace_id, account_id, at desc)
workspace_settings (workspace_id pk, icp jsonb, page_weights jsonb, partner_domains text[],
          office_ips cidr[], own_domains text[], timezone text)
```

**Tasks:**
- `claim_job` with lease and retry backoff (1, 5, 30, 120 minutes). Move run, plan and exploration claims onto it. Old RPCs stay as wrappers until the worker is redeployed.
- `worker/index.ts`: one loop with job handlers in `worker/jobs/<kind>.ts`, and a concurrency limit per kind.
- Nav: Accounts, Analytics, Content, Pages, Actions, Playbook, Settings. The testing screens move under a Testing tab, hidden for new workspaces.
- Settings: ICP editor (industries, size bands, countries, must-have tech), own domains, office IPs, partner domains.
- `ToolIntro` first screens for Accounts and Analytics.

**Done when:**
- Existing runs, plans and explorations still pass their tests on the new queue.
- Two workers never claim the same job (test with 2 workers and 1,000 jobs).

**Cost:** none added.

---

### M1. Website Intelligence (weeks 2–4)

**Problem it solves:** buyers research in silence, and teams don't know which companies and people are on their site.

#### Migration `021_web.sql`

```sql
sites      (id, workspace_id, domain, extra_domains text[], site_key text unique, proxy_path text,
            consent_mode text default 'auto', created_at)
devices    (id uuid pk, workspace_id, site_id, first_seen, last_seen, internal bool, shared bool,
            tainted bool, consent text)
sessions   (id uuid pk, workspace_id, site_id, device_id, started_at, ended_at, landing_url,
            referrer, source, medium, campaign, term, content, country, region, city, device_type,
            browser, os, ip_net cidr, ip_account_id, ip_kind text, ip_confidence int,
            person_id, person_level text, account_id, account_source text, engaged_s int,
            pageviews int, is_bot bool)
events     (id uuid, workspace_id, session_id, kind text, url text, path text, title text,
            data jsonb, client_at, server_at, day date)  partition by range (day)
            primary key (day, id)
ip_networks (net cidr pk, domain text, name text, kind text, confidence int, vendor text, fetched_at)
```

The identity tables (`persons`, `identifiers`, `identity_evidence`, `device_links`, `person_aliases`, `merge_proposals`, `account_domains`) are in migration `022_identity.sql`, as set out in `docs/identity.md`.

#### The script, `claritia.js` (week 2)

- Source in `collect/script/`, plain TypeScript, built with esbuild. Target: under 5 KB gzipped.
- Installed as `<script defer src="https://<proxy or collect>/s.js" data-site="<site_key>"></script>`, or as a Google Tag Manager template.

| Event | When | Data |
|---|---|---|
| `view` | Load and SPA route change (patch `pushState`, `replaceState`, `popstate`) | url, title, referrer, UTM tags |
| `engage` | Every 15 s while visible, and on page hide | active seconds (only counts with input or scroll in the last 30 s), max scroll % |
| `click` | Links, buttons, `[data-clr]` | text (first 60 chars), href, outbound flag |
| `form` | Submit | form id, page, email field (if found), never passwords |
| `identify` | `claritia.identify({...})` | userId, email, token |
| `custom` | `claritia.track(name, props)` | name, props (2 KB max) |

- **IDs:** each event gets a uuid v7 made in the browser, so retries never double count.
- **Sending:** batches go out every 5 s or at 20 events, and on `pagehide` with `sendBeacon`. A failed batch is kept in `sessionStorage` and retried once.
- **Device id:** `_clr_id` cookie on the registrable domain, plus a localStorage copy. When served through the proxy path, the server sets a long-life cookie.
- **Consent:** reads Google Consent Mode v2, OneTrust and Cookiebot, or `claritia.consent()`. Without consent it sends `cookieless: true` and stores nothing in the browser.
- **Cross-domain:** links to `extra_domains` get `_clr_x=<signed device id>`, which expires after 2 minutes and is stripped on landing.
- **Email tokens:** `clr` and `_clr_x` are read, then removed with `history.replaceState`.
- **Adapters:**
  - HubSpot forms: the `hsFormCallback` message.
  - Marketo: `MktoForms2.whenReady` and `onSuccess`.
  - Calendly: `calendly.event_scheduled` postMessage.
  - Chili Piper: the booking callback (check).
- **Bot hints sent with each batch:** `navigator.webdriver`, number of input events, and time from load to first input.

#### The collect service (weeks 2–3)

- Hono on Node 22, with `postgres` (postgres.js) through the Supavisor pooler.
- **`GET /s.js`:** the script, cached for 1 hour, with versioned paths for cache busting.
- **`POST /e`** (batch):
  - Look up `site_key` and check that `Origin` is the site domain or one of its extra domains.
  - Limits: 64 KB body, 100 events per batch, 50 requests per second per IP and 2,000 per second per site.
  - Bots: dropped by the `isbot` user agent list and by data center IP ranges. The AWS, GCP, Azure, Oracle, Hetzner, DigitalOcean and OVH ranges load at boot and refresh daily. Bot hints are also checked.
  - **Session:** reuse it if the device was seen within 30 minutes. Otherwise make a new one. Source and medium come from UTM tags, then the referrer table (search engines, social, AI assistants like chatgpt.com and perplexity.ai), then direct.
  - **Geo:** country, region and city from a local MaxMind GeoLite2 file, refreshed weekly (free license, check terms). Only the `/24` network (`/48` for IPv6) is kept. The full IP is dropped after lookup.
  - Write with `COPY` into `events` from an in-memory buffer, flushed every 1 s or at 500 rows, with `ON CONFLICT DO NOTHING`.
  - Queue jobs: `ip_lookup` (once per network, cached 30 days), `stitch` (on identity evidence), and `signal` (on high-weight pages).
- **`POST /i`:** identity evidence (forms, identify) goes straight to `identity_evidence`.
- **Health:** `/health` reports buffer depth and the last flush time.

#### Company match (week 3)

- `ip_lookup` job: if the `ip_networks` cache misses, call the vendor (IPinfo or Snitcher, check prices), then save the domain, name, kind (business, isp, hosting, vpn, mobile, coworking) and confidence.
- Only kind `business` with confidence 70 or more sets `sessions.ip_account_id`.
- A new domain creates an `accounts` row. A `company_enrich` job then pulls Coresignal company data (size, industry, country, founded, headcount growth) into `accounts.firmo jsonb`, cached 30 days.

#### Signals (week 4)

| Signal | Rule | Default weight |
|---|---|---|
| `page_high` | Path matches the team's high-value list (pricing, demo, compare, security, integrations) | 10 |
| `page_mid` | Product and solution pages | 3 |
| `page_low` | Blog | 1 |
| `page_zero` | Careers, legal, login | 0 |
| `return_visit` | Account back after 14+ quiet days | 8 |
| `new_person` | New known person from an account | 6 |
| `spike` | Account sessions this week > 3 × its 8-week average | 12 |
| `form` | Any form from the account | 15 |

Weights are editable in Settings. Internal, tainted and bot sessions make no signals.

#### Screens

- **Settings › Sites:** add a site, copy the install snippet, proxy path guides (Next.js, Vercel, Cloudflare, Nginx), and a live "last event received" check.
- **Live:** the visits of the last 30 minutes. Each row shows the account, or "Unknown" plus the country, along with pages and time.
- **Visitors:** a list of devices and people with filters.

#### Tests

| Test | Pass |
|---|---|
| `scripts/collect-check.ts`: real Chromium on a local site, browse 5 pages, SPA route change, fill a form | Every event lands once. The session is right. The form becomes evidence. |
| Headless bot with `webdriver` | No events stored |
| Consent denied | No cookie or storage set, and cookieless sessions only |
| Proxy path | Cookie set by the server with a long life |
| Load: 10,000 events per second for 60 s at collect | No loss, p99 under 50 ms |
| Kill collect during a flush | Client retries make no doubles (dedupe on id) |
| Identity cases | All 17 from `docs/identity.md` |

**Done when:** a design partner's live site shows real accounts within 5 minutes of install.

**Risks:**
- Ad blockers. Fix: the proxy path.
- Safari cookie limits. Fix: the proxy path, plus localStorage.
- IP vendor accuracy. Fix: a sample check against known HubSpot contacts in week 3, and switch vendors if under 70% agree.

---

### M2. Buyer Analytics (weeks 5–6)

**Problem it solves:** marketing can't tie site traffic and content to pipeline and revenue.

#### Migration `023_analytics.sql`

```sql
site_daily     (site_id, day, path, source, medium, campaign, country, device_type,
                visitors int, sessions int, views int, engaged_s bigint, bounces int)
account_daily  (workspace_id, account_id, day, sessions, people, views, engaged_s, high_views)
goals          (id, workspace_id, site_id, name, kind text, match jsonb)   -- url, click, form, hubspot_stage
goal_hits      (goal_id, session_id, person_id, account_id, at)
funnels        (id, workspace_id, name, steps jsonb, window_days int)
deals          (id, workspace_id, hubspot_deal_id, account_id, name, amount, currency, stage,
                pipeline, created_at, closed_at, won bool)
touches        (id, workspace_id, account_id, person_id, session_id, at, source, medium, campaign,
                kind text)     -- session, email_click, page_view (M5), asset_view (M4), action (M6)
```

- **Rollups:** an hourly pg_cron job re-rolls the last 3 hours so late events land. A nightly job re-rolls yesterday.
- **Unique visitors:** exact distinct counts per day per dimension at Beta. Use the `hll` extension at Growth if Supabase offers it (check).
- **Goals:** checked by a job on new sessions and events.
- **Funnels:** a SQL function with window functions over sessions per device or person within `window_days`.
- **Attribution:** `attribution(p_workspace, p_from, p_to, p_model)` with first touch, last touch, linear, and U-shaped (40/20/40).
  - The deal's account gives the account's touches before `deal.created_at`.
  - The deal amount is spread across those touches by the chosen model.
- **Stripe revenue (optional):** customers pass `_clr_id` into Checkout metadata. A Stripe webhook links the payment to the device. This is the DataFast method.

#### Screens

- **Analytics:** stat tiles (visitors, sessions, engaged time, identified accounts, pipeline), a visitors-over-time chart, and tables for sources, pages, countries and devices.
- Any table row can be clicked to filter the page.
- **Goals and Funnels:** a builder using the app's own `Select`.
- **Revenue:** pipeline and won revenue by source, campaign and page, with a model switcher.
- **Account journey:** a timeline on the Account page with every session, page, asset, email and deal stage.
- Charts with Recharts, following the dataviz skill and brand tokens.

#### Tests

- Fixture events with known totals, so every tile and table matches by hand count.
- Attribution fixtures, so each model gives the expected split down to the cent.
- Late events at +2 hours are counted after the next hourly roll.
- Dashboards load in under 300 ms on 10 M fixture events (Beta scale).

**Done when:** a design partner can answer "which sources made pipeline last quarter" from one screen.

---

### M3. Account Intelligence Agent (weeks 7–9)

**Problem it solves:** reps don't know which accounts are in market, who is involved, or what to say.

#### HubSpot app (week 7) — migration `024_hubspot.sql`

```sql
hubspot_portals (workspace_id pk, portal_id, access_token_sealed, refresh_token_sealed, expires_at,
                 scopes text[], installed_by, installed_at, last_full_sync, status)
hubspot_sync_state (workspace_id, object text, cursor text, last_modified timestamptz)
hubspot_owners  (workspace_id, owner_id, user_email, name)
```

- **OAuth:** authorize at `app.hubspot.com/oauth/authorize`, exchange the code at the token endpoint (check the current version). Tokens are sealed with `SECRETS_KEY` and refreshed 5 minutes before expiry.
- **Scopes:** `crm.objects.companies.read/write`, `crm.objects.contacts.read/write`, `crm.objects.deals.read`, `crm.schemas.companies.write` (custom properties), `timeline`, `forms`, `sales-email-read`, `crm.objects.owners.read`.
- **Install:**
  - Create custom company properties: `claritia_fit`, `claritia_intent`, `claritia_stage`, `claritia_brief_url`, `claritia_last_signal`.
  - Create contact properties: `claritia_level`, `claritia_last_seen`.
  - Create timeline event templates: "Visited site", "Read asset", "Viewed account page", "Agent action".
- **First sync:** companies, contacts, deals, owners and associations, through the CRM Search API by `hs_lastmodifieddate`, 100 per page. This feeds `accounts`, `persons` and `identifiers` as HubSpot identity evidence, plus `deals`.
- **Ongoing:**
  - Webhooks for `company.*`, `contact.*`, `deal.*`, `contact.merge` and `contact.privacyDeletion`, verified with the v3 signature.
  - A 15-minute catch-up sync per object using the cursor.
- **Rate limit:** a token bucket per portal in Postgres, set to 80% of HubSpot's public app limit (check the current number). 429 answers back off and the job is re-queued.
- **Write back:** properties on score change (batched every 15 minutes) and timeline events (batched).
- **Errors:** a revoked token sets the portal status to `disconnected`, raises an alert, and shows one real error in Settings.

#### Scores (week 8) — migration `025_account_ai.sql`

```sql
account_scores (account_id, day, fit, intent, stage, temperature, reason, next_step,
                inputs_hash text, model text, created_at)
account_briefs (id, account_id, week, summary, news jsonb, buying_group jsonb, pains jsonb,
                assets jsonb, next_step, opener, sources jsonb, model, inputs_hash, created_at)
ai_calls       (id, workspace_id, kind, model, input_tokens, output_tokens, cached_tokens,
                cost_usd numeric, cache_hit bool, created_at)
```

- **Fit (deterministic):** 0–100 from the ICP match (industry, size band, country, tech).
  - Once a workspace has 20+ closed deals, weights come from lift per attribute bucket: win rate in the bucket divided by the overall win rate.
- **Intent (deterministic):** the sum of signal weights × 0.5^(age in days / 7), mapped to 0–100 by a log curve set per workspace (the 95th percentile account = 90).
- **Temperature:** rising, steady or cooling, from this week's intent vs the 4-week average.
- **Stage (rules):**

| Stage | Rule |
|---|---|
| Unknown | No sessions in 30 days |
| Engaged | Any session in 30 days |
| Researching | Intent 40+ or 2+ people |
| Evaluating | Intent 70+, or a `page_high` from 2+ people, or an asset binge |
| Meeting booked | HubSpot meeting or Calendly event in the future |
| In deal | Open HubSpot deal |

- **Reason and next step (Haiku 5.5):** only runs when stage or intent band changes. Structured output:

```json
{ "reason": "string <= 200 chars", "next_step": "alert_rep|email|page|wait|none",
  "why_next": "string <= 200 chars" }
```

  - Input: firmographics, the last 30 days of signals (compact), deal state and open tasks.
  - Decision cache key: `sha256(fit, intent band, stage, signal ids)`.

#### Briefs (week 9)

- A weekly job for the top 50 accounts by intent, plus any account that enters Evaluating.
- Sonnet 5.5 with the `web_search_20260209` tool (max 5 searches), adaptive thinking, and structured output:

```json
{ "summary": "string", "news": [{"title":"","url":"","date":""}],
  "buying_group": [{"name":"","title":"","role":"champion|decision_maker|user|finance|unknown","known":true}],
  "pains": ["string"], "assets": ["asset_id"], "next_step": "string", "opener": "string",
  "sources": [{"claim":"","url":""}] }
```

- **Inputs:**
  - The account, people from HubSpot and stitching, and the last 60 days of signals.
  - Coresignal employee search by company and title keywords (VP Sales, RevOps, CRO, Marketing).
  - The asset list from M4 once it exists.
- **Checks before saving:**
  - Every news item needs a URL from the search results.
  - People marked `known: false` are never written to HubSpot.
  - Asset ids must exist.
- The Batch API is used for the weekly run to halve its cost. Briefs for accounts entering Evaluating run right away.

#### Screens

- **Accounts:** a table with name, fit, intent, temperature arrow, stage (square tag), owner, last signal and people. Filters, saved views and bulk assign owner.
- **Account page:**
  - Header with scores, stage and owner.
  - Brief, with sources as links.
  - Journey timeline from M2.
  - People with identity level tags.
  - Deals.
  - "Why this score": the list of weighted signals behind it.
- **Morning digest:** Slack and email per rep at 8:00 in the rep's time zone. It lists the top 5 accounts that moved, with reason and next step. Built on the existing alerts (014).

#### Tests

- A HubSpot test portal with fixed data. Sync twice and nothing doubles. A webhook during the full sync is not lost.
- A forged webhook signature is refused.
- A token expiring mid-sync refreshes and carries on.
- Intent and stage fixtures give the expected numbers by hand math.
- Scoring cache: the same inputs make no second call (counted in `ai_calls`).
- Brief schema and checks: a fake URL in news is removed. An unknown asset id is removed.
- Leak tests on every new table.

**Done when:** a design partner's reps open the morning digest and can name why each account is on it.

**Phase 1 cost:** Beta $2,054, Growth $17,530 (section 9).

---

## 3. Phase 2: Action Agent (weeks 10–12)

### M6. Action Agent

**Problem it solves:** hot accounts get missed or get a slow, generic follow-up.

#### Migration `026_actions.sql`

```sql
mailboxes   (id, workspace_id, user_id, provider text, address, token_sealed, refresh_sealed,
             expires_at, daily_cap int default 40, status)
actions     (id, workspace_id, account_id, person_id, kind text, status text,
             -- proposed, approved, running, done, failed, dismissed, blocked
             payload jsonb, reason text, signal_ids uuid[], created_by text, approved_by,
             approved_at, done_at, error, external_id text)
action_rules (workspace_id, kind text, auto bool default false, approvals_count int,
             unlocked_at)   -- auto is allowed after 20 approvals of that kind
suppressions (workspace_id, value_hash, kind text, source, created_at)  -- email or domain
sent_emails (id, action_id, mailbox_id, to_hash, thread_id, message_id, sent_at, replied_at,
             bounced bool)
```

#### Action types

| Kind | Payload | Runs as |
|---|---|---|
| `alert_rep` | text, account link | Slack DM or email to the owner |
| `email` | to, subject, body, asset links | Gmail API `users.messages.send`, or Microsoft Graph `sendMail` |
| `task` | title, due, notes | HubSpot task on the owner, linked to the company and contact |
| `sequence` | sequence id, contact | HubSpot sequence enroll (needs Sales Hub; check the API) |
| `property` | object, field, value | HubSpot update |
| `page_link` | page id, contact (after M5) | Email with the account page link |

#### How actions are made

- Triggers:
  - A stage change to Researching or Evaluating.
  - A `form` or `spike` signal.
  - A brief's `next_step`.
  - A manual "Suggest action" button.
- **Draft (Sonnet 5.5, structured output):**
  - Input: the brief, the person (title, past emails from HubSpot, last 3), the signal that fired, approved assets, the team's tone guide, and 3 example emails the team marked as good.
  - Output:

```json
{ "subject": "string <= 70", "body": "string <= 900", "asset_ids": ["..."],
  "signal_used": "string", "personal_fact": {"text": "", "source_url": ""} }
```

- **Body checks:**
  - It never mentions page visits or tracking ("I saw you were on our pricing page" is blocked by a rule check).
  - The personal fact must have a source URL from the brief.
  - Every link gets a `clr` token (`docs/identity.md`).

#### Guardrails (run at approve time and again at send time)

1. The person's identity link is Verified or Asserted.
2. The email or domain is not in `suppressions` (unsubscribes, bounces, HubSpot `hs_email_optout`, manual adds).
3. No email to this person from any Claritia mailbox in the last 3 days, and at most 3 in 30 days.
4. The mailbox is under its daily cap. The workspace is under its daily cap (default 200).
5. If the person is on an open deal, the deal owner must be the approver.
6. Send window: 8:00 to 17:00 in the recipient's time zone (from the country), Monday to Friday.

#### Sending

- **Gmail:** OAuth with `gmail.send` and `gmail.readonly` (for replies).
  - Google's verification for these scopes takes weeks and may need a security review for `gmail.readonly` (check). Start in week 1.
  - Until then, use Microsoft Graph and SMTP-less HubSpot tasks.
- **Microsoft:** Entra app with `Mail.Send`, `Mail.Read` and `offline_access`.
- **Replies:** every 15 minutes, read the thread of each sent email.
  - A reply sets `replied_at`, adds a `reply` signal, stops follow-ups and alerts the owner.
  - A bounce adds a suppression.
- **HubSpot log:** each sent email is logged as an email engagement on the contact and company.

#### Screens

- **Actions** (Approvals, reused from Heals):
  - A list with kind tag, account, person, reason and signal.
  - Edit in place, Approve, Dismiss, and Approve all for one kind.
- **Settings › Mailboxes:** connect Gmail or Outlook, daily cap, signature.
- **Settings › Rules:** auto-run switches. Each unlocks after 20 approvals of that kind.
- **Account page:** an Actions tab with history and outcomes (replied, meeting, none).

#### Tests

- Guardrail matrix: each guardrail blocks a send even with auto-run on.
- A send that fails with a 5xx retries once, then shows a real error. A 4xx doesn't retry.
- A draft that mentions tracking is blocked.
- Reply detection on a test mailbox.
- Suppression from HubSpot opt-out holds.
- Time window: a send queued at 18:00 local runs at 8:00 the next workday.

**Done when:** a design partner approves 50 emails in a week with fewer than 10% edited heavily.

**Phase 2 cost:** Beta $620, Growth $6,090.

---

## 4. Phase 3: Buyer Experience (weeks 13–17)

### M4. Content Library and Experiences (weeks 13–15)

**Problem it solves:** content is scattered, nobody knows what gets read, and buyers bounce after one asset.

#### Migration `027_content.sql`

```sql
assets      (id, workspace_id, kind text,        -- pdf, video, web, slides
             title, url, storage_path, thumb_path, text_excerpt, text_len, pages int, duration_s int,
             topic text[], persona text[], stage text[], summary, read_min int,
             frameable bool, embedding vector(1024), status, created_at, updated_at)
asset_chunks (asset_id, idx, text, embedding vector(1024))     -- for M9 chat and brief picks
tracks      (id, workspace_id, slug, name, theme jsonb, cta jsonb, gate jsonb, asset_ids uuid[],
             recommend bool, status)
asset_views (id, workspace_id, asset_id, track_id, session_id, person_id, account_id,
             active_s int, max_page int, pct_done int, started_at)
```

#### Ingest (`content_ingest` job)

| Kind | How |
|---|---|
| PDF upload | Supabase Storage. Text with `unpdf`. Page count. Thumbnail from page 1 rendered in Playwright (already in the worker). |
| Slides | PPTX converted to PDF with LibreOffice in the agent image (adds about 300 MB; check the image size), then treated as PDF |
| Video | YouTube oEmbed, the Vimeo API or Wistia oEmbed for title, thumbnail and duration. Transcript where the API gives one. |
| Web page | Fetch, then Readability for text. Check `X-Frame-Options` and CSP `frame-ancestors` to set `frameable`. A screenshot thumbnail. |
| Whole site or blog | The Explorer crawler (exists) with a path filter, adding each page as a web asset |

- **Tagging (Haiku 5.5):** topic, persona, stage, a summary in 2 lines, and reading minutes.
  - The topic list is set per workspace in Settings, and the model can only pick from it.
- **Embeddings:** Voyage AI (check the model and price) on the title, summary and chunks of 800 tokens. Stored with pgvector and an HNSW index.

#### Experiences

- **Viewer route:** `/x/<track>/<asset>` on `go.<customer domain>` or `go.tryclaritia.com/<team>`.
  - **PDF:** pdf.js. Page-level active time from IntersectionObserver plus input activity.
  - **Video:** YouTube IFrame API, Vimeo Player SDK, Wistia `_wq`. Watched seconds come from time updates and skip seeking.
  - **Web:** an iframe if `frameable`. Otherwise the saved reader view, with a link to the original.
- **Next-up rail:** the track's next assets. If `recommend` is on, the nearest by embedding to what was read, filtered by the account's stage.
- **CTA:** a fixed button (book a meeting, contact sales) that shows after N seconds or after the 2nd asset.
- **Gate:**
  - A form after N assets or N minutes, skipped for known people.
  - The form posts to HubSpot through the Forms API with `hutk` and to Claritia as Asserted identity evidence.
- **Engagement score:**
  - Per asset view: `min(active_s / (read_min × 60), 1) × 100`.
  - A binge is 2+ assets in one session.
  - Both feed signals: `asset_read` (weight 6 at 50%+) and `binge` (weight 10).
- **Embed:** `<div data-clr-track="slug">` plus `claritia.js` renders the track on the customer's own site.

#### Screens

- **Content:** a library grid with kind tags and topic, persona and stage chips as square tags. Upload, Add URL, Crawl. Editing tags inline.
- **Asset page:** reads, average active time, completion and the accounts that read it.
- **Tracks:** a builder with drag-to-reorder, theme, CTA and gate. Preview and Share link.
- **Account page:** a Content tab with what each person read and for how long.

#### Tests

- `scripts/content-check.ts`: a real browser reads a 10-page PDF for 40 s on pages 1–3 and the stored view matches.
- A video with seeking counts only watched time.
- A frame-blocked page falls back to the reader view.
- The gate submits to a HubSpot test form and creates evidence.
- The ingest of a 50 MB PDF finishes inside the worker's memory.

---

### M5. Page Builder and Account Pages (weeks 16–17)

**Problem it solves:** buyers get generic pages, and making a custom page per account takes hours.

#### Migration `028_pages.sql`

```sql
page_templates (id, workspace_id, name, blocks jsonb, theme jsonb)
pages       (id, workspace_id, account_id, slug, title, blocks jsonb, theme jsonb, status,
             -- draft, review, live, archived
             variant_of uuid, split int, published_at, created_by)
page_views  (id, page_id, session_id, person_id, account_id, active_s, blocks_seen text[], at)
domains     (id, workspace_id, hostname, fly_cert_id, status, verified_at)
```

#### Blocks

`hero`, `logos`, `pain_points`, `asset_grid`, `case_study`, `quote`, `video`, `demo_embed`, `pricing_note`, `faq`, `form`, `meeting` (HubSpot Meetings or Calendly), `team` (the account's rep and SE).

- Each block has a JSON schema in `src/lib/pages/blocks.ts`. One renderer is used for the editor preview and the live page.

#### AI build (Sonnet 5.5)

- **Input:** the account brief, the team's template, up to 12 candidate assets (picked by embedding against the brief's pains), the account's logo (fetched from its domain favicon or Coresignal), and the rep's name and calendar link.
- **Output:** `blocks[]` that must pass the block schemas.
- **Claim check:** every sentence in `pain_points` and `hero.sub` must cite a `brief.sources` entry or an asset id. Any line that doesn't is removed before save.
- **Publish:** pages land as `review` in Approvals and go `live` once approved.

#### Hosting

- `proxy.ts` routes by host:
  - `go.tryclaritia.com/<team>/<slug>`
  - Custom `go.customer.com/<slug>`, looked up in `domains`.
- Pages are statically rendered with on-demand revalidation when they are edited.
- **Custom domains:** the customer adds a CNAME to `claritia-web.fly.dev`. We call the Fly certificates API (check the GraphQL mutation and price per hostname) and poll until the certificate is issued.
- **A/B:** two variants. The visitor hash picks one. A winner shows once one has 30% more meetings for 7 days with at least 30 views each.
- `claritia.js` is built in, so views and reading feed M1 and M2. `page_view` signals carry weight 8.

#### Editor

- A block list on the left and a live preview on the right. Drag to reorder and edit text in place.
- Asset pickers use the app's `Select` and dialogs.
- "Rebuild with AI" for one block or the whole page.
- Share: a copy-link button that adds a person token for each contact, so each view is tied to that person (Inferred level, upgraded by a form or booking).

#### Tests

- A generated page with an unsourced claim loses that line.
- Server and client renders match (hydration check).
- A custom domain on a Fly staging app gets a certificate.
- The A/B split holds near 50/50 over 1,000 fake visitors.
- A booking from the page creates a `meeting` signal and moves the stage to Meeting booked.

**Phase 3 cost:** Beta $510, Growth $5,090.

---

## 5. Phase 4: Outcome Optimization (weeks 18–20)

### M7. Orchestrator and Outcome Review

**Problem it solves:** the pieces work, but someone still has to decide what to do for each account, and nobody knows which plays work.

#### Migration `029_agent.sql`

```sql
playbooks    (id, workspace_id, version int, rules jsonb, prompt text, status, created_by,
              approved_by, created_at)      -- one live version per workspace
agent_runs   (id, workspace_id, account_id, playbook_version, trigger text, observed jsonb,
              plan jsonb, tool_calls jsonb, outcome text, tokens jsonb, started_at, finished_at)
account_state (account_id pk, stage, next_check_at, runs_today int, last_run_at, paused bool)
outcomes     (id, workspace_id, account_id, action_id, page_id, asset_id, kind text,
              -- reply, meeting, deal_created, deal_won, no_response_14d
              at)
reviews      (id, workspace_id, week, findings jsonb, proposed_playbook_id, model, created_at)
```

#### The loop: Observe, Reason, Plan, Execute, Evaluate

- **Trigger:** any new signal on an account sets `orchestrate` with `run_after = now() + 10 min` and key `account_id`. Bursts become one run.
- **Caps:** at most 3 runs per account per day and 2,000 per workspace per day. Paused accounts are skipped.
- **Model:** Sonnet 5.5 with tool use, adaptive thinking, and at most 6 tool calls per run.
  - Prompt caching on the system prompt, playbook and tool list.
- **Tools (server functions with strict JSON schemas):**

| Tool | What it does |
|---|---|
| `get_account(id)` | Scores, stage, brief, people, deal |
| `get_signals(id, days)` | Recent signals, compact |
| `search_content(query, stage, persona)` | Top assets by embedding |
| `get_history(id)` | Past actions and outcomes |
| `propose_email(person_id, angle, asset_ids)` | Makes an M6 email action (goes to Approvals) |
| `propose_task(text, due)` | M6 task |
| `alert_rep(text)` | M6 alert |
| `build_page(asset_ids, angle)` | M5 page in review |
| `set_next_check(at, why)` | Sleep until a date |
| `finish(summary)` | End the run |

- **Hard limits in code (the model can't skip them):**
  - Every send or publish becomes an M6 action with all guardrails.
  - Only one open email action per person.
  - No action on Probable people.
  - Tool errors are returned to the model as text, and the run stops after 2 errors.
- **Log:** each run saves what it saw, what it planned, each tool call and the outcome. The Account page shows it as "Agent log".

#### Outcome review (weekly)

- A job per workspace on Mondays at 6:00 local time builds a table:
  - Each action, page and asset delivered in the last 8 weeks.
  - The account's stage before and after.
  - The outcome within 14 days.
- **Opus 5.5 through the Batch API**, with structured output:

```json
{ "findings": [{"claim": "", "evidence": {"n": 0, "rate": 0, "baseline": 0}}],
  "changes": [{"rule": "", "from": "", "to": "", "why": ""}] }
```

- **Checks:** a finding needs n ≥ 20 and a rate at least 1.5× the baseline, or it's dropped. Changes only touch fields in the playbook schema.
- Changes become a new playbook version in `review`. The team sees a diff and approves or rejects. Rollback is one click.

#### Screens

- **Playbook:** the live version as readable rules (when, do, unless), a version list, diffs and rollback.
- **Outcomes:**
  - Accounts moved to meeting by week.
  - Days to meeting.
  - Pipeline from Claritia actions.
  - Win rate by action kind, asset and page.
- **Account page:** the Agent log tab, plus Pause agent on this account.
- **MCP:** new tools `list_accounts`, `get_account`, `get_brief`, `propose_action` and `build_page`, so Claude Code and other agents can work with the data. Built on the existing `/api/mcp`.

#### Tests

- Replay: a fixed signal stream with the cache on gives the same tool calls each time.
- A run that asks to email a Probable person is refused by the tool and logged.
- Caps hold under a burst of 500 signals on one account (1 run, then waits).
- A review with too few samples proposes no change.
- A rollback restores the old rules for the next run.

**Done when:** a design partner turns on the agent for 50 accounts, and the approval rate stays above 70% for two weeks.

**Phase 4 cost:** Beta $1,750, Growth $17,500.

---

## 6. Phase 5: Later (weeks 21–28)

| Module | What | Technical | Weeks | Adds per team |
|---|---|---|---|---|
| M8 Site Personalization | Swap headline, logos, case study and CTA for known accounts and segments | `claritia.js` gets the session's account and segment from `/p` at load, with a 300 ms anti-flicker cap and text swaps from `[data-clr-slot]` attributes. Variants are made once per segment by Sonnet and stored. No model call per view. | 3 | $1 |
| M9 Site Chat Agent | Answers questions, qualifies, books meetings, hands off live to the owner in Slack | A widget, with Sonnet 5.5 doing retrieval over `asset_chunks` and a site crawl, a meeting tool and a Slack handoff through the alerts app. Every answer cites an asset. | 3 | $6 |
| M10 Intent Feeds | Off-site research signals | G2 Buyer Intent API, Bombora Company Surge (paid, check). Mapped to `signals` with their own weights. | 1 | Vendor pass-through (check) |
| M11 Salesforce | Same as the HubSpot app for Salesforce teams | Connected App OAuth, Bulk API 2.0 sync, Platform Events or CDC, custom fields | 1+ | $0 |

Phase 5 adds about $400 at Beta and $4,000 at Growth (section 9).

---

## 7. Cross-cutting work

### 7.1 Security
- Every table has RLS by `workspace_id`, with a leak test per migration.
- Collect is public: site key plus origin check, size limits, rate limits, and no reads.
- Tokens (HubSpot, Gmail, Graph, Slack) are sealed with `SECRETS_KEY`. Every token refresh is logged.
- `identify()` is HMAC-signed for the Verified level.
- Webhook signatures checked: HubSpot v3, Stripe, Slack.
- Agent tools are server functions with schemas, so the model can never write SQL or call raw URLs.

### 7.2 Privacy
- DPA and a sub-processor list: Fly, Supabase, Anthropic, the IP vendor, Voyage, Resend, Coresignal and MaxMind.
- A cookie notice text for customers, and a consent mode set per site.
- Retention: raw events 90 days, sessions 13 months, rollups forever. All are configurable down.
- Erasure: an API, a Person page button and the HubSpot privacy webhook (`docs/identity.md`).
- The full IP is never stored. Person-level third-party identity graphs are left out.
- Data region: Supabase is in Tokyo. EU or US data residency is a later project (check the cost of a second project).

### 7.3 Reliability
- Collect: at-least-once with dedupe ids. Buffer depth and flush lag are alerted to our Slack.
- Jobs: leases, retries with backoff, and a dead-letter view in an internal admin page.
- Nightly checks:
  - Identity rebuild vs live tables.
  - Rollups vs raw counts for yesterday.
  - HubSpot property drift on a sample of 50 companies.
- Every AI call is logged in `ai_calls` with cost. A workspace that passes its monthly AI budget pauses briefs and the orchestrator and alerts the owner.

### 7.4 Performance budgets

| Thing | Budget |
|---|---|
| `claritia.js` | ≤ 5 KB gzipped, no effect on Largest Contentful Paint |
| Collect `/e` | p99 ≤ 50 ms |
| Dashboards | ≤ 300 ms at Beta data size |
| Account pages and experiences | Time to first byte ≤ 200 ms (cached) |
| Morning digest | Sent by 8:05 local |

### 7.5 Billing and plans (Stripe, already in the app)

Proposed plans:

| Plan | Price | Limits |
|---|---|---|
| Starter | $199/mo | 10K visitors, 250 tracked accounts, M1–M3, 1 HubSpot portal |
| Growth | $599/mo | 50K visitors, 1,000 accounts, all agents, 5 mailboxes, custom domain |
| Scale | From $1,499/mo | 250K visitors, 5,000 accounts, Phase 5 add-ons, SSO |

- Overages: $10 per 10K visitors.
- Credits for extra briefs and pages, using the `workspace_usage` meter (exists).
- At the assumptions in section 9, cost is about $92–$99 per team, against $199–$599 in plan price.

### 7.6 The testing product
- The code stays. Routes are hidden for new workspaces. Existing workspaces keep the Testing tab.
- The runner image keeps Playwright, which M1 (bot checks), M4 (thumbnails) and M5 (render checks) also use.

---

## 8. Launch plan

| Week | Milestone |
|---|---|
| 4 | M1 live on our own site (tryclaritia.com) |
| 6 | 5 design partners install the script and connect HubSpot (`docs/design-partners.md`) |
| 9 | Morning digest and briefs to design partners |
| 12 | Action Agent with Approvals on for design partners |
| 14 | Beta opens on the waitlist, Starter plan only |
| 17 | Experiences and account pages to all Beta teams |
| 20 | Orchestrator for design partners. Growth plan on sale. |
| 24 | HubSpot Marketplace listing (check the listing rules and minimum installs) |

**Beta exit (to Growth):**
- 50 paying teams.
- Fewer than 1 unmerge per team per week.
- At least 70% of agent actions approved.
- At least 20% of Evaluating accounts reach a meeting within 30 days.

---

## 9. Monthly cost in full

### 9.1 Assumptions per team per month

| Item | Amount |
|---|---|
| Page views | 50,000 |
| Events | 200,000 |
| Unique IP networks to look up | 20,000 (about half cached, check against real traffic) |
| Active accounts | 500 |
| Briefs | 200 (top 50 weekly) |
| Actions proposed | 400 |
| Account pages | 100 |
| Assets ingested | 50 |
| Orchestrator runs | 1,500 |
| Chat conversations (Phase 5) | 200 |

### 9.2 AI per team

| Module | Calls | Per team |
|---|---|---|
| M3 reason and next step | Haiku 5.5, on change only | $7 |
| M3 briefs | Sonnet 5.5 + web search ($10 per 1,000 searches, check), Batch API on weekly runs | $22 |
| M6 drafts | Sonnet 5.5 | $12 |
| M4 tagging and embeddings | Haiku 5.5 + Voyage (check) | under $1 |
| M5 pages | Sonnet 5.5 | $10 |
| M7 orchestrator | Sonnet 5.5 with prompt caching | $30 |
| M7 outcome review | Opus 5.5 through the Batch API | $2 |
| M7 outcome tagging | Haiku 5.5 | $3 |
| **Phases 1–4** | | **$86** |
| M8 personalization variants | Sonnet 5.5, once per segment | $1 |
| M9 chat | Sonnet 5.5 with caching | $6 |

Claude prices: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per million tokens.

### 9.3 Infra

| Item | Beta | Growth |
|---|---|---|
| Fly `claritia-web` | $5 (check) | 2 × 1 GB, $20 (check) |
| Fly `claritia-collect` | 2 × 256 MB, $4 (check) | 3 × 512 MB, $15 (check) |
| Fly `claritia-agent` | 1 GB, $10 (check) | 3 × 2 GB, $60 (check) |
| Supabase | Pro $25 + Medium compute $60 (check) | Pro $25 + Large compute $110 (check) |
| ClickHouse Cloud | none | $300 (check) |
| Reverse IP lookups | $500 (check) | $2,500 (check) |
| Resend | $20 | $90 (check) |
| Custom domain certificates and storage | $10 (check) | $90 (check) |
| MaxMind GeoLite2 | $0 (check terms) | $0 (check terms) |

### 9.4 Totals

| Phase | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| 1 Account Intelligence | $2,054 | $17,530 |
| 2 Action | $620 | $6,090 |
| 3 Buyer Experience | $510 | $5,090 |
| 4 Outcome Optimization | $1,750 | $17,500 |
| **Phases 1–4** | **$4,934** | **$46,210** |
| 5 Personalization + Chat | $350 + $50 more lookups and storage = $400 | $3,500 + $500 = $4,000 |
| **All phases** | **$5,334** | **$50,210** |

Intent feeds (M10) are passed through at the vendor's price (check).

---

## 10. Setup checklist (outside the code)

| Item | Needed by | Lead time |
|---|---|---|
| Google Cloud OAuth app, `gmail.send` and `gmail.readonly` verification | Week 10 | Weeks; start in week 1 |
| Microsoft Entra app (multi-tenant) | Week 10 | Days |
| HubSpot developer account, public app, test portal | Week 7 | Days |
| IP-to-company vendor contract (IPinfo or Snitcher) | Week 3 | 1–2 weeks |
| MaxMind GeoLite2 account and license key | Week 2 | 1 day |
| Voyage AI key | Week 13 | 1 day |
| Fly certificates API token for custom domains | Week 16 | 1 day |
| DPA, sub-processor list, privacy policy update | Week 6 (first install) | 1–2 weeks |
| ClickHouse Cloud | Before Growth | 1 day |
| HubSpot Marketplace listing | Week 24 | Weeks (review) |

---

## 11. Risks

| Risk | Effect | Plan |
|---|---|---|
| Wrong identity links | Reps embarrass themselves, trust is lost | Evidence levels, Probable never acted on, unmerge, nightly rebuild, tests in `docs/identity.md` |
| Low company match rate (remote work, VPN) | Thin data for small teams | Lean on first-party identity (forms, email, pages, gates), add intent feeds in M10 |
| Google verification delay | No Gmail sending at week 10 | Outlook and HubSpot tasks first, Gmail when approved |
| HubSpot rate limits on big portals | Slow first sync | Token bucket, a first sync spread over hours, a progress bar |
| AI spend runs over | Margin drops | `ai_calls` meter, a budget per workspace, decision cache, Batch API, Haiku where it's enough |
| Ad blockers and Safari | Missed visits | Proxy path setup, localStorage backup, server-set cookie |
| Privacy law change or a lawsuit wave | Legal risk | Company-level and first-party only, no third-party graphs, consent modes, erasure |
| Big rivals copy features (HubSpot Breeze, Mutiny) | Harder sales | Speed, a price small teams can pay, one loop from visit to meeting |
