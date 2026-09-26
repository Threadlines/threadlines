# Rooms, slice 2: agents talk to each other, and answer while another works

Builds on slice 1 (`docs/design/rooms-slice-1.md`) and the queue fix in PR #322.
Revision 3. Revision 2 followed the design review in
`/tmp/rooms-slice-2-review.md` (nine findings, all accepted; the biggest moved
side answers into their own runtime). Revision 3 follows the second review in
`/tmp/rooms-slice-2-review-2.md` (five resolved, four partly; seven new
findings, all accepted).

Two user-facing capabilities:

1. **Ask while another agent works** (the talking lane). While agent A holds the
   thread and runs a turn, the user can ask agent B something. B answers right
   away, read-only, and its answer shows in the chat. A is not disturbed.
2. **Agents message each other.** An agent can ask another agent a quick
   question and get the answer inside its own turn, hand the floor to another
   agent and get the reply back, or read older room messages.

Side answers come first, because an agent's quick question (`room_ask`) runs
on them.

## Principles

- One agent edits at a time. A side answer runs in its own locked-down
  runtime and never prompts for approval, so it cannot collide with A's edits,
  A's prompts, or A's runtime.
- Everything agents say to each other is visible in the chat.
- The user stays in charge:
  - Stop ends a chain for good.
  - The user's messages go ahead of agent requests, including ones that
    arrive later.
  - Agents get 3 requests of each other before they have to wait for the user.
- Identity is explicit. Every side answer and every agent request has a stable
  id that travels with its events. Nothing is matched by "the next event from
  that agent" or "whoever holds the slot now".

## Part A: side answers

### Where a side answer runs (the key design change)

A side answer does **not** run in B's normal runtime. It runs in a
short-lived **side runtime**.

**A distinct kind of session**

- **Key**: `<threadId>__side__<sideTurnId>__<participantId|primary>`.
- **Parsing**: `packages/shared/src/threadParticipants.ts` returns a
  discriminated target, `{ kind: "main", threadId, participantId }` or
  `{ kind: "side", threadId, participantId, sideTurnId }`. `ProviderService`
  stamps events with the thread, the participant and `sideTurnId`, so lane and
  identity come from the key, whatever order consumers process it in.
- **Audited consumers**: every consumer that today reads "same thread and
  participant" as "that agent's working session" is audited for the kind:
  - the session directory and its bindings;
  - the reaper (startup reconcile and idle sweep);
  - room stop, thread delete, and recovery;
  - runtime lookup, and subagent routing.
- **Rules**:
  - A side binding never owns the main session projection.
  - A side binding is never recovered or resumed after it settles.
  - Side bindings are pruned once settled.

**Conversation: a real fork of B, or an honest seed**

- **Codex**: B's rollout file is copied into the side runtime's own home and
  resumed there. Resuming a copy is a fork that cannot touch B's original.
  - The boundary is B's last completed turn; no in-flight automatic output is
    copied.
  - This works only within the same provider instance.
- **Claude**: this is **new adapter work**. `forkFrom` is not implemented in
  the Claude adapter today; `forkSession` is only used to relocate a resume out
  of a worktree. It will be built on the SDK's fork-on-resume:
  - an explicit, unique destination session id;
  - B's last completed turn as the boundary;
  - the existing relocation when B's transcript lives under another checkout.
- **Tests**: the destination id differs from B's, it carries B's history, and
  nothing is ever appended to, relocated from, or deleted in B's transcript.
- **No native history**: if B has never run, or its provider changed, the side
  runtime starts from a transcript seed. That is labelled as such, and is
  never a plain resume of B.

**Checkout**: always the thread's current checkout, so B reads the same files
A is working on. B's own runtime may be parked elsewhere; it does not matter.

**Locked down by construction**, rather than by hiding tools on a runtime that
loaded everything:

