// Product and billing tools (docs/contact-sources.md Part 7): Stripe customers come in as customers, Intercom
// users and leads with their email preference. Endpoints rechecked against a real account before launch ("check").

import { qs, readCursor } from "./ctx.ts";
import type { Connector, Page } from "./types.ts";

type StripeCustomer = { id: string; email: string | null; name: string | null; phone: string | null; address?: { country?: string | null } | null; created: number; deleted?: boolean };

export const stripe: Connector = {
  kind: "stripe",
  objects: ["contacts"],
  gapMs: 100,
  async account(ctx) {
    const d = await ctx.api<{ id: string; business_profile?: { name?: string }; settings?: { dashboard?: { display_name?: string } } }>("https://api.stripe.com/v1/account");
    return { id: d.id, label: d.settings?.dashboard?.display_name || d.business_profile?.name || d.id };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    // Stripe lists newest first with no "changed since", so each run reads it all; unchanged rows are skipped.
    const c = readCursor<{ after: string | null }>(cursor, { after: null });
    const d = await ctx.api<{ data: StripeCustomer[]; has_more: boolean }>(`https://api.stripe.com/v1/customers?${qs({ limit: 100, starting_after: c.after })}`);
    const records = (d.data ?? []).map((x) => ({ id: x.id, deleted: !!x.deleted, data: { email: x.email, name: x.name, phone: x.phone, country: x.address?.country ?? null, lifecycle: "customer" } }));
    const last = d.data?.[d.data.length - 1]?.id ?? null;
    return { records, cursor: d.has_more && last ? JSON.stringify({ after: last }) : null, more: !!d.has_more };
  },
  defaults: { contact: { email: "email", name: "name", phone: "phone", country: "country", lifecycle: "lifecycle" } },
};

type IcContact = { id: string; email: string | null; name: string | null; phone: string | null; role: string; location?: { country?: string | null }; unsubscribed_from_emails?: boolean; updated_at: number };

export const intercom: Connector = {
  kind: "intercom",
  objects: ["contacts"],
  gapMs: 100,
  async account(ctx) {
    const d = await ctx.api<{ app?: { id_code: string; name: string } }>("https://api.intercom.io/me", { headers: { "intercom-version": "2.11" } });
    return { id: d.app?.id_code ?? "", label: d.app?.name ?? "Intercom" };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    const c = readCursor<{ after: string | null; since: number; max: number }>(cursor, { after: null, since: 0, max: 0 });
    const d = await ctx.api<{ data: IcContact[]; pages?: { next?: { starting_after?: string } } }>("https://api.intercom.io/contacts/search", {
      method: "POST",
      headers: { "intercom-version": "2.11" },
      body: JSON.stringify({
        query: { field: "updated_at", operator: ">", value: c.since },
        sort: { field: "updated_at", order: "ascending" },
        pagination: { per_page: 150, ...(c.after ? { starting_after: c.after } : {}) },
      }),
    });
    const records = (d.data ?? []).map((x) => ({
      id: x.id,
      updatedAt: new Date(x.updated_at * 1000).toISOString(),
      data: { email: x.email, name: x.name, phone: x.phone, country: x.location?.country ?? null, role: x.role, unsubscribed: x.unsubscribed_from_emails === true },
    }));
    const max = (d.data ?? []).reduce((m, x) => Math.max(m, x.updated_at), c.max);
    const next = d.pages?.next?.starting_after;
    if (next) return { records, cursor: JSON.stringify({ ...c, after: next, max }), more: true };
    return { records, cursor: JSON.stringify({ after: null, since: max ? max - 300 : c.since, max: 0 }), more: false };
  },
  consent: (r) => (r.data.unsubscribed === true ? "unsubscribed" : null),
  defaults: { contact: { email: "email", name: "name", phone: "phone", country: "country" } },
};
