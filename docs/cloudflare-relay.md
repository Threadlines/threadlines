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
  pipe or the direct endpoint (`directRoute.ts`, `directRoutes.ts`). Event
  task hooks (`RelayHooks.ts`, `RelayHooksLive.ts`) ride on the same
  registration and control socket.
- `apps/relay-worker/src/v2/hookRoute.ts`, `hooks.ts`: event task addresses
  at the edge; `hostCore.ts` keeps hooks and waiting deliveries.
- `apps/relay-worker/src/v2/assistants/`: the assistants door (see
  Assistants below). `packages/contracts/src/relayAssistants.ts` has its
  relay <-> computer shapes, `packages/shared/src/assistantCredentials.ts` its
  credential and sign-in code formats.
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

## Event task hooks

Event tasks (docs/design/event-tasks.md) start when another service sends a
webhook. The relay gives each one a public address and holds what arrives
until the computer takes it.

Addresses look like `/v2/hooks/{hostId}/{hookId}/{mac}`. The host mints one
with `POST /v2/hosts/{h}/hooks` (host secret); `hookId` is 16 random bytes and
the mac is `base64url(HMAC-SHA256(HOOK_PATH_KEY, "v1|" + hostId + "|" +
hookId))`. A delivery (`POST`, `PUT` or `PATCH`; `GET` gets `405`) passes, in
order: a per-IP limit (`HOOK_IP_RATE_LIMITER`, 120 a minute), the mac (a
wrong one gets the same `404` as any unknown path), a per-hook limit
(`HOOK_RATE_LIMITER`, 60 a minute), a `Content-Length` of at most 1 MiB
(`411`/`413`), and the body itself, read by the worker within 10 seconds and
the same cap (`408`/`413`). Nothing touches a Durable Object before all of
these pass, so a slow sender never holds one. A limiter that can't answer
refuses too (`503`, `Retry-After: 60`). The host's object then checks
the hook is still active (`404`) and today's allowance and its queue (`429`
with `Retry-After`), and the answer is `202 {"accepted":true}`.

Each delivery keeps its method, query string, body, and a few headers (the
always-kept ones in `packages/shared/src/webhookTasks.ts` plus the ones the
hook names; never `cookie`, `authorization`, `cf-*` or `x-forwarded-*`). It is
sealed to the computer's hook key (P-256 ECDH, HKDF, AES-256-GCM, bound to
host, hook and delivery ids; `packages/shared/src/relayHookSeal.ts`) before
it is stored, so waiting events can't be read in relay storage. The relay
itself still sees each request while handling it.

Handing over: a sealed delivery up to 600 KiB goes out on the control socket
as `hook.delivery`; a larger one is announced as `hook.pending` and fetched
with `GET /v2/hosts/{h}/hooks/deliveries/{id}`. The computer answers
`hook.ack` (at most one a second, its own limiter `HOOK_ACK_RATE_LIMITER`
rather than the control one) once it stored them, and the relay deletes
them. Every (re)connect replays what wasn't acknowledged, oldest first (whole
up to 4 MiB, announced after that). Deliveries wait 24 hours at most.

The host changes its hooks only with revisions: `POST .../hooks` mints one,
`PUT .../hooks` sets the whole wanted list (others retired; a retired hook's
row is kept 25 hours), and `GET .../hooks` returns the last revision applied.
A call whose revision isn't newer than the last applied one is ignored
(`409` for a mint, `{"applied":false}` for a `PUT`). A host the relay
doesn't know gets `404` with code `unknown-host`, a wrong secret `401` with
`bad-host-secret`; the server then registers again and mints its hooks anew.

## Assistants

Always-on assistants in their makers' clouds (Grok Bot, dots, Muse, Claude
Duet) reach a user's computer through a public door on the relay: MCP over
HTTPS, with OAuth sign-in (docs/design/assistants.md). The relay routes,
refuses and answers for an offline computer; the computer approves every
connection and mints and checks every credential.

The door answers only on its own origin, `ASSISTANTS_ORIGIN`. Production uses
the worker's own, `https://threadlines-relay.threadlines.workers.dev` (Oct 30:
threadlines.dev's DNS is on Vercel, so a threadlines.dev name can't route
here); a staging deploy passes its own `workers.dev` origin with `--var`.
Credentials are bound to it, so changing it disconnects every assistant. A request there on one of these paths goes to
`src/v2/assistants/route.ts` before v1 and v2 routing; anything else falls
through as usual.

