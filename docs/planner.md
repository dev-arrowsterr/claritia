# Planner

**Tests → Plan tests** proposes end-to-end tests from the project's app map (see `docs/explorer.md`), the tests it
already has, its blocks, and optional notes or a PRD (up to 30,000 characters). Proposals show at the top of the
Tests page, most important first: a name, a use case, a priority, why it matters, the pages it covers, and
plain-English steps. **Accept** saves one as a real test (Claritia writes its code on the first run); **Dismiss**
removes it.

- One Claude Opus call per plan (`worker/planner.ts`), run by the runner. A plan uses 10 AI credits.
- Up to 15 proposals. Tests that already exist aren't proposed again. Blocks are used for setup, such as signing in,
  only when the block exists. Secrets are written as `process.env.NAME`, never invented.
- Needs an explored map or notes. One plan at a time per project.
- `supabase/migrations/017_planner.sql`: `plans`, `test_proposals`, `start_plan`, `claim_plan`, `accept_proposal`
  (saves the test with new step ids), `dismiss_proposal`.

## Running cost

About $0.32 a plan (Claude Opus 5.5: about 40,000 tokens in at $4 per million, 8,000 out at $20 per million).

| | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| 4 plans per team a month | about $64 | about $640 |
| Per team | about $1.28 | about $1.28 |
