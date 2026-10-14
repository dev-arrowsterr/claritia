# Export and import

**Settings → Project → Export tests** downloads a zip a team can keep in its repo and run with plain Playwright:

- `.claritia/tests/<test>.yaml`: each test in plain English (the same file as the YAML tab).
- `.claritia/lock/<test>.spec.ts`: its Playwright code. A test with no code yet gets its outline.
- `playwright.config.ts`: `baseURL` from the project's first environment, or `BASE_URL`.
- `.claritia/README.md`: how to run them, which secrets they read from environment variables, and which tests use
  Claritia's test inboxes (those only run in Claritia).

**Import tests** takes Claritia YAML files and Playwright specs (`.ts`, `.js`):

- An exported YAML and spec pair comes back as one test with its code.
- A plain Playwright spec gets one step per line, named from what the line does ("Click the "Sign in" button",
  "The "Dashboard" heading shows"), in the use case Imported. Its code runs as is, with no AI.
- Lines Claritia can't run (like `page.evaluate`) skip that test, with the reason. `process.env.NAME!` is read as
  a secret.
- A name already in the project gets "(imported)" added; nothing is overwritten.

`src/lib/transfer.ts`, `/api/export`, `/api/import`. Running cost: $0.
