# Website intelligence: identity stitching, full spec

How Claritia turns raw website visits into known devices, people and accounts, without ever linking the wrong person and without breaking privacy law. This spec covers everything from the browser cookie to the database rebuild. Compliance rules come from `docs/account-intelligence.md` Part 3, and this doc applies them to identity.

---

## Part 1. Goals

### 1.1 The rule above all others

**A wrong link costs more than a missing link.** If a rep says "Jane read the pricing page" and it was her coworker, the rep looks creepy and wrong in front of a buyer. Every rule below follows from that.

- Merges need hard proof. Guesses are kept, but tagged Probable, and agents never act on them.
- Every link can be traced to the evidence that made it, and undone.
- When two rules disagree, the stricter one wins.

### 1.2 Targets

| Measure | Target | Definition |
|---|---|---|
| Person link precision | ≥ 99% | Verified and Asserted device-to-person links that are right, from unmerges plus a monthly hand audit |
| Person merge precision | ≥ 99.5% | Person merges that are never undone |
| Identified session share | 8–20% of non-bot sessions (depends on the site) | Sessions with a Verified or Asserted person |
| Account session share | ≥ 30% of non-bot B2B sessions | Sessions with an account from a person or network |
| Evidence to link | ≤ 5 s p95 | Evidence stored to `device_links` updated |
| Rebuild equals live | 100% | Nightly check, rows that differ = 0 |
| Policy breaches | 0 | Identity rows made where the region policy, consent or GPC forbids them |

### 1.3 What we never do

- **Browser fingerprinting.** No canvas, fonts, audio or WebGL hashes, and no combining many browser traits into an ID. It's unreliable, regulators treat it as tracking needing consent, and browsers fight it.
- **Third-party identity graphs, hashed-email matching from data co-ops, or partner cookie syncs.** Every person link comes from the customer's own first-party sources.
- **Linking across customers.** The same human on Customer A's and Customer B's sites stays two unrelated records. There's no shared person table.
- **Recording keystrokes or form fields before submit.**

---

## Part 2. Words and model

### 2.1 Terms

| Term | Meaning |
|---|---|
| Site | One customer website (with its extra domains), with its own site key |
| Device | One browser profile on one site, known by `_clr_id` |
| Session | One visit from a device. It ends after 30 minutes idle. |
| Event | One thing in a session: a view, engagement ping, click, form submit, identify or custom event |
| Identifier | A hard key for a person: an email, a customer app user id, or a HubSpot contact id |
| Evidence | One record that a device showed an identifier at a time, from a source, at a level |
| Person | One human inside one workspace. Built from identifiers. |
| Device link | A dated link from a device to a person |
| Account | One company inside one workspace. Built from domains. |
| Network | An IP block (/24 for IPv4, /48 for IPv6) |
| Level | How sure we are: Verified, Asserted, Inferred (Part 5) |

### 2.2 The model

```
   Identifier ──belongs to──► Person ◄──dated link── Device ──has── Session ──has── Event
       ▲                        │                       ▲              │
       │                        └─works at─► Account ◄──┼──by network──┘
   Evidence ────────────────────────────────────────────┘
   (append only, the only source of truth)
```

- Evidence is written once and never edited. It can only be revoked.
- Persons, identifiers, device links, and the person and account on each session are all **derived**. They can be wiped and rebuilt from evidence at any time, with the same result.

---

## Part 3. Compliance gates for identity

The region policy engine (`docs/account-intelligence.md` 3.2) sets one policy per session. Identity work checks the policy before doing anything.

| Policy and state | Device cookie | Evidence stored | Person links | Backfill | Network account |
|---|---|---|---|---|---|
| `strict`, no consent yet | No | No | No | No | No |
| `strict`, consent given | Yes | Yes | Yes | Only sessions after consent | Yes |
| `notice` | Yes | Yes | Yes | Yes (90 days) | Yes |
| Any region, GPC on | No | No | No | No | For page stats only (never shown at person level) |
| Any region, consent denied | No | No | No | No | No in `strict`. For page stats only in `notice`. |
| Any region, opted out | No (an opt-out cookie only) | No | No | No | No |
| `off` | No | No | No | No | No |

**Consent changes:**

| Change | What happens |
|---|---|
| Consent given mid-session | A new device id is set from that moment. Cookieless sessions before it are never linked. |
| Consent taken back | `claritia.consent(false)` or the consent tool's event deletes `_clr_id`, the localStorage copy and `_clr_s`. The device is marked `consent_withdrawn` and gets no new events. Past data stays until erasure is asked for (withdrawal doesn't undo lawful past processing under GDPR). Agents stop acting on that person at once. |
| GPC turns on for a known device | The next request sees GPC, so the device is treated as opted out from then on. The person stays known from past evidence, but gets no new events. |
| Opt-out link used | `_clr_opt=1` is set on the site's domain and the device id is suppressed server-side. The person is marked `opted_out` for this site, and outreach suppression is added (M6). |

**Purpose:** identity data is used only for the customer's own sales and marketing views and actions inside Claritia and their own HubSpot. It's never used to build any product across customers, and never sold.

---

## Part 4. Device identity in the browser

### 4.1 The device id

- **Format:** `v1.<uuid v7>.<sig>`. The uuid is 128 bits, with 74 of them random. `sig` is the first 8 bytes of HMAC-SHA256(site secret, uuid), base64url encoded.
- **Why signed:** the server ignores ids it didn't make, so nobody can plant a crafted id to mix their visits into someone else's device.
- **Why uuid v7:** the time prefix makes the id sort by creation time, which keeps indexes tidy. The random part makes it impossible to guess.
- **Made by the server**, never by the script, in every mode except the CNAME fallback (4.3).

### 4.2 How browsers treat storage (as of Oct 2026; check every quarter)

| Browser | Cookie set by script (`document.cookie`) | Cookie set by a server on the same site | localStorage | Notes |
|---|---|---|---|---|
| Chrome, Edge | Up to the Max-Age we set (Chrome caps all cookies at 400 days) | Same | Kept | Third-party cookies still exist. We don't use them. |
| Safari (macOS, iOS), and all iOS browsers (WebKit) | Capped at 7 days | Full life if the server is truly same-site. Capped at 7 days if Safari sees it as a cloaked third party (CNAME to another company) or, per vendor reports, a server IP that differs from the site's (check WebKit's current rules) | Wiped after 7 days with no visit | The biggest reason for the proxy setup |
| Firefox (standard tracking protection) | Kept | Kept | Kept | Total Cookie Protection splits third-party storage by site, which doesn't affect first-party storage. Strict mode strips known tracking query params (our params aren't on the lists; check yearly). |
| Brave | Kept, but Shields can block known tracker scripts and domains | Kept | Kept | Our script on the customer's own domain path is less likely to be blocked. Brave strips listed query params. |
| In-app browsers (LinkedIn, X, Slack on iOS and Android) | Often a separate cookie jar, reset often | Same | Same | Each in-app open is often a new device. Stitching fixes it when they identify. |
| Private windows (all) | Wiped when the window closes | Same | Same | A new device each time |

