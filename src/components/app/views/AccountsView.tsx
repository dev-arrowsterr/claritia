"use client";

// Accounts and the account page (docs/m1-website-intelligence.md 8.5, 8.6).

import { useState } from "react";
import { applyFilters, cleanFilters, type Filter, type FilterField } from "@/lib/filters";
import { decayed } from "@/lib/web/scores";
import { Users } from "../../Icons";
import { Badge, Button, CardHead, Empty, ErrorNote, errorText, Loading, must, Page, Panel, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";
import { FilterBar, useFilters } from "../FilterBar";
import { activeTime, LEVEL_TONE } from "./VisitorsView";

type Row = {
  id: string;
  name: string | null;
  domain: string;
  fit: number | null;
  intent: number | null;
  priority: number | null;
  stage: string | null;
  temperature: string | null;
  why_now: string | null;
  last_signal_at: string | null;
  first_seen: string;
  industry: string | null;
  size: string | null;
  country: string | null;
  people: number;
  sessions_7d: number;
  feedback: string | null;
};

const opts = (...xs: string[]) => xs.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }));

const ACCOUNT_FIELDS: FilterField<Row>[] = [
  { key: "name", label: "Name", type: "text", get: (a) => a.name ?? a.domain },
  { key: "domain", label: "Domain", type: "text", get: (a) => a.domain },
  { key: "fit", label: "Fit", type: "number", get: (a) => a.fit },
  { key: "intent", label: "Intent", type: "number", get: (a) => a.intent },
  { key: "priority", label: "Priority", type: "number", get: (a) => a.priority },
  { key: "stage", label: "Stage", type: "enum", options: opts("evaluating", "researching", "engaged", "unknown"), get: (a) => a.stage },
  { key: "temperature", label: "Temperature", type: "enum", options: opts("hot", "warming", "steady", "cooling", "cold"), get: (a) => a.temperature },
  { key: "industry", label: "Industry", type: "text", get: (a) => a.industry },
  { key: "size", label: "Size", type: "text", get: (a) => a.size },
  { key: "country", label: "Country", type: "text", get: (a) => a.country },
  { key: "people", label: "People", type: "number", get: (a) => a.people },
  { key: "sessions_7d", label: "Visits 7d", type: "number", get: (a) => a.sessions_7d },
  { key: "last_active", label: "Last activity", type: "date", get: (a) => a.last_signal_at ?? a.first_seen },
  { key: "first_seen", label: "First seen", type: "date", get: (a) => a.first_seen },
];

// The old tabs, as built-in views.
const ACCOUNT_PRESETS: { name: string; filters: Filter[] }[] = [
  { name: "Hot this week", filters: [{ field: "temperature", op: "is", values: ["hot"] }] },
  { name: "Evaluating", filters: [{ field: "stage", op: "is", values: ["evaluating"] }] },
  { name: "New this week", filters: [{ field: "first_seen", op: "within", values: ["7"] }] },
  {
    name: "High fit, quiet",
    filters: [
      { field: "fit", op: "gte", values: ["70"] },
      { field: "last_active", op: "before", values: ["30"] },
    ],
  },
];

export const STAGE_TONE: Record<string, Tone> = { evaluating: "brand", researching: "violet", engaged: "gray", unknown: "gray" };
export const TEMP_TONE: Record<string, Tone> = { hot: "red", steady: "gray", cooling: "amber", cold: "gray" };

