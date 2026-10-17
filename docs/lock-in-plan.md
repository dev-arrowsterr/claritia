# Lock-in plan: the next six weeks

Claritia is an email marketing platform for B2B teams. A customer does four things, in this order:

1. **Sources:** bring every lead source into one place.
2. **Segments:** build lists from those contacts.
3. **Campaigns:** send broadcasts and nurture sequences.
4. **Forms & Pages:** catch new leads with forms and landing pages.

Reports show what each source, campaign and page produced. Everything else in `docs/marketing-platform.md` (agent journeys, Brand Brain, attribution, the Marketing Agent) waits until these six weeks ship.

## Where we are (main, 17 Oct)

| Built | Where |
|---|---|
| Sources from 20 tools, warehouses, two-way sync with HubSpot, Salesforce and Omniscient | `src/lib/sources/`, `036_sources.sql`, `038_warehouses.sql`, `040_sync.sql` |
| Contacts, companies, fields, imports | `033_contacts.sql`, `034_records.sql`, `035_imports.sql` |
| Segments with AND/OR rules | `037_segments.sql`, `SegmentsView.tsx` |
| Sending: domains, guard, unsubscribe, suppression (on Amazon SES) | `src/lib/email/`, `039_email.sql`, `SendingSettings.tsx` |
| Forms | `src/lib/forms/`, `041_forms.sql`, `FormsView.tsx` |
| Nurture with AI-written steps and approval | `src/lib/nurture/`, `042_nurture.sql`, `NurtureView.tsx` |
| Lead scoring and routing | `043_lead_scoring.sql`, `LeadScoringPanel.tsx` |

| Missing | Effect |
|---|---|
| Sending runs on SES, and we chose Resend | Nothing can go out until one is set up end to end |
| Sources live in Settings | Step 1 is hidden |
| Leads, Contacts and Companies are three sidebar items | Same people in three places |
| Visitors and Accounts sit next to Contacts | The website looks like a second product |
| No broadcasts | Step 3 is half there |
| Journeys, Pages and Reports are intro screens only | The sidebar promises things that don't work |

## The sidebar after week 2

| Item | Holds |
|---|---|
| Home | Setup checklist for a new workspace, then today's numbers |
| Sources | Tools, Imports, Website (visitors and accounts), Sync log |
| Contacts | People and Companies tabs. Leads is a saved view. |
| Segments | As now |
| Campaigns | Broadcasts and Nurtures in one list |
| Forms & Pages | Forms and Pages tabs |
| Reports | Sources, Campaigns, Forms & Pages |
| Settings | Sending, Fields, Objects, Scoring, Workspace, API keys, Profile |

---

## Week 1. Sending on Resend

**Goal:** a customer domain verifies in Resend and a campaign email reaches the inbox with every guard on.

