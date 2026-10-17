// SES events arrive through SNS (docs/marketing-platform.md M3). Every message is checked against Amazon's signing
// certificate before anything is trusted, and must come from our own topic (SES_SNS_TOPIC_ARN).

import { verify } from "node:crypto";

export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

export type SesEvent = { sns_id: string; ses_message_id: string; kind: "delivered" | "bounced" | "complained" | "rejected" | "delayed"; bounce?: "hard" | "soft"; at: string; detail: Record<string, unknown> };

const CERT_HOST = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/[^?#]+\.pem$/;
export const SUBSCRIBE_HOST = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;
const certs = new Map<string, string>();

export type CertFetch = (url: string) => Promise<string>;
const fetchCert: CertFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Certificate fetch answered ${res.status}`);
  return res.text();
};

/** The text SNS signs: chosen fields as "Name\nvalue\n", in this order. */
export function stringToSign(m: SnsMessage): string {
  const keys = m.Type === "Notification" ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys
    .filter((k) => (m as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${k}\n${(m as Record<string, string>)[k]}\n`)
    .join("");
}

/** Null when the message is genuine and from our topic; otherwise why it was refused. */
export async function checkSns(m: SnsMessage, topicArn: string, getCert: CertFetch = fetchCert): Promise<string | null> {
  if (!m || typeof m !== "object" || typeof m.Signature !== "string" || typeof m.MessageId !== "string") return "Not an SNS message";
  if (m.TopicArn !== topicArn) return "Wrong topic";
  if (!CERT_HOST.test(m.SigningCertURL ?? "")) return "Certificate isn't from SNS";
  const alg = m.SignatureVersion === "2" ? "sha256" : m.SignatureVersion === "1" ? "sha1" : null;
  if (!alg) return "Unknown signature version";
  let pem = certs.get(m.SigningCertURL);
  if (!pem) {
    pem = await getCert(m.SigningCertURL);
    if (certs.size > 50) certs.clear();
    certs.set(m.SigningCertURL, pem);
  }
  try {
    return verify(alg, Buffer.from(stringToSign(m), "utf8"), pem, Buffer.from(m.Signature, "base64")) ? null : "Bad signature";
  } catch {
    return "Bad signature";
  }
}

type Raw = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: { diagnosticCode?: string }[] };
  complaint?: { timestamp?: string; complaintFeedbackType?: string; complaintSubType?: string | null };
  delivery?: { timestamp?: string };
  reject?: { reason?: string };
  deliveryDelay?: { timestamp?: string; delayType?: string };
};

/** One SES event from an SNS notification, or null for kinds we don't act on (send, open, click, rendering). */
export function parseSesEvent(m: SnsMessage): SesEvent | null {
  let r: Raw;
  try {
    r = JSON.parse(m.Message) as Raw;
  } catch {
    return null;
  }
  const type = r.eventType ?? r.notificationType;
  const id = r.mail?.messageId;
  if (!id || !type) return null;
  const base = { sns_id: m.MessageId, ses_message_id: id };
  const when = (t?: string) => t ?? r.mail?.timestamp ?? m.Timestamp;
  switch (type) {
    case "Delivery":
      return { ...base, kind: "delivered", at: when(r.delivery?.timestamp), detail: {} };
    case "Bounce":
      return {
        ...base,
        kind: "bounced",
        bounce: r.bounce?.bounceType === "Permanent" ? "hard" : "soft",
        at: when(r.bounce?.timestamp),
        detail: { type: r.bounce?.bounceType, sub: r.bounce?.bounceSubType, code: r.bounce?.bouncedRecipients?.[0]?.diagnosticCode?.slice(0, 300) },
      };
    case "Complaint":
      // "not-spam" is a recipient taking an earlier complaint back.
      if (r.complaint?.complaintFeedbackType === "not-spam") return null;
      return { ...base, kind: "complained", at: when(r.complaint?.timestamp), detail: { type: r.complaint?.complaintFeedbackType, sub: r.complaint?.complaintSubType } };
    case "Reject":
      return { ...base, kind: "rejected", at: when(), detail: { reason: r.reject?.reason } };
    case "DeliveryDelay":
      return { ...base, kind: "delayed", at: when(r.deliveryDelay?.timestamp), detail: { type: r.deliveryDelay?.delayType } };
    default:
      return null;
  }
}
