import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePlan, PLAN_CREDITS } from "../worker/planHandle.ts";
import { cleanProposals, MAX_PROPOSALS, planPrompt, type PlanRequest, type Planner } from "../src/lib/planner.ts";

const req: PlanRequest = {
  site: "https://staging.shop.com",
  pages: [
    { pattern: "/cart", name: "Cart", purpose: "Shows the items in the cart.", title: "Cart", forms: [{ fields: [{ label: "Coupon", type: "text" }], submit: "Apply" }], buttons: ["Checkout"], links: ["/checkout"] },
    { pattern: "/orders/:id", name: null, purpose: null, title: "Order", forms: [], buttons: [], links: [] },
  ],
  tests: [{ name: "Sign in", use_case: "Account" }],
  blocks: ["Sign in"],
  notes: "Coupons give 10% off.",
};

test("the prompt carries the map, existing tests, blocks and notes", () => {
  const p = planPrompt(req);
  assert.match(p, /## \/cart \(Cart\)\nShows the items in the cart\.\nForm 1: Coupon \(text\) → Apply\nButtons: Checkout\nLinks to: \/checkout/);
  assert.match(p, /## \/orders\/:id\nTitle: Order/);
  assert.match(p, /# Tests that already exist\n- Account \/ Sign in/);
  assert.match(p, /# Blocks\n- Sign in/);
  assert.match(p, /# Notes from the team\nCoupons give 10% off\./);
  assert.match(planPrompt({ ...req, pages: [], notes: "" }), /\(not explored yet\)/);
});

test("proposals are cleaned: known blocks only, no repeats, limits held", () => {
  const raw = [
    { name: "Apply a coupon", use_case: "Checkout", priority: "high", reason: "Money.", pages: ["/cart", "nope"], steps: [{ kind: "use", text: "sign in" }, { kind: "use", text: "Made-up block" }, { kind: "do", text: "Type SAVE10 into Coupon" }, { kind: "check", text: "The total drops 10%" }] },
    { name: "Sign in", use_case: "Account", priority: "high", reason: "", pages: [], steps: [{ kind: "do", text: "Sign in" }] },
    { name: "apply a coupon", use_case: "Checkout", priority: "low", reason: "", pages: [], steps: [{ kind: "do", text: "x" }] },
    { name: "Only a block", use_case: "X", priority: "medium", reason: "", pages: [], steps: [{ kind: "use", text: "Sign in" }] },
    { name: "Odd priority", use_case: "", priority: "urgent", reason: "", pages: [], steps: [{ kind: "do", text: "  " }, { kind: "do", text: "Open the cart" }] },
  ];
  const out = cleanProposals(raw, req);
  assert.deepEqual(out.map((p) => p.name), ["Apply a coupon", "Odd priority"]);
  assert.deepEqual(out[0]!.steps, [{ kind: "use", block: "Sign in" }, { kind: "do", text: "Type SAVE10 into Coupon" }, { kind: "check", text: "The total drops 10%" }]);
  assert.deepEqual(out[0]!.pages, ["/cart"]);
  assert.equal(out[1]!.priority, "medium");
  assert.equal(out[1]!.use_case, "General");
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `T${i}`, use_case: "X", priority: "low", reason: "", pages: [], steps: [{ kind: "do", text: "Go" }] }));
  assert.equal(cleanProposals(many, req).length, MAX_PROPOSALS);
});

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function makeDb() {
  const db: Record<string, Row[]> = {
    plans: [{ id: "pl1", locked_by: "w1", status: "running" }],
    app_pages: [{ id: "pg1", project_id: "p1", pattern: "/cart", name: "Cart", purpose: "Cart.", title: "Cart", elements: { forms: [], buttons: ["Checkout"] }, depth: 0 }, { id: "pg2", project_id: "p1", pattern: "/checkout", name: null, purpose: null, title: null, elements: {}, depth: 1 }],
    app_links: [{ project_id: "p1", from_page: "pg1", to_page: "pg2" }],
    tests: [{ project_id: "p1", name: "Sign in", use_case: "Account" }],
    blocks: [{ project_id: "p1", id: "b1", name: "Sign in" }],
    environments: [{ project_id: "p1", base_url: "https://staging.shop.com", created_at: "1" }],
    test_proposals: [],
  };
  const query = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let insert: Row[] | null = null;
    const q: Row = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      update: (f: Row) => ((patch = f), q),
      insert: (rows: Row[]) => ((insert = rows), q),
      then: (ok: (v: unknown) => unknown) => {
        if (insert) {
          db[table]!.push(...insert);
          return Promise.resolve({ data: insert, error: null }).then(ok);
        }
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) for (const r of rows) Object.assign(r, patch);
        return Promise.resolve({ data: rows, error: null }).then(ok);
      },
    };
    return q;
  };
  return { db, sb: { from: query } };
}

test("a plan's proposals are saved with blocks as ids, and the plan counts 10 AI credits", async () => {
  const { db, sb } = makeDb();
  let seen: PlanRequest | null = null;
  const planner: Planner = async (r) => {
    seen = r;
    return { proposals: [{ name: "Check out", use_case: "Checkout", priority: "high", reason: "Money.", pages: ["/cart", "/checkout"], steps: [{ kind: "use", block: "Sign in" }, { kind: "do", text: "Click Checkout" }, { kind: "check", text: "It says Thanks" }] }], usage: { input: 9000, output: 2000 } };
  };
  await handlePlan(sb as never, { id: "pl1", workspace_id: "ws1", project_id: "p1", notes: "Notes", attempts: 1 }, { workerId: "w1", planner });
  assert.deepEqual(seen!.pages[0]!.links, ["/checkout"]);
  assert.equal(seen!.site, "https://staging.shop.com");
  assert.equal(seen!.notes, "Notes");
  assert.equal(db.test_proposals!.length, 1);
  assert.deepEqual(db.test_proposals![0]!.steps[0], { kind: "use", block: "b1" });
  assert.equal(db.plans![0]!.status, "done");
  assert.equal(db.plans![0]!.proposals, 1);
  assert.equal(db.plans![0]!.ai_calls, PLAN_CREDITS);
});

test("a planner error ends the plan with its reason, and no planner says why", async () => {
  const a = makeDb();
  await handlePlan(a.sb as never, { id: "pl1", workspace_id: "ws1", project_id: "p1", notes: "", attempts: 1 }, { workerId: "w1", planner: async () => { throw new Error("529 overloaded"); } });
  assert.equal(a.db.plans![0]!.status, "error");
  assert.match(a.db.plans![0]!.error, /529/);
  assert.equal(a.db.plans![0]!.ai_calls, undefined, "a failed plan used credits");
  const b = makeDb();
  await handlePlan(b.sb as never, { id: "pl1", workspace_id: "ws1", project_id: "p1", notes: "", attempts: 1 }, { workerId: "w1" });
  assert.match(b.db.plans![0]!.error, /ANTHROPIC_API_KEY/);
});
