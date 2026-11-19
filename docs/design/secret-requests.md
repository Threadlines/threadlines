# Secret requests

Status: step 1 built (Nov 18 2026): the card, both uses and the store
cleanup. Step 2, hiding a printed key, is not built. Plan rev 2 takes
GPT-6.2 Astra's fifteen findings on rev 1; "Review" at the end says what
each changed. The
plan follows research on T3 Code's `request_secret` (clone at `f1d64aa0`) and
Astra's review of that code. It reuses the request, claim and note machinery
of `agent-settings-changes.md` and the message path of
`terminal-command-runs.md`.

## The problem

An agent that needs an API key, token or password asks for it in chat. The
user pastes it. The key is then in the thread's events, the database, every
connected app, the provider's transcript, the provider logs and the model's
context, and a thread move carries it to another computer.

The agent should ask on a private card. What the user types goes to the
thread's computer on one RPC, lands where it will be used, and Threadlines
writes it down nowhere else.

## What we can promise, and what we can't

Three promises, weakest last. The card tells the user which ones apply.

1. **Threadlines does not record or pass on the value.** It is never in a
   message, a stored event, a projection row, a tool input or result, a log,
   a trace or telemetry, and Threadlines never sends it to another app. This
   holds for every request, until the agent reads the file with a file tool
   or a command prints it. Step 2 of the build covers most of that case.
2. **The model is not shown the value.** The agent learns only that it was
   saved and where. This holds until the agent reads or prints it.
   Threadlines cannot remove a value from the model's context or from the
   provider's own transcript file.
3. **The agent cannot get the value.** We do not promise this anywhere in
   this build, and the card never says it.

Why 3 is out of reach today: an agent's shell commands run as the same OS
user as the Threadlines server. Any file the server can read without the user
present, the agent can read too. T3 Code has the same limit (Astra's finding
1 on it), and so does our own secret store: `cat
~/.threadlines/userdata/secrets/*.bin` works from any agent. Most agents also
inherit the server's environment, their own provider's API key included
(`ProviderInstanceEnvironment.ts:19`; Claude account instances drop the
Claude credentials, `ClaudeHome.ts:133`).

The destination is a file on the thread's computer, so the user's own paired
apps can read it as well: they can already open any file and a terminal
there (`ws.ts:2494`). The promise is about what Threadlines sends and
stores, not about who can open the file afterward.

Promise 3 needs Threadlines itself to make the call that uses the key. T3 has
one such consumer (webhook signing). Threadlines has none an agent can reach:
agents cannot create webhook tasks (`scheduleTools.ts:107`), and provider keys
are typed in Settings, which is already private. So every use in this build
ends with the agent able to read the key. "Later" describes the design that
would earn promise 3.

## Where keys live

Keys live on the computer that runs the thread, at the place that uses them.
Threadlines carries a key there and keeps no copy of its own.

| What                                             | Where                                                                          | Who can read it                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| A key for the project (`env_file`)               | the env file the card names, in the thread's folder                            | the OS user: the agent, and the user's paired apps                          |
| A key for the agent's commands (`commands`)      | `<state>/agent-secrets/<threadKey>/<requestId>/value`, removed after 24 hours  | the OS user: any agent on that computer, and the user's paired apps         |
| What Threadlines itself uses (unchanged)         | `<state>/secrets/*.bin`: provider keys, webhook secrets, link keys, relay keys | the OS user                                                                 |
| A waiting request                                | the thread's events                                                            | no value exists yet                                                         |
| The typed value in transit                       | one RPC frame, then the answer handler's memory until the file is written      | the app that typed it and the thread's computer                             |
| The typed value on a phone, browser or other app | the card's input, in memory, until the request leaves waiting                  | that app only. It is never in a store, a draft, localStorage or the console |

### One store, not two

Secret requests add no vault. Every request names its use, and the answer is
applied to that use in the same step, so there is never a held value waiting
to be exchanged for something. That removes T3's `secretRef` and the three
findings that came with it: a code another thread can spend, a database
column that keeps a "one-use" value, and a 24-hour store of pending values.

`ServerSecretStore` stays the one store for what Threadlines itself uses. It
gets two fixes in this build (see "Store cleanup"). The `agent-secrets` folder
is not a second store: it is a destination, in plain text because a shell
command has to read it.

### Encrypting the store: not now

