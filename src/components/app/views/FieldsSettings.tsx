"use client";

// Settings › Fields and Settings › Objects (supabase/migrations/034_records.sql): custom fields of every type with
// options, groups and the required switch; built-in fields renamed or hidden; lead stages; ready-made packs;
// which source may overwrite which; and custom objects.

import { useState } from "react";
import { FIELD_KINDS, LEAD_STAGES, optionsOf, PACKS, type CustomField, type FieldKind, type Option } from "@/lib/records/fields";
import { askConfirm, askLines, askText } from "../Dialogs";
import { Select } from "../Select";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Panel, Segmented, useLoad, type ViewProps } from "../ui";
import { useMeta } from "../records/meta";

const CLASSES: { value: string; label: string }[] = [
  { value: "manual", label: "People in the app" },
  { value: "crm", label: "CRMs" },
  { value: "form", label: "Forms and events" },
  { value: "product", label: "Product data and API" },
  { value: "import", label: "Imports and email tools" },
  { value: "vendor", label: "Data vendors" },
  { value: "ai", label: "AI" },
];
const DEFAULT_ORDER = CLASSES.map((c) => c.value);

function useObjects(sb: ViewProps["sb"], wsId: string) {
  return useLoad(async () => must(await sb.from("objects").select("key, label, plural, icon, system").eq("workspace_id", wsId).order("created_at")) as { key: string; label: string; plural: string; icon: string; system: boolean }[], wsId);
}

/** Options as lines: "value" or "Label" per line; stages also take ": won" or ": lost". */
const toLines = (o: Option[], stages = false) => o.map((x) => `${x.label}${stages && x.kind && x.kind !== "open" ? `: ${x.kind}` : ""}`).join("\n");
function fromLines(text: string, stages = false): Option[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = stages ? /^(.*?):\s*(won|lost|open)$/i.exec(l) : null;
      const label = (m ? m[1] : l).trim().slice(0, 60);
      const value = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "option";
      return { value, label, ...(stages ? { kind: ((m?.[2]?.toLowerCase() as Option["kind"]) ?? "open") } : {}) };
    })
    .filter((o) => !seen.has(o.value) && seen.add(o.value));
}

