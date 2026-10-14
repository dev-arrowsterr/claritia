"use client";

import { useState } from "react";
import { stepId } from "@/lib/testfile";
import { Globe, Key, ListIcon, Play, Plus } from "../../Icons";
import { askText } from "../Dialogs";
import { announceChange, Badge, Button, StatusTag, Empty, ErrorNote, errorText, Field, hostOf, Input, Loading, must, Page, postJson, PriorityBars, cleanUrl, Th, timeAgo, useLoad, type Environment, type ViewProps } from "../ui";
import { Proposals } from "./Proposals";
import { latestRuns } from "./RunsView";
import { TestView, type TestRow } from "./TestView";

type ListRow = Pick<TestRow, "id" | "name" | "use_case" | "priority" | "steps" | "updated_at">;

const DEMO_SITE = "https://demo.playwright.dev/todomvc";

/** Tests to start from. Each becomes a real test with these steps, ready to run. */
const TRY: { name: string; useCase: string; steps: [kind: "do" | "check", text: string][]; demoOnly?: boolean }[] = [
  {
    name: "Add and finish a todo",
    useCase: "Todos",
    demoOnly: true,
    steps: [
      ["do", "Add a todo called Buy milk"],
      ["do", "Add a todo called Walk the dog"],
      ["do", "Mark Buy milk as done"],
      ["check", "1 item is left"],
    ],
  },
  {
    name: "Sign up with a test inbox",
    useCase: "Sign up",
    steps: [
      ["do", "Open the sign-up page"],
      ["do", "Sign up with a new test inbox email"],
      ["do", "Enter the code from the email, or open the link in it"],
      ["check", "The account is created"],
    ],
  },
  {
    name: "Log in",
    useCase: "Sign in",
    steps: [
      ["do", "Log in with the test account"],
      ["check", "The dashboard shows"],
    ],
  },
  {
    name: "Contact form",
    useCase: "Lead capture",
    steps: [
      ["do", "Open the contact page"],
      ["do", "Fill in the contact form"],
      ["do", "Submit it"],
      ["check", "It says thanks"],
    ],
  },
];

