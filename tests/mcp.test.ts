// The MCP server, spoken to the way Claude Code and Cursor do, with a stand-in database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpServer, MCP_VERSIONS } from "../src/lib/mcpProtocol.ts";
import { resultsText } from "../src/lib/mcpText.ts";
import type { Outcome } from "../src/lib/outcome.ts";

const { mcp } = await import("../src/lib/mcpTools.ts");

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const P1 = "11111111-1111-1111-1111-111111111111";
const db: Record<string, Row[]> = {
  projects: [{ id: P1, workspace_id: "ws1", name: "Shop", created_at: "1" }, { id: "p-other", workspace_id: "ws2", name: "Other", created_at: "2" }],
  environments: [{ id: "e1", workspace_id: "ws1", project_id: P1, name: "staging", base_url: "https://staging.shop.com", created_at: "1" }],
  blocks: [{ id: "b0000000-0000-0000-0000-000000000001", workspace_id: "ws1", project_id: P1, name: "Sign in" }],
  tests: [
    { id: "a0000000-0000-0000-0000-000000000001", workspace_id: "ws1", project_id: P1, name: "Checkout", use_case: "Checkout", priority: "high", steps: [{ id: "s1", kind: "do", text: "Add the hoodie" }, { id: "s2", kind: "check", text: "The cart shows 1 item" }], lock: null, version: 3 },
    { id: "a0000000-0000-0000-0000-000000000002", workspace_id: "ws2", project_id: "p-other", name: "Secret test", use_case: "General", priority: "medium", steps: [{ id: "x", kind: "do", text: "x" }], lock: null, version: 1 },
  ],
  runs: [],
  run_steps: [],
  heals: [],
  env_secrets: [],
};
let seq = 0;
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let insert: Row | null = null;
  let single: "one" | "maybe" | null = null;
  let max = Infinity;
  const q: Row = {
    select: () => q,
    order: () => q,
    limit: (n: number) => ((max = n), q),
    update: (f: Row) => ((patch = f), q),
    insert: (f: Row) => ((insert = f), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    ilike: (k: string, v: string) => (filters.push((r) => String(r[k]).toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()), q),
    maybeSingle: () => ((single = "maybe"), q),
    single: () => ((single = "one"), q),
    then: (ok: (v: unknown) => unknown) => {
      let rows: Row[];
      if (insert) {
        const row = { id: `a0000000-0000-0000-0000-00000000010${++seq}`, workspace_id: db.projects.find((p) => p.id === insert!.project_id)?.workspace_id, version: 1, lock: null, ...insert };
        db[table]!.push(row);
        rows = [row];
      } else {
        rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, max);
        if (patch) for (const r of rows) Object.assign(r, patch, table === "tests" ? { version: r.version + 1 } : {});
      }
      const data = single ? (rows[0] ? { ...rows[0] } : null) : rows.map((r) => ({ ...r }));
      return Promise.resolve({ data, error: null }).then(ok);
    },
  };
  return q;
}
const started: Row[] = [];
const sb = {
  from: query,
  rpc: async (fn: string, args: Row) => {
    assert.equal(fn, "api_start_runs");
    started.push(args);
    const rows = (args.p_tests as string[]).map((tid) => {
      const id = `c0000000-0000-0000-0000-00000000000${started.length}`;
      const t = db.tests.find((x) => x.id === tid)!;
      db.runs.push({ id, workspace_id: "ws1", test_id: tid, test_name: t.name, environment_name: "staging", status: "running", verdict: null, verdict_reason: null, error: null, duration_ms: null, finished_at: null, retry_of: null, retried_as: null, created_at: String(Date.now()), project_id: P1 });
      return { run_id: id, test_id: tid, test_name: t.name };
    });
    return { data: rows, error: null };
  },
};
const ctx = { sb, workspaceId: "ws1", keyId: "k1", pollMs: 5 } as never;

let rpcId = 0;
async function call(method: string, params?: Row) {
  return (await mcp(ctx, JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }))) as Row;
}
const tool = async (name: string, args: Row = {}) => (await call("tools/call", { name, arguments: args })).result as { content: { text: string }[]; structuredContent?: Row; isError: boolean };

test("the handshake, ping, tool list and notifications work as MCP clients expect", async () => {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "claritia");
  assert.ok(init.result.capabilities.tools);
  assert.equal((await call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, MCP_VERSIONS[0]);
  assert.deepEqual((await call("ping")).result, {});
  const names = (await call("tools/list")).result.tools.map((t: Row) => t.name);
  assert.deepEqual(names, ["list_projects", "list_tests", "get_test", "save_test", "verify_change", "get_results", "list_fixes"]);
  assert.equal(await mcp(ctx, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  assert.equal((await call("nope")).error.code, -32601);
  assert.equal(((await mcp(ctx, "{not json")) as Row).error.code, -32700);
  assert.equal((await call("tools/call", { name: "nope" })).error.code, -32602);
  const batch = (await mcp(ctx, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }]))) as Row[];
  assert.equal(batch.length, 1);
});

test("list_projects and list_tests only show the key's workspace", async () => {
  const p = await tool("list_projects");
  assert.match(p.content[0]!.text, /Shop\n {2}staging: https:\/\/staging.shop.com/);
  assert.ok(!p.content[0]!.text.includes("Other"));
  const t = await tool("list_tests");
  assert.match(t.content[0]!.text, /Checkout \/ Checkout {2}\(2 steps, never run\)/);
  assert.ok(!t.content[0]!.text.includes("Secret test"));
  const other = await tool("get_test", { test: "Secret test" });
  assert.equal(other.isError, true);
  assert.match(other.content[0]!.text, /not found/);
});

