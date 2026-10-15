"use client";

// Settings › Identity (docs/identity.md Part 9, 5.2): the team's own domains, partner domains, and the secret that
// signs claritia("identify", ...) calls.

import { useState } from "react";
import { askConfirm } from "../Dialogs";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, Tabs, useLoad, type ViewProps } from "../ui";
import { domainList } from "@/lib/identity/domainList";
import { Copy } from "./SitesPanel";
import type { SiteHealth } from "./VisitorsView";

type Domains = { own_domains: string[]; partner_domains: string[] };

export function IdentityPanel({ sb, session, ws, role }: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const saved = useLoad(
    async () => ((must(await sb.from("identity_settings").select("own_domains, partner_domains").eq("workspace_id", ws.id).maybeSingle()) as Domains | null) ?? { own_domains: [], partner_domains: [] }),
    ws.id,
  );
  const owner = role === "owner";
  return (
    <Panel>
      <CardHead label="Identity" />
      {saved.data ? <DomainsForm key={JSON.stringify(saved.data)} sb={sb} ws={ws} owner={owner} saved={saved.data} onSaved={saved.reload} /> : <Loading />}
      {owner ? <Secret session={session} ws={ws} sb={sb} /> : null}
    </Panel>
  );
}

function DomainsForm({ sb, ws, owner, saved, onSaved }: Pick<ViewProps, "sb" | "ws"> & { owner: boolean; saved: Domains; onSaved: () => void }) {
  const [own, setOwn] = useState(saved.own_domains.join(", "));
  const [partner, setPartner] = useState(saved.partner_domains.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const o = domainList(own);
    const p = domainList(partner);
    const bad = [...o.bad, ...p.bad];
    if (bad.length) return setError(`Not a domain: ${bad.join(", ")}`);
    setBusy(true);
    setError("");
    try {
      must(await sb.rpc("set_identity_domains", { p_ws: ws.id, p_own: o.ok, p_partner: p.ok }));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <Field label="Your team's email domains">
        <Input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="acme.com" disabled={!owner} />
      </Field>
      <Field label="Partner domains">
        <Input value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="agency.com, reseller.io" disabled={!owner} />
      </Field>
      <ErrorNote message={error} />
      {owner ? (
        <div>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const snippet = (siteId: string) => `// Server, after sign-in. Keep the secret out of the browser.
import { createHmac } from "node:crypto";

const SITE_ID = "${siteId}";

export function claritiaIdentify(userId, email) {
  const iat = Math.floor(Date.now() / 1000);
  const token = createHmac("sha256", process.env.CLARITIA_IDENTIFY_SECRET)
    .update(\`v1|\${SITE_ID}|\${userId}|\${email.toLowerCase()}|\${iat}\`)
    .digest("base64url");
  return { userId, email, iat, token };
}

// Browser, with what claritiaIdentify returned
claritia("identify", signed);`;

function Secret({ sb, session, ws }: Pick<ViewProps, "sb" | "session" | "ws">) {
  const auth = { Authorization: `Bearer ${session.access_token}` };
  const state = useLoad(async () => {
    const res = await fetch(`/api/identity-secret?workspaceId=${ws.id}`, { headers: auth });
    const data = (await res.json().catch(() => ({}))) as { secret?: string | null; old?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
    return { secret: data.secret ?? null, old: !!data.old };
  }, ws.id);
  const sites = useLoad(async () => must(await sb.rpc("site_health", { p_ws: ws.id })) as SiteHealth[], ws.id);
  const [site, setSite] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const act = async (action: "rotate" | "drop_old") => {
    if (action === "rotate" && state.data?.secret && !(await askConfirm("Make a new secret?", { body: "The old one keeps working until you stop it.", ok: "Make new secret" }))) return;
    if (action === "drop_old" && !(await askConfirm("Stop the old secret?", { body: "Sign-ins signed with it will show as unverified.", ok: "Stop it", danger: true }))) return;
    setBusy(action);
    setError("");
    try {
      await postJson(session, "/api/identity-secret", { workspaceId: ws.id, action });
      setShown(action === "rotate");
      state.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const list = sites.data ?? [];
  const current = list.find((s) => s.id === site) ?? list[0];
  return (
    <div className="flex flex-col gap-3 border-t border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">Sign-in secret</span>
        {state.data ? state.data.secret ? <Badge tone="green">Set</Badge> : <Badge>Not set</Badge> : null}
        {state.data?.old ? <Badge tone="amber">Old secret still works</Badge> : null}
        <span className="ml-auto flex gap-1.5">
          {state.data?.secret ? (
            <Button variant="plain" className="h-7 px-2" onClick={() => setShown(!shown)}>
              {shown ? "Hide" : "Show"}
            </Button>
          ) : null}
          {state.data?.old ? (
            <Button variant="ghost" className="h-7 px-2.5" onClick={() => act("drop_old")} disabled={!!busy}>
              Stop old secret
            </Button>
          ) : null}
          <Button variant="ghost" className="h-7 px-2.5" onClick={() => act("rotate")} disabled={!!busy || !state.data}>
            {busy === "rotate" ? "Making…" : state.data?.secret ? "New secret" : "Make secret"}
          </Button>
        </span>
      </div>
      <ErrorNote message={error || state.error} />
      {state.data?.secret && shown ? (
        <>
          <Copy text={`CLARITIA_IDENTIFY_SECRET=${state.data.secret}`} />
          {list.length > 1 ? <Tabs value={current?.id ?? ""} onChange={setSite} tabs={list.map((s) => ({ value: s.id, label: s.domain }))} /> : null}
          {current ? <Copy text={snippet(current.id)} /> : null}
        </>
      ) : null}
    </div>
  );
}
