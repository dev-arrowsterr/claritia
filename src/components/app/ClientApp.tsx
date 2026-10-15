"use client";

import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase, type SupaConfig } from "@/lib/supa";
import { allowedRoute, navFor, showsProjectPicker, type Route as NavRoute } from "@/lib/nav";
import { BarChart, Box, Branch, Check, Clock, Contact, Eye, FileText, Globe, ListIcon, LogOut, MapIcon, Play, Settings, Users } from "../Icons";
import { Logo } from "../Logo";
import { AuthScreen } from "./AuthScreen";
import { askText, DialogHost } from "./Dialogs";
import { Select } from "./Select";
import { Avatar, ErrorNote, errorText, mayLeave, must, type Project, type Role, type Route, type ViewProps, type Workspace } from "./ui";
import { ApprovalsView } from "./views/ApprovalsView";
import { BlocksView } from "./views/BlocksView";
import { EnvironmentsView } from "./views/EnvironmentsView";
import { InsightsView } from "./views/InsightsView";
import { SchedulesView } from "./views/SchedulesView";
import { RunsView } from "./views/RunsView";
import { ConnectExtension } from "./ConnectExtension";
import { MapView } from "./views/MapView";
import { AccountsView } from "./views/AccountsView";
import { ContactsView } from "./views/ContactsView";
import { JourneysView, PagesView, ReportsView } from "./views/MarketingIntros";
import { VisitorsView } from "./views/VisitorsView";
import { SettingsView } from "./views/SettingsView";
import { TestsView } from "./views/TestsView";

// One icon per screen. Which screens a workspace sees comes from its features (src/lib/nav.ts): the testing product's
// four modules (AI works inside each: the Writer in Authoring, the Healer in Execution, smart retries in Management
// and the Judge in Analytics), the marketing platform's screens, or both.
const ICONS: Record<NavRoute, React.ReactNode> = {
  contacts: <Contact size={15} />,
  visitors: <Eye size={15} />,
  accounts: <Users size={15} />,
  people: <Users size={15} />,
  journeys: <Branch size={15} />,
  pages: <FileText size={15} />,
  reports: <BarChart size={15} />,
  tests: <ListIcon size={15} />,
  blocks: <Box size={15} />,
  map: <MapIcon size={15} />,
  runs: <Play size={15} />,
  environments: <Globe size={15} />,
  schedules: <Clock size={15} />,
  approvals: <Check size={15} />,
  insights: <BarChart size={15} />,
  settings: <Settings size={15} />,
};

const PROJECT_KEY = "claritia:project";
const NEW_PROJECT = "__new";

type Loc = { route: Route; id: string };
const WITH_ID = new Set<Route>(["tests", "blocks", "runs", "approvals", "accounts", "contacts"]);

const readLoc = (): Loc => {
  const [, first = "", id = ""] = window.location.pathname.split("/");
  const route = first in ICONS ? (first as Route) : "tests";
  return { route, id: WITH_ID.has(route) && /^[0-9a-f-]{36}$/.test(id) ? id : "" };
};

function remember(id: string) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {}
}

function recall() {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function Splash() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <span className="animate-pulse">
        <Logo compact />
      </span>
    </main>
  );
}

