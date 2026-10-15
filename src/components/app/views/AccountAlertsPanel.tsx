"use client";

// Settings › Account alerts: Slack when an account turns hot, reaches Evaluating, or passes an intent score.

import { useState } from "react";
import { ruleText, type AlertRule } from "@/lib/web/accountAlerts";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, useLoad, type ViewProps } from "../ui";

type Saved = { id: string; rule: AlertRule; slack_hint: string | null; daily_cap: number };

export function AccountAlertsPanel({ sb, session, ws }: Pick<ViewProps, "sb" | "session" | "ws">) {
  const rules = useLoad(async () => must(await sb.from("account_alert_rules").select("id, rule, slack_hint, daily_cap").eq("workspace_id", ws.id).order("created_at")) as Saved[], ws.id);
  const [when, setWhen] = useState<AlertRule["when"]>("hot");
  const [intent, setIntent] = useState("70");
  const [fit, setFit] = useState("");
  const [slack, setSlack] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const add = () =>
    run("add", async () => {
      const rule: AlertRule = { when, ...(when === "intent" ? { intent: Number(intent) } : {}), ...(fit.trim() ? { fit_min: Number(fit) } : {}) };
      await postJson(session, "/api/account-alerts", { workspaceId: ws.id, rule, slackUrl: slack });
      setSlack("");
      rules.reload();
    });
  const remove = (id: string) =>
    run(id, async () => {
      if (!(await askConfirm("Remove this alert?", { ok: "Remove", danger: true }))) return;
      const res = await fetch("/api/account-alerts", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ workspaceId: ws.id, ruleId: id }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      rules.reload();
    });

  return (
    <Panel>
      <CardHead label="Account alerts" count={rules.data?.length} />
      <div className="flex flex-col">
        {!rules.data ? (
          <Loading />
        ) : (
          rules.data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-[13px]">
              <span>{ruleText(r.rule)}</span>
              <span className="font-mono text-[11.5px] text-muted">Slack …{r.slack_hint} · up to {r.daily_cap} a day</span>
              <span className="ml-auto flex gap-1.5">
                <Button variant="ghost" className="h-7 px-2.5" disabled={!!busy} onClick={() => run(`t${r.id}`, () => postJson(session, "/api/account-alerts", { workspaceId: ws.id, ruleId: r.id, test: true }))}>
                  {busy === `t${r.id}` ? "Sending…" : "Send test"}
                </Button>
                <Button variant="plain" className="h-7 px-2" disabled={!!busy} onClick={() => remove(r.id)}>
                  Remove
                </Button>
              </span>
            </div>
          ))
        )}
        <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto]">
          <Field label="When an account">
            <Select<AlertRule["when"]>
              value={when}
              onChange={setWhen}
              options={[
                { value: "hot", label: "turns hot" },
                { value: "evaluating", label: "reaches Evaluating" },
                { value: "intent", label: "passes an intent score" },
              ]}
            />
          </Field>
          {when === "intent" ? (
            <Field label="Intent">
              <Input value={intent} onChange={(e) => setIntent(e.target.value.replace(/\D/g, ""))} className="w-20" />
            </Field>
          ) : (
            <span />
          )}
          <Field label="Fit at least">
            <Input value={fit} onChange={(e) => setFit(e.target.value.replace(/\D/g, ""))} placeholder="Any" className="w-24" />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Slack webhook">
              <Input value={slack} onChange={(e) => setSlack(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" />
            </Field>
          </div>
          <div className="sm:col-span-3">
            <ErrorNote message={error || rules.error} />
          </div>
          <div>
            <Button onClick={add} disabled={!!busy || !slack.trim()}>
              {busy === "add" ? "Adding…" : "Add alert"}
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
