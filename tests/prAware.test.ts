// PR-aware runs: the fixed rules, reading the picker's answer, and a pull request played through the GitHub flow with
// a stand-in database, GitHub API, picker and planner.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { Planner } from "../src/lib/planner.ts";
import { pickPrompt, selectByRules, selectionFrom, type ChangedFile, type Picker } from "../src/lib/prSelect.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), GITHUB_WEBHOOK_SECRET: "w", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s" });
const { handlePlan, selectionText } = await import("../src/lib/githubChecks.ts");

const f = (filename: string, patch = "+x"): ChangedFile => ({ filename, status: "modified", additions: 1, deletions: 0, patch });

test("fixed rules: docs alone run nothing, shared code runs everything, the rest goes to the picker", () => {
  assert.equal(selectByRules([f("README.md"), f("docs/setup.md"), f("src/cart.test.ts"), f(".github/workflows/ci.yml")])?.mode, "none");
  for (const shared of ["package.json", "pnpm-lock.yaml", "app/layout.tsx", "src/app/globals.css", "middleware.ts", "src/auth/session.ts", "next.config.ts", "Dockerfile"]) {
    const s = selectByRules([f("src/cart/Cart.tsx"), f(shared)]);
    assert.equal(s?.mode, "all", shared);
    assert.match(s!.reason, new RegExp(shared.replace(/[.]/g, "\\.")));
  }
  assert.equal(selectByRules([f("src/cart/Cart.tsx"), f("README.md")]), null);
  assert.equal(selectByRules([])?.mode, "all");
  assert.equal(selectByRules(Array.from({ length: 100 }, (_, i) => f(`src/x${i}.ts`)))?.mode, "all");
});

const tests = [
  { id: "t1", name: "Apply a coupon", use_case: "Checkout", steps: ["Open the cart", "check: The total drops 10%"] },
  { id: "t2", name: "Sign in", use_case: "Account", steps: ["Sign in"] },
];

test("the picker's answer: known tests only; nothing picked or unsure means everything", () => {
  const s = selectionFrom({ runAll: false, reason: "Only the cart changed.", tests: [{ name: "apply a coupon", why: "Cart total code changed" }, { name: "Made up", why: "x" }, { name: "Apply a coupon", why: "dupe" }] }, tests);
  assert.deepEqual(s, { mode: "picked", reason: "Only the cart changed.", tests: [{ id: "t1", name: "Apply a coupon", why: "Cart total code changed" }] });
  assert.equal(selectionFrom({ runAll: false, reason: "", tests: [{ name: "Nope", why: "" }] }, tests).mode, "all");
  assert.equal(selectionFrom({ runAll: true, reason: "Layout changed.", tests: [] }, tests).mode, "all");
  assert.match(selectionText(s), /Ran 1 test this change can affect\. Only the cart changed\.\n- \*\*Apply a coupon\*\*: Cart total code changed/);
});

test("the prompt keeps diffs within budget", () => {
  const big = "+" + "a".repeat(5000);
  const p = pickPrompt(Array.from({ length: 40 }, (_, i) => f(`src/f${i}.ts`, big)), tests, [{ pattern: "/cart", name: "Cart" }]);
  assert.ok(p.length < 50_000, String(p.length));
  assert.match(p, /- Apply a coupon \[Checkout\]: Open the cart → check: The total drops 10%/);
  assert.match(p, /- \/cart \(Cart\)/);
});

// The flow.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SHA = "e".repeat(40);
function world(files: ChangedFile[] | "error") {
  const db: Record<string, Row[]> = {
    github_links: [{ id: "L1", workspace_id: "ws1", project_id: "p1", installation_id: 77, repo_id: 9001, repo_full_name: "acme/shop", run_on: "pull_request", scope: "all", use_case: null, pick_tests: true, enabled: true, environments: { name: "staging", base_url: "https://staging.shop.com" } }],
    tests: [
      { id: "t1", project_id: "p1", name: "Apply a coupon", use_case: "Checkout", steps: [{ kind: "do", text: "Open the cart" }] },
      { id: "t2", project_id: "p1", name: "Sign in", use_case: "Account", steps: [{ kind: "do", text: "Sign in" }] },
    ],
    app_pages: [],
    app_links: [],
    blocks: [],
    test_proposals: [],
    plans: [],
    github_checks: [],
  };
  const query = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let insert: Row[] | null = null;
    let single = false;
    const q: Row = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      insert: (rows: Row | Row[]) => ((insert = Array.isArray(rows) ? rows : [rows]), q),
      update: () => q,
      maybeSingle: () => ((single = true), q),
      single: () => ((single = true), q),
      then: (ok: (v: unknown) => unknown) => {
        let rows: Row[];
        if (insert) {
          rows = insert.map((r, i) => ({ id: `${table}-${db[table]!.length + i + 1}`, ...r }));
          db[table]!.push(...rows);
        } else rows = (db[table] ?? []).filter((r) => filters.every((fn) => fn(r)));
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(ok);
      },
    };
    return q;
  };
  const rpcs: Row[] = [];
  const sb = {
    from: query,
    rpc: async (_fn: string, args: Row) => {
      rpcs.push(args);
      const check = { id: "C1", workspace_id: "ws1", link_id: "L1", installation_id: 77, repo_full_name: "acme/shop", head_sha: SHA, pr_number: args.p_pr, base_url: "https://staging.shop.com", run_ids: args.p_test_ids ?? ["r1", "r2"], check_run_id: null, status: args.p_test_ids?.length === 0 ? "done" : "pending", conclusion: args.p_test_ids?.length === 0 ? "neutral" : null, finished_count: 0, error: args.p_test_ids?.length === 0 ? args.p_selection.reason : null, created_at: new Date().toISOString(), selection: args.p_selection };
      db.github_checks!.push(check);
      return { data: [check], error: null };
    },
  };
  const posted: Row[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (path === "/app/installations/77/access_tokens") return json(201, { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === "/repos/acme/shop/pulls/12/files") return files === "error" ? json(403, { message: "Resource not accessible by integration" }) : json(200, files);
    if (path === "/repos/acme/shop/check-runs") {
      posted.push(JSON.parse(String(init.body)));
      return json(201, { id: 9 });
    }
    return json(404, {});
  }) as typeof fetch;
  return { db, sb, rpcs, posted };
}
const pr = (opened = false) => ({ kind: "pull_request" as const, installationId: 77, repoId: 9001, sha: SHA, pr: 12, opened, title: "Add gift cards" });

