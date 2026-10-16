// claritia-collect: starts the routes on PORT, flushes the write buffer every second, and on SIGTERM stops taking
// requests, writes everything waiting and exits (Fly gives 30 seconds).
//   DATABASE_URL=… CLR_ID_SECRET=… node collect/server.ts

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { WriteBuffer } from "./buffer.ts";
import { ipinfoGeo, openGeo } from "./geo.ts";
import { PgStore } from "./store.ts";

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
const port = Number(process.env.PORT || 8080);

// Until the secrets are set, stay up and say so, and answer 503 to everything else. The script won't load, so
// sites that already have the tag send nothing.
const missing = ["DATABASE_URL", "CLR_ID_SECRET"].filter((k) => !process.env[k]);
if ((process.env.CLR_ID_SECRET ?? "x".repeat(32)).length < 32) missing.push("CLR_ID_SECRET (32+ characters)");
if (missing.length) {
  log("not configured", { missing });
  serve({
    port,
    hostname: "0.0.0.0",
    fetch: (req) =>
      new URL(req.url).pathname === "/health"
        ? Response.json({ ok: false, missing })
        : new Response(null, { status: 503, headers: { "Retry-After": "300" } }),
  });
  await new Promise(() => {});
}

const store = new PgStore(process.env.DATABASE_URL!, Number(process.env.DB_POOL || 10));
const secret = process.env.CLR_ID_SECRET!;
const geo = process.env.IPINFO_TOKEN
  ? await ipinfoGeo({ token: process.env.IPINFO_TOKEN, path: process.env.GEO_DB_PATH || "/tmp/ipinfo_lite.mmdb", log })
  : await openGeo(process.env.GEO_DB_PATH);
let script: { code: string; tag: string } | undefined;
try {
  const dist = new URL("./dist/", import.meta.url);
  const { tag } = JSON.parse(readFileSync(new URL("version.json", dist), "utf8"));
  script = { code: readFileSync(new URL("s.js", dist), "utf8"), tag };
} catch {
  log("no built script; run npm run build:script");
}

const buffer = new WriteBuffer(store, { log });
const devOrigins = process.env.DEV_ORIGINS ? process.env.DEV_ORIGINS.split(",") : undefined;
// Company matches by IP need CLR_IP_SECRET here and on claritia-intel (the same value, 32+ characters).
const ipSecret = (process.env.CLR_IP_SECRET ?? "").length >= 32 ? process.env.CLR_IP_SECRET : undefined;
if (!ipSecret) log("no CLR_IP_SECRET (32+ characters): company matches by IP are off");
const { app } = createApp({ store, secret, ipSecret, geo, script, buffer, log, devOrigins });
buffer.start();

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => log("collect listening", { port, geo: !!(process.env.IPINFO_TOKEN || process.env.GEO_DB_PATH), script: script?.tag }));

let stopping = false;
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log("stopping", { sig, waiting: buffer.size });
  server.close();
  const left = await buffer.close(25_000);
  log("stopped", { left });
  await store.pool.end().catch(() => {});
  process.exit(left ? 1 : 0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
