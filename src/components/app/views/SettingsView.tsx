"use client";

import { useState } from "react";
import { Copy, Key, LogOut, Plus, Settings } from "../../Icons";
import { APP_URL } from "@/lib/site";
import { askConfirm, askText } from "../Dialogs";
import { AccountAlertsPanel } from "./AccountAlertsPanel";
import { IdentityPanel } from "./IdentityPanel";
import { IcpPanel, SitesPanel } from "./SitesPanel";
import { SETTINGS_GROUPS, settingsTab, type SettingsTab } from "@/lib/settingsTabs";
import { DomainsPanel, TeamPanel } from "./TeamSettings";
import { FieldsSettings, ObjectsSettings } from "./FieldsSettings";
import { ImportsSettings } from "./ImportsSettings";
import { SourcesSettings, SyncLog } from "./SourcesSettings";
import {
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

export function SettingsView({ sb, session, ws, role, navigate, id }: ViewProps) {
  const [error, setError] = useState("");
  const [tab, setTab] = useState<SettingsTab>(() => settingsTab(id || (typeof window === "undefined" ? "" : window.location.hash.slice(1))));
  const members = useLoad(async () => must(await sb.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", ws.id).order("created_at")) as { user_id: string; role: string }[], ws.id);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const pages: Record<SettingsTab, React.ReactNode> = {
    fields: <FieldsSettings sb={sb} ws={ws} role={role} />,
    objects: <ObjectsSettings sb={sb} ws={ws} role={role} navigate={navigate} />,
    sources: <SourcesSettings sb={sb} session={session} ws={ws} role={role} />,
    imports: <ImportsSettings sb={sb} ws={ws} />,
    sync_log: <SyncLog sb={sb} ws={ws} navigate={navigate} />,
    sites: <SitesPanel sb={sb} ws={ws} role={role} />,
    identity: <IdentityPanel sb={sb} session={session} ws={ws} role={role} />,
    icp: <IcpPanel sb={sb} ws={ws} />,
    account_alerts: <AccountAlertsPanel sb={sb} session={session} ws={ws} />,
    domains: <DomainsPanel sb={sb} ws={ws} role={role} />,
    team: <TeamPanel sb={sb} ws={ws} role={role} session={session} />,
    workspace: (
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
    ),
    keys: <KeysPanel sb={sb} session={session} ws={ws} />,
    profile: (
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
    ),
  };
  const groups = SETTINGS_GROUPS;
  const tabs = groups.flatMap((g) => g.tabs);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const pick = (t: SettingsTab) => {
    setTab(t);
    try {
      history.replaceState(null, "", `/settings/${t}`);
    } catch {}
  };

  return (
    <Page icon={<Settings size={14} />} title="Settings">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 md:flex-row md:gap-10">
        <nav className="flex shrink-0 flex-col gap-4 md:sticky md:top-0 md:w-48 md:self-start" aria-label="Settings">
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <span className="label-mono px-2 pb-1">{g.label}</span>
              {g.tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-current={current.id === t.id ? "page" : undefined}
                  onClick={() => pick(t.id)}
                  className={`flex h-8 items-center rounded-md px-2.5 text-left text-[13px] font-medium ${current.id === t.id ? "bg-panel text-ink ring-1 ring-line" : "text-body hover:bg-hover hover:text-ink"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <ErrorNote message={error} />
          {pages[current.id]}
        </div>
      </div>
    </Page>
  );
}
