// The plans, in one place: the homepage, pricing.md, Settings and the database limits (plan_limits in
// supabase/migrations/005_inbox_billing.sql) all follow this list. Change both together.

export type PlanId = "free" | "starter" | "team" | "business";

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in dollars. Null is a custom price. */
  price: number | null;
  /** Null means no limit. */
  projects: number | null;
  minutes: number | null;
  credits: number | null;
  features: string[];
};

export const PLANS: Plan[] = [
  { id: "free", name: "Free", price: 0, projects: 1, minutes: 300, credits: 200, features: ["Video, trace and network log for every run", "Test inboxes"] },
  { id: "starter", name: "Starter", price: 49, projects: 3, minutes: 2000, credits: 2000, features: ["GitHub App", "Schedules"] },
  { id: "team", name: "Team", price: 199, projects: null, minutes: 10000, credits: 10000, features: ["MCP server", "PR-aware runs", "Slack alerts"] },
  { id: "business", name: "Business", price: null, projects: null, minutes: null, credits: null, features: ["SSO", "Private runners", "Data region", "Managed test writing"] },
];

export const planById = (id: string | null | undefined) => PLANS.find((p) => p.id === id) ?? PLANS[0]!;

/** "2,000" or "Unlimited". */
export const amount = (n: number | null) => (n === null ? "Unlimited" : n.toLocaleString("en-US"));
