"use client";

import { useEffect, useMemo, useState } from "react";
import { cleanSteps, isUse, MAX_NAME, slug, stepId, type Step } from "@/lib/testfile";
import { Box, Plus, Trash } from "../../Icons";
import { askConfirm, askText } from "../Dialogs";
import { StepsEditor } from "../StepsEditor";
import { Badge, Button, Empty, ErrorNote, errorText, Field, Loading, must, Page, Panel, setLeaveGuard, Th, timeAgo, useLoad, type ViewProps } from "../ui";

type BlockRow = { id: string; name: string; steps: Step[]; updated_at: string };

/** How many tests use each block. */
async function usage(sb: ViewProps["sb"], projectId: string) {
  const tests = must(await sb.from("tests").select("steps").eq("project_id", projectId)) as { steps: Step[] }[];
  const count = new Map<string, number>();
  for (const t of tests) for (const id of new Set(t.steps.flatMap((s) => (isUse(s) ? [s.block] : [])))) count.set(id, (count.get(id) ?? 0) + 1);
  return count;
}

function BlockEditor({ sb, project, id, navigate }: ViewProps) {
  const [saved, setSaved] = useState<BlockRow | null>(null);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [used, setUsed] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    let live = true;
    Promise.all([sb.from("blocks").select("id, name, steps, updated_at").eq("id", id).maybeSingle(), usage(sb, project.id)])
      .then(([b, count]) => {
        if (!live) return;
        if (b.error) return setError(b.error.message);
        if (!b.data) return setError("This block was deleted or isn't in this project.");
        const row = b.data as BlockRow;
        setSaved(row);
        setName(row.name);
        setSteps(row.steps);
        setUsed(count.get(row.id) ?? 0);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [sb, project, id]);

  const clean = useMemo(() => cleanSteps(steps), [steps]);
  const dirty = !!saved && (name.trim() !== saved.name || JSON.stringify(clean) !== JSON.stringify(saved.steps));

  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(() => askConfirm("Leave without saving?", { body: "Your changes to this block will be lost.", ok: "Leave", danger: true }));
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  const save = async () => {
    if (!saved) return;
    if (!name.trim()) return setError("Give the block a name.");
    setBusy(true);
    setError("");
    try {
      const row = must(await sb.from("blocks").update({ name: name.trim(), steps: clean }).eq("id", saved.id).select("id, name, steps, updated_at").single()) as BlockRow;
      setSaved(row);
      setName(row.name);
      setSteps(row.steps);
    } catch (e) {
      const text = errorText(e);
      setError(/duplicate key/i.test(text) ? "Another block already has that name." : text);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!saved) return;
    if (used) return setError(`${used} ${used === 1 ? "test uses" : "tests use"} this block. Remove it from ${used === 1 ? "that test" : "those tests"} first.`);
    if (!(await askConfirm(`Delete ${saved.name}?`, { ok: "Delete block", danger: true }))) return;
    setLeaveGuard(null);
    const res = await sb.from("blocks").delete().eq("id", saved.id);
    if (res.error) return setError(res.error.message);
    navigate("blocks");
  };

  const back = { label: "Blocks", onClick: () => navigate("blocks") };
  if (!saved)
    return error ? (
      <Page icon={<Box size={14} />} title="Block" back={back}>
        <ErrorNote message={error} />
      </Page>
    ) : (
      <Loading />
    );

  return (
    <Page
      icon={<Box size={14} />}
      title={name || "Untitled block"}
      back={back}
      actions={
        <>
          {dirty ? <Badge tone="amber">Unsaved</Badge> : null}
          <button type="button" aria-label="Delete block" title="Delete block" onClick={remove} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
            <Trash size={14} />
          </button>
          <Button onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <ErrorNote message={error} />
        <Panel className="flex flex-col gap-3 p-4">
          <Field label="Name">
            <input
              value={name}
              maxLength={MAX_NAME}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sign in"
              className="h-10 w-full rounded-md border border-line bg-panel px-2.5 text-[15px] font-medium text-ink outline-none placeholder:text-faint focus:border-ink"
            />
          </Field>
          <p className="font-mono text-[11.5px] text-muted">
            use: {slug(name)} · {used} {used === 1 ? "test" : "tests"}
          </p>
        </Panel>
        <section className="flex flex-col gap-3">
          <p className="section-head">Steps</p>
          <StepsEditor steps={steps} onChange={setSteps} blocks={[]} allowUse={false} />
        </section>
      </div>
    </Page>
  );
}

export function BlocksView(props: ViewProps) {
  const { sb, project, id, navigate } = props;
  const [error, setError] = useState("");
  const list = useLoad(async () => {
    if (!project) return null;
    const [rows, count] = await Promise.all([sb.from("blocks").select("id, name, steps, updated_at").eq("project_id", project.id).order("name"), usage(sb, project.id)]);
    return { rows: must(rows) as BlockRow[], count };
  }, project?.id ?? "none");

  if (id && project) return <BlockEditor key={id} {...props} />;

  const create = async () => {
    if (!project) return;
    const name = await askText("New block", { placeholder: "Sign in", ok: "Create" });
    if (!name) return;
    try {
      const row = must(await sb.from("blocks").insert({ project_id: project.id, name, steps: [{ id: stepId(), kind: "do", text: "" }] }).select("id").single()) as { id: string };
      navigate("blocks", row.id);
    } catch (e) {
      const text = errorText(e);
      setError(/duplicate key/i.test(text) ? "Another block already has that name." : text);
    }
  };

  const rows = list.data?.rows;
  return (
    <Page
      icon={<Box size={14} />}
      title="Blocks"
      count={rows?.length}
      flush={!!rows?.length}
      actions={
        project ? (
          <Button onClick={create}>
            <Plus size={13} />
            New block
          </Button>
        ) : null
      }
    >
      {error || list.error ? (
        <div className="p-4">
          <ErrorNote message={error || list.error} />
        </div>
      ) : null}
      {!project ? (
        <Empty icon={<Box size={16} />} title="Add a project first." />
      ) : !list.data ? (
        <Loading />
      ) : !rows?.length ? (
        <Empty icon={<Box size={16} />} title="Steps you reuse across tests, like signing in, show up here." />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th className="hidden w-48 sm:table-cell">Reference</Th>
              <Th className="w-20">Steps</Th>
              <Th className="w-24">Used in</Th>
              <Th className="hidden w-28 md:table-cell">Updated</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} onClick={() => navigate("blocks", b.id)} className="cursor-pointer hover:bg-hover">
                <td className="h-12 border-b border-line px-4 text-[13.5px]">
                  <a
                    href={`/blocks/${b.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate("blocks", b.id);
                    }}
                    className="inline-flex items-center gap-2 font-medium text-ink"
                  >
                    <Box size={14} className="text-violet" />
                    {b.name}
                  </a>
                </td>
                <td className="hidden border-b border-line px-4 font-mono text-[12px] text-muted sm:table-cell">use: {slug(b.name)}</td>
                <td className="border-b border-line px-4 font-mono text-[12px] text-muted">{b.steps.length}</td>
                <td className="border-b border-line px-4 text-[12.5px] text-muted">
                  {list.data!.count.get(b.id) ?? 0} {(list.data!.count.get(b.id) ?? 0) === 1 ? "test" : "tests"}
                </td>
                <td className="hidden border-b border-line px-4 text-[12px] text-muted md:table-cell">{timeAgo(b.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
