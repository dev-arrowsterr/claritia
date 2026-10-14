// The Claritia tunnel relay. A developer's machine connects as a provider (`npx claritia tunnel 3000`, with a workspace
// API key); the runner connects as a consumer (with the relay secret) and asks the provider to open TCP streams to
// localhost ports, which the relay passes through both ways. Nothing is stored here but which tunnels are open.
//
// Frames: text = JSON control ({t: "auth" | "hello" | "open" | "opened" | "fail" | "end", s?: stream id, ...});
// binary = 4-byte big-endian stream id + data. The first message on any connection must be {t: "auth"} within 10s.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const MAX_PORTS = 10;
const MAX_STREAMS = 256;
const AUTH_MS = 10_000;
const PING_MS = 20_000;

export const frame = (id, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(id >>> 0);
  return Buffer.concat([head, Buffer.from(data)]);
};
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

/**
 * @param {{ secret: string, verifyKey: (key: string) => Promise<{ workspaceId: string, keyId: string } | null>,
 *   saveTunnel: (t: { workspaceId: string, keyId: string, ports: number[] }) => Promise<string>,
 *   touchTunnel: (id: string) => Promise<void>, closeTunnel: (id: string) => Promise<void>, log?: (...a: unknown[]) => void }} deps
 */
export function createRelay(deps) {
  const log = deps.log ?? (() => {});
  /** tunnel id → { ws, ports, streams: Map<global id, { consumer, local }> } */
  const providers = new Map();
  let nextGlobal = 1;

  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/health" ? { ok: true, tunnels: providers.size } : { error: "Not found" }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

  wss.on("connection", (ws, req) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/provide" && path !== "/consume") return ws.close(4404, "Unknown path");
    const timer = setTimeout(() => ws.close(4401, "No auth"), AUTH_MS);
    ws.once("message", async (raw, isBinary) => {
      clearTimeout(timer);
      let msg;
      try {
        msg = isBinary ? null : JSON.parse(String(raw));
      } catch {
        msg = null;
      }
      if (!msg || msg.t !== "auth") return ws.close(4401, "Send auth first");
      try {
        if (path === "/provide") await provide(ws, msg);
        else consume(ws, msg);
      } catch (e) {
        log("auth failed:", e instanceof Error ? e.message : e);
        ws.close(4500, "Relay error");
      }
    });
  });

  async function provide(ws, msg) {
    const key = await deps.verifyKey(String(msg.key ?? ""));
    if (!key) return ws.close(4401, "This API key is wrong or was revoked.");
    const ports = [...new Set((Array.isArray(msg.ports) ? msg.ports : []).map(Number))].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (!ports.length || ports.length > MAX_PORTS) return ws.close(4400, `Name 1 to ${MAX_PORTS} ports.`);
    const id = await deps.saveTunnel({ workspaceId: key.workspaceId, keyId: key.keyId, ports });
    const p = { ws, ports, streams: new Map() };
    providers.set(id, p);
    ws.send(JSON.stringify({ t: "hello", tunnel: id, ports }));
    log(`tunnel ${id} open for ports ${ports.join(", ")}`);
    const ping = setInterval(() => {
      ws.ping();
      void deps.touchTunnel(id).catch(() => {});
    }, PING_MS);
    ws.on("message", (raw, isBinary) => {
      // From the developer's machine: replies and data for a consumer's stream.
      if (isBinary) {
        const buf = Buffer.from(raw);
        const target = p.streams.get(buf.readUInt32BE(0));
        if (target && target.consumer.readyState === 1) target.consumer.send(frame(target.local, buf.subarray(4)));
        return;
      }
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const target = p.streams.get(m.s);
      if (!target) return;
      if (target.consumer.readyState === 1) target.consumer.send(JSON.stringify({ ...m, s: target.local }));
      if (m.t === "fail" || m.t === "end") p.streams.delete(m.s);
    });
    ws.on("close", () => {
      clearInterval(ping);
      providers.delete(id);
      for (const target of p.streams.values()) if (target.consumer.readyState === 1) target.consumer.send(JSON.stringify({ t: "fail", s: target.local, message: "The tunnel closed." }));
      void deps.closeTunnel(id).catch(() => {});
      log(`tunnel ${id} closed`);
    });
  }

  function consume(ws, msg) {
    if (!sameSecret(msg.secret, deps.secret)) return ws.close(4401, "Wrong relay secret");
    const p = providers.get(String(msg.tunnel ?? ""));
    if (!p) return ws.close(4404, "That tunnel isn't open.");
    ws.send(JSON.stringify({ t: "hello", tunnel: msg.tunnel, ports: p.ports }));
    /** local id → global id, for this consumer */
    const mine = new Map();
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(raw);
        const g = mine.get(buf.readUInt32BE(0));
        if (g !== undefined && p.ws.readyState === 1) p.ws.send(frame(g, buf.subarray(4)));
        return;
      }
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === "open") {
        if (mine.size >= MAX_STREAMS) return ws.send(JSON.stringify({ t: "fail", s: m.s, message: "Too many open streams." }));
        if (!p.ports.includes(Number(m.port))) return ws.send(JSON.stringify({ t: "fail", s: m.s, message: `Port ${m.port} isn't shared by the tunnel. It shares ${p.ports.join(", ")}.` }));
        const g = nextGlobal++;
        mine.set(m.s, g);
        p.streams.set(g, { consumer: ws, local: m.s });
        p.ws.send(JSON.stringify({ t: "open", s: g, host: m.host, port: Number(m.port) }));
      } else if (m.t === "end") {
        const g = mine.get(m.s);
        if (g !== undefined) {
          p.ws.send(JSON.stringify({ t: "end", s: g }));
          mine.delete(m.s);
        }
      }
    });
    ws.on("close", () => {
      for (const g of mine.values()) {
        p.streams.delete(g);
        if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: "end", s: g }));
      }
    });
  }

  return { server, providers, close: () => new Promise((r) => { wss.close(); server.close(() => r()); }) };
}
