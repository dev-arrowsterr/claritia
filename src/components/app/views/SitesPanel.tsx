"use client";

// Settings › Sites and ICP (docs/m1-website-intelligence.md 8.1, 8.3).

import { useState } from "react";
import { askText } from "../Dialogs";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, Tabs, timeAgo, useLoad, type ViewProps } from "../ui";
import type { SiteHealth } from "./VisitorsView";

const COLLECT = "https://claritia-collect.fly.dev";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre">{text}</pre>
      <Button
        variant="ghost"
        className="h-7 px-2.5"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Install({ site }: { site: SiteHealth }) {
  const [mode, setMode] = useState<"proxy" | "subdomain" | "direct">("proxy");
  const tag = (src: string) => `<script defer src="${src}" data-site="${site.site_key}"></script>`;
  const next = `// app/_clr/[...path]/route.ts (folder name: %5Fclr)
const COLLECT = "${COLLECT}";
async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = new URL(req.url);
  const headers = new Headers();
  for (const h of ["cookie", "origin", "referer", "user-agent", "accept-language", "content-type", "dnt"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip");
  if (ip) {
    headers.set("x-clr-proxy", process.env.CLR_PROXY_SECRET!);
    headers.set("x-clr-client-ip", ip);
  }
  const res = await fetch(\`\${COLLECT}/\${path.join("/")}\${url.search}\`, { method: req.method, headers, body: req.method === "POST" ? await req.text() : undefined });
  const out = new Headers();
  for (const h of ["content-type", "cache-control", "retry-after", "access-control-allow-origin", "access-control-allow-credentials", "vary"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of res.headers.getSetCookie()) out.append("set-cookie", c);
  return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
}
export const GET = handle;
export const POST = handle;

// .env
CLR_PROXY_SECRET=${site.proxy_secret}`;
  const nginx = `location /_clr/ {
  proxy_pass ${COLLECT}/;
  proxy_set_header Host claritia-collect.fly.dev;
  proxy_set_header X-Clr-Client-IP $remote_addr;
  proxy_set_header X-Clr-Proxy ${site.proxy_secret};
}`;
  return (
    <div className="flex flex-col gap-3">
      <Tabs
        value={mode}
        onChange={setMode}
        tabs={[
          { value: "proxy", label: "Proxy path · Best" },
          { value: "subdomain", label: "Subdomain" },
          { value: "direct", label: "Direct" },
        ]}
      />
      {mode === "proxy" ? (
        <>
          <Copy text={tag("/_clr/s.js")} />
          <Field label="Next.js">
            <Copy text={next} />
          </Field>
          <Field label="Nginx">
            <Copy text={nginx} />
          </Field>
        </>
      ) : mode === "subdomain" ? (
        <>
          <Copy text={`fly certs add t.${site.domain} --app claritia-collect`} />
          <Copy text={tag(`https://t.${site.domain}/s.js`)} />
        </>
      ) : (
        <Copy text={tag(`${COLLECT}/s.js`)} />
      )}
    </div>
  );
}

export function SitesPanel({ sb, ws, role }: Pick<ViewProps, "sb" | "ws" | "role">) {
  const sites = useLoad(async () => ({ rows: must(await sb.rpc("site_health", { p_ws: ws.id })) as SiteHealth[], at: Date.now() }), ws.id);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  const add = async () => {
    const domain = await askText("Add a site", { placeholder: "acme.com", ok: "Add" });
    if (!domain) return;
    setError("");
    try {
      must(await sb.rpc("add_site", { p_workspace: ws.id, p_domain: domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] }));
      sites.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Panel>
      <CardHead label="Sites" count={sites.data?.rows.length}>
        {role === "owner" ? (
          <Button variant="ghost" className="h-7 px-2.5" onClick={add}>
            Add site
          </Button>
        ) : null}
      </CardHead>
      <div className="flex flex-col">
        <div className="px-4 pt-3">
          <ErrorNote message={error || sites.error} />
        </div>
        {!sites.data ? (
          <Loading />
        ) : (
          sites.data.rows.map((s, i) => {
            const live = !!s.last_event_at && sites.data!.at - Date.parse(s.last_event_at) < 3600_000;
            return (
              <div key={s.id} className={`flex flex-col gap-3 px-4 py-4 ${i ? "border-t border-line" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium">{s.domain}</span>
                  {s.paused ? <Badge tone="amber">Paused</Badge> : live ? <Badge tone="green">Receiving events</Badge> : <Badge>Waiting for events</Badge>}
                  {s.install_mode ? <Badge>{s.install_mode}</Badge> : null}
                  <span className="ml-auto font-mono text-[11.5px] text-muted">
                    {s.sessions_24h} visits · {s.with_account_24h} with a company · {s.identified_24h} with a person · last {timeAgo(s.last_event_at)}
                  </span>
                  <Button variant="plain" className="h-7 px-2" onClick={() => setOpen(open === s.id ? "" : s.id)}>
                    {open === s.id ? "Hide install" : "Install"}
                  </Button>
                </div>
                {open === s.id ? <Install site={s} /> : null}
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

const SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1,000", "1,001-5,000", "5,001-10,000", "10,001+"];
type Rules = { industries?: { values: string[]; weight: number }; sizes?: { values: string[]; weight: number }; countries?: { values: string[]; weight: number; required?: boolean } };

export function IcpPanel({ sb, ws }: Pick<ViewProps, "sb" | "ws">) {
  const saved = useLoad(async () => ((must(await sb.from("icp").select("rules").eq("workspace_id", ws.id).maybeSingle()) as { rules: Rules } | null)?.rules ?? {}) as Rules, ws.id);
  return saved.data ? <IcpForm key={JSON.stringify(saved.data)} sb={sb} ws={ws} rules={saved.data} onSaved={saved.reload} /> : <Loading />;
}

function IcpForm({ sb, ws, rules, onSaved }: Pick<ViewProps, "sb" | "ws"> & { rules: Rules; onSaved: () => void }) {
  const [industries, setIndustries] = useState((rules.industries?.values ?? []).join(", "));
  const [sizes, setSizes] = useState<string[]>(rules.sizes?.values ?? []);
  const [countries, setCountries] = useState((rules.countries?.values ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const next: Rules = {};
      if (list(industries).length) next.industries = { values: list(industries), weight: 50 };
      if (sizes.length) next.sizes = { values: sizes, weight: 30 };
      if (list(countries).length) next.countries = { values: list(countries).map((c) => c.toUpperCase()), weight: 20 };
      must(await sb.rpc("set_icp", { p_ws: ws.id, p_rules: next }));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel>
      <CardHead label="Ideal customer" />
      <div className="flex flex-col gap-4 p-4">
        <Field label="Industries">
          <Input value={industries} onChange={(e) => setIndustries(e.target.value)} placeholder="Software Development, Financial Services" />
        </Field>
        <Field label="Company size">
          <div className="flex flex-wrap gap-1.5">
            {SIZES.map((s) => (
              <Button key={s} variant={sizes.includes(s) ? "primary" : "ghost"} className="h-7 px-2.5" onClick={() => setSizes(sizes.includes(s) ? sizes.filter((x) => x !== s) : [...sizes, s])}>
                {s}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="Countries">
          <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="US, CA, GB" />
        </Field>
        <ErrorNote message={error} />
        <div>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
