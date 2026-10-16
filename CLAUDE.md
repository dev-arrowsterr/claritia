# Claritia

The agentic marketing platform: Claritia turns website visitors into leads and leads into meetings, with AI agents running the journeys, writing the emails, building the pages and proving what made revenue. It sits between Arrowsterr (SEO and AI search) and Omniscient (`dev-omniscient/omniscient`, CRM and deal rooms), on the same stack and brand system. The original product, AI end-to-end testing, stays for existing workspaces and powers Funnel QA.

Setup for imports, sources and warehouses: `docs/sources-setup.md`. Setup for sending: `docs/sending-setup.md`. Start with `docs/marketing-platform.md` (the plan), `docs/m1-website-intelligence.md` (the module being built), `docs/identity.md` and `docs/account-intelligence.md` (specs), and `docs/brand.md` (look and copy). `docs/vision.md` and `docs/plan.md` describe the testing product.

Workspaces see screens by `workspaces.features` (`src/lib/nav.ts`): `testing`, `marketing`, or both. Background work goes through the jobs queue (`supabase/migrations/020_foundation.sql`, `src/lib/jobs.ts`).

## Rule: every build includes its running cost
- Every build plan, feature or milestone states what it adds to the monthly bill: servers plus every paid service, Claude tokens included. Give monthly totals at two stages: Beta (50 teams) and Growth (500 teams).
- Mark any price that couldn't be confirmed on the vendor's own page as "check".

## Rule: reliability first
- A false failure costs more than a missing feature, and a wrong link or signal costs more than a missing one. Never ship a change to the runner, healing, failure sorting, the jobs queue, identity, the send pipeline or Funnel QA without a test that proves it on a flaky case.
- AI calls go through the step cache. A passing step replays from cache and never calls the model.

## Rule: no browser pop-ups or browser dropdowns
- Never use `<select>`, `window.prompt`, `window.confirm` or `window.alert`. Use the app's own `Select` and dialog helpers (same pattern as Omniscient).

## Rule: minimal copy
- Working screens hold labels, buttons and real errors only. No help text or cost notes.
- Explaining happens once, on a tool's first screen before there's data (the `ToolIntro` pattern from Omniscient).

## Rule: one brand style
- Follow `docs/brand.md` for the app, the website, emails and decks.
- Containers are square. Buttons and inputs use `rounded-md`. A state is a square tag. No pills, no shadows on cards, no gradients, no emoji.
