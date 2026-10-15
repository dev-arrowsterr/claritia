"use client";

// One list screen for every record type (Contacts, Leads, Companies, custom objects): view tabs with built-in and
// saved views (shared or just for you), search, filters, table or board, group by, columns, and bulk actions.
// A view remembers its filters, columns (order and width), sort, layout and grouping.

import { useState } from "react";
import { toCsv } from "@/lib/contacts/csv";
import { cleanFilters, describe, type Filter, type FilterField } from "@/lib/filters";
import { filterFields, shown as shownText, valueOf, type AnyField } from "@/lib/records/fields";
import { Check, Download, Plus, Trash, X } from "../../Icons";
import { askConfirm, askText, tell } from "../Dialogs";
import { FilterEditor, Popover } from "../FilterBar";
import { Select } from "../Select";
import { Button, Empty, ErrorNote, errorText, Input, Loading, must, Page, Segmented, Tabs, useLoad, type ViewProps } from "../ui";
import { FieldEditor } from "./FieldInput";
import { useMeta, type Meta } from "./meta";
import { DEFAULT_WIDTH, RecordBoard, RecordTable, type Column, type Row } from "./RecordTable";

export type ViewState = { filters: Filter[]; columns: Column[]; sort: { key: string; desc: boolean }; layout: "table" | "board"; group: string | null };
export type Preset = { name: string } & Partial<ViewState>;
type Saved = ViewState & { id: string; name: string; owner_id: string | null };

const PAGE = 100;
const MAX_EXPORT = 50_000;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const sameView = (a: ViewState, b: ViewState) =>
  JSON.stringify([a.filters, a.columns, a.sort, a.layout, a.group]) === JSON.stringify([b.filters, b.columns, b.sort, b.layout, b.group]);

function useStoredView(key: string, initial: ViewState) {
  const [v, setV] = useState<ViewState>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...(JSON.parse(raw) as Partial<ViewState>) } : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: ViewState) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  };
  return [v, set] as const;
}