### 4.3 Install modes, best first

| Mode | How | Cookie life in Safari | Setup |
|---|---|---|---|
| **A. Same-site proxy path (default)** | The customer's own server forwards `/_clr/*` to collect. The browser only ever talks to `acme.com`. | Full (13 months) | Recipes below. 5–10 minutes. |
| **B. Subdomain with an A record** | `t.acme.com` points to Claritia's IPs with an A or AAAA record. | Limited if Safari treats the IP as third party (check). Better than C. | DNS only |
| **C. CNAME subdomain** | `t.acme.com` is a CNAME to `collect.tryclaritia.com`. | 7 days (cloaking defense) | DNS only |
| **D. Direct** | The script and events go to `collect.tryclaritia.com`. | 7 days for the script's cookie. The server cookie is third party and not used. | Paste one tag |

The script detects which mode it's in, and Settings shows the mode with a warning on C and D: "Safari visitors are forgotten after 7 days. Set up the proxy path."

**Proxy recipes (shipped as copy-paste guides in Settings):**

| Platform | Recipe |
|---|---|
| Next.js | `next.config.js` `rewrites`: `{ source: '/_clr/:path*', destination: 'https://collect.tryclaritia.com/:path*' }` |
| Vercel (any framework) | `vercel.json` `rewrites` with the same rule |
| Netlify | `_redirects`: `/_clr/*  https://collect.tryclaritia.com/:splat  200` |
| Cloudflare (any site behind it) | A Worker on route `acme.com/_clr/*` that forwards the request, adding `X-Clr-Client-IP` from `CF-Connecting-IP` and passing cookies |
| Nginx | `location /_clr/ { proxy_pass https://collect.tryclaritia.com/; proxy_set_header X-Clr-Client-IP $remote_addr; proxy_set_header Host collect.tryclaritia.com; }` |
| WordPress | The Claritia plugin registers a REST route that forwards `/_clr/*` (PHP, with the IP header) |
| Webflow, HubSpot CMS, Squarespace, Wix | No server-side rewrites, so use mode B or C. Or put Cloudflare in front and use the Worker. |

**Client IP through the proxy:**
- The proxy adds `X-Clr-Client-IP`.
- Collect trusts that header only when the request carries the site's proxy secret header (`X-Clr-Proxy: <secret>`), which is set in the recipe. Without the secret, collect uses the connecting IP. This stops visitors from faking their IP.

### 4.4 Cookies we set

| Name | Value | Attributes | Life | Purpose |
|---|---|---|---|---|
| `_clr_id` | Signed device id | `Domain=<registrable domain>; Path=/; Secure; SameSite=Lax; HttpOnly` (modes A and B), or no HttpOnly (C and D, where the script must read it) | 13 months from creation, never extended past that. Re-sent on each visit so the browser keeps it. | Device |
| `_clr_s` | Session id and last-seen time | Same, but 30 minutes, renewed on each event | 30 min | Session continuity across tabs |
| `_clr_opt` | `1` | Same | 5 years | Opt-out |
| `_clr_c` | Consent state as Claritia last saw it | Same | 13 months | Detect consent changes between visits |

- In `strict` regions the 13-month life matches the common EU guidance for consent cookies. The consent is asked again after 13 months by the customer's consent tool, so the device id is set again then.
- **localStorage copy** `_clr_id` (modes C and D only): if the cookie is gone but the copy is valid and signed, the script sends it and the server restores the cookie. Safari wipes both after 7 days without a visit, so this mostly helps when a user clears cookies alone.

### 4.5 Device id lifecycle

| Moment | What happens |
|---|---|
| First request with no `_clr_id`, policy allows a device | The server makes an id, sets the cookie and creates the `devices` row on the first event |
| Every later request | The server checks the signature. Bad or unknown means a new id (logged as `bad_id`). |
| `claritia.reset()` (the customer calls it on logout) | The server issues a new id and closes any device link at that moment. The old device keeps its history. |
| 13 months since creation | The cookie expires and the next visit gets a new device |
| Opt-out or consent withdrawn | Cookies deleted, device marked, no new events |
| Erasure | Device rows and their events deleted (Part 15) |

### 4.6 Sessions

- **A new session starts when:**
  - there's no `_clr_s`, or it's older than 30 minutes;
  - the UTM campaign changes from the session's campaign (same rule as GA, so attribution stays clean);
  - the device link changes mid-session (Part 7.6). The session is split at that moment;
  - or 12 hours pass in one session (very long tabs).
- Midnight doesn't split sessions.
- **Tabs:** all tabs share `_clr_s`, so two tabs make one session.
- **Back-forward cache:** `pageshow` with `persisted` sends a new `view`, which continues the session if it's under 30 minutes.
- **Prerender:** while `document.prerendering` is true, nothing is sent. The first `view` goes out on `prerenderingchange`.
- **iframes:** the script does nothing inside iframes, except Claritia's own asset viewer (M4).

### 4.7 Cross-domain

For a customer with `acme.com` and `acme.io` (both listed in Settings):

1. On a click to a listed other domain, the script asks `/_clr/x` (same-site) for a hop token. The server returns `t = base64url(device_id_uuid | expiry 120 s | nonce) + HMAC`.
2. The script adds `_clr_x=<t>` to the link right before the browser follows it (on `mousedown`, `keydown` Enter and `touchstart`). Links aren't rewritten in advance, so a copied URL doesn't carry it.
3. On the other domain, the script sends `_clr_x` with the first event and then strips it from the URL with `history.replaceState`.
4. The server checks the HMAC, the expiry, and that the nonce wasn't used before (`hop_nonces`, kept 10 minutes). If all pass, it sets that domain's `_clr_id` to the same device uuid, signed for that site.
5. If the param was stripped by the browser or the token expired, the visitor becomes a new device on the second domain. It gets joined later through identity evidence. Same person, two devices, which is fine.

Claritia-hosted pages (M4 and M5) on `go.acme.com` share the cookie because they're on the same registrable domain. On `go.tryclaritia.com`, the hop token is used.

### 4.8 Cookieless mode

Used when the policy forbids storage (Part 3):
- Session key = HMAC(daily salt, site_id | ip_net | user agent | accept-language). The salt is random per day, kept only in collect's memory and in a `salts` row deleted after 24 hours.
- Nothing is stored in the browser. No device row, no evidence, no person.
- Events count for page stats (M2 rollups) only.
- Form submits in cookieless mode send nothing to Claritia. The customer's own form tool still gets the form.

### 4.9 What the script sends for identity

