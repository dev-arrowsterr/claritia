// The Claritia runner service. Takes waiting runs from the database, runs each in a fresh browser,
// writes step results as they happen, and uploads the video, trace, screenshots and console to storage.
//   node worker/index.ts
// Needs SUPABASE_URL, SUPABASE_SECRET_KEY (or its older name SUPABASE_SERVICE_ROLE_KEY) and SECRETS_KEY. Answers health checks on PORT.
// With ANTHROPIC_API_KEY it writes code for steps that have none (CLAUDE_MODEL and CLAUDE_EFFORT are optional).
// Test inboxes read mail on INBOX_DOMAIN (default inbox.tryclaritia.com).

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handleRun, type Run } from "./handle.ts";
import { claudeJudge, type Judge } from "./judge.ts";
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
  log(`Runner ${WORKER_ID} started with ${SLOTS} slots${writer ? "" : ". No ANTHROPIC_API_KEY, so steps with no code can't be written"}.`);
  for (let i = 0; i < SLOTS; i++) void slot(sb, i, writer, judge);
  void scheduler(sb);

  // On shutdown, hand running runs back to the queue so another runner picks them up right away.
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping: handing running runs back to the queue.");
    if (busy.size) await sb.from("runs").update({ status: "queued", locked_by: null, locked_at: null }).in("id", [...busy]).eq("locked_by", WORKER_ID);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function slot(sb: SupabaseClient, n: number, writer: Writer | undefined, judge: Judge | undefined) {
  while (!stopping) {
    try {
      const { data, error } = await sb.rpc("claim_run", { p_worker: WORKER_ID });
      if (error) throw new Error(error.message);
      const run = (data as Run[] | null)?.[0];
      if (!run) {
        await sleep(IDLE_MS + n * 250);
        continue;
      }
      busy.add(run.id);
      try {
        await handleRun(sb, run, { workerId: WORKER_ID, chromiumPath: env("CHROMIUM_PATH") || undefined, log, writer, judge, inboxDomain: env("INBOX_DOMAIN") || undefined });
      } finally {
        busy.delete(run.id);
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
