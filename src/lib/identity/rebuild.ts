// Rebuild (docs/identity.md 7.9): clear what stitching made for a workspace and replay every evidence row that isn't
// revoked, in arrival order. Undo works by revoking evidence and rebuilding. Old person ids get aliases to the new
// person holding most of their identifiers, so links and URLs keep working.

import { stitchOne, workspaceLock, type Pool, type Settings } from "./stitch.ts";

export const KIOSK_UNTIL = "9999-12-31T00:00:00Z";

export async function rebuildWorkspace(pool: Pool, ws: string, settings: Settings): Promise<{ replayed: number; aliased: number }> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await workspaceLock(c, ws, true);
    // Who held which identifiers before, for the aliases afterwards.
    const before = (await c.query(`select id, person_id from identifiers where workspace_id = $1 and person_id is not null`, [ws])).rows;
    const oldPersons = (await c.query(`select id from persons where workspace_id = $1 and merged_into is null`, [ws])).rows.map((r) => r.id as string);

    await c.query(`update identifiers set person_id = null where workspace_id = $1`, [ws]);
    await c.query(`delete from device_links where workspace_id = $1`, [ws]);
    await c.query(`delete from merge_proposals where workspace_id = $1 and status = 'open'`, [ws]);
    await c.query(`update sessions set person_id = null, person_level = null, person_source = null where workspace_id = $1`, [ws]);
    // Kiosks and opt-outs are people's choices, not stitching, so they stay.
    await c.query(
      `update devices set state = 'fresh', tainted_until = null, no_backfill = false
       where workspace_id = $1 and state <> 'opted_out' and coalesce(tainted_until, now()) < $2`,
      [ws, KIOSK_UNTIL],
    );
    await c.query(`update sessions set internal = false where workspace_id = $1 and internal and device_id in (select id from devices where workspace_id = $1 and state = 'fresh')`, [ws]);
    await c.query(`update identity_evidence set stitched_at = null, ignored = null where workspace_id = $1 and revoked_at is null`, [ws]);

    const rows = (
      await c.query(
        `select id, workspace_id, site_id, device_id, session_id, source, level, identifiers, hard_edge, extra, server_at
         from identity_evidence where workspace_id = $1 and revoked_at is null order by server_at, id`,
        [ws],
      )
    ).rows;
    // Unsigned rows are replayed as heard; a row's hard edge is worked out again.
    for (const e of rows) await stitchOne(c, { ...e, hard_edge: false } as Parameters<typeof stitchOne>[1], settings);

    // Old ids point to the new person with the most of their identifiers.
    const after = new Map((await c.query(`select id, person_id from identifiers where workspace_id = $1`, [ws])).rows.map((r) => [r.id, r.person_id]));
    const votes = new Map<string, Map<string, number>>();
    for (const r of before) {
      const now = after.get(r.id);
      if (!now) continue;
      const m = votes.get(r.person_id) ?? new Map<string, number>();
      m.set(now, (m.get(now) ?? 0) + 1);
      votes.set(r.person_id, m);
    }
    let aliased = 0;
    const live = new Set((await c.query(`select id from persons where workspace_id = $1 and merged_into is null`, [ws])).rows.map((r) => r.id as string));
    for (const old of oldPersons) {
      const best = [...(votes.get(old) ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
      if (!best || best === old || !live.has(best)) continue;
      await c.query(`update persons set merged_into = $2 where id = $1`, [old, best]);
      await c.query(`update person_aliases set new_id = $2 where new_id = $1`, [old, best]);
      await c.query(`insert into person_aliases (old_id, new_id, workspace_id) values ($1, $2, $3) on conflict (old_id) do update set new_id = excluded.new_id`, [old, best, ws]);
      aliased++;
    }
    // People left with nothing, and no alias pointing at them, go.
    await c.query(
      `delete from persons p where p.workspace_id = $1 and p.merged_into is null
         and not exists (select 1 from identifiers i where i.person_id = p.id)
         and not exists (select 1 from person_aliases a where a.new_id = p.id)`,
      [ws],
    );
    await c.query("commit");
    return { replayed: rows.length, aliased };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
