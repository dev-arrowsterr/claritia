// HubSpot embedded forms post a message when a form is sent. Only the email is read from it.

const ORIGIN = /^https:\/\/([\w-]+\.)*(hsforms\.(com|net)|hubspot\.com|hubspot\.net)$/;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function hubspotEmail(data: any): string {
  if (!data || data.type !== "hsFormCallback" || data.eventName !== "onFormSubmitted") return "";
  const v = data.data && (data.data.submissionValues || data.data);
  if (Array.isArray(v)) {
    const f = v.find((x: any) => x && x.name === "email");
    return f && typeof f.value === "string" ? f.value : "";
  }
  return v && typeof v.email === "string" ? v.email : "";
}

export function watchHubspot(w: Window, send: (email: string, form: string) => void): void {
  w.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== w.location.origin && !ORIGIN.test(e.origin)) return;
    const email = hubspotEmail(e.data);
    if (email) send(email, String((e.data.id || "") as string).slice(0, 100));
  });
}
