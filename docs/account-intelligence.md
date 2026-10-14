# Account Intelligence: full build spec

The goal is the best account intelligence product on the market, built so it can be shown to any privacy lawyer. This doc covers Phase 1 in full depth: website intelligence (M1), identity (`docs/identity.md`), company resolution, enrichment, HubSpot, signals, scoring, AI research, delivery and compliance. Buyer Analytics (M2) keeps its spec in `docs/pivot-plan.md`.

---

## Part 1. What "best" means

Point tools win on one number, such as match rate. We win on whether a rep can trust the list and act on it today. Every target below is measured in the product and shown on an internal quality page.

| Area | Target | How we measure it |
|---|---|---|
| Identity precision | ≥ 99% of Verified and Asserted person links are right | Unmerges per 1,000 links, plus a monthly hand audit of 100 links per design partner |
| Company match precision | ≥ 90% of IP matches are right | Weekly sample: IP match vs the email domain of people who later fill a form from the same network |
| Company match coverage | ≥ 30% of B2B sessions | Share of non-bot sessions with an account |
| Hot list quality | Top 10 accounts per rep: ≥ 3× the base rate of reply, meeting or deal within 30 days | Backtest on history, then live tracking |
| Speed | High-value signal to Slack alert in ≤ 2 minutes (p95) | Timestamps on signal and alert |
| Briefs | 0 claims without a source. ≥ 95% of claims pass the verifier. | Verifier pass logs, plus rep "wrong" flags |
| Explainability | Every score shows its top reasons | Present on 100% of scores |
| Time to value | Script installed and HubSpot connected to the first named account in ≤ 15 minutes | Onboarding funnel |
| Rep trust | ≥ 60% of reps open the digest 4+ days a week | Digest opens and clicks |
| Compliance | 0 events stored against a consent or opt-out rule | Automated consent matrix tests, plus a nightly audit query |

---

## Part 2. Principles

1. **Trust beats coverage.** A wrong name, company or claim is worse than a blank. We show less when we're unsure, and we say how sure we are.
2. **Privacy by default.** The safest setting is the default in every region. Customers can loosen it only where the law allows, and each choice is logged.
3. **First-party first.** The best signals are the customer's own: site, content, email, CRM and product. Third-party data adds context and never decides alone.
4. **Every number explains itself.** A score with no reasons is never shown.
5. **Fixed math for counting, AI for words.** Scores, stages and alerts come from SQL and code that give the same answer every time. AI writes briefs, reasons and answers, and every AI claim carries a source.
6. **Fast where it matters.** A pricing page visit by a target account reaches the rep in under 2 minutes. A weekly brief can take an hour.
7. **Undo everything.** Merges, links, scores and briefs can all be traced to evidence and rolled back.

---

## Part 3. Compliance framework

This part sets the rules that every later part follows. Legal points marked "check" need review by a privacy lawyer before launch.

### 3.1 Roles

| Party | Role | What that means |
|---|---|---|
| Customer (the team using Claritia) | Controller | Decides why visitor data is used. Shows the cookie notice. Answers its visitors' requests with our tools. |
| Claritia | Processor (GDPR), service provider (CCPA) | Uses data only to provide the service to that customer. Never sells it, never shares it across customers, and never builds a cross-customer profile of a person. |
| Enrichment vendors (Coresignal, IP vendor) | Independent controllers of their own data | We send only a domain or IP network. They return company facts and public professional data. |
| Anthropic, Fly, Supabase, Resend, Voyage | Sub-processors | Listed publicly with locations. Covered by DPAs. |

**No cross-customer person data.** A person seen on Customer A's site is never visible to Customer B, and visits are never pooled across customers into a shared person graph. This is the line between an analytics tool and a data broker.

**Company-level caches are shared.** The IP-to-company cache (an IP network maps to a company) and the company firmographics cache hold no person data, so they are shared across customers to cut cost. Each vendor's license must allow it (check).

### 3.2 The region policy engine

The collect service decides a policy per session from the visitor's country, and from their US state when the country is the US. The decision uses the IP geo lookup. The IP is then dropped.

| Policy | Regions | Device cookie | Person identity | Company match by IP | Enrichment |
|---|---|---|---|---|---|
| `strict` | EU, EEA, UK, Switzerland, Quebec, Brazil (check), plus any region the customer adds | Only after consent | Only after consent | Only after consent | Only after consent |
| `notice` | US (all states), Canada outside Quebec, Australia, rest of world by default | Yes, with notice in the customer's privacy policy | Yes, with first-party evidence only | Yes | Yes |
| `off` | Any country the customer blocks | No | No | No | No |

