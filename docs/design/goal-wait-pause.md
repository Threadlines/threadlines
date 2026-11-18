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
  with its output still on its way), a scheduled-task card (the scheduler holds
  those: `ScheduledTasks.waitingThreadIds`).
- **Threads it started that still owe their reports** (`awaitedChildRequestCount`).

A permission prompt or a question is not here: the turn that asked is still
running, and nothing loops.

## The rule

`goalWaitStep`, applied by the decider on `thread.goal.wait.sync` (server only):

- Waiting and the goal is active and not already paused by us: pause it. The
  goal gets `pausedForWait: true` (an optional field, not a new
  `ThreadGoalStatus` value, which clients decode as a closed set) and the
  provider gets `thread/goal/set` paused with `origin: "automatic"`, which Codex
  keeps out of the model's history.
- Not waiting, the goal is paused and marked: resume it, and drop the mark.
  Not while a turn is about to start (session `starting`): resumed while idle,
  Codex starts a goal turn at once, and it would race the turn that ended the
  wait (a report, a command's output). Resumed while that turn runs, the goal
  carries on after it, so a report never gets a second turn beside it.
- The user's own pause, resume, edit or clear drops the mark first, so their
  choice stands. A provider report keeps the mark only while the goal is active
  or paused; a goal that completed, blocked or hit a limit loses it.

The mark lives in the goal the projections keep, so a restart with a card still
waiting leaves the goal paused, and answering the card afterwards resumes it.

## Who asks

`GoalWaitReactor` watches the events that change a wait or the goal (cards,
started threads, the session, the goal) and the scheduler's waiting cards, and
sends the sync for a thread whose goal should change. At start it looks at
every thread with a goal once. It skips goals whose provider can't pause one.

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
