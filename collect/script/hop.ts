// Cross-domain links (docs/identity.md 4.7). A link to another of the site's domains gets `_clr_x` only at the
// moment it's followed, and loses it right after, so a copied URL never carries the token.

/** True when `host` is one of `domains` (or under one) and isn't the page's own host. */
export function otherDomain(host: string, here: string, domains: readonly string[]): boolean {
  host = host.toLowerCase();
  if (host === here.toLowerCase()) return false;
  return domains.some((dm) => host === dm || host.endsWith("." + dm));
}

/** Watches links. `token` asks the server for a single-use hop token. */
export function watchHops(d: Document, domains: readonly string[], token: () => Promise<string>): void {
  if (!domains.length) return;
  let ready: { t: string; at: number } | null = null;
  let asking: Promise<string> | null = null;
  const link = (e: Event) => {
    const a = (e.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
    return a && /^https?:$/.test(a.protocol) && otherDomain(a.hostname, location.hostname, domains) ? a : null;
  };
  const ask = () => {
    if (ready && Date.now() - ready.at < 60_000) return;
    asking ??= token()
      .then((t) => ((ready = t ? { t, at: Date.now() } : null), t))
      .catch(() => "")
      .finally(() => (asking = null));
  };
  const decorate = (a: HTMLAnchorElement) => {
    const add = (t: string) => {
      if (!t) return;
      const was = a.href;
      const u = new URL(was);
      u.searchParams.set("_clr_x", t);
      a.href = u.toString();
      ready = null;
      setTimeout(() => (a.href = was), 500);
    };
    if (ready) add(ready.t);
    else {
      ask();
      asking?.then(add);
    }
  };
  d.addEventListener("mouseover", (e) => link(e) && ask(), { passive: true });
  d.addEventListener("focusin", (e) => link(e) && ask());
  for (const type of ["mousedown", "touchstart"]) {
    d.addEventListener(type, (e) => {
      const a = link(e);
      if (a) decorate(a);
    }, { capture: true, passive: true });
  }
  d.addEventListener("keydown", (e) => {
    const a = link(e);
    if (a && (e as KeyboardEvent).key === "Enter") decorate(a);
  }, true);
}
