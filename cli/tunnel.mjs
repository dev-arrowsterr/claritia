// `claritia tunnel 3000`: lets Claritia's cloud browser reach this machine's localhost, only on the ports named.
// Connects to the relay with the workspace API key; the relay asks for TCP streams to localhost:<port>, and this
// opens them and passes the bytes both ways. Anything else (another host, another port) is refused here.

import { connect } from "node:net";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

const frame = (id, data) => {
  const out = Buffer.alloc(4 + data.length);
  out.writeUInt32BE(id >>> 0);
  Buffer.from(data).copy(out, 4);
  return out;
};

/**
 * Keep a tunnel open until `signal` aborts. Reconnects after drops. Resolves with an exit code.
 * @param {{ key: string, relay: string, ports: number[], out: (s: string) => void, err: (s: string) => void, signal?: AbortSignal, onOpen?: (id: string) => void }} o
 */
export async function runTunnel(o) {
  if (typeof WebSocket !== "function") {
    o.err("The tunnel needs Node.js 22 or newer.");
    return 3;
  }
  let delay = 1000;
  let first = true;
  while (!o.signal?.aborted) {
    const result = await connectOnce(o, first);
    first = false;
    if (result.fatal) {
      o.err(result.reason);
      return 3;
    }
    if (o.signal?.aborted) break;
    o.err(`Tunnel dropped (${result.reason}). Reconnecting in ${Math.round(delay / 1000)}s.`);
    await new Promise((r) => {
      const t = setTimeout(r, delay);
      o.signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
    delay = Math.min(delay * 2, 30_000);
  }
  o.out("Tunnel closed.");
  return 0;
}

function connectOnce(o, first) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${o.relay.replace(/\/+$/, "")}/provide`);
    ws.binaryType = "arraybuffer";
    /** stream id → socket */
    const sockets = new Map();
    let opened = false;
    const stop = () => ws.close(1000, "Stopped");
    o.signal?.addEventListener("abort", stop, { once: true });

    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "auth", key: o.key, ports: o.ports })));
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", (e) => {
      o.signal?.removeEventListener("abort", stop);
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
      // A refused key or bad ports won't fix itself: stop instead of retrying.
      const fatal = e.code === 4401 || e.code === 4400 || (!opened && first && e.code !== 1000);
      resolve({ fatal, reason: e.reason || (opened ? "connection lost" : "couldn't reach the Claritia relay") });
    });
    ws.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const buf = Buffer.from(ev.data);
        sockets.get(buf.readUInt32BE(0))?.write(buf.subarray(4));
        return;
      }
      const m = JSON.parse(String(ev.data));
      if (m.t === "hello") {
        opened = true;
        o.out(`Tunnel open: Claritia can reach ${m.ports.map((p) => `localhost:${p}`).join(", ")} on this machine. Press Ctrl+C to stop.`);
        o.onOpen?.(m.tunnel);
        return;
      }
      if (m.t === "open") {
        const host = String(m.host ?? "").replace(/^\[|\]$/g, "");
        if (!LOCAL.has(host) || !o.ports.includes(Number(m.port))) {
          ws.send(JSON.stringify({ t: "fail", s: m.s, message: `This tunnel only shares localhost:${o.ports.join(", localhost:")}.` }));
          return;
        }
        const sock = connect({ host: host === "localhost" ? "localhost" : host, port: Number(m.port) });
        sockets.set(m.s, sock);
        sock.on("connect", () => ws.readyState === 1 && ws.send(JSON.stringify({ t: "opened", s: m.s })));
        sock.on("data", (d) => ws.readyState === 1 && ws.send(frame(m.s, d)));
        sock.on("end", () => ws.readyState === 1 && ws.send(JSON.stringify({ t: "end", s: m.s })));
        sock.on("error", (e) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "fail", s: m.s, message: `Nothing answered on localhost:${m.port} (${e.code ?? e.message}). Is your app running?` }));
          sockets.delete(m.s);
        });
        sock.on("close", () => sockets.delete(m.s));
        return;
      }
      if (m.t === "end") {
        sockets.get(m.s)?.end();
        sockets.delete(m.s);
      }
    });
  });
}
