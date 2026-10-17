# Connect guide: every tool, step by step

How to connect each tool in Settings › Tools and check it works. `docs/sources-setup.md` covers the one-time server setup (database, `SECRETS_KEY`, Fly and Render). Do that first.

Menu names inside other tools change often. Where a path couldn't be confirmed on the vendor's own docs, it says "check".

## Before any tool

1. **Same `SECRETS_KEY` on Render and Fly.** Never change it after the first tool is connected.
2. **Sign-in keys on both Render and Fly.** For every tool with one-click sign-in, `<TOOL>_CLIENT_ID` and `<TOOL>_CLIENT_SECRET` go on Render (`claritia`) and on Fly (`claritia-intel`). Render makes the sign-in link. Fly refreshes it when it runs out.
3. **One return address for every sign-in app:** `https://app.tryclaritia.com/api/sources/callback`
4. **Test with a test account first.** Connect one tool, check it, then move on.

## How to check any tool

1. The tool's page shows the state **Active**.
2. Within a minute, the **Runs** table shows an "In · Contacts" row. Webhook tools show a row after the first test event.
3. **Settings › Sync log** shows the contacts it created.
4. Open one of those contacts in **Contacts** and check the name, email and company.

If it shows **Error**:
- "Reconnect…" means the sign-in ran out or the worker is missing the tool's keys.
- Any other message is the tool's own answer. Sync log has the details.
- After 5 failures in a row the tool stops. Fix the cause, then press **Resume**.

---

## CRMs

### HubSpot (two-way)

**One-time app setup (us):**
1. developers.hubspot.com → your developer account → Apps → **Create app**.
2. **Auth** tab:
   - Redirect URL: `https://app.tryclaritia.com/api/sources/callback`
   - Required scopes, exactly: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.lists.read`, `crm.schemas.contacts.read`, `crm.schemas.contacts.write`
   - Optional scopes: `timeline.read`, `timeline.write`, `crm.objects.owners.read`
3. Copy **Client ID** and **Client secret** into `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` on Render and Fly.
4. **Webhooks** tab (optional, for changes within seconds):
   - Target URL: `https://app.tryclaritia.com/api/hooks/hubspot`
   - Contact: creation, deletion, merge, privacy deletion.
   - Contact property change: `email`, `firstname`, `lastname`, `jobtitle`, `phone`, `company`, `website`, `country`, `state`, `lifecyclestage`, `hs_lead_status`, `hs_email_optout`.
   - Company: creation, deletion, and property change for `name`, `domain`, `industry`, `numberofemployees`, `country`.
   - Turn the subscriptions on.
5. Timeline events (optional): `HUBSPOT_APP_ID=… HUBSPOT_DEVELOPER_KEY=… node scripts/hubspot-timeline.mjs`, then put the printed `HUBSPOT_TIMELINE_TEMPLATE` on Fly.

**Connect (customer):** Settings › Tools › HubSpot → **Connect HubSpot** → pick the account → Allow.

**Without the app:** HubSpot → Settings → Integrations → Private apps → Create, with the scopes above. Paste the token into "Private app token".

**Check:**
- Change a contact's job title in HubSpot. It shows in Claritia within seconds with webhooks, or within 15 minutes without.
- Change a title in Claritia. It shows in HubSpot within 2 minutes.
- HubSpot now has the properties `claritia_score`, `claritia_band` and `claritia_source`.

### Salesforce (two-way)

**One-time app setup (us):**
1. Salesforce → Setup → App Manager → **New Connected App** (or New External Client App).
2. Enable OAuth settings:
   - Callback URL: `https://app.tryclaritia.com/api/sources/callback`
   - Scopes: "Manage user data via APIs (api)" and "Perform requests at any time (refresh_token, offline_access)".
   - Require PKCE: on. Require secret for web server flow: on.
3. Policies: "All users may self-authorize". Refresh token: "valid until revoked".
4. Consumer Key and Secret go into `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET`. These are set on Render; they still need to go on Fly.

**Per customer org (one time):** Setup → Object Manager → **Lead** → Fields & Relationships → New:
- `Claritia Score`: Number, 3 digits, 0 decimals → `Claritia_Score__c`
- `Claritia Band`: Text, 20 → `Claritia_Band__c`

Do the same on **Contact**. Give the connecting user edit access to all four fields. Without them, everything else syncs and the score is left out.

