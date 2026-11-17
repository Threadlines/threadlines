# Lead chat: one place to run a project

Status: plan rev 5 (Nov 17 2026), built in five pieces (see Build order). Rev 4 adds
family tabs (piece 5), asked for by Will after seeing pieces 1 to 3; that section has not been reviewed. GPT-6.1 Sol reviewed rev 1 (13 findings)
and the two redesigned parts of rev 2 (6 findings). Each was checked against the code
and all hold; the answers are in "Changes from review" at the end. Rev 3's answers to
the second pass were not reviewed again. Awaiting Will's go.

## Goal

Each project can have one **lead chat**. The user drops work into it (a bug, a stack
trace, a list of tasks). Its agent answers small questions itself, starts a thread for
new work, or passes the message to the thread already working in that area, and tells
the user when the threads it started finish. Beside it, a **Threads** panel shows the
project's threads grouped by what needs the user.

This is Threadlines' answer to Claude Code's Projects beta (Sep 2026:
code.claude.com/docs/en/claude-projects). We take the product idea and build it from
what we have: child threads (docs/design/child-threads.md), the pull request watcher,
scheduled and event tasks, linked computers. No second orchestration system.

What we do better than Projects, on purpose:

- **Any agent can lead.** Claude, Codex, OpenCode, Muse, Pi, and ACP agents that take
  our tools. Their coordinator is Claude only.
- **It runs on the user's computers,** with their tools, hooks and sign-ins, and can
  start threads on linked computers (`thread_start`'s `computer`).
- **The lead can pass work to threads the user started by hand,** not only its own.
- **The lead is replaceable.** What is in flight lives in the threads and the panel,
  not in the lead's memory, so a fresh lead chat picks up from `thread_list`.

## Decisions (each is hard to undo; the reasons are here so they can be argued)

1. **The lead is a role on an ordinary thread, named by a pointer on the project.**
   `leadThreadId` on the project, at most one per project per computer. Not a new
   thread kind and not a flag on the thread: one pointer makes "at most one" true by
   construction, and every existing thread feature (rooms, fork, revert, queue) keeps
   working without a second code path.
2. **The lead's own threads are an ordinary family.** Threads it starts are attached
   children, fold under its sidebar row and report back, exactly as today. No new
   sidebar grouping. The Threads panel is where the whole project is seen.
3. **Passing work to a thread the lead did not start is one-way.** The message lands
   in that thread as the lead's, the thread does the work, and the user sees the result
   there. Nothing comes back to the lead by itself; it reads the thread when asked.

   Rev 1 had the answer come back as a report. Sol's review showed what that costs:
   every place that finds a request does it through the thread's parent (turn-end
   delivery, the error and quiet-answer settles, taking back a queued message, archive,
   delete, revert, the report's own validity check, Stop's epoch, the done alert), so
   answers from a thread with no parent would need a second lookup in about ten places,
   plus a new rule for a target that hands the work to its own children. One-way needs
   none of it, because the code already runs a request-kind message in a thread that is
   not an attached child with nothing bound to it (a separated child's leftover
   messages take this path today: decider.ts "The request this turn answers was
   cancelled" applies only to attached children, and the binding at turn start finds
   no request and emits nothing). A thread the user started is the user's; its result
   belongs in front of the user, with its normal alert. Report-back for passes can be
   added later without undoing anything here.

4. **The lead never wakes for work it did not ask for.** Only answers from threads it
   started reach it. This keeps usage predictable; the panel shows everything else.
5. **Role text rides the per-turn context, not the system prompt.** It is the one
   hook that reaches every provider (ACP agents hear no system instructions of ours)
   and has the thread in scope. Claude's system prompt append must not differ between
   threads (prompt cache), so it cannot go there.
6. **A usage limit with a known reset pauses agent-started work instead of failing
   it,** when "Continue at reset" is on, for threads on this computer. Without this a
   lead left alone stops at the first limit: the child fails, the report turn fails on
   the same limit, and both wait for the user.
7. **The board is a right-panel tab, not a page and not a sidebar mode.** It sits
   beside the conversation where work is handed out, works as a sheet on a phone, and
   costs no eighth rail destination.

Out of scope here, with the seam named so they fit later: a project brief and shared
project notes (they append to the lead's role text and to a child's first-message
preamble, both built in `ProviderCommandReactor`), one Pause for a whole project, and
usage per project.

## User-facing behavior