- **Codex**: the side runtime gets its **own temporary home**, containing:
  - **no copied login.** ChatGPT sign-in uses Codex's external-auth mode:
    - Threadlines calls `account/login/start` with `chatgptAuthTokens`, read
      from the main Codex home, which it never writes.
    - Codex never refreshes tokens itself in that mode. It asks with
      `account/chatgptAuthTokens/refresh`, and Threadlines answers by
      re-reading the main home, after asking a main runtime to refresh if
      needed.

    So a side runtime can never rotate or invalidate the user's real login.
    An API-key login is passed through the environment. If neither is
    possible, the side answer is refused visibly.

  - a generated minimal config: the Threadlines room server as the only MCP
    server, no plugins, no hooks, apps off, `request_user_input` off;
  - sandbox `read-only` and approval `never`, applied at spawn and on every
    resume and turn call. Nothing reapplies the agent's normal runtime mode.

  The checkout's own project config must not load (it is untrusted in that
  home; to be verified). If the profile cannot be established on the
  installed Codex version, the side answer is refused visibly. It never falls
  back to a normal session.

- **Claude**:
  - `settingSources: []`, so no user or project settings, hooks, plugins, or
    MCP servers from settings.
  - `strictMcpConfig: true`. Without it, the account's claude.ai connectors
    (Docs, Supabase, Vercel) connect mid-turn, whatever the settings sources
    say (seen in the spike).
  - Built-in `tools: [Read, Grep, Glob, WebFetch, WebSearch]`.
  - The room server's exact read tools (`room_history`, `room_diff`).
  - A `PreToolUse` hook that allows exactly that set and denies everything
    else, including unknown tools.
  - `canUseTool` denies instead of prompting.
- **No questions**: any unexpected question or approval request is denied
  immediately, and it can never reach the user.
- **ACP drivers** (Cursor, fx) and OpenCode: side answers are refused.

**Life**: settles on any terminal outcome (below).

- **Cleanup, unconditional and retried if it fails**: the runtime is stopped,
  its credential revoked, and its temporary home or fork transcript deleted.
- **Late events** from its key are dropped. They never rewrite a settled
  answer.
- **Stays locked** until the runtime is gone, so a late tool call cannot gain
  write access.

### Data model

- `thread.sideTurn: { sideTurnId, participantId, messageId, askedBy, requestId | null, status: starting | running | cancelling, providerInstanceId, startedAt } | null`.
  - At most one per thread.
  - `askedBy` is `"user"` or an agent key.
  - `requestId` links to an agent request (Part B).
  - Stored as a JSON column on `projection_threads`.
- `sideTurnId?` on `OrchestrationMessage` and `OrchestrationThreadActivity`.
  Side messages and activities carry `turnId: null` plus this id, so they never
  touch main turn rows, `latestTurn`, or main-turn grouping. Activities also
  gain `participantId`.
- **Outcomes**: `thread.side-turn-settled { sideTurnId, outcome: completed | failed | interrupted, answerMessageId?, error? }`.
  - Kept as events, and also in `projection_side_turns` (id, thread,
    participant, outcome, answer message, times), so a waiter or a restart can
    read the result.
  - Migration 059 adds the column and the table.

### Commands

`start` and `interrupt` are client commands. `mark-running` and `settle` are
server-only; the client orchestration schema will not accept them.

- `thread.side-turn.start { threadId, sideTurnId, message, participantId }` → `message-sent` (with
  `sideTurnId`) + `side-turn-started`.
  - Rejected unless:
    - the thread is a room;
    - B is present, does not hold the slot, and is not working;
    - no side answer is running;
    - B's driver supports side answers;
    - voice is off.
- `thread.side-turn.interrupt { threadId, sideTurnId }` (client-accessible, for
  Stop): a stale id is a no-op.
  If the runtime has no turn yet, the side turn goes to `cancelling` and the
  dispatch is stopped the moment it binds.
- `thread.side-turn.mark-running { sideTurnId }` and
  `thread.side-turn.settle { sideTurnId, ... }`: idempotent, and no-ops for an
  id that is not the active one.
- Decider rules elsewhere:
  - Handover to B, removing B, and changing B's model are refused while B is
    answering.
  - A message queued for B waits, and the reactor retries it when the side
    turn settles.

### Lifecycle (every way out of the side slot)

