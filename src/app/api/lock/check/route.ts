import { parseLock } from "@/lib/lock";
import { requireUser } from "@/lib/serverAuth";

const MAX_CODE = 200_000;

/** Check a test's Playwright code against what Claritia can run. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const { code } = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof code !== "string") return Response.json({ error: "Missing code." }, { status: 400 });
  if (code.length > MAX_CODE) return Response.json({ ok: false, errors: [{ line: 1, message: "The code is too long." }] });
  const parsed = parseLock(code);
  return Response.json(parsed.ok ? { ok: true, steps: parsed.steps.length, actions: parsed.actionCount, secrets: parsed.secrets } : { ok: false, errors: parsed.errors.slice(0, 10) });
}
