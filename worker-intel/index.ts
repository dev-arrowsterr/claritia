// claritia-intel: runs the fast jobs that need no browser (stitch now; lookups, signals and scores next).
// Several claim loops share one pool. SIGTERM lets running jobs finish (Fly gives 30 seconds).
//   DATABASE_URL=… SECRETS_KEY=… node worker-intel/index.ts

import { createServer } from "node:http";
import { hostname } from "node:os";
import pg from "pg";
import { jobLoop } from "../src/lib/jobs.ts";
import { deviceReset, stitch } from "./jobs/stitch.ts";
import { pgRpc } from "./rpc.ts";

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
const port = Number(process.env.PORT || 8080);
const health = (body: object) => createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))).listen(port, "0.0.0.0");

if (!process.env.DATABASE_URL) {
  log("not configured", { missing: ["DATABASE_URL"] });
  health({ ok: false, missing: ["DATABASE_URL"] });
  await new Promise(() => {});
}

const loops = Math.max(1, Number(process.env.CONCURRENCY || 4));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: loops + 2, statement_timeout: 30_000 });
const rpc = pgRpc(pool);
const handlers = { stitch: stitch(pool), device_reset: deviceReset(pool) };
const stop = new AbortController();
const worker = `intel-${hostname()}-${process.pid}`;

health({ ok: true, worker, kinds: Object.keys(handlers), loops });
log("intel started", { worker, loops, secrets: !!process.env.SECRETS_KEY });
const running = Array.from({ length: loops }, (_, i) => jobLoop({ rpc, worker: `${worker}-${i}`, handlers, leaseS: 120, idleMs: 1000, signal: stop.signal, log: (m) => log(m) }));

const shutdown = async (sig: string) => {
  log("stopping", { sig });
  stop.abort();
  await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, 25_000))]);
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
