"use client";

import { useState } from "react";
import { Copy, Key, LogOut, Plus, Settings } from "../../Icons";
import { amount, planById, PLANS, type PlanId } from "@/lib/plans";
import { APP_URL, INBOX_DOMAIN } from "@/lib/site";
import { askConfirm, askText, tell } from "../Dialogs";
import { AlertsPanel } from "./AlertsPanel";
import { GitHubPanel } from "./GitHubPanel";
import {
  announceChange,
  Avatar,
  Badge,
  Button,
  CardHead,
  ErrorNote,
  errorText,
  Loading,
  must,
  Page,
  Panel,
  postJson,
  timeAgo,
  useLoad,
  type ViewProps,
} from "../ui";

type Usage = { plan: PlanId; period_start: string; period_end: string; minutes_used: number; minutes_limit: number | null; credits_used: number; credits_limit: number | null; projects_used: number; projects_limit: number | null };

/** A square bar of how much of a limit is used. */
function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number | null; unit?: string }) {
  const share = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-[12px] text-muted">
          {Math.round(used * 10) / 10 === Math.round(used) ? Math.round(used).toLocaleString("en-US") : used.toFixed(1)} / {amount(limit)}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <span className="block h-1.5 overflow-hidden bg-hover">
        <span className={`block h-full ${share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${limit ? Math.max(share * 100, used > 0 ? 1 : 0) : 0}%` }} />
      </span>
    </div>
  );
}

