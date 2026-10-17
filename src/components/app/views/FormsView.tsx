"use client";

// Forms (docs/marketing-platform.md M6): build a form, put it on any site with one script tag or share its link,
// and see every answer with the page and UTMs it came from. Answers become contacts with the consent the form asked
// for; spam is held back.

import { useEffect, useState } from "react";
import { FIELD_TYPES, formProblems, MAPS_TO, type FieldType, type FormField, type FormSettings } from "@/lib/forms/schema";
import { Eye, ListIcon, Plus, Trash, X } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { SampleTags, ToolIntro } from "../ToolIntro";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Page, Panel, Td, Th, timeAgo, useLoad, type ViewProps } from "../ui";
import { Copy } from "./SitesPanel";

type FormRow = { id: string; name: string; status: "draft" | "live"; fields: FormField[]; settings: FormSettings; updated_at: string };
type Submission = { id: string; answers: Record<string, unknown>; utm: Record<string, string>; page_url: string | null; spam: string | null; basis: string | null; contact_id: string | null; created_at: string };

const SEL = "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const MAP_LABEL: Record<string, string> = { email: "Email", first_name: "First name", last_name: "Last name", name: "Full name", title: "Job title", phone: "Phone", company: "Company", website: "Website", country: "Country", region: "State or region" };
const SPAM: Record<string, string> = { honeypot: "Bot", too_fast: "Too fast", rate: "Too many", captcha: "Check failed" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40) || "field";
const appBase = () => (typeof window === "undefined" ? "" : window.location.origin);

const STARTER: FormField[] = [
  { key: "email", label: "Work email", type: "email", required: true, maps_to: "email" },
  { key: "first_name", label: "First name", type: "text", maps_to: "first_name" },
  { key: "last_name", label: "Last name", type: "text", maps_to: "last_name" },
  { key: "company", label: "Company", type: "text", maps_to: "company" },
];

export function FormsView({ sb, ws, id, navigate }: ViewProps) {
  if (id) return <FormPage key={id} sb={sb} ws={ws} id={id} navigate={navigate} />;
  return <FormList sb={sb} ws={ws} navigate={navigate} />;
}

