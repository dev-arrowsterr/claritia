# M1 Website Intelligence: build plan

The day-by-day plan to build M1 from `docs/marketing-platform.md`. It covers what gets built, in which files, with which tables, endpoints, jobs, screens and tests, and in what order.

Rules come from three specs, and this plan doesn't repeat them:

| Spec | What it settles |
|---|---|
| `docs/identity.md` | Device ids, cookies, install modes, evidence levels, stitching rules, account resolution, erasure |
| `docs/account-intelligence.md` Part 3 | Region policy, GPC, never-collect list, retention, data requests |
| `docs/account-intelligence.md` Parts 5, 7, 8 | Company resolution, website signals, fit, intent, stage, priority |

---

## Part 1. Scope

### 1.1 What a customer can do at the end of M1

1. Add a site in Settings, choose an install mode, paste one tag (or set the proxy path), and see "Receiving events" within a minute.
2. Watch **Visitors**: live visits with company, country, pages and time, plus "Unknown" for unmatched visits.
3. Open **Accounts**: every company that visited, with fit, intent, temperature, stage, people and last signal.
4. Open an **Account page**: why-now line, timeline of sessions and pages, known people, firmographics, and score details.
5. Open a **Person page**: identifiers with levels, devices, evidence, sessions, plus Unmerge, Unlink and Erase.
6. Get a **Slack alert** when a target account heats up.
7. See hot accounts **pushed to Omniscient** as an activity on the account (once the Omniscient API from `docs/marketing-platform.md` Part 5.1 is live).
8. Handle privacy requests from the **Privacy** screen and the API.

### 1.2 In and out

| In M1 | Later |
|---|---|
| Script, collect, sessions, bots, region policy, GPC, consent, cookieless mode | ClickHouse (Growth) |
| Install modes A to D, proxy recipes, health check | WordPress plugin (week 9) |
| Identity: evidence, stitching, backfill, undo, rebuild, erasure | Calendly and Typeform adapters (with M6) |
| Signed and unsigned identify, form capture, HubSpot and Marketo form adapters | `hubspotutk` lookup (with the HubSpot sync in M2) |
| Company match: IPinfo, IP cache, learned networks, domain aliases, redirects | Snitcher fallback, bring your own key for 6sense and Demandbase |
| Enrichment: Coresignal company data | People suggestions, tech scan, job boards, news |
| Website signals, fit v0 (ICP rules), intent, stage, temperature, priority | Fit v1 (learned), backtests (M7) |
| Visitors, Accounts, Account, Person, Sites, Identity, ICP, Privacy screens | Reports (M8) |
| Slack alerts, basic Omniscient push | Full routing and handoff (M7) |
| REST and MCP read endpoints | Webhooks out |

### 1.3 Dependencies

| Need | From | When |
|---|---|---|
| Jobs queue (`claim_job`), nav, audit and privacy tables | M0, week 1 | Before day 1 of M1 |
| IPinfo Business token | Founder | Day 9 |
| Coresignal plan with enough credits (Mini to start) | Founder | Day 14 |
| Omniscient API (`POST /api/v1/activities`, accounts upsert) | Omniscient repo | Day 24 |
| Slack alerts app (exists, migration 014) | Built | — |

---

## Part 2. System design

### 2.1 Components

```
 Browser                      Fly: claritia-collect            Supabase Postgres            Fly: claritia-intel
 ───────                      ─────────────────────            ─────────────────            ───────────────────
 claritia.js ──/_clr/*──►     /s.js  (script)                  sites, devices, sessions     claim_job loop:
  (or direct)                 /e     (events)  ──COPY──►       events (daily partitions)     stitch, ip_lookup,
                              /i     (identity) ─insert─►      identity_evidence ─┐          enrich, signal, score,
                              /x     (hop token)                jobs ◄─────────────┘          alert, push, rollup,
                              /reset /opt /health               ip_cache, accounts…          retention, checks
                                                                       ▲                          │
 Next.js app (claritia-web) ── RPCs + RLS ─────────────────────────────┘ ◄────────────────────────┘
 Visitors · Accounts · Account · Person · Settings · Privacy           Slack, Omniscient, IPinfo, Coresignal
```

**New Fly apps:**

| App | Size | Why separate |
|---|---|---|
| `claritia-collect` | 2 × shared-cpu-1x, 256 MB, always on, in nrt | Public, high volume, must stay up and fast |
| `claritia-intel` | 1 × shared-cpu-1x, 512 MB, always on | Fast jobs with no browser (stitch, lookups, scores). The runner stays a separate app that sleeps when idle and keeps Chromium for Funnel QA. |

### 2.2 Life of one visit

| Step | Where | Time budget |
|---|---|---|
| 1. The page loads `/_clr/s.js` (proxy) or `collect.tryclaritia.com/s.js` | Browser | Script ≤ 6 KB gzipped, loaded with `defer` |
| 2. The script queues `view`, and sends a batch after 5 s, at 20 events, or on page hide | Browser | — |
| 3. Collect checks site key, origin, size and rate. Works out policy from geo, GPC and consent. Reads or sets `_clr_id`. Finds or starts the session. Drops bots. | collect | p99 ≤ 50 ms |
| 4. Collect buffers rows and flushes with `COPY` every 1 s or 500 rows | collect → Postgres | ≤ 1 s |
| 5. New network: queue `ip_lookup`. New evidence: queue `stitch`. High-value page: queue `signal`. | collect → jobs | — |
| 6. Intel runs the jobs: stitch (≤ 5 s), IP lookup (≤ 10 s), signal and score (≤ 30 s) | intel | — |
| 7. Score crosses an alert rule: queue `alert` and `push` | intel | Signal to Slack ≤ 2 min p95 |
| 8. Hourly rollups feed Visitors and Accounts | pg_cron | — |

### 2.3 Environment

