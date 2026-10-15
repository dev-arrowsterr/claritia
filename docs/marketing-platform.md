# Claritia: the agentic marketing platform

**One line:** Claritia turns website visitors into leads and leads into meetings, with AI agents running the journeys, writing the emails, building the pages and proving what made revenue.

**Who it's for first:** B2B teams of 5 to 200 people, with 1 to 10 marketers. They pay for 4 or 5 tools today (HubSpot or Marketo, Warmly or Unify, Mutiny or Unbounce, HockeyStack or Dreamdata) at $35K to $100K a year.

**The suite:**

```
GET FOUND                     CAPTURE · NURTURE · CONVERT · PROVE          CLOSE
Arrowsterr          ───►      Claritia                          ───►       Omniscient
SEO, GEO, AI search           visitors, contacts, journeys, email,         CRM, opportunities,
                              pages, forms, scoring, attribution           meetings, deal rooms
```

**Pitch:** Found by Arrowsterr. Converted by Claritia. Closed with Omniscient.

**Competitors this replaces or beats:**

| Job | Who does it today |
|---|---|
| Marketing automation | Conversion.ai, Inflection, HubSpot Marketing Hub, Marketo, Pardot, ActiveCampaign, Customer.io, Loops, Encharge, Userlist |
| Visitor intelligence | Warmly, Unify, RB2B, Factors, Common Room, Snitcher, Leadfeeder |
| Pages and personalization | Mutiny, Unbounce, Instapage, Abmatic, Default, Chili Piper |
| Attribution | HockeyStack, Dreamdata, Factors |

Companion specs that stay valid as module specs:
- `docs/identity.md`: identity stitching (M1)
- `docs/account-intelligence.md`: compliance framework (Part 3), company resolution, signals and scoring (M1, M7)

`docs/pivot-plan.md` is replaced by this plan.

---

## Part 1. The product

### 1.1 Modules

| # | Module | What the customer gets |
|---|---|---|
| M0 | Foundation and suite | Jobs queue, workspace, nav, billing, connections to Omniscient and Arrowsterr |
| M1 | Website Intelligence | Which companies and people visit, what they read, and which accounts are heating up |
| M2 | Contacts and Segments | One marketing database of people, companies, events and consent, with live segments |
| M3 | Email Engine | Sending from the customer's own domain, with deliverability, unsubscribes and suppression done right |
| M4 | Journeys and Agent Steps | A journey builder where AI agents decide the next step and write each email, with Approvals |
| M5 | Brand Brain | The customer's content, voice and proof, broken into atoms that every AI step writes from |
| M6 | Pages and Forms | AI landing pages, smart forms, booking, and personalization by account or segment |
| M7 | Scoring, Routing and Handoff | Fit, intent and engagement scores. Ready leads go to the right rep in Omniscient, HubSpot or Salesforce. |
| M8 | Attribution and Reports | Revenue traced from AI answers and search (Arrowsterr) to visits, journeys and pages (Claritia) to won deals (Omniscient) |
| M9 | Funnel QA | The browser engine checks every page, form, link and email before launch and on a schedule after |
| M10 | Marketing Agent | An agent that reads all the data, proposes the week's plays, and builds them on approval |

### 1.2 Screens (sidebar)

