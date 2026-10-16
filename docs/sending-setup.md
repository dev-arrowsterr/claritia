# Sending setup: what to set before email goes out

Everything here is done once by us. Customers only add their domain in Settings › Sending and paste the DNS records it shows.

The app is assumed to live at `https://app.tryclaritia.com`. If it doesn't, set `APP_URL` on Render and on `claritia-intel`, and use that address below.

## 1. Database

Run `supabase/migrations/039_email.sql` (Supabase → SQL editor, or `supabase db push`). `minute_tick` picks up sends and domain checks on its own.

## 2. Amazon SES (region ap-northeast-1)

1. AWS console → switch the region to **Asia Pacific (Tokyo) ap-northeast-1**.
2. SES → Account dashboard → **Request production access**. Until it's granted, SES only sends to addresses you verified by hand.
   - Mail type: Marketing.
   - Website: https://tryclaritia.com
   - Use case: sending for business customers from their own verified domains, with consent checks, one-click unsubscribe, bounce and complaint suppression, and an automatic pause at a 0.2% complaint rate.
3. Once granted, ask for a higher sending rate if the account's rate is under 14 a second.

## 3. Events: SNS topic and configuration set

1. SNS → Topics → **Create topic** → Standard → name `claritia-ses-events`. Copy its ARN.
2. Create a subscription on it:
   - Protocol: HTTPS
   - Endpoint: `https://app.tryclaritia.com/api/ses`
   - The app confirms the subscription by itself once `SES_SNS_TOPIC_ARN` is set on Render (step 5). If you created the subscription before that, press **Request confirmation** after the deploy.
3. SES → Configuration sets → **Create set** → name `claritia`.
4. Open the set → Event destinations → **Add destination**:
   - Event types: Deliveries, Hard bounces, Complaints, Rejects, Delivery delays.
   - Destination: Amazon SNS → the `claritia-ses-events` topic.

## 4. A sending user (IAM)

1. IAM → Users → **Create user** → name `claritia-ses`. No console access.
2. Permissions → Attach policies directly → Create policy → JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:SendEmail"
      ],
      "Resource": "*"
    }
  ]
}
```

3. Name it `claritia-ses-send` and attach it to the user.
4. The user → Security credentials → **Create access key** → "Application running outside AWS". Copy the key id and secret straight into step 5.

## 5. Secrets

**Fly (worker):**

```
fly secrets set --app claritia-intel \
  AWS_ACCESS_KEY_ID='…' \
  AWS_SECRET_ACCESS_KEY='…' \
  SES_REGION='ap-northeast-1' \
  SES_CONFIGURATION_SET='claritia'
```

`SECRETS_KEY` must already be there with the same value as on Render (docs/sources-setup.md step 2). It also signs unsubscribe and click links, so a link made by the worker opens on the web app.

**Render (web app):** Render → `claritia` → Environment → add `SES_SNS_TOPIC_ARN` with the topic's ARN → Save and deploy.

| Secret | Where | Without it |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | claritia-intel | Domains show "Amazon SES isn't set up on the worker", and nothing sends |
| `SES_REGION` | claritia-intel | Defaults to ap-northeast-1 |
| `SES_CONFIGURATION_SET` | claritia-intel | Emails send, but no delivery, bounce or complaint events come back |
| `SES_SNS_TOPIC_ARN` | Render | `/api/ses` refuses every event, so bounces and complaints don't suppress |
| `SECRETS_KEY` | both, same value | Unsubscribe and click links don't open |

## 6. Check it works

1. `fly logs --app claritia-intel` shows `intel started` with `"ses": true`, and the kinds include `send`, `domain_check` and `domain_remove`.
2. Settings › Sending → add a domain you control (for example `mail.tryclaritia.com`). Within a minute the records table fills in.
3. Add the records at your DNS host. Each turns from Waiting to Verified as SES and DNS see it (minutes to a few hours). Wrong means the record holds a different value, shown under it.
4. Fill in the Sender form: From address on the verified domain, and a physical address. Save.
5. Recent sends → **Send test**. The email reaches your sign-in address within a minute. The row goes Sent, then Delivered once SES reports it.
6. In Gmail, the email shows an "Unsubscribe" button next to the sender. Pressing it marks the row's unsubscribe (tests never suppress your own address).
7. Click the button in the email: the row's message gets a click (clicks in the first 10 seconds count as mail filters, so wait a moment).

## What's built and what's left

| Built | Where |
|---|---|
| Domains, settings, emails, one row per message, events, the guard at send time | `supabase/migrations/039_email.sql` |
| SES v2 client with AWS signing, no SDK | `src/lib/email/ses.ts`, `src/lib/email/sigv4.ts` |
| DNS records and checks | `src/lib/email/domains.ts` |
| Click and unsubscribe tokens, link rewriting, scanner filter | `src/lib/email/track.ts` |
| Footer, preheader, one-click unsubscribe headers (RFC 8058) | `src/lib/email/render.ts` |
| SNS signature check and SES event parsing | `src/lib/email/sns.ts`, `src/app/api/ses/route.ts` |
| Unsubscribe page and one-click endpoint; click redirect | `src/app/u/[token]/route.ts`, `src/app/c/[token]/route.ts` |
| `send`, `domain_check`, `domain_remove` jobs | `worker-intel/jobs/email.ts` |
| Settings › Sending | `src/components/app/views/SendingSettings.tsx` |
| Tests | `tests/email.test.ts`, `tests/pg/email.pg.ts`, sending block in `tests/db/leaks.sql` |

- **Flaky and hostile cases tested:** an address suppressed while its message waits is never sent; a throttle retries, a rejection fails, and a timeout is never resent; a worker killed mid-send leaves the message `unknown` with no second send; an SNS message delivered twice counts once; a forged or wrong-topic SNS message is refused; a changed byte in a link token is refused; 2 complaints in 600 sends pause the workspace and queued mail waits (nothing dropped) until the owner resumes; quiet hours wait for 08:00 in Tokyo; an unknown time zone falls back to the workspace's.
- **Left for later weeks:**
  - Branded link host (`t.<domain>`): links use the app's address until per-domain certificates are set up on Fly.
  - One configuration set per workspace and dedicated IPs (Growth).
  - Activity posted to Omniscient on send, and the email link token (`clr`) for identity.
  - Week 10: block editor, templates, brand kit, personalization tokens, broadcasts to segments, reports.

## Running cost

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| SES at $0.10 per 1,000 emails, 50,000 a team a month (check) | $250 | $2,500 |
| SNS HTTPS deliveries, about 2 events per email at $0.60 per million (check) | $3 | $30 |
| Dedicated IPs: shared pool at Beta; about 10 at $24.95 each at Growth (check) | $0 | $250 |
| Claude tokens | $0 | $0 |
| Servers: sends run on `claritia-intel` and the web app as they are | $0 | $0 |
| **Total added** | **about $253** | **about $2,780** |
