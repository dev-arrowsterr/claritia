"use client";

// What a records screen needs to know about its object: custom fields, built-in settings, teammates and lists.

import type { SupabaseClient } from "@supabase/supabase-js";
import { allFields, type AnyField, type CustomField, type FieldSetting, type ObjectDef, type Option, type Person } from "@/lib/records/fields";
import { must, useLoad } from "../ui";

export type Meta = { fields: AnyField[]; custom: CustomField[]; people: Person[]; lists: Option[]; object: ObjectDef | null; layout: { name: string; keys: string[] }[] };

export const OBJECT_LABELS: Record<string, ObjectDef> = {
  contact: { key: "contact", label: "Contact", plural: "Contacts", icon: "contact" },
  company: { key: "company", label: "Company", plural: "Companies", icon: "company" },
};

export async function loadMeta(sb: SupabaseClient, wsId: string, object: string): Promise<Meta> {
  const [custom, settings, people, lists, obj, layout] = await Promise.all([
    sb.from("fields").select("key, label, type, options, config, required, group_name, position, system").eq("workspace_id", wsId).eq("object", object).order("position"),
    sb.from("field_settings").select("key, label, hidden, options").eq("workspace_id", wsId).eq("object", object),
    sb.rpc("workspace_people", { p_ws: wsId }),
    object === "contact" ? sb.from("segments").select("id, name").eq("workspace_id", wsId).order("name") : Promise.resolve({ data: [], error: null }),
    OBJECT_LABELS[object] ? Promise.resolve({ data: OBJECT_LABELS[object], error: null }) : sb.from("objects").select("id, key, label, plural, icon").eq("workspace_id", wsId).eq("key", object).maybeSingle(),
    sb.from("object_layouts").select("sections").eq("workspace_id", wsId).eq("object", object).maybeSingle(),
  ]);
  const c = must(custom) as CustomField[];
  const p = (must(people) ?? []) as Person[];
  const l = ((must(lists) ?? []) as { id: string; name: string }[]).map((x) => ({ value: x.id, label: x.name }));
  return {
    custom: c,
    people: p,
    lists: l,
    object: (obj.data as ObjectDef | null) ?? null,
    layout: ((layout.data as { sections?: { name: string; keys: string[] }[] } | null)?.sections ?? []) as Meta["layout"],
    fields: allFields(object, c, (must(settings) ?? []) as FieldSetting[], { people: p, lists: l }),
  };
}

export function useMeta(sb: SupabaseClient, wsId: string, object: string) {
  return useLoad(() => loadMeta(sb, wsId, object), `${wsId}:${object}`);
}
