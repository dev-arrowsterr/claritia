# Moving Claritia from Render to Fly.io

Two Fly apps, both in Tokyo (`nrt`), next to the Supabase database:

| App | Config | Machine | Cost a month (check) |
|---|---|---|---|
| `claritia-web` (site and app) | `fly.toml`, `Dockerfile` | shared-cpu-1x, 512 MB, sleeps when idle | about $1 to $3 |
| `claritia-runner` (runs tests, fires schedules) | `fly.runner.toml`, `worker/Dockerfile` | shared-cpu-1x, 2 GB, always on | about $11 |
| **Total** | | | **about $12 to $14** |

Render today: about $32 (runner $25, web $7). Fly bills by the second; Tokyo can cost a little more than US regions.

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
fly deploy                              # the web app
fly deploy --config fly.runner.toml     # the runner
```

Check `https://claritia-web.fly.dev` loads. The runner and Render's runner can run side by side safely: each run is taken by one of them only.

## 5. Point the domains at Fly

```bash
fly certs add tryclaritia.com --app claritia-web
fly certs add www.tryclaritia.com --app claritia-web
fly certs add app.tryclaritia.com --app claritia-web
```

Each command prints the DNS records to add. In Hostinger → DNS for `tryclaritia.com`, replace the Render records with them (an A and AAAA record for `tryclaritia.com`, and CNAMEs to `claritia-web.fly.dev` for `www` and `app`). Leave the `inbox` records for Resend alone. `fly certs show app.tryclaritia.com --app claritia-web` says when the certificate is ready.

The Stripe and Resend webhooks keep working: they use `app.tryclaritia.com`, which now points at Fly.

## 6. Delete the Render services

Once the site loads on your domains from Fly, delete `claritia` and `claritia-runner` in Render (the service → Settings → Delete). Billing stops then. `render.yaml` can be deleted from the repo too.

## Deploying after this

Fly doesn't deploy on every push by itself. Run the two `fly deploy` commands, or ask Claude to add a GitHub Action that runs them on every push to `main` (it needs a `FLY_API_TOKEN` secret from `fly tokens create deploy`).
