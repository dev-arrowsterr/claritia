"use client";

// The filter bar for Contacts, Visitors and Accounts (docs/conversion-parity.md Part 6): a view menu with built-in and
// saved views, each filter as a square tag, and "+ Filter" to add one. Saved views are shared in the workspace.

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanFilters, describe, needsValue, OP_LABEL, OPS, type Filter, type FilterField, type Op } from "@/lib/filters";
import { Check, Plus, X } from "../Icons";
import { askConfirm, askText } from "./Dialogs";
import { Select } from "./Select";
import { Button, errorText, Input, must, Segmented, useLoad } from "./ui";

export type Screen = "contacts" | "visitors" | "accounts";
export type View = { id: string; name: string; filters: Filter[] };
type AnyField = FilterField<never>;

const same = (a: Filter[], b: Filter[]) => JSON.stringify(a) === JSON.stringify(b);

/** Filters for a screen, kept for this viewer between visits. */
export function useFilters(screen: Screen, wsId: string, initial: Filter[] = []) {
  const key = `claritia:filters:${wsId}:${screen}`;
  const [filters, setFilters] = useState<Filter[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Filter[]) : initial;
    } catch {
      return initial;
    }
  });
  const set = (f: Filter[]) => {
    setFilters(f);
    try {
      localStorage.setItem(key, JSON.stringify(f));
    } catch {}
  };
  return [filters, set] as const;
}

/** A small layer under an anchor, above the page, closed by a click away or Escape. */
export function Popover({ anchor, onClose, children, width = 300 }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor?.contains(t)) return;
      // Menus opened from inside (the app's Select) live in their own layer.
      if ((t as HTMLElement).closest?.('[role="listbox"]')) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [anchor, onClose]);
  if (!pos) return null;
  return createPortal(
    <div ref={box} style={{ position: "fixed", left: pos.left, top: pos.top, width }} className="z-[95] border border-line bg-panel text-[13px] shadow-pop">
      {children}
    </div>,
    document.body,
  );
}

