"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "../../Icons";
import { Badge, Button, duration, Empty, ErrorNote, Loading, must, Panel, StatusTag, Td, Th, timeAgo, useLoad, type RunStatus, type StepStatus, type Verdict, type ViewProps, VerdictTag } from "../ui";

type RunRow = { id: string; status: RunStatus; environment_name: string; test_version: number; duration_ms: number | null; ai_calls: number; created_at: string; video_path: string | null; verdict: Verdict | null; verdict_reason: string | null };
type StepRow = { id: string; position: number; label: string; status: StepStatus; started_ms: number | null; written: boolean };

const COLUMNS = "id, status, environment_name, test_version, duration_ms, ai_calls, created_at, video_path, verdict, verdict_reason";

/** Preview: the latest run of this test, its video, and its steps that jump the video. */
export function TestPreview({ sb, testId, navigate }: Pick<ViewProps, "sb" | "navigate"> & { testId: string }) {
  const latest = useLoad(async () => {
    const runs = must(await sb.from("runs").select(COLUMNS).eq("test_id", testId).order("created_at", { ascending: false }).limit(1)) as RunRow[];
    const run = runs[0];
    if (!run) return { run: null };
    const steps = must(await sb.from("run_steps").select("id, position, label, status, started_ms, written").eq("run_id", run.id).order("position")) as StepRow[];
    let video: string | null = null;
    if (run.video_path) video = (await sb.storage.from("runs").createSignedUrl(run.video_path, 3600)).data?.signedUrl ?? null;
    return { run, steps, video };
  }, testId);
  const ref = useRef<HTMLVideoElement>(null);

  if (latest.error) return <ErrorNote message={latest.error} />;
  if (!latest.data) return <Loading />;
  if (!latest.data.run) return <Empty icon={<Play size={16} />} title="No runs yet." />;
  const { run, steps, video } = latest.data;
  const seek = (ms: number | null) => {
    if (ms == null || !ref.current) return;
    ref.current.currentTime = ms / 1000;
    void ref.current.play().catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <StatusTag status={run.status} />
        <VerdictTag verdict={run.verdict} />
        <span className="text-muted">
          {run.environment_name} · v{run.test_version} · {duration(run.duration_ms)} · {timeAgo(run.created_at)}
        </span>
        <Button variant="ghost" className="ml-auto" onClick={() => navigate("runs", run.id)}>
          Open run
        </Button>
      </div>
      <div className="frame overflow-hidden border border-line bg-ink">
        {video ? (
          <video ref={ref} src={video} controls playsInline className="block aspect-video w-full bg-ink" />
        ) : (
          <div className="flex aspect-video items-center justify-center text-[13px] text-white/60">{run.status === "queued" || run.status === "running" ? "Running" : "No video for this run."}</div>
        )}
      </div>
      <Panel>
        <ol>
          {steps.map((s) => (
            <li key={s.id} className="border-b border-line last:border-b-0">
              <button type="button" onClick={() => seek(s.started_ms)} disabled={s.started_ms == null || !video} className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${s.started_ms != null && video ? "hover:bg-hover" : "cursor-default"}`}>
                <span className="w-5 shrink-0 font-mono text-[11px] text-faint">{s.position}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{s.label}</span>
                {s.written ? <Badge tone="violet">Written</Badge> : null}
                <StatusTag status={s.status} />
              </button>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

/** Run log: every run of this test, newest first. */
export function TestRunLog({ sb, testId, navigate }: Pick<ViewProps, "sb" | "navigate"> & { testId: string }) {
  const runs = useLoad(async () => must(await sb.from("runs").select(COLUMNS).eq("test_id", testId).order("created_at", { ascending: false }).limit(100)) as RunRow[], testId);
  const [, tick] = useState(0);
  // Keep the times fresh while the tab is open.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (runs.error) return <ErrorNote message={runs.error} />;
  if (!runs.data) return <Loading />;
  if (!runs.data.length) return <Empty icon={<Play size={16} />} title="No runs yet." />;
  return (
    <Panel>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th className="w-44">Status</Th>
            <Th>Environment</Th>
            <Th className="hidden w-20 sm:table-cell">Version</Th>
            <Th className="hidden w-24 sm:table-cell">Length</Th>
            <Th className="hidden w-20 md:table-cell">AI calls</Th>
            <Th className="w-28">When</Th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((r) => (
            <tr key={r.id} onClick={() => navigate("runs", r.id)} className="cursor-pointer hover:bg-hover">
              <Td>
                <span className="flex gap-1.5">
                  <StatusTag status={r.status} />
                  <VerdictTag verdict={r.verdict} />
                </span>
              </Td>
              <Td className="text-muted">{r.environment_name}</Td>
              <Td className="hidden font-mono text-[12px] text-muted sm:table-cell">v{r.test_version}</Td>
              <Td className="hidden font-mono text-[12px] text-muted sm:table-cell">{duration(r.duration_ms)}</Td>
              <Td className="hidden font-mono text-[12px] text-muted md:table-cell">{r.ai_calls}</Td>
              <Td className="text-[12px] text-muted">{timeAgo(r.created_at)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