export function ClientApp({ config }: { config: SupaConfig }) {
  const sb = useMemo(() => getSupabase(config), [config]);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [role, setRole] = useState<Role>("member");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loc, setLoc] = useState<Loc>({ route: "tests", id: "" });
  const [error, setError] = useState("");
  // The screen asked for, or this workspace's first screen when it doesn't have that one.
  const route = ws ? allowedRoute(ws.features, loc.route) : loc.route;
  // Keep the address in step when the screen asked for isn't this workspace's.
  useEffect(() => {
    if (ws && route !== loc.route) window.history.replaceState(null, "", `/${route}`);
  }, [ws, route, loc.route]);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [sb]);

  useEffect(() => {
    const sync = () => setLoc(readLoc());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const userId = session?.user.id;

  // Your workspace, made on first sign-in.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const id = must(await sb.rpc("ensure_workspace")) as string;
      const w = must(await sb.from("workspaces").select("id, name, features").eq("id", id).single()) as Workspace;
      const m = must(await sb.from("workspace_members").select("role").eq("workspace_id", id).eq("user_id", userId).single()) as { role: Role };
      setWs(w);
      setRole(m.role);
    })().catch((e) => setError(errorText(e)));
  }, [sb, userId]);

  // Your projects, and which one is open: the one asked for, the last one you used, or the first.
  const loadProjects = useCallback(
    (select?: string) => {
      if (!ws) return;
      sb.from("projects")
        .select("id, name, workspace_id, created_at")
        .eq("workspace_id", ws.id)
        .order("created_at")
        .then((res) => {
          if (res.error) return setError(res.error.message);
          const list = res.data as Project[];
          const want = select ?? recall();
          const pick = list.find((p) => p.id === want) ?? list[0] ?? null;
          setProjects(list);
          setProjectId(pick?.id ?? null);
          if (pick) remember(pick.id);
        });
    },
    [sb, ws],
  );

  useEffect(() => loadProjects(), [loadProjects]);

  // How many fixes wait for approval in the open project, for the sidebar.
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    const count = () =>
      void sb
        .from("heals")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId)
        .eq("status", "pending")
        .then(({ count: n }) => setWaiting(n ?? 0));
    count();
    window.addEventListener("claritia:changed", count);
    const t = setInterval(count, 60_000);
    return () => {
      window.removeEventListener("claritia:changed", count);
      clearInterval(t);
    };
  }, [sb, projectId, loc]);

  // Pages with unsaved changes get to ask first.
  const navigate = useCallback((r: Route, id = "") => {
    mayLeave().then((ok) => {
      if (!ok) return;
      window.history.pushState(null, "", `/${r}${id ? `/${id}` : ""}`);
      setLoc({ route: r, id });
    });
  }, []);

  async function newProject() {
    if (!ws) return;
    const name = await askText("New project", { placeholder: "My app", ok: "Create" });
    if (!name) return;
    try {
      const p = must(await sb.from("projects").insert({ workspace_id: ws.id, name }).select("id").single()) as { id: string };
      loadProjects(p.id);
      navigate("tests");
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (session === undefined) return <Splash />;
  if (!session) return <AuthScreen sb={sb} />;
  if (error && !ws)
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md space-y-4 border border-line bg-panel p-7">
          <Logo />
          <ErrorNote message={error} />
        </div>
      </main>
    );
  if (!ws || projects === null) return <Splash />;
  if (window.location.pathname === "/extension") return <ConnectExtension sb={sb} session={session} ws={ws} />;

  const project = projects.find((p) => p.id === projectId) ?? null;
  const props: ViewProps = { sb, session, ws, role, project, projectsChanged: loadProjects, navigate, id: loc.id };
  const email = session.user.email ?? "";
  const options = [...projects.map((p) => ({ value: p.id, label: p.name })), { value: NEW_PROJECT, label: "New project…" }];
  const pickProject = async (v: string) => {
    if (!(await mayLeave())) return;
    if (v === NEW_PROJECT) return void newProject();
    setProjectId(v);
    remember(v);
    if (loc.id) navigate(loc.route);
  };

  const navLinks = navFor(ws.features).map((n) => [
    n.group !== undefined ? (
      <p key={`g-${n.route}`} className={`hidden px-2.5 font-mono text-[10px] tracking-[0.12em] text-faint uppercase md:block ${n.group ? "mt-3 mb-1" : "mt-3 border-t border-line pt-3"}`}>
        {n.group}
      </p>
    ) : null,
    <a
      key={n.route}
      href={`/${n.route}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(n.route);
      }}
      aria-current={route === n.route && !loc.id ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium ${route === n.route ? "bg-panel text-ink ring-1 ring-line" : "text-body hover:bg-hover hover:text-ink"}`}
    >
      <span className={route === n.route ? "text-ink" : "text-muted"}>{ICONS[n.route]}</span>
      {n.label}
      {n.route === "approvals" && waiting ? <span className="ml-auto bg-brand px-1.5 font-mono text-[10px] leading-4 text-white">{waiting}</span> : null}
    </a>,
  ]);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-canvas md:flex-row">
      <DialogHost />
      {/* Sidebar on wide screens, a top bar on phones */}
      <aside className="flex shrink-0 flex-col gap-3 border-b border-line bg-side p-3 md:h-full md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-1">
          <Logo />
          <span className="truncate font-mono text-[10px] tracking-[0.08em] text-faint uppercase">{ws.name}</span>
        </div>
        {showsProjectPicker(ws.features, route) ? (
        <Select
          value={project?.id ?? ""}
          options={options}
          onChange={pickProject}
          ariaLabel="Project"
          placeholder="No project yet"
          className="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] font-medium hover:border-line-strong"
        />
        ) : null}
        <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">{navLinks}</nav>
        <div className="mt-auto hidden items-center gap-2 border-t border-line px-1 pt-3 md:flex">
          <Avatar label={email} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{email}</span>
          <button type="button" aria-label="Sign out" title="Sign out" onClick={() => sb.auth.signOut()} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink">
            <LogOut size={14} />
          </button>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1">
        {error ? (
          <div className="border-b border-line bg-panel p-3">
            <ErrorNote message={error} />
          </div>
        ) : null}
        {route === "contacts" ? <ContactsView {...props} /> : route === "visitors" ? <VisitorsView {...props} /> : route === "accounts" ? <AccountsView {...props} /> : route === "journeys" ? <JourneysView /> : route === "pages" ? <PagesView /> : route === "reports" ? <ReportsView /> : route === "tests" ? <TestsView {...props} /> : route === "blocks" ? <BlocksView {...props} /> : route === "map" ? <MapView {...props} /> : route === "runs" ? <RunsView {...props} /> : route === "approvals" ? <ApprovalsView {...props} /> : route === "environments" ? <EnvironmentsView {...props} /> : route === "schedules" ? <SchedulesView {...props} /> : route === "insights" ? <InsightsView {...props} /> : <SettingsView {...props} />}
      </main>
    </div>
  );
}
