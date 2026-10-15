# Conversion parity: build plan

The plan to match what Conversion (conversion.ai) sells, on top of what Claritia already has. Conversion is a marketing automation platform built around the CRM: two-way Salesforce sync, a workflow canvas, an email builder, AI lead scoring with routing, and agents that work inside approval rules. Claritia gets the same core in 14 weeks, plus Website Intelligence (M1), which Conversion doesn't have.

This plan changes the order of `docs/marketing-platform.md`. It pulls CRM sync forward from weeks 27–30 and pushes Brand Brain, Pages and Attribution after it. Rules for identity, consent and sending stay in their specs and are not repeated here:

| Spec | What it settles |
|---|---|
| `docs/marketing-platform.md` M2, M3, M4, M7, M10 | Contacts, email, journeys, scoring and agent details this plan builds on |
| `docs/identity.md` | Matching contacts to people, cleaning emails, email link tokens |
| `docs/account-intelligence.md` Part 3 | Region policy, consent, data requests |
| `docs/brand.md` | Look and copy of every screen and email |

---

## Part 1. Scope

### 1.1 What Conversion does, and our answer

| Conversion | What it does (from its own pages) | Claritia after this plan |
|---|---|---|
| Salesforce sync | Two-way, with a log of every create, update and failure. Campaigns sync both ways. | Two-way HubSpot and Salesforce sync, sync log, campaign members both ways, Omniscient sync kept |
| Workflows | A canvas with branches, delays, Salesforce actions, webhooks and API calls. Triggers from CRM changes, warehouse queries and product events. | Workflows with the same triggers and steps, plus AI Decide and AI Write steps and website-visit triggers |
| Email Studio | Drag-and-drop builder with live CRM fields and personalization blocks | Block editor with CRM fields, brand kit, live preview, test send |
| AI lead scoring and routing | Scores from CRM, warehouse and behavior data, retrained as deals close, with top reasons. Synced to Salesforce. | Contact scores with reasons, synced to the CRM, retrained weekly on closed deals. Routing rules and SLA timers. |
| Agents | Started from Slack, Linear or a schedule. Each tool is Automatic, Requires approval or Disabled. Nothing publishes before a person reviews it. | Agents in the app and Slack, same per-tool settings, drafts only until approved |
| — | — | Website visitors, companies and intent (M1), which Conversion lacks |

### 1.2 What a customer can do at the end

1. Connect HubSpot or Salesforce in two clicks and see every lead, contact and account in Contacts within 10 minutes.
2. See every sync change in the Sync log, with the record, the fields, the direction and any error, and retry a failed row.
3. Build a segment with filters ("Fintech, fit 70+, clicked an email in 14 days") and see the live count.
4. Send a newsletter to a segment from their own domain, with unsubscribes, suppression and reports.
5. Build a workflow on a canvas: trigger, branches, waits, email, CRM update, Slack, webhook and AI steps. Test it on 20 real contacts without sending, then publish.
6. See a score and its top 3 reasons on every contact, in Claritia and in the CRM.
7. Route ready leads to the right rep, with a Slack alert and a timer that warns the manager if nobody acts.
8. Ask the agent "Build a nurture for webinar signups" in the app or Slack and get a draft workflow and emails to approve.

### 1.3 In and out

| In this plan | Later |
|---|---|
| Contacts, companies, fields, consent, topics, segments, CSV import | Pages and forms builder (M6) |
| HubSpot and Salesforce two-way sync, Omniscient sync, sync log | Marketo and Pardot import |
| Snowflake, BigQuery and Postgres warehouse triggers (read only) | Writing back to a warehouse |
| Segment and PostHog product events in | Mixpanel, Amplitude |
| Email: domains, SES sending, block editor, broadcasts, tracking, reports | SMS, WhatsApp |
| Workflows with AI Decide and AI Write | Brand Brain (M5) atoms. Until then, Write uses a voice guide and an approved facts list. |
| Contact scoring, routing, handoff, SLA | Multi-touch attribution (M8) |
| Agents in the app and Slack with per-tool settings | Linear trigger (after Beta, check demand) |
| REST and MCP for contacts, segments, workflows | Webhooks out to any URL (the webhook step covers most needs) |

### 1.4 Dependencies

| Need | From | When |
|---|---|---|
| Jobs queue, identity, accounts, scores | M0, M1 (built) | — |
| HubSpot public app (client id, secret, scopes) | Founder | Week 1 |
| Salesforce connected app (Developer Edition org for tests) | Founder | Week 2 |
| Amazon SES production access in ap-northeast-1 | Founder, request in week 1 | Week 4 |
| Slack app (exists, migration 014): add `chat:write`, `im:history`, `app_mentions:read` | Build | Week 13 |
| Omniscient API with app keys (Omniscient migration 032, one-click connect) | Omniscient repo | Week 3 |

