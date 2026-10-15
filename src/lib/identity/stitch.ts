// The stitch job (docs/identity.md Part 7): turns identity evidence into people, identifiers and device links.
// One evidence row per transaction, with advisory locks on the device and every identifier in sorted order, so
// jobs for different devices can run side by side without deadlocks or double people.

import { createHmac, timingSafeEqual } from "node:crypto";
import { uuid7 } from "../../../collect/ids.ts";
import { cleanIdentifier, isRejected, type Cleaned } from "./clean.ts";

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount: number | null }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Client = Db & { release: () => void };
export type Pool = { connect: () => Promise<Client> };

export type Settings = {
  own_domains: string[];
  partner_domains: string[];
  secrets: string[];
  /** Whether an email domain takes mail. Without it every domain passes. */
  checkDomain?: (domain: string) => Promise<boolean>;
};
export type Outcome =
  | { ignored: string }
  | { person: string; device: "linked" | "shared" | "tainted" | "unchanged" | "none"; merged?: string[]; proposed?: boolean; backfilled?: number; split?: string };

const DAY = 86400_000;
const BACKFILL_DAYS = 90;
const TAINT_DAYS = 30;
const IDENTITY_POLICIES = ["strict", "notice"];

type Evidence = {
  id: string;
  workspace_id: string;
  site_id: string | null;
  device_id: string | null;
  session_id: string | null;
  source: string;
  level: "verified" | "asserted" | "inferred";
  identifiers: { kind: string; value: string }[];
  hard_edge: boolean;
  extra: Record<string, unknown> | null;
  server_at: Date;
};

// Guards (7.2) ----------------------------------------------------------------------------------------------

export type IdRow = { kind: string; clean: string; domain: string | null; class: string | null };

/** Why a merge or attach would make a person that's almost surely a data error, or null when it's fine. */
export function guardFails(ids: IdRow[], crmMerge = false): string | null {
  const distinct = (kind: string) => new Set(ids.filter((i) => i.kind === kind).map((i) => i.clean)).size;
  if (distinct("user") >= 2) return "two_user_ids";
  if (!crmMerge && distinct("hubspot") >= 2) return "two_hubspot_ids";
  if (distinct("email") > 5) return "too_many_emails";
  const domains = new Set(ids.filter((i) => i.kind === "email" && i.class === "work").map((i) => i.domain));
  if (domains.size >= 3) return "three_company_domains";
  return null;
}

// Signed identify (5.2) -------------------------------------------------------------------------------------

export function identifyToken(secret: string, siteId: string, userId: string, email: string, iat: number): string {
  return createHmac("sha256", secret).update(`v1|${siteId}|${userId}|${email.toLowerCase()}|${iat}`).digest("base64url");
}