| Field | When | Notes |
|---|---|---|
| Nothing for the id | Modes A and B | The HttpOnly cookie goes with the request |
| `did` (signed id) | Modes C and D | Read from the cookie or localStorage |
| `consent` | Every batch | `granted`, `denied` or `unknown`, plus which tool |
| `gpc` | Every batch | `navigator.globalPrivacyControl` |
| `hutk` | First batch of a session | The `hubspotutk` cookie, if present. Never sent in `strict` before consent. |
| `clr` | First batch after landing | Email link token (5.6) |
| `_clr_x` | First batch after a hop | Hop token (4.7) |
| `human` | With the first `engage` | `{pointer: n, scroll: n, keys: n, first_input_ms}`, counts only (never which keys) |
| Evidence events | On submit or identify | Part 5 |

---

## Part 5. Evidence sources

### 5.1 Levels

| Level | Meaning | Can merge people | Can link a device | Backfill | Agents may act |
|---|---|---|---|---|---|
| **Verified** | Proven by a system that authenticated the person | Yes | Yes | Yes | Yes |
| **Asserted** | The person typed or chose it themselves, in a way that's hard to fake by accident | Yes, on the same identifier | Yes | Yes | Yes |
| **Inferred** | A strong hint that someone else could have triggered | No | Only a fresh device, as Probable | No | No |

**Probable** is a state, not a source. A link made from Inferred evidence, or a later session on a shared device, is Probable.

### 5.2 `claritia.identify()` with a signed token (Verified)

**On the customer's server, at login:**

```
iat   = unix seconds now
token = base64url(HMAC_SHA256(identify_secret, "v1|" + site_id + "|" + user_id + "|" + lower(email) + "|" + iat))
```

**In the page:**

```js
claritia.identify({ userId: "u_88", email: "jane@acme.com", iat: 1760000000, token: "..." })
```

**On our server:**
- Recompute and compare in constant time.
- `iat` must be within 24 hours.
- Each workspace has 2 secrets (current and next) for rotation.
- Pass: Verified evidence for both `user:u_88` and `email:jane@acme.com`, recorded as one evidence row that ties both identifiers together (a hard edge, Part 7.1).
- Fail: the call is downgraded to the unsigned path (5.3), and `bad_token` is logged.

Server libraries are shipped for Node, Python, Ruby, PHP and Go: one function, `claritiaToken(userId, email)`.

### 5.3 `claritia.identify()` without a token (Asserted, limited)

- Allowed so customers can start fast.
- Stored as Asserted, with `unsigned` in `extra`.
- Rule: unsigned identify can't create a tie between two identifiers (no hard edge between a userId and an email). It only links the device to one identifier.
- Anyone can type it in the browser console, so the tainted rules (7.4) watch it closely: 2 different unsigned identities on one device in 24 hours marks the device tainted.

### 5.4 Form submits (Asserted)

**Listener:** the `submit` event on `document`, in the capture phase.
- React, Vue and plain forms all fire it.
- Forms that submit with `fetch` from a button click and never fire `submit` need a `data-clr-form` attribute on the button, or a `claritia.form(email)` call. Both are in the install guide.

**Finding the email field, in this order:**
1. `input[type=email]`
2. `[autocomplete=email]`
3. A `name` or `id` matching `/e-?mail/i`
4. A text input whose value matches the email pattern and whose label says "email"

Only the first match is read. Every other field is ignored and never leaves the browser.

**Never read**, even if matched: fields with `type=password`, `autocomplete` of `cc-*`, `new-password` or `one-time-code`, or `data-clr-ignore`.

**Server checks:**

| Check | Fail means |
|---|---|
| Syntax: one `@`, a dot in the domain, length ≤ 254, no spaces | Dropped |
| Domain has MX or A records (DNS lookup, cached 7 days per domain) | Dropped (catches `gmial.com`) |
| Disposable email domain list | Dropped |
| Role inbox list (`sales@`, `info@` and the rest) | Kept as an account hint only (Part 6.3) |
| The same device sent 3+ different emails in 24 hours | Device tainted (7.4) |

**Platform adapters** (they read the email from the platform's success event, which is more reliable than our own listener):

| Platform | Event |
|---|---|
| HubSpot forms | `message` event with `type: 'hsFormCallback'`, `eventName: 'onFormSubmitted'`, reading the email from `submissionValues` (check the payload on the current embed) |
| Marketo | `MktoForms2.whenReady(form => form.onSuccess(values => …))` |
| Pardot | Form handler success page `?clr_email=` is not used. A same-page `claritia.form()` snippet instead. |
| Typeform, Tally | Their embed SDK `onSubmit`, using the hidden field for the response id, with the email fetched server-side through their API when the customer connects it (check) |
| Calendly | `message` with `event: 'calendly.event_scheduled'` gives the invitee URI. Our server fetches the invitee's email through the customer's connected Calendly (check scopes). |
| HubSpot Meetings | The embed's booked message (check the payload) |
| Chili Piper | Its booking callback (check) |

### 5.5 HubSpot `hubspotutk` (Asserted)

- The script sends `hutk` once per session (never in `strict` before consent).
- The `hutk_lookup` job calls HubSpot's documented contact-by-usertoken method (`/contacts/v1/contact/utk/:utk/profile`). It's legacy v1, and its future is unclear (check before launch).
- Results cached per `hutk` for 24 hours. A 404 means not a contact yet, cached 6 hours.
- **Level is Asserted, not Verified.** HubSpot community threads report wrong contacts coming back for some cookies, and the cookie can be shared by everyone on a shared computer.
- If v1 is retired, we drop this source. Our own form capture already records the email at the moment a HubSpot form is submitted with Claritia on the page, which covers most of the value.

### 5.6 Tracked email links (Inferred)

**The token:** links in emails sent through Claritia (M6) get `?clr=<t>`.

`t = base64url(ver | workspace | contact_id | email_id | link_idx | expiry 30 d) + HMAC (16 bytes)`

**Landing:**
1. The script reads `clr`, strips it with `replaceState`, and sends it with the first batch.
2. The server checks the HMAC, the expiry and the workspace.
3. The token is held as pending for up to 30 seconds while the session proves it's human (step 4). Only then is it written as evidence.

**Human proof (all must pass):**
- The script ran (scanners that only fetch HTML never send a batch).
- At least one pointer move, scroll or key press within 30 seconds of load.
- The IP isn't in a data center range. Microsoft 365 and Azure ranges are checked closely, since Safe Links scans come from there.
- The click is more than 60 seconds after the email was sent.
- No more than 3 different links from the same email were opened within 10 seconds (scanners open every link at once).
- The device isn't internal.

**One token, many devices:**
- The first human device to use a token "claims" it, and gets Inferred evidence for that contact.
- Any other device that uses the same token later gets it as Probable and marks the token `forwarded`.
- A forwarded token never adds evidence again. The account still gets a `email_click` signal.

**What it can do:**
- On a fresh device (never linked), it makes a Probable link to the contact. The device's sessions show under that person with a Probable tag. Agents don't act on them.
- On a device already linked to the same person, it adds a note and nothing changes.
- On a device linked to someone else, the session gets a note ("Raj's link opened here") and the device stays as it was.
- A later Verified or Asserted evidence for the same contact upgrades the Probable link to that level.

### 5.7 Product login (Verified)

The same as 5.2, called from the customer's app on sign-in. The app's own domain must be in the site's domain list.

### 5.8 Content gates and account pages (M4, M5)

- A gate form is Asserted (same as 5.4), and also posts to HubSpot Forms with `hutk`.
- Per-person account page links (`?p=<token>`) work like email tokens (5.6). They're Inferred, with the same human proof and the same one-token-many-devices rule.

### 5.9 HubSpot CRM data (identifier ties, no device)

- A HubSpot contact with `email` and `hs_additional_emails` gives a hard edge between those emails and the contact id. That's Verified, because HubSpot manages its own records.
- No device link comes from CRM data alone.
- `contact.merge` webhooks tie the two contact ids (Verified).
- `contact.deletion` revokes the CRM evidence for that id.

### 5.10 Evidence summary

| Source | Level | Identifiers | Hard edge between identifiers | Device link |
|---|---|---|---|---|
| Signed identify | Verified | user id + email | Yes | Yes |
| Unsigned identify | Asserted | one | No | Yes |
| Form submit, booking, gate | Asserted | email | No | Yes |
| `hubspotutk` lookup | Asserted | HubSpot contact id (+ its email from CRM) | No | Yes |
| Email link, page link | Inferred | contact id | No | Probable, on fresh devices only |
| HubSpot CRM record | Verified | contact id + emails | Yes | No |
| HubSpot merge | Verified | contact id + contact id | Yes | No |

---

## Part 6. Cleaning identifiers

### 6.1 Emails

1. Trim, remove a `mailto:` prefix and surrounding quotes or angle brackets.
2. Lowercase the whole address. Local parts are case-sensitive in theory, but no real provider treats them that way.
3. Convert international domains to punycode (`IDNA` to ASCII).
4. **Provider rules:**

| Provider domains | Remove `+tag` | Remove dots in local part | Map domain |
|---|---|---|---|
| gmail.com, googlemail.com | Yes | Yes | googlemail.com → gmail.com |
| outlook.com, hotmail.com, live.com, msn.com | Yes | No | No |
| icloud.com, me.com, mac.com | Yes | No | me.com and mac.com → icloud.com (check) |
| yahoo.com | `-tag` is Yahoo's style. Not removed (it's a different mailbox) | No | No |
| fastmail.com, proton.me, protonmail.com | Yes | No | protonmail.com → proton.me (check) |
| All other domains (company domains) | Yes (almost every company mail system treats it as the same box) | No | No |

