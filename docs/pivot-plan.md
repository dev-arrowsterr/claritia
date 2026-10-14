# Claritia pivot: agentic buyer enablement

One orchestrator agent moves each account from first visit to a booked sales meeting. Under it sit eight modules. They ship in four phases, in this order: Account Intelligence, Action, Buyer Experience, Outcome Optimization.

Market we sit in: PathFactory and Folloze (content experience), RB2B, Warmly and Factors (website intelligence), DataFast (revenue analytics), Mutiny (AI account pages), and Qualified Piper (AI SDR). See the research notes in chat for prices.

## Assumptions per team

| Item | Per team per month |
|---|---|
| Page views on their site | 50,000 |
| Tracked events (views, scroll, clicks, time) | 200,000 |
| Unique visitor IPs to look up | 20,000 |
| Active accounts in HubSpot | 500 |
| Actions the agent proposes | 400 |
| Account pages built | 100 |
| Orchestrator runs | 1,500 |

## What we keep from today's Claritia

| Today | New use |
|---|---|
| Worker claim queue (`claim_run`, `claim_plan`, `claim_exploration`) | One `claim_job` queue for every agent job |
| Step cache | Decision cache: same signals in, no model call |
| Approvals and Heals screens | Approve anything the agent sends or publishes |
| Slack and email alerts (014) | Hot account and deal at risk alerts |
| Sealed secrets with `SECRETS_KEY` | HubSpot, Gmail and Outlook tokens |
| API keys, REST `/api/v1`, MCP server | Same, with new tools for accounts, pages and actions |
| Supabase RLS, security definer RPCs, leak tests | Same tenant model and test style |
| Fly apps and GitHub deploy matrix | Add `claritia-collect`, rename the runner to `claritia-agent` |
| Explorer crawler | Crawls the customer's site to map pages and pull content into the library |
| Chrome extension | Reps see the account brief on any HubSpot or LinkedIn page (later) |

Playwright test screens stay in the repo, off in the nav.

---

## Phase 1: Account Intelligence (9 weeks)

### M0. Foundation (1 week)

What it does: sets up the shared pieces every module uses.

Technical:
- Migration `020_jobs.sql`: one `jobs` table (`kind`, `workspace_id`, `account_id`, `payload jsonb`, `status`, `run_after`, `attempts`, `locked_until`) and `claim_job(kinds text[])` using `for update skip locked`. Old run, plan and explore claims move onto it.
- `accounts` table keyed by `workspace_id` + `domain`, linked to the HubSpot company id.
- `signals` table: one row per thing that happened to an account (`kind`, `source`, `weight`, `at`, `data`).
- Nav and brand: new routes Accounts, Analytics, Content, Pages, Actions, Playbook. Tests move under a Testing tab.
- Credits: reuse `workspace_usage`, add counters for briefs, pages and orchestrator runs.

### M1. Website Intelligence (3 weeks)

What it does: a script on the customer's site records visits, ties visitors to companies and HubSpot contacts, and turns visits into signals.

Technical:
- **Tracking script `claritia.js`**: plain TypeScript bundled with esbuild, under 5 KB gzipped.
  - Events: page view, scroll depth (25/50/75/100), engaged time (Page Visibility API), CTA and outbound clicks, form submits, UTM tags, referrer, SPA route changes (History API).
  - Sends with `navigator.sendBeacon`, batched every 5 seconds and on page hide.
  - First-party cookie `_clr_id` (13 months). A cookieless mode for sites with no consent: daily hash of IP + user agent + a salt that rotates every day, same as Plausible.
  - Reads consent from Google Consent Mode, OneTrust and Cookiebot. No consent means cookieless mode.
  - Custom tracking domain (`t.customer.com` CNAME to collect) so ad blockers don't drop it.
- **Collect service `claritia-collect`** (new Fly app, Node 22 with Hono, 2 machines):
  - `POST /e` takes batches, checks the site key and allowed origin, drops bots (`isbot` user agent list, known data center IP ranges, headless browser flags).
  - Writes raw events to Postgres in monthly partitions (`events_2026_11`), then rolls them up each hour into `daily_page_stats` and `account_visits`.
  - Raw events are kept 90 days. Rollups are kept forever.
  - The raw IP is never stored. Only the company match and a /24 network are kept.
