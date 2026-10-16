// Sending (docs/conversion-weeks.md week 9): AWS signing, SES answers, link tokens, rendering with one-click
// unsubscribe, SNS signatures, SES event parsing, and DNS record checks.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { checkRecords, expectedRecords, type Resolver } from "../src/lib/email/domains.ts";
import { renderMessage, type Claimed } from "../src/lib/email/render.ts";
import { fromHeader, sesClient, SesError } from "../src/lib/email/ses.ts";
import { signV4 } from "../src/lib/email/sigv4.ts";
import { checkSns, parseSesEvent, stringToSign, type SnsMessage } from "../src/lib/email/sns.ts";
import { extractLinks, looksLikeScanner, makeToken, readToken, rewriteLinks } from "../src/lib/email/track.ts";

const SECRET = "x".repeat(40);

test("SigV4 matches AWS's get-vanilla test", () => {
  const h = signV4({ method: "GET", url: "https://example.amazonaws.com/", region: "us-east-1", service: "service", creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, now: new Date("2015-08-30T12:36:00Z") });
  assert.equal(h.Authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(h["x-amz-date"], "20150830T123600Z");
});

test("SES answers sort into sent, try again, failed and unknown", async () => {
  const answer = (status: number, body: object | string, headers: Record<string, string> = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  const client = (f: typeof fetch) => sesClient({ region: "ap-northeast-1", creds: { accessKeyId: "a", secretAccessKey: "b" }, fetchFn: f });
  const msg = { from: "a@b.co", to: "c@d.co", subject: "s", html: "h", text: "t", headers: [], tags: {} };

  let seen: RequestInit | undefined;
  let url = "";
  const id = await client((async (u: string, init: RequestInit) => {
    url = u;
    seen = init;
    return new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 });
  }) as typeof fetch).send({ ...msg, headers: [{ name: "List-Unsubscribe", value: "<https://x/u/1>" }], tags: { message: "abc" } });
  assert.equal(id, "m-1");
  assert.equal(url, "https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");
  const sent = JSON.parse(String(seen?.body));
  assert.deepEqual(sent.Content.Simple.Headers, [{ Name: "List-Unsubscribe", Value: "<https://x/u/1>" }]);
  assert.deepEqual(sent.EmailTags, [{ Name: "message", Value: "abc" }]);
  assert.match(String((seen?.headers as Record<string, string>).Authorization), /^AWS4-HMAC-SHA256 Credential=a\/\d{8}\/ap-northeast-1\/ses\/aws4_request/);

  const fails = async (f: typeof fetch) => client(f).send(msg).then(() => assert.fail("should throw"), (e: SesError) => e);
  const throttled = await fails(answer(429, { message: "Maximum sending rate exceeded." }, { "x-amzn-errortype": "TooManyRequestsException:http://x" }) as unknown as typeof fetch);
  assert.ok(throttled.retry && !throttled.unknown);
  const rejected = await fails(answer(400, { message: "Email address is not verified." }, { "x-amzn-errortype": "MessageRejected" }) as unknown as typeof fetch);
  assert.ok(!rejected.retry && !rejected.unknown);
  assert.match(rejected.message, /MessageRejected/);
  const server = await fails(answer(503, "Service Unavailable") as unknown as typeof fetch);
  assert.ok(server.retry);
  const timeout = await fails((async () => {
    throw new Error("The operation was aborted due to timeout");
  }) as unknown as typeof fetch);
  assert.ok(timeout.unknown && !timeout.retry);

  assert.equal(await client(answer(404, { message: "nope" }, { "x-amzn-errortype": "NotFoundException" }) as unknown as typeof fetch).getIdentity("acme.com"), null);
  const ident = await client(answer(200, { DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] }, MailFromAttributes: { MailFromDomain: "bounce.acme.com", MailFromDomainStatus: "SUCCESS" }, VerifiedForSendingStatus: true }) as unknown as typeof fetch).getIdentity("acme.com");
  assert.deepEqual(ident, { dkimStatus: "SUCCESS", dkimTokens: ["t1", "t2", "t3"], mailFrom: "bounce.acme.com", mailFromStatus: "SUCCESS", verified: true });
});

test("From names are quoted, or MIME-encoded when not plain ASCII", () => {
  assert.equal(fromHeader("Acme", "hi@acme.com"), `"Acme" <hi@acme.com>`);
  assert.equal(fromHeader(`Acme "Labs"`, "hi@acme.com"), `"Acme \\"Labs\\"" <hi@acme.com>`);
  assert.equal(fromHeader("Café\r\nBcc: x", "hi@acme.com"), `=?UTF-8?B?${Buffer.from("Café Bcc: x").toString("base64")}?= <hi@acme.com>`);
  assert.equal(fromHeader(null, "hi@acme.com"), "hi@acme.com");
});