export function FieldsSettings({ sb, ws, role }: Pick<ViewProps, "sb" | "ws" | "role">) {
  const objects = useObjects(sb, ws.id);
  const [object, setObject] = useState("contact");
  const meta = useMeta(sb, ws.id, object);
  const order = useLoad(async () => must(await sb.from("field_order").select("key, classes").eq("workspace_id", ws.id).eq("object", object)) as { key: string; classes: string[] }[], `${ws.id}:${object}`);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      meta.reload();
      order.reload();
      window.dispatchEvent(new Event("claritia:changed"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const objectOptions = [{ value: "contact", label: "Contacts" }, { value: "company", label: "Companies" }, ...(objects.data ?? []).map((o) => ({ value: o.key, label: o.plural }))];
  if (!meta.data) return meta.error ? <ErrorNote message={meta.error} /> : <Loading />;

  const custom = [...meta.data.custom].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const builtins = meta.data.fields.filter((f) => !f.custom);
  const move = (i: number, d: number) => {
    const keys = custom.map((f) => f.key);
    const [k] = keys.splice(i, 1);
    keys.splice(i + d, 0, k);
    void run(async () => must(await sb.rpc("fields_order", { p_ws: ws.id, p_object: object, p_keys: keys })));
  };
  const defaults = order.data?.find((o) => o.key === "*")?.classes ?? DEFAULT_ORDER;
  const owner = role === "owner";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select<string>
          value={object}
          onChange={(v) => {
            setObject(v);
            setAdding(false);
            setEditing(null);
          }}
          ariaLabel="Object"
          options={objectOptions}
          className="h-9 w-56 rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong"
        />
        <Button className="ml-auto" onClick={() => setAdding(true)} disabled={adding}>
          Add field
        </Button>
      </div>
      <ErrorNote message={error} />

      {adding ? (
        <FieldForm
          objects={objectOptions}
          onCancel={() => setAdding(false)}
          busy={busy}
          onSave={(f) =>
            run(async () => {
              must(await sb.rpc("field_add", { p_ws: ws.id, p_object: object, p_label: f.label, p_type: f.type, p_options: f.options, p_config: f.config ?? {}, p_required: !!f.required, p_group: f.group ?? null }));
              setAdding(false);
            })
          }
        />
      ) : null}

      <Panel>
        <CardHead label="Custom fields" count={custom.length} />
        {!custom.length ? (
          <p className="px-4 py-3 text-[13px] text-faint">—</p>
        ) : (
          <ul className="divide-y divide-line">
            {custom.map((f, i) =>
              editing === f.key ? (
                <li key={f.key} className="p-3">
                  <FieldForm
                    objects={objectOptions}
                    start={f}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(n) =>
                      run(async () => {
                        must(
                          await sb.rpc("field_update", {
                            p_ws: ws.id,
                            p_object: object,
                            p_key: f.key,
                            p_label: n.label,
                            p_options: n.options,
                            p_config: n.config ?? {},
                            p_required: !!n.required,
                            p_group: n.group ?? "",
                          }),
                        );
                        setEditing(null);
                      })
                    }
                  />
                </li>
              ) : (
                <li key={f.key} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
                  <span className="font-medium">{f.label}</span>
                  <Badge>{FIELD_KINDS.find((k) => k.value === f.type)?.label ?? f.type}</Badge>
                  {f.required ? <Badge tone="amber">Required</Badge> : null}
                  {f.group_name ? <span className="text-[12px] text-muted">{f.group_name}</span> : null}
                  <span className="font-mono text-[11px] text-faint">{f.key}</span>
                  <span className="ml-auto flex gap-1">
                    <Button variant="plain" className="h-7 px-2" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up">
                      ↑
                    </Button>
                    <Button variant="plain" className="h-7 px-2" disabled={i === custom.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down">
                      ↓
                    </Button>
                    <Button variant="ghost" className="h-7 px-2.5" onClick={() => setEditing(f.key)}>
                      Edit
                    </Button>
                    {f.system ? null : (
                      <Button
                        variant="danger"
                        className="h-7 px-2.5"
                        onClick={async () => {
                          if (!(await askConfirm(`Delete "${f.label}"?`, { body: "Its values go from every record.", ok: "Delete", danger: true }))) return;
                          void run(async () => must(await sb.rpc("field_delete", { p_ws: ws.id, p_object: object, p_key: f.key })));
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </Panel>

      <Panel>
        <CardHead label="Built-in fields" count={builtins.length} />
        <ul className="divide-y divide-line">
          {builtins.map((f) => {
            const original = f.label;
            const stages = object === "contact" && f.key === "lead_status";
            return (
              <li key={f.key} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
                <span className={`font-medium ${f.hidden ? "text-faint line-through" : ""}`}>{f.label}</span>
                <span className="font-mono text-[11px] text-faint">{f.key}</span>
                <span className="ml-auto flex gap-1">
                  {stages ? (
                    <Button
                      variant="ghost"
                      className="h-7 px-2.5"
                      onClick={async () => {
                        const text = await askLines("Lead stages", { initial: toLines(f.options.length ? f.options : LEAD_STAGES, true) });
                        if (text == null) return;
                        const opts = fromLines(text, true);
                        if (!opts.length) return setError("Add at least one stage");
                        void run(async () => must(await sb.rpc("field_settings_save", { p_ws: ws.id, p_object: object, p_key: f.key, p_label: f.label, p_hidden: f.hidden, p_options: opts })));
                      }}
                    >
                      Stages
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    className="h-7 px-2.5"
                    onClick={async () => {
                      const label = await askText("Rename field", { initial: original, ok: "Save" });
                      if (!label) return;
                      void run(async () => must(await sb.rpc("field_settings_save", { p_ws: ws.id, p_object: object, p_key: f.key, p_label: label, p_hidden: f.hidden, p_options: null })));
                    }}
                  >
                    Rename
                  </Button>
                  {f.key !== "name" && f.key !== "email" ? (
                    <Button
                      variant="ghost"
                      className="h-7 px-2.5"
                      onClick={() => run(async () => must(await sb.rpc("field_settings_save", { p_ws: ws.id, p_object: object, p_key: f.key, p_label: f.label, p_hidden: !f.hidden, p_options: null })))}
                    >
                      {f.hidden ? "Show" : "Hide"}
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>

      {object === "contact" || object === "company" ? (
        <Panel>
          <CardHead label="Field packs" />
          <div className="flex flex-wrap gap-2 p-4">
            {PACKS.filter((p) => p.object === object).map((p) => (
              <Button
                key={p.key}
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const have = new Set(custom.map((f) => f.label.toLowerCase()));
                    for (const f of p.fields) {
                      if (have.has(f.label.toLowerCase())) continue;
                      must(await sb.rpc("field_add", { p_ws: ws.id, p_object: object, p_label: f.label, p_type: f.type, p_options: (f.options ?? []).map((o) => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: o })), p_group: p.label }));
                    }
                  })
                }
              >
                {p.label}
              </Button>
            ))}
          </div>
        </Panel>
      ) : null}

      {object === "contact" ? (
        <Panel>
          <CardHead label="Which source wins" />
          <ol className="divide-y divide-line">
            {defaults.map((c, i) => (
              <li key={c} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="w-5 font-mono text-[11px] text-faint">{i + 1}</span>
                <span className="flex-1">{CLASSES.find((x) => x.value === c)?.label ?? c}</span>
                {owner ? (
                  <span className="flex gap-1">
                    {[-1, 1].map((d) => (
                      <Button
                        key={d}
                        variant="plain"
                        className="h-7 px-2"
                        disabled={busy || i + d < 0 || i + d >= defaults.length}
                        aria-label={d < 0 ? "Move up" : "Move down"}
                        onClick={() => {
                          const next = [...defaults];
                          [next[i], next[i + d]] = [next[i + d], next[i]];
                          void run(async () => must(await sb.rpc("field_order_save", { p_ws: ws.id, p_object: object, p_key: "*", p_classes: next })));
                        }}
                      >
                        {d < 0 ? "↑" : "↓"}
                      </Button>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </div>
  );
}

type Draft = { label: string; type: FieldKind; options: Option[]; config?: CustomField["config"]; required?: boolean; group?: string | null };

function FieldForm({ start, objects, busy, onSave, onCancel }: { start?: CustomField; objects: { value: string; label: string }[]; busy: boolean; onSave: (f: Draft) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(start?.label ?? "");
  const [type, setType] = useState<FieldKind>(start?.type ?? "text");
  const [lines, setLines] = useState(start ? toLines(optionsOf(start)) : "");
  const [required, setRequired] = useState<"yes" | "no">(start?.required ? "yes" : "no");
  const [group, setGroup] = useState(start?.group_name ?? start?.group ?? "");
  const [target, setTarget] = useState(start?.config?.target ?? "contact");
  const [multiple, setMultiple] = useState<"one" | "many">(start?.config?.multiple ? "many" : "one");
  const [currency, setCurrency] = useState(start?.config?.currency ?? "USD");
  const picks = type === "select" || type === "multi_select";
  const ready = label.trim() && (!picks || fromLines(lines).length > 0);
  return (
    <Panel>
      <form
        className="grid gap-4 p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          onSave({
            label: label.trim(),
            type,
            options: picks ? fromLines(lines) : [],
            config: type === "relation" ? { target, multiple: multiple === "many" } : type === "currency" ? { currency: currency.toUpperCase().slice(0, 3) } : {},
            required: required === "yes",
            group: group.trim() || null,
          });
        }}
      >
        <Field label="Name">
          <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Type">
          <Select<FieldKind>
            value={type}
            onChange={setType}
            disabled={!!start}
            ariaLabel="Type"
            options={FIELD_KINDS}
            className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong disabled:opacity-60"
          />
        </Field>
        {picks ? (
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="label-mono">Options, one per line</span>
            <textarea value={lines} onChange={(e) => setLines(e.target.value)} rows={5} className="rounded-md border border-line bg-panel px-2.5 py-2 text-[13px] outline-none focus:border-ink" />
          </label>
        ) : null}
        {type === "relation" ? (
          <>
            <Field label="Links to">
              <Select<string>
                value={target}
                onChange={setTarget}
                disabled={!!start}
                ariaLabel="Links to"
                options={objects}
                className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong disabled:opacity-60"
              />
            </Field>
            <Field label="How many">
              <Segmented<"one" | "many">
                value={multiple}
                onChange={setMultiple}
                options={[
                  { value: "one", label: "One" },
                  { value: "many", label: "Many" },
                ]}
              />
            </Field>
          </>
        ) : null}
        {type === "currency" ? (
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
        ) : null}
        <Field label="Group">
          <Input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Required">
          <Segmented<"yes" | "no">
            value={required}
            onChange={setRequired}
            options={[
              { value: "no", label: "No" },
              { value: "yes", label: "Yes" },
            ]}
          />
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="plain" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready || busy}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function ObjectsSettings({ sb, ws, role, navigate }: Pick<ViewProps, "sb" | "ws" | "role" | "navigate">) {
  const objects = useObjects(sb, ws.id);
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      objects.reload();
      window.dispatchEvent(new Event("claritia:changed"));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <ErrorNote message={error} />
      <Panel>
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            void run(async () => {
              must(await sb.rpc("object_save", { p_ws: ws.id, p_key: "", p_label: label.trim(), p_plural: plural.trim() || `${label.trim()}s`, p_icon: "box" }));
              setLabel("");
              setPlural("");
            });
          }}
        >
          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Subscription" maxLength={60} className="w-56" />
          </Field>
          <Field label="Plural">
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="Subscriptions" maxLength={60} className="w-56" />
          </Field>
          <Button type="submit" disabled={!label.trim()}>
            Add object
          </Button>
        </form>
      </Panel>
      <Panel>
        <CardHead label="Objects" count={objects.data?.length} />
        {!objects.data ? (
          <Loading />
        ) : !objects.data.length ? (
          <p className="px-4 py-3 text-[13px] text-faint">—</p>
        ) : (
          <ul className="divide-y divide-line">
            {objects.data.map((o) => (
              <li key={o.key} className="flex items-center gap-2 px-4 py-2.5 text-[13px]">
                <span className="font-medium">{o.plural}</span>
                <span className="font-mono text-[11px] text-faint">{o.key}</span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" className="h-7 px-2.5" onClick={() => (o.system ? navigate("opportunities") : navigate("objects", o.key))}>
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2.5"
                    onClick={async () => {
                      const name = await askText("Rename object", { initial: o.label, ok: "Save" });
                      if (!name) return;
                      void run(async () => must(await sb.rpc("object_save", { p_ws: ws.id, p_key: o.key, p_label: name, p_plural: o.plural, p_icon: o.icon })));
                    }}
                  >
                    Rename
                  </Button>
                  {role === "owner" && !o.system ? (
                    <Button
                      variant="danger"
                      className="h-7 px-2.5"
                      onClick={async () => {
                        if (!(await askConfirm(`Delete ${o.plural}?`, { body: "Every record, field and link of this object goes.", ok: "Delete", danger: true }))) return;
                        void run(async () => must(await sb.rpc("object_delete", { p_ws: ws.id, p_key: o.key })));
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
