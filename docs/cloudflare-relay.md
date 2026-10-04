# Cloudflare Relay

Threadlines Relay lets a phone, tablet, or another computer use a Threadlines
server from anywhere, without Tailscale, SSH, port forwarding, or a public IP.

The computer with the projects still runs Codex, Claude, git, terminals, and
project access. The Cloudflare Worker only forwards WebSocket frames between
that computer's server and the devices it has allowed. Those frames are end-to-end
encrypted: the relay can't read or change them, and can't pose as either side.
When a device can reach the computer directly (same network or Tailscale), it
skips the relay altogether.

## Where it lives

- `apps/relay-worker`: the Worker and its Durable Objects. `src/v2/` is
  Connect a device; `src/index.ts` still serves the retired v1 phone links.
- `packages/contracts/src/relay.ts`: relay wire schemas, close codes, and the
  v1 session schemas. `relayAccess.ts`: the owner-facing RPC shapes.
- `packages/shared/src/relaySecure.ts`: the end-to-end encryption (Noise KK
  handshake, encrypted framing) and the pairing math (commitment, match number,
  QR claim proof), shared by server and web.
- `apps/server/src/relay/`: the host side (`RelayHost.ts`), which registers the
  server with the relay, checks and approves joins, issues device sessions, and
  serves each device's encrypted connection (`securePipe.ts`) over a relay
  pipe or the direct endpoint (`directRoute.ts`, `directRoutes.ts`).
- `apps/web/src/relayDevice.ts` and `environments/runtime/relayJoins.ts`: the
  joiner side (typing a code, claiming a QR invite, waiting for Allow).
  `rpc/secureRelaySocket.ts` is the device end of every encrypted connection.
- `apps/web/src/components/settings/connections/`: the Connect a device and
  Connect to a computer dialogs.

## Connect a device (v2)

The server registers itself once (`POST /v2/hosts`) and keeps a control
WebSocket open to its own `RelayHost` Durable Object, sending a lease every
60 seconds. The relay treats a host as offline after 150 seconds without one.

Joining:

1. The owner clicks **Connect a device**. The server makes a QR invite secret
   and asks its Durable Object for an invite: a 6-digit code (10 minutes, one
   try). The relay only gets a hash of a claim token derived from the secret.
2. A computer types the code. It makes a static key pair and a nonce, and its
   own server sends `POST /v2/join` with its public key, a commitment to the
   key and nonce, and hashes of a device secret and a request secret (the
   secrets never leave the joiner).
3. The host server stores the join in `relay_pairings` and sends back its own
   nonce and public key (`POST .../requests/{r}/host-nonce`). The joiner
   freezes them, shows the 4-digit match number, and reveals its nonce
   (`POST .../requests/{r}/reveal`).
4. The host checks the nonce against the commitment, works out the same
   number from its own stored copy, and only then shows **Allow {name}?**.
   Allow records the device and its pinned public key, issues it a client
   session, and tells the relay to approve.
5. A phone that scans the QR code takes the host's public key from the QR and
   claims the invite with the claim token and a proof made with a key derived
   from the secret. The relay never sees that key; the host checks the proof
   and approves without a prompt, because only someone who saw the owner's
   screen could make it.

Why the number works: a relay in the middle has to commit to a fake key before
it sees the host's nonce, and has to hand the joiner a nonce before it learns
the joiner's. It gets one blind guess per code (each code gets one try,
enforced by the host), which matches 1 time in 10,000; otherwise the two
screens show different numbers.

Codes live in ten `RelayCodeShard` Durable Objects keyed by the code's last
digit, so lookups never touch every host. A used or denied code stays routable
until it expires, so a joiner whose first reply was lost can retry its join.

Connecting: the device first tries the direct routes the host last reported
(LAN addresses when the host listens on the network, the Tailscale HTTPS name
when Tailscale Serve is on; https pages only use `wss://` routes), for at most
1.5 seconds, at `/relay/direct/{deviceId}` on the host's own server. Otherwise
it opens `/v2/hosts/{h}/devices/{d}/connect`; the relay holds the upgrade,
tells the host's control socket `device.connecting`, and the host opens
`/v2/hosts/{h}/pipes/{p}`. The two sockets are spliced. A host that refuses
(device revoked, still approving) closes the device socket with a code the
client understands. A device whose relay route is on hold still checks its
direct routes every minute.

Either way, the device then runs a Noise KK handshake with the host
(`Noise_KK_P256_AESGCM_SHA256`, prologue binding host and device ids), with
both static keys pinned at pairing. The host opens the app's `/ws` only after
the device's first encrypted record, so a replayed handshake never counts as a
live device. All app frames are binary ciphertext, split into parts under the
1 MiB cap. On the relay route the only plaintext is the RPC heartbeat, which
the relay answers at the edge; an encrypted keepalive every minute of silence
proves the host itself is still there, and the device reconnects after 150
seconds without one. The direct endpoint has no HTTP sign-in (the handshake is
the sign-in), and caps handshakes in progress at 32 overall and 4 per address.

