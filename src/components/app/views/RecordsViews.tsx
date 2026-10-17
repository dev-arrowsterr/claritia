"use client";

// Companies, Opportunities and custom objects (docs/conversion-parity.md Part 7): lists on the shared records list,
// and a record page with editable fields in sections, links both ways, and the change history. A company page also
// holds its opportunities and what it does on your site; an opportunity page leads with amount, stage and close date.

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shown, type AnyField } from "@/lib/records/fields";
import { Box, Dollar, Eye, Users } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Avatar, Badge, Button, CardHead, ErrorNote, errorText, Loading, must, Page, Panel, timeAgo, useLoad, type ViewProps } from "../ui";
import type { Link } from "../records/FieldInput";
import { useMeta } from "../records/meta";
import { FieldsPanel, HistoryPanel, type Change } from "../records/RecordParts";
import { RecordsList, type ViewState } from "../records/RecordsList";
import { DEFAULT_WIDTH, type Row } from "../records/RecordTable";
import { AccountActivity, AccountFeedback } from "./AccountActivity";
import { VisitorsView } from "./VisitorsView";

const cols = (...keys: string[]) => keys.map((key) => ({ key, width: DEFAULT_WIDTH }));

const COMPANIES_BASE: ViewState = {
  filters: [],
  columns: cols("domain", "industry", "size", "country", "owner", "contacts", "fit", "intent", "updated_at"),
  sort: { key: "updated_at", desc: true },
  layout: "table",
  group: null,
};

export function CompaniesView(props: ViewProps) {
  const { sb, ws, session, navigate, id } = props;
  if (id === "visits") return <VisitorsView {...props} />;
  if (id.startsWith("account/")) return <CompanyForAccount {...props} accountId={id.slice(8)} />;
  if (id) return <RecordPage {...props} object="company" />;
  return (
    <RecordsList
      sb={sb}
      session={session}
      ws={ws}
      object="company"
      screen="companies"
      title="Companies"
      icon={<Users size={14} />}
      base={COMPANIES_BASE}
      presets={[
        { name: "Evaluating", filters: [{ field: "stage", op: "is", values: ["evaluating"] }] },
        { name: "Fit 70+", filters: [{ field: "fit", op: "gte", values: ["70"] }] },
        { name: "Intent 50+", filters: [{ field: "intent", op: "gte", values: ["50"] }] },
        { name: "No owner", filters: [{ field: "owner", op: "empty", values: [] }] },
      ]}
      actions={
        <Button variant="ghost" className="h-7 px-2.5" onClick={() => navigate("companies", "visits")}>
          <Eye size={13} />
          Visits
        </Button>
      }
      onOpen={(r) => navigate("companies", r.id)}
    />
  );
}

/** An old account link: open its company. */
function CompanyForAccount({ sb, ws, navigate, accountId }: ViewProps & { accountId: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    void sb
      .from("companies")
      .select("id")
      .eq("workspace_id", ws.id)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle()
      .then(({ data, error: e }) => (data ? navigate("companies", (data as { id: string }).id) : setError(e?.message ?? "Company not found")));
  }, [sb, ws.id, accountId, navigate]);
  return (
    <Page icon={<Users size={14} />} title="Companies">
      {error ? <ErrorNote message={error} /> : <Loading />}
    </Page>
  );
}

// Opportunities ---------------------------------------------------------------------------------------------------

const OPPORTUNITIES_BASE: ViewState = {
  filters: [],
  columns: cols("f.amount", "f.stage", "f.close_date", "f.company", "f.owner", "f.probability", "updated_at"),
  sort: { key: "updated_at", desc: true },
  layout: "board",
  group: "f.stage",
};

