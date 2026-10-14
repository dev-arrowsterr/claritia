// When the runner may go to sleep: nothing running, and no run taken for a while.
// On Fly.io the machine stops when the process exits, and the database wakes it when a run is queued.

export function shouldSleep(opts: { idleExitMs: number; lastWorkAt: number; now: number; running: number }) {
  if (opts.idleExitMs <= 0 || opts.running > 0) return false;
  return opts.now - opts.lastWorkAt >= opts.idleExitMs;
}
