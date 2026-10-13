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
import { executeRun, maskSecrets, type StepUpdate } from "./runner.ts";

export type Run = { id: string; workspace_id: string; environment_id: string | null; base_url: string; lock: string; attempts: number };
type Options = { workerId: string; chromiumPath?: string; allowPrivate?: boolean; log?: (...a: unknown[]) => void; heartbeatMs?: number };

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
    const { data: steps, error } = await sb.from("run_steps").select("position").eq("run_id", run.id).order("position");
    if (error) throw new Error(error.message);
    const parsed = parseLock(run.lock);
    secrets = await secretsFor(sb, run.environment_id, parsed.ok ? parsed.secrets : []);

    const stepHook = async (u: StepUpdate) => {
      const fields: Record<string, unknown> = { status: u.status };
      if (u.retried !== undefined) fields.retried = u.retried;
      if (u.startedMs !== undefined) fields.started_ms = u.startedMs;
      if (u.durationMs !== undefined) fields.duration_ms = u.durationMs;
      if (u.error !== undefined) fields.error = u.error && maskSecrets(u.error, secrets).slice(0, 2000);
      if (u.screenshot) fields.screenshot_path = await upload(u.screenshot, `step-${u.position}.jpg`, "image/jpeg").catch(() => null);
      await sb.from("run_steps").update(fields).eq("run_id", run.id).eq("position", u.position);
    };

    const result = await executeRun(
      { baseUrl: run.base_url, lock: run.lock, positions: (steps as { position: number }[]).map((s) => s.position), secrets, dir, chromiumPath: opts.chromiumPath, allowPrivate: opts.allowPrivate },
      { step: stepHook },
    );

    // A run that stopped before any step ran marks every step as skipped.
    if (result.status === "error") await sb.from("run_steps").update({ status: "skipped" }).eq("run_id", run.id).in("status", ["pending", "running"]);

    const video_path = result.video ? await upload(result.video, "video.webm", "video/webm").catch(() => null) : null;
    const trace_paths: string[] = [];
    for (const [i, t] of result.traces.entries()) {
      const p = await upload(t, result.traces.length > 1 ? `trace-${i + 1}.zip` : "trace.zip", "application/zip").catch(() => null);
      if (p) trace_paths.push(p);
    }
    const console_path = result.consoleFile ? await upload(result.consoleFile, "console.json", "application/json").catch(() => null) : null;
    await finish({ status: result.status, error: result.error && maskSecrets(result.error, secrets), duration_ms: result.durationMs, video_path, trace_paths, console_path });
    log(`Run ${run.id}: ${result.status} in ${result.durationMs}ms.`);
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
