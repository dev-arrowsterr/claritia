// Everything collect reads and writes in Postgres. The interface lets tests swap in a fake store or a real local
// Postgres; PgStore is the live one.

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

export type Site = {
  id: string;
  workspace_id: string;
  domain: string;
  extra_domains: string[];
  proxy_secret: string;
  policy_overrides: { strict?: string[]; off?: string[] };
  private_paths: string[];
  url_param_allow: string[];
  city_level: boolean;
  honor_dnt: boolean;
  paused: boolean;
};

export type SessionRow = {
  id: string;
  workspace_id: string;
  site_id: string;
  device_id: string | null;
  cookieless_key: Buffer | null;
  started_at: Date;
  ended_at: Date;
  policy: string;
  consent: string;
  gpc: boolean;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: string;
  browser: string;
  os: string;
  landing_path: string | null;
  referrer_host: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  ref_class: string;
  ip_net: string | null;
  ip_kind: string | null;
  is_bot: boolean;
};

export type EventRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  day: string;
  kind: string;
  path: string | null;
  title: string | null;
  data: Record<string, unknown> | null;
  client_at: Date | null;
};

export type EvidenceRow = {
  id: string;
  workspace_id: string;
  site_id: string;
  device_id: string;
  session_id: string | null;
  source: string;
  level: "verified" | "asserted" | "inferred";
  identifiers: { kind: string; value: string }[];
  extra: Record<string, unknown>;
  server_at?: Date;
};

export type Prior = { id: string; startedAt: number; endedAt: number; campaign: string | null; pageviews: number };

export interface Store {
  siteByKey(key: string): Promise<Site | null>;
  priorSession(siteId: string, by: { deviceId?: string; ckey?: Buffer }): Promise<Prior | null>;
  isOptedOut(siteId: string, deviceId: string): Promise<boolean>;
  startSession(s: SessionRow, device: { id: string; consent: string } | null): Promise<void>;
  /** Inserts events once each (by id) and adds what was actually inserted to the sessions' counts. */
  writeEvents(rows: EventRow[]): Promise<void>;
  setBot(sessionId: string, bot: boolean): Promise<void>;
  touchSite(siteId: string, mode: string): Promise<void>;
  /** True the first time a hop nonce is seen. */
  useNonce(nonce: Buffer): Promise<boolean>;
  /** Today's cookieless salt. Made on first use; salts older than a day are deleted. */
  salt(day: string): Promise<Buffer>;
  optOut(site: Site, deviceId: string | null): Promise<void>;
  addEvidence(e: EvidenceRow): Promise<void>;
  enqueue(workspaceId: string, kind: string, key: string, payload: Record<string, unknown>): Promise<void>;
  ping(): Promise<void>;
}

export const deviceHash = (deviceId: string) => createHash("sha256").update(deviceId).digest();

export class PgStore implements Store {
  pool: pg.Pool;
  constructor(url: string, max = 10) {
    this.pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  }

  async siteByKey(key: string): Promise<Site | null> {
    const r = await this.pool.query(
      `select id, workspace_id, domain, extra_domains, proxy_secret, policy_overrides, private_paths, url_param_allow,
              city_level, honor_dnt, paused
       from sites where site_key = $1`,
      [key],
    );
    return r.rows[0] ?? null;
  }

  async priorSession(siteId: string, by: { deviceId?: string; ckey?: Buffer }): Promise<Prior | null> {
    const col = by.deviceId ? "device_id" : "cookieless_key";
    const r = await this.pool.query(
      `select id, started_at, ended_at, campaign, pageviews from sessions
       where site_id = $1 and ${col} = $2 and ended_at > now() - interval '30 minutes'
       order by started_at desc limit 1`,
      [siteId, by.deviceId ?? by.ckey],
    );
    const s = r.rows[0];
    return s ? { id: s.id, startedAt: +s.started_at, endedAt: +s.ended_at, campaign: s.campaign, pageviews: s.pageviews } : null;
  }

  async isOptedOut(siteId: string, deviceId: string): Promise<boolean> {
    const r = await this.pool.query(`select 1 from opt_outs where site_id = $1 and device_hash = $2`, [siteId, deviceHash(deviceId)]);
    return r.rowCount! > 0;
  }

