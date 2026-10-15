"use client";

// Contacts, Leads and the contact page (docs/conversion-parity.md Parts 4 and 17). The lists run on the shared
// records list (src/components/app/records): views, filters, table or board, columns, inline edits and bulk
// actions. The import wizard and the add and edit forms live here.

import { useEffect, useState } from "react";
import { BASES, BASIS_LABEL, IMPORT_SOURCES, sourceRefused, type Basis, type ImportSource } from "@/lib/contacts/consent";
import { MAX_ROWS, parseCsv } from "@/lib/contacts/csv";
import { fullName, guessTarget, LIFECYCLES, TARGETS, type ContactRow, type CustomField, type Target } from "@/lib/contacts/fields";
import type { AnyField } from "@/lib/records/fields";
import { Contact, Plus, Upload } from "../../Icons";
import { askConfirm, askText, tell } from "../Dialogs";
import { Popover } from "../FilterBar";
import { Select } from "../Select";
import { SampleRows, SampleStats, SampleTags, ToolIntro } from "../ToolIntro";
import { Avatar, Badge, Button, CardHead, Empty, ErrorNote, errorText, Field, Input, Loading, must, Page, Panel, postJson, Th, Td, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";
import type { Link } from "../records/FieldInput";
import { useMeta, type Meta } from "../records/meta";
import { FieldsPanel, HistoryPanel, sourceLabel, type Change } from "../records/RecordParts";
import { RecordsList, type Preset, type ViewState } from "../records/RecordsList";
import { DEFAULT_WIDTH, type Row } from "../records/RecordTable";
import { activeTime } from "./VisitorsView";

const LIFECYCLE_LABEL = Object.fromEntries(LIFECYCLES.map((l) => [l.value, l.label]));
const LIFECYCLE_TONE: Record<string, Tone> = { customer: "green", opportunity: "brand", sql: "brand", mql: "violet" };
const BASIS_TONE: Record<Basis, Tone> = { opt_in: "green", soft_opt_in: "green", legitimate_interest: "gray", none: "amber" };

const displayName = (c: { first_name: string | null; last_name: string | null; email: string | null }) => fullName(c) ?? c.email ?? "Contact";
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const cols = (...keys: string[]) => keys.map((key) => ({ key, width: DEFAULT_WIDTH }));

const CONTACTS_BASE: ViewState = {
  filters: [],
  columns: cols("company", "title", "lifecycle", "lead_status", "owner", "country", "score", "updated_at"),
  sort: { key: "updated_at", desc: true },
  layout: "table",
  group: "lifecycle",
};
const CONTACT_PRESETS: Preset[] = [
  { name: "Customers", filters: [{ field: "lifecycle", op: "is", values: ["customer"] }] },
  { name: "Seen on site", filters: [{ field: "known", op: "is", values: ["true"] }] },
  { name: "New this week", filters: [{ field: "created_at", op: "within", values: ["7"] }] },
  { name: "By lifecycle", layout: "board", group: "lifecycle" },
];
const LEADS_BASE: ViewState = {
  filters: [{ field: "lead_status", op: "not_empty", values: [] }],
  columns: cols("lead_status", "company", "title", "owner", "score", "fit", "updated_at"),
  sort: { key: "updated_at", desc: true },
  layout: "board",
  group: "lead_status",
};
const LEAD_PRESETS: Preset[] = [
  { name: "Open", filters: [{ field: "lead_status", op: "is", values: ["new", "attempting", "connected"] }], layout: "table" },
  { name: "No owner", filters: [{ field: "lead_status", op: "not_empty", values: [] }, { field: "owner", op: "empty", values: [] }], layout: "table" },
  { name: "Fit 70+", filters: [{ field: "lead_status", op: "not_empty", values: [] }, { field: "fit", op: "gte", values: ["70"] }], layout: "table" },
];

export function ContactsView(props: ViewProps) {
  if (props.id) return <ContactPage {...props} />;
  return <ContactsList {...props} />;
}

export function LeadsView(props: ViewProps) {
  if (props.id) return <ContactPage {...props} back="leads" />;
  return <ContactsList {...props} leads />;
}

function ContactsList({ sb, ws, session, navigate, leads = false }: ViewProps & { leads?: boolean }) {
  const [panel, setPanel] = useState<"import" | "add" | null>(null);
  const [tick, setTick] = useState(0);
  const custom = useMeta(sb, ws.id, "contact");
  const route = leads ? "leads" : "contacts";
  const actions = (
    <>
      <Button variant="ghost" onClick={() => setPanel("import")}>
        <Upload size={13} />
        Import
      </Button>
      <Button onClick={() => setPanel("add")}>
        <Plus size={13} />
        Add contact
      </Button>
    </>
  );
  return (
    <>
      <RecordsList
        key={tick}
        sb={sb}
        session={session}
        ws={ws}
        object="contact"
        screen={route}
        title={leads ? "Leads" : "Contacts"}
        icon={<Contact size={14} />}
        base={leads ? LEADS_BASE : CONTACTS_BASE}
        presets={leads ? LEAD_PRESETS : CONTACT_PRESETS}
        actions={actions}
        onOpen={(r) => navigate(route, r.id)}
        nameExtra={(r) => (r.person_id ? <Badge tone="brand">On site</Badge> : null)}
        intro={leads ? undefined : <ContactsIntro action={actions} />}
        bulkExtra={(ids, done, meta) => <ContactBulk sb={sb} wsId={ws.id} ids={ids} done={done} meta={meta} />}
      />
      {panel === "import" ? (
        <ImportPanel
          sb={sb}
          session={session}
          wsId={ws.id}
          custom={custom.data?.custom ?? []}
          fieldsChanged={custom.reload}
          onClose={(changed) => {
            setPanel(null);
            if (changed) setTick((t) => t + 1);
          }}
        />
      ) : null}
      {panel === "add" ? (
        <ContactPanel
          session={session}
          wsId={ws.id}
          custom={custom.data?.custom ?? []}
          onClose={(id) => {
            setPanel(null);
            if (id) navigate(route, id);
          }}
        />
      ) : null}
    </>
  );
}

/** Contacts' own bulk actions: add to a list, merge two. */
function ContactBulk({ sb, wsId, ids, done, meta }: { sb: ViewProps["sb"]; wsId: string; ids: () => Promise<string[]>; done: () => void; meta: Meta }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState("");
  const addTo = async (list: string | null) => {
    setAnchor(null);
    let name = "";
    if (!list) {
      const n = await askText("New list", { placeholder: "List name", ok: "Create" });
      if (!n) return;
      name = n;
    }
    try {
      const chosen = await ids();
      must(await sb.rpc("list_add", { p_ws: wsId, p_list: list, p_name: name, p_ids: chosen }));
      done();
      await tell(`Added ${chosen.length.toLocaleString("en-US")} to the list`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const merge = async () => {
    const chosen = await ids();
    if (chosen.length !== 2) return void tell("Pick exactly two contacts to merge");
    if (!(await askConfirm("Merge these two contacts?", { body: "The first one picked stays. Its empty fields fill from the other.", ok: "Merge" }))) return;
    try {
      must(await sb.rpc("contacts_merge", { p_keep: chosen[0], p_drop: chosen[1] }));
      done();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      {error ? <span className="text-[12.5px] text-danger">{error}</span> : null}
      <Button variant="ghost" className="h-7 px-2.5" onClick={(e) => setAnchor(e.currentTarget)}>
        Add to list
      </Button>
      <Button variant="ghost" className="h-7 px-2.5" onClick={merge}>
        Merge
      </Button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240}>
          <ul className="max-h-72 overflow-y-auto p-1">
            {meta.lists.map((l) => (
              <li key={l.value}>
                <button type="button" onClick={() => addTo(l.value)} className="flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-hover">
                  {l.label}
                </button>
              </li>
            ))}
            <li>
              <button type="button" onClick={() => addTo(null)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
                <Plus size={13} />
                New list
              </button>
            </li>
          </ul>
        </Popover>
      ) : null}
    </>
  );
}

function ContactsIntro({ action }: { action: React.ReactNode }) {
  return (
    <ToolIntro
      action={action}
      title="Every contact in one place"
      lead="Bring in your contacts from a CSV, or add them one by one. Claritia cleans each email, merges duplicates, keeps each person's email consent, and ties them to their visits."
      features={[
        {
          title: "Import a CSV",
          text: "Columns map on their own. Duplicates merge into one contact, and each value keeps where it came from.",
          visual: <SampleStats items={[["rows", "10,000"], ["created", "8,912"], ["merged", "1,088"]]} />,
        },
        {
          title: "Filter and save views",
          text: "Filter by any field, company or fit, and save the view for your team.",
          visual: <SampleTags rows={[["Lifecycle is Lead", "Filter"], ["Fit at least 70", "Filter"], ["Country is DE", "Filter"]]} />,
        },
        {
          title: "Consent by region",
          text: "Each contact keeps its basis for email. In the EU and UK, only opt-in counts.",
          visual: <SampleRows rows={[["Opted in", 62, "62%"], ["Legitimate interest", 24, "24%"], ["No basis", 14, "14%"]]} />,
        },
      ]}
    />
  );
}

// Side panels -----------------------------------------------------------------------------------------------------

export function SidePanel({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector('[role="listbox"]') && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-[80] bg-ink/10" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-label={title} className={`fixed inset-y-0 right-0 z-[81] flex w-full flex-col border-l border-line bg-panel ${wide ? "max-w-[760px]" : "max-w-[480px]"}`}>
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <h2 className="truncate text-[15px] font-medium">{title}</h2>
          <Button variant="ghost" className="ml-auto h-7 px-2.5" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer ? <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-canvas px-5 py-3">{footer}</div> : null}
      </aside>
    </>
  );
}

type Counts = { rows: number; created: number; updated: number; merged: number; no_basis: number; skipped: { missing_email: number; invalid_email: number; disposable: number } };
const NEW_FIELD = "__new" as Target;

function ImportPanel({
  sb,
  session,
  wsId,
  custom,
  fieldsChanged,
  onClose,
}: {
  sb: ViewProps["sb"];
  session: ViewProps["session"];
  wsId: string;
  custom: CustomField[];
  fieldsChanged: () => void;
  onClose: (changed: boolean) => void;
}) {
  const [file, setFile] = useState<{ name: string; text: string; header: string[]; rows: string[][] } | null>(null);
  const [columns, setColumns] = useState<Target[]>([]);
  const [source, setSource] = useState<ImportSource | "">("");
  const [basis, setBasis] = useState<Basis | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Counts | null>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError("");
    const text = await f.text();
    const [header, ...rows] = parseCsv(text);
    if (!header || !rows.length) return setError("The file has no rows under its header.");
    if (rows.length > MAX_ROWS) return setError(`Up to ${MAX_ROWS.toLocaleString("en-US")} rows at a time.`);
    const guessed: Target[] = [];
    for (const h of header) {
      const t = guessTarget(h, custom);
      guessed.push(t !== "skip" && guessed.includes(t) ? "skip" : t);
    }
    setFile({ name: f.name, text, header, rows });
    setColumns(guessed);
  }

  async function choose(i: number, t: Target) {
    let target = t;
    if (t === NEW_FIELD) {
      const label = await askText("New field", { initial: file?.header[i] ?? "", ok: "Add" });
      if (!label) return;
      try {
        const made = must(await sb.rpc("field_add", { p_ws: wsId, p_object: "contact", p_label: label, p_type: "text" })) as { key: string };
        fieldsChanged();
        target = `f.${made.key}`;
      } catch (e) {
        return setError(errorText(e));
      }
    }
    setColumns((cols) => cols.map((c, j) => (j === i ? target : target !== "skip" && c === target ? "skip" : c)));
  }

  const hasBasisColumn = columns.includes("basis");
  const refused = source !== "" && sourceRefused(source);
  const ready = !!file && columns.includes("email") && !!source && !refused && (hasBasisColumn || !!basis);

  async function run() {
    if (!file || !ready) return;
    setBusy(true);
    setError("");
    try {
      const r = await postJson<{ counts: Counts }>(session, "/api/contacts/import", {
        workspaceId: wsId,
        fileName: file.name,
        text: file.text,
        mapping: { columns, source, basis: basis || null },
      });
      setDone(r.counts);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const targetOptions = [
    ...TARGETS,
    ...custom.map((f) => ({ value: `f.${f.key}` as Target, label: f.label })),
    { value: NEW_FIELD, label: "New field…" },
  ];
  const sample = (i: number) =>
    file!.rows
      .map((r) => r[i]?.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");

  if (done) {
    const skipped = done.skipped.missing_email + done.skipped.invalid_email + done.skipped.disposable;
    const tiles: [string, number][] = [
      ["Rows", done.rows],
      ["Created", done.created],
      ["Updated", done.updated],
      ["Merged", done.merged],
      ["Skipped", skipped],
      ["No email consent", done.no_basis],
    ];
    return (
      <SidePanel title="Import" onClose={() => onClose(true)} wide footer={<Button onClick={() => onClose(true)}>Done</Button>}>
        <div className="grid grid-cols-2 border-b border-line sm:grid-cols-3">
          {tiles.map(([label, v]) => (
            <div key={label} className="border-r border-b border-line px-5 py-4">
              <div className="label-mono">{label}</div>
              <div className="mt-1 text-[22px] font-medium tabular-nums">{v.toLocaleString("en-US")}</div>
            </div>
          ))}
        </div>
        {skipped ? (
          <ul className="px-5 py-3 text-[13px] text-body">
            {done.skipped.missing_email ? <li>No email: {done.skipped.missing_email.toLocaleString("en-US")}</li> : null}
            {done.skipped.invalid_email ? <li>Not a valid email: {done.skipped.invalid_email.toLocaleString("en-US")}</li> : null}
            {done.skipped.disposable ? <li>Disposable email: {done.skipped.disposable.toLocaleString("en-US")}</li> : null}
          </ul>
        ) : null}
      </SidePanel>
    );
  }

  return (
    <SidePanel
      title="Import"
      onClose={() => onClose(false)}
      wide
      footer={
        file ? (
          <>
            <Button variant="plain" onClick={() => setFile(null)} disabled={busy}>
              Choose another file
            </Button>
            <Button onClick={run} disabled={!ready || busy}>
              {busy ? "Importing…" : `Import ${file.rows.length.toLocaleString("en-US")} rows`}
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-5 p-5">
        <ErrorNote message={error} />
        {!file ? (
          <label className="frame flex cursor-pointer flex-col items-center gap-3 border border-dashed border-line-strong bg-canvas px-6 py-16 text-center hover:border-ink">
            <Upload size={18} />
            <span className="text-[14px] font-medium">Choose a CSV file</span>
            <input type="file" accept=".csv,text/csv,.tsv,.txt" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-medium">{file.name}</span>
              <span className="font-mono text-[11.5px] text-faint">{file.rows.length.toLocaleString("en-US")} rows</span>
            </div>
            <Panel>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Column</Th>
                    <Th>Sample</Th>
                    <Th>Field</Th>
                  </tr>
                </thead>
                <tbody>
                  {file.header.map((h, i) => (
                    <tr key={i}>
                      <Td className="font-medium">{h || `Column ${i + 1}`}</Td>
                      <Td className="max-w-[220px] truncate text-[12.5px] text-muted">{sample(i)}</Td>
                      <Td className="w-56">
                        <Select<Target>
                          value={columns[i] ?? "skip"}
                          onChange={(t) => choose(i, t)}
                          ariaLabel={`Field for ${h}`}
                          options={targetOptions}
                          className={`h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong ${columns[i] === "skip" ? "text-faint" : ""}`}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            {!columns.includes("email") ? <ErrorNote message="Map a column to Email." /> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source">
                <Select<ImportSource | "">
                  value={source}
                  onChange={setSource}
                  ariaLabel="Source"
                  placeholder="Choose…"
                  options={IMPORT_SOURCES}
                  className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
                />
              </Field>
              <Field label={hasBasisColumn ? "Email consent when blank" : "Email consent"}>
                <Select<Basis | "">
                  value={basis}
                  onChange={setBasis}
                  ariaLabel="Email consent"
                  placeholder="Choose…"
                  options={BASES}
                  className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
                />
              </Field>
            </div>
            {refused ? <ErrorNote message="Bought or rented lists can't be imported." /> : null}
          </>
        )}
      </div>
    </SidePanel>
  );
}

type FormState = Record<string, string>;
const FORM_FIELDS: [key: string, label: string][] = [
  ["email", "Email"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["title", "Title"],
  ["company", "Company"],
  ["website", "Company website"],
  ["phone", "Phone"],
  ["country", "Country"],
  ["region", "State or region"],
  ["lead_status", "Lead status"],
];

/** Add a contact, or edit one when `initial` is given. Only changed values are sent. */
function ContactPanel({
  session,
  wsId,
  custom,
  id,
  initial,
  onClose,
}: {
  session: ViewProps["session"];
  wsId: string;
  custom: CustomField[];
  id?: string;
  initial?: { form: FormState; fields: FormState };
  onClose: (id?: string) => void;
}) {
  const start = initial ?? { form: { lifecycle: "" }, fields: {} };
  const [form, setForm] = useState<FormState>(start.form);
  const [fields, setFields] = useState<FormState>(start.fields);
  const [basis, setBasis] = useState<Basis>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => (start.form[k] ?? "") !== v));
    const changedFields = Object.fromEntries(Object.entries(fields).filter(([k, v]) => (start.fields[k] ?? "") !== v));
    const payload = { ...changed, ...(Object.keys(changedFields).length ? { fields: changedFields } : {}), ...(id ? {} : { basis }) };
    try {
      if (id && !Object.keys(payload).length) return onClose(id);
      const r = await postJson<{ id: string }>(session, "/api/contacts", { workspaceId: wsId, ...(id ? { id } : {}), form: payload });
      onClose(r.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title={id ? "Edit contact" : "Add contact"}
      onClose={() => onClose()}
      footer={
        <>
          <Button variant="plain" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !form.email?.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNote message={error} />
        {FORM_FIELDS.map(([key, label]) => (
          <Field key={key} label={label}>
            <Input value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} type={key === "email" ? "email" : "text"} autoFocus={key === "email" && !id} />
          </Field>
        ))}
        <Field label="Lifecycle">
          <Select<string>
            value={form.lifecycle ?? ""}
            onChange={(v) => setForm({ ...form, lifecycle: v })}
            ariaLabel="Lifecycle"
            options={[{ value: "", label: "None" }, ...LIFECYCLES]}
            className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
          />
        </Field>
        {!id ? (
          <Field label="Email consent">
            <Select<Basis> value={basis} onChange={setBasis} ariaLabel="Email consent" options={BASES} className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong" />
          </Field>
        ) : null}
        {custom.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === "select" || f.type === "checkbox" ? (
              <Select<string>
                value={fields[f.key] ?? ""}
                onChange={(v) => setFields({ ...fields, [f.key]: v })}
                ariaLabel={f.label}
                options={[
                  { value: "", label: "None" },
                  ...(f.type === "checkbox" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o))),
                ]}
                className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
              />
            ) : (
              <Input value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} placeholder={f.type === "date" ? "2026-03-31" : undefined} inputMode={f.type === "number" ? "decimal" : undefined} />
            )}
          </Field>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </SidePanel>
  );
}

// The contact page ------------------------------------------------------------------------------------------------

type Detail = {
  moved_to?: string;
  contact: ContactRow & { email_clean: string; timezone: string | null; score_reasons: unknown; company_id: string | null; owner: string | null };
  company: { id: string; name: string | null; domain: string | null; industry: string | null; size: string | null; account_id: string | null; fit: number | null; intent: number | null; stage: string | null } | null;
  person: { id: string; level: string | null } | null;
  writes: Record<string, { source: string; at: string }>;
  history: Change[];
  fields: CustomField[];
  links: Record<string, Link[]>;
  consents: { channel: string; basis: Basis; status: string; source: string; at: string }[];
  suppressed: { reason: string; source: string; at: string } | null;
  topics: { name: string; status: string; at: string }[];
  segments: { id: string; name: string; kind: string; entered_at: string }[];
  events: { kind: string; data: Record<string, unknown>; source: string; at: string }[];
  visits: { id: string; started_at: string; pageviews: number; engaged_s: number; referrer_host: string | null; pages: string[] }[];
};

const EVENT_LABEL: Record<string, string> = { "contact.created": "Added" };

function ContactPage({ sb, ws, session, id, navigate, back: backRoute = "contacts" }: ViewProps & { back?: "contacts" | "leads" }) {
  const detail = useLoad(async () => must(await sb.rpc("contact_detail", { p_id: id })) as Detail, id);
  const meta = useMeta(sb, ws.id, "contact");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const back = { label: backRoute === "leads" ? "Leads" : "Contacts", onClick: () => navigate(backRoute) };

  if (detail.data?.moved_to) {
    navigate(backRoute, detail.data.moved_to);
    return null;
  }
  if (detail.error || meta.error || !detail.data || !meta.data) {
    return (
      <Page icon={<Contact size={14} />} title="Contact" back={back}>
        {detail.error || meta.error ? <ErrorNote message={detail.error || meta.error} /> : <Loading />}
      </Page>
    );
  }
  const d = detail.data;
  const c = d.contact;
  const name = displayName(c);
  const consent = d.consents[0];
  const fields = meta.data.fields;
  const record: Row = { ...(c as unknown as Row), company_name: d.company?.name ?? d.company?.domain ?? null, company_domain: d.company?.domain ?? null, fit: d.company?.fit ?? null, intent: d.company?.intent ?? null, industry: d.company?.industry ?? null, size: d.company?.size ?? null };
  const stage = fields.find((f) => f.key === "lead_status");

  async function remove() {
    if (!(await askConfirm(`Remove ${name}?`, { ok: "Remove", danger: true }))) return;
    try {
      must(await sb.rpc("contacts_delete", { p_ws: ws.id, p_ids: [id] }));
      navigate(backRoute);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const save = async (f: AnyField, v: unknown) => {
    must(await sb.rpc("record_set", { p_object: "contact", p_id: id, p_key: f.key, p_value: v ?? null }));
    detail.reload();
  };

  const timeline = [
    ...d.events.map((e) => ({ at: e.at, key: `e${e.at}${e.kind}`, node: <span>{`${EVENT_LABEL[e.kind] ?? e.kind} · ${sourceLabel(e.source)}`}</span> })),
    ...d.visits.map((v) => ({
      at: v.started_at,
      key: v.id,
      node: (
        <span className="flex flex-col gap-1">
          <span>
            Visited · {v.pageviews} {v.pageviews === 1 ? "page" : "pages"} · {activeTime(v.engaged_s)}
            {v.referrer_host ? <span className="text-faint"> · {v.referrer_host}</span> : null}
          </span>
          <span className="flex flex-wrap gap-x-3 font-mono text-[12px] text-body">
            {v.pages.map((p, i) => (
              <span key={i}>{p}</span>
            ))}
          </span>
        </span>
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const edit = {
    form: {
      email: c.email ?? "",
      first_name: c.first_name ?? "",
      last_name: c.last_name ?? "",
      title: c.title ?? "",
      company: d.company?.name ?? "",
      website: d.company?.domain ?? "",
      phone: c.phone ?? "",
      country: c.country ?? "",
      region: c.region ?? "",
      lead_status: c.lead_status ?? "",
      lifecycle: c.lifecycle ?? "",
    },
    fields: Object.fromEntries(d.fields.filter((f) => f.type !== "relation").map((f) => [f.key, c.fields?.[f.key] == null ? "" : f.type === "checkbox" ? (c.fields[f.key] ? "yes" : "no") : Array.isArray(c.fields[f.key]) ? (c.fields[f.key] as string[]).join(", ") : String(c.fields[f.key])])),
  };

  return (
    <Page
      icon={<Contact size={14} />}
      title={name}
      back={back}
      actions={
        <>
          <Button variant="ghost" className="h-7 px-2.5" onClick={() => setEditing(true)}>
            Edit
          </Button>
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
                <span className="text-[13px] text-muted">{[c.title, d.company?.name ?? d.company?.domain, c.country].filter(Boolean).join(" · ") || c.email}</span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {c.lifecycle ? <Badge tone={LIFECYCLE_TONE[c.lifecycle] ?? "gray"}>{LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle}</Badge> : null}
                  {consent ? <Badge tone={BASIS_TONE[consent.basis]}>{BASIS_LABEL[consent.basis]}</Badge> : null}
                  {d.suppressed ? <Badge tone="red">{d.suppressed.reason}</Badge> : null}
                  {d.person ? <Badge tone="brand">On site</Badge> : null}
                </span>
              </div>
            </div>
            {[
              ["Score", c.score],
              ["Fit", d.company?.fit ?? null],
              ["Intent", d.company?.intent ?? null],
            ].map(([label, v]) => (
              <div key={label as string} className="flex flex-col gap-1">
                <span className="label-mono">{label}</span>
                <span className="font-mono text-[24px] tabular-nums">{v ?? "—"}</span>
              </div>
            ))}
          </div>
          {stage ? <StageBar stages={stage.options} value={c.lead_status} onPick={(v) => void save(stage, v).catch((e) => setError(errorText(e)))} /> : null}
        </Panel>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-5">
            <Panel>
              <CardHead label="Timeline" count={timeline.length} />
              {!timeline.length ? (
                <Empty title="Nothing yet" />
              ) : (
                <ol className="divide-y divide-line">
                  {timeline.map((t) => (
                    <li key={t.key} className="flex gap-4 px-4 py-3 text-[13px]">
                      <span className="w-32 shrink-0 font-mono text-[12px] whitespace-nowrap text-muted">{new Date(t.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      {t.node}
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
            <HistoryPanel history={d.history} fields={fields} people={meta.data.people} />
          </div>

          <div className="flex flex-col gap-5">
            <FieldsPanel
              sb={sb}
              wsId={ws.id}
              record={record}
              fields={fields}
              layout={meta.data.layout}
              writes={d.writes}
              links={d.links}
              skip={["name", "known", "segment", "fit", "intent", "score"]}
              onSave={save}
              onCustomize={() => navigate("settings", "fields")}
            />

            {d.company ? (
              <Panel>
                <CardHead label="Company">
                  <Button variant="plain" className="h-7 px-2" onClick={() => navigate("companies", d.company!.id)}>
                    Open
                  </Button>
                  {d.company.account_id ? (
                    <Button variant="plain" className="h-7 px-2" onClick={() => navigate("accounts", d.company!.account_id!)}>
                      Intent
                    </Button>
                  ) : null}
                </CardHead>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[13px]">
                  {[
                    ["Name", d.company.name],
                    ["Domain", d.company.domain],
                    ["Industry", d.company.industry],
                    ["Size", d.company.size],
                    ["Stage", d.company.stage],
                  ].map(([k, v]) => (
                    <div key={k as string} className="contents">
                      <dt className="text-muted">{k}</dt>
                      <dd>{v ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </Panel>
            ) : null}

            <Panel>
              <CardHead label="Email consent" />
              {!d.consents.length ? (
                <p className="px-4 py-3 text-[13px] text-faint">—</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.consents.map((k, i) => (
                    <li key={i} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
                      <Badge tone={BASIS_TONE[k.basis]}>{BASIS_LABEL[k.basis]}</Badge>
                      <span className="text-muted">{sourceLabel(k.source)}</span>
                      <span className="ml-auto font-mono text-[11.5px] text-faint">{fmtDate(k.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {d.topics.length ? (
                <ul className="border-t border-line px-4 py-2 text-[13px]">
                  {d.topics.map((t) => (
                    <li key={t.name} className="flex justify-between py-1">
                      <span>{t.name}</span>
                      <Badge tone={t.status === "subscribed" ? "green" : "gray"}>{t.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel>
              <CardHead label="Lists and segments" count={d.segments.length} />
              {!d.segments.length ? (
                <p className="px-4 py-3 text-[13px] text-faint">—</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.segments.map((g) => (
                    <li key={g.id} className="flex justify-between px-4 py-2.5 text-[13px]">
                      <span>{g.name}</span>
                      <span className="font-mono text-[11.5px] text-faint">{timeAgo(g.entered_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
      {editing ? (
        <ContactPanel
          session={session}
          wsId={ws.id}
          custom={d.fields.filter((f) => f.type !== "relation")}
          id={id}
          initial={edit}
          onClose={(saved) => {
            setEditing(false);
            if (saved) detail.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

/** The lead stages as one bar; the current stage is filled, a click moves the lead. */
function StageBar({ stages, value, onPick }: { stages: { value: string; label: string; kind?: string }[]; value: string | null; onPick: (v: string) => void }) {
  return (
    <div className="flex border-t border-line">
      {stages.map((s, i) => {
        const on = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => !on && onPick(s.value)}
            className={`h-9 flex-1 truncate px-2 text-[12.5px] font-medium ${i ? "border-l border-line" : ""} ${
              on ? (s.kind === "lost" ? "bg-danger-soft text-danger" : s.kind === "won" ? "bg-success-soft text-success" : "bg-ink text-white") : "text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