test("a pull request that changes the cart runs only the cart's test, and says why on the check", async () => {
  const w = world([f("src/cart/Cart.tsx", "+ total * 0.9")]);
  let seenFiles: ChangedFile[] = [];
  const picker: Picker = async (files) => ((seenFiles = files), { runAll: false, reason: "Only the cart changed.", tests: [{ name: "Apply a coupon", why: "Cart total changed" }], newFlows: [], usage: { input: 3000, output: 200 } });
  assert.deepEqual(await handlePlan(w.sb as never, pr(), { picker }), []);
  assert.equal(seenFiles[0]!.filename, "src/cart/Cart.tsx");
  assert.deepEqual(w.rpcs[0]!.p_test_ids, ["t1"]);
  assert.equal(w.rpcs[0]!.p_ai_calls, 1);
  assert.match(w.posted[0]!.output.summary, /Ran 1 test this change can affect.*\n- \*\*Apply a coupon\*\*: Cart total changed/);
});

test("a docs-only pull request runs nothing and posts a finished neutral check, with no AI call", async () => {
  const w = world([f("README.md")]);
  let called = false;
  await handlePlan(w.sb as never, pr(), { picker: async () => ((called = true), { runAll: true, reason: "", tests: [], newFlows: [], usage: { input: 0, output: 0 } }) });
  assert.equal(called, false);
  assert.deepEqual(w.rpcs[0]!.p_test_ids, []);
  assert.equal(w.posted[0]!.status, "completed");
  assert.equal(w.posted[0]!.conclusion, "neutral");
  assert.match(w.posted[0]!.output.title, /Only docs/);
});

test("when the files can't be read, or the picker fails, every test runs", async () => {
  const a = world("error");
  await handlePlan(a.sb as never, pr(), { picker: async () => ({ runAll: false, reason: "", tests: [{ name: "Sign in", why: "" }], newFlows: [], usage: { input: 0, output: 0 } }) });
  assert.equal(a.rpcs[0]!.p_test_ids, null);
  assert.match(a.rpcs[0]!.p_selection.reason, /couldn't be read/);
  const b = world([f("src/cart/Cart.tsx")]);
  await handlePlan(b.sb as never, pr(), { picker: async () => { throw new Error("529"); } });
  assert.equal(b.rpcs[0]!.p_test_ids, null);
  assert.match(b.rpcs[0]!.p_selection.reason, /couldn't decide/);
});

test("with picking off, or no AI key, every test runs as before", async () => {
  const w = world([f("src/cart/Cart.tsx")]);
  w.db.github_links![0]!.pick_tests = false;
  let called = false;
  await handlePlan(w.sb as never, pr(), { picker: async () => ((called = true), { runAll: false, reason: "", tests: [], newFlows: [], usage: { input: 0, output: 0 } }) });
  assert.equal(called, false);
  assert.equal(w.rpcs[0]!.p_test_ids, null);
  assert.equal(w.rpcs[0]!.p_selection, null);
  const n = world([f("src/cart/Cart.tsx")]);
  await handlePlan(n.sb as never, pr(), {});
  assert.equal(n.rpcs[0]!.p_test_ids, null);
});

test("a new pull request that adds a flow gets proposed tests named after it; a later push doesn't", async () => {
  const w = world([f("src/giftcards/Redeem.tsx", "+ export function Redeem()")]);
  const picker: Picker = async () => ({ runAll: false, reason: "", tests: [{ name: "Apply a coupon", why: "Checkout total" }], newFlows: ["Redeem a gift card"], usage: { input: 1, output: 1 } });
  let change = "";
  const planner: Planner = async (r) => (
    (change = r.change ?? ""),
    { proposals: [{ name: "Redeem a gift card", use_case: "Checkout", priority: "high", reason: "New in this PR.", pages: [], steps: [{ kind: "do", text: "Type GIFT50 into Gift card" }, { kind: "check", text: "The total drops 50" }] }, { name: "Apply a coupon", use_case: "Checkout", priority: "high", reason: "dupe", pages: [], steps: [{ kind: "do", text: "x" }] }], usage: { input: 5000, output: 900 } }
  );
  await handlePlan(w.sb as never, pr(true), { picker, planner });
  assert.match(change, /Pull request #12: Add gift cards\nNew flows: Redeem a gift card\nChanged files:\n- src\/giftcards\/Redeem\.tsx/);
  assert.deepEqual(w.db.test_proposals!.map((p) => p.name), ["Redeem a gift card"]);
  assert.equal(w.db.test_proposals![0]!.source, "PR #12 in acme/shop");
  assert.equal(w.db.plans![0]!.ai_calls, 5);
  const later = world([f("src/giftcards/Redeem.tsx")]);
  let planned = false;
  await handlePlan(later.sb as never, pr(false), { picker, planner: async () => ((planned = true), { proposals: [], usage: { input: 0, output: 0 } }) });
  assert.equal(planned, false);
});