test("get_test shows the test as YAML", async () => {
  const r = await tool("get_test", { test: "checkout" });
  assert.equal(r.isError, false);
  assert.match(r.content[0]!.text, /name: Checkout\nuse_case: Checkout\npriority: high\nsteps:\n {2}- Add the hoodie\n {2}- check: The cart shows 1 item/);
  assert.match(r.content[0]!.text, /No code yet/);
});

test("save_test creates a test, updates one by name keeping unchanged steps' ids, and explains YAML mistakes", async () => {
  const created = await tool("save_test", { yaml: "name: Sign up\nuse_case: Account\nsteps:\n  - use: sign-in\n  - Open settings\n  - check: It says Settings" });
  assert.equal(created.isError, false, created.content[0]!.text);
  assert.match(created.content[0]!.text, /^Created Sign up/);
  const row = db.tests.find((t) => t.name === "Sign up")!;
  assert.equal(row.steps[0].kind, "use");
  assert.equal(row.steps[0].block, "b0000000-0000-0000-0000-000000000001");

  const before = db.tests.find((t) => t.name === "Checkout")!;
  const keepId = before.steps[0].id;
  const updated = await tool("save_test", { yaml: "name: Checkout\nuse_case: Checkout\npriority: high\nsteps:\n  - Add the hoodie\n  - Click Checkout\n  - check: It says Thanks" });
  assert.match(updated.content[0]!.text, /^Updated Checkout \(version 4\)/);
  assert.equal(before.steps[0].id, keepId, "an unchanged step lost its id, so its code");
  assert.equal(before.steps.length, 3);

  const bad = await tool("save_test", { yaml: "name: X\nsteps:\n  - use: no-such-block" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /no block called/);
  assert.equal((await tool("save_test", { yaml: "name: Empty\nsteps: []" })).isError, true);
});

const out = (over: Partial<Outcome>): Outcome => ({ id: "r1", final_id: "r1", test_id: "t1", test: "Checkout", environment: "staging", status: "passed", done: true, passed: true, passed_on_retry: false, verdict: null, reason: null, error: null, failed_step: null, duration_ms: 3200, url: "https://app.tryclaritia.com/runs/r1", ...over });

test("results read as next steps for an agent", () => {
  const text = resultsText(
    [
      out({}),
      out({ id: "r2", test: "Save", status: "failed", passed: false, verdict: "app_bug", reason: "Save answers 500.", failed_step: { position: 3, label: "Check: It says saved", error: "Timed out\n  waiting for text" } }),
      out({ id: "r3", test: "Login", status: "running", done: false, passed: false }),
    ],
    "https://pr-7.shop.dev",
  );
  assert.match(text, /^1 passed, 1 failed, 1 still running on https:\/\/pr-7.shop.dev\./);
  assert.match(text, /FAIL Save: App bug \(the app did something wrong: fix the code\)\n {2}Why: Save answers 500\.\n {2}Step 3: Check: It says saved\n {2}Error: Timed out waiting for text/);
  assert.match(text, /PASS Checkout 3\.2s/);
  assert.match(text, /Call get_results with run_ids \["r3"\]/);
});

test("verify_change starts agent runs on a preview address and waits for them", async () => {
  const pending = tool("verify_change", { tests: ["Checkout"], base_url: "https://pr-7.shop.dev", wait_seconds: 5 });
  await new Promise((r) => setTimeout(r, 30));
  const run = db.runs.at(-1)!;
  Object.assign(run, { status: "passed", finished_at: new Date().toISOString(), duration_ms: 4100 });
  const r = await pending;
  assert.equal(r.isError, false, r.content[0]!.text);
  assert.equal(started.at(-1)!.p_trigger, "mcp");
  assert.equal(started.at(-1)!.p_base_url, "https://pr-7.shop.dev");
  assert.match(r.content[0]!.text, /^1 passed on https:\/\/pr-7.shop.dev\./);
  assert.equal(r.structuredContent!.done, true);
});

test("verify_change stops waiting at wait_seconds and hands back run ids", async () => {
  const r = await tool("verify_change", { use_case: "Checkout", wait_seconds: 0.05 });
  assert.match(r.content[0]!.text, /still running/);
  const id = (r.structuredContent!.runs as Outcome[])[0]!.id;
  Object.assign(db.runs.find((x) => x.id === id)!, { status: "failed", verdict: "app_bug", verdict_reason: "Total is wrong.", finished_at: new Date().toISOString() });
  const later = await tool("get_results", { run_ids: [id], wait_seconds: 0 });
  assert.match(later.content[0]!.text, /FAIL Checkout: App bug/);
  assert.equal((await tool("get_results", { run_ids: ["not-an-id"] })).isError, true);
});

test("verify_change refuses addresses that aren't web addresses", async () => {
  const r = await tool("verify_change", { base_url: "file:///etc/passwd" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /web address/);
});

test("a tool that throws comes back as an error result, not a broken connection", async () => {
  const server = mcpServer<null>({ name: "x", title: "X", version: "1", instructions: "", tools: [{ name: "boom", title: "Boom", description: "", inputSchema: { type: "object" }, run: async () => { throw new Error("db down"); } }] });
  const r = (await server(null, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } }))) as Row;
  assert.deepEqual(r.result, { content: [{ type: "text", text: "db down" }], isError: true });
});
