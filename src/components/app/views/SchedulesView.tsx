"use client";

import { useState } from "react";
import { DAYS, describeSchedule, two } from "@/lib/schedules";
import { Clock, Plus, Trash } from "../../Icons";
import { askConfirm } from "../Dialogs";
import { Select } from "../Select";
import {
  announceChange,
  Badge,
  Button,
  CardHead,
  Empty,
  ErrorNote,
  errorText,
  Field,
  Input,
  Loading,
  must,
  Page,
  Panel,
  Segmented,
  timeAgo,
  useLoad,
  type Environment,
  type ViewProps,
} from "../ui";

type Every = "hour" | "day" | "weekday" | "week";
type Scope = "all" | "use_case" | "tests";
type Schedule = {
  id: string;
  name: string;
  environment_id: string;
  scope: Scope;
  use_case: string | null;
  test_ids: string[];
  every: Every;
  at_hour: number;
  at_minute: number;
  weekday: number;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_count: number | null;
  last_error: string | null;
};
type Draft = Omit<
  Schedule,
  "id" | "next_run_at" | "last_run_at" | "last_count" | "last_error" | "enabled"
>;
type TestRef = { id: string; name: string; use_case: string };

const COMMON_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Ho_Chi_Minh",
  "Asia/Tokyo",
  "Australia/Sydney",
];
const myZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function ScheduleForm({
  envs,
  tests,
  initial,
  onSave,
  onCancel,
}: {
  envs: Environment[];
  tests: TestRef[];
  initial: Draft;
  onSave: (d: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const useCases = [...new Set(tests.map((t) => t.use_case))].sort();
  const zones = [...new Set([myZone(), d.timezone, ...COMMON_ZONES])];
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD({ ...d, [k]: v });
  const selectClass =
    "h-9 w-full rounded-md border border-line bg-panel px-2.5 text-[13px] hover:border-line-strong";

  return (
    <form
      className="grid gap-4 p-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onSave(d);
        } catch (err) {
          setError(errorText(err));
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <Input
          value={d.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Nightly smoke"
          maxLength={80}
          required
          autoFocus
        />
      </Field>
      <Field label="Environment">
        <Select
          value={d.environment_id}
          options={envs.map((e) => ({ value: e.id, label: e.name }))}
          onChange={(v) => set("environment_id", v)}
          ariaLabel="Environment"
          className={selectClass}
        />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="label-mono">Runs</span>
        <div className="self-start">
          <Segmented<Scope>
            value={d.scope}
            label="Runs"
            onChange={(v) => set("scope", v)}
            options={[
              { value: "all", label: "Every test" },
              { value: "use_case", label: "A use case" },
              { value: "tests", label: "Picked tests" },
            ]}
          />
        </div>
        {d.scope === "use_case" ? (
          <div className="sm:max-w-xs">
            <Select
              value={d.use_case ?? ""}
              options={useCases.map((u) => ({ value: u, label: u }))}
              onChange={(v) => set("use_case", v)}
              ariaLabel="Use case"
              placeholder="Pick a use case"
              className={selectClass}
            />
          </div>
        ) : null}
        {d.scope === "tests" ? (
          <ul className="max-h-56 overflow-auto border border-line">
            {tests.map((t) => (
              <li key={t.id} className="border-b border-line last:border-b-0">
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={d.test_ids.includes(t.id)}
                    onChange={(e) =>
                      set(
                        "test_ids",
                        e.target.checked
                          ? [...d.test_ids, t.id]
                          : d.test_ids.filter((x) => x !== t.id),
                      )
                    }
                    className="size-3.5 accent-[var(--color-brand)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="text-[12px] text-faint">{t.use_case}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="label-mono">When</span>
        <div className="self-start">
          <Segmented<Every>
            value={d.every}
            label="When"
            onChange={(v) => set("every", v)}
            options={[
              { value: "hour", label: "Hourly" },
              { value: "day", label: "Daily" },
              { value: "weekday", label: "Weekdays" },
              { value: "week", label: "Weekly" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.every === "week" ? (
            <div className="w-36">
              <Select
                value={d.weekday}
                options={DAYS.map((name, i) => ({ value: i, label: name }))}
                onChange={(v) => set("weekday", v)}
                ariaLabel="Day"
                className={selectClass}
              />
            </div>
          ) : null}
          {d.every !== "hour" ? (
            <div className="w-20">
              <Select
                value={d.at_hour}
                options={Array.from({ length: 24 }, (_, h) => ({
                  value: h,
                  label: two(h),
                }))}
                onChange={(v) => set("at_hour", v)}
                ariaLabel="Hour"
                className={selectClass}
              />
            </div>
          ) : null}
          <div className="w-20">
            <Select
              value={d.at_minute}
              options={[0, 15, 30, 45].map((m) => ({
                value: m,
                label: `:${two(m)}`,
              }))}
              onChange={(v) => set("at_minute", v)}
              ariaLabel="Minute"
              className={selectClass}
            />
          </div>
          {d.every !== "hour" ? (
            <div className="w-56">
              <Select
                value={d.timezone}
                options={zones.map((z) => ({ value: z, label: z }))}
                onChange={(v) => set("timezone", v)}
                ariaLabel="Time zone"
                className={selectClass}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save schedule"}
        </Button>
        <Button type="button" variant="plain" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? (
        <div className="sm:col-span-2">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </form>
  );
}

/** Schedules: run a project's tests every hour, day, weekday or week, on one environment. */
export function SchedulesView({ sb, project }: ViewProps) {
  const data = useLoad(async () => {
    if (!project)
      return {
        schedules: [] as Schedule[],
        envs: [] as Environment[],
        tests: [] as TestRef[],
      };
    const [schedules, envs, tests] = await Promise.all([
      sb
        .from("schedules")
        .select(
          "id, name, environment_id, scope, use_case, test_ids, every, at_hour, at_minute, weekday, timezone, enabled, next_run_at, last_run_at, last_count, last_error",
        )
        .eq("project_id", project.id)
        .order("created_at"),
      sb
        .from("environments")
        .select("id, project_id, name, base_url, created_at")
        .eq("project_id", project.id)
        .order("created_at"),
      sb
        .from("tests")
        .select("id, name, use_case")
        .eq("project_id", project.id)
        .order("use_case")
        .order("name"),
    ]);
    return {
      schedules: must(schedules) as Schedule[],
      envs: must(envs) as Environment[],
      tests: must(tests) as TestRef[],
    };
  }, project?.id ?? "none");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      data.reload();
      announceChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async (id: string | null, d: Draft) => {
    const row = {
      ...d,
      use_case: d.scope === "use_case" ? d.use_case : null,
      test_ids: d.scope === "tests" ? d.test_ids : [],
    };
    if (id) must(await sb.from("schedules").update(row).eq("id", id));
    else
      must(
        await sb.from("schedules").insert({ ...row, project_id: project!.id }),
      );
    setEditing(null);
    data.reload();
  };

  const envName = (id: string) =>
    data.data?.envs.find((e) => e.id === id)?.name ?? "—";
  const scopeText = (s: Schedule) =>
    s.scope === "all"
      ? "Every test"
      : s.scope === "use_case"
        ? `Use case: ${s.use_case}`
        : `${s.test_ids.length} ${s.test_ids.length === 1 ? "test" : "tests"}`;
  const blank = (): Draft => ({
    name: "",
    environment_id: data.data?.envs[0]?.id ?? "",
    scope: "all",
    use_case: null,
    test_ids: [],
    every: "day",
    at_hour: 9,
    at_minute: 0,
    weekday: 1,
    timezone: myZone(),
  });

  return (
    <Page
      icon={<Clock size={14} />}
      title="Schedules"
      count={data.data?.schedules.length}
      actions={
        project && data.data?.envs.length && editing === null ? (
          <Button onClick={() => setEditing("new")}>
            <Plus size={13} />
            New schedule
          </Button>
        ) : null
      }
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <ErrorNote message={error || data.error} />
        {!data.data ? (
          <Loading />
        ) : editing === "new" ? (
          <Panel>
            <CardHead label="New schedule" />
            <ScheduleForm
              envs={data.data.envs}
              tests={data.data.tests}
              initial={blank()}
              onSave={(d) => save(null, d)}
              onCancel={() => setEditing(null)}
            />
          </Panel>
        ) : !data.data.schedules.length ? (
          <Empty icon={<Clock size={16} />} title="No schedules yet.">
            {data.data.envs.length
              ? "Run your tests every hour, every night or every week, and see failures before your users do."
              : "Add an environment first."}
          </Empty>
        ) : null}

        {data.data?.schedules.map((s) =>
          editing === s.id ? (
            <Panel key={s.id}>
              <CardHead label={`Edit ${s.name}`} />
              <ScheduleForm
                envs={data.data!.envs}
                tests={data.data!.tests}
                initial={s}
                onSave={(d) => save(s.id, d)}
                onCancel={() => setEditing(null)}
              />
            </Panel>
          ) : (
            <Panel key={s.id}>
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="text-[14px] font-medium">{s.name}</span>
                {s.enabled ? (
                  <Badge tone="green">On</Badge>
                ) : (
                  <Badge>Paused</Badge>
                )}
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    onClick={() => setEditing(s.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="plain"
                    className="h-7 px-2"
                    onClick={() =>
                      act(async () =>
                        must(
                          await sb
                            .from("schedules")
                            .update({ enabled: !s.enabled })
                            .eq("id", s.id),
                        ),
                      )
                    }
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </Button>
                  <button
                    type="button"
                    aria-label={`Delete ${s.name}`}
                    onClick={() =>
                      act(async () => {
                        if (
                          !(await askConfirm(`Delete ${s.name}?`, {
                            ok: "Delete",
                            danger: true,
                          }))
                        )
                          return;
                        must(
                          await sb.from("schedules").delete().eq("id", s.id),
                        );
                      })
                    }
                    className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger"
                  >
                    <Trash size={13} />
                  </button>
                </span>
              </div>
              <dl className="grid gap-x-6 gap-y-2 border-t border-line px-4 py-3 text-[13px] sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">When</dt>
                  <dd>{describeSchedule(s)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">Runs</dt>
                  <dd>
                    {scopeText(s)} on {envName(s.environment_id)}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">Next</dt>
                  <dd>{s.enabled ? when(s.next_run_at) : "Paused"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">Last</dt>
                  <dd className={s.last_error ? "text-danger" : ""}>
                    {s.last_run_at
                      ? `${timeAgo(s.last_run_at)} · ${s.last_error ?? `${s.last_count ?? 0} ${s.last_count === 1 ? "run" : "runs"}`}`
                      : "Not yet"}
                  </dd>
                </div>
              </dl>
            </Panel>
          ),
        )}
      </div>
    </Page>
  );
}
