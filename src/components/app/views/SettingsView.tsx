"use client";

import { useState } from "react";
import { Key, LogOut, Plus, Settings, Trash } from "../../Icons";
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
