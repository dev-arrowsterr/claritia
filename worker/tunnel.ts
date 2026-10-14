// The runner's side of a tunnel: connects to the relay as a consumer, opens TCP streams to the developer's localhost
// through it, and fetches HTTP over them. A run whose address is localhost has its browser requests to local hosts
// answered this way (see executeRun), so nothing on the runner's own network is ever reached.

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Duplex } from "node:stream";

export type TunnelClient = { stream: (host: string, port: number) => Duplex; close: () => void; ports: number[] };

const frame = (id: number, data: Uint8Array) => {
  const out = new Uint8Array(4 + data.length);
  new DataView(out.buffer).setUint32(0, id >>> 0);
  out.set(data, 4);
  return out;
};

/** Hosts that mean the developer's own machine. */
export const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1|\[?::1\]?|[^.]+\.localhost)$/i.test(host);

/** Connect to the relay for one tunnel. Rejects if the tunnel isn't open. */
export function connectTunnel(opts: { relayUrl: string; secret: string; tunnelId: string; timeoutMs?: number }): Promise<TunnelClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${opts.relayUrl.replace(/\/+$/, "")}/consume`);
    ws.binaryType = "arraybuffer";
    const streams = new Map<number, { duplex: Duplex; opened: () => void; failed: (e: Error) => void }>();
    let next = 1;
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error("The tunnel relay didn't answer."));
      ws.close();
    }, opts.timeoutMs ?? 10_000);

    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "auth", secret: opts.secret, tunnel: opts.tunnelId })));
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(e.reason || "The tunnel isn't open."));
      for (const s of streams.values()) s.failed(new Error("The tunnel closed."));
      streams.clear();
    });
    ws.addEventListener("error", () => undefined);
    ws.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const buf = Buffer.from(ev.data);
        streams.get(buf.readUInt32BE(0))?.duplex.push(buf.subarray(4));
        return;
      }
      const m = JSON.parse(String(ev.data)) as { t: string; s?: number; ports?: number[]; message?: string };
      if (m.t === "hello" && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve({ stream, close: () => ws.close(), ports: m.ports ?? [] });
        return;
      }
      const s = m.s !== undefined ? streams.get(m.s) : undefined;
      if (!s) return;
      if (m.t === "opened") s.opened();
      else if (m.t === "fail") {
        s.failed(new Error(m.message ?? "The developer's machine refused the connection."));
        streams.delete(m.s!);
      } else if (m.t === "end") {
        s.duplex.push(null);
        streams.delete(m.s!);
      }
    });

    function stream(host: string, port: number): Duplex {
      const id = next++;
      let open = false;
      const waiting: (() => void)[] = [];
      const duplex = new Duplex({
        read() {},
        write(chunk: Buffer, _enc, cb) {
          const send = () => {
            if (ws.readyState !== WebSocket.OPEN) return cb(new Error("The tunnel closed."));
            ws.send(frame(id, chunk));
            cb();
          };
          if (open) send();
          else waiting.push(send);
        },
        final(cb) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "end", s: id }));
          cb();
        },
      });
      // Node's HTTP client treats its connection as a socket and calls these.
      Object.assign(duplex, { setTimeout: () => duplex, setNoDelay: () => duplex, setKeepAlive: () => duplex, ref: () => duplex, unref: () => duplex });
      streams.set(id, {
        duplex,
        opened: () => {
          open = true;
          waiting.splice(0).forEach((f) => f());
        },
        failed: (e) => duplex.destroy(e),
      });
      ws.send(JSON.stringify({ t: "open", s: id, host, port }));
      return duplex;
    }
  });
}

export type TunnelResponse = { status: number; headers: Record<string, string>; body: Buffer };
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
const MAX_BODY = 50 * 1024 * 1024;

/** One HTTP request over the tunnel. Asks for no compression, so the body can be handed to the browser as is. */
export function tunnelFetch(t: TunnelClient, req: { url: string; method: string; headers: Record<string, string>; body?: Buffer | null }, timeoutMs = 30_000): Promise<TunnelResponse> {
  const u = new URL(req.url);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== "accept-encoding") headers[k] = v;
  headers["accept-encoding"] = "identity";
  headers.host = u.host;
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { method: req.method, path: `${u.pathname}${u.search}`, headers, createConnection: () => t.stream(host === "localhost" || host.endsWith(".localhost") ? "localhost" : host, port) as never },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) r.destroy(new Error("The response was over 50 MB."));
          else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: flat(res.headers), body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => r.destroy(new Error(`${u.host} took longer than ${Math.round(timeoutMs / 1000)}s to answer through the tunnel.`)), timeoutMs);
    r.on("close", () => clearTimeout(timer));
    r.on("error", reject);
    r.end(req.body ?? undefined);
  });
}

function flat(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = Array.isArray(v) ? v.join(k === "set-cookie" ? "\n" : ", ") : v;
  return out;
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * The tunnel for a run or exploration whose address is localhost: the workspace's open tunnel, connected. Nothing for
 * any other address. An error says plainly what to do (start a tunnel, share the right port).
 */
export async function tunnelFor(sb: Rpc, workspaceId: string, baseUrl: string, relay = { url: process.env.RELAY_URL?.trim() ?? "", secret: process.env.RELAY_SECRET?.trim() ?? "" }): Promise<{ client?: TunnelClient; error?: string }> {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return {};
  }
  if (!isLocalHost(u.hostname.replace(/^\[|\]$/g, ""))) return {};
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!relay.url || !relay.secret) return { error: "Tunnels aren't set up on this runner, so localhost can't be reached." };
  const { data, error } = await sb.rpc("open_tunnel", { p_workspace: workspaceId });
  if (error) return { error: `Couldn't look up the tunnel: ${error.message}` };
  const row = (data as { id: string; ports: number[] }[] | null)?.[0];
  if (!row) return { error: `Nothing is tunneled to localhost. Run "npx claritia tunnel ${port}" on your machine, then run again.` };
  if (!row.ports.includes(port)) return { error: `The tunnel shares localhost:${row.ports.join(", localhost:")}, not localhost:${port}. Run "npx claritia tunnel ${port}".` };
  try {
    return { client: await connectTunnel({ relayUrl: relay.url, secret: relay.secret, tunnelId: row.id }) };
  } catch (e) {
    return { error: `Couldn't connect to the tunnel: ${e instanceof Error ? e.message : e}` };
  }
}
