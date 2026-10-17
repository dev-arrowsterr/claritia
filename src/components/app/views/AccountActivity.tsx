"use client";

// What a company does on your site (docs/m1-website-intelligence.md 8.6): visits, the people behind them, firmographics
// and the signals behind its intent score. Shown on the company page.

import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decayed } from "@/lib/web/scores";
import { Badge, Button, CardHead, Empty, ErrorNote, errorText, Loading, must, Panel, Td, timeAgo, useLoad, type Tone } from "../ui";
import { activeTime, LEVEL_TONE } from "./VisitorsView";

export const STAGE_TONE: Record<string, Tone> = {
  evaluating: "brand",
  researching: "violet",
  engaged: "gray",
  unknown: "gray",
};
export const TEMP_TONE: Record<string, Tone> = {
  hot: "red",
  steady: "gray",
  cooling: "amber",
  cold: "gray",
};

type Signal = {
  kind: string;
  weight: number;
  at: string;
  person_id: string | null;
  evidence: { session_id?: string; path?: string };
};
type Detail = {
  account: {
    id: string;
    name: string | null;
    domain: string;
    fit: number | null;
    intent: number | null;
    priority: number | null;
    stage: string | null;
    temperature: string | null;
    why_now: string | null;
    flags: string[];
    firmo: {
      employees?: number;
      size?: string;
      industry?: string;
      country?: string;
      founded?: number;
      type?: string;
    } | null;
    firmo_at: string | null;
    first_seen: string;
  };
  people: {
    id: string;
    email: string | null;
    level: string | null;
    last_seen: string;
    sessions: number;
  }[];
  unknown: { devices: number; sessions: number };
  networks: { net: string; source: string }[];
  signals: Signal[];
  half_lives: Record<string, number>;
};
type Visit = {
  id: string;
  started_at: string;
  person_email: string | null;
  person_level: string | null;
  ref_class: string | null;
  referrer_host: string | null;
  country: string | null;
  engaged_s: number;
  events: {
    kind: string;
    path: string | null;
    at: string;
    data: { form?: string } | null;
  }[];
  signals: string[];
};

const HALF_LIFE: Record<string, number> = {
  page_pricing: 7,
  page_demo: 7,
  page_compare: 10,
  page_security: 14,
  page_integrations: 14,
  docs_depth: 14,
  case_study: 14,
  return_visit: 7,
  multi_person: 7,
  review_site_ref: 10,
  ai_assistant_ref: 10,
  engaged_session: 7,
  form_submit: 14,
  demo_request: 21,
  new_person: 14,
};

