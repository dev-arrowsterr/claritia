import { SKILL } from "@/lib/skill";

export const dynamic = "force-static";

/** The Claritia agent skill (SKILL.md), at /skill.md. */
export function GET() {
  return new Response(SKILL, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
