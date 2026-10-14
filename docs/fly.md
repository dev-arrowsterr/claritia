# Moving Claritia from Render to Fly.io

Two Fly apps, both in Tokyo (`nrt`), next to the Supabase database:

| App | Config | Machine | Cost a month (check) |
|---|---|---|---|
| `claritia-web` (the app) | `fly.toml`, `Dockerfile` | shared-cpu-1x, 512 MB, always on | about $3.20 |
| `claritia-runner` (runs tests) | `fly.runner.toml`, `worker/Dockerfile` | shared-cpu-1x, 2 GB, sleeps when there's nothing to run | about $0.30 stopped, plus about $0.015 per hour of runs |
| **Total before launch** | | | **about $3.50 to $5** |

Render today: about $32 (runner $25, web $7). Fly bills by the second; Tokyo can cost a little more than US regions.

### How the runner sleeps and wakes

- After 5 minutes with nothing to run (`IDLE_EXIT_MS`), the runner exits and Fly stops the machine. A stopped machine only costs its disk.
- When a run is queued, the database calls `https://claritia-runner.fly.dev/` (pg_net). Fly starts the machine, which takes about 2 to 5 seconds, then the runner takes the run.
- Every minute the database fires due schedules itself (pg_cron), so schedules work while the runner sleeps, and it wakes the runner again if a run has been waiting.
- The wake address lives in the database, in `app_config`. Set it once after the runner's first deploy (step 4).

## 1. Sign up and install

```bash
brew install flyctl        # or: curl -L https://fly.io/install.sh | sh
fly auth signup            # or: fly auth login. Fly asks for a card.
```

## 2. Make the apps

From the repo folder:

```bash
fly apps create claritia-web
fly apps create claritia-runner
```

## 3. Copy the secrets from Render

Copy each value from Render → the service → Environment. `SECRETS_KEY` must be exactly the same, or saved secrets can't be opened.

```bash
fly secrets set --app claritia-web \
  SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  SECRETS_KEY=... STRIPE_SECRET_KEY=... RESEND_API_KEY=...

fly secrets set --app claritia-runner \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SECRETS_KEY=... ANTHROPIC_API_KEY=...
```

## 4. Deploy

```bash
fly deploy --ha=false                    # the web app
fly deploy --ha=false --config fly.runner.toml # the runner
```

Check `https://claritia-web.fly.dev` loads. Then tell the database where to wake the runner, in the Supabase SQL editor:

```sql
update app_config set value = 'https://claritia-runner.fly.dev/' where key = 'runner_wake_url';
```

 The runner and Render's runner can run side by side safely: each run is taken by one of them only.

## 5. Point the app's domain at Fly

Only the app moves to Fly. The marketing site, `tryclaritia.com` and `www.tryclaritia.com`, moves to Hostinger as a plain HTML site (the `claritia-site` repo; its README has the steps). Until that site is live, leave the `tryclaritia.com` and `www` records pointing at Render.

```bash
fly certs add app.tryclaritia.com --app claritia-web
```

It prints the DNS record to add. In Hostinger → DNS for `tryclaritia.com`, replace the Render record for `app` with a CNAME to `claritia-web.fly.dev`. Leave the `inbox` records for Resend alone. `fly certs show app.tryclaritia.com --app claritia-web` says when the certificate is ready.

The Stripe and Resend webhooks keep working: they use `app.tryclaritia.com`, which now points at Fly.

## 6. Delete the Render services

Once the app loads on `app.tryclaritia.com` from Fly and `tryclaritia.com` shows the Hostinger site, delete `claritia` and `claritia-runner` in Render (the service → Settings → Delete). Billing stops then. `render.yaml` can be deleted from the repo too.

## Deploying after this

Every push to `main` deploys both apps, through `.github/workflows/fly-deploy.yml`. It runs lint, typecheck and the unit tests first, and only deploys when they pass. To turn it on:

1. Make a token: `fly tokens create org` (one token works for both apps).
2. In GitHub → the `claritia` repo → Settings → Secrets and variables → Actions → New repository secret, name it `FLY_API_TOKEN` and paste the token.

Until the secret is there, the workflow runs the checks and skips the deploy. To deploy by hand, run `fly deploy --ha=false` and `fly deploy --ha=false --config fly.runner.toml`. Turn off Render's auto deploy (or delete the Render services) so pushes don't deploy to both.
