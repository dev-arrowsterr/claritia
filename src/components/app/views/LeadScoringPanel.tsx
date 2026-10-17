"use client";

// Settings › Lead scoring (docs/marketing-platform.md M7): fit plus engagement, the score that makes an MQL, what each
// activity is worth, and who gets the lead. Scores go to two-way CRMs with the owner and the stage.

import { useState } from "react";
import { Plus, Trash } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import {
  Badge,
  Button,
  CardHead,
  ErrorNote,
  errorText,
  Field,
  Input,
  Loading,
  must,
  Panel,
  Td,
  Th,
  useLoad,
  type ViewProps,
} from "../ui";

type Owner = { user_id?: string; crm_owner_id?: string; label: string };
type Rule = {
  name: string;
  countries: string[];
  industries: string[];
  sizes: string[];
  owners: Owner[];
};
type Routing = {
  respect_owner: boolean;
  rules: Rule[];
  default: { owners: Owner[] };
};
type Settings = {
  enabled: boolean;
  threshold: number;
  fit_weight: number;
  half_life_days: number;
  weights: Record<string, number>;
  titles: string[];
  routing: Routing;
};
type Scored = {
  id: string;
  email_clean: string | null;
  score: number | null;
  fit_score: number | null;
  engagement_score: number | null;
  score_band: string | null;
  qualified_at: string | null;
  owner_user_id: string | null;
  owner_crm_id: string | null;
};

