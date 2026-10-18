# Pi as a built-in agent: build plan

Status: reviewed twice by GPT-6.1 Sol (21 findings, all taken; see the end). All four decisions made by Will on Oct 18. Owner: Opus 5.5.

**In plain words.** Pi becomes a built-in agent next to Codex and Claude.

- Threadlines installs, updates and signs in to Pi with one click.
- It talks to Pi directly, through Pi's own control channel.
- A small Threadlines add-on runs inside Pi. It asks before Pi runs commands, keeps Pi read-only in plan mode, and gives Pi our browser panel, rooms, pages and run-in-terminal tools.
- Revert and fork also rewind what Pi remembers.
- People already using the community version get a "Pi is now built in" button.
- It's about the size of the Muse Code work. Most of the effort goes into tests that run the real Pi.
- Will's four decisions are at the end.

## Goal

Make Pi a first-class Threadlines agent, on the level of Codex, Claude, OpenCode and Muse Code. A Pi user gets:

- one-click install, update and sign-in;
- the model and reasoning pickers;
- steering, Stop, approvals and plan mode;
- revert that also rewinds Pi's memory, and fork;
- the context meter, compaction, skills and slash commands;
- usage, titles and commit messages;
- Threadlines' own tools: browser panel, rooms, agent pages, run-in-terminal.

Why native, not the `pi-acp` add-on:

- `pi-acp` can't take our tools (it says `http:false`).
- It never asks for approval.
- It can't rewind or fork.
- It's a third-party 0.0.x project.

Pi's own RPC mode (`pi --mode rpc`) is documented for exactly this and covers every feature above. T3 Code made the same call (PR #7211).

## How it works

One `pi --mode rpc` process per thread, like Muse Code's one host per thread. Threadlines writes JSON commands to its stdin and reads JSON events from stdout. A small Threadlines extension, loaded with `--extension`, runs inside Pi. It asks for approvals, enforces plan mode, and gives Pi our tools.

```
Threadlines server
  PiAdapter ──stdin JSONL──▶ pi --mode rpc --session <file> --extension <threadlines-ext>
            ◀─stdout JSONL──   ├─ events: message_update, tool_execution_*, agent_settled …
                               ├─ extension_ui_request (approvals, questions)
                               └─ threadlines extension ──HTTP MCP──▶ browser / rooms / pages / commands
```

**Minimum Pi version: 1.3.0**, the version we build and test against. Raising the floor later needs only a re-run of the integration suite. Older installs get "Update Pi" with the one-click update.

## Design decisions

### Process and protocol

**Template.** Muse Code's process handling (`muse/MuseHost.ts` `startMuseHost`):

- spawn through `planCliSpawn` (handles a Windows `.cmd` shim) with `hideWindowsConsole`;
- close stdin when the scope closes;
- keep a stderr tail.

Pi's wire is not JSON-RPC, so the reader is ours:

- commands are `{type, id}`;
- replies are `{type:"response", id, command, success, data|error}`;
- events carry no id.

**Framing.**

- Split on `\n` only and strip a trailing `\r`.
- Never Node `readline`, which also splits on U+2028/U+2029 inside JSON strings.
- Read stdout continuously (Pi honors backpressure).
- Stderr goes to logs only.

**Requests.**

- Every command carries an `id`. Responses are matched by id, never by order.
- State queries get short deadlines (15 s; 60 s for session changes).
- Commands that run a model have their own cancellable lifetime with no short deadline, and a late response is still handled. That covers `compact`, `prompt` acks (an extension command can hold one on a dialog) and text generation.

**Spawn.**

- Own process group.
- Stop = SIGTERM to the group, then SIGKILL after 1 s; `taskkill /T /F` on Windows.
- We only ever kill the PID we spawned.

**Resume.**

- Spawn with `--session <sessionFile>`.
- Never `switch_session`: it re-runs extension factories and leaves their context stale, which broke T3 Code's approval gate after a restart (their #12467).

**Checkout moves.** Pi runs a resumed session in the folder saved in the session file, not the spawn folder (Pi 1.3.0 `main.ts` creates the runtime with `sessionManager.getCwd()`). When a thread's folder differs from the session's saved folder (worktree switch, moved or deleted checkout):

