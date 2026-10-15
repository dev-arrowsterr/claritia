"use client";

// Contacts and the contact page (docs/conversion-parity.md Part 11): the table with the filter bar, saved views,
// a columns picker and bulk export and remove; the import wizard; adding and editing a contact.

import { useEffect, useState } from "react";
import { BASES, BASIS_LABEL, IMPORT_SOURCES, sourceRefused, type Basis, type ImportSource } from "@/lib/contacts/consent";
import { MAX_ROWS, parseCsv, toCsv } from "@/lib/contacts/csv";
import { contactFilterFields, fullName, guessTarget, LIFECYCLES, SOURCES, TARGETS, type ContactRow, type CustomField, type Target } from "@/lib/contacts/fields";
import { cleanFilters, type Filter, type FilterField } from "@/lib/filters";
import { Check, Contact, Download, Plus, Trash, Upload } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { FilterBar, Popover, useFilters } from "../FilterBar";
import { Select } from "../Select";
import { SampleRows, SampleStats, SampleTags, ToolIntro } from "../ToolIntro";
import { Avatar, Badge, Button, CardHead, Empty, ErrorNote, errorText, Field, Input, Loading, must, Page, Panel, postJson, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";
import { activeTime } from "./VisitorsView";

const PAGE = 100;
const LIFECYCLE_LABEL = Object.fromEntries(LIFECYCLES.map((l) => [l.value, l.label]));
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));
const LIFECYCLE_TONE: Record<string, Tone> = { customer: "green", opportunity: "brand", sql: "brand", mql: "violet" };
const BASIS_TONE: Record<Basis, Tone> = { opt_in: "green", soft_opt_in: "green", legitimate_interest: "gray", none: "amber" };

const displayName = (c: { first_name: string | null; last_name: string | null; email: string | null }) => fullName(c) ?? c.email ?? "Contact";
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function useCustomFields(sb: ViewProps["sb"], wsId: string) {
  return useLoad(async () => must(await sb.from("fields").select("key, label, type, options").eq("workspace_id", wsId).eq("object", "contact").order("created_at")) as CustomField[], wsId);
}

export function ContactsView(props: ViewProps) {
  if (props.id) return <ContactPage {...props} />;
  return <ContactsList {...props} />;
}

// The table ------------------------------------------------------------------------------------------------------

type Column = { key: string; label: string; sort?: string; right?: boolean; cell: (c: ContactRow) => React.ReactNode };

function columnsFor(custom: CustomField[]): Column[] {
  const text = (v: unknown) => (v == null || v === "" ? <span className="text-faint">—</span> : String(v));
  return [
    { key: "company", label: "Company", sort: "company", cell: (c) => text(c.company_name ?? c.company_domain) },
    { key: "title", label: "Title", cell: (c) => <span className="block max-w-[220px] truncate">{text(c.title)}</span> },
    { key: "lifecycle", label: "Lifecycle", sort: "lifecycle", cell: (c) => (c.lifecycle ? <Badge tone={LIFECYCLE_TONE[c.lifecycle] ?? "gray"}>{LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle}</Badge> : text(null)) },
    { key: "country", label: "Country", cell: (c) => text(c.country) },
    { key: "score", label: "Score", sort: "score", right: true, cell: (c) => <span className="font-mono text-[12px] tabular-nums">{c.score ?? "—"}</span> },
    { key: "fit", label: "Fit", sort: "fit", right: true, cell: (c) => <span className="font-mono text-[12px] tabular-nums">{c.fit ?? "—"}</span> },
    { key: "lead_status", label: "Lead status", cell: (c) => text(c.lead_status) },
    { key: "phone", label: "Phone", cell: (c) => text(c.phone) },
    { key: "region", label: "State or region", cell: (c) => text(c.region) },
    { key: "source", label: "Source", cell: (c) => <Badge>{SOURCE_LABEL[c.source] ?? c.source}</Badge> },
    { key: "created_at", label: "Created", sort: "created_at", cell: (c) => <span className="font-mono text-[12px] text-muted">{timeAgo(c.created_at)}</span> },
    { key: "updated_at", label: "Updated", sort: "updated_at", cell: (c) => <span className="font-mono text-[12px] text-muted">{timeAgo(c.updated_at)}</span> },
    ...custom.map((f) => ({ key: `f.${f.key}`, label: f.label, cell: (c: ContactRow) => text(f.type === "bool" && c.fields?.[f.key] != null ? (c.fields[f.key] ? "Yes" : "No") : c.fields?.[f.key]) })),
  ];
}

const DEFAULT_COLUMNS = ["company", "title", "lifecycle", "country", "score", "updated_at"];

