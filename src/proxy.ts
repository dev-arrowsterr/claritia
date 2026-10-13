import { NextResponse, type NextRequest } from "next/server";

// One app on two domains: the marketing site on tryclaritia.com and the app on app.tryclaritia.com.
// Any other host (localhost, the onrender.com address) serves every page, so nothing changes there.

const SITE = process.env.SITE_HOST?.trim() || "tryclaritia.com";
const APP = process.env.APP_HOST?.trim() || "app.tryclaritia.com";
const MARKETING = new Set(["/"]);

export function proxy(request: NextRequest) {
  const raw = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const host = raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  const { pathname, search } = request.nextUrl;
  const go = (to: string, path: string) => NextResponse.redirect(`https://${to}${path}${search}`, 308);

  if (host === `www.${SITE}`) return go(SITE, pathname);
  if (host === SITE && !MARKETING.has(pathname)) return go(APP, pathname);
  if (host === APP && (pathname === "/" || pathname === "/start")) return go(APP, "/tests");
  return NextResponse.next();
}

// Next.js files and icons answer on any host.
export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|icon|apple-icon|.*\\.[a-zA-Z0-9]+$).*)"],
};
