// What the runner service does with one claimed run: read its steps and secrets, run it,
// write step results as they happen, and upload the files. Takes the Supabase client as a
// parameter, so scripts/worker-check.ts can drive it with a stand-in.

import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLock } from "../src/lib/lock.ts";
import { unseal } from "../src/lib/seal.ts";
import { executeRun, maskSecrets, type Inbox, type InboxMail, type RunStep, type StepUpdate } from "./runner.ts";
import type { Writer } from "./writer.ts";

export type Run = { id: string; workspace_id: string; project_id?: string; environment_id: string | null; base_url: string; lock: string; attempts: number; test_name?: string };
type Options = {
  workerId: string;
  chromiumPath?: string;
  allowPrivate?: boolean;
  log?: (...a: unknown[]) => void;
  heartbeatMs?: number;
  writer?: Writer;
  frameMs?: number;
  /** The domain test inboxes receive mail on. */
  inboxDomain?: string;
  inboxTimeoutMs?: number;
};

/** A run's inbox addresses look like <project inbox id>-<name>-<run code>@inbox.tryclaritia.com. */
export function inboxAddress(inboxId: string, tag: string, runId: string, domain: string) {
  return `${inboxId}-${tag}-${runId.replace(/-/g, "").slice(0, 6)}@${domain}`.toLowerCase();
}

/** The project's test inbox, read from the inbox_messages table. */
async function inboxFor(sb: SupabaseClient, run: Run, domain: string): Promise<Inbox | undefined> {
  if (!run.project_id) return undefined;
  const { data, error } = await sb.from("projects").select("inbox_id").eq("id", run.project_id);
  if (error) throw new Error(error.message);
  const inboxId = (data as { inbox_id: string }[] | null)?.[0]?.inbox_id;
  if (!inboxId) return undefined;
  return {
    address: (tag) => inboxAddress(inboxId, tag, run.id, domain),
    read: async (address, since) => {
      const { data: rows, error: readErr } = await sb
        .from("inbox_messages")
        .select("subject, text_body, html_body, received_at")
        .eq("project_id", run.project_id!)
        .eq("to_address", address)
        .gte("received_at", since.toISOString())
        .order("received_at", { ascending: false })
        .limit(10);
      if (readErr) throw new Error(readErr.message);
      return ((rows ?? []) as { subject: string | null; text_body: string | null; html_body: string | null; received_at: string }[]).map(
        (r): InboxMail => ({ subject: r.subject ?? "", text: r.text_body ?? "", html: r.html_body ?? "", receivedAt: r.received_at }),
      );
    },
  };
}

/** AI credits left this period. Null means no limit. A failed lookup never blocks a run. */
async function creditsLeft(sb: SupabaseClient, workspaceId: string): Promise<number | null> {
  const { data, error } = await sb.rpc("workspace_usage", { p_workspace: workspaceId });
  const u = (data as { credits_used: number; credits_limit: number | null }[] | null)?.[0];
  if (error || !u || u.credits_limit == null) return null;
  return Math.max(0, u.credits_limit - u.credits_used);
}

/** Stops the writer once the plan's AI credits are used up. */
function limitWriter(writer: Writer, left: number | null): Writer {
  if (left === null) return writer;
  let remaining = left;
  return async (r) => {
    if (remaining <= 0) throw new Error("This month's AI credits are used up. Upgrade in Settings to write more steps.");
    remaining--;
    return writer(r);
  };
}

/** How a step's comment reads in the lock: the step's words, "check: ..." or "use: Block name". */
export function lockLabel(kind: string, label: string) {
  if (kind === "check") return `check: ${label.replace(/^Check:\s*/, "")}`;
  if (kind === "use") return `use: ${label.replace(/^Use\s+/, "")}`;
  return label;
}

/** The environment's secrets that the code uses, opened with SECRETS_KEY. */
export async function secretsFor(sb: SupabaseClient, environmentId: string | null, names: string[]) {
  if (!environmentId || !names.length) return {};
  const { data, error } = await sb.from("env_secrets").select("name, env_secret_values(sealed)").eq("environment_id", environmentId).in("name", names);
  if (error) throw new Error(error.message);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as unknown as { name: string; env_secret_values: { sealed: string } | { sealed: string }[] | null }[]) {
    const v = Array.isArray(row.env_secret_values) ? row.env_secret_values[0] : row.env_secret_values;
    if (v?.sealed) out[row.name] = unseal(v.sealed);
  }
  return out;
}