function Meter({ value }: { value: number | null }) {
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-1.5 w-14 bg-hover">
        <span className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${value ?? 0}%` }} />
      </span>
      <span className="font-mono text-[12px] tabular-nums">{value ?? "—"}</span>
    </span>
  );
}

export function AccountsView(props: ViewProps) {
  if (props.id) return <AccountPage {...props} />;
  return <AccountsList {...props} />;
}

function AccountsList({ sb, ws, navigate }: ViewProps) {
  const [stored, setFilters] = useFilters("accounts", ws.id);
  const filters = cleanFilters(stored, ACCOUNT_FIELDS as FilterField<never>[]);
  const list = useLoad(async () => must(await sb.rpc("accounts_list", { p_ws: ws.id, p_view: "all", p_limit: 1000 })) as Row[], ws.id);
  const rows = applyFilters(list.data ?? [], filters, ACCOUNT_FIELDS);
  return (
    <Page icon={<Users size={14} />} title="Accounts" count={list.data ? rows.length : undefined} flush>
      <FilterBar sb={sb} wsId={ws.id} screen="accounts" fields={ACCOUNT_FIELDS as FilterField<never>[]} filters={filters} onChange={setFilters} presets={ACCOUNT_PRESETS} allLabel="All accounts" />
      {list.error ? (
        <div className="p-4">
          <ErrorNote message={list.error} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : !rows.length ? (
        <Empty icon={<Users size={16} />} title={list.data.length ? "No accounts match" : "No accounts here yet"} />
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Fit</Th>
              <Th>Intent</Th>
              <Th>Stage</Th>
              <Th className="text-right">Priority</Th>
              <Th className="text-right">People</Th>
              <Th className="text-right">Visits 7d</Th>
              <Th>Why now</Th>
              <Th>Last signal</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} onClick={() => navigate("accounts", a.id)} className="cursor-pointer hover:bg-hover">
                <Td>
                  <span className="flex flex-col">
                    <span className="font-medium">{a.name ?? a.domain}</span>
                    <span className="text-[12px] text-faint">{[a.domain, a.industry, a.size, a.country].filter(Boolean).join(" · ")}</span>
                  </span>
                </Td>
                <Td>
                  <Meter value={a.fit} />
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <Meter value={a.intent} />
                    {a.temperature && a.temperature !== "steady" ? <Badge tone={TEMP_TONE[a.temperature]}>{a.temperature}</Badge> : null}
                  </span>
                </Td>
                <Td>{a.stage ? <Badge tone={STAGE_TONE[a.stage]}>{a.stage}</Badge> : <span className="text-faint">—</span>}</Td>
                <Td className="text-right font-mono text-[12px] tabular-nums">{a.priority ?? "—"}</Td>
                <Td className="text-right font-mono text-[12px] tabular-nums">{a.people}</Td>
                <Td className="text-right font-mono text-[12px] tabular-nums">{a.sessions_7d}</Td>
                <Td className="max-w-[320px] truncate text-[12.5px] text-body">{a.why_now ?? ""}</Td>
                <Td className="font-mono text-[12px] text-muted">{timeAgo(a.last_signal_at)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

type Signal = { kind: string; weight: number; at: string; person_id: string | null; evidence: { session_id?: string; path?: string } };
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
    firmo: { employees?: number; size?: string; industry?: string; country?: string; founded?: number; type?: string } | null;
    firmo_at: string | null;
    first_seen: string;
  };
  people: { id: string; email: string | null; level: string | null; last_seen: string; sessions: number }[];
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
  events: { kind: string; path: string | null; at: string; data: { form?: string } | null }[];
  signals: string[];
};

const HALF_LIFE: Record<string, number> = {
  page_pricing: 7, page_demo: 7, page_compare: 10, page_security: 14, page_integrations: 14, docs_depth: 14, case_study: 14, return_visit: 7,
  multi_person: 7, review_site_ref: 10, ai_assistant_ref: 10, engaged_session: 7, form_submit: 14, demo_request: 21, new_person: 14,
};

function AccountPage({ sb, id, navigate }: ViewProps) {
  // Decay is worked out at load time, so the page doesn't shift while it's open.
  const detail = useLoad(async () => ({ ...(must(await sb.rpc("account_detail", { p_id: id })) as Detail), loadedAt: Date.now() }), id);
  const timeline = useLoad(async () => must(await sb.rpc("account_timeline", { p_id: id, p_limit: 60 })) as Visit[], id);
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const back = { label: "Accounts", onClick: () => navigate("accounts") };

  if (detail.error) {
    return (
      <Page icon={<Users size={14} />} title="Account" back={back}>
        <ErrorNote message={detail.error} />
      </Page>
    );
  }
  if (!detail.data) {
    return (
      <Page icon={<Users size={14} />} title="Account" back={back}>
        <Loading />
      </Page>
    );
  }
  const d = detail.data;
  const a = d.account;
  const now = d.loadedAt;
  const people = new Map(d.people.map((p) => [p.id, p.email]));
  const contributions = d.signals
    .map((s) => {
      const half = d.half_lives[s.kind] ?? HALF_LIFE[s.kind] ?? 14;
      return { ...s, half, points: decayed({ kind: s.kind, weight: s.weight, half_life_days: half, at: +new Date(s.at), person_id: s.person_id }, now) };
    })
    .sort((x, y) => y.points - x.points);

  const feedback = async (kind: string) => {
    setError("");
    try {
      must(await sb.rpc("account_feedback_add", { p_account: id, p_kind: kind }));
      setSent(kind);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Page
      icon={<Users size={14} />}
      title={a.name ?? a.domain}
      back={back}
      actions={
        <>
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
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <ErrorNote message={error} />
        <Panel>
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4 p-5">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[20px] font-medium tracking-[-0.02em]">{a.name ?? a.domain}</span>
              <span className="text-[13px] text-muted">{[a.domain, a.firmo?.industry, a.firmo?.size, a.firmo?.country].filter(Boolean).join(" · ")}</span>
              <span className="mt-1 flex flex-wrap gap-1.5">
                {a.stage ? <Badge tone={STAGE_TONE[a.stage]}>{a.stage}</Badge> : null}
                {a.temperature ? <Badge tone={TEMP_TONE[a.temperature]}>{a.temperature}</Badge> : null}
                {a.flags.map((f) => (
                  <Badge key={f}>{f.replace(/_/g, " ")}</Badge>
                ))}
              </span>
            </div>
            {[
              ["Fit", a.fit],
              ["Intent", a.intent],
              ["Priority", a.priority],
            ].map(([label, v]) => (
              <div key={label as string} className="flex flex-col gap-1">
                <span className="label-mono">{label}</span>
                <span className="font-mono text-[24px] tabular-nums">{v ?? "—"}</span>
              </div>
            ))}
          </div>
          {a.why_now ? <p className="border-t border-line px-5 py-3 text-[14px]">{a.why_now}</p> : null}
        </Panel>

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
                      <span className="font-mono text-[12px] text-muted">{new Date(v.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
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
                    <li key={n.net}>
                      {n.net} · by network
                    </li>
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
      </div>
    </Page>
  );
}
