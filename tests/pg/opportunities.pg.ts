// Opportunities on a real database (supabase/migrations/039_crm.sql): HubSpot deals through 429s and an expired
// token land once each, follow stage changes and deletes, link to the contacts the same source synced, and a portal
// without the deals scope still syncs its contacts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { seal } from "../../src/lib/seal.ts";
import { runPull, type RunOpts } from "../../src/lib/sources/run.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";
import { ctxFor } from "../../worker-intel/jobs/imports.ts";
import { FakeHubspot, rng } from "../sources/fakeHubspot.ts";

process.env.SECRETS_KEY ||= "test-secrets-key-that-is-long-enough-1234";
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);

async function connect(name: string, hs: FakeHubspot) {
  const ws = uuid7();
  const user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, $2)`, [ws, name]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  const creds = {
    type: "oauth",
    access: "t1",
    refresh: "r1",
    expiresAt: Date.now() + 3_600_000,
  };
  const id = (
    await q(`select source_connect($1, $2, 'hubspot', 'HubSpot', '777', $3, $4) as id`, [
      ws,
      user,
      seal(JSON.stringify(creds)),
      JSON.stringify({
        objects: {
          contacts: "in",
          companies: "off",
          opportunities: "in",
          lists: "off",
        },
        push_new: "none",
        basis: "legitimate_interest",
      }),
    ])
  )[0].id as string;
  const opts: RunOpts = {
    rpc,
    clean: (w) => ctxFor(pool, w),
    fetcher: hs.fetch,
    sleep: async () => {},
    refresh: async () => {
      const r = await hs.fetch("https://api.hubapi.com/oauth/v1/token", {
        method: "POST",
      });
      const t = (await r.json()) as { access_token: string };
      return {
        access: t.access_token,
        refresh: "r1",
        expiresAt: Date.now() + 1_800_000,
      };
    },
  };
  const settle = async () => {
    for (let more = true; more; ) more = !!(await runPull(opts, id))?.more;
  };
  return { ws, id, settle };
}

const opportunities = async (ws: string) =>
  (await q(
    `select r.id, r.name, r.fields, r.source_ids from records r join objects o on o.id = r.object_id
     where o.workspace_id = $1 and o.key = 'opportunity' and r.deleted_at is null order by r.name`,
    [ws],
  )) as {
    id: string;
    name: string;
    fields: Record<string, unknown>;
    source_ids: Record<string, string>;
  }[];

test("every workspace has the built-in Opportunities object, which can't be removed", async () => {
  const ws = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'seed')`, [ws]);
  const fields = (await q(`select key, type, system from fields where workspace_id = $1 and object = 'opportunity' order by position`, [ws])) as {
    key: string;
    system: boolean;
  }[];
  assert.deepEqual(
    fields.map((f) => f.key),
    ["amount", "stage", "close_date", "probability", "company", "contacts", "owner", "pipeline", "next_step", "crm_url"],
  );
  assert.ok(fields.every((f) => f.system));
  const owner = uuid7();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [owner, `${owner}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, owner]);
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [owner]);
    await assert.rejects(c.query(`select object_delete($1, 'opportunity')`, [ws]), /built in/);
    await assert.rejects(c.query(`select field_delete($1, 'opportunity', 'amount')`, [ws]), /built in/);
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
});

test("HubSpot deals sync through 429s and an expired token, once each, with stages, links and deletes", async () => {
  const random = rng(7);
  const hs = new FakeHubspot(random, { rate429: 0.15, portal: 777 });
  const ana = hs.create({ email: "ana@acme.com", firstname: "Ana" }, true);
  const ben = hs.create({ email: "ben@acme.com", firstname: "Ben" }, true);
  const deals: string[] = [];
  for (let i = 0; i < 250; i++)
    deals.push(
      hs.deal(
        null,
        {
          dealname: `Deal ${String(i).padStart(3, "0")}`,
          amount: String(1000 + i),
          dealstage: "appointmentscheduled",
          pipeline: "default",
          closedate: "2026-12-01T00:00:00Z",
        },
        { contacts: i % 2 ? [ana] : [ana, ben] },
      ),
    );
  const { ws, settle } = await connect("deals", hs);

  await settle();
  let rows = await opportunities(ws);
  assert.equal(rows.length, 250, "every deal once");
  assert.equal(new Set(rows.map((r) => r.source_ids.hubspot)).size, 250);
  const first = rows[0];
  assert.equal(first.name, "Deal 000");
  assert.equal(first.fields.amount, 1000);
  assert.equal(first.fields.stage, "appointment_scheduled");
  assert.equal(first.fields.probability, 20);
  assert.equal(first.fields.close_date, "2026-12-01");
  assert.equal(first.fields.pipeline, "Sales");
  assert.match(String(first.fields.crm_url), /^https:\/\/app\.hubspot\.com\/contacts\/777\/record\/0-3\/\d+$/);
  const stage = (await q(`select options from fields where workspace_id = $1 and object = 'opportunity' and key = 'stage'`, [ws]))[0].options as {
    value: string;
    kind: string;
  }[];
  assert.ok(
    stage.some((o) => o.value === "appointment_scheduled" && o.kind === "open"),
    "the CRM's stage is added to the list",
  );

  // Links: the contacts this source synced.
  const linked = (await q(
    `select l.from_id, c.email_clean from record_links l join contacts c on c.id = l.to_id join fields f on f.id = l.field_id where f.key = 'contacts' and l.workspace_id = $1`,
    [ws],
  )) as { from_id: string; email_clean: string }[];
  assert.equal(linked.length, 375, "125 deals with Ana, 125 with Ana and Ben");

  // Changes: won, lost, a new renewal stage, a deleted deal, contacts that change. The token expires midway.
  hs.deal(deals[0], { dealstage: "closedwon" });
  hs.deal(deals[1], { dealstage: "closedlost" });
  hs.deal(deals[2], { dealstage: "123", pipeline: "p2" }, { contacts: [] });
  hs.removeDeal(deals[3]);
  hs.token = "rotated";
  await settle();
  await settle(); // a second run changes nothing
  rows = await opportunities(ws);
  assert.equal(rows.length, 249, "the deleted deal is gone");
  const by = new Map(rows.map((r) => [r.source_ids.hubspot, r]));
  assert.equal(by.get(deals[0])!.fields.stage, "won");
  assert.equal(by.get(deals[0])!.fields.probability, 100);
  assert.equal(by.get(deals[1])!.fields.stage, "lost");
  assert.equal(by.get(deals[1])!.fields.probability, 0);
  assert.equal(by.get(deals[2])!.fields.stage, "renewal_due");
  assert.equal(by.get(deals[2])!.fields.pipeline, "Renewals");
  assert.equal(by.get(deals[3]), undefined);
  const gone = (
    await q(`select count(*)::int n from record_links l join records r on r.id = l.from_id where r.source_ids->>'hubspot' = any($1)`, [[deals[2], deals[3]]])
  )[0].n;
  assert.equal(gone, 0, "a deal with no contacts now, and a deleted deal, keep no links");
  assert.ok(hs.throttled > 0, "the run went through 429s");

  // Stages that came from the CRM stay unique.
  const values = (
    (await q(`select options from fields where workspace_id = $1 and object = 'opportunity' and key = 'stage'`, [ws]))[0].options as { value: string }[]
  ).map((o) => o.value);
  assert.equal(new Set(values).size, values.length);
});

test("a portal without the deals scope still syncs contacts, and logs why deals were skipped", async () => {
  const hs = new FakeHubspot(rng(3), { portal: 778 });
  hs.dealsScope = false;
  hs.create({ email: "cara@acme.com", firstname: "Cara" }, true);
  hs.deal(null, { dealname: "Hidden", dealstage: "appointmentscheduled" });
  const { ws, id, settle } = await connect("no-scope", hs);
  await settle();
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and deleted_at is null`, [ws]))[0].n, 1);
  assert.equal((await opportunities(ws)).length, 0);
  const log = (await q(`select object, action, error from sync_log where source_id = $1 and action = 'error'`, [id])) as { object: string; error: string }[];
  assert.ok(log.some((l) => l.object === "opportunity" && /scope/i.test(l.error)));
  assert.equal((await q(`select status from sources where id = $1`, [id]))[0].status, "active", "the source isn't marked broken");
});
