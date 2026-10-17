// AWS Signature Version 4 for JSON APIs (SES v2). Small on purpose: one header set, no streaming, no presigning.
// Checked against AWS's own test suite ("get-vanilla") in tests/email.test.ts.

import { createHash, createHmac } from "node:crypto";

export type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers to send with a request: the given ones plus host, x-amz-date and Authorization. */
export function signV4(req: { method: string; url: string; headers?: Record<string, string>; body?: string; region: string; service: string; creds: Creds; now?: Date }): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = (req.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(req.headers ?? {}), host: u.host, "x-amz-date": amzDate };
  if (req.creds.sessionToken) headers["x-amz-security-token"] = req.creds.sessionToken;

  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const signed = names.join(";");
  // Non-S3 services take each path segment encoded twice; the URL already holds it encoded once.
  const path = u.pathname.split("/").map((seg) => enc(seg)).join("/") || "/";
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [req.method.toUpperCase(), path, query, names.map((n) => `${n}:${lower[n]}\n`).join(""), signed, sha256(req.body ?? "")].join("\n");

  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${req.creds.secretAccessKey}`, day), req.region), req.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${req.creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