const SEL =
  "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const KINDS: { key: string; label: string }[] = [
  { key: "form.submitted", label: "Filled a form" },
  { key: "meeting.booked", label: "Booked a meeting" },
  { key: "email.clicked", label: "Clicked an email" },
  { key: "visit", label: "Visited the site" },
  { key: "visit.pricing", label: "Landed on pricing" },
  { key: "email.unsubscribed", label: "Unsubscribed" },
];
const DEFAULTS: Settings = {
  enabled: false,
  threshold: 70,
  fit_weight: 0.5,
  half_life_days: 30,
  weights: {
    "form.submitted": 25,
    "meeting.booked": 40,
    "email.clicked": 8,
    visit: 3,
    "visit.pricing": 15,
    "email.unsubscribed": -30,
  },
  titles: [],
  routing: { respect_owner: true, rules: [], default: { owners: [] } },
};
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function LeadScoringPanel({
  sb,
  session,
  ws,
  role,
}: Pick<ViewProps, "sb" | "session" | "ws" | "role">) {
  const saved = useLoad(
    async () =>
      (must(
        await sb
          .from("lead_settings")
          .select(
            "enabled, threshold, fit_weight, half_life_days, weights, titles, routing",
          )
          .eq("workspace_id", ws.id)
          .maybeSingle(),
      ) as Settings | null) ?? DEFAULTS,
    `${ws.id}:lead_settings`,
  );
  const team = useLoad(
    async () =>
      (must(await sb.rpc("workspace_people", { p_ws: ws.id })) as {
        id: string;
        email: string;
      }[]) ?? [],
    `${ws.id}:people`,
  );
  const crm = useLoad(async () => {
    const res = await fetch(`/api/sources/owners?workspaceId=${ws.id}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const j = (await res.json().catch(() => ({}))) as {
      crms?: {
        source: string;
        owners: { id: string; label: string }[];
        error?: string;
      }[];
    };
    return j.crms ?? [];
  }, `${ws.id}:crm-owners`);
  if (!saved.data || !team.data) return <Loading />;
  const owners: { value: string; label: string; owner: Owner }[] = [
    ...team.data.map((m) => ({
      value: `u:${m.id}`,
      label: m.email,
      owner: { user_id: m.id, label: m.email },
    })),
    ...(crm.data ?? []).flatMap((c) =>
      c.owners.map((o) => ({
        value: `c:${o.id}`,
        label: `${o.label} · ${c.source}`,
        owner: { crm_owner_id: o.id, label: `${o.label} · ${c.source}` },
      })),
    ),
  ];
  return (
    <div className="flex flex-col gap-5">
      {(crm.data ?? [])
        .filter((c) => c.error)
        .map((c) => (
          <ErrorNote key={c.source} message={c.error!} />
        ))}
      <Form
        key={JSON.stringify(saved.data)}
        sb={sb}
        ws={ws}
        owner={role === "owner"}
        saved={{ ...DEFAULTS, ...saved.data }}
        owners={owners}
        onSaved={saved.reload}
      />
      <Top sb={sb} ws={ws} team={team.data} />
    </div>
  );
}

function Form({
  sb,
  ws,
  owner,
  saved,
  owners,
  onSaved,
}: Pick<ViewProps, "sb" | "ws"> & {
  owner: boolean;
  saved: Settings;
  owners: { value: string; label: string; owner: Owner }[];
  onSaved: () => void;
}) {
  const [v, setV] = useState<Settings>(saved);
  const [titles, setTitles] = useState(saved.titles.join(", "));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const setRule = (i: number, patch: Partial<Rule>) =>
    setV({
      ...v,
      routing: {
        ...v.routing,
        rules: v.routing.rules.map((r, j) =>
          j === i ? { ...r, ...patch } : r,
        ),
      },
    });
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    setResult("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const save = () =>
    run(
      "save",
      async () => (
        must(
          await sb.rpc("lead_settings_save", {
            p_ws: ws.id,
            p_values: { ...v, titles: list(titles) },
          }),
        ),
        onSaved()
      ),
    );
  const rescore = () =>
    run("rescore", async () => {
      if (
        !(await askConfirm("Rescore every contact now?", {
          body: "Contacts that cross the threshold get an owner.",
          ok: "Rescore",
        }))
      )
        return;
      const r = must(await sb.rpc("lead_rescore_now", { p_ws: ws.id })) as {
        scored: number;
        routed: number;
      };
      setResult(
        `${r.scored.toLocaleString()} scored · ${r.routed.toLocaleString()} routed`,
      );
    });

  return (
    <>
      <Panel>
        <CardHead label="Lead scoring">
          <span className="ml-auto">
            {v.enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
          </span>
        </CardHead>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Scoring">
            <Select
              className={SEL}
              value={v.enabled ? "on" : "off"}
              onChange={(x) => setV({ ...v, enabled: x === "on" })}
              disabled={!owner}
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ]}
            />
          </Field>
          <Field label="MQL at score">
            <Input
              type="number"
              min={1}
              max={100}
              value={v.threshold}
              onChange={(e) =>
                setV({ ...v, threshold: Number(e.target.value) || 70 })
              }
              disabled={!owner}
            />
          </Field>
          <Field label="Fit vs engagement">
            <Select
              className={SEL}
              value={String(v.fit_weight)}
              onChange={(x) => setV({ ...v, fit_weight: Number(x) })}
              disabled={!owner}
              options={[
                { value: "0.3", label: "30% fit · 70% engagement" },
                { value: "0.5", label: "50% fit · 50% engagement" },
                { value: "0.7", label: "70% fit · 30% engagement" },
              ]}
            />
          </Field>
          <Field label="Activity halves in value every (days)">
            <Input
              type="number"
              min={1}
              max={365}
              value={v.half_life_days}
              onChange={(e) =>
                setV({ ...v, half_life_days: Number(e.target.value) || 30 })
              }
              disabled={!owner}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Titles that fit (comma-separated)">
              <Input
                value={titles}
                onChange={(e) => setTitles(e.target.value)}
                placeholder="marketing, growth, demand gen, CMO"
                disabled={!owner}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel>
        <CardHead label="Points per activity" />
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {KINDS.map((k) => (
            <Field key={k.key} label={k.label}>
              <Input
                type="number"
                min={-100}
                max={100}
                value={v.weights[k.key] ?? 0}
                onChange={(e) =>
                  setV({
                    ...v,
                    weights: {
                      ...v.weights,
                      [k.key]: Number(e.target.value) || 0,
                    },
                  })
                }
                disabled={!owner}
              />
            </Field>
          ))}
        </div>
      </Panel>

      <Panel>
        <CardHead label="Who gets the lead">
          {owner ? (
            <Button
              variant="plain"
              className="ml-auto h-7 px-2"
              onClick={() =>
                setV({
                  ...v,
                  routing: {
                    ...v.routing,
                    rules: [
                      ...v.routing.rules,
                      {
                        name: `Rule ${v.routing.rules.length + 1}`,
                        countries: [],
                        industries: [],
                        sizes: [],
                        owners: [],
                      },
                    ],
                  },
                })
              }
            >
              <Plus size={14} /> Rule
            </Button>
          ) : null}
        </CardHead>
        <div className="flex flex-col divide-y divide-line">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="Contacts with an owner">
              <Select
                className={SEL}
                value={v.routing.respect_owner ? "keep" : "replace"}
                onChange={(x) =>
                  setV({
                    ...v,
                    routing: { ...v.routing, respect_owner: x === "keep" },
                  })
                }
                disabled={!owner}
                options={[
                  { value: "keep", label: "Keep their owner" },
                  { value: "replace", label: "Route them anyway" },
                ]}
              />
            </Field>
          </div>
          {v.routing.rules.map((r, i) => (
            <div key={i} className="grid gap-3 p-4 sm:grid-cols-2">
              <Field label="Rule">
                <Input
                  value={r.name}
                  onChange={(e) => setRule(i, { name: e.target.value })}
                  disabled={!owner}
                />
              </Field>
              <Field label="Countries (codes)">
                <Input
                  value={r.countries.join(", ")}
                  onChange={(e) =>
                    setRule(i, {
                      countries: list(e.target.value).map((c) =>
                        c.toUpperCase(),
                      ),
                    })
                  }
                  placeholder="US, CA"
                  disabled={!owner}
                />
              </Field>
              <Field label="Industries">
                <Input
                  value={r.industries.join(", ")}
                  onChange={(e) =>
                    setRule(i, { industries: list(e.target.value) })
                  }
                  placeholder="Software, Fintech"
                  disabled={!owner}
                />
              </Field>
              <Field label="Company sizes">
                <Input
                  value={r.sizes.join(", ")}
                  onChange={(e) => setRule(i, { sizes: list(e.target.value) })}
                  placeholder="51-200, 201-500"
                  disabled={!owner}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Owners (take turns)">
                  <div className="flex items-center gap-2">
                    <OwnerPicker
                      value={r.owners}
                      onChange={(o) => setRule(i, { owners: o })}
                      owners={owners}
                      owner={owner}
                    />
                    {owner ? (
                      <Button
                        variant="plain"
                        className="ml-auto h-7 px-2"
                        aria-label="Remove rule"
                        title="Remove rule"
                        onClick={() =>
                          setV({
                            ...v,
                            routing: {
                              ...v.routing,
                              rules: v.routing.rules.filter((_, j) => j !== i),
                            },
                          })
                        }
                      >
                        <Trash size={14} />
                      </Button>
                    ) : null}
                  </div>
                </Field>
              </div>
            </div>
          ))}
          <div className="p-4">
            <Field label="Everyone else">
              <OwnerPicker
                value={v.routing.default.owners}
                onChange={(o) =>
                  setV({
                    ...v,
                    routing: { ...v.routing, default: { owners: o } },
                  })
                }
                owners={owners}
                owner={owner}
              />
            </Field>
          </div>
        </div>
        {owner ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
            <Button onClick={save} disabled={!!busy}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={rescore}
              disabled={!!busy || !saved.enabled}
            >
              {busy === "rescore" ? "Scoring…" : "Rescore now"}
            </Button>
            {result ? (
              <span className="text-[12px] text-muted">{result}</span>
            ) : null}
            <ErrorNote message={error} />
          </div>
        ) : null}
      </Panel>
    </>
  );
}

function OwnerPicker({
  value,
  onChange,
  owners,
  owner,
}: {
  value: Owner[];
  onChange: (o: Owner[]) => void;
  owners: { value: string; label: string; owner: Owner }[];
  owner: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((o, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 border border-line px-1.5 py-0.5 text-[12px]"
        >
          {o.label}
          {owner ? (
            <button
              type="button"
              aria-label={`Remove ${o.label}`}
              className="text-faint hover:text-ink"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {owner ? (
        <Select
          className="h-7 w-56 rounded-md border border-line bg-panel px-2 text-[12px]"
          value=""
          placeholder="Add owner"
          options={owners
            .filter(
              (o) =>
                !value.some(
                  (x) =>
                    (x.user_id && `u:${x.user_id}` === o.value) ||
                    (x.crm_owner_id && `c:${x.crm_owner_id}` === o.value),
                ),
            )
            .map((o) => ({ value: o.value, label: o.label }))}
          onChange={(val) => {
            const o = owners.find((x) => x.value === val);
            if (o) onChange([...value, o.owner]);
          }}
        />
      ) : null}
    </div>
  );
}

function Top({
  sb,
  ws,
  team,
}: Pick<ViewProps, "sb" | "ws"> & { team: { id: string; email: string }[] }) {
  const rows = useLoad(
    async () =>
      must(
        await sb
          .from("contacts")
          .select(
            "id, email_clean, score, fit_score, engagement_score, score_band, qualified_at, owner_user_id, owner_crm_id",
          )
          .eq("workspace_id", ws.id)
          .not("score", "is", null)
          .order("score", { ascending: false })
          .limit(20),
      ) as Scored[],
    `${ws.id}:top-leads`,
  );
  if (!rows.data?.length) return null;
  const who = (r: Scored) =>
    team.find((m) => m.id === r.owner_user_id)?.email ??
    (r.owner_crm_id ? `CRM ${r.owner_crm_id}` : "—");
  return (
    <Panel>
      <CardHead label="Top scores" count={rows.data.length} />
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th className="w-16">Fit</Th>
              <Th className="w-24">Engagement</Th>
              <Th className="w-16">Score</Th>
              <Th>Owner</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.data.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-[12px]">
                  {r.email_clean ?? "—"}{" "}
                  {r.qualified_at ? <Badge tone="green">MQL</Badge> : null}
                </Td>
                <Td className="tabular-nums">{r.fit_score ?? "—"}</Td>
                <Td className="tabular-nums">{r.engagement_score ?? "—"}</Td>
                <Td>
                  <Badge
                    tone={
                      r.score_band === "hot"
                        ? "red"
                        : r.score_band === "warm"
                          ? "amber"
                          : "gray"
                    }
                  >
                    {r.score ?? "—"}
                  </Badge>
                </Td>
                <Td className="max-w-[220px] truncate text-muted">{who(r)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
