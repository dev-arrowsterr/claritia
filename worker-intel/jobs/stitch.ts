import type pg from "pg";
import { JobError, type Handler } from "../../src/lib/jobs.ts";
import { erasePerson, exportPerson } from "../../src/lib/identity/erase.ts";
import { rebuildWorkspace } from "../../src/lib/identity/rebuild.ts";
import { stitchDevice, stitchOne, workspaceLock } from "../../src/lib/identity/stitch.ts";
import { settingsFor } from "../settings.ts";

/** stitch: every waiting evidence row for one device (the job key). */
export const stitch = (pool: pg.Pool): Handler => async (job) => {
  const device = String(job.payload.device_id ?? job.key ?? "");
  if (!job.workspace_id || !/^[0-9a-f-]{36}$/.test(device)) throw new JobError("stitch needs a workspace and a device", { retry: false });
  await stitchDevice(pool, job.workspace_id, device, await settingsFor(pool, job.workspace_id));
};

/** device_reset: claritia.reset() on the site. The old device's open link closes at that moment (docs/identity.md 4.5). */
export const deviceReset = (pool: pg.Pool): Handler => async (job) => {
  const device = String(job.payload.device_id ?? job.key ?? "");
  const at = typeof job.payload.at === "string" ? new Date(job.payload.at) : new Date();
  if (!job.workspace_id || !/^[0-9a-f-]{36}$/.test(device) || isNaN(+at)) throw new JobError("device_reset needs a workspace and a device", { retry: false });
  await pool.query(`update device_links set to_at = $3 where workspace_id = $1 and device_id = $2 and to_at is null and from_at <= $3`, [job.workspace_id, device, at]);
};

/** rebuild: replay the workspace's evidence after an undo (the job key is the workspace, so undos coalesce). */
export const rebuild = (pool: pg.Pool): Handler => async (job) => {
  if (!job.workspace_id) throw new JobError("rebuild needs a workspace", { retry: false });
  await rebuildWorkspace(pool, job.workspace_id, await settingsFor(pool, job.workspace_id));
};

/** stitch_evidence: one row with no device, such as an approved merge. */
export const stitchEvidence = (pool: pg.Pool): Handler => async (job) => {
  const id = String(job.payload.evidence_id ?? "");
  if (!job.workspace_id || !/^[0-9a-f-]{36}$/.test(id)) throw new JobError("stitch_evidence needs an evidence id", { retry: false });
  const settings = await settingsFor(pool, job.workspace_id);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await workspaceLock(c, job.workspace_id);
    const e = (
      await c.query(
        `select id, workspace_id, site_id, device_id, session_id, source, level, identifiers, hard_edge, extra, server_at
         from identity_evidence where workspace_id = $1 and id = $2 and stitched_at is null and revoked_at is null`,
        [job.workspace_id, id],
      )
    ).rows[0];
    if (e) await stitchOne(c, e, settings);
    await c.query("commit");
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
};

/** privacy: an erasure or an export asked for by an owner. */
export const privacy = (pool: pg.Pool): Handler => async (job) => {
  const { request_id, person_id, kind } = job.payload as { request_id?: string; person_id?: string; kind?: string };
  if (!job.workspace_id || !request_id || !person_id || (kind !== "erase" && kind !== "export")) throw new JobError("privacy needs a request", { retry: false });
  const done = (counts: object, error: string | null = null) =>
    pool.query(`update privacy_requests set status = $3, counts = $4, error = $5, finished_at = now() where id = $1 and workspace_id = $2`, [
      request_id, job.workspace_id, error ? "failed" : "done", JSON.stringify(counts), error,
    ]);
  try {
    if (kind === "erase") {
      await done(await erasePerson(pool, job.workspace_id, person_id));
    } else {
      const data = await exportPerson(pool, job.workspace_id, person_id);
      await pool.query(`insert into privacy_exports (request_id, workspace_id, data) values ($1, $2, $3) on conflict (request_id) do update set data = excluded.data`, [
        request_id, job.workspace_id, JSON.stringify(data),
      ]);
      await done({ identifiers: data.identifiers.length, sessions: data.sessions.length, evidence: data.evidence.length });
    }
  } catch (e) {
    if ((e as Error).message === "Person not found") {
      await done({}, "Person not found");
      return;
    }
    throw e;
  }
};
