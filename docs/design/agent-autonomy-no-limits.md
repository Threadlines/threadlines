# Agents work without per-message limits, and threads nest

Status (Nov 23 2026): Part 1 is built. Part 2 is **not built**. It is on its fourth plan, after three reviews by GPT-6.2 Astra. Rev 1 held a parent's request open until the threads below had settled, which loses or misroutes answers. Rev 2 reports every turn upward instead, and that decision has held since. Rev 3 tried to route each report to the exact work and room agent it belonged to, and the third review showed that was not converging. Rev 4 below drops that routing for fixed rules and splits the build into two stages. All three reviews are kept at the end with the current answer under each finding. Asked for by Will: "do it all the T3 code way, we will accept the same risks that they are taking". The goal is a lead agent that directs other agents, in a room or in threads it starts, for hours or days without the user writing.

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

## Part 2: threads nest to any depth (rev 4)

Rev 4 is smaller than rev 3. Three reviews are at the end of this file, with the current answer under each finding. Line numbers are from commit 975bf136e.

The examples use three threads. R is the root, the thread the user talks to. M is a thread R started. G is a thread M started.

### Is this converging

Rev 3 was not. It tried to say exactly which piece of the parent's work every turn in a child belonged to, and which agent of a room that work was for, and to carry that through every way a turn can start. There are more than ten of those ways (a request, a report, a hand-off, a side review's reply, a check-back, background work, a continue, an account switch, a retry, a scheduled run, an automatic fix), and each review found some that the carrying missed. The provider cannot even supply what two of them need. That is a class of problem, not a list of bugs, so rev 4 removes the class:

| Rev 3 had                                                                                                  | Rev 4 has                                                                | What goes away                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Work carried on requests, reports, queued messages and hand-offs, so each report finds the agent it is for | One fixed rule: a thread's later reports go to the agent that started it | Every finding about the wrong agent, check-back ids, background guesses and replies that lost their route |
| A report steered into a running turn when the work matches                                                 | A middle thread reads each report in a turn of its own                   | Mixed answers, lost reports, and the mark for a crash while steering                                      |
| Late replies kept as a net for dropped reports                                                             | No late replies for threads on this computer                             | A dropped report that comes back, a report read twice                                                     |
| A failed turn that holds its report for the continue                                                       | A failed turn reports at once, every time                                | The handover to the continue, and what happens when a person or an account switch overtakes it            |
| Only a person's message lifts a Stop                                                                       | What lifts a Stop is left as it is today                                 | The scheduler regression and the change to rooms                                                          |
| A route on every turn row, with a migration                                                                | A short list on the child of the reports it owes                         | The migration, and state the decider could not see                                                        |

What rev 4 gives up for that, on purpose:

- In a room with several agents, a thread's later reports wake the agent that started it, even when another agent's task set the work going. An answer to a request still goes to the agent that asked.
- The lead can hear about work the user asked a middle thread for directly, when that work ends in a turn the user did not start (a check-back, a report from a thread it started). This is noise, not a leak: any agent in the project can read any thread with `thread_read`.

