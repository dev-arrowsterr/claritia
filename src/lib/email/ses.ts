// Amazon SES v2 over plain fetch (docs/marketing-platform.md M3): domain identities, MAIL FROM, and sending.
// Needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and SES_REGION (default ap-northeast-1). SES_CONFIGURATION_SET
// routes events to SNS.

import { signV4, type Creds } from "./sigv4.ts";

export type Identity = { dkimStatus: string; dkimTokens: string[]; mailFrom: string | null; mailFromStatus: string | null; verified: boolean };
export type Outgoing = { from: string; to: string; replyTo?: string | null; subject: string; html: string; text: string; headers: { name: string; value: string }[]; tags: Record<string, string> };

/**
 * An SES error. retry: SES said not now (throttled or a server error), so it's safe to try again. unknown: no clear
 * answer (a timeout or dropped connection), so the email may have gone out and must not be sent again.
 */
export class SesError extends Error {
  status: number;
  code: string;
  retry: boolean;
  unknown: boolean;
  constructor(message: string, o: { status?: number; code?: string; retry?: boolean; unknown?: boolean } = {}) {
    super(message);
    this.status = o.status ?? 0;
    this.code = o.code ?? "";
    this.retry = o.retry ?? false;
    this.unknown = o.unknown ?? false;
  }
}

const RETRY_CODES = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException", "Throttling", "ServiceUnavailable", "InternalFailure"]);

export type Ses = ReturnType<typeof sesClient>;

export function sesFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Ses | null {
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!id || !secret) return null;
  return sesClient({ region: env.SES_REGION?.trim() || "ap-northeast-1", creds: { accessKeyId: id, secretAccessKey: secret, sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined }, configSet: env.SES_CONFIGURATION_SET?.trim() || null, fetchFn });
}

export function sesClient(o: { region: string; creds: Creds; configSet?: string | null; fetchFn?: typeof fetch; timeoutMs?: number }) {
  const base = `https://email.${o.region}.amazonaws.com`;
  const fetchFn = o.fetchFn ?? fetch;

  async function call<T>(method: string, path: string, body?: object): Promise<T> {
    const url = `${base}${path}`;
    const json = body ? JSON.stringify(body) : "";
    const headers = signV4({ method, url, body: json, region: o.region, service: "ses", creds: o.creds, headers: { "content-type": "application/json" } });
    let res: Response;
    try {
      res = await fetchFn(url, { method, headers, body: body ? json : undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    } catch (e) {
      throw new SesError(`SES didn't answer: ${(e as Error).message}`, { unknown: true });
    }
    const text = await res.text().catch(() => "");
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    let code = res.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; Message?: string; __type?: string };
      message = j.message ?? j.Message ?? message;
      code ||= (j.__type ?? "").split("#").pop() ?? "";
    } catch {
      // Not JSON; keep the text.
    }
    throw new SesError(`SES ${res.status}${code ? ` ${code}` : ""}: ${message}`, { status: res.status, code, retry: res.status === 429 || res.status >= 500 || RETRY_CODES.has(code) });
  }

  const ident = (domain: string) => `/v2/email/identities/${encodeURIComponent(domain)}`;
  type Raw = { DkimAttributes?: { Status?: string; Tokens?: string[] }; MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string }; VerifiedForSendingStatus?: boolean };
  const shape = (r: Raw): Identity => ({
    dkimStatus: r.DkimAttributes?.Status ?? "NOT_STARTED",
    dkimTokens: r.DkimAttributes?.Tokens ?? [],
    mailFrom: r.MailFromAttributes?.MailFromDomain || null,
    mailFromStatus: r.MailFromAttributes?.MailFromDomainStatus || null,
    verified: !!r.VerifiedForSendingStatus,
  });

  return {
    region: o.region,
    /** The domain's identity, or null when SES doesn't have it. */
    async getIdentity(domain: string): Promise<Identity | null> {
      try {
        return shape(await call<Raw>("GET", ident(domain)));
      } catch (e) {
        if (e instanceof SesError && (e.status === 404 || e.code === "NotFoundException")) return null;
        throw e;
      }
    },
    /** Add the domain with Easy DKIM (three CNAMEs). */
    async createIdentity(domain: string): Promise<Identity> {
      const r = await call<{ DkimAttributes?: Raw["DkimAttributes"]; VerifiedForSendingStatus?: boolean }>("POST", "/v2/email/identities", { EmailIdentity: domain, ...(o.configSet ? { ConfigurationSetName: o.configSet } : {}) });
      return shape(r);
    },
    async putMailFrom(domain: string, mailFrom: string): Promise<void> {
      await call("PUT", `${ident(domain)}/mail-from`, { MailFromDomain: mailFrom, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" });
    },
    async deleteIdentity(domain: string): Promise<void> {
      try {
        await call("DELETE", ident(domain));
      } catch (e) {
        if (!(e instanceof SesError && (e.status === 404 || e.code === "NotFoundException"))) throw e;
      }
    },
    /** Send one email. Returns SES's message id. */
    async send(m: Outgoing): Promise<string> {
      const utf8 = (Data: string) => ({ Data, Charset: "UTF-8" });
      const r = await call<{ MessageId?: string }>("POST", "/v2/email/outbound-emails", {
        FromEmailAddress: m.from,
        Destination: { ToAddresses: [m.to] },
        ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
        Content: { Simple: { Subject: utf8(m.subject), Body: { Html: utf8(m.html), Text: utf8(m.text) }, Headers: m.headers.map((h) => ({ Name: h.name, Value: h.value })) } },
        EmailTags: Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value })),
        ...(o.configSet ? { ConfigurationSetName: o.configSet } : {}),
      });
      if (!r.MessageId) throw new SesError("SES took the email but sent no message id", { unknown: true });
      return r.MessageId;
    },
  };
}

/** A From header: the name quoted, or MIME-encoded when it isn't plain ASCII (RFC 2047). */
export function fromHeader(name: string | null | undefined, email: string): string {
  const n = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!n) return email;
  if (/^[\x20-\x7e]*$/.test(n)) return `"${n.replace(/(["\\])/g, "\\$1")}" <${email}>`;
  return `=?UTF-8?B?${Buffer.from(n, "utf8").toString("base64")}?= <${email}>`;
}
