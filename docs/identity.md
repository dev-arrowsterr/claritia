# Identity stitching

How Claritia ties visits to people and accounts. This is part of M1 (Website Intelligence) and feeds every agent after it.

## The rule above all others

A wrong link costs more than a missing link. If Claritia tells a rep "Jane read the pricing page" and it was her coworker, the rep looks creepy and wrong in front of a buyer. So:

- We only merge on hard proof. Guesses are kept as "probable" and shown with that tag.
- Agents only act on links that are Verified or Asserted (defined below). They never email anyone based on a Probable link.
- Every link can be undone, because links are rebuilt from a log of evidence.

## The pieces

| Thing | What it is | Example |
|---|---|---|
| Device | One browser on one site, known by the `_clr_id` cookie | Jane's Chrome at work |
| Session | One visit from a device, ends after 30 minutes idle | Tuesday 10:02 to 10:19 |
| Identifier | A hard ID for a person | `jane@acme.com`, HubSpot contact 501, app user `u_88` |
| Person | One human, made of one or more identifiers | Jane |
| Account | One company, known by its main domain | acme.com |
| Evidence | One record that says "this device showed this identifier at this time, from this source" | Form submit on /demo |

Devices link to people. People link to accounts. Sessions get an account from IP when no person is known.

## Evidence levels

| Level | Sources | Can merge people? | Can link a device? | Agents may act? |
|---|---|---|---|---|
| Verified | `claritia.identify()` with a server-signed token; HubSpot contact found by `hubspotutk` | Yes | Yes | Yes |
| Asserted | Form submit, chat email, meeting booking, gated content form | Yes, on the same identifier only | Yes | Yes |
| Inferred | Click on a tracked email link (`clr` token) | No | Only on a fresh device with no person | No |
| Never used | IP address alone, browser fingerprint, third-party identity graphs | No | No | No |

**Why email clicks are only Inferred:**
- Emails get forwarded. A coworker who clicks a forwarded link carries the first person's token.
- Email security scanners open every link.
- Reps click their own links when they check their sent mail.

## Identifiers and how we clean them

| Kind | How it's cleaned | Notes |
|---|---|---|
| Email | Trim, lowercase. For gmail.com, googlemail.com, outlook.com, hotmail.com, icloud.com and fastmail.com, also remove `+tag`. Remove dots too, for Gmail only. | We keep the raw value as well as the cleaned one. |
| HubSpot contact | The HubSpot contact id, as a string | After a HubSpot merge, the old id points to the new one. |
| App user | The customer's own user id from `identify()` | Scoped to the workspace |

**Role inboxes** (`sales@`, `info@`, `team@`, `hello@`, `support@`, `admin@`, `billing@`, `marketing@`, `office@`, `contact@`):
- Marked as shared.
- They link to an account only, never to a person.
- A device that shows one stays linked to no person.

**Free email domains** (gmail.com, yahoo.com, outlook.com and the rest, from a maintained list):
- The person gets no account from the email.
- The account comes from HubSpot's company link, or stays empty.

## The five stitching rules

### Rule 1. People merge only on a shared identifier

Two people merge only when they hold the same identifier:
- the same cleaned email,
- the same HubSpot contact id,
- or the same app user id.

Any one of these merges them.

Some things never cause an automatic merge:
- the same device,
- the same name,
- the same IP,
- or the same company.

A person can hold two emails (work and personal) only when one piece of evidence carries both at once:
- an `identify()` call that sends both,
- or a HubSpot contact with `hs_additional_emails`.

Same name, same account and a different email becomes a merge **proposal**. A human approves or denies it on the Person page.

### Rule 2. A device links to one person at a time, with dates

`device_links` has `from_at` and `to_at`. A device can belong to Jane in March and to Raj in April. Each session goes to whoever held the device at that time.

When a device with no person gets Verified or Asserted evidence:
- Link it from that moment on.
- **Backfill:** past anonymous sessions on that device from the last 90 days also go to that person, as long as the device was never linked to anyone else.

