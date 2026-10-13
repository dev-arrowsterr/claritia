# Claritia platform vision

**One line:** Claritia is the place where software gets checked before it ships, written and fixed by AI, run on real Playwright, and backed by proof.

**The bet:** soon most code will be written by AI agents. Writing code gets cheap. Knowing it works gets expensive. Claritia is the check that sits between "the agent says it's done" and "it's live for customers."

This doc builds on `docs/plan.md`. It adds what we learned from TestSprite and BugBug, and the design choices that keep Claritia ready for better AI models every year.

---

## 1. What we learned

### From TestSprite

| What they do | What we take |
|---|---|
| Start a project with a URL, a test account and sources (PRD, repo) | Same setup screen. Three fields and one button. |
| Many AI agents explore the site at once and list the pages they find | Explore mode with parallel agents and a live "pages found" list |
| Tests are grouped by use case (Checkout, Account, Orders) with a priority | Same grouping. Every test has a use case and a priority. |
| A pull request comes in, new tests get written for the change, and all tests run | PR-aware runs. Read the diff, add tests for the new feature, run the affected ones. |
| The run page shows a map of the app as agents reach each page | A live **app map** on the run page |
| Each test has Preview, Code, Run log and History tabs | Same four tabs on our test page |
| Auto-heal is a choice you turn on when you re-run | Healing is on by default, and every fix waits for approval |
| A chat box changes tests from plain words | A chat dock that edits tests and re-runs them |
| The closing line: "Ship at AI speed. Sign off with evidence." | Proof on every result is our core promise too |

### From BugBug

| What they do | What we take |
|---|---|
| A Chrome extension records tests by clicking | A Chrome recorder that writes the same YAML file as the AI |
| Tests can be edited visually, in YAML, or by an AI agent | One test file, many ways to edit it |
| Import and export, so there is no lock-in | Every test exports to plain Playwright code |
| A built-in test inbox for sign-up and password-reset emails | Built-in inboxes from day one |
| Unlimited users and no seat pricing | No seat pricing. Pay for runs and AI work. |
| Free plan with unlimited local runs | Local runs are always free |
| Reusable parts (log in, add to cart) | Reusable steps called **blocks** |
| Edit and run from any step | Start a run from any step while writing a test |
| `llms.txt` and `pricing.md` for AI readers | Same files, so AI answers describe us correctly |
| Many "X vs BugBug" pages | Comparison pages for growth, tracked in Arrowsterr |

### Where both fall short (our opening)

- **Their AI runs inside their cloud.** Claritia compiles every test to real Playwright code. You can run it anywhere, even with Claritia turned off.
- **Healing is a black box.** Claritia shows every fix as a diff, like a code review.
- **They test after the code is written.** Claritia plugs into the coding agent itself, so Claude Code or Cursor checks its own work before it opens a pull request.

---

## 2. Six design rules for an AI-ready platform

1. **Playwright runs the tests. AI writes and fixes them.**
   A passing test replays as plain Playwright with zero AI calls. AI only steps in when something is new or broken. This keeps runs fast, cheap and repeatable, and it means a better model makes Claritia better without changing how tests run.

2. **Two layers in every test: intent and lock.**
   The **intent** is the plain-English steps a person or agent wrote. The **lock** is the exact Playwright code that runs, like `package-lock.json` for tests. Healing changes the lock and shows the diff. The intent only changes when a person or agent says so.

3. **Agents are first-class users.**
   Everything you can do in the web app, an agent can do through the API, CLI and MCP server, with the same permissions. The web app is one client among several.

4. **Any model, measured.**
   All AI calls go through one model gateway. Claude is the default, and models can be swapped per job (writing, healing, judging). A fixed set of test apps with known bugs scores every model change before it ships. The number we guard is the false failure rate.

5. **Proof on every result.**
   Every pass or fail comes with video, screenshots, the Playwright trace, console logs, network calls and the AI's reason. Nobody has to trust Claritia. They can check it.

6. **Open files, no lock-in.**
   Tests live as files in the customer's repo. They export to Playwright any time. Results export as JUnit and JSON.

---

## 3. The test file

Each test is one file in `.claritia/tests/`. People and agents edit the intent. Claritia writes the lock.

```yaml
# .claritia/tests/checkout-coupon.yaml
name: Checkout with a coupon
use_case: Checkout
priority: high
env: staging
steps:
  - use: sign-in                 # a block: reusable steps
  - Add the blue hoodie to the cart
  - Apply the coupon SAVE10
  - check: The total drops 10%
  - Pay with the test card
  - check: The page says "Order confirmed"
```