export async function handleRun(sb: SupabaseClient, run: Run, opts: Options) {
  const log = opts.log ?? (() => undefined);
  const WORKER_ID = opts.workerId;
  log(`Run ${run.id}: started (try ${run.attempts}).`);
  // Keep the claim fresh, so the run isn't taken by another runner while it's still going.
  const heartbeat = setInterval(() => void sb.from("runs").update({ locked_at: new Date().toISOString() }).eq("id", run.id).eq("locked_by", WORKER_ID).then(() => undefined), opts.heartbeatMs ?? 30_000);
  const dir = mkdtempSync(join(tmpdir(), `run-${run.id.slice(0, 8)}-`));
  const prefix = `${run.workspace_id}/${run.id}`;
  let secrets: Record<string, string> = {};

  const upload = async (file: string, name: string, contentType: string) => {
    const body = await readFile(file);
    const path = `${prefix}/${name}`;
    const { error } = await sb.storage.from("runs").upload(path, body, { contentType, upsert: true });
    if (error) throw new Error(`Upload of ${name} failed: ${error.message}`);
    return path;
  };

  const finish = (fields: Record<string, unknown>) =>
    sb
      .from("runs")
      .update({ ...fields, finished_at: new Date().toISOString(), locked_at: null })
      .eq("id", run.id)
      .eq("locked_by", WORKER_ID);

  try {
    const { data: stepRows, error } = await sb.from("run_steps").select("position, kind, label, intent").eq("run_id", run.id).order("position");
    if (error) throw new Error(error.message);
    const steps: RunStep[] = ((stepRows ?? []) as { position: number; kind: RunStep["kind"]; label: string; intent: string | null }[]).map((r) => ({
      position: r.position,
      kind: r.kind,
      label: lockLabel(r.kind, r.label),
      intent: r.intent || r.label,
    }));
    const parsed = parseLock(run.lock);
    const inbox = await inboxFor(sb, run, opts.inboxDomain ?? "inbox.tryclaritia.com");
    const writer = opts.writer ? limitWriter(opts.writer, await creditsLeft(sb, run.workspace_id)) : undefined;
    if (!opts.writer && (!parsed.ok || !parsed.actionCount) && !run.lock.trim()) throw new Error("it can't write code yet. Add ANTHROPIC_API_KEY to the runner service.");
    // The writer may use any of the environment's secrets, so it gets all their names. Code that's already written only gets what it uses.
    let names = parsed.ok ? parsed.secrets : [];
    if (opts.writer && run.environment_id) {
      const { data: all } = await sb.from("env_secrets").select("name").eq("environment_id", run.environment_id);
      names = [...new Set([...names, ...((all ?? []) as { name: string }[]).map((r) => r.name)])];
    }
    secrets = await secretsFor(sb, run.environment_id, names);

    const stepHook = async (u: StepUpdate) => {
      const fields: Record<string, unknown> = { status: u.status };
      if (u.retried !== undefined) fields.retried = u.retried;
      if (u.startedMs !== undefined) fields.started_ms = u.startedMs;
      if (u.durationMs !== undefined) fields.duration_ms = u.durationMs;
      if (u.error !== undefined) fields.error = u.error && maskSecrets(u.error, secrets).slice(0, 2000);
      if (u.written !== undefined) fields.written = u.written;
      if (u.code !== undefined) fields.code = u.code;
      if (u.screenshot) fields.screenshot_path = await upload(u.screenshot, `step-${u.position}.jpg`, "image/jpeg").catch(() => null);
      await sb.from("run_steps").update(fields).eq("run_id", run.id).eq("position", u.position);
    };

    // Live frames go up as live-1.jpg, live-2.jpg, ... and the run points at the newest. They're removed when the run ends.
    const frames: string[] = [];
    const frameHook = async (jpeg: Buffer) => {
      const path = `${prefix}/live-${frames.length + 1}.jpg`;
      const { error: upErr } = await sb.storage.from("runs").upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
      if (upErr) return;
      frames.push(path);
      await sb.from("runs").update({ live_path: path }).eq("id", run.id).eq("locked_by", WORKER_ID);
    };

    const result = await executeRun(
      {
        baseUrl: run.base_url,
        lock: run.lock,
        positions: steps.map((s) => s.position),
        secrets,
        dir,
        chromiumPath: opts.chromiumPath,
        allowPrivate: opts.allowPrivate,
        writer,
        inbox,
        inboxTimeoutMs: opts.inboxTimeoutMs,
        testName: run.test_name,
        steps,
        frameMs: opts.frameMs,
        runTimeoutMs: opts.writer ? 15 * 60_000 : undefined,
      },
      { step: stepHook, frame: frameHook },
    );
    if (frames.length) await Promise.resolve(sb.storage.from("runs").remove(frames)).catch(() => undefined);

    // Save the code the writer wrote, so the next run replays it with no AI calls.
    if (result.lock) {
      const { error: saveErr } = await sb.rpc("save_written_lock", { p_run: run.id, p_lock: result.lock });
      if (saveErr) log(`Run ${run.id}: couldn't save the written code: ${saveErr.message}`);
    }

    // A run that stopped before any step ran marks every step as skipped.
    if (result.status === "error") await sb.from("run_steps").update({ status: "skipped" }).eq("run_id", run.id).in("status", ["pending", "running"]);

    const video_path = result.video ? await upload(result.video, "video.webm", "video/webm").catch(() => null) : null;
    const trace_paths: string[] = [];
    for (const [i, t] of result.traces.entries()) {
      const p = await upload(t, result.traces.length > 1 ? `trace-${i + 1}.zip` : "trace.zip", "application/zip").catch(() => null);
      if (p) trace_paths.push(p);
    }
    const console_path = result.consoleFile ? await upload(result.consoleFile, "console.json", "application/json").catch(() => null) : null;
    const network_path = result.networkFile ? await upload(result.networkFile, "network.json", "application/json").catch(() => null) : null;
    await finish({
      status: result.status,
      error: result.error && maskSecrets(result.error, secrets),
      duration_ms: result.durationMs,
      video_path,
      trace_paths,
      console_path,
      network_path,
      live_path: null,
      ai_calls: result.ai.calls,
      ai_input_tokens: result.ai.input,
      ai_output_tokens: result.ai.output,
    });
    // The workspace's first passing run, to track how long sign-up to a passing test takes.
    if (result.status === "passed") await sb.from("workspaces").update({ first_pass_at: new Date().toISOString() }).eq("id", run.workspace_id).is("first_pass_at", null);
    log(`Run ${run.id}: ${result.status} in ${result.durationMs}ms${result.ai.calls ? `, ${result.ai.calls} AI calls` : ""}.`);
  } catch (e) {
    const message = maskSecrets(e instanceof Error ? e.message : String(e), secrets);
    log(`Run ${run.id}: error: ${message}`);
    await sb.from("run_steps").update({ status: "skipped" }).eq("run_id", run.id).in("status", ["pending", "running"]);
    await finish({ status: "error", error: `The runner hit a problem: ${message}` });
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
