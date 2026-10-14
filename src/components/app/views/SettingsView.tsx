"use client";

import { useState } from "react";
import { Key, LogOut, Plus, Settings, Trash } from "../../Icons";
import { amount, planById, PLANS, type PlanId } from "@/lib/plans";
import { INBOX_DOMAIN } from "@/lib/site";
import { askConfirm, askText } from "../Dialogs";
import {
  Avatar,
  Badge,
  Button,
  CardHead,
  cleanUrl,
  ErrorNote,
  errorText,
  Input,
  Loading,
  must,
  Page,
  Panel,
  postJson,
  timeAgo,
  useLoad,
  type Environment,
  type Secret,
  type ViewProps,
} from "../ui";

type EnvWithSecrets = Environment & { secrets: Secret[] };
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

function SecretRow({ secret, onDelete }: { secret: Secret; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Key size={13} className="text-faint" />
      <span className="font-mono text-[12.5px] text-ink">{secret.name}</span>
      <span className="font-mono text-[12px] tracking-[0.2em] text-faint">••••••••</span>
      <span className="ml-auto text-[12px] text-muted">{timeAgo(secret.updated_at)}</span>
      <button type="button" aria-label={`Delete ${secret.name}`} onClick={onDelete} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger">
        <Trash size={13} />
      </button>
    </li>
  );
}

function AddSecret({ onAdd }: { onAdd: (name: string, value: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-2 px-4 py-3 sm:grid-cols-[200px_1fr_auto]"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onAdd(name.trim().toUpperCase(), value);
          setName("");
          setValue("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]+/g, "_").replace(/[^A-Z0-9_]/g, ""))} placeholder="NAME" aria-label="Secret name" className="font-mono" maxLength={64} required />
      <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" aria-label="Secret value" autoComplete="new-password" required />
      <Button type="submit" variant="ghost" disabled={busy}>
        <Plus size={13} />
        {busy ? "Saving…" : "Add secret"}
      </Button>
    </form>
  );
}

function EnvironmentCard({ env, onChanged, sb, session }: { env: EnvWithSecrets; onChanged: () => void } & Pick<ViewProps, "sb" | "session">) {
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Panel>
      <CardHead label={env.name} count={env.secrets.length ? `${env.secrets.length} secrets` : undefined}>
        <Button
          variant="plain"
          className="h-7 px-2"
          onClick={() =>
            run(async () => {
              const next = await askText("Site address", { initial: env.base_url, ok: "Save" });
              if (!next) return;
              const base = cleanUrl(next);
              if (!base) throw new Error("Enter a site address, like staging.acme.com.");
              must(await sb.from("environments").update({ base_url: base }).eq("id", env.id));
            })
          }
        >
          Edit address
        </Button>
        <button
          type="button"
          aria-label={`Delete ${env.name}`}
          className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger"
          onClick={() =>
            run(async () => {
              if (!(await askConfirm(`Delete ${env.name}?`, { body: "Its secrets are deleted too.", ok: "Delete", danger: true }))) return;
              must(await sb.from("environments").delete().eq("id", env.id));
            })
          }
        >
          <Trash size={13} />
        </button>
      </CardHead>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Badge tone="brand">URL</Badge>
        <a href={env.base_url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[12.5px] text-brand hover:underline">
          {env.base_url}
        </a>
      </div>
      {env.secrets.length ? (
        <ul className="divide-y divide-line border-b border-line">
          {env.secrets.map((s) => (
            <SecretRow
              key={s.id}
              secret={s}
              onDelete={() =>
                run(async () => {
                  if (!(await askConfirm(`Delete ${s.name}?`, { ok: "Delete", danger: true }))) return;
                  must(await sb.from("env_secrets").delete().eq("id", s.id));
                })
              }
            />
          ))}
        </ul>
      ) : null}
      <AddSecret onAdd={(name, value) => run(() => postJson(session, "/api/secrets", { environmentId: env.id, name, value }))} />
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
  const envs = useLoad(async () => {
    if (!project) return [] as EnvWithSecrets[];
    const list = must(await sb.from("environments").select("id, project_id, name, base_url, created_at").eq("project_id", project.id).order("created_at")) as Environment[];
    if (!list.length) return [] as EnvWithSecrets[];
    const secrets = must(
      await sb
        .from("env_secrets")
        .select("id, environment_id, name, updated_at")
        .in(
          "environment_id",
          list.map((e) => e.id),
        )
        .order("name"),
    ) as Secret[];
    return list.map((e) => ({ ...e, secrets: secrets.filter((s) => s.environment_id === e.id) }));
  }, project?.id ?? "none");
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

  const addEnvironment = () =>
    act(async () => {
      if (!project) return;
      const name = await askText("Environment name", { placeholder: "production", ok: "Next" });
      if (!name) return;
      const address = await askText("Site address", { placeholder: "acme.com", ok: "Add" });
      if (!address) return;
      const base = cleanUrl(address);
      if (!base) throw new Error("Enter a site address, like acme.com.");
      must(await sb.from("environments").insert({ project_id: project.id, name: name.toLowerCase(), base_url: base }));
      envs.reload();
    });

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
            <div className="flex items-center justify-between gap-3 px-4 py-4">
              <span className="text-[15px] font-medium">{project.name}</span>
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

        {project ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="section-head">Environments</p>
              <Button variant="ghost" onClick={addEnvironment}>
                <Plus size={13} />
                Add environment
              </Button>
            </div>
            {envs.error ? <ErrorNote message={envs.error} /> : null}
            {!envs.data ? <Loading /> : envs.data.map((e) => <EnvironmentCard key={e.id} env={e} onChanged={envs.reload} sb={sb} session={session} />)}
          </section>
        ) : null}

        <PlanPanel sb={sb} session={session} ws={ws} role={role} />

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
