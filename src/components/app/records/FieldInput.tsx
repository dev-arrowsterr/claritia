"use client";

// One field's value: how it shows, and how it's edited, for every field type (src/lib/records/fields.ts).
// Used by table cells, the board, the record page and the add form.

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { shown, type AnyField } from "@/lib/records/fields";
import { Check, X } from "../../Icons";
import { Popover } from "../FilterBar";
import { Select } from "../Select";
import { Badge, Input, must, timeAgo, type Tone } from "../ui";

export type Link = { id: string; name: string; object?: string };

const TONE: Record<string, Tone> = { won: "green", lost: "red" };

/** A value as it reads in a cell or on the record page. */
export function FieldValue({ field, value, links }: { field: AnyField; value: unknown; links?: Link[] }) {
  if (field.kind === "relation") {
    const list = links ?? [];
    if (!list.length) return <span className="text-faint">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {list.map((l) => (
          <span key={l.id} className="inline-flex h-5 max-w-[180px] items-center truncate border border-line bg-canvas px-1.5 text-[12px]">
            {l.name}
          </span>
        ))}
      </span>
    );
  }
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-faint">—</span>;
  if (field.kind === "select") {
    const o = field.options.find((x) => x.value === String(value));
    return <Badge tone={(o?.kind && TONE[o.kind]) || (o?.color as Tone) || "gray"}>{o?.label ?? String(value)}</Badge>;
  }
  if (field.kind === "multi_select" && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((v) => (
          <Badge key={String(v)}>{field.options.find((o) => o.value === v)?.label ?? String(v)}</Badge>
        ))}
      </span>
    );
  }
  if (field.kind === "checkbox") return <span>{value ? "Yes" : "No"}</span>;
  if (field.key === "created_at" || field.key === "updated_at") return <span className="font-mono text-[12px] text-muted">{timeAgo(String(value))}</span>;
  if (field.kind === "url")
    return (
      <a href={String(value)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="truncate text-brand hover:underline">
        {String(value).replace(/^https?:\/\//, "")}
      </a>
    );
  if (field.kind === "email")
    return (
      <a href={`mailto:${String(value)}`} onClick={(e) => e.stopPropagation()} className="truncate hover:underline">
        {String(value)}
      </a>
    );
  const text = shown(field, value);
  return <span className={["number", "currency", "percent"].includes(field.kind) ? "font-mono text-[12.5px] tabular-nums" : ""}>{text}</span>;
}

/** Find records to link, for relation fields. */
export function RecordPicker({
  sb,
  wsId,
  object,
  picked,
  multiple,
  onChange,
}: {
  sb: SupabaseClient;
  wsId: string;
  object: string;
  picked: Link[];
  multiple: boolean;
  onChange: (links: Link[]) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Link[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = must(await sb.rpc("records_search", { p_ws: wsId, p_object: object, p_q: q, p_limit: 10 })) as Link[];
        if (live) setHits(r);
      } catch {
        if (live) setHits([]);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sb, wsId, object, q]);
  const has = (id: string) => picked.some((p) => p.id === id);
  return (
    <div className="flex flex-col">
      {picked.length ? (
        <div className="flex flex-wrap gap-1 border-b border-line p-2">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex h-6 items-center gap-1 border border-line bg-canvas pl-1.5 text-[12px]">
              {p.name}
              <button type="button" aria-label="Remove" onClick={() => onChange(picked.filter((x) => x.id !== p.id))} className="px-1 text-muted hover:text-ink">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="p-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8" />
      </div>
      <ul className="max-h-60 overflow-y-auto p-1 pt-0">
        {hits.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onChange(has(h.id) ? picked.filter((p) => p.id !== h.id) : multiple ? [...picked, h] : [h])}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
            >
              <span className="flex-1 truncate">{h.name}</span>
              {has(h.id) ? <Check size={13} className="text-brand" /> : null}
            </button>
          </li>
        ))}
        {!hits.length ? <li className="px-2 py-2 text-faint">No matches</li> : null}
      </ul>
    </div>
  );
}

/** Ticks for pick-many fields. */
function MultiPicker({ field, value, onChange }: { field: AnyField; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <ul className="max-h-64 overflow-y-auto p-1">
      {field.options.map((o) => {
        const on = value.includes(o.value);
        return (
          <li key={o.value}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
            >
              <span className={`flex size-4 items-center justify-center border ${on ? "border-ink bg-ink text-white" : "border-line-strong"}`}>{on ? <Check size={11} /> : null}</span>
              {o.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Edit one value in place. Text-like fields save on Enter or when focus leaves; pick lists, yes/no and dates save
 * on change; links and pick-many save when their layer closes. Escape cancels.
 */
export function FieldEditor({
  sb,
  wsId,
  field,
  value,
  links,
  onSave,
  onCancel,
  compact = false,
}: {
  sb: SupabaseClient;
  wsId: string;
  field: AnyField;
  value: unknown;
  links?: Link[];
  onSave: (v: unknown) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(() => (value == null ? "" : field.kind === "datetime" ? String(value).slice(0, 16) : Array.isArray(value) ? "" : String(value)));
  const [multi, setMulti] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  const [picked, setPicked] = useState<Link[]>(links ?? []);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setAnchor(box.current), []);
  const h = compact ? "h-8" : "h-9";
  const selectClass = `${h} w-full rounded-md border border-ink bg-panel px-2.5 text-[13px]`;

  if (field.kind === "select" || field.kind === "user") {
    return (
      <Select<string>
        value={value == null ? "" : String(value)}
        onChange={(v) => onSave(v || null)}
        onClose={onCancel}
        autoOpen
        ariaLabel={field.label}
        options={[{ value: "", label: "None" }, ...field.options.map((o) => ({ value: o.value, label: o.label }))]}
        className={selectClass}
      />
    );
  }
  if (field.kind === "checkbox") {
    return (
      <Select<string>
        value={value == null ? "" : value ? "true" : "false"}
        onChange={(v) => onSave(v === "" ? null : v === "true")}
        onClose={onCancel}
        autoOpen
        ariaLabel={field.label}
        options={[
          { value: "", label: "None" },
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]}
        className={selectClass}
      />
    );
  }
  if (field.kind === "multi_select" || field.kind === "relation") {
    return (
      <span ref={box} className={`flex ${h} w-full items-center rounded-md border border-ink bg-panel px-2.5 text-[13px]`}>
        <FieldValue field={field} value={multi} links={picked} />
        {anchor ? (
          <Popover anchor={anchor} onClose={() => onSave(field.kind === "relation" ? picked.map((p) => p.id) : multi)} width={280}>
            {field.kind === "relation" ? (
              <RecordPicker sb={sb} wsId={wsId} object={field.config.target ?? "contact"} picked={picked} multiple={!!field.config.multiple} onChange={setPicked} />
            ) : (
              <MultiPicker field={field} value={multi} onChange={setMulti} />
            )}
          </Popover>
        ) : null}
      </span>
    );
  }
  const type = field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : "text";
  const commit = () => {
    const t = text.trim();
    if (t === (value == null ? "" : String(value))) return onCancel();
    if (field.kind === "datetime") return onSave(t ? new Date(t).toISOString() : null);
    onSave(t || null);
  };
  if (field.kind === "long_text" && !compact) {
    return (
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
        }}
        rows={4}
        className="w-full rounded-md border border-ink bg-panel px-2.5 py-2 text-[13px] outline-none"
      />
    );
  }
  return (
    <Input
      autoFocus
      type={type}
      value={text}
      inputMode={["number", "currency", "percent"].includes(field.kind) ? "decimal" : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
      className={`${h} border-ink`}
    />
  );
}
