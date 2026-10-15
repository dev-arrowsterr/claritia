// What the stitch job needs to know about a workspace: its own and partner domains, and the identify secrets.

import type pg from "pg";
import { unseal } from "../src/lib/seal.ts";
import type { Settings } from "../src/lib/identity/stitch.ts";

const cache = new Map<string, { s: Settings; at: number }>();

export async function settingsFor(pool: pg.Pool, workspaceId: string, now = Date.now()): Promise<Settings> {
  const hit = cache.get(workspaceId);
  if (hit && now - hit.at < 60_000) return hit.s;
  const r = await pool.query(`select own_domains, partner_domains, identify_secrets_sealed from identity_settings where workspace_id = $1`, [workspaceId]);
  const row = r.rows[0];
  let secrets: string[] = [];
  if (row?.identify_secrets_sealed && process.env.SECRETS_KEY) {
    try {
      const parsed = JSON.parse(unseal(row.identify_secrets_sealed));
      secrets = [parsed.current, parsed.next].filter((x): x is string => typeof x === "string" && x.length >= 32);
    } catch {}
  }
  const s: Settings = { own_domains: row?.own_domains ?? [], partner_domains: row?.partner_domains ?? [], secrets };
  cache.set(workspaceId, { s, at: now });
  return s;
}