1. Spawn with `--fork <sessionFile>` in the new folder. That writes a new session file whose header names the new folder.
2. Save the new `sessionFile` in the resume cursor before accepting the turn.

This works whether or not the old folder still exists.

### Who owns the session

- Sessions live in Pi's own folder (`~/.pi/agent/sessions`, or `PI_CODING_AGENT_DIR`), so usage scanning finds them where Pi puts them.
- A thread owns its session file while it runs. We don't advertise opening it in Pi's terminal app: Pi keeps the session tree in memory, so two writers would grow competing branches without seeing each other.
- If the session's leaf changed outside Threadlines when we resume, the thread notes it in its work log and continues. Saved revert positions stay valid because Pi only ever appends entries.

### Turns and positions

**Send.**

- `prompt {message, images, streamingBehavior:"steer"}` with an id. With that flag Pi starts a run when idle and queues the message when busy, atomically.
- Images go as `images`. Other files: the saved path is appended to the prompt.

**When a turn ends.** A turn ends only when Pi is truly idle. That means:

- the turn's `prompt` ack has arrived;
- no extension dialog it opened is still open;
- `get_state` says `!isStreaming && !isCompacting && pendingMessageCount == 0`.

We check on `agent_settled` and after every ack. If Pi is still busy, keep listening and check again on the next event or settle. Never stop waiting (T3 Code's turns hung open forever, their #16846).

- `disposition:"handled"` doesn't rule out work: an extension command can start a run before acking. So "handled" also goes through the idle check.
- A slash command still running its handler (say, waiting on an editor dialog) hasn't acked yet, so its turn stays open even if Pi reports idle.
- Our own control commands (the mode command below) never end a user's turn.

**Pi's own wake-ups.** An `agent_start` with no turn open (an extension woke Pi) becomes a turn Pi started itself. It takes the same path Grok's wake-ups use.

**Errors.**

- `message_end` with `stopReason:"error"` records the failure.
- `auto_retry_end success` clears it, and so does a compaction that will retry.

**Steering.** Steering also uses `prompt` with `streamingBehavior:"steer"`. A direct `steer` sent just as Pi goes idle stays queued forever.

**Stop.** In order, with a bounded wait at each step:

1. Cancel every open dialog by its request id (`extension_ui_response {cancelled:true}`) and close the matching Threadlines approval or question.
2. `clear_queue`.
3. `abort`.
4. Kill the process group, after saving the revert positions, if any of these is true:
   - `abort` doesn't return in time;
   - Pi is past `agent_settled` doing detached work;
   - the turn's prompt handler still hasn't acked after its dialogs were cancelled (a slash command can carry on and start work later; `abort` only stops agent runs).

Our approval dialog passes `ctx.signal`, so an abort also ends it inside Pi.

**Revert positions: turn markers in Pi's own tree.** Before each user turn, the adapter sends `/threadlines-turn <nonce> <turnId>`, and the Threadlines extension appends a custom entry (`threadlines-turn`) to Pi's session. Pi never sends custom entries to the model, keeps them in the session file, and copies them on `fork` and `clone` (all checked on 1.3.0). So a turn's boundary is read from Pi's own tree, by any process, at any time (`PiCursor.piTurnBoundaries`):
- A turn starts at its marker. Its first user message after the marker is where a fork cuts; later user messages in the same turn are steers.
- A turn that crashed half way still has its marker, so later turns stay exact. This replaced v2's per-turn leaf reads, which needed a fresh read before every prompt and lost precision after a crash.
- A turn Pi started itself has no marker; reverting to before it says Pi's memory wasn't rewound (`conversationRolledBack: false`). Nothing is guessed.
- The resume cursor holds only the session file and its folder.
- Startup checks that the extension's commands are registered (`get_commands`); without them a marker would reach the model as text, so the session refuses to start instead.

### Showing the work

- `message_update` text and thinking deltas stream into the reply and the reasoning row. `message_end` is the final word.
- `tool_execution_start/update/end` become tool rows, keyed by `toolCallId`:
  - `bash` shows as a command;
  - `edit`/`write` show as file changes;
  - our own tools reuse `threadlinesMcpTool` for friendly names;
  - other extension tools show by name.
- Pi fires `tool_execution_start` before the approval hook. So a tool waiting for approval shows "waiting for approval", not "running".
- `compaction_*`, `auto_retry_*` and extension `notify` become work-log lines. `queue_update` drives the queued-steer chip.
- Edit counts: if Pi's `edit`/`write` results carry exact line counts, `pi` joins `PER_ITEM_DIFF_EVIDENCE_PROVIDERS`.

### The Threadlines extension (runs inside Pi)

One TypeScript file, written into Threadlines' data folder:

- mode 0600;
- named by content hash, so two Threadlines versions never fight over one file;
- imports only from Pi's own packages.

It has three jobs.

**1. Approvals and plan mode, in `tool_call`.** Two independent policies are checked on every call, including nested calls (codemode, `ctx.executeTool`) and our own MCP tools:

| Policy            | Rule                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan mode         | Deny everything that can change things: `edit`, `write`, `bash`, `powershell`, write-capable MCP tools, and unknown extension tools. Allowed: reading tools, tool search, `codemode` (its nested calls are checked one by one), and our read-only tools. Applies in every access level, Full access included. |
| Full access       | no question                                                                                                                                                                                                                                                                                                   |
| Auto-accept edits | ask for everything except reading tools and `edit`/`write`                                                                                                                                                                                                                                                    |
| Approval required | ask for everything except reading tools (`read`, `grep`, `find`, `ls`, tool search, our read-only tools)                                                                                                                                                                                                      |
| Auto              | not offered (Pi has no classifier); `supportedRuntimeModes` leaves it out                                                                                                                                                                                                                                     |

- Questions go out as `ctx.ui.confirm(…, {signal: ctx.signal})` and arrive as `extension_ui_request`. The message carries the `toolCallId`, so the answer binds to the right tool row.
- "Allow for this session" is keyed by tool and arguments. It's dropped when the session changes (T3 Code's grants survived a switch, their #16854).
- The gate fails closed: a crashing hook blocks the tool.
- Mode changes (access level, plan mode) go live through an extension command (`/threadlines-mode …`), which never ends a turn. If integration tests show that isn't reliable, the fallback is a restart with `--session`.
- The plan instruction is added per turn as a `systemPromptOptions.sections` entry.

**2. Threadlines tools.** Threadlines has four tool servers (`McpHttpServer`): browser, rooms, pages and commands.

- The extension gets a list of the endpoints this session may use, with each server's name. That list comes from the same credential minting Muse Code uses (`McpSessionRegistry.credentialFor`).
- It connects to each with a small MCP client and registers every tool with `pi.registerTool` under `mcp__<server>__<tool>`, so each call routes back to the server that owns it.
- We chose our own bridge (about 250 lines, as T3 Code did) over Pi's `registerMcpServer`. The latter disappears if the user turns off Pi's built-in MCP, or has an `mcp.json` server with the same name.
- Core tools are exposed directly; the rest are deferred behind Pi's tool search when it's on. We never force-activate every tool on every turn (T3 Code's #19190).
- The bearer token arrives in the environment. The extension deletes it from `process.env` at load, so `bash` children and other extensions don't inherit it (T3 Code's #12031).

**3. Questions from any extension.** `select`, `input` and `editor` dialogs become Threadlines questions (options, free text, prefilled text). `pi-acp` cancels these today. Dialog timeouts become question expiry.

One gap is in Pi itself. In 1.3.0, RPC mode starts reading stdin only after extensions finish their `session_start` handlers. So a user extension that asks a question while Pi starts can never get an answer, and startup hangs.

- We offer Pi a fix (start reading stdin before binding extensions) as an upstream PR, opened only with Will's OK.
- Until it ships, startup has a timeout and a clear message: "A Pi extension asked a question while Pi was starting. Threadlines can't answer it yet. Turn that extension off for Threadlines, or update Pi."
- The integration suite has a case for it.

**Instructions.** Threadlines' standing instructions use the same builders every driver uses (browser panel, agent pages, run-in-terminal, file links). They go in with `--append-system-prompt`, never as a whole replacement system prompt (T3 Code's #18933 overwrote other extensions' prompt edits).

### Revert and fork

Pi's RPC `fork {entryId}` always cuts **before** the given user entry (Pi 1.3.0 `agent-session-runtime.ts`, `position` defaults to "before" and RPC doesn't expose "at"). Threadlines' boundaries map like this:

| Threadlines asks for                                                             | Pi does                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Revert to before turn N                                                          | `fork` at turn N's first user entry                                     |
| Fork including turn N (`lastTurnId`)                                             | `fork` at turn N+1's first user entry; if N is the latest turn, `clone` |
| Fork before turn N (`beforeTurnId`)                                              | `fork` at turn N's first user entry                                     |
| Full history                                                                     | `clone`                                                                 |
| A boundary that's unknown or unrepresentable (a wake-up turn with no user entry) | Threadlines' context-seed path, like a provider switch                  |

- `clone` copies Pi's current leaf. So it's used only when that leaf is the one we saved for the target turn. If the session grew outside Threadlines, the fork takes the context-seed path.
- After a fork, read `get_state.sessionFile`, save the new cursor, and respawn on it with `--session`.
- A thread fork into another folder spawns `pi --mode rpc --no-extensions --no-tools --fork <sourceFile>` in the new folder first. Pi forks fine without a usable model (checked on 1.3.0), and skipping add-ons avoids startup questions.
- Files come back through Threadlines' own checkpoints, as for every agent.

### Models and reasoning

- **Discovery:** a short-lived `pi --mode rpc --no-session` with the user's extensions loaded asks `get_state`, `get_available_models` and `get_commands` (15 s).
- **Model ids** are `provider/id`, split at the first `/`.
- **Picker:** grouped by Pi's provider (Anthropic, Google, OpenRouter …). A "Pi default" entry uses whatever the user set in Pi.
- **Reasoning picker:** Pi's levels (`off` to `max`), per model, from `reasoning` and `thinkingLevelMap`. The default is Pi's current level for that model.
- An empty discovery clears the cached list, so signing out removes stale models.

### Context, compaction, skills, usage

**Context meter.**

- Live: `message_update.usage.totalTokens` against the model's `contextWindow`.
- After each turn: `get_session_stats.contextUsage`. It's null right after a compaction; then use the compaction's estimate.

**Compact.** Threadlines' compact action sends `compact`, with a model-length lifetime (it returns the finished summary).

**Skills and slash commands.**

- Listed from `get_commands`: skills, prompt templates and extension commands.
- Pi's own terminal-app commands (`/login`, `/model` …) can't run over RPC and aren't shown.

**Usage page.** Pi joins it.

- An entry-level reader covers assistant messages, tool results, standalone usage entries, and compaction and branch summaries.
- Entries are de-duplicated across files by entry id, timestamp and model. Every revert and fork copies history into a new file, and summing files would count that spending again.
- Pi reports cost in USD.
- No plan meters: Pi has no subscription of its own.

**Not offered (same as Muse Code and OpenCode):**

- agent invites, room side answers, the plugins page, importing outside threads;
- reviews, goals, realtime voice, workflow runs;
- subagent cards: Pi has none; an extension that adds subagents shows as ordinary tools.

### Titles and commit messages

1. Spawn `pi --mode rpc --no-session --no-tools`.
2. `set_model`, then `prompt`, then wait for idle.
3. Read `get_last_assistant_text`.

User extensions stay on, so models that extensions add still work (T3 Code's `--no-extensions` broke them, their #19053). Our extension is not loaded. Titles use whatever model and sign-in the thread uses.

### Install and update

Built on `ManagedRuntimeStore`, which already handles Antigravity's runtime and our managed Node:

- versioned releases;
- staging and atomic activation;
- a lease per running process;
- pruning only versions nobody uses.

An update never touches files a running Pi has loaded, and a failed install leaves the active copy alone.

- **Install:** one click. `npm install --ignore-scripts @earendil-works/pi-coding-agent@<version>` into a new release, run with Threadlines' managed Node (24.21.0, meets Pi's 22.19 minimum).
- **One launch description:** Node path, script, prefix args, environment and lease, used for chat, discovery, text generation and the sign-in terminal alike, so the user needs no Node of their own.
- **The user's own `pi`** (npm, Pi's `install.sh`, Nix) is found through the usual known folders and used when it's 1.3.0 or newer.
- **Update:**
  - our copy: a new release, activated when complete; running threads keep their leased version until they restart;
  - the user's copy: `pi update` or npm, matching how it was installed; Nix gets "update with Nix";
  - the latest version comes from npm (`enrichProviderSnapshotWithVersionAdvisory`, as OpenCode).

