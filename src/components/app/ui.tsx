"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Route } from "@/lib/nav";
export type { Route };
export type Workspace = { id: string; name: string; features: string[] };
export type Project = { id: string; name: string; workspace_id: string; created_at: string };
export type Environment = { id: string; project_id: string; name: string; base_url: string; created_at: string };
export type Secret = { id: string; environment_id: string; name: string; updated_at: string };
export type Role = "owner" | "member";

export type ViewProps = {
  sb: SupabaseClient;
  session: Session;
  ws: Workspace;
  role: Role;
  project: Project | null;
  projectsChanged: (select?: string) => void;
  navigate: (r: Route, id?: string) => void;
  /** The record in the address, like a test's id in /tests/<id>. */
  id: string;
};

// A page with unsaved changes can ask before anyone leaves it, from the sidebar or the back button.
let leaveGuard: (() => Promise<boolean>) | null = null;
export const setLeaveGuard = (fn: (() => Promise<boolean>) | null) => {
  leaveGuard = fn;
};
export const mayLeave = () => (leaveGuard ? leaveGuard() : Promise.resolve(true));

/** Tell every loaded page that data changed, so lists reload. */
export const announceChange = () => window.dispatchEvent(new Event("claritia:changed"));

/** Load data once, and again when `reload` is called or `key` changes. */
export function useLoad<T>(fn: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    let live = true;
    latest
      .current()
      .then((d) => {
        if (!live) return;
        setData(d);
        setError("");
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    window.addEventListener("claritia:changed", reload);
    return () => window.removeEventListener("claritia:changed", reload);
  }, [reload]);
  return { data, error, reload };
}

/** POST to one of our API routes as the signed-in user. */
export async function postJson<T = Record<string, unknown>>(session: Session, path: string, body: object): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data as T;
}

/** Throw a Supabase error so callers can show it. */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A page in the app: a slim title bar, then the content. */
export function Page({
  icon,
  title,
  count,
  actions,
  back,
  flush = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number | string;
  actions?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-4 md:px-5">
        {back ? (
          <>
            <button type="button" onClick={back.onClick} className="rounded-md px-1.5 py-1 text-[13px] font-medium text-muted hover:bg-hover hover:text-ink">
              {back.label}
            </button>
            <span className="text-faint">/</span>
          </>
        ) : null}
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-line bg-panel text-ink">{icon}</span>
        <h1 className="truncate text-[14px] font-medium tracking-[-0.01em]">{title}</h1>
        {count != null ? <span className="font-mono text-[11px] text-faint tabular-nums">[{count}]</span> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${flush ? "bg-panel" : "paper p-4 md:p-6"}`}>{children}</div>
    </div>
  );
}

export function Panel({ children, className = "", frame = false }: { children: React.ReactNode; className?: string; frame?: boolean }) {
  return <div className={`border border-line bg-panel ${frame ? "frame" : ""} ${className}`}>{children}</div>;
}

/** A card's header bar: a black dot and a mono label, with room for actions on the right. */
export function CardHead({ label, count, children }: { label: string; count?: number | string; children?: React.ReactNode }) {
  return (
    <div className="flex h-10 items-center gap-2 border-b border-line bg-canvas px-4">
      <span className="size-1.5 shrink-0 rounded-full bg-ink" />
      <span className="label-mono truncate">{label}</span>
      {count != null ? <span className="font-mono text-[10.5px] text-faint tabular-nums">{count}</span> : null}
      {children ? <div className="ml-auto flex items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
      {icon ? <span className="frame mb-2 flex size-10 items-center justify-center border border-line bg-panel text-ink">{icon}</span> : null}
      <p className="text-[15px] font-medium tracking-[-0.01em]">{title}</p>
      {children ? <div className="max-w-sm text-[13px] text-muted">{children}</div> : null}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return message ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{message}</p> : null;
}

export function Loading() {
  return (
    <div className="space-y-2 p-5" aria-label="Loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-hover" style={{ opacity: 1 - i * 0.16 }} />
      ))}
    </div>
  );
}

export function Button({ variant = "primary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "plain" | "danger" }) {
  const look =
    variant === "primary"
      ? "bg-ink text-white hover:bg-[#2b2b29]"
      : variant === "ghost"
        ? "border border-line bg-panel text-ink hover:border-line-strong hover:bg-canvas"
        : variant === "danger"
          ? "border border-line bg-panel text-danger hover:border-red-300 hover:bg-danger-soft"
          : "text-body hover:bg-hover hover:text-ink";
  return (
    <button
      {...props}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 ${look} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-ink ${className}`} />;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label-mono">{label}</span>
      {children}
    </label>
  );
}

