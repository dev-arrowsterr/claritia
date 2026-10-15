import type pg from "pg";
import { JobError, type Handler } from "../../src/lib/jobs.ts";
import { stitchDevice } from "../../src/lib/identity/stitch.ts";
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
