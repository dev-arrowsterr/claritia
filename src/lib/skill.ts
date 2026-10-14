import { APP_URL } from "./site.ts";

/** The agent skill file for Claude Code and other agents that read SKILL.md. Served at /skill.md. */
export const SKILL = `---
name: claritia
description: Check a change in the running app with Claritia's end-to-end tests (real browser, plain-English steps). Use after changing UI or user flows, before saying a change works, or when asked to write or fix an end-to-end test.
---

# Claritia

Claritia runs end-to-end tests in a cloud browser. Tests are plain-English steps; Claritia writes and keeps the
Playwright code. Tools come from the \`claritia\` MCP server.

## Set up (once)

\`\`\`bash
claude mcp add --transport http claritia ${APP_URL}/api/mcp --header "Authorization: Bearer $CLARITIA_API_KEY"
\`\`\`

Make the key in Claritia → Settings → API keys.

## Check a change

1. \`list_projects\` to find the project and where it runs (environments).
2. Get the change live somewhere Claritia can reach: a preview deploy, staging, or localhost while
   \`npx claritia tunnel <port>\` runs on this machine (in the background) with \`base_url\` http://localhost:<port>.
3. \`verify_change\` with \`base_url\` (the preview) or \`environment\`. Pick \`use_case\` or \`tests\` that cover the
   change; with neither, every test runs.
4. Read each failure's kind:
   - **App bug**: the app did something wrong. Fix the code, deploy, verify again.
   - **Flaky**: failed again on its re-run, likely timing. Mention it; don't change app code for it.
   - **Setup**: the address or a secret wasn't reachable. Check base_url and the environment.
5. Tests still running come back with run ids: call \`get_results\` with them.

Say the change works only after the tests that cover it pass.

## Write or edit a test

\`get_test\` shows a test as YAML. \`save_test\` takes YAML and creates the test, or updates the test with the same name:

\`\`\`yaml
name: Checkout with a coupon
use_case: Checkout
priority: high
steps:
  - use: sign-in                  # a block of shared steps, by name
  - Add the blue hoodie to the cart
  - Type SAVE10 into the coupon field and apply it
  - check: The total drops 10%
\`\`\`

- One action per step, in the words a person would use. \`check:\` steps state what must be true.
- Passwords and keys: name them in the step ("Type process.env.LOGIN_PASSWORD into the password field") and add the
  value to the environment in Claritia. Never put a secret in a step.
- Claritia writes the code on the first run. Steps whose words don't change keep their code.

## Fixes

When the app's UI changes, Claritia's Healer may fix a step's code itself. \`list_fixes\` shows fixes waiting; a person
approves them in Claritia.
`;