### Sign-in and readiness

**Sign-in.**

- Pi signs in only inside its terminal app (`/login`). The Sign in button opens Threadlines' sign-in terminal running `pi`, using the same launch description, and tells the user to type `/login`. This is the terminal-first path OpenCode already uses (`signInStartsInTerminal`).
- After a one-click install, the sign-in re-resolves the binary (`ProviderAuthSessions`).

**API keys** need no terminal. The Pi card takes them as the instance's environment variables, and Pi's key names join the always-sensitive list (`serverSettings.ts`), as Grok's and Antigravity's did.

**Ready = discovery found at least one usable model.**

- Discovery loads the user's extensions, so providers that extensions add count.
- `pi auth check --no-refresh --json` adds detail for the providers it knows (never refreshing, so a probe can't race a token renewal). It's advisory: it reports extension providers as unknown.

**Extra accounts:** not offered. A second Pi account means a second `PI_CODING_AGENT_DIR`, which also splits the user's Pi settings, extensions, skills and sessions.

### Claude subscriptions through Pi

**Decided (Will, Oct 18): do what T3 Code does.** T3 Code has contacts at Anthropic; if it changes its approach, we change ours.

T3 Code runs Pi with whatever sign-in the user set up in Pi, and has no Anthropic-specific code: no block, no warning, no detection. Its docs tell users to run `pi`, then `/login`. We do the same:

- Pi keeps its own credentials. Threadlines never reads, stores or relays them.
- Threadlines has no Claude sign-in of its own for Pi. The Pi Sign in button opens Pi's terminal and says to type `/login`, as above.
- No Claude-specific notice or check.

Background, for when this is revisited:

- Pi's Claude Pro/Max sign-in presents itself as Claude Code, and Pi warns that it's billed as Anthropic "extra usage".
- Since April 2026, Anthropic bills third-party harnesses on a subscription per token from "extra usage".
- Anthropic's legal page forbids app makers from offering Claude.ai login in their own app, or collecting, storing or relaying Claude.ai tokens. We do neither.
- OpenCode, Crush and Roo Code removed their own Claude-subscription sign-in after Anthropic asked. JetBrains ThinkRail, which starts Pi's sign-in from its own screen, is debating removing the Claude option (its issue #437).
- ChatGPT through Pi is approved: OpenAI's "Sign in with ChatGPT" page lists Pi.

### Security

- Never pass `--approve`: it would run a repo's own Pi extensions without asking. A project's `.pi/extensions` load only if the user trusted that project in Pi.
- The approval gate is not a sandbox. Other extensions' commands and Pi's `!` shell run outside it. The docs say so.

### Moving `pi-acp` users over

Adding `pi-acp` to `ACP_REGISTRY_BUILT_IN_AGENT_IDS` hides it from the community list. Today that also silently stops its updates, because update checks read the same filtered list. We separate the two:

- The registry catalog keeps replaced agents internally. They're hidden from "add an agent" but still checked for updates while installed.
- A `builtInDriver` field on `ServerProviderCommunity` marks a community agent that has a built-in replacement (`pi-acp` → `pi`).
- Its row in Settings and setup says "Pi is now built in", with "Use the built-in Pi" (turns on Pi, installing it if needed) and Remove.
- The old agent keeps working, with updates, until the user removes it.
- Its threads move to built-in Pi the way any agent switch works, with a recap. Resuming the same Pi session file across drivers would need an exception to the rule that native resume stays within one driver, so we don't.

### Telemetry

- `pi` joins the readiness report (`READINESS_DRIVER_KEYS`), noted in `docs/telemetry.md`.
- The "Messages by agent" chart gets a Pi row.
- `provider/model` names already report correctly after PR #497.

## Work breakdown (one PR, built in this order)

1. **Contracts** (`packages/contracts`):
   - `PI_DRIVER_KIND`, display name, offline default model;
   - `PiSettings`: enabled, `binaryPath`, hidden `customModels`, launch args that refuse session and mode flags;
   - the `providers.pi` settings block and patch;
   - raw-source literals `pi.rpc.event` and `pi.rpc.extension_ui`;
   - `"pi"` in `UsageProviderKind`;
   - `builtInDriver` on `ServerProviderCommunity`.
2. **Protocol layer** (`provider/pi/`):
   - `PiRpc`: process and JSONL wire;
   - `PiProtocol`: schemas that ignore unknown fields;
   - `PiToolItems`;
   - `PiBinary` and `PiRuntime`: find, managed install via `ManagedRuntimeStore`, update, launch description;
   - `PiLaunch`: args and environment;
   - `PiExtensionSource`: the extension, written by content hash;
   - `PiCursor`: the versioned resume cursor and turn map.
3. **Adapter** (`Layers/PiAdapter.ts`, `Services/PiAdapter.ts`). It covers:
   - sessions and checkout moves; turns and events;
   - steering and Stop;
   - approvals, questions and plan mode;
   - revert and fork, compaction, the context meter;
   - MCP credentials for all four tool servers.

   It has a `startHost`-style seam for tests.

4. **Provider and driver** (`Layers/PiProvider.ts`, `Drivers/PiDriver.ts`, `builtInDrivers.ts`):
   - snapshot, discovery, readiness;
   - install, update and sign-in;
   - `textGeneration/PiTextGeneration.ts`;
   - the Usage page reader (`usage/`);
   - the process diagnostics pattern and the preview-panel instruction union.
5. **ACP registry and shared:**
   - `pi-acp` in the built-in list;
   - the catalog keeps replaced agents for updates;
   - `buildPiLoginCommand` and the reconnect command table.
6. **Web:**
   - `PiIcon`;
   - the driver lists (`MAINTAINED_PROVIDER_DRIVER_KINDS`, `PROVIDER_OPTIONS`, `PROVIDER_CLIENT_DEFINITIONS`, the icon map);
   - the settings card (terminal sign-in, API key names) and runtime-mode wording;
   - model picker grouping, reasoning levels;
   - Usage page colors and labels;
   - the "now built in" community row.
7. **Telemetry, docs, marketing:**
   - the readiness key, `docs/telemetry.md`, the PostHog chart;
   - `docs/providers/pi.md` (user guide) and `docs/providers/pi-plan.md` (this plan, with an "as built" section);
   - `community-agents.md` and the provider lines in `AGENTS.md`;
   - the marketing row already lists Pi (PR #501).

Rough size: like Muse Code (72 files, 8,752 lines), so about 8,000 to 10,000 lines over about 85 files.

## Testing

**Integration tests against real Pi, required in CI.**

- A pinned `@earendil-works/pi-coding-agent` 1.3.x as a test-only dev dependency of the server, so Dependabot proposes Pi bumps and CI re-tests them.
- Tests run real `pi --mode rpc` with our real extension against a local fake OpenAI-compatible model server. The environment is `PI_CODING_AGENT_DIR=<temp>`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`. No keys, no cost.
- They assert both directions: what we send, and what Pi and the extension do.
- Cases:
  - start, resume after a restart, checkout move (old folder present and deleted);
  - steer mid-turn;
  - Stop mid-tool, during an approval, during an editor dialog, and after settle;
  - approval allow, deny and allow-for-session;
  - plan mode blocking `edit`, `bash`, a nested codemode call and a write-capable MCP tool;
  - all four tool servers;
  - extension questions;
  - revert, including across an unknown boundary;
  - fork including the latest turn and including a middle turn;
  - compaction longer than 15 s;
  - model and reasoning switch;
  - an extension wake-up and a "handled" command that starts work;
  - usage across repeated revert and fork (totals unchanged);
  - Pi missing, Pi too old, signed out;
  - a turn that crashes before its capture, followed by a revert of the next turn;
  - a slash command waiting on an editor dialog when Stop is pressed;
  - an extension that asks a question during startup;
  - a thread fork for a user whose only models come from an extension;
  - a fork of the latest turn after the session grew outside Threadlines.

**Replay tests.** Adapter edge cases on raw recorded lines from those runs, for speed. They feed raw lines, never our own protocol code.

**Install tests.** A managed install and launch with no user Node on PATH, an update while a thread holds a lease, and a failed install leaving the active copy working. These run on macOS, Windows and Linux CI.

**Live runs.** An isolated Threadlines (temp data folder, never `~/.threadlines/userdata`) with a real account, for sign-in, real provider catalogs and the packaged desktop app.

**Gates.** `vp fmt`, `vp lint`, `vp run typecheck`, server and web unit tests, the web browser suite.

## Risks

- **Pi moves fast** (four releases in two weeks). Mitigations: a version floor, the pinned test dependency with Dependabot bumps, and schemas that ignore unknown fields.
- **Long tail.** T3 Code needed about 28 follow-up fixes in five weeks. Their bugs are listed above so we avoid them.
- **Extensions run arbitrary code** inside Pi, ours included. Mitigations: a content-hash file, mode 0600, the token removed from the environment, and a gate that fails closed.
- **Claude terms.** We follow T3 Code (decision 1) and revisit if it changes.

## Checked first: results (real Pi 1.3.0, Oct 18)

Run against a fake OpenAI-compatible model server in a temp `PI_CODING_AGENT_DIR`. Raw traffic is saved for fixtures.

| Question                                      | Answer                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--session <file>` keeps add-on hooks working | Yes. Same session file, hooks fire, approvals work after a restart. The add-on starts fresh on each launch, so the access level goes in at launch (environment) and through the live command.                                                                                |
| Moving a thread to another folder             | `--session` from another folder still runs in the session's saved folder. `--fork <file>` in the new folder runs there, with the old folder present or deleted. `--session` on a deleted folder exits 1 with a clear message.                                                |
| Live mode change through an add-on command    | Works between turns and mid-reply. Ack is `handled`, no run starts, nothing is queued.                                                                                                                                                                                       |
| Plan mode with code mode                      | Code mode's nested calls (`call_N/1`, with `parentToolCallId`) go through `tool_call` and are blocked. So plan mode allows `codemode` and blocks only the writes inside it. Nested calls send their own `tool_execution_*` events, which the adapter shows under the parent. |
| Stop with an approval open                    | Cancel the dialog, `clear_queue`, `abort`: abort answers in ~7 ms. `agent_settled {aborted:true}` arrives before the abort response, so the adapter listens before sending.                                                                                                  |
| Model list without credentials                | `get_available_models` lists only models with usable credentials (a keyless provider is left out). Pi starts in RPC mode with none at all. Ready = the list isn't empty.                                                                                                     |
| `pi auth check --json`                        | Needs `--provider`. One line: `{"status":"ready","provider":"fake","authType":"api_key"}` or `{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}` (`provider_not_found` for unknown names).                                                 |
| Fork when the session's model isn't available | Works, with or without `--no-extensions`. So the fork helper uses `--no-extensions --no-tools` (faster, and no startup questions). This corrects Sol's v2 finding 4.                                                                                                         |
| `handled` ack that started work               | The ack comes before `agent_start`, but `get_state` already says `isStreaming:true` (5 of 5). The idle check after every ack is reliable.                                                                                                                                    |
| Steer mid-reply                               | Ack `queued`, `queue_update`, then the steer is a user message in the next turn of the same run; one `agent_settled`.                                                                                                                                                        |
| A question asked by an add-on during startup  | Confirmed hang: Pi sends `extension_ui_request` but reads no answer until startup ends. Timeout plus message, as planned.                                                                                                                                                    |
| Line framing                                  | Effect's `splitLines` also splits on a bare `\r`, which Pi's spec doesn't. We write our own 20-line LF splitter.                                                                                                                                                             |
| `get_commands`                                | Also lists Pi's built-in terminal commands (`/llama`, `/mcp`, source `builtin:*`). These are hidden; user, project and package commands, skills and prompt templates are shown.                                                                                              |
| `compact` on a tiny session                   | Fails fast: "Nothing to compact (session too small)". Shown as the reason.                                                                                                                                                                                                   |

Still to check during the build: whether `pi "/login"` opens the login screen directly (needs a real terminal, checked in the live run).

## Decisions

1. **Claude subscriptions through Pi (Will, Oct 18): do what T3 Code does.** No Anthropic-specific code. If T3 Code changes its approach, we change ours.
2. **Live testing account (Will, Oct 18): his ChatGPT account.** Signed in through Pi's `openai-chatgpt` sign-in (OpenAI's official flow, which names itself Pi; not `openai-codex`, which borrows Codex's client id), inside a throwaway Pi folder (`PI_CODING_AGENT_DIR` in the temp folder), so it never touches his real Pi or Codex setup. That login is its own token, separate from Codex's (unverified that a second login leaves the Codex one alone; checked on the first run).
3. **Marketing site (Will, Oct 18): Pi and Muse Code are listed.** Done in PR #501 (the row's label moved to its own line so all nine fit).
4. **Name and icon (Will, Oct 18): "Pi" with the one-color mark from Pi's press kit (pi.dev/press-kit, MIT), option C.** Used on the site (PR #501) and in the app, so Pi's icon matches the one-color marks of Codex, Cursor and Grok.

## Review log

Sol's review of v1 (all taken):

1. Checkout moves: Pi resumes in the session's saved folder. Now `--fork` into the new folder.
2. Revert positions: guessing by counting user entries was wrong. Now a durable, versioned turn map, and "memory not rewound" when unknown.
3. Fork boundaries: Pi forks before an entry. Now a mapping table for each boundary.
4. "handled" can still start work. Now the idle check after every ack.
5. Stop with an open dialog. Now cancel dialogs, then `clear_queue`, then `abort`, then a bounded kill.
6. Plan mode: limiting tools wasn't enough. Now a deny policy in the gate, independent of access level.
7. Shared session with Pi's terminal. Now not promised, and resume notes outside changes.
8. Claude subscriptions: hiding text didn't stop the routing. Now enforcement (decision 1).
9. Readiness missed extension providers. Now discovery-based readiness.
10. The migration still froze updates. Now the catalog keeps replaced agents for updates.
11. Install had no runtime lifecycle. Now `ManagedRuntimeStore` with leases; Node is 24.21.0.
12. Four tool servers, not one. Now every endpoint is bridged with routing by server.
13. Usage double-counted forks. Now an entry-level reader with de-duplication.
14. Compaction can take more than 15 s. Now model-length lifetimes.
15. The test gates didn't prove the extension. Now required CI integration tests on real Pi, and the floor raised to 1.3.0.

Built differently than reviewed (Oct 18): turn boundaries are markers Pi stores itself (see "Revert positions"), which also covers v2 #2 and forks from other threads.

Sol's review of v2 (all taken):

1. A one-time `pi auth check` can't enforce the Claude rule (OAuth tokens saved as keys, custom provider names). Now checked per request in Pi's request hook, with a spike and a fallback.
2. A crashed turn's entries could land in the next turn. Now each turn reads a fresh starting leaf before its prompt.
3. A slash command waiting on a dialog could look idle and survive Stop. Now open prompt handlers keep the turn open, and Stop kills Pi if one is still unresolved.
4. The fork helper broke for users whose models all come from extensions. Spike showed Pi forks fine without a usable model, so the helper uses `--no-extensions` after all.
5. `clone` could copy turns added outside Threadlines. Now only when the leaf matches.
6. Pi 1.3.0 can't answer questions extensions ask during startup. Now a fix sent upstream, a startup timeout with a clear message, and a test.

Later (Oct 18): Will chose to follow T3 Code on Claude subscriptions, so the enforcement from v1 #8 and v2 #1 was dropped. Nothing Anthropic-specific is built.
