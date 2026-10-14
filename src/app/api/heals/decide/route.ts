import { lockSections, parseLock, replaceStepCode } from "@/lib/lock";
import { requireUser } from "@/lib/serverAuth";

type Heal = { id: string; test_id: string; position: number; old_code: string; new_code: string; status: string };

/**
 * Approve or reject a fix from the Healer. Approving swaps that step's code in the test, through the normal save,
 * so it gets a version with the person's name. A fix only applies while the step still has the code it fixed.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const { sb } = auth;
  const body = (await request.json().catch(() => ({}))) as { healId?: unknown; decision?: unknown };
  if (typeof body.healId !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) return Response.json({ error: "Missing fix or decision." }, { status: 400 });

  const { data: heal, error } = await sb.from("heals").select("id, test_id, position, old_code, new_code, status").eq("id", body.healId).maybeSingle<Heal>();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!heal) return Response.json({ error: "Fix not found." }, { status: 404 });
  if (heal.status !== "pending") return Response.json({ error: `This fix was already ${heal.status}.` }, { status: 409 });

  const decide = async (status: "approved" | "rejected" | "stale") => {
    const { error: e } = await sb.rpc("decide_heal", { p_heal: heal.id, p_status: status });
    return e;
  };

  if (body.decision === "rejected") {
    const e = await decide("rejected");
    return e ? Response.json({ error: e.message }, { status: 400 }) : Response.json({ ok: true });
  }

  const { data: test, error: testErr } = await sb.from("tests").select("id, lock, version").eq("id", heal.test_id).maybeSingle<{ id: string; lock: string | null; version: number }>();
  if (testErr) return Response.json({ error: testErr.message }, { status: 500 });
  if (!test) return Response.json({ error: "The test was deleted." }, { status: 404 });

  // The step must still have the code this fix replaces. Otherwise someone changed it, and the fix is out of date.
  const current = (lockSections(test.lock ?? "").get(heal.position) ?? []).join("\n");
  const next = parseLock(test.lock ?? "").ok && current === heal.old_code ? replaceStepCode(test.lock!, heal.position, heal.new_code.split("\n")) : null;
  if (!next) {
    await decide("stale");
    return Response.json({ error: "This step's code changed since the fix was made. The next run makes a new fix if it's still needed." }, { status: 409 });
  }

  const { data: saved, error: saveErr } = await sb.from("tests").update({ lock: next }).eq("id", test.id).eq("version", test.version).select("version");
  if (saveErr) return Response.json({ error: saveErr.message }, { status: 500 });
  if (!saved?.length) return Response.json({ error: "Someone saved this test just now. Try again." }, { status: 409 });
  const e = await decide("approved");
  return e ? Response.json({ error: e.message }, { status: 400 }) : Response.json({ ok: true, version: saved[0]!.version });
}
