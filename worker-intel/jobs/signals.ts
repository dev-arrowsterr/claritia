// Signals and scores (docs/m1-website-intelligence.md 7.4, 7.5). A sweep finds visits with an account that went
// quiet (or grew since the last look) and saves their signals; score_account turns an account's signals into its
// scores. Both can run twice with the same result.

import type pg from "pg";
import { JobError, type Handler } from "../../src/lib/jobs.ts";
import { fitV0, intentOf, priorityOf, rawIntent, SCORE_VERSION, stageOf, temperatureOf, whyNow, type Icp, type ScoredSignal, type Stage } from "../../src/lib/web/scores.ts";
import { accountSignals, DEFAULT_SIGNALS, visitSignals, type PageGroup, type Signal } from "../../src/lib/web/signals.ts";

const QUIET_MS = 2 * 60_000;

async function types(pool: pg.Pool, ws: string) {
  const r = await pool.query(`select kind, weight::float, half_life_days::float, enabled from signal_types where workspace_id = $1`, [ws]);
  const out = { ...DEFAULT_SIGNALS } as Record<string, { weight: number; half_life_days: number; enabled?: boolean }>;
  for (const t of r.rows) out[t.kind] = { weight: t.weight, half_life_days: t.half_life_days, enabled: t.enabled };
  return out;
}

/** Signals for one visit. Returns the account to rescore, or null. */
export async function signalVisit(pool: pg.Pool, sessionId: string): Promise<{ workspace: string; account: string } | null> {
  const s = (
    await pool.query(
      `select s.id, s.workspace_id, s.site_id, s.account_id, s.person_id, s.person_level, s.ref_class, s.referrer_host, s.started_at, s.internal, s.is_bot,
              d.state as device_state, p.partner
       from sessions s left join devices d on d.id = s.device_id left join persons p on p.id = s.person_id
       where s.id = $1`,
      [sessionId],
    )
  ).rows[0];
  if (!s) return null;
  await pool.query(`update sessions set signaled_at = now() where id = $1`, [sessionId]);
  // Internal, bot, partner and tainted devices make no signals (7.6).
  if (!s.account_id || s.internal || s.is_bot || s.partner || s.device_state === "tainted" || s.device_state === "internal") return null;
  const ws = s.workspace_id as string;
  const events = (await pool.query(`select kind, path, data, server_at from events where session_id = $1 order by server_at`, [sessionId])).rows;
  const groups = (await pool.query(`select pattern, grp, competitor from page_groups where site_id = $1`, [s.site_id])).rows as PageGroup[];
  const at = +s.started_at;
  const found: Signal[] = visitSignals(s.account_id, {
    id: s.id, startedAt: at, personId: s.person_id, personLevel: s.person_level, refClass: s.ref_class, referrerHost: s.referrer_host,
    events: events.map((e) => ({ kind: e.kind, path: e.path, at: +e.server_at, data: e.data })),
  }, groups);
  const history = (
    await pool.query(
      `select
         (select max(started_at) from sessions where workspace_id = $1 and account_id = $2 and not internal and not is_bot and started_at < $3) as last_before,
         (select count(distinct coalesce(person_id::text, device_id::text)) from sessions
           where workspace_id = $1 and account_id = $2 and not internal and not is_bot and started_at > $3::timestamptz - interval '7 days' and started_at <= $3) as people,
         (select not exists (select 1 from sessions where workspace_id = $1 and account_id = $2 and person_id = $4 and started_at < $3)) as first_person`,
      [ws, s.account_id, s.started_at, s.person_id],
    )
  ).rows[0];
  found.push(...accountSignals(s.account_id, {
    visitAt: at,
    lastBefore: history.last_before ? +history.last_before : null,
    peopleThisWeek: Number(history.people) || 0,
    personId: s.person_id && s.person_level !== "probable" ? s.person_id : null,
    firstSeenPerson: !!history.first_person,
  }));
  const t = await types(pool, ws);
  let added = 0;
  for (const sig of found) {
    const type = t[sig.kind];
    if (!type || type.enabled === false) continue;
    const r = await pool.query(
      `insert into signals (workspace_id, account_id, person_id, kind, weight, at, dedupe_key, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (workspace_id, dedupe_key) do nothing`,
      [ws, s.account_id, sig.person_id, sig.kind, type.weight, new Date(sig.at), sig.dedupe_key, JSON.stringify(sig.evidence)],
    );
    added += r.rowCount ?? 0;
  }
  if (added) await pool.query(`update accounts set last_signal_at = greatest(coalesce(last_signal_at, 'epoch'), now()) where id = $1`, [s.account_id]);
  return added ? { workspace: ws, account: s.account_id } : null;
}

/** One pass of the sweep: quiet visits with an account that weren't checked since they last grew. */
export async function sweepSignals(pool: pg.Pool, limit = 200): Promise<number> {
  const due = (
    await pool.query(
      `select id from sessions
       where account_id is not null and not internal and not is_bot and ended_at < now() - make_interval(secs => $2)
         and (signaled_at is null or signaled_at < ended_at)
       order by ended_at limit $1`,
      [limit, QUIET_MS / 1000],
    )
  ).rows;
  for (const r of due) {
    const hit = await signalVisit(pool, r.id);
    if (hit) await pool.query(`select enqueue_job($1, 'score_account', $2, $3, 60)`, [hit.workspace, hit.account, JSON.stringify({ account_id: hit.account })]);
  }
  return due.length;
}

/** score_account: fit, intent, stage, temperature, priority and why-now, saved on the account and in history. */
export const scoreAccount = (pool: pg.Pool, now: () => number = Date.now): Handler => async (job) => {
  const id = String(job.payload.account_id ?? job.key ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new JobError("score_account needs an account", { retry: false });
  const a = (await pool.query(`select id, workspace_id, firmo, stage, owner_user_id from accounts where id = $1`, [id])).rows[0];
  if (!a) return;
  const t = await types(pool, a.workspace_id);
  const sigs: ScoredSignal[] = (
    await pool.query(`select kind, weight::float, at, person_id from signals where account_id = $1 and at > now() - interval '90 days'`, [id])
  ).rows.map((r) => ({ kind: r.kind, weight: r.weight, half_life_days: t[r.kind]?.half_life_days ?? 14, at: +r.at, person_id: r.person_id }));
  const icp = (await pool.query(`select rules from icp where workspace_id = $1`, [a.workspace_id])).rows[0]?.rules as Icp | undefined;
  const k = Number((await pool.query(`select k from intent_params where workspace_id = $1`, [a.workspace_id])).rows[0]?.k ?? 60);
  const at = now();
  const fit = fitV0(a.firmo, icp ?? null);
  const intent = intentOf(rawIntent(sigs, at), k);
  const stage: Stage = stageOf(sigs, at, a.stage ?? null);
  const temperature = temperatureOf(sigs, at, intent);
  const priority = priorityOf(intent, fit, stage, !!a.owner_user_id);
  const why = whyNow(sigs, at);
  await pool.query(
    `update accounts set fit = $2, intent = $3, stage = $4, stage_since = case when stage is distinct from $4 then now() else stage_since end,
       temperature = $5, priority = $6, why_now = $7 where id = $1`,
    [id, fit, intent, stage, temperature, priority, why.text || null],
  );
  await pool.query(
    `insert into account_scores (account_id, workspace_id, fit, intent, priority, stage, temperature, why_now, score_version) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, a.workspace_id, fit, intent, priority, stage, temperature, JSON.stringify(why.top), SCORE_VERSION],
  );
};
