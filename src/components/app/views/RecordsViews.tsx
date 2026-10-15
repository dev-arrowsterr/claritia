"use client";

// Companies and custom objects (docs/conversion-parity.md Part 7): lists on the shared records list, and a record
// page with editable fields in sections, links both ways, and the change history.

import { useState } from "react";
import type { AnyField } from "@/lib/records/fields";
import { Box, Users } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Avatar, Badge, Button, CardHead, ErrorNote, errorText, Loading, must, Page, Panel, timeAgo, useLoad, type ViewProps } from "../ui";
import type { Link } from "../records/FieldInput";
import { useMeta } from "../records/meta";
import { FieldsPanel, HistoryPanel, type Change } from "../records/RecordParts";
import { RecordsList, type ViewState } from "../records/RecordsList";
import { DEFAULT_WIDTH, type Row } from "../records/RecordTable";

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
        { name: "Fit 70+", filters: [{ field: "fit", op: "gte", values: ["70"] }] },
        { name: "No owner", filters: [{ field: "owner", op: "empty", values: [] }] },
      ]}
      onOpen={(r) => navigate("companies", r.id)}
    />
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
  const meta = useMeta(sb, ws.id, object);
  const detail = useLoad(async () => must(await sb.rpc(company ? "company_detail" : "record_detail", { p_id: id })) as Detail, `${object}:${id}`);
  const [error, setError] = useState("");
  const listRoute = company ? () => navigate("companies") : () => navigate("objects", object);
  const label = company ? "Companies" : (meta.data?.object?.plural ?? "Records");
  const icon = company ? <Users size={14} /> : <Box size={14} />;

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
    l.object === "contact" ? navigate("contacts", l.id) : l.object === "company" ? navigate("companies", l.id) : navigate("objects", `${l.object}/${l.id}`);

  return (
    <Page
      icon={icon}
      title={name}
      back={{ label, onClick: listRoute }}
      actions={
        <Button variant="danger" className="h-7 px-2.5" onClick={remove}>
          Remove
        </Button>
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
              </div>
            </div>
            {company
              ? [
                  ["Fit", d.account?.fit],
                  ["Intent", d.account?.intent],
                  ["Contacts", d.contacts?.length],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex flex-col gap-1">
                    <span className="label-mono">{k}</span>
                    <span className="font-mono text-[24px] tabular-nums">{(v as number | null | undefined) ?? "—"}</span>
                  </div>
                ))
              : null}
          </div>
          {company && d.account?.why_now ? <p className="border-t border-line px-5 py-3 text-[14px]">{d.account.why_now}</p> : null}
        </Panel>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-5">
            {company ? (
              <Panel>
                <CardHead label="Contacts" count={d.contacts?.length}>
                  {d.account ? (
                    <Button variant="plain" className="h-7 px-2" onClick={() => navigate("accounts", d.account!.id)}>
                      Intent
                    </Button>
                  ) : null}
                </CardHead>
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
            {d.backlinks?.length ? (
              <Panel>
                <CardHead label="Linked from" count={d.backlinks.length} />
                <ul className="divide-y divide-line">
                  {d.backlinks.map((l, i) => (
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
      </div>
    </Page>
  );
}
