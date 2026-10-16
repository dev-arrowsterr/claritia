// Sending on claritia-intel (docs/conversion-weeks.md week 9, supabase/migrations/039_email.sql).
//   send: one workspace at a time. Each second it claims up to the workspace's rate, renders and hands each
//         message to SES, and records the answer. Runs about 50 seconds, then queues the next round if more wait.
//   domain_check: makes the SES identity and MAIL FROM if needed, then checks every DNS record.
//   domain_remove: deletes a removed domain's SES identity, unless it was added again.

import type pg from "pg";
import { checkRecords, systemResolver, type DomainRow, type Resolver } from "../../src/lib/email/domains.ts";
import { renderMessage, type Claimed } from "../../src/lib/email/render.ts";
import { SesError, type Ses } from "../../src/lib/email/ses.ts";
import { JobError, type Handler, type Rpc } from "../../src/lib/jobs.ts";

const NOT_SET = "Amazon SES isn't set up on the worker (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).";

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export type SendOpts = { ses: Ses | null; base: string; secret?: string; roundMs?: number; sleep?: (ms: number) => Promise<void> };

export const send =
  (rpc: Rpc, o: SendOpts): Handler =>
  async (job, signal) => {
    const ws = job.workspace_id;
    if (!ws) throw new JobError("send needs a workspace", { retry: false });
    if (!o.ses) throw new JobError(NOT_SET, { retry: false });
    const ses = o.ses;
    const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const until = Date.now() + (o.roundMs ?? 50_000);
    let limit = 14;
    while (!signal.aborted) {
      if (Date.now() >= until) {
        await call(rpc, "enqueue_job", { p_workspace: ws, p_kind: "send", p_key: ws, p_payload: {}, p_delay_s: 0, p_max_attempts: 3 });
        return;
      }
      const started = Date.now();
      const batch = await call<Claimed[]>(rpc, "send_claim", { p_ws: ws, p_limit: limit });
      if (!batch?.length) return;
      limit = batch[0].per_second || limit;
      // A failure to record SES's answer leaves the message 'sending'; send_claim turns it 'unknown', never resent.
      await Promise.all(
        batch.map(async (m) => {
          let outcome: "ok" | "retry" | "unknown" | "failed" = "ok";
          let sesId: string | null = null;
          let error: string | null = null;
          try {
            sesId = await ses.send(renderMessage(m, { base: o.base, secret: o.secret }));
          } catch (e) {
            const se = e instanceof SesError ? e : null;
            outcome = se?.unknown ? "unknown" : se?.retry ? "retry" : "failed";
            error = (e as Error).message;
          }
          await call(rpc, "send_done", { p_id: m.id, p_outcome: outcome, p_ses_id: sesId, p_error: error });
        }),
      );
      const wait = 1000 - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  };

export const domainCheck =
  (rpc: Rpc, ses: Ses | null, resolver: Resolver = systemResolver): Handler =>
  async (job) => {
    const id = String(job.payload.domain_id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new JobError("domain_check needs a domain", { retry: false });
    const d = await call<DomainRow | null>(rpc, "sending_domain_load", { p_id: id });
    if (!d) return;
    if (!ses) {
      await call(rpc, "sending_domain_update", { p_id: id, p_dkim: null, p_records: null, p_status: "pending", p_error: NOT_SET });
      return;
    }
    let identity;
    try {
      identity = await ses.getIdentity(d.domain);
      if (!identity) identity = await ses.createIdentity(d.domain);
      if (identity.mailFrom !== d.mail_from) {
        await ses.putMailFrom(d.domain, d.mail_from);
        identity = { ...identity, mailFrom: d.mail_from, mailFromStatus: "PENDING" };
      }
    } catch (e) {
      // Show SES's answer on the domain, then let the queue try again.
      await call(rpc, "sending_domain_update", { p_id: id, p_dkim: null, p_records: null, p_status: "pending", p_error: (e as Error).message });
      throw e;
    }
    const { records, status } = await checkRecords(d, identity, ses.region, resolver);
    await call(rpc, "sending_domain_update", {
      p_id: id,
      p_dkim: identity.dkimTokens.length ? identity.dkimTokens : null,
      p_records: records,
      p_status: status,
      p_error: status === "failed" ? "SES couldn't find the DKIM records. Check them, then press Check." : null,
    });
  };

export const domainRemove =
  (pool: pg.Pool, ses: Ses | null): Handler =>
  async (job) => {
    const domain = String(job.payload.domain ?? "");
    if (!domain) throw new JobError("domain_remove needs a domain", { retry: false });
    if (!ses) return;
    const again = await pool.query(`select 1 from sending_domains where domain = $1`, [domain]);
    if (again.rowCount) return;
    await ses.deleteIdentity(domain);
  };
