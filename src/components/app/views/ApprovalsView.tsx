"use client";

import { useEffect, useState } from "react";
import { lineDiff } from "@/lib/diff";
import { Check, X } from "../../Icons";
import { announceChange, Badge, Button, Empty, ErrorNote, errorText, Loading, must, Page, Panel, postJson, timeAgo, useLoad, type ViewProps } from "../ui";

type Heal = { id: string; test_id: string; run_id: string | null; position: number; step_label: string; old_code: string; new_code: string; error: string; created_at: string; tests: { name: string } | null };

function HealCard({ heal, session, navigate, onDone }: { heal: Heal; onDone: () => void } & Pick<ViewProps, "session" | "navigate">) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setError("");
    try {
      await postJson(session, "/api/heals/decide", { healId: heal.id, decision });
      announceChange();
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy("");
    }
  };
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <button type="button" onClick={() => navigate("tests", heal.test_id)} className="text-[14px] font-medium hover:underline">
          {heal.tests?.name ?? "Test"}
        </button>
        <span className="min-w-0 truncate text-[13px] text-muted">
          Step {heal.position} · {heal.step_label}
        </span>
        <Badge tone="violet">Healed</Badge>
        <span className="ml-auto text-[12px] text-faint">{timeAgo(heal.created_at)}</span>
      </div>
      <p className="border-b border-line px-4 py-2 font-mono text-[11.5px] leading-relaxed break-words text-danger">{heal.error}</p>
      <pre className="overflow-x-auto py-2 font-mono text-[12px] leading-6">
        {lineDiff(heal.old_code, heal.new_code).map((l, k) => (
          <div key={k} className={`px-4 ${l.kind === "del" ? "bg-danger-soft/50 text-danger" : l.kind === "add" ? "bg-success-soft/60 text-success" : "text-muted"}`}>
            {l.kind === "del" ? "- " : l.kind === "add" ? "+ " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        {heal.run_id ? (
          <Button variant="plain" onClick={() => navigate("runs", heal.run_id!)}>
            Open run
          </Button>
        ) : null}
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" disabled={!!busy} onClick={() => decide("rejected")}>
            <X size={13} />
            {busy === "rejected" ? "Rejecting…" : "Reject"}
          </Button>
          <Button disabled={!!busy} onClick={() => decide("approved")}>
            <Check size={13} />
            {busy === "approved" ? "Saving…" : "Approve"}
          </Button>
        </span>
      </div>
      {error ? (
        <div className="border-t border-line p-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}

/** Fixes from the Healer, waiting for a yes. Approving saves the new code to the test. */
export function ApprovalsView({ sb, session, project, navigate, projectsChanged, id }: ViewProps) {
  // A link to one fix (from a Slack or email alert) opens its project and puts it first.
  useEffect(() => {
    if (!id) return;
    void sb
      .from("heals")
      .select("project_id")
      .eq("id", id)
      .maybeSingle<{ project_id: string }>()
      .then(({ data }) => {
        if (data && data.project_id !== project?.id) projectsChanged(data.project_id);
      });
  }, [id, sb, project?.id, projectsChanged]);
  const list = useLoad(
    async () =>
      project
        ? (must(
            await sb
              .from("heals")
              .select("id, test_id, run_id, position, step_label, old_code, new_code, error, created_at, tests(name)")
              .eq("project_id", project.id)
              .eq("status", "pending")
              .order("created_at", { ascending: false }),
          ) as unknown as Heal[])
        : [],
    project?.id ?? "none",
  );
  return (
    <Page icon={<Check size={14} />} title="Approvals" count={list.data?.length}>
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {list.error ? <ErrorNote message={list.error} /> : null}
        {!list.data ? (
          <Loading />
        ) : !list.data.length ? (
          <Empty icon={<Check size={16} />} title="No fixes waiting.">
            When a step&apos;s code breaks because your app changed, Claritia tries a fix and puts it here for your yes.
          </Empty>
        ) : (
          [...list.data].sort((a, b) => Number(b.id === id) - Number(a.id === id)).map((h) => <HealCard key={h.id} heal={h} session={session} navigate={navigate} onDone={list.reload} />)
        )}
      </div>
    </Page>
  );
}
