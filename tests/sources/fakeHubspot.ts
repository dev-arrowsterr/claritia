// A HubSpot that answers like the real one for the calls the connector makes: contact search by
// lastmodifieddate, batch read, update and upsert, account details, properties, lists, token refresh. It can
// throw 429s, expire tokens, drop or repeat webhooks, and it counts every write so a test can spot echo loops.

type Contact = { id: string; properties: Record<string, string | null>; modified: number; archived: boolean };

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Deal = { id: string; properties: Record<string, string | null>; modified: number; archived: boolean; companies: string[]; contacts: string[] };

/** Two pipelines, as HubSpot returns them: stages carry isClosed and a probability from 0 to 1. */
const PIPELINES = [
  {
    id: "default",
    label: "Sales",
    stages: [
      { id: "appointmentscheduled", label: "Appointment scheduled", metadata: { isClosed: "false", probability: "0.2" } },
      { id: "contractsent", label: "Contract sent", metadata: { isClosed: "false", probability: "0.8" } },
      { id: "closedwon", label: "Closed won", metadata: { isClosed: "true", probability: "1.0" } },
      { id: "closedlost", label: "Closed lost", metadata: { isClosed: "true", probability: "0.0" } },
    ],
  },
  { id: "p2", label: "Renewals", stages: [{ id: "123", label: "Renewal due", metadata: { isClosed: "false", probability: "0.5" } }] },
];

export class FakeHubspot {
  contacts = new Map<string, Contact>();
  deals = new Map<string, Deal>();
  /** False: the portal didn't grant crm.objects.deals.read. */
  dealsScope = true;
  writes = 0;
  calls = 0;
  throttled = 0;
  events: Record<string, unknown>[] = [];
  /** Timeline events by our id, and notes, as written. */
  timeline = new Map<string, { objectId: string; tokens: Record<string, string> }>();
  notes: { body: string; contact: string }[] = [];
  token = "t1";
  private seq = 1000;
  private clock = Date.now() - 86_400_000;
  private eventSeq = 1;
  private random: () => number;
  opts: { rate429?: number; portal?: number };
  constructor(random: () => number, opts: { rate429?: number; portal?: number } = {}) {
    this.random = random;
    this.opts = opts;
  }

  /** Move HubSpot's clock (for "newest wins" cases). */
  setClock(ms: number) {
    this.clock = ms;
  }

  private tick() {
    // Each change a little later than the last; several changes can share a millisecond in real life too.
    this.clock += Math.floor(this.random() * 3);
    return this.clock;
  }

  private emit(type: string, c: Contact, extra: Record<string, unknown> = {}) {
    this.events.push({ eventId: this.eventSeq++, subscriptionType: type, objectId: Number(c.id), portalId: this.opts.portal ?? 123, occurredAt: c.modified, ...extra });
  }

  /** A person changes a contact in HubSpot. */
  edit(id: string, props: Record<string, string | null>) {
    const c = this.contacts.get(id)!;
    Object.assign(c.properties, props);
    c.modified = this.tick();
    c.properties.lastmodifieddate = new Date(c.modified).toISOString();
    this.emit("contact.propertyChange", c);
  }

  create(props: Record<string, string | null>, fromApi = false) {
    const id = String(this.seq++);
    const c: Contact = { id, properties: { ...props }, modified: this.tick(), archived: false };
    c.properties.lastmodifieddate = new Date(c.modified).toISOString();
    c.properties.email = (props.email ?? "").toLowerCase() || null;
    this.contacts.set(id, c);
    if (!fromApi) this.emit("contact.creation", c);
    return id;
  }

  remove(id: string) {
    const c = this.contacts.get(id)!;
    c.archived = true;
    c.modified = this.tick();
    this.emit("contact.deletion", c);
  }

  /** Merge `drop` into `keep`, the way HubSpot does: the dropped record is gone, the kept one changes. */
  merge(keep: string, drop: string) {
    const k = this.contacts.get(keep)!;
    const d = this.contacts.get(drop)!;
    for (const [p, v] of Object.entries(d.properties)) if (!k.properties[p] && v) k.properties[p] = v;
    d.archived = true;
    k.modified = this.tick();
    k.properties.lastmodifieddate = new Date(k.modified).toISOString();
    this.emit("contact.merge", k, { primaryObjectId: Number(keep), mergedObjectIds: [Number(keep), Number(drop)] });
  }

