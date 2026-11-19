# Hiding a printed key

Status: plan rev 4 (Nov 19 2026). Step 2a (the scrubber and provider output) and step 2b (the other doors) built. Rev 4 moves stream holding from the provider hook into ingestion (see "Streams"). Debug logs: Will chose to keep them (whole values hidden, pieces may remain). Step 2 of
`secret-requests.md`, whose step 1 is on main (#1000). GPT-6.2 Astra
reviewed rev 1 (fifteen findings) and the new parts of rev 2 (thirteen);
"Review" at the end says what each changed. Will chose to keep the debug
logs ("The debug logs").

## The problem

A key saved through a card stays out of Threadlines' records only until the
agent pulls it into view: `env`, `cat .env.local`, `curl -v` showing an
Authorization header, a file tool reading the env file, or the model
repeating it in a reply. From there the text goes into the thread's events,
the activity rows, the provider logs and every connected app, and a thread
move carries it.

This step replaces a known value with `[NAME hidden]` before Threadlines
stores, logs or sends it, and tells the user it happened.

## What it promises

1. A watched value never appears whole in anything Threadlines stores,
   logs or sends to an app, on the paths listed under "Where it runs".
2. In reply text, plan text and command output, which arrive in pieces that
   Threadlines stores and joins, a value split across pieces is hidden too.
3. For `ask_user_to_run` output the agent never sees the value: Threadlines
   owns that text before the model does.

What it does not promise:

- That the agent has not seen the value. For provider output it usually
  has. Threadlines cannot take a value out of the model's context or the
  provider's own transcript.
- That the two debug logs hold no pieces of a value. See "The debug logs".
- Anything in "What it does not cover".

This is cover for accidents with keys saved through a card. It is not a
secret scanner.

## The scrubber

One module, `apps/server/src/secrets/SecretScrubber.ts`, used by every hook.
It holds the watched values in memory and offers:

- `scrubText(text)`: replaces watched values in a string.
- `scrubDeep(value)`: the same for every string and every member name
  inside a JSON-like value. It returns the same object when nothing matched,
  so an untouched value is not copied. A renamed member that collides with
  another gets a numbered suffix.
- `scrubRuntimeEvent(event)`: for provider events, with the stream handling
  under "Streams".
- `contains(value)`: whether anything would be hidden, for callers that
  refuse instead of rewriting.

Each reports the names it hid, for the notice.

### What a watched value is

A watched value has a name, the exact text, and its forms:

- the text as saved;
- its JSON-escaped form, when that differs (a value with a quote, a
  backslash or a line break, as it sits inside a JSON string that was itself
  put in a string);
- its URL-encoded form, when that differs (a key with `+`, `/` or `=` in a
  query string).

Matching is exact and case-sensitive.

A long value is matched by its head. Once the first 256 characters of a
form match, the value counts as found, and the scrubber hides on from there
for as long as the text keeps agreeing with the value. A value of 256
characters or fewer is matched whole. This keeps the work linear, bounds
what a stream ever holds back to 255 characters, and also hides a long key
that a tool printed cut short.

The replacement is `[NAME hidden]`, with the request's name. When two
different values are watched under one name, the second is `[NAME 2
hidden]`, so two texts that differ only by the key still differ after
hiding.

A value is watched only if hiding it cannot damage ordinary output or give
itself away:

- at least 8 characters;
- not letters only and not digits only, so `localhost`, `development` or
  `12345678` saved as a "key" never blanks those words everywhere;
- not part of its own name: a value that appears in `[NAME hidden]` would be
  printed by its own placeholder;
- not able to join a placeholder: a value that starts with `]` or with the
  end of ` hidden]`, or ends with `[` and name characters, could be formed
  by a placeholder and the text beside it. No real key looks like that.

A value that fails these is not watched. Nothing is shown for that; the
guide topic states the rule.

The registry holds at most 200 values. Past that the oldest retained value
with no live destination is dropped first.

### Where the values come from

The server stores no copy of a value on disk (step 1). The registry is
memory only, filled two ways:

- At save: the answer service hands the scrubber the value as the user
  typed it, before the write. Not the text it writes: for an env file that
  is the shell spelling, quotes included
  (`checkSecretValue`, `secretRequests.ts:129`), and a command that prints
  the variable prints the value without them. Handing it over first matters
  because the service writes and then settles
  (`AgentSecretRequests.ts:375` to `:408`), so reading the file back
  afterward would leave a window in which another thread's agent could
  read and print a key nobody is watching yet. A failed write does not
  unwatch the value: the file can outlive a failed save
  (`secretDestinations.ts:510`), and watching costs nothing.
- At startup: one read-back from the destinations, below.

One registry for the whole computer, not one per thread. A key one thread
saved is hidden when another thread prints it, and no hook needs to know
which thread an event belongs to.

### When a value enters and leaves

| Moment                                                                   | What happens                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user presses Save                                                    | the typed value is watched from before the file is written                                                                                                                                                                                                                                                                                                                                        |
| The server starts                                                        | every `saved` request the startup read returns is read back from its destination and watched (`reads.all`, `AgentSecretRequests.ts:82`: every thread that is not deleted, archived ones included). So is every `env_file` request that is `uncertain` or still `claimed`: a crash after the rename leaves the value in the file with the request never marked saved (`secretDestinations.ts:306`) |
| Remove now, the 24-hour expiry, thread cleanup                           | the file goes. The value stays watched                                                                                                                                                                                                                                                                                                                                                            |
| The request leaves the thread's state, the thread is archived or deleted | the value stays watched                                                                                                                                                                                                                                                                                                                                                                           |
| A second card saves the same name                                        | both values are watched                                                                                                                                                                                                                                                                                                                                                                           |
| The server stops                                                         | everything is forgotten                                                                                                                                                                                                                                                                                                                                                                           |

A value stays watched after its file is gone because the model can still
hold it: a session that read the key an hour ago can repeat it after the
file expired.

The startup read-back, per destination:

- a `commands` key: the file
  `<state>/agent-secrets/<threadKey>/<requestId>/value`
  (`secretDestinations.ts`, `commandsFilePath`), when it still exists;
- an `env_file` key: the `NAME=` line of the file the request is bound to
  (`parent` joined with the file name), read by the reverse of
  `writeEnvLine` in `packages/shared/src/secretRequests.ts`: bare, or in
  single or double quotes with no escapes.

The load is one query and a handful of small file reads. It finishes while
the server starts, as part of building the scrubber, so no provider event
can arrive before it.

What the registry does not do:

- It does not follow the env file between restarts. A key the user changes
  by hand in the file is watched after the next restart. A key changed
  through a new card is watched at once.
- A destination that cannot be read at startup (the file is gone, the name
  is no longer in it, the line is in a form the reader does not know) is
  skipped until the next restart. A debug log line names the request, never
  a value.

## Where it runs

### 1. Provider output: one place

Every provider's events enter the server at `processRuntimeEvent`
(`ProviderService.ts:665`), called for each event of each adapter's
`streamEvents` (`:715`) and for the events the server makes for a session
(compaction `:2267`, goals `:2373`). It calls `publishRuntimeEvent`
(`:584`), which writes the canonical log (`:589`), holds events of an early
session (`:605`, `:1406`), and delivers to analytics and to every consumer
through one PubSub (`:614`; the only other delivery, `:1302`, hands on
events it already took). Ingestion, the events, the projections, alerts and
the client streams are all behind that PubSub. No adapter writes to the
event store itself.

The scrubber goes in `processRuntimeEvent`, after
`correlateRuntimeEventWithInstance` and before `publishRuntimeEvent`.

`scrubRuntimeEvent` works on `payload` and on `raw.payload`. It leaves the
event's own ids alone: they route the event, and rewriting one would detach
it from its item or request. An event can come back as one event, or as
that event with others before or after it (released stream tails, the
notice), published in order.

`raw.payload` is the provider's own message, the same content in another
shape, and Codex and Muse can carry output there as base64
(`CodexAdapter.ts:2488`, `MuseAdapter.ts:1148`), which a text match cannot
see. So when anything was hidden in an event's `payload` or `raw.payload`,
`raw.payload` is replaced with `{ "hidden": true }`. The
`source` and `method` beside it stay, since ingestion reads `raw.method`
(`ProviderRuntimeIngestion.ts:3545`).

Events are still keyed by the provider session key here, not the thread id
(`toThreadRuntimeEvent`, `:353`). The registry is per computer, so this
does not matter. The hook keeps no stream state (see "Streams").

One place joins text after this hook: ingestion keeps a child's partial
answers and joins them with its final one before handing the result to the
parent (`ProviderRuntimeIngestion.ts:3690`). `scrubText` runs on that joined
text too.

#### Text that stops in the middle of a value

Some text is a snapshot of output still being written: a growing tool
input, a running command's output so far. It can end partway through a
value. In any string that is not a stream piece, a tail of 4 or more
characters that is the start of a watched form is cut off. The next
snapshot holds the whole value and hides it. Fewer than 4 characters are
left alone, so ordinary text does not lose its last letter.

#### Questions and approvals

Two kinds of event are answered by the user, and the answer goes back to
the provider:

- An approval (`request.opened`). The card shows the command or edit with
  the key hidden. On approval the provider runs its own copy of the input
  (Claude: `updatedInput: toolInput`, `ClaudeAdapter.ts:9451`), so what runs
  is what the agent asked for. The card says less than what runs by exactly
  the hidden key.
- A question (`user-input.requested`). Claude uses the question's own text
  as its id and expects the answer keyed by that text
  (`ClaudeAdapter.ts:9224`). A rewritten question would come back under a
  key the adapter does not know.

So for these two event types the scrubber remembers, per session and
request id, each string it changed and what it was. When the answer passes
`respondToRequest` or `respondToUserInput` (`ProviderService.ts:2518`,
`:2556`), any string or member name in it that exactly equals a remembered
changed string is put back to the original before the adapter gets it. The
memory is dropped when the request resolves or the session exits. Nothing
else is ever put back, so typing `[NAME hidden]` into a reply does nothing.

Two cases this leaves as they are:

- A Codex question answered as a message. The reactor writes the question
  and the chosen label into a sentence and sends it as the user's message
  (`ProviderCommandReactor.ts:4631`). That sentence is stored, so it keeps
  the placeholder, and the agent reads `[NAME hidden]` where the key was.
- A form an MCP server sends with a watched key as a field's default
  (`mcpElicitation.ts:104`). The field shows the placeholder, and a length
  or format rule on it can reject that until the user types the value.

### 2. `ask_user_to_run`

A run's output is read from the user's terminal and recorded in two places
in `commandRuns/CommandRuns.ts`:

- `dispatchProgress` (`:204`) carries `output` into the
  `thread.command-run.update` command, which becomes the server-only output
  event and the `projection_thread_command_runs.output` row. Every recorded
  output passes here (`:336`, `:353`).
- `deliver` (`:226`) builds the message to the agent from the output in
  hand, the row, or the open terminal (`:238` to `:259`).

`scrubText` runs on `output` at the top of `dispatchProgress`, and in
`deliver` on the output once it is chosen, before
`buildCommandOutputMessage`. The second call matters for a run still going,
whose output is read straight from the terminal (`:245`).

The terminal manager cuts a run's output to its last 16,000 characters
before `CommandRuns` sees it (`terminal/Layers/Manager.ts:2594`, `:4702`),
and a cut can fall inside a value. Both cuts scrub first, then cut. A run
still going can also have printed only the start of a long value: the rule
for text that stops in the middle of a value covers that (`cutTail` on
every read of output that may still be printing: the terminal's live read,
Claude's running command, a background run's file).

The request is checked too. `request` (`:122`) refuses a command or a
reason that contains a watched value: "This command contains
STRIPE_SECRET_KEY. Read it from its file inside the command instead." A
placeholder inside a shell command would only break it.

### 3. Threadlines' own tools

An agent that has read a key can put it into one of Threadlines' tools: a
message to another thread, a question to another agent, a scheduled task's
prompt, a page. Each handler stores the arguments it was called with.

These calls are refused, not rewritten. A rewritten message would tell
another agent something the caller did not say, and a refusal teaches the
agent what to do instead.

- The room endpoint's handlers are one object (`McpRoomServer.ts`). Every
  tool that changes something goes through one wrapper (`changes`), which
  checks the input with `contains` and refuses a call that has a watched
  value: "Your call contains STRIPE_SECRET_KEY. Don't pass a key through
  this tool. The other agent can ask the user for it." Two tools that only
  touch the caller's own thread but store what they are given
  (`secret_request`'s card and `scheduled_run_finish`'s summary) are
  checked the same way. Reads (`room_history`, `thread_read`, the guide)
  are not: they store nothing.
- `show_page` (`AgentPages.ts`, `publish`) refuses a page whose title,
  content or icon holds a watched value: "Your page contains
  STRIPE_SECRET_KEY. Don't put a key on a page; name the file it is in
  instead." Theme pages go through `publish` too.
- A Claude artifact that Threadlines adopts as a page (`AgentPages.ts:557`)
  is not a call it can refuse. Its title and content are scrubbed.

### 4. Provider text read back for an app

Some screens read a provider's own files or live state and send the text
straight to the app that asked, with no event in between. A subagent that
ran `cat .env.local`, or a background task that printed a key, would show
there.

Two of these readers return only the end of a longer text, so they scrub
before they cut:

- a running command's output (`ClaudeAdapter.ts`, `readCommandOutput`):
  the adapter hands back the whole of what Claude kept (8 KiB at most), and
  `ProviderService.readCommandOutput` scrubs it, then takes the
  4,096-character tail;
- a background run's output file (`BackgroundRunOutput.ts:88`): it reads
  the wanted tail plus the length of the longest watched form in bytes,
  scrubs, then keeps the tail. A value that overlaps the tail starts no
  further back than that, so it is always read whole.

The others return whole strings. Their `ws.ts` handlers scrub the fields a
person reads (`secrets/readBackScrubbing.ts`), never ids, cursors or status
words, so a key that equals one can't break the reply or an import that
sends the id back:

- `serverReadSubagentTranscript` (`:1813`)
- `serverListExternalProviderThreads` (`:1864`, titles and previews)
- `serverReadWorkflowRunFile` and `serverReadWorkflowAgentTranscript`
  (`:2178`, `:2184`)

### 5. Imported sessions

Importing a session made outside Threadlines reads the provider's own
transcript and writes a thread from it: a title from the session's name or
preview (`ExternalThreadImport.ts:73`), then its messages (`:93`, `:104`).
Its name, preview and messages are scrubbed once, right after it is read and
before anything is dispatched (`scrubExternalThreadSnapshot`); a failed
attach's error is scrubbed before it is stored.

### 6. Provider failure text

A provider's error text is stored without passing hook 1: Pi, OpenCode and
Muse append the end of the process's stderr to a failure
(`PiRpc.ts:384`), and the reactor stores it as an activity and as
`session.lastError`, from where it can reach a phone alert
(`pushAlertRules.ts:174`). That text is made in one function,
`formatFailureDetail` (`ProviderCommandReactor.ts:1041`). `scrubText` runs
on its result, on the side-answer start error, and at the two places the
reactor stores such text, so callers that pass a cause as it is (a failed
interrupt or approval answer) are covered too: the failure activity's
detail and the session's `lastError`.

### 7. The debug logs

Two files per thread under `<state>/logs/provider/`, kept 30 days:

- the canonical log, written by `publishRuntimeEvent` from events hook 1
  already scrubbed;
- the native log, each provider's raw messages, written by the adapters
  before any canonical event exists. Every native write goes through one
  function, `write` in `EventNdjsonLogger.ts:680`, including the ACP
  protocol log (`AcpNativeLogging.ts:21`).

`makeEventNdjsonLogger` takes an optional `scrubLine`, applied to each
record's JSON line before it is written. For the native logger,
`ProviderEventLoggersLive` searches the line, and only a line with a match
is parsed, scrubbed with `scrubDeep` and written again, so a value ending in
a quote can't take the line's own quote and break it. The
three adapters that can build a logger of their own (`ClaudeAdapter.ts`,
`CodexAdapter.ts`, `AcpAdapter.ts`, from `nativeEventLogPath`) do so only
in tests; the server always hands them the shared one.

This hides a value that sits whole in one record. It does not hide a value
spread over several records, and both logs can hold one that way. Since rev
4 that includes the canonical log's stream pieces themselves, since the hook
no longer holds stream text:

- the native log keeps the pieces of a reply and of command output as
  separate records for most providers (`ClaudeAdapter.ts:4234` and
  `CodexAdapter.ts:132` leave out only thinking pieces; OpenCode and ACP
  mark none, and ACP logs each message twice);
- the canonical log keeps each event's `raw.payload`, and some events that
  are not stream pieces carry a piece there (Claude's partial tool input,
  `ClaudeAdapter.ts:5240`).

Rev 1 tried to mark those records provider by provider. Astra showed the
lists were already wrong for OpenCode, Codex and ACP, and a list like that
goes stale with every provider release. There are two honest designs:

- **Keep the logs, hide whole values (the plan's default).** The logs stay
  as useful as they are today. A value can sit in them in pieces. They are
  files under the same OS account that can already read the key file
  itself, and nothing sends them anywhere.
- **Quiet logs.** While any value is watched, the native log is not written
  and every event loses its `raw.payload`. Then no log holds a piece. The
  cost is that provider problems on that computer can no longer be debugged
  from the logs, for good, since an env key stays watched across restarts.

Will chose to keep the logs, so the quiet-logs flag was not built.

## Streams

Rev 4 (Nov 19 2026), after two review rounds on the build and a design call
by Fable: the hook does not hold stream text. It could not know when
ingestion closes the message a piece feeds, and every review round found
another case where its guess and ingestion's buffers disagreed. Ingestion
owns those buffers, so it holds there.

Reply text, side answers and realtime transcripts reach the store as
`thread.message.assistant.delta` commands that the projector appends by
message id. That is the only stored text built by appending across
commands. Everything else ingestion stores is a whole snapshot.

- **Message text.** `dispatchAssistantDelta` in
  `ProviderRuntimeIngestion.ts` holds per message id, the projector's own
  append key. Each piece is joined with what the message held back, whole
  values are hidden, and a tail that could start one is held again. A piece
  held whole sends nothing. Every delta dispatch goes through it, the
  buffered-mode spill included. The held tail is released as one more
  delta just before `thread.message.assistant.complete`
  (`finalizeAssistantMessage` and the side answer's completion), and
  dropped in `clearAssistantMessageState`.
- **Command output and thinking.** Held per activity stream before the text
  enters its buffer (`appendBufferedActivityStream`), with the held state
  kept in the buffer entry so it lives and dies with it. The buffer's
  4,000-character window can cut a key's front, and its snapshot is
  dispatched whole, so holding has to happen before the window.
- **Snapshots.** Plans (`upsertProposedPlan`), a child's answer so far
  (`dispatchSubagentResultActivity`) and every activity's summary and
  payload (`projectRuntimeActivities`) get a whole-value check where they
  are stored. Nothing touches a command's ids, type or member names.

The holder (`holdPiece` in `secretScrubberCore.ts`) is the same three steps
as before: join, scan once, hold the longest tail that starts a watched
head. Long values are followed across pieces from a saved position. Held
text is at most 255 characters and in practice one or two, and is always
original text, never a placeholder. At completion it is released as it is:
the promise is "never whole", and cutting there would eat the last word of
ordinary replies.

The hook keeps whole-value hiding per event, never cuts a stream piece, and
drops `raw.payload` when it hid anything.

## Cost

Every provider event passes hook 1, and the registry stays non-empty for
good once a user saves an env key. The watched case is the normal case for
anyone who used the card, so it has to be cheap, not rare.

- Nothing watched: one length check, and the event is passed on as the same
  object. No allocation.
- A stream piece: one key string, one pass over the held text plus the
  piece per form. No rescanning of text already scanned.
- Any other event: one walk over the strings and member names in `payload`
  and `raw.payload`, one `indexOf` per form per string. Linear in the
  event's size, no copy unless something matched.
- Memory: at most 200 values, and per open stream at most 255 held
  characters and one small event to copy for the release. Stream state is
  freed at its release.

The throughput check, reported in the PR:

- Workloads: the runtime events of the recorded Claude and Codex sessions
  in `apps/server/integration/replay/fixtures`; 100,000 token-sized reply
  pieces; 2,000 command-output events of 64 KB; a 64 KB key arriving one
  character per piece; 200 streams open at once; and the same records
  through the native logger's `scrub`.
- Registries: nothing watched, one value, 50, and 200 (one of them a 64 KB
  multi-line key).
- Measured: events per second and the slowest single piece through
  `scrubRuntimeEvent`; the same events' time through ingestion, for
  scale; memory held with 200 streams mid-value; wall time with nothing
  watched against the code without the hook.
- Pass: with nothing watched, no measurable change; with 50 values the
  scrubber adds less than 5% to an event's time through ingestion; the
  one-character workload stays linear. If it does not pass, the build stops
  and comes back to the plan.

A unit test pins the nothing-watched case by identity (`toBe`), so that
part cannot flake on a loaded CI machine. The timings are a PR report, not
a CI gate.

## The notice

Two places notice a hidden key: the provider hook for whole values in one
event, and ingestion for values its holder or snapshot checks hid. They
share one memory, keyed by thread id and turn id, so the user is told once
per name per turn either way. A side answer gets no notice; its text is
still hidden.

When hook 1 hides a value in a thread's own session, the user is told once
per name per turn. The scrubber emits a `runtime.warning` event after the
scrubbed one, with `warningKind: "secret-hidden"`. It rides the path
warnings already take (`ProviderActivityProjection.ts:797`), and the
timeline gives that kind its own row, as it does for `api-retry` and
`sign-in-resend` (`apps/web/src/session-logic.ts:4496`). No new event type
and no migration.

> Hid STRIPE_SECRET_KEY in the agent's output
>
> The agent may have seen it. Replace the key if that matters.

The first line is the row; the second is its detail, so the row fits one
line on a narrow screen.

"May have": a command's output can be hidden as it streams and the turn
stopped before the model reads it.

Where there is no notice, and why:

- a side answer (`room_ask`, a review): ingestion handles side sessions
  apart and drops warnings there (`ProviderRuntimeIngestion.ts:2305`). The
  text is still hidden;
- `ask_user_to_run`, the read-backs, imports and adopted pages: nothing was
  shown to the model by that path, or nothing new was;
- a refused tool call: the agent gets the reason, and the tool call itself
  passes hook 1, which shows the notice.

The guide topic for secret requests (`guide/topics.ts`) gains a short
paragraph: what is hidden, the 8-character rule, and the gaps below in
plain words.

## What it does not cover

1. The model's context, and the provider's own transcript files
   (`~/.claude/projects/*.jsonl`, Codex rollouts, Pi sessions).
   Threadlines carries these on a thread move as they are.
2. Pieces of a value across records of the two debug logs, unless quiet
   logs are on.
3. The user's own terminal: its scrollback file and what another app
   watching that terminal sees (`ws.ts:3175`). It is the user's screen.
4. Files in the project. If the agent writes a key into a tracked file, the
   diff and file views show what the file holds (`ws.ts:1443`, the
   checkpoint diffs). The edit's tool call is hidden and the notice fires.
5. A value that is not watched: too short or too plain; after a restart,
   one whose file is gone or unreadable; a key changed by hand in the env
   file since the last restart.
6. A value changed on the way out: base64, reversed, spaced out, or
   combined with other text and then encoded (`Authorization: Basic`). Also
   a long value the provider itself cut at the front before Threadlines saw
   it: without its first 256 characters it is not recognized.
7. An id the provider chose. Codex uses a process handle as an item id
   (`CodexAdapter.ts:2495`); ids are never rewritten.
8. Voice. A realtime session's audio goes to apps on its own channel
   (`CodexSessionRuntime.ts:2312`). Its transcript is covered.
9. MCP Apps and browser tools: what a page or an MCP server returns to an
   app, and what the agent types into a page with `browser_type`.
10. Other failure text: an error an adapter put on its own session object
    (`session.lastError` from `CodexSessionRuntime.ts:2393`), a review that
    failed to start, and server log lines that quote a provider's message.
    A saved key is in a file, not in the provider's environment, so it has
    no ordinary way into that text.
11. What the user types. A saved key pasted into the message box is sent
    as typed.
12. The two question cases under "Questions and approvals": a Codex
    question answered as a message, and an MCP form with a watched key as a
    default.
13. Two long texts that share their first 256 characters. If one is a
    watched value, the shared start of the other is hidden too.
14. A side answer stopped or timed out from outside, mid-stream: up to the
    last few characters it held back, because they could start a key, are
    dropped. Ingestion never sees that stop, and the answer is closed by
    then. The key is never shown; only those few ordinary characters go.

## Providers

Hook 1 needs no per-provider code: every provider reaches the server
through `adapter.streamEvents` and `processRuntimeEvent`. Side answers run
under a side session key on the same streams, and room tools read their
text back from the stored message.

| Provider                            | What is particular                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude                              | Questions are keyed by their text: the original is put back on the way to the adapter. Partial tool input rides `item.updated` as a growing snapshot, hidden once the value is whole. Command output tail and background output are scrubbed before the cut. |
| Codex                               | Output pieces are base64 in `raw`: `raw.payload` is dropped when the stream hides or holds. Plan text is `turn.proposed.delta`, its own stream type. Imports are hook 5.                                                                                     |
| OpenCode                            | Child sessions share a session key: the stream key carries the provider's thread id. Stderr in failure text is hook 6.                                                                                                                                       |
| Pi                                  | Stderr in failure text is hook 6.                                                                                                                                                                                                                            |
| Muse                                | Output can outlive its turn: output streams are released at the item's end, not the turn's. Summary index is part of the stream key.                                                                                                                         |
| Cursor, fx, Antigravity, Grok (ACP) | Reply pieces can lack an item id: one stream per kind per turn. Handled once in the scrubber, nothing per agent.                                                                                                                                             |
| Community agents                    | The same generic path.                                                                                                                                                                                                                                       |

## Build order and files

Two PRs. The promise needs both.

Step 2a: the scrubber and provider output.

- New: `apps/server/src/secrets/SecretScrubber.ts` and its test.
- `packages/shared/src/secretRequests.ts`: `readEnvValue` (the reverse of
  `writeEnvLine`) and `isWatchableSecret`.
- `apps/server/src/secrets/AgentSecretRequests.ts`: hand over the value
  before the write, drop it on a failed write; the startup read-back.
- `apps/server/src/provider/Layers/ProviderService.ts`: the call in
  `processRuntimeEvent`; putting originals back in `respondToRequest` and
  `respondToUserInput`.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`: the
  child's joined answer.
- `apps/web/src/session-logic.ts` and the timeline row for `secret-hidden`.
- `apps/server/src/guide/topics.ts`.
- The throughput check.

Step 2b: the other doors.

- `apps/server/src/commandRuns/CommandRuns.ts`: `request`,
  `dispatchProgress`, `deliver`; `apps/server/src/terminal/Layers/Manager.ts`:
  the two cuts of a run's output.
- `apps/server/src/mcp/McpRoomServer.ts`: the input check.
- `apps/server/src/pages/AgentPages.ts`: `publish` and adopt.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` and
  `ProviderService.ts` (the command output tail),
  `apps/server/src/diagnostics/BackgroundRunOutput.ts`, and the four
  `ws.ts` read handlers.
- `apps/server/src/provider/ExternalThreadImport.ts`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`:
  `formatFailureDetail` and the side-answer start error.
- `apps/server/src/provider/Layers/EventNdjsonLogger.ts` and
  `ProviderEventLoggers.ts`: `scrubLine`.
- `apps/server/src/secrets/SecretScrubber.ts` and `server.ts`: the registry
  (`layer`) sits at the bottom of the runtime, under every door above;
  `loadSavedKeys` fills it inside the provider layer.

## Testing

The main test is a reconstruction check, not a search for the literal
value: a search passes while every character of a key is still
recoverable. For a session whose command output, reply and tool input each
carry a saved key, split at awkward places:

- read back every event, every projection row and every frame a second
  client received, join each stream's pieces in order, and require that no
  joined stream and no single string holds the value;
- the same for both debug logs, for whole values, and for pieces too with
  quiet logs on;
- run it on the Claude and Codex replays, and on recorded or hand-made
  event sequences for OpenCode, Pi (`pi/fixtures/pi-1.3.0-records.jsonl`),
  Muse and ACP.

Then, by part:

- The scrubber: a whole value in a string, in nested objects and arrays,
  and as a member name; a snapshot that ends 4 or more characters into a
  value loses that tail, and one that ends 3 in keeps it; a child's partial
  and final answers that join into a value are hidden in what the parent
  gets; the JSON-escaped and URL-encoded forms; the same
  object back when nothing matched; a short, plain or self-naming value
  never hidden; a long value found by its head and hidden as far as it
  agrees, including one cut short; two names with one value.
- Streams: a value split across two and across five pieces; two streams
  interleaved; two summary indexes kept apart; pieces with no item id; a
  value that could join a placeholder (`]1234567`) is not watched; held
  text released before each closing event in the list, asserted on the
  final projected text: a plan ending in a held letter is whole after
  `turn.proposed.completed`, a reply before an approval card keeps its last
  letter, a realtime transcript's tail stays in its own message, a reused
  Codex process handle does not get the old tail; a command whose output
  crosses its turn's end stays hidden; several streams released by one
  event; a tail that turns out not to be a value arrives intact and in
  order.
- Questions and approvals: a Claude question containing a watched value is
  shown hidden and its answer reaches the adapter under the original text;
  two questions that differ only by two values of one name stay two
  questions;
  an approval shows the command hidden and the original runs; nothing is
  put back for any other string.
- The registry: watched before the file exists (a barrier between the
  hand-over and the write, with another session printing the value); an
  env value with a `#` in it is hidden when a command prints the variable
  right after Save; still watched after a failed write; read back at
  startup, archived threads included, and for an env request left
  `uncertain` by a crash after the rename; two values under one name get
  different placeholders; a removed `commands` key still hidden until restart; an
  unreadable destination skipped without a failure; the 200-value limit.
- `ask_user_to_run`: output hidden in the event, the row and the message,
  for a finished run and a run still going; a 300-character key sent once
  while half printed and once after 16,000 more characters is hidden both
  times; a command or reason with a watched value refused.
- Tools: a `thread_send`, a `room_ask` and a `show_page` with a watched
  value (in its content, its title or its icon) are refused and store
  nothing; an adopted artifact is stored
  hidden, title included.
- Read-backs: both tail readers give the same result as scrubbing the
  whole source and then cutting, for a short key, a multi-line key and a
  URL-encoded one; a subagent transcript and an import (title and messages) come
  back hidden.
- Failure text: a start failure whose stderr tail holds the value is
  stored, and alerted, hidden.
- The notice: one per name per turn, its own row, none for a side answer.
- The throughput check above.
- A polish check of the notice row with the app's real fonts, light and
  dark.

## Review

Astra reviewed rev 1 without the room's conversation. I checked its
findings against the code. All fifteen held at least in part. What each
changed:

1. The per-provider lists of log records to leave out were already
   incomplete (OpenCode's text deltas, Codex's realtime transcript, ACP's
   second copy). The lists are gone. The logs get whole-value hiding, and
   the choice between useful logs and piece-free logs goes to Will.
2. A piece can ride an event that is not a stream piece, in `raw`. Same
   answer as 1. In the event's `payload` those are growing snapshots, which
   are hidden once whole.
3. Releasing held text at the end of a turn leaked output that outlives the
   turn. Output streams now release at their item's end.
4. Scrubbing a tail after it was cut misses a value across the cut. The two
   tail readers scrub before they cut.
5. Reading the file back after the save left a window with an unwatched
   key on disk. The value is handed over before the write.
6. Three fields went around the hooks: an import's title, a command
   request's reason, a page's title. Each is covered where it enters.
7. Member names are scrubbed. Ids are not, and that is listed.
8. Failure text is covered at `formatFailureDetail`. The terminal, voice
   and project files are listed as not covered, each with its reason.
9. A rewritten question broke Claude's answer keys. Originals are put back
   on the way to the adapter, for exactly the strings that were changed.
   Threadlines' own tools refuse instead of rewriting.
10. The stream step matched its own placeholder. Held text and tail checks
    now use original text only, and a value that is part of its own name is
    not watched.
11. The stream key was too coarse. It now carries summary index, content
    index and the provider's thread id, with a rule for missing item ids.
12. A release is now an event of the stream's own type, and one event can
    release several streams.
13. The background refresh of env files is gone: it could miss an edit and
    could lag for hours. Values come from the card at save and from one
    read-back at startup, and the plan says what that leaves out. The
    startup read includes archived threads, as the query does.
14. The notice says "may have seen", and the paths with no notice are
    listed with reasons.
15. Long values are matched by their first 256 characters, which bounds
    held text and keeps the work linear. The registry is capped. The
    throughput check now covers long keys, many values, many streams, the
    logger and the nothing-watched wall time.

Also from the review: the acceptance test is now a reconstruction check.

Astra then reviewed only the parts new in rev 2 and found thirteen more. I
checked them against the code. What rev 3 changed:

1. The env save handed over the shell spelling, quotes and all. It now
   hands over the value as typed.
2. A crash after the rename left a key in the file with its request never
   marked saved. Startup now reads back `uncertain` and `claimed` env
   requests too.
3. Ingestion joins a child's partial and final answers. That joined text is
   scrubbed.
4. A placeholder and the text beside it could spell another watched value.
   A value shaped to do that is not watched.
5. `show_page` checks its icon too. `browser_type` is listed as not
   covered.
6. A failed write no longer unwatches the value.
7. A long key sent in two cut snapshots of command output got through in
   two halves. The terminal manager scrubs before it cuts, and a snapshot
   that ends partway into a value loses that tail.
8. A Codex question answered as a message keeps the placeholder. Listed.
9. Two values under one name get different placeholders, so two questions
   cannot collapse into one.
10. An MCP form with a watched key as a default is listed as a limit.
11. and 12. Held text is now released before every event at which ingestion
    closes the message: a finished plan, a finished voice transcript, an
    approval or question card, a reused process handle.
12. The tail readers read back as far as the longest watched value, not 255
    characters. Shared 256-character starts and a long key the provider cut
    at the front are listed.

I stopped at two rounds. The second found less than the first, and what is
left is the kind of thing the build's own tests and diff review catch.
