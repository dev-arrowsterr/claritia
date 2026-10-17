# Conversion parity: week by week

The build detail for each of the 21 weeks in `docs/conversion-parity.md` Part 19. Each week lists its tables, code, jobs, screens, tests, what the founder needs to have ready, when it's done, and what it adds to the monthly bill. Source specs are in `docs/contact-sources.md`.

Rules for every week (from `CLAUDE.md`):
- Every table gets RLS, leak tests in `tests/db/leaks.sql`, and functions that check membership.
- Anything touching identity, the jobs queue, the send pipeline, imports or sync ships with a test that proves it on a flaky case.
- AI calls go through the step cache; a passing step replays from cache.
- No `<select>` or browser dialogs; app `Select` and dialog helpers only. Working screens hold labels, buttons and real errors. `ToolIntro` on first screens.
- Each week ends with `npm test`, `npm run test:db`, `typecheck`, `lint` and `build` green, then a push.

Cost lines are what the week adds to the monthly bill at Beta (50 teams) and Growth (500 teams). Totals are in the plan's Part 20.

---

## Week 1. Contacts, CSV import, filter bar (built)

See the plan's Part 21. Migration `033_contacts.sql`, `src/lib/contacts/`, `src/lib/filters.ts`, `FilterBar`, `ContactsView`. Cost: $0 Beta, about $1 Growth.

---

## Week 2. Imports at full size (built)

What shipped and what's left: the plan's Part 21b. The build used `035_imports.sql` (records took `034`), one import run shared by the web app and the job in place of staged rows, and undo from field history.

**Goal:** any file of any size imports with preview, undo and suppressions first.

**Database: `034_imports.sql`**
- `import_files`, `import_rows`, `source_links`, `suppressions`, `field_order` (plan 16.1).
- `imports` gains `kind`, `source_id`, `cursor`, `progress jsonb`, `undo_until`, `undone_at`.
- `contacts`, `field_writes`, `consents` gain `import_id`.
- Storage bucket `imports`, private, path `<workspace_id>/<import_id>/<file>`, policies like the `runs` bucket.
- Functions:
  - `import_stage(p_import, p_rows jsonb)` (service): writes a page of raw rows.
  - `import_apply(p_import, p_from int, p_to int)` (service): maps staged rows through `contacts_upsert` and sets each row's outcome.
  - `import_preview(p_import)` (member): first 20 staged rows with their outcome.
  - `import_undo(p_import)` (member): queues the undo job; owner or the person who ran it.
  - `suppress(p_ws, p_rows jsonb)` (service): upsert suppressions.
  - `contacts_upsert` gains: skip suppressed-and-erased checks, `import_id` on writes, and the field order rule (a lower source fills blanks only).

**Code**
- `src/lib/contacts/csv.ts`: a streaming parser (`parseCsvStream(chunks)`) beside the week 1 one; encoding sniff.
- `src/lib/contacts/excel.ts`: `.xlsx` with `exceljs` streaming; `.xls` with SheetJS up to 50 MB.
- `src/lib/contacts/vcard.ts`: vCard 3.0 and 4.0.
- `src/lib/contacts/clean.ts`: phone (`libphonenumber-js`), Name Case, "Last, First" split, US and Canadian region codes, title → seniority and department rules.
- `src/lib/contacts/undo.ts`: rules for what undo removes and restores.
- `worker-intel/jobs/imports.ts`: `import_file` (stream from storage, stage 5,000 rows a page, save byte offset as cursor), `import_apply` (1,000 rows per call), `import_undo`, `ai_title` (Haiku for unknown titles, cached by title).
- `src/app/api/contacts/import/route.ts`: small files keep the week 1 path; big files return a signed upload URL and start `import_file`.

**Screens**
- Import wizard: file picker accepts CSV, TSV, TXT, XLSX, XLS, VCF; paste box; Google Sheets button (Picker). Sheet picker for Excel. Preview step with 20 rows and outcome tags (New, Update, Merge, Skip, Suppressed). Progress bar from `imports.progress`, read every 2 s. Report with "Download errors" (CSV of skipped rows with reasons) and Undo.
- Settings › Imports: list with Undo while open.
- Contact page: each value's source tag now shows the import's file name.

**Jobs:** `import_file`, `import_apply`, `import_undo`, `ai_title`.

