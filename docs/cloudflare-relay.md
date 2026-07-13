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

## Privacy and trust boundary

Phone Link is an opt-in remote-access path. Its WebSockets use TLS, but the app
protocol is not currently end-to-end encrypted above that transport. Relay
frames can contain prompts, responses, file contents, diffs, and terminal data.
The Worker forwards those frames in memory and does not intentionally persist
their contents, while Cloudflare remains part of the transport trust boundary.

Users who do not want project traffic to pass through the hosted relay should
leave Phone Link disconnected, use a direct or SSH connection, or self-host the
relay and set `THREADLINES_RELAY_URL` to that deployment.

## Cost and abuse controls

The public relay uses Cloudflare's Durable Object WebSocket Hibernation API, so
idle connections remain attached without continuously accruing active-duration
charges. The deployment also applies:

- at most five new relay sessions per minute per Cloudflare client IP;
- at most 3,000 incoming frames per minute per relay session;
- at most four connected phone/browser devices per relay session; and
- a session-creation kill switch through
  `THREADLINES_RELAY_SESSION_CREATION_ENABLED=false`.

The rate-limit counters are intentionally permissive and local to a Cloudflare
location. They reduce accidental and single-source abuse but are not an exact
billing ledger. Keep the relay on Workers Free for a hard platform usage ceiling
at launch. If the account moves to Workers Paid, configure several account-wide
budget alerts; Cloudflare budget alerts notify but do not stop usage.

## Commands

From the repo root:

```powershell
pnpm --filter @threadlines/relay-worker run types
pnpm --filter @threadlines/relay-worker run test
pnpm --filter @threadlines/relay-worker run typecheck
```

Local Worker dev:

```powershell
pnpm --filter @threadlines/relay-worker run dev
```

Deploy after `wrangler login`:

```powershell
pnpm --filter @threadlines/relay-worker run deploy
```

Dry-run deploy validation:

```powershell
pnpm --filter @threadlines/relay-worker exec wrangler deploy --dry-run --config wrangler.jsonc
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

Connection lifecycle rules in raw mode:

- A new desktop connection replaces any existing desktop socket (close code
  `4001`), so a half-dead socket left by sleep or a network drop cannot block
  reconnects. The replaced desktop stops reconnecting when it sees `4001`.
- Desktop frames sent while no device is connected are dropped, not treated as
  an error. Devices resync from a fresh snapshot when they reconnect.
- Device frames sent while no desktop is connected close the device socket
  with `1013` so the device retries with backoff.
- The Durable Object notifies raw-mode desktop sockets of device joins and
  leaves with control frames: an ASCII record separator (`U+001E`) followed by
  a `relay.peer-joined` / `relay.peer-left` JSON event. The desktop bridge
  uses these to recycle its local backend socket so a reconnecting device
  never resumes on a server connection that still holds a previous device's
  RPC state.

Preferred WebSocket auth uses subprotocols:

```ts
new WebSocket(socketUrl, ["threadlines-relay", `threadlines-token.${token}`]);
```

Tokens are not accepted in query strings because URLs may be retained in logs
or browser history. Status and renewal requests use `Authorization: Bearer`.

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
