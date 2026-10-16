"use client";

// Segments (docs/conversion-parity.md Part 10): groups of contacts by any rule, AND and OR up to 3 levels deep,
// with a live count and ten of the people while editing. Dynamic segments refresh hourly; lists from a tool are
// static segments and show here too.

import { useEffect, useRef, useState } from "react";
import { describe, type Filter } from "@/lib/filters";
import { filterFields } from "@/lib/records/fields";
import { Plus, Refresh, Trash, Users, X } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { FilterEditor, Popover } from "../FilterBar";
import { Select } from "../Select";
import { SampleStats, ToolIntro } from "../ToolIntro";
import { Badge, Button, CardHead, Empty, ErrorNote, errorText, Input, Loading, must, Page, Panel, Segmented, Td, Th, timeAgo, useLoad, type ViewProps } from "../ui";
import { useMeta } from "../records/meta";

type Group = { op: "and" | "or"; rules: Node[] };
type Leaf =
  | ({ kind: "field" } & Filter)
  | { kind: "event"; event: string; op: "at_least" | "none"; count?: number; days: number }
  | { kind: "visit"; path?: string; op: "at_least" | "none"; count?: number; days: number }
  | { kind: "consent"; state: "sendable" | "not_sendable" | "suppressed" }
  | { kind: "source"; source_id: string; op: "in" | "not_in" }
  | { kind: "object"; object: string; op: "has" | "has_not"; filters: Filter[] };
type Node = Group | Leaf;
type Segment = { id: string; name: string; kind: "dynamic" | "static"; rules: Group | Record<string, never>; count: number; refreshed_at: string | null; error: string | null; source_id: string | null };
type Ctx = { sb: ViewProps["sb"]; wsId: string; sources: { value: string; label: string }[]; objects: { value: string; label: string }[] };

const SEL = "h-8 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const isGroup = (n: Node): n is Group => "rules" in n;
const EVENTS = [
  { value: "email.clicked", label: "Clicked an email" },
  { value: "email.opened", label: "Opened an email" },
  { value: "form.submitted", label: "Filled a form" },
  { value: "meeting.booked", label: "Booked a meeting" },
  { value: "webinar.attended", label: "Attended a webinar" },
  { value: "contact.created", label: "Became a contact" },
  { value: "segment.entered", label: "Joined a segment" },
];
const KINDS = [
  { value: "field", label: "Field" },
  { value: "event", label: "Activity" },
  { value: "visit", label: "Website visit" },
  { value: "consent", label: "Email consent" },
  { value: "source", label: "Source" },
  { value: "object", label: "Custom object" },
];

function fresh(kind: string, ctx: Ctx): Leaf | null {
  if (kind === "event") return { kind: "event", event: "email.clicked", op: "at_least", count: 1, days: 30 };
  if (kind === "visit") return { kind: "visit", path: "", op: "at_least", count: 1, days: 30 };
  if (kind === "consent") return { kind: "consent", state: "sendable" };
  if (kind === "source") return ctx.sources[0] ? { kind: "source", source_id: ctx.sources[0].value, op: "in" } : null;
  if (kind === "object") return ctx.objects[0] ? { kind: "object", object: ctx.objects[0].value, op: "has", filters: [] } : null;
  return null;
}

export function SegmentsView({ sb, ws, id, navigate }: ViewProps) {
  if (id) return <SegmentPage key={id} sb={sb} ws={ws} id={id} navigate={navigate} />;
  return <SegmentList sb={sb} ws={ws} navigate={navigate} />;
}