**Connect:** Settings › Tools › Salesforce → **Connect Salesforce** → sign in → Allow.

**Limits:** production and Developer Edition orgs only. Sandboxes (`test.salesforce.com`) can't connect yet. New contacts go in as Leads.

**Check:**
- Edit a Lead's title in Salesforce. It shows in Claritia within a few minutes.
- Edit a title in Claritia. It shows in Salesforce within 2 minutes.
- An email sent from Claritia shows as a completed Task on the Lead.

### Omniscient (two-way)

1. Omniscient must have migration `032_connect.sql` live, with `SUPABASE_SECRET_KEY` set on its Render.
2. Settings › Tools › Omniscient → **Connect Omniscient**.
3. An Omniscient owner or admin clicks **Allow**.

**Check:** create a contact in Omniscient. It shows in Claritia within seconds.

### Pipedrive (in)

**One-time app setup (us):**
1. developers.pipedrive.com → Developer Hub → **Create an app** (private is fine).
2. Callback URL: `https://app.tryclaritia.com/api/sources/callback`
3. Scopes: Contacts read, Organizations read, Users read (check the names on the form).
4. Client ID and secret go into `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET` on Render and Fly.

**Connect:** **Connect Pipedrive** → Allow.

**Without the app:** Pipedrive → profile picture → Personal preferences → **API** → copy the token. Paste into "API token".

**Check:** people and organizations show in Contacts and Companies.

### Attio (in)

**One-time app setup (us):**
1. build.attio.com → create an app → **OAuth**.
2. Redirect URI: `https://app.tryclaritia.com/api/sources/callback`
3. Scopes: read records, read objects, read the user's workspace (check the names on the form).
4. `ATTIO_CLIENT_ID` and `ATTIO_CLIENT_SECRET` on Render and Fly.

**Connect:** **Connect Attio** → Allow.

**Without the app:** Attio → Workspace settings → Developers → **New integration** → give it read access to records and objects → copy the access token. Paste into "Access token".

**Check:** People and Companies from Attio show in Claritia.

### Close (in)

1. Close → Settings → **Developer** → API Keys → **+ New API Key** (check).
2. Copy the key.
3. Settings › Tools › Close → paste into "API key" → Connect.

**Check:** leads' contacts show in Contacts.

---

## Email tools

### Mailchimp (in)

**One-time app setup (us):**
1. Mailchimp → Profile → Extras → **Registered apps** → Register an app.
2. Redirect URI: `https://app.tryclaritia.com/api/sources/callback`
3. `MAILCHIMP_CLIENT_ID` and `MAILCHIMP_CLIENT_SECRET` on Render and Fly. No scopes.

**Connect:** **Connect Mailchimp** → Allow.

**Without the app:** Profile → Extras → **API keys** → Create A Key. The key ends in the data center, like `-us21`. Paste into "API key".

**Check:**
- Audience members show in Contacts.
- Subscribed members come in as opted in, and unsubscribed ones come in as unsubscribed.

### Klaviyo (in)

1. Klaviyo → Settings → **API keys** → Create Private API Key.
2. Access: **Read-only** for Profiles and Lists (check).
3. Settings › Tools › Klaviyo → paste into "Private API key" → Connect.

**Check:** profiles show in Contacts with their consent.

### ActiveCampaign (in)

1. ActiveCampaign → Settings → **Developer**.
2. Copy **URL** (like `https://you.api-us1.com`) and **Key**.
3. Settings › Tools › ActiveCampaign → paste into "API URL" and "API key" → Connect.

**Check:** contacts show in Contacts.

### Brevo (in)

1. Brevo → your name → **SMTP & API** → API Keys → **Generate a new API key**.
2. Settings › Tools › Brevo → paste into "API key" → Connect.

**Check:** contacts show, with blocklisted contacts as unsubscribed.

### Kit (in)

1. Kit → Settings → **Developer** → copy the **API secret** (v3) (check).
2. Settings › Tools › Kit → paste into "API secret" → Connect.

**Check:** subscribers show in Contacts, and unsubscribed ones show in suppressions.

### MailerLite (in)

1. MailerLite → **Integrations** → API → **Generate new token**.
2. Settings › Tools › MailerLite → paste into "API token" → Connect.

**Check:** subscribers show in Contacts.

---

## Forms

Every form and meeting tool works the same way. Claritia gives you a webhook address, and you paste it into the tool. Records arrive as soon as someone fills the form. Claritia never pulls from these tools.