**Why `strict` covers the UK and the EU:**
- The ePrivacy rules (and the UK's PECR) need consent before non-essential cookies or storage.
- France's CNIL lets some audience-measurement cookies skip consent, but only for anonymous stats used solely by the publisher. Claritia links visits to companies and CRM records, so that exemption doesn't fit.
- The UK ICO said in April 2026 that analytics cookies need consent.
- So in `strict` regions, no cookie and no identification happen before consent.

**Signals that override the region:**

| Signal | Effect |
|---|---|
| `navigator.globalPrivacyControl === true` | Treated as an opt-out in every region. The session runs cookieless, with no person identity and no enrichment, and counts only for company-level stats inside the customer's own reports. California, Colorado and Connecticut confirm GPC as a valid opt-out, and more states require universal opt-outs (check the current list). We honor it everywhere because it's simpler and safer. |
| Customer's consent tool says "denied" | Same as no consent: cookieless |
| Visitor used the opt-out link (`/optout` on the customer's site, or `claritia.optOut()`) | An opt-out cookie on that site, plus server-side suppression of the device id. No tracking on that site again. |
| Do Not Track header | Ignored by default (it has no legal force). Customers can choose to honor it. |

**Cookieless mode in detail:**
- No storage in the browser.
- The session key is `hash(daily_salt, site_id, ip_net, user_agent)`. The salt changes at midnight UTC and the old one is destroyed, so yesterday's sessions can't be linked to today's.
- Events count toward page stats only.
- In `strict` regions without consent, the IP is not sent to the company-match vendor, and the session gets no account.
- In `notice` regions under GPC, company match is allowed for internal stats, since it identifies a business and not a person (check per state).

### 3.3 What we never collect

| Never | How it's enforced |
|---|---|
| Keystrokes, or form field values before submit | The script listens only to `submit`. There are no `input` or `keydown` listeners on forms. |
| Any form field other than the email on submit | The email field finder reads one field, and everything else is dropped in the browser |
| Passwords, card numbers, government IDs | `type=password` and fields named or autocompleted as `cc-*` are never read, and server-side patterns block card and ID numbers |
| Session replay (mouse paths, screen recording) | Not built. Wiretap-style claims under California's CIPA §631 remain possible even after SB 690. |
| Full IP address | Dropped right after the geo and company lookups. Only the /24 (IPv4) or /48 (IPv6) network is stored. |
| Precise location | City level at most. Customers can turn city off. |
| Emails, tokens or PII in URLs | Query strings are filtered to an allowlist (UTM tags, `gclid`, `fbclid`, `ref`, `page`, `q` on search pages). Anything that looks like an email, phone number, JWT or long token is replaced with `[removed]`, both in the browser and again on the server. |
| Pages the customer marks as private | Path rules: no events on matching pages (account settings, checkout, support tickets) |
| Sensitive categories | We don't infer health, religion, politics or any GDPR Article 9 data. Customers can't create segments on those topics (a blocked-word list on segment names and page groups). |
| Third-party identity graph matches (person-level de-anonymization) | Not built and not bought |
| LinkedIn scraping | Not done. Professional data only comes from vendors that state their own legal basis. |

### 3.4 Retention

| Data | Default | Customer can set |
|---|---|---|
| Raw events | 90 days | 30–180 days |
| Sessions | 13 months | 3–25 months |
| Rollups (no person data) | Forever | — |
| Identity evidence | While the person exists, plus 30 days after deletion for audit (hash only) | — |
| Unknown devices with no person and no activity | 13 months after last seen | 3–13 months |
| Briefs | 12 months | 3–24 months |
| Vendor people data (buying group suggestions not in the CRM) | 30 days, unless a human adds the person to the CRM | 7–90 days |
| AI call logs (no prompt text, just counts and cost) | 24 months | — |
| AI prompt and response text | 30 days, for debugging | 0–30 days |

A nightly job deletes data past retention and writes a count to the audit log.

### 3.5 Data subject requests

| Request | How | Deadline we meet |
|---|---|---|
| Access or export | Search by email on the Privacy screen. Exports a JSON of the person, identifiers, sessions, events, scores and briefs that mention them. | 7 days (GDPR allows 1 month, CCPA 45 days) |
| Deletion | The erasure flow in `docs/identity.md`. Also removes the person from vendor-sourced buying group lists. | 7 days |
| Opt-out of sale or sharing | We don't sell or share. The request is logged and the person suppressed from enrichment and outreach. | Same day |
| Correction | Edit identifiers on the Person page. The change is logged. | 7 days |
| By API | `POST /api/v1/privacy/requests` for customers who run their own DSR tools (OneTrust, Transcend, Ketch) | — |
| HubSpot | `contact.privacyDeletion` webhook runs a full erasure | Within 1 hour |

Every request is logged in `privacy_requests` with who asked, what was done, row counts and the finish time.

### 3.6 Documents we ship

| Document | For |
|---|---|
| DPA with SCCs (EU) and the UK addendum | Customers |
| Sub-processor list with locations, with 30 days' notice of changes | Public page |
| Privacy notice snippet: the paragraph customers paste into their privacy policy, per region | Customers |
| Cookie table: names, purpose and life of `_clr_id`, `_clr_s`, `_clr_opt` | Customers' consent tools |
| Legitimate interest assessment (LIA) template for B2B company-level analytics | Customers in `notice` regions |
| DPIA template | Customers in the EU |
| Article 14 notice text, for people data from vendors (buying group) | Customers |
| Security overview | Customers |
| AI use statement: what AI does, which data goes to Anthropic, that it isn't used for training (check Anthropic's commercial terms) | Customers |

**Transfers:** the Supabase project is in Tokyo. Japan has an EU adequacy decision, which simplifies EU to Japan transfers (check how it applies through US-based sub-processors). Anthropic and the other US vendors are covered by SCCs or the EU-US Data Privacy Framework where certified (check each).

### 3.7 Security

| Control | Detail |
|---|---|
| Tenant isolation | RLS on every table by `workspace_id`, with a leak test per table in `tests/db/leaks.sql` |
| Secrets | OAuth tokens sealed with `SECRETS_KEY` (AES-256-GCM). Never logged. Rotation runbook. |
| Staff access | No standing access to customer data. Support access needs a time-limited grant from the customer and is logged. |
| Audit log | `audit_log`: every export, erasure, settings change, consent policy change, token connect and staff access |
| Encryption | TLS everywhere. Supabase encrypts at rest. Backups are encrypted. |
| Dependencies | Lockfile, Dependabot, `npm audit` in CI |
| Webhooks | HubSpot v3 signature (HMAC-SHA256 of method, URI, body and timestamp, rejected after 5 minutes, constant-time compare), plus Stripe and Slack signatures |
| Collect abuse | Site key plus origin check, size and rate limits, no read endpoints, and bot filtering |
| SOC 2 Type I | Start the compliance tool in week 12 and audit at Growth (check the cost) |
| Pen test | Before Growth (check the cost) |

### 3.8 AI rules

| Rule | Detail |
|---|---|
| No sensitive inference | The prompts forbid inferring personal traits. Output schemas have no field for them. A filter removes flagged terms. |
| Every claim has a source | Briefs and answers cite a URL or a record id. The verifier removes unsupported claims (Part 9.3). |
| No automated decisions about people | Scores rank companies for sales follow-up. Nothing with a legal or similarly significant effect on a person (GDPR Article 22) is decided by AI. |
| Disclosure | Internal tools need no disclosure. Any AI that talks to visitors (later, the M9 chat) says it's AI, in line with EU AI Act transparency rules (check timing and scope). |
| Data sent to the model | Account facts, signals summaries and people's names and titles. Never raw events, never emails of people outside the CRM. |
| Model data use | Commercial API terms. No training on customer data (check Anthropic's current terms). |

### 3.9 Legal watch list (review every quarter)

| Item | Status as of Oct 2026 | Our position |
|---|---|---|
| California SB 690 (CIPA reform) | Signed Sept 30, 2026. Removes private suits over website pen register and trap-and-trace claims, likely from Jan 1, 2027 (check the chaptered text). Wiretap (§631) claims remain. | No session replay, no keystroke capture, chat disclosure later |
| GPC and universal opt-outs | Required in a growing list of states. CA, CO and CT run joint sweeps. | Honored everywhere |
| UK ICO on analytics cookies (Apr 2026) | Consent needed | UK is `strict` |
| CNIL audience-measurement exemption | Anonymous, publisher-only stats only | Doesn't apply to us. France is `strict`. |
| California AB 566 (browser opt-out signals) | From Jan 2027 (check) | Already honor GPC |
| California Delete Act (DROP) | Applies to data brokers | We're not a broker. Our vendors must comply, so check each vendor's broker registration status. |
| EU AI Act Article 50 | Transparency rules for AI that interacts with people | Matters for M9 chat, not Phase 1 |

---

## Part 4. The account graph

Everything links into one graph per workspace.

```
                ┌──────────── parent_of ────────────┐
                ▼                                   │
  domains ──► ACCOUNT ◄── works_at ── PERSON ◄── device_links ── DEVICE ── SESSION ── EVENT
     ▲          │  ▲                    │                                   │
     │          │  └── account_tech ── TECH                                 └── SIGNAL ──┐
  ip_networks   │                                                                         │
                ├── deals (HubSpot)        people_roles (champion, finance…)              │
                ├── account_jobs (hiring)  account_news (funding, launches)               │
                └── SCORES (fit, intent, priority, stage) ◄───────────────────────────────┘
```

| Node | Key | Sources |
|---|---|---|
| Account | `workspace_id + primary domain` | HubSpot companies, email domains, IP matches, manual |
| Domain | Cleaned domain | HubSpot `domain` + `hs_additional_domains`, enrichment, redirects |
| Person | Survivor id | Identity evidence (`docs/identity.md`), HubSpot contacts |
| Device, Session, Event | Ids | M1 |
| Signal | Id | Built from all sources (Part 7) |
| Tech | Tech slug | Site scan (Part 6.4) |
| Job | Posting id | Public job boards (Part 6.5) |
| News | URL | Web search (Part 9.2) |
| Deal | HubSpot deal id | HubSpot |
| Role | Person + role | Title classifier (Part 9.4) |

---

## Part 5. Company resolution

This is how every source maps to exactly one account.

### 5.1 Cleaning a domain

1. Lowercase it and trim spaces.
2. Remove the scheme, path, port and `www.`.
3. Get the registrable domain with the Public Suffix List. `app.eu.acme.co.uk` becomes `acme.co.uk`.
4. Drop known hosting domains (`vercel.app`, `herokuapp.com`, `github.io`, `wixsite.com` and the rest of the list). A company that lives on one of these keeps the full subdomain.
5. **Redirect check:** fetch `https://<domain>/` with a 5 s timeout, following up to 5 redirects. If it lands on another registrable domain, record an alias (for example `acme.io` to `acme.com`). Done once and cached for 90 days.

### 5.2 Mapping each source to an account

| Source | Rule | Confidence |
|---|---|---|
| HubSpot company | Primary domain plus additional domains. All map to one account. | High |
| Person's email | Work domain, through aliases. Free email and role inboxes map to nothing. | High |
| IP network | Vendor domain if kind is `business` with confidence 70+ | Medium (shown as "by network") |
| Manual | A rep sets it | High |
| Enrichment | The vendor's canonical domain for the company, as an alias | Medium |

### 5.3 Conflicts and duplicates

| Case | What we do |
|---|---|
| Two HubSpot companies with the same domain | One Claritia account, linked to the older HubSpot company. The other is listed under "HubSpot duplicates" with a "Merge in HubSpot" link. We never merge in HubSpot on our own. |
| An IP maps to a domain that's an alias of a known account | Goes to that account |
| An IP maps to a parent company (for example, the parent's network used by a subsidiary) | Goes to the parent's account. Shown as "network of Parent Co". When a person's email says Subsidiary, the person wins. |
| An agency or partner domain (on the team's partner list) | Never an account in reports. The person counts toward the account they're working for, if known. |
| A customer's own domains | Internal. Dropped. |
| Big shared networks (universities, government, telecom staff networks) | Kept as accounts but flagged "shared network". Their intent counts at half weight. |

### 5.4 Parent and child accounts

- `account_links (parent_id, child_id, source, confidence)` from HubSpot parent-child associations and enrichment.
- Default view: each account on its own. The team can turn on "roll up to parent" per view.

---

## Part 6. Data sources

### 6.1 Website (M1)

As in `docs/pivot-plan.md` M1 and `docs/identity.md`, plus the region policy, URL scrubbing and never-collect rules in Part 3.

Additions for intelligence:

| Field | Use |
|---|---|
| Page groups | Customers tag paths: `pricing`, `demo`, `compare`, `security`, `integrations`, `docs`, `case_study`, `careers`, `blog`, `legal`, `login`. Suggested on day 1 from a crawl of their own site by the Explorer, and the customer confirms them. |
| Competitor compare pages | `/vs/*` and `/alternatives/*` views are tagged with the competitor's name. A strong signal of active evaluation. |
| Docs depth | Number of distinct docs pages. A strong signal of technical evaluation. |
| Return pattern | Days between sessions per account |
| Referrer class | Search, AI assistant (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com, copilot.microsoft.com), review site (g2.com, capterra.com, trustradius.com), social, partner, email, direct |
| AI assistant referrals | Tracked on their own. A growing source of buyer research. |
| Review site referrals | A strong intent signal: they're comparing. |

### 6.2 HubSpot

#### Objects synced

| Object | Endpoint style | Fields we keep |
|---|---|---|
| Companies | List with `after` cursor (full), Search by `hs_lastmodifieddate` (incremental) | name, domain, additional domains, industry, employees, revenue, country, owner, lifecycle stage, parent, created date, custom ICP fields the team maps |
| Contacts | Same | email, additional emails, first and last name, job title, company link, owner, lifecycle, lead status, opt-out flags, created date, last activity |
| Deals | Same | name, amount, stage, pipeline, close date, owner, created date, won or lost |
| Associations | Associations v4 batch read | company↔contact, company↔deal, contact↔deal |
| Engagements | Emails, meetings, calls, notes, tasks (CRM objects) | type, time, direction, owner, contact and company links. **No email bodies.** Subject only, and only if the team turns it on. |
| Owners | Owners API | id, email, name, team |
| Pipelines | Pipelines API | stages, order, won and lost flags |
| Form submissions | Forms API (submissions) | form, page, time, contact. Becomes identity evidence. |
| Marketing email events | Email events API (check availability by tier) | opens are ignored (bots and Apple Mail Privacy make them noise). Clicks are kept as Inferred evidence. |

**Full sync:**
- Uses the list endpoints with a cursor, so no result cap applies. Search is used only for the incremental passes, sliced by time windows so no window holds too many results (check the Search API result cap).
- Runs in the background with a progress bar.
- A portal with 100K contacts at 110 requests per 10 s, 100 records per request, takes about 2 minutes of API time for contacts. With associations and engagements, plan for up to an hour on big portals.

**Incremental sync:**
- Webhooks are the main path. A catch-up pass every 15 minutes covers anything missed.

**Rate limits:**
- 110 requests per 10 seconds per installed account for public apps, per HubSpot's usage guidelines. The Search API has its own lower per-second limit (about 4–5 per second; check).
- One token bucket per portal per limit, kept in Postgres. Target 80% of each limit.
- A 429 with `policyName` SECONDLY waits 1–2 s. DAILY pauses that portal's sync until midnight in the portal's time zone and raises an alert.

**Webhooks:**
- Endpoint `/api/hubspot/webhook`.
- Signature check: v3, with the timestamp in milliseconds, rejected if older than 5 minutes, constant-time compare.
- Fast ack: store the raw batch in `hubspot_inbox` and return 200 right away (HubSpot times out fast; check the exact timeout). A job processes the inbox.
- Dedupe on `eventId`. Order by `occurredAt`. A stale event (older than the record's last sync time) only triggers a fetch of the current record, so we never apply old data.

**Write back:**

| What | When | Batched |
|---|---|---|
| Company properties: `claritia_fit`, `claritia_intent`, `claritia_priority`, `claritia_stage`, `claritia_temperature`, `claritia_last_signal`, `claritia_brief_url`, `claritia_reasons` (top 3 as text) | On change | Every 15 minutes, batch update of 100 |
| Contact properties: `claritia_level`, `claritia_last_seen`, `claritia_role` | On change | Same |
| Timeline events: "Visited 4 pages incl. Pricing", "Read Security Guide 6 min", "New person from account" | On signal, rolled into one event per account per hour | Hourly |
| Tasks | Never in Phase 1 (that's M6) | — |

**CRM card inside HubSpot:**
- A HubSpot UI extension on the company and contact records shows the Claritia brief, scores with reasons, last 5 signals, people with roles, and an "Open in Claritia" link.
- Reps never have to leave HubSpot. Check the current UI extension rules for public apps.

**Field mapping screen:**
- The team maps HubSpot fields to Claritia ICP fields (for example their own `Segment` field to industry).
- Lifecycle stages map to Claritia stages (for example SQL to Researching).

### 6.3 Enrichment (Coresignal, connected)

| Data | When | Cached |
|---|---|---|
| Company: size, industry, HQ country, founded, revenue range, headcount growth 6 and 12 months, department sizes | Account gets its first session or is created in HubSpot. Refreshed every 30 days while active. | Shared company cache, 30 days (check license) |
| Employee search by title keywords for the buying group | Top 50 accounts weekly, plus any account entering Evaluating | Per workspace, 30 days |
| Job postings | Weekly for active accounts, if not found on a public board (6.5) | 7 days |

Compliance:
- Vendor people data is shown as suggestions ("Possible: VP Finance, joined 2024").
- It's never written to HubSpot automatically. It's deleted after 30 days unless a rep adds the person to the CRM.
- We send Coresignal only a company domain or id. No visitor data goes to them.
- We keep Coresignal's stated data rules (public professional data only, no private or sensitive data) on file, and ask them for their written legal basis (check).

### 6.4 Tech stack scan

- A monthly job per active account: fetch the homepage and up to 3 key pages (pricing, careers, login) with plain HTTP, no browser.
- Detect tech from script URLs, meta tags, headers, cookies and DNS (MX for email provider, TXT for SPF and verification records, CNAMEs).
- The detection rules come from an open fingerprint set, or one we write. Check the license: the original Wappalyzer rules went closed, and the community forks are GPL.

| Category | Examples | Why it matters |
|---|---|---|
| CRM and marketing | HubSpot, Marketo, Salesforce Pardot, Intercom | Fit, and the integration angle |
| Analytics | GA4, Segment, Mixpanel, Amplitude | Tech fit |
| Email provider (MX) | Google Workspace, Microsoft 365 | Which mailbox flow to use in M6 |
| Competitors' scripts | The team lists its competitors' tags | **Strong signal:** they use a competitor, which means displacement and renewal timing |
| Hosting and frameworks | Vercel, Webflow, WordPress, Shopify | Fit |

- Changes create signals: `tech_added` (a competitor added is a risk; a complementary tool added is an opening) and `tech_removed` (a competitor removed is an opening).

### 6.5 Hiring signals from public job boards

- Find the board from the account's careers page links: Greenhouse, Lever, Ashby, Workable or SmartRecruiters.
- Read their public job board APIs (for example `boards-api.greenhouse.io/v1/boards/<token>/jobs`, `api.lever.co/v0/postings/<company>`, Ashby's posting API; check each API's terms).
- Job posts are company data, not personal data.

| Signal | Rule |
|---|---|
| `hiring_role` | A post whose title matches the team's watch list (for example "RevOps", "Head of Demand Gen", "Sales Enablement") |
| `hiring_mentions_tool` | A post that mentions the team's product category or a competitor ("experience with 6sense") |
| `hiring_spike` | Open roles up 50%+ in 30 days |
| `hiring_freeze` | Open roles to zero after 5+ (a negative signal) |

### 6.6 News and funding

- A weekly news watch for active accounts runs web search for news in the last 30 days (Part 9.2).
- Funding, acquisitions, leadership changes, launches, layoffs, expansion and partnerships are stored as `account_news` with URL, date and kind.
- Optional later: a paid funding feed such as the Crunchbase API (check the cost).

### 6.7 Product usage (for product-led teams, optional)

- `claritia.identify()` in the customer's app, plus `claritia.track()` events, or a Segment destination.
- Signals: `product_signup`, `product_active_users` (count by account), `product_feature` (key features the team lists), `product_limit` (hit a plan limit) and `product_invite` (teammate invites mean the account is spreading).
- Same consent and identity rules. The app's own legal basis covers logged-in users (customer's notice).

### 6.8 Stripe (optional)

- Payments and plan changes by account. Gives `expansion_ready` (usage near the plan limit) and `churn_risk` (failed payment, downgrade).

### 6.9 Third-party intent (later, M10)

- G2 Buyer Intent and Bombora, if the customer has a license. Each feed carries its own weight and is shown as "outside signal".

---

## Part 7. Signal catalog

Every signal has a kind, an account, an optional person, a weight, a half-life, a dedupe window and a source. Weights and half-lives are defaults that teams can change, and Part 8.4 tunes them from history.

### 7.1 Website

| Kind | Rule | Weight | Half-life | Dedupe |
|---|---|---|---|---|
| `page_pricing` | View of a `pricing` page | 10 | 7 d | 1 per person per day |
| `page_demo` | View of a `demo` page with no form submit | 8 | 7 d | 1 per person per day |
| `page_compare` | View of a `/vs/` or alternatives page | 12 | 10 d | 1 per person per competitor per day |
| `page_security` | Security or compliance pages | 9 | 14 d | 1 per account per day |
| `page_integrations` | Integration pages (records which one) | 6 | 14 d | 1 per person per integration per week |
| `docs_depth` | 5+ distinct docs pages in a session | 9 | 14 d | 1 per person per day |
| `case_study` | Case study view (records the industry) | 5 | 14 d | 1 per person per asset |
| `return_visit` | Account back after 14+ quiet days | 8 | 7 d | 1 per account per gap |
| `multi_person` | 3+ distinct people or devices from the account in 7 days | 12 | 7 d | 1 per account per week |
| `review_site_ref` | Session referred from G2, Capterra or TrustRadius | 10 | 10 d | 1 per account per day |
| `ai_assistant_ref` | Session referred from an AI assistant | 6 | 10 d | 1 per account per day |
| `engaged_session` | 3+ minutes active time | 4 | 7 d | 1 per person per day |
| `spike` | Account sessions this week > 3× its 8-week average, and at least 5 | 12 | 7 d | 1 per account per week |
| `careers_only` | Session with only careers pages | 0, and marks the session a likely job seeker | — | — |

### 7.2 Identity and CRM

| Kind | Rule | Weight | Half-life |
|---|---|---|---|
| `form_submit` | Any form | 15 | 14 d |
| `demo_request` | A form tagged as demo | 25 | 21 d |
| `new_person` | A new Verified or Asserted person at the account | 6 | 14 d |
| `new_role` | First person in a new role group (for example the first finance person) | 10 | 21 d |
| `meeting_booked` | A HubSpot meeting created | stage change | — |
| `email_reply` | An inbound email logged in HubSpot | 14 | 14 d |
| `email_click` | A tracked link click (Inferred level, account only) | 3 | 7 d |
| `deal_created` | — | stage change | — |
| `deal_stalled` | Open deal with no activity for 21 days | negative 10 | 14 d |
| `closed_lost_return` | An account with a lost deal over 90 days ago comes back to pricing or compare pages | 20 | 14 d |
| `customer_expansion` | An existing customer views pricing or a new product page | 10 (flagged to the CSM view) | 14 d |

### 7.3 Company events

| Kind | Rule | Weight | Half-life |
|---|---|---|---|
| `funding` | News of funding in the last 30 days | 10 | 30 d |
| `leadership_change` | A new exec in a buyer role (CRO, CMO, VP Sales, RevOps) | 12 | 45 d |
| `acquisition` | Acquired, or acquiring | 6 | 30 d |
| `hiring_role` | Section 6.5 | 8 | 30 d |
| `hiring_mentions_tool` | Section 6.5 | 12 | 30 d |
| `headcount_growth` | 6-month growth > 20% | 5 | 60 d |
| `tech_competitor_added` | Section 6.4 | negative 5, but a "renewal watch" flag | 90 d |
| `tech_competitor_removed` | Section 6.4 | 15 | 30 d |
| `tech_complement_added` | A tool that pairs with the customer's product | 6 | 60 d |
| `layoffs` | News | negative 8 | 60 d |

### 7.4 Champion moves (opt-in feature)

- **What:** past champions and users (contacts on closed-won deals) who move to a new company.
- **How:** monthly, check current employer for those HubSpot contacts through Coresignal by name, company and title (check matching quality).
- **Signal:** `champion_moved` at the new account, weight 20.
- **Compliance:**
  - Off by default.
  - The customer confirms they have a legitimate interest and include it in their privacy notice.
  - Only for people who were customers' users, never for prospects.
  - The match must be high confidence, and a rep confirms it before outreach.

### 7.5 Product and billing (optional)

| Kind | Weight | Half-life |
|---|---|---|
| `product_signup` | 15 | 14 d |
| `product_active` (3+ active users in a week) | 10 | 7 d |
| `product_limit` | 15 | 7 d |
| `product_invite` | 8 | 14 d |
| `payment_failed` | negative, to the CSM view | — |

### 7.6 Signal rules that apply to all kinds

- **Internal, bot, partner and tainted devices** make no signals.
- **Probable person links** give signals to the account only, never to the person.
- **Per-person cap:** one person can add at most 40% of an account's intent. One curious intern can't make an account hot.
- **Breadth bonus:** intent × (1 + 0.15 × (distinct people − 1)), capped at 1.6×. More people researching is a stronger sign.
- **Every signal stores its evidence** (session ids, URLs, news URL, job URL), so "why" can always be shown.

---

## Part 8. Scoring

All scoring is fixed math in SQL and TypeScript, versioned (`score_version`), and backtested before any change goes live.

### 8.1 Fit (0–100)

**Version 0: ICP rules.** Used until the workspace has 20 closed-won deals.

- The team sets weights per field in Settings: industry list, size bands, countries, required or bonus tech, revenue range.
- Fit = sum of matched weights / sum of all weights × 100.
- Required fields that miss cap fit at 30.

**Version 1: learned from history.** Used once there are 20+ won and 50+ lost or stalled accounts.

- Features: industry, size band, country, revenue band, growth band, each tech, department size bands, and source of first touch.
- For each feature value, lift = (wins with value + α × base rate) / (accounts with value + α) ÷ base rate, with α = 10 (shrinks rare values toward the base rate).
- Fit = the geometric mean of lifts across the account's features, mapped to 0–100 by the workspace's percentile ranks.
- Shown with the top 3 features that raise or lower it ("Industry: Fintech, 2.4× more wins").
- Refit monthly. A new fit model goes live only if its backtest lift (8.4) beats the old one.

### 8.2 Intent (0–100)

```
raw = Σ over signals in last 90 days:
        weight × 0.5 ^ (age_days / half_life)
      with the per-person cap applied
raw = raw × breadth_bonus
intent = 100 × (1 − e^(−raw / k))
```

- `k` is set per workspace so that the 95th percentile account of the last 30 days gets about 90.
- `k` is refit weekly, with a floor so a quiet week can't make everyone look hot.
- Negative signals subtract after the cap. Intent is floored at 0.

### 8.3 Stage, temperature and priority

**Stage:** the rules in `docs/pivot-plan.md` M3, plus mapping from HubSpot lifecycle (the team's mapping wins when it's more advanced).

Stages only move forward automatically. They move back only:
- after 45 days of no signals (to Engaged), or 90 days (to Unknown);
- when a deal is closed lost (to Researching, with a `closed_lost` flag).

**Temperature:**
- Hot when 7-day intent > 1.5× the 28-day average and intent ≥ 40.
- Cooling when < 0.5×.
- Steady otherwise.

**Priority** (what decides the order of the hot list):

```
priority = intent × (0.4 + 0.6 × fit/100) × stage_factor × owner_factor
stage_factor: Unknown 0.5, Engaged 0.8, Researching 1.0, Evaluating 1.3, Meeting booked 0.6, In deal 0.7
owner_factor: 1.0, or 1.2 if the account has no owner (so it gets picked up)
```

- An open deal lowers priority on the prospecting list and moves the account to the deal view.

**"Why now" line:** the two biggest signal contributions in the last 7 days, as text. For example: "3 people read pricing and the security page this week. Hiring a RevOps lead."

### 8.4 Backtesting (how we prove the scores work)

The harness is `scripts/score-backtest.ts`. It runs on a workspace's own history in HubSpot and Claritia.

For each week W in the last 12 months:
1. Rebuild every account's fit, intent and priority using only data before W.
2. Take the top 10% by priority.
3. Measure the share that got a reply, meeting or deal within 30 and 60 days after W.
4. Compare with the base rate across all accounts.

| Report | Pass bar to ship a scoring change |
|---|---|
| Lift at top 10% | ≥ 3× base rate, and ≥ the current version |
| Precision at top 10 per rep | ≥ the current version |
| Coverage | Share of all meetings that came from accounts in the top 20% the week before, ≥ 50% |

- Signal weights and half-lives are tuned by a grid search on the backtest, with limits (weights 0–30, half-lives 3–90 days).
- Changes need a 5%+ gain. A team can lock its weights.
- At first only HubSpot history exists (no website history), so backtests start with HubSpot signals and grow as Claritia data builds up.

### 8.5 Rep feedback

- Every account on the hot list has buttons: "Good pick", "Wrong company" (bad IP match), "Not a fit" and "Already handled".
- "Wrong company" sends the IP network to a review list and lowers its confidence. Three flags from different reps mark the network bad for this workspace.
- "Not a fit" adds a fit penalty for that account and feeds the next fit refit.
- Feedback rates are shown on the quality page.

---

## Part 9. The AI layer

### 9.1 Where AI is and isn't used

| Job | AI? | Model |
|---|---|---|
| Counting, scoring, stages, alerts | No | — |
| Reason and next step text | Yes, only on a band change | Haiku 5.5 |
| Weekly brief | Yes | Sonnet 5.5 + web search, Batch API for the weekly run |
| Claim verifier | Yes | Haiku 5.5 |
| News watch | Yes | Haiku 5.5 + web search (check web search support on Haiku; else Sonnet) |
| Title to role classifier | Rules first, AI for the leftovers | Haiku 5.5 |
| "Ask about this account" | Yes | Sonnet 5.5 with tools |
| Signal names and page group suggestions | Yes, once at setup | Haiku 5.5 |

Every call:
- is logged in `ai_calls` with tokens and cost;
- has a decision cache key;
- uses structured output with a JSON schema;
- uses prompt caching on the stable prefix (system prompt, workspace context).

### 9.2 Briefs

**Pipeline (`brief` job):**

1. **Gather (no AI).** Account facts, firmographics, tech, jobs, the last 60 days of signals (compact), people with roles, deals, past emails (subjects only, if allowed) and the team's product context. The product context is a short "what we sell, to whom, why we win" written once in Settings.
2. **Research.** Sonnet 5.5 with the `web_search_20260209` tool, max 5 searches, limited to the last 12 months. It looks for news, funding, launches, leadership, and pains from the company's own posts and pages.
3. **Write.** The same call fills the brief schema.
4. **Verify.** For each claim with a URL, fetch the page text (the worker, with a 10 s timeout and the first 20 KB), and Haiku checks whether the text supports the claim (yes, no or unclear). "No" claims are removed. "Unclear" claims are kept with a dotted underline and the label "unverified". Claims from Claritia data are checked against the records directly, with no AI.
5. **Save** with `inputs_hash`, then write `claritia_brief_url` to HubSpot.

**Schema:**

```json
{
  "headline": "string <= 120",
  "summary": "string <= 600",
  "why_now": [{"text": "", "source": {"kind": "signal|news|job|tech|crm", "ref": ""}}],
  "company": {"what_they_do": "", "customers": "", "stage": "", "source_urls": []},
  "news": [{"title": "", "url": "", "date": "YYYY-MM-DD", "kind": "funding|leadership|launch|acquisition|layoffs|other"}],
  "buying_group": [{"person_id": "", "name": "", "title": "", "role": "champion|decision_maker|evaluator|user|finance|security|unknown",
                    "known": true, "engaged": true}],
  "gaps": ["string"],
  "pains": [{"text": "", "evidence": {"kind": "", "ref": ""}}],
  "angle": "string <= 300",
  "opener": "string <= 300",
  "next_step": {"kind": "alert_rep|email|call|page|wait", "why": ""},
  "competitors": [{"name": "", "evidence": {"kind": "tech|page_compare|news", "ref": ""}}]
}
```

**Writing rules in the prompt:**
- Plain language, short sentences.
- No guesses about people's personal lives. No traits.
- Never mention web tracking in the opener ("I saw you visited…" is banned, and a rule check enforces it).
- Every item in `why_now`, `pains` and `competitors` needs evidence.
- If evidence is thin, say so in `summary` and keep the lists short.

**Freshness:**
- Weekly for the top 50 by priority.
- Right away when an account enters Evaluating or gets a `demo_request`.
- On demand with a "Refresh" button (counts against credits).

**Eval set:**
- 40 golden accounts (public companies with known news) with expected facts.
- Run before any prompt or model change. Pass bar: ≥ 90% expected facts found, 0 banned phrases, ≤ 2% claims removed by the verifier.

### 9.3 The verifier in detail

- **Input:** claim text plus source text (or record).
- **Output:** `{"verdict": "supported|unsupported|unclear", "quote": "the sentence that supports it"}`.
- A "supported" verdict must include a quote found word for word in the source, checked in code. If the quote isn't in the source, the verdict becomes "unclear".
- This stops the verifier from inventing support.

### 9.4 Buying group

**Title to role (rules first):**

| Pattern | Role |
|---|---|
| CEO, Founder, President, Owner (at < 200 people) | decision_maker |
| CRO, VP Sales, Head of Sales, CMO, VP Marketing | decision_maker |
| RevOps, Sales Ops, Marketing Ops, Growth | evaluator, and a likely champion |
| CFO, Finance, Procurement, Purchasing | finance |
| CISO, Security, IT, Compliance | security |
| SDR, BDR, AE, Marketer, Manager | user |

- Unmatched titles go to Haiku in batches of 50, with output limited to the role list.
- Seniority (C, VP, Director, Manager, IC) and department come from the same pass.
- **Coverage view:** roles present vs the team's typical won-deal group (learned from contacts on won deals). For example: "Won deals usually include finance. None seen yet."
- **Known vs suggested:** known people are CRM contacts or Verified or Asserted visitors. Suggested people come from Coresignal (section 6.3 rules) and show as "Possible", never with an email.

### 9.5 "Ask about this account"

- A box on the Account page: "What did they read about security?", "Who's the likely champion?", "What changed since last week?"
- Sonnet 5.5 with read-only tools: `get_signals`, `get_sessions`, `get_people`, `get_news`, `get_brief`, `get_deals`, `get_tech`, `get_jobs`.
- Answers must cite records, and the UI links each citation.
- 6 tool calls max, answers ≤ 200 words.
- No writes. It can't send, change or delete anything.
- Logged and counted against credits.

### 9.6 Prompt and model management

- Prompts are versioned in code (`src/lib/accounts/prompts/*.ts`) with an id and a version. Every output stores the prompt version.
- A model or prompt change runs the eval set in CI and must meet the pass bars.
- Fallback: on overload or error, Sonnet briefs retry once and are then requeued for an hour later. Haiku calls retry once, and on a second failure the plain-math reason text is used ("Intent up: 3 pricing views").

---

## Part 10. Delivery

### 10.1 In Claritia

**Today** (the rep's home screen):
- The rep's top 10 accounts by priority that changed in the last 24 hours.
- Each row: account, why-now line, stage tag, temperature, people active, and buttons for Brief, Good pick, Wrong company, Not a fit and Done.
- A "New to you" section: accounts with no owner that are hot.

**Accounts:**
- A table with name, fit, intent, priority, temperature, stage, owner, people, last signal, competitors seen, and open deal.
- Saved views ("My hot accounts", "Evaluating, no meeting", "Closed lost coming back", "Customers expanding").
- Bulk assign owner. Export to CSV, logged in the audit log.

**Account page:**

| Section | Content |
|---|---|
| Header | Name, domain, logo, fit, intent, priority, stage, temperature, owner, Pause, HubSpot link |
| Why now | Top contributions with evidence links |
| Brief | Section 9.2, with verifier marks |
| Activity | Timeline of sessions (pages, time), content, forms, emails, meetings, deals, news, jobs and tech changes, with filters |
| People | Known people with role, level tag, last seen and pages read. Suggested people below, clearly marked. |
| Buying group | Roles covered and missing |
| Company | Firmographics, tech, jobs and news, each with a source |
| Ask | Section 9.5 |
| Score details | Fit features, intent signals with weight × decay, and the score version |

**Person page:** identifiers with levels, devices with date ranges, evidence list, sessions, Unmerge, Unlink and Erase.

**Alerts builder:**
- Rules like "When an account in my list has `page_compare` or `demo_request`, Slack me now", or "When fit ≥ 70 and intent crosses 60".
- Made with the app's `Select` controls. Sent through the existing alerts (014). Quiet hours per rep. A daily cap of 10 per rep unless raised.

### 10.2 Morning digest

- Slack DM and email at 8:00 in each rep's time zone.
- Content: the top 5 changes, each with a why-now line and one button.
- No digest on days with nothing new ("No new movement" is never sent).
- Managers get a team version: hot accounts with no owner, and hot accounts with no touch in 3 days.

### 10.3 In HubSpot

- Properties and timeline events (section 6.2).
- The CRM card (section 6.2).
- HubSpot lists and workflows can then use `claritia_priority` and `claritia_stage`. For example, "enroll in sequence when stage becomes Evaluating" works inside HubSpot with no Claritia action needed.

### 10.4 Chrome extension (existing, extended)

- A side panel on HubSpot, LinkedIn, Gmail and the account's own website shows the account brief, scores and people for the company on screen.
- On LinkedIn it shows only our data about the company and people already in the CRM. It reads the company name from the page title and reads nothing else from LinkedIn (check LinkedIn's terms). It never scrapes or stores profile data.
- The existing one-click connect is reused.

### 10.5 Slack app

- `/claritia acme.com` returns the brief card.
- The alert buttons work in Slack: Good pick, Wrong company, Assign to me.

### 10.6 API, MCP and webhooks out

| Surface | Endpoints and tools |
|---|---|
| REST `/api/v1` | `GET accounts`, `GET accounts/:id`, `GET accounts/:id/signals`, `GET accounts/:id/brief`, `GET people/:id`, `POST privacy/requests` |
| MCP `/api/mcp` | `list_accounts`, `get_account`, `get_brief`, `get_signals`, `ask_account` |
| Webhooks out | `account.stage_changed`, `account.hot`, `signal.created` (filtered), signed with HMAC per endpoint, retried 5 times over 24 hours |

---

## Part 11. Data model

Extends migrations 020–025 in `docs/pivot-plan.md`. New and changed tables:

```sql
-- 021_web.sql additions
sites (… , policy_overrides jsonb, private_paths text[], url_param_allow text[], city_level bool default true,
       honor_dnt bool default false)
sessions (… , policy text, gpc bool, consent text, region text)
opt_outs (site_id, device_hash, created_at)

-- 022_identity.sql per docs/identity.md

-- 023_company.sql
account_domains (workspace_id, domain, account_id, source, confidence, created_at)
domain_aliases  (domain pk, canonical, source, checked_at)                -- shared, no person data
company_cache   (domain pk, data jsonb, vendor, fetched_at)               -- shared, no person data
account_links   (workspace_id, parent_id, child_id, source, confidence)
account_tech    (account_id, tech, category, first_seen, last_seen, evidence)
account_jobs    (account_id, board, posting_id, title, dept, location, url, opened_at, closed_at)
account_news    (account_id, kind, title, url, published_at, found_at, verified bool)
network_flags   (workspace_id, net cidr, flag text, by_user, created_at)  -- wrong company reports

-- 024_hubspot.sql additions
hubspot_inbox   (id, workspace_id, received_at, body jsonb, processed_at, error)
hubspot_map     (workspace_id, hs_field, claritia_field, transform jsonb)
hubspot_dupes   (workspace_id, domain, company_ids text[], found_at)

-- 025_scores.sql
signal_types    (workspace_id, kind, weight, half_life_days, dedupe text, enabled)
signals (… , evidence jsonb, person_capped bool)
account_scores  (account_id, at, fit, intent, priority, stage, temperature, why_now jsonb, reasons jsonb,
                 score_version int, inputs_hash)
fit_models      (workspace_id, version, kind text, params jsonb, backtest jsonb, live bool, created_at)
intent_params   (workspace_id, k numeric, fitted_at)
feedback        (workspace_id, account_id, user_id, kind text, note, created_at)

-- 026_ai.sql
account_briefs (… , headline, why_now jsonb, company jsonb, gaps jsonb, competitors jsonb, angle,
                prompt_version, verifier jsonb)
people_roles    (person_id, role, seniority, department, source, confidence)
suggested_people(id, workspace_id, account_id, name, title, role, vendor, vendor_ref, expires_at)
asks            (id, workspace_id, account_id, user_id, question, answer, citations jsonb, tokens jsonb, created_at)

-- 027_privacy.sql
privacy_requests(id, workspace_id, kind, subject_hash, requested_by, source, status, counts jsonb,
                 requested_at, finished_at)
audit_log       (id, workspace_id, actor, action, target, data jsonb, at)
retention       (workspace_id, data_kind, days)
alert_rules     (id, workspace_id, user_id, rule jsonb, channel, quiet_hours jsonb, daily_cap, enabled)
```

All workspace tables have RLS and leak tests. The shared caches (`domain_aliases`, `company_cache`) hold company data only, are read through security definer functions, and are never exposed to clients directly.

---

## Part 12. Jobs and schedules

| Job | Trigger | Runs |
|---|---|---|
| `ip_lookup` | New IP network | Seconds |
| `stitch` | New identity evidence | Seconds |
| `signal` | New event batch with page groups | Seconds |
| `score_account` | New signal (debounced 60 s per account) | Seconds |
| `alert` | Score crosses a rule | Seconds |
| `hubspot_inbox` | Webhook batch | Seconds |
| `hubspot_catchup` | Every 15 min per portal | Minutes |
| `hubspot_writeback` | Every 15 min | Minutes |
| `hubspot_timeline` | Hourly | Minutes |
| `company_enrich` | New account, 30-day refresh | Minutes |
| `tech_scan` | Monthly per active account | Minutes |
| `jobs_scan` | Weekly per active account | Minutes |
| `news_watch` | Weekly per active account (top 200) | Minutes |
| `brief` | Weekly top 50, plus on Evaluating, demo request or Refresh | Batch API weekly, direct on trigger |
| `digest` | 8:00 rep local time | Minutes |
| `intent_refit` | Weekly | Minutes |
| `fit_refit` | Monthly | Minutes |
| `backtest` | On demand, and monthly | Minutes |
| `retention` | Nightly | Minutes |
| `identity_rebuild_check` | Nightly | Minutes |
| `quality_report` | Nightly | Minutes |

---

## Part 13. Screens: copy and states

- Each tool's first screen uses `ToolIntro`. Setup flow: install script, then connect HubSpot, then confirm page groups, then set ICP.
- After setup, screens show labels, buttons and real errors only.
- Real errors are plain and specific:
  - "HubSpot disconnected. Reconnect."
  - "No events from acme.com in 24 hours. Check the script."
  - "IP vendor over limit. Company matches paused."
- States are square tags: `Unknown`, `Engaged`, `Researching`, `Evaluating`, `Meeting booked`, `In deal`, plus identity levels `Verified`, `Asserted`, `Probable`.
- Temperature is an arrow icon with a label.
- No pills, shadows, gradients or emoji. Dropdowns use `Select`. Questions use `askConfirm`.

---

## Part 14. Performance and scale

| Thing | Beta (50 teams) | Growth (500 teams) | Budget |
|---|---|---|---|
| Events per month | 10 M | 100 M | Collect p99 ≤ 50 ms |
| Signals per month | 500 K | 5 M | Signal to alert ≤ 2 min p95 |
| Accounts | 25 K | 250 K | Accounts list ≤ 300 ms |
| HubSpot API calls per month | 5 M | 50 M | Within each portal's limits |
| Score recomputes per day | 100 K | 1 M | Batched, under 50 ms each |
| Briefs per month | 10 K | 100 K | Batch API |

- Hot paths (signal, score, alert) run in the agent worker with a job concurrency of 20 and indexes on `(workspace_id, account_id, at desc)`.
- Account scores are recomputed for one account at a time. There are no full-table recomputes except the nightly refit.

---

## Part 15. Quality monitoring

The internal quality page (staff only), per workspace and overall:

| Metric | Alert when |
|---|---|
| Unmerges per 1,000 links | > 2 |
| Wrong company flags per 100 matched accounts | > 5 |
| Verifier "unsupported" rate | > 5% |
| Hot list lift (live, 30 days) | < 2× |
| Signal to alert p95 | > 2 min |
| HubSpot sync lag | > 30 min |
| Events stored against policy (audit query) | > 0 |
| AI spend vs budget per workspace | > 80% |
| Digest open rate | < 40% for 2 weeks |

---

## Part 16. Testing

| Kind | What | Where |
|---|---|---|
| Unit | Domain cleaning, PSL edge cases, URL scrubbing, signal rules, intent math, fit math, priority, title rules | `tests/*.test.ts` |
| Property | Intent is the same in any event order. Rebuild equals step-by-step build. Scores are bounded 0–100. | `tests/*.prop.test.ts` |
| Consent matrix | A real browser for each region × consent state × GPC × opt-out, checking cookies set, events stored, identity made and vendor calls made. 4 regions × 3 consent states × 2 GPC × 2 opt-out = 48 cases. | `scripts/consent-check.ts` |
| URL scrubbing | 200 URLs with emails, tokens and IDs. None survive. | Unit + `collect-check.ts` |
| Never-collect | The script on a page with password and card fields, typing and submitting. Nothing but the email leaves the browser. | `scripts/collect-check.ts` |
| Identity | 17 cases from `docs/identity.md` | `scripts/identity-check.ts` |
| HubSpot | Test portal: full sync, a webhook storm, out-of-order events, 429 handling, token refresh, privacy deletion | `scripts/hubspot-check.ts` |
| Company resolution | 100 hand-labeled domains (aliases, redirects, hosting domains, subsidiaries) | Unit |
| Scoring backtest | Fixture history with a known answer. A real design partner history before each change. | `scripts/score-backtest.ts` |
| AI evals | 40 golden accounts for briefs. 200 titles for roles. 100 claims for the verifier. | `scripts/ai-eval.ts`, run in CI on prompt changes |
| DSR | Export and erase end to end, then a search finds no trace | `scripts/privacy-check.ts` |
| Leak | RLS on every table | `tests/db/leaks.sql` |
| Load | Collect at 10K events/s. Score worker at 500 signals/s. | `scripts/load-*.ts` |
| Chaos | Kill the worker mid-job, kill collect mid-flush, drop the HubSpot connection mid-sync | Manual runbook in weeks 11–12 |

---

## Part 17. Week by week (14 weeks)

Phase 1 grows from 9 to 14 weeks to fit this scope. Later phases in `docs/pivot-plan.md` shift by 5 weeks.

| Week | Build | Done when |
|---|---|---|
| 1 | M0 foundation (jobs queue, accounts, signals tables), compliance groundwork: region policy table, retention table, audit log, privacy request table, DPA and sub-processor list drafts | Old jobs run on the new queue. Leak tests pass. |
| 2 | `claritia.js`: events, consent reading, GPC, opt-out, URL scrubbing, never-collect rules, cross-domain, proxy path guides | Consent matrix and never-collect checks pass in a real browser |
| 3 | Collect service: intake, region policy, bots, sessions, geo, COPY writes, dedupe, cookieless mode | Load test passes. Policy audit query returns 0. |
| 4 | Identity stitching (`docs/identity.md`): evidence, five rules, internal traffic, rebuild, erasure | 17 identity cases pass |
| 5 | Company resolution: domain cleaning, redirects, aliases, IP vendor and cache, network flags, enrichment and company cache | 100-domain label set ≥ 98% right. IP sample check ≥ 90% precise. |
| 6 | HubSpot app: OAuth, full sync with cursors, rate limit buckets, webhooks with inbox, catch-up, field mapping | Test portal syncs twice with no doubles. Webhook storm loses nothing. |
| 7 | HubSpot: engagements, forms, associations, owners, pipelines, write back, timeline events, CRM card, privacy deletion | Card shows on a test portal. Erasure from HubSpot clears Claritia. |
| 8 | Signals: page groups (with Explorer suggestions), the full catalog, tech scan, job boards, per-person cap, breadth bonus | Each signal rule has a unit test |
| 9 | Scoring: fit v0 and v1, intent with `k` fitting, stage, temperature, priority, why-now, backtest harness | Backtest on fixture history passes. Design partner history shows ≥ 3× lift. |
| 10 | AI: reasons, briefs with research, verifier, buying group roles, news watch, evals in CI | Eval pass bars met |
| 11 | Surfaces: Today, Accounts, Account page, Person page, alerts builder, morning digest, feedback buttons | A design partner rep uses Today for a week |
| 12 | Ask about this account, Slack app, Chrome side panel, API, MCP tools, webhooks out. SOC 2 tool setup starts. | Each surface tested end to end |
| 13 | M2 Buyer Analytics (dashboards, goals, funnels, attribution) | Per `docs/pivot-plan.md` M2 |
| 14 | Hardening: privacy center screen, DSR API, retention jobs, quality page, chaos runbook, docs for customers (privacy snippet, cookie table, LIA, DPIA) | All tests in Part 16 pass. Lawyer review of Part 3 (check). |

---

## Part 18. Monthly cost (Phase 1 only)

### 18.1 Per team per month

| Item | Detail | Per team |
|---|---|---|
| Haiku reasons | On band change only | $7 |
| Sonnet briefs + web search | 200 a month, Batch API weekly | $22 |
| Verifier | Haiku, about 3,000 claims | $1 |
| News watch | Haiku + 200 web searches ($10 per 1,000, check) | $3 |
| Role classifier | Haiku, leftovers only | $0.50 |
| Ask about this account | Sonnet, about 100 questions | $5 |
| **AI subtotal** | | **$38.50** |
| Coresignal | About 850 credits (300 company, 50 searches, 500 people records) at about $0.03 each (check plan pricing) | $25 (check) |
| Reverse IP | 20,000 networks, about half cached | $10 (check) |
| Tech scan, job boards, redirects | Plain HTTP from the worker | $0 |

### 18.2 Totals

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| AI ($38.50 per team) | $1,925 | $19,250 |
| Coresignal | $1,250 (check) | $10,000 with the shared company cache (check license) |
| Reverse IP | $500 (check) | $2,500 (check) |
| Fly: web, collect, agent | $19 (check) | $95 (check) |
| Supabase Pro + compute | $85 (check) | $135 (check) |
| ClickHouse Cloud | — | $300 (check) |
| Resend (digests and alerts) | $20 | $90 (check) |
| SOC 2 compliance tool | — | $850 (check) |
| **Phase 1 total** | **$3,799** | **$33,220** |

This replaces the Phase 1 line in `docs/pivot-plan.md` ($2,054 Beta, $17,530 Growth). The increase comes from Coresignal, the verifier, news watch, Ask, and the SOC 2 tool at Growth.

Ways to cut the bill:
- Company enrichment only for accounts with a real session or CRM activity.
- People search only for the top 50 accounts.
- The shared company cache.
- The Batch API for weekly briefs.
- Ask limited by credits.

---

## Part 19. Open checks before launch

| Check | Owner | By week |
|---|---|---|
| Lawyer review of the region policy, GPC handling and the never-collect list | Founder | 14 |
| Coresignal: written legal basis, license terms for a shared company cache, credit pricing | Founder | 5 |
| IP vendor: accuracy sample, price, license for a shared network cache | Founder | 5 |
| HubSpot: Search API rate limit and result cap, webhook timeout and retry rules, UI extension rules for public apps, utk lookup endpoint | Build | 6 |
| Haiku 5.5 web search support | Build | 10 |
| LinkedIn terms for a side panel that only reads the page title | Founder | 12 |
| Job board API terms (Greenhouse, Lever, Ashby) | Build | 8 |
| Tech fingerprint rules license | Build | 8 |
| SB 690 chaptered text and effective date | Founder | 14 |
| Anthropic commercial terms on data use | Founder | 1 |
| SOC 2 tool and audit pricing | Founder | 12 |

---

## Sources used for this spec

- [HubSpot usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)
- [HubSpot usage details](https://developers.hubspot.com/docs/api/usage-details)
- [HubSpot validating requests](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests)
- [HubSpot v3 webhook signatures](https://community.hubspot.com/t/introducing-version-3-of-webhook-signatures/45895)
- [Knit: HubSpot API guide](https://getknit.dev/blog/hubspot-api)
- [Hookdeck: HubSpot webhooks guide](https://hookdeck.com/webhooks/platforms/guide-to-hubspot-webhooks-features-and-best-practices)
- [Truendo: CNIL audience measurement exemption](https://truendo.com/en/blog/what-is-audience-measurement-cookies-consent-exemption)
- [Luxgap: CNIL, CNPD and ICO on analytics cookies](https://www.luxgap.com/articles/cookies-analytics-exemption-cnil-cnpd-consentement-ico-2026/?lang=en)
- [Bird & Bird: CNIL guidelines](https://cm.twobirds.com/en/insights/2020/france/cookies-et-traceurs-les-nouvelles-recommandations-de-la-cnil)
- [CookieScript: universal opt-out by state](https://cookie-script.com/privacy-laws/universal-opt-out-mechanisms-in-us-privacy-laws-gpc-requirements-by-state)
- [Nelson Mullins: GPC](https://www.nelsonmullins.com/insights/alerts/privacy_and_data_security_alert/all/get-to-know-the-global-privacy-control-gpc-state-attorneys-general-remind-consumers-of-their-right-to-opt-out-of-the-sale-or-sharing-of-personal-information)
- [WilmerHale: CIPA reform signed](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20261006-cipa-reform-signed-into-law)
- [Parker Poe: SB 690](https://www.parkerpoe.com/news/2026/08/california-legislature-approves-senate-bill-690-narrowing-certain)
- [Ketch: SB 690](https://www.ketch.com/blog/posts/sb-690-cipa-demand-letter)
- [Coresignal: data and compliance](https://docs.coresignal.com/introduction/data-and-compliance)
- [Coresignal: compliance statement](https://coresignal.com/statement-on-compliance/)
- [Crowell: deanonymization suits](https://crowell.com/en/insights/client-alerts/another-wave-of-california-privacy-suitsdeanonymization-as-doxing)
- [UserGems: de-anonymization privacy FAQ](https://help.usergems.com/article/website-visitor-de-anonymization-privacy-faq)