5. Store `value_raw` (as typed), `value_clean` (the cleaned version, used for matching) and `value_hash` (SHA-256 of the clean value, used for erasure and lookups).

### 6.2 Other identifiers

| Kind | Clean | Scope |
|---|---|---|
| `user` (app user id) | Trim, keep case, max 128 chars | Workspace |
| `hubspot` (contact id) | Digits only | Workspace + portal |
| `calendly_invitee` | Not an identifier. Only used to fetch the email. | — |

Phone numbers, names and LinkedIn URLs are never identifiers. Names are display only.

### 6.3 Special email classes

| Class | How it's found | Effect |
|---|---|---|
| Free email (gmail, yahoo and so on) | A maintained list, about 4,000 domains (from an open list; check its license), updated monthly | A person, but no account from the email |
| Disposable (mailinator and so on) | A maintained list, updated weekly | Dropped |
| Role inbox | Local part in: sales, info, hello, contact, team, support, admin, billing, marketing, office, hr, jobs, careers, press, noreply, no-reply, accounts, finance | No person. Account hint only. The device is not linked. |
| Own domain | Workspace `own_domains` | The device is marked internal (Part 9) |
| Partner domain | Workspace `partner_domains` | A person, flagged partner. Never makes an account of their own. |

---

## Part 7. The stitching algorithm

### 7.1 People are built from hard edges

- Each identifier belongs to exactly one person.
- Two identifiers end up in the same person only through a **hard edge**:
  - one Verified evidence row that carries both (signed identify with userId and email, a HubSpot contact with several emails, a HubSpot merge);
  - or the same `value_clean` (two forms with `Jane@Acme.com` and `jane@acme.com` are the same identifier).
- Devices never connect people. Two identifiers seen on the same device stay as two people. The device link just moves between them over time.
- So a person is a group of identifiers joined by hard edges (a connected component).

### 7.2 Merge guards (stop snowballs)

A hard edge that would join two people is refused, and becomes a `merge_proposal` instead, if after the merge the person would have:
- 2 or more different `user` ids;
- 2 or more different `hubspot` ids, unless HubSpot itself merged them (the `contact.merge` evidence);
- more than 5 emails;
- or emails at 3 or more different company domains.

These cases are almost always data errors (a shared login, a CRM mix-up), and a human decides.

### 7.3 Device states

```
             evidence (V/A)                  evidence (V/A) for another person
   FRESH ──────────────────► LINKED(P) ──────────────────────────────► SHARED
     │                          │   ▲                                    │
     │ Inferred                 │   │ same P evidence                    │ 3+ people in 24 h
     ▼                          │   │                                    ▼
   PROBABLE(P) ─V/A for P──► LINKED(P)                                TAINTED
     │                                                                   ▲
     └── V/A for Q ──► LINKED(Q)                     too many identities ┘
   Any state ── own-domain email / office IP / "this is me" ──► INTERNAL
   Any state ── opt-out / withdraw ──► OPTED_OUT
```

| From | Evidence | To | Effects |
|---|---|---|---|
| Fresh | Verified or Asserted for P | Linked(P) | Open link from now. Backfill (7.5). |
| Fresh | Inferred for P | Probable(P) | Open a Probable link. No backfill. |
| Probable(P) | V/A for P | Linked(P) | Upgrade the link's level from its start. Backfill (7.5). |
| Probable(P) | V/A for Q | Linked(Q) | Close the P link. Open Q from now. The device isn't marked shared, since P was only a guess. |
| Linked(P) | V/A for P | Linked(P) | Note only |
| Linked(P) | Inferred for Q | Linked(P) | The session gets a note. Q gets nothing. |
| Linked(P) | V/A for Q | Shared | Close P at the evidence time. Open Q. No backfill for Q. |
| Shared | V/A for anyone | Shared | Close the current link, open the new one. Anonymous sessions after a switch go to the latest person as Probable. |
| Any | 3+ different people (V/A) or 2 unsigned identifies in 24 h | Tainted | Close all links. Sessions count for the account only. Lasts 30 days, then the device can be linked again. |
| Any | Internal trigger | Internal | Close all links to prospects. Events don't count toward scores or signals. |
| Any | Opt-out or withdrawal | Opted out | No new events |

### 7.4 Tainted details

- Devices used by many people: trade show laptops, shared office kiosks, a rep testing their own forms, bots that fill forms.
- On taint, existing links stay in the record for history, but every session from the taint window on loses its person.
- A team can mark a device "kiosk" by hand. It's tainted forever.

### 7.5 Backfill

