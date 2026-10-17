# CRM: Contacts, Companies, Opportunities

The first group in the sidebar. Records come from the customer's CRM (HubSpot, Salesforce, Pipedrive, Attio, Omniscient) through the sources pipeline (`src/lib/sources/sync.ts`), and can be added by hand.

## Screens

- **Contacts.** Everyone. Leads are a view on Contacts (a lead status is set), with a board by lead status. The contact page shows the contact's opportunities.
- **Companies.** Every company, with fit and intent from website intelligence. The company page holds its contacts, its opportunities and what it does on the site (visits, people, intent signals, firmographics). The live visit feed opens from the Visits button. The old Accounts and Visitors screens are folded in here.
- **Opportunities.** A built-in object on the records tables (`supabase/migrations/039_crm.sql`). Board by stage by default, with the amount totalled per stage; table, saved views, filters, bulk edit and export come from the shared records list. Views: Open, Won, Lost, No company. The page leads with amount, win chance and close date, and marks a late close date.

Patterns taken from Omniscient: stages with a kind (open, won, lost) so boards and reports tell them apart, the amount per stage, the late close date, built-in fields that can be renamed but not deleted, and the field source on synced values.

## Opportunities from CRMs

| CRM | Read | Links |
| --- | --- | --- |
| HubSpot | Deal search on `hs_lastmodifieddate`, then the archived list for deletes. Stage names and won/lost from the pipelines. Needs the optional `crm.objects.deals.read` scope. | v4 associations to companies and contacts |
| Salesforce | `queryAll` on Opportunity by `SystemModstamp`, deletes included | `AccountId`, contact roles |
| Pipedrive | Full read, then the recents feed (check) | Organization, person |
| Attio | Deals object, full read each run (check) | Associated company and people |
| Omniscient | API v1 `/opportunities` | Account |

- Closed deals always land on the stages `won` and `lost`. Open stages keep the CRM's name, and a stage the list doesn't have yet is added to it.
- Links only go to companies and contacts the same source already synced. A CRM that won't share deals (scope not granted) logs one error in the sync log and contacts keep syncing.
- Tests: `tests/opportunities.test.ts`, `tests/pg/opportunities.pg.ts` (250 deals through 429s and an expired token, stage changes, deletes, a portal without the deals scope).

## Settings

- **CRM:** Connection, Imports, Sync log, Fields, Objects.
- **Email:** Sending domains. Domains are listed as unverified until the send pipeline checks DNS.
- **Team:** Members. Invite by email; signing in with that email joins the workspace (same as Omniscient).

## Running cost

No new AI calls and no new paid services. Deal reads use the CRMs' free APIs inside the sync job that already runs.

| | Beta (50 teams) | Growth (500 teams) |
| --- | --- | --- |
| Claude tokens | $0 | $0 |
| Database storage (about 2 KB per opportunity; 2,000 per team at Beta, 5,000 at Growth) | about 0.2 GB, inside the plan: $0 | about 5 GB, inside Supabase Pro's 8 GB (check): $0 to $1 |
| Sync job time (one more page per run) | $0 | $0 |
| **Added per month** | **$0** | **$0 to $1** |
