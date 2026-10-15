// Small helpers for claritia.js. Storage can throw (private windows, blocked site data), so every call is guarded.

export function uuid7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const t = Date.now().toString(16).padStart(12, "0");
  let h = t;
  for (let i = 6; i < 16; i++) h += (b[i] + 256).toString(16).slice(1);
  // Version 7 and the RFC variant.
  h = h.slice(0, 12) + "7" + h.slice(13, 16) + "89ab"[b[0] & 3] + h.slice(17);
  return h.replace(/(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

export function cookie(name: string): string {
  const m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
  return m ? m[1] : "";
}

export function setCookie(name: string, value: string, maxAge: number): void {
  document.cookie = name + "=" + value + ";max-age=" + maxAge + ";path=/;samesite=lax" + (location.protocol === "https:" ? ";secure" : "");
}

function store(kind: "localStorage" | "sessionStorage") {
  const run = (f: (s: Storage) => unknown) => {
    try {
      return f(window[kind]);
    } catch {}
  };
  return {
    get: (k: string) => (run((s) => s.getItem(k)) as string) || "",
    set: (k: string, v: string) => run((s) => s.setItem(k, v)),
    del: (k: string) => run((s) => s.removeItem(k)),
  };
}
export const ls = store("localStorage");
export const ss = store("sessionStorage");

/** FNV-1a, for "already sent this" marks. Never used as an id. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
