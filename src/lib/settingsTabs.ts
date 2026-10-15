// Settings pages, grouped the way the Settings sidebar shows them (same layout as Arrowsterr).

export type SettingsTab = "sites" | "identity" | "icp" | "account_alerts" | "project" | "github" | "test_alerts" | "workspace" | "keys" | "plan" | "profile";
export type SettingsGroup = { label: string; tabs: { id: SettingsTab; label: string }[] };

export function settingsGroups(features: readonly string[], hasProject: boolean): SettingsGroup[] {
  const marketing = features.includes("marketing");
  const testing = features.includes("testing") || !marketing;
  const groups: SettingsGroup[] = [];
  if (marketing) {
    groups.push({ label: "Website", tabs: [{ id: "sites", label: "Sites" }, { id: "identity", label: "Identity" }] });
    groups.push({ label: "Scoring", tabs: [{ id: "icp", label: "Ideal customer" }, { id: "account_alerts", label: "Account alerts" }] });
  }
  if (testing && hasProject) {
    groups.push({ label: "Testing", tabs: [{ id: "project", label: "Project" }, { id: "github", label: "GitHub" }, { id: "test_alerts", label: "Alerts" }] });
  }
  groups.push({
    label: "Workspace",
    tabs: [{ id: "workspace", label: "General" }, { id: "keys", label: "API keys" }, ...(testing ? [{ id: "plan" as const, label: "Plan" }] : [])],
  });
  groups.push({ label: "Account", tabs: [{ id: "profile", label: "Profile" }] });
  return groups;
}