/** Pick a field, then its condition and values. */
function FilterEditor({ fields, start, onDone }: { fields: AnyField[]; start: Filter | null; onDone: (f: Filter | null) => void }) {
  const [field, setField] = useState<AnyField | null>(start ? (fields.find((f) => f.key === start.field) ?? null) : null);
  const [op, setOp] = useState<Op>(start?.op ?? "is");
  const [values, setValues] = useState<string[]>(start?.values ?? []);
  const [text, setText] = useState(start && start.values.length && field?.type !== "enum" ? start.values.join(", ") : "");
  const [search, setSearch] = useState("");

  if (!field) {
    const shown = fields.filter((f) => f.label.toLowerCase().includes(search.trim().toLowerCase()));
    return (
      <div className="flex flex-col">
        <div className="border-b border-line p-2">
          <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Field" className="h-8" />
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {shown.map((f) => (
            <li key={f.key}>
              <button
                type="button"
                onClick={() => {
                  setField(f);
                  setOp(OPS[f.type][0]);
                  setValues(f.type === "bool" ? ["true"] : []);
                  setText("");
                }}
                className="flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-hover"
              >
                {f.label}
              </button>
            </li>
          ))}
          {!shown.length ? <li className="px-2 py-2 text-faint">No fields</li> : null}
        </ul>
      </div>
    );
  }

  const typed = field.type === "text" ? text.split(",").map((s) => s.trim()).filter(Boolean) : text.trim() ? [text.trim()] : [];
  const vals = !needsValue(op) ? [] : field.type === "enum" || field.type === "bool" ? values : typed;
  const bad =
    needsValue(op) &&
    (!vals.length || (field.type === "number" && !/^-?\d+(\.\d+)?$/.test(vals[0])) || (field.type === "date" && !/^\d{1,5}$/.test(vals[0])));
  const apply = () => !bad && onDone({ field: field.key, op, values: vals });

  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{field.label}</span>
        {OPS[field.type].length > 1 ? (
          <Select<Op>
            value={op}
            onChange={setOp}
            ariaLabel="Condition"
            options={OPS[field.type].map((o) => ({ value: o, label: OP_LABEL[o] }))}
            className="ml-auto h-8 w-36 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
          />
        ) : null}
      </div>
      {!needsValue(op) ? null : field.type === "bool" ? (
        <Segmented value={values[0] ?? "true"} onChange={(v) => setValues([v])} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} label={field.label} />
      ) : field.type === "enum" ? (
        <ul className="max-h-60 overflow-y-auto">
          {(field.options ?? []).map((o) => {
            const on = values.includes(o.value);
            return (
              <li key={o.value}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setValues(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
                >
                  <span className={`flex size-4 items-center justify-center border ${on ? "border-ink bg-ink text-white" : "border-line-strong"}`}>{on ? <Check size={11} /> : null}</span>
                  {o.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-center gap-2">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} inputMode={field.type === "text" ? undefined : "decimal"} className="h-8" />
          {field.type === "date" ? <span className="text-muted">days</span> : field.unit ? <span className="text-muted">{field.unit}</span> : null}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="plain" className="h-7 px-2.5" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" className="h-7 px-2.5" disabled={bad}>
          Apply
        </Button>
      </div>
    </form>
  );
}

export function FilterBar({
  sb,
  wsId,
  screen,
  fields,
  filters,
  onChange,
  presets = [],
  allLabel,
  right,
}: {
  sb: SupabaseClient;
  wsId: string;
  screen: Screen;
  fields: AnyField[];
  filters: Filter[];
  onChange: (f: Filter[]) => void;
  presets?: { name: string; filters: Filter[] }[];
  allLabel: string;
  right?: React.ReactNode;
}) {
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ index: number | null; anchor: HTMLElement } | null>(null);
  const stored = useLoad(
    async () => must(await sb.from("saved_views").select("id, name, filters").eq("workspace_id", wsId).eq("screen", screen).order("created_at")) as { id: string; name: string; filters: unknown }[],
    `${wsId}:${screen}`,
  );
  const saved: View[] = (stored.data ?? []).map((r) => ({ id: r.id, name: r.name, filters: cleanFilters(r.filters, fields) }));

  const views = [{ value: "all", label: allLabel, filters: [] as Filter[] }, ...presets.map((p, i) => ({ value: `p${i}`, label: p.name, filters: p.filters })), ...saved.map((v) => ({ value: v.id, label: v.name, filters: v.filters }))];
  const active = views.find((v) => same(v.filters, filters));
  const savedActive = active && saved.some((v) => v.id === active.value) ? active : null;

  const saveView = async () => {
    const name = await askText("Save view", { placeholder: "View name", ok: "Save" });
    if (!name) return;
    setError("");
    try {
      must(await sb.from("saved_views").insert({ workspace_id: wsId, screen, name, filters }));
      stored.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const deleteView = async () => {
    if (!savedActive || !(await askConfirm(`Delete the view "${savedActive.label}"?`, { ok: "Delete", danger: true }))) return;
    setError("");
    try {
      must(await sb.from("saved_views").delete().eq("id", savedActive.value));
      stored.reload();
      onChange([]);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-4 py-2 md:px-5">
      <Select
        value={active?.value ?? ""}
        onChange={(v) => onChange(views.find((x) => x.value === v)?.filters ?? [])}
        ariaLabel="View"
        placeholder="Custom view"
        plainPlaceholder
        options={views.map((v) => ({ value: v.value, label: v.label }))}
        className="h-8 w-44 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
      />
      {filters.map((f, i) => (
        <span key={i} className="inline-flex h-8 items-center border border-line bg-panel text-[12.5px]">
          <button type="button" onClick={(e) => setEditing({ index: i, anchor: e.currentTarget })} className="h-full max-w-[320px] truncate px-2.5 hover:bg-hover">
            {describe(f, fields.find((x) => x.key === f.field))}
          </button>
          <button type="button" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))} className="flex h-full items-center border-l border-line px-1.5 text-muted hover:bg-hover hover:text-ink">
            <X size={12} />
          </button>
        </span>
      ))}
      <Button variant="ghost" className="h-8 px-2.5" onClick={(e) => setEditing({ index: null, anchor: e.currentTarget })} disabled={filters.length >= 20}>
        <Plus size={13} />
        Filter
      </Button>
      {filters.length && !active ? (
        <Button variant="plain" className="h-8 px-2.5" onClick={saveView}>
          Save view
        </Button>
      ) : null}
      {savedActive ? (
        <Button variant="plain" className="h-8 px-2.5" onClick={deleteView}>
          Delete view
        </Button>
      ) : null}
      {error || stored.error ? <span className="text-[12.5px] text-danger">{error || stored.error}</span> : null}
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
      {editing ? (
        <Popover anchor={editing.anchor} onClose={() => setEditing(null)}>
          <FilterEditor
            fields={fields}
            start={editing.index === null ? null : filters[editing.index]}
            onDone={(f) => {
              if (f) onChange(editing.index === null ? [...filters, f] : filters.map((x, j) => (j === editing.index ? f : x)));
              setEditing(null);
            }}
          />
        </Popover>
      ) : null}
    </div>
  );
}
