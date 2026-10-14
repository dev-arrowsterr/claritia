import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, checkSummary, conclusionOf, planEvent, readPrivateKey, readState, signState, verifySignature } from "../src/lib/github.ts";
import type { Outcome } from "../src/lib/outcome.ts";

test("a webhook body is accepted only with the right signature", () => {
  const body = '{"action":"opened"}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifySignature(body, sig, "s3cret"), true);
  assert.equal(verifySignature(body + " ", sig, "s3cret"), false);
  assert.equal(verifySignature(body, sig, "other"), false);
  assert.equal(verifySignature(body, null, "s3cret"), false);
  assert.equal(verifySignature(body, "sha1=abc", "s3cret"), false);
  assert.equal(verifySignature(body, sig, ""), false);
});

test("the app's token is a JWT signed with its key, naming the app, good for under 10 minutes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const now = Date.parse("2026-10-14T12:00:00Z");
  // Keys pasted into an env var often arrive with \n written out.
  const token = appJwt("12345", pem.replace(/\n/g, "\\n"), now);
  const [head, body, sig] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, now / 1000 - 60);
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, "base64url")));
});

test("the private key works however it was pasted", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const clean = readPrivateKey(pem);
  const pasted = {
    "as is": pem,
    "line breaks as spaces": pem.replace(/\n/g, " "),
    "line breaks lost": pem.replace(/\n/g, ""),
    "\\n written out": pem.replace(/\n/g, "\\n"),
    "in quotes": `"${pem}"`,
    "windows line breaks": pem.replace(/\n/g, "\r\n"),
    "base64 of the file": Buffer.from(pem).toString("base64"),
  };
  for (const [how, raw] of Object.entries(pasted)) assert.equal(readPrivateKey(raw), clean, how);
  assert.ok(appJwt("1", pem.replace(/\n/g, " ")).split(".").length === 3);
  assert.throws(() => readPrivateKey("not a key"), /isn't a private key/);
  assert.throws(() => readPrivateKey(pem.slice(0, 200) + pem.slice(-40)), /cut off or changed/);
  assert.throws(() => readPrivateKey("-----BEGIN RSA PRIVATE KEY----- -----END RSA PRIVATE KEY-----"), /empty/);
});

test("the install state comes back only unchanged and in time", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const state = signState({ workspaceId: "ws1", userId: "u1" }, "key-1", now);
  assert.deepEqual(readState(state, "key-1", now + 60_000), { workspaceId: "ws1", userId: "u1", exp: now + 30 * 60_000 });
  assert.equal(readState(state, "key-2", now), null);
  assert.equal(readState(state, "key-1", now + 31 * 60_000), null);
  const [body, sig] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ workspaceId: "ws2", userId: "u1", exp: now + 1e9 })).toString("base64url");
  assert.equal(readState(`${forged}.${sig}`, "key-1", now), null);
  assert.equal(readState(`${body}.`, "key-1", now), null);
  assert.equal(readState(null, "key-1", now), null);
});

const SHA = "a".repeat(40);
const inst = { installation: { id: 77 }, repository: { id: 9001 } };

test("pull requests run on open, push, reopen and ready, but not drafts or closed ones", () => {
  const pr = (action: string, over: Record<string, unknown> = {}) => planEvent("pull_request", { ...inst, action, pull_request: { number: 7, title: "Add coupons", state: "open", draft: false, head: { sha: SHA }, ...over } }, "1");
  for (const a of ["opened", "synchronize", "reopened", "ready_for_review"]) assert.deepEqual(pr(a), { kind: "pull_request", installationId: 77, repoId: 9001, sha: SHA, pr: 7, opened: a === "opened" || a === "ready_for_review", title: "Add coupons" });
  assert.equal(pr("opened", { draft: true }).kind, "ignore");
  assert.equal(pr("closed").kind, "ignore");
  assert.equal(pr("labeled").kind, "ignore");
  assert.equal(pr("synchronize", { state: "closed" }).kind, "ignore");
  assert.equal(planEvent("pull_request", { action: "opened", pull_request: { head: { sha: SHA } } }, "1").kind, "ignore");
});

