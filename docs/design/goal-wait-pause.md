# A goal pauses while its thread waits

A goal keeps an agent working across turns. When the agent asks for something
through a card and gets control back at once, or starts threads and waits for
their reports, the goal would keep running turns that can only say "still
pending". On Codex that was three turns before Codex marked the goal blocked,
and more while started threads worked. So Threadlines pauses the goal while
the thread waits, and resumes it when the wait ends.

## What counts as waiting

`goalWaitOf` in `packages/shared/src/goalWaitPause.ts`, from the same facts the
sidebar reads:

- **A card only the user can answer:** threads waiting for approval to start,
  a settings change, an invite, a command card not yet run or skipped (or run,
  with its output still to go back: a run's finish is recorded a moment before
  its output is sent), a scheduled-task card (the scheduler holds those:
  `ScheduledTasks.waitingThreadIds`).
- **Threads it started that still owe their reports** (`awaitedChildRequestCount`).

A permission prompt or a question is not here: the turn that asked is still
running, and nothing loops.

## The mark

The goal carries `waitPause` (an optional field, not a new `ThreadGoalStatus`
value, which clients decode as a closed set):

- `paused`: Threadlines paused it for the wait. The provider may not have
  confirmed yet, so the mark stays while the goal reads active or paused.
- `resuming`: the wait ended and the resume went out. It stays until the
  provider reports the goal active, so a restart in between sends it again.
- `user`: the user paused, resumed, edited, cleared or stopped the goal during
  the wait (or while it was paused for one). Nothing automatic happens until
  that wait is over; then the mark goes and the goal stays as the user left it.
  The decider marks it when it sees the user's command; a wait on a
  scheduled-task card is the scheduler's, not the thread's, so the reactor
  also reports each user action (`userActed` on the sync).

A provider report keeps the mark only while it means something
(`carriedGoalWaitMark`); a goal that completed, blocked or hit a limit loses
`paused`, and a completed or cleared one loses any mark.

## The rule

`goalWaitStep`, applied by the decider on `thread.goal.wait.sync` (server only):

- Waiting, the goal active and unmarked: pause it (`paused`), and send
  `thread/goal/set` paused with `origin: "automatic"`, which Codex keeps out of
  the model's history.
- The wait is over and the goal is paused with `paused`: resume it
  (`resuming`, `thread/goal/set` active, automatic). A resume not yet confirmed
  is sent again only on the reactor's pass at startup (`retryResume`), never on
  every look. Not while a turn is
  about to start (the session is starting one, or a message waits in the
  queue): resumed while idle, Codex starts a goal turn at once, and it would
  race the turn that ended the wait. A report from a thread it started is
  queued in the same decision that settles its request, so the resume lands
  once the report's own turn runs, and the goal carries on inside it.
- The wait is over and the mark is `user`: drop it, send nothing.
- Waiting again before a resume was confirmed: back to `paused`, and the pause
  is sent, so a resume still on its way doesn't win.

The provider reactor sends an automatic pause or resume only while the goal
still carries that intent when it gets to it (`paused` for a pause, `resuming`
on a paused goal for a resume): a goal the user took over, or that the
provider ended or blocked in between, is left alone.

## Who asks

`GoalWaitReactor` watches the events that change a wait or the goal (cards and
their runs, started threads, the queue, the session, the goal, reverts, agents
leaving) and the scheduler's waiting cards, and sends the sync for a thread
whose goal should change, saying when the user acted on the goal or pressed
Stop. At start it looks at every thread with a goal once, which also resends a
resume a restart cut off. It skips a pause or resume for
a provider that can't pause a goal.

## Per provider

- **Codex:** paused and resumed as above. Codex finishes a turn already running
  when the pause lands and starts nothing after it.
- **Claude:** not supported. Its goal is `/goal` with Claude Code's own Stop
  hook, which keeps one turn going until its evaluator is satisfied. There is
  no pause (`threadGoalPause: "unsupported"`), and clearing and setting it again
  would lose its checks and change what the user sees.
- **OpenCode, Muse Code, Pi, the ACP agents:** no goals.

## On screen

The goal bar shows "Paused until you answer", or "Paused while its threads
work" once the card is answered and threads are running, beside the objective.
Resume and clear stay available.
