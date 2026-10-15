import { seal, unseal } from "@/lib/seal";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";
import { checkConnection, cleanBaseUrl, isProduct, keyHint, PRODUCTS, type Product } from "@/lib/suite";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Auth = Exclude<Awaited<ReturnType<typeof requireUser>>, { denied: Response }>;

async function roleIn(auth: Auth, workspaceId: string) {
  const { data } = await auth.sb.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", auth.user.id).maybeSingle<{ role: string }>();
  return data?.role ?? null;
}

/**
 * Connect a suite product: { workspaceId, product, baseUrl, key, brand? }. Owners only. The key is checked with the
 * product, sealed and saved, even when the check fails, so "Check again" works once the product is ready.
 * With { workspaceId, product, check: true }, any member checks the saved connection again.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; product?: unknown; baseUrl?: unknown; key?: unknown; brand?: unknown; check?: unknown };
  if (typeof body.workspaceId !== "string") return bad("Missing workspace.");
  if (!isProduct(body.product)) return bad("Pick Omniscient or Arrowsterr.");
  const product: Product = body.product;
  const role = await roleIn(auth, body.workspaceId);
  if (!role) return bad("Workspace not found.", 404);
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for suite connections.", 500);

  if (body.check === true) {
    const { data: saved } = await sb.from("suite_connections").select("base_url, key_sealed").eq("workspace_id", body.workspaceId).eq("product", product).maybeSingle<{ base_url: string; key_sealed: string }>();
    if (!saved) return bad(`${PRODUCTS[product].name} isn't connected.`, 404);
    let key: string;
    try {
      key = unseal(saved.key_sealed);
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 500);
    }
    const result = await checkConnection(product, saved.base_url, key);
    await sb
      .from("suite_connections")
      .update({ status: result.ok ? "ok" : "error", error: result.ok ? null : result.error, checked_at: new Date().toISOString() })
      .eq("workspace_id", body.workspaceId)
      .eq("product", product);
    return Response.json(result.ok ? { ok: true, detail: result.detail } : { ok: false, error: result.error });
  }

  if (role !== "owner") return bad("Only the workspace owner can connect products.", 403);
  const base = cleanBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : "");
  if ("error" in base) return bad(base.error);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key.length < 8 || key.length > 500 || /\s/.test(key)) return bad(`Paste the API key from ${PRODUCTS[product].name}.`);
  const brand = product === "arrowsterr" && typeof body.brand === "string" && body.brand.trim() ? body.brand.trim().slice(0, 200) : null;

  let sealed: string;
  try {
    sealed = seal(key);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
  const result = await checkConnection(product, base.url, key);
  const { error } = await sb.from("suite_connections").upsert(
    {
      workspace_id: body.workspaceId,
      product,
      base_url: base.url,
      key_sealed: sealed,
      key_hint: keyHint(key),
      brand,
      status: result.ok ? "ok" : "error",
      error: result.ok ? null : result.error,
      checked_at: new Date().toISOString(),
      connected_by: auth.user.id,
    },
    { onConflict: "workspace_id,product" },
  );
  if (error) return bad(error.message, 500);
  await sb.from("audit_log").insert({ workspace_id: body.workspaceId, actor: auth.user.id, action: "suite.connect", target: product, data: { base_url: base.url, ok: result.ok } });
  return Response.json(result.ok ? { ok: true, detail: result.detail } : { ok: false, error: result.error });
}

/** Disconnect a suite product: { workspaceId, product }. Owners only. */
export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; product?: unknown };
  if (typeof body.workspaceId !== "string") return bad("Missing workspace.");
  if (!isProduct(body.product)) return bad("Pick Omniscient or Arrowsterr.");
  const role = await roleIn(auth, body.workspaceId);
  if (!role) return bad("Workspace not found.", 404);
  if (role !== "owner") return bad("Only the workspace owner can disconnect products.", 403);
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for suite connections.", 500);
  const { error } = await sb.from("suite_connections").delete().eq("workspace_id", body.workspaceId).eq("product", body.product);
  if (error) return bad(error.message, 500);
  await sb.from("audit_log").insert({ workspace_id: body.workspaceId, actor: auth.user.id, action: "suite.disconnect", target: body.product });
  return Response.json({ ok: true });
}
