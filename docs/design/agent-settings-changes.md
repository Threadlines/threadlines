# Agents change settings

Status: built (Nov 2 2026), from plan rev 4. Sol's diff reviews added what
"Answering" and "Lifetime" now say about a dropped connection, save order and
reverts. Rev 4 takes Sol's four on rev 3: device
changes are no longer made before the answer (a losing window could undo the
winner, a retry could misreport, two stores can't be one write). The app
whose claim won makes them once, prompted by the answer or by seeing its own
claim settle, and reports each setting; nothing is ever put back. Agent
retries are deduplicated by the engine's durable command receipts, not by
what the thread state still holds.

Earlier: builds on `app-guide.md` (the place catalog,
`app_guide`, place links), which left settings changes for later. Rev 2 took
Sol's eleven findings on rev 1 (two rows off the list, claim before any write,
truthful outcomes, device results, stale values, lifetime, retries, duplicate
and nested changes, whole numbers, web surfaces, links to another computer).
Rev 3 takes Sol's nine on rev 2 by removing protocol rather than adding it: no
refresh back to waiting (a stale value fails that request), device changes
made by the clicking app before it answers and reported in the answer (no
later confirmation), the write itself says whether it landed (no read-back),
one answer at a time per computer, and settle allowed on a frozen thread.

## The problem

An agent can now tell the user where a setting is and what it is set to. Asked
"switch me to the light theme" or "stop streaming replies", it can only link
the row. The user wants the change made. A prompt-injected agent must not be
able to use the same path to give itself more reach, delete data, or turn on
sharing the user never agreed to.

## What the user sees

1. The agent calls `settings_change`. A card docks above the message box, in
   the family of the child-thread and scheduled-task cards:

   ```
   AGENT REQUEST  The agent wants to change 2 settings
   Stream replies: On → Off            Will's MacBook Pro
   Theme: Dark → Light                 this device
                                        [Not now] [Change]
   ```

   Each setting's name is a place link: it opens and highlights the row,
   except a computer setting of another computer (a Fleet thread), whose chip
   is inert and says "In Threadlines on <computer>", as place links already
   do. The right column says where the change lands: the thread's computer by
   name, or "this device" for settings each app keeps. Device "from" values are
   read live from this app; computer ones are what the computer had when the
   agent asked, and are checked again when the user answers.

2. **Change** makes the computer's changes, all of them or none, then this
   app makes this device's changes. **Not now** makes none. Either way the
   card goes, and a toast says what changed and what didn't.
