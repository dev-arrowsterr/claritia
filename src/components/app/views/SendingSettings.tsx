"use client";

// Settings › Sending (docs/conversion-weeks.md week 9): sending domains with their DNS records, the sender and
// physical address, frequency cap and quiet hours, topics, recent sends, and a test email to yourself.

import { useEffect, useState } from "react";
import { Plus, Refresh, Trash } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Select } from "../Select";
import { SampleTags, ToolIntro } from "../ToolIntro";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";

type DnsRecord = { key: string; type: string; name: string; value: string; status: "verified" | "waiting" | "wrong"; seen?: string };
type Domain = { id: string; domain: string; status: "pending" | "verified" | "failed"; records: DnsRecord[]; error: string | null; checked_at: string | null };
type Settings = { from_name: string | null; from_email: string | null; reply_to: string | null; address: string | null; cap_count: number; cap_days: number; quiet_start: number; quiet_end: number; timezone: string; paused: boolean; paused_reason: string | null };
type Topic = { id: string; name: string; default_on: boolean };
type Sent = { id: string; to_email: string; status: string; skip_reason: string | null; error: string | null; created_at: string; sent_at: string | null; emails: { subject: string; kind: string } | null };

const RECORD: Record<DnsRecord["status"], [string, Tone]> = { verified: ["Verified", "green"], waiting: ["Waiting", "amber"], wrong: ["Wrong", "red"] };
const DOMAIN: Record<Domain["status"], [string, Tone]> = { verified: ["Verified", "green"], pending: ["Waiting", "amber"], failed: ["Failed", "red"] };
const MESSAGE: Record<string, [string, Tone]> = {
  queued: ["Queued", "gray"],
  sending: ["Sending", "brand"],
  sent: ["Sent", "brand"],
  delivered: ["Delivered", "green"],
  bounced: ["Bounced", "red"],
  complained: ["Complained", "red"],
  rejected: ["Rejected", "red"],
  skipped: ["Skipped", "gray"],
  failed: ["Failed", "red"],
  unknown: ["Unknown", "amber"],
};
const SKIP: Record<string, string> = {
  suppressed: "Suppressed",
  erased: "Erased",
  no_basis: "No consent",
  withdrawn: "Consent withdrawn",
  not_subscribed: "Not subscribed",
  cap: "Frequency cap",
  no_domain: "Domain not verified",
  no_address: "No address",
  not_member: "Not a member",
  no_contact: "No contact",
  email_changed: "Email changed",
  paused: "Paused",
  no_settings: "Not set up",
};
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00` }));

export function SendingSettings({ sb, session, ws, role }: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const owner = role === "owner";
  const domains = useLoad(async () => must(await sb.from("sending_domains").select("id, domain, status, records, error, checked_at").eq("workspace_id", ws.id).order("created_at")) as Domain[], `${ws.id}:domains`);
  const settings = useLoad(
    async () => must(await sb.from("send_settings").select("from_name, from_email, reply_to, address, cap_count, cap_days, quiet_start, quiet_end, timezone, paused, paused_reason").eq("workspace_id", ws.id).maybeSingle()) as Settings | null,
    `${ws.id}:send_settings`,
  );
  const [error, setError] = useState("");
  const waiting = domains.data?.some((d) => d.status !== "verified") ?? false;
  const reloadDomains = domains.reload;

  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reloadDomains, 10_000);
    return () => clearInterval(t);
  }, [waiting, reloadDomains]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError("");
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!domains.data || settings.data === undefined) return <Loading />;
  const s = settings.data;

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote message={error || domains.error || settings.error} />
      {s?.paused ? (
        <Panel>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Badge tone="red">Paused</Badge>
            <span className="text-[13px]">{s.paused_reason}</span>
            {owner ? (
              <Button
                variant="ghost"
                className="ml-auto h-7 px-2.5"
                onClick={() =>
                  run(async () => {
                    if (!(await askConfirm("Resume sending?", { ok: "Resume" }))) return;
                    must(await sb.rpc("send_resume", { p_ws: ws.id }));
                  }, settings.reload)
                }
              >
                Resume
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {!domains.data.length ? (
        <ToolIntro
          title="Send from your own domain"
          lead="Add the domain you send from, then add the DNS records it shows. Sending opens once DKIM, SPF and DMARC check out, and every marketing email carries one-click unsubscribe."
          action={owner ? <AddDomain sb={sb} ws={ws} onAdded={domains.reload} onError={setError} /> : undefined}
          features={[
            { title: "Records checked for you", text: "Each DNS record shows Verified, Waiting or Wrong, checked every few minutes until it's right.", visual: <SampleTags rows={[["DKIM", "Verified"], ["SPF", "Waiting"], ["DMARC", "Wrong"]]} /> },
            { title: "Every guard on", text: "Consent by region, unsubscribes, bounces, a frequency cap and quiet hours in each contact's time zone, checked the moment each email leaves." },
            { title: "Complaints watched", text: "Bounces and spam complaints suppress the address at once. Sending pauses if complaints pass 0.2%." },
          ]}
        />
      ) : (
        <Panel>
          <CardHead label="Domains" count={domains.data.length} />
          <div className="divide-y divide-line">
            {domains.data.map((d) => (
              <DomainCard key={d.id} d={d} owner={owner} sb={sb} onChange={domains.reload} onError={setError} />
            ))}
          </div>
          {owner ? (
            <div className="border-t border-line px-4 py-3">
              <AddDomain sb={sb} ws={ws} onAdded={domains.reload} onError={setError} />
            </div>
          ) : null}
        </Panel>
      )}

      <SenderForm key={JSON.stringify(s)} sb={sb} ws={ws} owner={owner} saved={s} onSaved={settings.reload} />
      <Topics sb={sb} ws={ws} owner={owner} onError={setError} />
      <Recent sb={sb} session={session} ws={ws} canTest={!!s?.from_email && domains.data.some((d) => d.status === "verified")} />
    </div>
  );
}

function AddDomain({ sb, ws, onAdded, onError }: Pick<ViewProps, "sb" | "ws"> & { onAdded: () => void; onError: (m: string) => void }) {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!domain.trim()) return;
    setBusy(true);
    onError("");
    try {
      must(await sb.rpc("sending_domain_add", { p_ws: ws.id, p_domain: domain.trim() }));
      setDomain("");
      onAdded();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="w-64">
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mail.yourcompany.com" aria-label="Sending domain" />
      </div>
      <Button type="submit" disabled={busy || !domain.trim()}>
        <Plus size={14} /> {busy ? "Adding…" : "Add domain"}
      </Button>
    </form>
  );
}

function DomainCard({ d, owner, sb, onChange, onError }: { d: Domain; owner: boolean; sb: ViewProps["sb"]; onChange: () => void; onError: (m: string) => void }) {
  const [label, tone] = DOMAIN[d.status];
  const act = async (fn: () => Promise<unknown>) => {
    onError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{d.domain}</span>
        <Badge tone={tone}>{label}</Badge>
        <span className="ml-auto flex items-center gap-2">
          {d.checked_at ? <span className="text-[12px] text-faint">{timeAgo(d.checked_at)}</span> : null}
          <Button variant="plain" className="h-7 px-2" aria-label="Check now" title="Check now" onClick={() => act(async () => must(await sb.rpc("sending_domain_check_now", { p_id: d.id })))}>
            <Refresh size={14} />
          </Button>
          {owner ? (
            <Button
              variant="plain"
              className="h-7 px-2"
              aria-label="Remove domain"
              title="Remove domain"
              onClick={() =>
                act(async () => {
                  if (!(await askConfirm(`Remove ${d.domain}?`, { body: "Emails from this domain stop at once.", ok: "Remove", danger: true }))) return;
                  must(await sb.rpc("sending_domain_remove", { p_id: d.id }));
                })
              }
            >
              <Trash size={14} />
            </Button>
          ) : null}
        </span>
      </div>
      <ErrorNote message={d.error ?? ""} />
      {d.records.length ? (
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Name</Th>
                <Th>Value</Th>
                <Th className="w-24">State</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.records.map((r) => (
                <tr key={r.key} className="align-top">
                  <Td className="font-mono">{r.type}</Td>
                  <Td>
                    <CopyText text={r.name} />
                  </Td>
                  <Td>
                    <CopyText text={r.value} />
                    {r.status === "wrong" && r.seen ? <p className="mt-1 font-mono text-[11px] text-red-600">{r.seen}</p> : null}
                  </Td>
                  <Td>
                    <Badge tone={RECORD[r.status][1]}>{RECORD[r.status][0]}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : d.error ? null : (
        <Loading />
      )}
    </div>
  );
}

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={done ? "Copied" : "Copy"}
      className="max-w-full text-left font-mono break-all hover:text-brand"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? "Copied" : text}
    </button>
  );
}

function SenderForm({ sb, ws, owner, saved, onSaved }: Pick<ViewProps, "sb" | "ws"> & { owner: boolean; saved: Settings | null; onSaved: () => void }) {
  const [v, setV] = useState({
    from_name: saved?.from_name ?? "",
    from_email: saved?.from_email ?? "",
    reply_to: saved?.reply_to ?? "",
    address: saved?.address ?? "",
    cap_count: String(saved?.cap_count ?? 3),
    cap_days: String(saved?.cap_days ?? 7),
    quiet_start: saved?.quiet_start ?? 21,
    quiet_end: saved?.quiet_end ?? 8,
    timezone: saved?.timezone ?? "UTC",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      must(await sb.rpc("send_settings_save", { p_ws: ws.id, p_values: { ...v, cap_count: Number(v.cap_count) || 3, cap_days: Number(v.cap_days) || 7 } }));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel>
      <CardHead label="Sender" />
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="From name">
          <Input value={v.from_name} onChange={set("from_name")} placeholder="Acme" disabled={!owner} />
        </Field>
        <Field label="From address">
          <Input value={v.from_email} onChange={set("from_email")} placeholder="news@mail.yourcompany.com" disabled={!owner} />
        </Field>
        <Field label="Reply-to">
          <Input value={v.reply_to} onChange={set("reply_to")} placeholder="team@yourcompany.com" disabled={!owner} />
        </Field>
        <Field label="Physical address">
          <Input value={v.address} onChange={set("address")} placeholder="1 Main St, City, Country" disabled={!owner} />
        </Field>
        <Field label="Marketing emails per contact">
          <div className="flex items-center gap-2">
            <Input className="w-20" type="number" min={1} max={50} value={v.cap_count} onChange={set("cap_count")} disabled={!owner} aria-label="Emails" />
            <span className="text-[13px] text-muted">per</span>
            <Input className="w-20" type="number" min={1} max={60} value={v.cap_days} onChange={set("cap_days")} disabled={!owner} aria-label="Days" />
            <span className="text-[13px] text-muted">days</span>
          </div>
        </Field>
        <Field label="Quiet hours">
          <div className="flex items-center gap-2">
            <Select value={v.quiet_start} options={HOURS} onChange={(h) => setV({ ...v, quiet_start: h })} ariaLabel="Quiet from" className="w-24" disabled={!owner} />
            <span className="text-[13px] text-muted">to</span>
            <Select value={v.quiet_end} options={HOURS} onChange={(h) => setV({ ...v, quiet_end: h })} ariaLabel="Quiet until" className="w-24" disabled={!owner} />
          </div>
        </Field>
        <Field label="Default time zone">
          <Input value={v.timezone} onChange={set("timezone")} placeholder="UTC" disabled={!owner} />
        </Field>
      </div>
      {owner ? (
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}

function Topics({ sb, ws, owner, onError }: Pick<ViewProps, "sb" | "ws"> & { owner: boolean; onError: (m: string) => void }) {
  const list = useLoad(async () => must(await sb.from("topics").select("id, name, default_on").eq("workspace_id", ws.id).order("name")) as Topic[], `${ws.id}:topics`);
  const save = async (t: Topic | null, name: string | null, defaultOn?: boolean) => {
    onError("");
    try {
      must(await sb.rpc("topic_save", { p_ws: ws.id, p_id: t?.id ?? null, p_name: name ?? t?.name, p_default_on: defaultOn ?? t?.default_on ?? true }));
      list.reload();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <Panel>
      <CardHead label="Topics" count={list.data?.length}>
        {owner ? (
          <Button
            variant="plain"
            className="h-7 px-2"
            onClick={async () => {
              const name = await askText("New topic", { placeholder: "Product news" });
              if (name?.trim()) await save(null, name.trim(), true);
            }}
          >
            <Plus size={14} /> Topic
          </Button>
        ) : null}
      </CardHead>
      {!list.data ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-line">
          {list.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium">{t.name}</span>
              <Badge tone={t.default_on ? "green" : "gray"}>{t.default_on ? "On by default" : "Opt-in"}</Badge>
              {owner ? (
                <span className="ml-auto flex items-center gap-1">
                  <Button variant="plain" className="h-7 px-2" onClick={() => save(t, null, !t.default_on)}>
                    {t.default_on ? "Make opt-in" : "Make on by default"}
                  </Button>
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    onClick={async () => {
                      const name = await askText("Rename topic", { initial: t.name });
                      if (name?.trim() && name.trim() !== t.name) await save(t, name.trim());
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    aria-label={`Delete ${t.name}`}
                    title="Delete"
                    onClick={async () => {
                      if (!(await askConfirm(`Delete ${t.name}?`, { ok: "Delete", danger: true }))) return;
                      onError("");
                      try {
                        must(await sb.rpc("topic_delete", { p_id: t.id }));
                        list.reload();
                      } catch (e) {
                        onError(errorText(e));
                      }
                    }}
                  >
                    <Trash size={14} />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Recent({ sb, session, ws, canTest }: Pick<ViewProps, "sb" | "session" | "ws"> & { canTest: boolean }) {
  const list = useLoad(
    async () => must(await sb.from("email_messages").select("id, to_email, status, skip_reason, error, created_at, sent_at, emails(subject, kind)").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(25)) as unknown as Sent[],
    `${ws.id}:recent_sends`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const moving = list.data?.some((m) => m.status === "queued" || m.status === "sending" || m.status === "sent") ?? false;
  const reload = list.reload;

  useEffect(() => {
    if (!moving) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [moving, reload]);

  const test = async () => {
    setBusy(true);
    setError("");
    try {
      await postJson(session, "/api/email/test", { workspaceId: ws.id });
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <CardHead label="Recent sends" count={list.data?.length}>
        <Button variant="ghost" className="h-7 px-2.5" onClick={test} disabled={busy || !canTest}>
          {busy ? "Sending…" : "Send test"}
        </Button>
      </CardHead>
      <ErrorNote message={error || list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <Th>To</Th>
                <Th>Subject</Th>
                <Th className="w-56">State</Th>
                <Th className="w-28">When</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.map((m) => {
                const [label, tone] = MESSAGE[m.status] ?? [m.status, "gray" as Tone];
                return (
                  <tr key={m.id}>
                    <Td className="max-w-[220px] truncate font-mono text-[12px]">{m.to_email}</Td>
                    <Td className="max-w-[260px] truncate">{m.emails?.subject ?? "—"}</Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <Badge tone={tone}>{label}</Badge>
                        {m.skip_reason ? <span className="text-[12px] text-muted">{SKIP[m.skip_reason] ?? m.skip_reason}</span> : null}
                        {m.error && (m.status === "failed" || m.status === "unknown") ? (
                          <span className="max-w-[180px] truncate text-[12px] text-red-600" title={m.error}>
                            {m.error}
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    <Td className="text-faint">{timeAgo(m.sent_at ?? m.created_at)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
