import Link from "next/link";
import { HeroMock } from "@/components/marketing/HeroMock";
import { Tag } from "@/components/marketing/Tag";
import { SiteFooter, SiteHeader } from "@/components/Site";
import { APP_URL, CONTACT_EMAIL } from "@/lib/site";

const INTEGRATIONS = ["GitHub", "GitLab", "Vercel", "Netlify", "Slack", "Playwright", "Claude Code", "Cursor"];

const STEPS = [
  { n: "01", title: "Describe", body: "Write the flow the way you'd explain it to a new teammate. Or paste your product spec." },
  { n: "02", title: "Run", body: "Claritia drives a real browser, step by step, and saves the video, screenshots and logs." },
  { n: "03", title: "Heal", body: "When your UI changes, Claritia finds the new button and asks you to approve the fix." },
  { n: "04", title: "Gate", body: "Tests run on every pull request. A failure blocks the merge and posts the video." },
];

const STATS = [
  { value: "5 min", label: "to your first passing test" },
  { value: "100%", label: "of runs saved with video" },
  { value: "0", label: "lines of selector code" },
  { value: "None", label: "lock-in" },
];

const PLANS = [
  { name: "Free", price: "$0", note: "for side projects", items: ["1 project", "500 steps a month", "Video for every run"], cta: "Start free" },
  { name: "Starter", price: "$49", note: "per month", items: ["5,000 steps a month", "GitHub Action", "Slack alerts", "Schedules"], cta: "Start free" },
  {
    name: "Team",
    price: "$199",
    note: "per month",
    items: ["25,000 steps a month", "Self-healing tests", "Failure sorting", "5 seats", "MCP server"],
    cta: "Start a free trial",
    featured: true,
  },
  { name: "Business", price: "Custom", note: "billed yearly", items: ["Higher limits", "SSO", "Private runners", "Managed test writing"], cta: "Talk to us", contact: true },
];