export function verifyIdentify(secrets: string[], siteId: string, userId: string, email: string, iat: unknown, token: unknown, at: number): boolean {
  if (typeof token !== "string" || typeof iat !== "number" || !Number.isInteger(iat)) return false;
  if (Math.abs(at - iat * 1000) > DAY) return false;
  const got = Buffer.from(token);
  return secrets.some((s) => {
    const want = Buffer.from(identifyToken(s, siteId, userId, email, iat));
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// Locks ------------------------------------------------------------------------------------------------------

/** Every stitch holds the workspace lock shared; a rebuild holds it alone. */
export async function workspaceLock(db: Db, ws: string, exclusive = false) {
  await db.query(`select ${exclusive ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended($1, 0))`, [`ws:${ws}`]);
}

async function lock(db: Db, ws: string, keys: string[]) {
  for (const k of [...new Set(keys)].sort()) await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${ws}:${k}`]);
}

/** Follows merges to the person that holds the identifiers now. */
async function resolve(db: Db, id: string | null): Promise<string | null> {
  let cur = id;
  for (let i = 0; cur && i < 20; i++) {
    const r = await db.query(`select merged_into from persons where id = $1`, [cur]);
    const next = r.rows[0]?.merged_into ?? null;
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

// The job ----------------------------------------------------------------------------------------------------

/** Stitches every waiting evidence row for one device, oldest first. Returns what happened to each. */
export async function stitchDevice(pool: Pool, workspaceId: string, deviceId: string, settings: Settings, limit = 200): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < limit; i++) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await workspaceLock(c, workspaceId);
      await lock(c, workspaceId, [`dev:${deviceId}`]);
      const r = await c.query(
        `select id, workspace_id, site_id, device_id, session_id, source, level, identifiers, hard_edge, extra, server_at
         from identity_evidence where workspace_id = $1 and device_id = $2 and stitched_at is null and revoked_at is null
         order by server_at, id limit 1`,
        [workspaceId, deviceId],
      );
      const e = r.rows[0] as Evidence | undefined;
      if (!e) {
        await c.query("commit");
        break;
      }
      out.push(await stitchOne(c, e, settings));
      await c.query("commit");
    } catch (err) {
      await c.query("rollback").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
  return out;
}

async function finish(db: Db, e: Evidence, fields: { ignored?: string | null; level?: string; source?: string; hard_edge?: boolean }) {
  await db.query(
    `update identity_evidence set stitched_at = now(), ignored = $3, level = coalesce($4, level), source = coalesce($5, source),
       hard_edge = coalesce($6, hard_edge), extra = coalesce(extra, '{}'::jsonb) - 'token'
     where workspace_id = $1 and id = $2`,
    [e.workspace_id, e.id, fields.ignored ?? null, fields.level ?? null, fields.source ?? null, fields.hard_edge ?? null],
  );
}

/** One evidence row (7.7). The caller holds the device lock inside a transaction. */
export async function stitchOne(db: Db, e: Evidence, settings: Settings): Promise<Outcome> {
  const ws = e.workspace_id;
  const t = new Date(e.server_at).getTime();
  const ignore = async (why: string) => (await finish(db, e, { ignored: why }), { ignored: why });

  // Manual merges and CRM rows have no device: they only shape people.
  const deviceless = !e.device_id && (e.source === "manual_merge" || e.source === "crm" || e.source === "crm_merge");
  if (!e.device_id && !deviceless) return ignore("no_device");
  const dev = e.device_id ? (await db.query(`select id, state, tainted_until, no_backfill from devices where id = $1 for update`, [e.device_id])).rows[0] : null;
  if (!deviceless && !dev) return ignore("no_device");
  if (e.session_id) {
    const s = (await db.query(`select policy from sessions where id = $1`, [e.session_id])).rows[0];
    if (s && !IDENTITY_POLICIES.includes(s.policy)) return ignore("policy");
  }
  if (dev && (dev.state === "internal" || dev.state === "opted_out")) return ignore(dev.state);
  if (e.source === "hutk") return ignore("no_crm"); // needs the HubSpot connection (M3)
  if (e.level === "inferred") return ignore("not_built"); // email links come with M6

  // Signed identify: Verified, and a hard edge between the user id and the email.
  let level = e.level;
  let source = e.source;
  let hard = e.hard_edge;
  const raw = e.identifiers;
  // Checked before (a rebuild replays it after the token is gone).
  if (e.source === "identify_signed" || deviceless) {
    level = "verified";
    hard = raw.length > 1;
  }
  if (e.source === "identify") {
    const user = raw.find((i) => i.kind === "user")?.value ?? "";
    const email = raw.find((i) => i.kind === "email")?.value ?? "";
    if (e.extra?.token && e.site_id && verifyIdentify(settings.secrets, e.site_id, user, email, e.extra.iat, e.extra.token, t)) {
      level = "verified";
      source = "identify_signed";
      hard = raw.length > 1;
    }
  }

  // Clean, and drop anything invalid or disposable. An erased email that comes back later starts fresh (15.1).
  const cleaned: Cleaned[] = [];
  for (const i of raw) {
    const c = cleanIdentifier(i.kind, i.value, settings);
    if (isRejected(c)) continue;
    // Typed emails only: CRM and signed identities came from a system that already had them.
    if (c.kind === "email" && c.domain && settings.checkDomain && (source === "form" || source === "identify") && !(await settings.checkDomain(c.domain))) continue;
    cleaned.push(c);
  }
  if (!cleaned.length) return (await finish(db, e, { ignored: "invalid", level, source }), { ignored: "invalid" });

  // Own domain: the device is internal from now on (Part 9).
  if (e.device_id && cleaned.some((c) => c.class === "own")) {
    await db.query(`update device_links set to_at = $2 where device_id = $1 and to_at is null`, [e.device_id, new Date(t)]);
    await db.query(`update devices set state = 'internal', state_since = $2 where id = $1`, [e.device_id, new Date(t)]);
    await db.query(`update sessions set internal = true, person_id = null, person_level = null, person_source = null where device_id = $1`, [e.device_id]);
    return (await finish(db, e, { ignored: "internal", level, source }), { ignored: "internal" });
  }
  // Role inboxes are account hints only: no person, no link.
  const usable = cleaned.filter((c) => c.class !== "role");
  if (!usable.length) return (await finish(db, e, { ignored: "role", level, source }), { ignored: "role" });

  // Without a hard edge, only the first identifier counts, so nothing ties two identifiers together (5.3).
  const ids = hard ? usable : [usable[0]];
  if (ids.length < 2) hard = false;
  await lock(db, ws, ids.map((c) => `id:${c.kind}:${c.clean}`));

  for (const c of ids) {
    await db.query(
      `insert into identifiers (id, workspace_id, kind, value_raw, value_clean, value_hash, class, domain)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (workspace_id, kind, value_clean) do nothing`,
      [uuid7(t), ws, c.kind, c.raw, c.clean, c.hash, c.class, c.domain],
    );
  }
  const rows = (
    await db.query(
      `select id, kind, value_clean, person_id from identifiers where workspace_id = $1 and (kind, value_clean) in (select * from unnest($2::text[], $3::text[]))`,
      [ws, ids.map((c) => c.kind), ids.map((c) => c.clean)],
    )
  ).rows;
  const byKey = new Map(rows.map((r) => [`${r.kind}:${r.value_clean}`, r]));
  const primaryRow = byKey.get(`${ids[0].kind}:${ids[0].clean}`)!;
  const owners: string[] = [];
  for (const r of rows) {
    const p = await resolve(db, r.person_id);
    if (p && !owners.includes(p)) owners.push(p);
  }
  await lock(db, ws, owners.map((p) => `person:${p}`));

  let person: string;
  let merged: string[] | undefined;
  let proposed = false;
  if (!owners.length) {
    person = await newPerson(db, ws, t, ids);
  } else if (hard && owners.length > 1) {
    const all = await identifiersOf(db, ws, owners);
    // A person approving a proposal decides past the guards.
    const why = source === "manual_merge" ? null : guardFails([...all, ...unattached(ids, rows)], source === "crm_merge");
    if (!why) {
      ({ survivor: person, merged } = await merge(db, ws, owners));
    } else {
      proposed = await propose(db, ws, owners, why, e.id);
      person = (await resolve(db, primaryRow.person_id)) ?? owners[0];
    }
  } else {
    person = (await resolve(db, primaryRow.person_id)) ?? owners[0];
  }

  // Attach identifiers that have no person yet, if the person stays sane.
  const loose = rows.filter((r) => !r.person_id);
  if (loose.length) {
    const have = await identifiersOf(db, ws, [person]);
    const add = ids.filter((c) => loose.some((r) => r.kind === c.kind && r.value_clean === c.clean)).map(idRow);
    if (!guardFails([...have, ...add])) {
      await db.query(`update identifiers set person_id = $3 where workspace_id = $1 and id = any($2) and person_id is null`, [ws, loose.map((r) => r.id), person]);
    } else {
      for (const r of loose) {
        const own = await newPerson(db, ws, t, ids.filter((c) => c.kind === r.kind && c.clean === r.value_clean));
        await db.query(`update identifiers set person_id = $2 where id = $1 and person_id is null`, [r.id, own]);
        proposed = (await propose(db, ws, [person, own], "guard_on_attach", e.id)) || proposed;
      }
    }
  }
  const email = ids.find((c) => c.kind === "email");
  if (email) await db.query(`update persons set primary_email = coalesce(primary_email, $2), partner = partner or $3 where id = $1`, [person, email.clean, email.class === "partner"]);

  if (!e.device_id || !dev) {
    await finish(db, e, { level, source, hard_edge: hard });
    return { person, merged, proposed, device: "none" };
  }
  const linkLevel = level === "verified" ? "verified" : "asserted";
  const result = await linkDevice(db, e, person, linkLevel, t, dev as Dev, source);
  await finish(db, e, { ignored: result.device === "tainted" ? "taint" : null, level, source, hard_edge: hard });
  return { person, merged, proposed, ...result };
}

function idRow(c: Cleaned): IdRow {
  return { kind: c.kind, clean: c.clean, domain: c.domain, class: c.class };
}
function unattached(ids: Cleaned[], rows: Record<string, unknown>[]): IdRow[] {
  return ids.filter((c) => rows.some((r) => r.kind === c.kind && r.value_clean === c.clean && !r.person_id)).map(idRow);
}

async function identifiersOf(db: Db, ws: string, persons: string[]): Promise<IdRow[]> {
  const r = await db.query(`select kind, value_clean as clean, domain, class from identifiers where workspace_id = $1 and person_id = any($2)`, [ws, persons]);
  return r.rows as IdRow[];
}

async function newPerson(db: Db, ws: string, t: number, ids: Cleaned[]): Promise<string> {
  const id = uuid7(t);
  const email = ids.find((c) => c.kind === "email");
  await db.query(`insert into persons (id, workspace_id, created_at, primary_email, partner) values ($1, $2, $3, $4, $5)`, [id, ws, new Date(t), email?.clean ?? null, email?.class === "partner"]);
  await db.query(
    `update identifiers set person_id = $3 where workspace_id = $1 and person_id is null and (kind, value_clean) in (select * from unnest($2::text[], $4::text[]))`,
    [ws, ids.map((c) => c.kind), id, ids.map((c) => c.clean)],
  );
  return id;
}

/** Joins people into the oldest one. Everything that pointed at the others moves, and aliases keep old ids working. */
async function merge(db: Db, ws: string, persons: string[]): Promise<{ survivor: string; merged: string[] }> {
  const r = await db.query(`select id from persons where id = any($1) order by created_at, id`, [persons]);
  const [survivor, ...rest] = r.rows.map((x) => x.id as string);
  for (const old of rest) {
    await db.query(`update identifiers set person_id = $2 where workspace_id = $3 and person_id = $1`, [old, survivor, ws]);
    await db.query(`update device_links set person_id = $2 where workspace_id = $3 and person_id = $1`, [old, survivor, ws]);
    await db.query(`update sessions set person_id = $2 where workspace_id = $3 and person_id = $1`, [old, survivor, ws]);
    await db.query(`update persons set merged_into = $2 where id = $1`, [old, survivor]);
    await db.query(`update person_aliases set new_id = $2 where new_id = $1`, [old, survivor]);
    await db.query(`insert into person_aliases (old_id, new_id, workspace_id) values ($1, $2, $3) on conflict (old_id) do update set new_id = excluded.new_id`, [old, survivor, ws]);
  }
  return { survivor, merged: rest };
}

async function propose(db: Db, ws: string, persons: string[], reason: string, evidenceId: string): Promise<boolean> {
  const sorted = [...new Set(persons)].sort();
  let made = false;
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const r = await db.query(
        `insert into merge_proposals (workspace_id, person_a, person_b, reason, evidence_id) values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [ws, sorted[i], sorted[j], reason, evidenceId],
      );
      made = made || (r.rowCount ?? 0) > 0;
    }
  return made;
}

// Device states (7.3), backfill (7.5) and session splits (7.6) ----------------------------------------------

type Dev = { id: string; state: string; tainted_until: Date | null; no_backfill: boolean };

async function linkDevice(db: Db, e: Evidence, person: string, level: "verified" | "asserted", t: number, dev: Dev, source: string): Promise<{ device: "linked" | "shared" | "tainted" | "unchanged"; backfilled?: number; split?: string }> {
  const at = new Date(t);
  const device = e.device_id!;
  const ws = e.workspace_id;
  if (dev.state === "tainted" && dev.tainted_until && +new Date(dev.tainted_until) > t) return { device: "tainted" };

  // Taint (7.4): 3+ people in 24 hours, or 2 different unsigned identities.
  const recent = await db.query(
    `select distinct person_id from device_links where device_id = $1 and level <> 'probable' and coalesce(to_at, $2) > $3`,
    [device, at, new Date(t - DAY)],
  );
  const people = new Set(await Promise.all(recent.rows.map((r) => resolve(db, r.person_id))));
  people.add(person);
  const unsigned = await db.query(
    `select count(distinct identifiers::text)::int as n from identity_evidence
     where workspace_id = $1 and device_id = $2 and source = 'identify' and server_at > $3 and server_at <= $4 and revoked_at is null`,
    [ws, device, new Date(t - DAY), at],
  );
  // Unsigned identify rows keep source 'identify'; verified ones become 'identify_signed'.
  if (people.size >= 3 || (source === "identify" && unsigned.rows[0].n >= 2)) {
    await db.query(`update device_links set to_at = $2 where device_id = $1 and to_at is null`, [device, at]);
    await db.query(`update devices set state = 'tainted', state_since = $2, tainted_until = $3, no_backfill = true where id = $1`, [device, at, new Date(t + TAINT_DAYS * DAY)]);
    await db.query(
      `update sessions set person_id = null, person_level = null, person_source = null where device_id = $1 and (started_at >= $2 or ended_at >= $2)`,
      [device, new Date(t - DAY)],
    );
    return { device: "tainted" };
  }

  const open = (await db.query(`select id, person_id, level, from_at from device_links where device_id = $1 and to_at is null`, [device])).rows[0];
  const current = open ? await resolve(db, open.person_id) : null;
  const session = await currentSession(db, e, device, t);

  const openLink = () =>
    db.query(`insert into device_links (id, workspace_id, device_id, person_id, level, from_at, evidence_id) values ($1, $2, $3, $4, $5, $6, $7)`, [uuid7(t), ws, device, person, level, at, e.id]);
  const setState = (state: string, noBackfill: boolean) =>
    db.query(`update devices set state = $2, state_since = case when state = $2 then state_since else $3 end, no_backfill = no_backfill or $4 where id = $1`, [device, state, at, noBackfill]);

  // Fresh, or a probable guess: link and backfill.
  if (!open || (open.level === "probable" && current === person)) {
    if (open) await db.query(`update device_links set level = $2 where id = $1`, [open.id, level]);
    else await openLink();
    const wasFresh = dev.state === "fresh" || dev.state === "probable";
    await setState("linked", false);
    const backfilled = wasFresh && !dev.no_backfill ? await backfill(db, device, person, level, t, session?.id ?? null) : await liveSession(db, session, person, level);
    return { device: "linked", backfilled };
  }
  if (open.level === "probable") {
    await db.query(`update device_links set to_at = $2 where id = $1`, [open.id, at]);
    await openLink();
    await setState("linked", false);
    await liveSession(db, session, person, level);
    return { device: "linked" };
  }
  if (current === person) {
    if (level === "verified" && open.level !== "verified") await db.query(`update device_links set level = 'verified' where id = $1`, [open.id]);
    return { device: "unchanged" };
  }
  // Someone else on a linked device: shared. Close, open, split the visit at this moment.
  await db.query(`update device_links set to_at = $2 where id = $1`, [open.id, at]);
  await openLink();
  await setState("shared", true);
  const split = session && +new Date(session.started_at) < t ? await splitSession(db, session, t, person, level) : undefined;
  if (session && !split) await liveSession(db, session, person, level);
  return { device: "shared", split };
}

type Sess = { id: string; started_at: Date; person_id: string | null };

async function currentSession(db: Db, e: Evidence, device: string, t: number): Promise<Sess | null> {
  const r = e.session_id
    ? await db.query(`select id, started_at, person_id, split_to from sessions where id = $1`, [e.session_id])
    : await db.query(`select id, started_at, person_id, split_to from sessions where device_id = $1 and started_at <= $2 order by started_at desc limit 1`, [device, new Date(t)]);
  let s = r.rows[0];
  if (s?.split_to) s = (await db.query(`select id, started_at, person_id, split_to from sessions where id = $1`, [s.split_to])).rows[0] ?? s;
  return (s as Sess | undefined) ?? null;
}

async function liveSession(db: Db, s: Sess | null, person: string, level: string): Promise<number> {
  if (!s) return 0;
  // The second part of a split visit keeps saying so (a rebuild lands here instead of splitting again).
  await db.query(
    `update sessions set person_id = $2, person_level = $3, person_source = case when split_from is not null then 'split' else 'live' end
     where id = $1 and policy = any($4) and not internal`,
    [s.id, person, level, IDENTITY_POLICIES],
  );
  return 0;
}

/** Earlier visits on this device (90 days) move to the person, if they allowed identity and weren't bots. */
async function backfill(db: Db, device: string, person: string, level: string, t: number, sessionId: string | null): Promise<number> {
  const r = await db.query(
    `update sessions set person_id = $2, person_level = $3, person_source = case when id = $6 then 'live' else 'backfill' end
     where device_id = $1 and started_at >= $4 and started_at <= $5 and policy = any($7) and not internal and not is_bot
       and (person_id is null or person_level = 'probable')`,
    [device, person, level, new Date(t - BACKFILL_DAYS * DAY), new Date(t), sessionId, IDENTITY_POLICIES],
  );
  return Math.max(0, (r.rowCount ?? 0) - (sessionId ? 1 : 0));
}

/** Splits a visit at `t`: events from then on move to a new session for the new person. */
async function splitSession(db: Db, s: Sess, t: number, person: string, level: string): Promise<string> {
  const id = uuid7(t);
  const at = new Date(t);
  await db.query(
    `insert into sessions (id, workspace_id, site_id, device_id, cookieless_key, started_at, ended_at, policy, consent, gpc, country, region, city,
       device_type, browser, os, landing_path, referrer_host, source, medium, campaign, term, content, ref_class, ip_net, ip_kind,
       person_id, person_level, person_source, account_id, account_source, network_account_id, internal, is_bot, split_from)
     select $2, workspace_id, site_id, device_id, cookieless_key, $3, greatest(ended_at, $3), policy, consent, gpc, country, region, city,
       device_type, browser, os, null, null, source, medium, campaign, term, content, ref_class, ip_net, ip_kind,
       $4, $5, 'split', account_id, account_source, network_account_id, internal, is_bot, id
     from sessions where id = $1`,
    [s.id, id, at, person, level],
  );
  await db.query(`update events set session_id = $2 where session_id = $1 and day >= $3::date and server_at >= $4`, [s.id, id, at.toISOString().slice(0, 10), at]);
  await db.query(`update sessions set split_to = $2 where id = $1 or split_to = $1`, [s.id, id]);
  for (const sid of [s.id, id]) {
    await db.query(
      `update sessions set pageviews = c.views, engaged_s = c.engaged from (
         select count(*) filter (where kind = 'view')::int as views,
                coalesce(sum(least(greatest((data->>'active_s')::int, 0), 3600)) filter (where kind = 'engage'), 0)::int as engaged
         from events where session_id = $1) c
       where id = $1`,
      [sid],
    );
  }
  await db.query(`update sessions set ended_at = least(ended_at, $2) where id = $1`, [s.id, at]);
  return id;
}
