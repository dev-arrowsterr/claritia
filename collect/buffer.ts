// The event write buffer (docs/m1-website-intelligence.md 5.5). Rows wait in memory and go to Postgres every second
// or at 500 rows. A failed write keeps its rows and tries again, so a slow or down database loses nothing while the
// process lives. Writes are idempotent (event ids), so a retry after an unclear failure can't double anything.

import type { EventRow, Store } from "./store.ts";

export type BufferOptions = {
  flushMs?: number;
  batch?: number;
  /** Over this many waiting rows, collect answers 503 so browsers hold their batches. */
  limit?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

const DATA_ERROR = /^(22|23)/;

export class WriteBuffer {
  private rows: EventRow[] = [];
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private pausedUntil = 0;
  private store: Store;
  private opts: Required<BufferOptions>;
  dropped = 0;

  constructor(store: Store, opts: BufferOptions = {}) {
    this.store = store;
    this.opts = { flushMs: 1000, batch: 500, limit: 20_000, log: () => {}, ...opts };
  }

  get size() {
    return this.rows.length;
  }
  get full() {
    return this.rows.length >= this.opts.limit;
  }

  push(rows: EventRow[]) {
    this.rows.push(...rows);
    if (this.rows.length >= this.opts.batch) void this.flush();
  }

  start() {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushMs);
  }

  /** Writes what's waiting. Only one write runs at a time; a call during a write waits for it, then writes more. */
  async flush(): Promise<void> {
    if (this.running) return this.running;
    if (!this.rows.length || Date.now() < this.pausedUntil) return;
    this.running = this.drain().finally(() => (this.running = null));
    return this.running;
  }

  private async drain() {
    while (this.rows.length && Date.now() >= this.pausedUntil) {
      const take = this.rows.slice(0, this.opts.batch);
      try {
        await this.write(take);
        this.rows.splice(0, take.length);
        this.failures = 0;
      } catch (e) {
        // Keep the rows. Back off 1, 2, 4 … 30 seconds.
        this.failures++;
        this.pausedUntil = Date.now() + Math.min(30_000, 1000 * 2 ** (this.failures - 1));
        this.opts.log("flush failed", { error: String((e as Error).message ?? e), waiting: this.rows.length, failures: this.failures });
        return;
      }
    }
  }

  /** A bad row (a data error) is found by halving and dropped alone; the rest still lands. */
  private async write(rows: EventRow[]): Promise<void> {
    try {
      await this.store.writeEvents(rows);
    } catch (e) {
      const code = String((e as { code?: string }).code ?? "");
      if (!DATA_ERROR.test(code)) throw e;
      if (rows.length === 1) {
        this.dropped++;
        this.opts.log("row dropped", { code, error: String((e as Error).message), kind: rows[0].kind });
        return;
      }
      const mid = Math.ceil(rows.length / 2);
      await this.write(rows.slice(0, mid));
      await this.write(rows.slice(mid));
    }
  }

  /** On shutdown: wait for the write in progress, then write the rest, retrying until `deadlineMs`. */
  async close(deadlineMs = 25_000): Promise<number> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const end = Date.now() + deadlineMs;
    while (this.rows.length && Date.now() < end) {
      this.pausedUntil = 0;
      await this.flush();
      if (this.rows.length) await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, end - Date.now()))));
    }
    if (this.running) await this.running;
    return this.rows.length;
  }
}