| From                 | Event                                             | To                                               |
| -------------------- | ------------------------------------------------- | ------------------------------------------------ |
| starting             | side runtime started, turn sent                   | running                                          |
| starting             | start fails, or no turn after 60s                 | settled: failed                                  |
| starting / running   | user or asking agent stops it                     | cancelling                                       |
| running / cancelling | `turn.completed`                                  | settled: completed, or interrupted if cancelling |
| running / cancelling | `turn.aborted`, `runtime.error`, `session.exited` | settled: interrupted or failed                   |
| cancelling           | interrupt not confirmed in 10s                    | runtime stopped; settled: interrupted            |
| any                  | thread session stop                               | runtime stopped; settled: interrupted            |
| any                  | server restart                                    | settled: interrupted (on startup)                |

Terminal events (`turn.completed`, `turn.aborted`, `session.exited`) can
arrive while the record is still `starting`, because Claude emits its start
before `sendTurn` returns. They settle it there too. The outcome comes from
the completion payload's state, not the event name.

Two rules for settling:

- **Flush first.** The answer message is finalized and persisted before
  `settled` is emitted, and `answerMessageId` names that exact message. It is
  never "the thread's latest assistant message".
- **Clean up only the side runtime's state.** Nothing is cleared across the
  thread's key prefix.

### Ingestion

Events whose key is a side key go to a side handler, keyed by `sideTurnId`:

- **Content and assistant messages**: `assistant.delta` / `complete` with
  `participantId` B, `turnId: null`, `sideTurnId`.
- **Items**: activities with `sideTurnId` and `participantId`.
- **Terminal events**: finalize the answer message, then settle.
- **Ignored**: session status, `thread.started`, task counts, diffs and
  file-change evidence, goals, cwd and metadata.
- **Stale**: events for a side turn that is not the active one only finish
  that turn's own message buffer; otherwise they are dropped.

Events from a non-holder's normal key keep today's rule: drop them, and
interrupt a self-started turn exactly.

### Checkpoints: ingestion decides, once

Ingestion is the single admission authority. Every provider `turn.started`
gets admitted, once, as one of:

- **main**: from the slot holder's key, including legitimate automatic turns
  such as a background agent waking the holder;
- **side**: from a side key;
- **rejected**: a self-started turn from a non-holder, which is interrupted.

Decisions go to a shared in-memory turn-admission registry, keyed by session
key and provider turn.

- **Raw provider stream**: the checkpoint reactor waits a bounded time for the
  admission decision for a turn, then acts only on `main`. It never
  re-derives the lane from who holds the slot when it gets there. So a main
  turn's late completion after a handover still checkpoints. Side turns and a
  non-holder's self-woken turn never do; that fixes a latent slice-1 bug.
- **Domain stream**: user messages with `sideTurnId` never create or retake a
  baseline.

Tests:

- A holder woken by background work does real work, then hands off before its
  completion is checkpointed.
- An idle non-holder's self-wake is rejected.

### Catch-up note: a delivered-context cursor, per conversation

Today the cursor is inferred from message order and ownership. That misses a
side answer that landed before a steer, and it cannot tell a message that was
only partly streamed.

**The cursor belongs to a durable conversation, not to the agent's name.**

- **Stored as**:
  `roomContext: { [agentKey]: { conversationId, throughSequence, partialMessageIds } }`.
  `conversationId` is the main runtime's continuation identity: its native
  thread or session id.
- **Committed** (`thread.room-context-delivered`) only after a main turn
  carrying that note was accepted by the provider.
- **Reset to "just joined"** when the conversation is replaced, for example
  after a fresh start once resume failed, or a provider change.
- **Side forks read, never write.** A side fork reads the main cursor to build
  its note and never advances it. What a fork saw is thrown away with it.
- **What goes in a main note**: every room message after `throughSequence`
  that is not already in that conversation. The agent's own main-lane turns
  and steers are in it; side answers, including its own, are not. Messages in
  `partialMessageIds` come again with their final text.
- **Steers**: they don't carry a note, so they don't move the cursor. A side
  answer before a steer is still delivered at the next turn.
- **Repeats beat losses.** An answer already returned by `room_ask` may be
  repeated in the next note, labelled "you already received this", rather
  than risk hiding one whose tool result was lost.
