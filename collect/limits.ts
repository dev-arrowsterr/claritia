// Token buckets in memory, per instance. A per-site count in Postgres catches abuse across instances later.

export class Buckets {
  private m = new Map<string, { tokens: number; at: number }>();
  private rate: number;
  private burst: number;
  constructor(ratePerSecond: number, burst = ratePerSecond) {
    this.rate = ratePerSecond;
    this.burst = burst;
  }
  take(key: string, now = Date.now()): boolean {
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size > 100_000) this.sweep(now);
      b = { tokens: this.burst, at: now };
      this.m.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  private sweep(now: number) {
    for (const [k, b] of this.m) if (now - b.at > 10_000) this.m.delete(k);
  }
}