| Route                                             | What it does                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata for `<origin>/mcp`, static                       |
| `GET /.well-known/oauth-authorization-server`     | RFC 8414 metadata: public clients, code + S256, CIMD, `iss`        |
| `POST /register`                                  | Stateless DCR: the client id is the registration, signed           |
| `GET /authorize`                                  | Checks the request, keeps a pending sign-in, shows the page        |
| `POST /authorize/code`                            | The page sends the code the app showed                             |
| `GET /authorize/status`                           | The page waits for the computer's decision                         |
| `POST /token`                                     | Routed by the code or refresh token to the computer                |
| `POST /mcp`                                       | Routed by the access token or key to the computer (GET/DELETE 405) |

Clients are either registered (`POST /register` returns
`tlrc1.<base64url JSON>.<mac>`, signed with `ASSISTANT_CLIENT_KEY`; nothing is
stored) or CIMD (the client id is an https URL whose metadata document the
relay fetches: DNS names only, no redirects, 5 KiB, 10 s, cached an hour).
Return addresses are https, exact, without user info or fragment; plain http
only for loopback while the door itself is on loopback. Any bad request to
`/authorize` shows an error page and never redirects, so the door can't be
used to send people to a registered address.

Sign-in: `/authorize` keeps a pending sign-in in one of 32
`RelayAssistantSignIn` shards (the shard comes from a hash of the page's IP,
so at most 10 can wait per network; the sign-in id names its shard). The page
holds a secret that only it has (no cookies). The user types the code
Threadlines shows (`POST /v2/hosts/{h}/assistants/code`; 8 characters, 10
minutes, one use, one per computer, kept in the `RelayCodeShard` objects as
`assistant-codes:<last character>`). A match binds that page's sign-in to the
computer, whose `RelayHost` sends it on the assistant socket as `signin` (and
again after every reconnect). Each sign-in gets 3 tries; after 10 minutes the
page says it timed out and the computer gets `signin.gone`. The computer's
`signin.decision` makes the page go to the return address with `code`,
`state` and `iss`, or `error=access_denied`.

