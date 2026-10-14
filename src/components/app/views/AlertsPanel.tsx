"use client";

import { useState } from "react";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, useLoad, type ViewProps } from "../ui";

type Saved = { slack_hint: string | null; emails: string[]; on_failure: boolean; on_heal: boolean };

/** Where a project's alerts go: a Slack channel and emails, for real failures and fixes waiting for approval. */
export function AlertsPanel({ sb, session, project }: Pick<ViewProps, "sb" | "session"> & { project: NonNullable<ViewProps["project"]> }) {
  const saved = useLoad(
    async () =>
      ((must(await sb.from("alert_settings").select("slack_hint, emails, on_failure, on_heal").eq("project_id", project.id).maybeSingle()) as Saved | null) ?? {
        slack_hint: null,
        emails: [],
        on_failure: true,
        on_heal: true,
      }),
    project.id,
  );
  return (
    <Panel>
      <CardHead label="Alerts" />
      {saved.error ? (
        <div className="p-4">
          <ErrorNote message={saved.error} />
        </div>
      ) : !saved.data ? (
        <Loading />
      ) : (
        <AlertsForm key={project.id + JSON.stringify(saved.data)} session={session} projectId={project.id} saved={saved.data} onSaved={saved.reload} />
      )}
    </Panel>
  );
}

function AlertsForm({ session, projectId, saved, onSaved }: { session: ViewProps["session"]; projectId: string; saved: Saved; onSaved: () => void }) {
  const [slackUrl, setSlackUrl] = useState("");
  const [emails, setEmails] = useState(saved.emails.join(", "));
  const [onFailure, setOnFailure] = useState(saved.on_failure);
  const [onHeal, setOnHeal] = useState(saved.on_heal);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const run = async (which: string, fn: () => Promise<unknown>) => {
    setBusy(which);
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const save = (slack?: string | null) =>
    postJson(session, "/api/alerts/settings", {
      projectId,
      emails: emails.split(/[\s,;]+/).filter(Boolean),
      onFailure,
      onHeal,
      ...(slack === undefined ? {} : { slackUrl: slack }),
    });

  return (
    <form
      className="grid gap-4 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run("save", async () => {
          await save(slackUrl.trim() ? slackUrl.trim() : undefined);
          setSlackUrl("");
          onSaved();
        });
      }}
    >
      {saved.slack_hint ? (
        <div className="flex flex-col gap-1.5">
          <span className="label-mono">Slack</span>
          <div className="flex h-9 items-center gap-2">
            <Badge tone="green">Connected</Badge>
            <span className="font-mono text-[12px] text-faint">…{saved.slack_hint}</span>
            <Button
              type="button"
              variant="plain"
              className="ml-auto h-7 px-2"
              disabled={!!busy}
              onClick={() =>
                run("slack", async () => {
                  await save(null);
                  onSaved();
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Field label="Slack webhook">
          <Input value={slackUrl} onChange={(e) => setSlackUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" spellCheck={false} />
        </Field>
      )}
      <Field label="Emails">
        <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="qa@company.com, dev@company.com" autoComplete="off" spellCheck={false} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="label-mono">Alert on</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} className="size-3.5 accent-[var(--color-brand)]" />
            Failed tests
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={onHeal} onChange={(e) => setOnHeal(e.target.checked)} className="size-3.5 accent-[var(--color-brand)]" />
            Fixes waiting for approval
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={!!busy}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!!busy || (!saved.slack_hint && !saved.emails.length)}
          onClick={() =>
            run("test", async () => {
              await postJson(session, "/api/alerts/settings", { projectId, test: true });
              setNote("Sent.");
            })
          }
        >
          {busy === "test" ? "Sending…" : "Send test"}
        </Button>
        {note ? <span className="text-[12.5px] text-muted">{note}</span> : null}
        <ErrorNote message={error} />
      </div>
    </form>
  );
}