function FormList({ sb, ws, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate">) {
  const list = useLoad(async () => must(await sb.from("forms").select("id, name, status, updated_at").eq("workspace_id", ws.id).order("updated_at", { ascending: false })) as FormRow[], ws.id);
  const add = (
    <Button onClick={() => navigate("forms", "new")}>
      <Plus size={14} /> New form
    </Button>
  );
  return (
    <Page icon={<ListIcon size={16} />} title="Forms" count={list.data?.length} actions={list.data?.length ? add : undefined}>
      <ErrorNote message={list.error} />
      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <ToolIntro
          action={add}
          title="Forms that turn visits into contacts"
          lead="Build a form, paste one script tag on any site, or share its link. Each answer becomes a contact with the consent it gave, the page it came from and its UTMs, and bots are held back."
          features={[
            { title: "Consent built in", text: "An unticked checkbox by default, or a notice where the law allows it. Ticking it can also subscribe them to a topic." },
            { title: "Where they came from", text: "First and latest UTMs, ad click ids, the page and the referrer, on every answer.", visual: <SampleTags rows={[["utm_source", "linkedin"], ["utm_campaign", "q4-guide"], ["page", "/pricing"]]} /> },
            { title: "Spam held back", text: "A hidden field, a speed check, a limit per address and Cloudflare Turnstile when you want it." },
          ]}
        />
      ) : (
        <Panel>
          <ul className="divide-y divide-line">
            {list.data.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => navigate("forms", f.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-hover">
                  <span className="font-medium">{f.name}</span>
                  <span className="ml-auto flex items-center gap-3">
                    <span className="text-[12px] text-faint">{timeAgo(f.updated_at)}</span>
                    <Badge tone={f.status === "live" ? "green" : "gray"}>{f.status === "live" ? "Live" : "Draft"}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Page>
  );
}

function FormPage({ sb, ws, id, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate"> & { id: string }) {
  const isNew = id === "new";
  const saved = useLoad(async () => (isNew ? null : (must(await sb.from("forms").select("id, name, status, fields, settings, updated_at").eq("id", id).maybeSingle()) as FormRow | null)), `form:${id}`);
  const custom = useLoad(async () => must(await sb.from("fields").select("key, label").eq("workspace_id", ws.id).eq("object", "contact").order("position")) as { key: string; label: string }[], `${ws.id}:fields`);
  const topics = useLoad(async () => must(await sb.from("topics").select("id, name").eq("workspace_id", ws.id).order("name")) as { id: string; name: string }[], `${ws.id}:topics`);
  if (!isNew && saved.data === undefined) return <Page icon={<ListIcon size={16} />} title="Forms">{saved.error ? <ErrorNote message={saved.error} /> : <Loading />}</Page>;
  if (!isNew && !saved.data) return <Page icon={<ListIcon size={16} />} title="Forms"><ErrorNote message="Form not found." /></Page>;
  if (!custom.data || !topics.data) return <Page icon={<ListIcon size={16} />} title="Forms"><Loading /></Page>;
  return <Builder sb={sb} ws={ws} navigate={navigate} form={saved.data ?? null} custom={custom.data} topics={topics.data} onSaved={saved.reload} />;
}

function Builder({ sb, ws, navigate, form, custom, topics, onSaved }: Pick<ViewProps, "sb" | "ws" | "navigate"> & { form: FormRow | null; custom: { key: string; label: string }[]; topics: { id: string; name: string }[]; onSaved: () => void }) {
  const [name, setName] = useState(form?.name ?? "New form");
  const [fields, setFields] = useState<FormField[]>(form?.fields ?? STARTER);
  const [settings, setSettings] = useState<FormSettings>(form?.settings ?? { consent: "checkbox" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [shown, setShown] = useState(0);
  const problems = formProblems(name, fields, settings);
  const mapOptions = [{ value: "", label: "Answer only" }, ...MAPS_TO.map((m) => ({ value: m as string, label: MAP_LABEL[m] })), ...custom.map((f) => ({ value: `f.${f.key}`, label: f.label }))];
  const set = (i: number, patch: Partial<FormField>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  };

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const save = () =>
    run("save", async () => {
      if (problems.length) throw new Error(problems[0]);
      const fid = must(await sb.rpc("form_save", { p_ws: ws.id, p_id: form?.id ?? null, p_name: name, p_fields: fields, p_settings: settings })) as string;
      if (!form) navigate("forms", fid);
      else {
        onSaved();
        setShown((n) => n + 1);
      }
    });
  const live = form?.status === "live";
  const embed = form ? `<script src="${appBase()}/f/embed.js" data-claritia-form="${form.id}" async></script>` : "";

  return (
    <Page
      icon={<ListIcon size={16} />}
      title={form?.name ?? "New form"}
      actions={
        <span className="flex items-center gap-2">
          {form ? <Badge tone={live ? "green" : "gray"}>{live ? "Live" : "Draft"}</Badge> : null}
          {form ? (
            <Button variant="ghost" disabled={!!busy} onClick={() => run("live", async () => (must(await sb.rpc("form_publish", { p_id: form.id, p_live: !live })), onSaved()))}>
              {live ? "Take down" : "Go live"}
            </Button>
          ) : null}
          {form ? (
            <Button
              variant="plain"
              aria-label="Delete form"
              title="Delete form"
              onClick={() =>
                run("delete", async () => {
                  if (!(await askConfirm(`Delete ${form.name}?`, { body: "Its answers go too. Contacts stay.", ok: "Delete", danger: true }))) return;
                  must(await sb.rpc("form_delete", { p_id: form.id }));
                  navigate("forms");
                })
              }
            >
              <Trash size={14} />
            </Button>
          ) : null}
          <Button onClick={save} disabled={!!busy}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorNote message={error} />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col gap-5">
            <Panel>
              <div className="p-4">
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </div>
            </Panel>
            <Panel>
              <CardHead label="Fields" count={fields.length}>
                <Button variant="plain" className="h-7 px-2" onClick={() => setFields([...fields, { key: slug(`field_${fields.length + 1}`), label: "", type: "text" }])}>
                  <Plus size={14} /> Field
                </Button>
              </CardHead>
              <ul className="divide-y divide-line">
                {fields.map((f, i) => (
                  <li key={i} className="grid gap-3 p-4 sm:grid-cols-2">
                    <Field label="Label">
                      <Input value={f.label} onChange={(e) => set(i, { label: e.target.value, ...(form?.fields.some((x) => x.key === f.key) ? {} : { key: slug(e.target.value) }) })} />
                    </Field>
                    <Field label="Type">
                      <Select className={SEL} value={f.type} options={FIELD_TYPES} onChange={(t: FieldType) => set(i, { type: t, ...(t === "email" && !fields.some((x) => x.maps_to === "email") ? { maps_to: "email" } : {}) })} />
                    </Field>
                    <Field label="Fills">
                      <Select className={SEL} value={f.maps_to ?? ""} options={mapOptions} onChange={(m) => set(i, { maps_to: m || undefined })} />
                    </Field>
                    <Field label="Key">
                      <Input value={f.key} onChange={(e) => set(i, { key: e.target.value })} className="font-mono text-[12px]" />
                    </Field>
                    {f.type === "select" || f.type === "multi" ? (
                      <Field label="Choices, one per line">
                        <textarea className="min-h-20 w-full rounded-md border border-line bg-panel px-2.5 py-2 text-[13px]" value={(f.options ?? []).join("\n")} onChange={(e) => set(i, { options: e.target.value.split("\n") })} />
                      </Field>
                    ) : f.type === "hidden" ? (
                      <Field label="Value">
                        <Input value={f.value ?? ""} onChange={(e) => set(i, { value: e.target.value })} placeholder="utm_campaign" />
                      </Field>
                    ) : (
                      <Field label="Placeholder">
                        <Input value={f.placeholder ?? ""} onChange={(e) => set(i, { placeholder: e.target.value || undefined })} />
                      </Field>
                    )}
                    <div className="flex items-end gap-2">
                      {f.type !== "hidden" ? (
                        <label className="flex h-9 items-center gap-2 text-[13px]">
                          <input type="checkbox" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
                        </label>
                      ) : null}
                      <span className="ml-auto flex gap-1">
                        <Button variant="plain" className="h-7 px-2" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" title="Move up">
                          ↑
                        </Button>
                        <Button variant="plain" className="h-7 px-2" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down" title="Move down">
                          ↓
                        </Button>
                        <Button variant="plain" className="h-7 px-2" onClick={() => setFields(fields.filter((_, j) => j !== i))} aria-label="Remove field" title="Remove field">
                          <X size={14} />
                        </Button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {problems.length ? <div className="border-t border-line px-4 py-3"><ErrorNote message={problems[0]} /></div> : null}
            </Panel>
            <Panel>
              <CardHead label="After they send" />
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <Field label="Button">
                  <Input value={settings.submit_label ?? ""} onChange={(e) => setSettings({ ...settings, submit_label: e.target.value || undefined })} placeholder="Send" />
                </Field>
                <Field label="Thank-you message">
                  <Input value={settings.success_message ?? ""} onChange={(e) => setSettings({ ...settings, success_message: e.target.value || undefined })} placeholder="Thanks. We got it." />
                </Field>
                <Field label="Or go to a page">
                  <Input value={settings.redirect_url ?? ""} onChange={(e) => setSettings({ ...settings, redirect_url: e.target.value.trim() || undefined })} placeholder="https://yoursite.com/thanks" />
                </Field>
                <Field label="Button color">
                  <Input value={settings.color ?? ""} onChange={(e) => setSettings({ ...settings, color: e.target.value.trim() || undefined })} placeholder="#266DF0" />
                </Field>
              </div>
            </Panel>
            <Panel>
              <CardHead label="Consent and spam" />
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <Field label="Email consent">
                  <Select
                    className={SEL}
                    value={settings.consent ?? "checkbox"}
                    onChange={(v) => setSettings({ ...settings, consent: v })}
                    options={[
                      { value: "checkbox", label: "Unticked checkbox" },
                      { value: "notice", label: "Notice (legitimate interest)" },
                    ]}
                  />
                </Field>
                <Field label="Subscribe to topic">
                  <Select className={SEL} value={settings.topic_id ?? ""} onChange={(v) => setSettings({ ...settings, topic_id: v || undefined })} options={[{ value: "", label: "None" }, ...topics.map((t) => ({ value: t.id, label: t.name }))]} />
                </Field>
                <Field label="Consent wording">
                  <Input value={settings.consent_text ?? ""} onChange={(e) => setSettings({ ...settings, consent_text: e.target.value || undefined })} placeholder="I'd like to get emails. I can unsubscribe at any time." />
                </Field>
                <Field label="Cloudflare Turnstile">
                  <Select
                    className={SEL}
                    value={settings.captcha ? "on" : "off"}
                    onChange={(v) => setSettings({ ...settings, captcha: v === "on" })}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "on", label: "On" },
                    ]}
                  />
                </Field>
              </div>
            </Panel>
          </div>
          <div className="flex flex-col gap-5">
            {form ? (
              <>
                <Panel>
                  <CardHead label="Preview">
                    <a className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-hover" href={`/f/${form.id}?preview=1`} target="_blank" rel="noreferrer">
                      <Eye size={13} /> Open
                    </a>
                  </CardHead>
                  <iframe key={`${form.updated_at}:${shown}`} title="Preview" src={`/f/${form.id}?preview=1`} className="block h-[520px] w-full border-0 bg-panel" />
                </Panel>
                <Panel>
                  <CardHead label="Embed" />
                  <div className="flex flex-col gap-3 p-4">
                    <Copy text={embed} />
                    <Copy text={`${appBase()}/f/${form.id}`} />
                  </div>
                </Panel>
              </>
            ) : null}
          </div>
        </div>
        {form ? <Submissions sb={sb} form={form} /> : null}
      </div>
    </Page>
  );
}

function Submissions({ sb, form }: Pick<ViewProps, "sb"> & { form: FormRow }) {
  const list = useLoad(async () => must(await sb.from("form_submissions").select("id, answers, utm, page_url, spam, basis, contact_id, created_at").eq("form_id", form.id).order("created_at", { ascending: false }).limit(100)) as Submission[], `form:${form.id}:subs`);
  const reload = list.reload;
  useEffect(() => {
    if (form.status !== "live") return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [form.status, reload]);
  const emailKey = form.fields.find((f) => f.maps_to === "email")?.key ?? "email";
  const path = (u: string | null) => {
    if (!u) return "—";
    try {
      const x = new URL(u);
      return `${x.hostname}${x.pathname}`;
    } catch {
      return u;
    }
  };
  return (
    <Panel>
      <CardHead label="Answers" count={list.data?.filter((s) => !s.spam).length} />
      <ErrorNote message={list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Page</Th>
                <Th>Source</Th>
                <Th>Consent</Th>
                <Th className="w-28">When</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.map((s) => (
                <tr key={s.id} className={s.spam ? "text-faint" : ""}>
                  <Td className="max-w-[220px] truncate font-mono text-[12px]">
                    {String(s.answers[emailKey] ?? "—")} {s.spam ? <Badge>{SPAM[s.spam] ?? s.spam}</Badge> : null}
                  </Td>
                  <Td className="max-w-[220px] truncate text-muted">{path(s.page_url)}</Td>
                  <Td className="max-w-[200px] truncate text-muted">{[s.utm.utm_source, s.utm.utm_campaign].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td>{s.basis === "opt_in" ? <Badge tone="green">Opted in</Badge> : s.basis === "legitimate_interest" ? <Badge>Notice</Badge> : <Badge>None</Badge>}</Td>
                  <Td className="text-faint">{timeAgo(s.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
