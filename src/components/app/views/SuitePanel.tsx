"use client";

import { useState } from "react";
import { PRODUCTS, type Product } from "@/lib/suite";
import { askConfirm } from "../Dialogs";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, postJson, timeAgo, useLoad, type ViewProps } from "../ui";

type Saved = { product: Product; base_url: string; key_hint: string | null; brand: string | null; status: "ok" | "error"; error: string | null; checked_at: string | null };

/** Links to Omniscient and Arrowsterr: an address and an API key from each. Owners connect; anyone checks again. */
export function SuitePanel({ sb, session, ws, role }: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const saved = useLoad(
    async () => must(await sb.from("suite_connections").select("product, base_url, key_hint, brand, status, error, checked_at").eq("workspace_id", ws.id)) as Saved[],
    ws.id,
  );
  return (
    <Panel>
      <CardHead label="Suite" />
      {saved.error ? (
        <div className="p-4">
          <ErrorNote message={saved.error} />
        </div>
      ) : !saved.data ? (
        <Loading />
      ) : (
        (Object.keys(PRODUCTS) as Product[]).map((p, i) => (
          <SuiteRow key={p + JSON.stringify(saved.data!.find((s) => s.product === p) ?? null)} product={p} saved={saved.data!.find((s) => s.product === p) ?? null} first={i === 0} session={session} wsId={ws.id} owner={role === "owner"} onChange={saved.reload} />
        ))
      )}
    </Panel>
  );
}

function SuiteRow({ product, saved, first, session, wsId, owner, onChange }: { product: Product; saved: Saved | null; first: boolean; session: ViewProps["session"]; wsId: string; owner: boolean; onChange: () => void }) {
  const name = PRODUCTS[product].name;
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(saved?.base_url ?? "");
  const [key, setKey] = useState("");
  const [brand, setBrand] = useState(saved?.brand ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const run = async (which: string, fn: () => Promise<unknown>) => {
    setBusy(which);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const connect = () =>
    run("connect", async () => {
      await postJson(session, "/api/suite", { workspaceId: wsId, product, baseUrl, key, brand });
      setEditing(false);
      onChange();
    });
  const check = () =>
    run("check", async () => {
      await postJson(session, "/api/suite", { workspaceId: wsId, product, check: true });
      onChange();
    });
  const disconnect = () =>
    run("disconnect", async () => {
      if (!(await askConfirm(`Disconnect ${name}?`, { ok: "Disconnect", danger: true }))) return;
      const res = await fetch("/api/suite", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ workspaceId: wsId, product }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      onChange();
    });

  const form = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Address">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={PRODUCTS[product].placeholder} autoComplete="off" />
      </Field>
      <Field label={`${name} API key`}>
        <Input value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" placeholder={saved?.key_hint ? `Saved ${saved.key_hint}` : ""} />
      </Field>
      {product === "arrowsterr" ? (
        <Field label="Brand">
          <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="acme.com" autoComplete="off" />
        </Field>
      ) : null}
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button onClick={connect} disabled={!!busy || !baseUrl.trim() || !key.trim()}>
          {busy === "connect" ? "Connecting…" : "Connect"}
        </Button>
        {saved ? (
          <Button variant="plain" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className={`flex flex-col gap-3 px-4 py-4 ${first ? "" : "border-t border-line"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{name}</span>
        {saved ? <Badge tone={saved.status === "ok" ? "green" : "red"}>{saved.status === "ok" ? "Connected" : "Not working"}</Badge> : <Badge>Not connected</Badge>}
        {saved ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" className="h-7 px-2.5" onClick={check} disabled={!!busy}>
              {busy === "check" ? "Checking…" : "Check again"}
            </Button>
            {owner && !editing ? (
              <Button variant="plain" className="h-7 px-2" onClick={() => setEditing(true)} disabled={!!busy}>
                Change
              </Button>
            ) : null}
            {owner ? (
              <Button variant="plain" className="h-7 px-2" onClick={disconnect} disabled={!!busy}>
                Disconnect
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {saved ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] text-muted">
          <span>{saved.base_url}</span>
          {saved.key_hint ? <span>key {saved.key_hint}</span> : null}
          {saved.brand ? <span>brand {saved.brand}</span> : null}
          <span>checked {timeAgo(saved.checked_at)}</span>
        </p>
      ) : null}
      {saved?.status === "error" && saved.error ? <ErrorNote message={saved.error} /> : null}
      <ErrorNote message={error} />
      {owner && (!saved || editing) ? form : null}
    </div>
  );
}