I looked at sealing the store with a key held in the OS keychain (the desktop
app already uses Electron `safeStorage` for saved-computer tokens and could
hand a key to its server over the bootstrap pipe,
`DesktopBackendManager.ts:370`). What it would buy, per platform:

- macOS desktop: the key sits in a Keychain item tied to the signed app, so
  an agent's `cat` or `security` call no longer reads stored values without a
  prompt. This is the only platform where it stops an agent.
- Windows desktop: DPAPI decrypts for any process of the same user. It stops
  other users and copied disks, not an agent.
- Linux desktop: the keyring answers any process in the session, and without
  a keyring `safeStorage` is unavailable.
- Headless servers, Docker, SSH: no keychain. The key would sit in a file
  beside the data.

What it would cost: the server could not read user-typed secrets whenever
the keychain is locked, reset or missing (a headless start against a desktop
home, a restored backup, a moved home folder). Provider sign-ins and assistant
alerts would fail in ways that are hard to explain.

Nothing in this build holds a value the agent must not read, so sealing
protects nothing new here. It becomes worth its cost with host-bound keys
("Later"), on macOS. Until then the plain statement is that stored keys are
protected by the OS account, on every platform.

### By setup

- Desktop, any OS: the local server writes the file.
- Headless or remote server: the same. The value goes to the computer that
  runs the thread, not the device in the user's hand.
- Phone or browser through the relay: the answer frame is end-to-end
  encrypted (Noise KK, `docs/cloudflare-relay.md`), so the relay cannot read
  it.
- Fleet: the app sends the answer straight to the thread's own computer
  (`readEnvironmentConnection(threadRef.environmentId)`), never through
  another computer's server.
- A connection that isn't protected (a computer added by a plain `ws://`
  address): Save is off, and the card says "The connection to Windows PC
  isn't encrypted, so a key can't be sent from here. Answer on that
  computer." This is the check project setup already makes before it sends
  env files (`isProtectedConnectionUrl`, `packages/client-runtime`).
- Windows: `chmod` does nothing there. When the server first makes the
  `agent-secrets` folder it sets an ACL that drops inheritance and grants
  only the current user (`icacls`). If that fails, `commands` requests are
  refused on that computer with the reason, so the card never calls a shared
  folder private.

## What the user sees

1. The agent calls `secret_request`. A card docks above the message box, in
   the family of the settings and command cards:

   ```
   AGENT REQUEST  Claude is asking for a key
   STRIPE_SECRET_KEY
   Claude says: To run the checkout tests against Stripe test mode.
   [ ••••••••••••••••••••••••            (show) ]
   Saved as STRIPE_SECRET_KEY in .env.local, in this thread's folder on
   Will's MacBook Pro. It stays out of the chat. The agent can read that file.
                                          [Not now] [Save]
   ```

   When the file already has that name, the first line reads "Replaces the
   STRIPE_SECRET_KEY already in .env.local". For a `commands` request the two
   lines read: "Kept in a private file on Will's MacBook Pro until 2:14 PM
   tomorrow. It stays out of the chat. The agent can read it."

2. The agent picks the name, the reason and, for `env_file`, the file.
   Threadlines writes the two lines about where the value goes, from the
   checked request, and shows the name and file there in full. The reason is
   plain text behind "Claude says:". An injected agent can put a card in
   front of the user, and cannot change what the card says happens to the
   value.
3. Save sends the value to the thread's computer. The card goes, and a row
   in the timeline stays: "You saved STRIPE_SECRET_KEY to .env.local". A
   `commands` row also says when the file goes and has "Remove now".
4. A value the use cannot hold keeps the card open with the reason under the
   field (see "Uses"). Nothing is claimed, so the user can fix it and save
   again.
5. If the field starts or ends with a space, the card says so and offers
   "Remove spaces". Threadlines never trims by itself.
6. Not now saves nothing. The agent hears it at its next turn.
7. While a card waits, the sidebar shows Pending Approval and a paired phone
   gets a "Needs you" alert ("Wants a key from you"), as for the other agent
   requests.
8. Several cards can wait at once (an agent that needs two keys). The dock
   shows one at a time with "1 of 2".

The field is a password input the browser must not offer to save and must not
fill with the user's own passwords. A `multiline` request shows a masked text
area for PEM keys and JSON credentials.

What the app does with the typed text:

- It lives in the card's component state, keyed by computer, thread and
  request. It is never in a store, a draft or browser storage.
- It is cleared when the request leaves waiting for any reason: saved or
  failed by this app, answered on another device, replaced, cancelled, or
  gone from a fresh snapshot after a reconnect.
- It survives only a `rejected` answer and a lost connection while the
  request still waits.
- It never moves to another card when the dock advances.

## The tool

`secret_request` on the room endpoint, in the same grant group as `app_guide`
and `settings_change` (`APP_TOOL_NAMES`, `roomToolAccess.ts`), so every local
thread's own runtime has it. Side runtimes (ask, review) do not. Fenced
threads and fx through WSL have no room endpoint, as today.

```
secret_request({
  name: string,        // /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, e.g. STRIPE_SECRET_KEY
  reason: string,      // plain text, 1 to 200 characters
  use: { kind: "env_file", path: string }   // e.g. ".env.local"
     | { kind: "commands", multiline?: boolean }
})
→ { outcome: "asked_user" | "refused" | "not_allowed", detail: string }
```

- The result never carries a value, a file path or a reference. On
  `asked_user` the detail says: "The user was asked on a card. End your turn
  or go on with other work. A message arrives when they answer. Don't ask
  for the value in chat."
- There is no `value` input. A key the user already pasted in chat is in the
  events and the model's context, and copying it into a file undoes nothing.
  The tool description says: if the user pastes a key in chat, tell them it
  is now in the conversation and that they may want to replace it.
- The tool loads up front (not `loadedOnDemand`). `toolLoading.ts` keeps a
  tool unmarked "when a model that cannot see it does the wrong thing instead
  of looking for it", and here the wrong thing is asking in chat. This
  raises the pinned budget in `agentContextBudget.test.ts` on purpose. Keep
  the description under about 150 tokens.
- It returns at once and does not hold the call open. Room tool calls stop
  at 26 minutes on Claude and Codex and at about 60 seconds on Cursor and fx
  (`roomToolTimeouts.ts`, `roomToolHandlers.ts:107`), and a user may answer
  from a phone an hour later.
- The caller must hold the thread's live turn (`latchCallerTurn`). The thread
  must exist and not be archived or moving.
