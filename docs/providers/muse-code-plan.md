# Muse Code provider: build plan

Will approved (Oct 15 2026): a native Muse Code provider, a data-sharing switch, and a
read-only plan mode. Research notes: T3 Code PR #17082 (their Muse driver), Meta's SDK repo
(`meta-models/muse-code-sdk`, schema + 51 golden transcripts), and live probes against Muse
Code 1.4.9 in a throwaway home (`--provider echo` runs real turns with no account).

## Route

A native driver (`muse`) over `muse serve`, the Muse Session Protocol (MSP): JSON-RPC 2.0,
one JSON message per line on the child's stdin/stdout, stable schema `version: 1`.

- Not ACP: Muse is not in the ACP registry, the adapters are third-party, and our ACP core
  would lose steering, compaction, subagents, approvals scopes and the plan meter.
- Protocol client: the official `@muse-code/sdk` (MIT, ESM, zero dependencies), pinned to an
  exact version, used only for its `Connection` (NDJSON framing, request correlation,
  idempotent `commandId`s with retry, typed `MspError`). We spawn the process ourselves and
  hand its stdio to `Connection` as a `DuplexTransport`, so Windows `.cmd` launching,
  hidden consoles and process-tree kills use our shared helpers. Not the `MuseClient`
  facade: it drops notifications without a `sessionId` (`usage/changed`, `account/changed`)
  and cannot pass session MCP servers. Bundled (`bundledPackagePrefixes`), not a runtime dep.
- Wire payloads we act on are decoded with Effect Schemas in `provider/muse/MuseProtocol.ts`
  (open enums stay strings; unknown fields ignored).

## Process model

One `muse serve` host per active thread (`MuseHost`), started on the thread's first start or
resume, stopped with the session.

