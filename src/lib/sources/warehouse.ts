// Warehouses and databases as sources (docs/contact-sources.md Part 8): Postgres, Redshift, MySQL, ClickHouse,
// BigQuery, Snowflake and Databricks behind one runner. A source is one saved query. It must be a single SELECT;
// `:cursor` is bound by the driver (never pasted into the SQL); it runs read-only where the database allows,
// with a 120-second limit, 5,000 rows a page, ordered by the cursor column, and the next run reads on from the
// last cursor. Hosts on private networks are refused.

import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import pg from "pg";
import { hostIsPrivate } from "../privateNet.ts";
import type { Connector, Ctx, ObjectKind, Page, RawRecord, SourceRow } from "./types.ts";

import { bindCursor, queryError, START_CURSOR, type WhQuery } from "./sql.ts";

export { START_CURSOR, type WhQuery } from "./sql.ts";
export const PAGE = 5000;
const TIMEOUT_MS = 120_000;
type Result = { columns: string[]; rows: Record<string, unknown>[] };

const wrap = (sql: string, cursor: string, limit: number) => `select * from (${sql.trim().replace(/;\s*$/, "")}) q order by ${cursor} limit ${limit}`;

const plain = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("base64") : v);
const rowsOf = (columns: string[], arrays: unknown[][]) => arrays.map((a) => Object.fromEntries(columns.map((c, i) => [c, plain(a[i])])));

// Runners ----------------------------------------------------------------------------------------------------

async function guard(ctx: Ctx, host: string) {
  if (ctx.local) return;
  if (!host || (await hostIsPrivate(host))) throw new Error("That host is on a private network. Use the database's public address.");
}

async function runPg(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  const host = ctx.secret("host");
  await guard(ctx, host);
  const ssl = ctx.local && ctx.secret("ssl") === "disable" ? false : { rejectUnauthorized: ctx.secret("ssl") !== "require" };
  const client = new pg.Client({ host, port: Number(ctx.secret("port") || 5432), database: ctx.secret("database"), user: ctx.secret("user"), password: ctx.secret("password"), ssl, connectionTimeoutMillis: 10_000, query_timeout: TIMEOUT_MS + 5_000 });
  await client.connect();
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${TIMEOUT_MS}`);
    const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => "$1");
    const r = await client.query({ text: b.sql, values: b.count ? [cursor] : [], rowMode: "array" });
    return { columns: r.fields.map((f) => f.name), rows: rowsOf(r.fields.map((f) => f.name), r.rows as unknown[][]) };
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runMysql(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  const host = ctx.secret("host");
  await guard(ctx, host);
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    host,
    port: Number(ctx.secret("port") || 3306),
    database: ctx.secret("database"),
    user: ctx.secret("user"),
    password: ctx.secret("password"),
    ssl: ctx.local && ctx.secret("ssl") === "disable" ? undefined : { rejectUnauthorized: ctx.secret("ssl") !== "require" },
    connectTimeout: 10_000,
    dateStrings: false,
  });
  try {
    await conn.query(`set session max_execution_time = ${TIMEOUT_MS}`);
    await conn.query("start transaction read only");
    const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => "?");
    const [rows, fields] = await conn.query({ sql: b.sql, values: Array(b.count).fill(cursor), rowsAsArray: true, timeout: TIMEOUT_MS });
    const columns = (fields as { name: string }[]).map((f) => f.name);
    return { columns, rows: rowsOf(columns, rows as unknown[][]) };
  } finally {
    await conn.query("rollback").catch(() => {});
    await conn.end().catch(() => {});
  }
}

async function runClickhouse(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  const base = ctx.secret("url").replace(/\/+$/, "");
  const u = new URL(base);
  if (u.protocol !== "https:" && !ctx.local) throw new Error("Use the https address.");
  await guard(ctx, u.hostname);
  const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => "{cursor:String}");
  const q = new URLSearchParams({ readonly: "1", max_execution_time: String(TIMEOUT_MS / 1000), default_format: "JSONCompact", ...(b.count ? { param_cursor: cursor } : {}) });
  const d = await ctx.api<{ meta: { name: string }[]; data: unknown[][] }>(`${base}/?${q}`, {
    method: "POST",
    auth: false,
    headers: { "x-clickhouse-user": ctx.secret("user"), "x-clickhouse-key": ctx.secret("password"), "content-type": "text/plain" },
    body: b.sql,
  });
  const columns = d.meta.map((m) => m.name);
  return { columns, rows: rowsOf(columns, d.data) };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function jwt(header: object, claims: object, key: string) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${head}.${b64url(createSign("RSA-SHA256").update(head).sign(createPrivateKey(key)))}`;
}