**Tests**
- 2,000,000-row CSV with the worker killed 3 times: every row applied once, counts match, no doubles.
- Undo after an overlapping second import: only untouched contacts from the first go; overwritten values come back.
- A suppressed address in the file never becomes sendable; a send queued mid-import skips it.
- Encodings and Excel quirks (BOM, UTF-16, Windows-1252, dates, formulas, merged headers).
- Field order: a file import never overwrites a CRM value.
- Leak tests for the new tables and the storage bucket.

**Founder:** Google Cloud OAuth client for the Picker and Sheets (scope `drive.file`).

**Done when:** a 2,000,000-row file imports with killed workers, and Undo works after an overlapping import.

**Cost:** Supabase storage for uploads, deleted after 30 days: under $1 Beta, about $5 Growth (check). Haiku titles: under $5 Beta, under $50 Growth. Fly `claritia-intel` to 1 GB: about $3 (check).

---

## Week 3. Sources framework, HubSpot two-way, read-only MCP (started)

What shipped and what's left: the plan's Part 21c.

**Goal:** one framework every source plugs into; HubSpot syncs both ways.

**Database: `035_sources.sql`** with `sources`, `source_runs`, `sync_log`, `mappings`, `hooks`, `campaigns`, `campaign_members`, `deals`, `deal_contacts` (plan 16.2). Functions: `source_connect` (service), `source_settings_save` (member), `sync_log_list` (member, filtered), `sync_retry` (member).

**Code**
- `src/lib/sources/types.ts`, `registry.ts`, `ctx.ts` (fetch with retry, rate limiter, token refresh, lease check), `apply.ts` (records → `import_rows` → upsert, shared with files).
- `src/lib/sources/hubspot.ts` (spec in `docs/contact-sources.md` Part 4).
- `src/lib/sources/sync.ts`: echo guard (hash of what we sent in `source_links.last_hash`; `claritia_source` property), conflict rule per field, one `sync_log` row per change.
- `src/app/api/sources/[kind]/connect/route.ts` and `callback/route.ts` (OAuth with state and PKCE), `src/app/api/hooks/[kind]/[id]/route.ts` (signature check, stage only).
- `worker-intel/jobs/sources.ts`: `source_pull`, `crm_push`, nightly count check.
- `src/app/api/mcp` gains read tools: `search_contacts`, `get_contact`, `list_segments`, `get_account`, `list_visitors`, `list_sources`.

**Screens**
- Settings › Sources: catalog of cards by group with state tags; search.
- Source page: objects and direction (Select per object: Both ways, In only, Off), schedule, mapping table with value maps, field order, last runs, Pause, Disconnect.
- Settings › Sync log: table with FilterBar (source, object, action, error) and Retry.

**Tests**
- HubSpot fake from recorded responses: 1,000 random changes on both sides with dropped webhooks, duplicate deliveries and 429s; both sides end equal; no echo loops; one log row per change.
- A merge in HubSpot moves the link; a delete soft-deletes the link.
- MCP read tools return only the caller's workspace.

**Founder:** HubSpot public app (client id, secret, redirect URL), a test account.

**Done when:** a HubSpot test account syncs both ways with 0 doubles after the 1,000-change test.

**Cost:** $0. HubSpot's API is free on the customer's plan.

---

## Week 4. Salesforce and Omniscient (started)

What shipped and what's left: the plan's Part 21c.

**Goal:** Salesforce two-way, Omniscient one-click.

**Code**
- `src/lib/sources/salesforce.ts`: Bulk API 2.0 backfill, CDC through the Pub/Sub API (gRPC client `@grpc/grpc-js`, Avro decode `avsc`), polling fallback, Composite writes, lead convert, campaigns and members both ways, `/limits` guard.
- `src/lib/sources/omniscient.ts`: app key connect, webhooks, activity write-back.
- Setup page for Salesforce custom fields (score, band, reasons) with a downloadable package or step list.

**Screens:** Salesforce mapping includes the lead vs contact rule (Select: "Create leads", "Create contacts", "Match only").

**Tests**
- The 1,000-change test against a Salesforce fake.
- Lead convert: one contact, both links kept.
- CDC gap: the stream drops for 10 minutes; the poll fills the gap with no doubles.
- API budget: pulls pause at 80% of the org total.

**Founder:** Salesforce connected app, a Developer Edition org. Omniscient migration 032 live.

**Done when:** a Salesforce Developer org passes the same test.

**Cost:** $0.