```ts
// .claritia/lock/checkout-coupon.spec.ts  (written by Claritia, reviewed in PRs)
test('Checkout with a coupon', async ({ page }) => {
  // step 1: Add the blue hoodie to the cart
  await page.getByRole('link', { name: 'Blue hoodie' }).click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  // ...
});
```

- **Blocks** (`.claritia/blocks/`) are reusable steps: sign in, add to cart, fill an address.
- **Checks** are plain-English assertions. Simple ones compile to normal Playwright `expect` lines. Fuzzy ones ("the page looks right") go to the AI judge with a screenshot.
- **Data** (`.claritia/data/`) holds test accounts, cards and seeds. Secrets stay in Claritia and are passed in at run time.

---

## 4. The platform map

### Layer A: Run engine (the base)
- Playwright workers in Docker on Render, one fresh browser per test
- A job queue in Postgres with retries, timeouts and parallel runs
- Proof store in Cloudflare R2: video, trace, screenshots, DOM snapshots, network and console
- Smart retries that tell a flaky step apart from a real failure before marking a test red
- Sharding, so 200 tests finish in about the time of the slowest few

### Layer B: AI agents
| Agent | Job | When it runs |
|---|---|---|
| **Explorer** | Crawls the app with several browsers at once and builds the app map | New project, or on demand |
| **Planner** | Turns the app map, a PRD or a PR diff into proposed test cases, grouped by use case | After explore, on a new PR |
| **Writer** | Turns plain-English steps into the Playwright lock | New or edited steps |
| **Healer** | Fixes broken locators and timing, shows a diff, waits for approval | A step fails in a way that looks like UI drift |
| **Judge** | Decides fuzzy checks, and sorts each failure into app bug, flaky or setup | Fuzzy checks and every failure |
| **Chat** | Answers questions and edits tests from plain words | When a person asks |

All agents read the **knowledge base**: product rules, test accounts and words the team uses ("Plus member" means a paid plan).

### Layer C: App map
A live graph of the app: pages, states and the flows between them. It is built from explore runs and every test run.
- Shows coverage: which pages and flows have tests and which don't
- Powers PR-aware runs: a PR that touches `/checkout` runs the Checkout tests first
- Drawn on the run page as agents move through the app

### Layer D: Test data and access
- Built-in email inboxes (`anything@inbox.tryclaritia.com`) for sign-up, reset and magic links
- SMS numbers for one-time codes (later)
- Saved logins, so each test starts signed in without repeating the login steps
- A tunnel to test `localhost` and private staging sites
- Environments (staging, production, preview URLs) with their own secrets

### Layer E: Ways in (surfaces)
| Surface | Who uses it | What it does |
|---|---|---|
| Web app | Everyone | Projects, tests, runs, app map, approvals, chat |
| CLI | Developers and CI | `claritia run`, `claritia heal`, `claritia export` |
| GitHub App | Teams | Runs on every PR, posts a check with video, blocks the merge on a real failure |
| MCP server | Claude Code, Cursor, Codex | Write, run and fix tests from inside the coding agent |
| REST API | Anything else | Same actions as the CLI |
| Chrome recorder | Non-coders | Record a flow by clicking, saved as the same YAML |
| Slack | Teams | Alerts on failures, approve heals with one click |

### Layer F: Insights
- Flaky test tracking with the reason for each flake
- Pass rate, run time and AI cost per test over time
- Coverage by use case and by page on the app map
- A weekly digest in Slack or email

### Layer G: More kinds of testing (later)
API tests, visual compare, accessibility, basic speed checks, mobile web sizes, then native apps.

### Layer H: Enterprise (later)
SSO, roles, audit log, SOC 2, runners in the customer's cloud, data kept in the EU or US.

---

## 5. The agent loop (the most AI-ready part)

This is how Claritia works with a coding agent such as Claude Code:

1. A developer asks Claude Code to build a coupon feature.
2. Claude Code writes the code, then calls the Claritia MCP tool `claritia.verify` with the change.
3. Claritia's Planner reads the diff and writes two new tests for coupons. It also picks the 12 existing Checkout tests the change could break.
4. Claritia runs all 14 against the preview URL.
5. One fails. Claritia returns the failed step, the error, a screenshot link and the Judge's reason ("app bug: the coupon is applied twice").
6. Claude Code fixes the bug and calls `verify` again. All 14 pass.
7. Claude Code opens the PR with the new tests included and a link to the passing run.

**MCP tools to ship:** `list_tests`, `write_test`, `run_tests`, `verify_change`, `get_run`, `get_failure`, `approve_heal`, `explore`, `export_playwright`.

**Also ship:** an agent skill file (`claritia.skill.md`) that teaches any agent how to use Claritia, plus `llms.txt` and `pricing.md` on the website.

