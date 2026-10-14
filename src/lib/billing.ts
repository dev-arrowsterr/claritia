import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanId } from "./plans";

/** Stripe, when STRIPE_SECRET_KEY is set. */
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? new Stripe(key) : null;
}

/** The Stripe price for each paid plan, from STRIPE_PRICE_STARTER and STRIPE_PRICE_TEAM. */
export function priceFor(plan: PlanId) {
  if (plan === "starter") return process.env.STRIPE_PRICE_STARTER?.trim() || null;
  if (plan === "team") return process.env.STRIPE_PRICE_TEAM?.trim() || null;
  return null;
}

export function planForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === priceFor("starter")) return "starter";
  if (priceId === priceFor("team")) return "team";
  return null;
}

const PAYING = new Set(["active", "trialing", "past_due"]);

/**
 * Copy a subscription onto its workspace's plan. The workspace comes from the subscription's metadata,
 * or from the customer we saved at checkout. A canceled or unpaid subscription puts the workspace back on Free.
 */
export async function applySubscription(admin: SupabaseClient, sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let workspaceId = sub.metadata?.workspace_id || null;
  if (!workspaceId) {
    const { data } = await admin.from("workspace_billing").select("workspace_id").eq("stripe_customer_id", customerId).maybeSingle();
    workspaceId = (data as { workspace_id: string } | null)?.workspace_id ?? null;
  }
  if (!workspaceId) return { ok: false as const, reason: "No workspace for this subscription." };

  const item = sub.items.data[0];
  const paidPlan = planForPrice(item?.price.id);
  const plan: PlanId = PAYING.has(sub.status) && paidPlan ? paidPlan : "free";
  const at = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : null);
  const { error } = await admin.from("workspace_billing").upsert(
    {
      workspace_id: workspaceId,
      plan,
      status: sub.status,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.status === "canceled" ? null : sub.id,
      period_start: at(item?.current_period_start),
      period_end: at(item?.current_period_end),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  return { ok: true as const, workspaceId, plan };
}

/** What the webhook does with each Stripe event it cares about. */
export async function handleStripeEvent(stripe: Stripe, admin: SupabaseClient, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      if (s.mode !== "subscription" || !s.subscription) return { ok: true as const, skipped: true };
      const sub = typeof s.subscription === "string" ? await stripe.subscriptions.retrieve(s.subscription) : s.subscription;
      if (!sub.metadata?.workspace_id && s.client_reference_id) sub.metadata = { ...sub.metadata, workspace_id: s.client_reference_id };
      return applySubscription(admin, sub);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscription(admin, event.data.object);
    default:
      return { ok: true as const, skipped: true };
  }
}
