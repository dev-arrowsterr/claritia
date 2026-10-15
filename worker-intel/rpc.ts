// The jobs queue over a direct Postgres connection: the same functions Supabase's rpc would call.

import type pg from "pg";
import type { Rpc } from "../src/lib/jobs.ts";

const NAME = /^[a-z_]+$/;

export function pgRpc(pool: pg.Pool): Rpc {
  return async (fn, args) => {
    if (!NAME.test(fn)) return { data: null, error: { message: "bad function name" } };
    const keys = Object.keys(args).filter((k) => NAME.test(k));
    const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    try {
      const r = await pool.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k])));
      // A scalar function comes back as one column named after it; a set of rows as rows.
      const single = r.fields.length === 1 && r.fields[0].name === fn;
      return { data: single ? (r.rows[0]?.[fn] ?? null) : r.rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
}
