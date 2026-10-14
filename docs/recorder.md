# Chrome recorder

Click through your site and the Claritia Recorder saves what you did as a test: plain-English steps with one line of
Playwright code each, ready to run in Claritia with no AI.

1. Install (until it's on the Chrome Web Store): `npm run pack:extension`, then Chrome → `chrome://extensions` →
   Developer mode → **Load unpacked** → the `extension/` folder.
2. Open the recorder and click **Connect to Claritia**. It opens app.tryclaritia.com/extension (signed in); click
   **Connect Claritia Recorder** there. The app makes a key named "Chrome recorder" (revocable in Settings → API
   keys) and hands it to the extension, which takes it only from the Claritia app's own address. If the extension
   doesn't answer, the key is revoked again. **Use an API key** in the popup still works too.
3. Open your site, click **Record**, and use the site. **Add check** makes the next click a check that the element
   shows, instead of a click (the element under the pointer is outlined in blue).
4. **Stop**, remove any step with ×, name the test, pick the project, **Save test**.

What it records: clicks on buttons and links, typing (one step per field, with the final value), Enter, ticking and
unticking, choosing from a dropdown, and checks. Locators prefer a test id, then a label, a placeholder, the role and
name, then exact text, telling identical elements apart with `nth()`. Clicking into a field before typing isn't a
step. **Passwords are never recorded**: a password field records `process.env.PASSWORD`; add PASSWORD to the
environment in Claritia.

## How it works

- `extension/content.js` runs in pages and records while its tab is recording; `extension/background.js` keeps the
  steps (merging typing in the same field, `extension/steps.js`) and saves through `POST /api/v1/tests`, which puts
  each step's code under its step comment and checks the whole test before saving.
- `scripts/recorder-check.ts` records a session on a local site with a real browser (sign-in with a password, two
  identical buttons, a check, a checkbox, a dropdown, Enter, a test id, an icon button, a link to a new page and a
  check there), then replays the recorded test with the runner: every step passes.
- `scripts/connect-check.ts` loads the extension in Chrome: a look-alike page on another address is refused, and the
  app's /extension page connects it so the popup lists the projects.
- `scripts/pack-extension.ts` makes the icons and `dist/claritia-recorder.zip` for the Chrome Web Store.

## Running cost

$0 at Beta (50 teams) and Growth (500 teams): no AI and no servers. The Chrome Web Store charges a one-time $5 to
publish (check).