### Typeform

1. Settings › Tools › Typeform → **Connect** → copy the webhook address.
2. Typeform → open the form → **Connect** → **Webhooks** → Add a webhook → paste the address.
3. Click **Edit** on the webhook → set a **Secret** → copy it.
4. Back in Claritia, paste the secret into the signing secret field → Save.
5. Turn the webhook **on** in Typeform.

**Check:** press **Send test request** in Typeform, or fill the form once. The person shows in Contacts. Each answer comes in as a field.

### Tally

1. Settings › Tools › Tally → **Connect** → copy the webhook address.
2. Tally → open the form → **Integrations** → **Webhooks** → Connect → paste the address.
3. Turn on **Signing secret**, set one, and paste the same secret into Claritia.

**Check:** fill the form once. The person shows in Contacts.

### Webflow forms

1. Settings › Tools › Webflow forms → **Connect** → copy the webhook address.
2. Webflow → Site settings → **Apps & Integrations** → Webhooks → **Add webhook** (check).
3. Trigger type: **Form submission**. URL: paste the address.
4. Webflow has no signing secret for this, so leave Claritia's secret empty.
5. Publish the site so the form is live.

**Check:** submit the form on the live site. The person shows in Contacts.

---

## Meetings and events

### Calendly

Calendly webhooks need a paid Calendly plan (Standard or higher, check) and are made through Calendly's API, since Calendly has no screen for it.

1. Settings › Tools › Calendly → **Connect** → copy the webhook address.
2. Make a signing key: any long random text, like the output of `openssl rand -hex 32`. Paste it into Claritia's signing secret field → Save.
3. Calendly → Integrations → **API & Webhooks** → **Personal access tokens** → generate a token.
4. Find your organization address:
   ```
   curl -s https://api.calendly.com/users/me -H "Authorization: Bearer <token>"
   ```
   Copy `current_organization` from the answer.
5. Make the webhook:
   ```
   curl -s -X POST https://api.calendly.com/webhook_subscriptions \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"url":"<webhook address from Claritia>","events":["invitee.created"],"organization":"<current_organization>","scope":"organization","signing_key":"<your signing key>"}'
   ```
6. If the Calendly source shows **Error** ("pull is not a function"), it was made before the fix in `7bc6bd1`. Once that fix is live, press **Resume**.

**Check:** book a test meeting on your Calendly page. The invitee shows in Contacts with their answers to the booking questions.

### Cal.com

1. Settings › Tools › Cal.com → **Connect** → copy the webhook address.
2. Cal.com → Settings → **Developer** → **Webhooks** → New.
3. Subscriber URL: paste the address. Event trigger: **Booking Created**.
4. Set a **Secret** and paste the same secret into Claritia.
5. Save.

**Check:** book a test meeting. The attendee shows in Contacts.

---

## Product and billing

### Stripe (in)

1. Stripe → Developers → **API keys** → **Create restricted key**.
2. Permissions: **Customers: Read**. Leave everything else at None.
3. Settings › Tools › Stripe → paste into "Restricted key" → Connect.

**Check:** customers show in Contacts with the lifecycle stage Customer.

### Intercom (in)

1. Intercom → Settings → Integrations → **Developer Hub** → New app (check).
2. Authentication → copy the **Access token**. Give it read access to users and companies.
3. Settings › Tools › Intercom → paste into "Access token" → Connect.

**Check:** users and leads show in Contacts.

---

## Warehouses and databases

All of these work the same way:

1. Make a **read-only** user. The connect screen shows the exact grant to run.
2. The database needs a **public address**, because private network addresses are refused.
3. If the database has an IP allowlist, add Claritia's outbound addresses: Render → `claritia` → **Connect** → Outbound, and the addresses of Fly `claritia-intel`.
4. Write the query Claritia runs on a schedule:
   - Return one row per person, with an `email` column, a unique id column, and an update time column.
   - Use `:cursor` for the last update time read, for example:
     ```sql
     select id, email, first_name, last_name, company, updated_at
     from users
     where updated_at > :cursor
     ```
   - Pick the id and cursor columns on the connect screen and press **Test query**.
   - Each run reads 5,000 rows a page, within a 120-second limit.

### PostgreSQL

1. Run as an admin:
   ```sql
   create user claritia_read with password '<strong password>';
   grant usage on schema public to claritia_read;
   grant select on all tables in schema public to claritia_read;
   ```