test("link tokens round-trip, and a changed byte or another key fails", () => {
  const message = "0190f5a2-1c3b-7d4e-8f90-123456789abc";
  const t = makeToken({ kind: "click", message, link: 7 }, SECRET);
  assert.deepEqual(readToken(t, SECRET), { kind: "click", message, link: 7 });
  assert.deepEqual(readToken(makeToken({ kind: "unsub", message, link: 0 }, SECRET), SECRET), { kind: "unsub", message, link: 0 });
  assert.equal(readToken(t, "y".repeat(40)), null);
  const [body, mac] = t.split(".");
  const flipped = Buffer.from(body, "base64url");
  flipped[19] ^= 1;
  assert.equal(readToken(`${flipped.toString("base64url")}.${mac}`, SECRET), null);
  assert.equal(readToken("nonsense", SECRET), null);
  assert.equal(readToken("", SECRET), null);
  assert.throws(() => makeToken({ kind: "click", message, link: 0 }, "short"), /SECRETS_KEY/);
});

test("links are listed and rewritten in the same order; mailto, anchors and tokens stay", () => {
  const html = `<p><a href="https://acme.com/a?x=1&amp;y=2">A</a> <a class="b" href='http://acme.com/b'>B</a> <a href="mailto:hi@acme.com">M</a> <a href="#top">T</a> <a href="{{unsubscribe}}">U</a> <A HREF="https://acme.com/a?x=1&amp;y=2">A again</A></p>`;
  assert.deepEqual(extractLinks(html), ["https://acme.com/a?x=1&y=2", "http://acme.com/b", "https://acme.com/a?x=1&y=2"]);
  const out = rewriteLinks(html, (i) => `https://t/c/${i}`);
  assert.equal(out, `<p><a href="https://t/c/0">A</a> <a class="b" href='https://t/c/1'>B</a> <a href="mailto:hi@acme.com">M</a> <a href="#top">T</a> <a href="{{unsubscribe}}">U</a> <A HREF="https://t/c/2">A again</A></p>`);
});

test("mail filters are told apart from people by method and user agent", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  assert.equal(looksLikeScanner("GET", chrome), false);
  assert.equal(looksLikeScanner("HEAD", chrome), true);
  assert.equal(looksLikeScanner("GET", ""), true);
  assert.equal(looksLikeScanner("GET", null), true);
  assert.equal(looksLikeScanner("GET", "Mozilla/5.0 (compatible; Barracuda Sentinel)"), true);
  assert.equal(looksLikeScanner("GET", "python-requests/2.31"), true);
  assert.equal(looksLikeScanner("GET", "Mozilla/5.0 (Windows NT 10.0) Microsoft Outlook SafeLinks"), true);
});

const claimed = (o: Partial<Claimed> = {}): Claimed => ({
  id: "0190f5a2-1c3b-7d4e-8f90-123456789abc",
  to: "dana@example.com",
  contact_id: "c1",
  email_id: "e1",
  kind: "broadcast",
  marketing: true,
  subject: "Hello\nthere",
  preheader: "Peek <in>",
  html: `<html><body><p>Hi</p><a href="https://acme.com/x">Go</a></body></html>`,
  text: "Hi\n",
  links: ["https://acme.com/x"],
  from_name: "Acme",
  from_email: "news@mail.acme.com",
  reply_to: "team@acme.com",
  address: "1 Main St, Springfield",
  topic: null,
  mail_from: "bounce.mail.acme.com",
  per_second: 14,
  ...o,
});

