"use client";

// Nurture emails (docs/marketing-platform.md M4, first step): a sequence with waits between emails. AI writes the
// steps from the brief, a person reads and approves each one, and contacts join from a segment or a form.

import { useState } from "react";
import { readStep, stepEmail } from "@/lib/nurture/email";
import { Branch, Check, Plus, Refresh, Trash, X } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import { SampleStats, ToolIntro } from "../ToolIntro";
import { Badge, Button, CardHead, ErrorNote, errorText, Field, Input, Loading, must, Page, Panel, postJson, Td, Th, timeAgo, useLoad, type Tone, type ViewProps } from "../ui";

type Nurture = { id: string; name: string; status: "draft" | "live" | "paused"; trigger: { kind?: string; segment_id?: string; form_id?: string }; topic_id: string | null; brief: string; exit_stages: string[]; updated_at: string };
type Step = { id: string; position: number; wait_days: number; ai: boolean; review_notes: string[]; approved_at: string | null; emails: { subject: string; preheader: string | null; html: string; text: string } };
type Enrollment = { id: string; status: string; step: number; next_at: string; exit_reason: string | null; contacts: { email_clean: string | null } | null };

const SEL = "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";
const STATUS: Record<Nurture["status"], [string, Tone]> = { draft: ["Draft", "gray"], live: ["Live", "green"], paused: ["Paused", "amber"] };
const STAGES = [
  { value: "mql", label: "MQL" },
  { value: "sql", label: "SQL" },
  { value: "opportunity", label: "Opportunity" },
  { value: "customer", label: "Customer" },
];
const EXIT: Record<string, string> = { reached_stage: "Reached stage", unsubscribed: "Unsubscribed", suppressed: "Suppressed", deleted: "Deleted", removed: "Removed" };

export function NurtureView({ sb, session, ws, id, navigate }: ViewProps) {
  if (id) return <NurturePage key={id} sb={sb} session={session} ws={ws} id={id} navigate={navigate} />;
  return <NurtureList sb={sb} ws={ws} navigate={navigate} />;
}

