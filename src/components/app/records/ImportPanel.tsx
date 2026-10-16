"use client";

// The import wizard (docs/conversion-parity.md 4.9): upload or paste, map columns, say what the list is and where it
// came from, preview 20 rows with what will happen to each, run, then the report with the error file and Undo.
// Files go straight to storage; small ones import at once, big ones run in the background and show progress.

import { useEffect, useState } from "react";
import { BASES, IMPORT_SOURCES, sourceRefused, type Basis, type ImportSource } from "@/lib/contacts/consent";
import { TARGETS, type CustomField, type Target } from "@/lib/contacts/fields";
import { Upload } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Select } from "../Select";
import { Badge, Button, ErrorNote, errorText, Field, Loading, must, Panel, postJson, Segmented, Td, Th, type Tone, type ViewProps } from "../ui";
import { SidePanel } from "./SidePanel";

type Inspect = { kind: string; size: number; sheets: string[]; sheet: string | null; header: string[]; samples: string[][]; rows: number; exact: boolean; guessed: Target[] };
type PreviewRow = { row: number; email: string; name: string; company: string; outcome: "new" | "update" | "suppressed" | "skip" | "erased"; reason?: string };
type ImportRow = { id: string; status: string; counts: Record<string, unknown>; progress: { rows?: number }; errors_path: string | null; error: string | null; undo_until: string | null };
type ListKind = "contacts" | "unsubscribed" | "bounced";

const NEW_FIELD = "__new" as Target;
const OUTCOME: Record<PreviewRow["outcome"], { label: string; tone: Tone }> = {
  new: { label: "New", tone: "green" },
  update: { label: "Update", tone: "brand" },
  suppressed: { label: "Unsubscribed", tone: "amber" },
  skip: { label: "Skip", tone: "red" },
  erased: { label: "Erased", tone: "gray" },
};

const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file.csv";

