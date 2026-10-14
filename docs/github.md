# GitHub: checks on pull requests

A workspace connects the Claritia GitHub App and links a repository to a project (Settings → GitHub). Then:

- **Pull requests:** every push to an open pull request (drafts skipped) runs the project's tests on the linked environment.
- **Preview deploys:** every successful preview deploy (Vercel, Netlify, Render and others that post GitHub deployment statuses) runs the tests on the deploy's own address. Production deploys are skipped. Secrets come from the linked environment.

Each run posts a check named `Claritia (staging)` (or `Claritia (preview)`) with one row per test, the reason for each failure and a link to the run.

| Result | Check |
|---|---|
| Every test passed (a flaky test that passed on its re-run counts) | Success |
| A test failed | Failure, which blocks the merge when the check is required |
| Tests couldn't run (site down, setup problem, cloud minutes used up) | Neutral, which doesn't block |
| Not finished in 3 hours | Timed out |

The **Re-run** button on GitHub runs the check again. To block merges on a failure, add the check under the repository's Settings → Branches → branch protection → Require status checks.

## Only the tests a change affects

With **Only run the tests a change affects** on (the default for new links), each check runs the tests the pull
request's changed files can affect, and says why at the top of the check:

1. Fixed rules first, no AI: a pull request that only changes docs, tests or CI runs nothing (a neutral check, which
   doesn't block). One that changes shared code (dependencies, config, global styles, layouts, sign-in, routing, 100+
   files) runs every test.
2. Otherwise Claude Haiku reads the changed files, their diffs (up to 40,000 characters), the tests and the app map,
   and picks the tests with a reason for each. Unsure, or nothing picked, runs everything.
3. Anything that fails (files can't be read, the picker errors, no `ANTHROPIC_API_KEY` on the web app) runs every
   test. A missed failure costs more than a few extra runs.

When a pull request opens with a user-facing flow no test covers, Claude Sonnet proposes up to 5 tests for it. They
show on the Tests page marked with the pull request.

**Needs:** `ANTHROPIC_API_KEY` on `claritia-web`, and the GitHub App's **Contents: Read** permission (to read a
pull request's files on private repositories; owners accept the new permission on their installation).

## How it works

- `POST /api/github/webhook`: GitHub's events, checked against the webhook secret. A pull request or preview deploy calls `github_start_check()` (`supabase/migrations/013_github.sql`), which queues the tests (up to 50, trigger `ci`), then posts the check run.
- The database calls `POST /api/github/sync` when a run of an open check finishes, and every minute while a check is open (`minute_tick`). Sync updates the check run's progress and closes it once every run is done, following flaky runs to their re-runs.
- Installing: Settings → Connect GitHub → GitHub → back to `/api/github/setup`. The installation joins the workspace only after GitHub confirms, through the person's own GitHub sign-in, that they can reach it.

## Setting up the GitHub App (once)

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:
   - Name: `Claritia`. Homepage URL: `https://tryclaritia.com`.
   - Callback URL: `https://app.tryclaritia.com/api/github/setup`.
   - Turn on **Request user authorization (OAuth) during installation** and **Redirect on update**.
   - Webhook: active, URL `https://app.tryclaritia.com/api/github/webhook`, and a long random secret.
   - Repository permissions: **Checks** read and write, **Contents** read, **Pull requests** read, **Deployments** read. Metadata read is set already.
   - Events: **Pull request**, **Deployment status**, **Check run**.
   - Where it can be installed: **Any account**.
2. After saving: note the **App ID** and **Client ID**, make a **client secret**, and make a **private key** (downloads a `.pem`).
3. Set them on the web app:

   ```bash
   fly secrets set --app claritia-web \
     GITHUB_APP_ID=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... GITHUB_WEBHOOK_SECRET=... \
     GITHUB_APP_PRIVATE_KEY="$(cat claritia.private-key.pem)"
   ```

4. Tell the database where to send check updates (Supabase SQL editor; already done for the live project):

   ```sql
   update app_config set value = 'https://app.tryclaritia.com/api/github/sync' where key = 'github_sync_url';
   ```

## GitHub Action (no app needed)

Any workflow can run the tests with an API key, using the CLI:

```yaml
- uses: dev-arrowsterr/claritia/action@main
  with:
    api-key: ${{ secrets.CLARITIA_API_KEY }}
    project: Shop
    environment: staging
```

The Action lives in `action/` and needs this repository to be public, or copied to a public repository (for example `claritia/run`). Until then, call the CLI directly: `npx claritia run --project Shop --env staging` with `CLARITIA_API_KEY` set.

## Running cost

Picking: Claude Haiku, about $0.004 a push. Proposals for new flows: Claude Sonnet, about $0.10 on the pull requests
that add one. At 150 pushes and 15 such pull requests per team a month: about $105 at Beta (50 teams) and $1,050 at
Growth (500 teams), about $2.10 per team. A pick counts as 1 AI credit, proposals as 5.

The GitHub App itself adds $0 at Beta (50 teams) and Growth (500 teams): GitHub Apps are free, webhooks and syncs run on the existing web app, and runs use the same runner and cloud minutes.
