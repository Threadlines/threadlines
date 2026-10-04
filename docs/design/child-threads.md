# Child threads: agents that start and steer threads

Status: plan rev 3 (Oct 4 2026). GPT-6.1 Sol reviewed rev 1 and found 19 issues; I checked each against the code and accepted them all. Sol re-checked rev 2: 13 were closed, and the 6 partly open ones plus 5 new ones are fixed in rev 3 (see "Rev 3 fixes"). Building from this revision.
Sidebar mockup: `docs/design/child-threads-sidebar.html`. The agreed design is in the boards "Option B · your pick", "B, opened" and "Wrapping and separating children". One thing in the mockup is superseded: there is no "same checkout" choice any more (see Workspaces).

## Goal

An agent in thread P can start new threads in the same project, read them, send them messages and stop them. Each child is a normal Threadlines thread: its own provider session, its own git worktree, any ready provider or model. When a child finishes work P asked for, its final answer comes back to P, and P picks up again on its own. The user sees each family in the sidebar, can open and talk to any child, and can wrap or separate children.

T3 Code shipped the same idea in "orchestrator v2" (`delegate_task`, `create_threads`, `t3_thread_*`; see github.com/pingdotgg/t3code `docs/orchestration-v2/orchestrator-mcp-server.md`). We take the product idea, not their core rewrite. Their open bug list is our warning: about a dozen fixes for Stop not reaching children, restarts losing deliveries, and results that never arrive. Each of those paths has an explicit rule below and a test.

## Decisions already made by Will

1. Build it, full scope, one feature.
2. Sidebar is option B, opening in place. The parent row gets a summary line ("●●● 3 threads · 1 needs you", chevron) that opens into one-line child rows under it. Collapsed by default, remembered per family.
3. Finished children wrap themselves, behind a client setting next to "Wrap up merged threads" (default on).
4. Wrapping the parent never stops working children.
5. Children can be wrapped on their own and separated ("Make it its own thread"), with a way back ("Put back under <parent>").
6. There is an approval setting like agent invites: off / ask / auto, default ask.

## Changes from rev 1 (from Sol's review)

- **Durable launch spec.** The whole launch spec is saved in the request: prompt, workspace, base, model, both access modes, reportBack and setup.
- **Child bootstrap** is a resumable, staged sequence with deterministic ids. Simply moving the WS helper out would not survive a crash.
- **Restart rules cover every state.** A child turn cut off by a restart settles as failed and tells the parent. Nothing waits for an event that will never come.
- **A request is bound to its own message's turn** (matched by `pendingMessageId`, the hand-off pattern). Statuses gain `queued` and `awaiting_background`. Settling no longer depends on "nothing queued".
- **One shared agent-origin predicate** covers `fromAgent` and `fromThread`, so child traffic is never treated as the user's.
- **Children inherit the parent's interaction mode** (plan stays plan) as well as its runtime mode.
- **Batching several answers into one parent turn is dropped.** It needed multi-message turns, and it only saves a turn when answers land while the parent is busy.
- **Cancelling stops queued answers too,** not just open requests. A final check before send catches answers already being prepared.
- **`thread_stop` stops the child's whole session,** background agents included.
- **Requests and reports are marked separately,** and each gets its own preamble.
- **Room specifics:** the requester leaving cancels its child traffic, and notes are delivered per recipient.
- **Put back** is refused when it would create depth two.
- **New discovery tool `thread_agents`.** `room_available_agents` is invite-only: it is disabled when invites are off and limited to Codex and Claude.
- **Pending approvals mark the parent as needing the user.**
- **Persistent per-user-message counters,** with pending approvals reserving room.
- **The auto-wrap exemption is scoped** to the exact handed-back completion.
- **Archive cascade:** membership is decided on the server, cleanup runs for every archived thread, and the sweeper is guarded.
- **No shared-checkout children in git projects.**

## Rev 3 fixes (Sol's re-check of rev 2)

These rules override anything in the sections below that disagrees with them.