export type Tone = "gray" | "brand" | "violet" | "green" | "amber" | "red";
const TONES: Record<Tone, string> = {
  gray: "text-body shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  brand: "bg-brand text-white",
  violet: "bg-violet-soft text-violet",
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  red: "bg-danger-soft text-danger",
};

/** A record's state: a square tag. */
export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-[10px] font-medium tracking-[0.08em] whitespace-nowrap uppercase ${TONES[tone]}`}>{children}</span>;
}

/** A round avatar with mono initials, for people. */
export function Avatar({ label, size = 24 }: { label: string; size?: number }) {
  const initials =
    label
      .replace(/@.*/, "")
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-canvas font-mono font-medium text-ink" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}>
      {initials}
    </span>
  );
}

export function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`h-10 border-b border-line bg-canvas px-4 text-left font-mono text-[10.5px] font-medium tracking-[0.12em] whitespace-nowrap text-muted uppercase ${className}`}>{children}</th>;
}

export function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`h-12 border-b border-line px-4 text-[13.5px] whitespace-nowrap ${className}`}>{children}</td>;
}

/** The host of a URL, for showing it short. */
export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Accepts "staging.acme.com" or a full URL, and returns a clean https URL or null. */
export function cleanUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** A row of choices where one is picked. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 items-center gap-0.5 rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`inline-flex h-6 items-center rounded-[4px] px-2.5 text-[12.5px] font-medium ${value === o.value ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Tabs under a page header. */
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-line bg-panel px-3 md:px-4">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={`relative flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[13px] font-medium ${value === t.value ? "text-ink" : "text-muted hover:text-ink"}`}
        >
          {t.label}
          {t.count != null ? <span className="font-mono text-[10.5px] text-faint">{t.count}</span> : null}
          {value === t.value ? <span className="absolute inset-x-1 -bottom-px h-px bg-ink" /> : null}
        </button>
      ))}
    </div>
  );
}

/** Priority as three small bars, filled up to the level. */
export function PriorityBars({ value }: { value: "low" | "medium" | "high" }) {
  const level = value === "high" ? 3 : value === "medium" ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span aria-hidden="true" className="inline-flex h-2.5 items-end gap-px">
        {[4, 7, 10].map((h, i) => (
          <span key={h} className={`w-[3px] rounded-[1px] ${i < level ? "bg-ink" : "bg-line-strong"}`} style={{ height: h }} />
        ))}
      </span>
      {value[0]!.toUpperCase() + value.slice(1)}
    </span>
  );
}

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error" | "canceled";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";
const RUN_TONE: Record<RunStatus | StepStatus, Tone> = { queued: "gray", pending: "gray", running: "brand", passed: "green", failed: "red", error: "amber", canceled: "gray", skipped: "gray" };
const RUN_LABEL: Record<RunStatus | StepStatus, string> = { queued: "Waiting", pending: "Waiting", running: "Running", passed: "Passed", failed: "Failed", error: "Error", canceled: "Canceled", skipped: "Skipped" };

/** A run's or a step's state as a square tag. */
export function StatusTag({ status }: { status: RunStatus | StepStatus }) {
  return <Badge tone={RUN_TONE[status] ?? "gray"}>{RUN_LABEL[status] ?? status}</Badge>;
}

/** 1.2s, 45s, 2m 05s */
export function duration(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export type Verdict = "app_bug" | "flaky" | "setup";
const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  app_bug: { label: "App bug", tone: "red" },
  flaky: { label: "Flaky", tone: "amber" },
  setup: { label: "Setup", tone: "gray" },
};

/** The Judge's call on a failed run. */
export function VerdictTag({ verdict }: { verdict: Verdict | null | undefined }) {
  if (!verdict || !VERDICT[verdict]) return null;
  return <Badge tone={VERDICT[verdict].tone}>{VERDICT[verdict].label}</Badge>;
}
