"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "../../Icons";
import { Badge, Button, duration, Empty, ErrorNote, errorText, hostOf, Loading, must, Page, Panel, postJson, StatusTag, Tabs, Th, timeAgo, type RunStatus, type StepStatus, type ViewProps, type Verdict, VerdictTag } from "../ui";

type RunRow = {
  id: string;
  test_id: string | null;
  test_name: string;
  test_version: number;
  environment_id: string | null;
  environment_name: string;
  base_url: string;
  trigger: string;
  status: RunStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  video_path: string | null;
  trace_paths: string[];
  console_path: string | null;
  network_path: string | null;
  project_id: string;
  attempts: number;
  live_path: string | null;
  ai_calls: number;
  lock_saved: boolean;
  verdict: Verdict | null;
  verdict_reason: string | null;
};
type StepRow = { id: string; position: number; kind: string; label: string; status: StepStatus; retried: boolean; started_ms: number | null; duration_ms: number | null; error: string | null; screenshot_path: string | null; written: boolean; healed: boolean; code: string | null };
type ConsoleLine = { ms: number; type: string; text: string };
type NetworkLine = { ms: number; method: string; url: string; status: number | null; type: string; durationMs: number | null; failure?: string };
type Email = { id: string; to_address: string; from_address: string | null; subject: string | null; text_body: string | null; received_at: string };

/** The part of a run's inbox addresses that's unique to the run: <inbox>-<name>-<this>@... */
const runCode = (runId: string) => runId.replace(/-/g, "").slice(0, 6);

const LIVE = new Set<RunStatus>(["queued", "running"]);
const RUN_COLUMNS = "id, test_id, test_name, test_version, environment_id, environment_name, base_url, trigger, status, error, created_at, started_at, finished_at, duration_ms, video_path, trace_paths, console_path, network_path, project_id, attempts, live_path, ai_calls, lock_saved, verdict, verdict_reason";

/** Load again every few seconds while `live` is true. */
function usePoll(live: boolean, ms: number, tick: () => void) {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => latest.current(), ms);
    return () => clearInterval(t);
  }, [live, ms]);
}

