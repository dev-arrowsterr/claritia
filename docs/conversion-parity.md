# Conversion parity: the full platform plan

The plan to match everything Conversion (conversion.ai) sells, on top of what Claritia already has, and to go past it in two places: contacts come in from every tool a team has ever used, and Website Intelligence (M1) shows who is on the site. Conversion is an AI-native B2B marketing automation platform built around Salesforce and the data warehouse, sold as a Marketo replacement.

Two companion docs hold the build detail: `docs/conversion-weeks.md` (tables, code, jobs, screens, tests and cost for each week) and `docs/contact-sources.md` (one spec per import source).

This plan replaces the 14-week version. It keeps week 1 (built, Part 21) and changes the order of `docs/marketing-platform.md`: imports and CRM sync come first, then email and workflows, then pages, scoring, ads, attribution and agents. Rules for identity, consent and sending stay in their specs:

| Spec | What it settles |
|---|---|
| `docs/marketing-platform.md` M2 to M10 | Module details this plan builds on |
| `docs/identity.md` | Matching contacts to people, cleaning emails, email link tokens |
| `docs/account-intelligence.md` Part 3 | Region policy, consent, data requests, retention |
| `docs/brand.md` | Look and copy of every screen, email and page |

Facts about Conversion come from its own pages (home, data model, automations, lead scoring, agents, forms, landing pages, ads, integrations, migration). They are vendor claims, read in October 2026.

---

## Part 1. What Conversion sells, and our answer

| Conversion | What it does (its own pages) | Claritia after this plan |
|---|---|---|
| Data model | CRM records, warehouse tables and product events in one model. Custom objects with one-to-one, one-to-many and many-to-many links. Salesforce changes land in minutes, webhooks and API events in real time, warehouse tables on a schedule. | The same, plus 60+ import sources (Part 4) and website visitors (M1) |
| Knowledge graph | AI maps the data model into a graph of people, accounts, activity, campaigns and product, which agents work from | Brand Brain plus a data map the agents read (Part 15) |
| Warehouses | Snowflake, BigQuery, Databricks, Redshift, ClickHouse, PostgreSQL, on the customer's schedule | The same list plus MySQL, read only |
| Salesforce sync | Two-way, campaign members both ways, task creation, audit log | Two-way HubSpot, Salesforce and Omniscient, one sync log, campaign members both ways |
| Email Studio | Drag-and-drop builder with live CRM and warehouse fields | Block editor, brand kit, personal blocks, test send, reports |
| Automations | Visual builder, real-time triggers from every source, AI steps that score, route or classify | Workflows with the same triggers and steps, AI Decide and AI Write, website triggers |
| Lead scoring and routing | AI weighs CRM, warehouse, product and behavior data, with top reasons. Routing by territory, segment, ownership, rep capacity and named accounts. | Scores with top 3 reasons, retrained weekly, synced to the CRM. Routing with capacity and SLA timers. |
| ABM | Account-level orchestration with one engagement view | Account lists, buying groups, account plays, account journeys |
| Forms | On landing pages, start workflows, add to scores, keep page, referrer and UTMs, attach earlier anonymous visits | The same, plus consent wording by region and Funnel QA on every form |
| Landing pages | Sections and blocks, published on the customer's domain, form rendered in the page | The same, built by AI from Brand Brain, checked in a real browser |
| Ads | Audiences, lead gen forms and attribution | Audience sync to LinkedIn, Google and Meta, lead forms in, offline conversions out |
| Attribution (Mosaic) | Attributed pipeline and closed-won by channel, campaign and asset, built-in model or custom weights | Multi-touch attribution with AI search as a channel (M8) |
| Plays | An agent for every contact and account | Account and contact plays with drafts to approve (Part 15) |
| Agents | Start from Slack, Linear, a schedule, a webhook or a prompt. Each tool is Automatic, Requires approval or Disabled. Reads and new drafts run alone; deletes, contact imports and Salesforce links wait; edits show a before-and-after diff. Nothing goes live without a person. | The same settings, plus an MCP server and a Skills pack so teams can work from Claude |
| Migration | Playbooks for Marketo, Pardot, HubSpot and Eloqua. Agents rebuild workflows, lists and campaigns, the old tool stays live, each part is checked on real data. They claim about 4 weeks. | Migration agent for the same four plus ActiveCampaign, Mailchimp, Klaviyo and Customer.io (Part 5) |
| Events | Cvent registrations into campaigns every hour | Cvent, Zoom, Luma, Eventbrite, Goldcast and Livestorm |
| — | — | Website visitors, companies and intent (M1), and AI search visibility from Arrowsterr |

## Part 2. What a customer can do at the end

1. Bring in every contact they have, from a CSV, an Excel file, a Google Sheet or any of 60+ tools, with lists, unsubscribes, consent and 13 months of email history, in one afternoon. Undo any import.
2. Connect HubSpot, Salesforce or Omniscient in two clicks and keep it in sync both ways, with every change in the Sync log.
3. Keep form, event, ad and product sources flowing in live, each one landing on the right contact.
4. Build a segment ("Fintech, fit 70+, clicked an email in 14 days, used feature X") and see the live count.
5. Send a newsletter from their own domain with unsubscribes, suppression and reports.
6. Build a workflow on a canvas with AI steps, test it on 20 real contacts with no sends, then publish.
7. Publish a landing page with a form that starts a workflow, checked in a real browser first.
8. See a score and its top 3 reasons on every contact, in Claritia and in the CRM, and route ready leads to the right rep with an SLA timer.
9. Run plays on target accounts, sync audiences to ads, and see pipeline by channel, campaign and asset.
10. Ask an agent in the app, Slack, Linear or Claude to build a nurture, and get drafts to approve.
11. Move off Marketo, Pardot, HubSpot or Eloqua with the old tool live until every part checks out.

## Part 3. Scope

| In this plan | Later |
|---|---|
| Imports from files and 60+ tools, with undo | Two-way sync with CRMs past the first three (they import, and sync in on a schedule) |
| HubSpot, Salesforce and Omniscient two-way sync | Writing back to a warehouse |
| Custom objects and 7 warehouses, read only | SMS and WhatsApp |
| Email, workflows, forms, landing pages | A/B tests on landing pages (pages ship with A/B on emails only) |
| Scoring, routing, ABM, ads audiences, attribution | Direct mail, chat widget |
| Agents in the app, Slack, Linear, schedules, webhooks, MCP and Skills | Mobile app |
| Migration agent for 8 platforms | Done-for-you migration service (a person runs the agent for the customer) |

---

## Part 4. Contacts from everywhere

The goal: no team stays on an old tool because their contacts are stuck in it. Every source lands through one pipeline, so dedupe, consent, suppression and undo work the same for all of them.

### 4.1 The pipeline

```
 source (file, API, webhook, warehouse)
        │  pull, page by page, with a saved cursor
        ▼
 import_rows (staging: raw record, source id, batch)          ── preview, dry run, error file
        │  map fields (saved mapping, then AI suggestions for unknown columns)
        │  clean (email, phone, country, names, title → seniority and department)
        │  consent and suppression rules for the source
        ▼
 contacts_upsert (week 1) ── contacts, companies, field_writes, consents, contact_events
        │                    source_links (source record id → contact)
        ▼
 suppressions, segments (static lists), engagement history, custom objects
```