When a device that belongs to Jane gets Verified or Asserted evidence for Raj:
- Close Jane's link at that moment and open Raj's.
- Mark the device **shared**. Raj gets no backfill.
- Later anonymous sessions on a shared device go to the latest person as **Probable**. Agents don't act on them.

When a device that belongs to Jane gets Inferred evidence for Raj (Raj's email link was clicked):
- The device stays Jane's.
- That one session is tagged "Raj's link was opened here" as Probable. It counts toward the account, and for Raj only as Probable.

### Rule 3. Too many identities means the device is tainted

If a device shows 3 or more different people in 24 hours, mark it **tainted** and stop linking it to anyone. Its sessions count for the account only. This covers:
- a kiosk or demo laptop at a trade show,
- a rep testing their own forms,
- someone typing fake emails.

### Rule 4. Internal traffic is removed before stitching

A device is marked **internal** when any of these happen:
- it shows an email on the workspace's own domains;
- it comes from an office IP the team listed;
- a teammate opens a one-time "this is me" link from Claritia settings;
- a teammate has the Claritia Chrome extension signed in.

Internal devices are never linked to a prospect. Their events don't count toward scores. Email link clicks from internal devices are dropped. This stops a rep's own clicks from linking to the prospect.

### Rule 5. Logouts and resets start a new device

`claritia.reset()` on logout makes a new `_clr_id`, the same way Segment and PostHog handle it. This keeps shared computers clean. The docs for the customer's developers say to call it on logout.

## How each source works

### `claritia.identify()` (Verified)

```js
claritia.identify({ userId: "u_88", email: "jane@acme.com", token: "<hmac from your server>" })
```

- `token` is HMAC-SHA256 of `userId + email` with the workspace's identify secret. The customer's server makes it at login, the same way Intercom and Crisp verify identity.
- With a valid token, the evidence is Verified. With no token or a bad one, it drops to Asserted.
- Without signing, anyone could type `claritia.identify("ceo@acme.com")` in the browser console and attach their own visits to the CEO.

### Forms (Asserted)

- `claritia.js` watches `submit` events. It reads the first field that looks like an email (`type=email`, or a name or id with "email" in it).
- It sends the email with the device id and the form's page and id. Password fields are never read.
- HubSpot forms, Marketo forms and Calendly bookings get small adapters that read the email from their success events.
- A form email that fails a basic check (no `@`, no dot after it, a known throwaway domain) is dropped.

### HubSpot cookie (Verified)

- `claritia.js` reads the `hubspotutk` cookie when present and sends it with the session.
- The agent worker looks up the contact for that cookie through HubSpot's API, then caches the answer for 24 hours. The exact endpoint is "check": the old v1 contact-by-utk call may be retired.
- The contact id becomes Verified evidence, since HubSpot made that link from its own form submit.

### Tracked email links (Inferred)

- Links in emails sent through Claritia's Action Agent carry `?clr=<token>`.
- The token holds the contact id, the email id and an expiry 30 days out, signed with HMAC.
- On page load, `claritia.js` reads the token and then strips it from the URL with `history.replaceState`. If the visitor copies the URL and shares it, the token doesn't travel with it.
- A click is dropped when any of these is true:
  - it happens within 60 seconds of sending;
  - it comes from a data center IP;
  - the session shows no human action (no scroll, no pointer move, no key press) within 30 seconds;
  - the device is internal;
  - the token is past its expiry or its signature fails.

### HubSpot webhooks

| Webhook | What we do |
|---|---|
| `contact.merge` | Merge the two people that hold those contact ids. |
| `contact.deletion` | Remove the identifier. A person with no identifiers left drops back to anonymous devices. |
| `contact.privacyDeletion` | Full erasure (see below). |
| `contact.propertyChange` on `email` | Add the new email as an identifier on the same person. |

## Cross-domain and cookie life

| Case | Fix |
|---|---|
| Subdomains (`www.`, `app.`, `docs.`) | The cookie is set on the registrable domain (`.acme.com`), found with the Public Suffix List. |
| Different domains (`acme.com` and `acme.io`) | Links between listed domains get a short-lived signed `_clr_x` param that carries the device id. It's read and stripped on landing, and expires after 2 minutes. |
| Claritia-hosted pages (M4, M5) | Served on the customer's domain (`go.acme.com`), so the cookie is shared. On `go.tryclaritia.com`, the cross-domain param is used. |
| Safari script cookie limit (7 days) | The cookie is set by the server on a path proxied through the customer's own site (for example `/_clr/*` rewritten to collect). Safari treats a CNAME to another company's IP more strictly, so the same-site proxy path is the main setup and the CNAME is the backup. Exact Safari limits are "check" in testing. |
| Cookie lost, localStorage still there | The id is restored from localStorage. |
| Both lost | It's a new device. It gets linked again on the next form, login or click. |

## Consent

| State | What happens |
|---|---|
| No consent (or consent denied) | Cookieless mode: a daily hash of IP, user agent and a salt that changes daily. No device id is kept, and the session is never stitched or backfilled. It counts for the account by IP only. |
| Consent given | A device id is set from that moment. Earlier cookieless sessions are never linked to it. |
| Consent taken back | The cookie and localStorage id are deleted and linking stops. Past data stays until an erasure request comes in. |

Consent is read from Google Consent Mode v2 (`analytics_storage`), OneTrust, Cookiebot, or a direct `claritia.consent(true|false)` call.

## Accounts

A session's account comes from the first match in this order:

1. The person's HubSpot company link.
2. The person's work email domain, through the domain alias table.
3. The session's IP lookup, when the vendor marks the IP as a business with high confidence. IPs marked as VPN, hosting, mobile carrier or coworking space are skipped.
4. No account.

Details:
- **Domain aliases:** `acme.com`, `acme.co.uk` and `acmecorp.com` map to one account. Aliases come from HubSpot company domains (`domain` plus `hs_additional_domains`) and from enrichment.
- **IP account is per session.** A laptop moves between home and office, so the IP account is never stored on the device.
- **When person and IP disagree** (Jane at acme.com visits from Globex's network), the person's account wins. The session also notes "seen from Globex network". This happens with consultants and partners and is useful to see.
- **Agencies and consultants:** a person whose email domain is on the team's partner list counts toward the account they visit for, never toward their own firm's account.
- **Parent companies:** off by default. A team can choose to roll subsidiaries up to a parent.

## Data model

```
devices          (id, workspace_id, site_id, first_seen, last_seen, internal, shared, tainted, consent)
sessions         (id, workspace_id, device_id, started_at, ended_at, ip_net, ip_account_id, ip_confidence,
                  person_id, person_level, account_id, account_source)
events           (id, workspace_id, session_id, kind, url, data, client_at, server_at)       -- partitioned monthly
persons          (id, workspace_id, created_at, display_name, primary_email, account_id, merged_into)
identifiers      (id, workspace_id, person_id, kind, value_raw, value_clean, value_hash, shared_role)
                  unique (workspace_id, kind, value_clean)
identity_evidence(id, workspace_id, device_id, session_id, level, source, identifier_kind, value_clean,
                  extra jsonb, client_at, server_at, ip_net, revoked_at)                    -- append only
device_links     (id, workspace_id, device_id, person_id, level, from_at, to_at)
person_aliases   (old_id, new_id)
merge_proposals  (id, workspace_id, person_a, person_b, reason, status, decided_by, decided_at)
account_domains  (workspace_id, domain, account_id, source)
```

Key points:
- `identity_evidence` is the only source of truth. `persons`, `identifiers`, `device_links` and the `person_id` on sessions are all built from it.
- A full rebuild for one workspace must give the same result as building step by step. This is tested.
- Order is fixed by `(server_at, id)`. The time a browser reports is kept but never trusted for ordering, since clocks are wrong and batches arrive late.
- `person_aliases` keeps old person ids working after a merge. Links, briefs and API calls follow the alias to the survivor. The older person always survives.
- Events store `session_id` only. The person is resolved through the session, so a merge or split only updates sessions, never millions of event rows.
- Emails are stored in plain text, behind RLS, for the Action Agent to send to. `value_hash` (SHA-256) is used for lookups and for erasure matching.

## The stitching job

- Every new evidence row adds a `stitch` job to the queue with `workspace_id` and `device_id`.
- The job takes a Postgres advisory lock on `(workspace_id, identifier)` for each identifier involved, so two jobs can't merge the same person at once.
- The job applies the five rules, writes `device_links`, updates `sessions.person_id`, and adds an `identity_changed` job for each person it touched.
- `identity_changed` makes scoring (M3), attribution (M2) and the orchestrator (M7) look at that person and account again.
- The job is safe to run twice: running it again on the same evidence changes nothing.
- A nightly rebuild for each workspace checks against the live tables and reports any drift.

## Undo

- **Unmerge or unlink** from the Person page. The evidence rows that caused the link are marked `revoked_at`, and the person's whole connected group is rebuilt.
- **Revoked evidence** is kept for the audit log. It's left out of the rebuild.
- **Agents:** any action an agent took using a link that was later undone is listed on the Person page, so the rep can follow up.

## Erasure (GDPR, CCPA)

A request by email, from the Person page or a HubSpot privacy deletion:

1. Find the person by `value_hash`.
2. Delete the person's identifiers, evidence, `device_links`, merge proposals and briefs.
3. Delete the events of every device that was ever linked to that person, along with those devices.
4. Write a deletion record that holds only the hash and the date. If the same email shows up again, it starts fresh with no history.

The customer is the controller and Claritia is the processor. The DPA states this.

## What the screens show

- **Person page:** each identifier with its level as a square tag (Verified, Asserted, Probable), devices with their date ranges, and an evidence list ("Form on /demo, 3 Nov 10:04").
- **Account page:** known people, plus "unknown visitors from this account".
- **Unmerge and Unlink** buttons, using the app's own dialogs.
- **Merge proposals** with Approve and Deny buttons.

## Tests

Each case runs in a real browser with `claritia.js` against a local site, the same way as `scripts/recorder-check.ts`.

| Case | Expected |
|---|---|
| Jane browses, then fills the demo form | Her last 90 days of sessions on that device are hers, at Asserted. |
| Jane's email link is forwarded to Raj, and Raj clicks it on his laptop | Raj's device links to Jane only as Probable. No agent action. Once Raj fills a form, his device becomes Raj's. |
| Security scanner opens the link 5 seconds after send | Dropped |
| Rep clicks the link in their sent folder | Dropped (internal device) |
| Jane and Raj share one computer and both fill forms | Device marked shared. Each gets only their own sessions, and Raj gets no backfill. |
| Trade show laptop with 6 different emails | Device marked tainted. No person links. |
| `identify()` called from the console with no token | Asserted, never Verified |
| Token-carrying URL is copied to another browser | Token was stripped. No link. |
| HubSpot merges two contacts | The two people merge, and the older id survives. |
| Unmerge | Rebuild gives two people. Sessions go back to their owners. |
| Events arrive out of order and late | Same result as in order |
| Full rebuild vs step-by-step build on 10,000 random evidence rows | Same tables |
| Cookie dropped, localStorage kept | Same device |
| Consent denied, then given | Earlier sessions never linked |
| Erasure | No row anywhere holds the email or the person's events. |
| gmail `J.ane+news@gmail.com` and `jane@gmail.com` | One person |
| `sales@acme.com` fills a form | Account link only, no person |

## Numbers to watch

- Share of sessions with a person, by level.
- Share of devices marked shared or tainted (a jump points to a bug or a kiosk).
- Unmerges per week. Each one is a wrong link, so the target is near zero.
- Merge proposals waiting.
- Email link clicks dropped, by reason.

## Monthly cost

Stitching makes no AI calls. It runs on the `claritia-agent` worker and stores rows in Supabase, both already counted in M1. The HubSpot API is free with the customer's plan.

| Stage | Added cost |
|---|---|
| Beta (50 teams) | $0 beyond M1 |
| Growth (500 teams) | $0 beyond M1. Evidence and links are small next to events: about 2 GB a year at Growth, inside the Supabase plan in M1 (check). |