3. If a computer setting changed since the agent asked, none of the computer
   changes are made ("Stream replies was changed to Off since the agent
   asked"); the device changes still are, since the user saw them as they
   are. The agent hears both, and can ask again.
4. The sidebar shows the thread as Pending Approval while a card waits, like
   the other agent requests.
5. "All or none" holds for the computer's changes (one file write). Device
   changes are made one store at a time (the theme has its own), so each is
   reported as it went.
6. At the agent's next turn it is told what happened (a note in front of the
   user's message, like scheduled-task answers). It is not woken just to hear
   it.

Nothing changes without a click. There is no "without asking" mode: half the
settings live in the user's apps, and only an app the user is looking at can
make those, so every change needs one anyway. It also keeps the injection
story simple: an injected agent can only put a card in front of the user.

## Which settings: the allowlist

A place is writable only if the catalog gives it an `edit`. Nothing else is,
including places with a `value` reader. Fail closed.

Rules for what may get an `edit` (a unit test enforces the first):

- never a place marked `widensAgents` (agent reach, autonomy, fan-out,
  sign-ins, devices, plugins, exposure, site policy);
- nothing that deletes or archives data, or removes a guard against losing it
  or putting it away (Delete old archived threads; Auto-archive, which
  archives at once; Confirm delete; Confirm archive);
- nothing that turns on sharing (Usage analytics);
- no free text that ends up in prompts (Custom instructions for commit and PR
  writing): a planted instruction would outlive the turn;
- nothing that needs more than a value: model pickers, branch names,
  downloads, permission prompts (alerts), sizes;
- desktop-only rows (`appliesWhen: "desktop"`) wait for a later version: the
  card can't promise them on a phone or the web app.

The catalog marks two more places `widensAgents`, so the guide says only the
user changes them: Claude workflow size ("Any" means no limit on agents) and
Continue after usage limits (agents carry on alone after a limit).

The first list:

| Place                                             | Lands on | Control                                              | Setting (the only leaves its patch may touch)                                          |
| ------------------------------------------------- | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stream replies                                    | computer | switch                                               | `enableAssistantStreaming`                                                             |
| Keep awake during turns                           | computer | switch                                               | `preventSleepDuringActiveTurns`                                                        |
| Start in                                          | computer | choice: Local, New worktree                          | `defaultThreadEnvMode`                                                                 |
| Keep Claude's suggestions when you're using a lot | computer | switch                                               | `claudeSuggestionsWhenUsageRunsFast`                                                   |
| Fetch interval                                    | computer | whole seconds: 0 (off) or 30 to 3600                 | `automaticGitFetchInterval`                                                            |
| Source control writing style                      | computer | choice: Repository conventions, Conventional Commits | `sourceControlWritingStyle.mode`                                                       |
| Follow PR templates                               | computer | switch                                               | `sourceControlWritingStyle.followPrTemplates`                                          |
| Theme                                             | device   | choice: System, Light, Dark                          | theme store                                                                            |
| Time format                                       | device   | choice: System default, 12-hour, 24-hour             | `timestampFormat`                                                                      |
| Changed files in chat                             | device   | switch                                               | `chatChangedFilesDefaultExpanded`                                                      |
| Agents panel                                      | device   | switch                                               | `autoOpenAgentsPanel`                                                                  |
| Wrap diff lines                                   | device   | switch                                               | `diffWordWrap`                                                                         |
| Hide whitespace changes                           | device   | switch                                               | `diffIgnoreWhitespace`                                                                 |
| Text size (terminal)                              | device   | whole px, 9 to 24                                    | `terminalFontSize`                                                                     |
| Screen reader support                             | device   | switch                                               | `terminalScreenReaderMode`                                                             |
| Hold to record                                    | device   | switch                                               | `dictationHoldToRecord`                                                                |
| Wrap up idle / merged / finished child threads    | device   | switch                                               | `wrapUpIdleThreads`, `wrapUpThreadsOnPullRequestSettled`, `wrapUpChildThreadsOnFinish` |
| Open panel by default (source control)            | device   | switch                                               | `sourceControlPanelDefaultOpen`                                                        |

The wrap-up switches only change how each app files its own thread lists
(Wrapped is reversible filing, not archiving).

## The catalog: `edit`

`AppPlaceSpec` gains `edit?: AppPlaceEdit`:

```ts
type EditControl =
  | { kind: "switch" }
  | { kind: "choice"; options: Record<string, string> } // value -> label on screen
  | { kind: "count"; min: number; max: number; unit: string; offAt?: 0 }; // whole numbers
type EditValue = boolean | string | number;

type AppPlaceEdit =
  | {
      lands: "computer";
      control: EditControl;
      leaves: ReadonlyArray<string>;
      read: (s: ServerSettings) => EditValue;
      patch: (v: EditValue) => ServerSettingsPatch;
    }
  | {
      lands: "device";
      control: EditControl;
      leaves: ReadonlyArray<string>;
      read: (c: ClientSettings) => EditValue;
      patch: (v: EditValue) => ClientSettingsPatch;
    }
  | { lands: "device"; control: EditControl; store: "theme" };
```

- Helpers build `value` and `edit` together for computer switches and
  choices, so the guide's reading and the write can't drift.
- Agents pass place ids and values only; keys come from the catalog.
- One shared module (`packages/shared/src/settingsEdits.ts`) holds
  `checkEdits(changes)` (known place, has `edit`, value fits its control:
  booleans, option keys, finite whole numbers in range; no duplicate places;
  1 to 8 changes) and `composePatch(edits)` (deep-merges the patches, so the
  two writing-style edits each set their own leaf and never reset
  `customInstructions`). The tool, the server's answer and the web's apply
  all use it.
- Tests: every `patch` touches exactly its `leaves`; `read(patch(v))` gives
  `v` back for every option and range end; no `edit` on a `widensAgents`
  place.

The guide marks each place: "An agent can change this for you after you
accept on a card", or (widensAgents) "Only you can change this", or neither.
Its settings topic and the `app_guide` description drop "You can't change
settings" for a line about `settings_change`.

## The tool

`settings_change` on the room endpoint, granted wherever `app_guide` is
(every local thread's own runtime, including the guide-only grant). Not for
side runtimes (ask or review); fenced threads (another computer's agent,
outside agents) have no room endpoint, as today.

```
settings_change({ changes: [{ place: string, value: boolean | string | number }] })  // 1 to 8
→ { outcome: "asked_user" | "unchanged" | "refused" | "not_allowed",
    detail: string,
    changes?: [{ place, path, link, from?, to, lands: "computer" | "device" }] }
```

- `checkEdits` first; one bad change refuses the whole call, and the detail
  names it: not a place, only the user can change it (with its link), not
  changeable by agents (with its link), a duplicate, or a bad value (with the
  allowed ones).
- The caller must hold the thread's live turn (`latchCallerTurn`, as the
  schedule tools do); the thread must exist and not be archived or moving.
  Answers may come after the turn ends; new requests may not.
- Computer changes already at their value are dropped. If nothing is left,
  `unchanged`. Device values are unknown to the server, so device changes
  always go to the card.
- At most 5 requests per turn per agent.
- The request id is `derivedUuid(thread, participant, turn, tool, input)` and
  the command id is derived from it, so a provider's transport retry inside
  the turn is the same command: the engine's durable command receipts make it
  a no-op whatever the thread state still holds, and the tool answers with
  that request's outcome (plain `asked_user` if it has left the state). It
  never makes or replaces a card. A call in a later turn is a new request, as
  it should be (the model asked again).
- A new request from the same agent replaces its waiting one (marked
  `replaced`, in the same decision); a claimed one is never replaced.
- Annotated read-only and not destructive, like `ask_user_to_run`: the call
  only shows a card, so providers that ask before non-read-only tools (Pi)
  don't ask twice.

## The request on the thread

Event-sourced on the thread, kept like child requests: a JSON column
`settings_requests` on `projection_threads` (new migration: one nullable
column, no backfill, instant on large databases) holding a small state from a
pure reducer in `packages/shared` that the projector, the projection pipeline
and the web store all fold with.

```
OrchestrationSettingsChangeRequest {
  requestId, participantId | null, turnId,
  changes: [{ place, value, from? }],   // from: computer changes, when asked
  status: "waiting" | "claimed" | "changed" | "declined" | "failed"
        | "uncertain" | "replaced" | "cancelled",
  claim?: { claimId, deviceLabel },     // the app that pressed Change
  device?: { applied: place[], failed: [{ place, detail }] },  // its report
  detail?, createdAt, settledAt?, noted: boolean
}
```

Transitions, each from a server-internal command; the decider refuses any
other:

| Event                             | From → to                                                                                | Sent by                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `settings-change-requested`       | → waiting; the agent's waiting one → replaced                                            | the tool                                                                                                     |
| `settings-change-claimed`         | waiting → claimed, with the claim                                                        | the answer service                                                                                           |
| `settings-change-settled`         | waiting → declined, cancelled; claimed → changed, failed, uncertain (claimId must match) | the answer service; archive, move start and revert (cancelled, inside their own decisions); startup recovery |
| `settings-change-device-reported` | changed with device changes and no report yet → report recorded (first report wins)      | the answer service, from the claiming app                                                                    |
| `settings-change-notes-delivered` | settled → noted                                                                          | the provider command reactor                                                                                 |

There is no way back to waiting, so nothing can reopen a card the user
answered, or one on a thread put away.

Lifetime:

- Archive, the start of a move, and revert (for requests from reverted turns)
  settle waiting requests `cancelled` in the same decision. For a revert the
  checkpoint reactor names the turns it keeps (`keptTurnIds`, from the
  checkpoints and transcript cut it loaded; the engine's read model has no
  checkpoints after a restart), and any other turn's waiting card goes, also
  one asked for while the revert ran. A revert that removes nothing cancels none.
- A claimed request always finishes: its settle and its device report are
  allowed on an archived thread and through the move freeze (both join the
  frozen thread's allowed commands, as the server's own bookkeeping). A
  deleted thread takes its requests with it; a settle or report for a thread
  that's gone is dropped, since the settings change itself already happened.
- Forks and moved copies don't carry requests.
- State kept: every waiting and claimed request, plus the 20 most recently
  settled (noted or not). Agent retries don't depend on it (command
  receipts). An app's answer retries do: they are supported while the request
  is kept, and a request that has left gets `gone`, which changes nothing,
  since no app changes anything before its claim wins. An agent that never
  gets another turn loses notes beyond 20; that's acceptable.
