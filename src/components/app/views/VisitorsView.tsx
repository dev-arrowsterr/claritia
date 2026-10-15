"use client";

// Visitors (docs/m1-website-intelligence.md 8.4): the last day's visits, refreshed every 10 seconds.

import { useEffect } from "react";
import { Eye } from "../../Icons";
import { Badge, Button, Empty, ErrorNote, Loading, must, Page, Panel, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";
import { VisitorsIntro } from "./MarketingIntros";

export type Visit = {
  id: string;
  started_at: string;
  country: string | null;
  city: string | null;
  ref_class: string | null;
  source: string | null;
  referrer_host: string | null;
  device_type: string | null;
  policy: string;
  account_id: string | null;
  account_name: string | null;
  account_domain: string | null;
  account_source: string | null;
  person_id: string | null;
  person_email: string | null;
  person_level: string | null;
  pageviews: number;
  engaged_s: number;
  pages: string[];
};

export type SiteHealth = {
  id: string;
  domain: string;
  extra_domains: string[];
  site_key: string;
  proxy_secret: string;
  install_mode: string | null;
  last_event_at: string | null;
  paused: boolean;
  sessions_24h: number;
  identified_24h: number;
  with_account_24h: number;
};

export const LEVEL_TONE: Record<string, Tone> = { verified: "green", asserted: "brand", probable: "amber" };
const REF_LABEL: Record<string, string> = {
  search: "Search",
  ai_assistant: "AI",
  review_site: "Reviews",
  social: "Social",
  partner: "Partner",
  email: "Email",
  paid: "Paid",
  direct: "Direct",
  other: "Referral",
};

export const activeTime = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

export function VisitorsView({ sb, ws, navigate }: ViewProps) {
  const sites = useLoad(async () => must(await sb.rpc("site_health", { p_ws: ws.id })) as SiteHealth[], ws.id);
  const visits = useLoad(async () => must(await sb.rpc("visitors_live", { p_ws: ws.id, p_hours: 24, p_limit: 200 })) as Visit[], ws.id);
  const reload = visits.reload;

  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (sites.error || visits.error) {
    return (
      <Page icon={<Eye size={14} />} title="Visitors">
        <ErrorNote message={sites.error || visits.error} />
      </Page>
    );
  }
  if (!sites.data || !visits.data) {
    return (
      <Page icon={<Eye size={14} />} title="Visitors">
        <Loading />
      </Page>
    );
  }
  if (!sites.data.length) return <VisitorsIntro action={<Button onClick={() => navigate("settings")}>Add your site</Button>} />;

  const rows = visits.data;
  const named = rows.filter((v) => v.account_id).length;
  return (
    <Page icon={<Eye size={14} />} title="Visitors" count={rows.length} flush>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line bg-canvas px-4 py-2.5 font-mono text-[11px] text-muted md:px-5">
        <span>24h</span>
        <span>
          {rows.length} visits · {named} with a company · {rows.filter((v) => v.person_id).length} with a person
        </span>
        <span className="ml-auto">{sites.data.map((s) => `${s.domain} ${s.last_event_at ? timeAgo(s.last_event_at) : "—"}`).join(" · ")}</span>
      </div>
      {!rows.length ? (
        <Empty icon={<Eye size={16} />} title="No visits yet" />
      ) : (
        <Panel className="m-0 border-0">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Company</Th>
                <Th>Person</Th>
                <Th>Pages</Th>
                <Th className="text-right">Active</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} onClick={() => v.account_id && navigate("accounts", v.account_id)} className={v.account_id ? "cursor-pointer hover:bg-hover" : ""}>
                  <Td className="font-mono text-[12px] text-muted">{timeAgo(v.started_at)}</Td>
                  <Td>
                    {v.account_id ? (
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{v.account_name ?? v.account_domain}</span>
                        {v.account_name ? <span className="text-[12px] text-faint">{v.account_domain}</span> : null}
                        {v.account_source === "vendor_network" || v.account_source === "learned_network" ? <Badge>By network</Badge> : null}
                      </span>
                    ) : (
                      <span className="text-muted">Unknown{v.country ? ` · ${v.country}` : ""}</span>
                    )}
                  </Td>
                  <Td>
                    {v.person_email ? (
                      <span className="flex items-center gap-2">
                        <span className="truncate">{v.person_email}</span>
                        {v.person_level ? <Badge tone={LEVEL_TONE[v.person_level] ?? "gray"}>{v.person_level}</Badge> : null}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td className="max-w-[340px] truncate font-mono text-[12px]">
                    {v.pages.join("  ")}
                    {v.pageviews > v.pages.length ? <span className="text-faint">{`  +${v.pageviews - v.pages.length}`}</span> : null}
                  </Td>
                  <Td className="text-right font-mono text-[12px] tabular-nums">{activeTime(v.engaged_s)}</Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Badge>{REF_LABEL[v.ref_class ?? "direct"] ?? v.ref_class}</Badge>
                      <span className="truncate text-[12px] text-muted">{v.referrer_host ?? v.source ?? ""}</span>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Page>
  );
}
