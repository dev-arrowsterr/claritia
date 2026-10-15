"use client";

// Settings › Sources and Settings › Sync log (docs/conversion-weeks.md weeks 3 to 7): every tool contacts come
// from, connected in one click where the tool allows it, with its objects, schedule, consent, mapping and runs.

import { useState } from "react";
import { BASES, type Basis } from "@/lib/contacts/consent";
import { TARGETS, type Target } from "@/lib/contacts/fields";
import { CATALOG, GROUPS, entryOf, type Entry } from "@/lib/sources/catalog";
import { Copy, Pause, Play, Plug, Refresh } from "../../Icons";
import { BrandLogo } from "../BrandLogo";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { SampleStats, ToolIntro } from "../ToolIntro";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";
import { CheckBox } from "../records/RecordTable";
import { SidePanel } from "../records/SidePanel";

type Source = {
  id: string;
  kind: string;
  name: string;
  account: string | null;
  status: string;
  settings: { objects?: Record<string, string>; every_min?: number; basis?: Basis; push_new?: string; follow_deletes?: boolean };
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
};
type Run = { id: string; object: string; direction: string; started_at: string; finished_at: string | null; pulled: number; written: number; skipped: number; errors: number; error: string | null };
type MapRow = { col: string; sample: string; target: string };

const STATE: Record<string, [string, Tone]> = { active: ["Active", "green"], paused: ["Paused", "gray"], error: ["Error", "red"], disconnected: ["Disconnected", "gray"] };
const EVERY = [
  { value: 5, label: "Every 5 minutes" },
  { value: 15, label: "Every 15 minutes" },
  { value: 60, label: "Every hour" },
  { value: 360, label: "Every 6 hours" },
  { value: 1440, label: "Every day" },
];
const SEL = "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const OBJECT_LABEL: Record<string, string> = { contacts: "Contacts", companies: "Companies", lists: "Lists", suppressions: "Unsubscribes" };

async function getJson<T>(session: ViewProps["session"], path: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${session.access_token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data as T;
}

const search = () => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search));