When a device first gets a Verified or Asserted link to P (from Fresh, or upgraded from Probable):
- Every earlier session on that device within **90 days** moves to P, if:
  - the device was never Linked, Shared or Tainted before;
  - the session's policy allowed identity (never cookieless, never before consent);
  - and the session wasn't internal or bot.
- Backfilled sessions keep `person_source = 'backfill'`, so the UI can show "before they filled the form".
- Backfill never crosses devices. A second device of the same person only gets its own history when that device gets its own evidence.

### 7.6 Sessions and identity switches

- A session's person is the device link active when the session started.
- If the device link changes mid-session (logout and a new login, or a form for someone else), the session is split at the evidence time. Events after it move to a new session id, linked to the new person.
- `claritia.reset()` always starts a new session.

### 7.7 Processing one evidence row

```
stitch(evidence e):
  if policy(e.session) forbids identity: mark e.ignored('policy'); return
  if device(e).state in (internal, opted_out): mark e.ignored(state); return
  if e.level == inferred: return handle_inferred(e)        -- 5.6 rules, 7.3 table

  lock(sorted([ 'dev:'+e.device ] + [ 'id:'+i for i in e.identifiers ]))  -- advisory xact locks
  ids     = upsert identifiers(e.identifiers)               -- unique (workspace, kind, value_clean)
  persons = distinct person_of(ids)                         -- after following person_aliases
  if len(persons) == 0: p = new_person(ids)
  elif e.hard_edge and len(persons) > 1:
       if guards_ok(persons): p = merge(persons)            -- survivor = oldest (created_at, id)
       else: propose_merge(persons, e); p = person_of(primary identifier of e)
  else: p = person_of(primary identifier of e)
  attach unattached ids to p

  if e.device:
    apply device state table (7.3) with p at e.server_at
    if state became linked from fresh/probable: backfill(e.device, p)  -- 7.5
    split current session if the link changed mid-session              -- 7.6
  enqueue identity_changed(p) and for any person whose links changed
```

- `merge(persons)` moves identifiers, device links and sessions to the survivor, and writes `person_aliases(old → survivor)`.
- `person_of` follows aliases, so ids from an old link still resolve.

### 7.8 Order, repeats and late data

- Evidence is processed in `(server_at, id)` order per lock group. `server_at` is set by collect on arrival, never by the browser.
- **Repeats:** evidence ids are uuid v7 made in the browser, unique by `(workspace_id, id)`, so a retried batch is a no-op.
- **Late data:** a session's events can arrive late (offline tabs), but evidence uses arrival time, so the link timeline never shifts backwards.
- A late event is attached to its session, and its person comes from the session. Nothing needs re-linking.

### 7.9 Rebuild

`rebuild(workspace, scope)`, where scope is a whole workspace or one connected group:

1. Collect the group: all identifiers and devices reachable from the starting person through evidence.
2. Delete the derived rows for that group (identifier → person, device links, the person fields on sessions, and the persons themselves, keeping their ids for alias continuity).
3. Replay non-revoked evidence for the group in `(server_at, id)` order through `stitch`.
4. Old person ids that no longer exist get aliases to the new survivor with the most overlap, so links and URLs keep working.

**Rebuild equals incremental:** a property test makes 10,000 random evidence rows across 500 devices and 300 identifiers. It builds them step by step in random batch sizes, then fully rebuilds, and checks the tables match. It runs in CI.

### 7.10 Concurrency

- Each `stitch` job takes `pg_advisory_xact_lock` on a hash of every device and identifier it touches, always in sorted order (no deadlocks).
- Merges take locks on all identifiers of all persons involved before moving rows.
- Jobs for the same device are keyed `stitch:<device>` in the queue, so they don't run in parallel (the unique key in `jobs`).
- **Throughput target:** 500 evidence rows per second per worker at Growth. Most rows are notes that change nothing and finish fast.

### 7.11 Undo

| Action | What happens |
|---|---|
| Unmerge a person | The hard edges between the chosen identifiers are revoked (`revoked_at`, `revoked_by`, `reason`). The group is rebuilt (7.9). |
| Unlink a device from a person | The evidence rows that linked it are revoked and the group rebuilt. The device becomes Fresh if nothing else links it, and is marked "no backfill" so the same history doesn't jump back. |
| Mark a device as kiosk | The device is tainted forever and rebuilt |
| Approve a merge proposal | A `manual_merge` evidence row (Verified, by user) is added and processed |
| Deny a merge proposal | Saved, so the same pair isn't proposed again |

After any undo, every agent action that used the old link is listed on the Person page for follow-up.

---

## Part 8. Account resolution

### 8.1 A session's account, in priority order

| Priority | Source | `account_source` | Shown as |
|---|---|---|---|
| 1 | The person's HubSpot company link | `crm` | Plain |
| 2 | The person's email domain through `account_domains` (work email only) | `email` | Plain |
| 3 | A network the workspace learned from its own people (8.3) | `learned_network` | "by network" |
| 4 | The IP vendor's match: kind `business`, confidence 70+ | `vendor_network` | "by network" |
| 5 | None | — | "Unknown" with country |

- For Probable people, priorities 1 and 2 still set the account. A wrong guess about the person rarely means a wrong company, since forwards mostly stay inside a company.
- When the person's account and the network's account differ, the person's wins. The session keeps `network_account_id` too, for "seen from Globex network".

### 8.2 IP lookups

- The full IP is used in memory for the geo lookup and the vendor lookup, then dropped.
- **Cache key:**
  - When the vendor says a whole /24 has one owner (most corporate blocks), the cache key is the /24.
  - Otherwise the key is `HMAC(cache_secret, ip)`, kept 30 days and never linked to a session row.
  - This keeps cost down without storing raw IPs.
- **Network kinds:** `business`, `isp`, `mobile`, `hosting`, `vpn`, `education`, `government`, `coworking`.
  - Only `business`, `education` and `government` can set an account.
  - `coworking` never does. One coworking network holds many companies.
- **Refresh:** cached matches expire after 30 days. A network flagged "wrong company" by reps (`docs/account-intelligence.md` 8.5) is re-checked right away and can be blocked for that workspace.

### 8.3 Learned networks (first-party, the best signal)

Each night, for each business network:
- Count distinct Verified or Asserted people per company domain seen on that network in the last 60 days.
- If 3+ people from one domain were seen, and people from other domains make up less than 10%, save `learned_networks(workspace, net, account, people, share)`.
- Learned networks beat the vendor (priority 3 vs 4). They only use this workspace's own visitors, so nothing leaks between customers.
- A learned network that later sees mixed people drops back to the vendor.

This fixes the vendor's biggest weakness (stale or wrong corporate ranges) with the customer's own ground truth.

### 8.4 People with more than one account

- **Consultants and partners:** a person with a partner domain is shown on the account they're visiting for, which is the network account when known. They're never added to the partner's own account.
- **Job changes:** a person whose HubSpot company changes keeps their old sessions on the old account. New sessions go to the new one. The Person page shows both.