- **Labels**: every entry carries author, addressee and origin (user, or an
  agent asking on the user's behalf). An agent's request is never presented
  as the user speaking.
- **Clipping**: clipped text points to `room_history` by message id.

## Part B: agents message each other (room tools)

### Plumbing

- **Room MCP server**: a second server, `threadlines_room` at `/mcp/room`,
  attached only to room sessions and to side runtimes. Its read tools
  (`room_history`, and `room_diff`: fixed git commands, bounded output) ship in
  PR 1, because side answers need them.
  - Claude main runtimes get it live with `setMcpServers`, passing the
    existing browser and internal servers too, since the call replaces the set.
  - Codex reads MCP servers at spawn, so a runtime that predates the room is
    restarted, with resume, at its next turn. That's once per agent, and never
    while it has a turn or background work to protect.
- **Codex timeout**: this server's `tool_timeout_sec` is raised (Codex
  defaults to 60s).
- **Credentials**: the registry keeps the caller's participant and runtime
  generation. Revocation is scoped to that generation, so a late shutdown of
  an old runtime cannot revoke its replacement's credentials. Credentials are
  revoked when their session stops.
- **Authorization is per tool.**
  - Read tools: any live main credential, or a live side credential (minus
    `room_history` for fresh eyes).
  - `room_ask` and `room_hand_off`: only the slot holder, only from the turn
    that made the call.
- **Knowing which turn made a call.** An HTTP MCP call carries no turn, and
  "the runtime's current turn" is not proof of it. So:
  - Every turn the server sends a room agent carries a **turn key**, a random
    token on one line of its note. The key is invalidated when that turn ends.
  - `room_ask` and `room_hand_off` require it.
  - A call made in T1 that arrives during T2 carries T1's dead key, and is
    refused.
  - Turns the agent starts by itself carry no key, so they cannot hand off.
- **Deduplication** is separate from authorization. `(turn key, tool,
argument hash)` identifies a call, so a replay after reconnect maps to the
  same request, and two different calls in one turn stay distinct.

### Agent requests (durable)

- **Record**: `projection_room_requests` (id, thread, kind `ask | hand_off`,
  from, to, caller turn id, request message, side turn or target turn, status
  `pending | running | answered | failed | cancelled`, reply message,
  timestamps).
- **Events**: `thread.room-request-*`.
- **Ids**:
  - The request id comes from the dedupe key above.
  - The reply message id is derived from the request id, so a replay after a
    restart never sends a duplicate.

### Tools

Tool inputs take a participant id or an unambiguous name. Results always give
ids.

- `room_agents()`: who is here, their model, and who is working or answering.
- `room_ask({ agent, question })`:
  - Only the holder, during its turn.
  - Creates an `ask` request and a side answer for the target, with `askedBy`
    set to the caller.
  - Waits in the MCP request fiber, never in the reactor's worker, with a
    Threadlines deadline of 10 minutes (under the provider tool timeout).
  - Returns `{ outcome: completed | failed | interrupted | busy | limit, answer (bounded), answerMessageId }`.
  - `busy` if a side answer is already running; it does not queue.
  - If the caller's turn stops, the deadline passes, or the connection drops,
    it cancels that exact side answer.
  - The answer is marked delivered to the caller.
- `room_hand_off({ agent, message })`:
  - Only the holder.
  - Creates a `hand_off` request and queues a working turn for the target that
    carries the request id.
  - User messages always go first, including ones queued later.
  - The tool tells the caller to end its turn.
  - When the target turn for that request completes, its final reply is routed
    back to the caller as a queued agent message. Matching is by request id,
    not "the target's next completion".
  - Failure, removal of the target, a model change, or a restart settles the
    request as failed or cancelled, with a visible note.
- `room_history({ before?, limit ≤ 20, query? })`:
  - Earlier room messages with author, addressee and origin labels, side
    exchanges included.
  - Stable ordering, and a cursor built from the event sequence.
  - Output is capped; attachments are listed as metadata only.
  - Allowed in side answers.

### Stop and the limit

- **Stop cancels the chain.** Every open request in the thread is cancelled,
  and so is every agent continuation not yet delivered. That includes a
  hand-off already answered whose routed reply is still queued. A running side
  answer from a request is cancelled too.
  - Agent-queued messages never lift the Stop hold; only the user's own
    messages do.
  - A cancelled request never revives.
  - Stopping a side answer the user started cancels only that side answer.
