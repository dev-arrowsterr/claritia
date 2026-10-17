import { checkSns, parseSesEvent, SUBSCRIBE_HOST, type SnsMessage } from "@/lib/email/sns";
import { serviceClient } from "@/lib/serviceClient";

// SES events through SNS (docs/marketing-platform.md M3). Each message is checked against Amazon's certificate and
// our topic before anything changes. SNS retries anything that isn't 2xx, and ses_event_apply counts each once.
export async function POST(request: Request) {
  const topic = process.env.SES_SNS_TOPIC_ARN?.trim();
  const db = serviceClient();
  if (!topic || !db) return Response.json({ error: "Not set up." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 256_000) return Response.json({ error: "Too large." }, { status: 413 });
  let m: SnsMessage;
  try {
    m = JSON.parse(raw) as SnsMessage;
  } catch {
    return Response.json({ error: "Not JSON." }, { status: 400 });
  }
  const bad = await checkSns(m, topic).catch((e: Error) => `Couldn't check the signature: ${e.message}`);
  if (bad) return Response.json({ error: bad }, { status: 403 });

  if (m.Type === "SubscriptionConfirmation") {
    if (!m.SubscribeURL || !SUBSCRIBE_HOST.test(m.SubscribeURL)) return Response.json({ error: "Bad subscribe address." }, { status: 400 });
    const res = await fetch(m.SubscribeURL, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    return res?.ok ? Response.json({ ok: true }) : Response.json({ error: "Couldn't confirm." }, { status: 502 });
  }
  if (m.Type !== "Notification") return Response.json({ ok: true });

  const event = parseSesEvent(m);
  if (!event) return Response.json({ ok: true, ignored: true });
  const { data, error } = await db.rpc("ses_event_apply", { p_event: event });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, result: data });
}
