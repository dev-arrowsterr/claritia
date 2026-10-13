# Claritia homepage plan

Built the same way as the Omniscient homepage (`dev-omniscient/omniscient`, `src/app/page.tsx`): one long page, white and `canvas` sections taking turns, square framed cards, `// ` mono captions, a black primary button, blue for the one highlighted word, and two dark sections for weight. The product picture in the hero is built in HTML (like `HeroMock.tsx`) so it stays sharp and loads fast.

Domain idea: `tryclaritia.com` for the site and `app.tryclaritia.com` for the app, served by one Render service with a proxy that splits them (copy `src/proxy.ts`).

## Page order

| # | Section | Ground | Job |
|---|---|---|---|
| 1 | Header | white, sticky | Nav and "Start free" |
| 2 | Hero | white + dot grid | Say what it is in one line, show a test run |
| 3 | Works with | `canvas` strip | Show it fits their stack |
| 4 | How it works | white | Four steps from sentence to green check |
| 5 | The product (bento) | `canvas` | Four proof cards |
| 6 | The agent | white | Explore, heal, sort, write from a spec |
| 7 | Developers | dark `ink` | Repo files, CI gate, MCP, export |
| 8 | Security | white | Secrets, isolation, data rules |
| 9 | Pricing | `canvas` | Free, Starter, Team, Business |
| 10 | Final call | dark `ink` | One last push to start |
| 11 | Footer | white | Links and status |

## 1. Header

- Logo left. Nav: Product, Agent, Developers, Security, Pricing.
- Right side: "Sign in" (ghost) and "Start free →" (black).

## 2. Hero

- Badge link: `NEW` tag + "Tests from plain English" → `#agent`. After Phase 3, swap to "Claude Code and Cursor can now run your tests".
- Headline (76px desktop, 44px phone):
  > Tests that write
  > **and fix themselves.** (brand blue)
- Lead: "Describe a user flow in plain English. Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes. Every run comes with a video."
- Buttons: "Start free" (black) and "Watch a test run" (outline).
- Small line: "Free tier · No card needed · Export to Playwright any time"
- **Hero picture (`HeroMock`)**: a run viewer.
  - Window bar: `// fig. 01 — run #482` and `app.tryclaritia.com/runs/482`.
  - Left column: the test's steps in plain English, each with a tag: `PASSED`, `CACHED`, `HEALED`, one `FAILED`.
    1. Go to the pricing page `CACHED`
    2. Click "Start trial" `CACHED`
    3. Sign up with a test inbox `PASSED`
    4. Enter the code from the email `PASSED`
    5. Check the plan says "Pro trial" `HEALED`
  - Right column: a video frame (a still of a checkout page) with a scrub bar and "0:14 / 0:31".
  - Floating card, bottom right: "Healing suggestion". Old selector struck through, new one beside it, a short reason ("Button text changed from 'Start trial' to 'Try free'"), buttons Approve and Skip.
  - Floating dark card, top left: `// test` with the sentence "Sign up, confirm the email, and land on the Pro trial."

## 3. Works with

Mono capitals in a row: GitHub, GitLab, Vercel, Netlify, Slack, Playwright, Claude Code, Cursor.
Only list what works on launch day. Add the rest as they ship.

## 4. How it works

Eyebrow `// How it works`. Heading: "From a sentence to a green check." Lead: "No selectors to write and no scripts to fix. Tell Claritia what a user does, and it handles the rest."

Four cells in one framed strip:
| Step | Title | Body |
|---|---|---|
| 01 | Describe | Write the flow the way you'd explain it to a new teammate. Or paste your spec. |
| 02 | Run | Claritia drives a real browser, step by step, and saves video, screenshots and logs. |
| 03 | Heal | When your UI changes, Claritia finds the new button and asks you to approve the fix. |
| 04 | Gate | Tests run on every pull request. A failure blocks the merge and posts the video. |

## 5. The product (bento)

Eyebrow `// The product`. Heading: "Every failure, explained." Lead: "Real bugs get flagged. Flaky ones get sorted out. You only look at what matters."

- **Run viewer** (wide, 4 cols): "See exactly what broke." Video, trace, console and network in one screen. Mini mock: a step list with a red tag on step 4 and the error line under it.
- **Failure sorting** (2 cols): "Bug, flake or setup?" Each failure gets a label with its reason. Mock card: `// verdict · app bug`, "Checkout total shows $0.00", quote of the console error, "Run #482 · step 4 · 0:14".
- **Plain-English checks** (3 cols): "Check what a person would check." Mock chat: you type "the total drops 10% after the coupon", Claritia replies "Passed. $120.00 → $108.00" with source tags `STEP 6` `SCREENSHOT` `DOM`.
- **Tests in your repo** (3 cols): "Your tests live with your code." Mock file tree: `.claritia/checkout.yaml`, `signup.yaml`, `billing.yaml`, each with a pass tag.

