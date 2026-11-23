# Agents work without per-message limits, and threads nest

Status (Nov 23 2026): Part 1 is built. Part 2 is **not built**. It is on its third plan. Rev 1 held a parent's request open until the threads below had settled, and GPT-6.2 Astra's review showed that loses or misroutes answers. Rev 2 reports every turn upward instead. Astra's review of rev 2 accepted that and found 13 problems in how it was carried out, most of them from working out what a turn was for only when it ended. Rev 3 below records that when the turn starts. Both reviews are kept at the end with a line per finding. Asked for by Will: "do it all the T3 code way, we will accept the same risks that they are taking". The goal is a lead agent that directs other agents, in a room or in threads it starts, for hours or days without the user writing.

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

Surfaces and tests for Part 1 (built):

- Contracts: the constants and counters above. No new wire fields.
- App guide: the rooms topic and the threads topic lost the limits.
- Tests: `roomAgentRequests` and `agentRequestDecisions` accept a fourth and a fortieth request; the shared `childThreads` tests accept starts and sends past the old limits.

## Part 2: threads nest to any depth (rev 3)

Rev 3 keeps rev 2's decision and replaces how it is carried out. Rev 2 worked out what a turn was for at the moment it ended, from what was open then. Astra's review of rev 2 showed that this is wrong whenever something closes, stops or restarts in between. Rev 3 records what a turn is for when it starts, and reads that record when it ends. Both reviews are at the end of this file, with a line per finding. Line numbers are from commit 975bf136e.

The examples use three threads. R is the root, the thread the user talks to. M is a thread R started. G is a thread M started.

### The decision: every turn a child finishes on its own goes up as a report

Today a child talks to its parent in two ways. An **answer** settles a request the parent made, and wakes the parent. A **late reply** is work the child did afterwards with no request open. It wakes nobody, and the parent's agent reads it at its next turn (`lateReplyOf`, `childThreadDelivery.ts:381`).

With nesting, almost everything a middle thread does after its first answer is a late reply. M answers R "I started G1 and G2", and that settles R's request. G1's report then wakes M, M does the real work, and R never hears of it unless something else wakes R.

Three ways to fix that:

