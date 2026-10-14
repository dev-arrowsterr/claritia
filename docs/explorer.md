# Explorer and app map

**Map → Explore** crawls one of the project's environments and lists each kind of page it finds.

- Up to 3 browser tabs at once follow every link on the same site, up to 25, 50, 100 or 200 pages.
- One page per address pattern: `/orders/1` and `/orders/2` are one page, `/orders/:id`.
- For each page: title, headings, forms with their fields, main buttons, the pages it links to, a screenshot, and
  (from Claude Haiku, in batches of 10) a short name and what people do there.
- **Sign in first with** replays a test's saved code (no AI, no healing) and crawls with its cookies, so pages behind
  the sign-in show up. The test must have run once.
- It only follows links. It never clicks buttons or sends forms, and it skips links that sign out, delete, remove,
  unsubscribe or cancel. Other sites, files and private addresses are left alone.
- Pages found again are updated; the map only grows. Stop ends it early.

Explorations use cloud minutes (browser time) and AI credits (one per batch of 10 pages) like runs.

## How it works

- `supabase/migrations/016_explore.sql`: `explorations`, `app_pages`, `app_links`, `start_exploration`,
  `claim_exploration`, and `workspace_usage` counting explorations. A new exploration wakes the runner.
- `worker/explorer.ts` crawls; `worker/exploreHandle.ts` signs in, saves pages and screenshots
  (`runs/<workspace>/explore/<id>/`), links them and names them (`worker/namer.ts`). Runner slots take a run first,
  and an exploration only when no run is waiting.
- `scripts/explore-check.ts` crawls a local site built to be awkward (slow, broken, never-quiet pages, ids, popups,
  alerts, sign-out and delete links, pages behind a sign-in) with a real browser.

## Running cost

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude Haiku naming (about $0.0005 per 10 pages, 4 explorations of 50 pages per team a month) | under $1 | about $5 |
| Runner time (about 2 minutes per 50 pages) | about $5 (check) | about $50 (check) |
