import { handleWebhook, stripeClient } from "@/lib/billing";
import { serviceClient } from "@/lib/serviceClient";

/** Stripe tells us when a subscription starts, changes or ends. Each event is checked by fetching it back from Stripe. */
export async function POST(request: Request) {
  const stripe = stripeClient();
  const admin = serviceClient();
  if (!stripe || !admin) return Response.json({ error: "Billing isn't set up." }, { status: 503 });
  try {
    const result = await handleWebhook(stripe, admin, await request.text());
    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch {
    return Response.json({ error: "Unknown event." }, { status: 400 });
  }
}
