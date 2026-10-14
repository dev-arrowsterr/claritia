import { requireKey } from "@/lib/apiAuth";
import { mcp } from "@/lib/mcpTools";

// Up to 45 seconds waiting for runs, plus the time to start them.
export const maxDuration = 60;

/**
 * The Claritia MCP server, for Claude Code, Cursor and other agents (Streamable HTTP, JSON answers).
 *   claude mcp add --transport http claritia https://app.tryclaritia.com/api/mcp --header "Authorization: Bearer clr_..."
 */
export async function POST(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const reply = await mcp(caller, await request.text());
  return reply === null ? new Response(null, { status: 202 }) : Response.json(reply);
}

// No server-sent stream and no sessions: every answer comes back on its POST.
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
