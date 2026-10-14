import { stripeClient } from "@/lib/billing";
import { requireUser } from "@/lib/serverAuth";
import { APP_URL } from "@/lib/site";

/** Open Stripe's billing page, to change plan, card or cancel. Only the workspace's owner can. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const { sb, user } = auth;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown };
  if (typeof body.workspaceId !== "string") return Response.json({ error: "Missing workspace." }, { status: 400 });
  const stripe = stripeClient();
  if (!stripe) return Response.json({ error: "Billing isn't set up yet." }, { status: 503 });

  const { data: me } = await sb.from("workspace_members").select("role").eq("workspace_id", body.workspaceId).eq("user_id", user.id).maybeSingle();
  if (me?.role !== "owner") return Response.json({ error: "Only the workspace owner can manage billing." }, { status: 403 });
  const { data: billing } = await sb.from("workspace_billing").select("stripe_customer_id").eq("workspace_id", body.workspaceId).maybeSingle();
  if (!billing?.stripe_customer_id) return Response.json({ error: "This workspace has no billing yet." }, { status: 400 });

  const session = await stripe.billingPortal.sessions.create({ customer: billing.stripe_customer_id, return_url: `${process.env.APP_URL?.trim() || APP_URL}/settings` });
  return Response.json({ url: session.url });
}
