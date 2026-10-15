// Reads the visitor's consent from the site's own consent tool. The server decides the policy; this only reports
// what the tool says. Order: claritia.consent() call, Cookiebot, OneTrust, Google Consent Mode v2.

export type Consent = { state: "granted" | "denied" | "unknown"; tool: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function readConsent(w: any, api: boolean | null): Consent {
  if (api !== null) return { state: api ? "granted" : "denied", tool: "api" };

  const cb = w.Cookiebot;
  if (cb && cb.consent) {
    return { state: !cb.hasResponse ? "unknown" : cb.consent.statistics ? "granted" : "denied", tool: "cookiebot" };
  }

  // OneTrust lists active groups as ",C0001,C0002,". C0002 is performance (analytics).
  const ot = w.OnetrustActiveGroups;
  if (typeof ot === "string") {
    if (("," + ot + ",").indexOf(",C0002,") >= 0) return { state: "granted", tool: "onetrust" };
    const closed = w.OneTrust && typeof w.OneTrust.IsAlertBoxClosed === "function" && w.OneTrust.IsAlertBoxClosed();
    return { state: closed ? "denied" : "unknown", tool: "onetrust" };
  }

  // gtag('consent', 'default' | 'update', { analytics_storage }). The last one wins. A default "denied" with no
  // update means the visitor hasn't chosen yet.
  const dl = w.dataLayer;
  if (dl && typeof dl.length === "number") {
    let found: Consent | null = null;
    for (let i = 0; i < dl.length; i++) {
      const e = dl[i];
      if (e && e[0] === "consent" && (e[1] === "default" || e[1] === "update") && e[2] && e[2].analytics_storage) {
        const granted = e[2].analytics_storage === "granted";
        found = { state: granted ? "granted" : e[1] === "update" ? "denied" : "unknown", tool: "gcm" };
      }
    }
    if (found) return found;
  }
  return { state: "unknown", tool: "none" };
}

/** Calls `fn` when any consent tool reports a change. */
export function watchConsent(w: any, fn: () => void): void {
  for (const name of ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline", "OneTrustGroupsUpdated"]) {
    w.addEventListener(name, fn);
  }
  const dl = w.dataLayer;
  if (dl && typeof dl.push === "function") {
    const push = dl.push;
    dl.push = function (this: unknown, ...args: unknown[]) {
      const r = push.apply(this, args);
      setTimeout(fn, 0);
      return r;
    };
  }
}