- **Company match (reverse IP)**: lookup by IP with a 30-day cache by /24 network, so each network is paid for once. Vendor options to price: IPinfo, Snitcher API, Dealfront API (all "check"). Match rate is usually 20% to 35% of B2B traffic.
- **Person match** (only from first-party sources):
  - HubSpot `hubspotutk` cookie, joined to the contact through the HubSpot API.
  - Form submits on the site.
  - Clicks from tracked email links that carry a `clr` token.
- **Enrichment**: Coresignal company data by domain (size, industry, location, headcount growth), cached 30 days.
- **Signals out**: high-intent page viewed (pricing, demo, docs, careers ignored), return visit, new person from a known account, visit spike.

Tests:
- A local site with the script, a fake visitor and a bot. The bot makes no signal.
- Consent off means no cookie is set.
- An event burst of 10,000 a second through collect with no drops.

### M2. Buyer Analytics (2 weeks)

What it does: a DataFast-style dashboard for B2B, with revenue tied to accounts and HubSpot deals.

Technical:
- Screens: visitors, sources, pages, countries, devices, live view, goals, funnels, and account journeys (every touch for one account on a timeline).
- Charts with Recharts, styled with `docs/brand.md` tokens.
- Queries run against the rollup tables, so a dashboard loads in under 300 ms.
- Attribution: first touch, last touch and linear, by source and campaign, for HubSpot deals marked closed won. Stripe connect is an option for self-serve revenue (same idea as DataFast).
- Goals: URL match, click on a selector, form submit, or a HubSpot lifecycle change.
- Funnels: ordered steps over the visitor id inside a time window, built in SQL with window functions.

Tests:
- Fixed event fixtures give known totals for each chart and each attribution model.

### M3. Account Intelligence Agent (3 weeks)

What it does: syncs HubSpot, scores every account each day, and writes a weekly brief on the top accounts.

Technical:
- **HubSpot public app** (OAuth 2.0):
  - Scopes: `crm.objects.companies.read/write`, `crm.objects.contacts.read/write`, `crm.objects.deals.read`, `timeline`, `crm.schemas.custom.read`, `sales-email-read`.
  - Tokens sealed with `SECRETS_KEY`. Refresh tokens rotate on use.
  - First sync: CRM Search API by `hs_lastmodifieddate`, paged 100 at a time.
  - Then webhooks for company, contact and deal changes, plus a 15-minute catch-up sync.
  - Rate limit: a token bucket per portal, set under HubSpot's limit for public apps ("check" the current number).
  - Writes back custom properties `claritia_score`, `claritia_stage` and `claritia_brief_url`, plus timeline events like "Viewed pricing page 3 times".
  - Marketplace listing needs a review and a minimum number of installs ("check").
- **Daily score** (Haiku 5.5, structured output with a JSON schema):
  - In: firmographics, last 30 days of signals, deal stage, open tasks.
  - Out: `fit` 0 to 100, `intent` 0 to 100, `stage`, `reason`, `next_step`.
  - Decision cache: a hash of the inputs. Same hash, no call.
- **Weekly brief** (Sonnet 5.5 with the `web_search_20260209` tool, top 50 accounts by score):
  - Company news, buying group (contacts in HubSpot plus Coresignal employee data by title), likely pains, which content to send, and an opening line.
  - Saved as `account_briefs` with sources listed.
- Screens: Accounts list (score, stage as a square tag, last signal) and Account page (brief, timeline, people, deal).

Tests:
- A HubSpot sandbox portal with fixed data. Sync twice and nothing doubles.
- Webhook signature check (HubSpot v3 signature).
- Score schema checks, and the cache skips a second call.

---

## Phase 2: Action Agent (3 weeks)

### M6. Action Agent

What it does: turns briefs and signals into actions, sends them to Approvals, and runs them once approved.

Technical:
- Action types:
  - Email draft to a contact.
  - HubSpot task for the owner.
  - Enroll in a HubSpot sequence.
  - Slack alert to the rep.
  - Update a HubSpot property.
  - Send an account page link (after Phase 3).
