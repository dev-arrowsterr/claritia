# Claritia

Tests that write and fix themselves. Describe a user flow in plain English, and Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes.

Today this repo holds the marketing site. The plan lives in `docs/plan.md`, the homepage plan in `docs/homepage.md`, and the brand notes in `docs/brand.md`.

## Local development

```bash
npm install
npm run dev   # http://localhost:3000
```

## Checks

```bash
npm run lint
npm run typecheck
npm run build
```

## Deploy

Render → New → Blueprint → this repo. Then add the domain under the web service's Custom Domains. Buttons point at `APP_URL` in `src/lib/site.ts`.
