# Contact sources: one spec per source

The detail behind `docs/conversion-parity.md` Part 4. Each source is a connector in `src/lib/sources/<kind>.ts` that plugs into one pipeline. This file says, for each source, how it signs in, what it pulls, how it finds changes, how it maps consent and suppression, and what it needs from the founder before it's built.

**Check before building.** Endpoints, scopes, page sizes, rate limits and field names below are from memory. Each one is to be confirmed on the vendor's current docs when its connector is built, and the connector's recorded-response test is made from a real account at that time.

---

## Part 1. The connector contract

```ts
// src/lib/sources/types.ts
type SourceKind = "hubspot" | "salesforce" | "mailchimp" | "sheets" | "typeform" | …;

type Connector = {
  kind: SourceKind;
  label: string;
  group: "file" | "crm" | "email" | "form" | "event" | "product" | "warehouse" | "vendor" | "api";
  auth: { type: "oauth"; authorizeUrl: string; tokenUrl: string; scopes: string[] }
      | { type: "api_key"; fields: { key: string; label: string; secret: boolean }[] }
      | { type: "webhook" } | { type: "upload" } | { type: "warehouse" };
  modes: ("one_time" | "scheduled" | "live" | "two_way")[];
  objects(ctx): Promise<SourceObject[]>;                 // contacts, lists, suppressions, events, deals …
  fields(ctx, object): Promise<SourceField[]>;          // name, label, type, sample
  pull(ctx, object, cursor | null): Promise<{ records: RawRecord[]; next: string | null; done: boolean }>;
  suppressions?(ctx, cursor | null): Promise<{ rows: Suppression[]; next: string | null }>;
  consent(record: RawRecord): ConsentIn | null;         // basis, status, at, wording, proof
  hook?(req: Request, secret): Promise<RawRecord[]>;    // checks the signature, returns records
  push?(ctx, changes): Promise<PushResult[]>;           // two-way sources only
  defaults: { mapping: Record<string, Target>; valueMaps: Record<string, Record<string, string>> };
};
```

- `ctx` holds the unsealed credentials, a fetch with retry (429 and 5xx with `Retry-After`, then backoff 1, 5, 30 s), a rate limiter per source and workspace, and a lease check that stops the pull when the job loses its lease.
- `pull` returns one page. The job writes the page to `import_rows`, saves `next` as the cursor, and enqueues the next page. A page is never held in memory with the next one.
- `RawRecord` is `{ id, updatedAt, deleted?, data }`. The id is the source's own record id, which goes into `source_links`.
- Token refresh happens in `ctx.fetch` on a 401, once, then the source goes to Error with "Reconnect" on its card.
- Every connector has a recorded-response test in `tests/sources/<kind>.test.ts`: two pages, a 429, a refresh, a deleted record, a merged record, and its consent map.

## Part 2. Shared rules

| Rule | Detail |
|---|---|
| Changes since | Each connector keeps a cursor per object: an updated-after timestamp minus 5 minutes of overlap, or the source's own sync token. Overlap repeats are safe (the upsert ignores unchanged rows by hash). |
| First pull | Newest first is never used. Pulls go oldest to newest so a stop mid-way leaves a clean cursor. |
| Deletes | A source that reports deletes (HubSpot, Salesforce, Pipedrive, Dynamics, Attio) soft-deletes the link; the contact stays unless no other source holds it and the workspace has "Delete when the source deletes" on (off by default). |
| Webhooks | One URL per source per workspace: `/api/hooks/<kind>/<hook id>`. The secret is checked with the vendor's signature scheme when there is one, else a token in the URL. A hook only stages records; the job applies them. |
| Rate share | A source uses at most 50% of its documented limit for pulls, leaving room for the customer's other tools. Salesforce: at most 20% of the org's daily API total, pausing at 80% of the total. |
| Credentials | Sealed with `SECRETS_KEY` in `sources.sealed_credentials`. Never sent to the browser. API keys show their last 4 characters. |
| Network | Warehouse and self-hosted hosts pass the private network guard (`src/lib/privateNet.ts`) before any connection. |
| Scopes | Read-only scopes unless the source is two-way |

---

## Part 3. Files

