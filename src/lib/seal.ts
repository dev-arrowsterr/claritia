import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Secrets are sealed with AES-256-GCM before they reach the database, using a key only the servers hold.
// Format: v1:<iv>:<tag>:<ciphertext>, each part base64.

function keyFrom(secret: string | undefined) {
  const s = secret?.trim();
  if (!s || s.length < 32) throw new Error("Add SECRETS_KEY (32 or more random characters) on Render.");
  return createHash("sha256").update(s).digest();
}

export function seal(value: string, secret = process.env.SECRETS_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function unseal(sealed: string, secret = process.env.SECRETS_KEY): string {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("This secret is not in a format Claritia can read.");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