export function OpportunitiesView(props: ViewProps) {
  const { sb, ws, session, navigate, id } = props;
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  if (id) return <RecordPage {...props} object="opportunity" />;
  const add = async () => {
    const name = await askText("New opportunity", { placeholder: "Name", ok: "Create" });
    if (!name) return;
    try {
      const rid = must(await sb.rpc("record_create", { p_ws: ws.id, p_object: "opportunity", p_name: name, p_fields: { stage: "qualification" } })) as string;
      navigate("opportunities", rid);
    } catch (e) {
      setError(errorText(e));
      setTick((t) => t + 1);
    }
  };
  return (
    <>
      {error ? (
        <div className="border-b border-line bg-panel p-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <RecordsList
        key={tick}
        sb={sb}
        session={session}
        ws={ws}
        object="opportunity"
        screen="opportunities"
        title="Opportunities"
        icon={<Dollar size={14} />}
        base={OPPORTUNITIES_BASE}
        sum="f.amount"
        presets={[
          { name: "Open", filters: [{ field: "f.stage", op: "is_not", values: ["won", "lost"] }] },
          { name: "Won", filters: [{ field: "f.stage", op: "is", values: ["won"] }] },
          { name: "Lost", filters: [{ field: "f.stage", op: "is", values: ["lost"] }] },
          { name: "No company", filters: [{ field: "f.company", op: "empty", values: [] }] },
        ]}
        onAdd={add}
        onOpen={(r) => navigate("opportunities", r.id)}
      />
    </>
  );
}

type Opp = { id: string; name: string; amount: number | null; stage: string | null; close_date: string | null };

/** Opportunities linked to a company or a contact, with their stage and amount. */
export function OpportunitiesPanel({ sb, ws, object, id, navigate }: { sb: SupabaseClient; ws: { id: string }; object: "company" | "contact"; id: string; navigate: ViewProps["navigate"] }) {
  const meta = useMeta(sb, ws.id, "opportunity");
  const list = useLoad(async () => must(await sb.rpc("opportunities_for", { p_object: object, p_id: id })) as Opp[], `${object}:${id}`);
  const amount = meta.data?.fields.find((f) => f.key === "f.amount");
  const stage = meta.data?.fields.find((f) => f.key === "f.stage");
  const rows = list.data ?? [];
  const open = rows.filter((o) => o.stage !== "won" && o.stage !== "lost").reduce((t, o) => t + (Number(o.amount) || 0), 0);
  return (
    <Panel>
      <CardHead label="Opportunities" count={list.data ? rows.length : undefined}>
        {amount && open ? <span className="font-mono text-[12px] text-muted tabular-nums">{shown(amount, open)} open</span> : null}
      </CardHead>
      {list.error ? (
        <div className="p-4">
          <ErrorNote message={list.error} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((o) => {
            const st = stage?.options.find((x) => x.value === o.stage);
            return (
              <li key={o.id}>
                <button type="button" onClick={() => navigate("opportunities", o.id)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {st ? <Badge tone={st.kind === "won" ? "green" : st.kind === "lost" ? "red" : "gray"}>{st.label}</Badge> : null}
                  <span className="w-24 text-right font-mono text-[12px] text-muted tabular-nums">{amount && o.amount != null ? shown(amount, Number(o.amount)) : "—"}</span>
                </button>
              </li>
            );
          })}
          {!rows.length ? <li className="px-4 py-3 text-[13px] text-faint">—</li> : null}
        </ul>
      )}
    </Panel>
  );
}

/** /objects/<key> lists a custom object; /objects/<key>/<id> opens one record. */
export function ObjectsView(props: ViewProps) {
  const [key, recordId] = props.id.split("/");
  if (!key) return <Page icon={<Box size={14} />} title="Records"><ErrorNote message="Object not found" /></Page>;
  if (recordId) return <RecordPage {...props} id={recordId} object={key} />;
  return <ObjectList {...props} objectKey={key} />;
}

function ObjectList({ sb, ws, session, navigate, objectKey }: ViewProps & { objectKey: string }) {
  const meta = useMeta(sb, ws.id, objectKey);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const obj = meta.data?.object;
  if (meta.error || (meta.data && !obj)) {
    return (
      <Page icon={<Box size={14} />} title="Records">
        <ErrorNote message={meta.error || "Object not found"} />
      </Page>
    );
  }
  const add = async () => {
    const name = await askText(`New ${obj?.label.toLowerCase() ?? "record"}`, { placeholder: "Name", ok: "Create" });
    if (!name) return;
    try {
      const rid = must(await sb.rpc("record_create", { p_ws: ws.id, p_object: objectKey, p_name: name, p_fields: {} })) as string;
      navigate("objects", `${objectKey}/${rid}`);
    } catch (e) {
      setError(errorText(e));
      setTick((t) => t + 1);
    }
  };
  const base: ViewState = {
    filters: [],
    columns: [...(meta.data?.fields ?? []).filter((f) => f.custom).slice(0, 6).map((f) => ({ key: f.key, width: DEFAULT_WIDTH })), { key: "updated_at", width: DEFAULT_WIDTH }],
    sort: { key: "updated_at", desc: true },
    layout: "table",
    group: null,
  };
  if (!meta.data) return <Page icon={<Box size={14} />} title={obj?.plural ?? "Records"}><Loading /></Page>;
  return (
    <>
      {error ? (
        <div className="border-b border-line bg-panel p-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <RecordsList
        key={tick}
        sb={sb}
        session={session}
        ws={ws}
        object={objectKey}
        screen={`object:${objectKey}`}
        title={obj!.plural}
        icon={<Box size={14} />}
        base={base}
        onAdd={add}
        onOpen={(r) => navigate("objects", `${objectKey}/${r.id}`)}
      />
    </>
  );
}

type Detail = {
  record?: Row & { name: string; fields: Record<string, unknown> };
  company?: Row & { name: string | null; domain: string | null; owner: string | null };
  object?: { key: string; label: string; plural: string };
  account?: { id: string; fit: number | null; intent: number | null; stage: string | null; temperature: string | null; why_now: string | null } | null;
  contacts?: { id: string; email: string | null; first_name: string | null; last_name: string | null; title: string | null; lifecycle: string | null }[];
  writes?: Record<string, { source: string; at: string }>;
  links?: Record<string, Link[]>;
  backlinks?: { field: string; object: string; id: string }[];
  history: Change[];
};

function RecordPage({ sb, ws, id, navigate, object }: ViewProps & { object: string }) {
  const company = object === "company";
  const opportunity = object === "opportunity";
  const meta = useMeta(sb, ws.id, object);
  const detail = useLoad(async () => must(await sb.rpc(company ? "company_detail" : "record_detail", { p_id: id })) as Detail, `${object}:${id}`);
  const [error, setError] = useState("");
  const listRoute = company ? () => navigate("companies") : opportunity ? () => navigate("opportunities") : () => navigate("objects", object);
  const label = company ? "Companies" : opportunity ? "Opportunities" : (meta.data?.object?.plural ?? "Records");
  const icon = company ? <Users size={14} /> : opportunity ? <Dollar size={14} /> : <Box size={14} />;

  if (detail.error || meta.error || !detail.data || !meta.data) {
    return (
      <Page icon={icon} title={label} back={{ label, onClick: listRoute }}>
        {detail.error || meta.error ? <ErrorNote message={detail.error || meta.error} /> : <Loading />}
      </Page>
    );
  }
  const d = detail.data;
  const rec = (company ? d.company : d.record) as Row;
  const name = (company ? d.company?.name || d.company?.domain : d.record?.name) ?? "—";
  const record: Row = company ? { ...rec, fit: d.account?.fit ?? null, intent: d.account?.intent ?? null, stage: d.account?.stage ?? null, contacts: d.contacts?.length ?? 0 } : rec;
  const save = async (f: AnyField, v: unknown) => {
    must(await sb.rpc("record_set", { p_object: object, p_id: id, p_key: f.key, p_value: v ?? null }));
    detail.reload();
  };
  const remove = async () => {
    if (!(await askConfirm(`Remove ${name}?`, { ok: "Remove", danger: true }))) return;
    try {
      must(await sb.rpc("records_delete", { p_ws: ws.id, p_object: object, p_ids: [id] }));
      listRoute();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const openLink = (l: { object: string; id: string }) =>
    l.object === "contact"
      ? navigate("contacts", l.id)
      : l.object === "company"
        ? navigate("companies", l.id)
        : l.object === "opportunity"
          ? navigate("opportunities", l.id)
          : navigate("objects", `${l.object}/${l.id}`);
  const field = (k: string) => meta.data!.fields.find((f) => f.key === k);
  const f = (rec.fields ?? {}) as Record<string, unknown>;
  const stage = field("f.stage")?.options.find((o) => o.value === f.stage);
  const late = opportunity && stage?.kind === "open" && typeof f.close_date === "string" && f.close_date < new Date().toISOString().slice(0, 10);
  const stats: [string, React.ReactNode][] = company
    ? [
        ["Fit", d.account?.fit ?? "—"],
        ["Intent", d.account?.intent ?? "—"],
        ["Contacts", d.contacts?.length ?? "—"],
      ]
    : opportunity
      ? [
          ["Amount", f.amount != null && field("f.amount") ? shown(field("f.amount")!, f.amount) : "—"],
          ["Win chance", f.probability != null ? `${f.probability}%` : "—"],
          ["Close date", f.close_date && field("f.close_date") ? shown(field("f.close_date")!, f.close_date) : "—"],
        ]
      : [];
  // Opportunities have their own panel on a company page.
  const backlinks = (d.backlinks ?? []).filter((l) => !(company && l.object === "opportunity"));

  return (
    <Page
      icon={icon}
      title={name}
      back={{ label, onClick: listRoute }}
      actions={
        <>
          {company && d.account ? <AccountFeedback sb={sb} accountId={d.account.id} /> : null}
          <Button variant="danger" className="h-7 px-2.5" onClick={remove}>
            Remove
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <ErrorNote message={error} />
        <Panel>
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4 p-5">
            <div className="flex min-w-0 items-start gap-3">
              <Avatar label={name} size={40} />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[20px] font-medium tracking-[-0.02em]">{name}</span>
                <span className="text-[13px] text-muted">{company ? d.company?.domain : meta.data.object?.label}</span>
                {company && d.account?.temperature ? (
                  <span className="mt-1 flex gap-1.5">
                    <Badge tone={d.account.temperature === "hot" ? "red" : "gray"}>{d.account.temperature}</Badge>
                    {d.account.stage ? <Badge tone="violet">{d.account.stage}</Badge> : null}
                  </span>
                ) : null}
                {opportunity && (stage || late) ? (
                  <span className="mt-1 flex gap-1.5">
                    {stage ? <Badge tone={stage.kind === "won" ? "green" : stage.kind === "lost" ? "red" : "gray"}>{stage.label}</Badge> : null}
                    {late ? <Badge tone="red">Late</Badge> : null}
                  </span>
                ) : null}
              </div>
            </div>
            {stats.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1">
                <span className="label-mono">{k}</span>
                <span className="font-mono text-[24px] tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          {company && d.account?.why_now ? <p className="border-t border-line px-5 py-3 text-[14px]">{d.account.why_now}</p> : null}
        </Panel>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-5">
            {company ? (
              <Panel>
                <CardHead label="Contacts" count={d.contacts?.length} />
                <ul className="divide-y divide-line">
                  {(d.contacts ?? []).map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => navigate("contacts", c.id)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] hover:bg-hover">
                        <Avatar label={[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "?"} />
                        <span className="min-w-0 flex-1 truncate">{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}</span>
                        <span className="truncate text-[12px] text-muted">{c.title}</span>
                      </button>
                    </li>
                  ))}
                  {!d.contacts?.length ? <li className="px-4 py-3 text-[13px] text-faint">—</li> : null}
                </ul>
              </Panel>
            ) : null}
            {company ? <OpportunitiesPanel sb={sb} ws={ws} object="company" id={id} navigate={navigate} /> : null}
            {backlinks.length ? (
              <Panel>
                <CardHead label="Linked from" count={backlinks.length} />
                <ul className="divide-y divide-line">
                  {backlinks.map((l, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => openLink(l)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-hover">
                        <span className="text-muted">{l.field}</span>
                        <span className="ml-auto font-mono text-[11px] text-faint">{l.object}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
            <HistoryPanel history={d.history} fields={meta.data.fields} people={meta.data.people} />
          </div>
          <div className="flex flex-col gap-5">
            <FieldsPanel
              sb={sb}
              wsId={ws.id}
              record={record}
              fields={meta.data.fields}
              layout={meta.data.layout}
              writes={d.writes ?? Object.fromEntries(Object.entries((rec.field_sources ?? {}) as Record<string, { s: string; at: string }>).map(([k, v]) => [k, { source: v.s, at: v.at }]))}
              links={d.links ?? {}}
              skip={company ? ["fit", "intent", "stage", "contacts"] : []}
              onSave={save}
              onCustomize={() => navigate("settings", "fields")}
            />
            <p className="px-1 font-mono text-[10.5px] text-faint">Created {timeAgo(String(rec.created_at))}</p>
          </div>
        </div>
        {company && d.account ? <AccountActivity sb={sb} accountId={d.account.id} /> : null}
      </div>
    </Page>
  );
}