function NurtureList({ sb, ws, navigate }: Pick<ViewProps, "sb" | "ws" | "navigate">) {
  const list = useLoad(async () => must(await sb.from("nurtures").select("id, name, status, updated_at").eq("workspace_id", ws.id).order("updated_at", { ascending: false })) as Nurture[], ws.id);
  const add = (
    <Button onClick={() => navigate("workflows", "new")}>
      <Plus size={14} /> New nurture
    </Button>
  );
  return (
    <Page icon={<Branch size={16} />} title="Workflows" count={list.data?.length} actions={list.data?.length ? add : undefined}>
      <ErrorNote message={list.error} />
      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <ToolIntro
          action={add}
          title="Follow up with every lead, in your words"
          lead="Describe who it's for and what you offer. AI writes the emails from that brief only, you read and approve each one, and people join from a segment or a form and leave when they're ready for sales."
          features={[
            { title: "Approved before it sends", text: "Every step waits for a person. The AI lists anything you should check, and editing a step asks for approval again." },
            { title: "Every guard on", text: "Consent by region, unsubscribes, bounces, the frequency cap and quiet hours apply to each email as it leaves." },
            { title: "Leaves at the right time", text: "People leave when they reach a stage you pick, unsubscribe or bounce.", visual: <SampleStats items={[["active", "412"], ["done", "96"], ["to sales", "31"]]} /> },
          ]}
        />
      ) : (
        <Panel>
          <ul className="divide-y divide-line">
            {list.data.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => navigate("workflows", n.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-hover">
                  <span className="font-medium">{n.name}</span>
                  <span className="ml-auto flex items-center gap-3">
                    <span className="text-[12px] text-faint">{timeAgo(n.updated_at)}</span>
                    <Badge tone={STATUS[n.status][1]}>{STATUS[n.status][0]}</Badge>
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

function NurturePage({ sb, session, ws, id, navigate }: Pick<ViewProps, "sb" | "session" | "ws" | "navigate"> & { id: string }) {
  const isNew = id === "new";
  const n = useLoad(async () => (isNew ? null : (must(await sb.from("nurtures").select("id, name, status, trigger, topic_id, brief, exit_stages, updated_at").eq("id", id).maybeSingle()) as Nurture | null)), `nurture:${id}`);
  const opts = useLoad(async () => {
    const [segs, forms, topics] = await Promise.all([
      sb.from("segments").select("id, name").eq("workspace_id", ws.id).order("name"),
      sb.from("forms").select("id, name").eq("workspace_id", ws.id).order("name"),
      sb.from("topics").select("id, name").eq("workspace_id", ws.id).order("name"),
    ]);
    return { segs: (segs.data ?? []) as { id: string; name: string }[], forms: (forms.data ?? []) as { id: string; name: string }[], topics: (topics.data ?? []) as { id: string; name: string }[] };
  }, `${ws.id}:nurture-opts`);
  if ((!isNew && n.data === undefined) || !opts.data) return <Page icon={<Branch size={16} />} title="Workflows">{n.error ? <ErrorNote message={n.error} /> : <Loading />}</Page>;
  if (!isNew && !n.data) return <Page icon={<Branch size={16} />} title="Workflows"><ErrorNote message="Nurture not found." /></Page>;
  return <Editor sb={sb} session={session} ws={ws} navigate={navigate} n={n.data ?? null} opts={opts.data} reload={n.reload} />;
}

function Editor({ sb, session, ws, navigate, n, opts, reload }: Pick<ViewProps, "sb" | "session" | "ws" | "navigate"> & { n: Nurture | null; opts: { segs: { id: string; name: string }[]; forms: { id: string; name: string }[]; topics: { id: string; name: string }[] }; reload: () => void }) {
  const [name, setName] = useState(n?.name ?? "New nurture");
  const [who, setWho] = useState(n?.trigger.kind === "form" ? `form:${n.trigger.form_id}` : n?.trigger.segment_id ? `segment:${n.trigger.segment_id}` : "");
  const [topic, setTopic] = useState(n?.topic_id ?? "");
  const [brief, setBrief] = useState(n?.brief ?? "");
  const [exit, setExit] = useState<string[]>(n?.exit_stages ?? ["sql", "opportunity", "customer"]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const whoOptions = [...opts.segs.map((s) => ({ value: `segment:${s.id}`, label: `Segment · ${s.name}` })), ...opts.forms.map((f) => ({ value: `form:${f.id}`, label: `Form · ${f.name}` }))];

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
      const [kind, ref] = who.split(":");
      if (!kind) throw new Error("Pick who joins.");
      const nid = must(await sb.rpc("nurture_save", { p_ws: ws.id, p_id: n?.id ?? null, p_name: name, p_trigger: { kind, [`${kind}_id`]: ref }, p_topic: topic || null, p_brief: brief, p_exit: exit })) as string;
      if (!n) navigate("workflows", nid);
      else reload();
    });
  const status = (s: Nurture["status"]) => run("status", async () => (must(await sb.rpc("nurture_set_status", { p_id: n!.id, p_status: s })), reload()));

  return (
    <Page
      icon={<Branch size={16} />}
      title={n?.name ?? "New nurture"}
      actions={
        <span className="flex items-center gap-2">
          {n ? <Badge tone={STATUS[n.status][1]}>{STATUS[n.status][0]}</Badge> : null}
          {n && n.status !== "live" ? (
            <Button variant="ghost" disabled={!!busy} onClick={() => status("live")}>
              Go live
            </Button>
          ) : null}
          {n?.status === "live" ? (
            <Button variant="ghost" disabled={!!busy} onClick={() => status("paused")}>
              Pause
            </Button>
          ) : null}
          {n ? (
            <Button
              variant="plain"
              aria-label="Delete nurture"
              title="Delete nurture"
              onClick={() =>
                run("delete", async () => {
                  if (!(await askConfirm(`Delete ${n.name}?`, { body: "Everyone in it stops getting its emails.", ok: "Delete", danger: true }))) return;
                  must(await sb.rpc("nurture_delete", { p_id: n.id }));
                  navigate("workflows");
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
        <Panel>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Who joins">
              <Select className={SEL} value={who} onChange={setWho} options={whoOptions} placeholder="Pick a segment or form" />
            </Field>
            <Field label="Topic">
              <Select className={SEL} value={topic} onChange={setTopic} options={[{ value: "", label: "None" }, ...opts.topics.map((t) => ({ value: t.id, label: t.name }))]} />
            </Field>
            <Field label="Leaves at stage">
              <div className="flex h-9 flex-wrap items-center gap-3">
                {STAGES.map((s) => (
                  <label key={s.value} className="flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={exit.includes(s.value)} onChange={(e) => setExit(e.target.checked ? [...exit, s.value] : exit.filter((x) => x !== s.value))} /> {s.label}
                  </label>
                ))}
              </div>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Brief">
                <textarea
                  className="min-h-36 w-full rounded-md border border-line bg-panel px-3 py-2 text-[13.5px] leading-relaxed"
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="Who it's for, what you offer, proof you can stand behind, and the page to send them to (https://…)."
                />
              </Field>
            </div>
          </div>
        </Panel>
        {n ? <Steps sb={sb} session={session} n={n} onChange={reload} onError={setError} /> : null}
        {n ? <People sb={sb} n={n} /> : null}
      </div>
    </Page>
  );
}

function Steps({ sb, session, n, onChange, onError }: Pick<ViewProps, "sb" | "session"> & { n: Nurture; onChange: () => void; onError: (m: string) => void }) {
  const list = useLoad(async () => must(await sb.from("nurture_steps").select("id, position, wait_days, ai, review_notes, approved_at, emails(subject, preheader, html, text)").eq("nurture_id", n.id).order("position")) as unknown as Step[], `nurture:${n.id}:steps:${n.updated_at}`);
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const live = n.status === "live";
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    onError("");
    try {
      await fn();
      list.reload();
      onChange();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const draft = (body: object) => act("draft", () => postJson(session, "/api/nurture/draft", { nurtureId: n.id, ...body }));
  const steps = list.data ?? [];
  return (
    <Panel>
      <CardHead label="Emails" count={steps.length}>
        {!live ? (
          <span className="ml-auto flex items-center gap-2">
            <Select className="h-7 w-20 rounded-md border border-line bg-panel px-2 text-[12px]" value={count} onChange={setCount} options={[1, 2, 3, 4, 5, 6].map((v) => ({ value: v, label: String(v) }))} ariaLabel="How many" />
            <Button variant="ghost" className="h-7 px-2.5" disabled={!!busy} onClick={() => draft({ count })}>
              {busy === "draft" ? "Writing…" : "Write with AI"}
            </Button>
            <Button variant="plain" className="h-7 px-2" disabled={!!busy} onClick={() => setEditing("new")}>
              <Plus size={14} /> Email
            </Button>
          </span>
        ) : null}
      </CardHead>
      {!list.data ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-line">
          {steps.map((s, i) => (
            <li key={s.id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-faint">{i === 0 ? `Day ${s.wait_days}` : `+${s.wait_days} day${s.wait_days === 1 ? "" : "s"}`}</span>
                <span className="text-[14px] font-medium">{s.emails.subject}</span>
                {s.ai ? <Badge>AI</Badge> : null}
                {s.approved_at ? <Badge tone="green">Approved</Badge> : <Badge tone="amber">Needs approval</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  {!s.approved_at ? (
                    <Button variant="ghost" className="h-7 px-2.5" disabled={!!busy} onClick={() => act("approve", async () => must(await sb.rpc("nurture_step_approve", { p_step: s.id })))}>
                      <Check size={14} /> Approve
                    </Button>
                  ) : null}
                  <Button variant="plain" className="h-7 px-2" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                    Edit
                  </Button>
                  <Button variant="plain" className="h-7 px-2" disabled={!!busy} aria-label="Rewrite with AI" title="Rewrite with AI" onClick={() => draft({ stepId: s.id })}>
                    <Refresh size={14} />
                  </Button>
                  {!live ? (
                    <>
                      <Button variant="plain" className="h-7 px-2" disabled={i === 0 || !!busy} aria-label="Move up" title="Move up" onClick={() => act("move", async () => must(await sb.rpc("nurture_step_change", { p_step: s.id, p_action: "up" })))}>
                        ↑
                      </Button>
                      <Button variant="plain" className="h-7 px-2" disabled={i === steps.length - 1 || !!busy} aria-label="Move down" title="Move down" onClick={() => act("move", async () => must(await sb.rpc("nurture_step_change", { p_step: s.id, p_action: "down" })))}>
                        ↓
                      </Button>
                      <Button
                        variant="plain"
                        className="h-7 px-2"
                        aria-label="Delete email"
                        title="Delete email"
                        onClick={() =>
                          act("delete", async () => {
                            if (!(await askConfirm("Delete this email?", { ok: "Delete", danger: true }))) return;
                            must(await sb.rpc("nurture_step_change", { p_step: s.id, p_action: "delete" }));
                          })
                        }
                      >
                        <X size={14} />
                      </Button>
                    </>
                  ) : null}
                </span>
              </div>
              {s.emails.preheader ? <p className="text-[12.5px] text-muted">{s.emails.preheader}</p> : null}
              {editing === s.id ? (
                <StepForm step={s} onCancel={() => setEditing(null)} onSave={(v) => act("save", async () => (must(await sb.rpc("nurture_step_save", { p_nurture: n.id, p_step: s.id, ...v })), setEditing(null)))} />
              ) : (
                <pre className="border border-line bg-canvas p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{s.emails.text}</pre>
              )}
              {s.review_notes.length && !s.approved_at ? (
                <ul className="flex flex-col gap-1 border-l-2 border-amber-500 pl-3 text-[12.5px]">
                  {s.review_notes.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
          {editing === "new" ? (
            <li className="p-4">
              <StepForm step={null} onCancel={() => setEditing(null)} onSave={(v) => act("save", async () => (must(await sb.rpc("nurture_step_save", { p_nurture: n.id, p_step: null, ...v })), setEditing(null)))} />
            </li>
          ) : null}
        </ul>
      )}
    </Panel>
  );
}

type StepValues = { p_wait_days: number; p_subject: string; p_preheader: string; p_html: string; p_text: string; p_links: string[]; p_ai: boolean; p_notes: string[] };

function StepForm({ step, onSave, onCancel }: { step: Step | null; onSave: (v: StepValues) => void; onCancel: () => void }) {
  const parsed = step ? readStep(step.emails.html, step.emails.text) : { paragraphs: [], cta_label: "", cta_url: "" };
  const [wait, setWait] = useState(String(step?.wait_days ?? 2));
  const [subject, setSubject] = useState(step?.emails.subject ?? "");
  const [pre, setPre] = useState(step?.emails.preheader ?? "");
  const [body, setBody] = useState(parsed.paragraphs.join("\n\n"));
  const [label, setLabel] = useState(parsed.cta_label);
  const [url, setUrl] = useState(parsed.cta_url);
  const [error, setError] = useState("");
  const submit = () => {
    if (!subject.trim()) return setError("Add a subject.");
    if (url && !/^https:\/\/\S+$/.test(url)) return setError("The link must start with https://.");
    const e = stepEmail({ paragraphs: body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), cta_label: label.trim(), cta_url: url.trim() });
    onSave({ p_wait_days: Math.max(0, Math.min(90, Number(wait) || 0)), p_subject: subject.trim(), p_preheader: pre.trim(), p_html: e.html, p_text: e.text, p_links: e.links, p_ai: false, p_notes: [] });
  };
  return (
    <div className="grid gap-3 border border-line p-3 sm:grid-cols-2">
      <Field label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Wait before, in days">
        <Input type="number" min={0} max={90} value={wait} onChange={(e) => setWait(e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Preheader">
          <Input value={pre} onChange={(e) => setPre(e.target.value)} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Email">
          <textarea className="min-h-40 w-full rounded-md border border-line bg-panel px-3 py-2 text-[13.5px] leading-relaxed" value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
      <Field label="Button">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Read the guide" />
      </Field>
      <Field label="Link">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yoursite.com/guide" />
      </Field>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button onClick={submit}>Save email</Button>
        <Button variant="plain" onClick={onCancel}>
          Cancel
        </Button>
        <ErrorNote message={error} />
      </div>
    </div>
  );
}

function People({ sb, n }: Pick<ViewProps, "sb"> & { n: Nurture }) {
  const list = useLoad(async () => must(await sb.from("nurture_enrollments").select("id, status, step, next_at, exit_reason, contacts(email_clean)").eq("nurture_id", n.id).order("entered_at", { ascending: false }).limit(100)) as unknown as Enrollment[], `nurture:${n.id}:people:${n.updated_at}`);
  const [error, setError] = useState("");
  const count = (s: string) => list.data?.filter((e) => e.status === s).length ?? 0;
  return (
    <Panel>
      <CardHead label="People" count={list.data?.length}>
        {list.data?.length ? (
          <span className="ml-auto flex gap-3 text-[12px] text-muted">
            <span>Active {count("active")}</span>
            <span>Done {count("done")}</span>
            <span>Left {count("exited")}</span>
          </span>
        ) : null}
      </CardHead>
      <ErrorNote message={error || list.error} />
      {!list.data ? (
        <Loading />
      ) : list.data.length ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th>Next</Th>
              <Th>State</Th>
              <Th className="w-12">{""}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.data.map((e) => (
              <tr key={e.id}>
                <Td className="font-mono text-[12px]">{e.contacts?.email_clean ?? "—"}</Td>
                <Td className="text-muted">{e.status === "active" ? `Email ${e.step + 1} · ${new Date(e.next_at).toLocaleDateString()}` : "—"}</Td>
                <Td>{e.status === "active" ? <Badge tone="brand">Active</Badge> : e.status === "done" ? <Badge tone="green">Done</Badge> : <Badge>{EXIT[e.exit_reason ?? ""] ?? "Left"}</Badge>}</Td>
                <Td>
                  {e.status === "active" ? (
                    <Button
                      variant="plain"
                      className="h-7 px-2"
                      aria-label="Remove from nurture"
                      title="Remove from nurture"
                      onClick={async () => {
                        setError("");
                        try {
                          must(await sb.rpc("nurture_remove_contact", { p_enrollment: e.id }));
                          list.reload();
                        } catch (x) {
                          setError(errorText(x));
                        }
                      }}
                    >
                      <X size={14} />
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
