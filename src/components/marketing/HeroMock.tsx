// A picture of a test run built in HTML, so it stays sharp and loads instantly.

import { Tag, type Tone } from "./Tag";

const STEPS: { text: string; tone: Tone; tag: string; ms: string }[] = [
  { text: "Go to the pricing page", tone: "cached", tag: "Cached", ms: "0.4s" },
  { text: "Click “Start trial”", tone: "healed", tag: "Healed", ms: "1.1s" },
  { text: "Sign up with a test inbox", tone: "passed", tag: "Passed", ms: "3.2s" },
  { text: "Enter the code from the email", tone: "passed", tag: "Passed", ms: "4.8s" },
  { text: "Check the plan says “Pro trial”", tone: "passed", tag: "Passed", ms: "0.9s" },
];

export function HeroMock() {
  return (
    <div className="relative">
      <div className="frame border border-line bg-white">
        {/* Window bar */}
        <div className="flex h-10 items-center gap-2 border-b border-line bg-canvas px-4">
          <span className="fig">{"// fig. 01 — run #482"}</span>
          <span className="ml-auto hidden rounded-sm border border-line bg-white px-2.5 py-0.5 font-mono text-[11px] text-faint sm:block">app.tryclaritia.com/runs/482</span>
        </div>

        {/* Run header */}
        <div className="flex h-12 items-center gap-3 border-b border-line px-4">
          <p className="truncate text-[13px] font-medium">Sign up for a Pro trial</p>
          <Tag tone="passed">Passed</Tag>
          <p className="ml-auto hidden shrink-0 text-[11px] text-faint tabular-nums sm:block">staging · 10.4s · 2m ago</p>
        </div>

        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Steps */}
          <ol className="border-b border-line md:border-r md:border-b-0">
            {STEPS.map((s, i) => (
              <li key={s.text} className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 ${i === 2 ? "bg-hover" : ""}`}>
                <span className="w-4 shrink-0 font-mono text-[11px] text-faint">{i + 1}</span>
                <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{s.text}</p>
                <Tag tone={s.tone}>{s.tag}</Tag>
                <span className="hidden w-8 shrink-0 text-right font-mono text-[10.5px] text-faint sm:block">{s.ms}</span>
              </li>
            ))}
          </ol>

          {/* Video */}
          <div className="bg-canvas p-4">
            <div className="border border-line bg-white">
              <div className="flex h-6 items-center gap-1.5 border-b border-line px-2">
                <span className="size-1.5 rounded-full bg-line-strong" />
                <span className="size-1.5 rounded-full bg-line-strong" />
                <span className="size-1.5 rounded-full bg-line-strong" />
                <span className="ml-2 truncate font-mono text-[9.5px] text-faint">staging.acme.com/signup</span>
              </div>
              <div className="px-6 py-6 sm:px-10">
                <p className="text-[13px] font-medium">Create your account</p>
                <p className="mt-0.5 text-[10.5px] text-muted">14-day Pro trial. No card needed.</p>
                <div className="mt-4 space-y-2">
                  <div className="flex h-7 items-center rounded-md border border-line px-2 font-mono text-[10px] text-body">qa+482@inbox.tryclaritia.com</div>
                  <div className="relative flex h-7 items-center rounded-md border-2 border-brand px-2 font-mono text-[10px] text-body">
                    ••••••••••
                    <span className="absolute -top-2 right-2 bg-brand px-1 font-mono text-[8.5px] tracking-[0.08em] text-white uppercase">fill</span>
                  </div>
                  <div className="flex h-7 items-center justify-center rounded-md bg-ink text-[10.5px] font-medium text-white">Create account</div>
                </div>
              </div>
            </div>
            {/* Scrub bar */}
            <div className="mt-3 flex items-center gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-line bg-white">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
                </svg>
              </span>
              <div className="relative h-1 flex-1 bg-line">
                <div className="absolute inset-y-0 left-0 w-[45%] bg-brand" />
                {[0, 4, 15, 46, 91].map((p) => (
                  <span key={p} className="absolute -top-1 h-3 w-px bg-line-strong" style={{ left: `${p}%` }} />
                ))}
              </div>
              <span className="shrink-0 font-mono text-[10.5px] text-muted tabular-nums">0:04 / 0:10</span>
            </div>
          </div>
        </div>
      </div>

      {/* Healing suggestion, floating */}
      <div className="absolute -right-2 -bottom-36 z-10 hidden w-72 border border-line bg-white p-3.5 shadow-pop sm:block md:-right-8">
        <p className="label-mono flex items-center gap-1.5">
          <span className="mk-pulse size-1.5 rounded-full bg-violet" /> Healing suggestion
        </p>
        <p className="mt-1.5 text-[12.5px] font-medium">Step 2 · Click “Start trial”</p>
        <p className="mt-1 font-mono text-[11px]">
          <span className="text-faint line-through">text=Start trial</span> → <span className="text-ink">text=Try free</span>
        </p>
        <p className="mt-2 border border-line bg-canvas px-2 py-1.5 text-[11px] leading-snug text-muted">The button text changed in the last deploy. Same place, same page.</p>
        <div className="mt-2.5 flex gap-1.5">
          <span className="rounded-md bg-ink px-2 py-1 text-[11px] font-medium text-white">Approve</span>
          <span className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted">Skip</span>
        </div>
      </div>

      {/* The test, floating */}
      <div className="absolute -top-16 -left-2 z-10 hidden w-64 border border-ink bg-ink p-3.5 text-white shadow-pop lg:block lg:-left-10">
        <p className="font-mono text-[10px] tracking-[0.18em] text-white/45 uppercase">{"// test"}</p>
        <p className="mt-1 text-[12.5px] leading-snug font-medium">Sign up, confirm the email, and land on the Pro trial.</p>
        <p className="mt-2 text-[10.5px] text-white/40">5 steps · written from one sentence</p>
      </div>
    </div>
  );
}