- Muse takes one client command at a time and slows during long turns (sdk #81); a shared
  host would let one thread's long turn delay another thread's approvals.
- A host holds the lease on every session it loaded until it exits; a second host gets
  `sessionInUse` (-32021, verified). Resume after a crash works once the old host is gone.
- Permission profile and sandbox flags are fixed per host: a same-host `session/resume`
  with a new `permissionProfile` keeps the old one (verified). A runtime-mode or plan-mode
  change between turns closes the host and resumes the session on a new one with the new
  profile (verified: the new profile applies). Never mid-turn.
- Status checks and title generation use short-lived read-only hosts
  (`--disable-shell --disable-write --no-session-log`), never a thread's host.

Environment for every host: the instance environment merged as usual, then
`MUSE_NO_AUTO_UPDATE=1` (the launcher must not swap the binary under a live host) and an
inherited `META_API_KEY` removed (case-insensitive). A key set explicitly on the instance's
own environment is kept: that is a deliberate per-use choice, and the card says so.

## Launch flags and session settings

| Threadlines                       | `muse serve` flags                                                                                                 | `permissionProfile`                                        | `approvalMode`                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Supervised (`approval-required`)  | `--trust-workspace`                                                                                                | `:ask-me`                                                  | `promptUnmatched`                                                                     |
| Auto-accept edits                 | `--trust-workspace`                                                                                                | `:ask-me`                                                  | `promptUnmatched`, the adapter approves file writes inside the workspace roots itself |
| Auto (`auto`)                     | `--trust-workspace`                                                                                                | `:auto-review` (Muse's own reviewer; falls back to asking) | `promptUnmatched`                                                                     |
| Full access                       | `--trust-workspace --disable-sandbox`                                                                              | `:unrestricted`                                            | `allowAll`                                                                            |
| Plan mode (any access)            | `--trust-workspace --disable-write` (+ `--disable-shell` when the host reports `sandboxAvailability: unavailable`) | `:read-only`                                               | `promptUnmatched`                                                                     |
| Side answer / review (`lockdown`) | `--disable-shell --disable-write --no-session-log --disable-request-user-input`                                    | `:read-only`                                               | `denyUnmatched`                                                                       |

Every host also gets `--contributor-mode on|off` from the data-sharing switch (below).
The profile is always passed explicitly: 1.4.6+ defaults new served sessions to Auto-review.

`lockdown` additionally promises "nothing from the user's or project's settings". Muse
loads the user's `settings.json` (hooks, plugins, MCP servers) in every host. Unless a probe
during the build shows a way to switch those off per host (`-c` overrides), the driver
refuses `lockdown`, the way OpenCode does, and Muse is not offered for side answers.

## Data sharing (contributor mode)

Muse subscribers default to Contributor mode: Meta may train on the content (Model API
Terms §6.1), and §6.2 says code that must stay confidential must not be sent there. In
exchange the plan's allowance lasts longer. `muse serve` 1.4.6 ignored the saved setting
(sdk #102), so the host flag is the only reliable lever.

- One source of truth: Muse's own `settings.json` key `contributor_mode_enabled`
  (`$XDG_CONFIG_HOME/muse/settings.json`, else `~/.config/muse/settings.json`; absent means
  on for subscribers). Every host launch reads it and passes `--contributor-mode on|off`.
- The Muse card in Settings shows a switch for it, and the setup screen shows it once before
  the first chat. Flipping it writes that key in Muse's file (read, change one key, write
  atomically; an unreadable file is never overwritten, the card shows the error). The
  terminal `muse` and Threadlines then agree.
- Copy states the trade in one sentence each way, no warning banner.

## Event mapping (MSP → `ProviderRuntimeEvent`)

Every notification carries `sessionId`; the host routes by it. Items carry a `revision`
(apply only if higher). Deltas append to `text`, `output`, or `summary.N`.

| MSP                                                                                                | Threadlines                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/started` for our `commandId`                                                                 | `turn.started` (turn id = Muse turn id = our `commandId`)                                                                                                                                                   |
| `turn/started` for an id we did not send                                                           | a provider-started turn (workflow reports), like Claude's                                                                                                                                                   |
| `turn/completed`                                                                                   | `turn.completed`: completed / failed (`error.kind`, `authRequired` → sign-in message, `quota` → usage-limit with reset time) / interrupted when we asked to stop                                            |
| `agentMessage` item + `text` deltas                                                                | `assistant_message` item + `content.delta`; `messagePhase: commentary` stays a normal message                                                                                                               |
| `reasoning` + `summary.N` deltas                                                                   | `reasoning` item + `reasoning_summary_text` deltas                                                                                                                                                          |
| `toolCall` (shell-like) / `userShell`                                                              | `command_execution` + `command_output` deltas, exit code                                                                                                                                                    |
| `toolCall` with `patchRef`                                                                         | `file_change`: the structured patch read once with `item/readOutput` after the item completes, paths made relative to the workspace root; exact per-edit diff evidence (`PER_ITEM_DIFF_EVIDENCE_PROVIDERS`) |
| `toolCall` web search / fetch, MCP tools, other                                                    | `web_search`, `mcp_tool_call`, `dynamic_tool_call`                                                                                                                                                          |
| `subagent` items                                                                                   | Codex-style collab item + `subagent.metadata.updated` (child session id as `providerThreadId`)                                                                                                              |
| `workflow` items                                                                                   | a tool row; each child as a subagent row; background `task.started/completed`                                                                                                                               |
| `compaction`                                                                                       | `context_compaction` item, `thread.state.changed: compacted`                                                                                                                                                |
| `reminderChild`, `hookRun`, `userMessage`                                                          | hidden                                                                                                                                                                                                      |
| `approval/requested` / `updated` / `resolved` (+ server request `approval/request`, answered `{}`) | `request.opened` / `request.resolved`; decisions go out as `approval/decide` with the offered `choiceId` and `currentRequirementId`                                                                         |
| `userInput/requested` / `settled`                                                                  | `user-input.requested` / `user-input.resolved`; answers via `userInput/answer`, dismiss via `userInput/cancel`                                                                                              |
| `session/todoListChanged`                                                                          | `turn.plan.updated`                                                                                                                                                                                         |
| `session/tokenUsage`, `session/contextUsage`                                                       | `thread.token-usage.updated`                                                                                                                                                                                |
| `usage/changed`, `usage/read`                                                                      | the provider snapshot's `accountUsage` (5-hour window + weekly), source `muse-subscription-usage`                                                                                                           |
| `turn/retryScheduled`, `turn/modelRetryScheduled`                                                  | `runtime.warning` (`api-retry`)                                                                                                                                                                             |
| `view/gap`                                                                                         | splice-fill with `view/page` over `(after, next)`; if paging fails, the turn fails with a plain message, never hangs                                                                                        |
| `session/closed`, `session/viewHealthChanged`, host exit                                           | a running turn ends failed with the reason; the session exits (T3 bug #17804 hangs here)                                                                                                                    |

Approval choices: `approved` → accept, `approvedForSession` / session-scoped amendments →
acceptForSession, `denied` → decline (shell approvals offer only `abort`, which decline
falls back to), `abort` → cancel. The decision is recorded before `approval/decide` returns
(Muse can settle first). A subagent's approval (`subagentOrigin`) is shown on the parent
thread; in Full access the adapter approves it, since Muse does not give children the
parent's `allowAll`.

## Turns, resume, fork

- Turn ids are our `commandId`s (UUIDv7): `turn/start` with `commandId = turnId`,
  `ifBusy: "queue"`, `workspaceRoots: [cwd]` (Windows: the `\\?\` realpath),
  `reasoningEffort` from the model selection on every turn, including provider-started
  continuations.
- Threadlines instructions (browser panel, pages, file links, managed worktree) ride a
  leading text part: MSP has no system-context input.
- Images: `image` parts (base64 + mediaType). Other files: `@path` text.
- Steering: `turn/steer` with `expectedTurnId`. Stop: `turn/interrupt`, then wait for
  `turn/completed` (bounded; past it the host is recycled and the turn ends interrupted).
- Resume cursor `{schemaVersion: 1, sessionId}`. Resume reads `lastTurn` and
  `pendingRequests` (pending approvals are re-issued as server requests right after the
  response) before reporting ready. `sessionNotFound` falls back to a fresh session with the
  context seed, unless `resumePolicy: "required"`.
- Fork: `session/fork` only from the latest completed turn (older cut points fail,
  sdk #97); anything else uses the context seed. `session/fork` takes no `config` or
  `permissionProfile`, so the copy is reopened at once with `session/resume` on a fresh host,
  which carries both. Rollback: not native (`none`).
- Compaction: `session/compact` (`noop` → a plain "nothing to compact" notice).

## Plan mode

`interactionMode: "plan"` runs the turn on a plan host (`:read-only`, `--disable-write`).
The turn's input starts with a short plan-mode instruction (explore, do not change
anything, answer with the plan in Markdown). When the turn completes, the final
`agentMessage` (phase `finalAnswer`) becomes `turn.proposed.completed`, so the chat shows
the plan card with "Implement". Leaving plan mode moves the session back to a normal host.
`muse` joins `PLAN_MODE_DRIVERS`.

## Status, sign-in, install, update

- Status check: `muse --version` (minimum 1.4.8: profile on resume, narration items,
  sandbox report), then a read-only host for `initialize` (with `experimentalApi`),
  `model/list`, `account/read`, `usage/read`.
  - `account/read` → `accountLogin`: signed in (label shown); `apiKey` / `envKey`: signed
    in, billed per use (the card says so, children refuse it like other per-use
    instances); `loggedOut`: signed out. Experimental: if refused, auth is `unknown` and a
    turn's `authRequired` error says to sign in.
  - Empty `model/list` while signed out is expected; signed in, it lists Meta's models with
    their reasoning tiers (`variants`, `defaultReasoningEffort`).
- Sign in (one click): in-app device code via experimental `account/loginStart
{type:"deviceCode"}` on a short-lived host (shows the code, opens Meta's page, waits for
  `account/loginCompleted`). Fallback: `muse login` in the sign-in terminal. No sign-out:
  Muse's login is shared with the user's terminal (Will's rule for shared logins).
- Install (one click): Meta's installer, never a bundled binary (terms §10):
  `curl -fsSL https://dev.meta.ai/install.sh | bash` on macOS/Linux,
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://dev.meta.ai/install.ps1 | iex"`
  on Windows (Windows PowerShell 5.1: the script breaks under PowerShell 7, sdk #68). The
  binary is looked up on PATH, then `~/.local/bin` / `%LOCALAPPDATA%\Programs\muse`, so it
  works without a restart.
- Update (one click): the launcher's own synchronous update (`MUSE_SYNC_UPDATE=1
MUSE_UPDATE_INTERVAL_SECONDS=0 MUSE_NO_AUTO_UPDATE=0 <launcher> --version`); Homebrew
  cask installs: `brew upgrade --cask muse-code`; Windows: re-run the installer. Latest
  version: `https://api.meta.ai/muse-code/channels/<channel>`. Live hosts are recycled
  between turns after an update.
- Extra accounts: not offered. Muse has no config-dir variable and macOS keeps the login
  in the Keychain, so a second account cannot be isolated safely.

## Surfaces

Contracts (`MuseSettings`, model defaults, display name, raw source `muse.msp`,
`accountUsage` source), shared (login command, reconnect hint), server (`provider/muse/*`,
`Layers/MuseAdapter.ts`, `Layers/MuseProvider.ts`, `Drivers/MuseDriver.ts`,
`textGeneration/MuseTextGeneration.ts`, registry, hydration default, per-driver lists:
plan mode, diff evidence, authoritative model list, diagnostics regex, analytics, preview
instructions, invites), web (driver meta + settings schema, icon, picker options,
maintained kinds, card sign-in, data-sharing switch on the card and in setup), docs
(`docs/providers/muse.md`, provider lists in AGENTS.md and community-agents.md).

## Tests

- Adapter: a scripted MSP peer (in-memory `DuplexTransport`) replaying frames recorded
  from Muse 1.4.9 plus Meta's golden transcripts where they fit: turn, steer, interrupt,
  approval round-trip and decline→abort, question answer/cancel, resume with pending
  approval, gap splice, host death mid-turn, quota error, plan mode → proposed plan.
- Pure units: launch flags per mode, choice mapping, version compare, settings-file write.
- Live (`THREADLINES_MUSE_BIN`, skipped otherwise): `--provider echo` turns, resume on a
  new host, profile change, plus a local Responses-API stub
  (`-c endpoint_transport.base_url=…`, dummy key) for tool calls, approvals and patches.
- Gates: fmt, lint, typecheck (+ per-package `tsc`), server/web/shared/contracts tests,
  browser suite.

## Review fixes (Sol, Oct 15, all accepted)

1. **Contributor changes reach live hosts.** Every host records the contributor value it was
   launched with. Changing the switch marks every Muse host whose value differs as stale;
   a stale host is recycled before its next turn (the same safe boundary as a mode switch,
   below). Work already running finishes under the old value; the switch says the change
   applies to new messages.
2. **Stop stops everything.** Stop = `turn/interrupt` for the turn, `turn/unqueue` for any
   of our queued submissions, `subagent/stop` for running subagents, `workflow/cancel` for
   running workflows and `task/stopAll` for background commands, then wait (bounded) for the
   terminal. Reports from work the user stopped do not open a provider-started turn.
   `turn/unqueued` is a terminal for a queued submission (it never gets `turn/completed`).
3. **Safe recycle boundary.** One serialized lifecycle per thread host with a generation
   counter: start, resume, recycle, stop and send all run under it; a stale generation's
   events and exits are ignored, and an intentional recycle exit is never reported as a
   failure. A recycle happens only when there is no running turn, no queued submission, no
   pending approval or question, and no running workflow, subagent or background command.
   Otherwise the send that needs a different mode fails fast with a plain message ("Muse is
   still finishing background work from an earlier message. Stop it or wait, then send
   again."). The old process must have exited before the new host resumes; a
   `sessionInUse` answer is retried with backoff for a bounded time.
4. **Approval mode is enforced after every start and resume**: `session/setApprovalMode`
   with the table's mode, then the effective `approvalMode` and `permissionState` read back
   from the session (resume result / `session/read`) must match before ready.
5. **Pending requests from both channels.** `approval/request` and `userInput/request`
   server requests carry the full payload (on resume they are the only source); they feed
   the same deduplicated pending map as `approval/requested` / `userInput/requested`.
   Multi-stage approvals: `approval/decide` may answer `terminal: false`; the next stage
   arrives as `approval/updated` / a re-issued `approval/request` with a new
   `currentRequirementId`. Each stage is its own Threadlines request (the previous one
   resolves when its stage is decided).
6. **API keys need an explicit opt-in.** A Muse instance setting "Allow API key billing"
   (off by default). When `account/read` reports `apiKey` (saved key) or `envKey` (an
   instance-level `META_API_KEY`), the snapshot says it is billed per use
   (`auth.type: "apiKey"`, so `inviteBilling` treats it as per use), and with the setting
   off every model-calling host (chat and title generation) refuses to start, saying how to
   allow it or sign in with a Meta account instead.
7. **Host-level notifications** (`usage/changed`, `account/changed`,
   `account/loginCompleted`, `session/listChanged`) are dispatched before session routing.
8. **Patches are read to the end**: `item/readOutput` pages until `eof`, advancing by the
   returned `offsetBytes + byteLen`; `availability` other than `available` falls back to the
   tool args. Reads are deduplicated per item and finished before the turn settles. Reads
   never run while an approval for the same turn is pending (sdk #81 ordering).
9. **Resume checks view health**: `history.noneReason: "projectionUnavailable"` (or
   `projectionReadLimit`) is not a healthy resume; the host is recycled once, then the
   thread falls back to a fresh session with the context seed.
10. **Ephemeral hosts take no profile** (`--no-session-log` refuses `permissionProfile`,
    verified on 1.4.9). Status checks and title generation run ephemeral with
    `--disable-shell --disable-write` and `approvalMode: "denyUnmatched"`, so nothing they
    start can act; they never land in the user's Muse session list.
11. **Quota** is detected by `error.quota` being present (`resetsAtMs`), not by a kind name.
12. **Settings writes are serialized** through one writer per file, re-read right before
    the write and refused if the file changed since it was read (the switch then reloads);
    the file is watched so a change made in terminal Muse updates the switch.

Extra gates from the review:

- Auto-accept edits approves only `subject.kind: "fileAccess"` with `access: "write"`,
  never `protectedWrite`, only a `once`-scoped approve choice, and only when the
  canonical (realpath'd) target sits inside a workspace root (no sibling-prefix match,
  symlinks resolved). Everything else asks.
- Plan mode never auto-approves anything, including subagent approvals under Full access.
  Plan hosts add `--disable-shell` unless the host reported `sandboxAvailability:
"available"` (absent or unknown counts as unavailable).
- Gap recovery applies paged durable events through the same idempotent handler (items
  replace only at a higher `revision`; terminals deduplicate by turn id), so overlap with
  live events is harmless. A page that fails stops the turn's work (`turn/interrupt`) before
  the turn is reported failed.

## Known limits (stated in docs/providers/muse.md)

Native rollback; forks from older turns; extra accounts; side answers (unless the
lockdown probe passes); child transcripts for inline subagents (Muse 1.4.x answers
`sessionNotFound` for them); Windows untested by us.

## As built (Oct 15 2026)

- Sign-in is `muse login` in the sign-in terminal, like Codex. Muse's in-app device-code sign-in
  (`account/loginStart`) is still on its experimental surface, so it is not used. `account/read`
  (experimental, read-only) drives the signed-in state and the API-key check. A sign-in it cannot
  read (no experimental API, a failed or unknown `account/read`) counts as a possible key: with
  "Allow API key billing" off, Muse does not run and the status says why (`museBillingRefusal`,
  shared by chats, text generation and the status check).
- Side answers (`lockdown`) are refused: no `-c` override switches off the user's hooks, plugins
  and MCP servers per host.
- Plan mode starts on the thread's normal host and moves to a plan host on the first plan turn
  (`ProviderSessionStartInput` carries no interaction mode).
- Live hosts keep the binary they started with after an update (`MUSE_NO_AUTO_UPDATE=1`); the next
  host a thread starts uses the new one.
- Subagents and workflows still running when a turn ends become background tasks
  (`task.started`/`task.completed`), and count toward the recycle boundary.
- Live tests: `THREADLINES_MUSE_BIN=<muse> vp run '@threadlines/server#test' MuseLive` (Muse's
  offline `echo` provider; isolated home). Verified on 1.4.9: a turn, resume on a new host with
  another profile, and a plan turn proposing its answer.
- Verified live on Oct 15 with a signed-in Everyday plan (Muse 1.4.9, Muse Spark 1.3): one-click
  install, sign-in, the setup screen's data-sharing choice, streaming, reads, commands, Supervised
  approvals (multi-step), edits with exact line counts, plan mode and Implement, a subagent, Stop
  (the running command ends), questions, steering, Threadlines' MCP tools, usage meters, title
  generation, and resume after a server restart. Not verified live: workflows, quota errors,
  compaction, images, Windows.

## Diff review fixes (Sol, Oct 15)

- The driver's settings refresh rebuilt the host environment by merging the shell's, which put
  an inherited `META_API_KEY` back; `refreshMuseHostEnvironment` rebuilds it in place.
- The API-key check failed open when `account/read` was unavailable or unreadable; it now fails
  closed (above).
- Host teardown awaited `Connection.close()` (which settles only when the host's output ends)
  before its grace timer, so a host ignoring EOF hung teardown; one timer now bounds both.
- A session restart (an access change) closed the host under background work; it is refused the
  way a switch between turns is. The reactor used to only log a failed access-change restart; it
  now posts a `provider.runtime-mode.failed` activity, and refusals (`ProviderAdapterValidationError`)
  show their `issue` rather than a printed cause, for every provider.
- Stop's fallback ended the turn before closing the stuck host, so a send waiting for the turn
  started on the host about to close. The host now closes first, and work that lived on it ends
  as stopped.
- A `turn/started` replayed after a gap could reopen a finished turn. Each start Muse reports
  now counts once per session (`startedTurnIds`); a first start that arrives after a timed-out
  `turn/start` still shows as a Muse turn.
- The settings writer checks the file is unchanged just before replacing it and starts over if
  Muse saved meanwhile (Muse shares no lock, so a sub-millisecond window remains).
- Forks are reopened with Threadlines' tools and access level (above).

## Live-run fixes (Oct 15, signed-in plan)

- `model/list` sends the id as `displayLabel`: an id-shaped label reads as words (`museModelName`).
- A finished `bash` call's `visibleOutput` is a JSON run record (`output`, `exit_code`,
  `terminal_status`): the row shows its output, and a non-zero exit fails the call
  (`museShellExitCode`, `museToolFailed`).
- A compound command is approved part by part (`subject.stages`): each request's detail names its
  part ("Step 2 of 2: …"), and approvals carry the call's `itemId`.
- Approval requests and resolutions were drawn as extra "Ran a command" steps for every provider:
  the work log now leaves them out before steps merge (a file-change approval could otherwise merge
  into its edit's row), so the approval card and the call's own row tell it (web, all providers).
- `:ask-me` never asks before edits inside the workspace (Muse's sandbox contains them): the access
  menu says so for Muse, and the guide's table matches.
- `usage/changed`'s `tier` is an internal number: it is not shown as the plan name.
- `read_skill` is titled like Claude's skill tool, so the chat names the skill.
- A provider whose edits carry their own line counts (Muse, OpenCode, Antigravity) had the turn's
  checkpoint file list summed on top (+8 for +4): the list is trimmed to the files the edits did not
  count, so a file only the checkpoint knows (deleted by a command) stays (web, before steps merge,
  since the list can land between an edit's start and end).
- A subagent row opened under its short `subagentId` before Muse sent the child session id, then
  continued under the child id: two agents, one forever running. The row now waits for the child
  session id (or the end).

Follow-ups, not built: `turn/foregroundCompleted` holds the turn open (Muse's reminder checks, up
to ~40 s) while the chat says "working"; Muse sessions are not read into the Usage page's token
breakdown; the shared "tests passed" wording reads a `cmd; echo` exit code of 0 as a pass.
