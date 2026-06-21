# Cloudflare Relay

Threadlines Relay is the planned mobile-connect path for using a desktop
Threadlines session from a phone or tablet without Tailscale, SSH, port
forwarding, or a public desktop IP.

The desktop still runs Codex, Claude, git, terminals, and project access. The
Cloudflare Worker only coordinates encrypted WebSocket connections between the
desktop and browser clients.

## Current Slice

This branch adds the first working relay path:

- `apps/relay-worker`: Cloudflare Worker + Durable Object service.
- `packages/contracts/src/relay.ts`: shared relay message and session schemas.
- one Durable Object per relay session.
- envelope mode for relay-level tests and raw mode for the app WebSocket bridge.
- web pairing support for hosted `app.threadlines.dev` relay links.
- desktop IPC support for creating and stopping a phone link.
- a user-facing `Phone link` row in Connections settings.
- generated Wrangler runtime types in `apps/relay-worker/src/worker-configuration.d.ts`.

This does not replace the existing direct local WebSocket path. Relay-backed
saved environments are added alongside direct and SSH environments.

## Live Test Status

As of 2026-06-20, the first hosted path is online:

- Relay Worker: `https://threadlines-relay.threadlines.workers.dev`
- Hosted app: `https://app.threadlines.dev`
- Vercel projects are intentionally split:
  - `threadlines` serves the marketing site at `threadlines.dev` and
    `www.threadlines.dev`.
  - `threadlines-app` serves the hosted app shell at `app.threadlines.dev`.

Verified live:

- `GET /health` returns the relay health payload.
- `POST /v1/sessions` creates a pairing session.
- generated pairing URLs point to `https://app.threadlines.dev/pair`.
- a raw-mode WebSocket message forwards between simulated desktop and device
  sockets through the Durable Object.

## Cloudflare Setup Needed

Required:

- A Cloudflare account.
- Wrangler login on this machine, or a Cloudflare API token in CI.
- A verified Cloudflare account email address. Deploy fails with Cloudflare API
  error `10034` until the account email is verified.
- Workers/Durable Objects enabled for the account.

Optional for first test:

- Use the default `https://threadlines-relay.threadlines.workers.dev` deployment URL.

Recommended before real user testing:

- Add a custom Worker domain such as `relay.threadlines.dev`.
- Keep `app.threadlines.dev` on Vercel for the web UI.
- Cloudflare Worker custom domains require the domain's nameservers to be
  managed by Cloudflare. If `threadlines.dev` remains on Vercel nameservers, use
  the `*.workers.dev` relay URL for the first test or move DNS management to
  Cloudflare and recreate the Vercel app records there.
- Set `THREADLINES_RELAY_PUBLIC_ORIGIN` to the public relay origin if the Worker
  is behind a custom domain.
- Set desktop `THREADLINES_RELAY_URL` to the public relay origin when it differs
  from the default `https://threadlines-relay.threadlines.workers.dev`.

No Cloudflare secret is required for the current MVP. Tokens are generated per
relay session with Web Crypto and stored as SHA-256 hashes in the Durable Object.

## Commands

From the repo root:

```powershell
bun run --cwd apps/relay-worker types
bun run --cwd apps/relay-worker test
bun run --cwd apps/relay-worker typecheck
```

Local Worker dev:

```powershell
bun run --cwd apps/relay-worker dev
```

Deploy after `wrangler login`:

```powershell
bun run --cwd apps/relay-worker deploy
```

Dry-run deploy validation:

```powershell
bunx wrangler deploy --dry-run --config apps/relay-worker/wrangler.jsonc
```

## Runtime Flow

1. Desktop Connections settings creates a `Phone link`.
2. Desktop asks the relay Worker to create a session with `POST /v1/sessions`.
3. Worker creates high-entropy desktop/device tokens.
4. Worker stores token hashes in the session Durable Object.
5. Desktop opens a local backend WebSocket and a raw-mode desktop relay
   WebSocket, then pipes frames between them.
6. Phone or tablet opens the returned pairing URL through `app.threadlines.dev`.
7. The hosted app stores the relay environment and opens a raw-mode device relay
   WebSocket.
8. The Durable Object relays app WebSocket frames between the phone browser and
   the desktop app.

Preferred WebSocket auth uses subprotocols:

```ts
new WebSocket(socketUrl, ["threadlines-relay", `threadlines-token.${token}`]);
```

The Worker still accepts `?token=` as a manual testing fallback.

## Next Integration Steps

1. Restart the desktop app after pulling this branch so it uses the default
   relay URL, `https://threadlines-relay.threadlines.workers.dev`.
2. In Settings, open Connections and create a `Phone link`.
3. Open the generated `app.threadlines.dev` pairing URL on a phone or tablet.
4. For `relay.threadlines.dev`, move `threadlines.dev` DNS management to
   Cloudflare or use another Cloudflare-managed zone, then attach
   `relay.threadlines.dev` as the Worker custom domain.
5. Set `THREADLINES_RELAY_PUBLIC_ORIGIN=https://relay.threadlines.dev` for the
   Worker if the custom domain is not inferred from the request.
6. Add browser/runtime coverage for reconnects, expired sessions, and desktop
   disconnects.
