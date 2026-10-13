# Claritia

AI end-to-end testing. Describe a user flow in plain English, Claritia turns it into a Playwright test, runs it, and fixes it when the UI changes. Sister product to Omniscient (`dev-omniscient/omniscient`), built on the same stack and the same brand system.

Start with `docs/vision.md` (full platform vision), `docs/plan.md` (Phase 1 detail), `docs/homepage.md` (the marketing site) and `docs/brand.md` (look and copy).

## Rule: every build includes its running cost
- Every build plan, feature or milestone states what it adds to the monthly bill: servers plus every paid service, Claude tokens included. Give monthly totals at two stages: Beta (50 teams) and Growth (500 teams).
- Mark any price that couldn't be confirmed on the vendor's own page as "check".

## Rule: reliability first
- A false failure costs more than a missing feature. Never ship a change to the runner, healing or failure sorting without a test that proves it on a flaky page.
- AI calls go through the step cache. A passing step replays from cache and never calls the model.

## Rule: no browser pop-ups or browser dropdowns
- Never use `<select>`, `window.prompt`, `window.confirm` or `window.alert`. Use the app's own `Select` and dialog helpers (same pattern as Omniscient).

## Rule: minimal copy
- Working screens hold labels, buttons and real errors only. No help text or cost notes.
- Explaining happens once, on a tool's first screen before there's data (the `ToolIntro` pattern from Omniscient).

## Rule: one brand style
- Follow `docs/brand.md` for the app, the website, emails and decks.
- Containers are square. Buttons and inputs use `rounded-md`. A state is a square tag. No pills, no shadows on cards, no gradients, no emoji.
