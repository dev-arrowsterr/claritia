// The Claritia runner service. Takes waiting runs from the database, runs each in a fresh browser,
// writes step results as they happen, and uploads the video, trace, screenshots and console to storage.
//   node worker/index.ts
// Needs SUPABASE_URL, SUPABASE_SECRET_KEY (or its older name SUPABASE_SERVICE_ROLE_KEY) and SECRETS_KEY. Answers health checks on PORT.
// With ANTHROPIC_API_KEY it writes code for steps that have none (CLAUDE_MODEL and CLAUDE_EFFORT are optional).
// Test inboxes read mail on INBOX_DOMAIN (default inbox.tryclaritia.com).
// With IDLE_EXIT_MS, the runner exits after that long with nothing to run, so a Fly.io machine can sleep for free
// between runs. The database wakes it by calling its address when a run is queued (supabase/migrations/011).

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handleExploration, type Exploration } from "./exploreHandle.ts";
import { handleRun, type Run } from "./handle.ts";
import { shouldSleep } from "./idle.ts";
import { claudeJudge, type Judge } from "./judge.ts";
import { claudeNamer, type Namer } from "./namer.ts";
import { claudeWriter, type Writer } from "./writer.ts";

const env = (k: string) => process.env[k]?.trim() ?? "";
const SLOTS = Math.max(1, Math.min(8, Number(env("WORKER_SLOTS") || 2)));
const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const IDLE_MS = 2000;
const supabaseKey = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const missing = [...["SUPABASE_URL", "SECRETS_KEY"].filter((k) => !env(k)), ...(supabaseKey ? [] : ["SUPABASE_SECRET_KEY"])];

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
const busy = new Set<string>();
const IDLE_EXIT_MS = Number(env("IDLE_EXIT_MS") || 0);
let lastWorkAt = Date.now();

// Health checks: Render needs a port to know the service is up.
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: !missing.length, missing, writer: !!env("ANTHROPIC_API_KEY"), worker: WORKER_ID, slots: SLOTS, running: busy.size }));
}).listen(Number(env("PORT") || 10000));

if (missing.length) {
  log(`Waiting: add ${missing.join(", ")} to this service's environment.`);
} else {
  const sb = createClient(env("SUPABASE_URL").replace(/\/+$/, ""), supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const effort = env("CLAUDE_EFFORT");
  const writer = env("ANTHROPIC_API_KEY")
    ? claudeWriter({ apiKey: env("ANTHROPIC_API_KEY"), model: env("CLAUDE_MODEL") || undefined, effort: effort === "low" || effort === "high" ? effort : "medium" })
    : undefined;
  const judge = env("ANTHROPIC_API_KEY")
    ? claudeJudge({ apiKey: env("ANTHROPIC_API_KEY"), model: env("CLAUDE_MODEL") || undefined, effort: effort === "low" || effort === "high" ? effort : "medium" })
    : undefined;
  const namer = env("ANTHROPIC_API_KEY") ? claudeNamer({ apiKey: env("ANTHROPIC_API_KEY"), model: env("CLAUDE_NAMER_MODEL") || undefined }) : undefined;
  log(`Runner ${WORKER_ID} started with ${SLOTS} slots${writer ? "" : ". No ANTHROPIC_API_KEY, so steps with no code can't be written"}.`);
  for (let i = 0; i < SLOTS; i++) void slot(sb, i, writer, judge, namer);
  void scheduler(sb);

  // Go to sleep when there's been nothing to run for IDLE_EXIT_MS. One last look first, so a run queued
  // just now isn't left waiting.
  if (IDLE_EXIT_MS > 0) {
    log(`Sleeps after ${Math.round(IDLE_EXIT_MS / 1000)}s with nothing to run.`);
    setInterval(async () => {
      if (stopping || !shouldSleep({ idleExitMs: IDLE_EXIT_MS, lastWorkAt, now: Date.now(), running: busy.size })) return;
      const [runs, explorations] = await Promise.all([
        sb.from("runs").select("id", { count: "exact", head: true }).eq("status", "queued"),
        sb.from("explorations").select("id", { count: "exact", head: true }).eq("status", "queued"),
      ]);
      if (runs.count || explorations.count) {
        lastWorkAt = Date.now();
        return;
      }
      stopping = true;
      log("Nothing to run: going to sleep.");
      process.exit(0);
    }, 5000);
  }

  // On shutdown, hand running runs back to the queue so another runner picks them up right away.
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping: handing running runs back to the queue.");
    if (busy.size) {
      await sb.from("runs").update({ status: "queued", locked_by: null, locked_at: null }).in("id", [...busy]).eq("locked_by", WORKER_ID);
      await sb.from("explorations").update({ status: "queued", locked_by: null, locked_at: null }).in("id", [...busy]).eq("locked_by", WORKER_ID).eq("status", "running");
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function slot(sb: SupabaseClient, n: number, writer: Writer | undefined, judge: Judge | undefined, namer: Namer | undefined) {
  const chromiumPath = env("CHROMIUM_PATH") || undefined;
  while (!stopping) {
    try {
      // Runs first; an exploration only when no run is waiting.
      const { data, error } = await sb.rpc("claim_run", { p_worker: WORKER_ID });
      if (error) throw new Error(error.message);
      const run = (data as Run[] | null)?.[0];
      let exploration: Exploration | undefined;
      if (!run) {
        const x = await sb.rpc("claim_exploration", { p_worker: WORKER_ID });
        if (x.error) throw new Error(x.error.message);
        exploration = (x.data as Exploration[] | null)?.[0];
      }
      const id = run?.id ?? exploration?.id;
      if (!id) {
        await sleep(IDLE_MS + n * 250);
        continue;
      }
      busy.add(id);
      lastWorkAt = Date.now();
      try {
        if (run) await handleRun(sb, run, { workerId: WORKER_ID, chromiumPath, log, writer, judge, inboxDomain: env("INBOX_DOMAIN") || undefined });
        else await handleExploration(sb, exploration!, { workerId: WORKER_ID, chromiumPath, log, namer });
      } finally {
        busy.delete(id);
        lastWorkAt = Date.now();
      }
    } catch (e) {
      log(`Slot ${n}:`, e instanceof Error ? e.message : e);
      await sleep(5000);
    }
  }
}

// Every minute, queue the tests of schedules that are due. Several runners can do this at once safely.
async function scheduler(sb: SupabaseClient) {
  while (!stopping) {
    const { data, error } = await sb.rpc("fire_due_schedules");
    if (error) log(`Schedules: ${error.message}`);
    else if (data) log(`Schedules: fired ${data}.`);
    await sleep(60_000);
  }
}