1. **Hold R's request open until M's own threads have settled** (rev 1). The first review showed five ways this loses or misroutes an answer. All five come from the same cause. One request has to stay bound to a chain of M's turns that nobody planned, across restarts, usage limits and other messages arriving in M.
2. **Hold nothing, and report every turn** (T3 Code's `completionWake: "always"`, `OrchestratorMcpService.ts:2975`). R's request settles when M's answering turn ends, as today. Each later turn M finishes on its own goes to R as a new report and wakes R.
3. **Report only when M's whole subtree is quiet.** A stuck or days-long G would silence everything M learns in the meantime, the lead could not redirect on partial news, and the server would need a re-check for every way a subtree goes quiet.

Rev 2 and rev 3 take option 2. The sequences that decided it:

- **Two grandchildren, a provider that can't steer.** G2 finishes while M reads G1's report. Option 1: M's turn ends with no open requests, so R's request settles with the G1-only answer and G2's result never reaches R. Option 2: M's G1 turn ends and its reply goes to R. M's G2 turn ends and its reply goes to R. R hears twice and loses nothing.
- **A second task while the first waits.** R sends M task B while G still works on task A. Option 1: G's report can settle the request for B with A's news. Option 2: B's turn answers B's request, and G's news starts its own turn and goes up as a report for task A.
- **A restart while G works.** Option 1: R's held request settles before M's queued report replays. Option 2: R holds no request. The request from M to G fails as today, which wakes M, and M's turn goes up to R.
- **A usage limit in M's report turn.** Option 1: the held request fails at once. Option 2: nothing is held. The turn waits for its continue, and the continue turn's reply goes up.

What it costs: R is woken once for every turn a child finishes on its own for R's work, and each piece of news climbs one turn per level. A middle thread that checks back every five minutes wakes its parent every five minutes. That is the risk T3 Code takes and Will accepted. The preamble tells a child that each of these replies wakes the thread above it.

### The record: what a turn is for

Every turn in an attached child on this computer gets a **route** when it starts. It says whose work the turn is and where its reply goes. Nothing later is inferred from what happens to be open.

```ts
WorkRef = {
  parentThreadId,
  requestId,        // the parent's request this work descends from
  recipient,        // the agent in the parent that made it (null: the thread's own agent)
  deliveryEpoch,    // the parent's, when that request's turn started
  attachmentEpoch,  // the child's, at the same moment
  chainEpoch,       // the child's own Stop epoch, at the same moment
  upstream,         // the parent's own WorkRef for the turn that made the request, or null
}
OrchestrationTurnRoute = {
  work: WorkRef | null,   // null: the user's conversation or automation; the reply stays here
  answers?: requestId,    // this turn is that request's own answering turn
  inRoom?: true,          // this turn answers a hand-off in this thread; its reply goes to the agent that asked
  report?: "owed" | "sent" | "dropped",   // for a turn that reports upward without a request
}
```

**Work travels with messages.** A queued message an agent wrote carries the work it belongs to, and the turn it starts takes that work. So the route never has to be guessed:

| What starts the turn                                                         | Its work                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A request from the parent                                                    | A new `WorkRef` from that request, with the three epochs as they are now. `answers` is that request.                                                                                                                                                                                                                                                                  |
| A report from one of its own threads                                         | The work of the turn that made the request to that thread. Each request stores it (`upstream`), and the report carries it back. A later follow-up report from that thread carries it too, from the thread's own `WorkRef.upstream`.                                                                                                                                   |
| A hand-off from another agent in this thread                                 | The work of the turn that handed off, with `inRoom`.                                                                                                                                                                                                                                                                                                                  |
| The reply to a hand-off                                                      | The work stored on the hand-off.                                                                                                                                                                                                                                                                                                                                      |
| A continue after a usage limit or a restart                                  | The route of the turn it continues, `answers` included.                                                                                                                                                                                                                                                                                                               |
| A check-back                                                                 | The work of the turn that set it. Check-backs have ids (`OrchestrationCheckBack.id`, and `TurnTrigger.checkBackId` on the turn it starts). The decision for `thread.check-backs.set` (`decider.ts:5723`) notes the running turn's work beside each id it has not seen before. An id first seen while no turn runs gets none, and an id seen before keeps what it had. |
| Another turn the provider starts by itself (background work finished)        | The work of the thread's previous turn. If the parent holds an `awaiting_background` request whose answer so far is that previous turn, `answers` is that request. The provider gives no id here, so this one is by position.                                                                                                                                         |
| A person, an outside agent, a scheduled run, an automatic fix, a lead's pass | None. The reply stays in the thread.                                                                                                                                                                                                                                                                                                                                  |

A person's own conversation with a child stays theirs all the way down. If the user asks M to start G, that request's `upstream` is null, G's reports start turns in M with no work, and R is not woken. This is about not waking or misleading the lead. It is not a secrecy boundary, since any agent in the project can read any thread with `thread_read`.

**Where it is written.**

- For a turn a message starts, the decision that emits `thread.turn-start-requested` works the route out from the queued entry and the thread, and puts it on that event. It rides the path `pendingMessageId` rides today: the pending start, then the turn row (`ProjectionPipeline.ts:2271-2376`). So it exists before the provider has taken the turn, keyed by the message.
- For a turn the provider starts by itself, ingestion sends a new server command, `thread.turn.route.record`, when the runtime reports the turn started. The decision works the route out by the table above.
- The thread's `latestTurn` carries the route, so the next decision can read it: a request made in that turn, a continue of it, a check-back set in it.

### Delivery rules

1. **Requests are unchanged.** A request answers to the turn its own message started. It waits past that turn only for the child's own background tasks (`awaiting_background`), never for the child's threads. The turn is found by its route's `answers`, which says the same thing as today's match on the message id. If that request is gone when the turn ends (the agent that asked left the room, `decider.ts:3355`), nothing goes up. The turn is never re-read as something else. A turn that was already running at the upgrade has no route and answers its request by today's message match.
2. **Follow-up reports.** A turn whose route has work, no `answers` and no `inRoom` owes a report. When it ends, `thread.turn-report.settle` decides it once:
   - Completed with a reply: the reply goes to the parent.
   - Failed: "'<title>' failed: <error>. Send it a message with thread_send to continue." The exception is a turn that waits to continue at a usage limit's reset. Its report is closed when the continue starts, and the continue turn owes it instead. If that wait ends with no continue, the failure goes up then, from the helper that ends held requests (`decideHeldRequestsEnd`, `decider.ts:1253`).
   - Stopped, or completed with no reply: dropped. Stops are deliberate.
3. **The decision checks the route's own epochs.** It delivers only when the parent's delivery epoch, the child's attachment epoch and the child's chain epoch all still equal the ones in the `WorkRef`, the child is still attached to that parent, neither is deleted, the parent is not archived, and the recipient is still in the room. Otherwise it drops the report. So a completion that crosses a Stop, a `thread_stop`, a separate and put back, or a wrap and reopen is dropped, because each of those moves one of the three (`childThreadDecisions.ts:1416`, :1861, :1959, and the chain stop). The epochs are from when the work began, so everything that work set going dies with it: a check-back set before a Stop reports nowhere after it. A new request from the parent starts new work with new epochs.
4. **What a delivered report is.** A user-role message in the parent with `fromThread { threadId, requestId, kind: "report", followUp: true, upstream }` and a queued follow-up for the recipient, as an answer is delivered today. `requestId` is the request the work descends from. The message and its queue entry carry the current epochs, so the existing checks before send still apply (`isCancelledReport`, `childThreadDecisions.ts:2223`). The text is clipped as answers are. The child is stamped handed back as of that turn, so it wraps itself as it does after an answer. The builder checks `pushAlertRules.ts`, which cancels a child's "done" alert on `child-request-settled`. A follow-up has no such event, and it must not alert the user each time a child reports.
5. **Steering.** A report is steered into a running turn only when that turn belongs to the same recipient's work: both have no work, or both have work for the same parent and recipient. Otherwise it waits and starts its own turn. Today a report from G steered into a turn the user started in M is consumed there, and since that turn is the user's, G's news would never reach R.
6. **A steered message is marked before it is handed over.** Today the reactor hands the message to the provider and then records it as steered (`ProviderCommandReactor.ts:5567-5597`). If the server dies in between, startup sends the queued message again (`ChildThreadReactor.ts:489`), and an autonomous lead may act on it twice. New: a small event marks the queued entry as being steered, before the provider is called. An entry found with that mark at startup, or after a failed write, is sent with one more line: "Threadlines restarted while this was being handed to you, so you may have read it already. If you did, don't act on it twice." Exactly once is not possible across a crash with the provider in between, so the repeat is made known. This covers answers and hand-off replies too.
7. **A start that fails.** When preparing the provider fails or times out, no turn ever ends (`reportFailedStart`, `ProviderCommandReactor.ts:3427`), and today a parent's request for that child stays `running` for good. New: the failed start settles the pending start's route. An `answers` route settles its request `failed` ("'<title>' could not start its turn: <error>"). An owed route sends the failure report. A start that is taken back on purpose before the provider took it (a report that went stale, a Stop while the turn was being prepared) closes its route as dropped and sends nothing.
8. **Late replies read only dropped reports.** `lateReplyOf` changes its test: the child's newest turn has a route with work, its report was `dropped`, it completed with a reply, and the child is still attached with nothing running. The recipient is the route's, and once read the report is closed as sent. A report still `owed` is never read here, so a report and a late reply can't both carry the same turn. A turn with no work (the user's, an outside assistant's) is never read. `lateRepliesForAgent` loses its early return for an attached thread (`ProviderCommandReactor.ts:2331`). Turns from before this change have no route. Late replies that were unread at the upgrade are not delivered, and stay in the child for `thread_read`.
9. **A message-started turn closes a waiting answer first.** `settleCandidateBeforeUserTurn` (`decider.ts:562`) runs today only for turns without `fromThread`. It now runs before every turn a message starts in the child. The request settles with its answer so far, and what the child does next goes up as follow-up reports.
10. **Continue at reset.** `reportsToTopLevel` (`decider.ts:929`) arms the wait for a report turn only in a thread with no parent. It drops that condition. It still arms only for the thread's own agent. A named room agent's report turn that stops on a limit does not wait, so its failure goes up at once by rule 2, and the parent is told.
11. **Restart.** Startup settles every route still `owed` whose turn has ended or whose start never happened. There is no time window. A turn from before the upgrade has no route and is never looked at, a failed turn and an older turn are found like any other, and nothing depends on which event was written last.
    - A turn that completed before the crash is settled by rule 2.
    - A turn the restart cut off: `thread.restart.continue` (`decider.ts:5498`) decides every cut-off turn, after the child reactor has settled requests (`serverRuntimeStartup.ts:461`). If the route has `answers`, the request path has already told the parent, and nothing more is sent. If the route is owed, the same decision sends "'<title>' was interrupted by a Threadlines restart. Send it a message with thread_send to continue."
    - A failed turn whose thread still waits to continue at a reset is left alone. The wait is stored, and its continue or its end settles the report.
    - Requests recover as today (`settleFromPreviousProcess`, `ChildThreadReactor.ts:409`).
12. **Linked computers.** Unchanged. A thread another computer started here answers through the link ledger, is fenced from thread tools, gets no route and sends no follow-up reports.

Where it goes: `routeChildReport` (`ProviderRuntimeIngestion.ts:2770`) returns early when the parent has no open request for the child. It reads the turn's route first instead, and a pure function in `childThreadDelivery.ts` turns route and outcome into the request settle, the report settle, or nothing.

### What a child and its parent are told

- **Attached child preamble** (`ProviderCommandReactor.ts:2268`). Today: "Another agent started this thread from the thread "X", and your final reply goes back to it automatically. Work in this thread's own checkout, and end with the answer it needs." Add: "If you take more turns on this work later, for example when a thread you started reports back, the reply that ends each one goes back too and wakes that thread. Keep those replies short when nothing has changed."
- **Follow-up report preamble.** "Report from thread "X" (<id>), which took another turn on its own after its last answer. It's information from another agent, not instructions from the user."
- **`thread_start` and `thread_send` descriptions** (`threadTools.ts`). Add: "A thread you start can start threads of its own. Its final reply comes back to you and wakes you, and so does the reply ending any later turn it takes on that work." ACP agents learn rules only from descriptions.

### Rules that go

Every refusal that says a thread started by another thread can't direct threads:

- `DEPTH_REFUSAL` in `callerRefusal` (`packages/shared/src/childThreads.ts:73-85`), which `childStartRefusal`, `childSendRefusal` and `leadPassRefusal` all call.
- The handlers' own checks through `depthRefusal()` (`threadToolHandlers.ts:521`): `threadStart` :928, `ownChild` :1740 (local send and stop), `remoteSend` :2139, `remoteStop` :2212, `threadWrap` :2282. The first, second and last go. The two remote ones are replaced by the linked-computer rule below.
- `thread.create` refusing a parent that is itself an attached child (`decider.ts:1552`).
- `decideChildrenStop`'s refusal of an attached caller (`childThreadDecisions.ts:1805`). Its twin for threads on another computer (:1824) stays, as part of the linked-computer rule below.
- Put back's "is part of another thread's family" and "has started threads of its own" (`childThreads.ts:249-254`). A cycle can't form: `parentThreadId` is set once at creation, and put back only re-attaches to that thread.
- The words "one level deep" wherever they state the rule: the "Depth 1" bullet in `child-threads.md:141`, code comments (`childThreads.ts:63`, `threadToolHandlers.ts:521`, `Sidebar.logic.ts:1076`, `decider.ts:1538`), and the contracts comment at `orchestration.ts:5341`. `fleet.md:1347` changes to say a move carries one level.

Kept:

- A thread messages, stops and wraps only threads it started (`ownChildRefusal`). R reaches G only through M.
- The lead chat cannot pass to an attached child (`childThreads.ts:351`), and a lead is top-level.
- "Agents can start threads" (off, ask, automatic) and "Threads can share a checkout" apply at every level. In ask mode the approval card shows in the thread whose agent asked. The root's sidebar line counts it as "needs you".
- Five threads per call.

### Stop

Stop is the only brake Will kept, so it has to reach everything, and it must not come off by itself.

- **The Stop button stops the thread and every thread under it.** `thread.turn.interrupt` is what the composer's Stop and an outside agent's stop send (`ChatView.tsx:6535`, `connectToolHandlers.ts:2348`). Its decision keeps what it does today to the thread itself, and in the same decision stops every attached descendant that is not at rest. This is T3 Code's rule (`ThreadManagementService.ts:1743`), and it replaces "children keep running" from `child-threads.md`. With reports climbing on their own and no limits, a subtree left running can keep itself going with nobody watching, and it spends the user's usage. A stopped turn can be resumed with a message. Spent usage can't be taken back. Will has not confirmed this yet (see "For Will to decide").
- **Not at rest** means the thread has a session that is not stopped, a queued message, a pending start, or an open request of its own. It is wider than "working" on purpose. A thread that is idle with a check-back or a background task pending would otherwise start a turn later.
- **A stop has a cause, and the cause decides the hold.** Today every stop runs `decideAgentChainStop`, which leaves the durable hold (`agentRequests.hold`) on a thread in a room or with an agent's message in its queue (`agentRequestDecisions.ts:1019`). A held thread's agent can't start or message threads (`callerRefusal`), and a parent's request does not lift the hold (`decider.ts:3970`). With one rule for every stop, a subtree stop would leave M and G held, and after the user wrote to R the team would stay stuck. So `thread.session.stop` takes a server-only cause, and the chain stop reads it:
  - **The user's Stop** (`thread.turn.interrupt` on the named thread). The hold always goes on when the thread is an attached child, has attached children or has open child requests. The thread's chain epoch and delivery epoch always move. So its own work for its parent is dead (rule 3), and so is everything its threads were doing for it.
  - **Stopped with its family** (a descendant of that Stop, a child stopped by `thread_stop`, "Stop N working threads"). No hold. Its epochs move, its queue is cleared of agents' messages, and it takes its parent's next message without the user writing in it.
  - **Cleanup** (archive, delete, the sweeper, a move, a link: `ws.ts:1349`, :1440, `ThreadAutoArchiveSweeper.ts:151`, `LinkRequests.ts:1268`). No hold, and no cascade. An archived thread that comes back must take work again.
- **Only a person lifts the hold.** Today the hold is lifted by any queued or sent message that isn't marked as an agent's (`decideFollowUpSubmit` `decider.ts:1049` and :1092, `thread.turn.start` :3970, and the in-memory `queueHeldByStop` at `ProviderCommandReactor.ts:6027`). A scheduled run (`ScheduledTasks.ts:1755`) and an automatic fix (`PullRequestAutomationWatcher.ts:595`) carry no mark, so either one releases a stopped thread with nobody writing. New: every one of those paths lifts the hold only for a message a person wrote (`composer` or `sentFrom`), the test the lead's pass block already uses. This changes rooms too, and is the right behavior there for the same reason.
- **What the stopped thread can still do.** A thread's own check-backs survive the Stop button (Claude's interrupt cancels the turn and its queue only, `ClaudeAdapter.ts:10499`), as they do today for every thread. Such a turn still runs. It can't message the thread's children, because the hold is on, and it wakes nobody above, because the work it belongs to is dead.
- **What stopping a descendant does.** What `thread.children.stop` does to a child today (`childThreadDecisions.ts:1781`): its parent's requests for it settle `stopped` with no report, its parent's messages still queued in it are taken back, the reports it queued upward are unqueued, the turn it was cut off in is stamped handed back, its attachment epoch moves, and its session is stopped with the family cause. Targets are found by walking `parentThreadId` from the thread records before anything is settled, so stopping M first can't hide G.
- **Stop inside a middle thread** stops M and everything under M. R hears as today if a request for M was open ("The user stopped 'M' before it finished."). M then has the hold, so `childSendRefusal` refuses R's later sends to it with the words the lead's pass already uses: "The user stopped that thread. It takes work again once they write there." Today such a message sits unseen in M's queue.
- **"Stop N working threads"** (`thread.children.stop` without ids) stops the whole subtree under the row, and N counts working threads at every level. The thread itself keeps running and gets no hold.
- **`thread_stop` from an agent** stops that child and everything under it. It returns `stopped` when anything in that subtree was not at rest, and `not_running` only when all of it was (`childHasWork`, `threadToolHandlers.ts:333`, reads the subtree).
- **An outside agent's stop** reaches only the descendants that agent may stop itself. `outsideStopRefusal` (`outsideTurns.ts:158`) is asked for each one. A descendant the user gave more access than that agent's limit keeps running, and the tool's answer names it.
- **A visible Stop while the root is idle.** A root that waits on its team has no running turn, so its composer shows no Stop button, and today the only brake is in the row's menu. The chat's family tab row gets a plain "Stop N threads" button at its end while any thread under the open thread is working. It sends the same command as the menu item. This one is a proposal. Drop it if the menu is enough.