1. **Delivery epoch.** The parent's child-request state has a `deliveryEpoch`. Stop, wrapping the parent, separating a child, deleting a child and a participant leaving all raise it.
   - Report entries and their `turn-start-requested` carry the epoch they were queued under.
   - `send-queued` for a report whose epoch is stale emits an unqueue (`cancelled`) instead of a turn start, and the decider checks this, not the reactor.
   - A report turn that was already dequeued and whose epoch moved is dropped by the reactor's existing stale-epoch path (ProviderCommandReactor.ts:2012-2030). It then marks the report cancelled and frees the session.
   - The epoch only goes up, so putting a child back can't revive an old answer.
2. **Restart.** Requests resume only if they are `starting` at bootstrap stages 1–3. At startup every other open request (except `awaiting_user`) settles:
   - `answered` when its answering turn durably completed with final messages;
   - otherwise `failed`, with the reply "<title> was interrupted by a Threadlines restart; send it a message with thread_send to continue" (any `awaiting_background` candidate is quoted as partial context).

   Its request message is unqueued in the child, and a pending start for it is cancelled, so nothing runs without a reader. This doesn't depend on the reactor ever re-scanning old queues.

3. **Background fallback.** The settle-on-`session-set` fallback applies only when the child's latest turn _is_ the candidate's turn, meaning no continuation started. A continuation settles only through its own finalized `turn.completed` routing. If it ends with more awaited work, it becomes the new candidate.
4. **Setup stage.** The runner starts the script in a terminal and returns `started` (ProjectSetupScriptRunner.ts:61); the WS path never waits for it to finish either. Stage 3 counts as done when this thread has a `setup-script.started` or `setup-script.skipped` activity. It is never re-run after a crash.
5. **The user and a child's answer.** A user steer into the answering turn, or into its continuation, becomes part of that turn by design, and the answer includes it. A _new_ user turn in the child while the request is `awaiting_background` settles the request with the candidate before that turn runs.
6. **Room history and catch-up** name `fromThread` messages by origin ("Request from thread X", "Report from thread X") through one shared author renderer, instead of labelling them "User" (roomHistory.ts:91, roomCatchUp.ts:216). Cancellation marking (roomAgentRequests.ts:309) covers reports too.
7. **`handed-back`** is stamped only when the settle actually emits a report. Suppressed, cancelled and stopped outcomes never set it.
8. **Archive cascade membership** uses the shared live-work predicate (`isAutoArchiveProtectedThread` inputs in packages/shared/src/threadAutoArchive.ts, plus awaited background work, queued or pending starts, and open child requests). Live children are separated; the rest are archived.
9. **`archivedWithParentAt`** is set only on children this cascade newly archives. Any independent archive or unarchive of the child clears it.
10. **Revert** is refused in a parent while it has open child requests or queued reports. It's also refused in a child while a parent request is bound to it ("Finish or stop its threads first"), extending the room guard at decider.ts:2385.

## User-facing behavior

### Sidebar (apps/web/src/components/Sidebar.tsx, sidebar/InboxRows.tsx)

- **What a family is.** A family is a parent plus its attached children. Attached children never render as top-level live rows while their parent is live.
- **Parent row.** It keeps its two lines. While it has attached children and is live, a third line appears:
  - one 5px dot per child in its status colour (grey when finished or wrapped; at most 8 dots, then "+N");
  - then the text, by priority: `N threads · K needs you` (amber, approval or input), `· K failed` (red), `· K working`, `N threads finished`;
  - then a chevron.

  The line is its own button, outside the row's `PreviewCardTrigger`, and toggles the family open or closed.

- **Parent status.** Three cases:
  - Its own turn has settled and answers are still owed: cyan "Waiting" pill, word `N threads`, clock from the turn's completion.
  - A batch is waiting for approval: amber `approval`, like any pending approval. It's blocking, so the parent can't be wrapped and it notifies.
  - Waiting on child answers alone does not block wrapping.