function SegmentList({ sb, ws, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate">) {
  const list = useLoad(async () => must(await sb.from("segments").select("id, name, kind, count, refreshed_at, error, source_id").eq("workspace_id", ws.id).order("name")) as Segment[], ws.id);
  const add = (
    <Button onClick={() => navigate("segments", "new")}>
      <Plus size={14} />
      New segment
    </Button>
  );
  return (
    <Page icon={<Users size={16} />} title="Segments" count={list.data?.length} actions={list.data?.length ? add : undefined}>
      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <ToolIntro
          action={add}
          title="Group contacts by anything you know"
          lead="Mix fields, activity, website visits, consent, sources and custom objects, with AND and OR. The count updates as you build, and members update every hour."
          features={[
            { title: "Any rule", text: "“Read pricing twice this week and can be emailed”, or “Customers with a subscription over 10 seats”.", visual: <SampleStats items={[["rules", "30+"], ["levels", "3"], ["count", "live"]]} /> },
            { title: "Lists from your tools", text: "HubSpot lists and email audiences come in as segments, kept up to date." },
            { title: "Ready for journeys", text: "Joining or leaving a segment is recorded on the contact, so journeys can start from it." },
          ]}
        />
      ) : (
        <Panel>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th className="text-right">Contacts</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="cursor-pointer border-t border-line hover:bg-hover" onClick={() => navigate("segments", s.id)}>
                  <Td className="font-medium">
                    <span className="flex items-center gap-2">
                      {s.name}
                      {s.error ? <span className="truncate text-[12px] font-normal text-red-600">{s.error}</span> : null}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={s.kind === "dynamic" ? "brand" : "gray"}>{s.kind === "dynamic" ? "Dynamic" : "List"}</Badge>
                  </Td>
                  <Td className="text-right font-mono">{s.count.toLocaleString("en-US")}</Td>
                  <Td className="text-faint">{timeAgo(s.refreshed_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Page>
  );
}

function SegmentPage({ sb, ws, id, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate"> & { id: string }) {
  const isNew = id === "new";
  const seg = useLoad(async () => (isNew ? null : (must(await sb.from("segments").select("id, name, kind, rules, count, refreshed_at, error, source_id").eq("id", id).maybeSingle()) as Segment | null)), id);
  const extra = useLoad(async () => {
    const [s, o] = await Promise.all([
      sb.from("sources").select("id, name").eq("workspace_id", ws.id).neq("status", "disconnected").order("name"),
      sb.from("objects").select("key, plural").eq("workspace_id", ws.id).order("plural"),
    ]);
    return {
      sources: ((s.data ?? []) as { id: string; name: string }[]).map((x) => ({ value: x.id, label: x.name })),
      objects: ((o.data ?? []) as { key: string; plural: string }[]).map((x) => ({ value: x.key, label: x.plural })),
    };
  }, ws.id);
  if ((!isNew && seg.data === undefined) || !extra.data) return <Loading />;
  if (!isNew && !seg.data) return <Empty title="Segment not found" />;
  return <Builder sb={sb} wsId={ws.id} seg={seg.data ?? null} ctx={{ sb, wsId: ws.id, ...extra.data }} navigate={navigate} reload={seg.reload} />;
}

function Builder({ sb, wsId, seg, ctx, navigate, reload }: { sb: ViewProps["sb"]; wsId: string; seg: Segment | null; ctx: Ctx; navigate: ViewProps["navigate"]; reload: () => void }) {
  const isList = seg?.kind === "static";
  const start: Group = seg && "rules" in (seg.rules ?? {}) ? (seg.rules as Group) : { op: "and", rules: [] };
  const [name, setName] = useState(seg?.name ?? "");
  const [rules, setRules] = useState<Group>(isList ? { op: "and", rules: [{ kind: "field", field: "segment", op: "is", values: [seg!.id] }] } : start);
  const [live, setLive] = useState<{ count: number; sample: { id: string; email: string; name: string | null; company: string | null }[] } | null>(null);
  const [liveError, setLiveError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const meta = useMeta(sb, wsId, "contact");
  const ticket = useRef(0);

  useEffect(() => {
    const mine = ++ticket.current;
    const t = setTimeout(async () => {
      const { data, error: e } = await sb.rpc("segment_preview", { p_ws: wsId, p_rules: rules });
      if (mine !== ticket.current) return;
      if (e) {
        setLiveError(e.message);
        return;
      }
      setLiveError("");
      setLive(data as never);
    }, 400);
    return () => clearTimeout(t);
  }, [sb, wsId, rules]);

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const sid = must(await sb.rpc("segment_save", { p_ws: wsId, p_id: seg?.id ?? null, p_name: name, p_rules: rules })) as string;
      if (!seg) navigate("segments", sid);
      else reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      icon={<Users size={16} />}
      title={seg?.name ?? "New segment"}
      actions={
        <span className="flex gap-1.5">
          <Button variant="ghost" onClick={() => navigate("segments")}>
            Segments
          </Button>
          {seg && !isList ? (
            <Button variant="ghost" onClick={() => void sb.rpc("segment_refresh_now", { p_id: seg.id }).then(reload)}>
              <Refresh size={14} />
              Refresh
            </Button>
          ) : null}
          {seg ? (
            <Button
              variant="danger"
              onClick={async () => {
                if (!(await askConfirm(`Delete ${seg.name}?`, { ok: "Delete", danger: true }))) return;
                const { error: e } = await sb.rpc("segment_delete", { p_id: seg.id });
                if (e) setError(e.message);
                else navigate("segments");
              }}
            >
              <Trash size={14} />
              Delete
            </Button>
          ) : null}
        </span>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <ErrorNote message={error || seg?.error || ""} />
          {!isList ? (
            <>
              <div className="flex items-center gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Segment name" maxLength={120} className="max-w-md" />
                <Button onClick={save} disabled={busy || !name.trim()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
              <GroupEditor node={rules} depth={1} ctx={ctx} fields={meta.data ? filterFields(meta.data.fields) : []} anyFields={meta.data ? (filterFields(meta.data.fields) as never) : []} onChange={setRules} />
            </>
          ) : (
            <Panel>
              <CardHead label="List" />
              <p className="px-4 py-3 text-[13px] text-muted">{ctx.sources.find((s) => s.value === seg?.source_id)?.label ?? "Added by hand"}</p>
            </Panel>
          )}
        </div>
        <Panel className="self-start">
          <CardHead label="Matches" count={live ? live.count.toLocaleString("en-US") : undefined} />
          <ErrorNote message={liveError} />
          {!live ? (
            <Loading />
          ) : !live.sample.length ? (
            <p className="px-4 py-3 text-[13px] text-faint">—</p>
          ) : (
            <ul className="divide-y divide-line">
              {live.sample.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => navigate("contacts", c.id)} className="flex w-full flex-col px-4 py-2 text-left hover:bg-hover">
                    <span className="truncate text-[13px] font-medium">{c.name ?? c.email}</span>
                    <span className="truncate text-[12px] text-faint">{[c.name ? c.email : null, c.company].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Page>
  );
}

type EditorProps = { ctx: Ctx; fields: ReturnType<typeof filterFields>; anyFields: Parameters<typeof FilterEditor>[0]["fields"] };

function GroupEditor({ node, depth, onChange, onRemove, ...p }: EditorProps & { node: Group; depth: number; onChange: (g: Group) => void; onRemove?: () => void }) {
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const set = (i: number, n: Node | null) => onChange({ ...node, rules: n ? node.rules.map((x, j) => (j === i ? n : x)) : node.rules.filter((_, j) => j !== i) });
  return (
    <div className={`flex flex-col gap-2 border border-line p-3 ${depth > 1 ? "bg-canvas" : "bg-panel"}`}>
      <div className="flex items-center gap-2">
        <Segmented<"and" | "or">
          value={node.op}
          onChange={(op) => onChange({ ...node, op })}
          label="Match"
          options={[
            { value: "and", label: "All of" },
            { value: "or", label: "Any of" },
          ]}
        />
        {onRemove ? (
          <button type="button" aria-label="Remove group" onClick={onRemove} className="ml-auto flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink">
            <X size={14} />
          </button>
        ) : null}
      </div>
      {node.rules.map((r, i) =>
        isGroup(r) ? (
          <GroupEditor key={i} node={r} depth={depth + 1} onChange={(g) => set(i, g)} onRemove={() => set(i, null)} {...p} />
        ) : (
          <RuleRow key={i} rule={r} onChange={(n) => set(i, n)} onRemove={() => set(i, null)} {...p} />
        ),
      )}
      <div className="flex gap-1.5">
        <Button variant="ghost" className="h-8 px-2.5" onClick={(e) => setAdding(e.currentTarget)}>
          <Plus size={14} />
          Rule
        </Button>
        {depth < 3 ? (
          <Button variant="ghost" className="h-8 px-2.5" onClick={() => onChange({ ...node, rules: [...node.rules, { op: node.op === "and" ? "or" : "and", rules: [] }] })}>
            <Plus size={14} />
            Group
          </Button>
        ) : null}
      </div>
      {adding ? (
        <Popover anchor={adding} onClose={() => setAdding(null)}>
          <FilterEditor
            fields={p.anyFields}
            start={null}
            onDone={(f) => {
              if (f) onChange({ ...node, rules: [...node.rules, { kind: "field", ...f }] });
              setAdding(null);
            }}
          />
          <div className="flex flex-wrap gap-1 border-t border-line p-2">
            {KINDS.filter((k) => k.value !== "field").map((k) => {
              const leaf = fresh(k.value, p.ctx);
              return leaf ? (
                <button
                  key={k.value}
                  type="button"
                  className="h-7 rounded-md border border-line px-2 text-[12px] hover:border-ink"
                  onClick={() => {
                    onChange({ ...node, rules: [...node.rules, leaf] });
                    setAdding(null);
                  }}
                >
                  {k.label}
                </button>
              ) : null;
            })}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

const num = (v: string, fallback: number) => (/^\d{1,4}$/.test(v) ? Number(v) : fallback);

function RuleRow({ rule, onChange, onRemove, ctx, fields, anyFields }: EditorProps & { rule: Leaf; onChange: (l: Leaf) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<HTMLElement | null>(null);
  let body: React.ReactNode = null;
  if (rule.kind === "field") {
    const f = fields.find((x) => x.key === rule.field);
    body = (
      <>
        <button type="button" onClick={(e) => setEditing(e.currentTarget)} className="h-8 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-ink">
          {describe(rule, f as never)}
        </button>
        {editing ? (
          <Popover anchor={editing} onClose={() => setEditing(null)}>
            <FilterEditor
              fields={anyFields}
              start={rule}
              onDone={(x) => {
                if (x) onChange({ kind: "field", ...x });
                setEditing(null);
              }}
            />
          </Popover>
        ) : null}
      </>
    );
  } else if (rule.kind === "event" || rule.kind === "visit") {
    body = (
      <>
        <Select
          className={SEL}
          value={rule.op}
          onChange={(op) => onChange({ ...rule, op })}
          options={[
            { value: "at_least", label: rule.kind === "event" ? "Did" : "Visited" },
            { value: "none", label: rule.kind === "event" ? "Didn't" : "Didn't visit" },
          ]}
        />
        {rule.kind === "event" ? (
          <Select className={SEL} value={rule.event} onChange={(event) => onChange({ ...rule, event })} options={EVENTS} />
        ) : (
          <Input className="h-8 !w-44" value={rule.path ?? ""} onChange={(e) => onChange({ ...rule, path: e.target.value.slice(0, 300) })} placeholder="/pricing or /blog/*" aria-label="Page" />
        )}
        {rule.op === "at_least" ? (
          <>
            <Input className="h-8 !w-14 text-right" value={String(rule.count ?? 1)} onChange={(e) => onChange({ ...rule, count: num(e.target.value, 1) })} aria-label="Times" />
            <span className="text-[13px] text-muted">or more times</span>
          </>
        ) : null}
        <span className="text-[13px] text-muted">in</span>
        <Input className="h-8 !w-16 text-right" value={String(rule.days)} onChange={(e) => onChange({ ...rule, days: num(e.target.value, 30) })} aria-label="Days" />
        <span className="text-[13px] text-muted">days</span>
      </>
    );
  } else if (rule.kind === "consent") {
    body = (
      <Select
        className={SEL}
        value={rule.state}
        onChange={(state) => onChange({ ...rule, state })}
        options={[
          { value: "sendable", label: "Can be emailed" },
          { value: "not_sendable", label: "Can't be emailed" },
          { value: "suppressed", label: "Unsubscribed or bounced" },
        ]}
      />
    );
  } else if (rule.kind === "source") {
    body = (
      <>
        <Select
          className={SEL}
          value={rule.op}
          onChange={(op) => onChange({ ...rule, op })}
          options={[
            { value: "in", label: "In" },
            { value: "not_in", label: "Not in" },
          ]}
        />
        <Select className={SEL} value={rule.source_id} onChange={(source_id) => onChange({ ...rule, source_id })} options={ctx.sources} />
      </>
    );
  } else if (rule.kind === "object") {
    body = <ObjectRule rule={rule} onChange={onChange} ctx={ctx} />;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="label-mono w-32 shrink-0 whitespace-nowrap text-faint">{KINDS.find((k) => k.value === rule.kind)?.label}</span>
      {body}
      <button type="button" aria-label="Remove rule" onClick={onRemove} className="ml-auto flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}

function ObjectRule({ rule, onChange, ctx }: { rule: Extract<Leaf, { kind: "object" }>; onChange: (l: Leaf) => void; ctx: Ctx }) {
  const meta = useMeta(ctx.sb, ctx.wsId, rule.object);
  const [editing, setEditing] = useState<{ anchor: HTMLElement; index: number | null } | null>(null);
  const fields = meta.data ? filterFields(meta.data.fields) : [];
  return (
    <>
      <Select
        className={SEL}
        value={rule.op}
        onChange={(op) => onChange({ ...rule, op })}
        options={[
          { value: "has", label: "Has" },
          { value: "has_not", label: "Has no" },
        ]}
      />
      <Select className={SEL} value={rule.object} onChange={(object) => onChange({ ...rule, object, filters: [] })} options={ctx.objects} />
      {rule.filters.map((f, i) => (
        <span key={i} className="inline-flex h-8 items-center gap-1 border border-line bg-panel pr-1 pl-2.5 text-[13px]">
          <button type="button" onClick={(e) => setEditing({ anchor: e.currentTarget, index: i })}>
            {describe(f, fields.find((x) => x.key === f.field) as never)}
          </button>
          <button type="button" aria-label="Remove" onClick={() => onChange({ ...rule, filters: rule.filters.filter((_, j) => j !== i) })} className="text-faint hover:text-ink">
            <X size={12} />
          </button>
        </span>
      ))}
      <Button variant="ghost" className="h-8 px-2" onClick={(e) => setEditing({ anchor: e.currentTarget, index: null })} aria-label="Add a condition">
        <Plus size={14} />
      </Button>
      {editing && meta.data ? (
        <Popover anchor={editing.anchor} onClose={() => setEditing(null)}>
          <FilterEditor
            fields={fields as never}
            start={editing.index === null ? null : rule.filters[editing.index]}
            onDone={(f) => {
              if (f) onChange({ ...rule, filters: editing.index === null ? [...rule.filters, f] : rule.filters.map((x, j) => (j === editing.index ? f : x)) });
              setEditing(null);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}
