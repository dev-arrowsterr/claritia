// A small MCP server over Streamable HTTP, answering with plain JSON (no streaming, no sessions).
// Handles initialize, ping, tools/list and tools/call; notifications get no answer.

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type ToolResult = { text: string; data?: unknown; isError?: boolean };
export type Tool<C> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  run: (ctx: C, args: Record<string, unknown>) => Promise<ToolResult>;
};

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

/** A tool's mistake the agent can fix (a bad argument, a missing test): shown as an error result, not a crash. */
export class ToolError extends Error {}

export function mcpServer<C>(opts: { name: string; title: string; version: string; instructions: string; tools: Tool<C>[] }) {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const ok = (id: Reply["id"], result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  const fail = (id: Reply["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function one(ctx: C, m: Message): Promise<Reply | null> {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return fail(null, -32600, "Not a JSON-RPC 2.0 message.");
    // Notifications and replies to us need no answer.
    if (m.id === undefined || m.id === null || typeof m.method !== "string") return null;
    const id = m.id;
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return ok(id, {
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, title: opts.title, version: opts.version },
          instructions: opts.instructions,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: opts.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        });
      case "tools/call": {
        const tool = byName.get(String(m.params?.name ?? ""));
        if (!tool) return fail(id, -32602, `Unknown tool: ${m.params?.name}`);
        const args = m.params?.arguments;
        if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return fail(id, -32602, "arguments must be an object.");
        try {
          const r = await tool.run(ctx, (args ?? {}) as Record<string, unknown>);
          return ok(id, { content: [{ type: "text", text: r.text }], ...(r.data !== undefined ? { structuredContent: r.data } : {}), isError: !!r.isError });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // A tool error goes back as a result the agent can read and act on.
          return ok(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `Unknown method: ${m.method}`);
    }
  }

  /** Answer an HTTP POST body: one message or a batch. Null means 202 with no body. */
  return async function handle(ctx: C, body: string): Promise<unknown | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail(null, -32700, "The body isn't JSON.");
    }
    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map((m) => one(ctx, m as Message)))).filter((r): r is Reply => !!r);
      return replies.length ? replies : null;
    }
    return one(ctx, parsed as Message);
  };
}