If another review finds a new class and not details, the scope to ship is stage 1 of the build steps alone (reports and Stop for today's one-level families), with nesting held back until that has run for real.

### The decision: every turn a child finishes on its own goes up as a report

Today a child talks to its parent in two ways. An **answer** settles a request the parent made, and wakes the parent. A **late reply** is work the child did afterwards with no request open. It wakes nobody, and the parent's agent reads it at its next turn (`lateReplyOf`, `childThreadDelivery.ts:381`).

With nesting, almost everything a middle thread does after its first answer is a late reply. M answers R "I started G1 and G2", and that settles R's request. G1's report then wakes M, M does the real work, and R never hears of it unless something else wakes R.

Three ways to fix that:

1. **Hold R's request open until M's own threads have settled** (rev 1). The first review showed five ways this loses or misroutes an answer. One request has to stay bound to a chain of M's turns that nobody planned, across restarts, usage limits and other messages arriving in M.
2. **Hold nothing, and report every turn** (T3 Code's `completionWake: "always"`, `OrchestratorMcpService.ts:2975`). R's request settles when M's answering turn ends, as today. Each later turn M finishes on its own goes to R as a new report and wakes R.
3. **Report only when M's whole subtree is quiet.** A stuck or days-long G would silence everything M learns in the meantime, and the server would need a re-check for every way a subtree goes quiet.

Every revision since rev 2 takes option 2. What it costs: R is woken once for every turn a child finishes on its own, and each piece of news climbs one turn per level. A middle thread that checks back every five minutes wakes its parent every five minutes. That is the risk T3 Code takes and Will accepted. The preamble tells a child that each of these replies wakes the thread above it.

### Delivery rules

1. **Requests are unchanged.** A request answers to the turn its own message started (`childDeliveryForTurnEnd`). It waits past that turn only for the child's own background tasks (`awaiting_background`), never for the child's threads.
2. **Which turns report.** A turn in an attached child on this computer owes its parent a report unless one of these is true. Each is read from the message that started the turn, when the turn starts, never from what is open when it ends:
   - The message is a request from its parent. That turn answers the request (rule 1) and is never anything else, even if the request is cancelled before the turn ends (the agent that asked left, `decider.ts:3355`).
   - A person wrote the message (`composer` or `sentFrom`, `personWrote`, `childThreadDecisions.ts:2145`), or an outside agent did (`fromOutside`).
   - The message is a hand-off from another agent in the same thread. That reply goes to the agent that asked (`routeHandOffReply`), and the turn that agent then takes reports.
   - The message is a continue (`trigger`: a usage limit reset, a restart, an account switch) of a turn a person or an outside agent started. A continue is judged by the turn it continues. If that turn answered a request and the request is moved onto the continue in the same decision, as continue at reset does today (`decider.ts:5473`), the continue answers it. In every other case the continue reports.

   Everything else reports: a report from one of its own threads, the reply to a hand-off or a review, a scheduled run, an automatic fix, and every turn the provider starts with no message (a check-back, background work that finished).

3. **The owed list.** The decision that starts a reporting turn adds an entry to a short list on the child: the turn, the parent's delivery epoch and the child's attachment epoch as they are then. The entry is the durable promise. It is removed when the report is settled, and the whole list is emptied when the child's attachment epoch moves.
   - For a turn a message starts, the decision that emits `thread.turn-start-requested` adds it, keyed by the message, before the provider has taken the turn.
   - For a turn the provider starts, ingestion says so on the session update that marks the turn started, and that decision adds it. If the parent holds an `awaiting_background` request for this child and the turn is not a check-back (the runtime says which, `TurnTrigger`), the entry names that request, and the turn's end settles the request as today's continuation does. If that request has gone by then, the turn reports as a follow-up.
   - The list lives in the thread's state, which the decider reads. No decision has to look up an old turn row.
4. **Settling a report.** When the turn ends, `thread.child-report.settle` decides it once and removes the entry.
   - Completed with a reply: delivered.
   - Failed: delivered as "'<title>' failed: <error>." followed by "It continues by itself when the limit resets." when the thread waits to continue at a reset, and by "Send it a message with thread_send to continue." otherwise. Nothing is held for the continue. The continue is a turn of its own and reports when it ends.
   - Stopped, or completed with no reply: dropped.
5. **When a report is dropped instead.** The decision delivers only if the entry's two epochs still equal the parent's delivery epoch and the child's attachment epoch, the child is still attached to that parent, neither is deleted, the parent is not archived, and neither thread is under the user's Stop hold. So a completion that crosses a `thread_stop`, a separate and put back, or a wrap and reopen is dropped, because each moves one of the two (`childThreadDecisions.ts:1416`, :1861, :1959). A dropped report stays dropped. Nothing reads it later.
6. **What a delivered report is.** A user-role message in the parent with `fromThread { threadId, requestId, kind: "report", followUp: true }` and a queued follow-up, as an answer is delivered today. The schema requires `requestId`, so it carries one derived from the child's turn. It goes to the agent that started the child, or to the thread's own agent if that one has left the room. The message carries the current epochs, so the existing checks before send still apply (`isCancelledReport`, `childThreadDecisions.ts:2223`). The text is clipped as answers are. The child is stamped handed back as of that turn, so it wraps itself as it does after an answer. The builder checks `pushAlertRules.ts`, which cancels a child's "done" alert on `child-request-settled`. A follow-up has no such event, and it must not alert the user each time a child reports.
7. **A middle thread reads each report in a turn of its own.** Today a report is steered into a running turn where the provider can steer (`steerQueuedAgentMessage`, `ProviderCommandReactor.ts:5489`). In an attached child, a report from one of its own threads is never steered. It waits and starts its own turn, which reports. So a report can't be swallowed by a turn the user started, and two tasks can't end up in one answer. A thread with no parent steers as it does today. Its turns report to nobody, so nothing can be lost there.
8. **A start that fails.** When preparing the provider fails or times out, no turn ever ends (`reportFailedStart`, `ProviderCommandReactor.ts:3427`), and today a parent's request for that child stays `running` for good. New: a failed start settles what its message owed. A request settles `failed` ("'<title>' could not start its turn: <error>"). An owed entry delivers the failure report. A start that is taken back on purpose before the provider took it (a report that went stale, a Stop while the turn was being prepared) removes its entry and sends nothing.
9. **No more late replies on this computer.** With rule 2, the only unasked work that does not reach the parent is work that was dropped on purpose. So `lateReplyOf`, `lateReplyRecipient`, `lateRepliesForAgent` and the `lateReplies` part of `thread.child-notes.delivered` go. Late replies that were unread at the upgrade stay in the child for `thread_read`. A child on a linked computer never had late replies and still doesn't.
10. **A message-started turn closes a waiting answer first.** `settleCandidateBeforeUserTurn` (`decider.ts:562`) runs today only for turns without `fromThread`. It now runs before every turn a message starts in the child. The request settles with its answer so far, and what the child does next goes up as reports.
11. **Continue at reset.** `reportsToTopLevel` (`decider.ts:929`) arms the wait for a report turn only in a thread with no parent. It drops that condition, so a middle thread's report turn continues by itself too. Whether it waits or not, its failure has already gone up (rule 4).
12. **Restart.** Startup settles every entry on every owed list whose turn has ended or never started. There is no time window, and turns from before the upgrade have no entry.
    - A turn that completed before the crash is delivered.
    - A turn the restart cut off, or that failed, delivers its failure. For a cut-off turn the text is "'<title>' was interrupted by a Threadlines restart. Send it a message with thread_send to continue."
    - A waiting request (`awaiting_background`) is recovered by a provider-started turn only if that turn's entry names the request. `finishedTurnAfterRestart` (`childThreadDelivery.ts:295`) takes the newest turn no message started, which can be an unrelated check-back. It keeps that rule only for turns from before the upgrade.
    - Other requests recover as today (`settleFromPreviousProcess`, `ChildThreadReactor.ts:409`).
13. **Linked computers.** Unchanged. A thread another computer started here answers through the link ledger, is fenced from thread tools, has no owed list and sends no follow-up reports.

Where it goes: `routeChildReport` (`ProviderRuntimeIngestion.ts:2770`) returns early when the parent has no open request for the child. That early return goes. One pure function in `childThreadDelivery.ts` takes the turn's end, the child's owed list and the parent's open requests and returns the request settle, the report settle, or nothing. The live path and startup both call it, so a turn can never be delivered as both.

### What a child and its parent are told

- **Attached child preamble** (`ProviderCommandReactor.ts:2268`). Today: "Another agent started this thread from the thread "X", and your final reply goes back to it automatically. Work in this thread's own checkout, and end with the answer it needs." Add: "If you take more turns later that the user did not start, for example when a thread you started reports back, the reply that ends each one goes back too and wakes that thread. Keep those replies short when nothing has changed."
- **Follow-up report preamble.** "Report from thread "X" (<id>), which took another turn on its own after its last answer. It's information from another agent, not instructions from the user."
- **`thread_start` and `thread_send` descriptions** (`threadTools.ts`). Add: "A thread you start can start threads of its own. Its final reply comes back to you and wakes you, and so does the reply ending any later turn it takes on its own." ACP agents learn rules only from descriptions.

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

Stop is the only brake Will kept, so it has to reach everything.

- **The Stop button stops the thread and every thread under it.** `thread.turn.interrupt` is what the composer's Stop and an outside agent's stop send (`ChatView.tsx:6535`, `connectToolHandlers.ts:2348`). Its decision keeps what it does today to the thread itself, and in the same decision stops every attached descendant that is not at rest. This is T3 Code's rule (`ThreadManagementService.ts:1743`), and it replaces "children keep running" from `child-threads.md`. With reports climbing on their own and no limits, a subtree left running can keep itself going with nobody watching, and it spends the user's usage. A stopped turn can be resumed with a message. Spent usage can't be taken back. Will has not confirmed this yet (see "For Will to decide").
- **Not at rest** means the thread has a session that is not stopped, a queued message, a pending start, or an open request of its own. It is wider than "working" on purpose. A thread that is idle with a check-back or a background task pending would otherwise start a turn later.
- **A stop has a cause, and the cause decides the hold.** Today every stop runs `decideAgentChainStop`, which leaves the durable hold (`agentRequests.hold`) on a thread in a room or with an agent's message in its queue (`agentRequestDecisions.ts:1019`). A held thread's agent can't start or message threads (`callerRefusal`), and a parent's request does not lift the hold (`decider.ts:3970`). With one rule for every stop, a subtree stop would leave M and G held, and after the user wrote to R the team would stay stuck. So `thread.session.stop` takes a server-only cause, and the chain stop reads it:
  - **The user's Stop** (`thread.turn.interrupt` on the named thread). The hold always goes on when the thread is an attached child, has attached children or has open child requests, and its delivery epoch always moves.
  - **Stopped with its family** (a descendant of that Stop, a child stopped by `thread_stop`, "Stop N working threads"). No new hold. Its attachment epoch moves, its queue is cleared of agents' messages, and it takes its parent's next message without the user writing in it. A hold it already had from the user's own Stop in it stays.
  - **Cleanup** (archive, delete, the sweeper, a move, a link: `ws.ts:1349`, :1440, `ThreadAutoArchiveSweeper.ts:151`, `LinkRequests.ts:1268`). No new hold, and no cascade. An archived thread that comes back must take work again.
- **What the hold does.** The held thread's agent can't start or message threads. Reports to it and from it are dropped (rule 5). `childSendRefusal` refuses a parent's send to a held child with the words the lead's pass already uses: "The user stopped that thread. It takes work again once they write there." Today such a message sits unseen in the child's queue.
- **What lifts the hold stays as it is today.** A message that no agent wrote lifts it: the user's, and also a scheduled run's or an automatic fix's (`decider.ts:1049`, :1092, :3970, `ProviderCommandReactor.ts:6027`). Those are automation the user set up, a schedule that targets a stopped lead keeps working as it does now, and rooms don't change. Rev 3 narrowed this to a person's message. That broke the scheduler, whose run would have sat queued and counted against later runs.
- **One automatic path is closed.** When a provider session falls back, the server resends the turn's message by itself (`processNativeSessionFellBack`, `ProviderCommandReactor.ts:6385`), and a resend lifts the hold (`decider.ts:4176`). `thread.turn.resend` already refuses a resend whose chain epoch has moved (`decider.ts:4025`), but the fallback sends no epoch. It now sends the epoch of the turn it resends, so one that arrives after a Stop is refused.
- **What the stopped thread can still do.** A thread's own check-backs survive the Stop button (Claude's interrupt cancels the turn and its queue only, `ClaudeAdapter.ts:10499`), as they do today for every thread. Such a turn still runs. It can't message the thread's children and it wakes nobody above, because the thread is held.
- **What Stop does not take back.** A report the thread had already finished and queued in its parent before the Stop still reaches the parent. The user stopped this thread, not the one above it, and today a child the user stops even tells its parent so. To stop the parent, stop the parent, which clears its queue of agents' messages.
- **What stopping a descendant does.** What `thread.children.stop` does to a child today (`childThreadDecisions.ts:1781`): its parent's requests for it settle `stopped` with no report, its parent's messages still queued in it are taken back, the reports it queued upward are unqueued, the turn it was cut off in is stamped handed back, its attachment epoch moves, and its session is stopped with the family cause. Targets are found by walking `parentThreadId` from the thread records before anything is settled, so stopping M first can't hide G.
- **Stop inside a middle thread** stops M and everything under M. R hears as today if a request for M was open ("The user stopped 'M' before it finished.").
- **"Stop N working threads"** (`thread.children.stop` without ids) stops the whole subtree under the row, and N counts working threads at every level. The thread itself keeps running and gets no hold.
- **`thread_stop` from an agent** stops that child and everything under it. It returns `stopped` when anything in that subtree was not at rest, and `not_running` only when all of it was (`childHasWork`, `threadToolHandlers.ts:333`, reads the subtree).
- **An outside agent's stop** reaches only the descendants that agent may stop itself. `outsideStopRefusal` (`outsideTurns.ts:158`) is asked for each one. A descendant the user gave more access than that agent's limit keeps running, and the tool's answer names it.
- **A visible Stop while the root is idle.** A root that waits on its team has no running turn, so its composer shows no Stop button, and today the only brake is in the row's menu. The chat's family tab row gets a plain "Stop N threads" button at its end while any thread under the open thread is working. It sends the same command as the menu item. This one is a proposal. Drop it if the menu is enough.

### The idle reaper

`ProviderSessionReaper` closes a session after 30 minutes idle by writing the session as `stopped` (`ProviderSessionReaper.ts:441-475`). `settleStoppedAnswers` (`ChildThreadReactor.ts:345`) then tells the parent "The user stopped" the child for any open `running` or `awaiting_background` request.

- The reaper's stop carries its cause in the same write that marks the session stopped, so the mark is stored before anything can settle on it. The reactor reads it from the stored session.
- An `awaiting_background` request then settles `answered` with its answer so far, as it does after a restart. A `running` one settles `failed` with "'<title>' went idle and its session was closed. Send it a message with thread_send to continue."
- A middle thread that waits on its threads holds no request from above, so being reaped costs it nothing. Its child's report starts its session again. The reaper leaves its requests, its epochs and the hold alone, and a test pins that.

### Wrap, archive, delete, revert, separate, put back

Each is one decision, as today. The subtree is found with one shared walk (see "Data model").

- **Outstanding work** is the test for wrapping, and it is not the Stop test. A thread has outstanding work when `childHasLiveWork` says so (`childThreadDecisions.ts:1721`): a running turn, an approval, a question, a plan, awaited background work, a queued message, or an open request of its own, which includes a start still waiting for the user's yes. An idle session that is merely still open does not count. A finished turn leaves the session `ready` until the reaper closes it (`ProviderRuntimeIngestion.ts:3477`), so the Stop test would call every finished thread busy for half an hour.
- **Auto-wrap** (`isThreadDone`, `Sidebar.logic.ts:883`). Today nothing stops M from wrapping itself the moment its first answer goes back, while G still works (`canMarkThreadDone` ignores child waits, :762). New condition on the handed-back rule: an attached child does not count as done while it has open requests of its own (`awaitedChildThreadCount`, which covers a start not yet made into a thread) or while any thread under it is working, waiting, or needs the user. The "its parent is done" rule stays and already recurses (`resolveDone`, :1106).
- **`thread_wrap`** returns `working` for a child when it or anything under it has outstanding work (`agentWrapRefusal`, `childThreadDecisions.ts:2098`). Wrapping a finished M wraps M only; its finished threads follow by the "parent is done" rule.
- **Wrapping a thread by hand** keeps decision 4: nothing under it stops. Its open requests are cancelled and its delivery epoch moves, so reports to it are dropped. Its live children stand on their own in the sidebar with "↳ <title>", as a wrapped parent's children do today.
- **Revert is refused while anything under the thread is not at rest.** Today revert is refused only while the thread has open requests or queued reports (`childRevertRefusal`, `childThreadDecisions.ts:2185`). With reports after the first answer, R can hold neither and still have G working for M. Reverting then would let M wake R about a task the revert removed. New: revert is refused in a thread while any attached thread under it is not at rest, by the Stop test, with today's words ("Finish or stop its threads first..."). "Stop N working threads" puts every one of them at rest, and then nothing under it can start a turn by itself.
- **Archive.** The cascade walks down. A settled attached descendant is archived and stamped `archivedWithParentAt` with the root's archive time. A live one is separated from its parent and keeps everything under it. The walk does not go below a thread it separated. Unarchive restores every thread stamped by that archive (`childArchivePlan` `decider.ts:2068`, `childrenArchivedWith` :2163). The auto-archive sweeper skips a thread with a live thread anywhere under it.
- **Delete names what it deletes.** The dialog counts from the client's store, winds those threads down, and then sends the command, so the server's own idea of the subtree can differ by then (M may have started G in between). New optional `alsoDelete` on `thread.delete`: the ids the dialog listed. The server deletes exactly those that are still attached, unarchived descendants. Any other attached thread under a deleted one is separated and kept, with what is under it. Archived threads are never in the list and are never deleted this way, on either end: the client leaves them out today (`useThreadActions.ts:63`) and so does the server (`decider.ts:1916`). `withChildren` alone keeps today's meaning for a client that has not updated, including today's small race: a direct child that appears between its count and the server's decision is deleted too. The old command has no way to say which threads it meant.
- **Separate** ("Make it its own thread"). The thread leaves with everything under it still attached to it.
- **Put back** works at any depth and for a thread with threads of its own. One new refusal: a thread that has threads on another computer (`remoteChildren`, or an open request to one) can't be put back under a parent. Today's check does not look at them (`childThreads.ts:252`).

### Access, the lead's pass, linked computers, moves

- **Every request carries the sender's access, and it is checked wherever a pass's ceiling is checked today.** A child's access is checked at start today (`decideChildStart`, `clampLaunchToCeiling`, `thread.create`). A send checks nothing (`childThreadDecisions.ts:702`). New: a parent's request carries `fromThread.requestCeiling`, the sender's access when it sent, or its pass ceiling if that is narrower. One helper compares it with the receiving thread's access at the send, at every decision that starts a turn from a stored message (the four that call `passCeilingRefusal` today), and in the reactor when it prepares or resumes the session (`ProviderCommandReactor.ts:1452`, :2630). The last two matter. The reactor rereads the thread there, so a thread the user widened after the decision would otherwise run the request with more access than its sender. Words: "'<title>' has more access than this thread has now. Do the work here, or tell the user, who can send it there." It refuses and does not lower the child, because agent traffic never changes a thread's settings (`decider.ts:4516`). Narrowing a parent does not reach down the tree by itself.
- **The same ceiling goes over the link.** Today a send to a child on a linked computer carries only a request id, a thread id and the text (`PeerSendInput`, `peerRpc.ts:360`), and that computer runs it at the thread's own access (`decideRemoteRequestQueue`, `childThreadDecisions.ts:1275`). New optional `ceiling` on that send. A computer that knows the field stores it as `requestCeiling`, and the same helper refuses the turn there. An older computer ignores it and behaves as today, so no linked family that works now breaks. This is the one place the plan touches what linked computers send each other, and it is here because the ceiling is Will's own rule. It is listed under "For Will to decide".
- **A lead's pass keeps its block down a chain.** Today a thread working on a pass can't start threads but can message its own (`childThreads.ts:121-127`, :165-188). With nesting, that child could start threads, and one lead message would fan out after all. New: a request sent by a thread whose `passCeiling` is set also carries `fromThread.passBlocked`. The decision that starts that message's turn sets the receiver's `passCeiling` to the request's ceiling (the narrowest, as passes do). The receiver's own sends carry it further. It is not `fromThread.ceiling`, which means "this is a lead's pass" in the preamble (`ProviderCommandReactor.ts:2262`) and in `answersHeldableRequest`. The block lifts when a person writes in that thread (today's reset), or when its parent's next request arrives without the flag, which can only happen after a person wrote in the parent.
- **Linked computers stay fenced.** A thread another computer started here still gets no thread tools (`isLinkFenced`). New fence: an attached child cannot start a thread on another computer ("A thread another thread started can only start threads on its own computer."), and `remoteSend` and `remoteStop` refuse the same way. So a nested tree lives on one computer, a subtree stop never crosses a link below the first level, and a report from another computer only ever arrives in a top-level thread.
- **A thread in a family deeper than one level does not move to another computer.** The rule covers every member, not only the root. Today an attached child may move alone and stay its parent's child across the link (`threadMoveDecisions.ts:291-307`). With R, M and G, moving G alone would leave M owning a thread on another computer, which the fence above says cannot exist. So `threadMoveRefusals` refuses a thread when its family tree has more than one level: its parent is itself an attached child, or it is an attached child with attached children, or one of its children has attached children. The check runs at admission and again when the move starts, because `decideMoveStart` re-runs the same function (`threadMoveDecisions.ts:900`). Words only, since the refusal codes are a closed set older peers decode: "This thread is part of a family more than one level deep, which can't move yet. Make it its own thread first." The web's move dialog and quit dialog show the reason (`threadMove.ts:898-1005`). Moving a nested family is a follow-up.
- **Outside agents and assistants** keep their own tool set. A thread one of them started stays fenced. A message one of them sends into a child is the user's own conversation, and its turn is not reported upward.

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

Everything here is an optional field on something that exists, except one command and one event.

- **The owed list.** An optional list in the thread's child-request state (`childRequests`), which already travels in the thread's stored JSON. Each entry: the turn or the message that will start it, the two epochs, and optionally the waiting request it continues. Optional fields add an entry on `thread.turn-start-requested` and on the session update that marks a provider-started turn. `thread.handed-back` removes one when its report is delivered.
- **The report.** New server-only command `thread.child-report.settle`: child, turn, outcome, text, optional error. Its ids are derived from the child and turn. Delivered, it emits events that exist today (`thread.message-sent`, `thread.follow-up-queued`, `thread.handed-back`). Dropped, it emits one new event on the child that removes the entry.
- **That one new event type.** Clients read the server's projections, not events, and features add event types as they go (the lead's pass added `thread.lead-pass-recorded` in #971). The only reader of raw events is `orchestration.replayEvents` (`ws.ts:1626`), which decodes a closed union. Nothing in `apps/web` or `packages/client-runtime` calls it. The builder confirms no shipped client version does. If one does, the dropped case rides on `thread.handed-back` with an optional flag instead, and there is no new event type at all.
- **`fromThread`** (`ThreadMessageOrigin`): optional `followUp`, `requestCeiling` and `passBlocked`. `PeerSendInput`: optional `ceiling`.
- **Stop.** A server-only `cause` on `thread.session.stop` (`family`, `cleanup`), which the Normalizer refuses from clients. The chain stop can move the chain epoch without leaving the hold. The reaper's cause on its session write. The fallback's resend carries a chain epoch.
- **`thread.delete`**: optional `alsoDelete: ThreadId[]`.
- **Removed.** The late-reply functions and the `lateReplies` field's use. Old events that carry it still decode.
- **Shared walk.** `attachedDescendantsOf(threads, rootId)` in `packages/shared/src/childThreads.ts` returns the subtree in tree order with each thread's level, with a visited set. The server's stop, wrap, revert, archive, delete and move rules and the web's sidebar, tabs, menus and delete dialog all use it. `attachedChildrenOf` (`childThreadDecisions.ts:192`) stays for the places that mean direct children.
- **No migration.** Nothing new needs a column. The builder confirms the reaper's cause fits the stored session.
- **Older clients.** Every new field is optional. The builder confirms an older client decodes a thread and a message that carry them, as Part 1 did for the counters.

### Every surface

- **Entry points.** The composer's Stop, the sidebar row menu, the family tab row (tabs and the proposed Stop button), the delete, archive and revert dialogs, the move dialog and the quit dialog. The command palette has no family actions and gets none. There is no keybinding for any of this.
- **Clients.** Web and desktop share the components. The phone uses them over the relay, so the indent and the tab row need a check at phone width. A phone or another computer on an older version shows a nested family the way it shows one today (grandchildren missing from the sidebar) until it updates. Its Stop and "Stop N working threads" still stop the whole subtree, because the server decides. Its delete sends `withChildren` and deletes one level.
- **Providers.** Every provider that gets thread tools today gets them in a child the same way (Codex, Claude, OpenCode, and ACP agents that take HTTP MCP). No driver changes, and nothing depends on what a provider reports about a check-back beyond the mark that a turn is one. Community agents get the behavior only through the generic core.
- **Contracts.** Everything under "Data model".
- **Reverse states.** Stop on a thread and the next message that no agent wrote. A subtree stop and the next message from above. Archive and unarchive of what that archive stamped. Separate and put back at any depth. Delete has no way back, so it deletes only what the dialog listed.
- **The app guide.** The child-threads topic (`apps/server/src/guide/topics.ts:110-124`) changes in five places: threads can start threads; a thread that takes another turn on its own after its answer now wakes its parent with that reply, where it used to wait for the parent's next turn; Stop on a thread stops the threads under it, and "Stop N working threads" covers every level; a thread another thread started only starts threads on its own computer; a thread can't be reverted while threads under it are still going. The lead chat topic's line on a pass target (:144) gains "and neither can the threads it messages". No setting row moves, so `appPlaces.ts` is unchanged.
- **Docs.** `child-threads.md` (Depth 1, Delivery, Late replies, Stop, revert, put back, archive, delete), `lead-chat.md` (family tabs, no fan-out, the usage-limit rule for report turns), `fleet.md:1347`.

### Tests (extend existing files)

- **Shared rules** (`childThreads` tests). An attached child may start, send, stop and wrap. Put back is allowed for a thread with threads of its own and refused for one with threads on another computer. A send is refused when the child has more access than the request's ceiling, and when the child is under the user's hold. `attachedDescendantsOf` returns tree order and levels and survives a cycle in bad data.
- **Which turns report** (decider tests, commands in and events out). One case per kind of start: a parent's request, a person's message, an outside agent's, a hand-off, a hand-off's reply, a review's reply that arrives after the asking turn ended, a report from its own thread, a scheduled run, an automatic fix, a check-back, background work. A continue after a limit, a restart and an account switch each follow the turn they continue, for a person's turn and for a reporting one. A turn whose request was cancelled when its agent left sends nothing.
- **Reports** (`childThreadDelivery` tests, pure, and decider tests for the settle).
  - Completed is delivered; failed delivers the failure text, with the "continues by itself" line when the wait is armed; stopped and no reply are dropped; a second settle of the same turn is refused.
  - Each drop on its own: `thread_stop`, separate and put back, wrap and reopen, the parent held, the child held.
  - A report queued in R before the user stops M still reaches R. A check-back that ends in M after that Stop does not.
  - A provider-started turn while a request waits on background work settles that request and is not also a report. A check-back in the same state is a report and leaves the request waiting.
  - A failed start settles a request `failed`, and delivers a failure for an owed entry. A start taken back sends nothing.
  - A message-started turn in a child settles an `awaiting_background` request first.
  - In an attached child, a report from its own thread is not steered into a running turn, the user's or a request's. In a thread with no parent it is steered as today.
  - A follow-up goes to the agent that started the child, and to the thread's own agent once that one has left.
- **Stop** (decider tests).
  - `thread.turn.interrupt` on a root with three levels: every descendant not at rest is stopped in one decision, the root has the hold, and no descendant gains one, even one that is a room or had an agent's message queued.
  - M was stopped by the user earlier and still has its hold. The user then stops R. M keeps its hold.
  - After a stop the user writes to the root, the root sends M, M runs and sends G, G runs. Nobody wrote in M or G.
  - Archive and unarchive of M leave no new hold on it.
  - A fallback resend issued before a Stop and decided after it is refused, and the hold stays.
  - A scheduled run into a stopped lead runs as it does today.
  - `thread.children.stop` with an idle M whose child works stops the child.
  - An outside agent's stop leaves running a descendant above its limit and names it.
- **Wrap, revert, archive, delete.** `thread_wrap` wraps M when G finished and its session is still open, and returns `working` while M has a start waiting for approval. Revert in R is refused while G works for M with nothing open in R, and allowed after "Stop N working threads". Archive and unarchive of three levels with one live thread in the middle. Delete with `alsoDelete` deletes the listed threads and separates one started after the list was made; `withChildren` alone deletes one level.
- **Access and the pass.** R sends M a request, the user widens M, and the turn is refused at the decision and again at the reactor's prepare. A request from a pass-blocked thread sets the receiver's block; the receiver can't start threads; the block lifts on a person's message and on an unflagged request from its parent. A send over the link carries the ceiling, and a queued remote request above it is refused.
- **Reactor and ingestion.** G's report starts M's turn and M's reply reaches R and starts R's turn. Startup delivers an owed turn that completed before the crash, delivers one interruption report for a cut-off owed turn, recovers a waiting request only from a turn that names it, and ignores turns with no entry. A reaped child's `awaiting_background` request settles `answered`, with no "user stopped".
- **Handlers** (`threadToolHandlers` tests). Each tool from an attached child; `thread_stop` returns `stopped` for an idle child with a working thread under it; a start on another computer from an attached child is refused.
- **Moves.** With R, M and G: R, M and G are each refused, at admission and at the start of the move.
- **Web logic.** `Sidebar.logic.test.ts` ("child thread families"): tree order, levels, subtree counts and dots, the collapsed set, the root key walk, a wrapped middle thread with a live thread under it, a live thread under a wrapped parent heading its own family, a middle thread that does not auto-wrap while a thread under it works or while it has a start waiting. `familyTabs.logic.test.ts`: the tabs equal the sidebar's members for a root, a middle thread and a leaf. `threadMenu.logic.test.ts`: the subtree count. Delete has no test today; add one for the ids it sends.
- **Browser.** `InboxRows.browser.tsx` and `ChatView.sidebar.browser.tsx`: three levels render under one root, open and collapsed. `ChatView.agents.browser.tsx`: the tab row for three levels. Polish shots with the real fonts at desktop and phone width.
- **Live**, on a throwaway stack (never `~/.threadlines/userdata`). Stage 1: a Claude parent and a child; the child's check-back wakes the parent; Stop on the parent stops the child; a restart with the child mid-turn tells the parent once. Stage 2: a root starts a child that starts a grandchild; the grandchild's answer reaches the root and wakes it; Stop on the root stops all three; a Codex child in the chain covers a provider that queues reports.

### Build steps

Two stages, each its own pull request. Stage 1 changes how today's one-level families behave and can run for real before any thread nests. Stage 2 turns nesting on. Within a stage the server steps touch the same files and are built in order by one builder; the web step runs beside them in its own worktree.

**Stage 1: reports and Stop for today's families.**

1. **Contracts and shared rules.** The owed list, the report command, the `fromThread` fields, the stop cause, `alsoDelete`. Shared tests.
2. **Reports.** Which turns report, the owed list, the settle and its drops, failed starts, no steering into an attached child, the wider `settleCandidateBeforeUserTurn`, startup recovery, the reaper's cause, the removal of late replies. This is the risky step. It changes when a parent is woken.
3. **Stop and access.** Stop causes and the hold, Stop reaching a thread's children, the fallback resend's epoch, the request ceiling at every check, the peer field, the revert rule, delete by ids, the wrap test. Guide topic and docs for these.
4. **Web for stage 1.** The delete dialog's ids, the revert refusal's words, the proposed Stop button. Before and after shots.

**Stage 2: nesting.**

5. **The walk and the cascades.** `attachedDescendantsOf`; Stop, `thread.children.stop`, `thread_stop`, archive, unarchive, delete, revert and wrap over a subtree; put back at any depth; the move refusal; the pass block's inheritance; the linked-computer fence.
6. **The switch.** The removed depth refusals in `childThreads.ts`, `thread.create` and the handlers, then the preambles and tool descriptions. Nesting becomes reachable only here. Guide topics and the docs.
7. **Web for stage 2.** The family tree in `Sidebar.logic.ts` and its rows, the summary line, the auto-wrap condition, family tabs, menus and counts, the move and quit dialogs. Before and after shots.

Each stage ends with the gates (`vp fmt`, `vp lint`, `vp run typecheck`, the targeted tests, `@threadlines/web#test:browser`) and its live list. Review: Astra reviews the diff of steps 2, 3, 5 and 7 when each is done.

### For Will to decide

1. **Stop reaches the threads under a thread.** Still open. The plan says yes, as T3 Code does. It changes today's rule, where a parent's Stop leaves its threads running. The alternative keeps today's rule and relies on "Stop N working threads", which then has to be found in a menu while a subtree keeps itself going. If the answer is no, the cascade goes and the rest of "Stop" stands.
2. **The "Stop N threads" button on the tab row.** Still open. Proposed so the brake is on screen while a root waits. The plan works without it.
3. **Two stages.** New. I recommend shipping stage 1 by itself first. It is the part that changes when agents are woken, and a week of real use at one level will find what three reviews of a plan have not.
4. **The access ceiling over the link.** New. I recommend the optional field. Without it, a parent the user has narrowed can still send work to a wider child on another computer, as it can today.

Things decided here that Will should know about:

- In a room, a thread's later reports go to the agent that started it.
- The lead can be woken by work the user asked a middle thread for directly.
- Late replies go away. Work that used to wait for the parent's next turn now wakes it, or is dropped on purpose.
- No limits of any kind; nested trees stay on one computer; no thread in a nested family moves to another computer yet.

## Review of Part 2, rev 1 (GPT-6.2 Astra, Nov 23 2026)

Checked against the code; each holds. Under each finding is the answer as it stands in rev 4.

1. **Pending reports are owed work too.** A child's request leaves `open` when its report is queued, not when the middle thread has read it. M with G1 and G2: G2 settles while M handles G1's report on a provider that can't steer, so M's turn ends with zero open requests and R gets the G1-only answer.
   - Nothing above M waits on M's threads. M's G1 turn and its G2 turn each go up as a report (delivery rule 2).
2. **Downstream work needs the upstream request's identity.** R sends M a second task while the first waits on G: M's second turn sees G open and becomes a candidate too; G's report steered into it answers the wrong request. In a room the two requests can come from different agents.
   - A request answers only to the turn its own message started, and in a middle thread a report is never steered into another turn (rule 7), so no request gets another's content. Which room agent hears a later report is a fixed rule: the one that started the thread (rule 6).
3. **The session reaper (`ProviderSessionReaper.ts`, 30 minutes idle) stops an idle middle thread** whose children are still working, and `ChildThreadReactor.settleStoppedAnswers` then tells R "the user stopped" M. Runtime eviction must not read as a stop.
   - The reaper writes its cause in the same session write as the stop, and the reactor settles by it ("The idle reaper").
4. **Restart** settles R before M's queued report replays (M has zero open requests once G settled), misses a report turn that completed before the crash (recovery only matches `pendingMessageId === null` continuations), and delivers M's first turn when its `awaiting_background` update didn't commit.
   - The first and third need a request held across M's turns, which does not exist. The second is rule 12: every reporting turn is on the child's owed list from its start, and startup settles what is still on it.
5. **A room hand-off in M** goes through `thread.turn.start` without `fromThread`, so `settleCandidateBeforeUserTurn` sends R the candidate while G works.
   - That is now the rule for every message-started turn (rule 10), and it is safe because what M finishes later goes up as reports. A turn that answers a hand-off is recognised by its starting message and is not reported; the asking agent's next turn is (rule 2).
6. **Usage-limit continue** (`isHeldByContinueAtReset`) requires `running` and the failed turn's own message; an `awaiting_background` request continued by a report turn fails at once.
   - No request rides on a report turn. Its failure goes up at once, and the continue is a turn of its own that reports when it ends (rules 4 and 11).
7. **Reports with no local attached child** (a remote G with `environmentId`, a `neverMade` G) still start turns in M; and a queued report taken back (separate, wrap, room departure) triggers no re-check.
   - Rule 2 reads how M's turn started, not who the report came from. A report from another computer can't arrive in a middle thread: an attached child can't start threads there, and no thread in a nested family moves there. Nothing is held, so a report taken back needs no re-check.
8. **The MCP handlers have their own depth checks** (`threadToolHandlers.ts` start, local ownership, remote send, remote stop, wrap), separate from the shared and decider rules listed above.
   - All five are listed under "Rules that go". Start, local ownership and wrap go. The two remote ones become the linked-computer fence.
9. **Nesting lets a lead pass escape its ceiling** (T passes to its existing child M, which carries no pass block and starts G), and ordinary sends don't re-check the parent's current access when the user narrowed it after the child was made.
   - A blocked thread's requests carry the block down, and every request carries the sender's access, checked at the send, at turn start and when the reactor prepares the session ("Access").
10. **Delete with its threads** would delete more than the dialog counted (`useThreadActions.ts` counts direct children only and winds down only those).
    - The command names the threads the dialog listed (`alsoDelete`), and the server deletes only those.
11. **Agent-issued subtree stop** returns `not_running` for an idle M whose child works (`childHasWork` ignores M's own requests), and stopping M first settles the requests used to find the rest.
    - `childHasWork` reads the subtree, targets come from walking `parentThreadId` before anything settles, and a thread stopped with its family gets no hold ("Stop").
12. **Late replies and moves** assume one level (`lateRepliesForAgent` returns early for an attached thread; move admission and whole-family moves refuse or flatten a middle parent).
    - Late replies are gone (rule 9). No thread in a family deeper than one level moves.
13. **The chat's family tabs** (`familyTabs.logic.ts`) list a parent's direct children only and would disagree with a nested sidebar.
    - The tabs show the same members in the same order as the sidebar, from one function ("Chat").

Atomicity is fine: the engine commits one decision's events in one transaction, and `decideCommandSequence` projects each step before the next. The counter fields can go from storage, but older clients need them on the wire (kept, see Part 1).

## Review of Part 2, rev 2 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 2 (commit 956654b68) and accepted the decision to settle each request with its own answering turn. It found 13 problems in the rest. All 13 hold against the code; 10 and 13 are narrower than stated. Under each is the answer as it stands in rev 4.

1. **Stop can strand the team, and can come off without the user writing.** A subtree stop issues `thread.session.stop` per descendant, which runs the chain stop and would hold M and G. Archive cleanup has the same effect. A scheduled run's queued message lifts the hold.
   - A stop has a cause, and only the user's Stop on the named thread leaves the hold. What lifts a hold is left as it is today. Rev 3 narrowed it to a person's message, and the third review showed that breaks the scheduler. A schedule is automation the user set up, and it already lifts a Stop in a room.
2. **Stopping M does not stop M's own check-back from waking R.**
   - A report from a held thread is dropped (rule 5). M's check-back turn still runs, as it does today for any stopped thread, but it wakes nobody and can't message M's threads.
3. **A delayed completion can cross a Stop, a separate and put back, or a wrap and reopen.**
   - The owed entry holds the two epochs from when the turn started, and the settle delivers only if they still match (rules 3 and 5).
4. **Linked-computer sends cannot enforce the access ceiling, and an outside agent's stop would reach a descendant above its limit.**
   - The request's ceiling is proposed as an optional field on the linked send, enforced by computers that know it ("Access", and "For Will to decide"). An outside agent's stop reaches only the descendants that agent may stop itself.
5. **A lone move can create the cross-computer grandchild the plan says cannot exist.**
   - No thread in a family deeper than one level moves, checked at admission and when the move starts. Put back is refused for a thread with threads on another computer.
6. **Looking at what is open when a turn ends confuses an answer with a follow-up.**
   - Whether a turn reports is read from the message that started it, when it starts (rule 2).
7. **The wrong room agent is woken, and a check-back or a continue is credited to the wrong work.**
   - Rev 3 tried to route each report to the agent whose work it was. The third review showed that cannot be done for every kind of turn. Rev 4 does not try: a later report goes to the agent that started the thread. A continue of a person's turn stays the person's (rule 2).
8. **The late-reply net can pass on an outside assistant's answer, repeat a report, or lose one when a report is steered into a person's turn.**
   - There are no late replies on this computer any more (rule 9), and a middle thread never has a report steered into a turn (rule 7).
9. **The two-minute startup window can't tell an upgrade from a crash, misses failed and older turns, and a restart can report an interruption twice.**
   - The window is gone. Startup settles the owed lists, which only turns started after this change are on, and one function decides each turn once (rule 12).
10. **A report turn that never starts leaves R waiting, and a named room agent's turn skips the usage-limit wait.**
    - A failed start settles what its message owed (rule 8). A failed turn reports at once whether or not it waits to continue (rule 4), so the second half no longer matters. It was narrower than stated: only the "answers another thread" reason is left out for a room agent.
11. **A crash while a report is being steered delivers it twice.**
    - In a middle thread reports are never steered, so it can't happen there. In a thread with no parent it can, as it can today for answers. Astra's third review accepted that as a stated limit, and rev 4 drops the mark rev 3 added for it.
12. **`thread_wrap` refuses a finished subtree while sessions are merely idle, and misses a grandchild start that waits for approval.**
    - Wrapping uses "outstanding work", which leaves out an idle open session and includes the thread's own open requests.
13. **Delete can remove a thread the user never confirmed.**
    - The command names the threads the dialog listed. The wind-down is awaited, not left running, but the server still built its own list after it.

## Review of Part 2, rev 3 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 3 (commit 42b4555dd). It confirmed that recording a turn's purpose at its start fixed hand-off order and repeated settlement, and that leaving old turns without a record avoids waking old families on upgrade. It found 12 more problems, in paths that bypass the turn start, mix the work of two turns, or read a different record after a Stop or a restart.

How they were checked: 1, 2, 4, 5, 8, 10, 11 and 12 were read against the code and hold, except the two parts marked rejected. 3, 6, 7 and 9 were not traced line by line, because each is about a mechanism rev 4 removes. They are taken as true.

1. **A report queued in a busy R still wakes R after the user stops M, and a report dropped for that Stop can come back as a late reply.**
   - First half rejected. A report M finished and queued before the Stop is not cancelled by it. The user stopped M, not R, and today a child the user stops even tells its parent so. Cancelling would also take back answers a parent has not read yet, which no Stop does today ("What Stop does not take back"). Second half fixed: there are no late replies, so a dropped report stays dropped.
2. **The access check ends before the provider receives the work.**
   - Fixed. The request carries its ceiling, and the same helper checks it in the reactor where a pass's ceiling is checked today, after the thread is reread. The linked-computer gap gets the optional field.
3. **A provider-started background turn can report to the wrong room agent.**
   - Gone. No turn is assigned to an agent by position. A later report goes to the agent that started the thread.
4. **Steering mixes two requests from the same agent, and a person can steer into a turn that reports upward.**
   - First half fixed: in a middle thread a report is never steered. Second half rejected: a user's steer becomes part of the turn it lands in. That is the standing rule for answers (`child-threads.md`, rev 3 fix 5), and a follow-up turn is treated the same.
5. **Restart recovery can deliver one check-back as both a request's answer and a report, and the decider can't see an older turn's state.**
   - Fixed. The owed list is in the thread's state, where the decider reads it. A waiting request is recovered only from a turn whose entry names it, a check-back never continues a waiting request, and one function decides each turn for both the live path and startup.
6. **A review that returns after the asking turn ended loses its route.**
   - Gone. There is no route to lose. The reply starts a turn in M that no person wrote, so it reports (rule 2).
7. **A scheduled run into a stopped lead stays queued and blocks later runs.**
   - Gone. What lifts a hold is as it is today, so the run starts as it does now.
8. **An account switch and an overtaken reset continue can lose the answer.**
   - Fixed for reports: nothing is held for a continue. The failure has already gone up, and a continue reports as its own turn unless a request was moved onto it (rule 2). So a continue after an account switch reports its result. For requests, the failure a parent is told when an account is switched is today's behavior and is not changed here.
9. **Claude does not always give a check-back's id, and updates from idle room agents can bind one to the wrong turn.**
   - Gone. Nothing uses a check-back's id. The plan only reads the mark that a turn is a check-back.
10. **A family stop must not remove a hold the user put on a descendant, and an automatic resend can lift a hold.**
    - Both fixed. A hold a descendant already had stays. The fallback's resend carries the chain epoch of the turn it resends and is refused after a Stop.
11. **Revert lets a subtree wake a lead about work the user removed.**
    - Fixed. Revert is refused while any thread under the thread is not at rest.
12. **An older phone's delete can still take a child that appeared after its count, and a new event type breaks an old client that replays events.**
    - First half rejected as not fixable here: the old command has no field to say which threads it meant, and the race exists today at one level. It is stated in the plan. Second half fixed: the plan adds one event type at most, nothing in the current clients replays events, and if a shipped version does, the one case rides on an existing event.
