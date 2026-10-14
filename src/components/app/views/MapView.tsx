"use client";

import { useEffect, useState } from "react";
import { MapIcon } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { Badge, Button, CardHead, Empty, ErrorNote, errorText, Field, Loading, must, Page, Panel, Segmented, timeAgo, useLoad, type ViewProps } from "../ui";

type Exploration = { id: string; status: "queued" | "running" | "done" | "error" | "canceled"; pages_found: number; max_pages: number; environment_name: string; base_url: string; error: string | null; created_at: string; finished_at: string | null };
type MapPage = { id: string; pattern: string; sample_url: string; title: string | null; name: string | null; purpose: string | null; status_code: number | null; screenshot_path: string | null; elements: { forms?: unknown[] }; last_seen: string };
type Size = "25" | "50" | "100" | "200";

const selectClass = "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const ACTIVE = new Set(["queued", "running"]);

/** The app map: every kind of page the Explorer found, with what people do there. */
export function MapView({ sb, project }: ViewProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const data = useLoad(async () => {
    if (!project) return null;
    const [x, pages, envs, tests] = await Promise.all([
      sb.from("explorations").select("id, status, pages_found, max_pages, environment_name, base_url, error, created_at, finished_at").eq("project_id", project.id).order("created_at", { ascending: false }).limit(1),
      sb.from("app_pages").select("id, pattern, sample_url, title, name, purpose, status_code, screenshot_path, elements, last_seen").eq("project_id", project.id).order("pattern"),
      sb.from("environments").select("id, name").eq("project_id", project.id).order("created_at"),
      sb.from("tests").select("id, name, lock").eq("project_id", project.id).order("name"),
    ]);
    const list = must(pages) as MapPage[];
    const paths = list.map((p) => p.screenshot_path).filter((x): x is string => !!x);
    const shots = new Map<string, string>();
    if (paths.length) {
      const { data: signed } = await sb.storage.from("runs").createSignedUrls(paths, 3600);
      for (const s of signed ?? []) if (s.path && s.signedUrl) shots.set(s.path, s.signedUrl);
    }
    return {
      last: ((must(x) as Exploration[])[0] ?? null) as Exploration | null,
      pages: list,
      shots,
      envs: must(envs) as { id: string; name: string }[],
      signInTests: (must(tests) as { id: string; name: string; lock: string | null }[]).filter((t) => t.lock),
    };
  }, project?.id ?? "none");

  // While an exploration runs, the map fills in live.
  const running = !!data.data?.last && ACTIVE.has(data.data.last.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(data.reload, 3000);
    return () => clearInterval(t);
  }, [running, data.reload]);

  const d = data.data;
  const last = d?.last;
  return (
    <Page
      icon={<MapIcon size={14} />}
      title="Map"
      count={d?.pages.length || undefined}
      actions={
        project && d && !running && !starting ? (
          <Button onClick={() => setStarting(true)} disabled={!d.envs.length}>
            Explore
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <ErrorNote message={data.error || error} />
        {!project ? null : !d ? (
          <Loading />
        ) : (
          <>
            {starting ? (
              <ExploreForm
                envs={d.envs}
                signInTests={d.signInTests}
                onCancel={() => setStarting(false)}
                onStart={async (f) => {
                  must(await sb.rpc("start_exploration", { p_project: project.id, p_env: f.env, p_max_pages: Number(f.size), p_sign_in_test: f.signIn || null }));
                  setStarting(false);
                  data.reload();
                }}
              />
            ) : null}
            {last ? (
              <Panel className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge tone={last.status === "done" ? "green" : last.status === "error" ? "red" : ACTIVE.has(last.status) ? "brand" : "gray"}>
                  {last.status === "queued" ? "Starting" : last.status === "running" ? "Exploring" : last.status === "done" ? "Explored" : last.status === "error" ? "Failed" : "Stopped"}
                </Badge>
                <span className="text-[13px]">
                  {last.pages_found} {last.pages_found === 1 ? "page" : "pages"} on {last.environment_name}
                </span>
                <span className="font-mono text-[12px] text-faint">{last.base_url.replace(/^https?:\/\//, "")}</span>
                <span className="ml-auto text-[12px] text-muted">{timeAgo(last.finished_at ?? last.created_at)}</span>
                {running ? (
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    onClick={async () => {
                      if (!(await askConfirm("Stop exploring?", { ok: "Stop" }))) return;
                      setError("");
                      try {
                        must(await sb.rpc("cancel_exploration", { p_exploration: last.id }));
                        data.reload();
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }}
                  >
                    Stop
                  </Button>
                ) : null}
                {last.status === "error" && last.error ? (
                  <div className="w-full">
                    <ErrorNote message={last.error} />
                  </div>
                ) : null}
              </Panel>
            ) : null}
            {!d.pages.length ? (
              running ? (
                <Loading />
              ) : (
                <Empty icon={<MapIcon size={16} />} title="No pages yet.">
                  Explore opens your site in a few browsers at once, follows every link and lists each kind of page with what people do there. It only follows links, and skips sign-out and delete links.
                </Empty>
              )
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {d.pages.map((p) => (
                  <Panel key={p.id} className="flex flex-col">
                    <a href={p.sample_url} target="_blank" rel="noreferrer" className="block aspect-[16/9] overflow-hidden border-b border-line bg-canvas">
                      {p.screenshot_path && d.shots.get(p.screenshot_path) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.shots.get(p.screenshot_path)} alt="" className="h-full w-full object-cover object-top" />
                      ) : null}
                    </a>
                    <div className="flex flex-1 flex-col gap-1 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.name || p.title || p.pattern}</span>
                        {p.status_code && p.status_code >= 400 ? <Badge tone="red">{p.status_code}</Badge> : null}
                        {p.elements.forms?.length ? <Badge>Form</Badge> : null}
                      </div>
                      <span className="truncate font-mono text-[11.5px] text-faint">{p.pattern}</span>
                      {p.purpose ? <span className="text-[12.5px] leading-5 text-muted">{p.purpose}</span> : null}
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

function ExploreForm({ envs, signInTests, onStart, onCancel }: { envs: { id: string; name: string }[]; signInTests: { id: string; name: string }[]; onStart: (f: { env: string; signIn: string; size: Size }) => Promise<void>; onCancel: () => void }) {
  const [env, setEnv] = useState(envs[0]?.id ?? "");
  const [signIn, setSignIn] = useState("");
  const [size, setSize] = useState<Size>("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Panel>
      <CardHead label="Explore" />
      <form
        className="grid gap-4 p-4 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onStart({ env, signIn, size });
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Environment">
          <Select value={env} options={envs.map((x) => ({ value: x.id, label: x.name }))} onChange={setEnv} ariaLabel="Environment" className={selectClass} />
        </Field>
        <Field label="Sign in first with">
          <Select value={signIn} options={[{ value: "", label: "No sign-in" }, ...signInTests.map((t) => ({ value: t.id, label: t.name }))]} onChange={setSignIn} ariaLabel="Sign-in test" className={selectClass} />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <span className="label-mono">Pages</span>
          <div className="self-start">
            <Segmented<Size>
              value={size}
              label="Pages"
              onChange={setSize}
              options={[
                { value: "25", label: "25" },
                { value: "50", label: "50" },
                { value: "100", label: "100" },
                { value: "200", label: "200" },
              ]}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy || !env}>
            {busy ? "Starting…" : "Start"}
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