---

## Week 5. Email tool imports (started)

What shipped and what's left: the plan's Part 21c.

**Goal:** move contacts, lists, suppressions, consent and history out of 10 email tools.

**Code:** `src/lib/sources/` `mailchimp.ts`, `activecampaign.ts`, `klaviyo.ts`, `brevo.ts`, `kit.ts`, `constantcontact.ts`, `mailerlite.ts`, `sendgrid.ts`, `loops.ts`, `campaignmonitor.ts`. Each: suppressions pulled first, then contacts, lists to static segments (segments table from week 1), 13 months of activity to `contact_events`.

**Screens:** the wizard's source path: pick the tool, connect, pick lists, then the same mapping, consent, preview and run. Per-list basis question for tools that store none.

**Tests:** for each tool, the recorded test (2 pages, a 429, a refresh, a deleted member) and its consent map fixture; a suppression in the source blocks a send at once.

**Founder:** OAuth apps for Mailchimp, Klaviyo, Constant Contact, Kit.

**Done when:** each passes its recorded test and consent map.

**Cost:** $0 (customers' own plans). Disk for 13 months of history: about 1 KB per event; with 50,000 events per team, $0 Beta and about $3 Growth (check).

---

## Week 6. Marketing automation tools, other CRMs, Airtable, Notion (started)

What shipped and what's left: the plan's Part 21c.

**Goal:** the big three migration sources, plus every other CRM.

**Code**
- `marketo.ts` (bulk extract leads and activities in 31-day windows, assets for the agent), `pardot.ts`, `eloqua.ts`, HubSpot marketing assets (lists, workflows, emails, forms) in `hubspot.ts`, `customerio.ts`, `iterable.ts`, `braze.ts`, `intercom.ts`.
- `pipedrive.ts`, `zoho.ts`, `dynamics.ts`, `attio.ts`, `close.ts`, `copper.ts`, `freshsales.ts`, `monday.ts`, `affinity.ts`, `airtable.ts`, `notion.ts`.
- Assets from automation tools stored raw in `migration_items` (created now, filled by the agent in week 20).

**Tests:** recorded tests for each; Marketo's daily quota hit mid-run pauses and resumes next day with no gap.

**Founder:** OAuth apps for Pipedrive, Zoho, Dynamics (Entra), Attio, monday, Airtable, Notion, Intercom; Marketo, Pardot and Eloqua sandboxes if possible (or a design partner's read-only access).

**Done when:** each passes its recorded test.

**Cost:** $0.

---

## Week 7. Live sources: forms, scheduling, events, ad lead forms, API (started)

What shipped and what's left: the plan's Part 21c.

**Goal:** new leads from anywhere land on a contact in under 10 seconds.

**Code**
- Webhook connectors in `src/lib/sources/`: Typeform, Tally, Jotform, Fillout, Formstack, Webflow, Framer, Wix, Calendly, Chili Piper, Cal.com, SavvyCal, Zoom, Luma, Eventbrite, Goldcast, Livestorm, ON24, Cvent (hourly), LinkedIn Lead Gen, Meta Lead Ads, Google Ads lead forms.
- `wordpress/claritia-wp/`: the plugin (PHP) for Gravity Forms, Contact Form 7, WPForms.
- `src/app/api/v1/contacts/import/route.ts`, `imports/[id]/route.ts`, `imports/[id]/undo/route.ts`, `contacts/route.ts`; `api_idempotency` handling (table lands in week 21's migration; until then, the `jobs` key holds the idempotency key).
- Zapier, Make and n8n app definitions in `integrations/`.
- Anonymous visit attach: a form contact with an email links the device's earlier visits through identity (existing stitch with evidence source `form`).

**Tests:** a hook delivered twice makes one event; a hook with a bad signature is refused; a Typeform fill reaches a contact in under 10 s in the e2e check; the import API with the same idempotency key twice runs once.

**Founder:** Zoom Marketplace app, LinkedIn Marketing API access request (lead sync), Meta app with `leads_retrieval` (app review), Cvent partner access, Zapier and Make developer accounts.

**Done when:** a Typeform fill and a Zoom registration reach a contact in under 10 s.

**Cost:** $0 for the APIs (check Cvent partner terms). Web app load from hooks: within the current Render plan (check).

---

## Week 8. Custom objects, warehouses, product data, segments (built)

What shipped and what's left: the plan's Part 21b (custom objects) and Part 21d. The build used `037_segments.sql` and `038_warehouses.sql`; custom objects landed in `034_records.sql`.

**Goal:** the data model Conversion sells, and segments over all of it.

**Database: `036_objects.sql`** with `objects`, `object_fields`, `object_rows` (jsonb data, keyed by source id), `object_links`, `account_events`, `warehouse_queries`.

**Code**
- `src/lib/objects/`: registry, link resolver for segments and tokens.
- `src/lib/warehouse/`: Snowflake, BigQuery, Databricks, Redshift, ClickHouse, Postgres, MySQL clients behind one interface; query runner with cursor binding, timeout, row cap, one-statement check.
- Product and billing connectors: Segment, RudderStack, PostHog, Mixpanel, Amplitude, Stripe, Shopify, Chargebee, Paddle, Recurly, Zendesk, Front; data vendors, Outreach, Salesloft.
- `src/lib/contacts/segments.ts`: rule tree (AND and OR, 3 levels) → one SQL query, extending `contacts_where` with events, custom objects, consent, source and segment membership.
- `worker-intel/jobs/segments.ts`: `segment_refresh` per contact on change and hourly full; entered and left events.

**Screens:** Segments list and builder (live count, sample of 10); Settings › Data model (objects, fields, links, counts); warehouse query editor with a test run.

**Tests:** 30 rule types against a hand-counted fixture; fuzz with SQL-like values; custom object joins; a warehouse row becomes an event on schedule; a query with two statements is refused.

**Founder:** a Snowflake trial and a BigQuery project for tests; lawyer answer on the data vendor rule.

**Done when:** 30 rule types pass, and a warehouse row becomes an event on schedule.

**Cost:** Fly `claritia-intel` to 2 GB: about $6 Beta (check). Supabase compute up one size for segment refresh: about $25 Beta, $100 Growth (check).

---

## Week 9. Sending

**Goal:** a verified domain sends with every guard on.

**Database: `037_email.sql`** with `sending_domains`, `templates`, `emails`, `email_messages`, `send_limits`, `brand_kits`, `email_stats` (from `docs/marketing-platform.md` M3).

**Code:** `src/lib/email/resend.ts`, `domains.ts` (Resend domains API, DNS records and checks), `guard.ts` (consent, suppression, frequency cap, quiet hours by time zone), `track.ts` (link rewrite, click tokens, scanner filter), webhook route `src/app/api/email/events/route.ts` with Svix signature check; jobs `send`, `email_event`, `domain_check`.

**Screens:** Settings › Sending: domain wizard with record tags (Verified, Waiting, Wrong), topics, frequency cap, quiet hours.

**Tests:** webhook signature; suppressed address never sent even from a queued step; one-click unsubscribe (RFC 8058 headers); complaint storm pauses the workspace; cap and quiet hours.

**Founder:** Resend volume plan, rate raised, webhook secret in `RESEND_WEBHOOK_SECRET`.

**Done when:** a test domain verifies and an email sends with one-click unsubscribe.

**Cost:** Resend at 50,000 emails per team: $1,150 Beta, $5,000 Growth (check). Dedicated IPs $50 Beta, $250 Growth (check).

---

## Week 10. Email Studio

**Goal:** build, test and send a broadcast with reports.

**Code:** `src/lib/email/blocks.ts` (block schema, MJML render, plain text), `tokens.ts` (fields, custom objects, fallbacks), brand kit reader (logo, colors, fonts from the site), A/B split and winner job; `src/components/app/views/EmailEditor.tsx`, `EmailsView.tsx`.

**Screens:** Emails list; editor with blocks, token picker, personal block rules, preview at 3 widths in light and dark, test send with a chosen contact; report per email.

**Tests:** render snapshots at 3 widths; every token resolves or uses its fallback; broadcast to 500 contacts sends once each with a killed worker mid-send.

**Done when:** a broadcast to 500 contacts sends and clicks show in the CRM campaign.

**Cost:** $0 beyond week 9.

---

## Week 11. Workflow engine

**Goal:** an engine that never loses or doubles an enrollment.

**Database: `038_workflows.sql`** with `workflows`, `workflow_nodes`, `workflow_edges`, `enrollments` (unique open enrollment per contact and workflow), `node_runs`; `approvals` gains kinds.

**Code:** `src/lib/workflows/graph.ts` (schema, validation, versions), `engine.ts` (enroll, step, wait, branch, split, exit, re-entry), `steps/` one file per step; job `workflow_step`.

**Tests:** 10,000 enrollments with killed workers and retried jobs: none stuck or doubled; exits honored; version moves right.

**Done when:** the 10,000-enrollment test passes.

**Cost:** $0.

---

## Week 12. Canvas

**Code:** `WorkflowsView.tsx`, `WorkflowCanvas.tsx` (vertical layout, "+" on edges, side panel per node), validation messages, live counts per node, version history.

**Tests:** canvas round-trip (build, save, load) keeps the graph; validation blocks a path with no end and a wait with no timeout.

**Done when:** a 12-node workflow is built and published in the app.

**Cost:** $0.

---

## Week 13. Every trigger and step

**Code:** triggers (segment, source created, form, CRM change, product event, custom object, warehouse row, website, email, score, date, manual, API, webhook) and steps (email, wait, branch, split, update field, CRM action, ads (stub until week 18), Slack, webhook, route (stub until week 16), enroll, goal).

**Tests:** one passing test per trigger and per step; a CRM action retried makes one task.

**Done when:** each trigger and step has a passing test.

**Cost:** $0.

---

## Week 14. AI steps, approvals, simulate

**Code:** `ai_decide`, `ai_classify`, `ai_write` jobs through the step cache; checks on written emails (no tracking mentions, facts only from the approved list, tokens filled, length); review modes; Approvals for written emails; `simulate.ts` for "Test with 20 contacts".

**Tests:** Decide never returns a missing path; Write drops a made-up fact and blocks a tracking mention; a passing step replays from cache with no model call; simulate makes no sends and no CRM writes.

**Done when:** Simulate on 20 contacts shows every path, reason and email with no sends.

**Cost:** Claude for Decide, Classify and Write: about $30 per team: $1,500 Beta, $15,000 Growth.

---

## Week 15. Forms and landing pages

**Database: `039_pages.sql`** with `forms`, `form_fields`, `submissions`, `pages`, `page_versions`, `page_domains`.

**Code:** form renderer (embed script and in-page block), consent block by region, Turnstile, progressive fields; page sections and blocks; `collect` serves pages by host with HTTPS (certificates through Fly, check); AI page draft from Brand Brain facts (Sonnet); Funnel QA check on publish and daily (existing runner).

**Screens:** Pages and Forms lists, editors, Funnel QA state tag, reports.

**Tests:** a submit with the network cut mid-request lands once; Funnel QA catches a broken form; a strict-region form without the box ticked records no consent.

**Done when:** a page with a form publishes on a custom domain and Funnel QA passes.

**Cost:** Turnstile free tier (check); Fly for `collect` page serving about $5 Beta, $40 Growth (check); Sonnet page drafts about $1 per team: $50 Beta, $500 Growth.

---

## Week 16. Scoring and routing

**Database: `040_scoring.sql`** with `score_models`, `routing_rules`, `rep_capacity`, `handoffs`, `sla_timers`.

**Code:** `src/lib/scoring/contact.ts` (v0 weights, reasons), `train.ts` (v1 logistic regression, AUC gate), `routing.ts` (owner, account owner, named list, territory, segment, weighted round robin by capacity, out of office), `sla.ts`; CRM score sync; jobs `score_contact`, `score_train`, `route`, `sla_check`.

**Screens:** Settings › Scoring (bands, weights, model version and AUC, routing rules, capacity per rep, SLA); score and reasons on the contact page.

**Tests:** fixed fixtures give expected scores and reasons; v1 goes live only on a better AUC; 20 routing cases; one CRM task per handoff when retried; SLA fires once.

**Done when:** a Ready lead reaches the right rep in Slack within 2 minutes p95.

**Cost:** Haiku reasons on band change about $2 per team: $100 Beta, $1,000 Growth.

---

## Week 17. ABM

**Database: `041_abm.sql`** with `account_lists`, `account_list_members`, `buying_roles`.

**Code:** account lists (static and rules), buying group by role from title department and seniority, gaps, account score, account journeys (workflows on accounts).

**Screens:** Accounts gets list views and a buying group panel on the account page.

**Tests:** buying group roles on a fixture; an account journey runs once per account.

**Done when:** a target account list runs an account journey.

**Cost:** $0.

---

## Week 18. Ads and attribution

**Database: `042_ads.sql`** (`ad_accounts`, `audiences`, `audience_members`, `ad_spend`, `conversions_out`) and `043_attribution.sql` (`touches`, `attribution_models`, `attributed`).

**Code:** audience sync to LinkedIn Matched Audiences, Google Customer Match and Meta Custom Audiences (hashed emails, strict-region "No basis" left out); offline conversions out; daily spend in; touches built nightly; models (first, last, linear, time decay, W-shaped, custom); weekly summary job.

**Screens:** Settings › Ads; Attribution report with model picker; weekly summary.

**Tests:** a removed contact leaves the audience; strict-region "No basis" contacts never sync; attribution totals equal deal amounts for each model.

**Founder:** LinkedIn Marketing API approval, Google Ads developer token, Meta app review.

**Done when:** an audience syncs to LinkedIn, and a won deal shows credited touches.

**Cost:** ad APIs $0 (check terms); compute for nightly attribution within the Supabase line.

---

## Week 19. Agents, plays, MCP drafts, Skills

**Database: `044_agents.sql`** with `agent_tools`, `agent_runs`, `agent_steps`, `agent_schedules`, `plays`, `play_runs`.

**Code:** `src/lib/agent/tools.ts` (settings per tool), `run.ts` (loop, caching, 8-call cap), `slack.ts` (mentions, DMs, approve buttons), `linear.ts` (ticket assign, links), webhook start; plays engine; knowledge graph build (nightly); MCP draft tools; Skills pack in `skills/` (Brand voice, ICP and scoring, Campaign brief, Launch checklist, Event follow-up, Import cleanup); campaigns as code (YAML export and import).

**Screens:** agent panel on every screen; Plays list; Settings › Agents (tools with a Select each, schedules, Slack and Linear connect).

**Tests:** a disabled tool is never called; an approval tool never runs before approval; edits show a diff; replay of fixed data gives the same drafts.

**Founder:** Slack app scopes (`chat:write`, `im:history`, `app_mentions:read`), Linear OAuth app.

**Done when:** "Build a nurture for webinar signups" makes drafts, and a play runs on a hot account.

**Cost:** agents about $10 per team and plays about $3: $650 Beta, $6,500 Growth.

---

## Week 20. Migration agent

**Database: `045_migrations.sql`** with `migrations`, `migration_items` (kind, source id, raw, translated, proof, state).

**Code:** inventory per source; translators (smart lists → rule trees, HTML → blocks, tokens, forms, programs and workflows → our graph, score rules → v0 weights) with Sonnet for what rules can't map; proofs (counts within 1%, renders, form submits, simulated paths vs history, scores within 5 points); cutover checklist.

**Screens:** Settings › Migration: inventory with Keep or Leave behind, each item's proof tag (Proved, Differs, Can't translate), cutover per part.

**Tests:** a recorded Marketo instance migrates with every proof passing; an item that differs can't be cut over.

**Done when:** a recorded Marketo instance migrates with every proof passing.

**Cost:** Sonnet $20 to $40 per migration: $300 Beta (10 a month), $1,500 Growth (50 a month).

---

## Week 21. API, docs, design partners

**Database: `046_api.sql`** with `api_idempotency`.

**Code:** REST API (contacts, imports, events, segments, workflows enroll) with scopes; OpenAPI file; customer setup docs per source (`src/app/docs/` pages from the specs); internal quality page (sync loops, doubled contacts, suppressed sends, complaint rate, costs vs plan).

**Tests:** every Part 18 test green in CI; API scopes refuse out-of-scope calls.

**Done when:** 2 design partners import from their old tools and run a live workflow synced with their CRM.

**Cost:** $0 beyond earlier weeks.

---

## Summary

| Weeks | Theme | Adds to the bill (Beta / Growth) |
|---|---|---|
| 1–8 | Contacts from everywhere, sync, data model | About $40 / $260 (Supabase, Fly, Haiku titles) |
| 9–10 | Email | About $1,200 / $5,250 |
| 11–14 | Workflows and AI | About $1,500 / $15,000 |
| 15–18 | Pages, scoring, ABM, ads, attribution | About $155 / $1,540 |
| 19–21 | Agents, migration, API | About $950 / $8,000 |
| **All** | | **About $3,900 / $30,250** (plan Part 20; Claude lines there include per-team rounding) |

All prices not confirmed on the vendor's own page are marked "check" in the plan.