function PlanPanel({ sb, session, ws, role }: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const usage = useLoad(async () => {
    const { data, error } = await sb.rpc("workspace_usage", { p_workspace: ws.id });
    if (error) throw new Error(error.message);
    return (data as Usage[])[0]!;
  }, ws.id);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const go = async (path: string, body: Record<string, string>, which: string) => {
    setBusy(which);
    setError("");
    try {
      const { url } = await postJson<{ url: string }>(session, path, { workspaceId: ws.id, ...body });
      window.location.assign(url);
    } catch (e) {
      setError(errorText(e));
      setBusy("");
    }
  };

  const u = usage.data;
  const plan = planById(u?.plan);
  return (
    <Panel>
      <CardHead label="Plan" count={u ? `Resets ${new Date(u.period_end).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined} />
      {usage.error ? (
        <div className="p-4">
          <ErrorNote message={usage.error} />
        </div>
      ) : !u ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[15px] font-medium">{plan.name}</span>
            <Badge tone={plan.id === "free" ? "gray" : "brand"}>{plan.price === null ? "Custom" : `$${plan.price}/mo`}</Badge>
            {role === "owner" ? (
              <span className="ml-auto flex flex-wrap gap-2">
                {plan.id === "free" ? (
                  PLANS.filter((p) => p.id === "starter" || p.id === "team").map((p) => (
                    <Button key={p.id} variant={p.id === "team" ? "primary" : "ghost"} disabled={!!busy} onClick={() => go("/api/billing/checkout", { plan: p.id }, p.id)}>
                      {busy === p.id ? "Opening…" : `Upgrade to ${p.name} · $${p.price}/mo`}
                    </Button>
                  ))
                ) : plan.id !== "business" ? (
                  <Button variant="ghost" disabled={!!busy} onClick={() => go("/api/billing/portal", {}, "portal")}>
                    {busy === "portal" ? "Opening…" : "Manage billing"}
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Meter label="Cloud minutes" used={Number(u.minutes_used)} limit={u.minutes_limit} />
            <Meter label="AI credits" used={u.credits_used} limit={u.credits_limit} />
            <Meter label="Projects" used={u.projects_used} limit={u.projects_limit} />
          </div>
          <ErrorNote message={error} />
        </div>
      )}
    </Panel>
  );
}

/** A label, a line to copy, and a Copy button. */
function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="label-mono w-24 shrink-0">{label}</span>
      <code className="min-w-0 flex-1 truncate border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12.5px]">{text}</code>
      <Button
        variant="ghost"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Copy size={12} />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };

/** The workspace's API keys, for the REST API and the CLI. A new key shows once. */
function KeysPanel({ sb, session, ws }: Pick<ViewProps, "sb" | "session" | "ws">) {
  const keys = useLoad(async () => must(await sb.from("api_keys").select("id, name, prefix, created_at, last_used_at").eq("workspace_id", ws.id).is("revoked_at", null).order("created_at")) as ApiKey[], ws.id);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Panel>
      <CardHead label="API keys" count={keys.data?.length}>
        <Button
          variant="plain"
          className="h-7 px-2"
          onClick={() =>
            act(async () => {
              const name = await askText("Key name", { placeholder: "GitHub Actions", ok: "Create key" });
              if (!name) return;
              const { key } = await postJson<{ key: string }>(session, "/api/keys", { workspaceId: ws.id, name });
              setFresh({ name, key });
              keys.reload();
            })
          }
        >
          <Plus size={13} />
          New key
        </Button>
      </CardHead>
      {fresh ? (
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
          <span className="text-[13px] font-medium">Copy {fresh.name} now. It won&apos;t show again.</span>
          <CopyRow label="Key" text={fresh.key} />
          <CopyRow label="Claude Code" text={`claude mcp add --transport http claritia ${APP_URL}/api/mcp --header "Authorization: Bearer ${fresh.key}"`} />
          <div>
            <Button variant="plain" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
      {keys.error ? (
        <div className="p-4">
          <ErrorNote message={keys.error} />
        </div>
      ) : !keys.data ? (
        <Loading />
      ) : keys.data.length ? (
        <ul className="divide-y divide-line">
          {keys.data.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-4 py-3">
              <Key size={13} />
              <span className="min-w-0 truncate text-[13.5px] font-medium">{k.name}</span>
              <span className="font-mono text-[12px] text-faint">{k.prefix}…</span>
              <span className="ml-auto hidden text-[12px] text-muted sm:inline">{k.last_used_at ? `Used ${timeAgo(k.last_used_at)}` : "Never used"}</span>
              <Button
                variant="plain"
                className="h-7 px-2"
                onClick={() =>
                  act(async () => {
                    if (!(await askConfirm(`Revoke ${k.name}?`, { body: "Anything using this key stops working.", ok: "Revoke key", danger: true }))) return;
                    must(await sb.rpc("revoke_api_key", { p_key: k.id }));
                    keys.reload();
                  })
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <div className="px-4 pb-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </Panel>
  );
}

export function SettingsView({ sb, session, ws, role, project, projectsChanged, navigate }: ViewProps) {
  const [error, setError] = useState("");
  const inbox = useLoad(async () => (project ? ((must(await sb.from("projects").select("inbox_id").eq("id", project.id).single()) as { inbox_id: string }).inbox_id) : ""), project?.id ?? "none");
  const members = useLoad(async () => must(await sb.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", ws.id).order("created_at")) as { user_id: string; role: string }[], ws.id);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Page icon={<Settings size={14} />} title="Settings">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <ErrorNote message={error} />

        {project ? (
          <Panel>
            <CardHead label="Project">
              <Button
                variant="plain"
                className="h-7 px-2"
                onClick={() =>
                  act(async () => {
                    const name = await askText("Project name", { initial: project.name });
                    if (!name || name === project.name) return;
                    must(await sb.from("projects").update({ name }).eq("id", project.id));
                    projectsChanged(project.id);
                  })
                }
              >
                Rename
              </Button>
            </CardHead>
            <div className="flex flex-wrap items-center gap-2 px-4 py-4">
              <span className="mr-auto text-[15px] font-medium">{project.name}</span>
              <Button
                variant="ghost"
                onClick={() =>
                  act(async () => {
                    const res = await fetch(`/api/export?projectId=${project.id}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
                    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Export failed.");
                    const url = URL.createObjectURL(await res.blob());
                    const a = Object.assign(document.createElement("a"), { href: url, download: `${project.name.replace(/[^\w-]+/g, "-")}-claritia-tests.zip` });
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                }
              >
                Export tests
              </Button>
              <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-line bg-panel px-3 text-[13px] font-medium hover:border-line-strong">
                Import tests
                <input
                  type="file"
                  multiple
                  accept=".yaml,.yml,.ts,.js,.mjs"
                  className="hidden"
                  onChange={(e) => {
                    const picked = [...(e.target.files ?? [])];
                    e.target.value = "";
                    if (!picked.length) return;
                    void act(async () => {
                      const files = await Promise.all(picked.map(async (f) => ({ name: f.name, text: await f.text() })));
                      const r = await postJson<{ imported: string[]; skipped: { file: string; test?: string; reason: string }[] }>(session, "/api/import", { projectId: project.id, files });
                      announceChange();
                      await tell(
                        `Imported ${r.imported.length} ${r.imported.length === 1 ? "test" : "tests"}`,
                        r.skipped.length ? `Skipped:\n${r.skipped.map((x) => `${x.file}${x.test ? ` (${x.test})` : ""}: ${x.reason}`).join("\n")}` : undefined,
                      );
                    });
                  }}
                />
              </label>
              <Button
                variant="danger"
                onClick={() =>
                  act(async () => {
                    if (!(await askConfirm(`Delete ${project.name}?`, { body: "Everything in it is deleted for good.", ok: "Delete project", danger: true }))) return;
                    must(await sb.from("projects").delete().eq("id", project.id));
                    projectsChanged();
                    navigate("tests");
                  })
                }
              >
                Delete project
              </Button>
            </div>
            {inbox.data ? (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <span className="text-[13px] font-medium">Inbox</span>
                <span className="min-w-0 truncate font-mono text-[12.5px] text-muted">
                  {inbox.data}-<span className="text-faint">name</span>@{INBOX_DOMAIN}
                </span>
              </div>
            ) : null}
          </Panel>
        ) : null}


        {project ? <GitHubPanel sb={sb} session={session} ws={ws} project={project} /> : null}

        {project ? <AlertsPanel sb={sb} session={session} project={project} /> : null}

        <PlanPanel sb={sb} session={session} ws={ws} role={role} />

        <KeysPanel sb={sb} session={session} ws={ws} />

        <Panel>
          <CardHead label="Workspace" count={members.data ? `${members.data.length} ${members.data.length === 1 ? "member" : "members"}` : undefined}>
            {role === "owner" ? (
              <Button
                variant="plain"
                className="h-7 px-2"
                onClick={() =>
                  act(async () => {
                    const name = await askText("Workspace name", { initial: ws.name });
                    if (!name || name === ws.name) return;
                    must(await sb.from("workspaces").update({ name }).eq("id", ws.id));
                    window.location.reload();
                  })
                }
              >
                Rename
              </Button>
            ) : null}
          </CardHead>
          <div className="flex items-center gap-2 px-4 py-4">
            <span className="text-[15px] font-medium">{ws.name}</span>
            <Badge>{role}</Badge>
          </div>
        </Panel>

        <Panel>
          <CardHead label="Account" />
          <div className="flex items-center gap-3 px-4 py-4">
            <Avatar label={session.user.email ?? "?"} size={28} />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{session.user.email}</span>
            <Button variant="ghost" onClick={() => sb.auth.signOut()}>
              <LogOut size={13} />
              Sign out
            </Button>
          </div>
        </Panel>
      </div>
    </Page>
  );
}