function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`fig ${dark ? "!text-white/45" : ""}`}>{"// "}{children}</p>;
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="mt-0.5 shrink-0 text-brand" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const K = ({ children }: { children: React.ReactNode }) => <span className="text-[#7fa8f7]">{children}</span>;
const S = ({ children }: { children: React.ReactNode }) => <span className="text-emerald-300">{children}</span>;
const D = ({ children }: { children: React.ReactNode }) => <span className="text-white/40">{children}</span>;

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteHeader />
      <main className="flex-1 overflow-x-clip">
        {/* Hero */}
        <section className="relative">
          <div className="dot-grid pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-28 md:px-6 md:pt-24 md:pb-48">
            <div className="mk-fade mx-auto max-w-3xl text-center">
              <Link href="#agent" className="inline-flex items-center gap-2 border border-line bg-white py-1 pr-3 pl-1 text-[13px] font-medium text-ink hover:border-line-strong">
                <span className="inline-flex h-5 items-center rounded-sm bg-brand px-1.5 font-mono text-[10px] font-medium tracking-[0.08em] text-white uppercase">New</span>
                Tests from plain English
                <span className="text-faint" aria-hidden="true">
                  →
                </span>
              </Link>
              <h1 className="mt-7 text-[44px] leading-[1.02] font-medium tracking-[-0.035em] md:text-[76px]">
                Tests that write
                <br />
                <span className="text-brand">and fix themselves.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted md:text-[19px]">
                Describe a user flow in plain English. Claritia turns it into a Playwright test, runs it on every push, and fixes it when your UI changes. Every run comes with a video.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <a href={APP_URL} className="inline-flex h-12 items-center gap-2 rounded-md bg-ink px-6 text-[15px] font-medium text-white transition hover:bg-[#2b2b29]">
                  Start free
                </a>
                <Link href="#product" className="inline-flex h-12 items-center rounded-md border border-line bg-white px-6 text-[15px] font-medium text-ink transition hover:border-line-strong">
                  Watch a test run
                </Link>
              </div>
              <p className="mt-4 text-[13px] text-faint">Free tier · No card needed · Export to Playwright any time</p>
            </div>
            <div className="mk-fade mx-auto mt-16 max-w-5xl md:mt-24" style={{ animationDelay: "120ms" }}>
              <HeroMock />
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section className="border-y border-line bg-canvas">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-10 md:flex-row md:gap-10 md:px-6">
            <p className="label-mono shrink-0">Works with</p>
            <ul className="flex flex-wrap justify-center gap-x-8 gap-y-3 md:justify-start">
              {INTEGRATIONS.map((i) => (
                <li key={i} className="font-mono text-[12px] tracking-[0.12em] text-muted uppercase">
                  {i}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
            <div className="max-w-2xl">
              <Eyebrow>How it works</Eyebrow>
              <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">From a sentence to a green check.</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-muted">No selectors to write and no scripts to fix. Tell Claritia what a user does, and it handles the rest.</p>
            </div>
            <ol className="frame mt-14 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <li key={s.n} className="bg-white p-6 md:p-7">
                  <p className="fig">{`// step ${s.n}`}</p>
                  <h3 className="mt-6 text-[18px] font-medium tracking-tight">{s.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Product bento */}
        <section id="product" className="scroll-mt-20 bg-canvas">
          <div className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
            <div className="max-w-2xl">
              <Eyebrow>The product</Eyebrow>
              <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">Every failure, explained.</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-muted">Real bugs get flagged. Flaky ones get sorted out. You only look at what matters.</p>
            </div>

            <div className="mt-14 grid gap-4 md:grid-cols-6">
              {/* Run viewer */}
              <article className="frame border border-line bg-white p-6 md:col-span-4 md:p-8">
                <h3 className="text-[20px] font-medium tracking-tight">See exactly what broke</h3>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted">Video, trace, console and network in one screen. Click a step to jump to that moment.</p>
                <div className="mt-6 border border-line">
                  {(
                    [
                      ["1", "Add the blue hoodie to the cart", "passed", "Passed"],
                      ["2", "Apply the coupon SAVE10", "passed", "Passed"],
                      ["3", "Check the total drops 10%", "passed", "Passed"],
                      ["4", "Pay with the test card", "failed", "Failed"],
                    ] as const
                  ).map(([n, text, tone, tag]) => (
                    <div key={n} className={`border-b border-line last:border-b-0 ${tone === "failed" ? "bg-danger-soft/40" : ""}`}>
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <span className="w-4 shrink-0 font-mono text-[11px] text-faint">{n}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{text}</span>
                        <Tag tone={tone}>{tag}</Tag>
                      </div>
                      {tone === "failed" ? (
                        <p className="border-t border-line px-3 py-2 pl-10 font-mono text-[11px] text-danger">
                          POST /api/checkout → 500 · &quot;card_token is undefined&quot;
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </article>

              {/* Failure sorting */}
              <article className="border border-line bg-white p-6 md:col-span-2 md:p-8">
                <h3 className="text-[20px] font-medium tracking-tight">Bug, flake or setup?</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">Each failure gets a label and the reason behind it.</p>
                <div className="frame mt-6 border border-line bg-canvas p-4">
                  <p className="label-mono">Verdict · set by AI</p>
                  <p className="mt-2">
                    <Tag tone="failed">App bug</Tag>
                  </p>
                  <p className="mt-2 text-[15px] font-medium">Checkout returns a 500</p>
                  <p className="mt-2 text-[12.5px] leading-snug text-muted">“card_token is undefined” in the console, same error on retry.</p>
                  <p className="mt-1 text-[11px] text-faint">Run #482 · step 4 · 0:14</p>
                </div>
              </article>

              {/* Plain-English checks */}
              <article className="border border-line bg-white p-6 md:col-span-3 md:p-8">
                <h3 className="text-[20px] font-medium tracking-tight">Check what a person would check</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">Write checks in plain words. Claritia shows how it decided.</p>
                <div className="mt-6 space-y-3 text-[13px]">
                  <p className="ml-auto w-fit max-w-[85%] rounded-md rounded-br-none bg-ink px-3.5 py-2 text-white">Check the total drops 10% after the coupon</p>
                  <div className="max-w-[90%] border border-line px-3.5 py-2.5">
                    <span className="font-medium text-success">Passed.</span> The total went from $120.00 to $108.00.
                    <p className="mt-2 flex gap-1.5">
                      {["Step 6", "Screenshot", "DOM"].map((s) => (
                        <span key={s} className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.06em] text-muted uppercase">
                          {s}
                        </span>
                      ))}
                    </p>
                  </div>
                </div>
              </article>

              {/* Tests in your repo */}
              <article className="border border-line bg-white p-6 md:col-span-3 md:p-8">
                <h3 className="text-[20px] font-medium tracking-tight">Your tests live with your code</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">Plain YAML files, reviewed in pull requests like everything else.</p>
                <div className="mt-6 border border-line bg-canvas p-2 font-mono text-[12px]">
                  <p className="flex items-center gap-2 px-2 py-1.5 text-muted">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                    .claritia/
                  </p>
                  <div className="space-y-1">
                    {(
                      [
                        ["checkout.yaml", "failed", "Failed"],
                        ["signup.yaml", "passed", "Passed"],
                        ["billing.yaml", "healed", "Healed"],
                      ] as const
                    ).map(([file, tone, tag]) => (
                      <div key={file} className="flex items-center gap-2 border border-line bg-white py-1.5 pr-2 pl-7">
                        <span className="min-w-0 flex-1 truncate text-ink">{file}</span>
                        <Tag tone={tone}>{tag}</Tag>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* Agent */}
        <section id="agent" className="scroll-mt-20">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 py-24 md:grid-cols-2 md:px-6 md:py-32">
            <div>
              <Eyebrow>Agent</Eyebrow>
              <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">A QA engineer that never sleeps.</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-muted">
                The agent explores your app, writes tests and keeps them green. Anything that changes a test waits for your yes.
              </p>
              <ul className="mt-8 space-y-3 text-[15px]">
                {[
                  "Crawls a URL and suggests the tests you're missing",
                  "Writes tests from your PRD or product spec",
                  "Fixes broken selectors and shows you the change",
                  "Sorts every failure into bug, flake or setup",
                ].map((t) => (
                  <li key={t} className="flex gap-3">
                    <Check />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="frame border border-line bg-white">
              <div className="flex items-center justify-between border-b border-line bg-canvas px-5 py-3">
                <p className="label-mono flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-ink" />
                  Agent runs
                </p>
                <p className="flex items-center gap-1.5 text-[12px] text-emerald-700">
                  <span className="mk-pulse size-1.5 rounded-full bg-emerald-500" />
                  Live
                </p>
              </div>
              <ul className="divide-y divide-line">
                {(
                  [
                    ["Explore", "acme.com · 12 tests suggested", "Needs review", "flaky"],
                    ["Heal", "checkout.yaml · selector updated", "Needs approval", "flaky"],
                    ["Sort", "Run #482 · app bug", "Done", "passed"],
                    ["Nightly", "48 tests on production", "Scheduled 2:00", "brand"],
                  ] as const
                ).map(([name, what, status, tone]) => (
                  <li key={name} className="flex items-center gap-4 px-5 py-4">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-line bg-canvas font-mono text-[10px] font-medium text-ink">{name.slice(0, 2).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium">{name}</p>
                      <p className="truncate text-[12.5px] text-muted">{what}</p>
                    </div>
                    <Tag tone={tone}>{status}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Developers, dark */}
        <section id="developers" className="relative scroll-mt-20 overflow-hidden bg-ink text-white">
          <div className="mk-dots pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
            <div className="grid items-start gap-14 md:grid-cols-2">
              <div>
                <Eyebrow dark>Built for developers</Eyebrow>
                <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">Plain files. Real Playwright. No lock-in.</h2>
                <p className="mt-5 text-[17px] leading-relaxed text-white/65">
                  Every test is a YAML file in your repo. Run it from your laptop, in CI, or from Claude Code. Export to plain Playwright code whenever you want.
                </p>
                <dl className="mt-10 grid grid-cols-2 gap-6">
                  {[
                    ["Repo files", "Tests are reviewed in pull requests like code"],
                    ["CI gate", "A GitHub Action blocks merges on failure"],
                    ["MCP server", "Claude Code and Cursor write and run tests"],
                    ["Playwright export", "Take your tests with you any time"],
                  ].map(([t, d]) => (
                    <div key={t} className="border-t border-white/15 pt-3">
                      <dt className="text-[14px] font-medium">{t}</dt>
                      <dd className="mt-1 text-[13px] leading-snug text-white/55">{d}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="overflow-hidden border border-white/15 bg-[#161615]">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="ml-2 font-mono text-[12px] text-white/45">.claritia/checkout.yaml</span>
                </div>
                <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-6">
                  <code>
                    <K>name</K>: <S>Checkout with a coupon</S>
                    {"\n"}
                    <K>url</K>: <S>https://staging.acme.com</S>
                    {"\n"}
                    <K>steps</K>:{"\n"}
                    {"  "}
                    <D>-</D> <S>Add the blue hoodie to the cart</S>
                    {"\n"}
                    {"  "}
                    <D>-</D> <S>Apply the coupon SAVE10</S>
                    {"\n"}
                    {"  "}
                    <D>-</D> <S>Check the total drops 10%</S>
                    {"\n"}
                    {"  "}
                    <D>-</D> <S>Pay with the test card</S>
                    {"\n"}
                    {"  "}
                    <D>-</D> <S>Check the page says &quot;Order confirmed&quot;</S>
                  </code>
                </pre>
                <div className="space-y-1 border-t border-white/10 px-5 py-3 font-mono text-[12px] text-white/45">
                  <p>
                    <span className="text-[#7fa8f7]">$</span> claritia run <S>checkout.yaml</S>
                  </p>
                  <p>
                    <span className="text-emerald-300">✓</span> 5 steps passed · 3 from cache · 8.2s
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-20 grid gap-px border border-white/15 bg-white/15 sm:grid-cols-2 lg:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.label} className="bg-ink p-6">
                  <p className="font-mono text-[10px] tracking-[0.18em] text-white/45 uppercase">
                    {"// "}
                    {s.label}
                  </p>
                  <p className="mt-2 text-[34px] font-medium tracking-[-0.03em] tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="scroll-mt-20">
          <div className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
            <div className="mx-auto max-w-2xl text-center">
              <Eyebrow>Security</Eyebrow>
              <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">Your staging site and secrets stay safe.</h2>
            </div>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Encrypted secrets", "Passwords and API keys are encrypted and never shown in logs or videos."],
                ["Isolated runs", "Every run gets a fresh browser in its own container, wiped when it ends."],
                ["Never used for training", "Your app, tests and videos are never used to train AI models."],
                ["Delete any time", "Remove a project and its runs, videos and secrets are gone."],
              ].map(([t, d]) => (
                <div key={t} className="border border-line bg-white p-6">
                  <span className="flex size-9 items-center justify-center rounded-sm border border-line bg-canvas text-ink">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  </span>
                  <h3 className="mt-5 text-[16px] font-medium">{t}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-20 bg-canvas">
          <div className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
            <div className="mx-auto max-w-2xl text-center">
              <Eyebrow>Pricing</Eyebrow>
              <h2 className="mt-4 text-[34px] leading-[1.08] font-medium tracking-[-0.03em] md:text-[48px]">Start free. Pay for what runs.</h2>
              <p className="mt-5 text-[17px] leading-relaxed text-muted">Every plan includes the AI. Steps that replay from cache cost less.</p>
            </div>
            <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {PLANS.map((p) => (
                <div key={p.name} className={`flex flex-col p-6 ${p.featured ? "frame border border-ink bg-ink text-white" : "border border-line bg-white"}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-[15px] font-medium">{p.name}</p>
                    {p.featured ? <Tag tone="brand">Most popular</Tag> : null}
                  </div>
                  <p className="mt-6 text-[40px] font-medium tracking-[-0.03em]">{p.price}</p>
                  <p className={`text-[13px] ${p.featured ? "text-white/60" : "text-faint"}`}>{p.note}</p>
                  <ul className="mt-6 flex-1 space-y-2.5 text-[14px]">
                    {p.items.map((i) => (
                      <li key={i} className="flex gap-2.5">
                        <svg width="16" height="16" viewBox="0 0 16 16" className={`mt-0.5 shrink-0 ${p.featured ? "text-white/70" : "text-ink"}`} aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {i}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={p.contact ? `mailto:${CONTACT_EMAIL}` : APP_URL}
                    className={`mt-8 inline-flex h-10 items-center justify-center rounded-md text-[14px] font-medium transition ${p.featured ? "bg-white text-ink hover:bg-canvas" : "bg-ink text-white hover:bg-[#2b2b29]"}`}
                  >
                    {p.cta}
                  </a>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center text-[13px] text-faint">Extra steps: $5 per 1,000. Managed service: we write and keep your top flows green.</p>
          </div>
        </section>

        {/* Final CTA */}
        <section className="relative overflow-hidden bg-ink text-white">
          <div className="mk-dots pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-4xl px-4 py-24 text-center md:px-6 md:py-28">
            <h2 className="text-[36px] leading-[1.05] font-medium tracking-[-0.03em] md:text-[56px]">Stop fixing tests. Start shipping.</h2>
            <p className="mx-auto mt-5 max-w-xl text-[17px] text-white/75">Write your first test in plain English and watch it run in the next five minutes.</p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <a href={APP_URL} className="inline-flex h-12 items-center rounded-md bg-white px-6 text-[15px] font-medium text-ink transition hover:bg-canvas">
                Start free
              </a>
              <a href={`mailto:${CONTACT_EMAIL}`} className="inline-flex h-12 items-center rounded-md border border-white/30 px-6 text-[15px] font-medium text-white transition hover:border-white">
                Talk to us
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
