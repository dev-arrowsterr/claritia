# Claritia

Tests that write and fix themselves. Describe a user flow in plain English, and Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes.

This repo holds the marketing site (`/` on tryclaritia.com) and the app (app.tryclaritia.com). The vision lives in `docs/vision.md`, Phase 1 in `docs/plan.md`, the homepage plan in `docs/homepage.md`, and the brand notes in `docs/brand.md`.

## What works today (Week 1)

- Sign in with Google, GitHub or an email link. Your first sign-in makes a workspace.
- The first screen asks for a site address and an optional test login, then makes the project and its `staging` environment.
- Settings: rename or delete a project, add environments, edit their address, add and delete secrets, rename the workspace, sign out.
- Secret values are sealed with AES-256-GCM on the server (`src/lib/seal.ts`) before they reach the database. Members see secret names only. The values table has no access for signed-in users at all.

## Setup

1. **Supabase:** run each file in `supabase/migrations` in order (SQL Editor). Under Authentication → URL Configuration, set the Site URL to `https://app.tryclaritia.com` and add `https://app.tryclaritia.com/**` and `http://localhost:3000/**` to the redirect list. Under Providers, turn on Google and GitHub.
2. **Render:** add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SECRETS_KEY` (32+ random characters, never change it once secrets are saved).

## Local development

```bash
cp .env.example .env.local   # fill it in
npm install
npm run dev                  # http://localhost:3000
```

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run test:db   # leak tests: needs a local Postgres, set DATABASE_URL to a superuser connection
npm run build
```

## Deploy

One Render service (`claritia`) serves both domains. `src/proxy.ts` sends `/` on `tryclaritia.com` to the site, and everything on `app.tryclaritia.com` to the app (`/start` for now). `www.` goes to the bare domain.

Add `tryclaritia.com`, `www.tryclaritia.com` and `app.tryclaritia.com` under the web service's Custom Domains, then add the DNS records Render shows at your domain registrar.
