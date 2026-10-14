import { handleStripeEvent, stripeClient } from "@/lib/billing";
import { serviceClient } from "@/lib/serviceClient";

/** Stripe tells us when a subscription starts, changes or ends. The signature proves it came from Stripe. */
export async function POST(request: Request) {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const admin = serviceClient();
  if (!stripe || !secret || !admin) return Response.json({ error: "Billing isn't set up." }, { status: 503 });

  const body = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, request.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return Response.json({ error: "Bad signature." }, { status: 400 });
  }
  const result = await handleStripeEvent(stripe, admin, event);
  return Response.json(result);
}
