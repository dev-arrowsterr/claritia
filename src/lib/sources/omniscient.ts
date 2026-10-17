// Omniscient, two-way, connected in one click from its approve page (its migration 032). Contacts and accounts
// come in through its API v1 and its webhooks; contacts go out by email, so a lead handed off here lands on the
// same Omniscient contact.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readCursor } from "./ctx.ts";
import { dealRecord, day, num } from "./opportunities.ts";
import type { Connector, Ctx, Page, PushResult, RawRecord } from "./types.ts";

type Contact = { id: string; email: string | null; name: string | null; title: string | null; phone: string | null; lifecycle: string | null; account_id: string | null; created_at: string };
type Opportunity = { id: string; name: string | null; account_id: string | null; stage_name: string | null; stage_kind: string; amount: number | null; close_date: string | null; updated_at: string };
type Account = { id: string; name: string | null; domain: string | null; fields: Record<string, unknown>; created_at: string };

const url = (ctx: Ctx) => {
  const u = ctx.secret("url") || "https://app.tryomniscient.com";
  if (!/^https:\/\//.test(u) && !/^http:\/\/localhost/.test(u)) throw new Error("Connect Omniscient again.");
  return u.replace(/\/+$/, "");
};
const auth = (ctx: Ctx) => ({ authorization: `Bearer ${ctx.secret("api_key")}` });
const rec = (c: Contact): RawRecord => ({ id: c.id, data: { email: c.email, name: c.name, title: c.title, phone: c.phone, lifecycle: c.lifecycle } });

async function page<T>(ctx: Ctx, path: string, cursor: string | null) {
  const c = readCursor<{ offset: number }>(cursor, { offset: 0 });
  const d = await ctx.api<{ data: T[] }>(`${url(ctx)}${path}?limit=100&offset=${c.offset}`, { headers: auth(ctx), auth: false });
  const rows = d.data ?? [];
  // Omniscient lists newest first with no "changed since", so each run reads it all; unchanged rows are skipped.
  return { rows, cursor: rows.length === 100 ? JSON.stringify({ offset: c.offset + 100 }) : null, more: rows.length === 100 };
}

export const omniscient: Connector = {
  kind: "omniscient",
  objects: ["companies", "contacts", "opportunities"],
  twoWay: true,
  gapMs: 100,
  // Its contact upsert sets these; the stage moves in Omniscient only.
  writable: ["email", "name", "title", "phone"],
  async account(ctx) {
    const d = await ctx.api<{ workspace: string | null; workspace_id: string }>(`${url(ctx)}/api/v1/me`, { headers: auth(ctx), auth: false });
    return { id: d.workspace_id, label: d.workspace ?? "Omniscient" };
  },
  async pull(ctx, object, cursor): Promise<Page> {
    if (object === "companies") {
      const p = await page<Account>(ctx, "/api/v1/accounts", cursor);
      return { records: p.rows.map((a) => ({ id: a.id, data: { name: a.name, domain: a.domain } })), cursor: p.cursor, more: p.more };
    }
    if (object === "opportunities") {
      const p = await page<Opportunity>(ctx, "/api/v1/opportunities", cursor);
      const records = p.rows.map((o) =>
        dealRecord(o.id, o.updated_at, false, {
          name: o.name,
          amount: num(o.amount),
          stage: o.stage_name,
          stageKind: o.stage_kind === "won" || o.stage_kind === "lost" ? o.stage_kind : "open",
          closeDate: day(o.close_date),
          probability: null,
          owner: null,
          pipeline: null,
          nextStep: null,
          url: null,
          company: o.account_id,
        }),
      );
      return { records, cursor: p.cursor, more: p.more };
    }
    const p = await page<Contact>(ctx, "/api/v1/contacts", cursor);
    return { records: p.rows.map(rec), cursor: p.cursor, more: p.more };
  },
  async push(ctx, changes) {
    const out: PushResult[] = [];
    for (const c of changes) {
      try {
        const r = await ctx.api<{ id: string }>(`${url(ctx)}/api/v1/contacts`, {
          method: "POST",
          headers: auth(ctx),
          auth: false,
          body: JSON.stringify({ ...c.values, source: "claritia", external_id: c.localId }),
        });
        out.push({ localId: c.localId, externalId: r.id });
      } catch (e) {
        if (/Stopped|rate limit|Sign in again/i.test(String((e as Error).message))) throw e;
        out.push({ localId: c.localId, error: String((e as Error).message).slice(0, 300) });
      }
    }
    return out;
  },
  async setup(ctx, hookUrl) {
    const d = await ctx.api<{ secret: string }>(`${url(ctx)}/api/v1/webhooks`, {
      method: "POST",
      headers: auth(ctx),
      auth: false,
      body: JSON.stringify({ url: hookUrl, events: ["contact.created", "contact.updated"] }),
    });
    return { hook_secret: d.secret };
  },
  verify(req, secret) {
    const parts = Object.fromEntries((req.headers.get("omniscient-signature") ?? "").split(",").map((p) => p.split("=") as [string, string]));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300 || !parts.v1) return false;
    const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${req.body}`).digest("hex"));
    const got = Buffer.from(parts.v1);
    return want.length === got.length && timingSafeEqual(want, got);
  },
  parse(body) {
    const b = body as { id?: string; event?: string; data?: Contact };
    if (!b?.data?.id || !String(b.event ?? "").startsWith("contact.")) return [];
    return [{ dedupe: String(b.id ?? `${b.data.id}:${b.event}`), object: "contacts", id: b.data.id, record: rec(b.data) }];
  },
  defaults: {
    contact: { email: "email", name: "name", title: "title", phone: "phone", lifecycle: "lead_status" },
    company: { name: "name", domain: "domain" },
    valueMaps: { lifecycle: { new: "new", contacted: "attempting", engaged: "connected", qualified: "qualified", customer: "qualified", lost: "disqualified" } },
  },
};