function RunList({ sb, project, navigate }: ViewProps) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    if (!project) return;
    sb.from("runs")
      .select(RUN_COLUMNS)
      .eq("project_id", project.id)
      .order("created_at", { ascending: false })
      .limit(200)
      .then((res) => (res.error ? setError(res.error.message) : setRows(res.data as RunRow[])));
  };
  useEffect(load, [sb, project]);
  usePoll(!!rows?.some((r) => LIVE.has(r.status)), 3000, load);

  if (!project)
    return (
      <Page icon={<Play size={14} />} title="Runs">
        <Empty icon={<Play size={16} />} title="Add a project first." />
      </Page>
    );
  return (
    <Page icon={<Play size={14} />} title="Runs" count={rows?.length} flush={!!rows?.length}>
      {error ? (
        <div className="p-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {!rows ? (
        <Loading />
      ) : !rows.length ? (
        <Empty icon={<Play size={16} />} title="Every run will show up here, with its video." />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Test</Th>
              <Th className="w-44">Status</Th>
              <Th className="hidden w-32 md:table-cell">Environment</Th>
              <Th className="hidden w-24 sm:table-cell">Length</Th>
              <Th className="w-28">Started</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => navigate("runs", r.id)} className="cursor-pointer hover:bg-hover">
                <td className="h-12 border-b border-line px-4 text-[13.5px]">
                  <a
                    href={`/runs/${r.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate("runs", r.id);
                    }}
                    className="font-medium text-ink"
                  >
                    {r.test_name}
                  </a>
                  <span className="ml-2 font-mono text-[11px] text-faint">v{r.test_version}</span>
                </td>
                <td className="border-b border-line px-4">
                  <span className="flex gap-1.5">
                    <StatusTag status={r.status} />
                    <VerdictTag verdict={r.verdict} />
                  </span>
                </td>
                <td className="hidden border-b border-line px-4 text-[12.5px] text-muted md:table-cell">{r.environment_name}</td>
                <td className="hidden border-b border-line px-4 font-mono text-[12px] text-muted sm:table-cell">{duration(r.duration_ms)}</td>
                <td className="border-b border-line px-4 text-[12px] text-muted">{timeAgo(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

function RunDetail({ sb, session, id, navigate }: ViewProps) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[] | null>(null);
  const [tab, setTab] = useState<"screenshots" | "console" | "network" | "emails" | "trace">("screenshots");
  const [network, setNetwork] = useState<NetworkLine[] | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [again, setAgain] = useState(false);
  const [lastFrame, setLastFrame] = useState("");
  const video = useRef<HTMLVideoElement>(null);

  const load = () => {
    Promise.all([sb.from("runs").select(RUN_COLUMNS).eq("id", id).maybeSingle(), sb.from("run_steps").select("id, position, kind, label, status, retried, started_ms, duration_ms, error, screenshot_path, written, healed, code").eq("run_id", id).order("position")]).then(([r, s]) => {
      if (r.error || s.error) return setError((r.error ?? s.error)!.message);
      if (!r.data) return setError("This run was deleted or isn't in this workspace.");
      setRun(r.data as RunRow);
      setSteps(s.data as StepRow[]);
    });
  };
  useEffect(load, [sb, id]);
  usePoll(!!run && LIVE.has(run.status), 1500, load);

  // Files are private: get short-lived links for the ones this run has.
  const paths = useMemo(() => (run ? [run.video_path, run.console_path, run.network_path, run.live_path, ...run.trace_paths, ...steps.map((s) => s.screenshot_path)].filter((p): p is string => !!p) : []), [run, steps]);
  const missing = paths.filter((p) => !urls[p]).join("|");
  useEffect(() => {
    if (!missing) return;
    sb.storage
      .from("runs")
      .createSignedUrls(missing.split("|"), 3600)
      .then(({ data }) => {
        const next: Record<string, string> = {};
        for (const d of data ?? []) if (d.path && d.signedUrl) next[d.path] = d.signedUrl;
        setUrls((u) => ({ ...u, ...next }));
      });
  }, [sb, missing]);

  const consoleUrl = run?.console_path ? urls[run.console_path] : undefined;
  useEffect(() => {
    if (!consoleUrl) return;
    fetch(consoleUrl)
      .then((r) => r.json())
      .then((lines: ConsoleLine[]) => setConsoleLines(lines))
      .catch(() => setConsoleLines([]));
  }, [consoleUrl]);

  const networkUrl = run?.network_path ? urls[run.network_path] : undefined;
  useEffect(() => {
    if (!networkUrl) return;
    fetch(networkUrl)
      .then((r) => r.json())
      .then((lines: NetworkLine[]) => setNetwork(lines))
      .catch(() => setNetwork([]));
  }, [networkUrl]);

  // Mail that reached this run's test inboxes.
  const projectId = run?.project_id;
  const emailTick = run && LIVE.has(run.status) ? steps.filter((s) => s.status !== "pending").length : -1;
  useEffect(() => {
    if (!projectId) return;
    sb.from("inbox_messages")
      .select("id, to_address, from_address, subject, text_body, received_at")
      .eq("project_id", projectId)
      .like("to_address", `%-${runCode(id)}@%`)
      .order("received_at")
      .then(({ data }) => setEmails((data ?? []) as Email[]));
  }, [sb, id, projectId, emailTick]);

  const runAgain = async () => {
    if (!run?.test_id) return;
    setAgain(true);
    try {
      const res = await postJson<{ id: string }>(session, "/api/runs", { testId: run.test_id, environmentId: run.environment_id ?? undefined });
      navigate("runs", res.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAgain(false);
    }
  };

  const seek = (ms: number | null) => {
    if (ms == null || !video.current) return;
    video.current.currentTime = ms / 1000;
    void video.current.play().catch(() => undefined);
  };

  const back = { label: "Runs", onClick: () => navigate("runs") };
  if (!run)
    return error ? (
      <Page icon={<Play size={14} />} title="Run" back={back}>
        <ErrorNote message={error} />
      </Page>
    ) : (
      <Loading />
    );

  const done = steps.filter((s) => s.status === "passed" || s.status === "failed").length;
  const live = LIVE.has(run.status);
  const videoUrl = run.video_path ? urls[run.video_path] : undefined;
  // While the run goes, show the newest live frame, and keep the last one on screen until the next is signed.
  const liveUrl = live && run.live_path ? urls[run.live_path] : undefined;

  return (
    <Page
      icon={<Play size={14} />}
      title={run.test_name}
      back={back}
      actions={
        <>
          <StatusTag status={run.status} />
          {steps.some((s) => s.healed) && !live ? (
            <Button variant="ghost" onClick={() => navigate("approvals")}>
              Review fix
            </Button>
          ) : null}
          {run.test_id ? (
            <>
              <Button variant="ghost" onClick={() => navigate("tests", run.test_id!)}>
                Open test
              </Button>
              <Button onClick={runAgain} disabled={again || live}>
                <Play size={13} />
                {again ? "Starting…" : "Run again"}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        {/* Progress strip */}
        <Panel frame className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-[13px]">
          <span className="font-medium">
            {run.status === "queued" ? "Waiting for a runner" : run.status === "running" ? `Running step ${Math.min(done + 1, steps.length)} of ${steps.length}` : run.status === "passed" ? "All steps passed" : run.status === "failed" ? "A step failed" : run.status === "error" ? "The run couldn't finish" : "Canceled"}
          </span>
          <span className="h-1 min-w-24 flex-1 overflow-hidden rounded-full bg-hover">
            <span className={`block h-full ${run.status === "failed" ? "bg-danger" : run.status === "error" ? "bg-amber-500" : run.status === "passed" ? "bg-success" : "bg-brand"}`} style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
          </span>
          <span className="font-mono text-[12px] text-muted">
            {done}/{steps.length}
          </span>
          <span className="text-[12px] text-muted">
            {run.environment_name} · {hostOf(run.base_url)} · v{run.test_version} · {duration(run.duration_ms)} · {timeAgo(run.created_at)}
            {run.attempts > 1 ? ` · runner try ${run.attempts}` : ""}
            {run.ai_calls ? ` · ${run.ai_calls} AI ${run.ai_calls === 1 ? "call" : "calls"}` : ""}
            {run.lock_saved ? " · code saved to test" : ""}
          </span>
        </Panel>
        {run.verdict ? (
          <Panel className="flex items-start gap-3 px-4 py-3">
            <VerdictTag verdict={run.verdict} />
            <span className="text-[13px] leading-relaxed text-body">{run.verdict_reason}</span>
          </Panel>
        ) : null}
        {run.error ? <ErrorNote message={run.error} /> : null}
        {error ? <ErrorNote message={error} /> : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          {/* Steps */}
          <Panel className="self-start">
            <ol>
              {steps.map((s) => (
                <li key={s.id} className="border-b border-line last:border-b-0">
                  <button type="button" onClick={() => seek(s.started_ms)} disabled={s.started_ms == null || !videoUrl} className={`flex w-full items-center gap-3 px-4 py-3 text-left ${s.started_ms != null && videoUrl ? "hover:bg-hover" : "cursor-default"} ${s.status === "failed" ? "bg-danger-soft/40" : ""}`}>
                    <span className="w-5 shrink-0 font-mono text-[11px] text-faint">{s.position}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.label || "(empty step)"}</span>
                    {s.written ? <Badge tone="violet">{s.status === "running" ? "Writing" : "Written"}</Badge> : null}
                    {s.healed ? <Badge tone="violet">Healed</Badge> : null}
                    {s.retried ? <Badge tone="amber">Retried</Badge> : null}
                    <StatusTag status={s.status} />
                    <span className="hidden w-12 shrink-0 text-right font-mono text-[11px] text-faint sm:inline">{s.duration_ms != null ? duration(s.duration_ms) : ""}</span>
                  </button>
                  {s.code ? <pre className="overflow-x-auto border-t border-line px-4 py-2 pl-12 font-mono text-[11.5px] leading-relaxed text-muted">{s.code}</pre> : null}
                  {s.error ? <p className="border-t border-line px-4 py-2 pl-12 font-mono text-[11.5px] leading-relaxed break-words text-danger">{s.error}</p> : null}
                </li>
              ))}
            </ol>
          </Panel>

          {/* Video */}
          <div className="flex flex-col gap-3">
            <div className="frame overflow-hidden border border-line bg-ink">
              {videoUrl ? (
                <video ref={video} src={videoUrl} controls playsInline className="block aspect-video w-full bg-ink" />
              ) : live && (liveUrl || lastFrame) ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={liveUrl || lastFrame} alt="The page right now" onLoad={(e) => setLastFrame(e.currentTarget.src)} className="block aspect-video w-full bg-ink object-contain" />
                  <span className="absolute top-3 left-3">
                    <Badge tone="red">Live</Badge>
                  </span>
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center px-6 text-center text-[13px] text-white/60">{run.status === "queued" ? "Waiting for a runner" : live ? "Starting the browser" : "No video for this run."}</div>
              )}
            </div>
          </div>
        </div>

        {/* Files */}
        <Panel>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "screenshots", label: "Screenshots", count: steps.filter((s) => s.screenshot_path).length },
              { value: "console", label: "Console", count: consoleLines?.length },
              { value: "network", label: "Network", count: network?.length },
              { value: "emails", label: "Emails", count: emails.length || undefined },
              { value: "trace", label: "Trace" },
            ]}
          />
          <div className="p-4">
            {tab === "screenshots" ? (
              steps.some((s) => s.screenshot_path) ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {steps
                    .filter((s) => s.screenshot_path)
                    .map((s) => (
                      <a key={s.id} href={urls[s.screenshot_path!]} target="_blank" rel="noopener noreferrer" className="block border border-line hover:border-line-strong">
                        {urls[s.screenshot_path!] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={urls[s.screenshot_path!]} alt={`After step ${s.position}`} className="block aspect-video w-full object-cover" />
                        ) : (
                          <span className="block aspect-video w-full animate-pulse bg-hover" />
                        )}
                        <span className="flex items-center gap-2 border-t border-line px-3 py-2 text-[12px]">
                          <span className="font-mono text-faint">{s.position}</span>
                          <span className="truncate">{s.label}</span>
                        </span>
                      </a>
                    ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">{live ? "Screenshots show up after each step." : "No screenshots."}</p>
              )
            ) : null}
            {tab === "console" ? (
              consoleLines === null ? (
                <p className="text-[13px] text-muted">{live ? "The console shows up when the run ends." : "No console output."}</p>
              ) : consoleLines.length ? (
                <ul className="divide-y divide-line border border-line font-mono text-[12px]">
                  {consoleLines.map((l, i) => (
                    <li key={i} className="flex gap-3 px-3 py-1.5">
                      <span className="w-14 shrink-0 text-right text-faint">{duration(l.ms)}</span>
                      <span className={`w-16 shrink-0 ${l.type === "error" || l.type === "pageerror" ? "text-danger" : l.type === "warning" ? "text-warning" : "text-muted"}`}>{l.type}</span>
                      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-ink">{l.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">The page printed nothing to its console.</p>
              )
            ) : null}
            {tab === "network" ? (
              network === null ? (
                <p className="text-[13px] text-muted">{live ? "The network log shows up when the run ends." : "No network log for this run."}</p>
              ) : network.length ? (
                <div className="overflow-x-auto border border-line">
                  <table className="w-full border-collapse font-mono text-[12px]">
                    <tbody>
                      {network.map((n, i) => (
                        <tr key={i} className="border-b border-line last:border-b-0">
                          <td className="w-14 px-3 py-1.5 text-right text-faint">{duration(n.ms)}</td>
                          <td className="w-14 px-2 py-1.5 text-muted">{n.method}</td>
                          <td className={`w-12 px-2 py-1.5 ${n.status === null || n.status >= 400 ? "text-danger" : "text-muted"}`}>{n.status ?? "failed"}</td>
                          <td className="hidden w-20 px-2 py-1.5 text-faint sm:table-cell">{n.type}</td>
                          <td className="max-w-0 px-2 py-1.5 text-ink">
                            <span className="block truncate" title={n.failure ? `${n.url} · ${n.failure}` : n.url}>
                              {n.url}
                            </span>
                          </td>
                          <td className="hidden w-16 px-3 py-1.5 text-right text-faint sm:table-cell">{n.durationMs != null ? duration(n.durationMs) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[13px] text-muted">The page made no requests.</p>
              )
            ) : null}
            {tab === "emails" ? (
              emails.length ? (
                <ul className="divide-y divide-line border border-line">
                  {emails.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => setOpenEmail(openEmail === m.id ? null : m.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover">
                        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-faint">{timeAgo(m.received_at)}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.subject || "(no subject)"}</span>
                        <span className="hidden min-w-0 truncate font-mono text-[11.5px] text-muted sm:block">{m.to_address}</span>
                      </button>
                      {openEmail === m.id ? <pre className="border-t border-line px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-body">{m.text_body || "(no text)"}</pre> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No email reached this run&apos;s inboxes.</p>
              )
            ) : null}
            {tab === "trace" ? (
              run.trace_paths.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  {run.trace_paths.map((p) =>
                    urls[p] ? (
                      <span key={p} className="flex gap-2">
                        <a href={`https://trace.playwright.dev/?trace=${encodeURIComponent(urls[p]!)}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-md bg-ink px-3.5 text-[13px] font-medium text-white hover:bg-[#2b2b29]">
                          Open in Trace Viewer
                        </a>
                        <a href={urls[p]} className="inline-flex h-8 items-center rounded-md border border-line px-3.5 text-[13px] font-medium hover:border-line-strong">
                          Download trace
                        </a>
                      </span>
                    ) : null,
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-muted">{live ? "The trace shows up when the run ends." : "No trace for this run."}</p>
              )
            ) : null}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

export function RunsView(props: ViewProps) {
  if (props.id) return <RunDetail key={props.id} {...props} />;
  return <RunList {...props} />;
}

/** Each test's latest run status, for the tests list. */
export async function latestRuns(sb: ViewProps["sb"], projectId: string) {
  const rows = must(await sb.from("runs").select("test_id, status, created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(500)) as { test_id: string | null; status: RunStatus; created_at: string }[];
  const out = new Map<string, { status: RunStatus; created_at: string }>();
  for (const r of rows) if (r.test_id && !out.has(r.test_id)) out.set(r.test_id, r);
  return out;
}