---

## Part 9. Internal traffic

Internal devices and sessions are removed before signals, scores and agents. They still count in a separate "internal" line in analytics, so the customer can see them.

| Trigger | Effect |
|---|---|
| Evidence with an email on `own_domains` | Device internal |
| Session IP in `office_ips` | Session internal. The device is internal once 3 of its sessions are. |
| "This is me" link (Settings makes a one-time link for each teammate) | Device internal |
| The teammate's Claritia Chrome extension is signed in | The extension calls `/_clr/internal` on the customer's site with a signed teammate token, and the device becomes internal |
| A teammate is signed in to the Claritia app in the same browser | Doesn't help (a different site), so the extension or the link is needed |
| Email token clicks from internal devices | Dropped (5.6) |
| Preview and staging domains (`*.vercel.app`, `staging.`) | Sessions dropped unless the domain is listed as a site |

---

## Part 10. Abuse and security

| Threat | Defense |
|---|---|
| Someone calls `identify("ceo@acme.com")` in the console to fill the CEO's profile with fake visits | Unsigned identify is Asserted and can't make hard edges. 2 unsigned identities in 24 h taints the device. Signed identify is the default in the install guide. |
| Someone submits forms with other people's emails | Each is Asserted. A device with 3+ emails in 24 hours is tainted. Agents can only act on links that don't share a device with other identities (the Shared state blocks backfill). |
| A planted device id | Ids are signed by the server. Unknown or bad signatures get a new id. |
| A stolen or replayed hop token | 2-minute expiry, one use (nonce), bound to the target site |
| A forwarded email token | One-token-many-devices rule (5.6) |
| Fake client IPs through the proxy header | The header is only trusted with the per-site proxy secret |
| Flooding collect | Size and rate limits, site key and origin checks (`docs/pivot-plan.md` M1) |
| Reading data through collect | Collect has no read endpoints. Every read goes through the authenticated app with RLS. |
| Staff misuse | No standing access. Time-limited, logged support grants. |
| One customer seeing another's data | No shared person tables. RLS. Leak tests. Caches hold company data only. |

---

## Part 11. Data model

```sql
-- devices and sessions (021_web.sql, identity columns)
create table devices (
  id uuid primary key,                         -- uuid from the signed id
  workspace_id uuid not null, site_id uuid not null,
  state text not null default 'fresh',         -- fresh, probable, linked, shared, tainted, internal, opted_out
  state_since timestamptz not null default now(),
  tainted_until timestamptz, no_backfill bool not null default false,
  consent text, first_seen timestamptz, last_seen timestamptz, sessions int default 0
);
create index on devices (workspace_id, state);

create table sessions (
  id uuid primary key, workspace_id uuid not null, site_id uuid not null, device_id uuid,
  started_at timestamptz not null, ended_at timestamptz,
  policy text not null, consent text, gpc bool not null default false, region text,
  person_id uuid, person_level text, person_source text,          -- live, backfill, split
  account_id uuid, account_source text, network_account_id uuid,
  ip_net cidr, ip_kind text, internal bool not null default false, is_bot bool not null default false,
  split_from uuid
);
create index on sessions (workspace_id, device_id, started_at);
create index on sessions (workspace_id, person_id, started_at desc);
create index on sessions (workspace_id, account_id, started_at desc);

-- identity (022_identity.sql)
create table persons (
  id uuid primary key, workspace_id uuid not null, created_at timestamptz not null default now(),
  display_name text, primary_email text, account_id uuid,
  opted_out bool not null default false, merged_into uuid
);
create table person_aliases (old_id uuid primary key, new_id uuid not null, at timestamptz not null default now());

create table identifiers (
  id uuid primary key, workspace_id uuid not null, person_id uuid,
  kind text not null,                          -- email, user, hubspot
  value_raw text, value_clean text not null, value_hash bytea not null,
  class text,                                  -- work, free, role, own, partner
  unique (workspace_id, kind, value_clean)
);
create index on identifiers (workspace_id, value_hash);

create table identity_evidence (
  id uuid not null, workspace_id uuid not null,
  device_id uuid, session_id uuid,
  source text not null,                        -- identify_signed, identify, form, booking, gate, hutk, email_link,
                                               -- page_link, crm, crm_merge, manual_merge
  level text not null,                         -- verified, asserted, inferred
  identifiers jsonb not null,                  -- [{kind, value_clean}]
  hard_edge bool not null default false,
  extra jsonb, server_at timestamptz not null default now(),
  ignored text,                                -- policy, internal, opted_out, taint, guard
  revoked_at timestamptz, revoked_by uuid, revoke_reason text,
  primary key (workspace_id, id)
);
create index on identity_evidence (workspace_id, device_id, server_at);

create table device_links (
  id uuid primary key, workspace_id uuid not null,
  device_id uuid not null, person_id uuid not null,
  level text not null,                          -- verified, asserted, probable
  from_at timestamptz not null, to_at timestamptz,
  evidence_id uuid not null
);
create index on device_links (workspace_id, device_id, from_at desc);
create index on device_links (workspace_id, person_id);

create table merge_proposals (
  id uuid primary key, workspace_id uuid not null, person_a uuid, person_b uuid,
  reason text, evidence_id uuid, status text default 'open', decided_by uuid, decided_at timestamptz,
  unique (workspace_id, person_a, person_b)
);

create table email_tokens (                     -- one row per token sent (M6)
  workspace_id uuid, token_id uuid primary key, contact_id text, email_id uuid, sent_at timestamptz,
  claimed_device uuid, claimed_at timestamptz, forwarded bool default false
);
create table hop_nonces (nonce bytea primary key, used_at timestamptz);           -- kept 10 minutes
create table learned_networks (
  workspace_id uuid, net cidr, account_id uuid, people int, share numeric, updated_at timestamptz,
  primary key (workspace_id, net)
);
create table ip_cache (key bytea primary key, net cidr, domain text, kind text, confidence int,
  vendor text, fetched_at timestamptz);       -- shared, company data only, 30 days
create table deletions (workspace_id uuid, value_hash bytea, at timestamptz);       -- erasure record
```

- Every workspace table has RLS on `workspace_id` and a leak test. `ip_cache` and `hop_nonces` are server-only (no RLS policy for clients, read through security definer functions).
- Event rows (partitioned by day) only reference `session_id`. Identity changes touch sessions, never events.

### Views other modules use

| View or function | Returns | Used by |
|---|---|---|
| `v_session_identity` | session → person, level, account, source | M2, M3 |
| `v_person_current` | person with identifiers, account, last seen and opted-out flag | M3, M6 |
| `can_act(person_id)` | true only if the person has a Verified or Asserted identifier, isn't opted out, isn't only Probable, and isn't on a tainted device in the last 30 days | M6, M7 |
| `identity_changed` job | person ids whose links or merges changed | M2 re-attribution, M3 rescoring |

---

## Part 12. Jobs