function useColumns(wsId: string) {
  const key = `claritia:contact-columns:${wsId}`;
  const [cols, setCols] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as string[]) : DEFAULT_COLUMNS;
    } catch {
      return DEFAULT_COLUMNS;
    }
  });
  const set = (c: string[]) => {
    setCols(c);
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {}
  };
  return [cols, set] as const;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ContactsList({ sb, ws, session, navigate }: ViewProps) {
  const custom = useCustomFields(sb, ws.id);
  const fields = contactFilterFields(custom.data ?? []);
  const [stored, setStored] = useFilters("contacts", ws.id);
  // Custom-field filters wait for the fields, so a saved filter isn't dropped while they load.
  const filters = custom.data ? cleanFilters(stored, fields as FilterField<never>[]) : stored.filter((f) => !f.field.startsWith("f."));
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "updated_at", desc: true });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [cols, setCols] = useColumns(ws.id);
  const [panel, setPanel] = useState<"import" | "add" | null>(null);
  const [colsAnchor, setColsAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const query = JSON.stringify({ filters, sort, offset });
  const list = useLoad(
    async () => must(await sb.rpc("contacts_list", { p_ws: ws.id, p_filters: filters, p_sort: sort.key, p_desc: sort.desc, p_limit: PAGE, p_offset: offset })) as { total: number; rows: ContactRow[] },
    `${ws.id}:${query}`,
  );
  const unselect = () => {
    setSelected(new Set());
    setAllMatching(false);
  };
  const setFilters = (f: Filter[]) => {
    setStored(f);
    setOffset(0);
    unselect();
  };
  const goTo = (at: number) => {
    setOffset(at);
    unselect();
  };

  const columns = columnsFor(custom.data ?? []);
  const shown = columns.filter((c) => cols.includes(c.key));
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const count = allMatching ? total : selected.size;

  /** Every contact the current selection means, paging through when all matching are picked. */
  async function picked(): Promise<ContactRow[]> {
    if (!allMatching) return rows.filter((r) => selected.has(r.id));
    const out: ContactRow[] = [];
    for (let at = 0; at < Math.min(total, MAX_ROWS); at += 1000) {
      const page = must(await sb.rpc("contacts_list", { p_ws: ws.id, p_filters: filters, p_sort: sort.key, p_desc: sort.desc, p_limit: 1000, p_offset: at })) as { rows: ContactRow[] };
      out.push(...page.rows);
      if (page.rows.length < 1000) break;
    }
    return out;
  }

  async function exportCsv() {
    setError("");
    setBusy("export");
    try {
      const chosen = await picked();
      const cf = custom.data ?? [];
      const head = ["Email", "First name", "Last name", "Title", "Company", "Company domain", "Phone", "Country", "State or region", "Lifecycle", "Lead status", "Source", "Score", "Created", "Updated", ...cf.map((f) => f.label)];
      const body = chosen.map((c) => [c.email, c.first_name, c.last_name, c.title, c.company_name, c.company_domain, c.phone, c.country, c.region, c.lifecycle, c.lead_status, c.source, c.score, c.created_at, c.updated_at, ...cf.map((f) => c.fields?.[f.key])]);
      download(`contacts-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([head, ...body]));
      must(await sb.rpc("contacts_export_log", { p_ws: ws.id, p_count: chosen.length, p_filters: filters }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!(await askConfirm(`Remove ${count.toLocaleString("en-US")} ${count === 1 ? "contact" : "contacts"}?`, { ok: "Remove", danger: true }))) return;
    setError("");
    setBusy("remove");
    try {
      const ids = (await picked()).map((c) => c.id);
      for (let i = 0; i < ids.length; i += 5000) must(await sb.rpc("contacts_delete", { p_ws: ws.id, p_ids: ids.slice(i, i + 5000) }));
      unselect();
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

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
  const panels = (
    <>
      {panel === "import" ? (
        <ImportPanel
          sb={sb}
          session={session}
          wsId={ws.id}
          custom={custom.data ?? []}
          fieldsChanged={custom.reload}
          onClose={(changed) => {
            setPanel(null);
            if (changed) list.reload();
          }}
        />
      ) : null}
      {panel === "add" ? (
        <ContactPanel
          session={session}
          wsId={ws.id}
          custom={custom.data ?? []}
          onClose={(id) => {
            setPanel(null);
            if (id) navigate("contacts", id);
          }}
        />
      ) : null}
    </>
  );

  if (list.data && total === 0 && !filters.length) {
    return (
      <Page icon={<Contact size={14} />} title="Contacts">
        <ContactsIntro action={actions} />
        {panels}
      </Page>
    );
  }

  const sortBy = (key: string) => {
    setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" && key !== "company" }));
    goTo(0);
  };
  const head = (label: string, key?: string, right = false, id = label) => (
    <Th key={id} className={right ? "text-right" : ""}>
      {key ? (
        <button type="button" onClick={() => sortBy(key)} className="uppercase hover:text-ink">
          {label}
          {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
        </button>
      ) : (
        label
      )}
    </Th>
  );

  return (
    <Page icon={<Contact size={14} />} title="Contacts" count={list.data ? total.toLocaleString("en-US") : undefined} flush actions={actions}>
      <FilterBar
        sb={sb}
        wsId={ws.id}
        screen="contacts"
        fields={fields as FilterField<never>[]}
        filters={filters}
        onChange={setFilters}
        allLabel="All contacts"
        right={
          <Button variant="plain" className="h-8 px-2.5" onClick={(e) => setColsAnchor(colsAnchor ? null : e.currentTarget)}>
            Columns
          </Button>
        }
      />
      {count ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-pale px-4 py-2 text-[13px] md:px-5">
          <span className="font-medium">{count.toLocaleString("en-US")} selected</span>
          {pageAll && !allMatching && total > rows.length ? (
            <Button variant="plain" className="h-7 px-2" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString("en-US")}
            </Button>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <Button variant="ghost" className="h-7 px-2.5" onClick={exportCsv} disabled={!!busy}>
              <Download size={13} />
              {busy === "export" ? "Exporting…" : "Export"}
            </Button>
            <Button variant="danger" className="h-7 px-2.5" onClick={remove} disabled={!!busy}>
              <Trash size={13} />
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
            <Button variant="plain" className="h-7 px-2" onClick={unselect}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="p-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {list.error ? (
        <div className="p-4">
          <ErrorNote message={list.error} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : !rows.length ? (
        <Empty icon={<Contact size={16} />} title="No contacts match" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th className="w-10 pr-0">
                    <CheckBox
                      on={pageAll}
                      label="Select this page"
                      onClick={() => {
                        setAllMatching(false);
                        setSelected(pageAll ? new Set() : new Set(rows.map((r) => r.id)));
                      }}
                    />
                  </Th>
                  {head("Name", "name")}
                  {shown.map((c) => head(c.label, c.sort, c.right, c.key))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => navigate("contacts", c.id)} className={`cursor-pointer hover:bg-hover ${selected.has(c.id) || allMatching ? "bg-hover" : ""}`}>
                    <Td className="w-10 pr-0">
                      <CheckBox
                        on={selected.has(c.id) || allMatching}
                        label="Select"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAllMatching(false);
                          const next = new Set(allMatching ? rows.map((r) => r.id) : selected);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          setSelected(next);
                        }}
                      />
                    </Td>
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar label={displayName(c)} />
                        <span className="flex min-w-0 flex-col">
                          <span className="max-w-[260px] truncate font-medium">{displayName(c)}</span>
                          {fullName(c) ? <span className="max-w-[260px] truncate text-[12px] text-faint">{c.email}</span> : null}
                        </span>
                        {c.person_id ? <Badge tone="brand">On site</Badge> : null}
                      </span>
                    </Td>
                    {shown.map((col) => (
                      <Td key={col.key} className={col.right ? "text-right" : ""}>
                        {col.cell(c)}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 font-mono text-[11.5px] text-muted md:px-5">
            <span>
              {(offset + 1).toLocaleString("en-US")}–{(offset + rows.length).toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            </span>
            <span className="ml-auto flex gap-2">
              <Button variant="ghost" className="h-7 px-2.5" disabled={offset === 0} onClick={() => goTo(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <Button variant="ghost" className="h-7 px-2.5" disabled={offset + PAGE >= total} onClick={() => goTo(offset + PAGE)}>
                Next
              </Button>
            </span>
          </div>
        </>
      )}
      {colsAnchor ? (
        <Popover anchor={colsAnchor} onClose={() => setColsAnchor(null)} width={240}>
          <ul className="max-h-80 overflow-y-auto p-1">
            {columns.map((c) => {
              const on = cols.includes(c.key);
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCols(on ? cols.filter((k) => k !== c.key) : [...cols, c.key])}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
                  >
                    <span className={`flex size-4 items-center justify-center border ${on ? "border-ink bg-ink text-white" : "border-line-strong"}`}>{on ? <Check size={11} /> : null}</span>
                    {c.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover>
      ) : null}
      {panels}
    </Page>
  );
}

function CheckBox({ on, label, onClick }: { on: boolean; label: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} onClick={onClick} className={`flex size-4 items-center justify-center border ${on ? "border-ink bg-ink text-white" : "border-line-strong bg-panel hover:border-ink"}`}>
      {on ? <Check size={11} /> : null}
    </button>
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

function SidePanel({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
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
            {f.type === "enum" || f.type === "bool" ? (
              <Select<string>
                value={fields[f.key] ?? ""}
                onChange={(v) => setFields({ ...fields, [f.key]: v })}
                ariaLabel={f.label}
                options={[
                  { value: "", label: "None" },
                  ...(f.type === "bool" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o))),
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
  contact: ContactRow & { email_clean: string; timezone: string | null; score_reasons: unknown; company_id: string | null };
  company: { id: string; name: string | null; domain: string | null; industry: string | null; size: string | null; account_id: string | null; fit: number | null; intent: number | null; stage: string | null } | null;
  person: { id: string; level: string | null } | null;
  writes: Record<string, { source: string; at: string }>;
  fields: CustomField[];
  consents: { channel: string; basis: Basis; status: string; source: string; at: string }[];
  topics: { name: string; status: string; at: string }[];
  segments: { id: string; name: string; entered_at: string }[];
  events: { kind: string; data: Record<string, unknown>; source: string; at: string }[];
  visits: { id: string; started_at: string; pageviews: number; engaged_s: number; referrer_host: string | null; pages: string[] }[];
};

const EVENT_LABEL: Record<string, string> = { "contact.created": "Added" };

function ContactPage({ sb, ws, session, id, navigate }: ViewProps) {
  const detail = useLoad(async () => must(await sb.rpc("contact_detail", { p_id: id })) as Detail, id);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const back = { label: "Contacts", onClick: () => navigate("contacts") };

  if (detail.error || !detail.data) {
    return (
      <Page icon={<Contact size={14} />} title="Contact" back={back}>
        {detail.error ? <ErrorNote message={detail.error} /> : <Loading />}
      </Page>
    );
  }
  const d = detail.data;
  const c = d.contact;
  const name = displayName(c);
  const consent = d.consents[0];

  async function remove() {
    if (!(await askConfirm(`Remove ${name}?`, { ok: "Remove", danger: true }))) return;
    try {
      must(await sb.rpc("contacts_delete", { p_ws: ws.id, p_ids: [id] }));
      navigate("contacts");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const source = (key: string) => {
    const w = d.writes[key];
    return w ? `${SOURCE_LABEL[w.source] ?? w.source} · ${timeAgo(w.at)}` : null;
  };
  const rows: [string, string, React.ReactNode][] = [
    ["email", "Email", c.email],
    ["first_name", "First name", c.first_name],
    ["last_name", "Last name", c.last_name],
    ["title", "Title", c.title],
    ["company", "Company", d.company?.name ?? d.company?.domain],
    ["phone", "Phone", c.phone],
    ["country", "Country", c.country],
    ["region", "State or region", c.region],
    ["lifecycle", "Lifecycle", c.lifecycle ? (LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle) : null],
    ["lead_status", "Lead status", c.lead_status],
    ...d.fields.map((f): [string, string, React.ReactNode] => {
      const v = c.fields?.[f.key];
      return [`f.${f.key}`, f.label, v == null ? null : f.type === "bool" ? (v ? "Yes" : "No") : String(v)];
    }),
  ];
  const timeline = [
    ...d.events.map((e) => ({ at: e.at, key: `e${e.at}${e.kind}`, node: <span>{`${EVENT_LABEL[e.kind] ?? e.kind} · ${SOURCE_LABEL[e.source] ?? e.source}`}</span> })),
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
    fields: Object.fromEntries(d.fields.map((f) => [f.key, c.fields?.[f.key] == null ? "" : f.type === "bool" ? (c.fields[f.key] ? "yes" : "no") : String(c.fields[f.key])])),
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
        </Panel>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
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

          <div className="flex flex-col gap-5">
            <Panel>
              <CardHead label="Details" />
              <dl className="divide-y divide-line">
                {rows.map(([key, label, value]) => (
                  <div key={key} className="grid grid-cols-[110px_1fr] gap-3 px-4 py-2 text-[13px]">
                    <dt className="text-muted">{label}</dt>
                    <dd className="min-w-0">
                      <span className="block truncate">{value ?? <span className="text-faint">—</span>}</span>
                      {value != null && source(key) ? <span className="font-mono text-[10.5px] text-faint">{source(key)}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            {d.company ? (
              <Panel>
                <CardHead label="Company">
                  {d.company.account_id ? (
                    <Button variant="plain" className="h-7 px-2" onClick={() => navigate("accounts", d.company!.account_id!)}>
                      Open account
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
                      <span className="text-muted">{SOURCE_LABEL[k.source] ?? k.source}</span>
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
              <CardHead label="Segments" count={d.segments.length} />
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
          custom={d.fields}
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
