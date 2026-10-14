import { after } from "next/server";
import { planEvent, verifySignature } from "@/lib/github";
import { githubConfig } from "@/lib/githubApp";
import { handlePlan } from "@/lib/githubChecks";
import { serviceClient } from "@/lib/serviceClient";

/** GitHub's webhook for the Claritia app: pull requests, preview deploys, re-run requests and uninstalls. */
export async function POST(request: Request) {
  const config = githubConfig();
  const sb = serviceClient();
  if (!config || !sb) return Response.json({ error: "GitHub isn't set up on the server." }, { status: 500 });
  const body = await request.text();
  if (!verifySignature(body, request.headers.get("x-hub-signature-256"), config.webhookSecret)) return Response.json({ error: "Bad signature." }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Bad body." }, { status: 400 });
  }
  const plan = planEvent(request.headers.get("x-github-event"), payload, config.appId);
  if (plan.kind === "ignore") return Response.json({ ok: true, ignored: plan.why });
  // Answer GitHub at once (it waits 10 seconds at most), then pick the tests and start the check.
  after(async () => {
    const errors = await handlePlan(sb, plan).catch((e: Error) => [e.message]);
    if (errors.length) console.error(`GitHub ${plan.kind}: ${errors.join(" | ")}`);
  });
  return Response.json({ ok: true, accepted: plan.kind });
}