- **Limit: 3 agent-initiated requests (asks or hand-offs) since the user last
  wrote.**
  - An accepted request's answer or routed reply never counts, so the return
    half of an accepted hand-off always arrives.
  - The decider counts request records, so parallel tool calls cannot slip
    past it.
  - When the limit is hit, the tool returns `limit`, and the room shows
    "Agents are waiting for you (3 requests used)".
  - A user message resets the count.

### Agent-to-agent messages in the chat

- **Data**: role `user` messages written by an agent carry
  `fromAgent: { participantKey }` and `requestId`. `participantId` stays the
  addressee.
- **Display**: "Opus 5.5 → GPT-6 Astra", in a quieter style than the user's
  bubbles.
- **In catch-up notes**: "a request from Opus 5.5 on the user's behalf".

## Part C: extras

- **Fresh eyes**: `room_ask({ ..., fresh: true })` runs the side answer in a
  side runtime with no fork and no room history tool. Its only inputs are the
  question and an explicit basis: the diff or revision the asking agent names,
  captured by the server.
  - It really is independent, and B's normal conversation is untouched.
- **Change an added agent's model after it joins**:
  `thread.participant.update`. Refused while that agent is working or
  answering; queued targets are revalidated when they run.
- **Command palette**: "Add agent".

## Client

- **Composer**:
  - While the holder is busy (running, starting, or waiting on background
    work) and another agent is picked, Enter asks it now. The send menu offers
    "Send when {holder} finishes", which queues and can edit.
  - If a side answer is already running, asking a third agent keeps the draft
    and offers the choice to wait or queue. A read-only question never
    silently turns into an editing turn.
- **Timeline**:
  - A side exchange is its own block: the question "to GPT-6 Astra · while
    Opus 5.5 works", then the answer with its author line and its read-only
    steps in its own small tray.
  - Side messages are left out of the main turn's spans, trays, settle and
    hoist logic, and are never the "last user message" boundary.
  - While answering: a "GPT-6 Astra · answering" row with its own Stop.
- **Agent picker**: shows who is working and who is answering. Neither can be
  removed.
- **Sidebar, taskbar, and quit/update protection**: count a running side
  answer as live work. The thread shell carries `sideTurn`, and the shared
  running-work selectors read it. When only B is answering, the inbox row says
  "GPT-6 Astra · answering".

## Phasing (one PR each)

1. **Side answers**: Part A, the room read server (`room_history`,
   `room_diff`), the composer, the timeline block, Stop, the running-work
   selectors, turn admission and checkpoints, and the context cursor.
   - It starts with a **proof spike** before any UI work:
     1. A restricted Codex fork and a restricted Claude fork can read the
        intended context and checkout. They run no forbidden extension, hook
        or MCP server, and never touch B's original conversation.
     2. Side startup, Stop, exit and restart, and stored side bindings, never
        affect the main runtime or its projection.
     3. A disposable fork's note never consumes the main conversation's cursor.
     4. External-auth sign-in works for the side runtime, and the main
        Codex home's `auth.json` is byte-identical before and after.
   - The spike needs a few tiny live turns. They are asked for first, since
     they spend usage.
2. **Room tools**: Part B (ask, hand off, requests, turn keys, the limit,
   chain Stop, agent-to-agent display, credential scope and revoke).
3. **Extras**: Part C.

Each PR gets:

- the gates;
- an outside review of its diff;
- a live check in a throwaway stack (no real threads).

Resource use:

- Each side answer is one provider process plus one fork. There is one at a
  time per thread, and it is cleaned up after every outcome.
- There is no pool or scheduler until measurement asks for one.

## Spike results (2026-09-26)

Run in `/tmp/rooms-spike` with scratch provider homes, on codex-cli 0.157.0,
Claude Code 2.1.282 and SDK 0.3.276. It used five small live turns.

**Codex** (GPT-5.6 Luna, low effort): all 9 checks passed.

- **Setup**:
  - The source conversation ran in a home that trusts the project; the control
    fired (its project MCP server started).
  - The side runtime got a copy of that rollout in its own home, generated
    config `approval_policy="never"`, `sandbox_mode="read-only"`,
    `[features] hooks=false, apps=false, default_mode_request_user_input=false`,
    and the same values as `-c` flags. Sign-in was external-auth
    `chatgptAuthTokens`.
