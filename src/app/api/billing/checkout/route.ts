import { appBase, ensureWebhook, isPaidPlan, lineFor, stripeClient } from "@/lib/billing";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

/** Start a Stripe checkout for a paid plan. Only the workspace's owner can. Returns the checkout page's address. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const { sb, user } = auth;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; plan?: unknown };
  if (typeof body.workspaceId !== "string" || !isPaidPlan(body.plan)) return Response.json({ error: "Pick a plan." }, { status: 400 });
  const plan = body.plan;

  const stripe = stripeClient();
  const admin = serviceClient();
  if (!stripe || !admin) return Response.json({ error: "Billing isn't set up yet." }, { status: 503 });

  const { data: me } = await sb.from("workspace_members").select("role").eq("workspace_id", body.workspaceId).eq("user_id", user.id).maybeSingle();
  if (me?.role !== "owner") return Response.json({ error: "Only the workspace owner can change the plan." }, { status: 403 });

  // One Stripe customer per workspace, made on the first checkout.
  const { data: billing } = await admin.from("workspace_billing").select("stripe_customer_id, stripe_subscription_id, plan").eq("workspace_id", body.workspaceId).maybeSingle();
  if (billing?.stripe_subscription_id && billing.plan !== "free") return Response.json({ error: "Change your plan from Manage billing." }, { status: 409 });
  let customer = billing?.stripe_customer_id as string | undefined;
  if (!customer) {
    const made = await stripe.customers.create({ email: user.email, metadata: { workspace_id: body.workspaceId } });
    customer = made.id;
    const { error } = await admin.from("workspace_billing").upsert({ workspace_id: body.workspaceId, stripe_customer_id: customer }, { onConflict: "workspace_id" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }

  await ensureWebhook(stripe);
  const base = appBase();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: body.workspaceId,
    line_items: [lineFor(plan)],
    subscription_data: { metadata: { workspace_id: body.workspaceId, plan } },
    allow_promotion_codes: true,
    success_url: `${base}/settings?billing=done`,
    cancel_url: `${base}/settings`,
  });
  return Response.json({ url: session.url });
}
