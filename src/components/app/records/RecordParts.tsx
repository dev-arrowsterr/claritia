"use client";

// Pieces of every record page: the details panel (fields in their sections, edited in place, each with where its
// value came from) and the change history.

import type { SupabaseClient } from "@supabase/supabase-js";
import { useState } from "react";
import { shown, valueOf, type AnyField } from "@/lib/records/fields";
import { CardHead, ErrorNote, errorText, Panel, timeAgo } from "../ui";
import { FieldEditor, FieldValue, type Link } from "./FieldInput";
import type { Meta } from "./meta";

const SOURCE_LABEL: Record<string, string> = {
  manual: "App",
  import: "Import",
  csv: "CSV",
  excel: "Excel",
  sheets: "Google Sheets",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  omniscient: "Omniscient",
  form: "Form",
  api: "API",
  ai: "AI",
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The sections to show: the workspace's layout, then custom groups, then everything else under Details. */
export function sectionsFor(fields: AnyField[], layout: Meta["layout"], skip: string[] = []): { name: string; fields: AnyField[] }[] {
  const visible = fields.filter((f) => !f.hidden && !skip.includes(f.key));
  const byKey = new Map(visible.map((f) => [f.key, f]));
  const used = new Set<string>();
  const out: { name: string; fields: AnyField[] }[] = [];
  for (const s of layout) {
    const list = s.keys.map((k) => byKey.get(k)).filter((f): f is AnyField => !!f && !used.has(f.key));
    list.forEach((f) => used.add(f.key));
    if (list.length) out.push({ name: s.name, fields: list });
  }
  const groups = new Map<string, AnyField[]>();
  for (const f of visible) {
    if (used.has(f.key)) continue;
    const g = f.group || "Details";
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const details = groups.get("Details");
  groups.delete("Details");
  if (details) out.push({ name: "Details", fields: details });
  for (const [name, list] of groups) out.push({ name, fields: list });
  return out;
}

export function FieldsPanel({
  sb,
  wsId,
  record,
  fields,
  layout,
  writes,
  links,
  skip = [],
  onSave,
  onCustomize,
}: {
  sb: SupabaseClient;
  wsId: string;
  record: Record<string, unknown>;
  fields: AnyField[];
  layout: Meta["layout"];
  writes: Record<string, { source: string; at: string }>;
  links: Record<string, Link[]>;
  skip?: string[];
  onSave: (f: AnyField, v: unknown) => Promise<void>;
  onCustomize?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const sections = sectionsFor(fields, layout, skip);
  return (
    <>
      {sections.map((s, i) => (
        <Panel key={s.name}>
          <CardHead label={s.name}>
            {i === 0 && onCustomize ? (
              <button type="button" onClick={onCustomize} className="text-[12px] text-muted hover:text-ink">
                Customize
              </button>
            ) : null}
          </CardHead>
          {i === 0 && error ? (
            <div className="p-3">
              <ErrorNote message={error} />
            </div>
          ) : null}
          <dl className="divide-y divide-line">
            {s.fields.map((f) => {
              const v = valueOf(record, f.key);
              const w = writes[f.key];
              const l = links[f.key.slice(2)];
              const empty = f.kind === "relation" ? !l?.length : v == null || v === "" || (Array.isArray(v) && !v.length);
              return (
                <div key={f.key} className="grid grid-cols-[120px_1fr] items-start gap-3 px-4 py-2 text-[13px]">
                  <dt className="pt-1.5 text-muted">
                    {f.label}
                    {f.required ? <span className="text-danger"> *</span> : null}
                  </dt>
                  <dd className="min-w-0">
                    {editing === f.key ? (
                      <FieldEditor
                        sb={sb}
                        wsId={wsId}
                        field={f}
                        value={v}
                        links={l}
                        onCancel={() => setEditing(null)}
                        onSave={async (nv) => {
                          setEditing(null);
                          setError("");
                          try {
                            await onSave(f, nv);
                          } catch (e) {
                            setError(errorText(e));
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        disabled={!f.edit}
                        onClick={() => setEditing(f.key)}
                        className={`block min-h-8 w-full rounded-md px-1.5 py-1.5 text-left ${f.edit ? "hover:bg-hover" : "cursor-default"}`}
                      >
                        <span className="block truncate">
                          <FieldValue field={f} value={v} links={l} />
                        </span>
                        {w && !empty ? <span className="mt-0.5 block font-mono text-[10.5px] text-faint">{`${sourceLabel(w.source)} · ${timeAgo(w.at)}`}</span> : null}
                      </button>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Panel>
      ))}
    </>
  );
}

export type Change = { key: string; old: unknown; new: unknown; source: string; by: string | null; at: string };

export function HistoryPanel({ history, fields, people }: { history: Change[]; fields: AnyField[]; people: { id: string; email: string }[] }) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const who = (c: Change) => (c.by ? (people.find((p) => p.id === c.by)?.email ?? "Someone") : sourceLabel(c.source));
  return (
    <Panel>
      <CardHead label="Changes" count={history.length} />
      {!history.length ? (
        <p className="px-4 py-3 text-[13px] text-faint">—</p>
      ) : (
        <ol className="max-h-[420px] divide-y divide-line overflow-auto">
          {history.map((c, i) => {
            const f = byKey.get(c.key);
            const text = (v: unknown) => (v == null || v === "" ? "—" : f ? shown(f, v) || String(v) : typeof v === "object" ? JSON.stringify(v) : String(v));
            return (
              <li key={i} className="px-4 py-2.5 text-[12.5px]">
                <p>
                  <span className="font-medium">{f?.label ?? (c.key === "merged" ? "Merged" : c.key)}</span>
                  <span className="text-muted"> {text(c.old)} → </span>
                  <span>{text(c.new)}</span>
                </p>
                <p className="font-mono text-[10.5px] text-faint">
                  {who(c)} · {timeAgo(c.at)}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