| Source | How it reads | Notes |
|---|---|---|
| CSV, TSV, TXT | Streamed from storage in 1 MB chunks through the week 1 parser, made streaming | Encoding found by BOM, then by a UTF-8 check on the first 64 KB, then Windows-1252. Delimiter sniffed (week 1). |
| Excel .xlsx | `exceljs` streaming reader (MIT), one sheet picked in the wizard | Dates read as dates, formulas as their cached value, merged header cells filled across |
| Excel .xls | SheetJS Community Edition (Apache 2.0, check) on files up to 50 MB | Older format has no streaming read, hence the cap |
| Google Sheets | Google Picker with scope `drive.file`, then Sheets API `spreadsheets.values.get` per 10,000-row range | `drive.file` covers only files the user picks, which avoids the restricted-scope review (check). Changes found by Drive `modifiedTime`; changed rows by row hash. |
| Airtable | OAuth, scopes `data.records:read`, `schema.bases:read`; `GET /v0/{base}/{table}` with `pageSize=100`, `filterByFormula=LAST_MODIFIED_TIME()>'…'` | 5 requests per second per base (check) |
| Notion | OAuth (public integration), `POST /v1/databases/{id}/query` with a `last_edited_time` filter | Property types map to field types |
| vCard (.vcf) | Our parser for vCard 3.0 and 4.0 | FN, N, EMAIL, TEL, ORG, TITLE, ADR country |
| Paste | Parsed in the browser by the CSV parser; under 50,000 rows goes the week 1 way | — |

## Part 4. CRMs

### HubSpot (two-way)

| Item | Spec |
|---|---|
| Auth | OAuth public app. Scopes: `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read`, `crm.lists.read`, `crm.schemas.contacts.read`, `communication_preferences.read`, `oauth` (check names) |
| Backfill | `GET /crm/v3/objects/contacts?limit=100&properties=…&after=…`, same for companies and deals; associations v4 for contact ↔ company and deal |
| Changes in | Webhooks: contact and company creation, property change, deletion, merge, association change. Backup: `POST /crm/v3/objects/contacts/search` on `lastmodifieddate > cursor` every 2 minutes (search returns at most 10,000 results per query, so the window narrows when full) |
| Writes out | `POST /crm/v3/objects/contacts/batch/upsert` by email, 100 per call; custom properties `claritia_score`, `claritia_band`, `claritia_reasons`, `claritia_source` made on connect |
| Lists | `GET /crm/v3/lists/search` then memberships; static lists → static segments, active lists → the migration agent |
| Consent | `hs_email_optout` true → suppression `unsubscribed`; `hs_legal_basis` values ("Legitimate interest – prospect/lead", "Freely given consent from contact", …) → our basis; subscription types from `/communication-preferences/v4/statuses/batch/read` (check) → topics |
| Bounces | `hs_email_hard_bounce_reason_enum` set → suppression `bounced` |
| Value map | `lifecyclestage`: subscriber, lead, marketingqualifiedlead → mql, salesqualifiedlead → sql, opportunity, customer, evangelist, other |
| Limits | 110 requests per 10 s per app per account; search 5 per second (check) |
| Founder | Public app in a HubSpot developer account, redirect URL, a test account |

### Salesforce (two-way)

| Item | Spec |
|---|---|
| Auth | OAuth 2.0 web server flow with PKCE, scopes `api refresh_token` |
| Backfill | Bulk API 2.0 query jobs: `SELECT … FROM Lead WHERE IsConverted = false AND SystemModstamp > :cursor ORDER BY SystemModstamp`, then Contact, Account, Opportunity, Campaign, CampaignMember. Results read as CSV pages. |
| Changes in | Change Data Capture through the Pub/Sub API (gRPC) on Lead, Contact, Account, Opportunity, CampaignMember. Without CDC: REST query on `SystemModstamp` every 2 minutes. |
| Writes out | Composite sObject collections, 200 per call, as our integration user; custom fields installed from setup steps |
| Converted leads | `ConvertedContactId` links the lead's contact to the new Contact; both links kept |
| Consent | `HasOptedOutOfEmail` → suppression `unsubscribed`; `Individual` and `ContactPointTypeConsent` read when the org uses them (check) |
| Bounces | `EmailBouncedReason`, `EmailBouncedDate` → suppression `bounced` |
| Limits | Org daily API total from `/services/data/vXX.X/limits`; Bulk API job limits (check) |
| Founder | Connected app, a Developer Edition org for tests |

