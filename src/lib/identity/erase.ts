// Erasure and export (docs/identity.md 15.1, 15.2). Erasure removes everything that names the person and keeps
// only the hashes, so the same email starts fresh if it ever comes back.

import { cleanIdentifier, isRejected } from "./clean.ts";
import { workspaceLock, type Db, type Pool } from "./stitch.ts";

async function current(db: Db, id: string): Promise<string | null> {
  let cur: string | null = id;
  for (let i = 0; cur && i < 20; i++) {
    const r = await db.query(`select merged_into from persons where id = $1`, [cur]);
    if (!r.rows.length) return null;
    if (!r.rows[0].merged_into) return cur;
    cur = r.rows[0].merged_into;
  }
  return cur;
}

/** Evidence rows that name any of these identifiers: a text prefilter, then the same cleaning as stitch. */
async function evidenceNaming(db: Db, ws: string, ids: { kind: string; value_clean: string; value_raw: string | null; value_hash: Buffer }[]) {
  if (!ids.length) return [];
  const needles = [...new Set(ids.flatMap((i) => [i.value_clean, i.value_raw ?? ""]).filter(Boolean).map((v) => `%${v.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`))];
  const want = new Set(ids.map((i) => `${i.kind}:${Buffer.from(i.value_hash).toString("hex")}`));
  // Emails are also prefiltered by domain, since cleaning can drop +tags and dots.
  const locals = ids.filter((i) => i.kind === "email").map((i) => `%${i.value_clean.split("@")[1]}%`);
  const r = await db.query(
    `select id, device_id, identifiers, source, level, server_at from identity_evidence
     where workspace_id = $1 and (lower(identifiers::text) like any($2) or lower(identifiers::text) like any($3))`,
    [ws, needles, locals.length ? locals : ["\u0000"]],
  );
  return r.rows.filter((e) =>
    (e.identifiers as { kind: string; value: string }[]).some((i) => {
      const c = cleanIdentifier(i.kind, i.value);
      return !isRejected(c) && want.has(`${c.kind}:${c.hash.toString("hex")}`);
    }),
  );
}

export type EraseCounts = { identifiers: number; evidence: number; devices: number; sessions: number; events: number; persons: number; contacts: number };

export async function erasePerson(pool: Pool, ws: string, personId: string): Promise<EraseCounts> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await workspaceLock(c, ws, true);
    const p = await current(c, personId);
    if (!p) throw new Error("Person not found");
    const counts: EraseCounts = { identifiers: 0, evidence: 0, devices: 0, sessions: 0, events: 0, persons: 0, contacts: 0 };
    const ids = (await c.query(`select id, kind, value_clean, value_raw, value_hash from identifiers where workspace_id = $1 and person_id = $2`, [ws, p])).rows as {
      id: string;
      kind: string;
      value_clean: string;
      value_raw: string | null;
      value_hash: Buffer;
    }[];
    const evidence = await evidenceNaming(c, ws, ids);
    const linked = (await c.query(`select distinct device_id from device_links where workspace_id = $1 and person_id = $2`, [ws, p])).rows.map((r) => r.device_id as string);
    const devices = [...new Set([...linked, ...evidence.map((e) => e.device_id).filter(Boolean)])] as string[];
    const others = new Set(
      (await c.query(`select distinct device_id from device_links where workspace_id = $1 and device_id = any($2) and person_id <> $3`, [ws, devices, p])).rows.map((r) => r.device_id as string),
    );
    const alone = devices.filter((d) => !others.has(d));
    const shared = devices.filter((d) => others.has(d));

    // Devices only this person used go whole; on shared ones, only the visits that were theirs.
    const sessionIds = (
      await c.query(
        `select id from sessions where workspace_id = $1 and (device_id = any($2) or (device_id = any($3) and person_id = $4) or person_id = $4)`,
        [ws, alone, shared, p],
      )
    ).rows.map((r) => r.id as string);
    counts.events = (await c.query(`delete from events where workspace_id = $1 and session_id = any($2)`, [ws, sessionIds])).rowCount ?? 0;
    counts.sessions = (await c.query(`delete from sessions where workspace_id = $1 and id = any($2)`, [ws, sessionIds])).rowCount ?? 0;
    counts.evidence = (
      await c.query(`delete from identity_evidence where workspace_id = $1 and (id = any($2) or device_id = any($3))`, [ws, evidence.map((e) => e.id), alone])
    ).rowCount ?? 0;
    await c.query(`delete from device_links where workspace_id = $1 and (person_id = $2 or device_id = any($3))`, [ws, p, alone]);
    counts.devices = (await c.query(`delete from devices where workspace_id = $1 and id = any($2)`, [ws, alone])).rowCount ?? 0;
    // Contacts with any of the person's emails go too, with their consent, field history and events.
    const emails = ids.filter((i) => i.kind === "email").map((i) => i.value_clean);
    counts.contacts = (await c.query(`delete from contacts where workspace_id = $1 and (person_id = $2 or email_clean = any($3))`, [ws, p, emails])).rowCount ?? 0;
    counts.identifiers = (await c.query(`delete from identifiers where workspace_id = $1 and person_id = $2`, [ws, p])).rowCount ?? 0;
    await c.query(`delete from merge_proposals where workspace_id = $1 and (person_a = $2 or person_b = $2)`, [ws, p]);
    const aliased = (await c.query(`select old_id from person_aliases where workspace_id = $1 and new_id = $2`, [ws, p])).rows.map((r) => r.old_id as string);
    await c.query(`delete from person_aliases where workspace_id = $1 and (new_id = $2 or old_id = $2)`, [ws, p]);
    counts.persons = (await c.query(`delete from persons where workspace_id = $1 and (id = $2 or id = any($3))`, [ws, p, aliased])).rowCount ?? 0;
    for (const i of ids) await c.query(`insert into erasures (workspace_id, value_hash) values ($1, $2) on conflict do nothing`, [ws, i.value_hash]);
    await c.query("commit");
    return counts;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export type PersonExport = {
  person: { id: string; created_at: string; primary_email: string | null };
  identifiers: { kind: string; value: string; class: string | null }[];
  evidence: { source: string; level: string; at: string }[];
  sessions: { started_at: string; ended_at: string; landing_path: string | null; pages: string[] }[];
  contacts: { email: string | null; first_name: string | null; last_name: string | null; title: string | null; phone: string | null; country: string | null; fields: Record<string, unknown>; consents: { basis: string; status: string; at: string }[] }[];
};

