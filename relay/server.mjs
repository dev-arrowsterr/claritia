// The relay service on Fly: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) and RELAY_SECRET (the
// same value the runner has). Checks API keys and records tunnels through the database's REST API.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRelay } from "./relay.mjs";

const env = (k) => process.env[k]?.trim() ?? "";
const url = env("SUPABASE_URL").replace(/\/+$/, "");
const key = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const secret = env("RELAY_SECRET");
const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY", secret.length < 32 && "RELAY_SECRET (32+ characters)"].filter(Boolean);
if (missing.length) {
  // Wait, answering 503, until the secrets are set, so a first deploy doesn't fail.
  console.error(`Waiting: add ${missing.join(", ")} to the relay's secrets.`);
  createServer((_req, res) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, missing }))).listen(
    Number(process.env.PORT || 8080),
  );
} else {
  start();
}

function start() {
  const rest = async (path, init = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  const relay = createRelay({
    secret,
    log,
    verifyKey: async (apiKey) => {
      if (!/^clr_[A-Za-z0-9_-]{40}$/.test(apiKey)) return null;
      const rows = await rest("rpc/api_key_auth", { method: "POST", body: JSON.stringify({ p_hash: createHash("sha256").update(apiKey).digest("hex") }) });
      const row = rows?.[0];
      return row ? { workspaceId: row.workspace_id, keyId: row.key_id } : null;
    },
    saveTunnel: async ({ workspaceId, keyId, ports }) =>
      (await rest("tunnels", { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, api_key_id: keyId, ports }) }))[0].id,
    touchTunnel: async (id) => void (await rest(`tunnels?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString() }) })),
    closeTunnel: async (id) =>
      void (await rest(`tunnels?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ disconnected_at: new Date().toISOString() }) })),
  });
  relay.server.listen(Number(env("PORT") || 8080), () => log("Relay listening."));
}