export function RecordsList({
  sb,
  session,
  ws,
  object,
  screen,
  title,
  icon,
  presets = [],
  base,
  actions,
  onAdd,
  onOpen,
  nameExtra,
  intro,
  bulkExtra,
}: Pick<ViewProps, "sb" | "session" | "ws"> & {
  object: string;
  screen: string;
  title: string;
  icon: React.ReactNode;
  presets?: Preset[];
  /** The screen's starting view: columns, sort, layout. */
  base: ViewState;
  actions?: React.ReactNode;
  onAdd?: () => void;
  onOpen: (r: Row) => void;
  nameExtra?: (r: Row) => React.ReactNode;
  /** Shown instead of an empty table when there's nothing at all yet. */
  intro?: React.ReactNode;
  bulkExtra?: (ids: () => Promise<string[]>, done: () => void, meta: Meta) => React.ReactNode;
}) {
  const meta = useMeta(sb, ws.id, object);
  const [view, setView] = useStoredView(`claritia:view:${ws.id}:${screen}`, base);
  const [activeId, setActiveId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [pop, setPop] = useState<{ kind: "filter" | "columns" | "save" | "bulk_edit"; anchor: HTMLElement; index?: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const fields = meta.data?.fields ?? [];
  const fieldsForFilter = filterFields(fields) as FilterField<never>[];
  const filters = meta.data ? cleanFilters(view.filters, fieldsForFilter) : view.filters.filter((f) => !f.field.startsWith("f."));
  const effective = search.trim() ? [...filters, { field: "q", op: "contains" as const, values: [search.trim()] }] : filters;
  const board = view.layout === "board";
  const groupField = fields.find((f) => f.key === view.group && (f.kind === "select" || f.kind === "user"));

  const saved = useLoad(
    async () =>
      (must(await sb.from("saved_views").select("id, name, filters, columns, sort, layout, group_by, owner_id").eq("workspace_id", ws.id).eq("screen", screen).order("position").order("created_at")) as {
        id: string;
        name: string;
        filters: unknown;
        columns: Column[] | null;
        sort: ViewState["sort"] | null;
        layout: "table" | "board";
        group_by: string | null;
        owner_id: string | null;
      }[]).map(
        (r): Saved => ({
          id: r.id,
          name: r.name,
          owner_id: r.owner_id,
          filters: r.filters as Filter[],
          columns: r.columns ?? base.columns,
          sort: r.sort ?? base.sort,
          layout: r.layout,
          group: r.group_by ?? base.group,
        }),
      ),
    `${ws.id}:${screen}`,
  );

  const key = JSON.stringify({ effective, sort: view.sort, offset, board });
  const list = useLoad(
    async () =>
      must(
        await sb.rpc("records_list", {
          p_ws: ws.id,
          p_object: object,
          p_filters: effective,
          p_sort: view.sort.key,
          p_desc: view.sort.desc,
          p_limit: board ? 1000 : PAGE,
          p_offset: board ? 0 : offset,
        }),
      ) as { total: number; rows: Row[] },
    `${ws.id}:${object}:${key}`,
  );
  const counts = useLoad(
    async () =>
      board && groupField ? (must(await sb.rpc("records_group_counts", { p_ws: ws.id, p_object: object, p_filters: effective, p_group: groupField.key })) as Record<string, number>) : {},
    `${ws.id}:${object}:${key}:${groupField?.key}`,
  );

  const unselect = () => {
    setSelected(new Set());
    setAllMatching(false);
  };
  const change = (next: Partial<ViewState>) => {
    setView({ ...view, ...next });
    setOffset(0);
    unselect();
  };
  const tabs = [
    { value: "all", label: `All ${title.toLowerCase()}`, state: base },
    ...presets.map((p, i) => ({ value: `p${i}`, label: p.name, state: { ...base, ...p } as ViewState })),
    ...(saved.data ?? []).map((s) => ({ value: s.id, label: s.name, state: s as ViewState })),
  ];
  const active = tabs.find((t) => t.value === activeId) ?? tabs[0];
  const activeSaved = (saved.data ?? []).find((s) => s.id === activeId) ?? null;
  const changed = !sameView(view, active.state);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const count = allMatching ? total : selected.size;

  /** The ids the selection means, paging through when every match is picked. */
  async function pickedRows(): Promise<Row[]> {
    if (!allMatching) return rows.filter((r) => selected.has(r.id));
    const out: Row[] = [];
    for (let at = 0; at < Math.min(total, MAX_EXPORT); at += 1000) {
      const page = must(await sb.rpc("records_list", { p_ws: ws.id, p_object: object, p_filters: effective, p_sort: view.sort.key, p_desc: view.sort.desc, p_limit: 1000, p_offset: at })) as {
        rows: Row[];
      };
      out.push(...page.rows);
      if (page.rows.length < 1000) break;
    }
    return out;
  }
  const pickedIds = async () => (await pickedRows()).map((r) => r.id);

  async function run(label: string, fn: () => Promise<void>) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  const save = async (r: Row, f: AnyField, v: unknown) => {
    await run("save", async () => {
      must(await sb.rpc("record_set", { p_object: object, p_id: r.id, p_key: f.key, p_value: v ?? null }));
      list.reload();
    });
  };

  const exportCsv = () =>
    run("export", async () => {
      const chosen = await pickedRows();
      const cols = fields.filter((f) => f.key !== "segment");
      const head = cols.map((f) => f.label);
      const body = chosen.map((r) =>
        cols.map((f) => {
          if (f.kind === "relation") return (((r.links ?? {}) as Record<string, { name: string }[]>)[f.key.slice(2)] ?? []).map((l) => l.name).join("; ");
          return shownText(f, valueOf(r, f.key));
        }),
      );
      download(`${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([head, ...body]));
      if (object === "contact") must(await sb.rpc("contacts_export_log", { p_ws: ws.id, p_count: chosen.length, p_filters: effective }));
    });

  const remove = async () => {
    if (!(await askConfirm(`Remove ${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"}?`, { ok: "Remove", danger: true }))) return;
    await run("remove", async () => {
      const ids = await pickedIds();
      for (let i = 0; i < ids.length; i += 5000) must(await sb.rpc("records_delete", { p_ws: ws.id, p_object: object, p_ids: ids.slice(i, i + 5000) }));
      unselect();
      list.reload();
    });
  };

  const saveView = async (name: string, personal: boolean) => {
    await run("view", async () => {
      const row = must(
        await sb
          .from("saved_views")
          .insert({ workspace_id: ws.id, screen, name, filters: view.filters, columns: view.columns, sort: view.sort, layout: view.layout, group_by: view.group, owner_id: personal ? session.user.id : null })
          .select("id")
          .single(),
      ) as { id: string };
      saved.reload();
      setActiveId(row.id);
    });
  };
  const updateView = () =>
    activeSaved &&
    run("view", async () => {
      must(await sb.from("saved_views").update({ filters: view.filters, columns: view.columns, sort: view.sort, layout: view.layout, group_by: view.group }).eq("id", activeSaved.id));
      saved.reload();
    });
  const renameView = async () => {
    if (!activeSaved) return;
    const name = await askText("Rename view", { initial: activeSaved.name, ok: "Save" });
    if (!name) return;
    await run("view", async () => {
      must(await sb.from("saved_views").update({ name }).eq("id", activeSaved.id));
      saved.reload();
    });
  };
  const deleteView = async () => {
    if (!activeSaved || !(await askConfirm(`Delete the view "${activeSaved.name}"?`, { ok: "Delete", danger: true }))) return;
    await run("view", async () => {
      must(await sb.from("saved_views").delete().eq("id", activeSaved.id));
      saved.reload();
      setActiveId("all");
      change(base);
    });
  };

  const pickTab = (id: string) => {
    const t = tabs.find((x) => x.value === id);
    if (!t) return;
    setActiveId(id);
    change({ ...t.state });
  };

  if (meta.error || list.error) {
    return (
      <Page icon={icon} title={title}>
        <ErrorNote message={meta.error || list.error} />
      </Page>
    );
  }
  if (list.data && total === 0 && !effective.length && intro && activeId === "all") {
    return (
      <Page icon={icon} title={title} actions={actions}>
        {intro}
      </Page>
    );
  }

  const columns = view.columns.filter((c) => fields.some((f) => f.key === c.key));
  const editable = fields.filter((f) => f.edit);
  const groupable = fields.filter((f) => (f.kind === "select" || f.kind === "user") && f.edit);
  const cardFields = columns
    .map((c) => fields.find((f) => f.key === c.key))
    .filter((f): f is AnyField => !!f && f.key !== view.group)
    .slice(0, 3);

  return (
    <Page icon={icon} title={title} count={list.data ? total.toLocaleString("en-US") : undefined} flush actions={actions}>
      <Tabs value={active.value} tabs={tabs.map((t) => ({ value: t.value, label: t.label }))} onChange={pickTab} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-4 py-2 md:px-5">
        <div className="w-56">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            placeholder="Search"
            className="h-8"
          />
        </div>
        {filters.map((f, i) => (
          <span key={i} className="inline-flex h-8 items-center border border-line bg-panel text-[12.5px]">
            <button type="button" onClick={(e) => setPop({ kind: "filter", anchor: e.currentTarget, index: i })} className="h-full max-w-[300px] truncate px-2.5 hover:bg-hover">
              {describe(f, fieldsForFilter.find((x) => x.key === f.field))}
            </button>
            <button type="button" aria-label="Remove filter" onClick={() => change({ filters: filters.filter((_, j) => j !== i) })} className="flex h-full items-center border-l border-line px-1.5 text-muted hover:bg-hover hover:text-ink">
              <X size={12} />
            </button>
          </span>
        ))}
        <Button variant="ghost" className="h-8 px-2.5" onClick={(e) => setPop({ kind: "filter", anchor: e.currentTarget })} disabled={filters.length >= 20}>
          <Plus size={13} />
          Filter
        </Button>
        {changed ? (
          activeSaved ? (
            <>
              <Button variant="plain" className="h-8 px-2.5" onClick={updateView} disabled={!!busy}>
                Save changes
              </Button>
              <Button variant="plain" className="h-8 px-2.5" onClick={() => change(activeSaved)}>
                Reset
              </Button>
            </>
          ) : (
            <Button variant="plain" className="h-8 px-2.5" onClick={(e) => setPop({ kind: "save", anchor: e.currentTarget })}>
              Save view
            </Button>
          )
        ) : null}
        {activeSaved && !changed ? (
          <>
            <Button variant="plain" className="h-8 px-2.5" onClick={renameView}>
              Rename
            </Button>
            <Button variant="plain" className="h-8 px-2.5" onClick={deleteView}>
              Delete view
            </Button>
          </>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Segmented<"table" | "board">
            value={view.layout}
            label="Layout"
            onChange={(layout) => change({ layout, group: view.group ?? groupable[0]?.key ?? null })}
            options={[
              { value: "table", label: "Table" },
              { value: "board", label: "Board" },
            ]}
          />
          {board ? (
            <Select<string>
              value={groupField?.key ?? ""}
              onChange={(group) => change({ group })}
              ariaLabel="Group by"
              placeholder="Group by"
              options={groupable.map((f) => ({ value: f.key, label: f.label }))}
              className="h-8 w-40 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
            />
          ) : (
            <Button variant="ghost" className="h-8 px-2.5" onClick={(e) => setPop({ kind: "columns", anchor: e.currentTarget })}>
              Columns
            </Button>
          )}
          {onAdd ? (
            <Button className="h-8 px-2.5" onClick={onAdd}>
              <Plus size={13} />
              New
            </Button>
          ) : null}
        </span>
      </div>

      {count ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-pale px-4 py-2 text-[13px] md:px-5">
          <span className="font-medium">{count.toLocaleString("en-US")} selected</span>
          {!allMatching && rows.length && rows.every((r) => selected.has(r.id)) && total > rows.length ? (
            <Button variant="plain" className="h-7 px-2" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString("en-US")}
            </Button>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="ghost" className="h-7 px-2.5" onClick={(e) => setPop({ kind: "bulk_edit", anchor: e.currentTarget })} disabled={!!busy}>
              Edit field
            </Button>
            {meta.data && bulkExtra
              ? bulkExtra(pickedIds, () => {
                  unselect();
                  list.reload();
                }, meta.data)
              : null}
            <Button variant="ghost" className="h-7 px-2.5" onClick={exportCsv} disabled={!!busy}>
              <Download size={13} />
              {busy === "export" ? "Exporting…" : "Export"}
            </Button>
            <Button variant="danger" className="h-7 px-2.5" onClick={remove} disabled={!!busy}>
              <Trash size={13} />
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
            <Button variant="plain" className="h-7 px-2" onClick={unselect}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="p-4">
          <ErrorNote message={error} />
        </div>
      ) : null}

      {!list.data || !meta.data ? (
        <Loading />
      ) : !rows.length ? (
        <Empty icon={icon} title={effective.length ? "Nothing matches" : `No ${title.toLowerCase()} yet`} />
      ) : board && groupField ? (
        <RecordBoard
          group={{ key: groupField.key, label: groupField.label, options: groupField.options }}
          rows={rows}
          counts={counts.data ?? {}}
          cardFields={cardFields}
          onOpen={onOpen}
          onMove={(r, v) => void save(r, groupField, v)}
        />
      ) : board ? (
        <Empty icon={icon} title="Pick a field to group by" />
      ) : (
        <>
          <RecordTable
            sb={sb}
            wsId={ws.id}
            fields={fields}
            columns={columns}
            rows={rows}
            sort={view.sort}
            onSort={(k) => change({ sort: { key: k, desc: view.sort.key === k ? !view.sort.desc : k !== "name" } })}
            selected={selected}
            allMatching={allMatching}
            onToggle={(id) => {
              const next = new Set(allMatching ? rows.map((r) => r.id) : selected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setAllMatching(false);
              setSelected(next);
            }}
            onTogglePage={() => {
              const all = rows.every((r) => selected.has(r.id));
              setAllMatching(false);
              setSelected(all ? new Set() : new Set(rows.map((r) => r.id)));
            }}
            onOpen={onOpen}
            onSave={save}
            onColumns={(c) => setView({ ...view, columns: c })}
            nameExtra={nameExtra}
          />
          <div className="flex items-center gap-2 px-4 py-3 font-mono text-[11.5px] text-muted md:px-5">
            <span>
              {(offset + 1).toLocaleString("en-US")}–{(offset + rows.length).toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            </span>
            <span className="ml-auto flex gap-2">
              <Button
                variant="ghost"
                className="h-7 px-2.5"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - PAGE));
                  unselect();
                }}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                className="h-7 px-2.5"
                disabled={offset + PAGE >= total}
                onClick={() => {
                  setOffset(offset + PAGE);
                  unselect();
                }}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}

      {pop?.kind === "filter" ? (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)}>
          <FilterEditor
            fields={fieldsForFilter}
            start={pop.index == null ? null : filters[pop.index]}
            onDone={(f) => {
              if (f) change({ filters: pop.index == null ? [...filters, f] : filters.map((x, j) => (j === pop.index ? f : x)) });
              setPop(null);
            }}
          />
        </Popover>
      ) : null}
      {pop?.kind === "columns" ? (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={260}>
          <ul className="max-h-96 overflow-y-auto p-1">
            {fields
              .filter((f) => f.key !== "name" && !f.hidden)
              .map((f) => {
                const on = columns.some((c) => c.key === f.key);
                return (
                  <li key={f.key}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setView({ ...view, columns: on ? view.columns.filter((c) => c.key !== f.key) : [...view.columns, { key: f.key, width: DEFAULT_WIDTH }] })}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
                    >
                      <span className={`flex size-4 items-center justify-center border ${on ? "border-ink bg-ink text-white" : "border-line-strong"}`}>{on ? <Check size={11} /> : null}</span>
                      <span className="flex-1 truncate">{f.label}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </Popover>
      ) : null}
      {pop?.kind === "save" ? (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={300}>
          <SaveView
            onDone={(name, personal) => {
              setPop(null);
              if (name) void saveView(name, personal);
            }}
          />
        </Popover>
      ) : null}
      {pop?.kind === "bulk_edit" ? (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={320}>
          <BulkEdit
            sb={sb}
            wsId={ws.id}
            fields={editable.filter((f) => f.kind !== "relation")}
            onDone={async (f, v) => {
              setPop(null);
              if (!f) return;
              await run("bulk", async () => {
                const ids = await pickedIds();
                for (let i = 0; i < ids.length; i += 2000) must(await sb.rpc("records_bulk_set", { p_ws: ws.id, p_object: object, p_ids: ids.slice(i, i + 2000), p_key: f.key, p_value: v ?? null }));
                unselect();
                list.reload();
                await tell(`${f.label} set on ${ids.length.toLocaleString("en-US")} ${ids.length === 1 ? "record" : "records"}`);
              });
            }}
          />
        </Popover>
      ) : null}
    </Page>
  );
}

function SaveView({ onDone }: { onDone: (name: string | null, personal: boolean) => void }) {
  const [name, setName] = useState("");
  const [who, setWho] = useState<"team" | "me">("team");
  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onDone(name.trim(), who === "me");
      }}
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name" maxLength={80} className="h-8" />
      <Segmented<"team" | "me">
        value={who}
        onChange={setWho}
        label="Who sees it"
        options={[
          { value: "team", label: "Everyone" },
          { value: "me", label: "Only me" },
        ]}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="plain" className="h-7 px-2.5" onClick={() => onDone(null, false)}>
          Cancel
        </Button>
        <Button type="submit" className="h-7 px-2.5" disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

function BulkEdit({ sb, wsId, fields, onDone }: { sb: ViewProps["sb"]; wsId: string; fields: AnyField[]; onDone: (f: AnyField | null, v: unknown) => void }) {
  const [key, setKey] = useState<string>("");
  const field = fields.find((f) => f.key === key);
  return (
    <div className="flex flex-col gap-3 p-3">
      <Select<string>
        value={key}
        onChange={setKey}
        ariaLabel="Field"
        placeholder="Field"
        options={fields.map((f) => ({ value: f.key, label: f.label }))}
        className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
      />
      {field ? <FieldEditor key={field.key} sb={sb} wsId={wsId} field={field} value={null} onSave={(v) => onDone(field, v)} onCancel={() => onDone(null, null)} /> : null}
    </div>
  );
}