  async startSession(s: SessionRow, device: { id: string; consent: string } | null): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      if (device) {
        await c.query(
          `insert into devices (id, workspace_id, site_id, consent, sessions) values ($1, $2, $3, $4, 1)
           on conflict (id) do update set last_seen = now(), sessions = devices.sessions + 1, consent = excluded.consent`,
          [device.id, s.workspace_id, s.site_id, device.consent],
        );
      }
      const cols = Object.keys(s) as (keyof SessionRow)[];
      await c.query(
        `insert into sessions (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (id) do nothing`,
        cols.map((k) => s[k]),
      );
      // A visit belongs to the person the device is linked to when it starts (docs/identity.md 7.6), and to their
      // work email's account; otherwise to its network's account, when one is known.
      await c.query(
        `update sessions s set person_id = dl.person_id, person_level = dl.level, person_source = 'live'
         from device_links dl
         where s.id = $1 and dl.device_id = s.device_id and dl.to_at is null and s.policy in ('strict', 'notice') and not s.internal`,
        [s.id],
      );
      await c.query(
        `update sessions s set account_id = coalesce(p.account_id, n.account_id), account_source = case when p.account_id is not null then 'email' else n.source end,
                network_account_id = n.account_id
         from (select 1) one
         left join lateral (
           select ad.account_id from identifiers i join account_domains ad on ad.workspace_id = i.workspace_id and ad.domain = i.domain
           where i.workspace_id = $2 and i.person_id = (select person_id from sessions where id = $1) and i.kind = 'email' and i.class = 'work'
           order by i.created_at limit 1
         ) p on true
         left join lateral (
           select account_id, 'learned_network' as source from learned_networks where workspace_id = $2 and net = (select ip_net from sessions where id = $1) and account_id is not null
           union all
           select ad.account_id, 'vendor_network' from ip_cache ic join account_domains ad on ad.workspace_id = $2 and ad.domain = ic.domain
           where ic.net = (select ip_net from sessions where id = $1) and ic.kind in ('business', 'education', 'government') and ic.confidence >= 70
             and ic.fetched_at > now() - interval '30 days'
           limit 1
         ) n on true
         where s.id = $1 and not s.internal and (p.account_id is not null or n.account_id is not null)`,
        [s.id, s.workspace_id],
      );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async writeEvents(rows: EventRow[]): Promise<void> {
    if (!rows.length) return;
    const col = <K extends keyof EventRow>(k: K) => rows.map((r) => r[k]);
    const params = [
      col("id"),
      col("workspace_id"),
      col("session_id"),
      col("day"),
      col("kind"),
      col("path"),
      col("title"),
      rows.map((r) => (r.data ? JSON.stringify(r.data) : null)),
      col("client_at"),
    ];
    // A session split by the stitch job (split_to) takes the events collect still sends to its old id.
    const sql = `with v as (
        select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::date[], $5::text[], $6::text[], $7::text[], $8::jsonb[], $9::timestamptz[])
          as v(id, workspace_id, session_id, day, kind, path, title, data, client_at)
      ), ins as (
        insert into events (id, workspace_id, session_id, day, kind, path, title, data, client_at)
        select v.id, v.workspace_id, coalesce(s.split_to, v.session_id), v.day, v.kind, v.path, v.title, v.data, v.client_at
        from v left join sessions s on s.id = v.session_id
        on conflict do nothing
        returning session_id, kind, data, server_at
      )
      update sessions s set
        pageviews = s.pageviews + a.views,
        engaged_s = s.engaged_s + a.engaged,
        ended_at = greatest(s.ended_at, a.last)
      from (
        select session_id, count(*) filter (where kind = 'view') as views,
               coalesce(sum(least(greatest((data->>'active_s')::int, 0), 3600)) filter (where kind = 'engage'), 0) as engaged,
               max(server_at) as last
        from ins group by session_id
      ) a
      where s.id = a.session_id`;
    try {
      await this.pool.query(sql, params);
    } catch (e) {
      // A day with no table yet (clock skew around midnight, or the daily job late): make tables and try once more.
      if ((e as { code?: string }).code === "23514" && /no partition/i.test(String((e as Error).message))) {
        await this.pool.query("select public.make_event_partitions(7)");
        await this.pool.query(sql, params);
      } else throw e;
    }
  }

  async setBot(sessionId: string, bot: boolean): Promise<void> {
    await this.pool.query(`update sessions set is_bot = $2 where id = $1`, [sessionId, bot]);
  }

  async touchSite(siteId: string, mode: string): Promise<void> {
    await this.pool.query(`update sites set last_event_at = now(), install_mode = $2 where id = $1`, [siteId, mode]);
  }

  async useNonce(nonce: Buffer): Promise<boolean> {
    const r = await this.pool.query(`insert into hop_nonces (nonce) values ($1) on conflict do nothing`, [nonce]);
    return r.rowCount === 1;
  }

  async salt(day: string): Promise<Buffer> {
    await this.pool.query(`insert into salts (day, salt) values ($1, $2) on conflict do nothing`, [day, randomBytes(32)]);
    await this.pool.query(`delete from salts where day < $1::date - 1`, [day]);
    const r = await this.pool.query(`select salt from salts where day = $1`, [day]);
    return r.rows[0].salt;
  }

  async optOut(site: Site, deviceId: string | null): Promise<void> {
    if (!deviceId) return;
    await this.pool.query(`insert into opt_outs (site_id, device_hash) values ($1, $2) on conflict do nothing`, [site.id, deviceHash(deviceId)]);
    await this.pool.query(`update devices set state = 'opted_out', state_since = now() where id = $1 and site_id = $2`, [deviceId, site.id]);
  }

  async addEvidence(e: EvidenceRow): Promise<void> {
    await this.pool.query(
      `insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers, extra, server_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now())) on conflict do nothing`,
      [e.id, e.workspace_id, e.site_id, e.device_id, e.session_id, e.source, e.level, JSON.stringify(e.identifiers), JSON.stringify(e.extra), e.server_at ?? null],
    );
  }

  async enqueue(workspaceId: string, kind: string, key: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(`select public.enqueue_job($1, $2, $3, $4)`, [workspaceId, kind, key, JSON.stringify(payload)]);
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }
}