| Job | Key | Trigger | Target time |
|---|---|---|---|
| `stitch` | `device` | New evidence | ≤ 5 s p95 |
| `hutk_lookup` | `hutk` | First `hutk` in a session | ≤ 30 s |
| `token_confirm` | `token` | Email or page token, 30 s after landing | 30–40 s |
| `calendly_invitee` | `invitee_uri` | Booking event | ≤ 30 s |
| `mx_check` | `domain` | New email domain | ≤ 5 s, cached 7 days |
| `identity_changed` | `person` | After stitch, merge or undo | ≤ 60 s |
| `learned_networks` | `workspace` | Nightly | Minutes |
| `untaint` | — | Nightly, ends 30-day taints | Minutes |
| `identity_rebuild_check` | `workspace` | Nightly: rebuilds a sample of 200 groups in a scratch schema and compares | Minutes |
| `identity_retention` | — | Nightly: deletes unknown devices past retention, old nonces and caches | Minutes |

---

## Part 13. Screens

**Person page:**
- Header with name, account and a level tag (Verified, Asserted or Probable).
- **Identifiers:** kind, value and level, with the first evidence for each.
- **Devices:** browser and OS, first and last seen, state tag, and link date ranges.
- **Evidence list:** "Form on /demo, 3 Nov 10:04", "Signed login, 5 Nov 09:12", with revoked rows shown struck through.
- **Sessions,** with backfilled ones marked.
- **Buttons:** Unmerge, Unlink device, Mark as kiosk, Export, Erase. Each uses the app's own dialogs.

**Account page › People:**
- Known people with level tags.
- "Unknown visitors from this account": session count, pages, networks.

**Settings › Identity:**
- Install mode with a health check: proxy detected, cookie life seen in Safari.
- Identify secret (show, rotate) and server library snippets.
- Own domains, partner domains, office IPs, and "this is me" links for teammates.
- Health numbers: identified share, shared devices, tainted devices, open merge proposals, unmerges in the last 30 days.

**Merge proposals queue:** the pair, the reason, the evidence on both sides, and Approve or Deny.

**Staff-only device explorer** (for support, behind a logged access grant): a device's full timeline with every rule decision and its reason.

---

## Part 14. Explaining every decision

Every derived row records why it exists:
- **Device links** point to the evidence that opened them.
- **Each session's person** carries a source (live, backfill or split).
- **Ignored evidence** carries a reason (policy, internal, taint, guard).

The Person page shows this as plain sentences:
- "Linked because of a form on /demo at 10:04 (Asserted)."
- "Earlier visits from 1 Nov added because this browser had no other owner."
- "Raj's email link opened here on 6 Nov. Not linked, because the browser already belongs to Jane."

---

## Part 15. Privacy operations

### 15.1 Erasure

Triggered from the Person page, the privacy API or a HubSpot privacy deletion:

1. Find the person by `value_hash` of any identifier (following aliases).
2. Take locks on the group.
3. Delete:
   - events and sessions of every device that was ever linked to the person (any level);
   - those devices, unless another person also used them (shared). For a shared device, only the sessions inside this person's link windows are deleted;
   - evidence, identifiers, device links, merge proposals and email tokens;
   - briefs, signals and scores rows that name the person (scores at the account level are recomputed);
   - the person and its aliases.
4. Write `deletions(workspace, value_hash, at)`.
5. A later evidence row with that hash starts fresh. The deletion record only proves the erasure happened, and is kept 3 years (check).
6. **Backups:** Supabase backups roll off on their own schedule (check the current retention for the plan). The erasure log says when the last backup holding the data expires.

### 15.2 Export

A JSON file with the person, identifiers, evidence (source, level, time), sessions (time, pages), and briefs and signals that name them. It's delivered to the requesting admin in the app and logged.

### 15.3 Opt-out and withdrawal

Part 3. Opt-outs are honored within one request. The audit query `events stored after opt-out` must always return 0.

### 15.4 Retention

| Data | Default |
|---|---|
| Unknown devices with no activity | Deleted 13 months after last seen |
| Evidence | Kept while the person exists |
| Revoked evidence | Kept 12 months, then deleted |
| Ignored evidence | Kept 30 days (for debugging), then deleted |
| Email tokens | 90 days after send |
| Hop nonces | 10 minutes |
| IP cache | 30 days |
| Daily salts | 24 hours |

---

## Part 16. Metrics

| Metric | SQL idea | Alert |
|---|---|---|
| Identified share | sessions with `person_level` in (verified, asserted) / non-bot non-internal sessions | Drop of 30%+ week over week (install broke) |
| Probable share | Probable sessions / identified sessions | > 25% |
| Shared devices | devices in `shared` / devices with a link | > 3% |
| Tainted devices | devices in `tainted` / devices with evidence | > 1% |
| Unmerges per 1,000 links | revoked hard edges and unlinks / links made, 30 days | > 2 |
| Merge proposals open | count | > 50 per workspace |
| Evidence to link p95 | `device_links.from_at` vs `evidence.server_at` | > 5 s |
| Token human-proof pass rate | confirmed tokens / tokens landed | < 30% (scanners growing) or > 95% (proof too weak) |
| Forwarded tokens | forwarded / claimed | Tracked |
| Safari cookie survival | share of Safari devices seen again after 8+ days | < 50% in mode A (proxy broken) |
| Rebuild drift | rows different in the nightly sample | > 0 |
| Policy breaches | identity rows from sessions whose policy forbids them | > 0, paged at once |

---

## Part 17. Testing

### 17.1 Real-browser checks (`scripts/identity-check.ts`)

These run in Playwright on a local test site, in Chromium (pre-installed). They also run in WebKit and Firefox in CI (CI downloads those browsers; check runner time and cache).