---

## Part 2. System design

### 2.1 Components

```
 HubSpot ◄──────► sync_crm (intel) ◄──► contacts, companies, crm_links, sync_log
 Salesforce ◄───►     ▲  webhooks / CDC / polling
 Omniscient ◄───►     │
 Warehouse ─────► warehouse_poll (intel) ─► contact_events
 Segment, PostHog ─► /api/events ─► contact_events
 M1 sessions, signals ─────────────────────► contact_events
                                    │
                       segment_refresh · workflow_step · ai_decide · ai_write · send · ses_event
                       score_contact · route · sla_check · agent_run
                                    │
     Amazon SES ◄── send          Slack ◄── notify, agent      CRM ◄── handoff, score sync
```

No new Fly apps. `claritia-intel` runs every new job. It moves from 512 MB to 1 GB at Beta (Part 15).

### 2.2 Life of one lead

| Step | Where | Time budget |
|---|---|---|
| 1. A lead is created in Salesforce | Salesforce | — |
| 2. Change Data Capture (or a 2-minute poll) sends it to `sync_crm` | intel | ≤ 2 min |
| 3. The contact is upserted, matched to an identity person by cleaned email, and its `crm_links` row written | intel | ≤ 5 s |
| 4. Segments that use its fields refresh for that contact. Entering "New leads, fit 70+" starts a workflow. | intel | ≤ 10 s |
| 5. The workflow scores, waits, sends an email, and branches on the click | intel | per step |
| 6. The contact visits pricing twice. M1 signals raise the score past Ready. | collect, intel | ≤ 1 min |
| 7. Routing picks the owner, writes it to Salesforce, alerts the rep in Slack, and pauses nurture | intel | ≤ 2 min p95 |

### 2.3 Environment

| Var | App | Purpose |
|---|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | web, intel | OAuth and token refresh |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | web, intel | OAuth (web server flow with PKCE) and refresh |
| `AWS_SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | intel | Sending, identities, configuration sets |
| `SES_SNS_TOPIC_ARN` | web | Checks that SES events come from our topic |
| `TRACK_SECRET` | collect | Signs click and unsubscribe tokens |
| `SECRETS_KEY` (exists) | web, intel | Seals CRM and warehouse credentials |
| `ANTHROPIC_API_KEY` (exists) | intel | Decide, Write, score reasons, agents |

---

## Part 3. Files

```
src/lib/contacts/
  contacts.ts          upsert, merge through identity, field writes with source
  fields.ts            field registry, types, CRM field mapping
  consent.ts           consent and topic checks by region
  segments.ts          rule tree → one parameterized SQL query
  import.ts            CSV parse, mapping, dedupe, consent basis check
src/lib/crm/
  types.ts             one shape for both CRMs: records, changes, errors
  hubspot.ts           OAuth, contacts/companies/deals, webhooks, batch upsert
  salesforce.ts        OAuth, leads/contacts/accounts/opportunities/campaign members, CDC, Composite API
  omniscient.ts        app key connect, contacts, accounts, activities
  mapping.ts           default maps, custom maps, conflict rules
  sync.ts              pull, push, echo guard, retry, sync log
src/lib/warehouse/
  connect.ts           Snowflake, BigQuery, Postgres read-only clients
  poll.ts              saved queries on a schedule, row → contact event
src/lib/email/
  ses.ts               send, identities, config sets, rate limits
  domains.ts           DNS records and checks
  blocks.ts            block schema, MJML render, plain text
  tokens.ts            {{field | "fallback"}} parse and render
  track.ts             link rewrite, click tokens, scanner filter
  guard.ts             consent, suppression, frequency cap, quiet hours
src/lib/workflows/
  graph.ts             node and edge schema, validation, versions
  engine.ts            enroll, run step, wait, branch, exit, re-entry
  steps/               one file per step kind
  simulate.ts          dry run on real contacts
src/lib/scoring/
  contact.ts           engagement, readiness, reasons
  train.ts             weekly fit on closed deals
  routing.ts           rules, round robin, out of office
  sla.ts               timers and escalation
src/lib/agent/
  tools.ts             tool list with Automatic / Requires approval / Disabled
  run.ts               loop with caching and an 8-call cap
  slack.ts             mentions, DMs, approve buttons