### Omniscient (two-way)

One-click app key from Omniscient (its migration 032). Contacts, accounts, deals and activities through `GET/POST /api/v1/…`, changes by its webhooks. Claritia writes marketing activities to the Omniscient timeline.

### Other CRMs (scheduled, live where they have webhooks)

| CRM | Auth | Pull | Changes | Consent and suppression | Founder |
|---|---|---|---|---|---|
| Pipedrive | OAuth (Marketplace app) | `GET /v1/persons`, `/v1/organizations`, `/v1/deals`, `limit=500` | Webhooks v2 on person and organization; `GET /v1/recents?since_timestamp=` as backup | `marketing_status`: subscribed → opt-in, unsubscribed → suppression, no_consent → No basis | Marketplace app |
| Zoho CRM | OAuth (server-based client), data center per account | `GET /crm/v6/Leads`, `/Contacts`, `/Accounts`, `/Deals` with `If-Modified-Since`; Bulk Read API for backfill | Notifications API (watch), backup poll | `Email_Opt_Out` → suppression | Zoho API client |
| Microsoft Dynamics 365 | OAuth (Entra ID app), tenant URL | OData `GET /api/data/v9.2/contacts?$filter=modifiedon gt …`, leads, accounts, opportunities | Change tracking with `Prefer: odata.track-changes` | `donotbulkemail`, `donotemail` → suppression | Entra app registration |
| Attio | OAuth | `POST /v2/objects/people/records/query`, companies, lists, custom objects | Webhooks on record created, updated, deleted | Attribute mapped by the user | Attio app |
| Close | API key | `GET /api/v1/lead/?date_updated__gt=` with contacts inside each lead | Webhooks (event subscriptions) | Unsubscribed via `/api/v1/unsubscribed_email` (check) | — |
| Copper | API key and user email | `POST /developer_api/v1/people/search` with `minimum_modified_date` | Poll | — | — |
| Freshsales | API key, domain | Contact and account views with `updated_at` sort | Poll | `do_not_disturb`, `unsubscribed` (check) | — |
| monday CRM | OAuth | GraphQL `boards { items_page }` on the Contacts and Accounts boards | Webhooks on item change | Column mapped by the user | monday app |
| Affinity | API key | `GET /v2/persons`, `/v2/companies`, lists | Poll | — | — |

## Part 5. Marketing automation and email tools

Each one: contacts, lists, custom fields, suppressions first, consent, and 13 months of email activity. The four migration sources also feed the migration agent (`docs/conversion-parity.md` Part 5).

### Marketo

| Item | Spec |
|---|---|
| Auth | REST API client id and secret, Munchkin id; `GET /identity/oauth/token` |
| Leads | Bulk extract `POST /bulk/v1/leads/export/create.json` with an `updatedAt` filter in windows of up to 31 days (check), then `enqueue`, poll `status`, read `file` |
| Activity | Bulk extract `POST /bulk/v1/activities/export/create.json` for email send, open, click, form fill, web visit (13 months, in 31-day windows) |
| Lists | Static lists `GET /rest/v1/lists.json` and members; smart lists `GET /rest/asset/v1/smartLists.json` with rules (check `includeRules`) for the migration agent |
| Assets | Programs, smart campaigns, emails (with content), forms, templates, tokens (asset API) for the migration agent |
| Consent and suppression | `unsubscribed` → suppression `unsubscribed`; `emailInvalid` → `bounced`; `marketingSuspended` → No basis; custom GDPR fields mapped by the user |
| Limits | 100 calls per 20 s, 50,000 calls per day, bulk extract 500 MB per day (all check) |

### Salesforce Account Engagement (Pardot)

| Item | Spec |
|---|---|
| Auth | Salesforce OAuth plus the `Pardot-Business-Unit-Id` header |
| Prospects | API v5 export `POST /api/v5/objects/exports` (procedure `filter_by_updated_at`, check), read result files; or `GET /api/v5/objects/prospects` with `updatedAtAfter` |
| Lists | Lists and list memberships; dynamic list rules are not in the API (check), so the agent rebuilds them from their names and members |
| Activity | Visitor activities (email send, open, click, form, page view) |
| Assets | Engagement Studio programs, emails, forms (read where v5 exposes them, check) |
| Consent and suppression | `optedOut` → `unsubscribed`; `isDoNotEmail` → `unsubscribed`; `isEmailHardBounced` → `bounced` |