async function runBigquery(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  let sa: { client_email: string; private_key: string; project_id: string };
  try {
    sa = JSON.parse(ctx.secret("service_account"));
  } catch {
    throw new Error("Paste the service account's JSON key.");
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt({ alg: "RS256", typ: "JWT" }, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/bigquery", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, sa.private_key);
  const tok = await ctx.api<{ access_token: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    auth: false,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => "@cursor");
  const project = ctx.secret("project") || sa.project_id;
  type BqOut = { jobComplete: boolean; jobReference?: { jobId: string; location?: string }; schema?: { fields: { name: string }[] }; rows?: { f: { v: unknown }[] }[] };
  let d = await ctx.api<BqOut>(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`, {
    method: "POST",
    auth: false,
    headers: { authorization: `Bearer ${tok.access_token}` },
    body: JSON.stringify({
      query: b.sql,
      useLegacySql: false,
      timeoutMs: 60_000,
      maxResults: limit,
      ...(b.count ? { parameterMode: "NAMED", queryParameters: [{ name: "cursor", parameterType: { type: "STRING" }, parameterValue: { value: cursor } }] } : {}),
      ...(ctx.secret("location") ? { location: ctx.secret("location") } : {}),
    }),
  });
  const start = Date.now();
  while (!d.jobComplete && d.jobReference && Date.now() - start < TIMEOUT_MS) {
    const loc = d.jobReference.location ? `&location=${encodeURIComponent(d.jobReference.location)}` : "";
    d = await ctx.api<BqOut>(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries/${d.jobReference.jobId}?timeoutMs=30000&maxResults=${limit}${loc}`, {
      auth: false,
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
  }
  if (!d.jobComplete) throw new Error("The query took over 2 minutes.");
  const columns = (d.schema?.fields ?? []).map((f) => f.name);
  return { columns, rows: rowsOf(columns, (d.rows ?? []).map((r) => r.f.map((c) => c.v))) };
}

/** Snowflake key-pair auth: a JWT signed by the user's private key, named by its public key's fingerprint. */
export function snowflakeJwt(account: string, user: string, privateKey: string, now = Math.floor(Date.now() / 1000)) {
  const acct = account.toUpperCase().replace(/\.global$/i, "").split(".")[0];
  const der = createPublicKey(createPrivateKey(privateKey)).export({ type: "spki", format: "der" });
  const fp = `SHA256:${createHash("sha256").update(der).digest("base64")}`;
  const u = user.toUpperCase();
  return jwt({ alg: "RS256", typ: "JWT" }, { iss: `${acct}.${u}.${fp}`, sub: `${acct}.${u}`, iat: now, exp: now + 3540 }, privateKey);
}

async function runSnowflake(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  const account = ctx.secret("account").trim();
  if (!/^[A-Za-z0-9_.-]{3,100}$/.test(account)) throw new Error("Enter the account identifier, like myorg-myaccount.");
  const base = `https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`;
  const headers = { authorization: `Bearer ${snowflakeJwt(account, ctx.secret("user"), ctx.secret("private_key"))}`, "x-snowflake-authorization-token-type": "KEYPAIR_JWT" };
  const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => "?");
  const bindings: Record<string, { type: string; value: string }> = {};
  for (let i = 1; i <= b.count; i++) bindings[String(i)] = { type: "TEXT", value: cursor };
  type SfOut = { statementHandle: string; resultSetMetaData?: { rowType: { name: string }[] }; data?: unknown[][]; message?: string };
  let d = await ctx.api<SfOut>(`${base}?async=false`, {
    method: "POST",
    auth: false,
    headers,
    body: JSON.stringify({ statement: b.sql, timeout: TIMEOUT_MS / 1000, warehouse: ctx.secret("warehouse") || undefined, database: ctx.secret("database") || undefined, role: ctx.secret("role") || undefined, bindings }),
  });
  const start = Date.now();
  while (!d.resultSetMetaData && d.statementHandle && Date.now() - start < TIMEOUT_MS) {
    d = await ctx.api<SfOut>(`${base}/${d.statementHandle}`, { auth: false, headers });
  }
  const columns = (d.resultSetMetaData?.rowType ?? []).map((r) => r.name);
  return { columns, rows: rowsOf(columns, d.data ?? []) };
}

async function runDatabricks(ctx: Ctx, sql: string, cursor: string, limit: number): Promise<Result> {
  const host = ctx.secret("host").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/i.test(host)) throw new Error("Enter the workspace address, like dbc-123.cloud.databricks.com.");
  const b = bindCursor(wrap(sql, ctx.query?.cursor ?? "1", limit), () => ":cursor");
  type DbOut = { statement_id: string; status: { state: string; error?: { message: string } }; manifest?: { schema: { columns: { name: string }[] } }; result?: { data_array?: unknown[][] } };
  const headers = { authorization: `Bearer ${ctx.secret("token")}` };
  let d = await ctx.api<DbOut>(`https://${host}/api/2.0/sql/statements`, {
    method: "POST",
    auth: false,
    headers,
    body: JSON.stringify({
      statement: b.sql,
      warehouse_id: ctx.secret("warehouse_id"),
      wait_timeout: "50s",
      on_wait_timeout: "CONTINUE",
      format: "JSON_ARRAY",
      disposition: "INLINE",
      row_limit: limit,
      ...(b.count ? { parameters: [{ name: "cursor", value: cursor, type: "STRING" }] } : {}),
    }),
  });
  const start = Date.now();
  while (["PENDING", "RUNNING"].includes(d.status.state) && Date.now() - start < TIMEOUT_MS) d = await ctx.api<DbOut>(`https://${host}/api/2.0/sql/statements/${d.statement_id}`, { auth: false, headers });
  if (d.status.state !== "SUCCEEDED") throw new Error(d.status.error?.message ?? `The query ${d.status.state.toLowerCase()}.`);
  const columns = (d.manifest?.schema.columns ?? []).map((c) => c.name);
  return { columns, rows: rowsOf(columns, d.result?.data_array ?? []) };
}

const RUNNERS: Record<string, (ctx: Ctx, sql: string, cursor: string, limit: number) => Promise<Result>> = {
  postgres: runPg,
  redshift: runPg,
  mysql: runMysql,
  clickhouse: runClickhouse,
  bigquery: runBigquery,
  snowflake: runSnowflake,
  databricks: runDatabricks,
};

/** Run a query once, for the source page's Test button and for pulls. */
export async function runQuery(ctx: Ctx, q: WhQuery, cursor: string, limit = PAGE): Promise<Result> {
  const wrong = queryError(q);
  if (wrong) throw new Error(wrong);
  return RUNNERS[ctx.source.kind]({ ...ctx, query: q }, q.sql, cursor, limit);
}

// The connector ----------------------------------------------------------------------------------------------

export const queryOf = (s: SourceRow): WhQuery | null => ((s.settings as { query?: WhQuery }).query ?? null);
export const targetObject = (q: WhQuery | null): ObjectKind | null =>
  !q ? null : q.target === "contacts" ? "contacts" : q.target === "companies" ? "companies" : q.target === "events" ? "events" : q.target.startsWith("object:") ? "records" : null;

function warehouse(kind: string): Connector {
  return {
    kind,
    objects: [],
    objectsFor: (s) => {
      const t = targetObject(queryOf(s));
      return t ? [t] : [];
    },
    guess: true,
    async account(ctx) {
      const r = await RUNNERS[kind]({ ...ctx, query: { sql: "select 1 as one", key: "one", cursor: "one", target: "contacts" } }, "select 1 as one", START_CURSOR, 1);
      if (!r.rows.length) throw new Error("The database answered with nothing.");
      const where = ctx.secret("host") || ctx.secret("account") || ctx.secret("url") || (() => {
        try {
          return (JSON.parse(ctx.secret("service_account")) as { project_id?: string }).project_id ?? kind;
        } catch {
          return kind;
        }
      })();
      return { id: `${where}/${ctx.secret("database") || ""}`.replace(/\/$/, ""), label: where };
    },
    async pull(ctx, _object, cursor): Promise<Page> {
      const q = queryOf(ctx.source);
      if (!q) return { records: [], cursor, more: false };
      const from = cursor ?? START_CURSOR;
      const r = await runQuery(ctx, q, from);
      const records: RawRecord[] = r.rows.map((row) => ({ id: String(row[q.key] ?? ""), updatedAt: row[q.cursor] == null ? null : String(row[q.cursor]), data: row })).filter((x) => x.id);
      const last = r.rows.length ? r.rows[r.rows.length - 1][q.cursor] : null;
      const next = last == null ? from : String(last);
      const more = r.rows.length >= PAGE;
      if (more && next === from) throw new Error(`Over ${PAGE.toLocaleString("en-US")} rows share one cursor value; use a finer cursor column.`);
      return { records, cursor: next, more };
    },
    defaults: { contact: {}, company: {} },
  };
}

export const WAREHOUSES = ["postgres", "redshift", "mysql", "clickhouse", "bigquery", "snowflake", "databricks"].map(warehouse);