/** The first screen: a site address and a test login. Makes the project and its staging environment. */
function StartScreen({ sb, session, ws, project, projectsChanged }: ViewProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [url, setUrl] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const base = cleanUrl(url);
    if (!base) return setError("Enter your site's address, like staging.acme.com.");
    setBusy(true);
    setError("");
    try {
      const projectId =
        project?.id ?? (must(await sb.from("projects").insert({ workspace_id: ws.id, name: name.trim() || hostOf(base) }).select("id").single()) as { id: string }).id;
      const env = must(await sb.from("environments").insert({ project_id: projectId, name: "staging", base_url: base }).select("id").single()) as { id: string };
      const secrets: [string, string][] = [
        ["LOGIN_EMAIL", loginEmail.trim()],
        ["LOGIN_PASSWORD", password],
      ];
      for (const [key, value] of secrets) {
        if (value) await postJson(session, "/api/secrets", { environmentId: env.id, name: key, value });
      }
      projectsChanged(projectId);
      announceChange();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const features = [
    { icon: <ListIcon size={16} />, title: "Describe", text: "Write a user flow the way you'd explain it to a new teammate." },
    { icon: <Play size={16} />, title: "Run", text: "Claritia drives a real browser and saves the video, screenshots and logs." },
    { icon: <Key size={16} />, title: "Heal", text: "When your UI changes, Claritia proposes the fix and waits for your yes." },
  ];

  return (
    <Page icon={<ListIcon size={14} />} title="Tests">
      <section className="mx-auto flex max-w-5xl flex-col gap-7 py-4">
        <div className="flex flex-col gap-4">
          <p className="fig">{"// fig. 00 — start here"}</p>
          <h2 className="max-w-3xl text-[32px] leading-[1.1] font-medium tracking-[-0.03em]">Test your app in plain English.</h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-body">Add the site you want to test. If it needs a login, add a test account too. The password is sealed before it&apos;s saved.</p>
        </div>
        <form onSubmit={start} className="frame grid max-w-2xl gap-4 border border-line bg-panel p-5 sm:grid-cols-2">
          {project ? null : (
            <div className="sm:col-span-2">
              <Field label="Project name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Storefront" maxLength={80} />
              </Field>
            </div>
          )}
          <div className="sm:col-span-2">
            <Field label="Site address">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="staging.acme.com" required autoFocus inputMode="url" />
            </Field>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              Try
              <button
                type="button"
                onClick={() => {
                  setUrl(DEMO_SITE);
                  if (!project && !name) setName("Demo todo app");
                }}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[12px] text-ink hover:border-line-strong"
              >
                demo.playwright.dev/todomvc
              </button>
            </p>
          </div>
          <Field label="Test login email">
            <Input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="qa@acme.com" autoComplete="off" />
          </Field>
          <Field label="Test login password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : project ? "Save" : "Create project"}
            </Button>
          </div>
          {error ? (
            <div className="sm:col-span-2">
              <ErrorNote message={error} />
            </div>
          ) : null}
        </form>
        <div className="grid gap-5 sm:grid-cols-3">
          {features.map((f, i) => (
            <div key={f.title} className="flex flex-col border border-line bg-panel">
              <p className="fig border-b border-line bg-canvas px-4 py-2.5">{`// fig. ${String(i + 1).padStart(2, "0")}`}</p>
              <div className="flex flex-1 flex-col gap-2 p-5">
                <span className="text-muted">{f.icon}</span>
                <h3 className="text-[15px] font-medium">{f.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-body">{f.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

function TestList(props: ViewProps & { env: Environment }) {
  const { sb, project, navigate, env } = props;
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const list = useLoad(
    async () => must(await sb.from("tests").select("id, name, use_case, priority, steps, updated_at").eq("project_id", project!.id).order("use_case").order("name")) as ListRow[],
    project!.id,
  );
  const last = useLoad(() => latestRuns(sb, project!.id), project!.id);

  const create = async () => {
    const name = await askText("New test", { placeholder: "Checkout with a coupon", ok: "Create" });
    if (!name) return;
    try {
      const row = must(await sb.from("tests").insert({ project_id: project!.id, name, steps: [{ id: stepId(), kind: "do", text: "" }] }).select("id").single()) as { id: string };
      navigate("tests", row.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const startFrom = async (t: (typeof TRY)[number]) => {
    try {
      const steps = t.steps.map(([kind, text]) => ({ id: stepId(), kind, text }));
      const row = must(await sb.from("tests").insert({ project_id: project!.id, name: t.name, use_case: t.useCase, steps }).select("id").single()) as { id: string };
      navigate("tests", row.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const groups = new Map<string, ListRow[]>();
  for (const t of list.data ?? []) groups.set(t.use_case, [...(groups.get(t.use_case) ?? []), t]);

  return (
    <Page
      icon={<ListIcon size={14} />}
      title="Tests"
      count={list.data?.length}
      flush={!!list.data?.length}
      actions={
        <>
          <Button variant="ghost" onClick={() => setAsking(true)} disabled={asking}>
            Plan tests
          </Button>
          <Button onClick={create}>
            <Plus size={13} />
            New test
          </Button>
        </>
      }
    >
      <Proposals sb={sb} project={project!} navigate={navigate} asking={asking} onAsked={() => setAsking(false)} onAccepted={list.reload} />
      {error || list.error ? (
        <div className="p-4">
          <ErrorNote message={error || list.error} />
        </div>
      ) : null}
      {!list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10">
          <Empty icon={<ListIcon size={16} />} title="Your tests will show up here.">
            <span className="inline-flex items-center gap-1.5">
              <Globe size={13} />
              {env.name} · {hostOf(env.base_url)}
            </span>
          </Empty>
          <p className="section-head">Try</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {TRY.filter((t) => !t.demoOnly || env.base_url.startsWith(DEMO_SITE)).map((t) => (
              <button key={t.name} type="button" onClick={() => startFrom(t)} className="flex flex-col gap-2 border border-line bg-panel p-4 text-left hover:border-line-strong">
                <span className="text-[14px] font-medium">{t.name}</span>
                <ol className="space-y-1 text-[12.5px] text-muted">
                  {t.steps.map(([kind, text], i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-4 shrink-0 font-mono text-faint">{i + 1}</span>
                      <span className="truncate">{kind === "check" ? `Check: ${text}` : text}</span>
                    </li>
                  ))}
                </ol>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th className="w-32">Status</Th>
              <Th className="hidden w-28 md:table-cell">Priority</Th>
              <Th className="hidden w-20 sm:table-cell">Steps</Th>
              <Th className="hidden w-28 md:table-cell">Updated</Th>
            </tr>
          </thead>
          <tbody>
            {[...groups].map(([useCase, rows]) => (
              <TestGroup key={useCase} useCase={useCase} rows={rows} last={last.data} open={(id) => navigate("tests", id)} />
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

function TestGroup({ useCase, rows, last, open }: { useCase: string; rows: ListRow[]; last: Awaited<ReturnType<typeof latestRuns>> | null; open: (id: string) => void }) {
  return (
    <>
      <tr>
        <td colSpan={5} className="h-9 border-b border-line bg-canvas px-4">
          <span className="flex items-center gap-2 text-[12.5px] font-medium">
            <span className="size-1.5 rounded-full bg-ink" />
            {useCase}
            <span className="font-mono text-[11px] text-faint">{rows.length}</span>
          </span>
        </td>
      </tr>
      {rows.map((t) => (
        <tr key={t.id} onClick={() => open(t.id)} className="cursor-pointer hover:bg-hover">
          <td className="h-12 border-b border-line px-4 text-[13.5px]">
            <a
              href={`/tests/${t.id}`}
              onClick={(e) => {
                e.preventDefault();
                open(t.id);
              }}
              className="font-medium text-ink"
            >
              {t.name}
            </a>
          </td>
          <td className="border-b border-line px-4">{last?.get(t.id) ? <StatusTag status={last.get(t.id)!.status} /> : <Badge>Not run</Badge>}</td>
          <td className="hidden border-b border-line px-4 md:table-cell">
            <PriorityBars value={t.priority} />
          </td>
          <td className="hidden border-b border-line px-4 font-mono text-[12px] text-muted sm:table-cell">{t.steps.length}</td>
          <td className="hidden border-b border-line px-4 text-[12px] text-muted md:table-cell">{timeAgo(t.updated_at)}</td>
        </tr>
      ))}
    </>
  );
}

export function TestsView(props: ViewProps) {
  const { sb, project, id } = props;
  const envs = useLoad(
    async () => (project ? (must(await sb.from("environments").select("id, project_id, name, base_url, created_at").eq("project_id", project.id).order("created_at")) as Environment[]) : []),
    project?.id ?? "none",
  );

  if (!project) return <StartScreen {...props} />;
  if (id) return <TestView key={id} {...props} />;
  if (envs.error)
    return (
      <Page icon={<ListIcon size={14} />} title="Tests">
        <ErrorNote message={envs.error} />
      </Page>
    );
  if (!envs.data) return <Loading />;
  if (!envs.data.length) return <StartScreen {...props} />;
  return <TestList {...props} env={envs.data[0]!} />;
}