### Oracle Eloqua

| Item | Spec |
|---|---|
| Auth | OAuth; base URL from `GET /id` |
| Contacts | Bulk API 2.0 contact export with a filter on `C_DateModified` |
| Activity | Bulk activity exports (EmailSend, EmailOpen, EmailClickthrough, FormSubmit, PageView) |
| Lists | Shared lists, segments (definitions read for the agent) |
| Assets | Campaigns, emails, forms (REST 2.0 assets) |
| Consent and suppression | Global subscribe status and email group subscriptions; bounceback list → `bounced` (check names) |

### Email tools

| Tool | Auth | Contacts | Changes | Consent → basis | Suppressions | Lists | History |
|---|---|---|---|---|---|---|---|
| Mailchimp | OAuth | `GET /3.0/lists/{id}/members?count=1000` | `since_last_changed`; webhooks per audience (subscribe, unsubscribe, profile, cleaned, upemail) | `subscribed` → opt-in with `timestamp_opt` and `ip_opt` as proof; `marketing_permissions` kept as wording | `unsubscribed` → unsubscribed, `cleaned` → bounced | Tags and static segments | Member activity feed |
| ActiveCampaign | API key, account URL | `GET /api/3/contacts?limit=100` | `filters[updated_after]`; webhooks | Active list status → the list's basis (asked per list) | List status 2 → unsubscribed; bounces | Lists, tags | Campaign reports (check) |
| Klaviyo | OAuth or private key, `revision` header | `GET /api/profiles` with `page[size]=100` | `filter=greater-than(updated,…)` | `subscriptions.email.marketing.consent` SUBSCRIBED → opt-in with `consent_timestamp` and `method`; NEVER_SUBSCRIBED → No basis | `suppression` HARD_BOUNCE → bounced, SPAM_COMPLAINT → complained, USER_SUPPRESSED → unsubscribed | Lists, segments | `GET /api/events` |
| Brevo | API key | `GET /v3/contacts?limit=1000` | `modifiedSince`; webhooks | Per list, asked | `emailBlacklisted` → unsubscribed; blocked contacts | Lists | Campaign reports |
| Customer.io | App API key | Customer exports (check) | Reporting webhooks | `cio_subscription_preferences` (check) | `unsubscribed` attribute | Segments | Delivery exports |
| Iterable | API key | `GET /api/export/data.csv?dataTypeName=user` | Export by date range | Channel and message type subscriptions | `unsubscribedChannelIds`; bounce export | Lists | Event exports |
| Braze | REST key, cluster URL | `POST /users/export/segment` to a callback or bucket (check) | Segment export by date | `email_subscribe` opted_in → opt-in | `unsubscribed` → unsubscribed | Segments | Currents (if the customer has it) |
| Constant Contact | OAuth (v3) | `GET /v3/contacts?limit=500` | `updated_after` | `permission_to_send` explicit → opt-in, implicit → legitimate interest outside strict regions | unsubscribed, pending_confirmation → No basis | Lists | Campaign activity |
| Kit (ConvertKit) | OAuth (v4) | `GET /v4/subscribers` | `updated_after` with cursor | Active → opt-in (forms are opt-in) | cancelled → unsubscribed, bounced, complained | Tags, forms | — |
| MailerLite | API token | `GET /api/subscribers` with cursor | `filter[status]` and dates | `opted_in_at`, `optin_ip` as proof | unsubscribed, bounced, junk → complained | Groups | Campaign reports |
| Campaign Monitor | API key | Active, unsubscribed, bounced and deleted subscribers per list | `date` since | `ConsentToTrack` kept as wording | unsubscribed, bounced | Lists, segments | Campaign reports |
| SendGrid Marketing | API key | `POST /v3/marketing/contacts/exports`, read the result URLs | Export again | Asked per list | `/v3/suppression/unsubscribes`, `/bounces`, `/spam_reports`, `/invalid_emails`, group suppressions | Lists | — |
| Loops | API key | CSV export from Loops when the API has no list endpoint (check) | — | `subscribed` → opt-in | `unsubscribed` | Mailing lists | — |
| Intercom | OAuth | `POST /contacts/search` on `updated_at` | Webhooks (contact created, updated, unsubscribed) | Asked | `unsubscribed_from_emails` | Tags, segments | — |

