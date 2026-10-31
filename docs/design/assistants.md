# Assistants: always-on agents use Threadlines

Rev 3, Oct 29 2026. Status: plan, not built. Sol reviewed rev 1 (14 findings)
and rev 2 (9 findings); all were taken. See "Rev 2" and "Rev 3" at the end.

Builds on:

- `outside-agents.md`: the local agent door, its sign-in, grants and tools;
- `push-alerts.md`: the alert rules;
- `event-tasks.md`: how a public relay route is done safely;
- `docs/cloudflare-relay.md`.

## Why

Always-on assistants run in their makers' clouds and work for the user around
the clock:

- Grok Bot (SpaceXAI, on Cursor's cloud);
- dots (OpenAI);
- Muse (Meta, launched Sep 8);
- Claude Duet (Anthropic, research preview since Oct 21).

Users want them to drive Threadlines. That means seeing what's going on,
starting and steering work, and hearing when an agent needs the user, finishes
or fails.

Today they can't:

- The agent door (`/mcp/connect`) answers only programs on the same computer,
  on purpose.
- The `threadlines` command works when an assistant may run commands on the
  user's computer. Grok can, with approval: it ran `threadlines thread list
  --json` on Will's Mac on Oct 25. But it stops when the computer sleeps or
  nobody is there to approve.

The goal is one native door every assistant can use. It's built on the
standards they share (MCP over HTTPS, OAuth, signed webhooks), so the only
per-assistant work is a listing.

## What the assistants accept (research, Oct 25-29)

|                  | Grok Bot                                                                                                                                                                                                | dots                                                                                              | Muse                                                                                                                                  | Claude Duet                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adding tools** | Cursor marketplace plugins (its Connect Apps list), or a custom remote MCP server by https URL. Grok says that takes OAuth with DCR, a pre-registered client or static headers (not confirmed in docs). | Plugins and apps; custom MCP apps in developer mode.                                              | No URL field: Muse writes its own MCP client on its VM from a URL, an OpenAPI doc or a CLI. Bearer header; no OAuth for custom tools. | Claude Marketplace connectors and plugins; custom connectors. An early review says scheduled runs can't use custom connectors.                                                                     |
| **Events**       | Routine webhook: a POST URL plus a `crsr_` Bearer key. The body becomes the run's input. No retries.                                                                                                    | MCP Events (OpenAI's): `events/*` on MCP 2026-07-28, Standard Webhooks to a callback it supplies. | Unknown. It can run crons on its VM.                                                                                                  | Unknown. It "checks connected accounts every few hours".                                                                                                                                           |
| **Listing**      | Cursor marketplace, reviewed by hand (forum: weeks).                                                                                                                                                    | OpenAI app submission: org and domain verification, tool scan.                                    | None: Meta curates and takes no submissions.                                                                                          | Anthropic directory: OAuth, tool titles plus read-only/destructive annotations, privacy policy, a reviewer test account. Listed as Community after an automatic scan; per-user URLs need Verified. |

All four connect from their own cloud, so the door needs a public https
address. All four are changing fast; re-check before each phase.

The MCP spec changes that matter:

- **2026-07-28 is stateless:**
  - no `initialize`, no sessions;
  - `server/discover`;
  - the version in each request's `_meta`;
  - a required `resultType`;
  - `Mcp-Method` and `Mcp-Name` headers.
- **Clients:** it deprecates Dynamic Client Registration in favour of Client
  ID Metadata Documents (CIMD).
- **Events aren't in the core spec.** The Tasks and Events working group is
  still ideating. OpenAI's MCP Events is the only shipped version.

Sources:

- https://docs.x.ai/grok-bot/computer-and-apps
- https://docs.x.ai/grok-bot/team-bots
- https://hookdeck.com/webhooks/platforms/using-hookdeck-with-grok-bot-reliable-webhook-triggers
- https://developers.openai.com/plugins/build/mcp-events
- https://parallel.ai/articles/meta-muse-custom-integrations
- https://the-decoder.com/anthropic-takes-on-grok-bot-metas-muse-and-openais-dots-with-its-always-on-agent-claude-duet/
- https://claude.com/docs/connectors/building/submission
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle

## What the user does

1. **Add Threadlines in the assistant.** Pick it from the assistant's app list
   (once listed), or paste `https://connect.threadlines.dev/mcp` as a custom
   connector. The name is open (see Open questions).
2. **The browser page.** It says: "Open Threadlines on your computer and choose
   Settings › Assistants › Connect an assistant. Type the code it shows here."
   It has one box for the code.
3. **Threadlines shows the code**, `K4D8-2PQX`, under the line: "Type this only
   into the Threadlines page your assistant just opened. Never give it to
   anyone."
4. **The user types the code into the page.** The Threadlines screen turns into
   the approval dialog used for agents on this computer:
   - **Title:** "Grok Bot wants to use Threadlines".
   - **Where it comes from:** "Signs in from cursor.sh" for a verified client;
     otherwise "Name given by the assistant · sign-in returns to cursor.sh".
     A return site Threadlines doesn't know gets a warning line: "Threadlines
     doesn't know this assistant. Only allow it if you added it yourself."
   - **The browser:** "The page was opened near <city, country>", from
     Cloudflare's request data. This is shown for information only; it proves
     nothing.
   - **Access:** See threads (default), Start threads, or Work with all threads
     (new, see Access).
   - **Projects**, and the **highest access** for threads it starts or works
     on.
5. **Connected.** The page says "Connected. You can close this tab," and the
   assistant carries on.
6. **Muse, and anything that takes only a key.** Settings › Assistants ›
   Create a key, with the same choices. The key shows once; the user pastes it
   with the address.
7. **Afterwards.** Settings › Assistants lists each connection: name, how it
   signs in, access, when it was last used, Change and Remove. Remove cuts it
   off at its next call, even while the computer is offline.
8. **Alerts.** Settings › Assistants › Send alerts to a web address:
   - Paste a URL, plus an Authorization header if the receiver needs one
     (Grok's `Bearer crsr_…`).
   - Pick needs you, finished and failed.
   - Assistants with MCP Events (dots) subscribe on their own; their
     subscriptions show under their connection.

Phones show nothing in v1 (see Open questions).

## Shape

```
assistant's cloud ──https──▶ relay (connect.threadlines.dev) ──assistant socket──▶ the user's computer
assistant's webhook ◀──────────── https, signed alerts, sent by the computer ───────────────┘
```

- **The relay:**
  - the public address and the sign-in pages;
  - routing by a tag it can check itself;
  - a list of removed connections;
  - answers while the computer is offline;
  - limits.
  - It never decides access and can't mint a credential.
- **The computer:**
  - approves connections;
  - mints and checks every credential;
  - runs the tools under the grant and the ceiling;
  - sends alerts directly.
- **The local door (`/mcp/connect`)** is untouched.

## The public address

- **Decided Oct 30 (Will):** for now the door is the relay's own origin,
  `https://threadlines-relay.threadlines.workers.dev`. threadlines.dev's DNS
  is on Vercel, so `connect.threadlines.dev` can't route to the worker without
  moving the zone to Cloudflare. Credentials are bound to the origin, so a
  move disconnects every assistant: make it, if at all, before listing.
- **Hostname (the plan):** a custom domain on the relay worker, e.g.
  `connect.threadlines.dev`. Today the relay answers only on
  `threadlines-relay.threadlines.workers.dev` (`relayApi.ts` 27;
  `relay.threadlines.dev` appears only in tests). A separate hostname:
  - gives the OAuth issuer its own identity;
  - hosts OpenAI's domain-verification file;
  - keeps assistant routes away from device routes.

  It's one fixed URL. The Anthropic directory lists per-user URLs only once
  Verified, and Cursor and OpenAI listings point at one URL too.

- **Routes on that host:**
  - `GET /.well-known/oauth-protected-resource/mcp` and
    `GET /.well-known/oauth-authorization-server` (both static);
  - `POST /register` (stateless DCR);
  - `GET /authorize`, `POST /authorize/code`, `GET /authorize/status`;
  - `POST /token`;
  - `POST /mcp` (GET and DELETE answer 405);
  - later, `GET /.well-known/openai-apps-challenge`.
- **Cheap checks before any Durable Object wakes** (the event-tasks lesson):
  1. method;
  2. per-IP limiter (fails closed);
  3. body cap of 256 KiB, read with a deadline;
  4. credential format;
  5. route-tag HMAC.

  Junk never wakes a DO. (Today any 36-character hex id under `/v2/hosts/`
  wakes one. That's a side finding; fix it separately.)

- **Logging:** no bodies, no `Authorization`, no query strings on
  `/authorize`. `loggedPath` strips only `/v2/hooks` today.
- **CORS:** none. These are server-to-server calls and top-level navigations.
- **Kill switch:** `ASSISTANTS_ENABLED=false` answers 503 everywhere.

## Sign-in

### Clients

- **CIMD (preferred by 2026-07-28):** `client_id` is an https URL.
  - The relay fetches its metadata document for `client_name` and
    `redirect_uris`.
  - Fetch rules: public addresses only, no redirects, 5 KiB, 10 s, cached for
    an hour.
  - The URL's host is a verified identity, and the dialog says so.
- **DCR (what most clients still do):** stateless, like the local door.
  - `client_id` is a relay-signed blob (name, redirect URIs, software id),
    signed with `ASSISTANT_CLIENT_KEY`.
  - The name is the client's own claim, and the dialog says so.
- **Redirect URIs:** https only, no userinfo or fragment, exact match.

### Authorize: the app's code typed into the page

- **Checks.** `/authorize` checks:
  - the client and the redirect;
  - `state`;
  - the S256 challenge;
  - `resource`, if sent, must be the canonical `…/mcp`;
  - `scope`, within `threads:read threads:start threads:work`.

  It then keeps the request as a pending sign-in, bound to this page by a
  secret only the page holds (no cookies).

- **Where pending sign-ins live.** No computer is known yet, so they can't go
  in a per-host Durable Object. They go in `RelayAssistantSignIn` shards, keyed
  by a random sign-in id:
  - each holds the client, its identity, the redirect, `state`, the challenge,
    the scope, the page secret's hash, a tries counter and the expiry
    (10 minutes);
  - at most 10 can wait per IP;
  - once a code matches, the shard records the host, and the host's DO takes
    the sign-in from there.
- **The app's code.** "Connect an assistant" (Settings, or the command
  palette) asks the relay, with the host secret, for a sign-in code:
  - 8 characters from an unambiguous alphabet, about 40 bits;
  - kept in a code-shard Durable Object, like Connect a device's codes;
  - alive for 10 minutes, one use, one at a time per computer.
- **Typing it in.** The page posts the code to `/authorize/code`.
  - Each pending sign-in gets 3 tries, and each IP a few a minute.
  - A match binds the page's sign-in to that computer and uses up the code.
  - The relay passes the sign-in to the computer over the assistant socket:
    client, identity, redirect, scope, and the page's approximate place (from
    Cloudflare's request data).
- **Known assistants.** The relay keeps a short list of known return sites
  (Cursor's, OpenAI's, Anthropic's, Meta's), plus the CIMD hosts they use.
  Anything else gets the warning line in the dialog. The list is a hint, not
  a gate: a self-hosted client must still be able to connect.
- **The dialog** replaces the code on the app's screen and waits 5 minutes. It
  shows:
  - the name;
  - the identity line;
  - the browser line;
  - the requested scope;
  - the access, the projects and the highest access.
- **Allow:**
  1. The computer gives the connection an id.
  2. It gets the connection's route tag from the relay (see Route tags).
  3. It mints a one-time authorization code,
     `tlac1.<hostId>.<cid>.<routeTag>.<random>`. The code lives 60 s in memory
     and is bound to the connection, client, redirect, challenge and resource.
  4. The page that typed the code redirects to `redirect_uri?code&state&iss`.
- **Deny or timeout** gives `error=access_denied`.

Why the code goes from the app to the page:

- The redirect, and the authorization code in it, goes to the browser that
  typed the app's code.
- An attacker who starts a sign-in in their own browser can't finish it unless
  the user hands over the code from their own Threadlines. The copy says never
  to.
- Rev 1 had the page show the code for the user to type into the app. That
  sent the authorization code to whichever browser started the sign-in, so a
  phished user could connect an attacker's assistant account (Sol, finding 5).

What it doesn't stop:

- **A sign-in link sent to the user.** The user's own browser then gets the
  redirect. The attacker gets nothing only if the assistant ties `state` to the
  browser session that started the sign-in. That's the client's job
  (RFC 9700, section 4.7.1), and Threadlines can't check it. Test it for each
  assistant before listing it, and record the result per assistant in
  `docs/providers/`.
- **An attacker's own client** (DCR with a return site they run). The user
  would have to follow the link, fetch a code, type it in, and allow a dialog
  that names the attacker's return site, with the unknown-assistant warning.
  That's ordinary OAuth consent phishing. The dialog is the defense.
- **A user who reads their code out to an attacker.** The copy is the defense.
- **Guessing a live code from someone else's page.** That would bind an
  attacker's sign-in to a victim's waiting screen. 40 bits, 3 tries per
  sign-in, per-IP limits and a 10-minute life make it hopeless. The dialog's
  identity line shows what it is.
- **The place line** proves nothing either way. A cloud browser or a phone on
  mobile data shows somewhere else, and a shared IP shows "near" for anyone.

### Token

`/token` routes by the code's or refresh token's host, connection and route
tag, over the assistant socket. The computer checks:

- single use;
- client;
- redirect;
- PKCE;
- resource.

It then issues:

- **an access token** for 1 hour:
  `tlaa1.<hostId>.<cid>.<routeTag>.<rgen>.<exp>.<mac>`. `rgen` is the refresh
  generation it was issued with.
- **a rotating refresh token:** `tlar1.<hostId>.<cid>.<routeTag>.<rgen>.<mac>`.

Refresh rules. The computer keeps three things per connection:

- `rgen`, the newest generation issued;
- `rotated_at`, when it was issued;
- `rgen_seen`, the newest generation seen in use. "In use" means an access
  token of that generation passed the computer's check on any call.

| Presented                                                                                                     | Answer                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| generation `rgen`                                                                                             | Issue `rgen + 1` and a fresh access token.                                                                                  |
| generation `rgen - 1`, and either the successor was never seen in use or `rotated_at` is under 10 minutes ago | Return the same successor again (tokens are deterministic from the generation) and a fresh access token. Nothing is bumped. |
| anything older, or `rgen - 1` after both of those have passed                                                 | A theft signal. Remove the connection (reason `refresh-reuse`).                                                             |

- **A lost reply, then sleep:** the successor was never used, so the old token
  still works.
- **Two workers of one client refreshing at once:** one rotates, and the other
  arrives late. The 10-minute window covers it even after the first worker
  has used its new access token (Sol, rev 2 finding 3).
- **A thief using a stolen token:** caught once both copies are in play past
  the window.
- All three fields change in one transaction.
- **MAC:** HMAC with the server signing key under a new label
  (`threadlines-assistant-v1|…|resource`). It's the same key family as the
  local tokens, with domain separation.
- **Computer offline during a refresh:** the relay answers 503
  `temporarily_unavailable` with `Retry-After`, never `invalid_grant`, which
  makes clients drop the connection.
- **Idle for 90 days:** removed (`unused`), as on the local door.

Why rotation here when the local door dropped it: the credential lives for
months in someone else's cloud. Short access tokens and reuse detection limit a
leak. The local door's reasons were a single local client and simplicity; they
don't hold here.

### Keys

These are for Muse, for scripts on an assistant's computer, and for clients
that take only a header.

- **Making one:** Settings › Assistants › Create a key, with the same choices
  as the dialog. The key, `tlak1.<hostId>.<cid>.<routeTag>.<secret>`, shows
  once with the address. The computer keeps a hash.
- **Same as sign-in connections:** the same row (`sign_in = key`), the same
  Change and Remove, the same idle expiry.
- **No rotation.** Settings suggests sign-in where the assistant supports it.

### Route tags and removed connections

- **Route tags.** When the computer gives a connection its id, it asks the
  relay (with its host secret) for the connection's route tag:
  HMAC(`ASSISTANT_ROUTE_KEY`, `v1|hostId|connectionId`).
  - Every credential and authorization code carries it, along with the host
    and the connection.
  - The edge recomputes it, so a made-up credential is refused before any
    Durable Object wakes, the same idea as hook addresses.
  - The key is permanent: changing it breaks every connection.
- **The relay can route, but it can't authenticate.** The computer checks the
  rest of every credential (its MAC, or the key's hash) against the live row.
- **Removed connections.** When a connection is removed (Remove, replaced,
  idle, refresh reuse), the computer tells the relay.
  - The relay keeps the id on its per-computer revocation list for as long as
    the computer stays registered. Rows are tiny.
  - It answers 401 at once, even while the computer is offline.

## Between the relay and the computer

- **A new WebSocket, `/v2/hosts/{h}/assistant`.** The computer opens it with
  its host secret whenever it has a live assistant connection, a code waiting,
  or a sign-in waiting.
- **Why not the control socket:** it allows 10 messages a minute from the host
  and closes the socket on more (`CONTROL_RATE_LIMITER`, `RelayHost.ts`
  868-872).
- **Staying online:** `hasRelayWork` (server `RelayHost.ts` 437-449) gains
  "has assistant connections". The control socket and its lease then stay up,
  so the relay knows the computer is there.
- **Frames:** JSON text.
  - Relay to computer:
    `{ type: "request", id, route: "mcp" | "token", credential?, headers, body }`.
    - `credential` is the bearer from `Authorization`, or the code or refresh
      token for `/token`. It's never logged.
    - `headers` passes through only `content-type`, `mcp-protocol-version`,
      `mcp-method`, `mcp-name` and `mcp-session-id`.
  - Computer to relay: `{ type: "response", id, status, headers, body }`.
  - Sign-in messages also go this way: a sign-in to approve, the decision, and
    the authorization code.
- **Limits:**
  - frames up to 768 KiB, serialized. That's our own limit; Cloudflare's is
    32 MiB since Oct 2025. The computer turns a bigger result into a clear tool
    error (tools already clip).
  - 32 requests in flight per computer;
  - 30 s at most per request, which every tool fits (see `thread_start`);
  - a dropped socket fails its requests with 502, and the client retries.
    2026-07-28 says a broken stream loses the request anyway.
  - Mutations carry a required `requestId` (see Tools), so a retry never does
    the work twice.
- **Rate:**
  - a per-connection limiter at the edge (120 a minute, matching the
    computer's own);
  - a per-computer daily allowance in the DO (numbers depend on the plan
    decision);
  - the relay-wide ledger.
- **The pending map:** pending requests are kept in memory. A DO with a request
  in flight doesn't hibernate.

Two alternatives were turned down:

- **Pipes:** a pipe costs a new TLS and WebSocket handshake per call, and was
  built for long device sessions.
- **Sealing this socket end to end:** the relay already ends the assistant's
  TLS, so sealing this hop would hide nothing from it.

## The MCP endpoint on the computer

**Our own small stateless handler** (`apps/server/src/assistants/AssistantMcp.ts`),
not Effect's McpServer. Why:

- Effect's server (beta.107) speaks only 2025-06-18.
- It keeps every session in memory until restart. Hosted clients would grow
  that without bound.
- It takes no custom methods, so no `events/*`.
- Its session gate and handler table are hard-coded. Patching them means
  editing compiled `dist` JS (`McpServer.ts` 1195-1216, 1933-2066).
- Requests reach the computer over the relay socket, not its HTTP router. A
  handler of (credential, headers, body) → (status, headers, body) fits better
  than mounting a second HTTP McpServer.

**It speaks two generations:**

- **Before 2026-07-28 (the `initialize` lifecycle):**
  - `initialize` negotiates the usual way: if the client offers a version we
    don't speak (2025-11-25, say), we answer with 2025-06-18 and the client
    decides;
  - an opaque session id is returned, and any id is accepted afterwards, so
    nothing is kept;
  - `notifications/initialized`, `ping`, `tools/list`, `tools/call`;
  - no GET stream.
- **2026-07-28:**
  - `server/discover`;
  - the version in `_meta`;
  - `resultType`;
  - `Mcp-Method` and `Mcp-Name` checks;
  - `tools/list` in a fixed order, with `ttlMs` and `cacheScope`;
  - `events/*` (below).
  - A request whose `_meta` names a version we don't speak gets
    `UnsupportedProtocolVersion`. That error never answers an `initialize`.
- **No batches.**

**One toolkit, two front doors:**

- The tools are the same `Tool.make` definitions and handlers as the local
  door (`connectTools.ts`, `connectToolHandlers.ts`), with their JSON Schema
  from Effect's tool helpers.
- The grant decides which tools are listed, as `listOnlyGrantedTools` does
  today.
- Every tool gets a `title` and `readOnlyHint` or `destructiveHint`. The
  Anthropic directory requires them, and the local door gets them too.

Follow-up, not in this plan: move the local door onto the same handler. That
makes one MCP implementation and ends the local session leak.

## Access and tools

### Access levels

These are shared with local agents. The decider enforces them in
`orchestration/outsideTurns.ts`, as it does today.

- **See threads** (default): the read-only tools.
- **Start threads:** See, plus starting threads and sending to or stopping the
  threads it started. This is today's Start. Those threads are fenced: their
  agent gets none of Threadlines' own agent tools.
- **Work with all threads** (new, on both doors): See and Start, plus sending
  to, stopping and answering agents' questions on any thread in its projects,
  under the live ceiling. Needs turns from outside (below).
- **Never, at any level:**
  - answer approvals;
  - approve plans;
  - change access;
  - wrap, archive or delete threads.

  Pitch for later: approvals by link. The assistant sends the user a link that
  opens the thread in Threadlines.

### Turns from outside (what makes Work safe)

**The problem.** The fence today follows the thread, not the turn
(`ProviderCommandReactor.ts` 1248-1254: `thread.outsideOrigin`). A thread the
user started keeps Threadlines' own agent tools. So an assistant that could
message it could ask its agent to start threads, invite agents or set
schedules anywhere, past its own grant (Sol, finding 1).

**The rule.** Outside work carries its connection's grant until every piece of
it has ended. Outside work means a turn started from outside, plus everything
that turn set going:

- background tasks and subagents it started, which outlive the turn
  (`ProviderRuntimeIngestion.ts` 3459);
- check-backs it scheduled. Claude's own `CronCreate` and `ScheduleWakeup`
  start a later turn with no Threadlines message (`ClaudeCheckBacks.ts` 89,
  `ClaudeAdapter.ts` 8390).

**The gate is on the runtime, not the turn.** A thread's runtime is
restricted while any outside work on it is alive: the outside turn, or a
background task or subagent born in one. A tool call can't tell which task
made it; tool credentials belong to the session. So the gate can't serve a
new user turn while old outside work still runs. Lookups by "current turn"
can't tell them apart (Sol, rev 2 finding 2).

While the runtime is restricted:

- **Threadlines' own agent tools** (the thread, room, invite and schedule tools
  in `apps/server/src/mcp/`):
  - refuse every change (start, send, invite, schedule, wrap);
  - limit reads to the connection's projects. Each tool filters by the
    project ids the gate hands it; the build checks every read tool takes
    that filter.
- **Check-backs scheduled during outside work carry its origin.** When one
  fires, its turn is outside work for the same connection, checked against the
  grant as it is then. If the connection is gone, the wake-up is dropped. The
  adapter already sees these tool calls (`isClaudeCheckBackTool`).
- **What stays allowed:** pages and `ask_user_to_run`. They only show things
  to the user, and a command still needs the user's click.
- **When it lifts:** once the outside turn has ended and no task born in it is
  alive. Steers into the turn don't lift it; that covers child reports, late
  answers, and the user's own steer. A user turn started while it's still on
  runs restricted too, and the app says so on the thread ("An assistant's
  work is still running here, so agent tools are limited").

**The ceiling is the real boundary for shell access.** An agent with a shell
can run anything the user can, including the user's own `threadlines` command
and its stored sign-in. That's the local door's Honest limit too. Work only
reaches threads running at or under the connection's ceiling, so at
Supervised, every shell command still waits for the user.

- **The ceiling check runs on every way outside text reaches an agent.** The
  real runtime check (`ProviderCommandReactor.ts` 2060-2071) runs today only
  for an outside `thread.turn.start`. An answer reaches the agent another way:
  `thread.user-input.respond` steers the running turn or dispatches its own
  `thread.turn.start` (3705-3771). Neither carries `fromOutside` today (Sol,
  finding 2). So:
  - `fromOutside` goes on the respond command and its event;
  - from there it goes onto the steer and the follow-up turn;
  - the grant and the runtime are checked again right before delivery.

**Until that ships,** Work refuses threads whose agent has Threadlines' agent
tools.

### Tools

- **Today's eight** keep their behavior, with three changes for assistants:
  - `thread_wait` stops at 25 s;
  - `requestId` is required on `thread_start`, `thread_send`, `thread_stop` and
    `thread_answer`;
  - `thread_start` returns at once with the thread id it will use and status
    `starting`, before the worktree is made. Today the handler waits for all
    of `runTurnStart` (`connectToolHandlers.ts` 988). That makes the worktree
    before the thread exists (`ThreadBootstrap.ts` 454-475), so it can take
    longer than 30 s (Sol, rev 2 finding 4).
    - The durable record of the start is the existing request row
      (`outside_agent_requests`, keyed by connection and `requestId`). The
      thread id is set there before work begins.
    - `runTurnStart` runs on after the reply, and its creating the thread and
      starting the turn together doesn't change.
    - `thread_read`, `thread_wait` and `inbox` answer for a thread id with
      a request row but no thread yet: `starting`, or `failed` with the
      reason.
    - A restart marks rows still `starting` as `failed`, as it already does
      (`OutsideAgentRequests.ts` 102-104).
- **`thread_read`:** `waitingOn` gains detail, for local agents too:
  - approval: what's asked (the tool, plus the command or file, clipped);
  - question: `requestId`, the question text and its options;
  - plan: the plan's title.
- **`inbox` (new, See):**
  - input `{ since?, project? }`;
  - `needsYou`: live state, every open approval, question or plan in scope,
    with the thread, the kind, a short summary written by Threadlines,
    `askedAt` and a link;
  - `finished` and `failed`: from the event record since the cursor, each with
    `seenInThreadlines`;
  - `cursor` and `more`.
  - It's made for assistants that check in every few hours.
- **`thread_changes` (new, See):**
  - the branch and its base;
  - files changed with +/− (at most 200 files), and totals;
  - the pull request: number, URL, state, checks, review decision and
    mergeability, from the PR records the app already keeps (#667).
- **`thread_answer` (new, Work):**
  - input `{ threadId, requestId, answers }`, for questions only;
  - it dispatches `thread.user-input.respond` with `fromOutside`;
  - the decider refuses approvals and threads above the ceiling, and the
    reactor checks the runtime before delivery (above).
- **Links** use the push-alert format, `${appOrigin}/${environmentId}/${threadId}`
  on `https://app.threadlines.dev`. An unpaired browser is asked to pair
  (#635).
- **Thread titles and messages are agent-written.** Tools return them as data.
  The plugin's guide says so too.

## The event record and where it goes

Today push alerts:

- find alerts in the event log only while a phone is registered
  (`PushAlerts.ts` 349);
- drop events read more than 10 minutes late (`PushAlerts.ts` 352);
- drop alerts for a thread someone is looking at (`PushAlerts.ts` 422);
- deliver only to phones (deliveries keyed by `device_id`).

Those are the right rules for buzzing a person, but the wrong rules for a
record an assistant reads every few hours (Sol, finding 8). So there are two
layers.

### 1. The record (new)

- The same rules (`pushAlertRules.ts`) read the event log from their own saved
  cursor.
- **Every intent is a row at once.** Each one goes into `assistant_events` in
  the same transaction that moves the cursor, keyed by its subject (the
  push-alert keys: `approval:<id>`, `turn:<id>` and so on). Rows have three
  states:
  - **`settling`**, with a `settle_until`: finished waits 8 s, failed 3 s,
    needs-you 0. A restart finds settling rows and carries on. Nothing is lost
    between the cursor moving and the row being final (Sol, rev 2 finding 7).
  - **`recorded`**, which gets its public `seq` only now. So cursors cover
    final events only, in the order they became final.
  - **`dropped`**: cancelled or superseded while settling. Examples: an
    interrupt (the phone rules' `suppress`), a newer turn, an answered request.
    A finished turn with a plan left to review becomes a needs-you
    `plan:<planId>` row instead.
- **Settling is checked against the thread as it is then,** with the same
  checks phones use (`PushAlerts.ts` 420-483), minus presence.
- **Cancels after recording** set `resolved_at`; they don't delete. That
  covers an answered request, a seen or archived thread, and, new for this
  record, a plan that stops being actionable. The phone rules don't handle
  `thread.proposed-plan-upserted` (`decider.ts` 4243). Phones only get away
  with that because they re-check the plan before sending. So the record
  gains that rule: a plan that's dismissed, implemented or replaced resolves
  its `plan:` row (Sol, rev 2 finding 8).
- **No age rule, no presence rule.**
- Kept 7 days.
- It runs whenever an assistant connection, webhook or subscription exists.
- It's the source of `inbox`, webhooks and MCP Events.

### 2. Targets, each with its own rules

- **Phones:** unchanged, on today's pipeline. A later follow-up can move them
  onto the record.
- **Webhooks:**
  - recorded events of the picked kinds and projects;
  - "Skip threads I'm looking at" is on by default, since each Grok run costs
    the user usage.
- **MCP Events subscriptions:** every matching recorded event, with no
  presence rule. The protocol expects the whole stream.
- **Every send attempt re-checks the event,** for both kinds of target. A
  needs-you event resolved before it goes out is dropped for that target (the
  watermark still moves past it). Finished and failed events go out anyway.
  So a retry never sends a plan alert after the plan was dismissed.
- **The cursor is a watermark.** Each target keeps one: the highest `seq` at or
  below which every event is delivered or dropped for that target.
  - The watermark is the cursor sent with each event and returned on subscribe
    and refresh.
  - Replay starts above it.
  - So an event still retrying is never skipped when a later one lands first
    (Sol, finding 9).
- **Shared with phones:** `retryDelayMs` and the attempt cap. Lifetimes are
  per target: 24 h for webhooks, the subscription's life for MCP Events.

### What an event carries

The shared payload (`data`), all written by Threadlines or named by the user:

```json
{
  "kind": "needs_you",
  "reason": "approval",
  "threadId": "…",
  "project": "app",
  "computer": "Will's MacBook Pro",
  "link": "https://app.threadlines.dev/<environmentId>/<threadId>",
  "at": "2026-10-29T14:02:11Z"
}
```

- **No thread title and no agent text.** A webhook body is the assistant's run
  input (Grok's routines), the place it reads instructions from.
  - Agents write thread titles: provider metadata can set one
    (`ProviderRuntimeIngestion.ts` 4164).
  - Project names and the computer label belong to the user.
  - The assistant reads titles and messages through the tools, as data (Sol,
    finding 13).
- **The envelope:**
  - `{ eventId, name, timestamp, data, cursor }` for both channels;
  - `name` is `thread.needs_you`, `thread.finished` or `thread.failed`;
  - `eventId` stays the same across retries and is the `webhook-id`.

### Webhooks

- **Settings:** Settings › Assistants › Send alerts to a web address. Fields:
  the URL, an optional Authorization header, kinds, projects, and the look
  switch.
- **Sent from the computer, not the relay.** That costs the relay nothing, and
  a sleeping computer has nothing to report.
- **Network rules** (OpenAI's rules, applied to every outbound call here):
  - https only;
  - resolve the host, and refuse private, loopback, link-local and CGNAT
    addresses;
  - connect to the address that was checked;
  - no redirects;
  - 10 s.
- **Signing:** Standard Webhooks headers with a secret Threadlines makes, plus
  the optional header.
- **Receiver errors:**
  - 410 turns the target off, and Settings shows that;
  - repeated 401 or 403 shows as "refused by the receiver".

### MCP Events (dots, ChatGPT Work)

- **2026-07-28 only.** `server/discover` advertises `events`.
- **`events/list`:**
  - `thread.needs_you`, `thread.finished`, `thread.failed`;
  - `inputSchema` `{ project? }`;
  - `payloadSchema`: `data` above.
- **`events/subscribe`:**
  - checks the grant and the `whsec_` secret;
  - the computer sends a signed challenge to the callback, under the network
    rules;
  - the id comes from (connection, URL, name, canonical arguments), so a
    repeated subscribe is the same subscription;
  - 7 days by default, with `refreshBefore`;
  - the cursor is the target's watermark; `truncated` when the record no
    longer goes back that far.
- **Deliveries** come from the computer:
  - one per POST, with Standard Webhooks headers and `X-MCP-Subscription-Id`;
  - backoff retries, none on 410 or 413;
  - the grant is checked again at send;
  - they stop on Remove.
- **Subscriptions survive a restart.**

## Offline and sleep

- **The relay answers itself** when the computer has no live assistant socket.
  The relay can't authenticate a credential, so the answer says nothing it
  would mind a stranger holding an old credential learning (Sol, rev 2
  findings 5 and 6).
- **A connection on the revocation list** gets 401, so a removed key gets 401
  while the computer is offline too.
- **Any other credential with a valid route tag**, whether a token or a key,
  gets a generic answer with no computer name and no last seen:
  - `tools/call` gets a tool error the model reads: "Your Threadlines computer
    is offline (asleep, or Threadlines is closed). Try again later."
  - Other MCP methods get 503 with a JSON-RPC error carrying the same text.
  - `/token` gets 503 `temporarily_unavailable` with `Retry-After`.
- **Nobody gets "last seen".** The relay doesn't keep it.
- **No queued starts or sends**, as decided for outside agents (rev 3). Pitch:
  "start when my computer wakes", through the sealed hook queue.
- **The record and alerts:** nothing happens while the computer sleeps. On
  wake, the record catches up from its cursor. Phones keep their 10-minute
  rule.
- **Keep awake:** the desktop's "Keep this computer awake for scheduled tasks"
  (`DesktopBackground.ts`) could also count assistant connections. It doesn't
  stop a closed lid. See Open questions.

## Security: who can do what

- **The assistant:**
  - can do what its grant allows, through the tools, under the ceiling;
  - threads it starts are fenced;
  - its turns on other threads carry its grant into Threadlines' own agent
    tools.
  - It can be prompt-injected: it reads agent output and the user's other mail.
    That's why See is the default and Work is a deliberate choice.
- **The relay (and Cloudflare):**
  - sees assistant traffic in plain text: thread titles, messages, tool
    results, and credentials in transit;
  - can replay a credential it saw, within that connection's grant;
  - can't approve a connection, mint a credential, raise a grant, or reach
    anything beyond the assistant tools.
  - It routes and can refuse, but never authenticates.
  - This is new for the relay. Device and phone traffic stays end-to-end
    encrypted and doesn't change.
  - The relay keeps no bodies and logs none.
- **The computer** is the only authority. It checks every call against the
  connection row, so Remove takes effect at once.
- **A stranger on the internet:**
  - reaches only the sign-in pages, and otherwise gets 401;
  - is held by per-IP limits;
  - can't wake a DO without a valid route tag;
  - can't finish a sign-in without a code from the user's own Threadlines.
- **The local door** doesn't change. Assistant traffic never comes in through
  the local HTTP port, and nothing loopback-only is relaxed.
- **Data handling, for the listings:** "Threadlines' relay forwards requests
  between your assistant and your own computer. It stores no content."

## Storage

**The computer** (step 1 built it as migration 093; the record's tables come
with step 2):

- `outside_agent_connections` gains:
  - `kind` (`local` | `assistant`);
  - `sign_in` (`oauth` | `key`);
  - `identity_host`, `identity_verified`, `identity_known` (the contract's
    identity: the CIMD host or the redirect's host);
  - `host_id` and `route_tag`;
  - `refresh_generation`, `refresh_rotated_at`, `refresh_seen_generation`;
  - `key_hash`;
  - `relay_revoke_pending`: a removal the relay hasn't heard about yet,
    retried until it has, across restarts.
  - `access` gains `work` (step 3).
- **New tables:**
  - `assistant_events`: `event_id` (primary key), `subject_key` (unique),
    `state` (`settling` | `recorded` | `dropped`), `settle_until`, `seq` (set
    when recorded; unique), `name`, `reason`, `thread_id`, `project_id`,
    `occurred_at`, `recorded_at`, `resolved_at`;
  - its cursor row;
  - `assistant_targets`: `id`, `kind` (`webhook` | `subscription`),
    `connection_id?`, `url`, kinds, project ids, the look switch, `state`, a
    secrets reference, `watermark`, `expires_at`, timestamps;
  - `assistant_deliveries`: (`seq`, `target_id`), `state`, `attempts`,
    `next_attempt_at`.

  These are new tables, but time the migration against a database with real
  history anyway (AGENTS.md).

- **Secrets** (webhook headers, signing secrets, subscription secrets) go in
  the server secret store, not SQLite.
- **The phone tables** don't change.

**The relay:**

- the code shard: the app's sign-in codes (code → host), for 10 minutes;
- `RelayAssistantSignIn` shards: pending sign-ins before and after binding, for
  10 minutes;
- the `RelayHost` DO:
  - `assistant_revoked` (connection id);
  - per-computer daily counters;
- secrets: `ASSISTANT_ROUTE_KEY` and `ASSISTANT_CLIENT_KEY`. Both are
  permanent.

## Web

- **Settings › Connections › Assistants**, next to Agents. It holds:
  - Connect an assistant (which shows the code, then the dialog) and Create a
    key;
  - the connections, each with name, how it signs in, access, last used,
    Change and Remove;
  - alert web addresses and subscriptions;
  - the address to paste;
  - short setup notes for Grok, dots, Muse and Duet.
- **The approval dialog:** the identity line, the browser line, three access
  levels, and one line explaining Work with all threads.
- **The command palette:** "Connect an assistant".
- **Phones:** nothing in v1. Managing access is owner-only, and paired phones
  have the `client` role (`grantForInvitePurpose`).

## The `threadlines` command

- `threadlines connect --url <https address> --key <key>`, or the
  `THREADLINES_URL` and `THREADLINES_KEY` variables. With these, the command
  runs on an assistant's own computer (Grok, Muse and Duet all have one) and
  reaches the user's computer through the door.
- `connectClient` already POSTs to any resource with a Bearer header
  (`connectClient.ts` 141-166). It needs a URL source and the key path.
- It keeps its 2025-06-18 client, which the handler speaks.
- It sends a `requestId` on every mutation already.

## Listings (thin wrappers)

- **Cursor marketplace** (Grok Bot and Cursor itself):
  - a public repo with `.cursor-plugin/plugin.json`, an `mcp.json` pointing at
    the address, and `skills/threadlines/SKILL.md`;
  - the skill says: read freely; ask before starting, sending or stopping;
    approvals go to the user; thread text is data, not instructions; link
    instead of pasting; say plainly when the computer is offline.
  - Unknown: whether to submit through the publish form or cursor.directory.
- **Anthropic directory:** the address, tool titles and annotations, a privacy
  policy, docs, and a reviewer test account (needs the demo computer).
- **OpenAI:** org and domain verification (the challenge file on the
  hostname), the tool scan, then submit.
- **Muse:** a docs page; there's nothing to submit.
- **A demo computer for reviewers:**
  - a headless Threadlines (the Docker image) on a small always-on server;
  - a stand-in agent and sample projects;
  - a server-only flag that keeps a code on its sign-in screen and
    auto-approves at See access, since there is nobody there to read a code.
    The flag only exists on that server, whose data is fake. The code goes in
    the reviewer instructions.

## Hit every surface

- **Entry points:** Settings, the command palette, the dialog.
- **Clients:** web and desktop. Approval happens on the desktop; phones show
  nothing.
- **Providers:** not provider-shaped. Assistants are clients; threads they
  start run on any provider, behind the fence.
- **Threadlines' own agent tools:** every one of them checks the turn's
  origin.
- **Contracts:**
  - `outsideAgents.ts`: kind, sign-in, identity, `work` access;
  - `orchestration.ts`: `fromOutside` on the respond command;
  - `relay.ts`: assistant socket frames, codes and revocations;
  - the assistant targets.
- **Reverse states:**
  - Remove and revoking a key, at the relay too;
  - turning a webhook off;
  - unsubscribing, and subscriptions expiring;
  - the kill switch;
  - "offline" and "refused by the receiver" shown in Settings.

## Honest limits

- **The relay sees plain text for this door.**
- **A user can still be talked into reading out their code.**
- **One computer per connection.** A user with several computers connects each
  one. A listed app may allow one connection per account, which means one
  computer. Pitch: route through Fleet.
- **No queued work while the computer sleeps.**
- **Approvals stay in Threadlines.**
- **The offline answer tells whether the computer is online** to anyone holding
  a credential that was never removed, even an expired one.
- **Phishing resistance depends on each assistant** tying `state` to the
  browser session. Consent phishing with an attacker's own client remains, as
  with any OAuth app.
- **The assistants' own limits:**
  - Duet's scheduled runs may not use custom connectors until we're listed;
  - Muse needs a key;
  - Grok's webhook doesn't retry.
- **Two MCP implementations** until the local door moves over.
- **Listings depend on three review queues** we don't control.

## Cost

- **Relay requests.** Every assistant call is a Worker request plus a DO
  request. The free plan's 100,000 requests a day are shared by every user, and
  rejected requests count too. Before listing, when other people will rely on
  it, move to Workers Paid (about $5 a month plus usage). That's Will's call.
- **The demo computer:** a small server, about $5 a month.

## Build order (one PR each)

1. **The door** (relay, server, web):
   - hostname and routes, the sign-in front with app codes, route tags, the
     revocation list, the assistant socket, offline answers, limits, the kill
     switch;
   - on the computer: `AssistantMcp` (both generations), access, refresh and
     key credentials, sign-in approval, the connection columns;
   - Settings › Assistants;
   - the command's `--url` and `--key`.
   - It ships the existing access levels and tools, with `thread_start`
     returning early and `requestId` required.
   - Live test: a staging relay deployment with a real Claude custom connector,
     a Grok custom connector, and Muse with a key.
2. **The record and read tools:** `assistant_events`, `inbox`,
   `thread_changes`, the `waitingOn` detail, annotations.
3. **Work:** outside work:
   - the runtime gate over the outside turn, its background tasks and its
     check-backs;
   - `fromOutside` through answers;
   - the runtime check on every path;
   - the Work level on both doors;
   - `thread_answer`.
4. **Alerts out:** targets, watermarks, webhooks and their Settings.
5. **MCP Events:** `events/*`, subscriptions, callback checks. Live test with
   dots, which needs an account that has it.
6. **Listings:** the demo computer, the Cursor plugin, the Anthropic and
   OpenAI submissions, the docs pages.

Each ships behind the relay kill switch and a desktop capability flag until
step 1 is verified live.

## Tests (focused)

**Relay** (`hostCore.test.ts` style, plus worker tests):

- A junk credential or a bad route tag gets 401 and wakes no DO (spy on the
  namespace). The per-IP limiter fails closed.
- With the computer offline:
  - a revoked connection gets 401;
  - a live token or key gets the generic offline tool error, with no computer
    name;
  - `/token` gets 503 `temporarily_unavailable`.
- Concurrent requests are matched by id. A dropped socket fails the ones in
  flight with 502. The 30 s timeout holds. The credential is forwarded, and
  doesn't show in logs.
- Sign-in:
  - a pending sign-in lives in its shard before any computer is known;
  - an app code binds only the page that typed it;
  - 3 tries per sign-in;
  - expiry;
  - one code per computer at a time;
  - the redirect goes to the typing page's sign-in, never another's;
  - an unknown return site is flagged to the computer.
- The CIMD fetch refuses private addresses and redirects.

**The computer:**

- `AssistantMcp`:
  - a 2025-06-18 `initialize` and `tools/call`;
  - an `initialize` offering 2025-11-25 negotiates down to 2025-06-18;
  - 2026-07-28 `discover`, and the mismatch error for an unknown `_meta`
    version;
  - a batch is refused;
  - `tools/list` follows the grant.
- Credentials:
  - access tokens expire;
  - refresh rotates;
  - the previous generation returns the same successor while the successor is
    unused, or within 10 minutes of the rotation;
  - two refreshes race, the winner uses its access token, then the loser
    arrives: the loser gets the same successor, and the connection stays;
  - an older generation, or the previous one after both limits, removes the
    connection;
  - the key hash check;
  - after Remove, the next call gets 401, and the relay is told.
- The local door is unchanged: an assistant credential is refused on
  `/mcp/connect`, and a local token on the assistant door (resource binding).
- `thread_start`:
  - returns `starting` with a thread id before the worktree exists;
  - a repeated `requestId` returns the same thread;
  - `thread_read` on that id says `starting`, then the thread;
  - a restart in between reads as `failed`.
- Turns from outside:
  - during an assistant's turn on a user-started thread, its agent's thread,
    room and schedule tools refuse changes and see only the connection's
    projects;
  - the gate holds through a steer into that turn;
  - a background task born in the outside turn keeps the gate on after the
    turn ends, even through a new user turn;
  - the gate lifts once the outside turn and its tasks have ended;
  - a check-back scheduled in an outside turn starts an outside turn, and is
    dropped if the connection was removed.
- `thread_answer`:
  - refuses approvals;
  - carries `fromOutside` through both the steer and the follow-up turn;
  - a runtime above the ceiling leaves the answer unsent.
- The record:
  - written with no phone registered;
  - a thread being looked at still gets its event;
  - an event read late is still written;
  - a restart during a settle finishes it, with nothing lost or doubled;
  - an interrupt during a settle drops the row;
  - `seq` follows the order events became final;
  - dismissing a plan resolves its `plan:` row, and a webhook retry after that
    doesn't send it;
  - `inbox` returns finished and failed since the cursor, with `needsYou` live.
- Webhooks:
  - network rules (a private address is refused, a redirect isn't followed);
  - the Standard Webhooks signature matches a published test vector;
  - 410 turns the target off;
  - no title or agent text in any body.
- MCP Events:
  - the challenge must echo;
  - subscribe is idempotent and refresh extends it;
  - event 12 delivered while 11 retries keeps the watermark at 10, and a
    refresh after a restart replays 11;
  - Remove stops deliveries.

**Web:** a browser test for the Assistants group, and for the code screen
turning into the dialog with its identity line, browser line and Work level.

**Live:** a staging relay and a throwaway home, with:

- a real Claude custom connector;
- a real Grok custom connector;
- Muse with a key;
- dots for events, when an account allows it.

## Open questions for Will

1. Workers Paid before listing (about $5 a month plus usage), and a small demo
   server (about $5 a month)?
2. The hostname: `connect.threadlines.dev`, or another?
3. Approvals: never through assistants (this plan), or a switch per connection
   later?
4. Should paired phones be able to approve an assistant's sign-in? It changes
   the owner-only rule.
5. Should keep-awake count assistant connections?

## Rev 2: Sol's review of rev 1, and what changed

All 14 findings checked against the code; all hold.

1. **Work bypassed the fleet fence.** The fence follows the thread
   (`ProviderCommandReactor.ts` 1248). Fixed: turns from outside carry the
   grant into Threadlines' own agent tools. Work refuses unfenced threads
   until that ships, and it's its own build step.
2. **Answers lost their origin.** The steer and follow-up paths drop
   `fromOutside` and skip the runtime check (3705-3771, 2060). Fixed:
   `fromOutside` goes through both, and the grant and runtime are checked
   again before delivery.
3. **The socket dropped the bearer.** Fixed: an explicit `credential` field,
   never logged, checked on the computer.
4. **Authorization codes couldn't pass the route-tag check** (no connection
   id). Fixed: codes carry host, connection and tag; the id and tag are made
   at Allow.
5. **Sign-in phishing.** With the page showing a code typed into the app, an
   attacker could start a sign-in with their own assistant account and talk
   the user into typing that code. Fixed: the code now goes from the app to
   the page, so the redirect follows the browser holding the user's code. Plus
   a browser line in the dialog. The read-it-out-loud case remains (Honest
   limits).
6. **Refresh retries rotated again and could revoke an innocent
   connection.** Fixed: the previous generation returns the same successor
   until the successor is seen in use; state is two numbers in one
   transaction.
7. **The 30 s deadline broke `thread_start`.** Fixed: assistants get the
   thread back once it exists, and `requestId` is required on mutations.
8. **Phone rules dropped events assistants need** (the 10-minute and presence
   rules). Fixed: a separate record with no age or presence rule; eligibility
   per target; the record is built before `inbox`.
9. **The alert `seq` wasn't a safe cursor.** Fixed: a per-target watermark.
10. **MCP Events needs an envelope.** Fixed: the envelope is specified, with
    `eventId` stable across retries.
11. **Offline answers broke the 401-after-Remove promise and leaked the
    computer's label.** Fixed: a relay revocation list, and offline answers
    only for live, unexpired credentials. The remaining leak is in Honest
    limits.
12. **Legacy `initialize` must negotiate.** Fixed.
13. **Titles are agent text.** Fixed: no titles in pushed bodies.
14. **The 1 MiB WebSocket cap is outdated** (32 MiB since Oct 2025). Fixed:
    768 KiB is our own limit.

Not raised as defects, and kept: the in-memory pending map (a DO with a
request in flight doesn't hibernate), and writing our own handler.

## Rev 3: Sol's re-check of rev 2, and what changed

All 9 findings checked against the code; all hold.

1. **Flipping the code didn't make sign-in phishing-proof by itself.** It
   works only if the assistant ties `state` to the browser session, which is
   the client's job (RFC 9700, section 4.7.1). And an attacker's own client
   can collect a code. Fixed:
   - the claim is narrowed, with a per-assistant check before listing;
   - an unknown-assistant warning in the dialog;
   - the place line is information only (rev 2 claimed "same network", which a
     shared IP can't show).
2. **The turn gate ended before the work it allowed.** Background subagents
   outlive the turn, and Claude's check-backs start later turns on their own.
   Fixed:
   - the gate is on the runtime while any outside work is alive;
   - check-backs carry the origin;
   - the ceiling is stated as the real boundary for shell access.
3. **Two honest refreshes could still remove a connection.** Fixed: a
   10-minute duplicate window, as well as the unused-successor rule, with a
   test for that interleaving.
4. **Returning "once the thread exists" was still too late.** The worktree is
   made first (`ThreadBootstrap.ts` 454-475). Fixed: `thread_start` answers
   from the request row before setup starts.
5. **The offline `exp` check was forgeable.** Fixed: the offline answer is
   generic, with no name and no last seen, and the relay keeps no last seen.
6. **Keys got 401 while the computer was offline.** Fixed by the same
   generic answer.
7. **Settling events had no durable state.** Fixed: rows go in as `settling`
   in the cursor's transaction, and `seq` is set once they're final.
8. **A dismissed plan never resolved its event.** Fixed: a record rule for
   `thread.proposed-plan-upserted`, and every send attempt re-checks the event.
9. **Pending sign-ins had nowhere to live before a computer was known.**
   Fixed: `RelayAssistantSignIn` shards.

## Build notes: step 1 on the computer

Choices the build made inside the plan, for the relay and web builds to match:

- **Reading Settings never registers the computer with the relay.** The
  address stays null until Connect an assistant or Create a key registers it;
  after that the snapshot asks the relay again when its answer is stale.
- **A missing `requestId`** is a tool result with outcome `failed` that says
  so (the tools' house rule: decisions are outcomes), not a JSON-RPC error.
  This door's tool list marks `requestId` required on `thread_start`,
  `thread_send` and `thread_stop`.
- **Stops take a `requestId` on both doors**, recorded like starts and sends,
  so a retried stop answers from its row.
- **`server/discover`** lists `2026-07-28` and `2025-06-18`; modern requests
  without the `Mcp-Method` header (or `Mcp-Name` on `tools/call`) get
  HeaderMismatch. `ping` is legacy only, as 2026-07-28 removed it.
- **The assistant socket** sends the relay's heartbeat ping every 20 s; once a
  pong came back on a socket, 45 s of silence reconnects it.
- **Token requests are bound by the code or refresh token**, not by the
  frame's `resource`; a `resource` in the body must match. MCP requests must
  carry, in the frame's `resource`, the exact string the connection was made
  for: the sign-in's `resource`, or for a key the relay's info `address`.
- **The `threadlines` command** makes up a `requestId` for starts, sends and
  stops only when it talks to an assistants door; locally it still leaves it
  out unless `--request-id` is given.
- **No telemetry** for assistants yet; it needs a line in `docs/telemetry.md`.

## Build notes: step 1 put together (Oct 30)

Will's answers to the open questions: Workers Paid and the demo server when
listing comes (not before); the relay's own origin for the address (see The
public address); assistants never answer
approvals; phones and keep-awake stay as in this plan for v1.

What changed while the three parts were joined and tested live:

- **The door's address is public** (`GET /v2/assistants`), the same for every
  computer. Settings shows it before the computer has registered with the
  relay; until then it said the door was off and its buttons were grey.
- **Loopback return addresses on any port** (RFC 8252, and the MCP spec's
  "localhost or https"), so native clients (Claude Code, Codex, the
  `threadlines` command) can sign in through the door too.
- **Scopes the door doesn't define** (`offline_access`, `openid`) are ignored
  instead of refusing the sign-in.
- **The computer stays on the relay while an approved code waits to be
  traded** (60 s): right after Allow, nothing else was waiting, so it dropped
  the socket and the assistant's token request got "temporarily unavailable".
- **A feature keeping the relay link online registers the computer.** An
  assistant connection made under another relay asked to stay online before
  anything registered with the new one, so the control socket never opened.
- **Sol's review of the branch** (6 findings, all taken): `/token` counts
  against the daily allowance; a cancelled or replaced code starts nothing even
  before its shard hears; the revocation list can't fill (retries count once,
  route tags stop first); a decision that can't reach its shard is retried and
  the shard takes the same decision again; the assistant socket's silence
  timer starts when it opens; an assistant's `thread_start` bounds its git
  checks to 10 s.
- **App guide:** the Assistants section and its rows are catalog places, with
  an Assistants topic.

Live checks (Oct 30), all with a stand-in agent and a throwaway home:

- Local `wrangler dev` relay: sign-in through the real page (code from
  Settings, Allow, redirect), token, both MCP generations, `thread_start`
  with and without `requestId`, `thread_wait`, refresh with a replayed
  previous token, a key at See access refused a start, Remove (401 and relay
  told, refresh refused), the computer stopped (removed: 401; key: the
  generic offline answer; other methods: 503), the key working again after a
  restart.
- A staging relay on workers.dev (`threadlines-relay-staging`, its own keys):
  the same sign-in and tools over the public internet, and the `threadlines`
  command from another home with `connect --url --key` and `THREADLINES_URL`
  (projects, `thread start --wait`).

Not yet: a real hosted assistant (Grok Bot, Claude, dots, Muse) against the
staging relay; a nicer address than the relay's own; the relay's
production deploy and its secrets.

## Build notes: step 2 (the record and the read tools)

What was built (`feat/assistants-read-tools`):

- **The record** (`assistants/AssistantEvents.ts`, `AssistantEventsLive.ts`,
  `AssistantEventRepository.ts`, migration 094). Its own cursor over the event
  log, rows in the cursor's transaction, `settling` → `recorded` (next `seq`)
  or `dropped`, cancels drop or resolve, the plan rule, 7 days, the scheduled
  tasks' cards as `schedule:` rows. Service API for steps 4 and 5:
  `since(after, limit, names?, projectIds?)` → events, `upTo`, `more`;
  `position` (record id, running, last `seq`, pruned through); `changes`.
- **The checks are shared.** `pushAlerts/alertChecks.ts` is `PushAlerts`'
  old `evaluate` minus presence; phones call it and add presence, the record
  calls it as is. Phone behavior is unchanged.
- **`inbox`, `thread_changes`** on both doors (See), titled and read-only.
- **`waiting`** on `thread_read` and `thread_wait` (both doors), beside the
  old `waitingOn`. The `threadlines` command prints a line per item.
- **Shared reading of what waits:** `threads/threadWaiting.ts`, used by
  `waiting` and `needsYou`.

Choices made inside the plan:

- **A visit doesn't drop a settling row.** Phones drop on `thread.seen-set`;
  the record still records the event and marks it resolved `seen`. That is
  how "a thread being looked at still gets its event" holds even though the
  app marks a thread seen the moment a turn finishes in view.
  `seenInThreadlines` is a resolution of `seen`, `wrapped` or `archived`. A
  visit resolves only rows that happened at or before its stamp: the app
  stamps a visit with the turn's completion time (which is the turn event's
  `occurredAt`) and "Mark unread" a millisecond before it, so marking a
  thread unread never counts as seeing it. A side answer or restart that
  happened after the turn the visit was stamped with stays unseen.
- **Off forgets the cursor.** With no assistant connection the record stops
  reading and clears its cursor, so the next connection starts from the
  newest event: the time with nobody connected is history too. Cards waiting
  since before the record started are skipped for the same reason.
- **Long-running work backs off.** A finished turn whose thread still has
  work going is re-checked after 10 s, then less often the longer it has
  been settling (a tenth of that time, at most 5 minutes; `added_at`). Phones instead give up after the
  alert's 10-minute life; the record has no age rule.
- **`needsYou` covers every card the status counts:** tool approvals, the
  scheduled-task changes an agent asked for, and threads an agent asked to
  start, all as `approval` (the summary says which), then questions, then
  the plan when the thread's status is "needs the user". At most 50 threads
  are read per call, most recently active first.
- **`waiting` is a list,** one item per open request, the kind `waitingOn`
  names first. Approval: `asks`, `tool`, `detail` (command or path, clipped
  at 300). Question: `requestId`, questions with options. Plan: id and title
  (its first heading).
- **`inbox` on the local door** answers `needsYou` always; `finished` and
  `failed` only while the record runs, otherwise `recordKept: false` with a
  cursor that marks now. On the assistants door it also lists `starting`:
  its own starts that have no thread yet.
- **Cursors** are `base64url("ae1:<recordId>:<seq>")`. One from another
  computer, from beyond the last `seq`, or below the pruned mark reads from
  the start with `truncated: true`.
- **Links** go to the hosted app of the build's channel (nightly builds to
  `nightly.app.threadlines.dev`, as phone pairing does), at
  `/<environmentId>/<threadId>`.
- **`thread_changes`' files** come from the turns' stored file summaries
  since the checkout was last clean, the source of the sidebar's count and
  the turn cards. No git diff per call. Per-file numbers are summed over
  turns, so a line changed twice counts twice; `totals` is the sidebar's own
  number (`cumulativeDiffStat`, which uses the latest whole-thread
  measurement), so the two can differ.
- **Its pull request** comes from `PullRequestService`: `list({ open,
  projectId })` for checks, review and mergeability, and `lookup` by branch
  and by the thread's linked numbers for merged or closed ones. Both are
  cached 30 s and ask the host on a miss. The base branch is the pull
  request's, else the git driver's own rule for a branch without an upstream
  (`resolveBaseBranchName`: `branch.<b>.gh-merge-base`, else the remote's
  default, else `main` or `master`, whichever exists). The host and git share
  one 6 s deadline; what doesn't answer reads as null. An open pull request
  already listed is kept when the slower lookup misses the deadline.
- **A verdict is final only if its thread stood still.** A row is judged at
  the record's cursor, and becomes final only if no event about its thread
  (or its own result settling on its parent) reached the log after that
  cursor, read yet or not. So an interrupt or answer already in the log
  after a restart is read first, and other threads' streaming never holds a
  row up. A row that was stale goes behind the other due rows for 250 ms.
  Turning the record off drops rows still settling.

Found in the live run: a turn in a git checkout ends with its final capture
(`thread.turn-diff-completed` with `completesTurn`), not
`thread.turn-completed`, which only closes turns without one. The alert
rules listened only for the latter, so phones (since #614) and the record
missed most finished and failed turns. The rules now take both. A child's
turn alert also drops once its result went back to the parent
(`handedBackTurnId`), since the capture that starts it often lands after
the parent's cancel.

Tests: `AssistantEvents.test.ts` (no phone, a visit, read late, restart
mid-settle, interrupt mid-settle, another thread streaming, turned off
mid-settle, `seq` order, the plan rule, history and pruning), `connectToolHandlers.test.ts` (`inbox` live, scoped, paged,
truncated and not kept; `thread_changes` with the cap and with and without a
pull request; `waiting` for each kind), the tool lists in
`McpConnectServer.test.ts` and `Assistants.test.ts`. Migration 094 took 3 ms
on a copy of a real database (5.5 GB, 884,000 events).

Live run (production relay, a throwaway Threadlines with a stand-in agent):
sign-in, `inbox` listing a finished thread and an approval (gone once
approved in the app), `thread_changes` with a file and its base branch, and
`waiting` with the command asked for.

Not done here: `threadlines inbox` and `threadlines thread changes` commands;
a run against a real hosted assistant.

## Build plan: step 3 (Work with all threads)

Written Oct 30 from a map of the code on main (`e237b8c52`), then rewritten
after Sol's review of the first draft (10 findings, all taken; see the end).
Where the code differs from the sections above, this wins.

### What the code does today (and why it matters)

- **Agent tools are fixed per runtime.** Every provider gets Threadlines'
  tools once, at session start, with a bearer token minted per runtime
  (`McpSessionRegistry.credentialFor`). None can be handed a new list
  mid-session, and subagents and background agents call with the parent's
  token. So the gate is per call, and only a new runtime gets a clean token.
  The room endpoint authenticates every request (`McpRoomServer.authenticate`)
  and sends every tool through one table (`McpRoomServer.ts` 314-357).
- **The fence is per thread, at session start.** `fencedOff` (outside or
  remote origin) leaves out the room and guide tools
  (`ProviderCommandReactor.ts` 1250-1262, 1434-1439). No handler checks
  `outsideOrigin` per call. Threads the user started keep every tool, and
  the browser panel stays on for every thread.
- **Nothing says when outside work ends.** Session counts and the subagent
  roster say what's alive, not which turn started it, and describe only the
  room's slot holder. Claude and ACP open a turn only when output arrives
  (`ensureSyntheticTurn`), so a quiet runtime can still be working. Claude
  check-backs carry no origin, durable ones survive restarts, and a fired
  one starts a provider turn with no Threadlines command.
- **Outside access is ownership.** `outsideStopRefusal` refuses any thread
  whose `outsideOrigin` isn't the caller's; `OutsideTurnOrigin` has no level.
- **Answers lose their origin.** `thread.user-input.respond` has no
  `fromOutside`; the decider only checks that the thread exists; `message`
  mode (Codex) steers or starts its own turn without an origin;
  `respondToUserInput` delivers whatever the runtime's mode.
- **A runtime can already be restarted to change what it was given.**
  Missing room tools and a waiting access raise restart it with resume, and
  wait while background tasks run (`ProviderCommandReactor.ts` 1700-1760,
  the runtime's own `pendingBackgroundTaskCount`; the adapter refuses to
  cycle a runtime with tasks).

### What the gate promises

While outside work can still act on its own (the outside turn, its
background tasks and subagents, anything it left to run later), it can't use
Threadlines' agent tools past the connection's grant, and it can't leave
anything that runs after the gate lifts. Once that agent's runtime has
stopped and the user sends the next turn, the user is driving.

Not promised: outside text read later as data. Another agent can read an
assistant's message through `thread_read` or `room_history`, or get it in a
room's catch-up at a turn the user started, and be swayed by it, as by any
text it reads. That's the existing limit for threads an outside agent
starts ("Thread titles and messages are agent-written").

### Outside work marks the agent's session, until it starts fresh

A thread gets `outsideWork: Array<{ participantId, connectionId, name,
since }>`, one entry per agent session (room participant) that outside text
reached, with every connection that reached it (projection column, durable,
on the thread shell for the UI).

- **Marked by the decider,** in the same command that lets outside text
  reach an agent: an outside `thread.turn.start`, and an outside
  `thread.user-input.respond`. It names the agent the text goes to. Being
  in the event, it's on before the reactor delivers anything, and it
  survives restarts. The mark belongs to the agent (thread and
  participant), not to a token: a runtime that recovery respawns for a
  marked agent is still marked.
- **Cleared only by starting that agent fresh.** At the next turn that isn't
  from outside, the reactor treats a marked agent like one missing its room
  tools: it restarts the runtime with resume (a new runtime gets a new,
  clean token; the old one is revoked as it stops), and dispatches
  `thread.outside-work.clear { participantId }` before sending the turn.
  - It waits while the runtime reports background tasks or a turn in flight,
    as the existing restart reasons do; that turn runs marked.
  - An agent with no runtime alive starts fresh anyway, so it clears then.
  - The old runtime must be gone (its token revoked) before the clear. An
    early session started while the user typed only counts if it started
    after the mark.
  - A fresh start has to end what the old runtime left queued, not just its
    process. Each adapter says whether its restart did (`freshStart:
    "clean"`), and the mark stays if not. Claude, Codex, Pi and the ACP
    agents run one process per runtime, so stopping it ends everything.
    OpenCode keeps its native session in its own server across a restart,
    so its fresh start interrupts that session and silences its next
    self-wake (the existing `silenceNextWake` path) before it reports
    clean. Muse is checked in the build.
  - A provider that can't report background work (Pi, Codex's collab
    agents block the turn instead) still restarts when its runtime reports
    no turn; any work it hid ends with the runtime. The notice says so.
  - The user can also start it fresh from the thread's notice.
    No timers and no reading of what looks idle.
- **While marked, every call with that agent's token is gated** (its
  subagents, background agents and side answers use it or inherit the mark):
  - **Room endpoint:** every tool that changes something refuses with one
    sentence ("An assistant's work ran in this agent's session, so
    Threadlines' agent tools can only read until it starts fresh"):
    `thread_start`, `thread_send`, `thread_stop`, `room_ask`, `room_review`,
    `room_hand_off`, `room_invite`, `schedule_create`, `schedule_update`
    (`scheduled_run_finish` only records the caller's own run, so it stays).
    `app_guide` refuses (app-wide settings, linked
    computers, connection names). Reads stay inside every marking
    connection's live grant: `thread_list` and `thread_read` drop linked
    computers' children; `thread_agents` drops computers; a thread whose
    project left a grant reads nothing; a removed connection leaves only
    the caller's own thread. One exhaustive `Record<RoomEndpointToolName,
    "changes" | "reads">` decides, so a new tool can't skip it.
  - **The browser panel refuses every tool.** Its sign-ins and private
    addresses aren't the connection's to use. (This also applies to threads
    an outside agent started, which keep the browser today.)
  - **Pages and `ask_user_to_run` stay.** They only show the user things,
    and a command still waits for the user's click.
  - **Nothing it leaves runs later.** Claude's `CronCreate`,
    `ScheduleWakeup` and `ProposeGoal` are refused by the adapter's
    `PreToolUse` hook (it runs in every access mode, unlike `canUseTool`).
    The hook asks a live lookup (`OutsideWorkLookup`, a service the server
    provides to adapters) rather than a flag passed in, so every way text
    reaches the runtime is covered: turns, steers, answers, recovery. A
    Codex goal that appears while the agent is marked and that Threadlines
    didn't set is cleared (`thread/goal/clear`), with a line in the chat.
    The always-on assistant checks back itself.
  - **OpenCode registers tools per directory,** so a session sees every
    other session's servers in the same folder. For OpenCode the mark
    gates every token registered for a marked agent's directory (the
    registry records it at minting). That also closes the same gap for
    threads an outside agent starts today.
- **Several connections can mark the same agent.** Reads stay inside all of
  their grants; changes refuse either way.
- **The thread shows a notice** while any agent is marked: "An assistant's
  work ran here, so this agent's Threadlines tools are limited until it
  starts fresh." Button: Start fresh.

### The Work level

- `OutsideAgentAccess` gains `"work"`. `OutsideTurnOrigin` gains `access`
  (decoding default `"start"`, so old events keep today's rule).
- **Stored so an older build fails closed:** the `access` column keeps
  `"start"` and new columns say Work (`work_level INTEGER NOT NULL DEFAULT
  0`, `grant_writes INTEGER NOT NULL DEFAULT 0`). An older build reads the
  connection as Start. A trigger (`AFTER UPDATE OF access, max_runtime_mode,
  project_ids_json ... WHEN NEW.grant_writes IS OLD.grant_writes`) sets
  `work_level = 0`. New builds bump `grant_writes` on every grant change, so
  only an older build's change trips it: Change in an older build (See,
  then Start) can't bring Work back after an upgrade.
- **Never asked for, only granted.** No new OAuth scope and no relay change:
  the user picks Work in the dialog or in Change. A sign-in that asked for
  See only still caps at See (`grantRefusal`); Start may be raised to Work.
  `scopeForAccess` gives Work the Start scopes.
- **Decider:** `outsideStopRefusal` keeps ownership for Start and drops it
  for Work. The ceiling rule stays for both.
- **`thread_send` and `thread_stop`** reach any visible thread at Work
  (projects, no General Chats, ceiling). Sends still never queue or steer:
  a busy thread answers `busy`. `runningThreads` counts threads this
  connection marked, not only threads it started.
- **`thread_answer` (Work):** `{ threadId, requestId, waitingId, answers }`.
  `requestId` is the retry key; `waitingId` is the `requestId` of a
  `question` item in `waiting`. `answers` has one entry per question, in
  order: an option's label or free text, or a list of labels where several
  may be picked. The handler checks them against the open request's own
  questions and builds the provider's keyed answers. Refused: forms
  (elicitations), approvals, and a question with parts `waiting` doesn't
  show whole (over its caps, or a clipped label): "Answer this one in
  Threadlines."
  - It dispatches `thread.user-input.respond` with `fromOutside` (origin
    with access). The decider refuses no open question with that id, an
    approval, a thread the level doesn't reach, a thread above the ceiling,
    and a question whose asking agent no longer holds the thread (a room
    handed over since); it marks the asking agent in the same event. The
    reactor delivers only to that agent's runtime.
  - The reactor checks again right before delivery: the connection, its
    grant, and the live runtime's mode against the ceiling. Failing that,
    nothing is sent, the question stays open, and a
    `provider.user-input.respond.failed` activity says why.
  - `message` mode keeps the origin all the way: the steer is checked in the
    reactor, and the follow-up turn is a real outside `thread.turn.start`
    with `answering: <requestId>`, so the decider's busy rule passes over
    that one open question and the launch-time ceiling checks run.
  - The resolved card in the chat says who answered ("Answered by Grok Bot").
- **Waiting items** gain each question's `id` (additive).
- **Both doors** list `thread_answer` at Work (`listedToolsFor`, the
  assistants door's tool list with `requestId` required,
  `OutsideAgentRequestTool`). Tool texts stop saying "threads you started"
  where Work reaches further.

### Surfaces

- **Settings:** the access dialog's third level with one line ("Can also
  message, stop and answer questions in any thread in its projects. Never
  approvals."), the ceiling for Start and Work, rows describe Work.
- **The thread:** the notice with Start fresh, and "Answered by" on question
  cards.
- **The command:** `threadlines thread answer <thread> <waitingId> <answer>...`.
- **Guide and docs:** the outside agents and assistants topics, the places'
  words, `docs/outside-agents.md`.

### Tests

- Decider: Work reaches others' threads, Start doesn't; ceiling; respond
  with `fromOutside` refuses approvals, closed questions and threads out of
  reach; an outside turn or answer marks the agent it reaches; the answer's
  follow-up turn passes the busy rule only for its own question.
- The gate: a marked agent's changing room tools refuse, reads stay inside
  every marking grant, the browser refuses, pages work; another room
  agent's token isn't gated.
- Clearing: the next user turn restarts a marked runtime and clears it;
  background tasks keep it marked through that turn; Start fresh clears it.
- Claude: `CronCreate`, `ScheduleWakeup` and `ProposeGoal` refused while
  marked, including after an answer and after recovery; a Codex goal set
  while marked is cleared.
- OpenCode: a token sharing a marked agent's directory is gated.
- Answer delivery: a runtime above the ceiling leaves the answer unsent;
  message mode keeps the origin through the steer and the turn.
- `thread_answer` by order, multi-select, free text, a form refused.
- Old builds: a Work row reads as Start; an old build's grant change clears
  Work (the trigger), a new build's doesn't.
- Web: the dialog's third level, the notice.
- Live: a throwaway install with a stand-in agent that calls room tools
  during an outside turn and asks a question.

### Sol's review of the first draft (Oct 30)

The first draft lifted the gate after 15 s of a thread looking idle, kept
one origin per thread, stamped check-backs, and left the browser open. Sol
found that a quiet runtime can still be working (Claude and ACP open turns
on first output), that projections describe only the slot holder, that a
clear could race a new turn, that a second connection would take over the
first's work, that durable check-backs lose their origin across a crash,
that a labelled answer turn skips the ceiling checks, that the browser can
reach signed-in pages, that `waiting` can't always be answered from, and
that an older build can't read a Work row. The mark-until-fresh design, the
refused check-back tools, the gated browser, the `answering` turn, the
refusal for partly shown questions and the `work_level` column answer them.

Sol's second pass (same day) found six more: OpenCode's per-directory
tools, outside text reaching other agents as history, an answer steered
into a different room agent, the scheduling hook missing answers and
recovery, model-set goals re-armed on resume, and an older build's Change
reviving Work. Answered by: the promise stated above (history is data, as
today), per-directory gating for OpenCode, answers bound to the asking
agent, the live lookup for the hook plus goals refused or cleared, and the
`grant_writes` trigger.

A last focused pass found one more: OpenCode's restart keeps the native
session, so a report queued by outside work could wake the fresh runtime.
Answered by `freshStart` and OpenCode's interrupt-and-silence step.

Sol's review of the built branch (Oct 31) found seven more, all fixed: a
fresh start could clear a mark that outside text renewed while it ran (marks
now carry a version, and a clear names the one it saw); Retry replayed an
outside message without its mark or ceiling (Retry refuses it now); the goal
clear was only queued before the mark lifted (the provider clears it first,
or the agent stays marked); a stop that failed for one room agent still
cleared its mark (only agents whose runtime is gone clear); OpenCode's quiet
start ignored a failed interrupt (the start fails instead); an answer's own
turn went to the thread's own agent instead of the room agent that asked;
and an archived thread read as unmarked while its runtimes were still
stopping (the lookups read archived threads too).

Its re-check of those fixes found three more, fixed: a mark saved before
versions existed wouldn't load (it reads as version 1); Start fresh could
restart the runtime it had just stopped to clear a goal (a stop leaves an
agent with such a goal marked for its next fresh start, which has a runtime);
and an agent moved to a provider without goals stayed marked for good (a
provider without goals skips that step).

## Build plan: step 4 (alerts to a web address)

Written Oct 31 on main (`035ae18eb`), from "2. Targets" and "Webhooks" above.

### What already exists

- The record (`AssistantEvents`): `since(after, names?, projectIds?)` with
  `upTo`, `changes`, and events that carry `resolvedAt`. It runs only while
  an assistant connection exists (`AssistantEventsLive` checks `countLive`).
- Phone alerts: `retryDelayMs` (5 s up to 5 min) and 6 attempts
  (`PushAlerts.ts`), and the presence leases that say who is looking at a
  thread (`pushPresence.ts`, owned by `PushAlerts`).
- `ServerSecretStore` for secrets, and the `outsideAgents.subscribe` snapshot
  Settings reads.
- Nothing on the server makes outbound calls under network rules yet.

### Targets and deliveries (migration 096)

- `assistant_targets`: `target_id`, `kind` (`webhook` now; `subscription` in
  step 5), `connection_id` (null for one the user added), `url`, `names_json`,
  `project_ids_json` (null: all), `skip_viewed`, `state` (`on`, `off`,
  `gone`), `refused_since` (repeated 401 or 403), `watermark`,
  `last_sent_at`, `last_error`, `expires_at` (step 5), timestamps.
- `assistant_deliveries`: (`target_id`, `seq`) key, `event_id`, `state`
  (`pending`, `sent`, `dropped`, `failed`), `attempts`, `next_attempt_at`,
  `first_attempt_at`.
- Secrets in `ServerSecretStore`: the target's signing secret (`whsec_`, 32
  random bytes) and its optional Authorization value. Removing a target
  removes both.
- A new target's watermark starts at the record's last `seq`: no history.

### Sending (`AssistantAlertsLive`)

- The record runs while an assistant connection **or a target that's on**
  exists.
- A loop wakes on the record's `changes`, on target changes, and on the next
  due retry. Per target that's on:
  1. Read `since(watermark, names, projects)` in pages. Each matching event
     gets a `pending` delivery row; events that don't match need nothing.
  2. Send due rows, oldest first, one at a time per target. Right before each
     send, read the event again: a `needs_you` event that's resolved, or any
     event on a thread someone is looking at (with `skip_viewed`), is
     `dropped`. Finished and failed go out even if resolved.
  3. The watermark moves to just below the oldest delivery that isn't final
     (`sent`, `dropped`, `failed`), or to `upTo` when none is open, in the
     same transaction as the rows. A retrying event is never skipped.
- Answers:
  - 2xx: `sent`.
  - 410: the target turns `gone`; its open deliveries are dropped; Settings
    says the receiver turned it off and offers Turn on again.
  - 401 or 403: retried like any failure; three in a row set
    `refused_since`, shown as "refused by the receiver" until a 2xx.
  - 413: `failed` at once.
  - Anything else, a timeout or a refused address: retried with
    `retryDelayMs` (`Retry-After` honored), until 6 attempts or 24 hours
    after the first, then `failed`.
- The envelope, as "What an event carries" says: `{ eventId, name,
  timestamp, data, cursor }`. `cursor` is the record cursor at the target's
  watermark, so `inbox(since: cursor)` catches up. `data` carries no title
  and no agent text.
- Headers: `content-type: application/json`, Standard Webhooks
  `webhook-id` (the `eventId`), `webhook-timestamp`, `webhook-signature`
  (`v1,` HMAC-SHA256 over `id.timestamp.body`), the optional Authorization,
  and `user-agent: Threadlines`.

### Outbound calls (`net/outboundHttps.ts`, shared with step 5)

- `https:` only, port 443 or any explicit port, no credentials in the URL.
- Resolve the host (`dns.lookup`, all addresses). Refuse when any address is
  private, loopback, link-local, CGNAT, multicast, unspecified or reserved
  (IPv4 and IPv6, IPv4-mapped included; Node's `net.BlockList`).
- Connect to the checked address (`https.request` with a fixed `lookup`, the
  host as SNI and Host), so DNS can't change between check and connect.
- No redirects (a 3xx is a failure), 10 s for the whole call, the answer
  body read up to 64 KiB and ignored.

### Settings and RPCs

- Settings › Connections › Assistants gets "Alerts to a web address":
  - a row per target: its host, kinds, projects, and status (on, last sent,
    retrying, refused by the receiver, turned off by the receiver, off);
  - Add and Edit: the URL, an optional Authorization header (write-only,
    kept or replaced or cleared), the kinds (needs you, finished, failed),
    the projects, and "Skip threads I'm looking at" (on by default);
  - row actions: Send a test, Copy signing secret, Turn off or on, Remove.
- RPCs (owner only): `outsideAgents.alertTargetCreate`, `…Update`, `…Remove`,
  `…Test` (sends a `threadlines.test` envelope at once and answers with the
  status or error) and `…Secret` (the signing secret, on request only).
  Targets ride the `outsideAgents.subscribe` snapshot without secrets.
- The URL is checked when saved (the scheme, the host resolving to a public
  address), so a typo shows at once.
- The app guide gets the place; the assistants topic says how to use it with
  a Grok routine (its webhook URL and its `crsr_` key as the Authorization).

### Tests

- Outbound: private, loopback, link-local, CGNAT and mapped addresses are
  refused; the connection goes to the checked address; a redirect isn't
  followed; the timeout.
- Signing matches the Standard Webhooks test vector.
- Sending: a retrying event holds the watermark while a later one is sent;
  410 turns the target off; three 401s mark it refused and a 2xx clears it;
  a needs-you resolved before sending is dropped and the watermark moves; a
  viewed thread is skipped; no title or agent text in any body; a new target
  sends no history; a restart carries on from the rows.
- Web: the group, the dialog, the row states.

### Sol's review of the step 4 plan (Oct 31), and what changed

Nine findings, all taken:

- **Proxies.** Node can route the default agent through `HTTPS_PROXY`
  (`NODE_USE_ENV_PROXY`), which would resolve and connect on its own. Every
  call gets its own direct `https.Agent`, never the global one.
- **At most once when the outcome is unknown.** A receiver may start a paid
  run and then lose the answer. So the attempt is written (attempts + 1,
  `in_flight`) before the call. A send is retried only when it plainly didn't
  arrive: the address was refused, DNS or the connection or TLS failed, or
  the receiver answered 429 or 5xx. A timeout after the body went out, or a
  row still `in_flight` after a restart, ends `failed` ("may have arrived; not
  sent again"). The stable `webhook-id` lets a receiver that keeps ids drop a
  repeat.
- **Live checks before a needs-you goes out.** The record can lag (after a
  restart) or be stale (an answer given while the record was off isn't read).
  So a needs-you event is judged again by the shared alert checks
  (`alertChecks.ts`, as phones do) right before each send; one that no longer
  holds is dropped.
- **No gap when the first target turns on.** Creating or turning on a target
  starts the record at once (`AssistantEvents.keep`, which begins it if off),
  then sets the target's watermark to the record's last `seq`.
- **Missing events and lifetimes.** A delivery whose event was pruned is
  dropped. A delivery's 24 hours count from when it was queued
  (`queued_at`), not from its first attempt.
- **Presence is shared.** `PushAlerts` exposes `isViewed`, so the sender asks
  the same leases the app reports to.
- **Address rules are concrete.** IPv4: 0/8, 10/8, 100.64/10, 127/8,
  169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16,
  198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. IPv6: ::/128, ::1/128,
  IPv4-mapped (checked as IPv4), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64),
  100::/64, 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4), fc00::/7,
  fe80::/10, fec0::/10, ff00::/8. Honest limit: a network-specific NAT64
  prefix looks public and can't be told apart.
- **Turning back on never replays.** A target turned on again (after Off or a 410) starts at the record's last `seq`; what it missed isn't sent. A
  `refused_streak` column counts 401 and 403 in a row (three set
  `refused_since`); a 2xx, a successful test or new credentials reset it.
  `failed` deliveries are never retried.
- **Remove is coordinated.** Sends and Remove take the target's lock. Remove
  marks the target `deleting`, then deletes its secrets, then its rows; a
  start finishes any `deleting` target. A target whose signing secret is
  missing doesn't send (it shows an error), and the secret is made only at
  create.

### Build notes: step 4 (Oct 31)

What the build changed from the plan above:

- **Which answers are tried again.** A call that plainly never arrived, and
  401, 403, 408, 425, 429 and 5xx. Any other answer (a 3xx, 400, 404, 413,
  422 ...) means the receiver read it and turned it down, so it ends
  `failed` at once: trying again can't help, and a receiver that started a
  run shouldn't get a second. 410 still turns the target `gone`.
- **NAT64.** An address in 64:ff9b::/96 is judged by the IPv4 inside it, not
  refused outright, so a computer on an IPv6-only network with DNS64 still
  reaches a receiver with only an IPv4 address. 64:ff9b:1::/48 and the old
  IPv4-compatible ::/96 are refused.
- **Two more columns.** `scanned_seq` (how far through the record a target
  looked) is kept apart from `watermark`, so a retrying event doesn't make
  every pass read everything after it again. `authorization_secret` names
  the secret store entry holding the Authorization value (null: none), so
  the snapshot never reads secrets.
- **A test send that gets through** counts as a send: it clears the
  receiver's refusals and the last problem.
- **The snapshot.** OutsideAgentSignIn's snapshot carries everything but the
  targets; the `outsideAgents.subscribe` route joins in AssistantAlerts'
  list. `AssistantEvents.current` gives the event's project name with it.
- **The RPC group split.** The outside agents' 16 RPCs (with the six new
  ones) are their own group, `WsOutsideAgentsRpcGroup`, merged into
  `WsRpcGroup` (clients don't change) and served by their own layer in
  `ws.ts`. The main group's handler types cost about the square of its size
  in type work, all in one statement, and TypeScript stops at 5 million
  instantiations per statement. Past that it doesn't report an error: the
  server layer's type silently became `any`, and only `bin.ts` failed to
  compile. With the split, about 12 more RPCs fit in the main group; 24 don't.
  The lasting fix is splitting it further by area (a follow-up).

Sol's review of the build (Oct 31), three findings, all fixed:

- **An edit could pair a new key with the old address.** The key was
  overwritten before the row saved the new address; a failure between the
  two would send the new key to the old receiver. Now every new value goes
  in a new entry and the row's one write switches address and entry
  together; the old entry goes after.
- **Waiting alerts ignored an edit.** A retry went out even after Edit
  dropped its kind or project. Each send now checks the target's current
  kinds and projects.
- **A stalled body lost the answer.** A 503 whose body never finished
  timed out as "may have arrived" and was never retried. An answer keeps its
  status once its headers come.