| Group | Screens |
|---|---|
| Top | Home (today's movement and approvals), Ask |
| Audience | Visitors, Accounts, Contacts, Segments |
| Engage | Journeys, Emails, Pages, Forms |
| Prove | Reports, Attribution, Funnel QA |
| Bottom | Approvals, Brand Brain, Settings |

The testing product's screens (Tests, Runs, Map, Approvals for heals) move under Settings › Testing and are hidden for new workspaces. The runner engine stays, because M9 runs on it.

### 1.3 One lead, start to finish

| Day | What happens | Module |
|---|---|---|
| 1 | Someone at Acme finds the customer through a ChatGPT answer that Arrowsterr helped win. They read two pages. | Arrowsterr, M1 |
| 1 | Acme is matched by IP and scores high on fit | M1, M7 |
| 3 | They download a guide through a Claritia form. Now a known contact, with consent recorded. | M6, M2 |
| 3 | They enter the "Guide downloaders, fintech" journey. An agent step writes the first email from the Brand Brain, citing the right case study. | M4, M5 |
| 7 | They read the case study page for 4 minutes. Two coworkers visit pricing. Intent rises. | M1 |
| 7 | An agent step picks the "sales-ready" branch. The handoff creates the contact and opportunity in Omniscient, alerts the owner in Slack with a brief, and pauses nurture. | M4, M7 |
| 9 | The rep books a meeting from Omniscient. | Omniscient |
| 60 | The deal is won. Attribution credits the ChatGPT answer, the guide, the journey and the case study. | M8 |
| Weekly | The Marketing Agent proposes cloning the journey for healthcare, with a new page. Marketing approves. | M10 |

---

## Part 2. Rules every module follows

1. **A wrong signal costs more than a missing one.** Identity, scores and agent choices use hard evidence. Probable links never trigger a send.
2. **Approvals first.** Every journey starts in review mode. A team can turn on auto mode per journey after 20 approved sends with fewer than 10% edited.
3. **Every AI claim has a source.** Emails and pages only state facts found in the Brand Brain or the contact's own data. A verifier removes lines with no source.
4. **Consent before sending.** No marketing email goes to a contact without a lawful basis for their region (Part 9).
5. **Fixed math for counting, AI for words and choices.** Scores, segments and attribution are SQL. AI writes, and picks between branches the marketer defined.
6. **AI calls go through the decision cache.** Same inputs, no new call.
7. **Every feature lists its monthly cost** at Beta (50 teams) and Growth (500 teams), with "check" on unconfirmed prices.
8. **Brand rules from CLAUDE.md:** square containers, `rounded-md` controls, square tags, no `<select>` or browser pop-ups, minimal copy, `ToolIntro` on first screens, no emoji.

---

## Part 3. Architecture

### 3.1 Apps

| App | Size (Beta, then Growth) | Job |
|---|---|---|
| `claritia-web` (Fly nrt) | 512 MB, then 2 × 1 GB | Next.js app, API, hosted pages and forms (by host), webhooks |
| `claritia-collect` (new) | 2 × 256 MB, then 3 × 512 MB | Public intake for the site script, forms and email clicks |
| `claritia-intel` (new, always on) | 512 MB, then 3 × 1 GB | Fast jobs with no browser: stitch, lookups, scores, syncs, journeys, AI, sends (see `docs/m1-website-intelligence.md`) |
| `claritia-runner` (exists, sleeps when idle) | 2 GB | Browser jobs: crawls and Funnel QA runs |
| `claritia-relay` | 256 MB | Kept for localhost tunnels (Funnel QA on staging) |
| Supabase `claritia` (Tokyo) | Pro + Medium, then Large | Postgres, Auth, Storage, pg_cron, pgvector |
| Amazon SES | — | Email sending, with bounce and complaint events through SNS |
| ClickHouse Cloud | Growth only | Raw events at scale |

### 3.2 Data flow

```
 Site visitors ─claritia.js─► collect ─► events, sessions, evidence ─► stitch ─► people, accounts
 Forms (M6) ─────────────────► collect ─► contacts + consent ───────────────────┘
 Omniscient / HubSpot / Salesforce / Segment / PostHog / Stripe ─► sync ─► contacts, deals, events
 Arrowsterr API ─► AI referral sources, prompts, topics ─► M5, M8
                                   │
                         jobs queue (claim_job, skip locked)
                                   │
   segment_refresh · journey_step · agent_decide · agent_write · send · ses_event · score · handoff · qa_run
                                   │
          Approvals · Slack · Omniscient (contacts, opportunities, activities) · Reports · MCP · API
```

### 3.3 Code layout

```
collect/               Hono intake: /s.js, /e, /f (forms), /c (clicks), /u (unsubscribe)
src/lib/identity/      docs/identity.md
src/lib/contacts/      contacts, companies, consent, segments (filter → SQL)
src/lib/email/         ses client, domains, templates (MJML), suppression, tracking links
src/lib/journeys/      graph schema, engine, steps, simulation
src/lib/brain/         ingest, atoms, embeddings, verifier
src/lib/pages/         blocks, renderer, forms, booking, personalization, domains
src/lib/scoring/       fit, intent, engagement, routing, handoff
src/lib/attribution/   touches, models, reports
src/lib/qa/            funnel checks on the existing runner
src/lib/agent/         marketing agent tools and loop
src/lib/suite/         omniscient and arrowsterr clients
worker/jobs/           one file per job kind
supabase/migrations/   020 onward
```

---

## Part 4. Modules in detail

### M0. Foundation and suite (weeks 1–2) · built

**Shipped:**
- **Jobs queue** (migration `020_foundation.sql`, `src/lib/jobs.ts`):
  - `enqueue_job`, `claim_job`, `extend_job`, `finish_job`, `prune_jobs`.
  - Jobs that share a key run one at a time, and only one waits per key, so bursts collapse.
  - Leases that run out go back in line, retries back off (1, 5, 30 minutes, then 2 and 6 hours), and finished jobs are pruned hourly.
  - Server-only. Tests: `tests/db/jobs.sql` and `tests/jobs.test.ts`.
  - Runs, plans and explorations keep their own claim functions, which already work and have their own tests. New work (M1 onward) uses the queue.
- **Features flag:** `workspaces.features` (`testing`, `marketing`). Only the server changes it.
  - Existing and new workspaces start with `testing`, so nothing changes for them.
  - Turning on `marketing` shows the new screens. With both, the testing screens sit under one Testing group.
  - Logic in `src/lib/nav.ts`, tested in `tests/nav.test.ts`.
- **First screens** (`ToolIntro`) for Visitors, Journeys, Pages and Reports (`src/components/app/views/MarketingIntros.tsx`).
- **Settings › Suite:** connect Omniscient and Arrowsterr with an address and an API key.
  - The key is sealed. Private addresses are refused, and redirects aren't followed.
  - Each product is checked with `GET /api/v1/me`, which Omniscient and Arrowsterr must answer (Part 5).
  - Owners connect and disconnect, members check again. Every change goes to the audit log.
- **Tables:** `audit_log` and `privacy_requests` (owners read, server writes), plus leak tests for every new table.

**Moved later:** Stripe plans for the platform (Part 10) move to week 18, before the Beta. There's nothing to meter until contacts and emails exist.

### M1. Website Intelligence (weeks 2–5)

Scope and rules: `docs/identity.md` (all parts) and `docs/account-intelligence.md` Parts 3, 5, 6.1, 7.1 and 7.2.

**MVP cut for this plan:**

| Piece | In the MVP | Later |
|---|---|---|
| `claritia.js` with consent, GPC, URL scrubbing, form capture, signed identify | Yes | — |
| Collect with region policy, bots, sessions, proxy path recipes | Yes | ClickHouse at Growth |
| Identity stitching (evidence levels, device states, backfill, undo, erasure) | Yes | — |
| Company match: IPinfo Business, learned networks, domain aliases | Yes | Snitcher as a second source, bring your own key for 6sense and Demandbase |
| Enrichment: Coresignal company data | Yes | People suggestions, tech scan, job boards |
| Signals: website set (`docs/account-intelligence.md` 7.1) | Yes | Company events (7.3) |
| Screens: Visitors (live), Accounts, Account page, Person page | Yes | — |

**Done when:**
- A design partner sees named accounts within 5 minutes of install.
- All 38 identity browser cases pass.

---

### M2. Contacts and Segments (weeks 7–9)

**Problem:** marketing needs its own list of people, with consent and behavior, without fighting the CRM.

**Data (migration `023_contacts.sql`):**

```
contacts       (id, workspace_id, person_id → identity, email, first_name, last_name, title, company_id,
                country, region, lifecycle text, source, owner_id, fields jsonb, created_at, updated_at)
companies      (id, workspace_id, account_id → M1 accounts, domain, name, size, industry, fields jsonb)
consents       (id, workspace_id, contact_id, channel text, basis text, -- opt_in, soft_opt_in, legitimate_interest, none
                status text, -- granted, withdrawn
                source text, wording text, ip_net, at)                 -- proof of consent
subscriptions  (contact_id, topic_id, status, at)                       -- newsletter, product, events…
topics         (id, workspace_id, name, default_on bool)
fields         (id, workspace_id, object, key, label, type, options jsonb)
segments       (id, workspace_id, name, rules jsonb, kind text, -- dynamic, static
                count int, refreshed_at)
segment_members(segment_id, contact_id, entered_at, left_at)
contact_events (id, workspace_id, contact_id, kind, data jsonb, at)    -- email, page, form, product, crm
imports        (id, workspace_id, file_path, mapping jsonb, status, counts jsonb)
```

**Segment builder:**
- Rules are a tree of AND and OR groups, built with the app's `Select`.
- Rule kinds:
  - **Contact fields:** title, country, lifecycle and custom fields.
  - **Company fields:** size, industry, tech, fit.
  - **Behavior:** visited a page group N times in N days, opened a form, clicked an email, read a page for N minutes.
  - **Scores:** intent, fit, engagement.
  - **Suite data:** Omniscient opportunity stage or owner, Arrowsterr source (for example "came from an AI answer").
  - **Consent:** subscribed to a topic.
- Each rule tree compiles to one SQL query with workspace bound parameters, never string-built.
- Dynamic segments refresh on contact change (incremental, for the contact) and fully each hour. Entering or leaving a segment fires a journey trigger.

**Sync:**

| Source | Direction | What |
|---|---|---|
| Omniscient | Both ways | Contacts, accounts, owners, opportunity stage. Claritia writes marketing activities (email sent, page read, form) to the Omniscient timeline. |
| HubSpot (`docs/account-intelligence.md` 6.2) | Both ways | For teams not on Omniscient |
| Salesforce | Both ways (later, week 27+) | Leads, contacts, accounts, opportunities, campaign members |
| Segment, PostHog | In | Product events and identify |
| Stripe | In | Customer status, plan, MRR |
| CSV import | In | With field mapping, dedupe through identity, and a consent basis column required |

**Dedupe:** contacts match on cleaned email through `docs/identity.md` Part 6. A contact always points to one identity person.

**Screens:**
- **Contacts:** table with column filters and saved views, and a contact page with timeline, consents, segments, journeys and scores.
- **Segments:** a builder with a live count and a sample of 10.
- **Import:** a wizard.

**Tests:**
- Segment SQL matches a hand-counted fixture for 30 rule types.
- No SQL is built from user strings (a fuzz test with SQL-like text in values).
- Two-way sync with an Omniscient test workspace makes no doubles and no loops (each write carries `source=claritia` and is ignored on echo).
- An import without a consent basis is refused for EU contacts.

---

### M3. Email Engine (weeks 10–12)

**Problem:** marketing email has to reach the inbox, respect the law, and look right everywhere.

**Sending:** Amazon SES. One configuration set per workspace, for event routing and reputation tracking.

| Stage | Setup |
|---|---|
| Beta | Shared SES IP pool, split by sending reputation tier |
| Growth | Dedicated IPs for workspaces sending 100K+ a month (check price), with an automatic warm-up schedule |

**Domains wizard (Settings › Sending):**
1. The customer adds a sending domain (for example `mail.acme.com`).
2. Claritia shows the DNS records to add:
   - DKIM: three SES CNAMEs (Easy DKIM).
   - SPF: through a custom MAIL FROM subdomain.
   - DMARC: at least `p=none` with a `rua` address.
   - A tracking subdomain CNAME for links.
3. A DNS check job polls each record and shows a green or red tag per record.
4. Sending stays blocked until DKIM and SPF pass, and DMARC exists.

**Bulk sender rules** (Gmail and Yahoo, for senders of about 5,000+ a day to them):

| Rule | How we meet it |
|---|---|
| SPF, DKIM and DMARC on the sending domain | Required by the wizard |
| One-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`, RFC 8058) | On every marketing email. `POST /u` unsubscribes at once. |
| Spam complaint rate under 0.3% (aim for under 0.1%) | Per-workspace complaint tracking. Sending pauses at 0.2% over 7 days. |
| Visible unsubscribe link and physical address (CAN-SPAM) | A footer block that can't be removed from marketing templates |

**Events:** SES sends to SNS, then to `/api/ses/events`, verified by SNS signature.

| Event | Action |
|---|---|
| Delivery | Logged |
| Bounce (hard) | Suppress the address for all topics |
| Bounce (soft) | Retry by SES. Suppress after 3 in 30 days. |
| Complaint | Suppress, unsubscribe from all, alert if the rate rises |
| Reject | Logged, alert |

**Tracking:**
- **Clicks:** links rewritten to `t.<customer domain>/c/<token>` (`docs/identity.md` 5.6 rules), with human-proof handling so scanner clicks don't count.
- **Opens:** tracked with a pixel but labeled "unreliable" in reports, because Apple Mail Privacy Protection and scanners load images. Reports lead with clicks, replies, page reads and conversions.

**Templates:**
- A block editor (text, image, button, columns, case study card, signature, footer). Blocks compile to MJML and then HTML.
- Brand kit: logo, colors, fonts, footer and address, taken from the customer's site by the Explorer, then edited.
- Plain-text version made automatically.
- Personalization tokens with fallbacks (`{{first_name | "there"}}`). Missing tokens with no fallback block the send.

**Sending pipeline:**
1. The `send` job checks:
   - consent and topic subscription for the contact's region (Part 9.1);
   - suppression;
   - the frequency cap (default 3 marketing emails per 7 days per contact);
   - quiet hours in the contact's time zone.
2. It renders the email, rewrites links, adds headers, and sends through SES with up to 14 messages a second per workspace at Beta (check the SES account rate).
3. It writes `email_messages` and a contact event, and posts an activity to Omniscient.

**Data (migration `024_email.sql`):**

```
sending_domains (id, workspace_id, domain, dkim_status, spf_status, dmarc_status, tracking_cname, verified_at)
templates       (id, workspace_id, name, blocks jsonb, mjml text, version int)
emails          (id, workspace_id, name, kind text, -- journey, broadcast, one_to_one
                 subject, preheader, template_id, from_name, from_email, topic_id, status)
email_messages  (id, workspace_id, email_id, contact_id, journey_step_id, ses_message_id, subject_final,
                 body_hash, sent_at, delivered_at, bounced text, complained_at, first_click_at, replied_at)
suppressions    (workspace_id, email_hash, reason, source, at)
send_limits     (workspace_id, per_second, per_day, paused bool, paused_reason)
```

**Screens:**
- **Emails:** a list of broadcasts and journey emails. The editor has a live preview at 3 widths, test send, and "Check with Funnel QA" (M9).
- **Broadcasts:** pick a segment and a topic, schedule in the contact's time zone, and send.
- **Settings › Sending:** domains with record tags, reputation numbers, and the pause banner if paused.

**Tests:**
- SNS signature check. Each event type is handled.
- A suppressed address is never sent to, even from a journey step that was already queued.
- `List-Unsubscribe-Post` unsubscribes in one POST.
- Frequency cap and quiet hours hold.
- Renders in the 3 widths match snapshot images.
- A complaint storm pauses sending.

---

### M5. Brand Brain (weeks 13–14)

**Problem:** AI emails and pages are only as good and as true as what they draw on.

**Absorb:**
- The Explorer crawls the customer's site, blog, case studies and docs.
- Upload PDFs and decks.
- Pull Arrowsterr's topic bank and content plan.
- Pull Omniscient Knowledge docs (if connected, with the customer's permission).

**Distill:**
- Haiku 5.5 splits each asset into **atoms**: claim, proof point, stat, quote, case result, FAQ, feature, CTA.
- Each atom keeps its exact source span, which code checks is really in the source.
- Atoms are tagged with topic, persona, stage, industry and product.
- Voyage embeddings go into pgvector (check the model price).
- Near-duplicates (cosine 0.95+) are merged. Stats and dates get an expiry.

**Voice:**
- Haiku drafts a voice guide from the 20 best pages: tone, words to use, words to avoid, and sentence length.
- The marketer edits and approves it. Every write step uses it.

**Verifier:** shared with briefs (`docs/account-intelligence.md` 9.3). A supported claim must quote its atom word for word, or it's removed.

**Data (migration `025_brain.sql`):** `brain_sources`, `atoms (id, workspace_id, kind, text, source_id, span, tags jsonb, embedding vector(1024), expires_at)`, `voice (workspace_id, guide jsonb, approved_by, approved_at)`.

**Screens:**
- **Brand Brain:** sources with status, an atom browser with filters, coverage by persona and stage (where you lack proof), and the voice editor.

**Tests:**
- 20 assets go in, and every atom's span is found in its source.
- Expired stats aren't used by write steps.

---

### M4. Journeys and Agent Steps (weeks 15–19)

**Problem:** classic journeys are rigid trees that nobody updates. Agent steps let AI choose and write inside rules the marketer sets.

**Triggers:**

| Trigger | Example |
|---|---|
| Segment entered or left | "Fit 70+ and visited pricing" |
| Form submitted | Guide download |
| Event | Product signup, invite sent, plan limit hit |
| Score crossed | Intent passed 60 |
| Omniscient change | Opportunity lost, contact became customer |
| Date | Renewal in 60 days, webinar date |
| Manual or API | Add from a list, `POST /api/v1/journeys/:id/enroll` |

**Steps:**

| Step | What it does |
|---|---|
| Send email | A fixed email, or one written by an agent step |
| Wait | A time, until a weekday or hour, or until an event (with a timeout) |
| Branch (rules) | If and else on fields, events, scores or segments |
| **Agent: Decide** | Haiku picks one of the branches the marketer named, with a reason. It can't invent a branch. |
| **Agent: Write** | Writes a one-to-one email for this contact from the Brand Brain, the contact's activity and the journey's goal |
| **Agent: Research** | Pulls account news and a short brief before a write step (Sonnet + web search, only for high-fit accounts) |
| Update | Set a field, lifecycle or subscription |
| Notify | Slack or email to the owner |
| Handoff | Create or update the contact and opportunity in Omniscient (or HubSpot or Salesforce), and pause marketing (M7) |
| Add to segment or journey | Static list or another journey |
| Goal | Exit when reached (for example a meeting booked) |

**Agent: Decide (Haiku 5.5, structured output):**

```json
{ "branch": "one of the named branches", "reason": "<= 200 chars", "evidence": ["event or field ids"] }
```

- Input: the contact's last 30 days of events, scores, fields, the journey goal, and the branch names with the marketer's description of each.
- Decision cache: a hash of the inputs. If the model fails twice, the journey takes the default branch the marketer set.

**Agent: Write (Haiku 5.5 by default, Sonnet 5.5 for contacts with fit 80+ or by choice):**

```json
{ "subject": "<= 70 chars", "preheader": "<= 90 chars", "body_blocks": [ {"type": "text|case_study|button", "...": "..."} ],
  "claims": [ {"text": "", "atom_id": ""} ], "why": "<= 200 chars" }
```

- Input: the voice guide, up to 12 atoms picked by embedding against the contact's interests and stage, the contact's fields and recent activity (summarized), the step's brief from the marketer, and the template.
- Rules in the prompt and enforced in code:
  - Every claim maps to an atom, and the verifier checks it.
  - Never mention tracking ("I saw you visited…" is blocked by a rule check).
  - Never invent personal facts.
  - Keep to the length the marketer set.
- The body is placed into the template, so the footer, unsubscribe and brand stay fixed.

**Review modes, set per journey:**

| Mode | Behavior |
|---|---|
| Review all | Every agent-written email waits in Approvals |
| Review a sample | 1 in 10 waits. The rest send after the verifier passes. Unlocked after 20 approvals with < 10% heavy edits. |
| Auto | All send after the verifier passes. Unlocked after 100 approvals with < 5% heavy edits. Can be locked off by the workspace owner. |

**Engine:**
- Each enrollment is a row with `current_step`, `state` and `next_run_at`. Running a step is a `journey_step` job.
- A journey's graph is versioned. Running enrollments stay on their version unless the marketer moves them.
- **Re-entry rules:** once, once per N days, or every time.
- **Global guards:** frequency cap, quiet hours, consent check at every send, and exit on unsubscribe, bounce or handoff.
- **Simulation:** "Test with 20 contacts" runs the journey on real contacts without sending. It shows each path, every Decide reason and every written email.

**Data (migration `026_journeys.sql`):**

```
journeys      (id, workspace_id, name, trigger jsonb, goal jsonb, reentry jsonb, mode text, status, version int)
journey_steps (id, journey_id, version, kind, config jsonb, next jsonb)
enrollments   (id, workspace_id, journey_id, version, contact_id, state, current_step, next_run_at,
               entered_at, exited_at, exit_reason)
step_runs     (id, enrollment_id, step_id, started_at, finished_at, outcome jsonb, ai_call_id)
approvals     (id, workspace_id, kind, ref_id, payload jsonb, status, decided_by, decided_at, edit_ratio numeric)
```

**Screens:**
- **Journeys:** a list with status, enrolled, goal rate and pipeline.
- **Builder:** steps on a vertical canvas (drag to add, click to edit), the trigger at the top, the goal at the bottom, and Simulate and Publish buttons.
- **Journey report:** count per step, branch splits with sample reasons, emails written, and goal rate.
- **Approvals:** the queue with the written email, the atoms it used, the verifier marks, Edit, Approve and Skip, and "Approve all from this step" once trusted.

**Tests:**
- Graph engine on 10,000 simulated enrollments: no stuck enrollments, exits honored, version moves correct.
- Decide never returns a branch that doesn't exist (schema plus code check).
- Write: a fake claim is removed, a tracking mention is blocked, and a missing token blocks the send.
- Consent is withdrawn between Write and Send, so the send is skipped.
- Mode unlocks only after the approval counts.

---

### M6. Pages and Forms (weeks 20–22)

**Pages:**
- **Blocks:** hero, logos, proof (atoms), case study, features, video, demo embed, pricing note, FAQ, form, meeting booker, CTA, footer. One renderer serves both the editor and the live page.
- **AI build** (Sonnet 5.5): from a goal, a persona and an offer, it builds a page from the Brand Brain. Every claim cites an atom (the verifier rule).
- **Personalization:** `claritia.js` swaps marked slots (`data-clr-slot`) for visitors in a segment or account, with an anti-flicker cap of 300 ms. Variants are written once per segment, so there's no model call per view.
- **A/B tests:** split by visitor hash. A winner is called on conversion rate once each side has 100+ views and the gap holds for 7 days.
- **Hosting:** `go.<customer domain>` through Fly certificates (check the price per hostname), or `pages.tryclaritia.com/<team>`. Rendered statically, and refreshed on publish.
- **Publishing:** goes through Approvals until the team trusts it. Funnel QA (M9) runs before every publish.

**Forms:**
- **Fields:** standard fields, custom fields and hidden fields (UTM tags, page, segment).
- **Progressive profiling:** known contacts aren't asked again. The next unknown field is shown instead.
- **Consent block:** wording by region (opt-in checkbox in `strict` regions, notice elsewhere), recorded in `consents` with the exact wording.
- **Spam:** a honeypot plus Cloudflare Turnstile (free tier, check), a rate limit per network, and disposable email blocking (`docs/identity.md` 5.4).
- **After submit:** a thank-you page or redirect, a journey trigger, identity evidence (Asserted), and optional instant booking.
- **Embed:** a script tag on any site, or native on Claritia pages. The HubSpot form adapter stays for teams keeping HubSpot forms.

**Booking:**
- **Owner calendar:** through Omniscient, which already syncs Google Calendar. Claritia asks Omniscient for open slots of the routed owner (needs the Omniscient API in Part 5.1).
- **Fallback:** a Calendly or HubSpot Meetings link.
- Routing picks the owner at submit (M7), so the visitor books with the right rep at once.

**Data (migration `027_pages.sql`):** `pages`, `page_versions`, `page_variants`, `page_views`, `forms`, `form_fields`, `form_submissions`, `domains`, `bookings`.

**Tests:**
- A page with an unsourced claim loses the line.
- A form in `strict` regions without the checkbox ticked records no consent and enrolls in no marketing journey.
- Turnstile failure blocks the submission.
- Progressive profiling hides known fields.
- Server and client renders match.
- A booking creates a meeting in a test Omniscient workspace.

---

### M7. Scoring, Routing and Handoff (week 6 basic, weeks 23–24 full)

**Scores** (rules from `docs/account-intelligence.md` Part 8):

| Score | Level | What feeds it |
|---|---|---|
| Fit | Account | ICP rules, then learned from won deals |
| Intent | Account | Website signals with decay, breadth bonus and per-person cap |
| Engagement | Contact | Email clicks and replies, page reads, forms, events, with decay |
| Readiness | Contact | Fit × intent × engagement, mapped to Cold, Warm, Ready |

**Handoff rule** (editable): readiness is Ready, or a demo request, or a pricing page plus a form within 7 days.

**Routing:** rules in order:
1. Existing owner in Omniscient or CRM.
2. Account owner.
3. Territory (country, region).
4. Segment.
5. Round robin among available reps (skipping reps out of office in Omniscient).

**Handoff action:**
1. Upsert the contact and account in Omniscient (or HubSpot or Salesforce).
2. Create the opportunity in the right pipeline and stage.
3. Attach a brief (Haiku, from the contact's activity, with sources) as an Omniscient note.
4. Slack DM the owner.
5. Pause marketing journeys for that contact.
6. Start an SLA timer.

**SLA and recycle:**
- If the owner doesn't touch the lead in the set time (default 24 business hours), alert their manager.
- If the opportunity closes as lost or the lead is rejected, send the contact back to a nurture journey after 30 days.

**Data:** `scores`, `routing_rules`, `handoffs (id, contact_id, owner_id, target, target_ids jsonb, at, touched_at, outcome)`.

**Tests:**
- Fixed fixtures give the expected scores.
- Routing picks the right owner for 20 cases.
- A handoff creates exactly one contact and one opportunity in Omniscient, even if retried.
- An SLA breach fires once.

---

### M8. Attribution and Reports (weeks 23–25)

**Touches:** one table across the suite:

| Source | Touch |
|---|---|
| Arrowsterr | AI answer referral (chatgpt.com, perplexity.ai, gemini, claude.ai, copilot), organic search landing, tracked prompt or topic match |
| Claritia | Session source, email click, page view, form, journey step |
| Omniscient | Meeting, rep email, opportunity created, stage change, won or lost |
| Ads (later) | Google Ads and LinkedIn Ads clicks and costs through their APIs |

**Models:** first touch, last touch, linear, U-shaped (40/20/40), and W-shaped (30/30/30 with 10 in the middle), on opportunities created and won revenue from Omniscient (or the CRM).

**Reports:**

| Report | Answers |
|---|---|
| Pipeline by source | Which channels made pipeline and revenue, including "AI answers" as a channel (with Arrowsterr) |
| Journey performance | Enrolled, goal rate, pipeline and revenue per journey and per step |
| Email | Delivered, clicks, replies, unsubscribes, complaints. Opens marked unreliable. |
| Pages and forms | Views, conversion, A/B results, pipeline |
| Content (atoms) | Which atoms appear in emails and pages before meetings and wins |
| Accounts | Hot accounts, movement by stage, time to handoff |
| Funnel | Visitor to lead to Ready to opportunity to won, with conversion and time per step |

**Weekly AI summary:** Opus 5.5 through the Batch API, every Monday. "What worked and what didn't", where every claim cites a report number (n ≥ 20 rule from `docs/account-intelligence.md` M7).

**Tests:**
- Attribution fixtures give exact cents per model.
- Report numbers match hand counts on fixture data.
- Dashboards load in under 300 ms at Beta size.

---

### M9. Funnel QA (hooks across all phases, main work week 26)

Built on the existing runner, Explorer, healing, tunnel and alerts.

| Check | When | How |
|---|---|---|
| Page check | Before publish, then hourly | Loads at 3 widths. Broken links, missing images and console errors. Screenshot diff vs last good. |
| Form end to end | Before publish, then every 6 hours | Fills the form with a test contact (`qa+<id>@<workspace test domain>`), confirms the contact appears in Claritia, the journey trigger fires, and the Omniscient or CRM record exists. Then cleans up. |
| Booking | Daily | Opens the booker and checks slots load |
| Email render | Before every broadcast and journey email | Renders the HTML in Chromium at 3 widths. Every link resolves (200 or 3xx to 200), the unsubscribe link works, and no tokens are left unfilled. |
| Site key pages | Hourly | Customer-chosen pages: up, fast, and showing the expected text |
| Script health | Every 15 minutes | Events still arriving from each site |

- Failures alert in Slack and block a publish or send when they're pre-launch checks.
- Uses the existing heal flow when a page changes on purpose (approve the new screenshot as "good").

**Tests:**
- A broken form (one that never reaches the CRM) is caught.
- A dead link in an email blocks the send.
- A changed page needs approval.

---

### M10. Marketing Agent (weeks 27–30)

**Problem:** the data says what to do next, but nobody has time to read it.

**Weekly plan:**
- Sonnet 5.5 with read-only tools (reports, segments, journeys, Brand Brain coverage, Arrowsterr topics and gaps, Omniscient pipeline).
- It proposes 3 to 5 plays. Example: "Healthcare accounts read the compliance page 3× more but have no journey. Proposed: a segment, a 3-step journey and a page."
- Each play comes with a draft built in the product (segment, journey, page) in draft state, ready to review.

**Ask:** a chat box on every screen ("Why did signups drop last week?", "Which journey makes the most pipeline?"). It answers with links to the records and report numbers.

**MCP:** new tools on `/api/mcp`:
- `list_segments`, `create_segment_draft`
- `list_journeys`, `journey_report`, `create_journey_draft`
- `get_report`, `ask`

**Limits:**
- The agent can only make drafts. Publishing and sending always go through the normal Approvals.
- 6 tool calls per run.
- Prompt caching on the workspace context.

**Tests:**
- A replay of fixed data gives the same plays.
- The agent can't publish (tool not present).
- Each play cites report numbers.

---

## Part 5. Suite and outside integrations

### 5.1 Omniscient (work needed in the Omniscient repo, weeks 5–6)

Omniscient has no public API today, so Claritia needs one. This is the first piece of shared suite plumbing.

| Omniscient side | Detail |
|---|---|
| API keys | `omn_` keys stored as SHA-256 (same pattern as Claritia's `clr_` keys), with scopes |
| `GET/POST /api/v1/contacts`, `/accounts` | Upsert by email or domain, with `source` |
| `GET/POST /api/v1/opportunities` | Create in a pipeline and stage, read the stage |
| `POST /api/v1/activities` | Log marketing activity on a contact's timeline (email sent, page read, form) |
| `POST /api/v1/notes` | Attach the handoff brief |
| `GET /api/v1/owners`, `/owners/:id/availability` | Owners, and calendar slots for booking |
| Webhooks | `contact.created`, `contact.updated`, `opportunity.stage_changed`, `opportunity.closed`, `meeting.booked`. Signed with HMAC per endpoint, retried over 24 hours. |
| Privacy | Respect the privacy rules that follow the source in Omniscient: Claritia only receives records shared to the workspace |

Cost on the Omniscient side: $0 added (API traffic on existing servers).

### 5.2 Arrowsterr

| Need | How |
|---|---|
| AI referral and organic landing data | Claritia tags sessions from AI assistants and search itself (M1). Arrowsterr adds the matching prompt and topic. |
| Topics, prompts, content plan | Arrowsterr API (the same data its MCP server exposes: prompts, topic bank, content plan, visibility) |
| Back to Arrowsterr | Conversion and pipeline per landing page and topic, so Arrowsterr can show "this topic made $X" |

Work on the Arrowsterr side: an API key and 3 endpoints if they don't exist yet (check).

### 5.3 Outside tools

| Tool | When | Cost |
|---|---|---|
| HubSpot | Week 9 (for teams not on Omniscient) | Free with the customer's plan |
| Salesforce | Week 27+ | Free with the customer's plan |
| Segment, PostHog | Week 9 | Free (customer's data) |
| Stripe | Week 9 | Free |
| Slack | Week 6 (existing alerts app) | Free |
| Calendly, HubSpot Meetings | Week 22 (booking fallback) | Free with the customer's plan |
| Google Ads, LinkedIn Ads | Later (ad spend in attribution) | Free APIs (check access rules) |

---

## Part 6. Timeline (30 weeks)

| Phase | Weeks | Modules | Release |
|---|---|---|---|
| **A. See** | 1–6 | M0, M1, M7 basic handoff, Omniscient API, Funnel QA script health | Design partners see hot accounts in Omniscient |
| **B. Reach** | 7–12 | M2 contacts and segments, M3 email engine, Funnel QA email render | Broadcasts and newsletters with consent and deliverability |
| **C. Nurture** | 13–19 | M5 Brand Brain, M4 Journeys and agent steps | **Public Beta (Starter plan)** |
| **D. Convert** | 20–22 | M6 pages, forms, booking, personalization, Funnel QA page and form checks | Growth plan on sale |
| **E. Prove** | 23–26 | M7 full scoring and routing, M8 attribution and reports, M9 full | Suite bundle launch with Arrowsterr and Omniscient |
| **F. Run itself** | 27–30 | M10 Marketing Agent, Salesforce sync | Scale plan |

**Weekly detail:**

| Week | Work |
|---|---|
| 1 | Jobs queue, migrations, nav, audit and privacy tables |
| 2 | `claritia.js` (events, consent, GPC, scrubbing, forms, identify), suite connection screens |
| 3 | Collect (policy, bots, sessions, cookies, proxy path), IPinfo |
| 4 | Identity stitching, internal traffic, erasure |
| 5 | Accounts, learned networks, Coresignal, signals, intent and fit. Omniscient API (part 1). |
| 6 | Visitors and Accounts screens, basic handoff to Omniscient, Slack alerts. Omniscient API (part 2, webhooks). |
| 7 | Contacts, companies, consents, fields, import |
| 8 | Segment builder and engine |
| 9 | Syncs: Omniscient both ways, HubSpot, Segment, PostHog, Stripe |
| 10 | SES setup, domains wizard, DNS checks, SNS events, suppression |
| 11 | Templates, brand kit, MJML, tracking links, unsubscribe, footer rules |
| 12 | Broadcasts, send pipeline, caps and quiet hours, email render QA |
| 13 | Brand Brain: absorb and distill |
| 14 | Brand Brain: embeddings, voice guide, verifier |
| 15 | Journey engine: enrollments, steps, waits, branches, versions |
| 16 | Builder UI |
| 17 | Agent Decide and Write, Approvals modes |
| 18 | Research step, simulation, journey report |
| 19 | Hardening, load test, Beta launch |
| 20 | Page blocks, editor, renderer, hosting, domains |
| 21 | Forms, consent block, Turnstile, progressive profiling |
| 22 | AI page build, personalization slots, A/B, booking through Omniscient |
| 23 | Scores (engagement, readiness), routing rules, SLA, recycle |
| 24 | Touches across the suite, attribution models |
| 25 | Reports, weekly AI summary |
| 26 | Funnel QA: form end to end, booking, page diffs, site pages |
| 27 | Marketing Agent: tools, weekly plays |
| 28 | Ask everywhere, MCP tools |
| 29 | Salesforce sync |
| 30 | Hardening, SOC 2 tool setup, Scale plan |

---

## Part 7. Launch plan

| Week | Milestone |
|---|---|
| 4 | Script live on tryclaritia.com and on Perceptric's site |
| 6 | 5 design partners, including Perceptric clients already on Arrowsterr or Omniscient |
| 12 | Design partners send their newsletter through Claritia |
| 19 | Public Beta, Starter plan, from the waitlist |
| 22 | Growth plan |
| 26 | Suite bundle: Arrowsterr + Claritia + Omniscient |
| 30 | Scale plan. HubSpot Marketplace listing. |

**Beta exit (to Growth):**
- 50 paying teams.
- Spam complaint rate under 0.1% across the platform.
- At least 70% of agent-written emails approved without heavy edits.
- At least one design partner showing pipeline from a Claritia journey in attribution.

---

## Part 8. Testing

| Kind | Where |
|---|---|
| Unit and property tests (segments, scores, attribution, journey engine, identity) | `tests/*.test.ts` |
| Real-browser checks (script, identity, forms, pages, email renders, consent matrix) | `scripts/*-check.ts` on Chromium, plus WebKit and Firefox in CI |
| Suite integration (Omniscient and HubSpot test workspaces) | `scripts/suite-check.ts` |
| AI evals (Write, Decide, page build, verifier, weekly summary) | `scripts/ai-eval.ts` in CI on any prompt or model change |
| Deliverability (SES mailbox simulator addresses for bounce and complaint) | `scripts/ses-check.ts` |
| Leak tests on every table | `tests/db/leaks.sql` |
| Load (collect 10K events a second, 10K journey steps a minute, 50 sends a second) | `scripts/load-*.ts` |

Reliability rule from CLAUDE.md: no change to the journey engine, the send pipeline, identity or Funnel QA ships without a test that proves it on a flaky case (slow page, late event, retry, failed send).

---

## Part 9. Compliance

Website rules are in `docs/account-intelligence.md` Part 3 and `docs/identity.md` Part 3. Email adds these.

### 9.1 Lawful basis to email, by region (check each with a lawyer)

| Region | Default rule in Claritia |
|---|---|
| EU, EEA, UK | Marketing email only with recorded opt-in, or soft opt-in for existing customers about similar products (where the country allows it for B2B; check per country). The form shows an unticked checkbox. |
| Canada (CASL) | Express consent recorded, or implied consent within its time limits (check) |
| US (CAN-SPAM) | Allowed with a clear unsubscribe, physical address and honest subject. Unsubscribes honored at once (the law allows 10 business days). |
| Rest of world | Opt-in by default. The workspace owner can choose notice-based for named countries, and that choice is logged. |

- Every contact carries a `basis` per channel. The send job checks it at send time.
- Imports need a basis column. EU contacts without opt-in proof are imported as "no basis" and can't be emailed.

### 9.2 Email rules

- One-click unsubscribe, footer address, and honest From and Subject (Part M3).
- Topic subscriptions, plus a preference page at `/u/prefs`.
- Unsubscribe and complaint suppression applies across all journeys and broadcasts at once.
- No purchased lists. Imports ask the source, and "bought list" is refused.

### 9.3 AI rules

- AI writes only from the Brand Brain and the contact's own data, and never invents facts or personal details.
- No mention of tracking in any message.
- Agent-written emails are logged with the atoms they used, for audit.
- The M10 agent makes drafts only.

### 9.4 Data

- Same retention, erasure, export and sub-processor rules as `docs/account-intelligence.md` Part 3.
- Amazon SES and Cloudflare Turnstile are added to the sub-processor list.

---

## Part 10. Pricing (proposed)

| Plan | Price | Includes |
|---|---|---|
| Starter | $299/mo | 5,000 contacts, 25,000 emails/mo, 1 site, Website Intelligence, segments, broadcasts, 3 journeys with agent steps (review mode), Funnel QA basics |
| Growth | $799/mo | 25,000 contacts, 100,000 emails/mo, 3 sites, unlimited journeys, review-sample and auto modes, pages and forms, personalization, attribution, Omniscient and HubSpot sync |
| Scale | From $1,999/mo | 100,000+ contacts, dedicated sending IPs, Salesforce, Marketing Agent, SSO, priority support |
| Suite bundle | 20% off when a team runs Arrowsterr, Claritia and Omniscient together | — |

- Overages: $10 per 1,000 contacts, $1 per 1,000 emails.
- At the cost per team in Part 11 (about $80–$104), Starter keeps about 65% gross margin and Growth about 87%.

---

## Part 11. Monthly cost

### 11.1 Assumptions per team per month

| Item | Amount |
|---|---|
| Page views | 50,000 |
| Contacts | 10,000 |
| Emails sent | 50,000 (20,000 written by agent steps) |
| Agent Decide calls | 20,000 |
| Pages built or rebuilt | 20 |
| Active accounts | 500 |
| Handoffs | 50 |

### 11.2 AI per team

| Module | Use | Per team |
|---|---|---|
| M1, M7 | Score reasons (Haiku, on change only), handoff briefs (Haiku) | $12 |
| M4 Decide | Haiku, 20,000 calls, cached when inputs repeat | $10 |
| M4 Write | Haiku for most, Sonnet for fit 80+ | $20 |
| M5 Brand Brain | Distill and voice (Haiku), embeddings (Voyage, check) | $3 |
| M6 | Page builds and personalization variants (Sonnet) | $3 |
| M8 | Weekly summary (Opus, Batch API) | $2 |
| M10 | Weekly plays and Ask (Sonnet with caching) | $10 |
| **Total** | | **$60** |

Claude prices: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per million tokens. Web search $10 per 1,000 searches (check).

### 11.3 Totals

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| AI ($60 per team) | $3,000 | $30,000 |
| Amazon SES (about $0.10 per 1,000 emails, check) | $250 | $2,500 |
| Dedicated sending IPs (about $25 each, check) | $50 (2) | $250 (10) |
| Coresignal (check) | $1,500 | $5,000 |
| IPinfo Business (check) | $249 | $1,000 |
| Fly: web, collect, agent, relay (check) | $25 | $120 |
| Supabase Pro + compute (check) | $85 | $135 |
| ClickHouse Cloud (check) | — | $300 |
| Resend for app notifications | $20 | $90 (check) |
| Cloudflare Turnstile | $0 (check) | $0 (check) |
| SOC 2 compliance tool (check) | — | $850 |
| **Total** | **$5,179** | **$40,245** |
| **Per team** | **About $104** | **About $80** |

**Ways to cut the bill:**
- Haiku for Write by default.
- The decision cache on Decide.
- The Batch API for summaries.
- A shared company cache for Coresignal and IPinfo.
- Enrichment only for accounts with real activity.

---

## Part 12. Risks

| Risk | Effect | Plan |
|---|---|---|
| Deliverability problems from one bad sender | Shared IP reputation drops for everyone | Domain verification gate, complaint pause at 0.2%, reputation tiers in the shared pool, dedicated IPs at volume, no purchased lists |
| AI writes something false or off-brand | Trust lost | Atoms only, verifier, voice guide, review modes unlocked by approval history |
| Wrong identity link drives a wrong email | Creepy or wrong message | Probable never sends, no tracking mentions, `can_act()` gate |
| Omniscient API slips | Handoff and booking blocked | HubSpot sync as the fallback path, built in week 9 |
| SES production access or rate limits | Launch delay | Request production access in week 1, Resend as a backup sender at Beta volume (check) |
| Too much scope for one team | Late launch | Phase releases each stand alone. Beta at week 19 needs only phases A to C. |
| HubSpot and Conversion.ai move faster | Harder sales | Suite bundle, price, Website Intelligence and Funnel QA that they don't have |

---

## Part 13. Setup checklist (outside the code)

| Item | Needed by | Lead time |
|---|---|---|
| AWS account, SES production access request, SNS topic | Week 10 (request in week 1) | Days to weeks |
| IPinfo Business plan | Week 3 | 1 day |
| Coresignal plan upgrade (Premium at Beta) | Week 5 | 1 day |
| Omniscient API work (Part 5.1) | Weeks 5–6 | In the build |
| Arrowsterr API key and endpoints | Week 13 | In the build (check what exists) |
| HubSpot developer app | Week 9 | Days |
| Cloudflare Turnstile keys | Week 21 | 1 day |
| Voyage AI key | Week 14 | 1 day |
| Fly certificates for custom domains | Week 20 | 1 day |
| DPA, sub-processor list, privacy policy update, email consent wording per region | Week 6 | 1–2 weeks, plus lawyer review |
| Salesforce developer org | Week 29 | Days |

---

## Part 14. What changes in the repo

| Item | Change |
|---|---|
| `CLAUDE.md` | First paragraph rewritten for the marketing platform. Rules stay. |
| `docs/vision.md`, `docs/plan.md`, `docs/homepage.md` | Rewritten for the new product when building starts |
| `docs/pivot-plan.md` | Marked as replaced by this file |
| `docs/identity.md`, `docs/account-intelligence.md` | Stay as the specs for M1 and M7 |
| Testing product (runner, Explorer, recorder, tunnel, Planner, MCP) | Kept. Powers Funnel QA (M9) and the Explorer crawls for M5. Screens hidden for new workspaces. |
| Homepage tryclaritia.com | New copy after the Beta at week 19 |