export async function exportPerson(db: Db, ws: string, personId: string): Promise<PersonExport> {
  const p = await current(db, personId);
  if (!p) throw new Error("Person not found");
  const person = (await db.query(`select id, created_at, primary_email from persons where id = $1`, [p])).rows[0];
  const ids = (await db.query(`select kind, value_clean, value_raw, value_hash, class from identifiers where workspace_id = $1 and person_id = $2 order by created_at`, [ws, p])).rows;
  const evidence = await evidenceNaming(db, ws, ids as never);
  const sessions = (
    await db.query(
      `select s.started_at, s.ended_at, s.landing_path,
              coalesce((select array_agg(e.path order by e.server_at) from events e where e.session_id = s.id and e.kind = 'view'), '{}') as pages
       from sessions s where s.workspace_id = $1 and s.person_id = $2 order by s.started_at`,
      [ws, p],
    )
  ).rows;
  const emails = ids.filter((i) => i.kind === "email").map((i) => i.value_clean);
  const contacts = (
    await db.query(
      `select c.email, c.first_name, c.last_name, c.title, c.phone, c.country, c.fields,
              coalesce((select jsonb_agg(jsonb_build_object('basis', k.basis, 'status', k.status, 'at', k.at) order by k.at) from consents k where k.contact_id = c.id), '[]') as consents
       from contacts c where c.workspace_id = $1 and (c.person_id = $2 or c.email_clean = any($3)) order by c.created_at`,
      [ws, p, emails],
    )
  ).rows;
  const iso = (d: unknown) => new Date(d as string).toISOString();
  return {
    person: { id: person.id, created_at: iso(person.created_at), primary_email: person.primary_email },
    identifiers: ids.map((i) => ({ kind: i.kind, value: i.value_clean, class: i.class })),
    evidence: evidence.map((e) => ({ source: e.source, level: e.level, at: iso(e.server_at) })).sort((a, b) => a.at.localeCompare(b.at)),
    sessions: sessions.map((s) => ({ started_at: iso(s.started_at), ended_at: iso(s.ended_at), landing_path: s.landing_path, pages: s.pages })),
    contacts: contacts.map((c) => ({ email: c.email, first_name: c.first_name, last_name: c.last_name, title: c.title, phone: c.phone, country: c.country, fields: c.fields, consents: c.consents })),
  };
}