export function SourcesSettings({ sb, session, ws, role }: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const sources = useLoad(async () => must(await sb.from("sources").select("id, kind, name, account, status, settings, last_run_at, last_error, created_at").eq("workspace_id", ws.id).order("created_at")) as Source[], ws.id);
  const [open, setOpen] = useState<string | null>(() => search().get("connected") ?? search().get("source"));
  // Omniscient's own Connect button sends people to /settings/suite?connect=omniscient.
  const [connect, setConnect] = useState<Entry | null>(() => entryOf(search().get("connect") ?? "") ?? null);
  const [q, setQ] = useState("");
  const [error, setError] = useState(() => search().get("error") ?? "");
  const owner = role === "owner";
  const list = sources.data ?? [];
  const connected = new Map(list.filter((s) => s.status !== "disconnected").map((s) => [s.kind, s]));
  const shown = CATALOG.filter((e) => !q.trim() || e.label.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (id: string | null) => {
    setOpen(id);
    try {
      window.history.replaceState(null, "", id ? `/settings/sources?source=${id}` : "/settings/sources");
    } catch {
      // Not on the app's own address (a preview); the panel still opens.
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote message={error} />
      {sources.data && !list.length ? (
        <ToolIntro
          title="Contacts from every tool you use"
          lead="Connect your CRM, email tools, forms and billing. Contacts come in with their consent and unsubscribes, duplicates merge, and two-way CRMs get changes back within minutes."
          features={[
            { title: "Two-way CRM sync", text: "HubSpot, Salesforce and Omniscient stay in step with Claritia. A person's edit wins over a sync by default.", visual: <SampleStats items={[["in", "12,408"], ["out", "1,930"], ["loops", "0"]]} /> },
            { title: "Email tools", text: "Mailchimp, Klaviyo, ActiveCampaign, Brevo, Kit and MailerLite: lists, unsubscribes and bounces come first." },
            { title: "Forms and meetings", text: "Typeform, Tally, Webflow, Calendly, Cal.com or any tool that posts JSON: a signup lands on a contact in seconds." },
          ]}
        />
      ) : null}
      {list.length ? (
        <Panel>
          <CardHead label="Connected" count={list.length} />
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const e = entryOf(s.kind);
              const [label, tone] = STATE[s.status] ?? [s.status, "gray" as Tone];
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => pick(s.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-hover">
                    <BrandLogo domain={e?.domain ?? ""} name={s.name} size={22} />
                    <span className="font-medium">{s.name}</span>
                    {s.account ? <span className="truncate font-mono text-[11px] text-faint">{s.account}</span> : null}
                    <span className="ml-auto flex items-center gap-3">
                      {s.last_error && s.status !== "disconnected" ? <span className="max-w-[280px] truncate text-[12px] text-red-600">{s.last_error}</span> : null}
                      <span className="text-[12px] text-faint">{timeAgo(s.last_run_at)}</span>
                      <Badge tone={tone}>{label}</Badge>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}
      <div className="flex items-center gap-3">
        <span className="label-mono">Add a tool</span>
        <div className="ml-auto w-56">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search tools" />
        </div>
      </div>
      {GROUPS.map((g) => {
        const items = shown.filter((e) => e.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="flex flex-col gap-2">
            <h3 className="label-mono text-faint">{g.label}</h3>
            <div className="grid grid-cols-2 border-t border-l border-line sm:grid-cols-3 lg:grid-cols-4">
              {items.map((e) => {
                const on = connected.get(e.kind);
                return (
                  <button
                    key={e.kind}
                    type="button"
                    disabled={!owner && !on}
                    onClick={() => (on ? pick(on.id) : setConnect(e))}
                    className="flex items-center gap-3 border-r border-b border-line bg-panel px-4 py-3.5 text-left text-[13px] hover:bg-hover disabled:cursor-default disabled:hover:bg-panel"
                  >
                    <BrandLogo domain={e.domain} name={e.label} size={22} />
                    <span className="font-medium">{e.label}</span>
                    <span className="ml-auto flex gap-1">
                      {on ? <Badge tone={STATE[on.status]?.[1] ?? "gray"}>{STATE[on.status]?.[0] ?? on.status}</Badge> : e.twoWay ? <Badge>Two-way</Badge> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {connect ? (
        <ConnectPanel
          session={session}
          wsId={ws.id}
          entry={connect}
          onClose={(id) => {
            setConnect(null);
            if (id) {
              sources.reload();
              pick(id);
            }
          }}
          onError={setError}
        />
      ) : null}
      {open && list.some((s) => s.id === open) ? (
        <SourcePanel
          sb={sb}
          session={session}
          wsId={ws.id}
          source={list.find((s) => s.id === open)!}
          owner={owner}
          onClose={() => pick(null)}
          changed={sources.reload}
        />
      ) : null}
    </div>
  );
}

// Connecting -------------------------------------------------------------------------------------------------

function ConnectPanel({ session, wsId, entry, onClose, onError }: { session: ViewProps["session"]; wsId: string; entry: Entry; onClose: (id?: string) => void; onError: (e: string) => void }) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [useKey, setUseKey] = useState(!entry.oauth && entry.kind !== "omniscient");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (body: object) => {
    setBusy(true);
    setError("");
    try {
      const r = await postJson<{ url?: string; id?: string }>(session, "/api/sources/connect", { workspaceId: wsId, kind: entry.kind, ...body });
      if (r.url) window.location.href = r.url;
      else onClose(r.id);
    } catch (e) {
      setError(errorText(e));
      onError("");
    } finally {
      setBusy(false);
    }
  };
  const signIn = entry.oauth || entry.kind === "omniscient";
  return (
    <SidePanel title={entry.label} onClose={() => onClose()} footer={null}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-3">
          <BrandLogo domain={entry.domain} name={entry.label} size={32} />
          <span className="text-[15px] font-medium">{entry.label}</span>
          {entry.twoWay ? <Badge>Two-way</Badge> : null}
        </div>
        <ErrorNote message={error} />
        {signIn && !useKey ? (
          <div className="flex flex-col items-start gap-3">
            <Button onClick={() => run({})} disabled={busy}>
              <Plug size={14} />
              {busy ? "Opening…" : `Connect ${entry.label}`}
            </Button>
            {entry.keys?.length ? (
              <button type="button" className="text-[12px] text-muted underline-offset-2 hover:underline" onClick={() => setUseKey(true)}>
                Use a key instead
              </button>
            ) : null}
          </div>
        ) : entry.hook ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ hookSecret: secret });
            }}
          >
            {entry.hookSecret ? (
              <Field label="Signing secret">
                <Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" autoComplete="off" />
              </Field>
            ) : null}
            <div>
              <Button type="submit" disabled={busy}>
                {busy ? "Connecting…" : "Get the webhook URL"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ keys });
            }}
          >
            {(entry.keys ?? []).map((k) => (
              <Field key={k.key} label={k.label}>
                <Input value={keys[k.key] ?? ""} onChange={(e) => setKeys({ ...keys, [k.key]: e.target.value })} type={k.secret ? "password" : "text"} placeholder={k.placeholder} autoComplete="off" />
              </Field>
            ))}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy || (entry.keys ?? []).some((k) => !keys[k.key]?.trim())}>
                {busy ? "Checking…" : "Connect"}
              </Button>
              {signIn ? (
                <button type="button" className="text-[12px] text-muted underline-offset-2 hover:underline" onClick={() => setUseKey(false)}>
                  Sign in instead
                </button>
              ) : null}
            </div>
          </form>
        )}
      </div>
    </SidePanel>
  );
}

// One source -------------------------------------------------------------------------------------------------

function SourcePanel({ sb, session, wsId, source, owner, onClose, changed }: { sb: ViewProps["sb"]; session: ViewProps["session"]; wsId: string; source: Source; owner: boolean; onClose: () => void; changed: () => void }) {
  const e = entryOf(source.kind);
  const [settings, setSettings] = useState(source.settings);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const runs = useLoad(async () => must(await sb.from("source_runs").select("id, object, direction, started_at, finished_at, pulled, written, skipped, errors, error").eq("source_id", source.id).order("started_at", { ascending: false }).limit(20)) as Run[], source.id);
  const hook = useLoad(async () => (e?.hook && owner && source.status !== "disconnected" ? (await getJson<{ url: string }>(session, `/api/sources/hook-url?id=${source.id}`)).url : null), source.id);
  const [state, tone] = STATE[source.status] ?? [source.status, "gray" as Tone];
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      changed();
      runs.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const objects = settings.objects ?? {};
  const setObject = (o: string, v: string) => setSettings({ ...settings, objects: { ...objects, [o]: v } });

  return (
    <SidePanel title={source.name} wide onClose={onClose} footer={null}>
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <BrandLogo domain={e?.domain ?? ""} name={source.name} size={32} />
          <div className="flex flex-col">
            <span className="text-[15px] font-medium">{source.name}</span>
            {source.account ? <span className="font-mono text-[11px] text-faint">{source.account}</span> : null}
          </div>
          <Badge tone={tone}>{state}</Badge>
          <span className="ml-auto flex gap-1.5">
            {source.status !== "disconnected" && !e?.hook ? (
              <Button variant="ghost" className="h-8 px-2.5" onClick={() => act(async () => must(await sb.rpc("source_sync_now", { p_id: source.id })))} disabled={source.status === "paused"}>
                <Refresh size={14} />
                Sync now
              </Button>
            ) : null}
            {owner && source.status !== "disconnected" ? (
              <Button variant="ghost" className="h-8 px-2.5" onClick={() => act(async () => must(await sb.rpc("source_pause", { p_id: source.id, p_paused: source.status !== "paused" })))}>
                {source.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                {source.status === "paused" ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {owner && source.status !== "disconnected" ? (
              <Button
                variant="danger"
                className="h-8 px-2.5"
                onClick={() =>
                  act(async () => {
                    if (!(await askConfirm(`Disconnect ${source.name}?`, { ok: "Disconnect", danger: true }))) return;
                    must(await sb.rpc("source_disconnect", { p_id: source.id }));
                  })
                }
              >
                Disconnect
              </Button>
            ) : null}
          </span>
        </div>
        <ErrorNote message={error || (source.status !== "disconnected" ? (source.last_error ?? "") : "")} />

        {hook.data ? (
          <Field label="Webhook URL">
            <div className="flex gap-1.5">
              <Input readOnly value={hook.data} className="font-mono text-[12px]" onFocus={(ev) => ev.currentTarget.select()} />
              <Button variant="ghost" className="h-9 px-2.5" onClick={() => void navigator.clipboard.writeText(hook.data!)} aria-label="Copy">
                <Copy size={14} />
              </Button>
            </div>
          </Field>
        ) : null}

        {owner && source.status !== "disconnected" ? (
          <Panel>
            <CardHead label="Sync" />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              {(e?.objects ?? []).map((o) => (
                <Field key={o} label={OBJECT_LABEL[o] ?? o}>
                  <Select
                    className={SEL}
                    value={objects[o] ?? (o === "companies" ? "off" : "in")}
                    onChange={(v) => setObject(o, v)}
                    options={[...(o === "contacts" && e?.twoWay ? [{ value: "both", label: "Both ways" }] : []), { value: "in", label: "In only" }, { value: "off", label: "Off" }]}
                  />
                </Field>
              ))}
              {!e?.hook ? (
                <Field label="Schedule">
                  <Select className={SEL} value={settings.every_min ?? 60} onChange={(v) => setSettings({ ...settings, every_min: v })} options={EVERY} />
                </Field>
              ) : null}
              <Field label="Email consent when the tool doesn't say">
                <Select className={SEL} value={settings.basis ?? "none"} onChange={(v) => setSettings({ ...settings, basis: v })} options={BASES} />
              </Field>
              {e?.twoWay && objects.contacts === "both" ? (
                <Field label={`New contacts to ${source.name}`}>
                  <Select
                    className={SEL}
                    value={settings.push_new ?? "lifecycle"}
                    onChange={(v) => setSettings({ ...settings, push_new: v })}
                    options={[
                      { value: "all", label: "All contacts" },
                      { value: "lifecycle", label: "With a lifecycle stage" },
                      { value: "none", label: "Only ones already there" },
                    ]}
                  />
                </Field>
              ) : null}
              {!e?.hook ? (
                <Field label="When a contact is deleted there">
                  <Select
                    className={SEL}
                    value={settings.follow_deletes ? "delete" : "keep"}
                    onChange={(v) => setSettings({ ...settings, follow_deletes: v === "delete" })}
                    options={[
                      { value: "keep", label: "Keep it here" },
                      { value: "delete", label: "Delete it here" },
                    ]}
                  />
                </Field>
              ) : null}
            </div>
            <div className="flex items-center gap-3 border-t border-line px-4 py-3">
              <Button
                onClick={() =>
                  act(async () => {
                    must(await sb.rpc("source_settings_save", { p_id: source.id, p_name: source.name, p_settings: settings }));
                    setSaved(true);
                  })
                }
              >
                Save
              </Button>
              {saved ? <span className="text-[12px] text-faint">Saved</span> : null}
            </div>
          </Panel>
        ) : null}

        {source.status !== "disconnected" ? <MappingPanel sb={sb} session={session} wsId={wsId} source={source} owner={owner} hasCompanies={!!e?.objects.includes("companies")} /> : null}

        <Panel>
          <CardHead label="Runs" count={runs.data?.length} />
          {!runs.data ? (
            <Loading />
          ) : !runs.data.length ? (
            <p className="px-4 py-3 text-[13px] text-faint">—</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>What</Th>
                    <Th className="text-right">Read</Th>
                    <Th className="text-right">Written</Th>
                    <Th className="text-right">Unchanged</Th>
                    <Th className="text-right">Errors</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <Td className="whitespace-nowrap text-faint">{timeAgo(r.started_at)}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <Badge tone={r.direction === "out" ? "violet" : "brand"}>{r.direction === "out" ? "Out" : "In"}</Badge>
                          {OBJECT_LABEL[r.object] ?? r.object}
                          {r.error ? <span className="max-w-[240px] truncate text-[12px] text-red-600">{r.error}</span> : null}
                        </span>
                      </Td>
                      <Td className="text-right font-mono">{r.pulled.toLocaleString("en-US")}</Td>
                      <Td className="text-right font-mono">{r.written.toLocaleString("en-US")}</Td>
                      <Td className="text-right font-mono">{r.skipped.toLocaleString("en-US")}</Td>
                      <Td className="text-right font-mono">{r.errors.toLocaleString("en-US")}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </SidePanel>
  );
}

const COMPANY_TARGETS = [
  { value: "skip", label: "Skip" },
  { value: "name", label: "Name" },
  { value: "domain", label: "Domain" },
  { value: "industry", label: "Industry" },
  { value: "size", label: "Size" },
  { value: "country", label: "Country" },
];

function MappingPanel({ sb, session, wsId, source, owner, hasCompanies }: { sb: ViewProps["sb"]; session: ViewProps["session"]; wsId: string; source: Source; owner: boolean; hasCompanies: boolean }) {
  const [object, setObject] = useState<"contact" | "company">("contact");
  const data = useLoad(async () => getJson<{ contact: MapRow[]; company: MapRow[] }>(session, `/api/sources/mapping?id=${source.id}`), source.id);
  const custom = useLoad(async () => must(await sb.from("fields").select("key, label").eq("workspace_id", wsId).eq("object", "contact").order("position")) as { key: string; label: string }[], wsId);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState("");
  const rows = (data.data?.[object] ?? []).map((r) => ({ ...r, target: edits[object]?.[r.col] ?? r.target }));
  const options =
    object === "contact"
      ? [...TARGETS.filter((t) => t.value !== "basis"), ...(custom.data ?? []).map((f) => ({ value: `f.${f.key}` as Target, label: f.label }))]
      : COMPANY_TARGETS;
  const choose = (col: string, t: string) => {
    const mine = { ...(edits[object] ?? {}), [col]: t };
    // One column per field.
    if (t !== "skip") for (const r of rows) if (r.col !== col && (mine[r.col] ?? r.target) === t) mine[r.col] = "skip";
    setEdits({ ...edits, [object]: mine });
  };
  const save = async () => {
    setError("");
    try {
      must(await sb.rpc("mapping_save", { p_source: source.id, p_object: object, p_rows: rows.filter((r) => r.target !== "skip").map((r) => ({ col: r.col, target: r.target })) }));
      setEdits({ ...edits, [object]: {} });
      data.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Panel>
      <CardHead label="Fields">
        {hasCompanies ? (
          <span className="ml-auto flex gap-1">
            {(["contact", "company"] as const).map((o) => (
              <button key={o} type="button" onClick={() => setObject(o)} className={`h-6 rounded-md px-2 text-[12px] ${object === o ? "bg-ink text-white" : "text-muted hover:bg-hover"}`}>
                {o === "contact" ? "Contacts" : "Companies"}
              </button>
            ))}
          </span>
        ) : null}
      </CardHead>
      <ErrorNote message={error} />
      {!data.data ? (
        <Loading />
      ) : !rows.length ? (
        <p className="px-4 py-3 text-[13px] text-faint">—</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>{source.name}</Th>
              <Th>Sample</Th>
              <Th>Field</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.col} className="border-t border-line">
                <Td className="font-mono text-[12px]">{r.col}</Td>
                <Td className="max-w-[220px] truncate text-muted">{r.sample || "—"}</Td>
                <Td className="w-56">
                  <Select className={`${SEL} h-8 ${r.target === "skip" ? "text-faint" : ""}`} value={r.target} onChange={(v) => choose(r.col, v)} options={options as { value: string; label: string }[]} disabled={!owner} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {owner && Object.keys(edits[object] ?? {}).length ? (
        <div className="border-t border-line px-4 py-3">
          <Button onClick={save}>Save fields</Button>
        </div>
      ) : null}
    </Panel>
  );
}

// Sync log ---------------------------------------------------------------------------------------------------

type LogRow = { id: number; source_id: string; direction: string; object: string; local_id: string | null; external_id: string | null; action: string; fields: string[]; error: string | null; retried_at: string | null; at: string };
const ACTION: Record<string, [string, Tone]> = { create: ["Created", "green"], update: ["Updated", "brand"], delete: ["Deleted", "gray"], suppress: ["Unsubscribed", "amber"], error: ["Error", "red"] };

export function SyncLog({ sb, ws, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate">) {
  const [source, setSource] = useState("");
  const [direction, setDirection] = useState("");
  const [action, setAction] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const sources = useLoad(async () => must(await sb.from("sources").select("id, kind, name").eq("workspace_id", ws.id).order("created_at")) as { id: string; kind: string; name: string }[], ws.id);
  const rows = useLoad(async () => {
    let q = sb.from("sync_log").select("id, source_id, direction, object, local_id, external_id, action, fields, error, retried_at, at").eq("workspace_id", ws.id).order("id", { ascending: false }).limit(300);
    if (source) q = q.eq("source_id", source);
    if (direction) q = q.eq("direction", direction);
    if (action) q = q.eq("action", action);
    return must(await q) as LogRow[];
  }, `${ws.id}:${source}:${direction}:${action}`);
  const byId = new Map((sources.data ?? []).map((s) => [s.id, s]));
  const retry = async () => {
    setError("");
    try {
      must(await sb.rpc("sync_retry", { p_ids: [...picked] }));
      setPicked(new Set());
      rows.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Select className={`${SEL} !w-48`} value={source} onChange={setSource} options={[{ value: "", label: "All sources" }, ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        <Select className={`${SEL} !w-36`} value={direction} onChange={setDirection} options={[{ value: "", label: "In and out" }, { value: "in", label: "In" }, { value: "out", label: "Out" }]} />
        <Select className={`${SEL} !w-40`} value={action} onChange={setAction} options={[{ value: "", label: "Every change" }, ...Object.entries(ACTION).map(([value, [label]]) => ({ value, label }))]} />
        {picked.size ? (
          <Button className="ml-auto" onClick={retry}>
            <Refresh size={14} />
            Retry {picked.size}
          </Button>
        ) : null}
      </div>
      <Panel>
        {!rows.data ? (
          <Loading />
        ) : !rows.data.length ? (
          <p className="px-4 py-3 text-[13px] text-faint">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>{""}</Th>
                  <Th>When</Th>
                  <Th>Source</Th>
                  <Th>Change</Th>
                  <Th>Fields</Th>
                  <Th>Record</Th>
                </tr>
              </thead>
              <tbody>
                {rows.data.map((r) => {
                  const s = byId.get(r.source_id);
                  const [label, tone] = ACTION[r.action] ?? [r.action, "gray" as Tone];
                  const canRetry = r.action === "error" && r.direction === "out" && !r.retried_at;
                  return (
                    <tr key={r.id} className="border-t border-line">
                      <Td className="w-8">
                        {canRetry ? (
                          <CheckBox
                            label="Pick"
                            on={picked.has(r.id)}
                            onClick={() => {
                              const n = new Set(picked);
                              if (n.has(r.id)) n.delete(r.id);
                              else n.add(r.id);
                              setPicked(n);
                            }}
                          />
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-faint">{timeAgo(r.at)}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <BrandLogo domain={entryOf(s?.kind ?? "")?.domain ?? ""} name={s?.name ?? "?"} size={16} />
                          {s?.name ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <Badge tone={r.direction === "out" ? "violet" : "brand"}>{r.direction === "out" ? "Out" : "In"}</Badge>
                          <Badge tone={tone}>{label}</Badge>
                          {r.error ? <span className="max-w-[260px] truncate text-[12px] text-red-600">{r.error}</span> : null}
                        </span>
                      </Td>
                      <Td className="max-w-[260px] truncate font-mono text-[11px] text-muted">{r.fields.join(", ") || "—"}</Td>
                      <Td>
                        {r.local_id && r.object === "contact" ? (
                          <button type="button" className="text-[12px] underline-offset-2 hover:underline" onClick={() => navigate("contacts", r.local_id!)}>
                            Open
                          </button>
                        ) : (
                          <span className="font-mono text-[11px] text-faint">{r.external_id ?? "—"}</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
