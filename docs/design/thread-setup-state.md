# A thread exists once it is ready

Status: plan, rev 3 (Oct 25 2026). Follow-up to outside agents
(`docs/design/outside-agents.md`, Honest limits: "The setup window of a first
send").

## The problem

A new thread's first send does several things before the agent starts: cut its
worktree, launch the setup script, start the first turn. Two paths do it
(`ThreadBootstrap`):

- `runTurnStart`: the app's own first send (ws.ts) and outside agents'
  `thread_start`. In-memory single flight per client command id; random ids
  for the steps before the final turn start.
- `startChild`: child threads, scheduled runs, threads a linked computer
  starts. Staged (create, worktree, setup, turn) and resumable with derived
  ids; owners (ChildThreadReactor, ScheduledTasks, LinkRequests) resume their
  open requests at startup.

Both create the thread first. Between `thread.create` and the first turn
start the thread exists and looks idle everywhere except the sending window.
Two bugs follow:

1. **Work in the setup window runs in the wrong place.** A send from another
   window or the phone, an outside agent's `thread_send`, a room hand-off
   queued into it, a goal set on it, a parent agent's `thread_send` to a
   scheduled or remote child: the provider can start in the project folder
   before the worktree exists. The only guard, `isChildBeingSetUp`, covers
   local children.
2. **A restart mid-setup strands the thread.** `runTurnStart` is not
   resumable. The thread stays empty, and a client retrying the same command
   gets "thread already exists".

## Rev 1, and why it was dropped

Rev 1 kept the order and added a durable "setting up" marker on the thread:
the decider held other work off while it was set, the bootstrap's turn
cleared it, Stop ended it, a startup resumer finished client setups. Sol's
review (10 findings) showed what that costs: every producer of work needs a
fence (goal set/clear and warm-up bypass the turn-start path; checkout and
metadata writes from a stopped run; outside agents' own first turn reading as
busy), ended setups need per-command tombstones that survive replacement, a
failed setup still releases a thread whose worktree never came, request
owners leave orphan markers on their pre-bootstrap failure paths, Stop
prechecks in outside and linked tools never reach the decider, and the
resumer needs a startup barrier. Each is fixable; together they spread a new
invariant across a dozen places.

## The design: the thread is made last

Reorder the setup so **the thread does not exist until it is ready**, and
create it **in the same command** as its first turn:

1. **worktree** (if the send asked for one): reuse a worktree already on the
   run's branch, or the branch alone, else cut it (the client path resolves
   the fresh base first, as today). Nothing is recorded yet. The branch is
   the run's alone: named from its key with 64 bits (`threadlines/<16 hex>`;
   a first send's comes from its command id, not the client's placeholder),
   so a re-run finds what an interrupted one cut and no other run shares it.
   Git keeps a worktree locked `initializing` while it adds it (the add runs
   untranslated), so one still locked that way is an add a crash cut short:
   it is removed and made again. Any other lock is someone's on purpose: the
   setup stops and says so. A worktree made again from a branch an earlier
   run left always gets a folder of its own, in case the cut-off git is
   still running and later cleans up the usual one.
