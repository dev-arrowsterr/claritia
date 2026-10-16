# Sources setup: what to set before turning on imports, sync and warehouses

Everything here is done once by us, never by customers. Customers click "Connect HubSpot" and sign in. Without the sign-in app for a tool, that tool falls back to a pasted key.

The app is assumed to live at `https://app.tryclaritia.com`. If it doesn't, set `APP_URL` on Render to the real address and use that address everywhere below.

## 1. Database

Run `supabase/migrations/033_contacts.sql` through `038_warehouses.sql` in order (Supabase → SQL editor, or `supabase db push`). They create:

- the private `imports` storage bucket (035),
- the sources, sync log, hooks and links tables (036),
- segments (037),
- warehouse activity and records (038).

`minute_tick` already runs every minute from pg_cron. From 036 on, it also starts due pulls, pushes for two-way CRMs, and the hourly segment refresh. Nothing new to schedule.

## 2. SECRETS_KEY (Render and claritia-intel, same value)

Every tool's sign-in or key is sealed with `SECRETS_KEY` (AES-256-GCM) before it's saved. The web app seals; the worker unseals. Both need the exact same value, or every pull fails with "This secret is not in a format Claritia can read."

1. Render → `claritia` → Environment. `SECRETS_KEY` already exists (the Blueprint made it). Copy its value.
2. Put it on the worker: `fly secrets set SECRETS_KEY='<same value>' --app claritia-intel`
3. Never change it once sources are connected. A new value makes every saved sign-in unreadable, and every customer would have to connect again.

## 3. claritia-intel secrets (Fly)

```
fly secrets set --app claritia-intel \
  SECRETS_KEY='<same as Render>' \
  SUPABASE_URL='https://<project>.supabase.co' \
  SUPABASE_SECRET_KEY='<service role / secret key>' \
  HUBSPOT_CLIENT_ID='…' HUBSPOT_CLIENT_SECRET='…' \
  SALESFORCE_CLIENT_ID='…' SALESFORCE_CLIENT_SECRET='…' \
  PIPEDRIVE_CLIENT_ID='…' PIPEDRIVE_CLIENT_SECRET='…' \
  ATTIO_CLIENT_ID='…' ATTIO_CLIENT_SECRET='…' \
  MAILCHIMP_CLIENT_ID='…' MAILCHIMP_CLIENT_SECRET='…'
fly deploy --config fly.intel.toml
```

| Secret | What it's for | Without it |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Reading uploaded import files from storage, and deleting them after 30 days | Files over 3 MB fail after their retries; files up to 3 MB still import from the web app |
| `<TOOL>_CLIENT_ID`, `_CLIENT_SECRET` | Refreshing a tool's sign-in when it expires (HubSpot every 30 minutes, Salesforce every few hours) | The first refresh fails and the source turns to Error, "Reconnect" |
| `DATABASE_URL` | Already set | — |

The deploy also raises the worker to 1 GB (`fly.intel.toml`): about $3 a month more (check).

## 4. Render (web app) environment

Render → `claritia` → Environment. The Blueprint (`render.yaml`) now lists these, so a Blueprint sync prompts for them.

| Variable | What it's for |
|---|---|
| `SUPABASE_SECRET_KEY` | Already set. The connect, callback, webhook and test-query routes use it. |
| `SECRETS_KEY` | Already set. |
| `<TOOL>_CLIENT_ID`, `_CLIENT_SECRET` | Same values as on the worker. The web app makes the sign-in link and trades the code for tokens. |
| `APP_URL` | Only if the app isn't at `https://app.tryclaritia.com`. It builds the sign-in return address and the webhook addresses, and HubSpot signs its webhooks over that address, so it must match exactly. |
| `OMNISCIENT_URL` | Only if Omniscient isn't at `https://app.tryomniscient.com`. |

## 5. One sign-in app per tool

Every tool uses the same return address:

```
https://app.tryclaritia.com/api/sources/callback
```

### HubSpot (two-way)

1. developers.hubspot.com → your developer account → Apps → Create app (a public app).
2. Auth tab:
   - Redirect URL: the return address above.
   - Scopes: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.lists.read`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`. They must match `src/lib/sources/oauth.ts` exactly, or HubSpot refuses the sign-in.
   - Copy the Client ID and Client secret into `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` (Render and Fly).
3. Webhooks tab:
   - Target URL: `https://app.tryclaritia.com/api/hooks/hubspot`.
   - Subscriptions:
     - Contact: creation, deletion, merge, privacy deletion.
     - Contact property change for `email`, `firstname`, `lastname`, `jobtitle`, `phone`, `company`, `website`, `country`, `state`, `lifecyclestage`, `hs_lead_status`, `hs_email_optout`.
     - Company: creation, deletion, and property change for `name`, `domain`, `industry`, `numberofemployees`, `country`.
   - Turn the subscriptions on.
