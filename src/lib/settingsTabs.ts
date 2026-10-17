// Settings pages, grouped the way the Settings sidebar shows them (same layout as Arrowsterr).

export type SettingsTab =
  | "sources" | "imports" | "sync_log" | "fields" | "objects" | "sending" | "team" | "sites" | "identity" | "icp" | "lead_scoring" | "account_alerts" | "workspace" | "keys" | "profile";
export type SettingsGroup = { label: string; tabs: { id: SettingsTab; label: string }[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "CRM",
    tabs: [{ id: "sources", label: "Connection" }, { id: "imports", label: "Imports" }, { id: "sync_log", label: "Sync log" }, { id: "fields", label: "Fields" }, { id: "objects", label: "Objects" }],
  },
  { label: "Email", tabs: [{ id: "sending", label: "Sending domains" }] },
  { label: "Team", tabs: [{ id: "team", label: "Members" }] },
  { label: "Website", tabs: [{ id: "sites", label: "Sites" }, { id: "identity", label: "Identity" }] },
  { label: "Scoring", tabs: [{ id: "icp", label: "Ideal customer" }, { id: "lead_scoring", label: "Lead scoring" }, { id: "account_alerts", label: "Account alerts" }] },
  { label: "Workspace", tabs: [{ id: "workspace", label: "General" }, { id: "keys", label: "API keys" }] },
  { label: "Account", tabs: [{ id: "profile", label: "Profile" }] },
];

/** The page for an address: old names land on their new pages, unknown ones on the first. */
export function settingsTab(id: string): SettingsTab {
  const moved: Record<string, SettingsTab> = { suite: "sources", tools: "sources", domains: "sending" };
  const all = SETTINGS_GROUPS.flatMap((g) => g.tabs.map((t) => t.id));
  return (all as string[]).includes(id) ? (id as SettingsTab) : (moved[id] ?? "sources");
}
