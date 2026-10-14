"use client";

import { useEffect, useState } from "react";
import { Check, X } from "../../Icons";
import { Badge, Button, CardHead, ErrorNote, errorText, must, Panel, PriorityBars, useLoad, type ViewProps } from "../ui";

type Plan = { id: string; status: "queued" | "running" | "done" | "error"; proposals: number; error: string | null; created_at: string };
type Step = { kind: "do" | "check"; text: string } | { kind: "use"; block: string };
type Proposal = { id: string; name: string; use_case: string; priority: "low" | "medium" | "high"; reason: string | null; steps: Step[]; pages: string[] };

const ACTIVE = new Set(["queued", "running"]);

/** The Planner on the Tests page: ask for a plan, then accept or dismiss what it proposes. */
export function Proposals({ sb, project, navigate, asking, onAsked, onAccepted }: Pick<ViewProps, "sb" | "navigate"> & { project: NonNullable<ViewProps["project"]>; asking: boolean; onAsked: () => void; onAccepted: () => void }) {
  const [error, setError] = useState("");
  const data = useLoad(async () => {
    const [plan, list, blocks] = await Promise.all([
      sb.from("plans").select("id, status, proposals, error, created_at").eq("project_id", project.id).order("created_at", { ascending: false }).limit(1),
      sb.from("test_proposals").select("id, name, use_case, priority, reason, steps, pages").eq("project_id", project.id).eq("status", "pending").order("priority").order("created_at"),
      sb.from("blocks").select("id, name").eq("project_id", project.id),
    ]);
    const rank = { high: 0, medium: 1, low: 2 };
    return {
      plan: ((must(plan) as Plan[])[0] ?? null) as Plan | null,
      proposals: (must(list) as Proposal[]).sort((a, b) => rank[a.priority] - rank[b.priority]),
      blocks: new Map((must(blocks) as { id: string; name: string }[]).map((b) => [b.id, b.name])),
    };
  }, project.id);

  const planning = !!data.data?.plan && ACTIVE.has(data.data.plan.status);
  useEffect(() => {
    if (!planning) return;
    const t = setInterval(data.reload, 3000);
    return () => clearInterval(t);
  }, [planning, data.reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const d = data.data;
  if (!d) return null;
  const failed = d.plan?.status === "error" ? d.plan.error : null;
  if (!asking && !planning && !failed && !d.proposals.length && !error && !data.error) return null;

  return (
    <div className="flex flex-col gap-3 border-b border-line bg-canvas p-4">
      {asking ? (
        <AskForm
          onCancel={onAsked}
          onStart={async (notes) => {
            must(await sb.rpc("start_plan", { p_project: project.id, p_notes: notes }));
            onAsked();
            data.reload();
          }}
        />
      ) : null}
      {planning ? (
        <Panel className="flex items-center gap-3 px-4 py-3">
          <Badge tone="brand">Planning</Badge>
          <span className="text-[13px] text-muted">Reading the map and your tests.</span>
        </Panel>
      ) : null}
      <ErrorNote message={data.error || error || (failed ? `The last plan didn't finish: ${failed}` : "")} />
      {d.proposals.length ? (
        <div className="flex flex-col gap-2">
          <span className="label-mono">Proposed · {d.proposals.length}</span>
          <div className="grid gap-3 md:grid-cols-2">
            {d.proposals.map((p) => (
              <Panel key={p.id} className="flex flex-col">
                <div className="flex items-start gap-2 px-4 pt-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-[14px] font-medium">{p.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge>{p.use_case}</Badge>
                      <PriorityBars value={p.priority} />
                    </span>
                  </div>
                </div>
                {p.reason ? <p className="px-4 pt-2 text-[12.5px] leading-5 text-muted">{p.reason}</p> : null}
                <ol className="flex-1 space-y-1 px-4 py-3 text-[12.5px]">
                  {p.steps.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-4 shrink-0 font-mono text-faint">{i + 1}</span>
                      <span>{s.kind === "use" ? `Use ${d.blocks.get(s.block) ?? "block"}` : s.kind === "check" ? `Check: ${s.text}` : s.text}</span>
                    </li>
                  ))}
                </ol>
                <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
                  {p.pages.length ? <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{p.pages.join("  ")}</span> : <span className="flex-1" />}
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    onClick={() =>
                      act(async () => {
                        must(await sb.rpc("dismiss_proposal", { p_proposal: p.id }));
                        data.reload();
                      })
                    }
                  >
                    <X size={12} />
                    Dismiss
                  </Button>
                  <Button
                    className="h-7 px-2.5"
                    onClick={() =>
                      act(async () => {
                        const id = must(await sb.rpc("accept_proposal", { p_proposal: p.id })) as string;
                        data.reload();
                        onAccepted();
                        if (d.proposals.length === 1) navigate("tests", id);
                      })
                    }
                  >
                    <Check size={12} />
                    Accept
                  </Button>
                </div>
              </Panel>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AskForm({ onStart, onCancel }: { onStart: (notes: string) => Promise<void>; onCancel: () => void }) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Panel>
      <CardHead label="Plan tests" />
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onStart(notes);
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="label-mono">Notes or PRD</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={30000}
            rows={5}
            placeholder="Optional. What the app does, what matters most, what's new."
            className="w-full resize-y rounded-md border border-line bg-panel px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:border-ink"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Starting…" : "Plan"}
          </Button>
          <Button type="button" variant="plain" onClick={onCancel}>
            Cancel
          </Button>
          <ErrorNote message={error} />
        </div>
      </form>
    </Panel>
  );
}
