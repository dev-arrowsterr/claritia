// Test inboxes receive mail through Resend. Resend calls /api/inbox/resend for each email that reaches the
// inbox domain, and the app fetches the email from Resend's API with its own key, which proves it's real.

/** <inbox id>-<anything>@<domain> → the inbox id and the full address, or null for mail that isn't ours. */
export function readRecipient(recipient: string, domain: string) {
  const address = recipient.trim().toLowerCase().replace(/^.*</, "").replace(/>.*$/, "");
  const at = address.lastIndexOf("@");
  if (at < 1 || address.slice(at + 1) !== domain.toLowerCase()) return null;
  const local = address.slice(0, at);
  const inboxId = local.split("-")[0]!;
  if (!/^[0-9a-f]{8}$/.test(inboxId) || !/^[a-z0-9-]{1,64}$/.test(local)) return null;
  return { inboxId, address };
}

/** The first address in a list that belongs to a test inbox. */
export function firstInbox(recipients: unknown, domain: string) {
  const list = Array.isArray(recipients) ? recipients : typeof recipients === "string" ? recipients.split(",") : [];
  for (const r of list) {
    if (typeof r !== "string") continue;
    const hit = readRecipient(r, domain);
    if (hit) return hit;
  }
  return null;
}

export type ReceivedEmail = { id: string; from: string; to: string[]; subject: string; text: string; html: string };

/** Fetch a received email from Resend. Throws on anything but a found email. */
export async function fetchReceived(apiKey: string, id: string, fetcher: typeof fetch = fetch): Promise<ReceivedEmail> {
  const res = await fetcher(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Resend answered ${res.status}.`);
  const e = (await res.json()) as { id?: string; from?: string; to?: string[] | string; subject?: string; text?: string | null; html?: string | null };
  return { id: e.id ?? id, from: e.from ?? "", to: Array.isArray(e.to) ? e.to : e.to ? [e.to] : [], subject: e.subject ?? "", text: e.text ?? "", html: e.html ?? "" };
}
