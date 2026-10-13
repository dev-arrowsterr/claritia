// The Claritia runner service. Takes waiting runs from the database, runs each in a fresh browser,
// writes step results as they happen, and uploads the video, trace, screenshots and console to storage.
//   node worker/index.ts
// Needs SUPABASE_URL, SUPABASE_SECRET_KEY and SECRETS_KEY. Answers health checks on PORT.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handleRun, type Run } from "./handle.ts";

const env = (k: string) => process.env[k]?.trim() ?? "";
const SLOTS = Math.max(1, Math.min(8, Number(env("WORKER_SLOTS") || 2)));
const WORKER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;
const IDLE_MS = 2000;
const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SECRETS_KEY"].filter((k) => !env(k));

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
const busy = new Set<string>();

// Health checks: Render needs a port to know the service is up.
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: !missing.length, missing, worker: WORKER_ID, slots: SLOTS, running: busy.size }));
}).listen(Number(env("PORT") || 10000));

if (missing.length) {
  log(`Waiting: add ${missing.join(", ")} to this service's environment.`);
} else {
  const sb = createClient(env("SUPABASE_URL").replace(/\/+$/, ""), env("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  log(`Runner ${WORKER_ID} started with ${SLOTS} slots.`);
  for (let i = 0; i < SLOTS; i++) void slot(sb, i);

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

async function slot(sb: SupabaseClient, n: number) {
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
        await handleRun(sb, run, { workerId: WORKER_ID, chromiumPath: env("CHROMIUM_PATH") || undefined, log });
      } finally {
        busy.delete(run.id);
      }
    } catch (e) {
      log(`Slot ${n}:`, e instanceof Error ? e.message : e);
      await sleep(5000);
    }
  }
}

