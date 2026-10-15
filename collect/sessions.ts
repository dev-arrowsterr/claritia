// Finds or starts the visit for a device (or a cookieless key). Memory first, then Postgres, which is the source
// of truth across instances. Split rules from docs/identity.md 4.6: 30 minutes idle, a new UTM campaign, or 12 hours.

import type { Prior } from "./store.ts";

export const IDLE_MS = 30 * 60_000;
export const MAX_MS = 12 * 3600_000;

export type Live = {
  id: string;
  startedAt: number;
  lastAt: number;
  campaign: string | null;
  pageviews: number;
  inputs: number;
  bot: boolean;
  hosting: boolean;
};

/** True when the visit can go on, false when a new one starts. */
export function continues(s: { startedAt: number; lastAt: number; campaign: string | null }, now: number, campaign: string | null): boolean {
  if (now - s.lastAt > IDLE_MS) return false;
  if (now - s.startedAt > MAX_MS) return false;
  if (campaign && campaign !== s.campaign) return false;
  return true;
}

export class Sessions {
  private lru = new Map<string, Live>();
  private pending = new Map<string, Promise<{ s: Live; fresh: boolean }>>();
  private max: number;
  constructor(max = 50_000) {
    this.max = max;
  }

  get size() {
    return this.lru.size;
  }

  forget(key: string) {
    this.lru.delete(key);
  }

  /**
   * The visit for `key`. `prior` looks in Postgres on a memory miss; `start` makes and saves a new one. Two requests
   * for the same key at once share one lookup, so they can't start two visits.
   */
  async current(
    key: string,
    now: number,
    campaign: string | null,
    prior: () => Promise<Prior | null>,
    start: () => Promise<Live>,
  ): Promise<{ s: Live; fresh: boolean }> {
    const waiting = this.pending.get(key);
    if (waiting) {
      await waiting.catch(() => {});
      return this.current(key, now, campaign, prior, start);
    }
    const hit = this.lru.get(key);
    if (hit && continues(hit, now, campaign)) {
      hit.lastAt = now;
      this.lru.delete(key);
      this.lru.set(key, hit);
      return { s: hit, fresh: false };
    }
    const p = (async () => {
      if (!hit) {
        const old = await prior();
        if (old) {
          const s: Live = { id: old.id, startedAt: old.startedAt, lastAt: old.endedAt, campaign: old.campaign, pageviews: old.pageviews, inputs: 1, bot: false, hosting: false };
          if (continues(s, now, campaign)) {
            s.lastAt = now;
            return { s, fresh: false };
          }
        }
      }
      return { s: await start(), fresh: true };
    })();
    this.pending.set(key, p);
    try {
      const r = await p;
      this.lru.delete(key);
      this.lru.set(key, r.s);
      if (this.lru.size > this.max) this.lru.delete(this.lru.keys().next().value!);
      return r;
    } finally {
      this.pending.delete(key);
    }
  }
}
