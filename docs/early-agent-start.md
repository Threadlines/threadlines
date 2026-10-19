# Starting agents while you type

Typing in a thread whose agent has stopped starts that agent in the
background, so the message goes to an agent that is already running. Agents
stop after 30 minutes idle, and when the app restarts. Starting one again
(spawning its process, loading its tools, reopening its conversation) is most
of the extra wait on the first message after that.

Settings → Threads → **Start agents while you type** turns it off. It is on
by default.

## What starts early

- **Only an agent that has stopped**, in a thread that exists on the server.
  A brand-new thread's first message still starts its agent at send.
- **Only where the message would plainly start or resume the same agent.**
  Never a hand-over to another provider or account, never a fork, never over
  a running agent, and never while a turn is running or about to start.
- **Never with a goal running.** Resuming such a session can go on with the
  goal by itself.
- **Only on providers that allow it** (`earlySessionStart` in the adapter's
  capabilities): Claude and Codex. Their start sends nothing to a model and
  saves nothing in the provider's own lists. OpenCode and Muse Code save a
  session in their own lists at start, Pi's extensions can ask a question at
  start, and the ACP agents (fx, Cursor, Antigravity, Grok, community agents)
  sign in or hold their launch at start, so none of them start early.
- **Only the conversation it would reopen.** An early start resumes the
  thread's conversation exactly or fails (`resumePolicy: "required"`). If the
  provider lost it, starting fresh is left to the message's own start, which
  says so in the thread.
- **Only the agent the message would go to**, picked the way sending picks
  it, Rooms switch included.
- **At most 2 at a time** on one server.

## While it waits

An early agent isn't the thread's until something uses it: a message, a goal,
a review, voice, a compaction, a rollback. Until then:

- **The thread shows nothing of it.** Its events are withheld from every
  part of the server that reads them (the thread, checkpoints, sleep), so no
  "Starting" pulse, no status change, and no rows from its start-up hooks.
  Its warnings are held and shown once it is used.
- **It stops 3 minutes after the typing stops.** The composer renews it about
  once a minute while you keep typing, and asks again for each new message.
- **If it starts work or asks something on its own** (a Claude start-up hook
  that hands it a first message, or an MCP server that asks a question at
  start), it is stopped at once. Nothing in that checkout starts early again
  on that provider account until the server restarts.

When a message arrives while the agent is still starting, the message waits
for that start instead of starting a second one. The other way round, typing
while the agent is being started or brought back some other way starts
nothing more: one start per agent at a time.

## Server pieces

- `ProviderCommandReactor.warmUp` (RPC `orchestration.warmUpTurn`) decides
  whether a start applies, in the thread's worker, and asks
  `ProviderService.startEarlySession`.
- `ProviderService` keeps the early sessions (`provider/earlySessions.ts`).
  It reserves a slot when asked, starts the session in the background, and
  makes it the thread's on first use (`adoptEarlySession`). It also stops
  unused ones, and marks a fresh one `earlyUnused` in its binding so a later
  start never tries to resume a conversation nobody used. Its event stream
  withholds an early session's events, holds its warnings until adoption,
  and abandons one that works alone.

The composer side lives in `packages/client-runtime/src/agentWarmUp.ts`.
