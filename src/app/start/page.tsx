import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Claritia · Start" };

// The app's front door until sign-up ships.
export default function Start() {
  return (
    <main className="paper flex min-h-screen items-center justify-center px-4">
      <div className="frame w-full max-w-md border border-line bg-white p-8">
        <Logo />
        <p className="fig mt-8">{"// fig. 00 — start here"}</p>
        <h1 className="mt-3 text-[28px] leading-tight font-medium tracking-[-0.03em]">The app opens soon.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">Claritia is in private beta. Send us your URL and we&apos;ll set up your first tests with you.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={`mailto:${CONTACT_EMAIL}?subject=Claritia%20beta`} className="inline-flex h-10 items-center rounded-md bg-ink px-5 text-[14px] font-medium text-white transition hover:bg-[#2b2b29]">
            Join the beta
          </a>
          <a href="https://tryclaritia.com" className="inline-flex h-10 items-center rounded-md border border-line px-5 text-[14px] font-medium text-ink transition hover:border-line-strong">
            Back to the site
          </a>
        </div>
      </div>
    </main>
  );
}
