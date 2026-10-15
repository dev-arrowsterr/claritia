// Private and local addresses our servers must never reach on a customer's say-so: the runner's browser, the
// Explorer, and server-side calls to addresses people type in (like a suite connection's base URL).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
  }
  return false;
}

export const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** True when a host name is local, or any address it points to is private. A name that doesn't resolve isn't private. */
export async function hostIsPrivate(host: string, resolve: typeof lookup = lookup): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (LOCAL_NAMES.test(bare)) return true;
  if (isIP(bare)) return isPrivateAddress(bare);
  try {
    const all = await resolve(bare, { all: true });
    return all.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}