/** Good pick, wrong company, not a fit: teaches the scoring. */
export function AccountFeedback({ sb, accountId }: { sb: SupabaseClient; accountId: string }) {
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const feedback = async (kind: string) => {
    setError("");
    try {
      must(
        await sb.rpc("account_feedback_add", {
          p_account: accountId,
          p_kind: kind,
        }),
      );
      setSent(kind);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
      {[
        ["good", "Good pick"],
        ["bad", "Wrong company"],
        ["not_icp", "Not a fit"],
      ].map(([k, label]) => (
        <Button key={k} variant={sent === k ? "primary" : "ghost"} className="h-7 px-2.5" onClick={() => feedback(k)} disabled={!!sent}>
          {label}
        </Button>
      ))}
    </>
  );
}

export function AccountActivity({ sb, accountId }: { sb: SupabaseClient; accountId: string }) {
  const id = accountId;
  // Decay is worked out at load time, so the page doesn't shift while it's open.
  const detail = useLoad(
    async () => ({
      ...(must(await sb.rpc("account_detail", { p_id: id })) as Detail),
      loadedAt: Date.now(),
    }),
    id,
  );
  const timeline = useLoad(async () => must(await sb.rpc("account_timeline", { p_id: id, p_limit: 60 })) as Visit[], id);
  if (detail.error) return <ErrorNote message={detail.error} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const a = d.account;
  const now = d.loadedAt;
  const people = new Map(d.people.map((p) => [p.id, p.email]));
  const contributions = d.signals
    .map((s) => {
      const half = d.half_lives[s.kind] ?? HALF_LIFE[s.kind] ?? 14;
      return {
        ...s,
        half,
        points: decayed(
          {
            kind: s.kind,
            weight: s.weight,
            half_life_days: half,
            at: +new Date(s.at),
            person_id: s.person_id,
          },
          now,
        ),
      };
    })
    .sort((x, y) => y.points - x.points);

  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <Panel>
        <CardHead label="Timeline" count={timeline.data?.length} />
        {timeline.error ? (
          <div className="p-4">
            <ErrorNote message={timeline.error} />
          </div>
        ) : !timeline.data ? (
          <Loading />
        ) : !timeline.data.length ? (
          <Empty title="No visits yet" />
        ) : (
          <ol className="divide-y divide-line">
            {timeline.data.map((v) => (
              <li key={v.id} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-mono text-[12px] text-muted">
                    {new Date(v.started_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="font-medium">{v.person_email ?? "Unknown visitor"}</span>
                  {v.person_level ? <Badge tone={LEVEL_TONE[v.person_level] ?? "gray"}>{v.person_level}</Badge> : null}
                  <span className="text-[12px] text-faint">{[v.referrer_host, v.country, activeTime(v.engaged_s)].filter(Boolean).join(" · ")}</span>
                  <span className="ml-auto flex flex-wrap gap-1">
                    {v.signals.map((k, i) => (
                      <Badge key={i} tone="violet">
                        {k.replace(/^page_/, "").replace(/_/g, " ")}
                      </Badge>
                    ))}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[12px] text-body">
                  {v.events.map((e, i) =>
                    e.kind === "view" ? (
                      <span key={i}>{e.path}</span>
                    ) : (
                      <span key={i} className="text-brand">
                        {e.kind === "form" ? `form ${e.data?.form || ""}` : "signed in"}
                      </span>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <div className="flex flex-col gap-5">
        <Panel>
          <CardHead label="People" count={d.people.length} />
          <ul className="divide-y divide-line">
            {d.people.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
                <span className="min-w-0 truncate">{p.email ?? "Person"}</span>
                {p.level ? <Badge tone={LEVEL_TONE[p.level] ?? "gray"}>{p.level}</Badge> : null}
                <span className="ml-auto font-mono text-[11.5px] text-faint">{timeAgo(p.last_seen)}</span>
              </li>
            ))}
            <li className="px-4 py-2.5 text-[12.5px] text-muted">
              Unknown visitors: {d.unknown.devices} devices, {d.unknown.sessions} visits
            </li>
          </ul>
        </Panel>

        <Panel>
          <CardHead label="Company" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[13px]">
            {[
              ["Employees", a.firmo?.employees?.toLocaleString()],
              ["Industry", a.firmo?.industry],
              ["Country", a.firmo?.country],
              ["Founded", a.firmo?.founded],
              ["Type", a.firmo?.type],
            ].map(([k, v]) => (
              <div key={k as string} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd>{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {a.firmo_at ? <p className="border-t border-line px-4 py-2 font-mono text-[11px] text-faint">Coresignal · {timeAgo(a.firmo_at)}</p> : null}
          {d.networks.length ? (
            <ul className="border-t border-line px-4 py-2 font-mono text-[11.5px] text-muted">
              {d.networks.map((n) => (
                <li key={n.net}>{n.net} · by network</li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel>
          <CardHead label="Intent" count={contributions.length} />
          <table className="w-full border-collapse">
            <tbody>
              {contributions.slice(0, 20).map((s, i) => (
                <tr key={i}>
                  <Td className="h-9 text-[12.5px]">
                    {s.kind.replace(/^page_/, "").replace(/_/g, " ")}
                    {s.person_id ? <span className="text-faint"> · {people.get(s.person_id) ?? "person"}</span> : null}
                  </Td>
                  <Td className="h-9 text-right font-mono text-[11.5px] text-muted tabular-nums">
                    {s.weight} × {(s.points / s.weight).toFixed(2)} = {s.points.toFixed(1)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
