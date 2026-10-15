// Which screens a workspace sees, from its features (workspaces.features, supabase/migrations/020_foundation.sql).
// 'testing' is the testing product; 'marketing' is the marketing platform (docs/marketing-platform.md).
// A workspace with only testing sees the app exactly as before.

export type Route =
  | "contacts"
  | "leads"
  | "companies"
  | "objects"
  | "visitors"
  | "accounts"
  | "people"
  | "journeys"
  | "pages"
  | "reports"
  | "tests"
  | "blocks"
  | "map"
  | "runs"
  | "environments"
  | "schedules"
  | "approvals"
  | "insights"
  | "settings";

export type NavItem = { route: Route; label: string; group?: string };

const MARKETING: NavItem[] = [
  { route: "contacts", label: "Contacts", group: "Audience" },
  { route: "leads", label: "Leads" },
  { route: "companies", label: "Companies" },
  { route: "accounts", label: "Accounts" },
  { route: "visitors", label: "Visitors" },
  { route: "journeys", label: "Journeys", group: "Engage" },
  { route: "pages", label: "Pages" },
  { route: "reports", label: "Reports", group: "Prove" },
];

// The testing product's own groups, as before.
const TESTING: NavItem[] = [
  { route: "tests", label: "Tests", group: "Authoring" },
  { route: "blocks", label: "Blocks" },
  { route: "map", label: "Map" },
  { route: "runs", label: "Runs", group: "Execution" },
  { route: "environments", label: "Environments" },
  { route: "schedules", label: "Schedules", group: "Management" },
  { route: "approvals", label: "Approvals" },
  { route: "insights", label: "Insights", group: "Analytics" },
];

// Screens reached from other screens, never from the sidebar.
const LINKED: Partial<Record<Route, string>> = { people: "marketing", objects: "marketing" };

export const TESTING_ROUTES = new Set<Route>(TESTING.map((n) => n.route));

const SETTINGS: NavItem = { route: "settings", label: "Settings", group: "" };

export function navFor(features: readonly string[]): NavItem[] {
  const marketing = features.includes("marketing");
  const testing = features.includes("testing");
  if (!marketing) return [...TESTING, SETTINGS];
  // Both: the testing screens sit together under one Testing group, after the marketing ones.
  const testingGroup = testing ? TESTING.map((n, i) => ({ route: n.route, label: n.label, ...(i === 0 ? { group: "Testing" } : {}) })) : [];
  return [...MARKETING, ...testingGroup, SETTINGS];
}

export const defaultRoute = (features: readonly string[]): Route => (features.includes("marketing") ? "visitors" : "tests");

/** The route to show: the one asked for if this workspace has it, otherwise its first screen. */
export const allowedRoute = (features: readonly string[], route: Route): Route =>
  navFor(features).some((n) => n.route === route) || (LINKED[route] && features.includes(LINKED[route])) ? route : defaultRoute(features);

/** The project picker belongs to the testing product's screens. */
export const showsProjectPicker = (features: readonly string[], route: Route) => features.includes("testing") && (!features.includes("marketing") || TESTING_ROUTES.has(route) || route === "settings");
