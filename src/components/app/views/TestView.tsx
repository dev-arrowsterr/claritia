"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cleanSteps, fromYaml, lockOutline, lockPath, MAX_NAME, PRIORITIES, testPath, TestFileError, toYaml, type BlockRef, type Priority, type Step, type TestDoc } from "@/lib/testfile";
import { Copy, ListIcon, Play, Trash } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { Select } from "../Select";
import { StepsEditor } from "../StepsEditor";
import { TestPreview, TestRunLog } from "./TestRuns";
import { Badge, Button, ErrorNote, errorText, Field, Loading, Page, Panel, postJson, PriorityBars, Segmented, setLeaveGuard, Tabs, timeAgo, type Environment, type ViewProps } from "../ui";

export type TestRow = TestDoc & { id: string; project_id: string; lock: string | null; version: number; created_at: string; updated_at: string };
type Version = TestDoc & { id: string; version: number; lock: string | null; author_email: string | null; created_at: string };
type Tab = "steps" | "yaml" | "code" | "preview" | "runs" | "history";
type LockCheck = { ok: true; steps: number; actions: number; secrets: string[] } | { ok: false; errors: { line: number; message: string }[] };

const NEW_USE_CASE = "__new";
const TEST_COLUMNS = "id, project_id, name, use_case, priority, steps, lock, version, created_at, updated_at";

