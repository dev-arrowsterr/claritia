// A square status tag for test results, in the brand's tag style.

export type Tone = "passed" | "failed" | "healed" | "cached" | "running" | "flaky" | "brand";

const TONES: Record<Tone, string> = {
  passed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  healed: "bg-violet-soft text-violet",
  cached: "border border-line-strong text-body",
  running: "bg-brand text-white",
  flaky: "bg-warning-soft text-warning",
  brand: "bg-brand text-white",
};

export function Tag({ tone, children, className = "" }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 font-mono text-[10px] font-medium tracking-[0.08em] whitespace-nowrap uppercase ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}
