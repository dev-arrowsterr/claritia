import { APP_URL, CONTACT_EMAIL } from "@/lib/site";

export const dynamic = "force-static";

/** A short guide to Claritia for AI agents and LLMs, at /llms.txt. */
export function GET() {
  const text = `# Claritia

> Claritia is AI end-to-end testing. You describe a user flow in plain English, Claritia writes it as a Playwright test, runs it in a real browser in the cloud, and saves the video, trace, network log and screenshots.

## How it works

- A test is a list of plain-English steps. Each step is "do" (an action) or "check" (something that must be true).
- On the first run, Claude writes the Playwright code for each step while the browser runs it. Every line is checked against a fixed list of allowed actions before it runs.
- Passing code is saved to the test. Later runs replay it with no AI calls. A step is written again only when its words change.
- Test inboxes: a test can sign up with a fresh email address, then read the code or link from the email it gets.
- Secrets (passwords, API keys) are sealed before they're saved and hidden in errors, logs and traces.
- Runs can't reach private network addresses.

## Pages

- [Home](https://tryclaritia.com/): what Claritia does
- [Pricing](https://tryclaritia.com/pricing.md): plans, cloud minutes and AI credits, in Markdown
- [App](${APP_URL}): sign in and start testing

## Contact

${CONTACT_EMAIL}
`;
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