### The idle reaper

`ProviderSessionReaper` closes a session after 30 minutes idle by writing the session as `stopped` (`ProviderSessionReaper.ts:441-475`). `settleStoppedAnswers` (`ChildThreadReactor.ts:345`) then tells the parent "The user stopped" the child for any open `running` or `awaiting_background` request.

- The reaper's stop carries its cause in the same write that marks the session stopped, so the mark is stored before anything can settle on it. The reactor reads it from the stored session.
- An `awaiting_background` request then settles `answered` with its answer so far, as it does after a restart. A `running` one settles `failed` with "'<title>' went idle and its session was closed. Send it a message with thread_send to continue."
- A middle thread that waits on its threads holds no request from above, so being reaped costs it nothing. Its child's report starts its session again. The reaper leaves its requests, its epochs and the hold alone, and a test pins that.

### Wrap, archive, delete, separate, put back

Each is one decision, as today. The subtree is found with one shared walk (see "Data model").

- **Outstanding work** is the test for wrapping, and it is not the Stop test. A thread has outstanding work when `childHasLiveWork` says so (`childThreadDecisions.ts:1721`): a running turn, an approval, a question, a plan, awaited background work, a queued message, or an open request of its own, which includes a start still waiting for the user's yes. An idle session that is merely still open does not count. A finished turn leaves the session `ready` until the reaper closes it (`ProviderRuntimeIngestion.ts:3477`), so the Stop test would call every finished thread busy for half an hour.
- **Auto-wrap** (`isThreadDone`, `Sidebar.logic.ts:883`). Today nothing stops M from wrapping itself the moment its first answer goes back, while G still works (`canMarkThreadDone` ignores child waits, :762). New condition on the handed-back rule: an attached child does not count as done while it has open requests of its own (`awaitedChildThreadCount`, which covers a start not yet made into a thread) or while any thread under it is working, waiting, or needs the user. The "its parent is done" rule stays and already recurses (`resolveDone`, :1106).
- **`thread_wrap`** returns `working` for a child when it or anything under it has outstanding work (`agentWrapRefusal`, `childThreadDecisions.ts:2098`). Wrapping a finished M wraps M only; its finished threads follow by the "parent is done" rule.
- **Wrapping a thread by hand** keeps decision 4: nothing under it stops. Its open requests are cancelled and its delivery epoch moves, so reports to it are dropped. Its live children stand on their own in the sidebar with "↳ <title>", as a wrapped parent's children do today.
- **Archive.** The cascade walks down. A settled attached descendant is archived and stamped `archivedWithParentAt` with the root's archive time. A live one is separated from its parent and keeps everything under it. The walk does not go below a thread it separated. Unarchive restores every thread stamped by that archive (`childArchivePlan` `decider.ts:2068`, `childrenArchivedWith` :2163). The auto-archive sweeper skips a thread with a live thread anywhere under it.
- **Delete names what it deletes.** The dialog counts from the client's store, winds those threads down, and then sends the command, so the server's own idea of the subtree can differ by then (M may have started G in between). New optional `alsoDelete` on `thread.delete`: the ids the dialog listed. The server deletes exactly those that are still attached, unarchived descendants. Any other attached thread under a deleted one is separated and kept, with what is under it. Archived threads are never in the list and are never deleted this way, on either end: the client leaves them out today (`useThreadActions.ts:63`) and so does the server (`decider.ts:1916`). `withChildren` alone keeps today's meaning for an older client. The dialog's "Also delete its N threads" counts the subtree.
- **Separate** ("Make it its own thread"). The thread leaves with everything under it still attached to it.
- **Put back** works at any depth and for a thread with threads of its own. One new refusal: a thread that has threads on another computer (`remoteChildren`, or an open request to one) can't be put back under a parent. Today's check does not look at them (`childThreads.ts:252`).
- **Revert** rules are per pair and unchanged.

