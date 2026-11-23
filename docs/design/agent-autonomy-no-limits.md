# Agents work without per-message limits, and threads nest

Status (Nov 23 2026): Part 1 is built and merged (#1055). Part 2 is **not built**. It is on its fifth plan, after four reviews by GPT-6.2 Astra. Rev 1 held a parent's request open until the threads below had settled, which loses or misroutes answers. Rev 2 reports every turn upward instead, and that decision has held since. Rev 3 tried to route each report to the exact work and room agent it belonged to, which did not converge. Rev 4 replaced that with fixed rules and two build stages. Rev 5 below is rev 4 written against today's main, with the gaps the fourth review found closed. All four reviews are kept at the end with the current answer under each finding. Asked for by Will: "do it all the T3 code way, we will accept the same risks that they are taking". The goal is a lead agent that directs other agents, in a room or in threads it starts, for hours or days without the user writing.

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

## Part 2: threads nest to any depth (rev 5)

Rev 5 is written against main at 66ab80915, after four changes merged: the per-message limits are gone (#1055), a deleted parent's threads are cleaned up only when the server really deleted them (#1051), archiving a parent no longer kills a child's check-back (#1056), and the user's Stop ends every agent's check-backs (#1057). Every line number here is from that commit. Four reviews are at the end of this file, with the current answer under each finding.

The examples use three threads. R is the root, the thread the user talks to. M is a thread R started. G is a thread M started.

### Is this converging

Rev 3 was not. It tried to say exactly which piece of the parent's work every turn in a child belonged to, and which agent of a room that work was for, and to carry that through every way a turn can start. Rev 4 removed that whole class with fixed rules: a thread's later reports go to the agent that started it, a middle thread reads each report in a turn of its own, there are no late replies, and what lifts a Stop is left as it is today.

The fourth review found ten more problems and no new class. Three were fixed on main while it was being written (#1051, #1056, #1057). Of the other seven, most are in how today's code already behaves with one parent and one child, whatever this plan does: a child whose runtime dies is reported as stopped by the user, a check-back in the wrong moment strands a waiting answer, a thread started without report back is outside every Stop, and wrapping a thread does not stop reports to it. The reviews have turned into an audit of the child-thread code that is already shipped. That is useful, and it is also why a plan review will keep finding things: each one reads further into code the plan did not write.

Rev 5 answers each with a rule that makes the case impossible where one exists:

| The case                                                       | The rule that removes it                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A runtime that dies mid-turn is read as the user's Stop        | A turn was stopped on purpose only if it is the turn a Stop named. Main already records that (#1057)                        |
| The idle reaper's stop needs a mark that can land too late     | No mark. Nothing the reaper closes is named by a Stop                                                                       |
| A check-back strands a waiting answer, then is delivered twice | A waiting answer lasts only until the child's next turn starts, whatever starts it                                          |
| A continue after a usage limit runs with wider access          | A continue keeps the ceiling of the turn it continues                                                                       |
| An agent starts a thread no Stop reaches                       | A thread without report back is a single thread a top-level thread started. It can't start more until the user writes in it |
| A wrapped thread is woken by a later check-back                | A report is dropped while its parent is wrapped, by the parent's state, not by an epoch                                     |
| Revert names a Stop control that isn't shown                   | One "still going" test for the refusal, the stop and the count                                                              |
| An old client breaks on a new event                            | The one new event type is never sent on the thread stream                                                                   |

What rev 4 gave up stays given up: in a room, a thread's later reports wake the agent that started it, and the lead can hear about work the user asked a middle thread for directly.

My recommendation is to stop reviewing the plan after this round. Build stage 1, which is one parent and one child, with the tests listed below, and have Astra review each step's diff. The remaining risk is in details of existing code paths that tests pin down better than a fifth read of a plan. If stage 1's own review finds a new class, nesting waits.

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
   - The message is a request from its parent. That turn answers the request (rule 1) and is never anything else, even if the request is cancelled before the turn ends (the agent that asked left, `decider.ts:3376`).
   - A person wrote the message (`composer` or `sentFrom`, `personWrote`, `childThreadDecisions.ts:2153`), or an outside agent did (`fromOutside`).
   - The message is a hand-off from another agent in the same thread. That reply goes to the agent that asked (`routeHandOffReply`), and the turn that agent then takes reports.
   - The message is a continue (`trigger`: a usage limit reset, a restart, an account switch) of a turn a person or an outside agent started. A continue is judged by the turn it continues. If that turn answered a request and the request is moved onto the continue in the same decision, as continue at reset does today (`decider.ts:5496`), the continue answers it. In every other case the continue reports.

   Everything else reports: a report from one of its own threads, the reply to a hand-off or a review, a scheduled run, an automatic fix, and every turn the provider starts with no message (a check-back, background work that finished).

3. **The owed list.** The decision that starts a reporting turn adds an entry to a short list on the child: the turn, the parent's delivery epoch and the child's attachment epoch as they are then. The entry is the durable promise. It is removed when the report is settled, and the whole list is emptied when the child's attachment epoch moves.
   - For a turn a message starts, the decision that emits `thread.turn-start-requested` adds it, keyed by the message, before the provider has taken the turn.
   - For a turn the provider starts, ingestion says so on the session update that marks the turn started, with the runtime's mark when the turn is a check-back (`TurnTrigger`), and that decision adds it.
   - The list lives in the thread's state, which the decider reads. No decision has to look up an old turn row.
4. **A waiting answer lasts only until the child's next turn starts.** A request in `awaiting_background` holds the child's last reply as its answer so far. Today it is closed early only by a turn the user starts (`settleCandidateBeforeUserTurn`, `decider.ts:562`), and a check-back that runs in between leaves it open with nothing left to close it, because the quiet check needs the answer so far to be the child's newest turn (`isQuietCandidate`, `childThreadDelivery.ts:271`). New, decided when the next turn starts, whatever starts it:
   - If the provider started it and it is not a check-back, it is the background work coming back. Its owed entry names the request, and its end answers the request, or becomes the new answer so far if more background work is left.
   - Any other turn (the user's, a room agent's, a report, a later request, a check-back) settles the waiting request first, with its answer so far. That turn then reports or answers by rule 2.

   So while a request waits, its answer so far is always the child's newest turn, the quiet check always works, and a check-back can never be taken for the background work.

5. **Settling a report.** When the turn ends, `thread.child-report.settle` decides it once and removes the entry.
   - Completed with a reply: delivered.
   - Failed: delivered as "'<title>' failed: <error>." followed by "It continues by itself when the limit resets." when the thread waits to continue at a reset, and by "Send it a message with thread_send to continue." otherwise. Nothing is held for the continue. The continue is a turn of its own and reports when it ends.
   - Stopped on purpose, or completed with no reply: dropped.
   - Ended without being stopped: delivered as "'<title>' stopped before it finished: <reason>. Send it a message with thread_send to continue."
6. **Stopped on purpose is a recorded fact, not a guess.** Since #1057 a Stop names the turn it is for, and the session keeps it until another turn starts (`stopRequestedTurnId`, `packages/contracts/src/orchestration.ts:2212`; both the user's Stop and a session stop set it, `ProjectionPipeline.ts:2224`). A turn that ends interrupted was stopped on purpose only if it is that turn. Today every interrupted turn is treated as the user's Stop: when Claude's stream ends mid-turn the adapter closes the turn as interrupted (`ClaudeAdapter.ts:8479`), and the parent is told "The user stopped" the child (`childThreadDelivery.ts:183`). New, in every place that reads how a turn or a session ended:
   - A request's answering turn that ends interrupted says "The user stopped '<title>' before it finished." only when it is the turn Stop named. Otherwise the request settles `failed` with the text in rule 5.
   - A session that goes to `stopped` or `error` while a turn is still marked running never produced a turn end (Codex can emit `session.exited` alone, `CodexAdapter.ts:1937`). The reactor that settles a stopped child's answers (`settleStoppedAnswers`, `ChildThreadReactor.ts:345`) returns early today when the parent has no open request (`ChildThreadReactor.ts:292`). It now also settles the child's owed entries, and it uses the same test: named by Stop, dropped; otherwise the failure goes up.
   - A waiting request (`awaiting_background`) whose child's session ends without a Stop settles `answered` with its answer so far, as it does after a restart.
   - This replaces rev 4's plan to mark the idle reaper's stop. The reaper never issues a Stop, so nothing it closes is named, and nothing it closes is called the user's doing. No new field on the session is needed.
7. **When a report is dropped instead.** The decision delivers only if all of these hold. Otherwise it drops the report, and a dropped report stays dropped.
   - The entry's two epochs still equal the parent's delivery epoch and the child's attachment epoch. This catches a completion that crosses a `thread_stop`, a separate and put back, or the parent's Stop (`childThreadDecisions.ts:1417`, `:1865`, `:1963`).
   - The child is still attached to that parent, and neither is deleted.
   - The parent is not archived, and is not wrapped up by hand right now (its done override, set by the user or by its own parent's agent). The epoch can't carry this one. A wrap moves it at most once (`decider.ts:2308`), and not at all when the thread has nothing open (`childThreadDecisions.ts:1941`), and a turn that starts after the wrap records the new value. "Wrapped right now" means its done override says done and is newer than its newest turn, the test the sidebar already files by. Reopening the parent lets reports through again.
   - Neither thread is under the user's Stop hold.
8. **What a delivered report is.** A user-role message in the parent with `fromThread { threadId, requestId, kind: "report", followUp: true }` and a queued follow-up, as an answer is delivered today. The schema requires `requestId`, so it carries one derived from the child's turn. It goes to the agent that started the child, or to the thread's own agent if that one has left the room. If that agent leaves while a follow-up report for it is still queued, the leave decision hands the queued report to the thread's own agent. Today it takes every queued report for a leaving agent off the queue (`decider.ts:3394`), which is right for an answer to a request that agent made and wrong for a report nobody asked for. The message carries the current epochs, so the existing checks before send still apply (`isCancelledReport`, `childThreadDecisions.ts:2231`). The text is clipped as answers are. The child is stamped handed back as of that turn, so it wraps itself as it does after an answer. The builder checks `pushAlertRules.ts`, which cancels a child's "done" alert on `child-request-settled`. A follow-up has no such event, and it must not alert the user each time a child reports.
9. **A middle thread reads each report in a turn of its own.** Today a report is steered into a running turn where the provider can steer (`steerQueuedAgentMessage`, `ProviderCommandReactor.ts:5501`). In an attached child, a report from one of its own threads is never steered. It waits and starts its own turn, which reports. So a report can't be swallowed by a turn the user started, and two tasks can't end up in one answer. A thread with no parent steers as it does today. Its turns report to nobody, so nothing can be lost there.
10. **A failed turn says what is waiting behind it.** After a turn fails, the thread's queue is sent on only when something new is queued or a later turn ends (`maybeSendNextQueuedFollowUp`, `ProviderCommandReactor.ts:6203`). So a report that waited behind the failed turn (rule 9) sits unread, while the thread that sent it is already stamped handed back. The failure report therefore counts them: "'<title>' failed: <error>. 2 reports from its threads are waiting in it unread. Send it a message with thread_send and it reads them first." A send from the parent starts the queue again, oldest first (`processFollowUpQueued`, `ProviderCommandReactor.ts:6029`). The queue's own rules do not change. Sending the next report by itself after a failure would burn one failed turn per queued report in a thread that keeps failing.
11. **A start that fails.** When preparing the provider fails or times out, no turn ever ends (`reportFailedStart`, `ProviderCommandReactor.ts:3427`), and today a parent's request for that child stays `running` for good. New: a failed start settles what its message owed. A request settles `failed` ("'<title>' could not start its turn: <error>"). An owed entry delivers the failure report. A start that is taken back on purpose before the provider took it (a report that went stale, a Stop while the turn was being prepared) removes its entry and sends nothing.
12. **No more late replies on this computer.** With rule 2, the only unasked work that does not reach the parent is work that was dropped on purpose. So `lateReplyOf`, `lateReplyRecipient`, `lateRepliesForAgent` and the `lateReplies` part of `thread.child-notes.delivered` go. Late replies that were unread at the upgrade stay in the child for `thread_read`. A child on a linked computer never had late replies and still doesn't.
13. **Continue at reset.** `reportsToTopLevel` (`decider.ts:929`) arms the wait for a report turn only in a thread with no parent. It drops that condition, so a middle thread's report turn continues by itself too. Whether it waits or not, its failure has already gone up (rule 5).
14. **Restart.** Startup settles every entry on every owed list whose turn has ended or never started. There is no time window, and turns from before the upgrade have no entry.
    - A turn that completed before the crash is delivered.
    - A turn the restart cut off, or that failed, delivers its failure. For a cut-off turn the text is "'<title>' was interrupted by a Threadlines restart. Send it a message with thread_send to continue."
    - A waiting request is answered by a later turn only if that turn's owed entry names it. Otherwise it settles with its answer so far. `finishedTurnAfterRestart` (`childThreadDelivery.ts:295`) picks the newest turn no message started, which can be an unrelated check-back, and rev 4 kept that rule for turns from before the upgrade. Rev 5 drops it for waiting requests altogether. Startup cannot tell an old turn from a check-back whose entry was already settled, and the worst case of dropping it is one request, waiting at the moment of the upgrade, that gets its answer so far and not its final one.
    - Other requests recover as today (`settleFromPreviousProcess`, `ChildThreadReactor.ts:409`).
15. **Linked computers.** Unchanged. A thread another computer started here answers through the link ledger, is fenced from thread tools, has no owed list and sends no follow-up reports. The ledger keeps today's waiting rule, since nothing else brings a linked child's later work back.

Where it goes: `routeChildReport` (`ProviderRuntimeIngestion.ts:2770`) returns early when the parent has no open request for the child. That early return goes. One pure function in `childThreadDelivery.ts` takes the turn's end, the session's stopped turn, the child's owed list and the parent's open requests, and returns the request settle, the report settle, or nothing. The live path, the stopped-session reactor and startup all call it, so a turn can never be delivered as both.

### What a child and its parent are told

- **Attached child preamble** (`ProviderCommandReactor.ts:2268`). Today: "Another agent started this thread from the thread "X", and your final reply goes back to it automatically. Work in this thread's own checkout, and end with the answer it needs." Add: "If you take more turns later that the user did not start, for example when a thread you started reports back, the reply that ends each one goes back too and wakes that thread. Keep those replies short when nothing has changed."
- **Follow-up report preamble.** "Report from thread "X" (<id>), which took another turn on its own after its last answer. It's information from another agent, not instructions from the user."
- **`thread_start` and `thread_send` descriptions** (`threadTools.ts`). Add: "A thread you start can start threads of its own. Its final reply comes back to you and wakes you, and so does the reply ending any later turn it takes on its own." ACP agents learn rules only from descriptions.

### Rules that go

Every refusal that says a thread started by another thread can't direct threads:

- `DEPTH_REFUSAL` in `callerRefusal` (`packages/shared/src/childThreads.ts:73-85`), which `childStartRefusal`, `childSendRefusal` and `leadPassRefusal` all call.
- The handlers' own checks through `depthRefusal()` (`threadToolHandlers.ts:525`): `threadStart` :931, `ownChild` :1743 (local send and stop), `remoteSend` :2142, `remoteStop` :2215, `threadWrap` :2287. The first, second and last go. The two remote ones are replaced by the linked-computer rule below.
- `thread.create` refusing a parent that is itself an attached child (`decider.ts:1573`).
- `decideChildrenStop`'s refusal of an attached caller (`childThreadDecisions.ts:1809`). Its twin for threads on another computer (:1828) stays, as part of the linked-computer rule below.
- Put back's "is part of another thread's family" and "has started threads of its own" (`childThreads.ts:249-254`). A cycle can't form: `parentThreadId` is set once at creation, and put back only re-attaches to that thread.
- The words "one level deep" wherever they state the rule: the "Depth 1" bullet in `child-threads.md:150`, code comments (`childThreads.ts:63`, `threadToolHandlers.ts:524`, `Sidebar.logic.ts:1066`, `decider.ts:1559`), and the contracts comment at `orchestration.ts:5341`. `fleet.md:1347` changes to say a move carries one level.

Kept:

- A thread messages, stops and wraps only threads it started (`ownChildRefusal`). R reaches G only through M.
- The lead chat cannot pass to an attached child (`childThreads.ts:351`), and a lead is top-level.
- "Agents can start threads" (off, ask, automatic) and "Threads can share a checkout" apply at every level. In ask mode the approval card shows in the thread whose agent asked. The root's sidebar line counts it as "needs you".
- Five threads per call.

New refusals for threads started without report back are under "Stop".

### Stop

Stop is the only brake Will kept, so it has to reach everything an agent can set going.

- **Everything an agent starts is inside the tree Stop walks.** `thread_start` with `reportBack: false` makes a thread that is its starter's child on paper but was never attached (`ThreadBootstrap.ts:687`), so no walk reaches it, and today that thread can start more the same way. Two refusals close this for good:
  - A thread another thread started can't start a thread without report back. "A thread another thread started can only start threads that report back to it."
  - A thread that was started without report back can't start threads until a person has written in it. "This thread was started to work on its own. It can start threads once the user has written here."

  So a thread started without report back is always a single thread, started by a top-level thread, that can't multiply. It is the user's from the start, as it is today, and Stop on its starter does not reach it, as today.

- **The Stop button stops the thread and every thread under it.** `thread.turn.interrupt` is what the composer's Stop and an outside agent's stop send (`ChatView.tsx:6537`, `connectToolHandlers.ts:2348`). Its decision (`decider.ts:4716`) keeps what it does today to the thread itself, and in the same decision stops every attached thread under it that is still going. This is T3 Code's rule (`ThreadManagementService.ts:1743`), and it replaces "children keep running" from `child-threads.md`. With reports climbing on their own and no limits, a subtree left running can keep itself going with nobody watching, and it spends the user's usage. A stopped turn can be resumed with a message. Spent usage can't be taken back. Will has not confirmed this yet (see "For Will to decide").
- **Still going** is one test, used for what a stop targets, for the count in "Stop N working threads", and for the revert refusal, so a refusal never names a remedy that isn't on screen. A thread is still going when it has any of: a turn running or starting, a queued message or a pending start, an approval, question or plan waiting on the user, background work of any kind, an open request of its own, a check-back that dies with its runtime (`holdsRuntimeCheckBack`, `packages/shared/src/checkBacks.ts:53`), or a wait to continue at a reset. An idle session with none of these is not going, and nothing in it can start a turn by itself. The test goes in `packages/shared`, written over fields the thread's shell and its detail both have. Today the server's target test is `childHasLiveWork` plus open requests (`childThreadDecisions.ts:1813`), and the client counts only the Working, Starting, Answering and Waiting pills (`Sidebar.logic.ts:1783`), so they disagree on a thread that only checks back.
- **Check-backs end with Stop.** Since #1057 the user's Stop cancels every agent's check-backs in the thread and stops the runtimes that hold them, background work included (`endCheckBacksOnStop`, `decider.ts:1204`), and a check-back reported just after Stop is cancelled too (`ProviderRuntimeIngestion.ts:2976`). Rev 4 had to plan around check-backs that outlived Stop. That is gone. One limit stays, noted on main: a quiet child on a linked computer that holds only a check-back is not reached by `thread_stop`.
- **A stop has a cause, and the cause decides the hold.** Today every stop runs `decideAgentChainStop`, which leaves the durable hold (`agentRequests.hold`) on a thread in a room or with an agent's message in its queue (`agentRequestDecisions.ts:1019`). A held thread's agent can't start or message threads (`callerRefusal`), and a parent's request does not lift the hold (`decider.ts:3991`). With one rule for every stop, a subtree stop would leave M and G held, and after the user wrote to R the team would stay stuck. So `thread.session.stop` takes a server-only cause, and the chain stop reads it:
  - **The user's Stop** (`thread.turn.interrupt` on the named thread). The hold always goes on when the thread is an attached child, has attached children or has open child requests, and its delivery epoch always moves.
  - **Stopped with its family** (a thread under that Stop, a child stopped by `thread_stop`, "Stop N working threads"). No new hold. Its attachment epoch moves, its queue is cleared of agents' messages, and it takes its parent's next message without the user writing in it. A hold it already had from the user's own Stop in it stays.
  - **Cleanup** (archive, delete, the sweeper, a move, a link: `ws.ts:1374`, `:1465`, `ThreadAutoArchiveSweeper.ts:170`, `LinkRequests.ts:1271`). No new hold, and no cascade. An archived thread that comes back must take work again.
- **What the hold does.** The held thread's agent can't start or message threads. Reports to it and from it are dropped (delivery rule 7). `childSendRefusal` refuses a parent's send to a held child with the words the lead's pass already uses: "The user stopped that thread. It takes work again once they write there." Today such a message sits unseen in the child's queue.
- **What lifts the hold stays as it is today.** A message that no agent wrote lifts it: the user's, and also a scheduled run's or an automatic fix's (`decider.ts:1049`, `:1092`, `:3991`, `ProviderCommandReactor.ts:6039`). Those are automation the user set up, a schedule that targets a stopped lead keeps working as it does now, and rooms don't change.
- **One automatic path is closed.** When a provider session falls back, the server resends the turn's message by itself (`processNativeSessionFellBack`, `ProviderCommandReactor.ts:6397`), and a resend lifts the hold (`decider.ts:4197`). `thread.turn.resend` already refuses a resend whose chain epoch has moved (`decider.ts:4046`), but the fallback sends no epoch. It now sends the epoch of the turn it resends, so one that arrives after a Stop is refused.
- **What Stop does not take back.** A report the thread had already finished and queued in its parent before the Stop still reaches the parent. The user stopped this thread, not the one above it, and a child the user stops even tells its parent so. To stop the parent, stop the parent, which clears its queue of agents' messages.
- **What stopping a thread under it does.** What `thread.children.stop` does to a child today (`childThreadDecisions.ts:1785`): its parent's requests for it settle `stopped` with no report, its parent's messages still queued in it are taken back, the reports it queued upward are unqueued, the turn it was cut off in is stamped handed back, its attachment epoch moves (which empties its owed list), and its session is stopped with the family cause. Targets are found by walking `parentThreadId` from the thread records before anything is settled, so stopping M first can't hide G.
- **Stop inside a middle thread** stops M and everything under M. R hears as today if a request for M was open ("The user stopped 'M' before it finished.").
- **"Stop N working threads"** (`thread.children.stop` without ids) stops every thread under the row that is still going, and N counts exactly those. The thread itself keeps running and gets no hold.
- **`thread_stop` from an agent** stops that child and everything under it. It returns `stopped` when anything there was still going, and `not_running` only when nothing was. `childHasWork` (`threadToolHandlers.ts:335`) moves to the same test over the subtree. Today it counts any check-back, a saved one included; a saved one comes back the next time the agent runs whatever is stopped, so the shared test counts only those that die with the runtime.
- **An outside agent's stop** reaches only the threads that agent may stop itself. `outsideStopRefusal` (`outsideTurns.ts:158`) is asked for each one. A thread the user gave more access than that agent's limit keeps running, and the tool's answer names it.
- **A visible Stop while the root is idle.** A root that waits on its team has no running turn, so its composer shows no Stop button, and today the only brake is in the row's menu. The chat's family tab row gets a plain "Stop N threads" button at its end while any thread under the open thread is still going. It sends the same command as the menu item. This one is a proposal. Drop it if the menu is enough.

### Wrap, archive, delete, revert, separate, put back

Each is one decision, as today. The subtree is found with one shared walk (see "Data model").

- **Outstanding work** is the test for wrapping. It asks a different question from "still going": not "can this start a turn by itself" but "is something unfinished here". A thread has outstanding work when `childHasLiveWork` says so (`childThreadDecisions.ts:1724`): a running turn, an approval, a question, a plan, awaited background work, a queued message, or an open request of its own, which includes a start still waiting for the user's yes. An idle session that is merely still open does not count, and neither does a check-back, as today.
- **Auto-wrap** (`isThreadDone`, `Sidebar.logic.ts:873`). A thread that waits on requests of its own is already held open: `canMarkThreadDone` (`:739`) reads the Waiting pill, which covers a start not yet made into a thread. That holds M while its request to G is open. It does not hold M after G's first answer, when G works on and M has nothing open. New condition on the handed-back rule: an attached child does not count as done while any thread under it is working, waiting, or needs the user. The "its parent is done" rule stays and already recurses (`resolveDone`, `:1096`).
- **`thread_wrap`** returns `working` for a child when it or anything under it has outstanding work (`agentWrapRefusal`, `childThreadDecisions.ts:2106`). Wrapping a finished M wraps M only; its finished threads follow by the "parent is done" rule.
- **Wrapping a thread by hand** keeps decision 4: nothing under it stops. Its open requests are cancelled, and while it stays wrapped, reports to it are dropped (delivery rule 7). Its live children stand on their own in the sidebar with "↳ <title>", as a wrapped parent's children do today.
- **Revert is refused while anything under the thread is still going.** Today revert is refused only while the thread has open requests or queued reports (`childRevertRefusal`, `childThreadDecisions.ts:2189`). With reports after the first answer, R can hold neither and still have G working for M. Reverting then would let M wake R about a task the revert removed. New: revert is refused in a thread while any attached thread under it is still going, by the Stop test, with today's words ("Finish or stop its threads first..."). Because it is the same test "Stop N working threads" counts by, the menu item is always there when the refusal shows, and after it runs nothing under the thread can start a turn by itself.
- **Archive.** Main already has the rule for one level (#1056, `childArchivePlan`, `childThreadDecisions.ts:2072`): a child is live, and is separated instead of archived, when it has work of any kind, a request open from its parent, or a check-back that would die with its runtime. The cascade applies that same test going down. A settled attached thread is archived and stamped `archivedWithParentAt` with the root's archive time. A live one is separated from its parent and keeps everything under it. The walk does not go below a thread it separated. Unarchive restores every thread stamped by that archive (`childrenArchivedWith`, `childThreadDecisions.ts:2171`). The sweeper and "Archive inactive threads now" already skip a thread whose check-back is still owed; they also skip one with a live thread anywhere under it. One limit stays, noted on main: a child on a linked computer that is mid-request is still stopped when its parent is archived.
- **Delete names what it deletes.** Since #1051 the client winds down only the thread the user named, and the server cleans up each thread it really deletes (`ThreadDeletionReactor.ts:67`), so a thread the server keeps no longer loses its terminals. What is left is the count: the dialog counts from the client's store, and the server builds its own list when it decides (`decider.ts:1940`), which can hold a thread started in between. New optional `alsoDelete` on `thread.delete`: the ids the dialog listed. The server deletes exactly those that are still attached, unarchived threads under the named one. Any other attached thread under a deleted one is separated and kept, with what is under it. Archived threads are never in the list and are never deleted this way, on either end. `withChildren` alone keeps today's meaning for a client that has not updated, including today's small race: a direct child that appears between its count and the server's decision is deleted too. The old command has no way to say which threads it meant.
- **Separate** ("Make it its own thread"). The thread leaves with everything under it still attached to it.
- **Put back** works at any depth and for a thread with threads of its own. One new refusal: a thread that has threads on another computer (`remoteChildren`, or an open request to one) can't be put back under a parent. Today's check does not look at them (`childThreads.ts:252`).

### Access, the lead's pass, linked computers, moves

- **Every message that carries a parent's work carries the parent's access, and it is checked wherever a pass's ceiling is checked today.** A child's access is checked at start today (`decideChildStart`, `clampLaunchToCeiling`, `thread.create`). A send checks nothing (`childThreadDecisions.ts:703`). New: a parent's request carries a `requestCeiling`, the sender's access when it sent, or its pass ceiling if that is narrower. One helper compares it with the receiving thread's access:
  - at the send;
  - at every decision that starts a turn from a stored message (the ones that call `passCeilingRefusal` today, `decider.ts:3605`, `:4088`, `:4458`);
  - in the reactor, when it prepares the session and when it starts the turn (`ProviderCommandReactor.ts:1452`, `:2629`). The reactor rereads the thread there, so a thread the user widened after the decision would otherwise run the request with more access than its sender.

  Words: "'<title>' has more access than this thread has now. Do the work here, or tell the user, who can send it there." It refuses and does not lower the child, because agent traffic never changes a thread's settings (`decider.ts:4540`). Narrowing a parent does not reach down the tree by itself.

- **A continue keeps the ceiling of the turn it continues.** The reactor reads the ceiling from the turn's own starting message (`ProviderCommandReactor.ts:2584`). A continue after a usage limit is a fresh message with the thread's current access and no origin (`decider.ts:5463`), and the parent's request is moved onto it afterwards (`decider.ts:5496`). So today, and under rev 4, a child the user widened while it waited runs the parent's request with the wider access, and no check has anything to read. New: the ceiling is a field of the message, not of its origin, and every continue (a usage limit reset, a restart, an account switch) copies it from the message that started the turn it continues. The same helper then refuses the continue's turn in the decision and in the reactor. A refused continue ends the wait without continuing, and the request it held settles `failed` through the helper that ends held requests today (`decideHeldRequestsEnd`, `decider.ts:1274`), with the words above.
- **Over the link, a send is allowed only where the ceiling can be kept.** Today a send to a child on a linked computer carries only a request id, a thread id and the text (`PeerSendInput`, `peerRpc.ts:360`), and that computer runs it at the thread's own access (`decideRemoteRequestQueue`, `childThreadDecisions.ts:1276`). New optional `ceiling` on that send, and a new flag on what a linked computer says about itself (`PeerDescriptor`, `peerRpc.ts:213`, where optional flags such as `moves` already mean "absent: an older server"). A computer with the flag stores the ceiling on the message, and the same helper refuses the turn there. A computer without it can't check anything, so a send to it is allowed only when the sender has the widest access there is, where no ceiling can be broken. Any narrower sender is refused: "<computer> runs an older Threadlines that can't hold this thread's access limit. Update it, or send the work yourself." This is the one place the plan touches what linked computers send each other, and it is here because the ceiling is Will's own rule. It is listed under "For Will to decide".
- **A lead's pass keeps its block down a chain.** Today a thread working on a pass can't start threads but can message its own (`childThreads.ts:121-127`, `:165-188`). With nesting, that child could start threads, and one lead message would fan out after all. New: a request sent by a thread whose `passCeiling` is set also carries `passBlocked`. The decision that starts that message's turn sets the receiver's `passCeiling` to the request's ceiling (the narrowest, as passes do). The receiver's own sends carry it further. It is not `fromThread.ceiling`, which means "this is a lead's pass" in the preamble (`ProviderCommandReactor.ts:2262`) and in `answersHeldableRequest`. The block lifts when a person writes in that thread (today's reset), or when its parent's next request arrives without the flag, which can only happen after a person wrote in the parent.
- **Linked computers stay fenced.** A thread another computer started here still gets no thread tools (`isLinkFenced`). New fence: an attached child cannot start a thread on another computer ("A thread another thread started can only start threads on its own computer."), and `remoteSend` and `remoteStop` refuse the same way. So a nested tree lives on one computer, a subtree stop never crosses a link below the first level, and a report from another computer only ever arrives in a top-level thread.
- **A nested family does not move to another computer, and neither does a thread inside its nested part.** Today an attached child may move alone and stay its parent's child across the link (`threadMoveDecisions.ts:291-307`). With R, M and G, moving G alone would leave M owning a thread on another computer, which the fence above says cannot exist. So `threadMoveRefusals` refuses a thread when any of these holds: its parent is itself an attached child, or it is an attached child with attached children, or one of its children has attached children. A leaf directly under a top-level thread may still move alone, even when a sibling has threads of its own. That leaves the top-level thread with one child on another computer, which is allowed today and breaks nothing above. The check runs at admission and again when the move starts, because `decideMoveStart` re-runs the same function (`threadMoveDecisions.ts:900`). Words only, since the refusal codes are a closed set older peers decode: "This thread is part of a family more than one level deep, which can't move yet. Make it its own thread first." The web's move dialog and quit dialog show the reason (`threadMove.ts:898-1005`). Moving a nested family is a follow-up.
- **A thread that still owes its parent something does not freeze for a move.** "Move when done" waits today for the thread's own requests and its queue (`workWaits`, `threadMoveDecisions.ts:465`), not for what it owes upward. Ingestion writes the session as ready before it routes the turn's report (`ProviderRuntimeIngestion.ts:3636`, then `:4144`), so a child could freeze and leave with a report still owed. New: a thread with an entry on its owed list, or with a request from its parent still open for it, counts as working for a move. The settle itself is not blocked by a frozen child, because the freeze reads the parent the command names (`threadMoveDecisions.ts:866`).
- **Outside agents and assistants** keep their own tool set. A thread one of them started stays fenced. A message one of them sends into a child is the user's own conversation, and its turn is not reported upward.

### Sidebar

Today a grandchild has no row at all, because `familyParentKeyOf` looks one step up and only a row with no parent draws children (`Sidebar.logic.ts:1563`, `buildInboxSections` :1911).

- **One family per root.** A family is a live thread with no live attached parent, plus every thread reachable from it down attached links, as long as each link's parent is still in the live family. `familyParentKeyOf` stays the direct parent. A new `familyRootKeyOf` walks up, with a visited set.
- **Open family.** Every member gets one line, in tree order. Each thread is followed by its own threads, in creation order within a level. The first level sits where child rows sit today. Each level below is indented one step (12px), and the indent stops growing after two steps so titles keep room on a phone.
- **Summary line** on the root: dots and counts cover the whole family ("7 threads · 1 needs you"). There is one chevron per family. Middle threads get no summary line of their own.
- **Collapsed family.** It still shows any member that needs the user and the one open in the chat. They show without indent, because the rows that would explain the indent are hidden.
- **Wrapped members.** A wrapped member leaves the live family (`hasLeftLiveFamily`, :1618) only when no thread under it is still in the family. In Wrapped it holds its own wrapped threads inside it, at any depth, and its count is the subtree's.
- **A live thread under a wrapped parent** stands alone with "↳ <parent>" as today, and it now heads a family of its own. It draws its threads and gets a summary line. Today those threads vanish.
- **Fold, keys and attention.** A family still takes one seat. It has attention when any member has a status pill (`inboxLiveRowHasAttention`, :2097). `orderedThreadKeys` equals the rendered rows.
- **Menus and hover cards.** Every member's row gets "Stop N working threads" for the threads under it, "Make it its own thread", and the rest of a child row's menu. The hover card names the direct parent ("Started by <parent>") and, for a thread with threads, counts those under it.
- **Filters.** Project and computer scope apply to the root, and the family travels with it.

### Chat

- **Family tabs** (`familyTabs.logic.ts:84`, `lead-chat.md` "Family tabs"). The row shows the whole family the sidebar shows, root first, then every member in the sidebar's order. One function decides membership for both, as the lead chat design requires. It shows on every member while the root is live. A tab below the first level carries the small corner arrow the sidebar uses for "started by", and its tooltip names its parent. The "+N" menu indents its rows by level. The root's tab and the open thread's tab stay on the row.
- **Header chip, cards, pill.** "Started by <parent>" names the direct parent, which is right at any depth. "Started N threads" cards list the threads that turn started. "Waiting · N threads" counts the thread's own open requests. A root whose team is working with no request open shows no wait pill; its sidebar line and tabs show who is working.

### Data model

Everything here is an optional field on something that exists, except one command and one event.

- **The owed list.** An optional list in the thread's child-request state (`childRequests`), which already travels in the thread's stored JSON. Each entry: the turn or the message that will start it, the two epochs, and optionally the waiting request it continues. Optional fields add an entry on `thread.turn-start-requested` and on the session update that marks a provider-started turn (with whether it is a check-back). `thread.handed-back` removes one when its report is delivered.
- **The report.** New server-only command `thread.child-report.settle`: child, turn, outcome, text, optional error. Its ids are derived from the child and turn. Delivered, it emits events that exist today (`thread.message-sent`, `thread.follow-up-queued`, `thread.handed-back`). Dropped, it emits one new event on the child that removes the entry.
- **That one new event type stays out of the thread stream.** Astra checked the assumption rev 4 left to the builder, and it was wrong: a client replays stored events when it resubscribes to a thread (`ws.ts:1744`), decodes them against a closed union, and fails the whole batch on a type it does not know, then retries from the same place. The server filters what it sends through `isThreadDetailEvent` (`ws.ts:248`). So the new event is not added to that filter, as `thread.lead-pass-recorded` is not. No client needs it: the owed list is the server's bookkeeping. And nothing rides on `thread.handed-back` with a flag, because an old client would read that as delivered.
- **The ceiling.** Optional `requestCeiling` and `passBlocked` on a message and on the commands and events that start a turn from it. Optional `followUp` on `fromThread`. `PeerSendInput` gains optional `ceiling`, and `PeerDescriptor` a flag that says the computer enforces it.
- **Stop.** A server-only `cause` on `thread.session.stop` (`family`, `cleanup`), which the Normalizer refuses from clients. The chain stop can move the chain epoch without leaving the hold. The fallback's resend carries a chain epoch. Nothing new is stored on the session: the turn a Stop was for is already there (`stopRequestedTurnId`, migration 118).
- **`thread.delete`**: optional `alsoDelete: ThreadId[]`.
- **Removed.** The late-reply functions and the `lateReplies` field's use. Old events that carry it still decode. The local use of `finishedTurnAfterRestart` for waiting requests.
- **Shared code.** `attachedDescendantsOf(threads, rootId)` in `packages/shared/src/childThreads.ts` returns the subtree in tree order with each thread's level, with a visited set. The "still going" test sits beside it. The server's stop, wrap, revert, archive, delete and move rules and the web's sidebar, tabs, menus and delete dialog use them. `attachedChildrenOf` (`childThreadDecisions.ts:193`) stays for the places that mean direct children. "Started without report back" has no name in the code today (it is a thread with a parent that was never attached, attachment epoch zero), so it gets a named helper.
- **No migration.**
- **Older clients.** Every new field is optional, and excess fields are ignored when decoding. The builder confirms an older client decodes a thread and a message that carry them, as Part 1 did for the counters.

### Every surface

- **Entry points.** The composer's Stop, the sidebar row menu, the family tab row (tabs and the proposed Stop button), the delete, archive and revert dialogs, the move dialog and the quit dialog. The command palette has no family actions and gets none. There is no keybinding for any of this.
- **Clients.** Web and desktop share the components. The phone uses them over the relay, so the indent and the tab row need a check at phone width. A phone or another computer on an older version shows a nested family the way it shows one today (grandchildren missing from the sidebar) until it updates. Its Stop and "Stop N working threads" still stop the whole subtree, because the server decides. Its delete sends `withChildren` and deletes one level.
- **Providers.** Every provider that gets thread tools today gets them in a child the same way (Codex, Claude, OpenCode, and ACP agents that take HTTP MCP). No driver changes. The plan reads two things a driver already reports: whether a provider-started turn is a check-back, and the list of check-backs, which only Claude has. Community agents get the behavior only through the generic core.
- **Contracts.** Everything under "Data model".
- **Reverse states.** Stop on a thread and the next message that no agent wrote. A subtree stop and the next message from above. Wrap and reopen, with reports dropped only in between. Archive and unarchive of what that archive stamped. Separate and put back at any depth. Delete has no way back, so it deletes only what the dialog listed.
- **The app guide.** The child-threads topic (`apps/server/src/guide/topics.ts:110-124`) changes in six places: threads can start threads; a thread that takes another turn on its own after its answer now wakes its parent with that reply, where it used to wait for the parent's next turn; Stop on a thread stops the threads under it, and "Stop N working threads" covers every level and counts a thread that only checks back; a thread another thread started only starts threads on its own computer and only ones that report back; a thread started without report back starts threads only after you write in it; a thread can't be reverted while threads under it are still going. The lead chat topic's line on a pass target gains "and neither can the threads it messages". No setting row moves, so `appPlaces.ts` is unchanged.
- **Docs.** `child-threads.md` (Depth 1, Delivery, Late replies, Stop, revert, put back, archive, delete), `lead-chat.md` (family tabs, no fan-out, the usage-limit rule for report turns), `fleet.md` (a move carries one level; what a move waits for).

### Tests (extend existing files)

- **Shared rules** (`childThreads` tests). An attached child may start, send, stop and wrap, and may not start a thread without report back. A thread started without report back may not start threads until a person has written in it. Put back is allowed for a thread with threads of its own and refused for one with threads on another computer. A send is refused when the child has more access than the request's ceiling, and when the child is under the user's hold. `attachedDescendantsOf` returns tree order and levels and survives a cycle in bad data. "Still going" is true for a thread that only holds a runtime check-back and false for an idle open session.
- **Which turns report** (decider tests, commands in and events out). One case per kind of start: a parent's request, a person's message, an outside agent's, a hand-off, a hand-off's reply, a review's reply that arrives after the asking turn ended, a report from its own thread, a scheduled run, an automatic fix, a check-back, background work. A continue after a limit, a restart and an account switch each follow the turn they continue, for a person's turn and for a reporting one. A turn whose request was cancelled when its agent left sends nothing.
- **Reports** (`childThreadDelivery` tests, pure, and decider tests for the settle).
  - Completed is delivered; failed delivers the failure text, with the "continues by itself" line when the wait is armed; a second settle of the same turn is refused.
  - A turn interrupted by the Stop that named it is dropped. A turn interrupted with no Stop (Claude's "runtime stream ended") delivers "stopped before it finished", for an owed entry and for a request, and never says the user stopped it.
  - A session that exits with a turn still running and no turn end (the Codex case) settles the owed entry and the request the same way.
  - Each drop on its own: `thread_stop`, separate and put back, the parent held, the child held, the parent wrapped by hand. After the parent is reopened, the child's next turn is delivered.
  - A report queued in R before the user stops M still reaches R.
  - A failed start settles a request `failed`, and delivers a failure for an owed entry. A start taken back sends nothing.
  - A failed turn in M with two reports queued behind it says so in its failure report, and R's next send to M lets M read them first.
  - In an attached child, a report from its own thread is not steered into a running turn, the user's or a request's. In a thread with no parent it is steered as today.
  - A follow-up goes to the agent that started the child, and to the thread's own agent once that one has left. One already queued when that agent leaves is handed to the thread's own agent. An answer queued for a leaving agent is taken off, as today.
- **Waiting answers.** A background follow-up answers the waiting request. A check-back, a report, a later request and the user's message each settle it first with its answer so far. After a check-back did, the background work finishing with no further turn leaves nothing open. After a restart, a waiting request is answered only by a turn whose entry names it, and a settled check-back is never sent again as its answer.
- **Stop** (decider tests).
  - `thread.turn.interrupt` on a root with three levels: every thread under it that is still going is stopped in one decision, the root has the hold, and no thread under it gains one, even one that is a room or had an agent's message queued.
  - M was stopped by the user earlier and still has its hold. The user then stops R. M keeps its hold.
  - After a stop the user writes to the root, the root sends M, M runs and sends G, G runs. Nobody wrote in M or G.
  - Archive and unarchive of M leave no new hold on it.
  - A fallback resend issued before a Stop and decided after it is refused, and the hold stays.
  - A scheduled run into a stopped lead runs as it does today.
  - "Stop N working threads" targets a child that only checks back, and the count includes it.
  - An outside agent's stop leaves running a thread above its limit and names it.
- **Wrap, revert, archive, delete.** `thread_wrap` wraps M when G finished and its session is still open, and returns `working` while M has a start waiting for approval. Revert in R is refused while G works for M with nothing open in R, and while G only checks back; in both cases the menu offers "Stop N working threads", and revert is allowed after it. Archive and unarchive of three levels with one live thread in the middle and one that only holds a check-back. Delete with `alsoDelete` deletes the listed threads and separates one started after the list was made; `withChildren` alone deletes one level.
- **Access and the pass.** R sends M a request, the user widens M, and the turn is refused at the decision and again in the reactor. M stops on a usage limit while answering R, the user widens M, and the continue at the reset is refused and R's request settles `failed`. A request from a pass-blocked thread sets the receiver's block; the receiver can't start threads; the block lifts on a person's message and on an unflagged request from its parent. A send to a linked computer with the flag carries the ceiling, and a queued remote request above it is refused there. A send to one without the flag is allowed from a sender with the widest access and refused from any other.
- **Reactor and ingestion.** G's report starts M's turn and M's reply reaches R and starts R's turn. Startup delivers an owed turn that completed before the crash, delivers one interruption report for a cut-off owed turn, and ignores turns with no entry. A reaped child's waiting request settles `answered`, with no "user stopped".
- **Handlers** (`threadToolHandlers` tests). Each tool from an attached child; `thread_stop` returns `stopped` for an idle child with a thread under it that is still going; a start on another computer from an attached child is refused.
- **Moves.** With R, M, G and a leaf S under R: R, M and G are each refused, at admission and at the start of the move, and S may move alone. "Move when done" on a child waits while it owes a report or its parent has a request open for it.
- **Old clients.** A thread replay that spans a dropped report decodes on a client built before this change (a fixture of the older union).
- **Web logic.** `Sidebar.logic.test.ts` ("child thread families"): tree order, levels, subtree counts and dots, the collapsed set, the root key walk, a wrapped middle thread with a live thread under it, a live thread under a wrapped parent heading its own family, a middle thread that does not auto-wrap while a thread under it works or while it has a start waiting. `familyTabs.logic.test.ts`: the tabs equal the sidebar's members for a root, a middle thread and a leaf. `threadMenu.logic.test.ts`: the count by "still going". Delete: a test for the ids it sends.
- **Browser.** `InboxRows.browser.tsx` and `ChatView.sidebar.browser.tsx`: three levels render under one root, open and collapsed. `ChatView.agents.browser.tsx`: the tab row for three levels. Polish shots with the real fonts at desktop and phone width.
- **Live**, on a throwaway stack (never `~/.threadlines/userdata`). Stage 1: a Claude parent and a child; the child's check-back wakes the parent; Stop on the parent stops the child and its check-back; killing the child's Claude process mid-turn tells the parent it stopped unexpectedly; a restart with the child mid-turn tells the parent once. Stage 2: a root starts a child that starts a grandchild; the grandchild's answer reaches the root and wakes it; Stop on the root stops all three; a Codex child in the chain covers a provider that queues reports.

### Build steps

Two stages, each its own pull request. Stage 1 changes how today's one-level families behave and can run for real before any thread nests. Stage 2 turns nesting on. Within a stage the server steps touch the same files and are built in order by one builder; the web step runs beside them in its own worktree.

**Stage 1: reports, access and Stop for today's families.**

1. **Contracts and shared rules.** The owed list, the report command and its event (outside the thread stream), the ceiling fields, the stop cause, `alsoDelete`, the "still going" test, the two refusals for threads without report back. Shared tests, and the old-client replay fixture.
2. **Reports.** Which turns report, the owed list, the settle and its drops, stopped on purpose against ended by itself, the stopped-session settle, waiting answers, failed starts, no steering into an attached child, a leaving agent's queued follow-ups, startup recovery, the removal of late replies. This is the risky step. It changes when a parent is woken.
3. **Access.** The request ceiling at every check, the continue that keeps it, the linked send and its flag.
4. **Stop.** Stop causes and the hold, Stop reaching a thread's children, the shared test in the stop decision and the tool, the fallback resend's epoch, the revert rule, delete by ids, the wrap test, what a move waits for. Guide topic and docs for these.
5. **Web for stage 1.** The count in "Stop N working threads", the delete dialog's ids, the proposed Stop button. Before and after shots.

**Stage 2: nesting.**

6. **The walk and the cascades.** `attachedDescendantsOf`; Stop, `thread.children.stop`, `thread_stop`, archive, unarchive, delete, revert and wrap over a subtree; put back at any depth; the move refusal; the pass block's inheritance; the linked-computer fence.
7. **The switch.** The removed depth refusals in `childThreads.ts`, `thread.create` and the handlers, then the preambles and tool descriptions. Nesting becomes reachable only here. Guide topics and the docs.
8. **Web for stage 2.** The family tree in `Sidebar.logic.ts` and its rows, the summary line, the auto-wrap condition, family tabs, menus and counts, the move and quit dialogs. Before and after shots.

Each stage ends with the gates (`vp fmt`, `vp lint`, `vp run typecheck`, the targeted tests, `@threadlines/web#test:browser`) and its live list. Review: Astra reviews the diff of steps 2, 3, 4, 6 and 8 when each is done.

### For Will to decide

1. **Stop reaches the threads under a thread.** Still open. The plan says yes, as T3 Code does. It changes today's rule, where a parent's Stop leaves its threads running. The alternative keeps today's rule and relies on "Stop N working threads", which then has to be found in a menu while a subtree keeps itself going. If the answer is no, the cascade goes and the rest of "Stop" stands.
2. **The "Stop N threads" button on the tab row.** Still open. Proposed so the brake is on screen while a root waits. The plan works without it.
3. **Two stages.** Still open. I recommend shipping stage 1 by itself first. It is the part that changes when agents are woken, and real use at one level will find what four reviews of a plan have not.
4. **The access ceiling over the link.** Still open, and sharper than in rev 4. I recommend the optional field and the flag. With them, a linked computer that has not updated takes work only from a parent with the widest access. Without them, a parent the user has narrowed can still send work to a wider child on another computer, as it can today, and the plan cannot say a child never has more access than its parent.

Things decided here that Will should know about:

- In a room, a thread's later reports go to the agent that started it.
- The lead can be woken by work the user asked a middle thread for directly.
- Late replies go away. Work that used to wait for the parent's next turn now wakes it, or is dropped on purpose.
- A thread another thread started can't start a thread without report back, and a thread started without report back can't start threads until the user writes in it.
- A child whose runtime dies mid-turn now tells its parent it stopped unexpectedly. Today the parent is told the user stopped it.
- No limits of any kind; nested trees stay on one computer; no nested family moves to another computer yet.

## Review of Part 2, rev 1 (GPT-6.2 Astra, Nov 23 2026)

Checked against the code; each holds. Under each finding is the answer as it stands in rev 5.

1. **Pending reports are owed work too.** A child's request leaves `open` when its report is queued, not when the middle thread has read it. M with G1 and G2: G2 settles while M handles G1's report on a provider that can't steer, so M's turn ends with zero open requests and R gets the G1-only answer.
   - Nothing above M waits on M's threads. M's G1 turn and its G2 turn each go up as a report (delivery rule 2).
2. **Downstream work needs the upstream request's identity.** R sends M a second task while the first waits on G: M's second turn sees G open and becomes a candidate too; G's report steered into it answers the wrong request. In a room the two requests can come from different agents.
   - A request answers only to the turn its own message started, and in a middle thread a report is never steered into another turn (rule 9), so no request gets another's content. Which room agent hears a later report is a fixed rule: the one that started the thread (rule 8).
3. **The session reaper (`ProviderSessionReaper.ts`, 30 minutes idle) stops an idle middle thread** whose children are still working, and `ChildThreadReactor.settleStoppedAnswers` then tells R "the user stopped" M. Runtime eviction must not read as a stop.
   - A turn or a session counts as stopped by the user only when a Stop named it (rule 6). The reaper issues no Stop, so nothing it closes reads as one, and no mark is needed.
4. **Restart** settles R before M's queued report replays (M has zero open requests once G settled), misses a report turn that completed before the crash (recovery only matches `pendingMessageId === null` continuations), and delivers M's first turn when its `awaiting_background` update didn't commit.
   - The first and third need a request held across M's turns, which does not exist. The second is rule 14: every reporting turn is on the child's owed list from its start, and startup settles what is still on it.
5. **A room hand-off in M** goes through `thread.turn.start` without `fromThread`, so `settleCandidateBeforeUserTurn` sends R the candidate while G works.
   - A waiting answer now ends at the child's next turn of any kind (rule 4), and that is safe because what M finishes later goes up as reports. A turn that answers a hand-off is recognised by its starting message and is not reported; the asking agent's next turn is (rule 2).
6. **Usage-limit continue** (`isHeldByContinueAtReset`) requires `running` and the failed turn's own message; an `awaiting_background` request continued by a report turn fails at once.
   - No request rides on a report turn. Its failure goes up at once, and the continue is a turn of its own that reports when it ends (rules 5 and 13).
7. **Reports with no local attached child** (a remote G with `environmentId`, a `neverMade` G) still start turns in M; and a queued report taken back (separate, wrap, room departure) triggers no re-check.
   - Rule 2 reads how M's turn started, not who the report came from. A report from another computer can't arrive in a middle thread: an attached child can't start threads there, and no thread in the nested part of a family moves there. Nothing is held, so a report taken back needs no re-check.
8. **The MCP handlers have their own depth checks** (`threadToolHandlers.ts` start, local ownership, remote send, remote stop, wrap), separate from the shared and decider rules listed above.
   - All five are listed under "Rules that go". Start, local ownership and wrap go. The two remote ones become the linked-computer fence.
9. **Nesting lets a lead pass escape its ceiling** (T passes to its existing child M, which carries no pass block and starts G), and ordinary sends don't re-check the parent's current access when the user narrowed it after the child was made.
   - A blocked thread's requests carry the block down. Every request carries the sender's access, checked at the send, at turn start and in the reactor, and a continue keeps it ("Access").
10. **Delete with its threads** would delete more than the dialog counted (`useThreadActions.ts` counts direct children only and winds down only those).
    - The command names the threads the dialog listed (`alsoDelete`), and the server deletes only those. Cleanup now follows what the server really deleted (#1051).
11. **Agent-issued subtree stop** returns `not_running` for an idle M whose child works (`childHasWork` ignores M's own requests), and stopping M first settles the requests used to find the rest.
    - `childHasWork` uses the "still going" test over the subtree, targets come from walking `parentThreadId` before anything settles, and a thread stopped with its family gets no hold ("Stop").
12. **Late replies and moves** assume one level (`lateRepliesForAgent` returns early for an attached thread; move admission and whole-family moves refuse or flatten a middle parent).
    - Late replies are gone (rule 12). A nested family does not move, and neither does a thread inside its nested part.
13. **The chat's family tabs** (`familyTabs.logic.ts`) list a parent's direct children only and would disagree with a nested sidebar.
    - The tabs show the same members in the same order as the sidebar, from one function ("Chat").

Atomicity is fine: the engine commits one decision's events in one transaction, and `decideCommandSequence` projects each step before the next.

## Review of Part 2, rev 2 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 2 and accepted the decision to settle each request with its own answering turn. It found 13 problems in the rest. All 13 held against the code; 10 and 13 were narrower than stated. Under each is the answer as it stands in rev 5.

1. **Stop can strand the team, and can come off without the user writing.** A subtree stop issues `thread.session.stop` per descendant, which runs the chain stop and would hold M and G. Archive cleanup has the same effect. A scheduled run's queued message lifts the hold.
   - A stop has a cause, and only the user's Stop on the named thread leaves the hold. What lifts a hold is left as it is today. A schedule is automation the user set up, and it already lifts a Stop in a room.
2. **Stopping M does not stop M's own check-back from waking R.**
   - Fixed on main. Since #1057 the user's Stop ends every agent's check-backs in the thread. A report from a held thread is dropped as well (rule 7).
3. **A delayed completion can cross a Stop, a separate and put back, or a wrap and reopen.**
   - The owed entry holds the two epochs from when the turn started, and the settle delivers only if they still match. A wrapped parent is checked by its state (rule 7).
4. **Linked-computer sends cannot enforce the access ceiling, and an outside agent's stop would reach a descendant above its limit.**
   - The ceiling goes over the link as an optional field. A computer that does not say it enforces it takes work only from a sender with the widest access ("Access", and "For Will to decide"). An outside agent's stop reaches only the threads that agent may stop itself.
5. **A lone move can create the cross-computer grandchild the plan says cannot exist.**
   - A thread whose parent is itself an attached child does not move, checked at admission and when the move starts. Put back is refused for a thread with threads on another computer.
6. **Looking at what is open when a turn ends confuses an answer with a follow-up.**
   - Whether a turn reports is read from the message that started it, when it starts (rule 2).
7. **The wrong room agent is woken, and a check-back or a continue is credited to the wrong work.**
   - Rev 3 tried to route each report to the agent whose work it was, and that cannot be done for every kind of turn. A later report goes to the agent that started the thread. A continue of a person's turn stays the person's (rule 2).
8. **The late-reply net can pass on an outside assistant's answer, repeat a report, or lose one when a report is steered into a person's turn.**
   - There are no late replies on this computer any more (rule 12), and a middle thread never has a report steered into a turn (rule 9).
9. **The two-minute startup window can't tell an upgrade from a crash, misses failed and older turns, and a restart can report an interruption twice.**
   - The window is gone. Startup settles the owed lists, which only turns started after this change are on, and one function decides each turn once (rule 14).
10. **A report turn that never starts leaves R waiting, and a named room agent's turn skips the usage-limit wait.**
    - A failed start settles what its message owed (rule 11). A failed turn reports at once whether or not it waits to continue (rule 5).
11. **A crash while a report is being steered delivers it twice.**
    - In a middle thread reports are never steered, so it can't happen there. In a thread with no parent it can, as it can today for answers. The third review accepted that as a stated limit.
12. **`thread_wrap` refuses a finished subtree while sessions are merely idle, and misses a grandchild start that waits for approval.**
    - Wrapping uses "outstanding work", which leaves out an idle open session and includes the thread's own open requests.
13. **Delete can remove a thread the user never confirmed.**
    - The command names the threads the dialog listed.

## Review of Part 2, rev 3 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 3 and found 12 more problems, in paths that bypass the turn start, mix the work of two turns, or read a different record after a Stop or a restart. Findings 3, 6, 7 and 9 were about the routing rev 4 removed and were taken as true without tracing. Under each is the answer as it stands in rev 5.

1. **A report queued in a busy R still wakes R after the user stops M, and a report dropped for that Stop can come back as a late reply.**
   - First half rejected. A report M finished and queued before the Stop is not cancelled by it. The user stopped M, not R, and a child the user stops even tells its parent so. Cancelling would also take back answers a parent has not read yet, which no Stop does today. Second half fixed: there are no late replies, so a dropped report stays dropped.
2. **The access check ends before the provider receives the work.**
   - Fixed. The message carries its ceiling, and the same helper checks it in the reactor where a pass's ceiling is checked today, after the thread is reread.
3. **A provider-started background turn can report to the wrong room agent.**
   - Gone. No turn is assigned to an agent by position. A later report goes to the agent that started the thread.
4. **Steering mixes two requests from the same agent, and a person can steer into a turn that reports upward.**
   - First half fixed: in a middle thread a report is never steered. Second half rejected: a user's steer becomes part of the turn it lands in. That is the standing rule for answers (`child-threads.md`, rev 3 fix 5), and a follow-up turn is treated the same.
5. **Restart recovery can deliver one check-back as both a request's answer and a report, and the decider can't see an older turn's state.**
   - Fixed. The owed list is in the thread's state. A check-back settles a waiting request when it starts and never answers it, and after a restart a waiting request is answered only by a turn whose entry names it (rules 4 and 14).
6. **A review that returns after the asking turn ended loses its route.**
   - Gone. There is no route to lose. The reply starts a turn in M that no person wrote, so it reports (rule 2).
7. **A scheduled run into a stopped lead stays queued and blocks later runs.**
   - Gone. What lifts a hold is as it is today, so the run starts as it does now.
8. **An account switch and an overtaken reset continue can lose the answer.**
   - Fixed for reports: nothing is held for a continue. The failure has already gone up, and a continue reports as its own turn unless a request was moved onto it (rule 2). For requests, the failure a parent is told when an account is switched is today's behavior and is not changed here.
9. **Claude does not always give a check-back's id, and updates from idle room agents can bind one to the wrong turn.**
   - Gone. Nothing uses a check-back's id. The plan only reads the mark that a turn is a check-back.
10. **A family stop must not remove a hold the user put on a descendant, and an automatic resend can lift a hold.**
    - Both fixed. A hold a thread already had stays. The fallback's resend carries the chain epoch of the turn it resends and is refused after a Stop.
11. **Revert lets a subtree wake a lead about work the user removed.**
    - Fixed. Revert is refused while any thread under the thread is still going.
12. **An older phone's delete can still take a child that appeared after its count, and a new event type breaks an old client that replays events.**
    - First half rejected as not fixable here: the old command has no field to say which threads it meant, and the race exists today at one level. Second half fixed in rev 5: the new event type is kept out of the thread stream. Rev 4 left this to the builder to confirm, and the fourth review showed the assumption was wrong.

## Review of Part 2, rev 4 (GPT-6.2 Astra, Nov 23 2026)

Astra reviewed rev 4 (commit 9144768f9, before the rebase) and judged stage 1 unsafe as written: the access bypass, lost follow-ups and several Stop failures already happen with one parent and one child. It found 10 problems and checked the two things rev 4 left to the builder. Each was read against main at 66ab80915. Each line says whether it is fixed on main, still open or changed, and how rev 5 answers it.

1. **A usage-limit continue can run a parent's request with wider access, and an older linked computer can ignore the ceiling.**
   - Holds, both parts, and still open on main. The continue is a fresh message with the thread's current access and no origin (`decider.ts:5463`), and the reactor reads a ceiling only from the turn's own message (`ProviderCommandReactor.ts:2584`). Rev 5: a continue keeps the ceiling of the turn it continues, and a refused continue fails the request it held. Over the link, a computer that does not say it enforces the ceiling takes work only from a sender with the widest access.
2. **An agent can start work outside the Stop walk with `reportBack: false`, and a recurring check-back survives the composer's Stop.**
   - First part holds and is open on main: the thread is its starter's child on paper, never attached (`ThreadBootstrap.ts:687`), and it can start more. Rev 5: a thread another thread started can't start one without report back, and a thread started without report back can't start threads until a person writes in it. Second part is fixed on main by #1057.
3. **A child can disappear mid-report without waking its parent or reporting failure.**
   - Holds and is open on main, where it also misreports a request: Claude's stream ending mid-turn closes the turn as interrupted (`ClaudeAdapter.ts:8479`), and the parent is told the user stopped it. Codex can exit with no turn end at all. Rev 5: stopped on purpose is read from the turn a Stop named, which main records since #1057. Anything else that ends a turn or a session reports "stopped before it finished", from the turn end and from the stopped-session reactor (rule 6).
4. **A check-back can strand a background answer, then be delivered twice across a restart.**
   - Holds and is open on main for the first half. Rev 5: a waiting answer lasts only until the child's next turn starts, so a check-back settles it with its answer so far before it runs. The positional restart rule is dropped for waiting requests (rules 4 and 14).
5. **A middle thread can leave a delivered report unread after its turn fails, and a follow-up queued for an agent that then leaves the room is lost.**
   - Both hold. First: the queue does not move on a failed turn (`ProviderCommandReactor.ts:6203`). Rev 5 does not change the queue. The failure report says how many reports are waiting, and the parent's next send starts the queue, oldest first (rule 10). Second: fixed. The leave decision hands a queued follow-up to the thread's own agent (rule 8).
6. **Wrapping R doesn't stop its child's next check-back from waking it.**
   - Holds, and it is worse than stated: a wrap moves the epoch only when the thread has something open (`childThreadDecisions.ts:1941`). Rev 5: a report is dropped while its parent is wrapped, read from the parent's state (rule 7). Reopening lets reports through again.
7. **Archive can cancel the very check-back the parent waits for.**
   - Fixed on main by #1056. The cascade in this plan uses main's test going down ("Archive").
8. **`alsoDelete` protects the thread row too late to protect a surviving child's data.**
   - Fixed on main by #1051: the client winds down only the named thread, and the server cleans up each thread it really deleted. `alsoDelete` stays for the other half, the count the user confirmed.
9. **A one-level move can outrun report settlement, and the nested move rule misses a leaf beside a nested sibling.**
   - First half holds in part. A frozen child does not block the settle, because the freeze reads the parent the command names (`threadMoveDecisions.ts:866`). But a child can freeze with a report still owed, since a move waits only for the thread's own requests and queue. Rev 5: a thread that owes a report, or has a request from its parent open, counts as working for a move. Second half rejected: a leaf directly under a top-level thread may move alone even when a sibling has threads. That leaves a top-level thread with one child on another computer, which is allowed today. Rev 4's sentence said the rule covered every member of the family, and that sentence was wrong, not the rule.
10. **Revert can tell the user to press a Stop control that doesn't exist.**
    - Holds. Rev 5: one "still going" test for the revert refusal, the stop's targets and the menu's count. An idle open session is not going. A thread that only checks back is, which today neither the server's target test nor the menu counts.

What rev 4 left to the builder:

- **Old clients do replay events.** Astra is right, and main confirms it: a resubscribe replays stored events through `isThreadDetailEvent` (`ws.ts:248`, `:1744`), the client decodes a closed union, and one unknown type fails the batch. Rev 5 keeps the one new event type out of that filter and puts no flag on `thread.handed-back`.
- **The stored session has no room for the reaper's cause, and the reaper's write can land late.** Right on both counts. Rev 5 needs no cause: see finding 3.