2. **start**: one server-only command, `thread.start`, decided as a sequence
   (`decideCommandSequence`, already used by `thread.children.stop`):
   `thread.create` (with the worktree's branch and path) if the thread is
   absent, `thread.meta.update` with the worktree if the thread exists
   without it, `thread.turn.start`, then the setup script's claim
   (`setup-script.requested`) when the project has a script to run on a new
   worktree (after the turn, so the setup rows sit with the agent's first
   reply rather than ahead of the user's message).
   All events commit in one transaction under one receipt: the final turn's
   command id (the client's own, or the request's derived `turn` id,
   unchanged from today).
3. **setup script**: launched right after the start commits, by the run that
   committed it, then `started`, `skipped` or `failed` recorded. The claim is
   part of the start, so the script runs at most once without reading
   activities (a thread keeps only its newest 500): a run that finds the
   start's receipt already accepted never launches it. A crash between the
   commit and the launch skips it, the trade the child path already makes. A
   failure here is recorded on the thread and never fails the run. The
   agent's session takes seconds to start, so launching the script a few
   milliseconds after the turn start instead of before changes nothing in
   practice.

Before step 1 the run reads the final command's receipt: accepted means
everything is done or claimed; rejected answers as today. Owners'
`checkpoint` runs before steps 1 and 2 only: after the start nothing is left
that a cancelled request could stop, and a scheduled run whose turn already
ended must not be failed by a late checkpoint.

### Why this fixes both bugs

- **No window.** Before step 2 there is no thread: no window, phone, agent,
  goal, warm-up or queue can address it. After step 2 it already has its
  worktree and a turn starting. This covers every path (app, outside agents,
  children, scheduled runs, remote threads) without a guard list.
- **No half-made thread.** A crash before step 2 leaves no thread. A crash
  after leaves a complete one. A client that retries the same command after a
  restart re-runs: step 1 reuses the worktree, step 2 commits or is answered
  from its receipt. Request owners resume exactly as today: their requests
  are still `starting` until the start commits.

### `thread.start`

Server-only (not in the client command union):

```ts
{
  type: "thread.start",
  commandId,        // must equal first.commandId
  threadId,         // must equal first.threadId
  create?: ThreadBootstrapCreateThread,      // thread absent
  checkout?: { branch, worktreePath },       // thread present, worktree prepared
  setupScriptClaim?: OrchestrationThreadActivity, // claim the setup script
  first: ThreadTurnStartCommand | ThreadGoalSetCommand, // without bootstrap
}
```

Decider: refuse mismatched ids; with `create`, the thread must be absent;
without it, the thread must exist and not have started (no user message, no
session running or starting), else "This thread already started." A start
whose turn answers a local parent's request needs that request still open,
attached or not (today only attached children are checked), so a Stop that
lands after the last checkpoint still wins. Then
`decideCommandSequence([create | meta.update, first, claim?])`. Every existing
check on the inner commands applies unchanged (lineage, rooms, ceilings, the
move guard).

### The runner

`runTurnStart` and `startChild` become one staged runner with the shape
above, keyed by the client's command id or the request id (single flight,
detached from the caller, as now). Children keep `checkpoint` before steps 1
and 2. `ChildBootstrapStage` becomes `worktree | turn`.

A thread that exists without a receipt is one an older build left half-made
(or a server thread created without a message, like an older build's goal
flow): the start goes through the `checkout` form, and a child's modes are narrowed
first as today. This form keeps a window: while its worktree is cut, the
thread already exists without one, and every window shows it as working in
the project folder. A send from another window in that window runs there, as
that window says, and then the start is refused ("already started"), so the
first send's own message never runs in the wrong place. A warm-up there is
harmless: the turn's session restarts in the new checkout
(`ensureSessionForThread`'s cwd check). No new thread takes this form.

### Failures

- Before step 2 (git, a refusal of the start): no thread exists. The client
  path's RPC fails with the reason; the sending window already restores the
  draft and shows it. An outside agent gets `failed` or `not_allowed`, and
  its request id may try again (nothing was made). A child's owner reports to
  its parent as today.
- A refusal of `thread.start` is final (its receipt is rejected). A worktree
  this run itself created (not one it adopted from an earlier run) is removed
  with its branch, without force, so anything with changes stays. Branches
  are fixed per run key, and runs are single-flight per key, so no other run
  can be adopting it.
- The existing-thread form records the failure on that thread as today.

### Smaller changes

- **Local children not made yet.** A child exists only once its start
  commits, so for a few seconds the parent holds its id with only a
  `starting` request behind it (as it already does for one awaiting the
  user's yes). The room tools resolve such an id by request, like they
  resolve remote children: `thread_send` answers "still being set up",
  `thread_stop` cancels the request (`thread.children.stop` settles open
  requests whose thread doesn't exist yet), `thread_read` answers with the
  pending child and no messages. `decideChildSend` checks the request before
  the thread lookup. The decider's `isChildBeingSetUp` stays for half-made
  children an older build left.
- **The sidebar family** shows a child started here while it is set up, as
  it shows a start on a linked computer: the parent's shell carries
  `localChildStarts` (its open local start requests past the user's yes),
  and the family draws a "Setting up" row for each whose thread isn't in the
  list. The same rule covers the hand-over: the parent's request moving on
  and the child's thread arriving come separately (detail and shell streams,
  a coalesced shell batch), and the row stays until the thread is there.
  Archiving or deleting a child settles its request, so nothing is stood in
  for forever.
- **Implement plan in a new thread** (ChatView) dispatches `thread.create`,
  then a separate `thread.turn.start`; it becomes one turn start with
  `bootstrap.createThread`, so it gets the same atomic start.
- **A goal set on a draft** is first work too: the agent starts on an active
  goal at once. It dispatched `thread.create`, then `thread.goal.set`, so in
  New worktree mode the goal ran in the project folder. Now `thread.goal.set`
  carries the same `bootstrap` (ws.ts sends it to
  `ThreadBootstrap.runGoalStart`), and `thread.start`'s first work is the
  turn or the goal (`first`), with the same order and checks. A server
  thread that hasn't started and is set to New worktree takes the `checkout`
  form the same way.
- **Setup terminal reveal.** The sending window brings the setup script's
  terminal forward when `setup-script.started` arrives. The claim now arrives
  with the thread and its turn, which promotes the draft and remounts
  ChatView before the script starts; the reveal intent moves out of the
  component (keyed by thread) so the new instance still acts on it.
- **ScheduledTasks** links the run to its thread id at the `turn` checkpoint
  (it linked after `create` before; the id is fixed, and the turn's end
  finds the run through the thread's `scheduledRun` either way).
- **Outside agents**: the replay of a cut-off `thread_start` already reads
  the receipt; "the half-made thread" wording stays only for older threads.
- **Docs**: ThreadBootstrap module comment, fleet.md stage lists,
  outside-agents Honest limits.

## Limits

- If the whole app quits mid-setup, the first message is gone: the composer
  cleared it on send and no thread was made. Today the same quit leaves an
  empty thread without the message, so nothing is lost that wasn't before. A
  later improvement: keep a first send in the saved draft until its thread
  exists.
- A crash before step 2 with no retry leaves the cut worktree and branch with
  no thread (today it leaves an empty thread holding them). A sweep for
  `threadlines/*` worktrees no thread references would clean these up.
- The sending window has no Stop for a setup that hangs (same as today).
- A crash between the start's commit and the script's launch skips the setup
  script; its "Starting setup script" line stays with nothing after.

## Tests

- decider: `thread.start` creates and starts in one decision (event order,
  one receipt, claim after the turn); refuses `create` for an existing
  thread, the existing-thread form after a user message, mismatched ids, a
  child's start after its request was cancelled (attached or not); inner
  refusals (ceiling, lineage) refuse the whole command with nothing created.
- ThreadBootstrap: no thread is visible while the worktree stage runs; a run
  interrupted after the worktree is cut, re-run with the same key, makes one
  worktree, one thread, one turn; a re-run after the start never launches the
  script; a refused start removes the worktree it created and keeps one it
  adopted; existing-thread form.
- Room tools: a pending child is refused for send, stopped by request, read
  as pending.
- Existing ChildThreadReactor, ScheduledTasks, LinkRequests and outside-agent
  tests updated for the order.
- web: the setup terminal comes forward after the draft is promoted before
  the script starts; implement-plan sends one turn start with a bootstrap.

## Review history

- Rev 1 (marker): Sol, 10 findings; replaced by rev 2.
- Rev 2: Sol, 8 findings, all taken in rev 3: the existing-thread window
  (argued above, plus the checks), the post-start script claim (moved into
  the start), refusal cleanup ownership, a late scheduled checkpoint, pending
  children in the room tools, the 500-activity claim scan, the implement-plan
  flow, the terminal reveal across promotion.
- Second diff review: Sol, 7 findings, all fixed: any lock was taken for a
  cut add (now only git's `initializing`, with the add untranslated); lock
  state came from a second, heavy listing (now the plain listing reports
  it); branch-only recovery reused the usual folder; 32-bit branch tokens
  (now 64); mixed interruption causes (now any interruption is re-raised,
  the script launch included); the sidebar could drop the setting-up row
  before the child arrived (the row now stands in until the child's thread
  is in the list; reordering events could not guarantee it).
- Diff review: Sol, 3 findings, all fixed: a retry adopting a half-checked-out
  worktree (the lock check), cleanup removing a worktree another run adopted
  (branches named by the run key), post-start steps swallowing an
  interruption (re-raised). After it: the replacement for a cut-short
  worktree gets its own folder, and the setup claim moved after the turn so
  the setup rows sit with the agent's reply (seen live).
- Live test (throwaway home, stand-in fx agent, a git hook holding the
  worktree add open): no thread existed while the worktree was cut; the
  thread, its message, turn and claim committed together; killing the server
  mid-add left no thread, and the app's retry after the restart reused the
  worktree, made one thread and ran the setup script once.