4. HubSpot signs each webhook with the client secret (v3 signature). Claritia checks it, and refuses anything older than 5 minutes or signed for another address. Webhooks are optional: without them, changes still arrive with each pull, every 15 minutes.
5. Test with a HubSpot test account (developer account → Test accounts) before the app goes to the Marketplace.

On connect, Claritia makes three contact properties in the customer's HubSpot: `claritia_score`, `claritia_band` and `claritia_source`.

### Salesforce (two-way)

1. Setup → App Manager → New Connected App (or New External Client App).
2. Enable OAuth settings:
   - Callback URL: the return address above.
   - Scopes: "Manage user data via APIs (api)" and "Perform requests at any time (refresh_token, offline_access)".
   - Require Proof Key for Code Exchange (PKCE): on.
   - Require secret for web server flow: on.
3. Copy the Consumer Key and Consumer Secret into `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET`.
4. Policies: "All users may self-authorize". Refresh token policy: "valid until revoked".
5. A Developer Edition org (developer.salesforce.com/signup) is for testing.

Limits for now:
- Sign-in goes to `login.salesforce.com`, so sandboxes (`test.salesforce.com`) can't connect yet.
- Changes arrive by pull every few minutes. Change Data Capture comes later.
- New contacts are created as Leads.

### Pipedrive (in)

1. developers.pipedrive.com → Developer Hub → create an app.
2. Callback URL: the return address above.
3. Scopes: Contacts (read), Organizations (read), Users (read). Check the names on the app form.
4. Copy the Client ID and secret into `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`.
5. The app can stay unlisted (private) until it's reviewed for the Marketplace.

### Attio (in)

1. build.attio.com → create an app → OAuth.
2. Redirect URI: the return address above.
3. Scopes: read access to records, objects and the user's workspace. Check the names on the app form.
4. Copy the Client ID and secret into `ATTIO_CLIENT_ID` and `ATTIO_CLIENT_SECRET`.

### Mailchimp (in)

1. Mailchimp → Profile → Extras → Registered apps → Register an app.
2. Redirect URI: the return address above.
3. Copy the Client ID and secret into `MAILCHIMP_CLIENT_ID` and `MAILCHIMP_CLIENT_SECRET`.

Mailchimp has no scopes. Claritia finds the account's data center itself after sign-in.

### Omniscient (two-way, one click)

Nothing to register. Omniscient already knows Claritia (`src/lib/apps.ts` there) and allows return addresses on `tryclaritia.com`.

1. Omniscient's migration `032_connect.sql` must be live, with `SUPABASE_SECRET_KEY` set on Omniscient's Render.
2. "Connect Omniscient" in Claritia opens Omniscient's approve page. An Omniscient owner or admin clicks Allow. Claritia trades the one-time code for a key, then registers its own webhook with Omniscient (contact created and updated).
3. Omniscient's own "Connect Claritia" button sends people to `/settings/suite?connect=omniscient`. That address opens the same connect panel in Claritia.

## 6. Tools that need nothing from us

| Tool | How a customer connects |
|---|---|
| Close, Klaviyo, ActiveCampaign, Brevo, Kit, MailerLite, Stripe, Intercom | An API key from the tool's settings (these have no one-click sign-in in this build) |
| Typeform, Tally, Webflow, Calendly, Cal.com, any JSON | Claritia gives a webhook address to paste into the tool, with an optional signing secret |
| PostgreSQL, Redshift, MySQL, ClickHouse, BigQuery, Snowflake, Databricks | Database details for a read-only user. The connect screen shows the grant to run. Hosts on private networks are refused, so the database needs a public address. |

## 7. Check it works

1. Fly logs (`fly logs --app claritia-intel`) show `intel started` with `"secrets": true`, and the handlers include `source_pull`, `crm_push`, `source_hook` and `segment_refresh`.
2. In Claritia: Settings → Tools → HubSpot → Connect. You land back on Settings → Tools with the HubSpot page open and the state Active.
3. Within a minute, the page's Runs table shows an "In · Contacts" row, and Settings → Sync log shows created contacts.
4. Change a contact's job title in HubSpot. With webhooks on, it shows in Claritia within seconds; without them, within 15 minutes.
5. Change a contact's title in Claritia. It shows in HubSpot within a minute or two.
6. Import a CSV over 3 MB. Settings → Imports shows it Running, then Done.

If a source shows Error:
- "Reconnect…": the sign-in expired or was revoked, or the worker is missing that tool's client id and secret.
- Any other message: the tool's own answer, also in Settings → Sync log.

After 5 failed runs in a row, a source stops. Fix the cause, then press Resume on the tool's page.

## Running cost

None of this adds a paid service. The 1 GB worker is about $3 a month (check). The developer accounts for HubSpot, Salesforce, Pipedrive, Attio and Mailchimp are free.
