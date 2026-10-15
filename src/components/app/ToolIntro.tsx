"use client";

// The first screen of a tool, before there's anything to show: what it does, and cards with small sample visuals.
// The one place in the app that explains; working screens hold labels, buttons and real errors only.
// Same pattern as Omniscient's and Arrowsterr's ToolIntro.

type Feature = { title: string; text: string; visual?: React.ReactNode };

export function ToolIntro({ title, lead, action, features }: { title: string; lead?: string; action?: React.ReactNode; features?: Feature[] }) {
  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-7 py-4">
      <div className="flex flex-col gap-4">
        <p className="fig">{"// fig. 00 — start here"}</p>
        <h2 className="max-w-3xl text-[32px] leading-[1.1] font-medium tracking-[-0.03em]">{title}</h2>
        {lead ? <p className="max-w-2xl text-[15px] leading-relaxed text-body">{lead}</p> : null}
      </div>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
      {features?.length ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <div key={f.title} className="frame flex flex-col border border-line bg-panel">
              <p className="fig border-b border-line bg-canvas px-4 py-2.5">{`// fig. ${String(i + 1).padStart(2, "0")}`}</p>
              <div className="flex flex-1 flex-col gap-3 p-5">
                {f.visual ? <div className="flex h-20 items-center">{f.visual}</div> : null}
                <h3 className="text-[15px] font-medium">{f.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-body">{f.text}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// Sample visuals -----------------------------------------------------------------------------------

/** Vertical bars, like visits each day. */
export function SampleBars({ values = [30, 45, 40, 52, 48, 60, 72, 66, 58, 70, 64, 80] }: { values?: number[] }) {
  const max = Math.max(...values);
  return (
    <span className="flex h-16 w-full items-end gap-1" aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} className="flex-1 bg-brand" style={{ height: `${(v / max) * 100}%`, opacity: 0.35 + (i / values.length) * 0.65 }} />
      ))}
    </span>
  );
}

/** Horizontal bars with labels and values. */
export function SampleRows({ rows }: { rows: [string, number, string?][] }) {
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <span className="flex w-full flex-col gap-1.5" aria-hidden="true">
      {rows.map(([label, v, shown]) => (
        <span key={label} className="grid grid-cols-[1fr_90px_44px] items-center gap-2 text-[11.5px]">
          <span className="truncate text-ink">{label}</span>
          <span className="h-1.5 bg-hover">
            <span className="block h-full bg-brand" style={{ width: `${(v / max) * 100}%` }} />
          </span>
          <span className="num text-right text-body">{shown ?? v}</span>
        </span>
      ))}
    </span>
  );
}

/** A few big numbers side by side. */
export function SampleStats({ items }: { items: [string, string][] }) {
  return (
    <span className="grid w-full grid-cols-3 gap-2" aria-hidden="true">
      {items.map(([lab, v]) => (
        <span key={lab} className="flex flex-col">
          <span className="text-[22px] font-medium tracking-[-0.03em] text-ink tabular-nums">{v}</span>
          <span className="fig">
            {"// "}
            {lab}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Rows with a square state tag on the right. */
export function SampleTags({ rows }: { rows: [string, string][] }) {
  return (
    <span className="flex w-full flex-col gap-1.5" aria-hidden="true">
      {rows.map(([label, tag]) => (
        <span key={label} className="flex items-center justify-between gap-2 text-[12px]">
          <span className="truncate text-ink">{label}</span>
          <span className="border border-line bg-canvas px-1.5 font-mono text-[10px] tracking-[0.06em] text-body uppercase">{tag}</span>
        </span>
      ))}
    </span>
  );
}
