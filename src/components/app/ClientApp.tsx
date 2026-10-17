"use client";

import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase, type SupaConfig } from "@/lib/supa";
import { NAV, resolveRoute, type Route as NavRoute } from "@/lib/nav";
import { BarChart, Box, Branch, Contact, Dollar, FileText, FormIcon, ListIcon, LogOut, Mail, Megaphone, Settings, Users } from "../Icons";
import { Logo } from "../Logo";
import { AuthScreen } from "./AuthScreen";
import { DialogHost } from "./Dialogs";
import { Avatar, ErrorNote, errorText, mayLeave, must, type Role, type Route, type ViewProps, type Workspace } from "./ui";
import { ContactsView } from "./views/ContactsView";
import { CompaniesView, ObjectsView, OpportunitiesView } from "./views/RecordsViews";
import { SegmentsView } from "./views/SegmentsView";
import { AdsView, AnalyticsView, FormsView, PagesView, TemplatesView, WorkflowsView } from "./views/MarketingIntros";
import { SettingsView } from "./views/SettingsView";

// One icon per screen. The sidebar's groups are in src/lib/nav.ts.
const ICONS: Record<NavRoute, React.ReactNode> = {
  contacts: <Contact size={15} />,
  companies: <Users size={15} />,
  opportunities: <Dollar size={15} />,
  objects: <Box size={15} />,
  segments: <ListIcon size={15} />,
  templates: <Mail size={15} />,
  workflows: <Branch size={15} />,
  analytics: <BarChart size={15} />,
  forms: <FormIcon size={15} />,
  pages: <FileText size={15} />,
  ads: <Megaphone size={15} />,
  settings: <Settings size={15} />,
};

type Loc = { route: Route; id: string };
const WITH_ID = new Set<Route>(["contacts", "companies", "opportunities", "segments"]);

const readLoc = (): Loc => {
  const [, first = "", id = "", rest = ""] = window.location.pathname.split("/");
  const r = resolveRoute(first, rest ? `${id}/${rest}` : id);
  const [a = "", b = ""] = r.id.split("/");
  const uuid = (x: string) => /^[0-9a-f-]{36}$/.test(x);
  // Custom objects: /objects/<key> and /objects/<key>/<record id>.
  if (r.route === "objects") return { route: r.route, id: /^[a-z][a-z0-9_]{0,39}$/.test(a) ? (uuid(b) ? `${a}/${b}` : a) : "" };
  // Settings pages: /settings/<page>.
  if (r.route === "settings") return { route: r.route, id: /^[a-z_]{2,30}$/.test(a) ? a : "" };
  if (r.route === "segments" && a === "new") return { route: r.route, id: a };
  // Companies: the live visit feed, and an old account link that finds its company.
  if (r.route === "companies" && a === "visits") return { route: r.route, id: a };
  if (r.route === "companies" && a === "account" && uuid(b)) return { route: r.route, id: `account/${b}` };
  return { route: r.route, id: WITH_ID.has(r.route) && uuid(a) ? a : "" };
};

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
  const [loc, setLoc] = useState<Loc>({ route: "contacts", id: "" });
  const [error, setError] = useState("");
  const route = loc.route;

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [sb]);

  useEffect(() => {
    const sync = () => {
      const l = readLoc();
      setLoc(l);
      // Old and unknown addresses show where they landed.
      const want = `/${l.route}${l.id ? `/${l.id}` : ""}`;
      if (window.location.pathname !== want && !(l.route === "settings" && !l.id)) window.history.replaceState(null, "", want);
    };
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

  // The workspace's custom objects, listed in the sidebar after Opportunities.
  const [customObjects, setCustomObjects] = useState<{ key: string; plural: string }[]>([]);
  useEffect(() => {
    if (!ws) return;
    const load = () =>
      void sb
        .from("objects")
        .select("key, plural")
        .eq("workspace_id", ws.id)
        .eq("system", false)
        .order("created_at")
        .then(({ data }) => setCustomObjects((data ?? []) as { key: string; plural: string }[]));
    load();
    window.addEventListener("claritia:changed", load);
    return () => window.removeEventListener("claritia:changed", load);
  }, [sb, ws]);

  // Pages with unsaved changes get to ask first.
  const navigate = useCallback((r: Route, id = "") => {
    mayLeave().then((ok) => {
      if (!ok) return;
      window.history.pushState(null, "", `/${r}${id ? `/${id}` : ""}`);
      setLoc({ route: r, id });
    });
  }, []);

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
  if (!ws) return <Splash />;

  const props: ViewProps = { sb, session, ws, role, navigate, id: loc.id };
  const email = session.user.email ?? "";

  const objectLinks = customObjects.map((o) => {
    const on = route === "objects" && (loc.id === o.key || loc.id.startsWith(`${o.key}/`));
    return (
      <a
        key={`o-${o.key}`}
        href={`/objects/${o.key}`}
        onClick={(e) => {
          e.preventDefault();
          navigate("objects", o.key);
        }}
        aria-current={on && loc.id === o.key ? "page" : undefined}
        className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium ${on ? "bg-panel text-ink ring-1 ring-line" : "text-body hover:bg-hover hover:text-ink"}`}
      >
        <span className={on ? "text-ink" : "text-muted"}>{ICONS.objects}</span>
        <span className="truncate">{o.plural}</span>
      </a>
    );
  });
  const navLinks = NAV.map((n) => [
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
    </a>,
    n.route === "opportunities" ? objectLinks : null,
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
        {route === "contacts" ? (
          <ContactsView {...props} />
        ) : route === "companies" ? (
          <CompaniesView {...props} />
        ) : route === "opportunities" ? (
          <OpportunitiesView {...props} />
        ) : route === "objects" ? (
          <ObjectsView key={loc.id.split("/")[0]} {...props} />
        ) : route === "segments" ? (
          <SegmentsView {...props} />
        ) : route === "templates" ? (
          <TemplatesView />
        ) : route === "workflows" ? (
          <WorkflowsView />
        ) : route === "analytics" ? (
          <AnalyticsView />
        ) : route === "forms" ? (
          <FormsView />
        ) : route === "pages" ? (
          <PagesView />
        ) : route === "ads" ? (
          <AdsView />
        ) : (
          <SettingsView {...props} />
        )}
      </main>
    </div>
  );
}
