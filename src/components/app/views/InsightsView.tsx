"use client";

import { useState } from "react";
import { FINISHED, statsByTest, type InsightRow as Row } from "@/lib/insights";
import { BarChart } from "../../Icons";
import { Badge, Empty, ErrorNote, Loading, must, Page, Panel, Segmented, StatusTag, Td, Th, timeAgo, useLoad, type Verdict, type ViewProps } from "../ui";

type Range = "7" | "30";

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

/** One number with its label. The label carries the meaning, never the color. */
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Panel className="flex flex-col gap-1 px-4 py-3">
      <span className="label-mono">{label}</span>
      <span className="text-[28px] leading-tight font-medium tracking-[-0.02em] text-ink">{value}</span>
      {sub ? <span className="text-[12px] text-muted">{sub}</span> : null}
    </Panel>
  );
}

/** How the project's tests are doing: pass rate, what failures were, flaky tests, AI use. */
export function InsightsView({ sb, project, navigate }: ViewProps) {
  const [range, setRange] = useState<Range>("30");
  const runs = useLoad(async () => {
    if (!project) return [] as Row[];
    const since = new Date(Date.now() - Number(range) * 86_400_000).toISOString();
    return must(
      await sb.from("runs").select("test_id, test_name, status, verdict, retry_of, ai_calls, duration_ms, created_at").eq("project_id", project.id).gte("created_at", since).order("created_at", { ascending: false }).limit(5000),
    ) as Row[];
  }, `${project?.id ?? "none"}:${range}`);

  const rows = runs.data ?? [];
  const finished = rows.filter((r) => FINISHED.has(r.status));
  const passed = finished.filter((r) => r.status === "passed").length;
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const savedByRetry = rows.filter((r) => r.retry_of && r.status === "passed").length;
  const minutes = rows.reduce((m, r) => m + (r.duration_ms ?? 0), 0) / 60000;
  const ai = rows.reduce((n, r) => n + (r.ai_calls ?? 0), 0);
  const tests = statsByTest(rows);

  return (
    <Page icon={<BarChart size={14} />} title="Insights" actions={<Segmented<Range> value={range} label="Range" onChange={setRange} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />}>
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <ErrorNote message={runs.error} />
        {!runs.data ? (
          <Loading />
        ) : !rows.length ? (
          <Empty icon={<BarChart size={16} />} title="No runs in this time." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Pass rate" value={pct(passed, finished.length)} sub={`${passed} of ${finished.length} finished runs`} />
              <Tile label="Runs" value={rows.length.toLocaleString("en-US")} sub={`${minutes.toFixed(1)} cloud minutes`} />
              <Tile label="Saved by re-run" value={String(savedByRetry)} sub="Flaky failures that passed again" />
              <Tile label="AI calls" value={ai.toLocaleString("en-US")} sub="Writing, healing and judging" />
            </div>

            <Panel>
              <div className="flex h-10 items-center border-b border-line bg-canvas px-4">
                <span className="label-mono">Failures by kind</span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-line">
                {(
                  [
                    ["app_bug", "App bug", "red"],
                    ["flaky", "Flaky", "amber"],
                    ["setup", "Setup", "gray"],
                  ] as const
                ).map(([v, label, tone]) => (
                  <div key={v} className="flex flex-col items-start gap-1.5 px-4 py-3">
                    <Badge tone={tone}>{label}</Badge>
                    <span className="text-[24px] leading-tight font-medium text-ink">{count(v)}</span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Test</Th>
                    <Th className="w-20">Runs</Th>
                    <Th className="w-24">Pass rate</Th>
                    <Th className="hidden w-20 sm:table-cell">Flaky</Th>
                    <Th className="hidden w-24 sm:table-cell">App bugs</Th>
                    <Th className="w-36">Last run</Th>
                  </tr>
                </thead>
                <tbody>
                  {tests.map((t) => (
                    <tr key={t.id} onClick={() => navigate("tests", t.id)} className="cursor-pointer hover:bg-hover">
                      <Td className="max-w-0 truncate font-medium">{t.name}</Td>
                      <Td className="font-mono text-[12px] text-muted">{t.runs}</Td>
                      <Td className="font-mono text-[12px]">{pct(t.passed, t.finished)}</Td>
                      <Td className="hidden font-mono text-[12px] sm:table-cell">{t.flaky || "—"}</Td>
                      <Td className="hidden font-mono text-[12px] sm:table-cell">{t.appBugs || "—"}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <StatusTag status={t.last.status} />
                          <span className="text-[12px] text-muted">{timeAgo(t.last.created_at)}</span>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </div>
    </Page>
  );
}