- Shell summary: `pendingSettingsChange` (any waiting or claimed), feeding
  Pending Approval. Thread detail: the state, for the card. Both decode from
  the snapshot and fold the same events live through the shared reducer.

## Answering

**In the app, when the user presses Change:**

1. Check every device change with this app's own catalog (`checkEdits`). One
   this app doesn't know (an older app) disables Change with "Update
   Threadlines on this device to make these changes".
2. Send RPC `settings.respondAgentChange({ threadId, requestId, allow: true,
   claimId, deviceLabel })` to the thread's own computer:
   `readEnvironmentConnection(threadRef.environmentId)`, as the
   scheduled-request card does, never the primary-computer settings updater.
   `claimId` is made once per request and kept, with the request's device
   changes, in memory for the session, so pressing Change again after a lost
   answer reuses it. Nothing on the device changes yet.
3. The app makes its device changes when its claim has won, learned either
   way: the answer says `changed` or `failed` for its `claimId`, or the
   thread's live state shows the request settled with its `claimId` (the
   answer was lost). It makes them once per claim (an in-memory "done" mark),
   each store awaited (one client-settings patch through a new awaited
   persist, then the theme store's write), and reports per setting which
   applied and which failed with `settings.reportDeviceChanges`. A report
   that doesn't arrive leaves the note saying the device changes weren't
   confirmed. If the app closes before its claim settles, it makes nothing,
   which the note says the same way.
4. `already_answered`, `cancelled` or `gone`: nothing changed on this device,
   and the toast says who answered or why.

**Not now** sends `allow: false` and changes nothing anywhere.

Device changes follow the claim even when the computer part failed: the
user saw them as they are, and accepted them. Client-settings saves run one
after another (every writer shares the chain in `useSettings.ts`), so an older
snapshot never lands over a newer one. Every write changes memory at once, so
the last one made stands; a failed agent write puts back only the settings no
later write has set, to what was last stored.

**On the thread's computer**, one answer at a time (a semaphore in the answer
service; answers are rare), each run to its end in the service's own scope, so
an app that disconnects after its claim landed can't leave a card stuck:

