import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { planById, type PlanId } from "./plans.ts";
import { APP_URL } from "./site.ts";

// Billing needs one setting: STRIPE_SECRET_KEY. Prices come from src/lib/plans.ts, and the app makes its own
// webhook and billing page in Stripe the first time they're needed.

const PAID: PlanId[] = ["starter", "team"];
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"];
const PAYING = new Set(["active", "trialing", "past_due"]);

export const appBase = () => process.env.APP_URL?.trim().replace(/\/+$/, "") || APP_URL;

/** Stripe, when STRIPE_SECRET_KEY is set. */
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? new Stripe(key) : null;
}

export const isPaidPlan = (plan: unknown): plan is "starter" | "team" => PAID.includes(plan as PlanId);

/** The checkout line for a plan: its monthly price from plans.ts, so there are no price ids to copy. */
export function lineFor(plan: "starter" | "team"): Stripe.Checkout.SessionCreateParams.LineItem {
  const p = planById(plan);
  return { quantity: 1, price_data: { currency: "usd", unit_amount: p.price! * 100, recurring: { interval: "month" }, product_data: { name: `Claritia ${p.name}` } } };
}

/** Make sure Stripe sends subscription events to this app. Done once per server start. */
let webhookReady: Promise<void> | null = null;
export function ensureWebhook(stripe: Stripe) {
  webhookReady ??= (async () => {
    const url = `${appBase()}/api/billing/webhook`;
    // Stripe only sends to public https addresses, so local runs skip this.
    if (!url.startsWith("https://")) return;
    const all = await stripe.webhookEndpoints.list({ limit: 100 });
    const found = all.data.find((w) => w.url === url && w.status === "enabled");
    if (found && EVENTS.every((e) => found.enabled_events.includes(e))) return;
    if (found) await stripe.webhookEndpoints.update(found.id, { enabled_events: EVENTS });
    else await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: "Claritia plans" });
  })().catch((e) => {
    webhookReady = null;
    throw e;
  });
  return webhookReady;
}

/** Stripe's billing page, set up by the app: cancel, change card, see invoices. */
let portalConfig: Promise<string> | null = null;
export function ensurePortal(stripe: Stripe) {
  portalConfig ??= (async () => {
    const all = await stripe.billingPortal.configurations.list({ limit: 100, active: true });
    const ours = all.data.find((c) => c.metadata?.claritia === "1");
    if (ours) return ours.id;
    const made = await stripe.billingPortal.configurations.create({
      metadata: { claritia: "1" },
      default_return_url: `${appBase()}/settings`,
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
    });
    return made.id;
  })().catch((e) => {
    portalConfig = null;
    throw e;
  });
  return portalConfig;
}

/**
 * Copy a subscription onto its workspace's plan. The workspace and plan come from the subscription's metadata, which
 * only this server sets at checkout. The plan only counts when the price matches it, and a canceled or unpaid
 * subscription puts the workspace back on Free.
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
  const asked = sub.metadata?.plan;
  const pricedRight = isPaidPlan(asked) && item?.price.unit_amount === planById(asked).price! * 100 && item.price.recurring?.interval === "month";
  const plan: PlanId = PAYING.has(sub.status) && pricedRight ? (asked as PlanId) : "free";
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

/**
 * A webhook call. Anyone can post here, so only the event's id is read from the body. The event itself is
 * fetched from Stripe with the secret key, which proves it's real without a webhook signing secret.
 */
export async function handleWebhook(stripe: Stripe, admin: SupabaseClient, body: string) {
  let id: unknown;
  try {
    id = (JSON.parse(body) as { id?: unknown }).id;
  } catch {
    return { ok: false as const, reason: "Not JSON." };
  }
  if (typeof id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(id)) return { ok: false as const, reason: "No event id." };
  const event = await stripe.events.retrieve(id);
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      if (s.mode !== "subscription" || !s.subscription) return { ok: true as const, skipped: true };
      // Fetch the subscription fresh, so an old event never undoes a newer change.
      return applySubscription(admin, await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id));
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscription(admin, await stripe.subscriptions.retrieve(event.data.object.id));
    default:
      return { ok: true as const, skipped: true };
  }
}