- **One pipeline, many sources.** Each source is a connector that knows how to sign in, list its objects and fields, pull records page by page, and say what changed since a cursor. Everything after that is shared.
- **Staging first.** Records land in `import_rows` before they touch contacts. That gives a preview of the first 20 rows with what will happen to each (new, update, merge, skip, suppressed), a dry run, and an error file to download.
- **Resumable.** Each import is a chain of jobs that saves its cursor after every page. A crash or deploy picks up at the last page. A page sent twice changes nothing (week 1's upsert is safe to repeat).
- **Undo.** Every contact, field write and consent row carries its `import_id`. "Undo import" removes contacts the import created that nobody changed since, and puts back field values the import overwrote (from `field_writes`). Undo is open for 30 days.
- **Big files.** Files go straight from the browser to storage in parts (resumable upload), then a background job reads them in a stream. Up to 1 GB and 2,000,000 rows. Week 1's 50,000-row in-request import stays for small files, since it's instant.

### 4.2 Matching and merging across sources

| Rule | Detail |
|---|---|
| Match order | 1. The source's record id in `source_links`. 2. Cleaned email (`docs/identity.md` Part 6). 3. A CRM id field on the record (a HubSpot id in a Mailchimp merge field, a Salesforce id in a Marketo record). |
| No email | Allowed when the source gives a stable id (a Salesforce lead with no email, a Pipedrive person with a phone). Such contacts can't get email until an email arrives. |
| Same email, two records in one source | One contact, both source links kept, a `conflict` row in the Sync log |
| Which value wins | Each field has a source order, set per workspace. Default: CRM > form > product > file import > data vendor > AI. A lower source fills a blank field and never overwrites a higher one. A newer value from the same source wins. |
| Where a value came from | `field_writes` keeps the latest value per field and source (week 1), so the contact page shows each value's source and any value can be put back |
| Companies | By domain, then by name. Data vendor firmographics never overwrite CRM values. |

### 4.3 Consent and suppression on the way in

Consent rules from `docs/marketing-platform.md` 9.1 apply to every source. On top of that:

| Rule | Detail |
|---|---|
| Unsubscribes come with the contacts | Every email tool's unsubscribed, bounced, complained and cleaned addresses go into `suppressions` first, before any contact, so nothing can send to them even mid-import. Suppressed addresses with no contact still block sends. |
| Consent maps per tool | Each connector maps its own consent fields: Mailchimp `subscribed` with double opt-in becomes opt-in with the signup time; Klaviyo email consent `SUBSCRIBED`; HubSpot legal basis properties; Marketo `unsubscribed`; Brevo and ActiveCampaign list status (exact field names: check each tool's docs). |
| Proof kept | The source tool, its record id, the consent time and any wording it stored go into `consents.source` and `consents.wording` |
| Strict regions | Outside opt-in, contacts in strict regions and unknown countries get "No basis" (week 1 rule) |
| Data vendors | Apollo, ZoomInfo, Lusha, Clearbit, Cognism and Clay rows are bought data. They come in for scoring, ABM and ads audiences with source class `data_vendor` and basis "No basis", and can't get marketing email until they opt in. A CSV marked "Bought or rented list" is still refused (lawyer check on the data vendor rule). |
| Erased people stay erased | Each incoming email is checked against `erasures` (`docs/identity.md` 15.1). A match is skipped and counted. |

### 4.4 Every source

Status: **Two-way** = live sync both ways. **Live in** = new and changed records arrive within minutes. **Scheduled** = pulled on a schedule (hourly by default). **One-time** = a migration import, which can be run again.

Limits and field names are from memory and need checking against each vendor's current docs before that connector is built (marked "check" in 4.5).

#### Files and spreadsheets

| Source | Mode | How | What comes in |
|---|---|---|---|
| CSV, TSV | One-time | Upload or paste. Comma, semicolon or tab. Any encoding (UTF-8, UTF-16, Windows-1252 found by sniffing). | Rows |
| Excel (.xlsx, .xls) | One-time | Upload, pick the sheet | Rows |
| Google Sheets | Scheduled | Google sign-in, pick file and tab | Rows, re-read on a schedule, only changed rows written |
| Airtable | Scheduled | OAuth, pick base, table and view | Records |
| Notion database | Scheduled | OAuth, pick database | Pages as rows |
| vCard (.vcf) | One-time | Upload (exports from phones, Outlook, Apple Contacts) | Contacts |
| Paste | One-time | Paste emails or a table into a box | Rows |

#### CRMs

| Source | Mode | Auth | Objects |
|---|---|---|---|
| HubSpot | Two-way | OAuth public app | Contacts, companies, deals, lists, legal basis, owners |
| Salesforce | Two-way | OAuth with PKCE | Leads, contacts, accounts, opportunities, campaigns, campaign members, users |
| Omniscient | Two-way | One-click app key | Contacts, accounts, deals, activities |
| Pipedrive | Scheduled, live in by webhook | OAuth | Persons, organizations, deals, labels |
| Zoho CRM | Scheduled | OAuth | Leads, contacts, accounts, deals |
| Microsoft Dynamics 365 | Scheduled | OAuth (Entra ID) | Leads, contacts, accounts, opportunities |
| Attio | Scheduled, live in by webhook | OAuth | People, companies, lists, custom objects |
| Close | Scheduled, live in by webhook | API key | Leads, contacts, opportunities |
| Copper | Scheduled | API key | People, companies, opportunities |
| Freshsales | Scheduled | API key | Contacts, accounts, deals |
| monday CRM | Scheduled | OAuth | Contacts and accounts boards |
| Affinity | Scheduled | API key | People, organizations, lists |

#### Marketing automation and email tools

Every one brings contacts, lists, custom fields, unsubscribes and bounces, consent, and 13 months of sends, opens and clicks (for scoring). The four Conversion migrates from also bring programs, workflows, emails and forms for the migration agent (Part 5).

| Source | Mode | Auth | Extra objects |
|---|---|---|---|
| Marketo | One-time, then scheduled until cutover | REST API client id and secret | Smart lists, static lists, programs, smart campaigns, emails, forms, activity log (bulk extract) |
| Salesforce Account Engagement (Pardot) | One-time, then scheduled | Salesforce OAuth | Prospects, lists, Engagement Studio programs, emails, forms, visitor activity |
| Oracle Eloqua | One-time, then scheduled | OAuth | Contacts, segments, shared lists, campaigns, emails, forms, activities (bulk API) |
| HubSpot Marketing | Two-way contacts (as above) | Same app | Active and static lists, workflows, marketing emails, forms, subscription types |
| ActiveCampaign | One-time, scheduled | API key | Lists, tags, automations, campaigns |
| Mailchimp | One-time, scheduled | OAuth | Audiences, tags, segments, merge fields, campaigns, member activity |
| Klaviyo | One-time, scheduled | OAuth or private key | Lists, segments, flows, campaigns, profile events |
| Brevo | One-time, scheduled | API key | Lists, attributes, campaigns |
| Customer.io | One-time, scheduled | App API key | People, segments, campaigns, deliveries |
| Iterable | One-time | API key | Users, lists, campaigns, events |
| Braze | One-time | REST key | Users (export), segments, campaigns |
| Constant Contact | One-time | OAuth | Contacts, lists, campaigns |
| Kit (ConvertKit) | One-time | OAuth | Subscribers, tags, forms, sequences |
| MailerLite | One-time | API key | Subscribers, groups, campaigns |
| Campaign Monitor | One-time | API key | Subscribers, lists, campaigns |
| SendGrid Marketing | One-time | API key | Contacts, lists, suppressions |
| Loops | One-time | API key | Contacts, mailing lists |
| Intercom | Scheduled | OAuth | Users, leads, companies, tags, conversations count |

#### Forms, scheduling and events (live in)

| Source | How | Lands as |
|---|---|---|
| Claritia forms | Native (Part 9) | Contact, consent with exact wording, form event |
| Typeform, Tally, Jotform, Google Forms, Fillout, Formstack | Webhook or OAuth | Contact, form event, answers as fields |
| Webflow, Framer, WordPress (Gravity Forms, Contact Form 7, WPForms), Wix | Webhook, plugin for WordPress | Contact, form event |
| HubSpot forms, Marketo forms (during migration) | Through the sync | Contact, form event |
| Calendly, Chili Piper, Cal.com, SavvyCal | Webhook | Contact, meeting booked event, owner |
| Zoom Webinars and Meetings | OAuth, webhook | Registrant, attended with minutes, no-show |
| Cvent | API (partner access, check) | Registrations, check-ins, into a campaign hourly |
| Luma, Eventbrite, Goldcast, Livestorm, ON24 | Webhook or OAuth | Registered, attended, no-show |
| LinkedIn Lead Gen Forms | OAuth (Marketing API access, check) | Contact, ad lead event with campaign |
| Meta Lead Ads | OAuth (page lead access) | Contact, ad lead event |
| Google Ads lead forms | Webhook | Contact, ad lead event |
| Zapier, Make, n8n | Our REST API and an app listing for each | Anything a team already pipes around |

#### Product, billing and support

| Source | Mode | What |
|---|---|---|
| Segment, RudderStack | Live in (destination) | Identify (traits to fields), track (events), group (company) |
| PostHog, Mixpanel, Amplitude | Live in (webhook or export) and scheduled | Users, cohorts as static segments, events |
| Stripe | Live in (webhook) | Customers, plan, MRR, trial end, cancellations |
| Shopify | Live in (webhook) | Customers, orders, marketing consent |
| Chargebee, Paddle, Recurly | Live in (webhook) | Subscriptions, plan, MRR |
| Zendesk, Intercom, Front | Scheduled | Ticket counts, CSAT, last contact |

#### Warehouses and databases (read only, scheduled)

| Source | Auth | Notes |
|---|---|---|
| Snowflake | Key pair, read-only role | Saved queries on a schedule |
| BigQuery | Service account, read-only dataset | Same |
| Databricks | Personal access token or OAuth M2M, SQL warehouse | Same |
| Amazon Redshift | Read-only user | Same |
| ClickHouse | Read-only user | Same |
| PostgreSQL, MySQL | Read-only user, IP allow list, SSL | Same |

Each warehouse source is a saved query with a key column (email or a CRM id), a cursor column (updated_at) and a schedule. It can feed contacts, companies, custom objects or events. A run has a 120 s timeout and a 100,000-row cap per run, and pages past that.

#### Sales engagement and data vendors

| Source | Mode | Basis |
|---|---|---|
| Apollo, ZoomInfo, Lusha, Cognism, Clearbit (HubSpot Breeze), Clay | Customer's own API key, one-time or scheduled | "No basis", source class `data_vendor` (4.3) |
| Outreach, Salesloft | OAuth, scheduled | Keeps the source's basis; sequences become a field, so marketing pauses contacts in an active sequence |
| LinkedIn Sales Navigator | CSV export only (no open API) | "No basis" |

#### API and agents

| Way in | Detail |
|---|---|
| `POST /api/v1/contacts/import` | Up to 10,000 contacts per call as JSON or NDJSON, with an `Idempotency-Key` header. Returns an import id to poll. |
| `POST /api/v1/contacts` | One contact, upsert by email or external id |
| `POST /api/v1/events` | Segment-shaped events |
| MCP tool `import_contacts` | Requires approval by default, like Conversion. Shows the preview before it runs. |

### 4.5 Connector build list and checks

| Connector group | Build order | Checks before building |
|---|---|---|
| Files, Excel, Sheets, paste, vCard | Week 2 | Excel library license (SheetJS Community Edition is Apache 2.0, check) or `exceljs` (MIT) |
| HubSpot | Week 3 | Public app rate limits and webhook limits (check) |
| Salesforce, Omniscient | Week 4 | CDC per edition, Bulk API 2.0 and Composite limits (check) |
| Mailchimp, ActiveCampaign, Klaviyo, Brevo, Kit, Constant Contact, MailerLite, SendGrid, Loops, Campaign Monitor | Week 5 | Each export API, consent fields and rate limits (check) |
| Marketo, Pardot, Eloqua, HubSpot Marketing, Customer.io, Iterable, Braze, Intercom | Week 6 | Marketo bulk extract daily quota, Pardot API v5 limits, Eloqua bulk limits (check) |
| Pipedrive, Zoho, Dynamics, Attio, Close, Copper, Freshsales, monday, Affinity, Airtable, Notion | Week 6 | OAuth app approval steps for each (check) |
| Forms, scheduling, events, ads lead forms, Zapier, Make, n8n | Week 7 | LinkedIn Marketing API access and Cvent partner terms (check) |
| Segment, RudderStack, PostHog, Mixpanel, Amplitude, Stripe, Shopify, billing, support | Week 8 | — |
| 7 warehouses | Week 8 | Databricks SQL connector for Node (check) |
| Data vendors, Outreach, Salesloft | Week 8 | Lawyer check on the data vendor rule |

A connector is about 150 to 400 lines once the framework exists: auth, field list, pull with cursor, default mapping, consent and suppression mapping, and a recorded-response test.

### 4.6 Field mapping

1. **Saved mapping** for this source in this workspace, if one exists.
2. **Known fields.** Each connector ships a field dictionary: HubSpot `firstname` → First name, Marketo `Company` → Company, Mailchimp `FNAME` → First name, and so on.
3. **Header guesses** from week 1 (`guessTarget`).
4. **AI suggestions** for what's left: Haiku gets the column names and 5 sample values (emails masked) and picks a field, a new custom field with a type, or Skip, with a confidence. Cached by the hash of the headers, so the same export never asks twice. The marketer confirms each suggestion.
5. **Value maps.** Each connector maps its own values: HubSpot lifecycle stages, Marketo lead status, Salesforce lead status, Mailchimp member status, Pipedrive labels. Unknown values go to a review list on the mapping screen.

Custom fields made during mapping get a type (text, number, date, yes/no, pick list) from the samples, which the marketer can change before running.

### 4.7 Cleaning on the way in

| Step | How |
|---|---|
| Email | `cleanEmail` (week 1). Invalid and disposable skipped. Optional MX check (`src/lib/identity/mx.ts`), off for files over 100,000 rows. |
| Phone | Parsed with `libphonenumber-js` (MIT) to E.164, with the contact's country as the hint |
| Country and region | ISO codes from names and codes (week 1), US states and Canadian provinces to their codes |
| Names | Trimmed; ALL CAPS and all lower case fixed to Name Case; "Doe, Jane" split right |
| Title | Seniority (C-level, VP, Director, Manager, Individual) and department (Marketing, Sales, Engineering, Product, Finance, HR, Operations, Other) by rules first, Haiku for the rest, cached by title |
| Company | Domain from work email or website; Coresignal enrichment for new domains (existing `enrich_company` job) |
| Duplicates inside the file | Merged, later rows winning (week 1) |

### 4.8 Lists, history and objects

| What | Lands as |
|---|---|
| Static lists, tags, groups, audiences | Static segments with the same name and members |
| Smart lists, active lists, segments with rules | Rebuilt as dynamic segments by the migration agent (Part 5), with a count check |
| Unsubscribes, bounces, complaints, cleaned | `suppressions` with reason and source |
| Topic or subscription types | `topics` and `subscriptions` |
| Email history (13 months) | `contact_events` (`email.sent`, `email.clicked`, `email.replied`; opens kept and marked unreliable) for scoring and segments |
| Form fills, webinar attendance, meetings | `contact_events` |
| Deals, opportunities | Read-only `deals` linked to contacts and companies, for scoring and attribution |
| Anything else (product subscriptions, devices, orders) | Custom objects (Part 7) |

### 4.9 Screens

| Screen | Holds |
|---|---|
| Contacts › Import | Choose: upload a file, paste, or pick a source. Then objects and lists, mapping with suggestions, source and consent, preview of 20 rows with their outcome, Run. Progress while it runs. Report with counts, the error file and Undo. |
| Settings › Sources | Every source as a card with its state tag (Connected, Syncing, Error, Not set up), last sync and Connect. Search and filter by group. |
| Source page | Objects and direction, schedule, mapping, value maps, field order, last 50 runs, Pause, Disconnect |
| Settings › Imports | Every import with who, when, source, counts and Undo while open |
| Settings › Sync log | Every sync and import row, filtered by source, object, action and error, with Retry |

First screens use `ToolIntro`. Working screens hold labels, buttons and real errors only.

---

## Part 5. Migration agent

The answer to Conversion's migration playbooks: an agent that reads the old tool, rebuilds it in Claritia, and proves each part matches before anything switches.

| Step | What happens | Proof |
|---|---|---|
| 1. Connect | The old tool connects as a source (Part 4) and keeps running | — |
| 2. Inventory | The agent lists every list, program, workflow, email, form, field and scoring rule, with use in the last 90 days | An inventory page; unused parts default to "Leave behind" |
| 3. Contacts | Full import with suppressions first, then scheduled pulls until cutover | Count match per list, suppression count match |
| 4. Lists | Smart lists become dynamic segments: the agent translates each rule into our rule tree | Member count within 1%, with the differing contacts shown |
| 5. Emails and templates | HTML imported into the block editor; tokens mapped (Marketo `{{lead.First Name}}`, HubSpot `{{contact.firstname}}`) | Render check at 3 widths, every token resolves |
| 6. Forms | Rebuilt as Claritia forms with the same fields and hidden fields | Funnel QA submits each form and finds the contact |
| 7. Workflows | Programs, smart campaigns, Engagement Studio and HubSpot workflows rebuilt as workflows | Simulate on 50 contacts: the same path as the old tool's history for each |
| 8. Scoring | Old score rules rebuilt as v0 weights | Score match within 5 points on 100 contacts |
| 9. Cutover | Per part, the marketer flips it live and pauses the old one | A cutover checklist; the old tool stays connected for 30 days |

- Every rebuilt part is a draft. Nothing goes live without a person.
- Parts the agent can't translate are listed with the reason, for a person to rebuild.
- Model: Sonnet 5.5 with caching, through the step cache. About $20 to $40 per migration (Part 20).

---

## Part 6. System design

### 6.1 Components

```
 Files ─► storage ─► import_file (intel)  ┐
 60+ sources ─► source_pull (intel)       ├─► import_rows ─► import_apply ─► contacts, companies, objects
 Webhooks ─► /api/hooks/:source (web)     ┘                                  suppressions, segments, events
 HubSpot, Salesforce, Omniscient ◄──► crm_pull / crm_push (intel) ◄──► sync_log
 Warehouses ─► warehouse_poll (intel) ─► contact_events, custom objects
 Segment, PostHog, Stripe ─► /api/v1/events (web) ─► contact_events
 M1 sessions and signals ────────────────────────────► contact_events
                                   │
     segment_refresh · workflow_step · ai_decide · ai_write · send · ses_event · page_publish
     score_contact · route · sla_check · audience_sync · attribution · play_run · agent_run · migrate
                                   │
  Amazon SES ◄─ send     Slack, Linear ◄─ agents     CRM ◄─ handoff, scores     Ads ◄─ audiences
```

- No new Fly apps. `claritia-intel` runs every job; it grows from 512 MB to 2 GB at Beta and 3 × 2 GB at Growth.
- Pages are served by `collect` (already on the edge for `claritia.js`), so landing pages load from the customer's domain through a CNAME.

### 6.2 Life of one lead

| Step | Where | Time budget |
|---|---|---|
| 1. A webinar registrant arrives from Zoom | webhook → web | ≤ 5 s |
| 2. The row stages, maps, cleans, and upserts the contact; their earlier anonymous visits attach by email token | intel | ≤ 10 s |
| 3. Segments refresh for the contact. Entering "Webinar registrants, fit 70+" starts a workflow. | intel | ≤ 10 s |
| 4. The workflow scores, waits, sends an AI-written follow-up, and branches on the click | intel | per step |
| 5. They read pricing twice. Signals raise the score past Ready. | collect, intel | ≤ 1 min |
| 6. Routing picks the owner by territory and capacity, writes it to Salesforce, alerts the rep in Slack and pauses nurture | intel | ≤ 2 min p95 |
| 7. The deal closes in Salesforce; attribution credits the webinar, the email and the AI answer that first brought them | intel | nightly |

### 6.3 Environment

| Var | App | Purpose |
|---|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | web, intel | OAuth and refresh |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | web, intel | OAuth and refresh |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web, intel | Sheets, Google Ads |
| `<SOURCE>_CLIENT_ID`, `<SOURCE>_CLIENT_SECRET` | web, intel | One pair per OAuth source (Mailchimp, Pipedrive, Zoho, Dynamics, Attio, Airtable, Notion, Zoom, LinkedIn, Meta, Klaviyo, Constant Contact, Kit, Intercom, Outreach, Salesloft, monday) |
| `HOOK_SECRET` | web | Signs per-workspace webhook URLs |
| `AWS_SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | intel | Sending |
| `SES_SNS_TOPIC_ARN` | web | Checks SES events |
| `TRACK_SECRET` | collect | Click and unsubscribe tokens |
| `SECRETS_KEY` (exists) | web, intel | Seals every source credential |
| `ANTHROPIC_API_KEY` (exists) | intel | Mapping, titles, Decide, Write, reasons, plays, agents, migration |

---

## Part 7. Data model

### 7.1 Objects

| Object | Notes |
|---|---|
| Contact, company (week 1) | Standard fields plus custom fields |
| Deal | Read only, from the CRM or Omniscient |
| Campaign, campaign member | Two-way with Salesforce and HubSpot |
| Custom objects | Defined per workspace: name, key, fields, and links to contacts, companies or each other (one-to-one, one-to-many, many-to-many). Filled from warehouses, product tools or the API. |
| Events | `contact_events` by month (week 1), plus `account_events` for company-level events |

### 7.2 Custom objects in segments and workflows

- A segment rule can reach through a link: "has a Subscription where plan is Pro and seats ≥ 20".
- A workflow can trigger on a custom object row created or changed.
- Email tokens can read linked rows: "{{subscription.plan}}".
- Every link is one SQL join with bound parameters, keys from the registry (Part 10).

---

## Part 8. Email

As in `docs/marketing-platform.md` M3:

| Part | Detail |
|---|---|
| Editor | Blocks: text, image, button, columns, divider, spacer, social, signature, footer, custom HTML. Drag to reorder. Field tokens from a picker, including custom objects. Preview at desktop, tablet and phone widths, in light and dark mode. |
| Brand kit | Logo, colors and fonts read from the site, then edited |
| Personal blocks | Shown only when a rule passes ("Show if industry is Fintech") |
| Test send | To any teammate, with a chosen contact's data |
| Sending | Amazon SES from the customer's domain, SPF, DKIM and DMARC checks, one-click unsubscribe, footer address, frequency cap, quiet hours by time zone, send-time by time zone |
| Reports | Sent, delivered, human clicks, replies, unsubscribes, bounces, complaints, pipeline. Opens shown and marked unreliable. |
| Campaign link | Recipients join a CRM campaign as Sent, then Responded on click |
| A/B | Subject or body, split by percent, winner by clicks after a set time |

---

## Part 9. Forms and landing pages

| Part | Detail |
|---|---|
| Forms | Fields from the registry, hidden fields (UTMs, campaign), progressive fields (known contacts aren't asked twice), consent block with wording by region, Turnstile spam check. Embed with one line, or in a landing page. |
| On submit | Contact upsert, consent with exact wording, form event with page, referrer and UTMs, earlier anonymous visits attached (M1), workflow trigger, score update, optional instant booking with the routed rep |
| Landing pages | Sections and blocks (hero, logos, features, proof, pricing table, FAQ, form, booking), on the customer's domain by CNAME, served by `collect` with HTTPS |
| AI build | "A page for the Q4 webinar" → a draft from Brand Brain facts and the brand kit, each claim with its source |
| Funnel QA | Before publish and every day: the page loads, every link works, the form submits and the test contact appears (existing runner) |
| Reports | Views, submits, conversion rate, pipeline per page and form |

---

## Part 10. Segments and filters

- One `FilterBar` (week 1) for Contacts, Segments, Visitors and Accounts.
- Rule kinds: contact and company fields, custom objects, CRM fields, events ("clicked any email in 14 days", "visited /pricing 2 times", "attended a webinar"), scores, segment and campaign membership, consent, source.
- AND and OR groups, up to 3 levels.
- Every rule tree compiles to one SQL query with bound parameters; field keys come from the registry.
- Live count and a sample of 10 while editing (debounced 400 ms, 2 s timeout).
- Dynamic segments refresh per contact on change and fully every hour. Entering or leaving fires workflow triggers.

---

## Part 11. Workflows

### 11.1 Triggers

| Trigger | Example |
|---|---|
| Segment entered or left | "Fit 70+ and visited pricing" |
| Contact created from a source | "Came from the Zoom webinar" |
| Form submitted | "Demo request form" |
| CRM change | Lead status became "Working", opportunity lost, owner changed |
| Product event | Signup, invite sent, plan limit hit |
| Custom object | A Subscription row changes plan |
| Warehouse row | A row appears in "trials ending in 3 days" |
| Website | Visited a page group, account turned hot (M1), came from an AI answer |
| Email | Clicked, replied, bounced |
| Score | Crossed a band |
| Date | Field date ± N days |
| Manual, API, webhook | Add from a list, `POST /api/v1/workflows/:id/enroll`, a signed webhook |

### 11.2 Steps

| Step | What it does |
|---|---|
| Send email | A saved email, or one from AI Write |
| Wait | A time, until a weekday and hour, or until an event, with a timeout path |
| Branch | If and else, up to 5 paths |
| Split | Random A/B by percent |
| AI Decide | Haiku picks one of the named paths with a reason; it can't invent a path |
| AI Classify | Haiku sets a field from text (a form answer, a reply) into one of fixed values |
| AI Write | One email for this contact from the voice guide, approved facts and recent activity |
| Update field | Set a field, lifecycle, lead status or subscription; pushed to the CRM if mapped |
| CRM action | Create a task, add to a campaign, change owner, create a deal |
| Ads | Add to or remove from an ads audience |
| Slack | Message a channel or the owner with the contact card |
| Webhook | Signed POST; the response can feed a branch |
| Route | Run routing and hand off (Part 12) |
| Enroll | Into another workflow or a static segment |
| Goal | Exit when reached |

### 11.3 Canvas, simulate, versions, review modes

As in the 14-week plan: vertical canvas with live counts per node, validation before publish, "Test with 20 contacts" with no sends and no CRM writes, versions with running enrollments kept on theirs, and AI Write review modes (Review all, Review a sample after 20 approvals, Auto after 100) with checks on every written email (no tracking mentions, no facts outside the approved list, every token filled, length within limits).

---

## Part 12. Scoring, routing and ABM

### 12.1 Contact score

- **Inputs:** fit (account), intent (account), engagement (clicks, replies, page reads, forms, webinars, meetings, product events, 14-day half life), CRM fields, warehouse and custom object fields, title seniority and department (4.7).
- **v0:** fixed weights from the ICP rules; the top 3 reasons are the 3 biggest additions.
- **v1:** weekly logistic regression on won vs lost once a workspace has 30+ closed deals; goes live only if its AUC beats the current one on the last 20% of deals.
- **Bands:** Cold < 40, Warm 40–69, Ready 70+, editable. Score, band and reasons sync to the CRM.

### 12.2 Routing

Rules in order: existing owner, account owner, named account list, territory (country, region, size), segment, round robin weighted by rep capacity (open handoffs this week vs their cap), skipping people out of office. Then the handoff: owner and status in the CRM, a CRM task with the reasons, a Slack DM, nurture paused, SLA timer with one manager alert on breach.

### 12.3 ABM

| Part | Detail |
|---|---|
| Account lists | Static or by rules (fit, intent, stage, industry, named list from the CRM) |
| Buying group | Per account: people by role (decision maker, champion, user, finance) from title department and seniority, with gaps shown ("no finance contact") |
| Account view | One timeline across every contact, visit, email, ad and deal |
| Account journeys | Workflows that run on the account: trigger on account intent, steps per role |
| Account score | Fit and intent (M1) plus engagement summed over the buying group |

---

## Part 13. Ads

| Part | Detail |
|---|---|
| Audiences out | A segment or account list syncs to LinkedIn Matched Audiences, Google Customer Match and Meta Custom Audiences, hourly. Hashed emails only; contacts with "No basis" in strict regions are left out (lawyer check). |
| Lead forms in | LinkedIn, Meta and Google lead forms (Part 4) |
| Conversions out | Offline conversions (MQL, SQL, won) to LinkedIn, Google and Meta, so their bidding learns from pipeline |
| Spend in | Daily spend per campaign from each ad account, for attribution |

---

## Part 14. Attribution

As `docs/marketing-platform.md` M8, at Mosaic's level:

- Touches: visits by source (AI answers as their own channel), emails, forms, webinars, ads, meetings, sales touches from the CRM.
- Models: first touch, last touch, linear, time decay, W-shaped, and custom weights per touch type.
- Reports: pipeline and closed-won by channel, campaign, asset, page and workflow; cost per opportunity with ad spend.
- A weekly summary every Monday, each claim with its numbers.

---

## Part 15. Agents, plays, MCP and Skills

### 15.1 Where agents start

| Start | How |
|---|---|
| App | A panel on every screen |
| Slack | Mention `@Claritia` or DM; answers in the thread, approvals as buttons |
| Linear | Assign a ticket to Claritia; drafts linked on the ticket |
| Schedule | A saved prompt on a cron |
| Webhook | A signed POST with a prompt and data |
| Claude | Through the MCP server (15.4) |

### 15.2 Tools and their settings

Same rule as Conversion: each tool is Automatic, Requires approval or Disabled, per agent.

| Tool | Default |
|---|---|
| Search and read (contacts, accounts, segments, reports, workflows, sources) | Automatic |
| `create_segment`, `draft_email`, `draft_workflow`, `draft_page`, `draft_form` | Automatic (drafts only) |
| `import_contacts`, `connect_source_link`, `update_contact_fields`, `add_to_campaign` | Requires approval |
| `publish_*`, `send_broadcast`, `sync_audience` | Requires approval |
| Edits to existing assets | Requires approval, shown as a before-and-after diff |
| `delete_*` | Disabled, and can't be turned on |

Every run is logged with its tool calls, tokens and cost. Model: Sonnet 5.5 with prompt caching on the workspace context; Haiku 5.5 for short reads. 8 tool calls per run, 60 s per run, 30 runs per workspace per day at Beta.

### 15.3 Plays

- A play is a saved agent task that runs per account or per contact when a trigger fires: "When a target account turns hot, find the buying group gaps, draft a 3-email sequence for the champion and a LinkedIn note for the rep."
- Output lands in Approvals or the rep's Slack.
- Haiku by default, Sonnet for accounts with fit 80+, capped per workspace per day.

### 15.4 MCP server and Skills pack

- **MCP server:** read tools for contacts, accounts, segments, visitors, signals, reports and sources, and the draft tools above, with the same settings. Teams use Claritia from Claude, Claude Code or any MCP client. Read-only version first (week 3), drafts later.
- **Skills pack:** Brand voice, ICP and scoring rules, Campaign brief, Launch checklist, Event follow-up and Import cleanup, each reading and writing through the MCP server. Installed once for the team.
- **Campaigns as code:** segments, emails and workflows export to and import from YAML, so Claude Code can edit them in a repo and a pull request review is the approval.

### 15.5 Knowledge graph

The agents' context: the data model map (objects, fields, links, counts), Brand Brain facts with sources, the ICP, the segment and workflow lists, and recent performance. Built nightly, cached, and read through the step cache.

---

## Part 16. Database

Migrations 034 to 046, each with RLS, leak tests in `tests/db/leaks.sql`, and functions that check membership.

### 16.1 `034_imports.sql` (week 2)

```
import_files   (id, workspace_id, import_id, path, size, sheet, encoding, delimiter, rows, created_at)
import_rows    (import_id, n int, raw jsonb, mapped jsonb, outcome text, -- new, update, merge, skip, suppressed, error
                reason text, contact_id, primary key (import_id, n))       -- deleted 30 days after the import
source_links   (workspace_id, source_id, object, external_id, local_id, last_seen_at,
                primary key (source_id, object, external_id))
suppressions   (workspace_id, email_clean, reason text, -- unsubscribed, bounced, complained, cleaned, manual
                source text, at, primary key (workspace_id, email_clean))
field_order    (workspace_id, key, sources text[])                          -- which source wins per field
```

- `imports` (week 1) gains `source_id`, `kind` (file, source, api, migration), `cursor`, `progress`, `undo_until`, `undone_at`.
- `contacts`, `field_writes` and `consents` gain `import_id`.

### 16.2 `035_sources.sql` (week 3)

```
sources        (id, workspace_id, kind text, -- hubspot, salesforce, mailchimp, sheets, typeform, …
                name, sealed_credentials bytea, scopes text[], status, settings jsonb, -- objects, direction, schedule
                last_run_at, last_error, created_by, created_at)
source_runs    (id, source_id, object, started_at, finished_at, pulled int, written int, errors int, cursor_from, cursor_to)
sync_log       (id, workspace_id, source_id, direction, object, local_id, external_id, action, fields jsonb,
                error text, attempt int, at)                                -- 90 days kept
mappings       (source_id, object, column text, target text, value_map jsonb)
hooks          (id, workspace_id, source_id, secret_hash bytea, last_at)   -- per-workspace webhook URLs
campaigns      (id, workspace_id, name, external_id, source_id, status)
campaign_members (campaign_id, contact_id, status, external_id, at)
deals          (id, workspace_id, source_id, external_id, name, stage, amount, currency, close_date, won bool,
                company_id, owner, updated_at)
deal_contacts  (deal_id, contact_id, role)
```

The 14-week plan's `crm_connections` and `crm_links` become `sources` and `source_links`, so CRMs and every other tool share one model.

### 16.3 Later migrations

| Migration | Week | Tables |
|---|---|---|
| `036_objects.sql` | 8 | `objects`, `object_fields`, `object_rows`, `object_links`, `account_events`, `warehouse_queries` |
| `037_email.sql` | 9 | `sending_domains`, `templates`, `emails`, `email_messages`, `send_limits`, `brand_kits`, `email_stats` |
| `038_workflows.sql` | 11 | `workflows`, `workflow_nodes`, `workflow_edges`, `enrollments`, `node_runs`; `approvals` gains kinds |
| `039_pages.sql` | 15 | `forms`, `form_fields`, `submissions`, `pages`, `page_versions`, `page_domains` |
| `040_scoring.sql` | 16 | `score_models`, `routing_rules`, `rep_capacity`, `handoffs`, `sla_timers` |
| `041_abm.sql` | 17 | `account_lists`, `account_list_members`, `buying_roles` |
| `042_ads.sql` | 18 | `ad_accounts`, `audiences`, `audience_members`, `ad_spend`, `conversions_out` |
| `043_attribution.sql` | 18 | `touches`, `attribution_models`, `attributed` |
| `044_agents.sql` | 19 | `agent_tools`, `agent_runs`, `agent_steps`, `agent_schedules`, `plays`, `play_runs` |
| `045_migrations.sql` | 20 | `migrations`, `migration_items` (with the proof for each) |
| `046_api.sql` | 21 | `api_idempotency` |

### 16.4 Jobs

| Kind | Trigger | Retry |
|---|---|---|
| `import_file` | File uploaded | 5, resumes at the last page |
| `source_pull` | Schedule, webhook, or first connect | 5, backoff, resumes at the cursor |
| `import_apply` | Staged page ready | 5 |
| `import_undo` | Undo pressed | 3 |
| `crm_push` | Local change with a mapped field | 5, backoff |
| `warehouse_poll` | Its schedule | 3 |
| `segment_refresh` | Contact change, hourly full | 3 |
| `workflow_step` | `next_run_at` | 5 |
| `ai_map`, `ai_title`, `ai_decide`, `ai_classify`, `ai_write` | As needed | 2, then a safe default |
| `send`, `ses_event` | Broadcast, workflow, SNS | 5 |
| `page_publish`, `funnel_check` | Publish, daily | 3 |
| `score_contact`, `score_train` | Event (debounced 60 s), weekly | 3, 2 |
| `route`, `sla_check` | Ready, timer | 5 |
| `audience_sync`, `conversions_out`, `ad_spend` | Hourly, daily | 5 |
| `attribution` | Nightly | 3 |
| `play_run`, `agent_run` | Trigger, app, Slack, Linear, schedule, webhook | 1 |
| `migrate` | Migration step | 2 |
| `domain_check` | Every 10 min until verified, then daily | — |

---

## Part 17. Screens

| Group | Screens |
|---|---|
| Audience | Contacts, Segments, Accounts, Visitors |
| Engage | Workflows, Emails, Pages, Forms, Plays |
| Prove | Reports, Attribution |
| Bottom | Approvals, Settings |

| Screen | Holds |
|---|---|
| Contacts | Week 1 table and contact page, plus Import (4.9), source tags on each value, Undo on recent imports |
| Segments | List with count and trend; builder with live count and a sample of 10 |
| Accounts | Week 1 list with saved views; account page with buying group and one timeline |
| Workflows | List, canvas, simulate, versions, report per node |
| Emails | Broadcasts and workflow emails; editor, preview, test send, report |
| Pages, Forms | List, editor, Funnel QA state, report |
| Plays | List, trigger, output, runs |
| Reports, Attribution | Pipeline by channel, campaign, asset; model picker; weekly summary |
| Approvals | Emails, pages, workflows, imports, agent actions; Approve, Edit, Skip; diffs for edits |
| Settings › Sources | 4.9 |
| Settings › Imports, Sync log | 4.9 |
| Settings › Sending, Scoring, Agents, Ads, Migration | Domains and brand kit; bands, weights, routing, SLA; tools and schedules; ad accounts; migration inventory and cutover |

---

## Part 18. Tests

Reliability rule: the import pipeline, the sync, the send pipeline, the workflow engine and identity each get a test that proves them on a flaky case.

| Area | Test |
|---|---|
| Imports | A 2,000,000-row file imports with the worker killed 3 times mid-run: every row once, counts match, no doubles |
| Imports | Undo after a second import touched some of the same contacts: only the first import's untouched contacts go, overwritten values come back |
| Imports | Suppressions land before contacts: a send queued during the import never reaches a suppressed address |
| Imports | Each connector against recorded responses: pages, cursors, 429s with retry, a token refresh mid-run, a deleted record, a merged record |
| Imports | Every connector's consent map: a fixture of each tool's statuses gives the expected basis |
| Imports | Encodings: UTF-8 with BOM, UTF-16, Windows-1252, Excel dates, formulas, merged header cells |
| Imports | Field order: a file import never overwrites a CRM value; a CRM change always overwrites a file value |
| CRM sync | 1,000 random changes on both sides with dropped webhooks, duplicate deliveries and 429s: both sides match, no echo loops, one log row per change |
| CRM sync | A Salesforce lead converts to a contact: one Claritia contact, both links kept |
| Segments | 30 rule types match a hand-counted fixture; fuzz with SQL-like values; custom object joins |
| Email | SNS signature check, suppression at send time, one-click unsubscribe, cap and quiet hours, complaint storm pause, renders at 3 widths |
| Workflows | 10,000 enrollments with killed workers and retried jobs: none stuck or doubled |
| Forms, pages | A submit with the network cut mid-request lands once; Funnel QA catches a broken form |
| AI | Decide never returns a missing path; Write drops a made-up fact; mapping suggestions are cached; a passing step replays from cache |
| Scoring, routing | Fixed fixtures; one CRM task per handoff when retried; SLA fires once |
| Ads | Audience sync leaves out strict-region "No basis" contacts; a removed contact leaves the audience |
| Migration | A recorded Marketo instance: list counts within 1%, every token resolves, simulated paths match history |
| Agents | A disabled tool is never called; an approval tool never runs before approval |
| Leaks | Every new table in `tests/db/leaks.sql` |

---

## Part 19. Schedule (21 weeks)

| Week | Build | Done when |
|---|---|---|
| 1 | Contacts, CSV import, filter bar (built, Part 21) | Met |
| 2 | `034_imports.sql`, big files through storage, Excel, Google Sheets, paste, vCard, staging and preview, error file, Undo, suppressions table, field order, cleaning (phone, names, titles) | A 2,000,000-row file imports with killed workers; Undo works after an overlapping import |
| 3 | `035_sources.sql`, connector framework, HubSpot two-way, Sync log, Settings › Sources, read-only MCP server | A HubSpot test account syncs both ways with 0 doubles after the 1,000-change test |
| 4 | Salesforce two-way (CDC, polling, Composite, lead convert, campaigns), Omniscient one-click | A Salesforce Developer org passes the same test |
| 5 | Email tool imports: Mailchimp, ActiveCampaign, Klaviyo, Brevo, Kit, Constant Contact, MailerLite, SendGrid, Loops, Campaign Monitor (contacts, lists, suppressions, consent, 13 months of history) | Each passes its recorded test and consent map |
| 6 | Marketo, Pardot, Eloqua, HubSpot Marketing, Customer.io, Iterable, Braze, Intercom; other CRMs (Pipedrive, Zoho, Dynamics, Attio, Close, Copper, Freshsales, monday, Affinity); Airtable, Notion | Each passes its recorded test |
| 7 | Live sources: forms, scheduling, events (Zoom, Cvent, Luma, Eventbrite, Goldcast, Livestorm, ON24), ad lead forms, Zapier, Make, n8n, `POST /api/v1/contacts/import` | A Typeform fill and a Zoom registration reach a contact in under 10 s |
| 8 | `036_objects.sql`, custom objects, 7 warehouses, Segment, RudderStack, PostHog, Mixpanel, Amplitude, Stripe, Shopify, billing and support tools, data vendors, Outreach, Salesloft; segments with live count | 30 rule types pass; a warehouse row becomes an event on schedule |
| 9 | `037_email.sql`, domains, SES, send guard, SNS, suppression at send | A test domain verifies and an email sends with one-click unsubscribe |
| 10 | Block editor, brand kit, tokens, preview, test send, broadcasts, A/B, reports, campaign link | A broadcast to 500 contacts sends and clicks show in the CRM campaign |
| 11 | `038_workflows.sql`, engine, waits, branches, splits, exits, re-entry | 10,000-enrollment test passes |
| 12 | Canvas, side panel, validation, versions, live counts | A 12-node workflow is built and published |
| 13 | All steps and triggers | Each has a passing test |
| 14 | AI Decide, Classify and Write, review modes, Approvals, Simulate | Simulate on 20 contacts shows every path and email with no sends |
| 15 | `039_pages.sql`, forms, landing pages on custom domains, AI page build, Funnel QA | A page with a form publishes and Funnel QA passes |
| 16 | `040_scoring.sql`, score v0 and v1, reasons, CRM score sync, routing with capacity, SLA | A Ready lead reaches the right rep in Slack within 2 minutes p95 |
| 17 | `041_abm.sql`, account lists, buying groups, account journeys, account score | A target account list runs an account journey |
| 18 | `042_ads.sql`, `043_attribution.sql`, audiences, conversions out, spend, attribution models, weekly summary | An audience syncs to LinkedIn; a won deal shows credited touches |
| 19 | `044_agents.sql`, agents in app, Slack, Linear, schedules, webhooks; plays; MCP draft tools; Skills pack; knowledge graph | "Build a nurture for webinar signups" makes drafts; a play runs on a hot account |
| 20 | `045_migrations.sql`, migration agent for 8 platforms | A recorded Marketo instance migrates with every proof passing |
| 21 | `046_api.sql`, REST API, customer setup docs, quality page, 2 design partners live | Partners import from their old tools and run a live workflow. All Part 18 tests green. |

---

## Part 20. Monthly cost

### 20.1 Per team per month

Assumptions: 10,000 contacts, 50,000 emails (20,000 from AI Write), 20,000 Decide calls, 100 agent runs, 2,000 play runs, 3 sources, 2 landing pages, 1 migration per new team.

| Item | Use | Per team |
|---|---|---|
| Field mapping suggestions | Haiku, cached by header hash, a few files a month | under $0.10 |
| Title to seniority and department | Haiku for titles rules miss, cached; about 3,000 new titles | under $0.10 |
| Score reasons | Haiku, band changes only | $2 |
| AI Decide and Classify | Haiku, 20,000 calls, cached when inputs repeat | $10 |
| AI Write | Haiku by default, Sonnet for score 80+ | $20 |
| Agents | Sonnet with caching, about 100 runs | $10 |
| Plays | Haiku, about 2,000 runs, Sonnet for fit 80+ | $3 |
| AI page builds | Sonnet, a few drafts | $1 |
| **Claude subtotal** | | **About $46** |
| Migration agent | Sonnet, one time, $20 to $40 per migration | One time |
| Amazon SES | 50,000 emails at about $0.10 per 1,000 (check) | $5 |
| Source APIs | Customer's own plans; most are free to read | $0 |
| Ads APIs | Free to call (check LinkedIn Marketing API terms) | $0 |
| Warehouse queries | Run on the customer's warehouse | $0 |

Claude prices from `docs/marketing-platform.md` Part 11 (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million tokens).

### 20.2 Added to the monthly bill

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude ($46 per team) | $2,300 | $23,000 |
| Migration agent (new teams: 10 a month at Beta, 50 at Growth, $30 each) | $300 | $1,500 |
| Amazon SES | $250 (check) | $2,500 (check) |
| Dedicated sending IPs | $50, 2 IPs (check) | $250, 10 IPs (check) |
| Fly: `claritia-intel` to 2 GB, then 3 × 2 GB; `collect` serving pages | $25 (check) | $150 (check) |
| Supabase: compute, disk for contacts, events and staging, storage for uploads (files deleted after 30 days) | $75 (check) | $350 (check) |
| Cloudflare Turnstile for forms | $0 (free tier, check) | $0 (check) |
| Salesforce Developer org, HubSpot test account and vendor sandboxes for CI | $0 | $0 |
| **Added by this plan** | **About $3,000** | **About $27,750** |
| **Per team** | **About $60** | **About $56** |

At the proposed $299 Starter price, gross margin is about 80% at Beta and 81% at Growth, and higher on the $799 Growth plan (check against final pricing). The migration line falls once early customers are moved.

---

## Part 21. Week 1 status: built

| Piece | Where |
|---|---|
| Tables, consent, fields, events by month, imports, saved views, and the database functions | `supabase/migrations/033_contacts.sql` |
| Filters with one meaning in the browser and the database | `src/lib/filters.ts`, `contacts_where` |
| CSV read and write, column guesses, consent by region, import, add and edit | `src/lib/contacts/` |
| Server routes (emails are cleaned here, so writes stay server only) | `src/app/api/contacts/route.ts`, `src/app/api/contacts/import/route.ts` |
| Filter bar with saved views, on Contacts, Visitors and Accounts. The old Accounts tabs are built-in views. | `src/components/app/FilterBar.tsx` |
| Contacts screen, import wizard, add and edit, contact page | `src/components/app/views/ContactsView.tsx` |
| Tests | `tests/contacts.test.ts`, `tests/pg/contacts.pg.ts`, contacts block in `tests/db/leaks.sql` |

- **Done when, met:** a 10,000-row CSV imports with dedupe in about 4 seconds on a local database, and a second run creates nothing. Filters work on Contacts, Visitors and Accounts.
- **Flaky cases tested:** a batch whose answer is lost is sent again with no doubles; two imports of the same people at once make no doubles; a contact follows its person through stitching, merges in either order, a rebuild and erasure; 36 filter cases give the same rows in the database and the browser.
- **Running cost of week 1:** $0 at Beta, about $1 at Growth (Supabase disk, check). No new service, no Claude calls.

## Part 21b. Records and week 2 status: built

Records (custom objects and rich fields from week 8, pulled forward so imports and sources write into them) and week 2 (imports at full size).

| Piece | Where |
|---|---|
| Which source wins per field, field history, rich field types, custom objects, links between records, saved views with columns, sort, board and group | `supabase/migrations/034_records.sql`, `src/lib/records/` |
| Contacts, Leads board, Companies, custom objects, record pages, Settings › Fields and Objects | `src/components/app/records/`, `src/components/app/views/ContactsView.tsx`, `RecordsViews.tsx`, `FieldsSettings.tsx` |
| Imports bucket, background imports that pick up where they stopped, suppressions first, undo for 30 days, error files | `supabase/migrations/035_imports.sql` |
| CSV of any size and encoding, Excel (with sheet choice, dates and formulas), vCard, paste; phone, name and title cleaning | `src/lib/contacts/csv.ts`, `files.ts`, `vcard.ts`, `clean.ts` |
| One import run for the web app and the job; the `import_file` and `import_undo` jobs and file cleanup in `claritia-intel` | `src/lib/contacts/importRun.ts`, `importJob.ts`, `worker-intel/jobs/imports.ts` |
| Import wizard (upload, map, list type, preview with outcomes, progress, report, errors, undo) and Settings › Imports | `src/components/app/records/ImportPanel.tsx`, `src/components/app/views/ImportsSettings.tsx` |
| Tests | `tests/imports.test.ts`, `tests/pg/records.pg.ts`, `tests/pg/imports.pg.ts`, records and imports blocks in `tests/db/leaks.sql` |

- **Flaky cases tested:** a 60,000-row file (set `IMPORT_TEST_ROWS=2000000` for the full run) stopped twice mid-import lands every row once with matching counts; undo after an overlapping second import and a person's edit takes back only what the first import did; a file never overwrites a CRM value; an unsubscribed address never gets consent back from a later row.
- **Left for later weeks:** Google Sheets picker (needs the Google OAuth app), old `.xls` files, Haiku for titles the rules miss, the import's file name on each value's source tag.
- **Needs set on `claritia-intel`:** `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (it reads uploaded files from storage).
- **Running cost:** Supabase storage for uploads, deleted after 30 days: under $1 at Beta, about $5 at Growth (check). `claritia-intel` to 1 GB for big Excel files: about $3 at Beta and Growth (check). No Claude calls. **Total: about $4 at Beta, about $8 at Growth.**

## Part 21c. Sources status (weeks 3 to 7): framework and 20 tools built

| Piece | Where |
|---|---|
| Sources, sealed credentials, links by the tool's id with the values both sides last agreed, runs, sync log (90 days), mappings, staged webhooks, lists as static segments, the minute tick that runs due pulls and pushes | `supabase/migrations/036_sources.sql` |
| Connector contract, calls with retries and token refresh, sign-in with signed state and PKCE, mapping, the pipeline (in, out, hooks) and the runner | `src/lib/sources/` (`types.ts`, `ctx.ts`, `oauth.ts`, `map.ts`, `sync.ts`, `run.ts`) |
| Two-way: HubSpot (search window, app webhooks with v3 signatures, batch writes), Salesforce (queryAll on SystemModstamp with deletes, Composite writes, new contacts as Leads), Omniscient (one-click from its approve page, signed webhooks) | `hubspot.ts`, `salesforce.ts`, `omniscient.ts` |
| In: Pipedrive, Attio, Close; Mailchimp, Klaviyo, ActiveCampaign, Brevo, Kit, MailerLite; Stripe, Intercom | `crms.ts`, `email.ts`, `product.ts` |
| Webhooks: Typeform, Tally, Webflow, Calendly, Cal.com (signatures checked) and any tool that posts JSON | `forms.ts`, `src/app/api/hooks/` |
| Connect, sign-in callback, webhook URL, mapping routes | `src/app/api/sources/` |
| `source_pull`, `crm_push`, `source_hook` jobs | `worker-intel/jobs/sources.ts` |
| Settings › Tools (catalog with logos, connect by sign-in or key, source page with sync settings, field mapping and runs) and Settings › Sync log (filters, retry) | `src/components/app/views/SourcesSettings.tsx` |
| Tests | `tests/sources.test.ts` (every connector against recorded answers), `tests/pg/sources.pg.ts`, sources block in `tests/db/leaks.sql` |

- **Flaky cases tested:** HubSpot two-way through 1,000 random changes on both sides (edits, creates, deletes, merges, email changes) with 20% of webhooks dropped, 10% sent twice, 5% of calls answered 429 and the token expiring twice: both sides end equal, nothing doubled, and a further round writes nothing and logs nothing (passes on 5 seeds). A form webhook sent twice makes one contact; a paused source holds its hooks. Found and fixed on the way: a value that lost to a person's edit was never pushed back; the push cursor re-read the same 200 contacts inside its 30-second window; an update to a record deleted on the other side failed forever; a tool that ignores a field we write, or a record type without a column, caused a write every round.
- **Needs set:** on Render and `claritia-intel`, `SECRETS_KEY` (credentials are sealed with it) and, for one-click sign-in, `HUBSPOT_`, `SALESFORCE_`, `PIPEDRIVE_`, `ATTIO_`, `MAILCHIMP_` `CLIENT_ID` and `CLIENT_SECRET`; `OMNISCIENT_URL` if it isn't `https://app.tryomniscient.com`. HubSpot's app sends webhooks to `/api/hooks/hubspot`. Without a sign-in app, HubSpot, Pipedrive, Attio and Mailchimp take a pasted key.
- **Left for later weeks:** Salesforce Change Data Capture (until then it pulls every few minutes) and its 1,000-change test against a Salesforce fake; deals, campaigns and company writes; Marketo, Pardot, Eloqua and the other CRMs and email tools in 4.4; the other form, event and ad lead tools; the import API and Zapier, Make and n8n apps; read-only MCP tools. Each tool's endpoints are rechecked on a real account before launch (check).
- **Running cost:** no new paid service and no Claude calls; the tools' APIs are free on the customer's plan. Pulls every 15 minutes for CRMs and hourly for the rest add work on `claritia-intel`: within the 1 GB machine at Beta, a second 1 GB machine at Growth, about $6 (check). Sync log and links on Supabase disk: under $1 at Beta, about $5 at Growth (check). **Total: about $1 at Beta, about $11 at Growth.**

## Part 21d. Week 8 status: segments and warehouses built

| Piece | Where |
|---|---|
| Rule trees (AND and OR, 3 levels) over contact and company fields, custom fields, lists, activity, website visits, email consent, sources and custom objects, compiled to one SQL condition with every value bound; live count and 10 contacts; hourly refresh; joining and leaving as contact events | `supabase/migrations/037_segments.sql` |
| Segments screen and builder | `src/components/app/views/SegmentsView.tsx` |
| `segment_refresh` job | `worker-intel/jobs/segments.ts` |
| Warehouse sources: PostgreSQL, Redshift, MySQL, ClickHouse, BigQuery, Snowflake (key pair), Databricks behind one runner; one SELECT only, `:cursor` bound by the driver, read-only transactions where the database has them, 120-second limit, 5,000 rows a page, private hosts refused | `src/lib/sources/warehouse.ts`, `src/lib/sources/sql.ts` |
| Rows become contacts, companies, activity on contacts (a replay adds nothing) or custom object records linked to their contact | `supabase/migrations/038_warehouses.sql`, `src/lib/sources/sync.ts` |
| Query editor with Test on the source page; the read-only grant on the connect screen | `src/components/app/views/SourcesSettings.tsx`, `src/app/api/sources/test-query/route.ts` |
| Tests | `tests/pg/segments.pg.ts`, warehouse cases in `tests/sources.test.ts` and `tests/pg/sources.pg.ts`, segments block in `tests/db/leaks.sql` |

- **Flaky and hostile cases tested:** 35 rule cases against a hand-counted fixture; values like `'; drop table contacts; --`, `%`, `_` and `$2` match nothing and change nothing; 4-level groups, unknown fields, events, objects and other workspaces' sources are refused; a refresh logs who joined and who left, and a second refresh changes nothing. A warehouse query reads on from its cursor and logs only changed rows; activity read twice lands once; two statements, a write hidden in a WITH, and a write through a function are all stopped (the last by the read-only transaction).
- **Left for later weeks:** per-contact segment refresh on change (hourly and on save for now); Segment, PostHog, Mixpanel, Amplitude, Shopify and the other product connectors; the Data model screen; a Snowflake and BigQuery account test (both are tested against recorded answers until then, check).
- **Running cost:** no new paid service and no Claude calls; warehouse queries run on the customer's warehouse. Hourly segment refresh and warehouse pulls: Supabase compute within the current plan at Beta, one size up at Growth, about $25 (check); `claritia-intel` within the machines from Part 21c. **Total: $0 at Beta, about $25 at Growth.**

---

## Part 22. Rollout

| Step | When | Gate |
|---|---|---|
| Our own contacts from every tool Perceptric uses | Week 6 | Import tests green, Undo works |
| Our own HubSpot and the Perceptric Salesforce sandbox | Week 4 | Sync tests green |
| Our own newsletter from tryclaritia.com | Week 10 | Domain verified, complaint rate tracked |
| 2 design partners, each moving off an old tool | Week 21 | All tests green, setup docs ready |
| 5 design partners | Week 22 | 1 week with 0 sync loops, 0 doubled contacts, 0 sends to suppressed addresses, complaint rate < 0.1% |

- **Feature flags:** `workspaces.features` gets `imports`, `crm`, `email`, `workflows`, `pages`, `ads`, `agents`, `migration`, so each part turns on alone.
- **Kill switches:** pause a source, pause all imports for a workspace, pause sending per workspace and globally, pause a workflow, pause audience sync.

## Part 23. Open checks before week 2

| Check | Owner |
|---|---|
| HubSpot public app (client id, secret, scopes) | Founder |
| Salesforce connected app and a Developer org | Founder |
| Google Cloud OAuth app for Sheets, with verification for the sheets scope | Founder |
| Amazon SES production access in ap-northeast-1 (request now; takes days) | Founder |
| OAuth apps for the week 5 and 6 sources (Mailchimp, Klaviyo, Pipedrive, Zoho, Dynamics, Attio, Constant Contact, Kit, Intercom) | Founder, one per week ahead of its build |
| LinkedIn Marketing API access and Meta app review for lead forms and audiences | Founder, start by week 10 |
| Lawyer: data vendor contacts with "No basis", ads audiences from strict regions, consent proof from imported tools | Founder |
| Excel library license | Build |

## Part 24. Definition of done

- Every item in Part 2 works for a design partner on their live tools.
- A design partner moves off their old tool with the migration agent, every proof passing.
- All Part 18 tests pass in CI.
- For 7 days on live data: 0 sync loops, 0 doubled contacts, 0 sends to suppressed addresses, complaint rate < 0.1%.
- Costs in `ai_calls` and vendor usage match Part 20 within 20%.
