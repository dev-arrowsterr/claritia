import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import Stripe from "stripe";
import { applySubscription, handleStripeEvent } from "../src/lib/billing.ts";
import { readRecipient, verifyMailgun } from "../src/lib/mailgun.ts";

process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_TEAM = "price_team";

test("Mailgun requests are checked by their signature and age", () => {
  const key = "key-test";
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const sig = createHmac("sha256", key).update(ts + "tok").digest("hex");
  assert.ok(verifyMailgun(key, ts, "tok", sig, now));
  assert.ok(!verifyMailgun(key, ts, "tok2", sig, now), "another token");
  assert.ok(!verifyMailgun("other", ts, "tok", sig, now), "another key");
  assert.ok(!verifyMailgun(key, ts, "tok", sig, now + 20 * 60_000), "too old");
  assert.ok(!verifyMailgun(key, ts, "tok", "nothex", now));
  assert.ok(!verifyMailgun("", ts, "tok", sig, now));
});

test("inbox addresses map to a project's inbox id", () => {
  assert.deepEqual(readRecipient("a1b2c3d4-signup-1f2e3d@inbox.tryclaritia.com", "inbox.tryclaritia.com"), { inboxId: "a1b2c3d4", address: "a1b2c3d4-signup-1f2e3d@inbox.tryclaritia.com" });
  assert.equal(readRecipient("Sam <A1B2C3D4-X@Inbox.TryClaritia.com>", "inbox.tryclaritia.com")?.inboxId, "a1b2c3d4");
  assert.equal(readRecipient("a1b2c3d4@evil.com", "inbox.tryclaritia.com"), null);
  assert.equal(readRecipient("nothex-x@inbox.tryclaritia.com", "inbox.tryclaritia.com"), null);
});

/** A stand-in for the admin Supabase client: just workspace_billing. */
function fakeAdmin(rows: Record<string, unknown>[] = []) {
  return {
    rows,
    from: () => ({
      select: () => ({ eq: (k: string, v: unknown) => ({ maybeSingle: async () => ({ data: rows.find((r) => r[k] === v) ?? null }) }) }),
      upsert: async (row: Record<string, unknown>) => {
        const at = rows.findIndex((r) => r.workspace_id === row.workspace_id);
        if (at >= 0) rows[at] = { ...rows[at], ...row };
        else rows.push(row);
        return { error: null };
      },
    }),
  };
}
const sub = (status: string, price: string, metadata: Record<string, string> = {}) =>
  ({ id: "sub_1", status, customer: "cus_1", metadata, items: { data: [{ price: { id: price }, current_period_start: 1_760_000_000, current_period_end: 1_762_600_000 }] } }) as unknown as Stripe.Subscription;

test("a subscription sets the workspace's plan, and canceling puts it back on Free", async () => {
  const admin = fakeAdmin([{ workspace_id: "ws1", stripe_customer_id: "cus_1", plan: "free" }]);
  await applySubscription(admin as never, sub("active", "price_team"));
  assert.equal(admin.rows[0]!.plan, "team");
  assert.equal(admin.rows[0]!.period_end, new Date(1_762_600_000_000).toISOString());
  await applySubscription(admin as never, sub("past_due", "price_starter"));
  assert.equal(admin.rows[0]!.plan, "starter");
  await applySubscription(admin as never, sub("canceled", "price_starter"));
  assert.equal(admin.rows[0]!.plan, "free");
  assert.equal(admin.rows[0]!.stripe_subscription_id, null);
  await applySubscription(admin as never, sub("active", "price_unknown"));
  assert.equal(admin.rows[0]!.plan, "free", "an unknown price never grants a plan");
  const none = await applySubscription(fakeAdmin() as never, sub("active", "price_team"));
  assert.equal(none.ok, false);
});

test("the webhook only trusts events signed with the secret", async () => {
  const stripe = new Stripe("sk_test_x");
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated", data: { object: sub("active", "price_starter", { workspace_id: "ws9" }) } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = stripe.webhooks.constructEvent(payload, header, secret);
  const admin = fakeAdmin();
  const res = await handleStripeEvent(stripe, admin as never, event);
  assert.equal(res.ok, true);
  assert.equal(admin.rows[0]!.workspace_id, "ws9");
  assert.equal(admin.rows[0]!.plan, "starter");
  assert.throws(() => stripe.webhooks.constructEvent(payload.replace("starter", "team"), header, secret));
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, "whsec_other"));
});
