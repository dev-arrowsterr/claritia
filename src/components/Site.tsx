import Link from "next/link";
import { APP_URL, CLR_SITE_KEY, COMPANY, CONTACT_EMAIL } from "@/lib/site";
import { Logo } from "./Logo";

const NAV = [
  { href: "/#product", label: "Product" },
  { href: "/#agent", label: "Agent" },
  { href: "/#developers", label: "Developers" },
  { href: "/#security", label: "Security" },
  { href: "/#pricing", label: "Pricing" },
];

/** The public site's top bar. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-white/90 backdrop-blur">
      <script defer src="/_clr/s.js" data-site={CLR_SITE_KEY} />
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4 md:px-6">
        <Link href="/" aria-label="Claritia home" className="shrink-0">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 text-[14px] md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 font-medium text-muted transition-colors hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-[14px]">
          <a href={APP_URL} className="hidden rounded-md px-3 py-2 font-medium text-muted hover:text-ink sm:block">
            Sign in
          </a>
          <a href={APP_URL} className="group inline-flex h-9 items-center gap-1.5 rounded-md bg-ink px-4 font-medium text-white transition-colors hover:bg-[#2b2b29]">
            Start free
            <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">
              →
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}

const FOOTER: { title: string; links: [string, string][] }[] = [
  { title: "Product", links: [["Run viewer", "/#product"], ["Agent", "/#agent"], ["Pricing", "/#pricing"]] },
  { title: "Developers", links: [["Repo files", "/#developers"], ["GitHub Action", "/#developers"], ["MCP server", "/#developers"], ["Security", "/#security"]] },
  { title: "Company", links: [["Contact", `mailto:${CONTACT_EMAIL}`]] },
];

/** The public site's footer. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)] md:px-6">
        <div className="space-y-4">
          <Logo />
          <p className="max-w-xs text-[14px] leading-relaxed text-muted">Tests that write and fix themselves. Built for teams who would rather ship than babysit a test suite.</p>
          <p className="inline-flex items-center gap-2 border border-line px-2.5 py-1 font-mono text-[10.5px] tracking-[0.08em] text-muted uppercase">
            <span className="mk-pulse size-1.5 rounded-full bg-emerald-500" />
            All systems running
          </p>
        </div>
        {FOOTER.map((col) => (
          <div key={col.title}>
            <p className="label-mono">{col.title}</p>
            <ul className="mt-4 space-y-2.5 text-[14px]">
              {col.links.map(([label, href]) => (
                <li key={label}>
                  <Link href={href} className="text-muted hover:text-ink">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-[13px] text-faint md:px-6">
          <p>
            © {new Date().getFullYear()} {COMPANY}. Claritia is a {COMPANY} product.
          </p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-ink">
            {CONTACT_EMAIL}
          </a>
        </div>
      </div>
    </footer>
  );
}