2. Claritia: Host, Port (5432), Database, User `claritia_read`, Password.
3. Supabase, Neon and RDS work. Use the direct host, and turn on SSL if the host asks for it.

### Amazon Redshift

1. Run as an admin:
   ```sql
   create user claritia_read password '<Strong1Password>';
   grant usage on schema public to claritia_read;
   grant select on all tables in schema public to claritia_read;
   ```
2. In AWS, the cluster must be **publicly accessible**, and its security group must allow port 5439 from Claritia's addresses.
3. Claritia: Host (the cluster endpoint without the port), Port 5439, Database, User, Password.

### MySQL

1. Run as an admin:
   ```sql
   create user 'claritia_read'@'%' identified by '<strong password>' require ssl;
   grant select on yourdb.* to 'claritia_read'@'%';
   ```
2. Claritia: Host, Port (3306), Database, User, Password.

### ClickHouse

1. Run as an admin:
   ```sql
   create user claritia_read identified by '<strong password>' settings readonly = 1;
   grant select on yourdb.* to claritia_read;
   ```
2. ClickHouse Cloud → service → **Connect** → HTTPS. Copy the address with port 8443, like `https://abc.clickhouse.cloud:8443`.
3. Claritia: HTTPS address, User, Password.

### BigQuery

1. Google Cloud → IAM & Admin → **Service accounts** → Create, named `claritia-read`.
2. Roles:
   - **BigQuery Job User** on the project.
   - **BigQuery Data Viewer** on the dataset (BigQuery → dataset → Sharing → Permissions).
3. Service account → **Keys** → Add key → JSON. A file downloads.
4. Claritia: paste the whole JSON file into "Service account key (JSON)". Add the Project if it differs from the key's, and the Location if it isn't US.

### Snowflake

1. Make a key pair on your computer:
   ```
   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out claritia_key.p8 -nocrypt
   openssl rsa -in claritia_key.p8 -pubout -out claritia_key.pub
   ```
2. Run in Snowflake as ACCOUNTADMIN, with the public key's text between the BEGIN and END lines:
   ```sql
   create role claritia_read;
   grant usage on warehouse <wh> to role claritia_read;
   grant usage on database <db> to role claritia_read;
   grant usage on all schemas in database <db> to role claritia_read;
   grant select on all tables in database <db> to role claritia_read;
   create user claritia_read default_role = claritia_read rsa_public_key = '<public key>';
   grant role claritia_read to user claritia_read;
   ```
3. Claritia:
   - Account, like `myorg-myaccount` (Snowflake → your name → Account → copy the identifier).
   - User `claritia_read`.
   - Private key: the whole `claritia_key.p8` file.
   - Warehouse, Database, and Role `claritia_read`.

### Databricks

1. Databricks → Settings → Identity and access → **Service principals** → Add, named `claritia-read`.
2. SQL Warehouses → your warehouse → Permissions → give the service principal **Can use**.
3. Catalog → the tables → Permissions → give it **SELECT** (and USE CATALOG and USE SCHEMA on their parents).
4. Make an access token for the service principal (check: the service principal's page, or `databricks tokens create` as it).
5. Claritia:
   - Workspace address, like `dbc-123.cloud.databricks.com`.
   - SQL warehouse id: SQL Warehouses → warehouse → Connection details → the last part of the HTTP path.
   - Access token.

---

## Anything else

### Webhook (any tool that can post JSON)

1. Settings › Tools › Webhook → **Connect** → copy the address.
2. Point the tool at it: Zapier (Webhooks by Zapier → POST), Make (HTTP module), n8n (HTTP Request node), or your own code.
3. Send JSON with at least an `email`:
   ```json
   { "email": "ana@acme.com", "first_name": "Ana", "company": "Acme", "title": "CMO" }
   ```
   A list works too: `[ {...}, {...} ]` or `{ "contacts": [ ... ] }`, up to 1,000 a post. Nested objects become fields such as `address city`.
4. The same post sent twice counts once.

**Check:** send one test post. The person shows in Contacts.

---

## Running cost

Connecting tools adds no paid service. The worker at 1 GB is about $3 a month (check). Developer accounts for HubSpot, Salesforce, Pipedrive, Attio and Mailchimp are free. Calendly webhooks need the customer's own paid Calendly plan.
