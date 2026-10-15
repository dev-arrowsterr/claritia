"use client";

// Settings › Imports: every import in the workspace with its state and counts, the rows that didn't come in, and
// undo for 30 days (docs/conversion-weeks.md week 2).

import { useEffect, useState } from "react";
import { Download } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Badge, Button, CardHead, ErrorNote, errorText, Loading, must, Panel, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";

type Imp = {
  id: string;
  file_name: string | null;
  kind: string | null;
  status: string;
  counts: Record<string, unknown>;
  progress: { rows?: number } | null;
  rows_done: number | null;
  errors_path: string | null;
  error: string | null;
  undo_until: string | null;
  created_at: string;
};

const STATUS: Record<string, [string, Tone]> = {
  queued: ["Queued", "gray"],
  running: ["Running", "brand"],
  done: ["Done", "green"],
  failed: ["Failed", "red"],
  undoing: ["Undoing", "amber"],
  undone: ["Undone", "gray"],
};
const BUSY = new Set(["queued", "running", "undoing"]);
const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");

export function ImportsSettings({ sb, ws }: Pick<ViewProps, "sb" | "ws">) {
  const list = useLoad(
    async () =>
      must(
        await sb.from("imports").select("id, file_name, kind, status, counts, progress, rows_done, errors_path, error, undo_until, created_at").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(200),
      ) as Imp[],
    ws.id,
  );
  const [error, setError] = useState("");
  const busy = list.data?.some((i) => BUSY.has(i.status)) ?? false;
  const reload = list.reload;

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [busy, reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const download = (i: Imp) =>
    run(async () => {
      const { data, error: e } = await sb.storage.from("imports").createSignedUrl(i.errors_path!, 120, { download: `${(i.file_name || "import").replace(/\.[^.]+$/, "")}-errors.csv` });
      if (e) throw e;
      window.location.href = data.signedUrl;
    });

  const undo = (i: Imp) =>
    run(async () => {
      if (!(await askConfirm(`Undo ${i.file_name || "this import"}?`, { ok: "Undo import", danger: true }))) return;
      must(await sb.rpc("import_undo", { p_import: i.id }));
    });

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote message={error} />
      <Panel>
        <CardHead label="Imports" count={list.data?.length} />
        {!list.data ? (
          <Loading />
        ) : !list.data.length ? (
          <p className="px-4 py-3 text-[13px] text-faint">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>State</Th>
                  <Th className="text-right">Rows</Th>
                  <Th className="text-right">Created</Th>
                  <Th className="text-right">Updated</Th>
                  <Th className="text-right">Unsubscribed</Th>
                  <Th className="text-right">Skipped</Th>
                  <Th>When</Th>
                  <Th className="text-right">{""}</Th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((i) => {
                  const c = i.counts ?? {};
                  const sk = (c.skipped ?? {}) as Record<string, number>;
                  const skipped = Object.values(sk).reduce((a, b) => a + (Number(b) || 0), 0);
                  const [label, tone] = STATUS[i.status] ?? [i.status, "gray" as Tone];
                  const total = i.progress?.rows;
                  const canUndo = i.status === "done" && i.undo_until && new Date(i.undo_until) > new Date();
                  return (
                    <tr key={i.id} className="border-t border-line">
                      <Td className="max-w-[260px] truncate font-medium">{i.file_name || "Pasted rows"}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <Badge tone={tone}>{label}</Badge>
                          {i.status === "running" && i.rows_done ? (
                            <span className="font-mono text-[11px] text-faint">
                              {n(i.rows_done)}
                              {total ? ` / ${n(total)}` : ""}
                            </span>
                          ) : null}
                          {i.status === "failed" && i.error ? <span className="max-w-[220px] truncate text-[12px] text-red-600">{i.error}</span> : null}
                        </span>
                      </Td>
                      <Td className="text-right font-mono">{n(c.rows)}</Td>
                      <Td className="text-right font-mono">{n(c.created)}</Td>
                      <Td className="text-right font-mono">{n(c.changed)}</Td>
                      <Td className="text-right font-mono">{n(c.suppressed)}</Td>
                      <Td className="text-right font-mono">{c.skipped ? n(skipped) : "—"}</Td>
                      <Td className="whitespace-nowrap text-faint">{timeAgo(i.created_at)}</Td>
                      <Td className="text-right">
                        <span className="flex justify-end gap-1">
                          {i.errors_path ? (
                            <Button variant="ghost" className="h-7 px-2.5" onClick={() => download(i)}>
                              <Download size={13} />
                              Errors
                            </Button>
                          ) : null}
                          {canUndo ? (
                            <Button variant="ghost" className="h-7 px-2.5" onClick={() => undo(i)}>
                              Undo
                            </Button>
                          ) : null}
                        </span>
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