---

## 6. Screens

Built in the brand from `docs/brand.md`. Sidebar: Tests, Runs, App map, Insights, Settings.

1. **Start (ToolIntro):** URL, test account, optional PRD or repo. One button: "Explore my app."
2. **Explore:** parallel browsers at work, a live list of pages found, then "Plan tests."
3. **Plan:** proposed tests grouped by use case, each with a priority. Approve all or pick.
4. **Tests:** a table grouped by use case with status tag, last run, priority and pass bar. Buttons: "Add tests" and "Run all."
5. **Test page:** steps on the left. Tabs on the right: Preview (video replay), Code (the lock), Run log, History.
6. **Run page:** progress strip, live app map and the test list. A failed test opens to its step, video time and verdict.
7. **Approvals:** heal diffs and new tests waiting for a yes.
8. **App map:** the graph of pages and flows, colored by coverage.
9. **Insights:** flaky tests, trends and AI cost.
10. **Settings:** environments, secrets, inboxes, integrations, team, billing.
11. **Chat dock:** opens from any screen with ⌘K.

---

## 7. Pricing model

Learned from BugBug: teams hate seat pricing and surprise bills.

- **Unlimited users on every plan.**
- **Local runs are free forever** (CLI on your laptop or your own CI runners).
- **Cloud runs** are counted in test minutes.
- **AI work** (explore, plan, write, heal, judge) is counted in credits. Replays from the lock use no credits.

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 1 project, unlimited local runs, 300 cloud minutes, 200 AI credits |
| Starter | $49/mo | 3 projects, 2,000 cloud minutes, 2,000 AI credits, GitHub App, schedules |
| Team | $199/mo | Unlimited projects, 10,000 cloud minutes, 10,000 AI credits, MCP, PR-aware runs, Slack |
| Business | Custom | SSO, private runners, data region, managed test writing |

Prices are a draft. Check them against the cost model before launch.

---

## 8. Roadmap

| Phase | Time | Ships | Proof it worked |
|---|---|---|---|
| 1. Core loop | Weeks 1–6 | Sign-in, projects, intent + lock files, Writer, run engine, run page with video and trace, test inboxes, billing | A stranger gets a passing test in 5 minutes |
| 2. Trust | Months 2–3 | Healer with diffs, Judge with failure sorting, smart retries, CLI, GitHub App, schedules, Slack | False failure rate under 2% |
| 3. Agent era | Months 3–5 | MCP server with `verify_change`, agent skill file, Explorer, Planner, app map, PR-aware runs | Claude Code and Cursor users run Claritia every day |
| 4. Reach | Months 5–8 | Chrome recorder, blocks, chat dock, tunnel, Insights, Playwright export and import | Non-coders write tests too |
| 5. Expand | Months 8–12 | API tests, visual compare, accessibility, managed test writing | Bigger deals per customer |
| 6. Scale | Year 2 | Browser grid, mobile, enterprise, SOC 2, self-hosted runners | Mid-market and enterprise contracts |

---

## 9. What it costs to run

First estimates. All prices are marked "check" until confirmed on vendor pages. Beta = 50 teams, Growth = 500 teams.

| After phase | Adds | Beta (monthly) | Growth (monthly) |
|---|---|---|---|
| 1. Core loop | Render web + workers, Supabase, R2, Claude (Writer), inbox service | about $520 | about $3,750 |
| 2. Trust | Claude for Healer and Judge, Slack | +$120 | +$1,200 |
| 3. Agent era | Claude for Explorer and Planner, more workers for explore runs | +$250 | +$2,400 |
| 4. Reach | Tunnel server, more storage for history | +$40 | +$300 |
| **Total by Phase 4** | | **about $930** | **about $7,650** |

At Growth, 500 teams on an average of $120 a month is $60,000 in revenue against about $7,650 in running cost.

---

## 10. What makes it hard to copy

- **The lock file.** Tests that run as plain Playwright are fast, cheap and trusted. Competitors that run AI on every step can't match the cost or speed.
- **The app map.** It gets richer with every run and makes PR-aware testing smarter over time.
- **The heal history.** Every approved or rejected fix trains better healing for that app.
- **The agent loop.** Once Claude Code checks its own work with Claritia, it becomes part of how a team ships.

## 11. Numbers to watch

- Time to first passing test (goal: under 5 minutes)
- False failure rate (goal: under 2%)
- Share of steps replayed from the lock (goal: over 90%)
- Heal approval rate
- Tests still green after 30 days with no edits
- AI cost per run
- Weekly MCP `verify_change` calls
- Free to paid conversion