- **Open family.** Child rows are sibling `li`s, one line each (~26px): status dot (grey check when wrapped), title, meta (state word + clock, or relative time), provider glyph. Same colours and words as live rows. Creation order, never re-sorted.
- **Collapsed family.** A child that needs the user, and the child open in the chat, still render under the summary line.
- **Fold and keyboard.** A family takes one seat in `windowInboxThreads`. It has attention if the parent or any attached child has a status pill. `orderedThreadKeys` equals the rendered rows, which keeps jump labels, prewarm, prev/next and shift-range selection correct.
- **Filters.** Project and machine scope apply to the parent, and its children travel with it.
- **Hover actions.** Child rows get the floating wrap button under the same rule as live rows. Wrapped child rows get reopen.
- **Menus.**
  - Attached child: "Make it its own thread".
  - Separated child with a living, unarchived parent: "Put back under <parent>". Disabled with a reason when not allowed.
  - Parent with working attached children: "Stop N working threads".
- **Hover cards.** A child shows "Started by <parent>". A parent shows "Threads: 3 · 1 needs you".
- **Wrapped section.** A wrapped parent shows a fork icon and its attached child count. Its wrapped attached children live inside it.
- **Parent wrapped while a child is live.** That child renders as its own two-line row with `↳ <parent title>` in place of the project name. Once settled, it auto-wraps and joins its family.
- **Separated child.** A normal row. Its lineage shows in the hover card.
- **Mobile.** Uses the same components. Touch gets `pointer-coarse:` sizing on the summary line.

### Chat

- **Child header.** A "Started by <parent>" chip, built like the "Forked from" chip (chat/ChatHeader.tsx:225-246).
- **Child transcript.** Messages from the parent are authored "<parent title>" with a link.
- **Parent transcript.**
  - `thread_start` renders as a "Started N threads" card with live per-child status and links.
  - A child's answer lands as a message authored "<child title>". A clipped answer says so and points at `thread_read`.
  - Settled-without-answer outcomes (declined, stopped, separated, interrupted by restart) appear as one-line notes.
- **Approval card (ask mode).** Docked above the composer like the invite panel (chat/ComposerAgentInvitePanel.tsx):
  - Heading: "Claude wants to start 3 threads".
  - One line per child: title, agent glyph and model, "own worktree" (or "shares this folder" in a non-git project).
  - Buttons: **Not now** / **Start**.
  - The outcome stays in the transcript as a line, like invites do.

### Settings (settings/SettingsPanels.tsx, "Projects & Threads")

- **Agents can start threads:** Off / Ask me first / Automatic. Server setting `agentThreads`, default `ask`. Independent of the Rooms switch.
- **Wrap up finished child threads:** client setting `wrapUpChildThreadsOnFinish`, default `true`. Placed next to "Wrap up merged threads".
- Both are added to the dirty labels and to Restore defaults.

## Agent tools

The tools live on the existing room MCP server (`/mcp/room`, key `threadlines_room`). It's already attached to every main runtime on Codex, Claude, OpenCode and HTTP-capable ACP agents whenever room tools are wanted.

`roomToolsWanted` (ProviderCommandReactor.ts:893) becomes:

```ts
hasAgentRecords || agentInvitesMode !== "off" || agentThreadsMode !== "off";
```

Side runtimes never get these tools: `roomToolsFor(side)` excludes them and the handler re-checks `scope.side === undefined`. Every tool answers with an `outcome` literal and never blocks on child work.