## 6. The agent

Eyebrow `// Agent`. Heading: "A QA engineer that never sleeps." Lead: "The agent explores your app, writes tests, and keeps them green. Anything that changes a test waits for your yes."

Check list:
- Crawls a URL and suggests the tests you're missing
- Writes tests from your PRD or product spec
- Fixes broken selectors and shows you the change
- Sorts every failure into bug, flake or setup

Right side: a framed "Agent runs" list with a `Live` pulse, like Omniscient's:
| Agent | What | Tag |
|---|---|---|
| Explore | acme.com · 12 tests suggested | `NEEDS REVIEW` (amber) |
| Heal | checkout.yaml · selector updated | `NEEDS APPROVAL` (amber) |
| Sort | run #482 · app bug | `DONE` (green) |
| Nightly | 48 tests on production | `SCHEDULED 2:00` (brand) |

## 7. Developers (dark)

Eyebrow `// Built for developers`. Heading: "Plain files. Real Playwright. No lock-in." Lead: "Every test is a YAML file in your repo. Run it from your laptop, in CI, or from Claude Code. Export to plain Playwright code whenever you want."

Four facts on the left:
- **Repo files**: tests are reviewed in pull requests like code
- **CI gate**: a GitHub Action blocks merges on failure
- **MCP server**: Claude Code and Cursor write and run tests
- **Playwright export**: take your tests with you any time

Right: a code window titled `checkout.yaml`:
```yaml
name: Checkout with a coupon
url: https://staging.acme.com
steps:
  - Add the blue hoodie to the cart
  - Apply the coupon SAVE10
  - Check the total drops 10%
  - Pay with the test card
  - Check the page says "Order confirmed"
```
Footer line: `$ claritia run checkout.yaml`

Stat strip (four cells). Use only numbers we can prove. Until launch, show targets as product facts:
- `// to your first passing test` — "5 min"
- `// runs saved with video` — "100%"
- `// lines of selector code` — "0"
- `// lock-in` — "None"

## 8. Security

Eyebrow `// Security`. Heading: "Your staging site and secrets stay safe."
Four cards with the shield icon:
- **Encrypted secrets**: passwords and API keys are encrypted and never shown in logs or videos.
- **Isolated runs**: every run gets a fresh browser in its own container, wiped when it ends.
- **Never used for training**: your app, tests and videos are never used to train AI models.
- **Delete any time**: remove a project and its runs, videos and secrets are gone.

## 9. Pricing

Eyebrow `// Pricing`. Heading: "Start free. Pay for what runs." Lead: "Every plan includes the AI. Steps that replay from cache cost less."

| Plan | Price | Note | Items | Button |
|---|---|---|---|---|
| Free | $0 | for side projects | 1 project, 500 steps a month, video for every run | Start free |
| Starter | $49 | per month | 5,000 steps, GitHub Action, Slack alerts, schedules | Start free |
| Team (featured) | $199 | per month | 25,000 steps, self-healing, failure sorting, 5 seats, MCP server | Start a free trial |
| Business | Custom | yearly | Higher limits, SSO, private runners, managed test writing | Talk to us |

Small line under it: "Extra steps: $5 per 1,000. Managed service: we write and keep your top flows green."
Prices are a draft. Check them against the cost model before launch (see `docs/plan.md`).

## 10. Final call (dark)

Heading: "Stop fixing tests. Start shipping." Lead: "Write your first test in plain English and watch it run in the next five minutes."
Buttons: "Start free" (white) and "Talk to us" (outline).

## 11. Footer

- Logo, one line ("Tests that write and fix themselves."), and the `All systems running` status tag.
- Columns: Product (Run viewer, Agent, Pricing, Changelog), Developers (Docs, CLI, GitHub Action, MCP server), Company (Contact, Privacy, Terms).

## Later pages (for growth)

Same layout as the homepage sections, each one its own route:
- `/vs/momentic`, `/vs/testsprite`, `/vs/qa-wolf`, `/vs/browserstack`: a comparison table and "when to pick each".
- `/alternatives/cypress-cloud` and other "best of" lists.
- `/guides/playwright-*`: Playwright guides for search and AI answers.
- `/tools/flaky-test-finder`: the free tool for top-of-funnel traffic.
- Track all of these in Arrowsterr for AI answer visibility.

## Build notes

- Copy from Omniscient: `Site.tsx` (header and footer), `globals.css` tokens, the `Eyebrow` and `Check` helpers, the `frame` corner marks, `dot-grid` and `mk-dots` backgrounds, and the `mk-fade` and `mk-pulse` motion.
- New: `HeroMock` (run viewer), `Logo` (Claritia mark), the YAML code window.
- The hero picture is HTML. No screenshots or videos on the homepage until the real app is ready.