| # | Case | Expected |
|---|---|---|
| 1 | Browse, then fill the demo form | Linked at Asserted. The last 90 days backfilled. |
| 2 | Signed identify at login | Verified. User id and email tied. |
| 3 | Unsigned identify from the console | Asserted, no hard edge |
| 4 | Two unsigned identities in one day | Tainted |
| 5 | Two people fill forms on one browser | Shared. No backfill for the second. Each gets their own windows. |
| 6 | Trade show laptop, 6 emails | Tainted. No person links. |
| 7 | Email token, human proof passes | Probable on a fresh device. No agent action allowed (`can_act` false). |
| 8 | Email token opened by a scanner (no script run) | Nothing stored |
| 9 | Email token, script runs but no human input | Dropped after 30 s |
| 10 | Email token from an Azure IP | Dropped |
| 11 | All 5 links in one email opened within 3 s | Dropped |
| 12 | Forwarded token on a second laptop | Second device Probable. Token marked forwarded. |
| 13 | Token, then a form on the same device | Upgraded to Asserted with backfill |
| 14 | Token URL copied to another browser after landing | Token already stripped, so nothing |
| 15 | Rep clicks their own email link (internal device) | Dropped |
| 16 | Own-domain email in a form | Device internal |
| 17 | `claritia.reset()` on logout, then another user logs in | New device. No mixing. |
| 18 | Logout and login as another user without `reset()` | Session split. Device Shared. |
| 19 | Cross-domain hop | Same device on both domains |
| 20 | Hop token replayed | Refused |
| 21 | Hop token after 3 minutes | Refused. New device. |
| 22 | Proxy mode in WebKit, clock moved 30 days | Same device |
| 23 | CNAME mode in WebKit, clock moved 8 days | New device, and the health check warns |
| 24 | Cookie cleared, localStorage kept (mode C) | Same device |
| 25 | Region `strict`, no consent | No cookie, no evidence. The form sends nothing. |
| 26 | `strict`, consent given mid-visit | New device from consent. Earlier sessions never linked. |
| 27 | Consent withdrawn | Cookies deleted, no new events |
| 28 | GPC on | Cookieless. No evidence. |
| 29 | Opt-out link | `_clr_opt` set. Nothing after. |
| 30 | HubSpot form adapter | Email captured from the callback |
| 31 | `fetch` form without `submit` | Nothing (until `data-clr-form` is added, then captured) |
| 32 | Password and card fields typed and submitted | Only the email leaves the browser (checked by recording all network requests) |
| 33 | `J.ane+news@Gmail.com` then `jane@gmail.com` | One person |
| 34 | `sales@acme.com` form | No person. Account hint. |
| 35 | `jane@gmial.com` (no MX) | Dropped |
| 36 | Bfcache back navigation | One session, two views |
| 37 | Prerendered page never shown | Nothing sent |
| 38 | Campaign change mid-visit | New session |

### 17.2 Server tests

| Test | Kind |
|---|---|
| Rebuild equals incremental on 10,000 random evidence rows | Property |
| Same result for any order of concurrent batches | Property, with 8 parallel workers |
| Merge guards: 2 user ids, 2 HubSpot ids, 6 emails, 3 company domains | Unit |
| HubSpot `contact.merge` merges. Deletion revokes. Privacy deletion erases. | Integration, test portal |
| Unmerge then rebuild gives the old two people. Aliases resolve. | Unit |
| Erasure: a search of every table finds no row with the hash, email or device ids | Integration |
| Learned networks: 3 people from acme on a network maps it. Mixed people unmap it. | Unit |
| IP cache never stores a raw IP | Unit (a scan of rows for IP patterns) |
| Policy breach audit query returns 0 after the full browser suite | Integration |
| Leak tests for every identity table | `tests/db/leaks.sql` |
| Load: 500 evidence rows per second, p95 under 5 s | `scripts/load-identity.ts` |

---

## Part 18. Build order

This fits the weeks in `docs/account-intelligence.md` Part 17 with no change to the total.

| Week | Identity work |
|---|---|
| 2 | Script: device id handling per mode, `_clr_s`, consent and GPC reading, opt-out, reset, hop links, token stripping, form listener and adapters, never-read rules, human-proof counts |
| 3 | Collect: signed ids, cookies per mode, proxy secret and client IP, region policy gates, cookieless mode, salts, hop and token endpoints, evidence intake, MX and disposable checks |
| 4 | Stitching: identifiers and cleaning, hard edges, guards, device state machine, backfill, session split, advisory locks, aliases, rebuild, undo, merge proposals, internal traffic, erasure. Browser cases 1–38. |
| 5 | Accounts: priority rules, IP cache, network kinds, learned networks, partner and job-change handling. HubSpot identity: CRM ties, merges, `hutk` lookup (or drop it). Settings › Identity and the Person page. |

---

## Part 19. Cost

Identity makes no AI calls. Its work runs on `claritia-collect` and `claritia-agent`, which are already costed.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Storage: devices, sessions identity columns, evidence, links | About 3 GB, inside the Supabase plan (check) | About 30 GB, about $4 a month over the included disk (check) |
| DNS lookups (MX checks) | $0 | $0 |
| HubSpot `hutk` lookups | $0 (customer's API limits) | $0 |
| Calendly invitee lookups | $0 (customer's plan) | $0 |
| WebKit and Firefox in CI | GitHub Actions minutes, about $0–$10 (check) | Same |
| **Added to the monthly bill** | **$0–$10** | **About $15** |

IP vendor and Coresignal costs are in `docs/account-intelligence.md` Part 18.

---

## Part 20. Open checks

| Check | Why |
|---|---|
| WebKit's current rules on server-set cookies from a different IP, and on CNAME cloaking | Sets how good modes B and C are |
| HubSpot's `utk` lookup (v1) status, and whether wrong contacts still come back | Keep or drop the `hutk` source |
| HubSpot form embed callback payload (`submissionValues`) on the current embed | Form adapter |
| Calendly and HubSpot Meetings booking event payloads and API scopes | Booking evidence |
| Firefox and Brave query-stripping lists | Make sure `clr`, `_clr_x` and `p` aren't stripped |
| Free and disposable email list licenses | Bundling the lists |
| Supabase backup retention on the plan | The erasure log |
| Lawyer review of Part 3 and 15 | Compliance |

---

## Sources

- [Stape: Safari limits cookies from third-party IPs](https://stape.io/blog/safari-itp-update-limits-cookies-to-7-days-for-responses-from-3rd-party-ips)
- [Adobe: Apple ITP 2.x](https://experienceleague.adobe.com/en/docs/target-dev/developer/implementation/privacy/apple-itp-2x)
- [Adtribute: ITP](https://www.adtribute.io/glossary/itp)
- [Adtribute: CNAME cloaking](https://www.adtribute.io/glossary/cname-cloaking)
- [Hardal: Safari ITP guide](https://usehardal.com/safari-itp-guide.md)
- [Mozilla: query parameter stripping](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html)
- [Swetrix: browser tracking protection explained](https://swetrix.com/blog/browser-tracking-protection-features-explained)
- [HubSpot: get contact by usertoken (legacy)](https://legacydocs.hubspot.com/docs/methods/contacts/get_contact_by_utk?hsLang=en)
- [HubSpot Community: look up a contact from cookie](https://community.hubspot.com/t5/APIs-Integrations/Look-up-a-contact-or-account-from-cookie/td-p/1230679)
- [HubSpot Community: incorrect contact by hubspotutk](https://community.hubspot.com/t5/APIs-Integrations/incorrect-contact-coming-back-when-getting-contact-by-hubspotutk/m-p/318045)
- [Suped: automatic clicks on Office 365 domains](https://www.suped.com/learn/email-deliverability/why-are-we-seeing-automatic-opens-and-clicks-on-office-365-hosted-recipient-domains)
- [Suped: filtering tools clicking links](https://www.suped.com/email-deliverability/answers/what-data-supports-filtering-tools-clicking-on-links-in-emails)
- [Hummingdeck: why email clicks are wrong](https://hummingdeck.com/blog/why-your-deck-analytics-are-wrong)
- [Arternal: clicks from email security scanners](https://support.arternal.com/en/articles/15216436-smart-mail-clickthroughs-triggered-by-email-security-scanners)