Words below are the on-screen words. Copy follows the repo's copy rules (no em dashes).

### Making and unmaking a lead

- **Thread menu** (sidebar row menu and the chat header's title menu): "Make this the
  lead chat". On the lead: "Stop using as lead chat". When another thread is the lead:
  "Make this the lead chat instead of <title>".
- **Project menu** (the project picker's "…" and its context menu): "Open lead chat"
  when there is one, else "New lead chat". New lead chat creates a thread in the
  project folder (no worktree), makes it the lead and opens it.
- **Command palette:** "Go to lead chat" (one entry per project that has one), "New
  lead chat", "Make this thread the lead chat" / "Stop using as lead chat".
- **No keybinding command (built):** a new `navigate.leadChat` would extend
  `KeybindingCommand`, a closed set an older client decodes strictly: one rule naming
  it makes that client reject the whole keybinding list, and with it the computer's
  config. "Go to lead chat" stays in the palette. Commands can come once clients drop
  rules they don't know (a follow-up).
- **Not allowed, with the reason shown on the disabled item:** General Chats; a thread
  another thread started and still owns; a thread from another computer or an outside
  agent; an archived thread; a thread with a move pending; an agent that cannot use the
  thread tools; "Agents can start threads" off (the reason links to that setting).
- **Takes effect at the thread's next turn.** A turn already running is not told.
- **Ends by itself** when the lead thread is archived or deleted. Moving the lead to
  another computer is refused: "This is the project's lead chat. Pick another lead
  first."
- Nothing is lost when a lead stops being one: it becomes an ordinary thread, and the
  threads it started stay its family.

### Sidebar

- The lead's row carries a lead glyph before its title and "Lead" in place of the
  project name on its second line (the project name stays when several projects are in
  scope: "Lead · <project>").
- It sorts first: ahead of pinned rows, never folded, never wrapped by the idle or
  pull request rules. In project grouping it is the first row of its group.
- Its children fold under it as any family does. Nothing else changes.

### Chat

- Header chip "Lead chat", built like the "Started by" chip.
- Empty composer placeholder: "Drop work for <project> here".
- The Threads panel does not open by itself (rev 4: the family tabs below are how the
  lead's threads are reached; the panel is the whole-project view, opened on purpose).
- A message the lead passed into another thread is authored "<lead title>" there, as a
  parent's messages are in a child today.

### Family tabs (every family, not only a lead's)

A thread that started other threads, and each thread it started, show one row of tabs
under the chat header: the parent first, then its threads. Clicking a tab opens that
thread, the same full chat as today with its own message box, scroll position and
draft. The point is that the user never loses their place: the lead (or any parent) is
always one click away, and so is every thread it started.

- **Which threads.** Exactly the members the sidebar shows for that parent's open
  family (attached children that have not left the live family, `hasLeftLiveFamily`
  and the rules around it), in the same order (creation order, never re-sorted). One
  function decides membership for both, so the tabs and the sidebar cannot disagree.
  A child on a linked computer gets a tab when the sidebar gives it a row, and a click
  does what that row's click does.
- **When the row shows.** On the parent while it has at least one member, and on each
  member while its parent is live. A thread with no family has no row. A child the
  user made its own, or whose parent is wrapped or archived, has no row and keeps
  today's "Started by" chip.
- **A tab.** The parent's tab is its title; a lead's is the flag and "Lead". A child's
  is its status dot (the family child rows' colours and words; a check once wrapped
  and still in the family) and its title. The open one has a quiet fill. Hover is a
  colour shift. Right-click or a long press opens the sidebar's thread menu. There is
  no close button: a tab is not an open file, and wrapping up stays in the menu.
- **Too many to fit.** Tabs shrink to a floor (about 96px), then the rest move behind
  a "+N" menu at the end of the row, which lists them with their status. The open
  thread's tab is always on the row. "+N" carries an amber dot when a hidden thread
  needs the user. On a phone the row scrolls sideways instead and the open tab is
  scrolled into view.
- **What it replaces.** While the row shows, the header drops the "Started by" chip
  and the "Lead chat" chip: the row says both.
- **The sidebar is unchanged.** The open child still shows under its parent's row as
  it does today. (Hiding it, so only the parent's row is marked, would mean reworking
  the sidebar's keyboard order for no gain the tabs do not already give.)
- **No flash.** The row belongs to the family, not to the open thread: switching
  between members must not unmount or redraw it, and the chat below must not shift.
  The row appearing when a parent starts its first thread shifts the chat once.
- **Speed.** A tab switch is a thread open. The threads on the row use the sidebar's
  existing prewarm, so a switch paints as fast as a prewarmed sidebar row. The row
  reads a narrow selection (id, title, status per member) with stable equality, so a
  streaming reply in one thread does not re-render it.
- **Keys.** None for now, for the reason under "No keybinding command": the plan's
  `thread.family.next` and `thread.family.previous` wait for that follow-up.

### Starting several threads (approval card, every parent, not only the lead)

The card "<agent> wants to start N threads" gets a checkbox per row, all checked. The
button reads "Start all" or "Start 3". Unchecked rows are declined in the same answer
and the agent is told which. "Not now" is unchanged. The checkboxes show only when the
thread's server says it can take a partial answer (capability `childStartSelection`);
an older linked server would start the whole batch, so there the card stays as it is.

### Threads panel (right-panel tab "Threads")

Available on every thread of a workspace project; one line in the `+` menu: "This
project's threads." Lists the project's threads on every computer in view, in groups.
A thread goes in the first group that fits, in this order:

| Order | Group            | A thread is here when                                                                             |
| ----- | ---------------- | ------------------------------------------------------------------------------------------------- |
| 1     | Done             | the sidebar files it as wrapped, and it was wrapped in the last 7 days (older ones are not shown) |
| 2     | Needs you        | Pending Approval, Awaiting Input, Failed, or Plan Ready                                           |
| 3     | Working          | Working, Starting, Answering, Waiting, Checking back, Continues at reset                          |
| 4     | Landing          | its open pull request has auto-merge on or is in the merge queue                                  |
| 5     | Ready for review | it has an open, non-draft pull request                                                            |
| 6     | Idle             | everything else                                                                                   |

Drawn in the order Needs you, Ready for review, Working, Landing, Idle, Done (Done
closed by default, like the sidebar's Wrapped shelf).

- **Filing comes first.** "Wrapped" is the sidebar's own answer (`fileInboxThreads`),
  not a status: a failed thread the user looked at and wrapped keeps its Failed status
  and still belongs in Done. One exception keeps review work visible: a wrapped thread
  whose pull request is still open goes to Landing or Ready for review, not Done (a
  finished child wraps itself the moment it hands back, pull request still open).
- Rows are one line, like a family's child rows: status dot, title, the existing pull
  request badge, a state word (for Ready for review, the Pull requests page's reason:
  "Review required", "Changes requested", "Checks failing", "Approved"), clock,
  provider glyph, computer mark when not this one. Click opens the thread. The row menu
  is the sidebar's thread menu.
- Header: counts ("2 need you · 3 working"), and a "Lead chat" link when the open
  thread is not the lead.
- Groups with nothing in them are not drawn. More than 8 in a group folds behind "Show
  N more".
- Phone: the panel's existing sheet.
- What the client knows without detail reads: status and filing per thread, each
  thread's pull request (state, draft, auto-merge) from `useInboxThreads`, and review
  decision and checks from the open list matched by repository and branch. Merge-queue
  position is a detail read and is not shown.

## Agent side

### Role text

Added to the context of **every turn that starts in the lead**, whatever started it (a
person, a scheduled or event task, a report from one of its threads, a retry, a
continue). A report turn keeps its own framing line as well.

```
This thread is the lead chat for the project "<title>". The user drops work here and you
coordinate it.
- Answer quick questions yourself. Do not change files in this thread.
- For work, call thread_list with scope "project" first. If an open thread already works
  in that area, pass the message on with thread_send. Otherwise start one thread per
  independent task with thread_start, each with a brief that stands on its own.
- Say in a line or two what went where. When a report comes back, tell the user what
  finished and what needs them. Do not repeat the report.
- Threads you started report back by themselves. Do not poll them. A thread you did not
  start does not report back: the user sees its answer there.
```

- It is a preference, not a fence: we cannot remove file tools on every provider.
- **Paths that do not carry it, by decision:** a message steered into a running turn
  (the turn got the text when it started), and a room agent's side answer (read-only,
  not lead work). Both are named in the builder's tests so a change is deliberate.
- In a room that is the lead, each agent's turns get it.

### Tools

- **`thread_send` from the lead to a thread it did not start** ("a pass"). Allowed when
  the target: is open, in the same project, on this computer, top-level or a child the
  user made its own, not the lead, not a General Chat, not a room, not from an outside
  agent or another computer, has no move pending, and is not held by the user's Stop.
  Refusals say why: an attached child of another thread, "Message the thread that
  started it."; a room, "Rooms take work from the user."; a stopped thread, "The user
  stopped that thread. It takes work again once they write there." The result says
  plainly that nothing comes back: `sent` or `queued` with `reportsBack: false`.
  - **Why no rooms.** In a room the agent answering can hand the work to another agent,
    whose turn no longer carries the pass (agentRequestDecisions.ts), and the slot can
    be another agent's. Refusing rooms keeps every rule below true without a second set
    of room rules.
  - **A Stop that lands after the pass was queued** holds it like any agent message:
    it waits until the user writes in that thread. That is what Stop means.
  - **Access.** The pass carries the lead's access and interaction mode as a ceiling,
    and the ceiling stays on the message for good. It is checked when the tool is
    called **and at every decision that starts a turn from that message**: sent at
    once, sent from the queue, retried, resent. The check is against the target's modes
    at that moment (a user message queued ahead can widen them: agent messages run with
    the thread's current modes, decider.ts send-queued; retry and resend start a turn
    without passing through either, decider.ts ~3350). If the target then has more
    access than the ceiling (`withinModeCeiling`), the message does not run: one line
    in the target ("Not run: this thread has more access than the lead chat"), and a
    note to the lead on its next turn. A retry by the user is refused the same way,
    with "Send it yourself to run it." The user's thread's access is never changed.
  - **No fan-out.** Once a pass starts its turn in a thread, that thread cannot call
    `thread_start` until the user writes there ("This thread is working on something
    the lead chat passed on. Do the work here, or say what should be started.").
    Without this, one message in a lead on Automatic could start threads through every
    thread it passes to. It is a fact on the thread, not on the turn, so a retry or a
    continue of that work cannot shed it. `thread_send` to that thread's own children
    still works.
  - A pass counts against the lead's sends per user message.
  - What the target does with it is the target's business: the user's own queued
    messages go first; Stop, taking the message off the queue, revert and archive work
    as they do for any message, and need no word to the lead.
- **`thread_send` to its own children, `thread_stop`:** unchanged. The lead cannot stop
  a thread it did not start.
- **`thread_list`** summaries gain optional fields: `lead` (true on the lead),
  `lastActivityAt`, `pullRequests` (`number`, `url`, and `state` when the server already
  holds an observation; no network call). Every agent sees which thread is the lead.
- **Limits in a lead:** 10 starts and 20 sends per user message (5 and 10 elsewhere);
  5 per call stays. A scheduled or event run into the lead already counts as the user
  writing (`thread.follow-up.submit` resets the counters), so a lead fed by an event
  task keeps a budget per event, bounded by the task's own daily run limit.
- **Outside agents and assistants:** the project listing they read gains optional
  `leadThreadId`, so "send this to the project's lead" needs no thread id from the user.
- **Tool descriptions** say the lead's extra reach in one sentence each; ACP agents
  learn rules only from descriptions.

### What a passed-to thread hears

A new framing line, chosen when the message's sender is not this thread's parent: "The
project's lead chat "<title>" passed this on. It is from another agent, not typed by
the user. Your reply stays in this thread, where the user reads it."

## Data model

### Project (`packages/contracts/src/orchestration.ts`)

- `OrchestrationProject.leadThreadId?: ThreadId | null` and the same on the shell.
  Template end to end: `phoneAlertsMuted` (#759, migration 100): optional field,
  capability flag (`projectLead` in `environment.ts`) so a client hides the actions on
  an older server, additive column `lead_thread_id TEXT` (next migration, 116; no row
  rewrite).
- Command `project.lead.set { projectId, threadId: ThreadId | null }`. A command of its
  own, not `project.meta.update`, because it validates a thread and cascades. It emits
  the existing `project.meta-updated` event with a `leadThreadId` field rather than a
  new event type (decided while building): every reader of project changes (the shell
  stream, the web store, the git fetch supervisor) already follows that event, so none
  can miss a lead change.
- Decider refuses with the reasons listed under "Not allowed". Setting a lead while
  another exists replaces it in the same decision.
- Cascades, decided on the server: `thread.archive`, `thread.delete` and
  `project.delete` clear the pointer in the same decision. `thread.parent-attachment.set
  { attached: true }` on the lead is refused (a lead is top-level). The thread-move
  decision refuses the lead with words only (no new refusal code: the move's
  `refusalCode` is a closed set older peers decode).
- Readers treat a pointer at a missing, archived or deleted thread as no lead, so a
  replay of old events or a cascade that an older build missed cannot leave a ghost.
- Linked computers keep separate project records, so each computer can have its own
  lead for the same repository. The client shows each lead with its computer's mark and
  the menus act on the project record of the thread's own computer. No fan-out.

### A pass (`ThreadMessageOrigin`)

- The passed message is a user-role message in the target with
  `fromThread { threadId: <lead>, requestId: <new id>, kind: "request" }` and a new
  optional field `ceiling?: { runtimeMode, interactionMode }`. No request is recorded on
  the lead, so there is nothing to settle, hold, cancel or recover. `ceiling` marks a
  pass: no other message has it.
- Command `thread.lead.pass` (server-only, from the tool handler). In one decision:
  `message-sent` and `follow-up-queued` on the target, and the lead's send counter. The
  decider re-checks every rule the handler checked. Idempotent per caller turn, keyed
  like the other thread tools.
- Pure rule `leadPassRefusal(lead, target, project)` in
  `packages/shared/src/childThreads.ts`, used by the handler and the decider.
- When the ceiling refuses a queued entry, the decision takes it back (`cancelled`),
  writes the one-line activity in the target and adds a pending note on the lead (the
  existing `pendingNotes`, delivered on its next turn). If the lead is gone, only the
  first two.
- One helper, `passCeilingRefusal(message, thread)`, is called by every decision that
  emits `turn-start-requested` for a stored message (`thread.turn.start`,
  `thread.follow-up.send-queued`, `thread.turn.retry`, `thread.turn.resend`), reading
  the ceiling from the message itself.
- No fan-out is state: optional `startsBlockedByPass?: true` on the target's
  `OrchestrationChildRequestState`, set by the decision that starts a pass's turn and
  cleared by `thread.child-requests-reset` (the user wrote). `childStartRefusal` reads
  it; `childSendRefusal` does not (both call `callerRefusal`, so the rule cannot live
  there).
- Built (piece 2): the lead's send count, the refusal note and the "started" mark ride
  one event, `thread.lead-pass-recorded` (`kind`: `sent` on the lead, `refused` with
  the note on the lead, `started` on the target), so nothing settles a request that
  does not exist. The note goes to the lead's agent that passed it
  (`fromThread.passedBy` in a room). The block lifts only when a person writes
  (`composer` or `sentFrom` on the turn or the queued message); a continue, a restart,
  a scheduled run or an automatic fix reset the counts with `keepsPassBlock`. A target
  whose last turn failed is refused like a stopped one, since its queue is held the
  same way. Retry never picks a message still waiting in the queue, and the queue
  moves on when the decider takes a message back instead of starting its turn.
- A pass does not stamp `handed-back` and emits no `child-request-settled`, so the
  target's wrap rules and "done" alert are untouched (the alert rule cancels on every
  `child-request-settled`, pushAlertRules.ts).

### Approval answer

`thread.child-request.respond` gains optional `requestIds` with `choice: "start"`:
those start, the rest of the batch settles `declined` with one note naming them.
Absent means the whole batch. Capability `childStartSelection` gates the checkboxes.

### Limits

`childStartRefusal` and `childSendRefusal` take the caller's limits from one function
`childRequestLimits({ isLead })`; the constants stay as the defaults.

## Usage limits: pause, not failure

This applies to every parent, and is what makes a lead safe to leave. It is the
riskiest piece: it changes the child-request state machine. Only with
`continueAfterUsageLimits` on (default stays off; the setting's words change to say it
now covers threads an agent started).

**Covered:** a request whose child is on this computer, and a report turn in a
top-level thread. **Not covered, fails as today:** a child on a linked computer (its
request lives in the other computer's link ledger, LinkRequests.ts, with its own
restart rules and older peers), a thread another computer started here, a child
stopped on a Codex goal that is `usageLimited` (its continue sets the goal active
again and sends no message, decider.ts ~4473, so there is nothing to bind the request
to), scheduled-run turns, room-agent requests, outside-agent turns.

**The rule.** A covered request whose answering turn failed on a usage limit is held
while its child is either waiting to continue at the reset, or running the continue
turn Threadlines sent for it. It settles through the normal turn-end path when that
continue turn ends. It settles `failed`, with today's words, when the wait or the
continue ends any other way.

- **Arming** (`withArmedContinueAtReset`, decider.ts). With the setting on, the wait is
  also armed when the stopped turn was started by a `fromThread` message that is a
  request with an open, same-computer request, or a report in a thread with no parent
  to answer. Never when the user stopped that turn, and never while the thread's Stop
  hold is set: a limit failure that arrives after Stop must not bring the turn back.
  The fire re-checks the hold.
- **Holding.** Ingestion writes the failed session (which arms or does not) before it
  routes the turn's end, so `childDeliveryForTurnEnd` can read the answer: a failed
  turn whose child's session has the wait armed for this failure is not settled. The
  request stays `running`. No new status value.
- **Rebinding.** `thread.continue-at-reset.fire` on a child with a held request emits,
  in the same decision, `child-request-updated` on the parent with the continue
  message's id as `childMessageId` (a new optional field on that event). The continue
  turn's end then answers the request through the normal path.
- **The continue never runs.** After the fire the wait is already cleared, and the
  user's own message can overtake the continue (ProviderCommandReactor,
  `continueOvertaken`), leaving it unsent. The rule that takes back a parent's request
  when its queued message is removed (`settleParentRequestsForUnqueued`) is widened to
  "the message a request is bound to will never start a turn": an overtaken or unsent
  continue settles the request `failed` ("the user took over before it could
  continue").
- **The wait ends without a fire** (skip, the switch turned off, the user starts a
  turn, archive, a reset that is given up): the held request settles `failed` **in the
  decision that clears the wait**, through one helper called wherever `continueAtReset`
  goes from set to null without a fire. It cannot be left to the session-error settle
  in `ChildThreadReactor`: that only runs for a stopped or errored session, and a user
  turn moves the session to starting, running and ready, where nothing would ever
  settle the request (its message id cannot match the user's turn). That reactor settle
  only needs to skip a child whose wait is armed.
- **Restart.** A `running` request whose child has the wait armed is kept (the wait is
  persisted). One bound to a continue that was in flight follows today's rule for a
  turn a restart cut off.
- **Parent side.** Stop, wrap and archive on the parent settle a held request as they
  settle any open one; the child still continues at the reset on its own, as children
  keep running today.
- On screen nothing new: the child shows "Continues at reset", the parent "Waiting · N
  threads".

### Rulings after the third review (rev 5)

Sol reviewed this section against the code after piece 2 and found four gaps; all four
hold. These rulings override the bullets above where they differ.

1. **Stop is written down.** Today nothing durable says "the user asked this turn to
   stop" on an ordinary thread (`decideAgentChainStop` returns early without agent
   records, and `queueHeldByStop` lives only in the reactor), so a usage-limit failure
   that lands after Stop could arm the wait and bring the turn back. This hole exists
   today for turns the user typed; this piece would widen it. Add one optional field
   on the session, `stopRequestedTurnId`, set by the decisions for `thread.turn.interrupt`
   and `thread.session.stop` (the turn active then), folded by the projector and the
   web store, persisted with the session, and cleared when the next turn starts.
   `withArmedContinueAtReset` never arms for that turn, whoever started it.
2. **Stop ends a wait.** `thread.session.stop` and `thread.turn.interrupt` on a thread
   that is waiting clear the wait and settle a held request, in the same decision.
   (`thread_stop` from a parent goes through `thread.session.stop`, so a child the
   parent stopped no longer continues at the reset by itself.)
3. **The reset can arrive late, and the wait for it is bounded.** A provider can report
   the session error first and the turn's end, with the reset time, up to 15 s later
   (Codex refreshes usage first). The 5 s session-error settle in `ChildThreadReactor`
   must not fail the request in that gap. While the errored child's answering turn has
   not ended, that settle waits up to 20 s for the turn's end (one named constant,
   tied in its comment to the 15 s refresh), then settles `failed` as today. Prefer
   applying the longer wait only when the error is already recognised as a usage
   limit, if the session carries that by then. No new stored state, and never an
   unbounded hold.
4. **Only a `running` request is held.** The hold and the arming for a request-started
   turn apply only when the request is `running` and the failed turn is its own
   answering turn. A request that is `awaiting_background` follows today's path exactly
   (it settles with its candidate, and nothing is armed for it). Holding it would need
   a backward status change and candidate handling for an answer that already exists.
   A test pins today's behaviour for that case.
5. **The reducer learns `childMessageId`** (`childRequestStateOn.updated` applies and
   compares it), on the server and in the web store.
6. **Where a held request settles `failed`:** the two Stop decisions (ruling 2), the
   per-thread switch turned off, archive, and a session rewrite through
   `withLastErrorState` (which covers a user turn starting). Skip does not clear a wait:
   it marks an already-fired continue unsent, which "the continue never runs" covers.
7. **Scheduled runs stay out.** A run into an existing thread has a finish duty.

Checked while building: a scheduled run into an existing thread (`each_run: this_thread`)
does have a "finish the run" duty, so those turns are not covered (ruling 7).

Built (piece 4), where it differs from or adds to the rulings:

- The Stop events carry the turn they are for (`stopsTurnId` on
  `thread.turn-interrupt-requested` and `thread.session-stop-requested`); the projector
  and the SQLite projection fold it into the session (migration 117). The web store does
  not: nothing on screen reads it. A session update keeps it until a turn starts (the
  session is starting, or running another turn).
- A retry during the wait does not settle the held request: it sends the very message
  the request is bound to, so its turn answers it.
- Archive needed nothing new: archiving a child already cancels its parent's requests.
- Not covered: a continue that fails before its turn starts and leaves the session
  `ready` rather than `error` (no session-error settle runs then). Its request stays
  open until the parent's Stop, wrap or archive.

## Every surface

- **Entry points:** thread menus (sidebar, header), project menu, command palette,
  keybinding command, new-thread screen (a "Lead chat" link beside the project's thread
  map when one exists).
- **Clients:** web, desktop and the phone view share the components. Board logic that
  is not view code goes in `packages/client-runtime`.
- **Providers:** a lead needs the thread tools. Codex, Claude, OpenCode, Muse and Pi
  get them; ACP agents (fx, Cursor, Antigravity, Grok, community agents) only when they
  take an HTTP tool server, decided in the generic core. Where they do not, "Make this
  the lead chat" is disabled with the reason. Role text reaches all of them through
  the per-turn context. A room can be the lead: requests already carry the asking
  agent.
- **Contracts:** project field and command, two capability flags, the origin's
  `ceiling`, respond's `requestIds`, the update event's `childMessageId`, summary
  fields. All optional and additive; no closed set gains a value.
- **Reverse states:** make lead ↔ stop; replace; archive or delete clears; "Start 3" ↔
  declined rows are told to the agent; a pass that cannot run is taken back and both
  sides are told.
- **App guide:** a topic `lead-chat`; the threads topic's sidebar paragraph and the
  child-threads topic mention it. No new settings row, so no new place; the
  `continueAfterUsageLimits` place's words change.
- **Alerts:** unchanged. A lead's report turn finishing alerts like any finished turn; a
  passed-to thread alerts like any thread.

## Build order

Five pieces, each its own branch and pull request. 1, 2 and 4 touch the same decider
files and go in that order from one builder. 3 is web only and can run beside 2 once
piece 1's contracts are committed. 5 is web only and can run beside 4.

1. **Lead role.** Project field, command, cascades, migration, capability; role text
   on every turn start; limits; menus, palette, keybinding command, sidebar row and
   sort, header chip, placeholder; guide topic. Tests: decider (set, replace, refusals,
   cascades, ghost pointer), a restart round-trip of the pointer, role text present on
   person, task, report, retry and continue turns and absent on steers and side
   answers, Sidebar.logic sort and wrap rules, one browser test for the menu round
   trip.
2. **Passing and choosing what starts.** `thread.lead.pass`, `leadPassRefusal`, the
   ceiling at call and at turn start, no fan-out, the framing line, `thread_list`
   fields, outside project listing; `requestIds` on respond, its capability and the
   card's checkboxes. Tests: handler outcome for each refusal; a pass into a hand-made
   thread runs and stays there; the target's access widened by a queued user message is
   caught at turn start; partial start;
   whole-batch start against a server without the capability; a retried pass over
   its ceiling is refused; a room and a stopped thread are refused as targets; a
   pass-started thread still cannot start threads after a retry or a continue, and can
   again once the user writes.
3. **Threads panel.** Pure grouping in a `projectBoard.logic.ts` that shares the
   status-to-group table with `ProjectThreadMap.logic.ts` (one table, so they cannot
   drift) and takes the sidebar's filing as an input, fed by `useInboxThreads`. Tab
   registration in `rightPanelTabs.ts`. Tests: the grouping as data, including a
   wrapped failed thread and a wrapped child with an open pull request; one browser
   test.
4. **Usage limit pause.** As above. Before building, this section gets its own review
   pass against the code as it stands after piece 2. Tests: arming for request and
   report turns and not after Stop; hold → fire → answered; hold → skip → failed; the
   user writes during the wait → failed at once; the user overtakes the continue →
   failed; restart with a held request; a linked child and a `usageLimited` goal still
   fail as today.

5. **Family tabs.** Web only, no contract change. Membership comes from the sidebar's
   own family rules (extract the function if it is buried in `buildInboxSections`);
   the row's layout choices (order, which tabs fit, the open one always shown, "+N"
   attention) are pure data in a `familyTabs.logic.ts`. The header chips give way
   while the row shows; the Threads panel stops opening by itself. Guide: the threads
   topic says a family shows as tabs. Tests: the logic as data; one browser test that
   the row shows on a parent and on its child and not on a thread with no family,
   that a click switches threads, and, read after every paint
   (`readAfterEachPaint`), that the row does not vanish or move across the switch.

Live check before calling it done, on a throwaway stack (never `~/.threadlines/userdata`):
a Claude lead starts a Codex thread and a Claude thread and hears back from both,
passes a follow-up into a thread made by hand, the lead role moves to another thread
mid-flight, and a faked usage limit (the stand-in agent) holds and resumes a request.

## Changes from review

Rev 1, first pass:

| #   | Finding                                                                   | Answer                                                                        |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Answers from a thread with no parent have no route (lookups go by parent) | Passes are one-way; no request exists to route (decision 3)                   |
| 2   | Such a report is rejected later as a detached child's                     | Same                                                                          |
| 3   | Access ceiling checked only at submit; a queued user message can widen it | Checked again when the message is about to start its turn; taken back if over |
| 4   | Partial approval starts every thread on an older server                   | Capability `childStartSelection` gates the checkboxes                         |
| 5   | Unqueue, Stop, archive, delete, revert do not know such requests          | No request, so the target's own rules are complete                            |
| 6   | Stop may not raise an epoch for a lead with only such reports             | No such reports                                                               |
| 7   | A continue overtaken by the user leaves the rebound request orphaned      | "Bound message will never start a turn" settles it `failed`                   |
| 8   | The pause cannot resume a linked computer's request                       | Linked children are not covered and fail as today, stated                     |
| 9   | Arming for report turns can bring back a turn the user stopped            | Never armed after Stop or under the hold; the fire re-checks                  |
| 10  | A target that hands work to its children answers too early                | No answer is awaited                                                          |
| 11  | Settling cancels the target's done alert even without `handed-back`       | No settle event for a pass                                                    |
| 12  | Role text misses steers, side answers, retries                            | On every turn start; steers and side answers excluded by decision             |
| 13  | A wrapped failed thread lands in "Needs you"                              | Filing is checked before status                                               |

Rev 2, second pass (the one-way pass and the usage limit pause only). Sol confirmed
that an unattached thread runs an unbound request-kind message with nothing to settle,
and that the failed session is written before the turn's end is routed.

| #   | Finding                                                            | Answer                                                              |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | Retry and resend start a turn without the ceiling check            | The ceiling is checked by every decision that starts a turn from it |
| 2   | A room hand-off sheds the no-fan-out mark                          | Rooms are not pass targets; no-fan-out is a fact on the thread      |
| 3   | A user turn clears the wait and the held request is never settled  | Settled in the decision that clears the wait                        |
| 4   | A Codex goal's continue sends no message to bind to                | Not covered; fails as today                                         |
| 5   | A pass into a thread held by Stop can sit queued for good          | Refused when the hold is known; a later Stop holds it, by design    |
| 6   | The rule in `callerRefusal` would also block sends to own children | The rule lives in `childStartRefusal` only                          |

## Ideas not in this plan

- **Hearing back from passes.** Possible later: it needs request lookup that does not
  go through lineage, in about ten places.
- **A real cap on threads working at once per project** (extra starts wait for a free
  slot). Claude's is "a preference, not a cap"; here each thread is a local worktree
  with builds running, so a real cap protects the machine as well as the usage limit.
- **Auto-fix on by default for threads a lead starts,** so a failed check is fixed
  without the user (Claude does this).
- **Project brief, shared notes, project pause, usage per project** (see Out of scope).
