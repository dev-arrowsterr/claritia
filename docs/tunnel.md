# Tunnel: test localhost

```bash
export CLARITIA_API_KEY=clr_...
npx claritia tunnel 3000            # leave it running
npx claritia run --base-url http://localhost:3000
```

While the tunnel runs, any run or exploration in the workspace whose address is `localhost` (or `127.0.0.1`, or
`*.localhost`) reaches this machine through it: from the app, from the CLI with `--base-url`, from schedules, and
from coding agents through MCP (`verify_change` with `base_url: http://localhost:3000`). An environment can point at
`http://localhost:3000` too.

- **Only the ports named** are shared, and only on this machine (`localhost`, `127.0.0.1`, `::1`). Nothing else on
  the network is reachable, and the runner still refuses every other private address.
- No tunnel open, or one for another port: the run stops at once with a setup error that says the command to run.
- The CLI reconnects after drops. Ctrl+C closes the tunnel.
- Needs Node.js 22 or newer (for its built-in WebSocket).

## How it works

```
browser (runner) → runner intercepts localhost requests → relay (Fly) → developer's CLI → localhost:3000
```

- `relay/` is a small always-on WebSocket service (`fly.relay.toml`). The CLI connects as a provider with the API
  key (checked with `api_key_auth`); the relay records the tunnel in `tunnels` (`supabase/migrations/019_tunnels.sql`).
- The runner connects as a consumer with `RELAY_SECRET` and the workspace's open tunnel (`open_tunnel`), and answers
  the browser's localhost requests with `tunnelFetch` (`worker/tunnel.ts`). Other requests go out as usual.
- Streams are multiplexed over one WebSocket: binary frames carry a 4-byte stream id and data; text frames are
  `open`, `opened`, `fail` and `end`.
- `tests/tunnel.test.ts` (relay, CLI and client end to end) and `scripts/tunnel-check.ts` (a real browser signing in
  on localhost, no tunnel, the wrong port, exploring localhost).

## Setup (once)

1. Make a long random secret: `openssl rand -hex 32`.
2. `fly apps create claritia-relay`, then
   `fly secrets set --app claritia-relay SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RELAY_SECRET=<secret>`.
   The deploy workflow deploys it with the app and the runner.
3. On the runner: `fly secrets set --app claritia-runner RELAY_URL=wss://claritia-relay.fly.dev RELAY_SECRET=<secret>`.

## Running cost

One always-on shared-cpu-1x machine with 256 MB: about $2 a month (check), plus outbound data at $0.02 to $0.04 per
GB (check). About $3 at Beta (50 teams) and about $15 at Growth (500 teams, a 512 MB machine and more data).