/** A file view: its path in a bar on top, the text below, and a copy button. */
function FileBox({ path, text, badge, children }: { path: string; text: string; badge?: React.ReactNode; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="frame overflow-hidden border border-line bg-panel">
      <div className="flex h-10 items-center gap-2 border-b border-line bg-canvas px-3">
        <span className="truncate font-mono text-[12px] text-muted">{path}</span>
        {badge}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-hover hover:text-ink"
        >
          <Copy size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {children ?? <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6 text-ink">{text}</pre>}
    </div>
  );
}

export function TestView({ sb, session, project, id, navigate }: ViewProps) {
  const [saved, setSaved] = useState<TestRow | null>(null);
  const [doc, setDoc] = useState<TestDoc | null>(null);
  const [blocks, setBlocks] = useState<BlockRef[]>([]);
  const [useCases, setUseCases] = useState<string[]>([]);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [tab, setTab] = useState<Tab>("steps");
  const [yamlText, setYamlText] = useState("");
  const [yamlError, setYamlError] = useState("");
  const [picked, setPicked] = useState<Version | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The Playwright code. Until someone edits it, it follows the steps as an outline.
  const [lockText, setLockText] = useState("");
  const [lockTouched, setLockTouched] = useState(false);
  const [lockErrors, setLockErrors] = useState<{ line: number; message: string }[]>([]);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [envId, setEnvId] = useState("");
  const [starting, setStarting] = useState(false);

  // The test, the project's blocks and the use cases already in use.
  useEffect(() => {
    if (!project) return;
    let live = true;
    Promise.all([
      sb.from("tests").select(TEST_COLUMNS).eq("id", id).maybeSingle(),
      sb.from("blocks").select("id, name").eq("project_id", project.id).order("name"),
      sb.from("tests").select("use_case").eq("project_id", project.id),
      sb.from("environments").select("id, project_id, name, base_url, created_at").eq("project_id", project.id).order("created_at"),
    ]).then(([t, b, u, e]) => {
      if (!live) return;
      const err = t.error ?? b.error ?? u.error ?? e.error;
      if (err) return setError(err.message);
      if (!t.data) return setError("This test was deleted or isn't in this project.");
      const row = t.data as TestRow;
      setSaved(row);
      setDoc({ name: row.name, use_case: row.use_case, priority: row.priority, steps: row.steps });
      setBlocks(b.data as BlockRef[]);
      setUseCases([...new Set((u.data as { use_case: string }[]).map((r) => r.use_case))].sort());
      setEnvs(e.data as Environment[]);
      setEnvId((e.data as Environment[])[0]?.id ?? "");
      setLockText(row.lock ?? "");
      setLockTouched(false);
    });
    return () => {
      live = false;
    };
  }, [sb, project, id]);

  const loadVersions = useCallback(() => {
    sb.from("test_versions")
      .select("id, version, name, use_case, priority, steps, lock, author_email, created_at")
      .eq("test_id", id)
      .order("version", { ascending: false })
      .limit(100)
      .then((res) => (res.error ? setError(res.error.message) : setVersions(res.data as Version[])));
  }, [sb, id]);

  const cleaned = useMemo(() => (doc ? { ...doc, name: doc.name.trim(), steps: cleanSteps(doc.steps) } : null), [doc]);
  const lockChanged = lockTouched && lockText !== (saved?.lock ?? "");
  const dirty = !!(saved && cleaned && (lockChanged || JSON.stringify([cleaned.name, cleaned.use_case, cleaned.priority, cleaned.steps]) !== JSON.stringify([saved.name, saved.use_case, saved.priority, saved.steps])));

  // Ask before leaving with unsaved changes, in the app and when closing the tab.
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(() => askConfirm("Leave without saving?", { body: "Your changes to this test will be lost.", ok: "Leave", danger: true }));
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  // YAML edits apply when you leave the YAML tab or save.
  const applyYaml = (): TestDoc | null => {
    if (!doc || !saved) return null;
    try {
      const next = fromYaml(yamlText, blocks, doc.steps);
      setDoc(next);
      setYamlError("");
      return next;
    } catch (e) {
      setYamlError(e instanceof TestFileError ? e.message : errorText(e));
      return null;
    }
  };

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    if (tab === "yaml" && !applyYaml()) return;
    if (next === "yaml" && doc) {
      setYamlText(toYaml(doc, blocks));
      setYamlError("");
    }
    if (next === "history") loadVersions();
    setPicked(null);
    setTab(next);
  };

  const save = async () => {
    if (!saved || !doc) return;
    const current = tab === "yaml" ? applyYaml() : doc;
    if (!current) return;
    const body: TestDoc & { lock?: string | null } = { ...current, name: current.name.trim(), steps: cleanSteps(current.steps) };
    if (!body.name) return setError("Give the test a name.");
    setBusy(true);
    setError("");
    try {
      if (lockChanged) {
        const check = await postJson<LockCheck>(session, "/api/lock/check", { code: lockText });
        if (!check.ok) {
          setLockErrors(check.errors);
          setTab("code");
          throw new Error(`The code has ${check.errors.length === 1 ? "a problem" : `${check.errors.length} problems`}. Fix ${check.errors.length === 1 ? "it" : "them"} in the Code tab, then save.`);
        }
        setLockErrors([]);
        body.lock = lockText.trim() ? lockText : null;
      }
      // Only saves over the version this page loaded, so two people can't overwrite each other without knowing.
      const res = await sb.from("tests").update(body).eq("id", saved.id).eq("version", saved.version).select(TEST_COLUMNS).maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw new Error("Someone else saved this test after you opened it. Copy your changes, then reload the page.");
      const row = res.data as TestRow;
      setSaved(row);
      setDoc({ name: row.name, use_case: row.use_case, priority: row.priority, steps: row.steps });
      setLockText(row.lock ?? "");
      setLockTouched(false);
      if (tab === "yaml") setYamlText(toYaml(row, blocks));
      if (!useCases.includes(row.use_case)) setUseCases([...useCases, row.use_case].sort());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Cmd+S or Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !busy) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const run = async () => {
    if (!saved) return;
    setStarting(true);
    setError("");
    try {
      const res = await postJson<{ id: string }>(session, "/api/runs", { testId: saved.id, environmentId: envId || undefined });
      navigate("runs", res.id);
    } catch (e) {
      setError(errorText(e));
      setStarting(false);
    }
  };

  const remove = async () => {
    if (!saved) return;
    if (!(await askConfirm(`Delete ${saved.name}?`, { body: "Its history is deleted too.", ok: "Delete test", danger: true }))) return;
    setLeaveGuard(null);
    const res = await sb.from("tests").delete().eq("id", saved.id);
    if (res.error) return setError(res.error.message);
    navigate("tests");
  };

  const back = { label: "Tests", onClick: () => navigate("tests") };
  if (error && !saved)
    return (
      <Page icon={<ListIcon size={14} />} title="Test" back={back}>
        <ErrorNote message={error} />
      </Page>
    );
  if (!saved || !doc) return <Loading />;

  const useCaseOptions = [...new Set([...useCases, doc.use_case])].sort().map((u) => ({ value: u, label: u }));
  useCaseOptions.push({ value: NEW_USE_CASE, label: "New use case…" });
  const shownLock = lockTouched || saved.lock ? lockText : lockOutline(cleaned ?? doc, blocks);
  const errorLines = new Set(lockErrors.map((e) => e.line));

  return (
    <Page
      icon={<ListIcon size={14} />}
      title={doc.name || "Untitled test"}
      back={back}
      flush
      actions={
        <>
          {dirty ? <Badge tone="amber">Unsaved</Badge> : <span className="hidden font-mono text-[11px] text-faint sm:inline">v{saved.version}</span>}
          <button type="button" aria-label="Delete test" title="Delete test" onClick={remove} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
            <Trash size={14} />
          </button>
          {envs.length > 1 ? (
            <Select value={envId} options={envs.map((e) => ({ value: e.id, label: e.name }))} onChange={setEnvId} ariaLabel="Environment" className="hidden h-8 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong sm:inline-flex" />
          ) : null}
          <Button variant="ghost" onClick={run} disabled={dirty || starting || !saved.steps.length} title={dirty ? "Save first" : !saved.steps.length ? "Add a step first" : undefined}>
            <Play size={13} />
            {starting ? "Starting…" : "Run"}
          </Button>
          <Button onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={switchTab}
        tabs={[
          { value: "steps", label: "Steps", count: doc.steps.length },
          { value: "yaml", label: "YAML" },
          { value: "code", label: "Code" },
          { value: "preview", label: "Preview" },
          { value: "runs", label: "Run log" },
          { value: "history", label: "History", count: saved.version },
        ]}
      />
      <div className="paper min-h-full p-4 md:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          <ErrorNote message={error} />

          {tab === "steps" ? (
            <>
              <Panel className="grid gap-4 p-4 sm:grid-cols-[1fr_200px]">
                <div className="sm:col-span-2">
                  <Field label="Name">
                    <input
                      value={doc.name}
                      maxLength={MAX_NAME}
                      onChange={(e) => setDoc({ ...doc, name: e.target.value })}
                      placeholder="Checkout with a coupon"
                      className="h-10 w-full rounded-md border border-line bg-panel px-2.5 text-[15px] font-medium text-ink outline-none placeholder:text-faint focus:border-ink"
                    />
                  </Field>
                </div>
                <Field label="Use case">
                  <Select
                    value={doc.use_case}
                    options={useCaseOptions}
                    ariaLabel="Use case"
                    onChange={async (v) => {
                      if (v !== NEW_USE_CASE) return setDoc({ ...doc, use_case: v });
                      const name = await askText("New use case", { placeholder: "Checkout", ok: "Add" });
                      if (name) setDoc({ ...doc, use_case: name.slice(0, 60) });
                    }}
                    className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
                  />
                </Field>
                <Field label="Priority">
                  <Segmented<Priority> value={doc.priority} label="Priority" onChange={(p) => setDoc({ ...doc, priority: p })} options={PRIORITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
                </Field>
              </Panel>
              <section className="flex flex-col gap-3">
                <p className="section-head">Steps</p>
                <StepsEditor steps={doc.steps} onChange={(steps: Step[]) => setDoc({ ...doc, steps })} blocks={blocks} allowUse />
              </section>
            </>
          ) : null}

          {tab === "yaml" ? (
            <>
              <FileBox path={testPath(doc.name)} text={yamlText}>
                <textarea
                  value={yamlText}
                  onChange={(e) => setYamlText(e.target.value)}
                  spellCheck={false}
                  aria-label="Test as YAML"
                  rows={Math.max(12, yamlText.split("\n").length + 2)}
                  className="block w-full resize-y bg-panel p-4 font-mono text-[12.5px] leading-6 text-ink outline-none"
                />
              </FileBox>
              <ErrorNote message={yamlError} />
            </>
          ) : null}

          {tab === "code" ? (
            <>
              <FileBox path={lockPath(doc.name)} text={shownLock} badge={saved.lock ? <Badge tone="green">Saved</Badge> : <Badge>Outline</Badge>}>
                <div className="flex">
                  <div aria-hidden="true" className="shrink-0 border-r border-line bg-canvas py-4 text-right font-mono text-[12.5px] leading-6 text-faint select-none">
                    {shownLock.split("\n").map((_, i) => (
                      <div key={i} className={`px-2.5 ${errorLines.has(i + 1) ? "bg-danger-soft text-danger" : ""}`}>
                        {i + 1}
                      </div>
                    ))}
                  </div>
                  <textarea
                    value={shownLock}
                    onChange={(e) => {
                      setLockText(e.target.value);
                      setLockTouched(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Tab") return;
                      e.preventDefault();
                      const t = e.currentTarget;
                      const at = t.selectionStart;
                      const next = `${t.value.slice(0, at)}  ${t.value.slice(t.selectionEnd)}`;
                      setLockText(next);
                      setLockTouched(true);
                      requestAnimationFrame(() => t.setSelectionRange(at + 2, at + 2));
                    }}
                    spellCheck={false}
                    wrap="off"
                    aria-label="Playwright code"
                    rows={Math.max(14, shownLock.split("\n").length + 1)}
                    className="block min-w-0 flex-1 resize-y overflow-x-auto bg-panel p-4 font-mono text-[12.5px] leading-6 text-ink outline-none"
                  />
                </div>
              </FileBox>
              {lockErrors.length ? (
                <ul className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                  {lockErrors.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono">Line {e.line}:</span> {e.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          {tab === "preview" ? <TestPreview sb={sb} testId={saved.id} navigate={navigate} /> : null}
          {tab === "runs" ? <TestRunLog sb={sb} testId={saved.id} navigate={navigate} /> : null}

          {tab === "history" ? (
            !versions ? (
              <Loading />
            ) : picked ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" onClick={() => setPicked(null)}>
                    All versions
                  </Button>
                  <span className="text-[13px] text-muted">
                    v{picked.version} · {timeAgo(picked.created_at)}
                    {picked.author_email ? ` · ${picked.author_email}` : ""}
                  </span>
                  {picked.version !== saved.version ? (
                    <Button
                      className="ml-auto"
                      onClick={() => {
                        setDoc({ name: picked.name, use_case: picked.use_case, priority: picked.priority, steps: picked.steps });
                        setLockText(picked.lock ?? "");
                        setLockTouched(true);
                        setPicked(null);
                        setTab("steps");
                      }}
                    >
                      Restore this version
                    </Button>
                  ) : null}
                </div>
                <FileBox path={testPath(picked.name)} text={toYaml(picked, blocks)} />
              </>
            ) : (
              <Panel>
                <ul className="divide-y divide-line">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <button type="button" onClick={() => setPicked(v)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
                        <span className="w-10 shrink-0 font-mono text-[12px] text-muted">v{v.version}</span>
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{v.name}</span>
                        <span className="hidden text-[12px] text-muted sm:inline">{v.steps.length} steps</span>
                        <span className="hidden max-w-48 truncate text-[12px] text-muted md:inline">{v.author_email ?? "—"}</span>
                        <span className="w-20 shrink-0 text-right text-[12px] text-muted">{timeAgo(v.created_at)}</span>
                        <span className="flex w-16 shrink-0 justify-end">{v.version === saved.version ? <Badge tone="brand">Current</Badge> : null}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            )
          ) : null}

          <div className="flex items-center gap-3 text-[12px] text-faint">
            <PriorityBars value={doc.priority} />
            <span>·</span>
            <span>{doc.use_case}</span>
            <span>·</span>
            <span>Saved {timeAgo(saved.updated_at)}</span>
          </div>
        </div>
      </div>
    </Page>
  );
}