### Access, the lead's pass, linked computers, moves

- **A child on this computer never has more access than its parent, at every send.** Checked today at start (`decideChildStart`, `clampLaunchToCeiling`, `thread.create`). A send checks nothing (`childThreadDecisions.ts:702`), so a parent the user narrowed can still drive a wider child. New: `childSendRefusal` refuses when the child's access is above the sender's access now, and the decision that starts the queued message's turn checks again. Words: "'<title>' has more access than this thread has now. Do the work here, or tell the user, who can send it there." It refuses and does not lower the child, because agent traffic never changes a thread's settings (`decider.ts:4516`) and the lead's pass works the same way. Narrowing a parent does not reach down the tree by itself.
- **A child on a linked computer is not covered, and stays as it is today.** The send carries only a request id, a thread id and the text (`PeerSendInput`, `peerRpc.ts:360`), the other computer queues it at the thread's own access (`decideRemoteRequestQueue`, `childThreadDecisions.ts:1275`), and this computer does not know that thread's access. Refusing every such send would break linked families that work today. The fix is an optional ceiling on the peer's send that a newer computer enforces at turn start and an older one ignores. That is a peer contract change for a gap that exists without nesting, so it is a follow-up and not part of this build.
- **A lead's pass keeps its block down a chain.** Today a thread working on a pass can't start threads but can message its own (`childThreads.ts:121-127`, :165-188). With nesting, that child could start threads, and one lead message would fan out after all. New: a request sent by a thread whose `passCeiling` is set carries it in a new optional `fromThread.inheritedCeiling`. The decision that starts that message's turn sets the receiver's `passCeiling` (the narrowest, as passes do), and refuses the turn if the receiver's access is above it. The receiver's own sends carry it further. It is a new field and not `fromThread.ceiling`, which means "this is a lead's pass" in the preamble (`ProviderCommandReactor.ts:2262`) and in `answersHeldableRequest`. The block lifts when a person writes in that thread (today's reset), or when its parent's next request arrives without a ceiling, which can only happen after a person wrote in the parent.
- **Linked computers stay fenced.** A thread another computer started here still gets no thread tools (`isLinkFenced`). New fence: an attached child cannot start a thread on another computer ("A thread another thread started can only start threads on its own computer."), and `remoteSend` and `remoteStop` refuse the same way. So a nested tree lives on one computer, a subtree stop never crosses a link below the first level, and a report from another computer only ever arrives in a top-level thread.
- **A thread in a family deeper than one level does not move to another computer.** The rule covers every member, not only the root. Today an attached child may move alone and stay its parent's child across the link (`threadMoveDecisions.ts:291-307`). With R, M and G, moving G alone would leave M owning a thread on another computer, which the fence above says cannot exist. So `threadMoveRefusals` refuses a thread when its family tree has more than one level: its parent is itself an attached child, or it is an attached child with attached children, or one of its children has attached children. The check runs at admission and again when the move starts, because `decideMoveStart` re-runs the same function (`threadMoveDecisions.ts:900`). Words only, since the refusal codes are a closed set older peers decode: "This thread is part of a family more than one level deep, which can't move yet. Make it its own thread first." The web's move dialog and quit dialog show the reason (`threadMove.ts:898-1005`). Moving a nested family is a follow-up.
- **Outside agents and assistants** keep their own tool set. A thread one of them started stays fenced. A message one of them sends into a child is the user's own conversation: its turn has no work and is not reported upward.

### Sidebar

Today a grandchild has no row at all, because `familyParentKeyOf` looks one step up and only a row with no parent draws children (`Sidebar.logic.ts:1573`, `buildInboxSections` :1916).

- **One family per root.** A family is a live thread with no live attached parent, plus every thread reachable from it down attached links, as long as each link's parent is still in the live family. `familyParentKeyOf` stays the direct parent. A new `familyRootKeyOf` walks up, with a visited set.
- **Open family.** Every member gets one line, in tree order. Each thread is followed by its own threads, in creation order within a level. The first level sits where child rows sit today. Each level below is indented one step (12px), and the indent stops growing after two steps so titles keep room on a phone.
- **Summary line** on the root: dots and counts cover the whole family ("7 threads · 1 needs you"). There is one chevron per family. Middle threads get no summary line of their own.
- **Collapsed family.** It still shows any member that needs the user and the one open in the chat. They show without indent, because the rows that would explain the indent are hidden.
- **Wrapped members.** A wrapped member leaves the live family (`hasLeftLiveFamily`, :1628) only when no thread under it is still in the family. In Wrapped it holds its own wrapped threads inside it, at any depth, and its count is the subtree's.
- **A live thread under a wrapped parent** stands alone with "↳ <parent>" as today, and it now heads a family of its own. It draws its threads and gets a summary line. Today those threads vanish.
- **Fold, keys and attention.** A family still takes one seat. It has attention when any member has a status pill (`inboxLiveRowHasAttention`, :2098). `orderedThreadKeys` equals the rendered rows.
- **Menus and hover cards.** Every member's row gets "Stop N working threads" for the threads under it, "Make it its own thread", and the rest of a child row's menu. The hover card names the direct parent ("Started by <parent>") and, for a thread with threads, counts those under it.
- **Filters.** Project and computer scope apply to the root, and the family travels with it.

### Chat

- **Family tabs** (`familyTabs.logic.ts:74`, `lead-chat.md` "Family tabs"). The row shows the whole family the sidebar shows, root first, then every member in the sidebar's order. One function decides membership for both, as the lead chat design requires. It shows on every member while the root is live. A tab below the first level carries the small corner arrow the sidebar uses for "started by", and its tooltip names its parent. The "+N" menu indents its rows by level. The root's tab and the open thread's tab stay on the row.
- **Header chip, cards, pill.** "Started by <parent>" names the direct parent, which is right at any depth. "Started N threads" cards list the threads that turn started. "Waiting · N threads" counts the thread's own open requests. A root whose team is working with no request open shows no wait pill; its sidebar line and tabs show who is working.

### Data model

- **The route.** `OrchestrationTurnRoute` and `WorkRef` as above. Optional `route` on `thread.turn-start-requested`, on the pending start, on the turn row and on `OrchestrationLatestTurn`. New server-only command `thread.turn.route.record` and its event for turns the provider starts.
- **Work on what agents queue.** Optional `upstream` on `OrchestrationChildRequest` and on a room hand-off's `OrchestrationAgentRequest`. Optional `work` on `OrchestrationQueuedFollowUp`. Optional `upstream` and `followUp: true` on `ThreadMessageOrigin` (`fromThread`). The work a check-back was set under is kept beside the thread's check-backs by id.
- **The report.** New server-only command `thread.turn-report.settle` on the child's turn: outcome, text, optional error. It replaces rev 2's `thread.child-report.deliver`. Its ids are derived from the child and turn. It emits a new event on the child that closes the route's report as `sent` or `dropped` with the reason, plus, when sent, events that exist today: `thread.message-sent` and `thread.follow-up-queued` on the parent, `thread.handed-back` on the child.
- **Stop.** A server-only `cause` on `thread.session.stop` (`family`, `cleanup`), which the Normalizer refuses from clients. The chain stop can move the chain epoch without leaving the hold. The reaper's cause on its session write.
- **Steering.** An event that marks a queued entry as being steered.
- **`thread.delete`**: optional `alsoDelete: ThreadId[]`.
- **`fromThread.inheritedCeiling`**, and `passCeiling` set from it through the projection that sets it for a pass today (`childRequestStateOn.leadPass`), cleared by `thread.child-requests-reset`.
- **Shared walk.** `attachedDescendantsOf(threads, rootId)` in `packages/shared/src/childThreads.ts` returns the subtree in tree order with each thread's level, with a visited set. The server's stop, wrap, archive, delete and move rules and the web's sidebar, tabs, menus and delete dialog all use it. `attachedChildrenOf` (`childThreadDecisions.ts:192`) stays for the places that mean direct children.
- **Migration.** One additive migration: a route column and a report-state column on `projection_turns` and on the pending start, and a partial index on report state `owed` for the startup scan. No existing row is rewritten. The builder times the index build on a copy of a real `state.sqlite`.
- **Older clients.** Every new field is optional. The builder confirms an older client decodes a thread, a message and a queued entry that carry them, as Part 1 did for the counters.
- **No new shell fields.** The clients already hold every thread's `parentThreadId` and `attachedToParent` and compute the tree.

### Every surface

- **Entry points.** The composer's Stop, the sidebar row menu, the family tab row (tabs and the proposed Stop button), the delete and archive dialogs, the move dialog and the quit dialog. The command palette has no family actions and gets none. There is no keybinding for any of this.
- **Clients.** Web and desktop share the components. The phone uses them over the relay, so the indent and the tab row need a check at phone width. A phone or another computer on an older version shows a nested family the way it shows one today (grandchildren missing from the sidebar) until it updates. Its Stop and "Stop N working threads" still stop the whole subtree, because the server decides. Its delete sends `withChildren` and deletes one level, as it counted.
- **Providers.** Every provider that gets thread tools today gets them in a child the same way (Codex, Claude, OpenCode, and ACP agents that take HTTP MCP). No driver changes. A report is steered into a running turn where the provider can steer and waits behind the turn where it can't. Only Claude reports check-backs with ids today; on any other provider a self-started turn takes the previous turn's work. Community agents get the behavior only through the generic core.
- **Contracts.** Everything under "Data model".
- **Reverse states.** Stop on a thread and a person writing there. A subtree stop and the next message from above. Archive and unarchive of what that archive stamped. Separate and put back at any depth. Delete has no way back, so it deletes only what the dialog listed.
- **The app guide.** The child-threads topic (`apps/server/src/guide/topics.ts:110-124`) changes in four places: threads can start threads; a thread that keeps working on its parent's work after its answer now wakes its parent with each reply; Stop on a thread stops the threads under it, and "Stop N working threads" covers every level; a thread another thread started only starts threads on its own computer. The rooms topic gains one line: after Stop, only your own message sets the agents going again. The lead chat topic's line on a pass target (:144) gains "and neither can the threads it messages". No setting row moves, so `appPlaces.ts` is unchanged.
- **Docs.** `child-threads.md` (Depth 1, Delivery, Late replies, Stop, put back, archive, delete), `lead-chat.md` (family tabs, no fan-out, the usage-limit rule for report turns), `fleet.md:1347`, `rooms-slice-2.md` (what lifts a Stop).

### Tests (extend existing files)

- **Shared rules** (`childThreads` tests). An attached child may start, send, stop and wrap. Put back is allowed for a thread with threads of its own and refused for one with threads on another computer. A send is refused when a local child has more access than the sender has now, and when the child is under the user's hold. `attachedDescendantsOf` returns tree order and levels and survives a cycle in bad data.
- **Routes** (decider tests, commands in and events out). One case per row of the route table. Two agents in R share M: A's task starts G, B's task is answered, G's report then starts a turn in M whose work is A's. A person's turn sets a check-back, an agent's turn follows, the check-back turn has no work; and the reverse order has the agent's work. A continue of a person's turn has no work. A turn whose request was cancelled when its agent left keeps `answers` and sends nothing.
- **Reports** (`childThreadDelivery` tests, pure, and decider tests for the settle).
  - A completed owed turn is sent; a failed one sends the failure text; a stopped one and one with no reply are dropped; a second settle of the same turn is refused.
  - Each epoch on its own: `thread_stop`, separate and put back, wrap and reopen, and the user's Stop in the child each drop a completion that arrives afterwards.
  - A check-back set before the user's Stop in M ends a turn after it, and R is not woken.
  - A hand-off's answering turn sends nothing up, whatever order the hand-off settle and the turn end are handled in; the asking agent's next turn reports once.
  - A failed start settles a request `failed`, and sends a failure report for an owed route.
  - A message-started turn in a child settles an `awaiting_background` request first.
- **Late replies.** Only a dropped report is read. An owed one is not, and an outside assistant's turn is not.
- **Steering.** A report for other work is not steered into a person's turn and starts its own. An entry marked as being steered is sent after a restart with the "may have read it already" line.
- **Stop** (decider tests).
  - `thread.turn.interrupt` on a root with three levels: every descendant not at rest is stopped in one decision, the root has the hold, no descendant has it, even one that is a room or had an agent's message queued.
  - After that stop a person writes to the root, the root sends M, M runs and sends G, G runs. Nobody wrote in M or G.
  - A scheduled run and an automatic fix in a stopped thread do not lift the hold, in a family and in a room. A person's message does.
  - Archive and unarchive of M leave no hold on it.
  - `thread.children.stop` with an idle M whose child works stops the child.
  - An outside agent's stop leaves running a descendant above its limit and names it.
- **Wrap, archive, delete.** `thread_wrap` wraps M when G finished and its session is still open, and returns `working` while M has a start waiting for approval. Archive and unarchive of three levels with one live thread in the middle. Delete with `alsoDelete` deletes the listed threads and separates one started after the list was made; `withChildren` alone deletes one level.
- **Pass and access.** A request from a pass-blocked thread sets the receiver's block; the receiver can't start threads; the block lifts on a person's message and on an uncapped request from its parent.
- **Reactor and ingestion.** G's report starts M's turn and M's reply reaches R and starts R's turn. Startup settles an owed route whose turn completed before the crash, sends one interruption report for a cut-off owed turn and none for a cut-off answering turn, and ignores turns with no route. A reaped child's `awaiting_background` request settles `answered`, with no "user stopped".
- **Handlers** (`threadToolHandlers` tests). Each tool from an attached child; `thread_stop` returns `stopped` for an idle child with a working thread under it; a start on another computer from an attached child is refused.
- **Moves.** With R, M and G: R, M and G are each refused, at admission and at the start of the move.
- **Web logic.** `Sidebar.logic.test.ts` ("child thread families"): tree order, levels, subtree counts and dots, the collapsed set, the root key walk, a wrapped middle thread with a live thread under it, a live thread under a wrapped parent heading its own family, a middle thread that does not auto-wrap while a thread under it works or while it has a start waiting. `familyTabs.logic.test.ts`: the tabs equal the sidebar's members for a root, a middle thread and a leaf. `threadMenu.logic.test.ts`: the subtree count. Delete has no test today; add one for the ids it sends.
- **Browser.** `InboxRows.browser.tsx` and `ChatView.sidebar.browser.tsx`: three levels render under one root, open and collapsed. `ChatView.agents.browser.tsx`: the tab row for three levels. Polish shots with the real fonts at desktop and phone width.
- **Live**, on a throwaway stack (never `~/.threadlines/userdata`). A Claude root starts a child that starts a grandchild. The grandchild's answer reaches the root and wakes it. A check-back in the middle thread wakes the root. Stop on the root stops all three, and a check-back left in the middle thread does not wake the root afterwards. A restart with the grandchild mid-turn recovers up to the root. A Codex child in the chain covers a provider that queues reports instead of steering them.

### Build steps

Steps 1 to 4 touch the same server files and are built in order by one builder. Step 5 runs beside steps 2 to 4 in its own worktree once step 1 is committed.

1. **Shared rules and contracts.** `attachedDescendantsOf`, the removed depth refusals in `childThreads.ts` and in `thread.create`, the access and hold refusals on send, the linked-computer refusal, every field and command under "Data model", the migration. Shared tests. The handlers' own depth checks stay for now, so no agent can nest a thread yet and nothing changes for a user.
2. **Routes.** Work on requests, hand-offs, queued entries and reports; the route on every turn start; `thread.turn.route.record` for turns the provider starts; check-back work. Nothing reads a route yet, so this step changes no behavior and can be checked on its own: the route tests, and a run of today's one-level families with the routes inspected.
3. **Reports.** The report settle, the epoch checks, failed starts, the steering rule and its mark, late replies reading dropped reports, the wider `settleCandidateBeforeUserTurn`, continue at reset for middle threads, startup recovery, the reaper's cause. This changes one thing for today's one-level families: a child's later turns on its parent's work now wake its parent.
4. **Lifecycle, then the switch.** Stop causes and the hold, what lifts the hold, the subtree stop, `thread.children.stop` and `thread_stop` on a subtree, the outside agent's stop, the wrap rule, archive, unarchive and delete, put back, the move refusal, the pass block's inheritance. Last, the handlers' depth checks go and the preambles and tool descriptions change. Nesting becomes reachable only in that last commit. Guide topics and the docs.
5. **Web.** The family tree in `Sidebar.logic.ts` and its rows, the summary line, the auto-wrap condition, family tabs, menus and counts, the delete dialog and its ids, the move and quit dialogs, the proposed Stop button on the tab row. Before and after shots.
6. **Gates and the live run.** `vp fmt`, `vp lint`, `vp run typecheck`, the targeted tests, `@threadlines/web#test:browser`, then the live list above.

Part 2 ships as one pull request. Review: Astra reviews the diff of each of steps 2, 3, 4 and 5 when it is done. Step 3 is the risky one. It changes when a parent is woken.

### For Will to decide

1. **Stop reaches the threads under a thread.** Still open. The plan says yes, as T3 Code does. It changes today's rule, where a parent's Stop leaves its threads running. The alternative keeps today's rule and relies on "Stop N working threads", which then has to be found in a menu while a subtree keeps itself going. If the answer is no, the cascade bullet goes and the rest of "Stop" stands: the causes, the hold, and what lifts it are needed either way.
2. **The "Stop N threads" button on the tab row.** Still open. Proposed so the brake is on screen while a root waits. The plan works without it.

Two things Will should know about, decided here because they are fixes:

- **Only a person's message lifts a Stop.** Today a scheduled run or an automatic fix lifts it. This changes rooms as well as families.
- **A child on a linked computer can still be sent work by a parent the user has since narrowed.** That gap exists today and this plan leaves it. Closing it needs a change to what linked computers send each other.

Decided here on the grounds Will gave: no limits of any kind; a parent woken by every turn a child finishes on that parent's work, check-backs included; nested trees stay on one computer; no thread in a nested family moves to another computer yet.

## Review of Part 2, rev 1 (GPT-6.2 Astra, Nov 23 2026)

Checked against the code; each holds. Under each finding is how rev 2 answered it, and what rev 3 changed where the second review showed the answer was not enough.

1. **Pending reports are owed work too.** A child's request leaves `open` when its report is queued, not when the middle thread has read it. M with G1 and G2: G2 settles while M handles G1's report on a provider that can't steer, so M's turn ends with zero open requests and R gets the G1-only answer.
   - Rev 2: nothing above M waits on M's threads, so there is no "owed work" to count. M's G1 turn and its G2 turn each go up as a report (delivery rule 2).
2. **Downstream work needs the upstream request's identity.** R sends M a second task while the first waits on G: M's second turn sees G open and becomes a candidate too; G's report steered into it answers the wrong request. In a room the two requests can come from different agents.
   - Rev 2: a request answers only to the turn its own message started (rule 1), and a follow-up report belongs to no request (rule 3). What is left is which agent of a two-agent room is woken, stated in rule 3. Rev 3: the right agent is woken. A request, a report and a queued message each carry the work they belong to ("The record").
3. **The session reaper (`ProviderSessionReaper.ts`, 30 minutes idle) stops an idle middle thread** whose children are still working, and `ChildThreadReactor.settleStoppedAnswers` then tells R "the user stopped" M. Runtime eviction must not read as a stop.
   - Rev 2: the reaper marks its stop and the reactor settles by that mark, never as the user's Stop ("The idle reaper"). A middle thread waiting on its threads holds no request from above, so being reaped costs it nothing. Rev 3: the cause is written in the same session write as the stop, so nothing can settle before it is stored.
4. **Restart** settles R before M's queued report replays (M has zero open requests once G settled), misses a report turn that completed before the crash (recovery only matches `pendingMessageId === null` continuations), and delivers M's first turn when its `awaiting_background` update didn't commit.
   - Rev 2: the first and third cases need a request held across M's turns, which no longer exists. The second is rule 10: a cut-off report turn tells the parent through `thread.restart.continue`, and one that completed just before the crash is recovered at startup. Rev 3: startup settles every report still owed, read from the turn's own record. The two-minute window is gone, and a cut-off answering turn no longer gets a second report (rule 11).
5. **A room hand-off in M** goes through `thread.turn.start` without `fromThread`, so `settleCandidateBeforeUserTurn` sends R the candidate while G works.
   - Rev 2: that is now the rule for every message-started turn (rule 8), and it is safe because what M finishes later goes up as follow-up reports. A turn that answers a hand-off inside M is not reported itself; the turn of the agent that asked is (rule 2). Rev 3: the hand-off's answering turn is marked `inRoom` when it starts, so it does not matter that the hand-off is settled before the turn end is routed.
6. **Usage-limit continue** (`isHeldByContinueAtReset`) requires `running` and the failed turn's own message; an `awaiting_background` request continued by a report turn fails at once.
   - Rev 2: no request rides on a report turn. The turn itself waits and continues (rule 9), a failed turn stays silent while that wait is armed, and the failure goes up if the wait ends with no continue (rule 4). Rev 3: the wait arms only for the thread's own agent. A named room agent's report turn that stops on a limit reports its failure at once, so the parent is told either way (rule 10).
7. **Reports with no local attached child** (a remote G with `environmentId`, a `neverMade` G) still start turns in M; and a queued report taken back (separate, wrap, room departure) triggers no re-check.
   - Rev 2: rule 2 reads how M's turn started, not who the report came from, so a `neverMade` report's turn reports like any other. A report from another computer can't arrive in a middle thread (the linked-computer fence). Nothing is held, so a report taken back needs no re-check. Rev 3: the second review showed a lone move could put a grandchild on another computer. No thread in a family deeper than one level moves now.
8. **The MCP handlers have their own depth checks** (`threadToolHandlers.ts` start, local ownership, remote send, remote stop, wrap), separate from the shared and decider rules listed above.
   - Rev 2: all five are listed under "Rules that go" with line numbers. Start, local ownership and wrap go. The two remote ones become the linked-computer fence.
9. **Nesting lets a lead pass escape its ceiling** (T passes to its existing child M, which carries no pass block and starts G), and ordinary sends don't re-check the parent's current access when the user narrowed it after the child was made.
   - Rev 2: a blocked thread's requests carry the block down (`inheritedCeiling`), and every send checks the child against the sender's access now ("Access, the lead's pass, linked computers, moves"). Rev 3: the send check covers children on this computer. A child on a linked computer is left as it is today, and the doc says so.
10. **Delete with its threads** would delete more than the dialog counted (`useThreadActions.ts` counts direct children only and winds down only those).
    - Rev 2: the dialog counts and winds down the subtree and sends `withDescendants`. `withChildren` alone keeps its one-level meaning, so an older client deletes exactly what it counted. Rev 3: the command names the threads the dialog listed (`alsoDelete`), and the server deletes only those.
11. **Agent-issued subtree stop** returns `not_running` for an idle M whose child works (`childHasWork` ignores M's own requests), and stopping M first settles the requests used to find the rest.
    - Rev 2: `childHasWork` reads the subtree, and targets come from walking `parentThreadId` on the thread records before anything settles ("Stop"). Rev 3: a stop has a cause, and a thread stopped with its family gets no hold, so it takes its parent's next message.
12. **Late replies and moves** assume one level (`lateRepliesForAgent` returns early for an attached thread; move admission and whole-family moves refuse or flatten a middle parent).
    - Rev 2: the early return goes (rule 7). A family deeper than one level is refused a move with its own words, where today it would leave grandchildren behind. Moving one is a follow-up. Rev 3: late replies read only reports that were dropped (rule 8), and the move refusal covers every member of a nested family.
13. **The chat's family tabs** (`familyTabs.logic.ts`) list a parent's direct children only and would disagree with a nested sidebar.
    - Rev 2: the tabs show the same members in the same order as the sidebar, from one function ("Chat").

Atomicity is fine: the engine commits one decision's events in one transaction, and `decideCommandSequence` projects each step before the next. The counter fields can go from storage, but older clients need them on the wire (kept, see Part 1).

The review's closing suggestion was to weigh T3 Code's own direction: every completion of a child that isn't the user's own conversation with it wakes its parent with a report, and no request is held open across the middle thread's turns. Rev 2 takes it. It removes findings 1, 2, 4, 5 and 6 at the cost of the parent being woken more often, which is the risk Will accepted. Findings 3 and 7 to 13 are answered above.

## Review of Part 2, rev 2 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 2 (commit 956654b68) from the code and accepted the decision to settle each request with its own answering turn. It found 13 problems in the rest. Each was checked against the code. All 13 hold; two are narrower than stated, and the lines below say where. Under each is how rev 3 answers it.

Astra also suggested solving several at once by recording each turn's cause durably and capturing the epochs for the work being reported. Rev 3 does that ("The record"). It answers findings 3, 6, 7, 8 and 9 and the failed-start half of 10. It does not answer 11 by itself. That loss happens between the provider and the queue, so it needed its own mark on the queued message.

Stop and access:

1. **Stop can strand the team, and can come off without the user writing.** A subtree stop issues `thread.session.stop` per descendant, which runs the chain stop, so widening the hold would hold M and G, and R's next send would be refused. Archive cleanup has the same effect. In the other direction, a scheduled run's queued message lifts the hold.
   - Holds. Rev 3: a stop has a cause. Only the user's Stop on the named thread leaves the hold; a thread stopped with its family or by cleanup gets none. Every path that lifts the hold now needs a message a person wrote ("Stop").
2. **Stopping M does not stop M's own check-back from waking R.** Claude's interrupt leaves check-backs alive, and rev 2 tested the hold on R, not on M.
   - Holds. Rev 3: the user's Stop moves M's chain epoch, and a report is delivered only when the epochs of its work still match. A check-back set before the Stop belongs to dead work and wakes nobody (rule 3). It also can't message M's threads, because M is held.
3. **A delayed completion can cross a Stop, a separate and put back, or a wrap and reopen.** The deliver command carried no expected epochs, so it was accepted with the new ones.
   - Holds. Rev 3: the epochs are taken when the work begins and checked when the report is decided (rule 3).
4. **Linked-computer sends cannot enforce the access ceiling, and an outside agent's stop would reach a descendant above its limit.**
   - Both hold. Rev 3: the send check is stated for children on this computer only, and the linked gap is left as it is today, with the peer change named as a follow-up. An outside agent's stop reaches only the descendants that agent may stop itself.
5. **A lone move can create the cross-computer grandchild the plan says cannot exist.**
   - Holds. Rev 3: no thread in a family deeper than one level moves, checked at admission and when the move starts. Put back is refused for a thread with threads on another computer.

Delivery and recovery:

6. **Looking at what is open when a turn ends confuses an answer with a follow-up.** A hand-off is settled before the child report is routed, and an asking agent that leaves cancels its request mid-turn.
   - Holds for rev 2's rule (today's code never reads room requests there). Rev 3: the route is written when the turn starts. A hand-off's turn is `inRoom`, and a turn that answers a request keeps `answers` after that request is gone (rule 1).
7. **The wrong room agent is woken, and a check-back or a continue is credited to the wrong work.**
   - Holds. Rev 3: work travels with requests, reports and queued messages, so the recipient is the agent whose work it is. A check-back takes the work of the turn that set it, by its id. A continue takes the route of the turn it continues. One case stays by position: a turn the provider starts after background work, where the provider gives no id.
8. **The late-reply net can pass on an outside assistant's answer, repeat a report, or lose one when a report is steered into a person's turn.**
   - Holds. Rev 3: late replies read only reports that were dropped, never one still owed and never a turn with no work (rule 8). A report is steered only into a turn for the same recipient's work (rule 5).
9. **The two-minute startup window can't tell an upgrade from a crash, misses failed and older turns, and a restart can report an interruption twice.**
   - Holds. Rev 3: the window is gone. Startup settles the reports that are owed, which only turns started after this change can be, and a cut-off answering turn is recognised by its route (rule 11).
10. **A report turn that never starts leaves R waiting, and a named room agent's turn skips the usage-limit wait.**
    - The first holds, and today it also leaves a parent's request `running` for good. Rev 3: a failed start settles the route (rule 7). The second is narrower: the wait is still armed for a room agent's continue or its own user's turn, and only the "answers another thread" reason is left out. That turn does not wait, so its failure goes up at once and R is told (rule 10).
11. **A crash while a report is being steered delivers it twice.**
    - Holds, for answers today as well. Rev 3: the queued message is marked before the provider is called, and a marked message sent again after a restart says it may be a repeat (rule 6). Exactly once is not possible here.

Wrap and delete:

12. **`thread_wrap` refuses a finished subtree while sessions are merely idle, and misses a grandchild start that waits for approval.**
    - Holds. Rev 3: wrapping uses "outstanding work", which leaves out an idle open session and includes the thread's own open requests. Stopping keeps the wider test.
13. **Delete can remove a thread the user never confirmed.**
    - Holds. The wind-down is awaited, not left running, but the server still builds its own list after it. Rev 3: the command names the threads the dialog listed, and archived threads are left out on both ends.