| Tool            | Input                                                                                                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread_agents` | none                                                                                                                                   | Ready provider instances and models a child can run on. Respects `agentThreads`, not invites. Excludes per-use-billed sign-ins, as invites do (`PER_USE_AUTH_TYPES`), and providers that cannot honor the caller's interaction mode.                                                                                                                          |
| `thread_start`  | `threads: 1..5 × { title, prompt, agent?: { instanceId, model, options? }, runSetup?: boolean = true }`, `reportBack?: boolean = true` | Starts threads in the caller's project, each in its own new worktree off the caller's current branch (see Workspaces). `agent` defaults to the caller's model. `reportBack: false` starts them already separated, so nothing comes back. Returns `started` with `[{ threadId, title }]`, `asked_user`, `off`, `limit`, `not_allowed`, or `unavailable_agent`. |
| `thread_list`   | `scope?: "mine" \| "project" = "mine"`                                                                                                 | The caller's children (attached and separated), or the project's non-archived threads (newest first, max 30). For each: id, title, status word, branch, model, attached, startedBy.                                                                                                                                                                           |
| `thread_read`   | `threadId`, `after?`, `limit? = 20`                                                                                                    | Same project only. Recent user and assistant messages (each clipped at 4,000 chars, with a flag), status, and a `next` cursor.                                                                                                                                                                                                                                |
| `thread_send`   | `threadId`, `message`                                                                                                                  | The caller's attached children only. If the child is idle, starts a turn. If busy, queues behind its current turn. The answer comes back like a start. Returns `sent`, `queued`, `not_yours`, or `limit`.                                                                                                                                                     |
| `thread_stop`   | `threadId`                                                                                                                             | The caller's attached children only. Stops the child's whole session: the turn, background agents and workflows (`thread.session.stop`; the next message resumes it). The parent's requests for that child settle `stopped` without waking it. The parent's messages still queued in the child are taken back. Returns `stopped` or `not_running`.            |

- **Depth 1.** A thread that is currently an attached child gets `not_allowed` from `thread_start`, `thread_send` and `thread_stop`. It can still read and list. A separated child counts as top-level.
- **Idempotency.** Calls dedupe per caller turn through `requests.join`, keyed on threadId + callerTurnId + tool + normalized input. Request ids, child thread ids, message ids and every inner command id are derived from the request key, so a retried call finds its own work.
- **ACP 60s cap.** `thread_start` returns once the requests are recorded. Bootstrap runs in the reactor.

### Workspaces

- **Git project.** Every child gets its own new worktree off the caller's current branch HEAD, resolved and saved at submit time. Branches use the placeholder and are renamed by kind after the first turn, as today. Children never share the parent's checkout: we can't make a shared-checkout child reliably read-only on every provider, and concurrent edits to one checkout are the failure we're avoiding.
- **`runSetup: false`.** Skips the project setup script, for cheap research children.
- **Non-git project.** Children share the project folder because no isolation is possible. The approval card and the tool result say so.

## Data model (packages/contracts)

### Threads (`OrchestrationThread`, `OrchestrationThreadShell`, `ThreadCreatedPayload`)

- `parentThreadId: ThreadId | null`. Lineage, set once at creation.
- `attachedToParent: boolean`. Mutable through `thread.parent-attachment.set`.
- `handedBackAt: IsoDateTime | null` and `handedBackTurnId: TurnId | null`. The child's last delivered work. Set by settle with no `updatedAt` bump (the done-override pattern).
- `archivedWithParentAt: IsoDateTime | null`. Set when the parent's archive cascade archived this child, so unarchive restores only those.
- Parent detail: `childRequests: OrchestrationChildRequestState` (below).
- Parent shell:
  - `awaitedChildThreadCount`: open requests in `starting`, `queued`, `running` or `awaiting_background`.
  - `pendingChildApproval: boolean`: any batch in `awaiting_user`.

`ThreadCreateCommand` and `ThreadBootstrapCreateThread` gain `parentThreadId?` and `attachedToParent?`. The decider refuses:

- a missing or deleted parent;
- a parent in another project;
- a parent that is itself an attached child;
- self-reference.

### Child requests (parent aggregate)

```ts
OrchestrationChildRequest = {
  requestId, batchId,
  kind: "start" | "send",
  from: RoomAgentRef,                 // the agent in the parent that asked
  callerTurnId, chainEpoch,           // epoch shared with agentRequests (Stop)
  status: "awaiting_user" | "starting" | "queued" | "running" | "awaiting_background",
  childThreadId,                      // deterministic, reserved before approval
  childMessageId,                     // the message whose turn answers this request
  launch?: {                          // start only; everything bootstrap needs
    title, prompt, modelSelection, runtimeMode, interactionMode,
    reportBack, runSetup,
    workspace: { kind: "worktree", projectCwd, baseRef } | { kind: "project_folder" },
  },
  answeringTurnId?: TurnId,           // set when its message's turn starts
  candidate?: { turnId, messageId },  // awaiting_background: the answer so far
  createdAt,
}
OrchestrationChildRequestState = {
  open: OrchestrationChildRequest[],
  startsSinceUser: number,            // pending approvals included
  sendsSinceUser: number,
  pendingNotes: Array<{ requestId, recipient: RoomAgentRef, text, at }>, // max 20
}
```

This is kept apart from `OrchestrationAgentRequest`. Room code branches on `kind` in many places, and some of those rules are wrong here. For example, `closeRequestsOfEndedTurn` cancels requests whose caller's turn ended, but a parent's turn usually ends right after it starts children.

It shares two things with room requests: the parent's `agentRequests.chainEpoch`/`hold` (Stop), and the moment a real user submission resets counters. That reset gets its own child-state reset, so it doesn't rely on `resetAgentRequestsForUser`, which returns early when room state is clean.

Events:

- `thread.child-request-submitted`;
- `thread.child-request-updated` (status, answeringTurnId, candidate);
- `thread.child-request-settled` (outcome `answered | failed | stopped | cancelled | declined`, error);
- `thread.child-notes-delivered`;
- `thread.handed-back` (child aggregate);
- `thread.parent-attachment-set` (child aggregate).

### Messages and queued follow-ups

`fromThread?: { threadId, requestId, kind: "request" | "report" }`:

- `request` is a message the parent wrote into the child;
- `report` is a child's answer delivered into the parent.

`OrchestrationQueuedFollowUp` and `thread.turn-start-requested` carry the same field, so the origin survives being taken off the queue.

**One predicate** `isAgentOrigin(x) = x.fromAgent !== undefined || x.fromThread !== undefined` lives in packages/shared/src/roomAgentRequests.ts and replaces every `fromAgent === undefined` "is this the user" check:

- `nextQueuedFollowUp` (ProviderCommandReactor.ts:278);
- the Stop hold in `processFollowUpQueued` (:3199);
- `isUserWrittenMessage` (roomAgentRequests.ts:319), which drives inbox order and "last message from you";
- the reset calls;
- the send-queued branches (decider.ts:2036+);
- `decideAgentChainStop`'s unqueue.

### Settings

- Server: `agentThreads: "off" | "ask" | "auto"`, default `ask`. Shared helper `agentThreadsMode`.
- Client: `wrapUpChildThreadsOnFinish: boolean`, default `true`.

### Persistence

Migration **066** `ProjectionThreadLineage`:

- `projection_threads`: `parent_thread_id TEXT`, `attached_to_parent INTEGER NOT NULL DEFAULT 0`, `handed_back_at TEXT`, `handed_back_turn_id TEXT`, `archived_with_parent_at TEXT`, `child_requests_json TEXT`, `awaited_child_thread_count INTEGER NOT NULL DEFAULT 0`, `pending_child_approval INTEGER NOT NULL DEFAULT 0`, plus `idx_projection_threads_parent`.
- Messages: `from_thread_json TEXT`.
- Queued follow-up JSON and pending turn start carry `fromThread`.

These columns are additive, with no row rewrite. I'll time the index build on a copy of a real `state.sqlite` anyway. Every field round-trips through ProjectionThreads (Services and Layers), the four ProjectionSnapshotQuery selects and mappings, and ProjectionPipeline. A restart round-trip test proves it, because the engine rebuilds the decider read model from SQL at boot (OrchestrationEngine.ts:287).

## Lifecycle rules

Pure rules live in `packages/shared/src/childThreads.ts` (refusals, limits, family grouping, the auto-wrap predicate) and `apps/server/src/orchestration/childThreadDecisions.ts`.

### Starting

1. **Handler pre-checks:**
   - the setting is not off;
   - the caller is a main runtime inside its own turn;
   - the caller is not an attached child;
   - the limits (counting pending approvals);
   - the agents are ready, not per-use billed, and can honor the caller's interaction mode.
2. **`thread.child.start` (server-only).** Records one request per child with the full `launch`, sharing a `batchId`.
   - `ask` mode: `awaiting_user`; the tool returns `asked_user`.
   - `auto` mode: `starting`; the tool returns `started`.
3. **`thread.child-request.respond { batchId, choice }` (user).** The normalizer re-checks the setting and the agents, using the `inviteAnswerRefusal` pattern.
   - Start: the batch goes to `starting`.
   - Decline: it settles `declined`, adds a pending note, and doesn't wake the parent.
   - Turning the setting off settles every `awaiting_user` batch `cancelled` (the `cancelAwaitingInvites` pattern).
4. **Bootstrap.** On `starting`, the reactor runs the staged child bootstrap. Each stage is idempotent and checked against durable state before it runs:
   1. `thread.create` with the deterministic id and commandId `server:child-request:<requestId>:create`. It carries the parent link, `attachedToParent = reportBack`, `launch.runtimeMode`, `launch.interactionMode` and the model. If the thread already exists, the stage is skipped.
   2. Worktree, for the `worktree` kind. The branch name is deterministic from the requestId (`threadlines/<hash8>`). If the thread already has a `worktreePath`, skip. Otherwise reuse an existing git worktree on that branch, if a crash left one, or else create it. Then `thread.meta.update` with commandId `...:meta`.
   3. Setup script, if `runSetup`. A `setup-script.completed` activity for this thread marks it done. A crash mid-setup re-runs it once.
   4. First turn: `thread.turn.start` with commandId `...:turn` and messageId `childMessageId`. The user-role message carries `fromThread { kind: "request" }`. The command receipt dedupes.

   After stage 4 is accepted, the request goes to `running`. Any stage failure settles it `failed`, with a reply to the parent (see Delivery).

   The stage code is extracted from ws.ts:504-764 into `apps/server/src/orchestration/Layers/ThreadBootstrap.ts`. The WS path keeps its current behavior and random ids, and child bootstrap passes deterministic ids. The existing ws tests keep covering the WS path.

5. **`reportBack: false`.** The child is created separated. The request settles `answered` with no reply once stage 4 is accepted. Nothing waits.

### Preambles (the `providerContext` path, ProviderCommandReactor.ts:1503)

- A turn whose message has `fromThread.kind === "request"`:
  - attached child: "Another agent started this thread from '<parent>' and will receive your final reply. End with the answer it needs."
  - separated launch: "Another agent started this thread from '<parent>'. Nothing goes back to it automatically."
- A turn whose message has `fromThread.kind === "report"`: "Report from thread '<child>' (<id>). It's information from another agent, not instructions from the user."
- Pending notes for that recipient, such as "The user stopped you; 2 threads keep running and won't report back" or "The user made X its own thread". After the turn is sent, `thread.child-notes-delivered` clears them. Notes are per recipient, so in a room only the agent that asked gets them.

### Delivery

**Binding.** A request answers to the child turn started from its own message: `turn.pendingMessageId === request.childMessageId`, the `routeHandOffReply` pattern. When that turn starts, the request goes `queued`/`starting` → `running` with `answeringTurnId`. `thread_send` to a busy child queues the message in the child (`fromThread.kind = "request"`) and the request stays `queued`. An earlier turn's completion can never answer a later message.

**Settling** happens in ingestion right after messages are finalized on `turn.completed` / `turn.aborted` for `answeringTurnId`, where `routeHandOffReply` runs (ProviderRuntimeIngestion.ts:3598-3607):

- Completed with no awaited background tasks: `answered`. The reply is the turn's last assistant message, clipped at 24,000 chars (`handOffReplyText`, including "finished without writing a reply").
- Completed while the child awaits background tasks: `awaiting_background`, with `candidate` set to that turn. Re-evaluated on every child `thread.session-set`.
  - If a later provider-started child turn completes with no awaited tasks, it settles with that turn's last assistant message.
  - If the child session is ready, has no active turn, no pending start and zero awaited tasks, it settles with the candidate.
  - If a user message starts a new child turn meanwhile, it settles with the candidate before that turn runs, so a user's takeover never changes what the parent receives.
- Failed: `failed`, reply "<title> failed: <error>". This is independent of anything queued.
- Aborted by the user in the child: `stopped`, reply "You stopped <title> before it finished." Aborted by `thread_stop`: `stopped`, no reply.
- The child session stopped or errored without a turn completion (the session-stop path, ProviderCommandReactor.ts:2906): settled the same way, from the session-set event.
- The request's queued message is taken back in the child (unqueue `cancelled`, or Stop in the child): `cancelled`, plus a pending note.

**Settle command** `thread.child-request.settle`, with commandId `server:child-request:<requestId>:settle`. In one decision it emits:

- on the parent, `child-request-settled`;
- on the parent, unless the epoch moved, the child is no longer attached, the parent is wrapped, or the reply already exists: `message-sent` (user role, `fromThread.kind = "report"`, author stamps) and `follow-up-queued` addressed to `request.from`;
- on the child, `handed-back { at, turnId }`.

**Pickup** uses the existing queue: an idle parent starts a turn via `maybeSendNextQueuedFollowUp`; a busy parent waits behind its current turn. The user's own queued messages still go first.

**Before sending any `fromThread.kind = "report"` turn**, the reactor re-checks all of these:

- the child is still attached;
- the parent isn't wrapped;
- the epoch hasn't moved;
- the recipient is still present.

If any check fails, the entry is unqueued `cancelled`. This catches answers dequeued into preparation when a lifecycle change lands.

**Modes on send.** `send-queued` re-applies a queued entry's captured modes (decider.ts:2085-2096). For agent-origin entries, they may only narrow the thread's current runtime and interaction mode, never widen them. This fixes the same latent bug for room hand-offs.

### Limits

- At most 5 threads per call.
- At most 5 started threads (pending approvals included) and 10 sends per user message.
- Counters persist in the child-request state, reset on real user submissions, and are untouched by agent-origin traffic.
- After Stop, agent-origin sends wait until the user writes. The `queueHeldByStop` rule now covers `fromThread` too.

### Stop, wrap, separate, delete, archive

Each of these settles open requests and also unqueues the matching queued report entries.

- **Stop on the parent** (`turn.interrupt` / `session.stop`). `decideAgentChainStop` extends to settle every open child request `stopped`, unqueue every queued report, and add a note. Children keep running. "Stop N working threads" stops them on demand.
- **Wrap the parent** (done-override `done`). The parent's open requests settle `cancelled`, queued reports are unqueued, and a note is added. Children keep running.
- **Separate** (`thread.parent-attachment.set { attached: false }`, user). That child's open requests on the parent settle `cancelled`, its queued reports are unqueued, and a note is added. The parent's queued request messages inside the child stay; they're the child's to run now.
- **Put back** (`attached: true`). Allowed only when:
  - the parent exists and isn't archived;
  - the parent isn't itself an attached child;
  - this thread has no attached children and no open child requests of its own.

  Nothing is restored. Later sends report back again.

- **Delete the parent.** Decider cascade (`decideCommandSequence`, like `project.delete`). Attached children are separated, unless the command carries `withChildren: true`, in which case they're deleted. The confirm dialog gets "Also delete its N threads". Deleting a child settles its open requests `cancelled` and unqueues its reports.
- **Archive the parent.** The cascade is decided on the server:
  - attached children that are settled (no turn in flight, no open requests of their own, no pending approvals) are archived and stamped `archivedWithParentAt`;
  - live attached children are separated first.

  Cleanup (session stop and terminal close, today ws.ts:849-896 for the named thread only) runs for every thread the command archives. `ThreadAutoArchiveSweeper` skips parents with open child requests or live attached children, and otherwise uses the same cascade. Unarchive restores the parent plus the children stamped with its archive.

- **Room participant leaves.** Its child requests settle `cancelled`, its queued reports are unqueued, and its pending notes are dropped. This is an extension of `cancelAgentRequestsForLeaving`.

### Auto-wrap (client, `isThreadDone` in Sidebar.logic.ts)

This is a new rule after the explicit override and before the 2-day idle rule. With the setting on, an attached child counts as done when it has no blockers and nothing in flight or queued, and one of these holds:

- `handedBackTurnId` is its latest settled turn. That exact completion was delivered, so it is exempt from the unseen-completion gate in `canMarkThreadDone`. Later undelivered work gets no exemption.
- Its parent is done. The user is finished with this work, which matches the mockup's "joins its family in Wrapped".

An explicit reopen of a child still wins (the override comes first). With the setting off, children follow the normal rules.

### Restart recovery

The reactor reconciles every thread with open child requests (not only rooms) after `settleSessionsFromPreviousProcess`, in the subscribe-then-reconcile order `closeRequestsFromPreviousProcess` uses (ProviderCommandReactor.ts:4172-4222):

- `awaiting_user`: kept.
- `starting`: the bootstrap is resumed from its first unfinished stage (each stage is idempotent). If it fails, the request settles `failed` with a reply.
- `queued` or `running` with no turn started yet: once the reactor's normal queue logic runs, the message is still queued in the child, so nothing is needed. If that message is gone, `cancelled`.
- `running` whose answering turn was cut off: startup has already marked that session interrupted ("Turn interrupted by a server restart", ProviderCommandReactor.ts:4160). The request settles `failed`, with the reply "<title> was interrupted by a Threadlines restart. Send it a message with thread_send to continue." That reply wakes the parent.
- `running` whose answering turn completed before the crash but wasn't settled: settled from its stored last assistant message.
- `awaiting_background`: background work died with the process, so it settles with the candidate.

### Rooms

`from` names the asking participant. Replies and notes go to that participant only. Children are ordinary single-agent threads.

## Every surface

- **Providers.** Codex, Claude and OpenCode get the tools through the room endpoint. ACP agents get them only when they report HTTP MCP. Children run on any ready, non-per-use provider that can honor the caller's interaction mode. Side runtimes never get the tools.
- **Clients.** Web and desktop share the components, and the phone gets the same web UI over the relay. The desktop menu bar and quit dialog count threads as they do today.
- **Command palette and search.** Children are ordinary entries.
- **Notifications.** A child needing input notifies as usual. A parent's pending approval notifies like a pending approval.
- **Keyboard.** Follows the rendered rows.
- **Reverse states:**
  - start ↔ stop;
  - attached ↔ separated;
  - wrapped ↔ reopened;
  - archived ↔ unarchived (cascade-aware);
  - setting off cancels waiting approvals;
  - approval start ↔ not now.

## Build steps

1. Contracts and shared rules (`childThreads.ts`, `isAgentOrigin`), with tests.
2. Decider (`childThreadDecisions.ts`): create checks, start, respond, settle, attachment, Stop/wrap/delete/archive/leave extensions, mode narrowing on send-queued. Then projector, SQL projection, migration 066 and snapshot mappings. Decider tests (commands in → events out) and a restart round-trip.
3. Staged `ThreadBootstrap` service, with the ws.ts path unchanged and a crash-between-stages test.
4. Reactor and ingestion: bootstrap on `starting`, binding and settling (including background, user takeover and session stop), the pre-send check, preambles and notes, restart reconcile, setting-off cancel, the `isAgentOrigin` swap.
5. MCP tools (roomTools.ts, roomToolHandlers.ts, roomToolAccess.ts) plus `thread_agents` and the `roomToolsWanted` change. Handler tests: outcomes, depth, ask/auto, idempotent retry, limits.
6. Web:
   - store and types (shell fields, `sidebarThreadSummariesEqual`);
   - Sidebar families, rows, menus, hover cards;
   - uiStateStore family-open map;
   - approval panel, transcript cards, author lines, notes;
   - ChatHeader chip;
   - settings rows;
   - delete dialog option.

   Sidebar.logic tests, plus InboxRows/ChatView browser tests.

7. Gates: `vp fmt`, `vp lint`, per-package uncached `tsc --noEmit`, targeted tests, `@threadlines/web#test:browser`.
8. Live test on a throwaway stack (never `~/.threadlines/userdata`). A Claude parent starts a Codex child and a Claude child. Check:
   - family UI, delivery and auto-wrap;
   - ask mode;
   - separate and put back;
   - Stop on the parent;
   - wrapping the parent with a live child;
   - `thread_stop`;
   - a restart with a child mid-turn.

Steps 1–5 are coupled, and I build them myself. Step 6 runs in parallel in its own worktree once step 1 is committed.