worker-intel/jobs/
  crm.ts warehouse.ts segments.ts send.ts ses.ts workflows.ts ai.ts scoring.ts agent.ts
src/components/app/views/
  ContactsView.tsx SegmentsView.tsx SyncView.tsx EmailsView.tsx EmailEditor.tsx
  WorkflowsView.tsx WorkflowCanvas.tsx ApprovalsView.tsx (extend) AgentPanel.tsx
src/components/app/
  FilterBar.tsx        "+ Filter", tags, saved views (also used by Visitors and Accounts)
```

---

## Part 4. Database

Migrations 033 to 039, each with RLS, leak tests in `tests/db/leaks.sql`, and functions that check membership.

### 4.1 `033_contacts.sql`

```
contacts        (id, workspace_id, person_id → persons, email, email_clean, first_name, last_name, title, phone,
                 company_id, country, region, timezone, lifecycle, lead_status, owner_user_id, owner_crm_id,
                 source, fields jsonb, score int, score_band text, score_reasons jsonb, created_at, updated_at,
                 deleted_at)
companies       (id, workspace_id, account_id → accounts, domain, name, industry, size, country, owner_crm_id,
                 fields jsonb, created_at, updated_at)
fields          (id, workspace_id, object text, key, label, type text, options jsonb, crm_map jsonb, created_at)
field_writes    (contact_id, key, value jsonb, source text, at)          -- latest write per field and source
topics          (id, workspace_id, name, default_on bool)
consents        (id, workspace_id, contact_id, channel, basis, status, source, wording, at)
subscriptions   (contact_id, topic_id, status, at)
segments        (id, workspace_id, name, rules jsonb, kind text, count int, refreshed_at, created_by)
segment_members (segment_id, contact_id, entered_at, left_at)
contact_events  (id, workspace_id, contact_id, kind, data jsonb, source, at)   -- partitioned by month
imports         (id, workspace_id, file_path, mapping jsonb, status, counts jsonb, created_by, created_at)
```

- `unique (workspace_id, email_clean) where deleted_at is null`.
- `contact_events` partitions by month, 13 months kept (`docs/account-intelligence.md` Part 3 retention).

### 4.2 `034_crm.sql`

```
crm_connections (id, workspace_id, kind text, -- hubspot, salesforce, omniscient
                 instance_url, external_org_id, sealed_tokens bytea, scopes text[], status, last_sync_at,
                 settings jsonb, -- direction per object, conflict rule, lead vs contact rule
                 created_by, created_at)
crm_links       (workspace_id, connection_id, object text, local_id uuid, external_id text, external_type text,
                 last_pulled_at, last_pushed_at, last_hash text,
                 primary key (connection_id, external_type, external_id))
sync_log        (id, workspace_id, connection_id, direction text, object text, local_id, external_id,
                 action text, -- create, update, skip, conflict, error
                 fields jsonb, error text, attempt int, at)              -- 90 days kept
sync_cursors    (connection_id, object, cursor text, updated_at)
campaigns       (id, workspace_id, name, external_id, connection_id, status)
campaign_members(campaign_id, contact_id, status, external_id, at)
```

### 4.3 `035_warehouse.sql`

```
warehouse_connections (id, workspace_id, kind, sealed_credentials bytea, status, created_at)
warehouse_queries     (id, workspace_id, connection_id, name, sql text, every_minutes int, key_column,
                       event_kind, last_run_at, last_cursor text, last_error)
```

- Queries run with a read-only role the customer creates (setup text shows the exact grant). Each run has a 60 s timeout and a 10,000-row cap.

### 4.4 `036_email.sql`

From `docs/marketing-platform.md` M3: `sending_domains`, `templates`, `emails`, `email_messages`, `suppressions`, `send_limits`, plus:

```
brand_kits      (workspace_id, logo_path, colors jsonb, fonts jsonb, footer jsonb, address text)
email_stats     (email_id, day, sent, delivered, bounced, complained, clicked, replied, unsubscribed)
```

### 4.5 `037_workflows.sql`

```
workflows       (id, workspace_id, name, status, -- draft, live, paused, archived
                 version int, trigger jsonb, goal jsonb, reentry jsonb, review_mode text, created_by, updated_at)
workflow_nodes  (id, workflow_id, version, kind, config jsonb, position jsonb)
workflow_edges  (workflow_id, version, from_node, to_node, label text)
enrollments     (id, workspace_id, workflow_id, version, contact_id, state, current_node, next_run_at,
                 entered_at, exited_at, exit_reason)