Requests: `/token` and `/mcp` read the credential's host, connection and route
tag (`tlac1`/`tlar1` for `/token`, `tlaa1`/`tlak1` for `/mcp`) and recompute
the tag with `ASSISTANT_ROUTE_KEY` before anything wakes a Durable Object; a
made-up one gets `400 invalid_grant` or `401` with `WWW-Authenticate` right
there. The host's object then refuses removed connections (`401`, offline or
not), and when the computer has no live assistant socket (or its control
lease lapsed) it answers for it, saying nothing about the computer: a
`tools/call` gets a tool error ("Your Threadlines computer is offline
(asleep, or Threadlines is closed). Try again later."), any other MCP request
a 503 JSON-RPC error with the same words, `/token` a 503
`temporarily_unavailable` with `Retry-After: 60` (never `invalid_grant`).
Otherwise the request goes out as a `request` frame (only `content-type`,
`mcp-protocol-version`, `mcp-method`, `mcp-name` and `mcp-session-id`) and
the computer's `response` frame comes back as the HTTP answer, with only
`content-type`, `mcp-session-id`, `mcp-protocol-version` and
`www-authenticate` (`/token`: `content-type`, `cache-control`, `pragma`).
No answer in 30 s is a 504; a socket that drops fails its requests with 502.

Host routes, all with the host secret, under `/v2/hosts/{h}/assistants`:
`GET /` (the address and whether the door is on), `POST /code` and
`DELETE /code`, `POST /route-tags`, `POST /revocations` (kept as long as the
host is registered, up to 10,000), and `GET /socket`, the assistant socket
(host secret as the token protocol, like pipes; one per host, a newer one
replaces the older). Frames are JSON text up to 768 KiB, parsed with the
contract's schemas. While the door is off these answer `503` with code
`assistants-off`, except `GET /` (`enabled: false`) and revocations, which
are always kept.

**What the relay sees:** unlike device traffic, this door is plain text at
the relay. It sees thread titles, messages, tool results and credentials in
transit. It keeps no bodies and logs none: no bodies, credentials or query
strings are ever logged (`loggedPath()` drops every query string).

Limits, all at the edge and failing closed (`503`, `Retry-After: 60`):

- `ASSISTANT_SIGN_IN_RATE_LIMITER`: 10 a minute per IP, each for
  registrations, sign-in pages and typed codes.
- `ASSISTANT_STATUS_RATE_LIMITER`: 120 a minute per IP for sign-in pages
  waiting on a decision.
- `ASSISTANT_CONNECTION_RATE_LIMITER`: 120 a minute per connection, each for
  `/mcp` and `/token`.
- Bodies: `/mcp` 256 KiB, `/token` and `/register` 16 KiB, read within 10 s.
- In the host's object: 32 requests in flight (`503`), and
  `THREADLINES_RELAY_HOST_DAILY_ASSISTANT_REQUESTS` (20,000) forwarded MCP
  requests per UTC day (`429`). They also count toward the relay-wide budget.

Vars and secrets: `ASSISTANTS_ORIGIN` (empty: no door) and
`ASSISTANTS_ENABLED` (`false` answers 503 everywhere) are vars;
`ASSISTANT_ROUTE_KEY` and `ASSISTANT_CLIENT_KEY` are secrets, base64url of at
least 32 random bytes, and permanent: a new route key breaks every
connection, a new client key every registered client. Without either the
door is off.

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | wrangler secret put ASSISTANT_ROUTE_KEY
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | wrangler secret put ASSISTANT_CLIENT_KEY
```

Running it locally (from `apps/relay-worker`, state in a temp folder):

```sh
./node_modules/.bin/wrangler dev --port 18787 --persist-to "$TMPDIR/threadlines-relay" \
  --var ASSISTANTS_ORIGIN:http://127.0.0.1:18787 --var ASSISTANTS_ENABLED:true \
  --var ASSISTANT_ROUTE_KEY:<key> --var ASSISTANT_CLIENT_KEY:<key>
```

`--var` values show in `ps`; for keys you'd rather not, put
`ASSISTANT_ROUTE_KEY=...` and `ASSISTANT_CLIENT_KEY=...` in
`apps/relay-worker/.dev.vars` instead and drop those two flags. The door then
answers on `http://127.0.0.1:18787` only (not `localhost`), and loopback
return addresses are allowed.

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
- `THREADLINES_RELAY_HOST_DAILY_HOOKS` (1,000): event deliveries per host per
  UTC day. Each also counts as one message above. At most 500 deliveries or
  50 MiB wait per host, and a host keeps at most 500 hooks.

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

The assistants door is the exception: assistants' requests are plain text
at the relay (see Assistants).

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

Event tasks need the address key as a Worker secret, a long random value
that never changes once addresses are out (changing it voids every address):

```sh
openssl rand -base64 32 | wrangler secret put HOOK_PATH_KEY
```

Without it the relay refuses to mint (`503`, code `hooks-off`) and answers
every hook address with `404`. For `wrangler dev`, put a throwaway
`HOOK_PATH_KEY=...` in `apps/relay-worker/.dev.vars`.

Invocation logs are off in `wrangler.jsonc`: they record whole URLs, and a
hook address is the only credential of a task without a signature check.
Every relay log line goes through `loggedPath()` (`src/log.ts`), which cuts
`/v2/hooks/...` to `/v2/hooks/…`.

Deploying v2 the first time applies the `v2` Durable Object migration
(`RelayHost`, `RelayCodeShard`, `RelayLedger`); the assistants door adds
`v3` (`RelayAssistantSignIn`). Deploy the relay before
shipping a desktop or server build that uses it; older relays answer `/v2/`
with 404, which Settings reports as "This relay doesn't support device codes
yet."

For a custom domain such as `relay.threadlines.dev`, the zone must be managed
by Cloudflare. Set `THREADLINES_RELAY_PUBLIC_ORIGIN` on the Worker if the
public origin isn't inferred from requests, and add the hosted app's origin to
`THREADLINES_ALLOWED_ORIGINS` so phones can join from it.
