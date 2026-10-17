import { briefDomains, claudeDrafter, draftSteps, stepEmail } from "@/lib/nurture/draft";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// AI drafts for a nurture: POST { nurtureId, count } appends that many steps (1 to 6); { nurtureId, stepId } rewrites
// one step. Steps are saved as the person who asked, unapproved, with the AI's review notes.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "AI isn't set up on the server (ANTHROPIC_API_KEY)." }, { status: 503 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "The server is not set up for this." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { nurtureId?: unknown; count?: unknown; stepId?: unknown };
  const id = typeof body.nurtureId === "string" && /^[0-9a-f-]{36}$/.test(body.nurtureId) ? body.nurtureId : "";
  // Read through the person's own client: no row means not their workspace.
  const { data: n } = await auth.sb.from("nurtures").select("id, workspace_id, brief, status, workspaces(name)").eq("id", id).maybeSingle();
  if (!n) return Response.json({ error: "Nurture not found." }, { status: 404 });
  if (n.brief.trim().length < 40) return Response.json({ error: "Write a brief first: who it's for, what you offer, and what's true about it." }, { status: 400 });
  const { data: steps } = await auth.sb.from("nurture_steps").select("id, position, wait_days, emails(subject, text)").eq("nurture_id", id).order("position");
  const list = (steps ?? []) as unknown as { id: string; position: number; wait_days: number; emails: { subject: string; text: string } }[];
  const stepId = typeof body.stepId === "string" ? body.stepId : null;
  const target = stepId ? list.find((s) => s.id === stepId) : null;
  if (stepId && !target) return Response.json({ error: "Step not found." }, { status: 404 });
  if (!target && n.status === "live") return Response.json({ error: "Pause the nurture to add steps." }, { status: 409 });
  const count = target ? 1 : Math.max(1, Math.min(6, Math.round(Number(body.count) || 3)));

  const { data: sites } = await db.from("sites").select("domain, extra_domains").eq("workspace_id", n.workspace_id);
  const domains = [...new Set([...(sites ?? []).flatMap((s) => [s.domain, ...(s.extra_domains ?? [])]), ...briefDomains(n.brief)])];
  const ws = (n.workspaces as unknown as { name: string } | null)?.name ?? "";
  try {
    const out = await draftSteps((fn, args) => db.rpc(fn, args), claudeDrafter(apiKey), n.workspace_id, {
      workspace: ws,
      brief: n.brief,
      domains,
      existing: list.map((s) => ({ subject: s.emails.subject, text: s.emails.text })),
      count,
      replace: target ? target.position : null,
    });
    const saved: string[] = [];
    for (const s of out.steps) {
      const e = stepEmail(s);
      const { data, error } = await auth.sb.rpc("nurture_step_save", {
        p_nurture: id,
        p_step: target?.id ?? null,
        p_wait_days: target ? target.wait_days : s.wait_days,
        p_subject: s.subject,
        p_preheader: s.preheader,
        p_html: e.html,
        p_text: e.text,
        p_links: e.links,
        p_ai: true,
        p_notes: s.review_notes,
      });
      if (error) return Response.json({ error: error.message }, { status: 400 });
      saved.push(data as string);
    }
    return Response.json({ ok: true, steps: saved, cached: out.cached });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