**Code:**
- `src/lib/email/resend.ts` replaces `ses.ts` and `sigv4.ts`. It keeps the same `Outgoing` shape and the same error rule: `retry` when Resend says not now (429, 5xx), `unknown` when there's no clear answer.
- Each send carries `Idempotency-Key: <email_messages.dedupe>`. An `unknown` send is then safe to try once more, because Resend drops a second send with the same key (check the key window on Resend's docs).
- Bulk sends use `POST /emails/batch`, 100 emails a call.
- `src/lib/email/domains.ts` moves to the Resend domains API: create the domain, show the records it returns (DKIM TXT, SPF TXT, MX on `send.`), call verify, poll status. The tracking host CNAME stays ours.
- `src/app/api/email/events/route.ts` replaces `src/app/api/ses/route.ts` and `sns.ts`. It checks the Svix signature with `RESEND_WEBHOOK_SECRET` and handles `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed` and `email.failed`.
- `src/lib/alertSender.ts` and the test inbox already use Resend; they share the new client.

**Database: `044_resend.sql`**
- `sending_domains`: add `provider_id` (the Resend domain id). `dkim_tokens` and `mail_from` stay for old rows and stop being written.
- `email_messages`: rename `ses_message_id` to `provider_id`.
- `send_settings.per_second` default drops to the Resend account rate (check the plan's rate).

**Tests (reliability rule: each on a flaky case):**
- The send call times out after Resend took the email. The retry with the same key makes one email, never two.
- A 429 backs off and the send finishes later.
- A webhook with a bad signature is refused. The same event posted twice changes nothing the second time.
- Events out of order (`delivered` after `bounced`) leave the message bounced.
- A suppressed address is never sent, even from a send that was queued before the bounce.

**Founder:**
- Resend plan that covers Beta volume, and a rate raise (check).
- Webhook to `https://app.tryclaritia.com/api/email/events`, secret into `RESEND_WEBHOOK_SECRET` on Render.
- Verify `mail.tryclaritia.com` in Resend for sending, and set `ALERTS_FROM=Claritia <alerts@mail.tryclaritia.com>`.
- Remove the AWS keys from Render once week 1 ships.

**Done when:** a test domain verifies, a send to 3 seed inboxes (Gmail, Outlook, Yahoo) lands in the inbox, and Resend's bounce test address ends up suppressed.

**Cost:** Resend about $1,150 a month at Beta, about $5,000 at Growth (custom quote, check). AWS drops to $0.

---

## Week 2. Sidebar, Sources and Home

**Goal:** a new user can follow the four steps from the sidebar alone.

**Code:**
- `src/lib/nav.ts`: routes `home`, `sources`, `contacts`, `segments`, `campaigns`, `forms`, `reports`, `settings`. Default route is `home`.
- Old addresses redirect: `leads` → `contacts?view=leads`, `companies` → `contacts?tab=companies`, `visitors` and `accounts` → `sources/website`, `nurture` → `campaigns`, `pages` → `forms?tab=pages`, `settings/sources` → `sources`.
- `SourcesView.tsx`: tabs Tools (from `SourcesSettings.tsx`), Imports (from `ImportsSettings.tsx`), Website (`VisitorsView` and `AccountsView`, plus `SitesPanel`), Sync log.
- `ContactsView.tsx`: People and Companies tabs. Leads becomes a saved view on lead status.
- Journeys leaves the sidebar until agent journeys are built.
- `HomeView.tsx`: for a new workspace, a `ToolIntro` with the four steps and a done tag on each (a source connected, a segment saved, a campaign sent, a form published). After setup: contacts added this week, emails sent, clicks, new MQLs.

**Tests:**
- Every old address lands on the right screen.
- A testing-only workspace sees the testing sidebar exactly as before.

**Done when:** a fresh workspace goes from Home to a connected source in two clicks.

**Cost:** $0.

---

## Week 3. Campaigns: broadcasts

**Goal:** pick a segment, write an email, send it now or on a schedule.

**Screens:**
- **Campaigns list:** one table for broadcasts and nurtures. Columns: name, type tag, status tag, segment, sent, clicks, replies.
- **New broadcast:** segment (with live count) → email → from address → test send → send now or schedule. Schedule can be one time for all, or the same local hour in each contact's time zone.
- **Email editor:** blocks for text, image, button, divider, columns and footer. Preview at desktop and phone width. "Draft with AI" writes from a short brief.

**Database: `045_broadcasts.sql`**
- `broadcasts (id, workspace_id, email_id, segment_id, send_at, local_time bool, status, counts jsonb, created_by, created_at)`.
- The segment is frozen into `broadcast_recipients` at send time, so a segment change after that doesn't change who gets it.

**Jobs:**
- `broadcast_fanout` writes `email_messages` in chunks of 1,000 with `dedupe = broadcast:<id>:<contact>`, then the existing send job takes over.

**Tests:**
- Fanout killed halfway and restarted makes no doubles and misses no one.
- A contact who unsubscribes after the fanout and before their send is skipped.
- AI draft replays from `ai_cache` for the same brief.

**Done when:** a broadcast to 500 seed contacts sends with the cap and quiet hours on, and clicks show on the list.

**Cost:** AI drafts on Haiku, about $10 a month at Beta and $100 at Growth (check).

---

## Week 4. Campaigns: nurture

**Goal:** nurture lives in Campaigns, uses the same editor, and stops when a lead acts.

**Code:**
- `NurtureView.tsx` moves into Campaigns, with the week 3 editor in place of its own.
- Enrollment triggers: joins a segment, fills a form, comes in from a source.
- Exit rules: replied, booked a meeting, became an MQL, unsubscribed, or added to a deal in the CRM.
- Replies: reply-to is `r-<token>@inbox.tryclaritia.com`. The inbound webhook marks the reply and forwards it to the sender's real address.

**Tests:**
- A contact who replies on day 2 never gets the day 3 email, even when that send is already queued.
- A forwarded reply keeps the original sender and subject.

**Done when:** a 3-step nurture runs on seed contacts and a reply stops it.

**Cost:** Resend inbound is included in the plan (check). Claude for steps is already in the nurture build.

---

## Week 5. Landing pages

**Goal:** a marketer builds and publishes a landing page with a form in under 10 minutes.

**Screens:**
- **Forms & Pages → Pages:** 5 templates (demo request, webinar, content download, product, event).
- Blocks: hero, logos, features, testimonial, form, call to action, footer.
- "Write with AI" fills copy from the customer's own site.
- Publish to `go.<customer domain>` through a CNAME, or `tryclaritia.com/p/<slug>` until one is set.

**Database: `046_pages.sql`**
- `pages (id, workspace_id, slug, host, blocks jsonb, status, published_html, published_at)`.

**Code:**
- `src/proxy.ts` serves published pages by host from the web app.
- Forms from `src/lib/forms/` drop into the form block as they are.

**Tests:**
- A published page renders from stored HTML with no database call per block.
- A form on the page creates a contact with UTM fields.
- An unpublished page answers 404.
- Funnel QA checks the page and its form on publish.

**Done when:** a page on a test domain takes a fill that reaches Contacts and starts a nurture.

**Cost:** page drafts on Sonnet, about $10 a month at Beta and $100 at Growth. Render web service up to 1 GB, about $25 more (check).

---

## Week 6. Reports

**Goal:** a marketer sees what each source, campaign and page produced.

**Screens:**
- **Sources:** contacts added and MQLs per source, by week.
- **Campaigns:** sent, delivered, human clicks, replies, unsubscribes, bounces, meetings and MQLs per campaign. Opens are shown with a "not reliable" tag.
- **Forms & Pages:** views, fills and fill rate.

**Database: `047_report_rollups.sql`**
- Nightly rollups into `email_stats`, `source_stats` and `page_stats`. Postgres only; ClickHouse waits for Growth.

**Tests:**
- Each number matches a hand-counted fixture.
- Scanner clicks don't count as human clicks.

**Done when:** every number on the three reports matches the fixture.

**Cost:** $0 at Beta. About $300 a month for ClickHouse at Growth (check).

---

## What the six weeks add to the monthly bill

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Resend | $1,150 (check) | $5,000 (custom quote, check) |
| Claude: broadcast and page drafts | $20 (check) | $200 (check) |
| Render: web service to 1 GB | $25 (check) | $85 (check) |
| ClickHouse | $0 | $300 (check) |
| Amazon SES (removed) | −$250 | −$2,500 |
| **Added** | **About $945** | **About $3,085** |

## Founder checklist

| Item | Needed by |
|---|---|
| Resend plan, rate raise, webhook secret | Week 1 |
| `mail.tryclaritia.com` verified in Resend, `ALERTS_FROM` set | Week 1 |
| Seed inboxes on Gmail, Outlook and Yahoo | Week 1 |
| 500 seed contacts in a test workspace | Week 3 |
| A test domain for landing pages | Week 5 |

## After week 6

In order: agent journeys (M4), Brand Brain (M5), attribution with Arrowsterr and Omniscient (M8), Marketing Agent (M10). Each gets its own plan with its running cost before it starts.