test("a successful preview deploy runs on its own address; production and failed deploys don't", () => {
  const dep = (status: Record<string, unknown>, deployment: Record<string, unknown> = {}) =>
    planEvent("deployment_status", { ...inst, deployment: { sha: SHA, environment: "Preview", ...deployment }, deployment_status: { state: "success", environment_url: "https://shop-git-fix.vercel.app", ...status } }, "1");
  assert.deepEqual(dep({}), { kind: "preview", installationId: 77, repoId: 9001, sha: SHA, url: "https://shop-git-fix.vercel.app" });
  assert.equal(dep({ state: "pending" }).kind, "ignore");
  assert.equal(dep({ state: "failure" }).kind, "ignore");
  assert.equal(dep({}, { environment: "Production" }).kind, "ignore");
  assert.equal(dep({}, { production_environment: true }).kind, "ignore");
  assert.equal(dep({ environment_url: "", target_url: "" }).kind, "ignore");
  assert.equal(dep({ environment_url: "http://10.0.0.5" }).kind, "ignore");
  assert.equal((dep({ environment_url: "", target_url: "https://deploy-preview-7--shop.netlify.app" }) as { url: string }).url, "https://deploy-preview-7--shop.netlify.app");
});

test("only our own check's re-run button re-runs, and uninstalls and removed repos are noticed", () => {
  assert.deepEqual(planEvent("check_run", { ...inst, action: "rerequested", check_run: { id: 5, app: { id: 1 } } }, "1"), { kind: "rerun", installationId: 77, checkRunId: 5 });
  assert.equal(planEvent("check_run", { ...inst, action: "rerequested", check_run: { id: 5, app: { id: 2 } } }, "1").kind, "ignore");
  assert.equal(planEvent("check_run", { ...inst, action: "completed", check_run: { id: 5, app: { id: 1 } } }, "1").kind, "ignore");
  assert.deepEqual(planEvent("installation", { ...inst, action: "deleted" }, "1"), { kind: "uninstalled", installationId: 77 });
  assert.deepEqual(planEvent("installation_repositories", { ...inst, action: "removed", repositories_removed: [{ id: 3 }] }, "1"), { kind: "repos_removed", installationId: 77, repoIds: [3] });
  assert.equal(planEvent("push", inst, "1").kind, "ignore");
});

const o = (over: Partial<Outcome>): Outcome => ({ id: "r1", final_id: "r1", test_id: "t1", test: "Checkout", environment: "staging", status: "passed", done: true, passed: true, passed_on_retry: false, verdict: null, reason: null, error: null, failed_step: null, duration_ms: 1000, url: "https://app.tryclaritia.com/runs/r1", ...over });

test("the check fails on a failed test, passes a flaky test that passed on re-run, and doesn't block on setup", () => {
  assert.deepEqual(conclusionOf([o({}), o({ passed_on_retry: true })]), { conclusion: "success", title: "2 passed" });
  assert.deepEqual(conclusionOf([o({}), o({ status: "failed", passed: false, verdict: "app_bug" })]), { conclusion: "failure", title: "1 passed, 1 failed (1 app bug)" });
  // A test still failing after its re-run is a failure.
  assert.equal(conclusionOf([o({ status: "failed", passed: false, verdict: "flaky" })]).conclusion, "failure");
  // A failure the Judge couldn't sort is still a failure.
  assert.equal(conclusionOf([o({ status: "failed", passed: false, verdict: null })]).conclusion, "failure");
  assert.deepEqual(conclusionOf([o({}), o({ status: "error", passed: false, verdict: "setup" })]), { conclusion: "neutral", title: "1 passed, 1 couldn't run" });
  assert.equal(conclusionOf([o({ status: "failed", passed: false }), o({ status: "error", passed: false })]).conclusion, "failure");
});

test("the check's details list each test with its reason and run", () => {
  const md = checkSummary([o({}), o({ id: "r2", test: "Save | settings", status: "failed", passed: false, verdict: "app_bug", reason: "Save answers 500.", url: "https://app.tryclaritia.com/runs/r2" })], "pr-7.vercel.app");
  assert.match(md, /^Ran on pr-7.vercel.app\./);
  assert.match(md, /\| Checkout \| Passed \| {2}\| \[Open\]\(https:\/\/app.tryclaritia.com\/runs\/r1\) \|/);
  assert.match(md, /\| Save \\\| settings \| Failed: App bug \| Save answers 500\. \|/);
});
