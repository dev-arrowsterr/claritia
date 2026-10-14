"use client";

import { useEffect, useState } from "react";
import { Branch, Plus } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Loading, must, Panel, postJson, Segmented, useLoad, type ViewProps } from "../ui";

type RunOn = "pull_request" | "preview";
type Scope = "all" | "use_case";
type Link = { id: string; repo_full_name: string; run_on: RunOn; scope: Scope; use_case: string | null; enabled: boolean; pick_tests: boolean; environment_id: string; environments: { name: string } | null };
type Repo = { id: number; full_name: string; installation_id: number };
type Draft = { repo: string; run_on: RunOn; environment_id: string; scope: Scope; use_case: string; pick_tests: boolean };

const selectClass = "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";

/** A project's GitHub links: which repository's pull requests (or preview deploys) run its tests. */
export function GitHubPanel({ sb, session, ws, project }: Pick<ViewProps, "sb" | "session" | "ws"> & { project: NonNullable<ViewProps["project"]> }) {
  // Coming back from GitHub with a problem: show it once.
  const [error, setError] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("github_error") ?? "")));
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("github_error")) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const data = useLoad(async () => {
    const [installs, links, envs, tests] = await Promise.all([
      sb.from("github_installations").select("id, account_login").eq("workspace_id", ws.id).order("created_at"),
      sb.from("github_links").select("id, repo_full_name, run_on, scope, use_case, enabled, pick_tests, environment_id, environments(name)").eq("project_id", project.id).order("created_at"),
      sb.from("environments").select("id, name").eq("project_id", project.id).order("created_at"),
      sb.from("tests").select("use_case").eq("project_id", project.id),
    ]);
    const accounts = must(installs) as { id: number; account_login: string }[];
    const repos = await postJson<{ configured: boolean; repos: Repo[] }>(session, "/api/github/repos", { workspaceId: ws.id });
    return {
      accounts,
      links: must(links) as unknown as Link[],
      envs: must(envs) as { id: string; name: string }[],
      useCases: [...new Set((must(tests) as { use_case: string }[]).map((t) => t.use_case))].sort(),
      configured: repos.configured,
      repos: repos.repos,
    };
  }, `${ws.id}:${project.id}`);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    act(async () => {
      const { url } = await postJson<{ url: string }>(session, "/api/github/connect", { workspaceId: ws.id });
      window.location.assign(url);
    });

  const d = data.data;
  return (
    <Panel>
      <CardHead label="GitHub" count={d?.links.length || undefined}>
        {d?.configured ? (
          <Button variant="plain" className="h-7 px-2" disabled={busy} onClick={connect}>
            {d.accounts.length ? "Add account" : "Connect GitHub"}
          </Button>
        ) : null}
        {d?.accounts.length && !adding ? (
          <Button variant="plain" className="h-7 px-2" onClick={() => setAdding(true)}>
            <Plus size={13} />
            Link repository
          </Button>
        ) : null}
      </CardHead>
      {data.error ? (
        <div className="p-4">
          <ErrorNote message={data.error} />
        </div>
      ) : !d ? (
        <Loading />
      ) : !d.configured ? (
        <div className="p-4">
          <ErrorNote message="GitHub isn't set up on the server." />
        </div>
      ) : (
        <>
          {d.accounts.length ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] text-muted">
              {d.accounts.map((a) => (
                <Badge key={a.id}>{a.account_login}</Badge>
              ))}
            </div>
          ) : null}
          {adding ? (
            <LinkForm
              repos={d.repos}
              envs={d.envs}
              useCases={d.useCases}
              onCancel={() => setAdding(false)}
              onSave={async (f) => {
                const repo = d.repos.find((r) => String(r.id) === f.repo);
                if (!repo) throw new Error("Pick a repository.");
                const { error: e } = await sb.from("github_links").insert({
                    project_id: project.id,
                    installation_id: repo.installation_id,
                    repo_id: repo.id,
                    repo_full_name: repo.full_name,
                    run_on: f.run_on,
                    environment_id: f.environment_id,
                    scope: f.scope,
                  use_case: f.scope === "use_case" ? f.use_case : null,
                  pick_tests: f.pick_tests,
                });
                if (e) throw new Error(/duplicate/i.test(e.message) ? `${repo.full_name} is already linked to this project that way.` : e.message);
                setAdding(false);
                data.reload();
              }}
            />
          ) : null}
          {d.links.length ? (
            <ul className="divide-y divide-line">
              {d.links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <Branch size={13} />
                  <span className="min-w-0 truncate font-mono text-[13px]">{l.repo_full_name}</span>
                  <Badge tone={l.run_on === "preview" ? "violet" : "brand"}>{l.run_on === "preview" ? "Preview deploys" : `PRs on ${l.environments?.name ?? "?"}`}</Badge>
                  <span className="text-[12px] text-muted">
                    {l.scope === "use_case" ? l.use_case : "Every test"}
                    {l.pick_tests ? " · affected only" : ""}
                  </span>
                  {l.enabled ? null : <Badge>Paused</Badge>}
                  <span className="ml-auto flex gap-1">
                    <Button
                      variant="plain"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          must(await sb.from("github_links").update({ enabled: !l.enabled }).eq("id", l.id));
                          data.reload();
                        })
                      }
                    >
                      {l.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="plain"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          must(await sb.from("github_links").update({ pick_tests: !l.pick_tests }).eq("id", l.id));
                          data.reload();
                        })
                      }
                    >
                      {l.pick_tests ? "Run all" : "Affected only"}
                    </Button>
                    <Button
                      variant="plain"
                      className="h-7 px-2"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          if (!(await askConfirm(`Unlink ${l.repo_full_name}?`, { ok: "Unlink", danger: true }))) return;
                          must(await sb.from("github_links").delete().eq("id", l.id));
                          data.reload();
                        })
                      }
                    >
                      Unlink
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {error ? (
        <div className="px-4 py-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}

function LinkForm({ repos, envs, useCases, onSave, onCancel }: { repos: Repo[]; envs: { id: string; name: string }[]; useCases: string[]; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState<Draft>({ repo: "", run_on: "pull_request", environment_id: envs[0]?.id ?? "", scope: "all", use_case: useCases[0] ?? "", pick_tests: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  return (
    <form
      className="grid gap-4 border-b border-line p-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onSave(d);
        } catch (err) {
          setError(errorText(err));
          setBusy(false);
        }
      }}
    >
      <Field label="Repository">
        <Select value={d.repo} options={repos.map((r) => ({ value: String(r.id), label: r.full_name }))} onChange={(v) => set("repo", v)} ariaLabel="Repository" placeholder="Pick a repository" className={selectClass} />
      </Field>
      <Field label={d.run_on === "preview" ? "Secrets from" : "Environment"}>
        <Select value={d.environment_id} options={envs.map((e) => ({ value: e.id, label: e.name }))} onChange={(v) => set("environment_id", v)} ariaLabel="Environment" className={selectClass} />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="label-mono">Runs on</span>
        <div className="self-start">
          <Segmented<RunOn>
            value={d.run_on}
            label="Runs on"
            onChange={(v) => set("run_on", v)}
            options={[
              { value: "pull_request", label: "Pull requests" },
              { value: "preview", label: "Preview deploys" },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="label-mono">Tests</span>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Scope>
            value={d.scope}
            label="Tests"
            onChange={(v) => set("scope", v)}
            options={[
              { value: "all", label: "Every test" },
              { value: "use_case", label: "A use case" },
            ]}
          />
          {d.scope === "use_case" ? (
            <div className="min-w-40">
              <Select value={d.use_case} options={useCases.map((u) => ({ value: u, label: u }))} onChange={(v) => set("use_case", v)} ariaLabel="Use case" placeholder="Pick a use case" className={selectClass} />
            </div>
          ) : null}
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
        <input type="checkbox" checked={d.pick_tests} onChange={(e) => set("pick_tests", e.target.checked)} className="size-3.5 accent-[var(--color-brand)]" />
        Only run the tests a change affects
      </label>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy || !d.repo || !d.environment_id}>
          {busy ? "Linking…" : "Link"}
        </Button>
        <Button type="button" variant="plain" onClick={onCancel}>
          Cancel
        </Button>
        <ErrorNote message={error} />
      </div>
    </form>
  );
}
