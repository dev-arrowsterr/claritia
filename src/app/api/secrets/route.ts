import { requireUser } from "@/lib/serverAuth";
import { SECRET_NAME, seal } from "@/lib/seal";

const MAX_VALUE = 4096;

/** Add or replace a secret on an environment. The value is sealed here and never sent back. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = await request.json().catch(() => ({}));
  const { environmentId, name, value } = body as { environmentId?: unknown; name?: unknown; value?: unknown };
  if (typeof environmentId !== "string" || !environmentId) return Response.json({ error: "Missing environment." }, { status: 400 });
  if (typeof name !== "string" || !SECRET_NAME.test(name)) return Response.json({ error: "Use capital letters, numbers and _ for the name, like LOGIN_PASSWORD." }, { status: 400 });
  if (typeof value !== "string" || !value) return Response.json({ error: "Enter a value." }, { status: 400 });
  if (value.length > MAX_VALUE) return Response.json({ error: "That value is too long." }, { status: 400 });

  let sealed: string;
  try {
    sealed = seal(value);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Runs as the caller: the database checks they belong to the environment's workspace.
  const { data, error } = await auth.sb.rpc("set_secret", { p_env: environmentId, p_name: name, p_sealed: sealed });
  if (error) return Response.json({ error: error.message }, { status: /not found/i.test(error.message) ? 404 : 400 });
  return Response.json({ id: data });
}