1. Read the request. Settled with the same `claimId`: return its stored
   result (a retry). Settled otherwise, or claimed by another claim:
   `already_answered`. Gone: `gone`.
2. Not now: settle `declined`.
3. Change: claim it (recording `claimId` and `deviceLabel`). Then
   one write through a new `ServerSettingsService.updateSettingsChecked`:
   inside the write lock it compares every computer change's `from` with the
   stored value and, if any differs, writes nothing and reports `stale` with
   the current values. Otherwise it writes `composePatch` and reports
   `written` the moment the file lands, before the steps after it (filling in
   provider secrets) that can still fail.
4. Settle: `written` → `changed`; `stale` → `failed` with the setting that
   moved and its value now; an error before the file landed → `failed` with
   the reason. A request with only device changes settles `changed` at once.
5. A device report: recorded only from the claim's own `claimId`, once.
6. Startup recovery, before any answer is taken: a request still `claimed`
   (the server stopped mid-answer) is settled from the stored values, read
   without secrets (`readStored`): every target in place → `changed`; none →
   `failed` ("the settings asked for aren't in place"); a mix, or a read that
   fails → `uncertain`, with the current values. The note words it as the
   state now, not as what this answer did.

## The note

`ProviderCommandReactor` adds a settings context next to the child-thread and
scheduled-task ones, for the participant that asked, and dispatches
`notes-delivered` once the provider takes the turn. Examples:

- "The user changed the settings you asked for: Stream replies is now Off on
  this computer; Theme is now Light on their iPhone."
- "The user said no to your settings change (Theme to Light). Don't ask again
  unless they bring it up."
- "The user accepted your settings change. Theme is now Light on their
  iPhone. Stream replies wasn't changed: it was set to Off since you asked."
- "Your settings change was cancelled: the thread was archived."
- "Threadlines stopped while making your settings change. Now: Stream
  replies is Off (as asked), Fetch interval is 120 seconds (asked: 60)."

## Providers

The tool rides the room endpoint, so it reaches every provider that gets it
(Claude, Codex, OpenCode, Pi, Muse, ACP and community agents). The guide
instruction sentence gains one clause: "To change a setting the user asks
for, call `settings_change`; they accept on a card." ACP agents learn it from
the description.

## Hit every surface

- Entry points: the card is the only way in; the guide links each row so the
  user can also change it by hand (except another computer's rows, which say
  where they are).
- Clients: web and desktop share the card; phones apply device changes to
  the phone and computer changes to the thread's computer.
- Contracts: request state, events, commands, shell and detail fields, the
  answer RPC, the tool's schema.
- Reverse states: Not now, cancelled on archive, move start and revert,
  replaced; the agent hears every ending, and the user can change any row
  back by hand or ask again.

## Testing

- shared: `checkEdits` (unknown, not editable, widening, duplicate, bad value,
  fractional number); `composePatch` keeps both writing-style leaves; leaves
  and round trips per edit; the reducer (every transition, refused ones, no
  way back to waiting, pruning keeps waiting, claimed and the latest 20).
- server: the tool at its boundary (asked_user with from values; unchanged;
  refused with a link; a retry returns the same request; a new request
  replaces a waiting one but not a claimed one; no live turn refused);
  decider (one claim under two answers; Not now loses to a claim; archive and
  move start cancel waiting; settle passes the move freeze); answer service
  (Change writes one patch and settles changed; a stale `from` writes
  nothing and settles failed; a write that fails after the file landed
  settles changed; same-claim retry returns the stored result; startup
  recovery for all, none and a mix); `updateSettingsChecked`; reactor note
  for the asking participant only.
- web: browser test for the card (lines, where each lands, live device
  "from", Change calls the RPC and makes the device changes only once its
  claim wins, from the answer or from live state after a lost answer, then
  reports them; an already-answered reply changes nothing; Not now; an
  unknown device place disables Change); the sidebar pill from a snapshot and
  from a live event.
- Live: a real agent on a throwaway home ("switch me to light theme and turn
  off streaming"), accepted, declined, and answered from two windows at once.