- **Results**:
  - `mcpServerStatus/list` was empty, including no `codex_apps`, and
    `hooks/list` was empty.
  - Resume reported `readOnly` with network off. There were no server
    requests.
  - The fork recalled the secret word and read the checkout. Its write failed
    with "operation not permitted".
  - The source rollout and `~/.codex/auth.json` were byte-identical afterwards,
    and no login file was written to the side home.
- **Note**: Codex logs that project skills still load in an untrusted
  project. They are instructions only, and the sandbox still blocks writes.

**Claude** (Haiku 4.5): all 10 checks passed, on the second try.

- **Setup**: a fork via `resume` + `forkSession`, with `settingSources: []`,
  `tools: [Read, Grep, Glob]`, `mcpServers: {}`, `strictMcpConfig: true`, a
  default-deny `PreToolUse` hook, and `canUseTool` deny.
- **Results**:
  - The init message showed exactly those three tools, no MCP servers, and
    only the built-in `agents-md` and `telemetry` plugins.
  - The fork got a new session id and recalled the secret word. It read the
    checkout and said it had no write tools.
  - The source transcript was byte-identical afterwards. The project hook and
    MCP server never ran; the control fired both.
- **The first try failed**: without `strictMcpConfig`, the account's claude.ai
  connectors connected mid-turn, and the next request failed with "Prompt is
  too long".
- **Still to wire**: the transcript snapshot the CLI writes lists the source's
  tools, so tool gating is verified from the init message, not from
  transcripts.

**Proof points 2 and 3** (side bindings never touch the main session; forks
never consume the main cursor) are Threadlines logic. They are proven by
behavior tests during the build, with no live turns needed.

## Acceptance tests (behavior, not wiring)

1. A streams while B answers. B's answer, failure, Stop and runtime exit never
   change A's session, approvals, `latestTurn`, buffered text or checkpoint
   baseline.
2. Side completion and a main handover race in both orders. Stale bind,
   content, interrupt and settle events never touch the next side turn or a
   main turn.
3. Every lifecycle exit frees the side slot, and then another side answer can
   start.
4. A side runtime (against fixtures with a user MCP server, a plugin or
   project MCP server, and a lifecycle hook) cannot:
   - run a built-in write;
   - use an attached MCP write or browser action;
   - use an unknown tool;
   - make a late tool call during cancellation.

   None of these executes or prompts. Forbidden servers and hooks never start.
   Its first real turn is still restricted.

5. A main turn's late checkpoint survives a handover. Side messages and side
   completions never create one. An idle agent's self-woken turn never does.
6. A hand-off reply reaches the right caller despite user work in between.
   Stop plus a new user message cannot revive the chain. A restart does not
   duplicate the reply.
7. The third request always gets its answer; a fourth is refused visibly.
8. Side answer, then steer, then next turn: the missed context is delivered.
   Partial-then-final messages are not lost.
9. Fresh eyes sees neither B's conversation nor room history, and B's
   conversation is intact afterwards.
10. With only B answering, the sidebar and quit protection still show live
    work.
11. A stopped side binding for B never marks B's live main session stopped on
    startup.
12. A T1 hand-off delivered during T2 is refused. A replay does not duplicate.
    Two different calls in one turn stay two requests.

## Decisions taken from the review

- **Side answer identity**: a separate `sideTurnId` with `turnId: null`, and
  explicit lane helpers wherever events are consumed.
- **Bash in side answers**: denied. Diffs come from a server-owned read
  capability (fixed git commands, bounded output) in the room server, not from
  a shell allowlist.
- **Room tools**: room-only. Runtime reconfiguration is a lifecycle step that
  never kills protected background work.
- **One side answer per thread**: kept.
- **Catch-up cursor**: delivered-context, not inferred.
- **Blocking `room_ask`**: kept, with a Threadlines deadline, exact
  cancellation, idempotent request ids, and structured outcomes.
- **Other rules**:
  - Tool inputs use participant ids.
  - Side answers read the thread's current checkout.
  - Changing or removing an agent is refused while it is busy.
  - `fromAgent`, `askedBy`, bind and settle are server-only.
  - History output is bounded.
  - An answer about live files is not called a verification of a fixed
    revision.