node_runs       (id, enrollment_id, node_id, started_at, finished_at, outcome jsonb, ai_call_id)
approvals       (extend the existing table: kind 'email' | 'workflow' | 'segment' | 'agent_action')
```

- `enrollments (workflow_id, contact_id) where exited_at is null` is unique, so one contact is in a workflow once at a time.

### 4.6 `038_scoring.sql`

```
score_models    (id, workspace_id, version, weights jsonb, trained_on jsonb, auc numeric, created_at, active bool)
routing_rules   (id, workspace_id, position int, kind, config jsonb)
handoffs        (id, workspace_id, contact_id, owner, target, target_ids jsonb, at, touched_at, outcome)
sla_timers      (handoff_id, due_at, fired_at)
```

### 4.7 `039_agent.sql`

```
agent_tools     (workspace_id, tool text, mode text) -- automatic, approval, disabled
agent_runs      (id, workspace_id, started_by, source text, -- app, slack, schedule
                 prompt text, status, tool_calls int, tokens jsonb, created_at, finished_at)
agent_steps     (id, run_id, tool, input jsonb, output jsonb, approval_id, at)
agent_schedules (id, workspace_id, prompt, cron, enabled)
```

### 4.8 Jobs (new kinds in `jobs`)

| Kind | Scope | Trigger | Retry |
|---|---|---|---|
| `crm_pull` | connection, object | Webhook or CDC event, or every 2 min poll | 5, backoff |
| `crm_push` | contact or company | Local change with a CRM map | 5, backoff |
| `crm_backfill` | connection | First connect, then nightly check | 3 |
| `warehouse_poll` | query | Its schedule | 3 |
| `segment_refresh` | segment or contact | Contact change, hourly full | 3 |
| `workflow_step` | enrollment | `next_run_at` | 5 |
| `ai_decide`, `ai_write` | node run | Workflow step | 2, then default branch or skip |
| `send` | message | Broadcast or workflow | 5 |
| `ses_event` | message | SNS post | 5 |
| `score_contact` | contact | Event, debounced 60 s | 3 |
| `score_train` | workspace | Weekly | 2 |
| `route`, `sla_check` | handoff | Ready, timer | 5 |
| `agent_run` | run | App, Slack, schedule | 1 |
| `domain_check` | domain | Every 10 min until verified, then daily | — |

---

## Part 5. CRM sync

### 5.1 How each CRM connects

| CRM | Auth | Changes in | Writes out | Limits |
|---|---|---|---|---|
| HubSpot | OAuth public app | Webhooks (contact, company, deal create, change, merge, delete), plus a 2-minute search poll as backup | Batch upsert, 100 per call | 100 calls per 10 s per app per account (check the current tier on HubSpot's page) |
| Salesforce | OAuth web server flow with PKCE, refresh token | Change Data Capture on Lead, Contact, Account, Opportunity, CampaignMember. If CDC isn't enabled, `SystemModstamp` polling every 2 min. | Composite API, 200 per call | The org's daily API limit. We use at most 20% and pause at 80% of the org total (read `/limits`). |
| Omniscient | App key from one-click connect (Omniscient migration 032) | Its webhooks | `POST /api/v1/…` | Its rate limit (check) |

### 5.2 Records

| Claritia | HubSpot | Salesforce |
|---|---|---|
| Contact | Contact | Lead (before convert) or Contact (after). A converted lead links to its new Contact. |
| Company | Company | Account |
| Deal (read only) | Deal | Opportunity |
| Campaign member | List membership (static list) | CampaignMember with status |
| Score, band, reasons | Three custom properties we create | Three custom fields the admin installs from our setup steps |

### 5.3 Rules

- **Who wins on a conflict:** set per field. The default is "CRM wins" for owner and lifecycle, and "most recent change wins" for the rest. A field changed on both sides within 60 s goes to the sync log as `conflict` and keeps the CRM value.
- **Echo guard:** every push stores the hash of what we sent in `crm_links.last_hash`. A change coming back with the same hash is skipped. HubSpot writes carry a `claritia_source` property, Salesforce writes are done by our integration user, and both are ignored on the way back.
- **Dedupe:** a CRM record matches a contact by its link, then by cleaned email (`docs/identity.md` Part 6). Two CRM records with one email both link to one contact, and the sync log shows a `conflict` row for the admin.
- **Deletes:** a CRM delete soft-deletes the contact (`deleted_at`). An erasure in Claritia (`docs/identity.md` 15.1) never deletes in the CRM. It shows a task in the sync log for the admin.
- **Nothing is lost:** every pull and push writes one `sync_log` row. A failed row retries 5 times, then waits with a Retry button.

### 5.4 First connect

1. The admin clicks Connect, approves in HubSpot or Salesforce, and lands on the mapping screen with defaults already set.
2. They pick the direction for each object (both, in only, off) and press Start.
3. `crm_backfill` pages through all records (contacts first, then companies, then open deals) at the rate limit and shows progress.
4. After the backfill, changes run live. A nightly check compares counts and fixes gaps.

---

## Part 6. Segments and filters

- One `FilterBar` component for Contacts, Segments, Visitors and Accounts: "+ Filter", pick a field, pick a condition or values, and each filter shows as a square tag.
- Saved views per screen. On Accounts, the old tabs become saved views.
- Rule kinds: contact fields, company fields, CRM fields, events ("clicked any email in 14 days", "visited /pricing 2 times"), scores, segment membership, campaign membership, consent.
- Every rule tree compiles to one SQL query with bound parameters. Field keys come from the `fields` registry, never from user text.
- Live count and a sample of 10 while editing (debounced 400 ms, 2 s statement timeout).

---

## Part 7. Email

As in `docs/marketing-platform.md` M3, with these Conversion-level parts:

| Part | Detail |
|---|---|
| Editor | Blocks: text, image, button, columns, divider, spacer, social, signature, footer. Drag to reorder. CRM field tokens from a picker. A live preview at desktop, tablet and phone widths. |
| Brand kit | Logo, colors and fonts read from the customer's site, then edited |
| Personal blocks | A block shown only when a rule passes ("Show if industry is Fintech") |
| Test send | To any teammate, with a chosen contact's data |
| Reports | Sent, delivered, clicks (human only), replies, unsubscribes, bounces, complaints, and pipeline from Omniscient or the CRM. Opens shown and marked unreliable. |
| Campaign link | A broadcast can add each recipient to a CRM campaign with status Sent, then Responded on click |

---

## Part 8. Workflows

### 8.1 Triggers

| Trigger | Example |
|---|---|
| Segment entered or left | "Fit 70+ and visited pricing" |
| CRM change | Lead status became "Working", opportunity lost, owner changed |
| Product event | Signup, invite sent, plan limit hit (Segment, PostHog, API) |
| Warehouse row | A row appears in "trials ending in 3 days" |
| Website | Visited a page group, account turned hot (M1) |
| Email | Clicked, replied, bounced |
| Score | Crossed a band |
| Date | Field date ± N days (renewal, webinar) |
| Manual or API | Add from a list, `POST /api/v1/workflows/:id/enroll` |

### 8.2 Steps

| Step | What it does |
|---|---|
| Send email | A saved email, or one from AI Write |
| Wait | A time, until a weekday and hour, or until an event, with a timeout path |
| Branch | If and else on fields, events, scores or segments, up to 5 paths |
| Split | Random A/B split by percent |
| AI Decide | Haiku picks one of the named paths with a reason. It can't invent a path. |
| AI Write | Writes one email for this contact from the voice guide, approved facts and recent activity |
| Update field | Set a field, lifecycle, lead status or subscription. Pushed to the CRM if mapped. |
| CRM action | Create a task, add to a campaign, change owner, create a deal |
| Slack | Message a channel or the owner, with the contact card |
| Webhook | POST to a URL with a signed body. The response can feed a branch. |
| Route | Run routing rules and hand off (Part 9) |
| Enroll | Add to another workflow or a static segment |
| Goal | Exit when reached |

### 8.3 Canvas

- A vertical canvas: the trigger at the top, nodes linked down, branches side by side. Click a node to edit it in a side panel. Drag from the "+" on an edge to add a node.
- Each node shows its live count (in it now, passed, exited).
- Validation before publish: every path ends, every wait has a timeout path, no node is cut off, every email has a topic, and every AI Write has a review mode.
- **Simulate:** "Test with 20 contacts" runs the workflow on real contacts with no sends and no CRM writes. It shows each path, every AI reason and every written email.
- Versions: publishing makes a new version. Running enrollments stay on theirs unless the marketer moves them.

### 8.4 Review modes for AI Write

| Mode | Behavior |
|---|---|
| Review all | Every written email waits in Approvals |
| Review a sample | 1 in 10 waits. Unlocked after 20 approvals with < 10% heavy edits. |
| Auto | Sends after the checks pass. Unlocked after 100 approvals with < 5% heavy edits. The owner can lock it off. |

Checks on every written email: no tracking mentions, no facts outside the approved list, every token filled, length within limits.

---

## Part 9. Scoring and routing

### 9.1 Contact score

- **Inputs:** fit (account, M1), intent (account, M1), engagement (contact: clicks, replies, page reads, forms, product events, with a 14-day half life), CRM fields (title, lead source, lifecycle) and warehouse fields.
- **Model v0:** fixed weights from the ICP rules. Each input adds points, so the top 3 reasons are the 3 biggest additions ("Visited pricing 3 times this week +18").
- **Model v1 (weekly, once a workspace has 30+ closed deals):** logistic regression on won vs lost, with the same inputs. The new model goes live only if its AUC beats the current one on the last 20% of deals. Reasons still come from each input's share.
- **Bands:** Cold < 40, Warm 40–69, Ready 70+. Editable.
- **Sync:** score, band and reasons push to the CRM on band change, and once a day for any change.
- Reasons are plain text from templates. Haiku rewrites them into one line only on band change (cached by input hash).

### 9.2 Routing and handoff

From `docs/marketing-platform.md` M7: rules in order (existing owner, account owner, territory, segment, round robin skipping people out of office), then handoff:
1. Set the owner and lead status in the CRM.
2. Create a CRM task "Follow up: Ready lead", with the reasons.
3. Slack DM the owner with the contact card and an "Open in CRM" button.
4. Pause marketing workflows for the contact.
5. Start the SLA timer (default 24 business hours). On breach, alert the manager once.

---

## Part 10. Agents

### 10.1 Where they run

| Start | How |
|---|---|
| App | A panel on every screen: "Ask or build…" |
| Slack | Mention `@Claritia` in a channel or DM it. Answers come in the thread. |
| Schedule | A saved prompt on a cron, like "Every Monday: what changed in pipeline from email?" |

### 10.2 Tools and their settings

| Tool | Default |
|---|---|
| `search_contacts`, `get_contact`, `list_segments`, `get_report`, `list_workflows`, `workflow_report` | Automatic (read only) |
| `create_segment` | Automatic (segments are harmless until used) |
| `draft_email`, `draft_workflow` | Automatic (makes drafts only) |
| `publish_workflow`, `send_broadcast` | Requires approval |
| `update_contact_fields`, `add_to_campaign` | Requires approval |
| `delete_*` | Disabled, and can't be turned on |

- Settings › Agents shows each tool with a Select: Automatic, Requires approval, Disabled.
- An approval shows what the agent wants to do, the records it touches, and Approve or Skip. In Slack it's a message with buttons.
- Every run is logged in `agent_runs` and `agent_steps` with tokens and cost.

### 10.3 Model and limits

- Sonnet 5.5 with prompt caching on the workspace context (fields, segments, workflow list).
- Haiku 5.5 for short read-only answers.
- 8 tool calls per run, 60 s per run, 30 runs per workspace per day at Beta.

---

## Part 11. Screens

Sidebar after this plan:

| Group | Screens |
|---|---|
| Audience | Contacts, Segments, Visitors, Accounts |
| Engage | Workflows, Emails |
| Prove | Reports |
| Bottom | Approvals, Settings |

| Screen | Holds |
|---|---|
| Contacts | Table with FilterBar, saved views, columns picker, bulk actions (add to segment, enroll, export). Contact page: header with score and band, reasons, fields with source, timeline (CRM, email, web, product), segments, workflows, consents. |
| Segments | List with count and trend. Builder with live count and a sample of 10. |
| Workflows | List with status, in it now, goal rate. Canvas, simulate panel, version history, report per node. |
| Emails | Broadcasts and workflow emails. Editor with preview and test send. Report per email. |
| Approvals | Written emails, agent actions, publish requests. Approve, Edit, Skip. |
| Settings › Connections | HubSpot, Salesforce, Omniscient, warehouse, Segment, PostHog: connect, mapping, direction, status |
| Settings › Sync log | Every sync row with filters (connection, object, action, error), and Retry |
| Settings › Sending | Domains with record tags, brand kit, topics, frequency cap, quiet hours |
| Settings › Scoring | Bands, weights, model version and its AUC, routing rules, SLA |
| Settings › Agents | Tools and their settings, schedules, Slack connect |

First screens before data use `ToolIntro`. Working screens hold labels, buttons and real errors only.

---

## Part 12. API and MCP

| Endpoint | What |
|---|---|
| `GET/POST/PATCH /api/v1/contacts` | List with filters, create, update |
| `POST /api/v1/events` | Product events (Segment-shaped) |
| `GET /api/v1/segments`, `GET /api/v1/segments/:id/contacts` | Read |
| `POST /api/v1/workflows/:id/enroll` | Enroll contacts |
| MCP tools | The agent's read and draft tools (Part 10.2), same settings apply |

---

## Part 13. Tests

Reliability rule: the sync, the send pipeline and the workflow engine each get a test that proves them on a flaky case.

| Area | Test |
|---|---|
| CRM sync | HubSpot and Salesforce fakes (recorded responses): 1,000 random changes on both sides with dropped webhooks, duplicate deliveries and 429s. End state matches on both sides. No echo loops. Every change has one log row. |
| CRM sync | A Salesforce lead converts to a contact: one Claritia contact, both links kept |
| CRM sync | A sandbox org and a HubSpot test account, run nightly in CI (a Salesforce Developer org is free, check) |
| Segments | 30 rule types match a hand-counted fixture. Fuzz test with SQL-like text in values. |
| Email | SNS signature check. Suppressed address never sent, even from a queued step. One-click unsubscribe. Frequency cap and quiet hours. Complaint storm pauses sending. Renders match snapshots at 3 widths. |
| Workflows | 10,000 simulated enrollments with killed workers and retried jobs: no stuck or doubled enrollments, exits honored, version moves right |
| AI | Decide never returns a missing path. Write drops a made-up fact and blocks a tracking mention. A passing step replays from the step cache with no model call. |
| Scoring | Fixed fixtures give the expected scores and reasons. v1 goes live only when its AUC is higher. |
| Routing | 20 routing cases. A handoff makes exactly one CRM task when retried. SLA fires once. |
| Agents | A disabled tool is never called. An approval tool never runs before approval. Replay of fixed data gives the same drafts. |
| Leaks | Every new table in `tests/db/leaks.sql` |

---

## Part 14. Week-by-week schedule (14 weeks)

| Week | Build | Done when |
|---|---|---|
| 1 | `033_contacts.sql`, contacts library, fields registry, CSV import, FilterBar, Contacts screen and contact page | A 10,000-row CSV imports with dedupe, and filters work on Contacts, Visitors and Accounts |
| 2 | `034_crm.sql`, sync core (log, echo guard, retry), HubSpot OAuth, backfill, webhooks, push | A HubSpot test account syncs both ways with 0 doubles after the 1,000-change test |
| 3 | Salesforce OAuth, CDC and polling, Composite writes, lead convert, campaigns. Omniscient one-click connect. Settings › Connections and Sync log. | A Salesforce Developer org syncs both ways and passes the same test |
| 4 | Segments: rule compiler, live count, refresh job, membership events. Segment and PostHog events in. `035_warehouse.sql` and Snowflake, BigQuery, Postgres polling. | 30 rule types pass. A warehouse row becomes a contact event within its schedule. |
| 5 | `036_email.sql`, domains wizard and checks, SES client, send guard, SNS events, suppression | A test domain verifies and a test email sends with one-click unsubscribe |
| 6 | Block editor, brand kit, tokens, preview, test send, broadcasts, tracking, email reports, campaign link | A broadcast to a 500-contact segment sends, and clicks show on contacts and in the CRM campaign |
| 7 | `037_workflows.sql`, graph schema, engine, waits, branches, splits, exits, re-entry | 10,000-enrollment test passes |
| 8 | Canvas UI, node side panel, validation, versions, live counts | A 12-node workflow is built and published in the app |
| 9 | Steps: email, update field, CRM action, Slack, webhook, enroll, goal. All triggers. | Each trigger and step has a passing test |
| 10 | AI Decide and AI Write with step cache, checks, review modes, Approvals. Simulate. | Simulate on 20 contacts shows every path, reason and email with no sends |
| 11 | `038_scoring.sql`, contact score v0, reasons, CRM score sync | Scores and reasons show in Claritia and on the CRM record |
| 12 | Score v1 training, routing rules, handoff, SLA, Settings › Scoring | A Ready lead reaches the right rep in Slack within 2 minutes p95 |
| 13 | `039_agent.sql`, tools with settings, agent loop, app panel, Slack app, schedules | "Build a nurture for webinar signups" makes a draft workflow and emails |
| 14 | REST and MCP, quality numbers on the internal page, setup docs for customers, install with 2 design partners | Partners run a live workflow synced with their CRM. All Part 13 tests green. |

---

## Week 1 status: built

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
- **Flaky cases tested:** a batch whose answer is lost is sent again with no doubles; two imports of the same people at once make no doubles; a contact follows its person through stitching, merges in either order, a rebuild and erasure; 36 filter cases (SQL-like text, `%`, `_`, `\`, quotes) give the same rows in the database and the browser.
- **Identity:** a contact links to the person with the same cleaned email, in both orders, and never makes a person. Erasing a person removes their contacts; a person export lists them.
- **Consent:** imports need a source and a basis (a column or one for the file). Bought lists are refused. Outside opt-in, strict regions and unknown countries get "No basis".
- **Left for later weeks:** segments, enroll and add-to-segment bulk actions (week 4), scores and reasons (week 11). Custom fields made from the import are text; a fields screen comes with Settings › Connections in week 3.

**Running cost of week 1:** no new service and no Claude calls. Imports run in the web app. Each contact with its consent, field history and events takes about 3 KB.

| Line | Beta (50 teams, 10,000 contacts each) | Growth (500 teams) |
|---|---|---|
| Supabase disk: about 1.5 GB at Beta, 15 GB at Growth, inside the plan's 8 GB, then $0.125 per GB (check) | $0 | About $1 |
| Claude, servers, other services | $0 | $0 |
| **Added by week 1** | **$0** | **About $1** |

This sits inside the Supabase line in 15.2.

## Part 15. Monthly cost

### 15.1 Per team per month

Assumptions: 10,000 contacts, 50,000 emails (20,000 from AI Write), 20,000 Decide calls, 100 agent runs, 2 CRM syncs.

| Item | Use | Per team |
|---|---|---|
| Score reasons | Haiku, band changes only | $2 |
| AI Decide | Haiku, 20,000 calls, cached when inputs repeat | $10 |
| AI Write | Haiku by default, Sonnet for score 80+ | $20 |
| Agents | Sonnet with caching, about 100 runs | $10 |
| **Claude subtotal** | | **$42** |
| Amazon SES | 50,000 emails at about $0.10 per 1,000 (check) | $5 |
| CRM APIs | Customer's own HubSpot and Salesforce limits | $0 |
| Warehouse queries | Run on the customer's warehouse and bill | $0 |

Claude prices from `docs/marketing-platform.md` Part 11 (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million tokens).

### 15.2 Added to the monthly bill

| Line | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude ($42 per team) | $2,100 | $21,000 |
| Amazon SES | $250 (check) | $2,500 (check) |
| Dedicated sending IPs | $50, 2 IPs (check) | $250, 10 IPs (check) |
| Fly: `claritia-intel` 512 MB → 1 GB, then 3 × 2 GB | $6 (check) | $90 (check) |
| Supabase: more compute and disk for contacts and events | $50 (check) | $200 (check) |
| Salesforce Developer org and HubSpot test account for CI | $0 | $0 |
| **Added by this plan** | **About $2,456** | **About $24,040** |
| **Per team** | **About $49** | **About $48** |

At the proposed $299 Starter and $799 Growth prices, this keeps gross margin above 80% (check against final pricing).

---

## Part 16. Rollout

| Step | When | Gate |
|---|---|---|
| Our own HubSpot and the Perceptric Salesforce sandbox | Week 3 | Sync tests green |
| Our own newsletter from tryclaritia.com | Week 6 | Domain verified, complaint rate tracked |
| 2 design partners with their CRM | Week 14 | All tests green, setup docs ready |
| 5 design partners | Week 15 | 1 week with 0 sync loops, 0 doubled contacts, complaint rate < 0.1% |

- **Feature flag:** `workspaces.features` gets `crm`, `email`, `workflows`, `agents` so each part turns on alone.
- **Kill switches:** pause sync per connection, pause sending per workspace (`send_limits.paused`), pause a workflow, and a global `app_config.sends_paused`.

---

## Part 17. Open checks before week 1

| Check | Owner |
|---|---|
| HubSpot app rate limits and webhook limits for public apps | Build, on HubSpot's developer pages |
| Salesforce: CDC availability per edition, and the Composite API limits | Build, with a Developer org |
| SES production access, sending rate and dedicated IP price in ap-northeast-1 | Founder |
| Whether Conversion's warehouse triggers are a selling point for our first customers, or can wait | Founder, with design partners |
| Omniscient one-click connect ready by week 3 | Omniscient repo |

---

## Part 18. Definition of done

- Every item in 1.2 works for a design partner on their live CRM.
- All Part 13 tests pass in CI.
- For 7 days on live data: 0 sync loops, 0 doubled contacts, 0 sends to suppressed addresses, complaint rate < 0.1%.
- Costs in `ai_calls` and vendor usage match Part 15 within 20%.