- Drafts with Sonnet 5.5, structured output: subject, body, the signal it answers, and the asset it links.
- Sending email:
  - Through the rep's own inbox with the Gmail API (`gmail.send`) or Microsoft Graph (`Mail.Send`).
  - Google needs OAuth app verification for `gmail.send` ("check" the timeline).
  - The sent email is logged to HubSpot as an engagement.
- Approvals: the same queue as Heals. A team can set one action type to run without approval after it has been approved 20 times.
- Guardrails:
  - Daily send cap per rep.
  - HubSpot unsubscribe and do-not-contact checks.
  - No second email to the same contact within 3 days.
  - No email to a contact in an open deal unless the owner approves.
- Every action is saved with the signal that caused it, for Phase 4.

Tests:
- Do-not-contact and caps block a send even when approval is set to auto.
- A failed send retries once, then shows a real error.

---

## Phase 3: Buyer Experience (5 weeks)

### M4. Content Library and Experiences (3 weeks)

What it does: PathFactory-style content tracks. Assets play one after another, with a next-up rail and a form gate, and every second of reading counts as a signal.

Technical:
- **Library**:
  - Upload PDFs and slides to Supabase Storage.
  - Add YouTube, Vimeo and Wistia videos.
  - Add web pages by URL. The Explorer crawler can pull a whole blog or resource center.
- Text out of PDFs with `unpdf`. Web pages through Readability.
- Pages that block iframes (`X-Frame-Options`, CSP `frame-ancestors`) show a saved reader view instead.
- **AI tagging** (Haiku 5.5): topic, persona, funnel stage, a two-line summary, and reading time.
- Embeddings for "what to show next" (Voyage AI, "check" price) in pgvector.
- **Experiences**:
  - A track is an ordered list of assets with a theme and CTAs.
  - The viewer is a Next.js route with pdf.js for documents and player APIs for video watch time.
  - Gate: show a form after N assets or N minutes. The form fills HubSpot through the Forms API.
  - Engagement score per visitor: time on each asset times how much they finished.
- Embed: a script tag drops a track on any page, or it is hosted on a custom domain.

Tests:
- A PDF asset reports time and pages read.
- A blocked-iframe page falls back to the reader view.
- The gate posts to a HubSpot sandbox form.

### M5. Landing Page Builder and Account Pages (2 weeks)

What it does: builds one page per account (Mutiny-style) from the brief and the library, with a meeting link.

Technical:
- **Page format**: JSON blocks (hero, logos, asset grid, case study, quote, video, interactive demo embed, form, meeting booker, FAQ). There is one renderer, so pages always match the brand.
- **Editor**: block list with drag to reorder, inline text editing, and the app's own `Select` and dialogs.
- **AI build** (Sonnet 5.5, structured output in the block schema):
  - In: the account brief, the chosen assets and the team's page template.
  - Every claim on the page must point to an asset or the brief. Lines with no source are removed before save.
- **Hosting**: a Next.js route with incremental static regeneration, on `go.tryclaritia.com/<team>/<account>` or the team's domain.
  - Custom domains through the Fly certificates API, one certificate per hostname ("check" the price).
- Meeting booker: HubSpot Meetings link or a Calendly embed.
- A/B test: split by a hash of the visitor id, with a winner shown when the gap holds for 7 days.
- `claritia.js` is included on every page, so each visit feeds M1.
- Publishing goes through Approvals.

Tests:
- A generated page with a fake fact loses that line.
- The page renders the same on server and client.
- A custom domain gets a certificate in a staging app.

---

## Phase 4: Outcome Optimization (3 weeks)

### M7. Orchestrator and Outcome Optimization

What it does: one agent runs Observe, Reason, Plan, Execute and Evaluate for each account, and a weekly review tunes the playbook.

Technical:
- **Orchestrator** (Sonnet 5.5 with tool use, prompt caching on the playbook and tool list):
  - Tools it can call: `get_account`, `get_signals`, `search_content`, `build_page`, `draft_email`, `create_task`, `alert_rep`, `set_stage`, `wait_until`.
  - It runs when an account gets a new signal, held back 10 minutes so a burst of visits makes one run. Each account has a daily run cap.
  - Every tool that sends or publishes goes through M6 Approvals.
  - Account stages: Unknown, Engaged, Researching, Evaluating, Meeting booked, In deal. Each stage is a square tag.
  - Every run writes a log: what it saw, what it chose, and why. The log shows on the Account page.
