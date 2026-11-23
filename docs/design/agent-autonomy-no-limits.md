# Agents work without per-message limits, and threads nest

Status (Nov 23 2026): Part 1 is built. Part 2 is **not built**: GPT-6.2 Astra's review of rev 1 found that its delivery rule loses or misroutes answers (see "Review of Part 2, rev 1" at the end), so it needs a redesign before anyone builds it. Asked for by Will: "do it all the T3 code way, we will accept the same risks that they are taking". The goal is a lead agent that directs other agents, in a room or in threads it starts, for hours or days without the user writing.

## What T3 Code does (pingdotgg/t3code at f1c13177d8)

- No count, rate, depth or loop limit on agent-to-agent traffic. `delegate_task`, `t3_thread_send` and the rest run no count checks (`OrchestratorMcpService.ts:2855-2990`, `:3672-3724`).
- Children can delegate again, to any depth. Stop on a thread walks its delegated tasks recursively (`ThreadManagementService.ts:1789`, test `ThreadStop.test.ts:537`).
- Limits that stay: a child never gets more access than its parent (`delegatedTaskModes.ts`), message size (120,000 chars), batch size per call (20), one wait call blocks at most 45 s.
- Every child completion wakes its parent (`completionWake: "always"`).
- The risk they accept: two agents can message each other forever, unwatched, and spend the user's usage. The only brakes are tool wording, the user's Stop, and provider usage limits.

We take the same risk. We do not add a loop detector: a false alarm would stop a run that has been going for days, which is the case this change is for.

## Part 1: remove the per-message counts

Removed, with their counters, refusals, `limit` outcomes and every text that states them:

- Rooms: `ROOM_AGENT_REQUEST_LIMIT` (3 asks, reviews and hand-offs since the user wrote). `requestsSinceUser` and `batchesSinceUser` stop being counted or read. `roomAgentRequests.ts:61,105,163,224,275` and `agentRequestDecisions.ts:1063`.
- Threads: `CHILD_THREAD_START_LIMIT` (5), `CHILD_THREAD_SEND_LIMIT` (10), and the lead chat's 10 and 20 (`childRequestLimits`). `startsSinceUser` and `sendsSinceUser` likewise.
- Texts: room and thread tool descriptions (`roomTools.ts`, `threadTools.ts`), the lead chat's role text (`docs/design/lead-chat.md` "The role text states the lead's limits"), guide topics (`apps/server/src/guide/topics.ts`), `docs/design/rooms-slice-2.md` and `docs/design/child-threads.md`.

Kept, because none of them caps how much agents do over time:

- `MAX_LIVE_SIDE_TURNS = 3`: side answers running at once. More wait or are refused with "try again once one finishes".
- `CHILD_THREADS_PER_CALL = 5` per `thread_start` call. An agent makes another call.
- Prompt and title size limits, `THREAD_LIST_PROJECT_LIMIT`, `THREAD_WRAP_PER_CALL`.
- Stop: it still ends a chain for good, and agent-origin traffic still waits after Stop until the user writes (the `hold`, `chainEpoch`, `deliveryEpoch` and `queueHeldByStop` rules).
- Approval settings: "Agents can start threads" off / ask / auto, invites, and "Threads can share a checkout".
- The no-fan-out rule for work the lead chat passes on (`passCeiling`): it keeps one lead message from reaching through every thread it is passed to. That's about access, not volume.
- Outside agents' calls-per-minute limit (`outsideAgents/`): callers outside Threadlines, not agents talking to each other.
- A thread messages only threads it started (plus the lead chat's pass). T3 Code lets any thread message any thread; we keep ownership because it's how replies find their way back and how Stop knows what to stop.

Schema: the four counter fields stay in the schema, because an older client (a phone or another computer on an earlier version) still requires them when it decodes a thread from a newer server. Nothing counts or reads them any more; stored values are left as they were. The `limit` outcome is gone from the room and thread tool results; the web still reads it in old transcripts (`apps/web/src/childThreads.ts`). `thread.child-requests-reset` now only lifts a lead pass's block, and an old event with `keepsPassBlock` changes nothing.

## Part 2: threads nest to any depth

### Rules that go

Every "a thread started by another thread can't..." refusal:

- `callerRefusal`'s `DEPTH_REFUSAL` (`packages/shared/src/childThreads.ts:74`): `thread_start`, `thread_send`, `thread_stop`, `thread_wrap` from an attached child.
- `decideChildrenStop`'s two refusals (`childThreadDecisions.ts:1814,1833`).
- `thread.create` refusing a parent that is itself an attached child (`decider.ts:1559`).
- Put back's "parent is itself an attached child" and "this thread has started threads of its own" (`childThreads.ts:286-291`). A cycle can't form: `parentThreadId` is set once at creation, and put back only re-attaches to that thread.
- The tool texts and `Depth 1` section of `child-threads.md`.

Kept: the access ceiling (a child never gets more than its parent, checked at create and on every send, so it holds down any chain), linked computers (a thread another computer's agent started here stays fenced from thread tools, `isLinkFenced`), and the lead chat's `ownChildRefusal` for passes.

### A middle thread answers only when its own children have

Today a request from R to its child M settles when M's answering turn completes with no awaited background tasks. If M started threads of its own in that turn, R gets "I started G1 and G2" and goes on; G1's report later wakes only M, and M's final answer reaches R only as a late-reply note at R's next turn (`lateReplyOf`), never waking it. That breaks a lead directing a team for hours.

New rule: **a thread's open child requests are owed work, like awaited background tasks.** One predicate `owedWorkCount(thread) = awaitedBackgroundTaskCount + open child requests that report back` replaces the background count wherever delivery reads it:

1. `childDeliveryForTurnEnd`: M's answering turn completes with owed work → `awaiting_background` with that turn as the candidate (unchanged path, wider input).
2. A turn in M started by **a report from one of M's own children** (`fromThread.kind === "report"`, the report's `threadId` attached to M) continues R's `awaiting_background` request, exactly as a follow-up turn started by background work does today (`pendingMessageId === null`). Completed with owed work left → it becomes the new candidate. Completed with none → R's request settles `answered` with that turn's last reply. Failed or stopped → settles as today.
   - A turn started by the user or by R's own `thread_send` still answers only its own message (unchanged).
3. `isQuietCandidate` also requires no open child requests, and the reactor re-checks quiet candidates when **M's child requests settle** (`thread.child-request-settled` on M), not only on M's `session-set`. That covers M's last child settling with no report (`thread_stop` by M, declined approval, separated by the user): M takes no turn, so R's request settles with the candidate.
4. Restart: an `awaiting_background` request whose candidate thread still has open child requests is **not** settled with the candidate at startup. Those child requests recover by their own rules and wake M, which continues R's request. Only background work dies with the process; child requests don't.
5. Usage-limit continue: a report turn in M that continues R's request is heldable like an answering turn (`answersHeldableRequest`), so "continue at reset" keeps R's request open instead of failing it.
6. Linked computers: the link ledger path (`LinkRequests`) uses the same `childDeliveryForTurnEnd`; a remote child is fenced from starting threads, so it never has owed child requests. No change there beyond the shared input.

R's shell keeps showing "Waiting · N threads" from `awaitedChildThreadCount`; it counts R's own open requests, which now stay open while grandchildren work. That's the truthful state.

### Stop, wrap, archive and delete reach the whole subtree

Each stays one decision in the decider, so nothing slips through between steps (the failure T3 Code's bug list is full of):

- **"Stop N working threads"** (`thread.children.stop` without ids) stops every working descendant, not just direct children: each thread's own Stop rules apply (its open requests settle `stopped`, queued reports unqueued, notes added). The menu count is the subtree's. `thread_stop` from an agent on its own child stops that child's subtree too, so a lead can end a whole branch in one call.
- **Stop on a thread itself** keeps today's rule: its requests settle, its children keep running. Changing that is a separate decision Will made (child-threads.md decision 4 covers wrap; Stop follows it).
- **Archive cascade** recurses: a settled attached descendant is archived and stamped `archivedWithParentAt`; a live one is separated, with its own subtree staying attached to it. Unarchive restores everything stamped by that archive.
- **Delete with its threads** deletes the whole attached subtree; without it, direct children are separated and keep their own subtrees.
- **Auto-wrap** already reads the parent's done state recursively (`fileInboxThreads.resolveDone`); only the "one level deep" comment changes.

### Sidebar

The root's family shows every attached descendant, in tree order (each child followed by its own descendants, creation order within a level), one line each, indented one step per level below the first. The summary line ("●●● 7 threads · 1 needs you") counts the whole subtree. A collapsed family still shows any descendant that needs the user, and the open one. A middle thread's row gets the same menu items a parent row has ("Stop N working threads" for its subtree). Indentation steps stop growing after level 3 so titles keep room on a phone.

`familyParentKeyOf` stays the direct parent; a new `familyRootKeyOf` walks up attached parents (with a visited set) to pick the family a row renders under.

### Chat

Nothing new: a middle thread already shows "Started by <parent>" and its own "Started N threads" cards. The attached-child preamble adds one sentence when the thread may start threads: "Threads you start report back to you; your final answer goes back once they have."

## Every surface

- **Providers.** Thread tools already reach Codex, Claude, OpenCode and HTTP ACP agents through the room endpoint; children get them like any thread. No per-driver change.
- **Clients.** Web and desktop share the sidebar; phone gets it through the same components.
- **Contracts.** Constant and counter removals; no new wire fields (descendant walks are computed).
- **App guide.** Rooms topic and threads topic lose the limits and gain "threads can start threads".
- **Reverse states.** Stop subtree ↔ next message resumes each; archive subtree ↔ unarchive restores the stamped ones; separate ↔ put back (now allowed at any depth).

## Tests (extend existing files)

- `roomAgentRequests`/`agentRequestDecisions`: a fourth and a fortieth request are accepted.
- `childThreads` shared tests: starts and sends past the old limits accepted; an attached child can start, send, stop and wrap; put back allowed for a thread with its own children.
- `decider.childThreads.test.ts`: create under an attached child; subtree stop in one command; archive and unarchive of a three-level family; delete with children three levels.
- `childThreadDelivery` tests: M's answering turn with an open child request → `awaiting_background`; G's report turn in M with nothing left owed → R's request answered with that reply; with more owed → new candidate; M's last child settled without a report → quiet candidate settles; restart keeps an awaiting request whose thread still has open child requests.
- `Sidebar.logic` tests: tree order, indentation level, subtree counts, root key walk.
- Browser: the family rows render three levels; polish shot with real fonts, light and dark unchanged colours.
- Live: a throwaway stack (never `~/.threadlines/userdata`), a Claude root starts a child that starts a grandchild; the grandchild's answer reaches the root and wakes it; "Stop N working threads" on the root stops all three levels.

## Review of Part 2, rev 1 (GPT-6.2 Astra, Nov 23 2026)

Checked against the code; each holds. A redesign has to answer all of them.

1. **Pending reports are owed work too.** A child's request leaves `open` when its report is queued, not when the middle thread has read it. M with G1 and G2: G2 settles while M handles G1's report on a provider that can't steer, so M's turn ends with zero open requests and R gets the G1-only answer.
2. **Downstream work needs the upstream request's identity.** R sends M a second task while the first waits on G: M's second turn sees G open and becomes a candidate too; G's report steered into it answers the wrong request. In a room the two requests can come from different agents.
3. **The session reaper (`ProviderSessionReaper.ts`, 30 minutes idle) stops an idle middle thread** whose children are still working, and `ChildThreadReactor.settleStoppedAnswers` then tells R "the user stopped" M. Runtime eviction must not read as a stop.
4. **Restart** settles R before M's queued report replays (M has zero open requests once G settled), misses a report turn that completed before the crash (recovery only matches `pendingMessageId === null` continuations), and delivers M's first turn when its `awaiting_background` update didn't commit.
5. **A room hand-off in M** goes through `thread.turn.start` without `fromThread`, so `settleCandidateBeforeUserTurn` sends R the candidate while G works.
6. **Usage-limit continue** (`isHeldByContinueAtReset`) requires `running` and the failed turn's own message; an `awaiting_background` request continued by a report turn fails at once.
7. **Reports with no local attached child** (a remote G with `environmentId`, a `neverMade` G) still start turns in M; and a queued report taken back (separate, wrap, room departure) triggers no re-check.
8. **The MCP handlers have their own depth checks** (`threadToolHandlers.ts` start, local ownership, remote send, remote stop, wrap), separate from the shared and decider rules listed above.
9. **Nesting lets a lead pass escape its ceiling** (T passes to its existing child M, which carries no pass block and starts G), and ordinary sends don't re-check the parent's current access when the user narrowed it after the child was made.
10. **Delete with its threads** would delete more than the dialog counted (`useThreadActions.ts` counts direct children only and winds down only those).
11. **Agent-issued subtree stop** returns `not_running` for an idle M whose child works (`childHasWork` ignores M's own requests), and stopping M first settles the requests used to find the rest.
12. **Late replies and moves** assume one level (`lateRepliesForAgent` returns early for an attached thread; move admission and whole-family moves refuse or flatten a middle parent).
13. **The chat's family tabs** (`familyTabs.logic.ts`) list a parent's direct children only and would disagree with a nested sidebar.

Atomicity is fine: the engine commits one decision's events in one transaction, and `decideCommandSequence` projects each step before the next. The counter fields can go from storage, but older clients need them on the wire (kept, see Part 1).

A simpler direction worth weighing in the redesign: T3 Code's own. Every completion of a child that isn't the user's own conversation with it wakes its parent with a report, instead of holding the parent's request open until the subtree settles. R's request settles as today; M's later answers arrive as new reports. That removes findings 1, 2, 4, 5 and 6 (no request stays open across M's turns) at the cost of R being woken more often, which is the risk Will accepted. Findings 3 and 7 to 13 remain either way.
