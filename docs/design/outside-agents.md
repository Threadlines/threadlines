# Outside agents: agents running outside Threadlines use it

Rev 4, Oct 23 2026. Status: building on `feat/outside-agents` (off main after
Fleet #594). Follows event-tasks.md and closes the last T3 Code gap from the
Oct 19 review (their outside-agent sign-in, #16336).

Revision history:

- Rev 2 answered Sol's review of rev 1 (16 findings).
- Rev 3 answers his re-check of rev 2 (13 findings), mostly by taking
  machinery out:
  - no refresh tokens;
  - no queued sends;
  - the app's own first-send path instead of the child-thread path;
  - loopback only.
- Rev 4: Will said build it, with the `threadlines` command in the same
  release. New section "The `threadlines` command". The shared pieces are
  written:
  - `packages/contracts/src/outsideAgents.ts`;
  - the origin fields in `orchestration.ts`;
  - migration 087;
  - `apps/server/src/outsideAgents/OutsideAgentConnections.ts` and
    `connectTools.ts`.
    Builders work against them.

Both review lists are at the end.

## Why

A user runs Claude Code, Codex or Gemini CLI in a terminal, outside Threadlines.
They want that agent to hand work to Threadlines and follow it:

- start a thread in a project (with a worktree, the user's default agent and
  the user's setup script);
- see how threads are doing and read the replies;
- send a follow-up, or stop one.

Today the only way in from outside is an owner bearer token on the private HTTP
dispatch route, which skips worktree setup.

What others ship (research, Oct 23):

- **T3 Code:**
  - an MCP endpoint with OAuth sign-in (#16336, #16718);
  - a consent page unlocked with a pairing code, offering "Read only" or a mode
    ceiling;
  - 30-day tokens with no refresh;
  - a `t3 thread` CLI (#22732).
  - Their open bugs: a stale or hard-to-find URL, and tools listed to clients
    that can't call them.
- **Synara:**
  - a stdio bridge with a pairing code;
  - per-project scopes;
  - 2 active tasks;
  - a `requestId` on every start;
  - loopback only.
- **Paseo:** a CLI and SDK with an optional daemon password; no scopes.
- **Orca:** a CLI holding the owner token, with method permissions added after
  an escape from SSH hosts (#26337).

What we take, and where we go further:

- **From T3:** the standard MCP OAuth sign-in, so `claude mcp add` and
  `codex mcp login` just work, with a ceiling on the access of threads the
  agent starts.
- **From Synara:**
  - project scope;
  - a running cap;
  - idempotent starts;
  - loopback only.
- **Ours on top:**
  - **Approval in the app.** The user approves in the Threadlines window they
    already use, checking a short code that also shows in the browser. There's
    no pairing code to fetch and type.
  - **Visible threads and messages.**
    - The threads an outside agent starts are labelled with its name.
    - Its messages fold like other agents' messages.
    - The agent's name follows its messages everywhere, so they are never shown
      as "User".
  - **The fleet fence.** Those threads get no Threadlines agent tools, so the
    agent can't reach past its access through a thread it started.
  - **A live ceiling.** It is checked inside orchestration on every turn the
    agent starts, not only at the first. A thread the user raised above it is
    out of the agent's reach.
  - **Changeable access.** Change takes effect on the agent's next call.

Not in this plan (pitched at the end):

- a `threadlines` command for scripts;
- hosted agents (ChatGPT, claude.ai connectors);
- remote access (Tailscale);
- cross-computer starts.

## What the user does

1. **Settings → Connections → Agents** shows this computer's address for
   agents, `http://127.0.0.1:3773/mcp/connect`, with copy buttons:
   - **Claude Code:** `claude mcp add --transport http threadlines <url>`. It
     asks to sign in on first use (`/mcp`).
   - **Codex:** `codex mcp add threadlines --url <url>`, then
     `codex mcp login threadlines`.
   - **Gemini CLI:** `gemini mcp add --transport http threadlines <url>`. It
     signs in on first use (`/mcp auth threadlines`).
   - **Cursor:** an `mcp.json` snippet.
   - Signing in is interactive once. Later unattended runs (`claude -p`,
     `codex exec`) reuse the stored sign-in.
2. **The browser page.** Signing in opens the browser on a small Threadlines
   page: "Approve this agent in Threadlines. Check that Threadlines shows
   K4D-82P."
3. **The dialog.** Threadlines shows a dialog over whatever is open:
   - **Title:** "Claude Code wants to use Threadlines". Under it, in small
     text: "Name given by the agent." The code shows next to it.
   - **Same agent again:** if a connection from the same agent already exists,
     the dialog says it replaces it.
   - **What it can do:**
     - **See threads** (default): projects, agents, and every thread's status
       and messages.
     - **Start threads:** See threads, plus start threads and send to or stop
       the threads it started.
   - **Projects:** All, or picked ones.
   - **Highest access** for threads it starts: Supervised by default, up to
     Full access. Shown only with Start threads.
   - **Buttons:** Deny and Allow. With more than one request waiting, a line
     reads "2 more waiting" and adds a **Deny all** button.
   - **Notification:** when the window isn't focused, a system notification
     comes too, at most one every 30 seconds.
4. **Connected.** The browser page turns into "Connected. You can close this
   tab," and the agent carries on.
5. **Afterwards.** The Agents group lists each connection with its access and
   when it was last used.
   - **Change** opens the same dialog.
   - **Remove** cuts it off at its next call. A thread the agent started keeps
     its label.
   - **After Deny all,** the group shows "Not taking new agent requests (8
     min)" with **Take requests again**.

Approval waits 5 minutes. After that, or when the user denies, the browser page
says so and the agent gets `access_denied`.

Phones don't show the Agents group or the dialog. Approving, changing and
removing are access management, which is owner-only, as with the device list.

## Sign-in

The server is its own authorization server, like T3's.

**Spec status.** We follow the MCP authorization spec 2025-11-25, which still
holds for 2026-07-28 where they overlap. There are two intentional exceptions,
both named in the user guide:

- **Loopback http.** The spec asks for HTTPS on authorization-server endpoints.
  - Ours are loopback http.
  - Every client we target allows loopback; Claude Code documents it.
  - Nothing here leaves the computer: callbacks and the server are both on it.
- **One long-lived access token, no refresh token.** The spec says access
  tokens SHOULD be short-lived.
  - Ours is checked against its connection on every call, so Remove is
    immediate.
  - It expires after 90 days unused.
  - Why: rotating refresh tokens defend against a stolen token. A thief here
    must read the agent's own credential store on this computer, and anyone
    who can do that, as the same user, can already read the Threadlines data
    folder.
  - Rotation would add machinery (grace windows, race rules, replay alarms)
    with no protection in a local-only release.
  - Hosted agents (later) would bring refresh rotation with them.

**Transport.** The MCP transport is protocol 2025-06-18, the only version
Effect's McpServer speaks. Claude Code, Codex, Gemini CLI and Cursor negotiate
down to it.

### Endpoints (`apps/server/src/outsideAgents/oauthHttp.ts`)

`GET /.well-known/oauth-protected-resource/mcp/connect` (RFC 9728):

```json
{
  "resource": "<origin>/mcp/connect",
  "authorization_servers": ["<origin>"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["threads:read", "threads:start"]
}
```

`GET /.well-known/oauth-authorization-server` (RFC 8414):

```json
{
  "issuer": "<origin>",
  "authorization_endpoint": "<origin>/oauth/authorize",
  "token_endpoint": "<origin>/oauth/token",
  "registration_endpoint": "<origin>/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["threads:read", "threads:start"],
  "authorization_response_iss_parameter_supported": true
}
```

A test feeds both documents through the MCP TypeScript SDK client's discovery,
which Claude Code builds on.

`POST /oauth/register` (DCR) keeps no state:

- **The client id** is the signed client metadata:
  - `client_name` (trimmed, at most 60 characters);
  - up to 5 `redirect_uris`;
  - `software_id`;
  - a random registration id.
- **Same agent.** "The same agent" means the same registration. Clients keep
  theirs and sign in again with it (Claude Code, Codex and the `threadlines`
  command do), so a new approval replaces their old connection. A fresh
  registration is a new agent.
- **Redirects:** loopback only. `http://127.0.0.1`, `http://localhost` or
  `http://[::1]`. The port is ignored when matching: a registered loopback
  redirect matches any port at authorize time, so a kept registration works
  with a fresh listener (RFC 8252 §7.3). The path must match exactly.
- **Refused:** https callbacks, other hosts, userinfo, fragments.
- **No CIMD.** Clients fall back to DCR, and a CIMD document proves nothing for
  a client with a localhost redirect.

`GET /oauth/authorize` checks, in order:

1. **Host and Fetch Metadata.** Host must be on the allowlist (below).
   - When the browser sends `Sec-Fetch-Site`, it must be `none`: the agent or
     the OS opened the page, not another web page.
   - A link or script on a web page can't start a sign-in, whether the user
     clicked it or not.
   - Browsers that send no Fetch Metadata are let through, since they can't be
     told apart.
2. **The request.**
   - the client id's signature;
   - `redirect_uri` is on the client's list;
   - `state` is present;
   - an S256 `code_challenge`;
   - `resource` equals the canonical resource;
   - `scope` is within `scopes_supported`.
   - Before the redirect is validated, a failure shows an error on the page and
     never redirects. After it, every failure redirects with `error`,
     `error_description`, the original `state` and `iss`.
3. **Quiet period.** After Deny all, every new request gets a page saying
   Threadlines isn't taking new agent requests, for 10 minutes or until **Take
   requests again**. This is server-wide, so fresh registrations can't get
   around it.
4. **Limits.**
   - Registration: 20 a minute.
   - Authorization: 20 a minute.
   - Pending requests: one per (client id, redirect), where a new flow replaces
     the old, and 5 overall. A sixth gets "too many waiting".
5. **The pending connection request.** It lives in memory for 5 minutes and
   holds:
   - a 6-character code, shown in both places;
   - a poll secret for the page;
   - the scope the client asked for. The dialog can't grant more:
     `threads:read` alone means See threads only.

   The page served is a waiting page: self-contained HTML, no external loads,
   `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`.

`GET /oauth/authorize/status?request=…&poll=…`:

- The page polls it.
- **Approval:** returns the redirect, with `code`, `state` and `iss`.
- **Deny, expiry, quiet period or a restart:** returns `error=access_denied`,
  with `state` and `iss`.

`POST /oauth/token` (form-encoded), `authorization_code` only:

- **The code** lasts 60 seconds and works once.
- **Checks:**
  - the PKCE verifier;
  - `redirect_uri`;
  - `client_id`;
  - `resource`, which must equal the grant's when sent.
- **Approval saved.** It creates the connection row. If a connection with the
  same client id hash exists, it is replaced: removed, with its tokens dead.
- **Returns:**
  - `access_token`;
  - `token_type: "Bearer"`;
  - `scope`, which is the access granted (`threads:read`, or `threads:read
    threads:start`);
  - no `expires_in` and no refresh token.

### The token

- **Format:** `tlc1.<cid>.<gen>.<mac>`, where mac = HMAC(server signing key,
  `threadlines-connect-v1|cid|gen|resource`).
  - Nothing about the token is stored. The row holds `token_generation`.
  - The resource is inside the mac, so a token issued for `127.0.0.1` fails on
    `localhost`.
- **Checks on every `/mcp/connect` request:**
  - the mac, recomputed with the request's canonical resource;
  - the row exists and isn't removed;
  - `gen` equals `token_generation`;
  - the row was used within 90 days.
  - Then `last_used_at` is updated, at most once a minute.
  - A failure gets a 401 with
    `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/connect"`.
    The client signs in again.
- **Logging:** the token never appears in logs or traces.
  - Effect's HTTP layer redacts `authorization` by default
    (`Headers.CurrentRedactedNames`). `httpRequestPrivacy.ts` only handles
    paths.
  - A test pins the redaction for `/mcp/connect`.
  - Our middleware never logs the header.
- **Separation:**
  - These tokens aren't `auth_sessions` sessions, so no other route can parse
    them.
  - `/mcp/connect` accepts nothing else:
    - no cookie;
    - no owner bearer;
    - no MCP session-registry token;
    - no implicit dev-origin owner session (its middleware never calls
      ServerAuth).
  - This is the fleet `/peer` pattern: the allowlist holds by construction.

### Host and origin

- **On this computer only.** `outsideAgentOrigin` (OutsideAgentConnections.ts)
  requires all three of these:
  - **The socket's own address is loopback.** A network-exposed server
    (DesktopServerExposure) can't be reached from the LAN by sending
    `Host: 127.0.0.1`.
  - **No proxy header.** `Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP` and
    `Tailscale-User-*` are all refused. Tailscale Serve and reverse proxies
    connect from loopback on someone else's behalf.
  - **Host** is `127.0.0.1`, `localhost` or `[::1]` on the server's port. This
    blocks DNS rebinding.

  Anything else gets a 421 with a plain message. Approval promises the agent is
  on this computer.

- **Browser requests:** a request to `/mcp/connect` carrying `Origin` gets a 403. Effect's McpServer already does this, and a test pins it.
- **CORS:** `/oauth/*` and the well-known routes are taken out of
  `httpCors.ts`'s `*`.
- **Two names, two resources:** `localhost` and `127.0.0.1` give different
  resources, which is correct. The client uses the URL the user added, and
  Settings shows `127.0.0.1`.

## Storage (migration 087)

- **`outside_agent_connections`:**
  - `connection_id`, `client_id_hash`, `client_name`, `software_id`,
    `redirect_uri`, `resource`;
  - `access` (`see` | `start`), `max_runtime_mode`, `projects_json` (null
    means all);
  - `token_generation`;
  - `created_at`, `last_used_at`, `removed_at`, `removed_reason`.
- **`outside_agent_requests`** (start and send requests):
  - key `(connection_id, request_id)`;
  - `tool`, `input_hash`, `thread_id`, `command_id`, `result_json`,
    `created_at`;
  - kept for 24 hours.
- **Projection columns:** `projection_threads.outside_origin_json` and
  `projection_thread_messages.from_outside`.
  - These are new columns with no backfill. SQLite adds a column without
    rewriting rows.
  - Still timed against a copy of a real database before merging (the
    AGENTS.md rule).
- **In memory:** pending approval requests, authorization codes, the quiet
  period, and rate-limit counters.
  - A restart cancels pending requests and codes; the waiting page says
    "Threadlines restarted, try again".
  - A restart also ends the quiet period early, which is harmless.

## The MCP server (`/mcp/connect`)

- **Mounting:** a fifth `McpServer.layerHttp`, next to the four in server.ts.
  Same transport: POST and Streamable HTTP.
- **Middleware:** resolves the token to a **ConnectionCaller**:
  `{ connectionId, name }`.
- **Live permission.** Every tool handler reads the connection's live access,
  ceiling and projects on each call. Nothing is cached in the session.
- **Tool list.** `tools/list` is filtered by the live access each time it is
  asked, the way McpRoomServer filters room tools.
  - After a Change, a newly allowed tool shows the next time the agent lists
    tools, usually when it starts.
  - A removed one is refused at once, whether the agent lists again or not.
- **Refusals.** A refused call is an ordinary (successful) tool result whose
  `outcome` says why: for example `not_allowed`, with a plain reason such as
  "This connection can only see threads. The user can change that in
  Threadlines → Settings → Connections."
  - That matches the internal tools' house rule: every decision is an outcome,
    never an MCP error, so the structured result always decodes.
  - **Limits.** Every tool can answer `limit`, with `retryAfterSeconds` when
    known.
  - We don't use HTTP 403 `insufficient_scope`, which clients turn into a new
    sign-in prompt. A downgrade was the user's own choice.

| Tool                                                                              | `see` | `start` | Does                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`                                                                        | yes   | yes     | Projects in scope: id, name, folder.                                                                                                                                   |
| `agents`                                                                          | yes   | yes     | Ready agents and models (the `thread_agents` shape), and the user's default.                                                                                           |
| `threads_list {project?, status?, query?, mine?, limit?}`                         | yes   | yes     | Threads in scope, newest activity first. Status uses the internal tools' words: working, needs the user, waiting, failed, idle or wrapped. `query` uses thread search. |
| `thread_read {threadId, after?, limit?}`                                          | yes   | yes     | The title, project, status, agent and access, what the thread waits on (an approval, a question or a plan), and the messages after a cursor (the `thread_read` shape). |
| `thread_wait {threadId, seconds?}`                                                | yes   | yes     | Returns when the thread leaves `working`, or after `seconds` (default 45, at most 50, under client tool timeouts). Gives the status and the newest reply.              |
| `thread_start {project, prompt, title?, agent?, workspace?, access?, requestId?}` | no    | yes     | Starts a thread the way the app does (below). Returns `{ threadId, title, status }`.                                                                                   |
| `thread_send {threadId, message, requestId?}`                                     | no    | yes     | Sends to a thread this connection started that isn't running a turn (below).                                                                                           |
| `thread_stop {threadId}`                                                          | no    | yes     | Stops the running turn in a thread this connection started, the way the Stop button does.                                                                              |

**Scope:**

- Every tool sees only projects in `projects` (null means all).
- A thread outside scope reads as not found, never as not allowed.
- `thread_wait` checks scope again before it returns. A Change can happen while
  it waits.

**Sends: one turn at a time, never queued.**

- `thread_send` to a thread with a running turn returns `busy`. That includes a
  turn waiting on an approval, a question or a plan, and a setup still in
  progress.
- The agent waits (`thread_wait`) and sends again.
- **Why no queue.** Queued messages drain later, outside the handler. Each
  queued message would need its own ceiling rule and cap accounting, plus rules
  for stale settings (Sol, rev 2). Without a queue, every turn an outside agent
  starts goes through one handler and one decider check.

**The live ceiling.** Every turn the agent starts, from `thread_start` or
`thread_send`, carries `fromOutside { connectionId, name, maxRuntimeMode }` on
`thread.turn.start`.

- **Ceiling.** The decider refuses the turn with a distinguishable, typed
  refusal when the thread's current access is above `maxRuntimeMode`. The
  handler turns that into `not_allowed`: "This thread's access is above what
  Claude Code may use."
- **Busy.** The decider also refuses an outside turn while the thread has a
  turn running or about to start (a pending turn start, an approval, question
  or plan still waiting), or its setup is in progress. That refusal is also
  distinguishable, and the handler turns it into `busy`. A per-connection lock
  can't serialize against the user's own sends; the decider can.
- The decider is serialized, so a raise or a user's send can't slip between
  the check and the turn.
- **Build check.** The reactor must start the provider at the mode recorded on
  the turn-start event, not re-read the thread's.
  - Today the decider emits the thread's current mode (decider.ts:2450).
  - The build confirms the reactor uses the event's mode, or makes it, for
    every turn. Starting at the mode the turn was accepted with is correct for
    the user's own turns too.
  - A test races a raise against an outside turn start.
- **A raise during a turn.** If the user raises the thread's access while an
  outside-started turn runs, that applies as the user chose. It's their thread
  and their action.

**Limits per connection** (`apps/server/src/outsideAgents/limits.ts`):

- **Calls:** 120 a minute.
- **Running:** at most 4 of its threads at once. A thread counts while it has
  a running turn (including one waiting on the user) or a setup in progress.
  - The count is taken from live thread state, plus the starts and sends this
    connection has in flight, under a per-connection lock.
  - There are no reservations to release. Since sends never queue, every turn
    the connection causes passes this lock.
  - Over the cap, the call gets `limit`, with the running threads named.
- **Starts:** 50 a day.
- **Check-backs are not counted.** These are Claude's own wake-ups in a thread
  it started. They belong to the thread, run at the thread's own access, and
  show in the app like any check-back. A deliberate narrowing, also listed
  under Honest limits.
- **Retries.** `requestId` on start and send.
  - A newly claimed request row gets fresh random thread, message and
    command ids, stored on the row. A retry of a live row reuses them, so it is
    the same command, which the app's path joins in flight or answers from its
    receipt (see Starting). An id reused after its row was pruned (24 hours)
    gets new ids, so it can never overwrite an old message (Sol, tools
    review).
  - The same id with a different tool or input gets `conflict`, also while
    the first call is still in flight.
  - Without a `requestId`, the server makes one, so a client retry isn't
    deduplicated.

**Not in this release:**

- **Answering approvals, questions or plans in threads.** Under Supervised, the
  user approves in the app. An agent answering its own thread's approvals
  would defeat the ceiling. `thread_read` says what is waiting, so the agent
  can tell the user.
- **Sending to threads it didn't start.** That would be a third access level,
  later, under the same ceiling check.

## Threads an outside agent starts

**Starting:** `thread_start` builds the same command the composer sends for a
new thread, a `thread.turn.start` with a `bootstrap`, and runs it through
`ThreadBootstrap.runTurnStart`, as ws.ts does. That path:

- creates the thread;
- cuts the worktree when the workspace is a worktree;
- runs the setup script;
- starts the turn.

**What the handler supplies:**

- **Project:** from the call; it must be in scope.
- **Agent and model:** from the call, or the user's default.
- **Workspace:** from the call, or the project's default.
- **Access:** the lower of the request (or the user's default) and the ceiling.
- **On the command:**
  - `outsideOrigin { connectionId, name }` on `bootstrap.createThread`;
  - `fromOutside` on the turn start;
  - the ids stored on the request row.

**A restart in the middle.** `runTurnStart` is not resumable: only its final
turn start has a stable command id. If the server restarts after it made the
thread but before the turn started, the thread is left without its first turn,
as the app's own first send would be.

- The `outside_agent_requests` row says `starting` until the call answers.
- On startup, rows still `starting` become `failed`. A retry with the same
  `requestId` then answers `failed`, names the half-made thread and says to
  start again with a new `requestId`. It never re-runs the bootstrap: that would
  fail on the existing thread, or cut a second worktree.
- The half-made thread is visible in the app with the agent's label, so the
  user can see it and delete it.
- Making `runTurnStart` resume its stages (stable sub-command ids, recovering
  an existing worktree) would help the app's own first send too. That is a
  separate follow-up (Honest limits).

**Server-only fields.** `outsideOrigin` (on `ThreadBootstrapCreateThread` and
the thread shell) and `fromOutside` (on `thread.turn.start`) are server-only,
like `fromThread` and `composer` on the same command. The client's turn-start
schema has no such fields, and the Normalizer refuses them.

**Fence.**

- ProviderCommandReactor treats `outsideOrigin` like `remoteOrigin` when it
  attaches tools: no thread, room, schedule or invite tools.
- Browser, pages and "ask to run" follow the user's settings.
- Without the fence, a `see` or Supervised-capped connection could reach past
  its access through a thread's own tools: starting children, scheduling
  tasks, inviting agents.

**Who wrote a message.** `fromOutside` travels the whole path, like
`fromThread`:

- **Decider:** onto the message events.
- **Projector:** into `projection_thread_messages.from_outside`.
- **Provider context:** the agent sees the message labelled as coming from the
  outside agent, by name, the way `fromThread` requests are labelled.
- **Shared code:** `packages/shared/src/roomAgentRequests.ts` (origin
  classification) and `messageAuthor.ts`, so machine-readable history writes
  the agent's name, not "User".
- **The web:** the message folds like agent messages (agentMessageFolds),
  labelled with the name.
- **Moves and context seeds.**
  - `ThreadImportMessage.fromOutside` carries the attribution when a thread
    moves to another computer, for who wrote it only: the connection belongs to
    the computer it left.
  - Fork context and provider-handoff seeds (`packages/shared/src/contextSeed.ts`
    renders user-role messages as "User") use the same shared attribution
    rendering.
  - The thread's `outsideOrigin` is never copied onto a fork or an imported
    thread. Ownership is local; who wrote what is history.

No queued outside messages exist, so the follow-up queue needs no change.

**Labels.** The thread header, sidebar row and inbox row get a small origin
label with the agent's name, next to where scheduled runs show theirs.

**The user stays in charge.** The user can type in, stop or archive these
threads like any other. The connection keeps send and stop on them, under the
live ceiling, until it's removed.

## Code layout (no second copy of the thread tools)

`apps/server/src/mcp/threadToolHandlers.ts` mixes two kinds of code:

- **Rules for a thread caller:** session holder, own turn, family depth,
  per-message limits, parent-owned child requests.
- **The work:**
  - resolving agent and project;
  - list and read rendering;
  - send and stop dispatch;
  - thread status. Status combines shell state with scheduled-task waiting
    state (threadToolHandlers.ts:1401). Today it checks approvals before
    running state, and that order stays. It must also count an actionable
    proposed plan (the shell's `hasActionableProposedPlan`) as "needs the user"
    with `waitingOn: "plan"`. Today a finished planning turn reads `idle`.
  - Each summary carries the newest turn's id and how it ended (`lastTurn`).
    The status word says `idle` after a completed, a stopped or a failed turn
    alike.

Build step 1 moves the work into `apps/server/src/threads/threadOperations.ts`:

- **`threadStatus`** becomes one shared function.
- **A status subscription** watches every source that function reads: the shell
  stream and the scheduled-task waiting feed. It subscribes before it takes
  the snapshot, so no change can fall between the two. `thread_read`,
  `threads_list`, `thread_wait` and the running count all use it.
- **Who calls it:**
  - **ThreadCaller** (`threadToolHandlers.ts`): the internal tools, with their
    rules as today. Their tests pass unchanged after the move.
  - **ConnectionCaller** (`apps/server/src/outsideAgents/`): the rules in this
    plan.
- **Launching** differs by caller:
  - The internal tools keep `startChild` (child lineage, staged, resumable).
  - Outside starts use `runTurnStart`.
  - They share resolving the agent, model and workspace.

**Contracts:**

- **`packages/contracts/src/outsideAgents.ts`:**
  - the connection, the pending request and access;
  - the RPCs `outsideAgents.subscribe`, `approve`, `deny`, `denyAll`,
    `resumeRequests`, `update` and `remove`. All are owner-only in ws.ts.
- **Origin types:** `ThreadOutsideOrigin` and `MessageOutsideOrigin`, on the
  shell, the messages, the server turn-start command and
  `ThreadBootstrapCreateThread`.
- **Capability:** `outsideAgents` in the environment descriptor, so older
  clients don't show the group.

## Honest limits

- **What the access level protects against.**
  - It holds against an agent that can only use the MCP tools, and against a
    prompt-injected agent steered through them.
  - An agent with a shell on this computer, running as the same user, can read
    the Threadlines data folder directly. No local design changes that; T3's
    and Synara's don't either. The user guide says so.
- **Local processes** can start a sign-in. Fetch Metadata keeps web pages out.
  The limits, Deny all and its quiet period keep a noisy local process from
  burying the app; a determined one already has the data folder.
- **The address carries the port.** Desktop keeps 3773 unless something else
  holds it. Then Settings shows the new address, and the user adds it again.
- **Check-backs** are outside the running cap.
- **A restart during a start** leaves a thread without its first turn (see
  Starting). Making `runTurnStart` resumable would fix it for the app's own
  first send too. It's a follow-up, not in this build.
- **Phones** can't see, approve or remove connections.
- **One long-lived token per connection** (see Spec status).

## Hit every surface

- **Entry points:**
  - Settings → Connections → Agents (the address, commands, connections, quiet
    period);
  - the approval dialog over any view;
  - the system notification;
  - the command palette: "Connect an agent" opens the group.
- **Clients:** web and desktop share the group and the dialog. The phone shows
  neither (owner-only).
- **Providers:** nothing per driver. Outside agents are clients. The fence and
  the message labelling go through the reactor and the shared provider-context
  rendering every driver uses.
- **Contracts:** listed above.
- **Reverse states:**
  - deny, Deny all (with its way back, Take requests again) and expiry;
  - Remove (next call);
  - Change (next call; the tool list on the next listing);
  - a replaced connection;
  - 90 days unused (the agent signs in again);
  - stop;
  - a restart during sign-in or during a start.
- **Telemetry:** `outside_agent_connected { client_name, access }` and a daily
  count of tool calls by tool and outcome. No thread content.
- **Docs:** `docs/outside-agents.md`, the user guide: commands per client,
  access, limits, honest limits and the two spec exceptions. This file is the
  design.

## Build order (`feat/outside-agents`, off main; a PR when Will asks)

1. **Done (rev 4):** contracts, the Normalizer refusal, migration 087, the
   connection service contract and the tool schemas, plus placeholder RPC
   handlers so the base typechecks.
2. **In parallel, each in its own worktree:**
   - **Server sign-in:** OAuth, connections and the `outsideAgents.*` RPCs.
   - **Server tools:** shared thread operations and status, `/mcp/connect`,
     and the orchestration pieces.
   - **Web.**
   - **Then the `threadlines` command and desktop install,** once the first
     wave is merged.
3. **Server:**
   - migration 087;
   - the OAuth endpoints and waiting page (Fetch Metadata, limits, quiet
     period);
   - the connection store and token;
   - the `/mcp/connect` middleware and tools;
   - the outside fields through the Normalizer, decider (ceiling), projector,
     provider context and shared classifiers;
   - the reactor's turn mode (build check above);
   - the fence.
4. **Web:**
   - the Agents group and the approval dialog (Deny all, quiet period) and
     notification;
   - origin labels and the message fold;
   - the command palette entry.
5. **Live test** on a throwaway home:
   - **Claude Code** with the real sign-in (it has to run a model; never
     under a kill timeout, per AGENTS.md).
     - The MCP server is added at project scope in a temp folder, so Will's
       user config isn't touched.
     - Sign in with `claude mcp login`, then a `claude -p` prompt that lists,
       starts, waits, reads, sends and stops.
     - Afterwards the test signs out and the folder is deleted.
   - **Codex:** `codex mcp add` and `login`, then `codex exec`.
   - **Access:** Change from start to see and back; Remove mid-session; a send
     after the user raised the thread.
   - **Sign-in:** a second sign-in from the same agent replaces the first; a
     link to the authorize URL clicked on a web page is refused.
   - **Restarts:** a restart mid-start, then a retry with the same
     `requestId`.
   - **Gemini CLI**, if it's installed.
6. **Reviews:** Sol on the server diff, then on web and server together. Then
   the gates and the browser suite.

## Tests (focused)

- **OAuth:**
  - Discovery documents read by the MCP SDK client.
  - Refusals: a PKCE mismatch; a reused or expired code; a mismatched
    `resource` or redirect; a non-loopback redirect at registration; a Host
    off the allowlist; `Sec-Fetch-Site: cross-site` on authorize.
  - Error redirects carry `state` and `iss`.
  - The pending cap and the quiet period, including across fresh client ids.
  - Requested scope `threads:read` can't be granted Start.
- **Token:**
  - a token for `127.0.0.1` fails on `localhost`;
  - a bumped generation, a removed row, and 90 days unused all get 401;
  - a replacing approval kills the old token.
- **`/mcp/connect` refusals:** a cookie, an owner bearer, an MCP registry
  token, and a dev-origin request without a token.
- **Access:**
  - `see` lists no start tools, and a direct `thread_start` from `see` is
    refused;
  - a thread outside scope reads as not found;
  - a send to a thread it didn't start is refused;
  - start access is capped;
  - the decider refuses an outside turn on a thread above the ceiling;
  - a raise racing an outside turn start;
  - `busy` on a running thread and on one waiting for approval;
  - the running cap under concurrent starts;
  - `requestId` replay and conflict.
- **Fence:** an `outsideOrigin` thread gets no room or thread tools. A reactor
  test, next to the `remoteOrigin` one.
- **Attribution:** history and provider context name the agent.
- **Browser:**
  - the approval dialog: Allow with Start threads and picked projects; Deny;
    Deny all, then Take requests again;
  - the Agents group: Remove and Change.

## The `threadlines` command (Will, Oct 23: same release)

**What it is.** A command for scripts, and for agents that run shell commands
but don't speak MCP. It is one more outside agent:

- an OAuth client of `/mcp/connect`, calling the same tools under the same
  rules;
- shown in the Agents group as "Threadlines command";
- approved in the same dialog.

Nothing on the server is special for it. It never writes a session into the
database, which T3's `t3 thread` does.

It lives in `apps/server/src/cli/` (registered in bin.ts beside `auth` and
`project`) and reuses the connectTools.ts schemas to decode results.

**Commands:**

- `threadlines connect [--no-browser]`: signs in.
  1. Registers with DCR as "Threadlines command" (`software_id`
     `threadlines-cli`).
  2. Listens on a random loopback port.
  3. Opens the browser on the authorize URL (or prints it).
  4. Waits up to 5 minutes.
  5. Stores the token and prints what it was allowed.
- `threadlines disconnect`: forgets the token on this computer. It points to
  Settings → Connections → Agents to remove the connection itself.
- `threadlines projects`, `threadlines agents`.
- `threadlines thread list [--project <p>] [--status <s>] [--mine]`.
- `threadlines thread start <project> [<prompt> | -] [--title] [--agent <instance>[/<model>]] [--local] [--access <mode>] [--request-id <id>] [--wait]`.
  - The prompt comes from stdin when it's `-`, or when it's left out and stdin
    is piped.
- `threadlines thread send <id> [<message> | -] [--request-id <id>] [--wait]`.
- `threadlines thread read <id> [--after <n>] [--limit <n>]`.
- `threadlines thread wait <id> [--timeout <seconds>]`: calls `thread_wait`
  again and again until the thread is done, or the timeout runs out. With no
  timeout it never gives up.
- `threadlines thread stop <id>`.
- Every command takes `--json`, which prints the tool's result as is.
  Otherwise it prints short plain text: the status, then the newest reply when
  it waited.

**Exit codes** (the same for `--wait` and `thread wait`):

| Code | Meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 0    | Done: the call worked, or the thread's newest turn `completed` (status idle, waiting or wrapped).             |
| 1    | The thread's newest turn was `interrupted` or ended in `error`, its status is `failed`, or the call `failed`. |
| 2    | The thread needs the user: an approval, a question or a plan.                                                 |
| 3    | `--timeout` ran out.                                                                                          |
| 4    | Refused: `not_allowed`, `not_found`, `not_yours`, `limit`, `busy`, `conflict` or `unavailable_agent`.         |
| 5    | Not connected (run `threadlines connect`), or Threadlines isn't running.                                      |

**Finding Threadlines.**

- It reads `<THREADLINES_HOME or ~/.threadlines>/userdata/server-runtime.json`
  (`--dev` reads `dev`) and talks to `http://127.0.0.1:<port>`.
- When the file is missing or the port doesn't answer, it says "Threadlines
  isn't running. Open it and try again." and exits with 5.

**The token.**

- It is kept in `<home>/userdata/cli/connections.json`: folder 0700, file
  0600, one entry per resource (`client_id`, `access_token`).
- It is never printed.
- A 401 deletes the entry and exits with 5: "Run threadlines connect".
- A port change gives a different resource, so the command asks to connect
  again (see Honest limits).

**The MCP client.** It needs no new dependency: plain JSON-RPC over HTTP POST
to `/mcp/connect`, about 150 lines.

- `initialize` with protocol 2025-06-18, then `notifications/initialized`,
  then `tools/call`.
- It keeps the `mcp-session-id`, accepts a JSON or an SSE response, and
  decodes `structuredContent` with the connectTools.ts schemas.
- A 404 on the session means it initializes again once.

**Putting it on PATH (desktop).** The Agents group gets a "Threadlines command"
row with three states:

- "Not installed", with Install;
- "Installed at /usr/local/bin/threadlines", with Remove;
- "Points at another copy of Threadlines", with Install again.

The desktop does the work in `apps/desktop/src/cliCommand/`, exposed to the web
through the desktop bridge:

- **macOS:** a small script at `/usr/local/bin/threadlines`, written through the
  system's administrator prompt (`osascript … with administrator privileges`),
  as VS Code's "Install 'code' command" does. Cancel changes nothing. Remove
  asks again.
- **Windows:** `threadlines.cmd` in `%LOCALAPPDATA%\Threadlines\bin`, with that
  folder added to the user PATH (no admin). New terminals see it.
- **Linux:** `~/.local/bin/threadlines`. When that folder isn't on PATH, the row
  says so.
  - **AppImage builds** run from a temporary mount that changes every launch,
    so the script can't hold paths inside it. Instead it runs the persistent
    `$APPIMAGE` file with an environment variable the app's main process checks
    first, which then runs the command from wherever it is mounted.
  - This is tested across a quit and relaunch. If that can't be made reliable,
    the row says Install isn't available for the AppImage.
- **The script** runs the app's own runtime: `ELECTRON_RUN_AS_NODE=1` with the
  app executable and the app's `apps/server/dist/bin.mjs`.
  - The paths are written in at install time, plus the app's
    `THREADLINES_HOME` when it has a non-default one.
  - It also sets `THREADLINES_CLI_ONLY=1`, which makes bin.ts refuse to start a
    server. A bare `threadlines` would otherwise start a second server on the
    desktop's own data folder.
- **Dev builds** offer no Install; the row says how to run it from the repo.
- **npm installs** already have `threadlines` on PATH (the package's `bin`).

**Tests:**

- argument parsing and exit codes;
- the MCP client against a test server: initialize, call, session 404, 401;
- the install script written into a temp folder (the target folder is a
  parameter; the admin prompt is the only piece not run in tests);
- `THREADLINES_CLI_ONLY` refusing `start` and `serve`.

**Live test:**

- `connect` on a throwaway home, approved in the app;
- `thread start --wait` with the stand-in agent;
- `send`, `read`, `stop`;
- Remove in the app, after which the next call exits with 5;
- the desktop Install into a temp folder in a dev run.

## Later (pitch)

- **Hosted agents and remote access** (ChatGPT, claude.ai connectors, Tailscale
  Serve):
  - These need https callbacks, a public or tailnet https address, the
    callback's full origin in the dialog, and refresh rotation.
  - The relay can't carry MCP over HTTP today; Tailscale Funnel can.
- **Cross-computer starts:** a fleet peer request needs a parent thread on this
  computer, and an outside caller has none.
- **A third access level**, "work with all threads", under the live ceiling.
- **Queued sends**, if agents ask for them. Each queued message would carry
  its ceiling, and be re-checked and counted when it drains.

## Rev 4: Sol's review of the shared pieces, and what changed

14 findings. Each was taken; fixes are in the code or in this plan as noted.

1. **Host alone didn't prove locality.** `outsideAgentOrigin` now also needs a
   loopback socket address and no proxy header, with a test.
2. **`runTurnStart` dropped `outsideOrigin`.** It's forwarded now
   (ThreadBootstrap.ts).
3. **`runTurnStart` can't resume a start cut off by a restart.**
   - The plan no longer promises it.
   - A `starting` row turns `failed` on startup, a retry answers `failed`, and
     the half-made thread stays visible.
   - Resumable bootstrap is a follow-up.
4. **"Busy" needed the decider.** The decider refuses an outside turn while the
   thread is busy, with a distinguishable refusal.
5. **The wait couldn't tell finished from stopped.** Summaries now carry
   `lastTurn`, and the exit codes map every status.
6. **Actionable plans read `idle`.** The shared status counts them as needing
   the user.
7. **Reconnecting made a new agent.** Same agent now means same registration.
   The command keeps its registration, and a loopback redirect matches any
   port.
8. **AppImage paths are temporary.** The script runs the persistent
   `$APPIMAGE`, or Install says it isn't available.
9. **Attribution was lost through moves and context seeds.**
   - `ThreadImportMessage.fromOutside` was added.
   - Context seeds use the shared rendering.
   - `outsideOrigin` is never copied onto forks or imports.
10. **No limit answer on most tools.** Every result has `limit` and
    `retryAfterSeconds`.
11. **The plan said "tool error" while the schemas use outcomes.** Outcomes in
    successful results, everywhere.
12. **The placeholder RPCs had no owner guard.** `requireOwner` is in front of
    each now.
13. **The column name differed between the plan and the migration.** It's
    `from_outside` in both.
14. **The agent parameter pointed to `thread_agents`.** It's now
    `agentParameter("agents")` for outside tools.

## Rev 3: Sol's re-check of rev 2, and what changed

1. **Idle-send ceiling race:** the explicit mode wasn't honored at turn start.
   - The ceiling now lives in the decider, on `fromOutside.maxRuntimeMode`, so
     it is checked serialized.
   - Build check: the reactor uses the event's mode.
   - A race test.
2. **Queue drain dropped the pinned mode, or restored stale settings.** No
   queued outside sends: `busy` instead.
3. **The grace window let a thief share the refresh chain.** No refresh tokens
   (see Spec status).
4. **Narrowed scope had no enforcement.** No refresh, so no narrowing. The
   requested scope caps what the dialog can grant; the live connection row is
   the one authority.
5. **Startup recovery skipped the live grant check.** No resume: outside starts
   use the app's `runTurnStart` path, and a retry goes through the handler's
   live checks.
6. **Outside lineage had no setup gate.** No outside lineage. The app's first
   send path owns setup, and the agent gets `busy` while setup runs.
7. **Slot release broke the cap.** No reservations. The count comes from live
   state (a waiting-on-user turn counts), and with no queue every outside turn
   passes the lock.
8. **A 404 doesn't make clients re-list tools.** The 404 trick is dropped.
   `tools/list` is filtered live, every call is checked live, and a newly
   allowed tool shows on the next listing (said so).
9. **Tailscale broke "on this computer".** Loopback Host only. Serve and
   exposed binds are refused this release.
10. **Legit refresh interleavings could remove the connection.** No refresh
    tokens.
11. **Setup stage not replayable.** Not used by outside starts (`startChild`
    is no longer on this path). The issue sits in `startChild`'s
    scheduled-run and link-request path; noted for a separate fix.
12. **The request journal couldn't rebuild recovery work.** No recovery
    journal. The request row is now idempotency only: derived command ids and
    the result.
13. **The cooldown was bypassable, and the destination check didn't prove
    intent.**
    - Deny all starts a server-wide quiet period.
    - Authorize requires `Sec-Fetch-Site: none` when present, so web pages
      can't start a sign-in at all.

## Rev 2: Sol's findings on rev 1, and what changed (several superseded by rev 3)

1. **Metadata field names were wrong.** Fixed: the exact discovery JSON is
   given, with a client-discovery test.
2. **Hidden tools are not enforcement.** Fixed: every call is checked live; a
   refusal is a tool error, and the reason for not using 403 is given.
3. **The ceiling only held at start.** Fixed: the live ceiling on every send,
   an explicit pinned mode, and queued follow-ups keep it.
4. **Refresh grace had no algorithm.** Fixed: an authenticated envelope,
   compare-and-set rotation, a recomputed successor within the grace, and
   restart-safe.
5. **Start recovery and lineage were missing.** Fixed: an `outside` lineage in
   ThreadBootstrap, derived ids, a persisted launch, and resume on startup.
6. **Flooding the approval.** Fixed: ingress limits, the `Sec-Fetch-Dest`
   check, one pending per flow, a cooldown, Deny all, and a notification
   throttle.
7. **Grant bindings weren't stored.** Fixed: client id hash, redirect,
   resource and scope stored and checked on refresh; scope can only narrow.
8. **The running cap could be bypassed.** Fixed: atomic reservations for
   starts and sends to idle threads. Check-backs are excluded on purpose, and
   said so.
9. **Attribution stopped at the timeline.** Fixed: `fromOutside` goes through
   commands, queue, events, projection, provider context and shared
   classifiers.
10. **The detail stream isn't the whole status.** Fixed: a shared
    `threadStatus` and subscription over every source, subscribing before the
    snapshot.
11. **Change couldn't update the catalog.** Fixed: version-stamped sessions
    get a 404, so clients re-initialize. Verified live per client.
12. **Errors lacked `state` and `iss`.** Fixed.
13. **The phone promise contradicted owner-only RPCs.** Fixed: the phone shows
    nothing.
14. **Self-reported names were presented as identity.** Fixed: the dialog says
    the name comes from the agent, and callbacks are loopback-only this
    release.
15. **Codex needs `codex mcp login`.** Fixed in Settings and the guide.
16. **"Compliant" was overstated.** Fixed: the loopback-http exception is named
    as intentional.