  /** A deal made or changed in HubSpot. */
  deal(id: string | null, props: Record<string, string | null>, links: { companies?: string[]; contacts?: string[] } = {}) {
    const d: Deal = (id && this.deals.get(id)) || { id: String(this.seq++), properties: {}, modified: 0, archived: false, companies: [], contacts: [] };
    Object.assign(d.properties, props);
    if (links.companies) d.companies = links.companies;
    if (links.contacts) d.contacts = links.contacts;
    d.modified = this.tick();
    d.properties.hs_lastmodifieddate = new Date(d.modified).toISOString();
    this.deals.set(d.id, d);
    return d.id;
  }

  removeDeal(id: string) {
    const d = this.deals.get(id)!;
    d.archived = true;
    d.modified = this.tick();
  }

  live() {
    return [...this.contacts.values()].filter((c) => !c.archived);
  }

  /** Webhooks waiting to go out, taken. */
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  private byEmail(email: string) {
    return this.live().find((c) => c.properties.email === email.toLowerCase());
  }

  fetch: typeof fetch = async (input, init) => {
    this.calls++;
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

    if (url.pathname === "/oauth/v1/token") {
      this.token = `t${this.seq++}`;
      return json(200, { access_token: this.token, refresh_token: "r1", expires_in: 1800 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.token}`) return json(401, { message: "expired" });
    if (this.random() < (this.opts.rate429 ?? 0)) {
      this.throttled++;
      return json(429, { message: "You have reached your ten_secondly_rolling limit." }, { "retry-after": "1" });
    }
    const p = url.pathname;
    if (p === "/account-info/v3/details") return json(200, { portalId: this.opts.portal ?? 123, uiDomain: "app.hubspot.com" });
    if (p === "/crm/v3/properties/contacts" && method === "POST") return json(409, { message: "Property already exists" });
    if (p === "/crm/v3/lists/search") return json(200, { lists: [], hasMore: false, offset: 0 });
    if (p === "/crm/v3/objects/companies/search") return json(200, { results: [] });
    if (p === "/crm/v3/objects/contacts/search") {
      const since = Number(body.filterGroups?.[0]?.filters?.[0]?.value ?? 0);
      const all = this.live()
        .filter((c) => c.modified >= since)
        .sort((a, b) => a.modified - b.modified || Number(a.id) - Number(b.id));
      const after = Number(body.after ?? 0);
      const page = all.slice(after, after + body.limit);
      return json(200, {
        total: all.length,
        results: page.map((c) => ({ id: c.id, properties: { ...c.properties }, updatedAt: new Date(c.modified).toISOString() })),
        paging: after + body.limit < all.length ? { next: { after: String(after + body.limit) } } : undefined,
      });
    }
    if (p.startsWith("/crm/v3/objects/deals") || p.startsWith("/crm/v3/pipelines/deals") || p.startsWith("/crm/v4/associations/deals")) {
      if (!this.dealsScope) return json(403, { status: "error", message: "This app hasn't been granted all required scopes to make this call.", category: "MISSING_SCOPES" });
    }
    if (p === "/crm/v3/pipelines/deals") return json(200, { results: PIPELINES });
    if (p === "/crm/v3/objects/deals" && url.searchParams.get("archived") === "true") {
      const all = [...this.deals.values()].filter((d) => d.archived).sort((a, b) => Number(a.id) - Number(b.id));
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const page = all.slice(after, after + limit);
      return json(200, {
        results: page.map((d) => ({ id: d.id, properties: { hs_lastmodifieddate: d.properties.hs_lastmodifieddate }, archived: true })),
        paging: after + limit < all.length ? { next: { after: String(after + limit) } } : undefined,
      });
    }
    if (p === "/crm/v3/objects/deals/search") {
      // Search leaves out archived deals; HubSpot reports deletes by webhook only.
      const since = Number(body.filterGroups?.[0]?.filters?.[0]?.value ?? 0);
      const all = [...this.deals.values()]
        .filter((d) => !d.archived && d.modified >= since)
        .sort((a, b) => a.modified - b.modified || Number(a.id) - Number(b.id));
      const after = Number(body.after ?? 0);
      const page = all.slice(after, after + body.limit);
      return json(200, {
        total: all.length,
        results: page.map((d) => ({ id: d.id, properties: { ...d.properties }, updatedAt: new Date(d.modified).toISOString() })),
        paging: after + body.limit < all.length ? { next: { after: String(after + body.limit) } } : undefined,
      });
    }
    const assoc = p.match(/^\/crm\/v4\/associations\/deals\/(companies|contacts)\/batch\/read$/);
    if (assoc) {
      const results = (body.inputs as { id: string }[]).flatMap((i) => {
        const d = this.deals.get(i.id);
        const to = d ? (assoc[1] === "companies" ? d.companies : d.contacts) : [];
        return to.length ? [{ from: { id: i.id }, to: to.map((t) => ({ toObjectId: Number(t), associationTypes: [] })) }] : [];
      });
      return json(200, { status: "COMPLETE", results });
    }
    if (p === "/crm/v3/objects/contacts/batch/read") {
      const results = (body.inputs as { id: string }[]).map((i) => this.contacts.get(i.id)).filter((c): c is Contact => !!c && !c.archived);
      return json(200, { results: results.map((c) => ({ id: c.id, properties: { ...c.properties }, updatedAt: new Date(c.modified).toISOString() })) });
    }
    if (p === "/crm/v3/objects/contacts/batch/update") {
      const out: Contact[] = [];
      const errors: { message: string }[] = [];
      for (const i of body.inputs as { id: string; properties: Record<string, string> }[]) {
        const c = this.contacts.get(i.id);
        if (!c || c.archived) {
          errors.push({ message: `Object ${i.id} not found` });
          continue;
        }
        this.writes++;
        Object.assign(c.properties, stringify(i.properties));
        c.modified = this.tick();
        c.properties.lastmodifieddate = new Date(c.modified).toISOString();
        // HubSpot sends webhooks for API changes too.
        this.emit("contact.propertyChange", c);
        out.push(c);
      }
      return json(errors.length ? 207 : 200, { results: out.map((c) => ({ id: c.id, properties: { ...c.properties } })), errors });
    }
    if (p === "/crm/v3/objects/contacts/batch/upsert") {
      const out: Contact[] = [];
      for (const i of body.inputs as { id: string; properties: Record<string, string> }[]) {
        this.writes++;
        let c = this.byEmail(i.id);
        if (!c) {
          const id = this.create({ email: i.id }, true);
          c = this.contacts.get(id)!;
          this.emit("contact.creation", c);
        }
        Object.assign(c.properties, stringify(i.properties));
        c.properties.email = c.properties.email?.toLowerCase() ?? null;
        c.modified = this.tick();
        c.properties.lastmodifieddate = new Date(c.modified).toISOString();
        out.push(c);
      }
      return json(200, { results: out.map((c) => ({ id: c.id, properties: { ...c.properties } })) });
    }
    if (p === "/crm/v3/timeline/events/batch/create") {
      const results: { id: string }[] = [];
      const errors: { message: string; context: { id: string[] } }[] = [];
      for (const i of body.inputs as { id: string; objectId: string; tokens: Record<string, string> }[]) {
        if (this.timeline.has(i.id)) errors.push({ message: `Event ${i.id} already exists`, context: { id: [i.id] } });
        else if (!this.contacts.get(String(i.objectId))) errors.push({ message: `Object ${i.objectId} not found`, context: { id: [i.id] } });
        else {
          this.timeline.set(i.id, { objectId: String(i.objectId), tokens: i.tokens });
          results.push({ id: i.id });
        }
      }
      return json(errors.length ? 207 : 200, { results, errors });
    }
    if (p === "/crm/v3/objects/notes" && method === "POST") {
      const contact = String(body.associations?.[0]?.to?.id ?? "");
      this.notes.push({ body: String(body.properties?.hs_note_body ?? ""), contact });
      return json(201, { id: String(this.seq++) });
    }
    return json(404, { message: `No fake for ${method} ${p}` });
  };
}

const stringify = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? null : String(v)]));