export function ImportPanel({
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
  const [how, setHow] = useState<"file" | "paste">("file");
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<{ name: string; path: string; kind: "file" | "paste" } | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [columns, setColumns] = useState<Target[]>([]);
  const [list, setList] = useState<ListKind>("contacts");
  const [source, setSource] = useState<ImportSource | "">("");
  const [basis, setBasis] = useState<Basis | "">("");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [imp, setImp] = useState<ImportRow | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = async (label: string, fn: () => Promise<void>) => {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const inspect = (f: { name: string; path: string }, sheet?: string | null) =>
    run("inspect", async () => {
      const r = await postJson<Inspect>(session, "/api/contacts/import/inspect", { workspaceId: wsId, path: f.path, fileName: f.name, sheet });
      setInfo(r);
      setColumns(r.guessed);
      setPreview(null);
    });

  const upload = (blob: Blob, name: string, kind: "file" | "paste") =>
    run("upload", async () => {
      const clean = safeName(name);
      const path = `${wsId}/${crypto.randomUUID()}/${clean}`;
      const { error: e } = await sb.storage.from("imports").upload(path, blob, { contentType: blob.type || "text/csv", upsert: false });
      if (e) throw new Error(e.message);
      const f = { name: clean, path, kind };
      setFile(f);
      const r = await postJson<Inspect>(session, "/api/contacts/import/inspect", { workspaceId: wsId, path, fileName: clean });
      setInfo(r);
      setColumns(r.guessed);
    });

  // Follow a background import, or an undo, until it settles.
  const settled = !!imp && !["queued", "running", "undoing"].includes(imp.status);
  useEffect(() => {
    if (!importId || settled) return;
    let live = true;
    const tick = async () => {
      const { data } = await sb.from("imports").select("id, status, counts, progress, errors_path, error, undo_until").eq("id", importId).single();
      if (live && data) setImp(data as ImportRow);
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [sb, importId, settled]);

  async function choose(i: number, t: Target) {
    let target = t;
    if (t === NEW_FIELD) {
      const label = await askText("New field", { initial: info?.header[i] ?? "", ok: "Add" });
      if (!label) return;
      try {
        const made = must(await sb.rpc("field_add", { p_ws: wsId, p_object: "contact", p_label: label, p_type: "text" })) as { key: string };
        fieldsChanged();
        target = `f.${made.key}`;
      } catch (e) {
        return setError(errorText(e));
      }
    }
    setPreview(null);
    setColumns((cols) => cols.map((c, j) => (j === i ? target : target !== "skip" && c === target ? "skip" : c)));
  }

  const hasBasisColumn = columns.includes("basis");
  const refused = source !== "" && sourceRefused(source);
  const blocking = list !== "contacts";
  const mapping = { columns, source, basis: basis || null, list };
  const ready = !!info && columns.includes("email") && !!source && !refused && (hasBasisColumn || !!basis || blocking);

  const doPreview = () =>
    run("preview", async () => {
      const r = await postJson<{ rows: PreviewRow[] }>(session, "/api/contacts/import/preview", { workspaceId: wsId, path: file!.path, fileName: file!.name, sheet: info!.sheet, mapping });
      setPreview(r.rows);
    });
  const start = () =>
    run("start", async () => {
      const r = await postJson<{ importId: string }>(session, "/api/contacts/import", { workspaceId: wsId, path: file!.path, fileName: file!.name, sheet: info!.sheet, mapping, kind: file!.kind });
      setImportId(r.importId);
    });
  const undo = async () => {
    if (!importId || !(await askConfirm("Undo this import?", { body: "Contacts it added that nobody changed since are removed, and values it changed go back. Unsubscribes stay.", ok: "Undo", danger: true }))) return;
    await run("undo", async () => {
      must(await sb.rpc("import_undo", { p_import: importId }));
      setImp((x) => (x ? { ...x, status: "undoing" } : x));
    });
  };
  const errorsFile = () =>
    run("errors", async () => {
      const { data, error: e } = await sb.storage.from("imports").createSignedUrl(imp!.errors_path!, 120, { download: "import-errors.csv" });
      if (e || !data) throw new Error(e?.message ?? "The file is gone");
      window.location.href = data.signedUrl;
    });

  const targetOptions = [...TARGETS, ...custom.map((f) => ({ value: `f.${f.key}` as Target, label: f.label })), { value: NEW_FIELD, label: "New field…" }];
  const sample = (i: number) =>
    (info?.samples ?? [])
      .map((r) => r[i]?.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");

  // After it started: progress, then the report.
  if (importId) {
    const c = (imp?.counts ?? {}) as Record<string, number> & { skipped?: Record<string, number> };
    const skipped = (c.skipped?.missing_email ?? 0) + (c.skipped?.invalid_email ?? 0) + (c.skipped?.disposable ?? 0);
    const going = !imp || imp.status === "queued" || imp.status === "running";
    const done = imp?.status === "done";
    const tiles: [string, number][] = [
      ["Rows", c.rows ?? 0],
      ["Created", c.created ?? 0],
      ["Updated", c.changed ?? 0],
      ["Merged", c.merged ?? 0],
      ["Unsubscribed", c.suppressed ?? 0],
      ["Skipped", skipped],
      ["No email consent", c.no_basis ?? 0],
    ];
    return (
      <SidePanel
        title="Import"
        wide
        onClose={() => onClose(true)}
        footer={
          <>
            {done && imp?.errors_path ? (
              <Button variant="ghost" onClick={errorsFile} disabled={!!busy}>
                Download errors
              </Button>
            ) : null}
            {done && imp?.undo_until && new Date(imp.undo_until) > new Date() ? (
              <Button variant="danger" onClick={undo} disabled={!!busy}>
                Undo
              </Button>
            ) : null}
            <Button onClick={() => onClose(true)}>Done</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 p-5">
          <ErrorNote message={error || (imp?.status === "failed" ? (imp.error ?? "The import stopped") : "")} />
          {going ? (
            <Panel>
              <div className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-2 text-[13px]">
                  <Badge tone="brand">{imp?.status === "queued" ? "Waiting" : "Importing"}</Badge>
                  <span className="font-mono text-[12px] text-muted tabular-nums">
                    {(imp?.progress?.rows ?? 0).toLocaleString("en-US")} of {info?.exact ? "" : "about "}
                    {(info?.rows ?? 0).toLocaleString("en-US")} rows
                  </span>
                </div>
                <div className="h-1.5 bg-hover">
                  <div className="h-full bg-ink transition-[width]" style={{ width: `${Math.min(100, ((imp?.progress?.rows ?? 0) / Math.max(1, info?.rows ?? 1)) * 100)}%` }} />
                </div>
              </div>
            </Panel>
          ) : imp?.status === "undoing" ? (
            <Panel>
              <div className="flex items-center gap-2 p-5 text-[13px]">
                <Badge tone="amber">Undoing</Badge>
              </div>
            </Panel>
          ) : imp?.status === "undone" ? (
            <Panel>
              <div className="flex items-center gap-2 p-5 text-[13px]">
                <Badge>Undone</Badge>
                <span className="text-muted">
                  {Number(c.undo_removed ?? 0).toLocaleString("en-US")} removed · {Number(c.undo_restored ?? 0).toLocaleString("en-US")} values put back
                </span>
              </div>
            </Panel>
          ) : null}
          {imp && !going ? (
            <div className="grid grid-cols-2 border-t border-l border-line sm:grid-cols-4">
              {tiles.map(([label, v]) => (
                <div key={label} className="border-r border-b border-line px-5 py-4">
                  <div className="label-mono">{label}</div>
                  <div className="mt-1 text-[22px] font-medium tabular-nums">{Number(v).toLocaleString("en-US")}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </SidePanel>
    );
  }

  return (
    <SidePanel
      title="Import"
      wide
      onClose={() => onClose(false)}
      footer={
        info ? (
          <>
            <Button
              variant="plain"
              onClick={() => {
                setFile(null);
                setInfo(null);
                setPreview(null);
              }}
              disabled={!!busy}
            >
              Start over
            </Button>
            {preview ? (
              <Button onClick={start} disabled={!ready || !!busy}>
                {busy === "start" ? "Starting…" : `Import ${info.exact ? "" : "about "}${info.rows.toLocaleString("en-US")} rows`}
              </Button>
            ) : (
              <Button onClick={doPreview} disabled={!ready || !!busy}>
                {busy === "preview" ? "Checking…" : "Preview"}
              </Button>
            )}
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-5 p-5">
        <ErrorNote message={error} />
        {!info ? (
          busy ? (
            <Loading />
          ) : (
            <>
              <Segmented<"file" | "paste">
                value={how}
                onChange={setHow}
                label="How"
                options={[
                  { value: "file", label: "File" },
                  { value: "paste", label: "Paste" },
                ]}
              />
              {how === "file" ? (
                <label className="frame flex cursor-pointer flex-col items-center gap-3 border border-dashed border-line-strong bg-canvas px-6 py-16 text-center hover:border-ink">
                  <Upload size={18} />
                  <span className="text-[14px] font-medium">Choose a file</span>
                  <span className="font-mono text-[11px] text-faint">CSV · TSV · Excel · vCard</span>
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.tab,.xlsx,.xlsm,.vcf,.vcard,text/csv"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f, f.name, "file");
                    }}
                  />
                </label>
              ) : (
                <>
                  <textarea
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    rows={12}
                    placeholder={"email,first name,company\njane@acme.com,Jane,Acme"}
                    className="w-full rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-[12.5px] outline-none focus:border-ink"
                  />
                  <div>
                    <Button
                      disabled={!paste.trim()}
                      onClick={() => {
                        // A bare list of emails gets a header.
                        const text = /^[^,;\t\n]+@[^,;\t\n]+$/m.test(paste.trim().split("\n")[0]) ? `email\n${paste.trim()}` : paste.trim();
                        void upload(new Blob([text], { type: "text/csv" }), "pasted.csv", "paste");
                      }}
                    >
                      Continue
                    </Button>
                  </div>
                </>
              )}
            </>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium">{file?.name}</span>
              <span className="font-mono text-[11.5px] text-faint">
                {info.exact ? "" : "about "}
                {info.rows.toLocaleString("en-US")} rows
              </span>
              {info.sheets.length > 1 ? (
                <Select<string>
                  value={info.sheet ?? info.sheets[0]}
                  onChange={(s) => void inspect(file!, s)}
                  ariaLabel="Sheet"
                  options={info.sheets.map((s) => ({ value: s, label: s }))}
                  className="ml-auto h-8 w-48 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
                />
              ) : null}
            </div>

            {preview ? (
              <Panel>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Email</Th>
                      <Th>Name</Th>
                      <Th>Company</Th>
                      <Th>Result</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r) => (
                      <tr key={r.row}>
                        <Td className="font-mono text-[12px] text-faint">{r.row}</Td>
                        <Td className="max-w-[220px] truncate">{r.email || <span className="text-faint">—</span>}</Td>
                        <Td className="max-w-[160px] truncate">{r.name}</Td>
                        <Td className="max-w-[160px] truncate">{r.company}</Td>
                        <Td>
                          <span className="flex items-center gap-2">
                            <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                            {r.reason ? <span className="text-[12px] text-muted">{r.reason}</span> : null}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ) : (
              <>
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
                      {info.header.map((h, i) => (
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
                <Field label="This list is">
                  <Segmented<ListKind>
                    value={list}
                    onChange={setList}
                    options={[
                      { value: "contacts", label: "Contacts" },
                      { value: "unsubscribed", label: "Unsubscribes" },
                      { value: "bounced", label: "Bounces" },
                    ]}
                  />
                </Field>
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
                  {!blocking ? (
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
                  ) : null}
                </div>
                {refused ? <ErrorNote message="Bought or rented lists can't be imported." /> : null}
              </>
            )}
          </>
        )}
      </div>
    </SidePanel>
  );
}