| Var | App | Purpose |
|---|---|---|
| `DATABASE_URL` (Supavisor pooler, transaction mode) | collect, intel | Direct Postgres for COPY and fast writes |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | intel | Storage and RPC calls |
| `CLR_ID_SECRET` | collect | Signs device ids (one per site is derived as HMAC(CLR_ID_SECRET, site_id)) |
| `CLR_SALT_SECRET` | collect | Seeds the daily cookieless salt (the salt itself rotates daily) |
| `IPINFO_TOKEN` | intel | Company, geo and privacy lookups |
| `GEO_DB_PATH` | collect | Local geo file for country and region at intake (IPinfo's free country-ASN download, or MaxMind GeoLite2; check license) |
| `CORESIGNAL_API_KEY` | intel | Enrichment. In this cloud session the proxy injects it. |
| `SECRETS_KEY` | intel | Unseal Slack and Omniscient tokens |
| `ANTHROPIC_API_KEY` | intel | Score reason text (Haiku) |

---

## Part 3. Files

```
collect/
  server.ts            Hono app: routes, middleware order
  routes/script.ts     GET /s.js  (serves the built script, cache 1 h, versioned path /s.<hash>.js)
  routes/events.ts     POST /e
  routes/identity.ts   POST /i
  routes/hop.ts        GET /x  (hop token)
  routes/control.ts    POST /reset, POST /opt, GET /health
  policy.ts            region policy from geo + GPC + consent + site overrides
  ids.ts               sign and verify device ids, hop tokens
  sessions.ts          find or start a session (in-memory LRU + Postgres)
  bots.ts              isbot list, data center ranges, hint scoring
  geo.ts               local geo file lookup
  scrub.ts             URL and field scrubbing (shared with the script)
  buffer.ts            COPY buffer with flush, backpressure, retry
  limits.ts            per-IP and per-site token buckets
  ranges/              cloud provider range files, refreshed daily
  Dockerfile, fly.collect.toml
collect/script/
  index.ts             entry: config from data attributes, queue, batching
  consent.ts           Google Consent Mode v2, OneTrust, Cookiebot, claritia.consent
  spa.ts               pushState/replaceState/popstate, bfcache, prerender
  engage.ts            active time, scroll depth
  clicks.ts            CTA and outbound clicks
  forms.ts             submit capture, email field finder, never-read rules
  adapters/hubspot.ts  hsFormCallback
  adapters/marketo.ts  MktoForms2
  identify.ts          claritia.identify / reset / track / optOut
  hop.ts               cross-domain link decoration
  build.mts            esbuild, size check (fails the build over 6 KB gzipped)
src/lib/web/
  policy.ts            shared policy table (used by collect and the app)
  signals.ts           website signal rules
  scores.ts            fit v0, intent, stage, temperature, priority
  rollups.ts           query helpers for screens
src/lib/identity/
  clean.ts             email and identifier cleaning (docs/identity.md Part 6)
  stitch.ts            the stitch algorithm (docs/identity.md 7.7)
  rebuild.ts           group rebuild and the nightly check
  erase.ts             erasure and export
  lists/               free, disposable, role inbox lists
src/lib/company/
  domains.ts           cleaning, PSL, hosting list, redirects
  ipinfo.ts            client with cache and rate limits
  coresignal.ts        company enrichment client
  resolve.ts           account priority rules, learned networks
src/lib/suite/omniscient.ts   activity push (basic)
worker-intel/
  index.ts             claim_job loop for intel kinds, health port
  jobs/*.ts            one file per job kind (Part 6)
  Dockerfile, fly.intel.toml
src/app/(app)/visitors, accounts, accounts/[id], people/[id], settings/sites, settings/identity,
  settings/icp, privacy        screens (Part 8)
src/app/api/v1/visitors, accounts, people, privacy/requests      REST (Part 9)
supabase/migrations/021_web.sql, 022_intel.sql
tests/ and scripts/            (Part 11)
```

---

## Part 4. Database

Two migrations. Both follow the existing pattern from `001_base.sql`:
- RLS on every table, with `is_member(workspace_id)` for reads.
- No client writes. Writes go through security definer RPCs or the service role.
- A leak test for every table in `tests/db/leaks.sql`.

### 4.1 `021_web.sql`: sites, devices, sessions, events

```sql
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null,                                  -- registrable domain, cleaned
  extra_domains text[] not null default '{}',
  site_key text not null unique default encode(gen_random_bytes(12), 'base64'),
  proxy_secret text not null default encode(gen_random_bytes(24), 'hex'),
  install_mode text,                                     -- proxy, a_record, cname, direct (seen, not chosen)
  policy_overrides jsonb not null default '{}',          -- {"strict": ["CA-QC"], "off": ["RU"]}
  private_paths text[] not null default '{}',
  url_param_allow text[] not null default '{utm_source,utm_medium,utm_campaign,utm_term,utm_content,gclid,fbclid,ref,page,q}',
  city_level bool not null default true,
  honor_dnt bool not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, domain)
);

create table public.devices (
  id uuid primary key,
  workspace_id uuid not null, site_id uuid not null references public.sites (id) on delete cascade,
  state text not null default 'fresh' check (state in ('fresh','probable','linked','shared','tainted','internal','opted_out')),
  state_since timestamptz not null default now(), tainted_until timestamptz,
  no_backfill bool not null default false, consent text,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), sessions int not null default 0
);
create index on public.devices (workspace_id, state);
create index on public.devices (workspace_id, last_seen);

create table public.sessions (
  id uuid primary key,
  workspace_id uuid not null, site_id uuid not null, device_id uuid,              -- null when cookieless
  cookieless_key bytea,                                                          -- daily hash, cookieless only
  started_at timestamptz not null, ended_at timestamptz not null,
  policy text not null, consent text, gpc bool not null default false,
  country text, region text, city text,
  device_type text, browser text, os text,
  landing_path text, referrer_host text, source text, medium text, campaign text, term text, content text,
  ref_class text,                                     -- search, ai_assistant, review_site, social, partner, email, direct
  ip_net cidr, ip_kind text,
  person_id uuid, person_level text, person_source text,
  account_id uuid, account_source text, network_account_id uuid,
  pageviews int not null default 0, engaged_s int not null default 0,
  internal bool not null default false, is_bot bool not null default false, split_from uuid
);
create index on public.sessions (workspace_id, started_at desc);
create index on public.sessions (workspace_id, device_id, started_at);
create index on public.sessions (workspace_id, account_id, started_at desc);
create index on public.sessions (workspace_id, person_id, started_at desc);

create table public.events (
  id uuid not null, workspace_id uuid not null, session_id uuid not null,
  day date not null, kind text not null,              -- view, engage, click, form, identify, custom
  path text, title text, data jsonb, client_at timestamptz, server_at timestamptz not null,
  primary key (day, id)
) partition by range (day);
-- Partitions: one per day, made 7 days ahead by pg_cron (make_event_partitions()),
-- dropped after the site's retention (default 90 days) by drop_old_event_partitions().
create index on public.events (workspace_id, session_id);

create table public.page_groups (
  workspace_id uuid not null, site_id uuid not null, pattern text not null,     -- glob: /pricing*, /vs/*
  grp text not null,                                  -- pricing, demo, compare, security, integrations, docs,
                                                      -- case_study, product, blog, careers, legal, login, private
  competitor text,                                    -- for compare pages
  source text not null default 'user',                -- user, suggested
  primary key (site_id, pattern)
);

create table public.salts (day date primary key, salt bytea not null);           -- deleted after 24 h; service role only
create table public.opt_outs (site_id uuid, device_hash bytea, created_at timestamptz default now(), primary key (site_id, device_hash));
create table public.hop_nonces (nonce bytea primary key, used_at timestamptz not null default now());

-- Rollups (no person data in site_daily)
create table public.site_daily (
  site_id uuid, day date, path text, source text, medium text, campaign text, ref_class text,
  country text, device_type text,
  visitors int, sessions int, views int, engaged_s bigint, bounces int,
  primary key (site_id, day, path, source, medium, campaign, ref_class, country, device_type)
);
create table public.account_daily (
  workspace_id uuid, account_id uuid, day date,
  sessions int, people int, devices int, views int, engaged_s int, high_views int,
  primary key (workspace_id, account_id, day)
);
```

### 4.2 `023_intel.sql`: identity, accounts, signals, scores (evidence is in `022_evidence.sql`)

The identity tables are exactly as in `docs/identity.md` Part 11: `persons`, `person_aliases`, `identifiers`, `identity_evidence`, `device_links`, `merge_proposals`, `email_tokens`, `learned_networks`, `ip_cache`, `deletions`.

Plus:

```sql
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  domain text not null, name text, logo_url text,
  firmo jsonb,                                        -- size, industry, country, founded, growth (Coresignal)
  firmo_at timestamptz,
  owner_user_id uuid, omniscient_account_id text, hubspot_company_id text,
  fit int, intent int, priority numeric, stage text, stage_since timestamptz, temperature text,
  why_now text, last_signal_at timestamptz, first_seen timestamptz not null default now(),
  flags text[] not null default '{}',                 -- shared_network, partner, customer
  unique (workspace_id, domain)
);
create index on public.accounts (workspace_id, priority desc);

create table public.account_domains (workspace_id uuid, domain text, account_id uuid, source text, confidence int,
  primary key (workspace_id, domain));
create table public.domain_aliases (domain text primary key, canonical text not null, source text, checked_at timestamptz);
create table public.company_cache (domain text primary key, data jsonb, vendor text, fetched_at timestamptz);
create table public.network_flags (workspace_id uuid, net cidr, flag text, by_user uuid, created_at timestamptz default now(),
  primary key (workspace_id, net, by_user));

create table public.signal_types (
  workspace_id uuid, kind text, weight numeric not null, half_life_days numeric not null,
  dedupe text not null, enabled bool not null default true, primary key (workspace_id, kind)
);
create table public.signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null, account_id uuid not null, person_id uuid,
  kind text not null, weight numeric not null, at timestamptz not null,
  dedupe_key text not null, evidence jsonb not null,
  unique (workspace_id, dedupe_key)
);
create index on public.signals (workspace_id, account_id, at desc);

create table public.icp (workspace_id uuid primary key, rules jsonb not null, updated_at timestamptz);
create table public.account_scores (
  account_id uuid, at timestamptz, fit int, intent int, priority numeric, stage text, temperature text,
  why_now jsonb, reasons jsonb, score_version int, inputs_hash text, primary key (account_id, at)
);
create table public.intent_params (workspace_id uuid primary key, k numeric not null, fitted_at timestamptz);
create table public.feedback (workspace_id uuid, account_id uuid, user_id uuid, kind text, note text,
  created_at timestamptz default now());
create table public.alert_rules (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, user_id uuid,
  rule jsonb not null, channel text not null, quiet_hours jsonb, daily_cap int not null default 10, enabled bool not null default true
);
create table public.alert_log (rule_id uuid, account_id uuid, sent_at timestamptz, primary key (rule_id, account_id, sent_at));
```

### 4.3 RPCs the app uses

All are security definer, check `is_member`, and return only what the screen needs.

| RPC | Returns |
|---|---|
| `visitors_live(ws, site, since)` | Last 30 min of sessions: account or country, pages, time, person level |
| `accounts_list(ws, filters jsonb, sort, page)` | Account rows for the table |
| `account_detail(ws, id)` | Header, why-now, firmographics, people, score details |
| `account_timeline(ws, id, before, limit)` | Sessions with pages, forms and signals, newest first |
| `person_detail(ws, id)` | Identifiers, devices, links, evidence, sessions |
| `site_health(ws, site)` | Last event, install mode, Safari cookie survival, identified share |
| `identity_health(ws)` | The metrics from `docs/identity.md` Part 16 |
| `unmerge(ws, person, identifier_ids)`, `unlink(ws, device, person)`, `mark_kiosk(ws, device)` | Write an undo and queue a rebuild |
| `privacy_find(ws, email)`, `privacy_erase(ws, person)`, `privacy_export(ws, person)` | Privacy screen |
| `set_page_groups`, `set_icp`, `set_signal_types`, `set_alert_rule`, `add_site`, `update_site` | Settings |

### 4.4 pg_cron jobs

| Schedule | Function |
|---|---|
| Hourly at :05 | `rollup_hour(now() - 3h, now())`: site_daily and account_daily |
| 01:00 UTC | `make_event_partitions()`, `drop_old_event_partitions()` |
| 01:10 UTC | Queue `retention`, `learned_networks`, `identity_rebuild_check`, `untaint`, `intent_refit` (weekly) |
| Every minute | Queue `script_health` per site with no events in 24 h (sends one alert per day) |
| 00:00 UTC | Rotate the salt: insert today's, delete older than 24 h |

---

## Part 5. The script and collect

### 5.1 Script API

```html
<script defer src="/_clr/s.js" data-site="SITE_KEY"></script>          <!-- mode A: proxy -->
<script defer src="https://collect.tryclaritia.com/s.js" data-site="SITE_KEY"></script>   <!-- mode D -->
```

```js
claritia.identify({ userId, email, iat, token })   // signed is Verified, unsigned is Asserted
claritia.track(name, props)                         // props ≤ 2 KB, scrubbed
claritia.form(email)                                // for fetch-only forms
claritia.consent(true | false)
claritia.optOut()
claritia.reset()                                    // call on logout
```

Data attributes: `data-site`, `data-consent="auto|wait|on"`, `data-domains="acme.io,acme.dev"`, `data-private="/account,/checkout/*"` (also enforced by collect), `data-api` (endpoint override).

Calls made before the script loads are queued by a one-line stub and replayed: `window.claritia=window.claritia||function(){(claritia.q=claritia.q||[]).push(arguments)}`.

**Built (day 2–5):** `collect/scrub.ts` (shared), `collect/script/*`, `npm run build:script` (gate: 6 KB gzipped, now 5.7 KB), `tests/scrub.test.ts`, `tests/script.test.ts`, and `scripts/script-check.ts` (35 checks in Chromium against a fake collect).

### 5.2 Event batch (POST /e)

```json
{
  "v": 1, "site": "SITE_KEY", "did": "only in modes C and D",
  "consent": {"state": "granted|denied|unknown", "tool": "gcm|onetrust|cookiebot|api"},
  "gpc": false, "hutk": null, "clr": null, "hop": null,
  "human": {"pointer": 12, "scroll": 3, "keys": 0, "first_input_ms": 1840},
  "events": [
    {"id": "uuidv7", "k": "view", "t": 1760000000123, "u": "/pricing?utm_source=x", "ti": "Pricing", "r": "https://www.google.com/"},
    {"id": "uuidv7", "k": "engage", "t": 1760000015123, "u": "/pricing", "d": {"active_s": 14, "scroll": 75}},
    {"id": "uuidv7", "k": "click", "t": 1760000020000, "u": "/pricing", "d": {"text": "Book a demo", "href": "/demo", "out": false}}
  ]
}
```

Collect answers `200 {"p": "full|cookieless|off"}`, plus `"did"` in modes C and D when a new id was made. The script sends nothing that names a person (forms, identify, `hutk`, hop requests) and stores nothing until a batch has come back with `"p": "full"`. That's why the first batch goes at once. `"off"` stops the script for the page.

A batch that fails (network, `429`, `5xx`) is sent once more with the next batch, with the same event ids. A hidden tab sends with `fetch` so it can retry. Leaving the page uses `sendBeacon`. Errors: `400` (bad shape), `403` (key or origin), `413` (too big), `429` (rate).

### 5.3 Identity batch (POST /i)

```json
{ "v": 1, "site": "SITE_KEY", "did": "modes C/D only", "session_hint": "uuid",
  "kind": "form|identify|adapter", "source": "native|hubspot|marketo",
  "email": "jane@acme.com", "userId": null, "iat": null, "token": null, "page": "/demo", "form": "demo-form" }
```

The kind and source map to evidence levels per `docs/identity.md` 5.10.

### 5.4 Middleware order in collect

1. Size limit (64 KB), then parse JSON.
2. Site lookup by key (in-memory cache for 60 s), then origin check against domain and extra domains.
3. Client IP: `X-Clr-Client-IP` only with a matching `X-Clr-Proxy` secret, otherwise the socket IP.
4. Rate limits: 50 requests a second per IP, 2,000 a second per site (in-memory buckets per instance). A per-site count in Postgres catches abuse across instances.
5. Geo lookup (local file), then the `/24` or `/48` network. The full IP is kept in memory only.
6. **Policy** (`docs/account-intelligence.md` 3.2): region, then site overrides, then GPC, then consent, then opt-out cookie.
7. **Device:** verify `_clr_id`, or issue one if policy allows. Modes A and B set an HttpOnly cookie. Modes C and D return the id.
8. **Bot score:**
   - `isbot` user agent, or a data center range: drop.
   - `webdriver` true, or no input after 30 s with more than 10 views: mark bot.
9. **Session:** in-memory LRU of device to session (30 min), with Postgres as the source of truth. Split rules from `docs/identity.md` 4.6.
10. Scrub URLs and props (`scrub.ts`). Drop events on `private_paths`.
11. Buffer the rows. Queue jobs: `ip_lookup` if the network isn't in a 1-hour local seen-set, `signal` for page-group hits, `stitch` for evidence.
12. Reply.

### 5.5 Write path

- Each collect instance has a buffer of `events`, `sessions` upserts and `devices` upserts.
- Flush every 1 s or at 500 rows: `COPY events FROM STDIN` into a temp table, then `insert … on conflict do nothing` into the partition.
- Sessions use `insert … on conflict (id) do update` to set `ended_at`, `pageviews` and `engaged_s` with `greatest()`.
- **Backpressure:** if the buffer passes 20,000 rows (the database is slow), collect answers `503` with `Retry-After: 5`, and the script keeps the batch in `sessionStorage` and retries once.
- **On shutdown** (SIGTERM from Fly), flush and then exit. Fly's kill timeout is set to 30 s.

### 5.5a Built (week 3)

- **Files:** `collect/app.ts` (routes), `server.ts`, `store.ts` (Postgres), `buffer.ts`, `sessions.ts`, `ids.ts`, `geo.ts`, `bots.ts`, `attribution.ts`, `ua.ts`, `limits.ts`, `src/lib/web/policy.ts`, `src/lib/web/proxy.ts` (the Next.js proxy recipe, used by tryclaritia.com at `/_clr/*`), `supabase/migrations/022_evidence.sql`.
- **Tests:** `tests/collect.test.ts` (routes, the 144-case policy matrix, ids, hop, bots, sessions, buffer), `tests/proxy.test.ts`, `tests/pg/collect.pg.ts` (real Postgres: retries don't double, a killed write rolls back whole, shutdown loses nothing) and `scripts/collect-check.ts` (Chromium → script → proxy → collect → Postgres). `npm run test:db` runs the last two.
- **Changes from the plan:**
  - Writes use one `insert … select from unnest(…) on conflict do nothing` statement that also adds the rows it really inserted to the sessions' counts. No COPY and no temp table. Same speed at our sizes, and a retry can't double a count.
  - An event's day comes from its uuid v7 time, so a batch retried after midnight lands in the same day table.
  - The script says how it's installed (`m`: `a` proxy, `s` subdomain, `d` direct) and collect sets the HttpOnly cookie for `a` and `s`, or returns `did` for `d`. A request in mode `a` without the proxy secret has the proxy's IP, so its network isn't kept and it gets no company lookup.
  - Cloud networks are matched by ASN from the geo file. They're marked as bots and unmarked when the visit shows real input (people on cloud desktops are buyers). Only crawler user agents (`isbot`) are dropped.
  - New sessions and devices are written at once (one transaction), so the second instance finds them. Only events wait in the buffer.
  - Signed `identify` tokens are checked by the stitch job, which holds the secrets. Collect stores the token with the evidence.
  - Identity tables beyond evidence move to `023_intel.sql`.
- **Live:** `claritia-collect` deploys with the others and stays idle (health says what's missing, everything else is 503) until `DATABASE_URL` and `CLR_ID_SECRET` are set. One machine for now; scale to two before customer traffic.

### 5.6 `fly.collect.toml`

```toml
app = "claritia-collect"
primary_region = "nrt"
kill_timeout = 30
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 2
  [http_service.concurrency]
    type = "requests"
    soft_limit = 800
    hard_limit = 1000
[[http_service.checks]]
  path = "/health"
  interval = "15s"
  timeout = "2s"
[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Custom domains: `collect.tryclaritia.com`, and per-customer mode B and C subdomains through Fly certificates.

---

## Part 6. Intel jobs

All jobs run in `claritia-intel` through `claim_job(kinds)`. Each one can be run twice with the same result.

| Job | Key | Input | What it does | Retries |
|---|---|---|---|---|
| `stitch` | device | evidence id | `docs/identity.md` 7.7. Queues `identity_changed`. | 5, backoff |
| `identity_changed` | person | person id | Re-resolve accounts for affected sessions, queue `score_account` | 5 |
| `ip_lookup` | network | network, sample IP (in the payload, encrypted with a key held only in memory by collect and intel, deleted after use) | IPinfo lookup, save `ip_cache`, set account on sessions from that network in the last hour, queue `enrich_company` | 3 |
| `enrich_company` | domain | domain | Domain cleaning and redirects, `company_cache` (30-day TTL), Coresignal company data, write `accounts.firmo` | 3 |
| `signal` | session | session id | Apply the website signal rules (`src/lib/web/signals.ts`), write `signals` with dedupe keys, queue `score_account` | 5 |
| `score_account` | account (debounced 60 s) | account id | Fit v0, intent, stage, temperature, priority, why-now. Save `account_scores`. Haiku reason only when the band changes. Check alert rules. | 3 |
| `alert` | rule + account | ids | Send to Slack or email through alerts (014), honoring quiet hours and the daily cap | 5 |
| `omniscient_push` | account | account id | Upsert the account and log a "Hot on website" activity in Omniscient | 5 |
| `learned_networks` | workspace | — | Nightly, `docs/identity.md` 8.3 | 3 |
| `identity_rebuild_check` | workspace | — | Rebuild 200 random groups in a scratch schema and compare | 1 |
| `retention` | — | — | Delete past retention. Write counts to `audit_log`. | 3 |
| `untaint` | — | — | End 30-day taints | 3 |
| `intent_refit` | workspace | — | Weekly fit of `k` so the 95th percentile account is about 90 | 3 |
| `script_health` | site | — | Alert once a day when no events arrive for 24 h | 1 |
| `suggest_page_groups` | site | — | Explorer crawl (runner job) of up to 200 pages, rules first, then Haiku for leftovers. Suggestions go to Settings for approval. | 2 |

**Throughput targets (one intel machine):**
- 500 stitch rows a second.
- 50 IP lookups a second, within the IPinfo plan limit (check).
- 200 score recomputes a second.

The intel app scales by machine count, since jobs are claimed with `skip locked`.

---

## Part 7. Company resolution and scoring in M1

### 7.1 IPinfo use

- **Call:** one IPinfo API call per uncached IP (check the current endpoint and field names on the Business plan: company name, domain and type, ASN type, and privacy flags for VPN, proxy, hosting and relay).
- **Network kind:**

| IPinfo says | Kind |
|---|---|
| Company type business, or ASN type business | `business` |
| ASN type isp | `isp` |
| Hosting flag, or ASN type hosting | `hosting` |
| VPN, proxy or relay flag | `vpn` |
| Mobile carrier | `mobile` |
| Education | `education` |
| Government | `government` |

- **Confidence:**
  - 90 when the company domain matches the ASN owner domain;
  - 75 when the company type is business but the ASN is an ISP (business on a broadband line);
  - 60 otherwise.
  - Only 70+ sets an account (`docs/identity.md` 8.1).
- **Cache:** by /24 when IPinfo returns the same company for 3 IPs in that /24. Otherwise by `HMAC(cache_secret, ip)` for 30 days. Raw IPs are never stored.

### 7.2 Domain and account

- Cleaning, the Public Suffix List, hosting domains and redirect aliases come from `docs/account-intelligence.md` 5.1. Code: `src/lib/company/domains.ts`, using the `psl` package or a bundled list (check license).
- **Priority order:** CRM link (Omniscient account, later), then work email, then learned network, then vendor network (`docs/identity.md` 8.1).
- A new domain creates an `accounts` row and queues `enrich_company`.

### 7.3 Coresignal

- **What's used:** company enrichment by domain. Fields: name, logo, size band, industry, HQ country, founded, 6- and 12-month headcount growth.
- **When:**
  - only for accounts with 1+ non-bot, non-internal session that scored above zero;
  - or accounts that are linked to a CRM record.
- **Cache:** `company_cache` holds company data only and is shared across workspaces (check the license), with a 30-day TTL.
- **Endpoint:** check the current company enrich endpoint and its credit cost (10 credits for a base record, 20 for multi-source, per the pricing seen).

### 7.4 Signals in M1

The website set from `docs/account-intelligence.md` 7.1:
- `page_pricing`, `page_demo`, `page_compare`, `page_security`, `page_integrations`
- `docs_depth`, `case_study`, `return_visit`, `multi_person`
- `review_site_ref`, `ai_assistant_ref`
- `engaged_session`, `spike`
- `form_submit` and `demo_request` (from evidence)
- `new_person`

Defaults are seeded into `signal_types` for each new workspace.

### 7.5 Scores in M1

| Score | Rule |
|---|---|
| Fit v0 | ICP rules from Settings (`docs/account-intelligence.md` 8.1 version 0) |
| Intent | Decay sum, per-person cap 40%, breadth bonus up to 1.6×, `1 − e^(−raw/k)` (8.2) |
| Stage | Unknown, Engaged, Researching, Evaluating (8.3, without deal stages until M2 syncs) |
| Temperature | 7-day vs 28-day |
| Priority | intent × (0.4 + 0.6 × fit/100) × stage factor × owner factor |
| Why-now | The top 2 signal contributions in the last 7 days, as plain text built from templates (no AI) |
| Reason | Haiku 5.5, only when the stage or the intent band (0–39, 40–69, 70+) changes. Plain-math fallback if the call fails. |

---

## Part 8. Screens

All screens:
- Load through the RPCs in 4.3.
- Use `ListTable` with column filters and saved views (the same pattern as Omniscient).
- Use square tags for states and the app's `Select` and dialogs.
- Show a `ToolIntro` until there's data.

### 8.1 Settings › Sites

**Empty state** (`ToolIntro`): "See which companies visit your site". Short lead. Feature cards: Visitors, Accounts, Alerts. Add site button.

**Add site** (a dialog): domain, then extra domains.

**Install** (a tab per mode, with Proxy first and marked "Best"):
- A copy row for the script tag.
- Proxy recipes per platform (`docs/identity.md` 4.3), as copy blocks with the site's `proxy_secret` filled in.
- DNS records for modes B and C, with a live check tag.

**Verify:** a "Waiting for events" tag that turns into "Receiving events" (polls `site_health` every 5 s while open). It shows the detected mode, and warns on C and D about Safari.

**Settings per site:**
- Extra domains, private paths and URL parameters kept.
- City on or off, DNT.
- Region overrides (`Select` list of countries: strict or off).
- Page groups: suggested list with Accept and Edit, plus the add pattern form.

### 8.2 Settings › Identity

As in `docs/identity.md` Part 13:
- Identify secret (show, rotate) with Node, Python, Ruby, PHP and Go snippets.
- Own domains, partner domains, office IPs, and "This is me" links.
- Health tiles.

### 8.3 Settings › ICP and Signals

- **ICP:** industries (multi-select), size bands, countries, revenue bands, each with a weight, and must-haves. A live count of matching accounts.
- **Signals:** a table of signal kinds with weight, half-life and on or off. Reset to defaults.
- **Alerts:** rule builder. When stage becomes X, or intent crosses N, or a signal of kind K happens, for accounts with fit ≥ F, notify Slack or email, with quiet hours and a daily cap.

### 8.4 Visitors

- **Live list**, refreshed every 10 s: time, account (logo and name) or "Unknown · Country", person (name with level tag, if known), pages (the first 3 and a count), active time, source, and ref class tag.
- **Filters:** site, account known or unknown, ref class, country, page group.
- **Click** opens the account or person.

### 8.5 Accounts

**Table columns:**
- Account, with a fit bar and number.
- Intent, with a number and a temperature arrow.
- Stage tag, priority, people, sessions (7 d), last signal, and why-now (truncated).
- Owner, once M2 syncs owners.

**Saved views:**
- "Hot this week" (temperature hot)
- "Evaluating"
- "New this week"
- "High fit, no visit in 30 days"

**Row buttons:** Good pick, Wrong company, Not a fit (feedback table).

### 8.6 Account page

| Section | Content |
|---|---|
| Header | Logo, name, domain, fit, intent, priority, stage, temperature, flags, Open in Omniscient (when linked) |
| Why now | Contributions with links to the sessions |
| Timeline | Sessions grouped by day: who (person or "Unknown visitor"), pages with time, forms, signals |
| People | Known people with level tags, last seen and pages. "Unknown visitors: N devices, N sessions". |
| Company | Firmographics with the source and date. Networks seen, with the "by network" tag and a Wrong company button. |
| Score details | Fit rules matched, and intent signals with weight × decay = contribution |

### 8.7 Person page

As in `docs/identity.md` Part 13, with the plain-language decision lines from Part 14.

### 8.8 Privacy

- **Search by email:** results with Export and Erase (each erase asks through `askConfirm`).
- **Request log:** kind, subject hash, status, counts, and finish time.
- **Retention settings:** a table of data kinds and days.

---

## Part 9. API and MCP

| Endpoint | Returns |
|---|---|
| `GET /api/v1/visitors?site&since` | Live sessions |
| `GET /api/v1/accounts?filter&sort&page` | Accounts |
| `GET /api/v1/accounts/:id` | Account detail, scores, why-now |
| `GET /api/v1/accounts/:id/timeline` | Sessions and signals |
| `GET /api/v1/people/:id` | Person with identifiers and levels |
| `POST /api/v1/privacy/requests` | `{kind: export|erase, email}` |

MCP tools on `/api/mcp`: `list_accounts`, `get_account`, `get_account_timeline`, `list_visitors`. All are read-only and use the existing `clr_` API keys.

---

## Part 10. Compliance checklist (each item has a test)

| Item | Where in code | Test |
|---|---|---|
| Region policy decides cookie, identity and lookups | `collect/policy.ts` | Consent matrix (48 cases) |
| GPC honored everywhere | `policy.ts` | Matrix |
| No cookie before consent in `strict` | `ids.ts` + `policy.ts` | Matrix |
| Cookieless salt rotates and old salts are deleted | pg_cron + `salts` | Unit, plus a check that no salt older than 24 h exists |
| Full IP never stored | `geo.ts`, `ip_lookup` payload handling | A scan of all tables for IP patterns after the full suite |
| URL scrubbing | `scrub.ts` (shared) | 200 URL cases |
| Form fields: email only, never passwords or cards | `script/forms.ts` | Network capture in a real browser |
| Private paths send nothing | `collect` step 10 | Browser check |
| Opt-out works per site | `/opt`, `opt_outs` | Browser check |
| Erasure removes everything | `src/lib/identity/erase.ts` | Search every table after erase |
| Retention deletes on time | `retention` job | Clock-moved test |
| No person data across workspaces | RLS | `tests/db/leaks.sql` |
| Shared caches hold company data only | `company_cache`, `ip_cache` schemas | Schema test: no email, name or person columns |
| Audit log on exports, erasures and setting changes | RPCs | Unit |

---

## Part 11. Tests

| File | Covers |
|---|---|
| `tests/scrub.test.ts` | URL and prop scrubbing (200 cases) |
| `tests/policy.test.ts` | Policy table: region × GPC × consent × overrides × opt-out |
| `tests/ids.test.ts` | Signing, verifying, hop tokens, expiry, replay |
| `tests/bots.test.ts` | User agents, ranges, hint rules |
| `tests/clean.test.ts` | Email cleaning, classes, identify blocklist (`"null"`, `"anonymous"`, empty) |
| `tests/stitch.test.ts` | Every device-state transition, merge guards, backfill, session split |
| `tests/stitch.prop.test.ts` | Rebuild equals incremental (10,000 rows), and order independence with 8 workers |
| `tests/domains.test.ts` | PSL, hosting domains, aliases (100 labeled domains) |
| `tests/resolve.test.ts` | Account priority, learned networks, IPinfo kind mapping |
| `tests/signals.test.ts` | Each signal rule and dedupe key |
| `tests/scores.test.ts` | Fit v0, intent with cap and breadth, stage, temperature, priority, why-now text |
| `scripts/collect-check.ts` | Real Chromium: views, SPA, bfcache, prerender, engage, clicks, forms, adapters, backpressure, flush on shutdown |
| `scripts/consent-check.ts` | The 48-case matrix in real browsers |
| `scripts/identity-check.ts` | The 38 cases in `docs/identity.md` 17.1, in Chromium (and WebKit and Firefox in CI) |
| `scripts/load-collect.ts` | 10,000 events a second for 60 s: no loss, p99 ≤ 50 ms |
| `scripts/load-intel.ts` | 500 stitch rows a second, p95 ≤ 5 s |
| `tests/db/leaks.sql` | Every new table |

**Reliability rule:** collect, stitch and scores don't ship without their flaky-case tests passing:
- the database slow or down during flush;
- events arriving late;
- retried batches;
- a job killed midway.

---

## Part 12. Day-by-day schedule (weeks 2–6, 25 working days)

M0 (week 1) is done before day 1.

### Week 2: the script

| Day | Build | Done when |
|---|---|---|
| 1 | `021_web.sql` (sites, devices, sessions, events and partitions, page groups, salts, opt-outs, nonces, rollups), RLS, leak tests | Migration applies in a rolled-back transaction. Leak tests pass. |
| 2 | Script core: config, queue, uuid v7, batching, `sendBeacon`, `sessionStorage` retry, SPA, bfcache, prerender. Esbuild with the size gate. | Test page shows batches in the network log. Size ≤ 6 KB gzipped. |
| 3 | Engage (active time, scroll), clicks, URL scrubbing (shared module), private paths | Scrub tests pass. Engage numbers match a scripted session. |
| 4 | Consent readers (GCM v2, OneTrust, Cookiebot, API), GPC, opt-out, `identify`, `track`, `form`, `reset` | Unit tests for each consent source |
| 5 | Forms: email finder, never-read rules, HubSpot and Marketo adapters. Cross-domain hop links. | Network capture shows only the email leaves. Hop link carries `_clr_x` only at click time. |

### Week 3: collect

| Day | Build | Done when |
|---|---|---|
| 6 | Hono app, routes, size and origin checks, site cache, proxy secret and client IP, rate limits | Route tests with fake sites |
| 7 | Geo file, region policy, device ids (sign, verify, cookies per mode), cookieless keys and the salt job | Policy and ids tests pass |
| 8 | Bots (ranges loader, `isbot`, hints), sessions (LRU and Postgres, split rules) | Bot and session tests pass |
| 9 | Buffer with COPY, backpressure, flush on shutdown. Job queueing (`ip_lookup`, `signal`, `stitch`). `/i`, `/x`, `/reset`, `/opt`, `/health`. | Kill during flush loses nothing. Retried batches don't double. |
| 10 | `fly.collect.toml`, deploy, `collect.tryclaritia.com`, install on tryclaritia.com (proxy mode through Next.js rewrites). `collect-check.ts` and `load-collect.ts`. | Live events from tryclaritia.com. Load test passes. |

### Week 4: identity

| Day | Build | Done when |
|---|---|---|
| 11 | `022_intel.sql` identity tables. Identifier cleaning and lists. Evidence intake from `/i`. | Clean tests pass |
| 12 | `claritia-intel` app with the claim loop. The `stitch` job: identifiers, hard edges, merge guards, persons, aliases. | Unit tests for merges and guards |
| 13 | Device state machine, backfill, session split, advisory locks, internal traffic triggers | State transition tests pass |
| 14 | Rebuild, undo RPCs (unmerge, unlink, kiosk), merge proposals, erasure and export | Property test (rebuild equals incremental) passes |
| 15 | `identity-check.ts` (38 cases) and `consent-check.ts` (48 cases). Fix everything they find. | Both suites green in Chromium |

**Built so far (days 11–13):** `023_identity.sql` (settings, persons, aliases, identifiers, device links, merge proposals, `sessions.split_to`, ip cache, learned networks, erasures, email tokens), `src/lib/identity/clean.ts` with the free list (`free-email-domains`, MIT) and the disposable list (`lists/disposable.txt`, CC0), `src/lib/identity/stitch.ts`, and `claritia-intel` (`worker-intel/`, `fly.intel.toml`) running `stitch` and `device_reset`. Tests: `tests/clean.test.ts`, `tests/pg/stitch.pg.ts` (states, backfill, split, taint, signed merge, guards, internal, role, disposable, policy, erasure, an 8-way race, a job killed midway) and `tests/pg/intel.pg.ts`. Day 14 is built too: `src/lib/identity/rebuild.ts`, `erase.ts` (erasure and export), `024_identity_ops.sql` (`unmerge_person`, `unlink_device`, `mark_kiosk`, `decide_merge`, `privacy_request`, `privacy_exports`) and the intel jobs `rebuild`, `stitch_evidence` and `privacy`. `tests/pg/rebuild.pg.ts` proves rebuild equals incremental on 1,500 seeded random rows (shared, tainted and internal devices included) and covers each undo, erasure and export. Still to do: office-network and "this is me" internal triggers, and the browser suites (day 15). `hutk` waits for the HubSpot connection (M3) and email links for M6; both are kept and marked.

### Week 5: companies, signals, scores

| Day | Build | Done when |
|---|---|---|
| 16 | Domain cleaning, PSL, hosting list, redirect aliases, `accounts` and `account_domains` | 100-domain label set ≥ 98% right |
| 17 | IPinfo client, `ip_lookup` job, network kinds and confidence, IP cache rules, learned networks job | Sample of 200 known IPs (from our own team and partners' office networks) ≥ 90% precise |
| 18 | Coresignal client, `enrich_company` job, company cache, firmographics on accounts | Firmographics appear for tryclaritia.com visitors |
| 19 | Page groups (manual, plus the `suggest_page_groups` crawl), the website signal rules, `signal` job with dedupe | Signal tests pass |
| 20 | Fit v0, intent with `k` fit, stage, temperature, priority, why-now, Haiku reasons with fallback, `score_account` debounced | Score tests pass by hand math |

### Week 6: screens and alerts

| Day | Build | Done when |
|---|---|---|
| 21 | Settings › Sites (add, install tabs, verify, settings, page groups), Settings › Identity | A new site goes from add to "Receiving events" in under 5 minutes |
| 22 | Visitors and Accounts (RPCs, tables, filters, saved views, feedback buttons) | Lists load in ≤ 300 ms on 1 M fixture events |
| 23 | Account page and Person page (timeline, people, company, score details, undo buttons) | Every number links to its evidence |
| 24 | Settings › ICP, Signals and Alerts. `alert` job to Slack. `omniscient_push` (or a stub if the Omniscient API isn't ready). | A hot account fires one Slack alert and one Omniscient activity |
| 25 | Privacy screen and API, REST and MCP endpoints, quality page, docs for customers (privacy snippet, cookie table), install on 2 design partner sites | Partners see named accounts. All Part 11 tests green. |

---

## Part 13. Rollout

| Step | When | Gate |
|---|---|---|
| Our own site (tryclaritia.com), proxy mode | Day 10 | Load test passed |
| Perceptric's site | Day 15 | Identity and consent suites green |
| 2 design partners | Day 25 | All tests green, privacy docs ready |
| 5 design partners | Week 7 | 1 week of clean metrics (no policy breaches, drift 0, unmerges < 2 per 1,000) |

- **Feature flag:** `workspaces.features` includes `web_intel`, so the screens only show for flagged workspaces until Beta.
- **Kill switch:** `sites.paused`, plus a global `app_config.collect_paused`. Collect answers 204 and drops events while paused.

---

## Part 14. Operations

### 14.1 Metrics (on the internal quality page)

| Metric | Alert |
|---|---|
| Collect p99, 5xx rate, buffer depth, flush lag | p99 > 100 ms, 5xx > 0.5%, flush lag > 10 s |
| Jobs waiting by kind, oldest waiting | `stitch` oldest > 30 s, any kind > 10 min |
| IPinfo errors and spend | Error rate > 5%, spend > 80% of plan |
| Coresignal credits used | > 80% of plan |
| Identity metrics (`docs/identity.md` Part 16) | As listed there |
| Policy breach audit query | > 0, alert at once |

### 14.2 Runbooks

| Problem | Steps |
|---|---|
| Database slow, collect backpressure | Check Supabase load. Scale collect machines to keep connections steady. Raise flush batch size. If it lasts more than 15 min, pause the noisiest site. |
| IPinfo down or over limit | `ip_lookup` jobs retry with backoff. Accounts by network are delayed, while person and email accounts still work. |
| A customer's proxy broke (events stopped) | `script_health` alerts the customer once a day. The Sites screen shows the last event and mode. |
| Bad deploy of the script | Versioned script paths: `/s.js` points to the last good hash. Roll back by switching the pointer in `app_config.script_version`. |
| Wrong merges reported | Unmerge in the UI. Check the nightly rebuild report. Add a test case for the pattern. |

### 14.3 Backups and replay

- **Raw events:** kept 90 days. `scripts/replay-signals.ts` rebuilds signals and scores for a workspace from events, for use after a rule change.
- **Identity:** rebuilt from evidence at any time with `rebuild(workspace)`.

---

## Part 15. Monthly cost of M1

### 15.1 Assumptions per team

| Item | Amount |
|---|---|
| Page views | 50,000 |
| Events | 200,000 |
| IP lookups after caching | about 10,000 |
| Accounts enriched | about 300 |
| Haiku reasons | on band changes only |

### 15.2 Totals

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| IPinfo Business (check limits) | $249 | $1,000 |
| Coresignal company enrichment (about 3,000 credits per team, shared cache) | Starter to Pro plan, $199–$499 (check) | Premium, $1,500 (check) |
| Haiku reasons ($7 per team, often less) | $350 | $3,500 |
| Fly `claritia-collect` (2 × 256 MB, then 3 × 512 MB) | $4 (check) | $15 (check) |
| Fly `claritia-intel` (1 × 512 MB, then 3 × 1 GB) | $4 (check) | $25 (check) |
| Supabase compute for events (Medium, then Large) | $60 (check) | $110 (check) |
| ClickHouse (raw events at Growth) | — | $300 (check) |
| Geo file (IPinfo free country-ASN, or MaxMind GeoLite2) | $0 (check terms) | $0 (check terms) |
| **M1 total** | **About $866–$1,166** | **About $6,450** |

This is part of the platform total in `docs/marketing-platform.md` Part 11. There, the Coresignal line also covers people and briefs in later modules.

---

## Part 16. Open checks before day 1

| Check | Owner |
|---|---|
| IPinfo Business: exact fields for company type, ASN type and privacy flags, and the monthly request cap | Founder, with a test token |
| Coresignal: company enrich endpoint, credit cost per call, license for a shared company cache | Founder |
| Geo file license for commercial use in a product (IPinfo free download vs MaxMind GeoLite2) | Founder |
| PSL package license and update method | Build |
| Supabase pooler limits for COPY from 2–3 collect machines | Build, in week 3 |
| Omniscient API ready by day 24 (or ship the stub) | Omniscient repo |
| WebKit and Firefox Playwright browsers in CI (download size and time) | Build |

---

## Part 17. Definition of done

- Every item in 1.1 works on a design partner's live site.
- All tests in Part 11 pass in CI, including Chromium, WebKit and Firefox for the browser suites.
- The policy breach audit query returns 0, and nightly rebuild drift is 0, for 7 days on live traffic.
- The privacy documents for customers are published: the privacy snippet, the cookie table, and the sub-processor list.
- The monthly cost tracking in `ai_calls` and vendor usage matches Part 15 within 20%.