"Asked" means the tool stores no basis we can read, so the wizard asks the basis for each list, as week 1 does for a file.

## Part 6. Forms, scheduling and events

All live in by webhook unless noted. Each record becomes a contact upsert plus an event.

| Source | Setup | Event and fields |
|---|---|---|
| Typeform | OAuth, we create the webhook on the chosen forms (`form_response`); Responses API with `since` for history | `form.submitted` with answers; email from the email question |
| Tally | Webhook URL pasted in Tally, signing secret | `form.submitted` |
| Jotform | API key, we add the webhook | `form.submitted` |
| Google Forms | Through the linked Sheet (Part 3) | `form.submitted` |
| Fillout, Formstack | Webhook | `form.submitted` |
| Webflow | OAuth (Data API v2), `form_submission` webhook per site | `form.submitted` with page |
| Framer | Webhook URL in the form's settings | `form.submitted` |
| WordPress | Our plugin `claritia-wp`: hooks for Gravity Forms (`gform_after_submission`), Contact Form 7 (`wpcf7_mail_sent`), WPForms (`wpforms_process_complete`); posts to our hook with the site key | `form.submitted` with form name |
| Wix | Webhook from Wix Automations | `form.submitted` |
| Calendly | OAuth, organization webhook `invitee.created`, `invitee.canceled` | `meeting.booked`, `meeting.canceled`, with host as owner hint |
| Chili Piper, Cal.com, SavvyCal | Webhook (`BOOKING_CREATED` on Cal.com) | `meeting.booked` |
| Zoom | OAuth (Marketplace app), events `webinar.registration_created`, `webinar.participant_joined`; after the webinar, `GET /report/webinars/{id}/participants` for minutes | `event.registered`, `event.attended` with minutes, `event.no_show` |
| Cvent | REST API with partner credentials (check), hourly | Registrations and check-ins into a campaign |
| Luma | API key, `GET /public/v1/event/get-guests` hourly and webhooks (check) | Registered, attended |
| Eventbrite | OAuth, webhooks `order.placed`, `attendee.updated`, `attendee.checked_in` | Registered, attended |
| Goldcast, Livestorm, ON24 | Webhooks or API key (check each) | Registered, attended, minutes |
| LinkedIn Lead Gen Forms | OAuth with lead sync access (check the Marketing API program); lead notifications and `GET /rest/leadFormResponses` | `ad.lead` with campaign and form; consent from the form's custom checkbox |
| Meta Lead Ads | OAuth (`leads_retrieval`, `pages_manage_metadata`), page `leadgen` webhook, then `GET /{leadgen_id}` | `ad.lead`; app review needed (check) |
| Google Ads lead forms | Webhook URL and key in the lead form | `ad.lead` with campaign id |
| Zapier, Make, n8n | Our REST API with an API key; a listed app on each | Whatever the zap sends, through `POST /api/v1/contacts` or `/events` |

Form consent: a source's checkbox answer maps to opt-in only when the form showed consent wording; the wording is pasted once per form in the wizard and stored with each consent row.

## Part 7. Product, billing and support

| Source | Setup | What comes in |
|---|---|---|
| Segment | Claritia as a destination (partner destination, check), or a webhook destination with our key | `identify` → fields, `track` → events, `group` → company |
| RudderStack | Webhook destination | Same |
| PostHog | Webhook destination for events; batch export for history (check) | Events, person properties, cohorts as static segments |
| Mixpanel | Cohort sync to webhook; `/export` for history | Cohorts, events |
| Amplitude | Cohort sync to webhook | Cohorts |
| Stripe | Restricted key (read), webhooks `customer.*`, `customer.subscription.*`, `invoice.paid` | Customer, plan, MRR, trial end, canceled at |
| Shopify | OAuth app, webhooks `customers/create`, `customers/update`, `orders/create` | Customer, orders count and value, `email_marketing_consent` → basis with `consent_updated_at` |
| Chargebee, Paddle, Recurly | Webhooks | Subscription, plan, MRR |
| Zendesk | OAuth, incremental users export `/api/v2/incremental/users/cursor` and tickets | Ticket counts, CSAT, last contact |
| Front | OAuth | Last conversation |

