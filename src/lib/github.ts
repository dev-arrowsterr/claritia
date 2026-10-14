// The Claritia GitHub App: webhook signatures, the app's sign-in token, the install link's state, and what each
// GitHub event asks for. No network calls here; those are in githubApp.ts.

import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { Outcome } from "./outcome.ts";

/** GitHub signs each webhook body with the app's webhook secret (X-Hub-Signature-256). */
export function verifySignature(body: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=") || !secret) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** The token the app signs in to GitHub with: a JWT signed with its private key, good for 9 minutes. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey.replace(/\\n/g, "\n"));
  return `${head}.${body}.${b64url(sig)}`;
}

export type InstallState = { workspaceId: string; userId: string; exp: number };

/** The state sent to GitHub with the install link, signed so it comes back unchanged. Good for 30 minutes. */
export function signState(s: Omit<InstallState, "exp">, key: string, now = Date.now()): string {
  const body = b64url(JSON.stringify({ ...s, exp: now + 30 * 60_000 }));
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function readState(state: string | null, key: string, now = Date.now()): InstallState | null {
  const [body, sig] = (state ?? "").split(".");
  if (!body || !sig || !key) return null;
  const want = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as InstallState;
    return typeof s.workspaceId === "string" && typeof s.userId === "string" && s.exp > now ? s : null;
  } catch {
    return null;
  }
}

export type EventPlan =
  | { kind: "pull_request"; installationId: number; repoId: number; sha: string; pr: number }
  | { kind: "preview"; installationId: number; repoId: number; sha: string; url: string }
  | { kind: "rerun"; installationId: number; checkRunId: number }
  | { kind: "uninstalled"; installationId: number }
  | { kind: "repos_removed"; installationId: number; repoIds: number[] }
  | { kind: "ignore"; why: string };

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What a GitHub event asks Claritia to do. */
export function planEvent(event: string | null, p: Payload, appId: string): EventPlan {
  const installationId = Number(p?.installation?.id);
  if (!installationId) return { kind: "ignore", why: "no installation" };

  if (event === "pull_request") {
    if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) return { kind: "ignore", why: `pull_request ${p.action}` };
    const pr = p.pull_request;
    if (!pr || pr.draft) return { kind: "ignore", why: "draft" };
    if (pr.state !== "open") return { kind: "ignore", why: "closed" };
    const sha = String(pr.head?.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha)) return { kind: "ignore", why: "no commit" };
    return { kind: "pull_request", installationId, repoId: Number(p.repository?.id), sha, pr: Number(pr.number) };
  }

  if (event === "deployment_status") {
    const d = p.deployment;
    const s = p.deployment_status;
    if (s?.state !== "success") return { kind: "ignore", why: `deployment ${s?.state}` };
    if (d?.production_environment || /^production$/i.test(String(d?.environment ?? ""))) return { kind: "ignore", why: "production deploy" };
    const url = String(s.environment_url || s.target_url || "");
    if (!/^https:\/\/[^\s/]+/.test(url)) return { kind: "ignore", why: "no address" };
    const sha = String(d?.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha)) return { kind: "ignore", why: "no commit" };
    return { kind: "preview", installationId, repoId: Number(p.repository?.id), sha, url };
  }

  if (event === "check_run" && p.action === "rerequested") {
    if (String(p.check_run?.app?.id) !== String(appId)) return { kind: "ignore", why: "another app's check" };
    return { kind: "rerun", installationId, checkRunId: Number(p.check_run.id) };
  }

  if (event === "installation" && (p.action === "deleted" || p.action === "suspend")) return { kind: "uninstalled", installationId };

  if (event === "installation_repositories" && p.action === "removed") {
    return { kind: "repos_removed", installationId, repoIds: ((p.repositories_removed ?? []) as { id: number }[]).map((r) => Number(r.id)) };
  }

  return { kind: "ignore", why: `${event} ${p.action ?? ""}`.trim() };
}

export type Conclusion = "success" | "failure" | "neutral" | "timed_out";

/**
 * A check's result. Any failed test fails it, so a real failure blocks the merge. A flaky test that passed on its
 * re-run passes. Tests that couldn't run (the site was down, a setup problem) leave it neutral, so they don't block.
 */
export function conclusionOf(runs: Outcome[]): { conclusion: Conclusion; title: string } {
  const passed = runs.filter((r) => r.passed).length;
  const failed = runs.filter((r) => !r.passed && r.status === "failed");
  const couldnt = runs.filter((r) => !r.passed && r.status !== "failed");
  const bugs = failed.filter((r) => r.verdict === "app_bug").length;
  const parts = [`${passed} passed`];
  if (failed.length) parts.push(`${failed.length} failed${bugs ? ` (${bugs} app ${bugs === 1 ? "bug" : "bugs"})` : ""}`);
  if (couldnt.length) parts.push(`${couldnt.length} couldn't run`);
  const title = parts.join(", ");
  if (failed.length) return { conclusion: "failure", title };
  if (couldnt.length) return { conclusion: "neutral", title };
  return { conclusion: "success", title };
}

const VERDICT: Record<string, string> = { app_bug: "App bug", flaky: "Flaky", setup: "Setup" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** The check's details: one row per test, with the reason and a link to the run. */
export function checkSummary(runs: Outcome[], where: string): string {
  const rows = runs.map((r) => {
    const result = !r.done ? "Running" : r.passed ? (r.passed_on_retry ? "Passed on re-run" : "Passed") : r.status === "failed" ? `Failed${r.verdict ? `: ${VERDICT[r.verdict]}` : ""}` : `Couldn't run${r.verdict ? `: ${VERDICT[r.verdict]}` : ""}`;
    const why = r.passed ? "" : (r.reason ?? (r.failed_step ? `Step ${r.failed_step.position}: ${r.failed_step.label}` : (r.error ?? "")));
    return `| ${cell(r.test)} | ${result} | ${cell(why).slice(0, 300)} | [Open](${r.url}) |`;
  });
  return [`Ran on ${where}.`, "", "| Test | Result | Why | Run |", "| --- | --- | --- | --- |", ...rows].join("\n");
}