Device sessions last 90 days and are renewed every 6 hours while the device is
connected. **Remove access** revokes the session on the server and the device
at the relay, which closes the device's socket with `4003`.

Close codes the client acts on:

| Code   | Meaning                         | Client behavior                      |
| ------ | ------------------------------- | ------------------------------------ |
| `4001` | Replaced by a newer connection  | Hold; another window took over       |
| `4003` | Access removed                  | Hold until the user connects again   |
| `4004` | This computer's daily allowance | Retry after 15 minutes               |
| `4005` | Relay-wide budget reached       | Retry after 15 minutes               |
| `4006` | Host offline                    | Back off 30 s, 60 s, 120 s, then 5 m |
| `1013` | Not ready yet                   | Retry with backoff                   |

The relay answers `{"_tag":"Ping"}` with `{"_tag":"Pong"}` at the edge
(`setWebSocketAutoResponse`), so client heartbeats don't wake the Durable
Object or count against the allowance.

## Limits (Workers Free)

The relay stays on Workers Free, which has a hard daily ceiling. Each host gets
a share of it:

- `THREADLINES_RELAY_HOST_DAILY_MESSAGES` (200,000): forwarded frames per host
  per UTC day. Settings shows this as "Relay use today: N% of the free daily
  allowance".
- `THREADLINES_RELAY_HOST_DAILY_AWAKE_SECONDS` (86,400): awake time per host.
  Hibernated sockets aren't billed while idle, so this is tracked but
  effectively uncapped by default.
- `THREADLINES_RELAY_DAILY_MESSAGE_BUDGET` (1,200,000): relay-wide frames per
  day, kept in the `RelayLedger` Durable Object. Past it, new connections get
  `4005`.
- `THREADLINES_RELAY_REGISTRATIONS_PER_IP_PER_DAY` (20): new hosts per IP.
- `JOIN_RATE_LIMITER`: 10 join attempts per IP per minute.
- At most 50 devices per host.

Usage is tallied on each socket's attachment (so it survives hibernation) and
committed to storage at most once a minute, or when a device disconnects.

Measured on a local relay: an idle connected device sends close to zero
frames; clicking around another computer's projects is about 490 frames a
minute. A long agent turn has not been measured yet.

`THREADLINES_RELAY_V2_ENABLED=false` turns Connect a device off without
touching v1.

## v1 phone links (retired)

Older desktop builds created one `RelaySession` Durable Object per phone link
through `POST /v1/sessions`, with the Electron main process bridging frames.
Current builds don't create them. A desktop updated from a build that had a
phone link deletes that session once (`DELETE /v1/sessions/{id}`) and shows a
one-time notice in Connections. Phones on an old link see "This link doesn't work anymore" and
scan a new QR code. The v1 routes stay deployed for older desktop builds.

## Privacy and trust boundary

"Connect a device" connections are end-to-end encrypted between the device and
the host server, on the relay and on direct routes alike. The relay sees which
host and device talk, when, and how much, but not prompts, files, diffs, or
terminal output, and it can't inject or alter frames: anything it changes fails
to decrypt and ends the connection. What still relies on trust:

- Code joins: a relay in the middle gets one 1-in-10,000 guess per code; the
  owner sees mismatched numbers the rest of the time.
- The hosted app's code (`app.threadlines.dev`), which phones run: it handles
  their keys.
- Devices keep their keys where they keep other saved-computer secrets (the OS
  keychain on desktop, browser storage in the hosted app).

Old v1 phone links were not end-to-end encrypted; they are retired. Users who
want no third party at all can use Same network, Tailscale, or SSH under
Connection options, or self-host the relay and set `THREADLINES_RELAY_URL` on
the server (and `VITE_RELAY_URL` for a self-hosted web app).

## Setup and deploy

The default relay is `https://threadlines-relay.threadlines.workers.dev`. The
hosted app is `https://app.threadlines.dev`. Deploys need a Cloudflare account
with a verified email (error `10034` otherwise) and `wrangler login` or an API
token.

From the repo root:

```sh
vp run '@threadlines/relay-worker#types'      # regenerate worker-configuration.d.ts after wrangler.jsonc changes
vp run '@threadlines/relay-worker#test'
vp run '@threadlines/relay-worker#typecheck'
vp run '@threadlines/relay-worker#dev'        # local relay; point THREADLINES_RELAY_URL at it
vp run '@threadlines/relay-worker#deploy'
```

Deploying v2 the first time applies the `v2` Durable Object migration
(`RelayHost`, `RelayCodeShard`, `RelayLedger`). Deploy the relay before
shipping a desktop or server build that uses it; older relays answer `/v2/`
with 404, which Settings reports as "This relay doesn't support device codes
yet."

For a custom domain such as `relay.threadlines.dev`, the zone must be managed
by Cloudflare. Set `THREADLINES_RELAY_PUBLIC_ORIGIN` on the Worker if the
public origin isn't inferred from requests, and add the hosted app's origin to
`THREADLINES_ALLOWED_ORIGINS` so phones can join from it.