## Part 8. Warehouses and databases

| Source | Driver | Auth |
|---|---|---|
| Snowflake | `snowflake-sdk` | Key pair on a user with a read-only role |
| BigQuery | `@google-cloud/bigquery` | Service account with Data Viewer on one dataset and Job User |
| Databricks | `@databricks/sql` | Personal access token or OAuth M2M, a SQL warehouse id |
| Amazon Redshift | `pg` | Read-only user |
| ClickHouse | `@clickhouse/client` | Read-only user |
| PostgreSQL | `pg` | Read-only user, SSL required |
| MySQL | `mysql2` | Read-only user, SSL required |

- A source is a saved query plus: key column (email, CRM id or source id), cursor column, target (contacts, companies, a custom object, or events), schedule (every 15 minutes to daily).
- The query runs with `:cursor` bound by the driver, in a read-only transaction where the database has one, with a 120 s timeout and a row cap of 100,000 per run; the next run continues from the last cursor.
- One statement only. The setup screen shows the exact grant to create the read-only user.
- Hosts pass the private network guard. Snowflake and BigQuery use their public endpoints.

## Part 9. Sales engagement and data vendors

| Source | Setup | Rule |
|---|---|---|
| Apollo | Customer's API key; their saved contacts and lists | Source class `data_vendor`, basis No basis |
| ZoomInfo | Customer's API credentials (enterprise API, check) | Same |
| Lusha, Cognism | API key (check) | Same |
| Clearbit (HubSpot Breeze Intelligence) | Through HubSpot fields | Same for fields it fills |
| Clay | Clay table "Send to webhook" to our hook | Same |
| Outreach | OAuth, `GET /api/v2/prospects` with `filter[updatedAt]`, sequence states | Keeps the source basis; `in_sequence` field pauses marketing |
| Salesloft | OAuth, `GET /v2/people`, cadence memberships | Same |
| LinkedIn Sales Navigator | CSV export only | No basis |

## Part 10. API

| Endpoint | Detail |
|---|---|
| `POST /api/v1/contacts/import` | JSON array or NDJSON, up to 10,000 rows and 20 MB; `Idempotency-Key` header; optional `mapping`, `source`, `basis`; returns `{ import_id }` with 202 |
| `GET /api/v1/imports/:id` | Status, progress, counts, error file URL |
| `POST /api/v1/imports/:id/undo` | Undo while open |
| `POST /api/v1/contacts` | One contact, upsert by email or `external_id` + `source` |
| `POST /api/v1/events` | Segment-shaped `identify`, `track`, `group` |
| MCP `import_contacts` | Same as the import endpoint; Requires approval by default; returns the preview first |

API keys use the existing `api_keys` (migration 012), with a new `contacts:write` scope.

## Part 11. Build order and effort

| Week | Connectors | Effort |
|---|---|---|
| 2 | CSV (streaming), Excel, Google Sheets, paste, vCard | Framework plus 5 file readers |
| 3 | HubSpot | Framework for sources, two-way core |
| 4 | Salesforce, Omniscient | Two-way |
| 5 | Mailchimp, ActiveCampaign, Klaviyo, Brevo, Kit, Constant Contact, MailerLite, SendGrid, Loops, Campaign Monitor | About 1 day each after the first |
| 6 | Marketo, Pardot, Eloqua, HubSpot Marketing assets, Customer.io, Iterable, Braze, Intercom, Pipedrive, Zoho, Dynamics, Attio, Close, Copper, Freshsales, monday, Affinity, Airtable, Notion | About half a day each for the CRMs; 1 to 2 days for each of the three big automation tools |
| 7 | Every form, scheduling, event and ad lead source; Zapier, Make, n8n apps; import API | Webhook connectors are small; app listings take review time (check) |
| 8 | Product, billing, support, warehouses, data vendors, Outreach, Salesloft | — |

Each connector ships with its recorded test, its consent map test and a setup page in the customer docs.