- **Outcome review** (Opus 5.5 through the Batch API, weekly per workspace):
  - In: actions, pages, content views and the result for each account (meeting booked, deal created, no reply).
  - Out: which plays worked, which assets moved accounts forward, and proposed playbook changes. Changes go to Approvals.
- **Playbook**: versioned rules and prompts per workspace, with a diff view and rollback.
- **Dashboard**: accounts moved to meeting, time to meeting, pipeline from Claritia actions, and wins by action type.
- MCP: new tools `list_accounts`, `get_brief`, `propose_action` and `build_page`, so Claude Code and other agents can drive it.

Tests:
- Replay a fixed signal stream. The orchestrator makes the same choices each time with the cache on.
- A run that hits its cap stops and logs why.
- Approval rules hold even when the model asks to skip them.

---

## Monthly cost

### AI per team

| Phase | Model use | Per team |
|---|---|---|
| 1 | Haiku daily scores $7, Sonnet briefs with web search $22 | $29 |
| 2 | Sonnet drafts | $12 |
| 3 | Sonnet pages $10, Haiku tagging and embeddings under $1 | $10 |
| 4 | Sonnet orchestrator $30, Opus review $2, Haiku tagging $3 | $35 |
| **Total** | | **$86** |

Claude prices used: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per million tokens. Web search $10 per 1,000 searches (check).

### Monthly bill by phase

| Phase | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| 1 Account Intelligence | AI $1,450 + infra $604 = **$2,054** | AI $14,500 + infra $3,030 = **$17,530** |
| 2 Action | AI $600 + Resend $20 = **$620** | AI $6,000 + Resend $90 (check) = **$6,090** |
| 3 Buyer Experience | AI $500 + domains and storage $10 = **$510** | AI $5,000 + domains and storage $90 = **$5,090** |
| 4 Outcome Optimization | AI **$1,750** | AI **$17,500** |
| **Total** | **$4,934** | **$46,210** |

That is about $99 per team at Beta and $92 per team at Growth.

### Infra lines in Phase 1

| Item | Beta | Growth |
|---|---|---|
| Fly `claritia-web` | $5 (check) | 2 × 1 GB, $20 (check) |
| Fly `claritia-collect` | 2 × 256 MB, $4 (check) | 3 × 512 MB, $15 (check) |
| Fly `claritia-agent` | 1 GB, $10 (check) | 3 × 2 GB, $60 (check) |
| Supabase | Pro $25 + Medium compute $60 (check) | Pro $25 + Large compute $110 (check) |
| Event store | in Postgres | ClickHouse Cloud, $300 (check) |
| Reverse IP lookups | 1M a month, $500 (check) | 10M a month, $2,500 (check) |

At Growth, raw events move to ClickHouse. The rollups stay in Postgres, so the app code reading dashboards stays the same.

Ways to cut the bill:
- Batch API on briefs and reviews saves about $11 per team.
- The /24 cache on reverse IP lookups cuts paid lookups by about half (check against real traffic).

## Timeline

| Weeks | Work |
|---|---|
| 1 | M0 Foundation |
| 2 to 4 | M1 Website Intelligence |
| 5 to 6 | M2 Buyer Analytics |
| 7 to 9 | M3 Account Intelligence Agent |
| 10 to 12 | M6 Action Agent |
| 13 to 15 | M4 Content Library and Experiences |
| 16 to 17 | M5 Landing Page Builder and Account Pages |
| 18 to 20 | M7 Orchestrator and Outcome Optimization |

## Accounts and keys to set up

| What | When |
|---|---|
| HubSpot developer account, public app, test portal | Before M3 |
| Reverse IP vendor contract | Before M1 |
| Google Cloud OAuth app with `gmail.send` verification, Microsoft Entra app | Start in week 1. Google review takes weeks. |
| Voyage AI key | Before M4 |
| ClickHouse Cloud | Before Growth |
| Privacy: DPA, sub-processor list, cookie notice text for customers | Before the first customer installs `claritia.js` |