test("a marketing email gets tracked links, the footer and one-click unsubscribe headers", () => {
  const out = renderMessage(claimed(), { base: "https://app.test", secret: SECRET });
  assert.equal(out.from, `"Acme" <news@mail.acme.com>`);
  assert.equal(out.subject, "Hello there");
  assert.equal(out.replyTo, "team@acme.com");
  const unsub = out.headers.find((h) => h.name === "List-Unsubscribe")?.value ?? "";
  assert.match(unsub, /^<https:\/\/app\.test\/u\/[\w-]+\.[\w-]+>$/);
  assert.deepEqual(out.headers.find((h) => h.name === "List-Unsubscribe-Post"), { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" });
  const token = unsub.slice("<https://app.test/u/".length, -1);
  assert.deepEqual(readToken(token, SECRET), { kind: "unsub", message: claimed().id, link: 0 });
  const click = out.html.match(/href="https:\/\/app\.test\/c\/([^"]+)"/)?.[1] ?? "";
  assert.deepEqual(readToken(click, SECRET), { kind: "click", message: claimed().id, link: 0 });
  assert.ok(!out.html.includes("https://acme.com/x"));
  assert.match(out.html, /<body><div style="display:none[^>]*>Peek &lt;in&gt;<\/div>/);
  assert.match(out.html, /Acme · 1 Main St, Springfield<br><a href="https:\/\/app\.test\/u\/[^"]+"[^>]*>Unsubscribe<\/a><\/div><\/body>/);
  assert.match(out.text, /--\nAcme · 1 Main St, Springfield\nUnsubscribe: https:\/\/app\.test\/u\//);
  assert.deepEqual(out.tags, { message: claimed().id, email: "e1" });
});

test("a non-marketing email has no footer or unsubscribe headers", () => {
  const out = renderMessage(claimed({ marketing: false, preheader: null }), { base: "https://app.test", secret: SECRET });
  assert.deepEqual(out.headers, []);
  assert.ok(!out.html.includes("Unsubscribe"));
  assert.equal(out.text, "Hi\n");
});

function snsSigned(o: Partial<SnsMessage>, version = "2") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const m = { Type: "Notification", MessageId: "sns-1", TopicArn: "arn:aws:sns:ap-northeast-1:1:ses", Message: "{}", Timestamp: "2026-10-16T00:00:00.000Z", SignatureVersion: version, SigningCertURL: "https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-abc.pem", Signature: "", ...o } as SnsMessage;
  m.Signature = sign(version === "2" ? "sha256" : "sha1", Buffer.from(stringToSign(m)), privateKey).toString("base64");
  return { m, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

test("SNS messages are checked against the certificate and our topic", async () => {
  const topic = "arn:aws:sns:ap-northeast-1:1:ses";
  const { m, pem } = snsSigned({ Subject: "Amazon SES Email Event Notification" });
  let fetched = 0;
  const cert = async () => (fetched++, pem);
  assert.equal(await checkSns(m, topic, cert), null);
  assert.equal(await checkSns({ ...m, Message: '{"eventType":"Complaint"}' }, topic, cert), "Bad signature");
  assert.equal(await checkSns(m, "arn:aws:sns:ap-northeast-1:1:other", cert), "Wrong topic");
  assert.equal(await checkSns({ ...m, SigningCertURL: "https://evil.example.com/cert.pem" }, topic, cert), "Certificate isn't from SNS");
  assert.equal(await checkSns({ ...m, SigningCertURL: "https://sns.ap-northeast-1.amazonaws.com.evil.com/x.pem" }, topic, cert), "Certificate isn't from SNS");
  assert.equal(await checkSns({ ...m, SignatureVersion: "3" }, topic, cert), "Unknown signature version");
  const v1 = snsSigned({ SigningCertURL: "https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-v1.pem" }, "1");
  assert.equal(await checkSns(v1.m, topic, async () => v1.pem), null);
  const sub = snsSigned({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-northeast-1.amazonaws.com/?Action=ConfirmSubscription", Token: "tok", SigningCertURL: "https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-sub.pem" });
  assert.equal(await checkSns(sub.m, topic, async () => sub.pem), null);
  assert.equal(fetched, 1, "the certificate is fetched once");
});

test("SES events become delivered, hard and soft bounces, complaints, rejects and delays", () => {
  const ev = (body: object) => parseSesEvent({ Type: "Notification", MessageId: "sns-9", Message: JSON.stringify(body), Timestamp: "2026-10-16T00:00:09Z" } as SnsMessage);
  const mail = { messageId: "ses-1", timestamp: "2026-10-16T00:00:00Z" };
  assert.deepEqual(ev({ eventType: "Delivery", mail, delivery: { timestamp: "2026-10-16T00:00:02Z" } }), { sns_id: "sns-9", ses_message_id: "ses-1", kind: "delivered", at: "2026-10-16T00:00:02Z", detail: {} });
  assert.equal(ev({ eventType: "Bounce", mail, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ diagnosticCode: "550 no such user" }] } })?.bounce, "hard");
  assert.equal(ev({ eventType: "Bounce", mail, bounce: { bounceType: "Transient", bounceSubType: "MailboxFull" } })?.bounce, "soft");
  assert.equal(ev({ eventType: "Bounce", mail, bounce: { bounceType: "Undetermined" } })?.bounce, "soft");
  assert.equal(ev({ notificationType: "Complaint", mail, complaint: { complaintFeedbackType: "abuse" } })?.kind, "complained");
  assert.equal(ev({ eventType: "Complaint", mail, complaint: { complaintFeedbackType: "not-spam" } }), null);
  assert.equal(ev({ eventType: "Reject", mail, reject: { reason: "Bad content" } })?.kind, "rejected");
  assert.equal(ev({ eventType: "DeliveryDelay", mail, deliveryDelay: { delayType: "MailboxFull" } })?.kind, "delayed");
  assert.equal(ev({ eventType: "Open", mail }), null);
  assert.equal(ev({ eventType: "Delivery" }), null);
  assert.equal(parseSesEvent({ Type: "Notification", MessageId: "x", Message: "not json" } as SnsMessage), null);
});

const row = { id: "d1", domain: "mail.acme.com", mail_from: "bounce.mail.acme.com", dkim_tokens: ["aa", "bb", "cc"] };
const nx = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
const fake = (zone: Record<string, string[] | { exchange: string; priority: number }[]>): Resolver => {
  const get = <T>(key: string): T => {
    if (!zone[key]) throw nx();
    return zone[key] as T;
  };
  return {
    cname: async (n) => get<string[]>(`CNAME ${n}`),
    mx: async (n) => get<{ exchange: string; priority: number }[]>(`MX ${n}`),
    txt: async (n) => get<string[]>(`TXT ${n}`).map((t) => [t]),
  };
};

test("the records to add: three DKIM CNAMEs, MAIL FROM MX and SPF, and DMARC", () => {
  assert.deepEqual(
    expectedRecords(row, "ap-northeast-1").map((r) => `${r.type} ${r.name} ${r.value}`),
    [
      "CNAME aa._domainkey.mail.acme.com aa.dkim.amazonses.com",
      "CNAME bb._domainkey.mail.acme.com bb.dkim.amazonses.com",
      "CNAME cc._domainkey.mail.acme.com cc.dkim.amazonses.com",
      "MX bounce.mail.acme.com 10 feedback-smtp.ap-northeast-1.amazonses.com",
      "TXT bounce.mail.acme.com v=spf1 include:amazonses.com ~all",
      "TXT _dmarc.mail.acme.com v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com",
    ],
  );
});

test("records read Waiting, Wrong or Verified, and the domain verifies only with all three", async () => {
  const pending = { dkimStatus: "PENDING", dkimTokens: ["aa", "bb", "cc"], mailFrom: "bounce.mail.acme.com", mailFromStatus: "PENDING", verified: false };
  const none = await checkRecords(row, pending, "ap-northeast-1", fake({}));
  assert.equal(none.status, "pending");
  assert.deepEqual(none.records.map((r) => r.status), ["waiting", "waiting", "waiting", "waiting", "waiting", "waiting"]);

  const typos = await checkRecords(row, pending, "ap-northeast-1", fake({
    "CNAME aa._domainkey.mail.acme.com": ["aa.dkim.amazonses.com"],
    "CNAME bb._domainkey.mail.acme.com": ["bb.dkim.amazon.com"],
    "MX bounce.mail.acme.com": [{ exchange: "mx.google.com", priority: 1 }],
    "TXT bounce.mail.acme.com": ["v=spf1 include:_spf.google.com ~all"],
    "TXT _dmarc.mail.acme.com": ["dmarc please"],
  }));
  assert.deepEqual(typos.records.map((r) => `${r.key}:${r.status}`), ["dkim1:waiting", "dkim2:wrong", "dkim3:waiting", "mx:wrong", "spf:wrong", "dmarc:wrong"]);
  assert.equal(typos.records[1].seen, "bb.dkim.amazon.com");

  const ok = { ...pending, dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", verified: true };
  const zone = { "TXT bounce.mail.acme.com": ["v=spf1 include:amazonses.com ~all"], "TXT _dmarc.acme.com": ["v=DMARC1; p=quarantine"] };
  const done = await checkRecords(row, ok, "ap-northeast-1", fake(zone));
  assert.equal(done.status, "verified", "DMARC on the parent domain counts");
  assert.ok(done.records.every((r) => r.status === "verified"));

  const noDmarc = await checkRecords(row, ok, "ap-northeast-1", fake({ "TXT bounce.mail.acme.com": ["v=spf1 include:amazonses.com ~all"] }));
  assert.equal(noDmarc.status, "pending", "no DMARC, no sending");

  const flaky: Resolver = { ...fake({}), cname: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) };
  assert.equal((await checkRecords(row, pending, "ap-northeast-1", flaky)).records[0].status, "waiting", "a DNS timeout never reads as wrong");
  assert.equal((await checkRecords(row, { ...pending, dkimStatus: "FAILED" }, "ap-northeast-1", fake({}))).status, "failed");
});