- An `env_file` request is checked when asked (the rules below). A failure is
  `refused` with a detail the agent can act on ("`.env.local` isn't ignored
  by git here. Add it to .gitignore, then ask again.").
- At most 5 requests per turn per agent, and at most 5 waiting per thread.
  One waiting card per name and use per thread: a new request for the same
  name and use replaces the waiting one, whichever agent asked. A claimed one
  is never replaced.
- The request id is `derivedUuid(thread, participant, turn, tool, input)`, so
  a provider's retry inside the turn is the same command and never makes a
  second card.
- Annotated read-only, not destructive, idempotent, like `settings_change`:
  the call only shows a card.
- The guide instruction sentence (`guideTools.ts`) gains: "When you need an
  API key, token or password from the user, call `secret_request`. Never ask
  them to paste one into chat."

## Uses

A request is bound to its use when it is made. The use cannot change after,
and the value goes only there. Values are UTF-8 text.

### `env_file`

For a key the project needs to run. The value lands as `NAME=value` in an env
file in the thread's working folder (the worktree when the thread has one).

When the request is made, the server resolves the thread's working folder
and the file's parent folder to real paths and stores both on the request.
The answer writes there or nowhere: if the thread's folder is a different
path by then (a checkout switch, `decider.ts:4948`), the save fails with
"This thread's folder changed since the agent asked."

Path rules, checked when asked and again under the claim:

- relative, and its parent resolves inside the thread's folder;
- the file name is `.env`, `.env.<anything>` or `.dev.vars`, and does not end
  in `.example`, `.sample`, `.template`, `.dist` or `.defaults`;
- the target is absent or a regular file, never a link, junction or device,
  and the parent's real path is still the stored one;
- in a git repository the path is ignored and not tracked (`git
  check-ignore`, `git ls-files`). Outside a repository it is allowed.

Name rules:

- a name a framework ships to browsers is refused: `VITE_`, `NEXT_PUBLIC_`,
  `NUXT_PUBLIC_`, `PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `GATSBY_`. The
  detail says "That name is sent to browsers by the framework, so it can't
  hold a secret."
- a file Threadlines cannot edit safely is refused: the name is assigned
  more than once, or its line opens a quote that does not close on that line.

Value rules, checked before the claim so the card can stay open:

- one line, at most 8,192 characters, not empty;
- written bare when it has only `A-Z a-z 0-9 _ - . / : + = @ % , ~`;
  otherwise in single quotes; a value with a single quote or a line break is
  `rejected` with "An env file can't hold this value as typed. Ask the agent
  to request it for its commands instead."

The write, always a replace by rename:

1. Read the file and note its size, time and identity.
2. Build the new content: replace the one `NAME=` or `export NAME=` line, or
   append a line.
3. Create the temp file exclusively, mode `0600`, write, sync. In a
   repository it is `<requestId>.tmp` under `git rev-parse --git-path
   threadlines-secret-saves`, inside git's own folder, where no `git add`
   (a checkpoint's included) can stage the whole file; that folder must be a
   real folder, not a link. Outside a repository it is
   `.<file>.<requestId>.tmp` beside the file. Both are on the file's volume.
4. Stat the target again. If it changed since step 1, start over once, then
   fail with "The file changed while saving."
5. Rename over the target and give the result the old file's mode (`0600`
   for a new file). Remove the temp file on any failure.

A rename replaces the name, so a hard link elsewhere is never written
through, and the file is never half-written. The temp name comes from the
request id, so startup recovery removes exactly that file, in either place.
Git is asked in the file's own folder (a repository nested in the thread's
folder counts) and in the thread's folder (an outer repository may track
it); any git failure but "not a git repository" refuses.

An existing file keeps its mode. It already held the project's other
secrets at that mode, and tightening it could break the user's own tools.

Threadlines keeps nothing after the write. A worktree's env file goes with
the worktree, so a later thread in a fresh worktree asks again. That is a
known limit ("Later").

### `commands`

For a key the agent's shell commands need once or for a while, outside the
project's files. The value is written as typed to
`<state>/agent-secrets/<threadKey>/<requestId>/value`.

- `threadKey` is a hash of the thread id, and the request id is checked to
  be a UUID, because a `ThreadId` can be any non-empty string
  (`baseSchemas.ts:30`). Every create and every remove checks that the real
  path is inside `agent-secrets`. The file name is fixed, so a name like
  `NUL` or `CON` never becomes a file.
- Folders are `0700` and the file `0600`, opened with that mode. At most
  64 KB.
- Single-line values are saved as typed. `multiline` values are saved with
  `\n` line endings, which is what the text area gives. No line break is
  added at the end.
- The message to the agent gives the path and how to use it, quoted for the
  shell by one shared helper so a home folder with a quote or space in it
  still works. For a single-line value: "Read it inside a command, like
  `"$(cat <path>)"`. Never print it, and don't pass `-v` or `-x` to a
  command that uses it." On Windows it adds the PowerShell form. For a
  `multiline` value: "Pass the file's path to the tool that needs it. Don't
  read it into a variable."
- The file is removed at the `expiresAt` recorded when it was saved, 24
  hours on. A timer does it, set at save and again at startup from the
  thread's state. An hourly sweep by the file's own time is only the backstop
  for orphans.
- Archive, delete and the start of a move remove the thread's folder.
  "Remove now" on the timeline row removes one file.
- A file under the Threadlines home works under every provider's sandbox,
  which limits writes and network, not reads. A helper that fetched the
  value from the server would fail inside Codex's sandbox.

### Not built

- A `value` input for keys pasted in chat (above).
- References (`secretRef`). Nothing consumes one.
- Uses where Threadlines keeps the key for itself. `use` is a union so each
  can be added later with its own handler and card wording.

## The request on the thread

Event-sourced on the thread, like settings requests: a nullable JSON column
`secret_requests` on `projection_threads` (new migration, no backfill),
holding a small state from a pure reducer in `packages/shared` that the
projector, the projection pipeline and the web store all fold with.

```
OrchestrationSecretRequest {
  requestId, participantId | null, turnId,
  name, reason, use, replaces: boolean,
  folder?, parent?,                     // env_file: the real paths it is bound to
  status: "waiting" | "claimed" | "saved" | "failed" | "uncertain"
        | "declined" | "replaced" | "cancelled",
  claim?: { claimId, deviceLabel },     // also set by Not now
  detail?, savedAt?, expiresAt?, removedAt?,
  createdAt, settledAt?, noted: boolean
}
```

No field holds the value, its length or a hash of it. A hash of a short
password can be guessed, and a length narrows the guess.

| Event                            | From → to                                                         | Sent by                                                           |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `secret-request-created`         | → waiting; the waiting one with that name and use → replaced      | the tool                                                          |
| `secret-request-claimed`         | waiting → claimed, with the claim                                 | the answer service                                                |
| `secret-request-settled`         | waiting → declined, cancelled; claimed → saved, failed, uncertain | the answer service; archive, move start, revert; startup recovery |
| `secret-request-removed`         | saved (`commands`) → `removedAt` set                              | Remove now, the expiry timer, thread cleanup                      |
| `secret-request-notes-delivered` | settled → noted                                                   | the provider command reactor, or the follow-up's own decision     |

There is no way back to waiting. Archive, the start of a move and revert
(for requests from reverted turns) settle waiting ones `cancelled` in the
same decision. So does an agent leaving the room, for its own waiting
requests: nobody is left to use the key. Forks and moved copies carry no
requests. The shell summary
gains `pendingSecretRequest`, feeding Pending Approval.

What the state keeps:

- every waiting and claimed request;
- every saved `commands` request until it is removed, so Remove now and the
  expiry timer always find it;
- every settled request that still owes its agent a note;
- beyond those, the 20 most recently settled.

## Answering

RPC `secretRequest.respond`, sent to the thread's own computer:

```
{ threadId, requestId, claimId, deviceLabel,
  answer: { type: "save", value } | { type: "decline" } }
→ { outcome: "saved" | "failed" | "uncertain" | "declined" | "rejected"
           | "already_answered" | "cancelled" | "replaced" | "gone",
    detail?, by?: string }   // by: the device whose answer stands
```

`value` is `Schema.RedactedFromValue(Schema.String)` with no checks on the
wire schema, so the decoded value prints `<redacted>` if anything logs it.
The handler does the size and shape checks itself and answers with fixed
text. The wrapper does not protect a frame that fails to decode: the RPC
layer formats that failure itself (`RpcServer.ts:981`). The canary test
below proves what that formatting quotes, and the answer RPC gets fixed-text
decode errors if it quotes input.

One semaphore in the answer service serializes every answer and every file
operation under `agent-secrets` (write, remove, thread cleanup, expiry,
sweep). Each run goes to its end in the service's own scope.

1. Read the request. Settled with the same `claimId`: return its stored
   result and ignore the value (a retry after a lost answer; this covers Not
   now too, since a decline records its claim). Settled otherwise, or claimed
   by another claim: `already_answered`, `cancelled` or `replaced`, with
   `by`. Gone: `gone`.
2. Decline: settle `declined`, recording the claim.
3. Save: check the value against the use. A value the use cannot hold
   returns `rejected` with the reason. Nothing is claimed and the card stays.
4. Claim. Only the committed waiting-to-claimed event authorizes a write: a
   request replaced or cancelled between the read and the claim fails the
   claim, and nothing is written.
5. Check the destination again, then write.
6. Read the thread again. If it was archived, deleted or started moving
   during the write, remove what was written (`commands`) and settle
   `failed` ("The thread was put away while saving."). Otherwise settle
   `saved`.
7. The value exists in this handler's memory only, unwrapped at the write.

Thread cleanup (archive, delete, move start) runs after its event, under the
same semaphore, and removes the thread's `agent-secrets` folder, marking its
saved requests removed. Either order with a save ends the same way: the
file is gone and the request does not say `saved` with a file that exists.

Two apps answering at once: the first claim wins. The second gets
`already_answered` with `by`, its value is dropped, and its card says
"Answered on Will's iPhone", never "saved". This is T3's finding 6, fixed by
the claim.

Startup recovery, before any answer is taken: a request still `claimed` (the
server stopped mid-answer) is settled without a value. `commands`: its folder
is removed and it settles `failed` ("Threadlines stopped while saving. Ask
again."). `env_file`: the temp file named for the request is removed, and it
settles `uncertain` ("Threadlines stopped while saving NAME. It may or may
not be in .env.local. Ask again if you need it."). The rename is atomic, so
the rest of the file is whole either way.

## Telling the agent

Pressing Save is the user telling the agent to go on, so the outcome reaches
the agent the way a finished command's output does. The settle command
carries a message for the agent, and the decider emits the settled event and
the follow-up in one decision (`decideFollowUpSubmit`, as
`thread.command-run.deliver-output` does at `decider.ts:6000`): steered into
a running turn, or starting one on an idle thread. That decision also marks
the request noted, so no second note follows. The message id is
`secret-answer:<requestId>` and the timeline draws it as the saved row, not a
chat bubble (as `isCommandOutputMessage` does for command output).

- Saved, `env_file`: "I saved STRIPE_SECRET_KEY to .env.local. Its value is
  not in this conversation. Don't read the file into the chat or print it."
- Saved, `commands`: the path and the usage line above, and "It is removed
  at <time>. If it is gone when you need it, ask again."
- Failed: the reason, such as "`.env.local` is tracked by git now, so
  nothing was saved."

The answer goes only to the agent that asked:

- If that agent has left the room when the user saves, the request settles,
  no message is sent, and a `commands` file is removed at once: nobody is
  left to use it.
- A provider that cannot be steered queues the follow-up
  (`ProviderCommandReactor.ts:3711`). The queue drain's check that a message
  goes only to its own agent is keyed to command-output ids today
  (`decider.ts:4298`). It is widened to one shared test covering both ids,
  so a queued answer whose agent left is taken back, never handed to the
  thread's own agent.

The other endings do not wake the agent. They ride in front of its next turn
as a note, on the settings-change path in `ProviderCommandReactor`, each with
its own words:

- Not now: "The user said no to your request for STRIPE_SECRET_KEY. Don't
  ask again or in chat. Say what is blocked and go on without it."
- Cancelled: "Your request for STRIPE_SECRET_KEY was cancelled: the thread
  was archived." The user did not say no.
- Uncertain: the recovery sentence above.
- Replaced: nothing. The newer request stands.

## What gets written down

| Place                                                                | What it holds                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `orchestration_events`, `projection_threads`                         | name, reason, use, the bound folder, status, device label, times                               |
| The tool call (activities, provider logs, the provider's transcript) | name, reason, use; `asked_user`                                                                |
| The follow-up message and notes                                      | name, path, outcome                                                                            |
| Other connected apps                                                 | the request and its status, through the thread's events                                        |
| `server.trace.ndjson`, OTLP                                          | the method name. Errors are fixed text                                                         |
| Server logs (`server-child.log` on desktop)                          | nothing about the value                                                                        |
| Telemetry                                                            | nothing new                                                                                    |
| A thread move                                                        | the follow-up message's text (a path on the old computer). No request, no `agent-secrets` file |

Two things outside this table can still carry an env file somewhere, both
the user's own doing: Fleet project setup offers `.env` files to send to
another computer, ticked by default (`ProjectSetupSource.ts:56`), and a move
copies untracked files that are not ignored at that moment
(`moveExport.ts:194`), so un-ignoring the file later lets it travel.

The canary test holds this table to account. On a throwaway home with a
project folder beside it, make a request and answer it from a real client
with a random canary value. Then check all of these for the canary, plain
and base64:

- every file under the home (the database and its WAL, logs, traces,
  provider logs), where it may appear only in a `commands` destination;
- the project folder, where it may appear only in the env file;
- every frame sent to a second connected client, decoded;
- what a capturing OTLP endpoint received;
- the answering client's console, its trace export, localStorage,
  sessionStorage and IndexedDB.

Further runs answer with an oversized value, a `rejected` value, a frame
with a valid value and a malformed sibling field, a retry after a dropped
connection, and two clients at once. Any later change that logs a payload
fails this test.

## Hiding a printed key (step 2)

The agent can still pull a saved value into view: `env`, `cat .env.local`,
`curl -v` showing an Authorization header, or a file tool reading the env
file. Step 2 replaces a known value with `[NAME hidden]` before Threadlines
stores, logs or sends it, and tells the user. It has its own plan,
`secret-scrubbing.md`, which replaces the sketch that stood here.

## Store cleanup

Two fixes to `ServerSecretStore`, found while checking T3's finding 4 against
our own code:

- `set` writes `<name>.bin.<uuid>.tmp` and renames it. A crash in between
  leaves a plain copy that nothing removes (`list` matches `.bin` only). The
  layer now removes `*.tmp` in the secrets folder when it starts, before any
  write.
- `set` creates the temp file with the default mode and then narrows it. It
  now opens the file with `0600`, as `create` already does.

## Providers

The tool rides the room endpoint, so one implementation reaches every
provider that gets it.

| Provider                                       | Decision                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude                                         | Supported. Loaded up front. The instruction sentence is in the system prompt.                                 |
| Codex                                          | Supported. Check live that a sandboxed command can read the `commands` file in read-only and workspace-write. |
| OpenCode, Pi                                   | Supported. Pi asks before tools that are not read-only, so the annotations matter.                            |
| Muse                                           | Supported where the host grants session MCP servers. Otherwise no room endpoint, as today.                    |
| Cursor, fx, Antigravity, Grok (ACP)            | Supported through the generic core. No instruction text, so the description carries the rules.                |
| Community agents                               | The same generic path. Nothing agent-specific.                                                                |
| fx through WSL, fenced threads, outside agents | Not supported: no room endpoint, and nothing Threadlines can tell them. Nothing changes for them.             |

A provider that queues follow-ups hears a saved answer at its next turn
start instead of mid-turn. No provider timeout changes: the call returns at
once.

## Hit every surface

- Entry points: the card is the only way in. The timeline row is the way to
  see a saved key and, for `commands`, the way out.
- Clients: web, desktop and phone share the card. The value goes to the
  thread's computer from any of them, over a protected connection only.
- Contracts: request state, events, commands, shell and detail fields, the
  two RPCs, the tool's schema.
- Reverse states: Not now; cancelled on archive, move start and revert;
  replaced; Remove now; 24-hour removal. An `env_file` key is the user's own
  file to edit.
- App guide: a short topic ("Agents ask for keys on a card") in
  `guide/topics.ts`, with the limits above. No settings row, so no new place.

## Build order and files

Step 1, one PR: the card, both uses, store cleanup.

- `packages/contracts/src/secretRequests.ts` (new), `orchestration.ts`
  (request state, events, commands, `pendingSecretRequest`), `rpc.ts`
  (`secretRequest.respond`, `secretRequest.remove`).
- `packages/shared/src/secretRequestState.ts` (reducer),
  `secretRequests.ts` (name, path and value rules, the env line, shell
  quoting, message and note text, the message id).
- Server: `mcp/secretRequestTools.ts`, `mcp/secretRequestToolHandlers.ts`,
  `mcp/McpRoomServer.ts` (toolkit, `ROOM_TOOL_REACH`),
  `mcp/roomToolAccess.ts`, `mcp/guideTools.ts`,
  `secrets/AgentSecretRequests.ts` (answer service, recovery, timers),
  `secrets/secretDestinations.ts` (env file write, commands file, cleanup,
  sweep, the Windows ACL), `orchestration/secretRequestDecisions.ts`,
  `decider.ts` (commands, lifecycle cancels, the queue-drain recipient
  test), `projector.ts`,
  `persistence/Migrations/121_ProjectionThreadSecretRequests.ts`,
  `persistence/Layers/ProjectionThreads.ts`, `ws.ts`,
  `orchestration/Layers/ProviderCommandReactor.ts`, `config.ts`
  (`agentSecretsDir`), `auth/Layers/ServerSecretStore.ts`,
  `guide/topics.ts`, `server.ts`, `provider/agentContextBudget.test.ts`.
- Web: `components/chat/ComposerSecretRequestPanel.tsx`,
  `secretRequestCard.logic.ts`, `MessagesTimeline.tsx` (the saved row),
  `ChatComposer.tsx`, `Sidebar.logic.ts`, `threadDerivation.ts`, `store.ts`,
  `environments/runtime/threadDetailSubscriptions.ts`, `rpc/wsRpcClient.ts`,
  the push alert text.

Step 2, its own PR: hiding a printed key. Its files are listed in
`secret-scrubbing.md`.

## Testing

- shared: the reducer (every transition, refused ones, no way back to
  waiting, what pruning keeps); path, name and value rules; the env line for
  bare, quoted and rejected values; replace against append; a duplicate
  name and an open quote refused; shell quoting of a path with a quote and a
  space.
- server: the tool at its boundary (asked_user; refused for a tracked,
  unignored or template path and for a browser-exposed name; a retry returns
  the same request; replace across agents; no live turn refused; the
  per-turn limit); the decider (one claim under two answers; decline loses
  to a claim; archive and move start cancel waiting ones; a claim on a
  replaced request fails); the answer service (save writes, settles and
  delivers one message; rejected leaves the request waiting; a same-claim
  retry returns the stored result, for save and for decline; a path that
  became tracked, a parent swapped for a link and a changed thread folder
  each settle failed and write nothing; a file edited during the save is
  retried once; a thread id with `..` cannot reach outside `agent-secrets`,
  proved with a sentinel file; archive paused right after the claim and
  right after the write; recovery for both uses); the expiry timer and the
  sweep; a queued answer whose agent left is taken back; `ServerSecretStore`
  removes leftover temp files; the canary test.
- web: a browser test for the card (the fixed lines per use, with the
  replaces line; Save calls the RPC once; rejected keeps the card and the
  field; answered elsewhere, replaced and cancelled each clear the field and
  say why; the next card starts empty; Save is off on an unprotected
  connection; Not now; the spaces hint; the field is in no store), the saved
  row with Remove now, the sidebar pill from a snapshot and from a live
  event.
- Live, on a throwaway home: a real Claude and a real Codex agent asked to
  "set up Stripe", answered from desktop, from a phone through the relay, and
  from two windows at once. Check the agent asks on the card without being
  told to, and that Codex reads the `commands` file in both sandbox modes. A
  Windows run for the ACL and the PowerShell line.
- Step 2: see `secret-scrubbing.md`.

## Later, not in this build

- **Host-bound keys.** The design that earns promise 3. The request names a
  host ("sent only to api.stripe.com"), the user approves it on the card, and
  a Threadlines tool makes the HTTPS call with the key in a header. The agent
  sees the response and never the key. This needs a held value, and with it
  the sealed store on macOS. It covers REST APIs, not CLIs that read a key
  from the environment. Worth its own plan.
- Uses Threadlines owns: a webhook signing secret once agents can create
  webhook tasks.
- Password manager references (`op://`), read through the `op` CLI on the
  thread's computer.
- A paste guard in the message box: "This looks like an API key. Anything
  sent here is saved in the thread and shown to the model."
- Rules in the provider configs Threadlines writes that deny reads of the
  Threadlines home. This stops a casual read by a file tool, not a shell
  command.
- A "save in the main checkout too" tick for `env_file` in a worktree.
- A Settings list of every live `commands` file on this computer.

## Review

Astra reviewed rev 1 without the room's conversation. All fifteen findings
held against the code. What each changed:

1. A paired app or a file tool can read the destination with no command
   printing anything. The promises now say what Threadlines sends and
   stores, and that the agent and the user's paired apps can open the file.
2. Scrubbing `ask_user_to_run` output at delivery was too late: the output
   is in an event and a row first. Step 2 scrubs where the output is
   recorded, the notice is worded per path, and the user's own terminal is
   listed as not covered.
3. "Thread moves: nothing" was false. The table now names what a move
   carries, and the two ways an env file can travel.
4. Save over an unencrypted connection is refused, not warned about. The
   Windows ACL moved into the build, failing closed. An existing env file's
   mode is kept, with the reason given.
5. Step 2's limits are listed. The registry is per computer, which also
   removes the session-key lookup problem.
6. Folder names are hashed and checked on create and remove, and the file
   name is fixed.
7. The request is bound to real paths when made, checked again under the
   claim, and written by rename only.
8. The cross-volume direct write is gone. One write path, with an edit
   check and a temp file recovery can find.
9. The card shows the file and name in Threadlines' own lines and says when
   it replaces. Template files and browser-exposed names are refused. One
   waiting card per name and use per thread.
10. Encoding, line endings and the env grammar are defined, ambiguous files
    are refused, and multi-line values are used by path.
11. One semaphore orders answers and cleanup, the claim event authorizes the
    write, and the thread is read again before settling.
12. The RPC can return every ending, a decline records its claim, and the
    card's clearing rules are per transition.
13. State keeps live files and unsent notes, and expiry follows the recorded
    time.
14. Answers go only to the asking agent at enqueue and at drain, a
    follow-up marks the request noted, and each ending has its own words.
15. `RedactedFromValue` does not cover a failed decode. The canary test now
    covers the answering client, OTLP, base64, malformed frames and retries.

Also corrected: not every agent inherits its provider's key (Claude account
instances don't), and unsupported runtimes are described as unchanged.
