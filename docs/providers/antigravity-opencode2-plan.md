# Antigravity + OpenCode 2: integration plan (draft, 2026-10-02)

Status: both are built (see "OpenCode 2: as built" and "Antigravity: as
built" at the end). OpenCode 2 ships in its own PR; Antigravity is stacked on
it and held until Google confirms its sign-in in writing. Will's decisions (2026-10-02): build Antigravity's
Google sign-in but get written confirmation from Google before it ships;
support OpenCode 2 only. Evidence tags: **[v]** verified in code,
package contents or official docs; **[r]** reported by research (read in T3
Code / Paseo source or a community post, not re-checked); **[i]** inference.

Local research copies: T3 Code main `/tmp/t3code-research`, T3 Code v2 branch
`/tmp/t3code-v2`, Paseo `/tmp/paseo-research`, OpenCode `/tmp/opencode-research`,
OpenCode 2 client package `/tmp/oc2-pkg/x/package`, ACP registry
`/tmp/acp-registry-research`.

## Decisions that belong to Will

1. **Antigravity terms of service.** Section 6 of the Antigravity terms says
   "Using third party software, tools, or services to access the Service (e.g.
   using OpenClaw with Antigravity OAuth) is a breach" [v]. The FAQ names
   Claude Code, OpenClaw and OpenCode, warns of suspension or termination, and
   recommends Gemini Enterprise / AI Studio API keys for third-party agents [v].
   Against that: Google publishes its own ACP server in the ACP registry
   (authored by Google LLC) for ACP clients [v], the server deliberately serves
   non-allowlisted clients Gemini-only models [r], and a 2026-09-16 forum reply
   calls it "the officially supported path" (author's Google affiliation not
   confirmed) [r]. T3 Code ships Google sign-in through it [r]. Driving Google's
   own unmodified binary with Google's own OAuth client is the most defensible
   route, but it is not cleared. Options: (a) ship Google sign-in with a plain
   note in setup, (b) get written confirmation from Google first, (c) ship API
   key / Vertex only (sanctioned by the FAQ, but per-use billing).
2. **Per-use auth for Antigravity.** The ACP server also offers
   `gemini-api-key` and `agent-platform` (Vertex), both per-use billing [r].
   Expose them or not.
3. **OpenCode 1.x.** Recommended: support OpenCode 2 only. 1.x is still
   maintained (`opencode-ai@1.18.34` is npm latest) [v], so some users would see
   "Threadlines needs OpenCode 2" with an install action.

## Antigravity

**Surface: Google's official ACP server on our generic ACP core, as a
descriptor plus generic core additions.**

- Binary `agy_acp_server.par` / `.exe` (registry id `antigravity-acp`, version
  1.3.0 as of today, six platforms including darwin-x86_64, zips on
  `dl.google.com/agy-extensions/releases/...`, Linux needs `--uid=`) [v]. It is
  a separate ~111 MB download, not the user's `agy` CLI, with its own sign-in
  and its own conversation store [r].
- Why not the `agy` CLI (`--input-format/--output-format stream-json`): headless
  `agy` cannot ask for approvals (it soft-denies, or runs with
  `--dangerously-skip-permissions`), has no in-band cancel, and no ACP [r].
  Paseo shipped it, pulled it because denials were misreported, then restored it
  as full-access only with a warning on every session [r]. That would leave
  Antigravity without Supervised mode in Threadlines.
- Why not T3 main's per-provider ACP adapter (1.3k lines): AGENTS.md prefers
  implementing ACP behavior once in the generic core; T3's own v2 branch
  converged on a generic ACP adapter plus a 241-line Antigravity "flavor" [r],
  whose hook list is our spec.
- Models: Gemini only for us (the server allowlists Zed/JetBrains/Xcode for
  Claude/GPT-OSS by `clientInfo`) [r]. Never spoof `clientInfo`. Users already
  have Claude and Codex natively, so this costs little. Effort is encoded in the
  slug (`gemini-3.8-flash-high`) [r]; map it onto our effort control through the
  descriptor's `modelOptions` instead of listing three models per family.
- No plan mode, no fork in the ACP server [r]. Hide the plan toggle via a
  capability; provider-switch handoff still works through the context seed.
- Browser panel and room tools work as-is: the core already passes them as
  `http` MCP servers on `session/new` (`AcpAdapter.ts` ~575-615) [v] and the
  server advertises MCP over http [r].

### Generic ACP core additions (benefit Cursor and fx too)

1. Prefer `session/resume` over `session/load` when advertised; `load` replays
   history slowly [r]. `effect-acp` already has `resumeSession` [v];
   `AcpSessionRuntime.ts` only calls `loadSession` (~472) [v]. Also fix the
   failure path: today any load failure silently opens a fresh `session/new`
   (~478-490) [v], so the agent loses its memory without a word. Surface it,
   and start the replacement session through the context-seed handoff.
2. Explicit runtime-mode to agent-mode map on the descriptor (full-access →
   `yolo`, auto-accept-edits → `auto_edit`, approval-required → `default`). The
   alias resolver (`resolveRequestedAcpModeId`, `AcpAdapter.ts` ~235) would
   never pick `yolo` or `auto_edit` [v].
3. Permission-request classifier hook: requests that are really questions
   (`interaction_*` tool call ids) become user-input questions answered by
   option id [r].
4. Approval options carry agent warnings (`_meta["agy.security.warning"]` on
   "allow always") [r]: one optional field on the approval contract, shown in
   the approval UI.
5. Opt-in client fs capability (`fs/read_text_file`, `fs/write_text_file`),
   confined to the workspace and attachments dir. Edits then arrive through us.
   That does not feed diff attribution by itself: ingestion only accepts
   `file_change` evidence from Claude or child threads
   (`ProviderRuntimeIngestion.ts` ~3690) [v], so ACP parent edits never count.
   The write callback must produce turn-scoped evidence, and shell writes and
   late background edits still need the checkpoint diff.
6. stdout line transform in `effect-acp` (captures the sign-in URL) and stderr
   hook [r]; `additionalDirectories` on `session/new` [r].
7. Tool-call normalization hook (CommandLine/Cwd/combinedOutput/exitCode
   variants, payload caps) [r]; execute tools still running after `end_turn`
   become background tasks; `start_subagent` becomes an opaque subagent batch
   (ACP gives no child ids) [r].
8. **Honest rollback.** `AcpAdapter.rollbackThread` only splices the local turn
   list (~1234) [v], so after a revert Cursor and fx still remember the reverted
   turns, silently. Add an adapter capability `conversationRollback: "native" |
"none"`. For `none`, the revert can restart the conversation: stop the
   session and start a fresh one seeded with the transcript up to the revert
   point. It is a disclosed, lossy restart, not exact rollback. The existing
   `ThreadContextSeedBuilder` cannot be reused as-is (Sol review): rollback runs
   before the transcript is pruned (`CheckpointReactor.ts` ~1198) [v], the
   builder has no cutoff and would replay the reverted turns, and without a
   summarizer it drops older history to a truncation marker [v]. It needs an
   explicit cutoff message id and a summarizer. Fallback: revert files and say
   plainly the agent still remembers, as the no-session path already does
   (`CheckpointReactor.ts` ~1204) [v].

### Outside the descriptor

- **Managed install** (new generic maintenance capability "managed binary"):
  the registry has URLs but no hashes [v], so pin version + per-platform sha256
  in Threadlines; unpack into a versioned dir under Threadlines home with a
  short path (Windows MAX_PATH, T3 #13389) [r]; an `active` pointer and leases
  so an update never swaps a running binary; validate with ACP `initialize`. A
  CI job watches the registry and opens a bump PR with fresh hashes, so we do
  not lag Google by a release.
- **Sign-in**: new `ProviderAuthFlow` (today only `login` and
  `claude-setup-token`, both PTY-based, `packages/contracts/src/providerAuth.ts`)
  [v]. Spawn the agent, `authenticate("oauth-personal")`, capture the printed
  URL, set `BROWSER` to a helper so the server host never opens a browser. The
  desktop app opens the URL locally and the 127.0.0.1 redirect lands. Remote and
  phone clients paste the failed redirect URL back (T3's approach) [r]. Clients
  that skip `authenticate` get -32000 [r].
- **Per-instance profile**: `GEMINI_HOME` under Threadlines home, strip ambient
  `GEMINI_*`/`GOOGLE_*`, `AGY_ACP_FORCE_FILE_STORAGE=1` [r]. Isolated from the
  user's own `~/.gemini`.
- **Temp-dir hygiene (must have)**: the PyInstaller bundle unpacks ~1 GB per
  launch; leftover `_MEI*` dirs filled users' disks up to 324 GB (T3
  #12096/#12239) [r]. Per-process temp dir under our own root (`TMPDIR` on
  POSIX, `TEMP` and `TMP` on Windows, as T3 does [v]), removed on exit. The
  startup sweep must skip dirs owned by a live process, since another instance
  or a second Threadlines server may be extracting into the same root.
- **Probe without spawning**: T3's spawning health check broke on ~45 s Windows
  cold starts (#9432) [r]. Probe install + token file; mark authenticated on the
  first successful session.
- **Platform gates**: Linux x64 SIGKILL without a seccomp filter (#13842), SIGILL
  on CPUs without AVX (#11414), Linux ARM64 failures (#12490) [r]. Detect and
  show a precise message instead of a crash loop.
- **Process model**: our core spawns one agent process per thread
  (`makeAcpProviderRuntime` inside `startSession`) [v]. With a ~1 GB unpack and
  slow cold start per launch, measure cold start, RSS, and whether one server
  process handles concurrent sessions. If it does, add a pooled mode to the core
  (one process per instance, many sessions); `opencode acp` and Cursor could use
  it too.
- **Known open upstream bugs** to design around: runs stuck "thinking" with
  `session/cancel` failing (#14619), stale-question deadlock (#12979), dropped
  ACP stream ends the turn (#11670) [r]. Cancel needs a timeout that settles the
  turn locally and recycles the process.
- **Text generation**: helper ACP session with fs off [r]. Uses subscription
  quota.
- **Usage**: ACP has `usage_update` and our core already maps it to context
  fill (`AcpRuntimeModel.ts` ~540) [v]. Open: whether Antigravity's server emits
  it. T3 reads Antigravity's local SQLite for quota [r].

## Antigravity: build plan (2026-10-02)

Facts recorded against `agy-acp-server` 1.3.0 (darwin-arm64), isolated
`HOME`/`GEMINI_HOME`/`TMPDIR`:

- `initialize` answers in ~1-3 s with `protocolVersion: 1`,
  `agentInfo {name: "antigravity-acp", version: "1.3.0"}`, `loadSession`,
  `sessionCapabilities {list, resume}`, `auth.logout`, MCP http+sse, prompt
  image/audio/embeddedContext. Auth methods: `oauth-personal`,
  `oauth-business`, `gemini-api-key`, `agent-platform`.
- `session/new` before auth fails with -32000 "Authentication required"
  naming `<GEMINI_HOME>/antigravity-acp/settings.json` `auth.type` as the
  alternative to calling `authenticate`.
- `authenticate("oauth-personal")` with no credentials prints `Open the
following link to authenticate the ACP server: <url>` on **stderr**: a
  Google PKCE URL whose `redirect_uri` is `http://127.0.0.1:<port>/` on the
  machine running the agent. The process exits cleanly on stdin EOF.
- Windows ships a PyInstaller one-file exe (unpacks to `TEMP` per launch);
  the macOS `.par` left `TMPDIR` empty. Linux is unchecked.
- Zips: two flat entries each (`agy_acp_server.par|.exe`,
  `localharness_external[.exe]`); sha256 recorded per platform. T3 pins 1.1.1
  (no darwin-x64); 1.3.0 adds darwin-x64.

Build (server unless noted):

1. **Managed runtime** (`provider/antigravity/AntigravityRuntime.ts`): pinned
   1.3.0 table (url, sha256, archive bytes, entry names and sizes); layout
   `<home>/tools/antigravity-acp/<platform>-<arch>/{active.json,
versions/<sha256>/, versions/.staging-*}`; streamed download with running
   sha256 and byte cap, `yauzl` extraction that accepts exactly the expected
   entries, ACP `initialize` validation (name, version, resume, logout,
   `oauth-personal`), atomic `active.json` swap. Leases per version dir; old
   unleased versions are pruned after an activation. A generic in-process
   maintenance action (`run` on `ProviderMaintenanceCommandAction`) lets the
   existing Install/Update buttons drive it; the version advisory compares
   the active release with the pinned one.
2. **Profile and process env**: `GEMINI_HOME = <state>/providers/antigravity/
<sha256(instanceId)>`, `AGY_ACP_FORCE_FILE_STORAGE=1`,
   `PYTHONUNBUFFERED=1`, a no-op `BROWSER` (node helper, `ELECTRON_RUN_AS_NODE`)
   so the server host never opens a browser, ambient Gemini/Google credential
   variables stripped, `--uid=` on Linux. `settings.json` `auth.type`
   written on launch. Per-process temp dir `<state>/antigravity-tmp/<12 hex>/
run-*` (`TMPDIR`; `TEMP`/`TMP` on Windows), removed when the process scope
   closes; the instance's temp root is swept on driver start.
3. **Generic ACP core** (Cursor and fx unaffected unless they opt in):
   - descriptor `spawn` may be a scoped Effect (per-process setup/teardown);
   - `effect-acp` stderr line hook;
   - `resume` preferred over `load` when advertised; a failed resume/load
     still opens a fresh session but now says so (runtime warning);
   - explicit runtime-mode → agent-mode map (full-access `yolo`,
     auto-accept-edits `auto_edit`, approval-required `default`);
   - permission classifier: `interaction_*` tool calls become user-input
     questions answered by option id, never auto-approved;
   - approval option warning (`_meta["agy.security.warning"]`) carried on the
     approval request and shown in the approval UI;
   - opt-in client fs (`fs/read_text_file`, `fs/write_text_file`) confined to
     the session cwd and the attachments dir, writes producing turn-scoped
     file-change evidence; `additionalDirectories` for attachments;
   - tool-call normalization hook (command/cwd/output/exit-code field
     variants, payload caps); `start_subagent` as an opaque subagent item;
   - cancel with a deadline: if the prompt does not return within 15 s of
     `session/cancel`, the turn settles as cancelled locally and the process
     is recycled (the next turn resumes the session);
   - rollback honesty: ACP agents report `conversationRollback: "none"`, so a
     revert says the agent still remembers the reverted turns.
4. **Auth**: sign-in runs as a provider-auth session without a PTY: spawn the
   runtime, `authenticate("oauth-personal")`, stream the captured URL as
   output so the card opens it (desktop: the redirect lands on the agent's
   loopback listener), accept a pasted redirect URL as input (validated
   against the pending `redirect_uri` and `state`, then replayed as one GET to
   127.0.0.1 from the server), confirm with `session/new`. New flow `logout`
   runs ACP `logout` (Sign out button). Status without spawning: installed
   runtime plus the agent's token file in the profile.
5. **Descriptor** (`acp/AntigravityAcpSupport.ts`): presentation, settings
   (binary override, custom models), models from `configOptions` with effort
   variants (`-high/-medium/-low`) folded into one model plus an effort
   option, `clientInfo` stays `threadlines` (Gemini models only; never spoof),
   no plan mode, text generation through the generic ACP helper with tools
   denied, precise messages for crash signals at startup.
6. **Web**: icon, Experimental badge, picker entry, browser sign-in panel with
   a paste-back field and no terminal, Sign out, approval warning line.

Live recording (2026-10-03, 1.3.0, spare Google account on the free tier,
throwaway `GEMINI_HOME`):

- Sign-in: `authenticate` blocks until the browser redirect lands (3.5 min
  was fine). Any failed redirect ends the flow with -32000
  `onboarding_failed` and clears stored credentials; a retry needs a new
  `authenticate` (new port and state). On success the agent itself writes
  `antigravity-acp/acp_token.json` and records `auth.type` in
  `settings.json`; later processes need no `authenticate`.
- `session/new`: modes `default` / `auto_edit` / `yolo` (also exposed as the
  `mode` config option); a `model` select of 11 models whose names carry the
  effort, `Gemini 3.8 Flash (High|Medium|Low)` etc., but whose ids do not
  always (`gemini-pro-agent` is "Gemini 3.1 Pro (High)"), so effort folding
  goes by name. `available_commands_update` lists `/plan` and `/logout`.
  Accepts http MCP servers (an unreachable one does not fail the session) and
  `additionalDirectories`.
- `usage_update {used, size: 1048576}` arrives during prompts.
- Tool calls: reads are `kind: "read"` with `rawInput.AbsolutePath`; commands
  are `kind: "execute"` with `CommandLine`/`Cwd` on `tool_call` and
  `command_line`/`working_dir` on updates; results carry `rawOutput
{commandLine, workingDir, exitCode, combinedOutput}`. Failures are
  `status: "failed", rawOutput: "Tool execution failed"`. In `yolo` the ids
  look like `<sessionId>:<n>`.
- Edits: the pending `tool_call` (`kind: "edit"`, title `Run edit_file?`)
  carries ACP `diff` content (`path`, `oldText`, `newText`); the agent writes
  the file itself after `allow`. No client fs capability is needed: evidence
  comes from the diff. Edit approvals offer only `allow` / `deny`; command
  approvals add `allow_always` with `_meta["agy.security.warning"]
{severity, risk, title, message}`.
- Questions: `toolCallId: "interaction_<hex>"`, options `{optionId: "1",
name: "Tabs", kind: "allow_once"}`; answered by option id.
- Cancel: `session/cancel` returns the prompt with `stopReason: "cancelled"`
  in ~6 ms, preceded by one synthetic chunk "The request was cancelled by the
  client." (to be dropped).
- Resume: a new process, no `authenticate`, `session/resume` in ~1.2 s, no
  replay, memory intact; the mode persists across processes (`yolo` stayed),
  so the mode is set on every start. Unknown session: -32002 "Session not
  found in the current GEMINI_HOME".
- `/plan <task>`: writes `GEMINI_HOME/antigravity-acp/brain/<session>/plan.md`
  through a `create_file` edit approval, then ends the turn asking for
  review. The approved call is executed under a different tool call id; the
  approved id then fails with "Tool call was approved but never executed."
  Plan mode maps onto this (the plan file becomes the proposed-plan card).
- The agent installs a helper into `$HOME/.gemini/antigravity/bin` (real
  `HOME`, not `GEMINI_HOME`), and reads global MCP config from
  `GEMINI_HOME/config/mcp_config.json`.

Revisions after Sol's plan review (11 findings, all accepted):

- The ACP launcher merges `process.env` back into the child; descriptors can
  now hand over the complete environment, so stripped credentials stay out.
- Managed versions: leases are files (`.leases/<pid>-<id>`) checked by PID
  liveness, so a second server sees them; pruning renames a version dir to
  `.trash-*` only when no live lease exists, and a launch re-checks its
  version marker after taking its lease (a prune that wins sends it back to
  `active.json`).
- Temp dirs carry an owner file with the PID; the sweep skips live owners.
- Client fs is decided after a live recording: if edit tool calls carry diff
  content, evidence comes from those and the agent writes its own files (no
  fs capability, no confinement surface). If the capability is needed, the
  write path refuses symlinked components and re-checks the real path.
- Sign-in and sign-out run inside the instance (`ProviderInstance` owns its
  browser auth): both stop the instance's sessions and block new ones until
  done. Flows carry a `flowId`; writes and stops must name it; a pasted
  redirect is consumed once; flows expire after 5 minutes.
- Spawned ACP processes get a force-kill deadline; on a cancel deadline the
  process is killed and reaped before the turn settles as cancelled.
- Ingestion trusts Antigravity's turn-scoped file-change evidence
  (`PER_ITEM_DIFF_EVIDENCE_PROVIDERS`).
- Text generation runs in a fresh temp directory, never the workspace.
- The status check does not spawn: it reads the installed runtime, the token
  file and a catalog cached from the last session (`skipModelDiscovery`).
  Discovery runs once when no cache exists. A runtime that prints a sign-in
  URL outside a sign-in flow fails at once with "Sign in to Antigravity in
  Settings" and marks the profile as needing sign-in.
- A failed resume is seeded: callers pass the thread's context seed alongside
  the resume cursor to adapters that declare `contextSeedOnResumeFailure`,
  and the ACP adapter primes the fresh session with it.

Not built: Gemini API key / Vertex / Enterprise sign-in (per-use billing,
needs Will's go-ahead), usage from Antigravity's SQLite (reverse-engineered
protobuf), skills links into `~/.gemini`, a pooled process mode. Ships only
after Google confirms in writing.

## OpenCode 2

**Surface: a new native driver over OpenCode 2's HTTP `/api` + SSE, replacing
our dead 1.x driver under the same `opencode` kind.**

- "OpenCode v2" is OpenCode 2.0, a rewrite: v2.0.0 on 2026-09-11, v2.0.22
  today, published as `@opencode/cli` [v]. New `/api/*` routes, a password is
  always required, sessions with executions/steps, inbox delivery, forms,
  staged revert, permission rules [r]. Our driver's `@opencode-ai/sdk/v2` is the
  newer client inside the 1.x SDK (`apps/server/package.json`
  `@opencode-ai/sdk ^1.18.32`) and cannot talk to a 2.x server [v].
- T3 main still marks OpenCode ≥2.0 "broken"; their 2.x support is only on the
  unmerged orchestrator-v2 branch (PR #2829, 9-PR stack merged into it Sep 30 to
  Oct 1, follow-ups #14744/#14752/#14760 open) [r]. Its adapter (4.2k lines) is
  built on orchestrator-v2 concepts we do not have; port the client pieces, the
  rules table, tool-item mapping and the 15 recorded 2.0.18 fixtures as protocol
  reference, not the adapter [r].
- Why native over `opencode acp` through our core: native gives true
  conversation rollback (`revert.stage{files:false}` + `commit`), native steering
  (`delivery: "steer"`), durable prompt admission and inbox, forms, and
  session-scoped permission rules [r]. Over ACP we would lose rollback and
  steering; revert is a Threadlines flagship. OpenCode's ACP also changed daily
  this week and the registry still ships 1.18.34 [v].
- Why replace instead of version-routing like T3/Paseo: the OpenCode driver is
  not in `BUILT_IN_DRIVERS` [v], so nobody can run it today. Delete the 1.x
  adapter/provider/runtime and their tests. Saved state still exists, though:
  hydration preserves non-default legacy OpenCode settings as unavailable
  instances (`ProviderInstanceRegistryHydration.ts` ~108) [v], and old threads
  may carry 1.x resume cursors. Decide explicitly: decode legacy settings into
  the new schema where fields carry over, and treat 1.x cursors as "start fresh
  with a context seed" (T3 reports OpenCode 2 converts the 1.x database and
  `session.get` resumes 1.x ids [r], so verify before choosing).
- **Client**: `@opencode/client` root entry, which is a zero-Effect Promise
  client [v: no `effect` import reachable from `dist/promise`; README says so].
  Wrap in `Effect.tryPromise`; `event.subscribe()` is an `AsyncIterable` →
  `Stream.fromAsyncIterable`. Decode only the fields we use with our own
  tolerant schemas and skip unknown frames, except execution start/end so turns
  still end [r]. This avoids T3's `effect 4.0.0-rc.112` pnpm override (the
  protocol/schema packages hard-pin it; we are on beta.107 with a patch) [v].
  Needs a pnpm `peerDependencyRules` entry for the client's `effect` peer [v];
  the nested rc.112 copy is installed but never loaded [i].
- **Server**: one private server per instance serving all directories,
  `opencode serve --hostname 127.0.0.1 --port <scanned>`, random password via
  env (T3: `OPENCODE_PASSWORD` wins over `OPENCODE_SERVER_PASSWORD` in 2.x,
  so drop the inherited one) [r], readiness `GET /api/info` [r]. Not the shared
  per-user `--service` (version skew with the user's TUI) [r]. Open: concurrent
  database access with a user's own running OpenCode.
- **Mapping** (from T3's v2 branch [r]):
  - turn = `session.prompt` with a client-chosen id. One Threadlines turn can
    span several executions: undelivered steering starts another execution
    for the same turn, so hold the turn open until its inbox items settle, not
    on the first `session.execution.{succeeded,failed,interrupted}` (T3
    `OpenCode2AdapterV2.ts` ~2380) [v by Sol];
  - interrupt = `session.interrupt` on the session and on running background
    children (T3 ~3875), suppress the parent wake-ups they would cause, and
    after the timeout check real activity before allowing the next prompt
    (T3 ~3681). Keep an "unresolved stop" state rather than claiming it
    stopped [v by Sol]. Local settle alone lets agents keep editing after we
    say they stopped;
  - steering = `delivery: "steer"` → `activeTurnSteering` native;
  - fork = `session.fork{before}` → `nativeThreadFork`;
  - rollback = `revert.stage{files:false}` + `revert.commit`; our checkpoints
    keep owning files. A stage left over after a failed commit is committed by
    OpenCode on the next prompt, so clear failed stages and retry cleanup
    before prompting (T3 ~3053), and refuse rollback while background work can
    still wake the parent (T3 ~2983) [v by Sol];
  - approvals: runtime mode → session rules (last match wins). Never reply
    `always` (OpenCode persists it for the whole project); add a session rule
    and reply `once`. Decline steers a "do not retry" note, then rejects;
  - `form.created` → user-input questions (`custom` → free text,
    `multiselect`); unsupported form types are cancelled;
  - plan mode = the `plan` agent, edits denied outside the plan dir;
  - models from `/api/model` (`provider/model#variant`), variants → effort;
  - browser + room MCP: per-thread `PUT /api/experimental/mcp/<name>` plus rules
    that keep each thread to its own server; Threadlines instructions via the
    instructions entry API;
  - subagents are child sessions (`session.created{parentID}`). A finished
    background subagent makes OpenCode start a parent execution on its own, i.e.
    a provider-initiated turn. Our ingestion accepts `turn.started` with no
    active turn (`ProviderRuntimeIngestion.ts` ~2958) [v], but in a room an
    idle participant's self-started turn is rejected and interrupted (~2680)
    [v]. That is intended room behavior; the adapter must handle the rejection
    cleanly;
  - usage from `step.ended`; context windows per directory (a project's
    `opencode.json` can change limits);
  - SSE is volatile: reconnect with backoff, then re-read active sessions,
    pending permissions and pending forms as well as `message.list`, then
    settle open turns. Messages alone miss an approval raised during the gap,
    and the agent would wait on it forever (T3 ~2706, ~2744) [v by Sol].
- **Auth**: OpenCode owns credentials. Reuse the existing PTY `login` flow with
  `opencode auth login` [i]. Billing depends on the user's OpenCode setup (BYO
  keys and Zen are per-use; OpenCode Go, ChatGPT and Copilot logins are
  subscriptions) [r]. Threadlines adds no billing surface.
- **Install/update**: maintenance resolver currently knows 1.x names
  (`opencode-ai`, `anomalyco/tap/opencode`) [v]; switch to `@opencode/cli`, the
  curl installer and `opencode upgrade`. Version gate on `--version` (`opencode
v2.x` on 2.x, bare `1.18.x` on 1.x) [r], minimum = the version we record
  fixtures against.
- **Text generation**: temporary session that rejects every tool ask [r].

## Shared work

- Contracts: `antigravity` driver kind and settings schema; new OpenCode
  settings; `ProviderAuthFlow` addition; approval option warning; adapter
  capabilities (`conversationRollback`, plan-mode support).
- Web: icons, `providerDriverMeta` entries; an Antigravity setup card (install
  progress, sign-in, paste fallback, sign-out, remove runtime). Everything else
  is already settings-schema driven.
- Secrets: any API key goes into the instance's sensitive environment
  variables, not plain settings (T3 stores it in plain text) [r].
- Tests: adapter tests at the module boundary driven by recorded real-CLI
  native logs (record per scenario: plain turn, tool call, approval accept /
  decline, question, interrupt, resume after restart, fork, rollback, subagent),
  plus live runs on macOS and Windows through the isolated verify stack.
- PRs: (1) generic ACP core + honest rollback, (2) Antigravity, (3) OpenCode 2.
  (2) and (3) are independent and can be built in parallel worktrees.

## Not copied from T3 Code

- Per-provider ACP adapters (T3 main) → one descriptor on our core.
- Effect rc.112 override → Promise client with our own decoding.
- Keeping a 1.x OpenCode path → we have no 1.x users.
- Antigravity inheriting `canRollbackThread: true` on T3's v2 branch while main
  refuses rollback [r] → explicit capability.
- Plain-text API key in settings → sensitive env vars.
- Health probe that spawns the agent → install + token check.

## OpenCode 2: as built (2026-10-02)

Code: `apps/server/src/provider/opencode/` (client, server, manager, events,
rules, questions, tool items), `Layers/OpenCodeAdapter.ts`,
`Layers/OpenCodeProvider.ts`, `Drivers/OpenCodeDriver.ts`,
`textGeneration/OpenCodeTextGeneration.ts`. The 1.x driver code is gone.
Reviewed by GPT-6.1-Sol in three rounds (7 + 13 + 9 findings, all fixed),
then a final check of the adapter fixes and a review of the one-click work
(6 findings: 5 fixed, 1 rejected, see below; the re-check found 1 more, fixed),
and two reviews of the 1.x move (5 + 2 findings, all fixed).

Where it differs from the plan above:

- Server: `opencode serve --stdio --port 0`, one per provider instance, idle
  stop after 10 minutes; it exits with its parent. It uses the user's own
  OpenCode data (credentials live in OpenCode's database), so a user's saved
  "always" grants still apply.
- Client: the Promise entry of `@opencode/client` 2.0.22 with our own event
  schemas; no Effect version override.
- Permissions: mode rules, then per-thread tool-server scoping (deny all
  `threadlines_[br]_*`, allow this thread's), then the agent's denies and
  their exceptions. Full access answers OpenCode's asks rather than adding
  allow rules, so the user's denies hold. Subagent sessions get the same rules
  the moment they appear; OpenCode creates them without any (upstream gap).
- A native fork across directories is refused, so the caller falls back to
  the transcript seed; a resume in another checkout moves the session.
- Turn ids are prompt ids (`msg_tl_<message id>`), so fork and rollback
  boundaries need no lookup.
- OpenCode defaults to off, like Cursor and fx.

One-click actions (`opencode/OpenCodeBinary.ts`, live-verified on macOS):

- Install: `curl -fsSL https://opencode.ai/v2/install | bash` on macOS and
  Linux (the plain `opencode.ai/install` script still ships 1.x); npm
  `@opencode/cli` elsewhere (OpenCode publishes no v2 script for Windows).
  The installer writes `~/.opencode/bin`, which a running server's PATH
  lacks, so every use (sessions, status, sign-in, update) looks there after
  PATH. No restart needed after a one-click install.
- Update: `opencode upgrade --method curl` for installer installs (without
  `--method` it fails to detect how it was installed), run by the resolved
  path; npm `@opencode/cli`; Homebrew by the keg the binary links into:
  core `opencode` (2.0.20 on 2026-10-02) or OpenCode's
  `anomalyco/tap/opencode-v2`. Linuxbrew now counts as Homebrew for every
  provider. After an update the running OpenCode server is retired and
  restarts once no session holds it.
- Minimum version 2.0.20, the one Homebrew core ships; the live suite passes
  on it.
- Sign-in: `opencode auth login --standalone` in the settings terminal, shown
  straight away because it opens a provider menu. `--standalone` keeps it from
  starting OpenCode's shared background service.
- No sign-out: no provider has one in Threadlines.
- OpenCode 1.x: Update moves the install to OpenCode 2
  (`openCodeOneMigrationCapabilities`), by the method that installed 1.x.
  Steps run regardless of the one before (`;`, or `&` in cmd.exe), so a
  retry after a half-done move still installs OpenCode 2; if the move removed
  1.x and then failed, the card's Install retries it.
  - OpenCode's installer: the v2 installer, which replaces the binary in
    place (and adds an `opencode2` shim). 1.x's own `opencode upgrade`
    stays on 1.x.
  - npm: `npm uninstall -g opencode-ai ; npm install -g @opencode/cli@latest`
    (npm refuses one over the other: EEXIST).
  - pnpm: remove, then `pnpm add -g @opencode/cli@latest
--allow-build=@opencode/cli || pnpm add -g @opencode/cli@latest` (the
    flag needs pnpm 10.4; pnpm 9 runs the postinstall anyway). bun: remove,
    add, then `bun pm -g trust @opencode/cli`. pnpm 10 and bun skip
    `@opencode/cli`'s postinstall (which fetches the binary) otherwise; later
    plain updates keep working.
  - Homebrew: `brew uninstall opencode ; brew install
anomalyco/tap/opencode-v2` (the tap's `opencode` is 1.18.34, and
    `opencode-v2` conflicts with it).
  - No move (status message gives the install command instead): Scoop,
    Chocolatey, a 1.x installer binary on Windows, a binary only the npm
    fallback guessed at, and a configured path the move would delete (inside
    the package, the keg, or Homebrew's `opt/opencode`).
  - Moves run with the instance's own HOME and PATH when they differ from
    the server's.
  - Data: OpenCode 2 migrates the same `opencode.db` in place on first start.
    1.x chats keep their messages, and 1.x still reads the migrated database.
  - Tested 2026-10-02 (1.18.34 → 2.0.22): installer, npm, pnpm 9 and 10, and
    bun in sandboxed homes on macOS (pnpm and bun retries too); Homebrew in a
    Linuxbrew container (tap move, core update); the button end to end in a
    throwaway Threadlines (installer route), twice. Windows is untested.
- Rejected review finding: Windows sign-in through npm's `opencode.cmd` works,
  because node-pty starts it with `CreateProcessW(NULL, cmdline)`, which runs
  batch files; Codex's npm sign-in takes the same path.

Not done / known limits:

- No `turn.proposed.completed` for plan mode: the plan agent's plan shows as
  text, not as a plan card.
- A subagent can race its rules for its first step (upstream; OpenCode
  creates children without their parent's rules).
- Approval rows count as commands in the folded step summary. That is the
  shared timeline's behaviour for every provider, not OpenCode's.
- Windows is untested (install, update and sign-in included).

## Antigravity: as built (2026-10-03)

Code: `acp/AntigravityAcpSupport.ts` (descriptor), `antigravity/` (release
table, managed runtime, profile and temp dirs, sign-in and sign-out),
`Drivers/AntigravityDriver.ts`, plus the generic ACP core additions listed in
the build plan. Google sign-in is built but must not ship until Google
confirms in writing. No API key or Vertex sign-in.

- Runtime: Threadlines downloads `agy_acp_server` 1.3.0 itself (zip pinned by
  SHA-256 and size per platform), unpacks it under
  `<state>/tools/agy/<platform>/versions/<id>`, and validates it with a real
  `initialize` before switching `active.json`. Every agent process holds a
  lease on its version; prune and remove skip leased versions. A lease is kept
  only if the active pointer still names its version after it landed, which
  closes the prune race across server processes. One runtime object per root
  per server, so instances share its locks.
- Profile: each instance has its own `GEMINI_HOME` and temp root; the agent
  gets only a scrubbed environment (no Gemini/Google/gcloud vars, no
  `BROWSER`). Temp dirs whose server is gone are swept on start once they have
  been quiet for 10 minutes (an agent can outlive a crashed server briefly).
  Each run dir names its server and, once started, its agent process; a
  sweep removes it only when both are gone.
- One-click: Install and Update run in-process (the maintenance runner's
  `run` action). Sign in with Google and Sign out run inside the agent. Sign-in
  opens Google's page on the device the user clicked on; another device pastes
  the address its browser ended on, which is checked (loopback origin, path,
  exact state, one result, Google issuer) and replayed once. Sign-in and
  sign-out close the instance: no new agent process starts, sessions stop, and
  the flow waits for every other agent process to end before touching the
  profile. The chat's sign-in notices and the first-run card offer Google
  sign-in too (they used to say "not installed").
- Sessions: modes map plan → default, full access → yolo, auto-accept edits →
  auto_edit. Model ids fold into families with a Reasoning option (the Pro
  High id is `gemini-pro-agent`). `/plan` plans become plan cards. Questions
  arrive as permission requests and go to the user. Edits carry exact +/-
  from the agent's diffs. A resume the agent refuses falls back to a fresh
  session and the next message carries the thread's history, whatever caused
  the restart (in a room, as the room's joining note, so nothing is sent
  twice); the debt is paid only once the agent takes that message. Cancel
  drops the agent's synthetic "cancelled" text; a turn that doesn't stop in
  15 s is recycled.
- Approvals across ACP providers: full access answers "allow once", never
  "always"; Decline never picks a standing reject (it answers `cancelled` if
  that's all the agent offers). No answer is ever an option the agent didn't
  offer: a full-access request with no "once" goes to the user.
- Reviewed by GPT-6.1-Sol twice. Round 1, 10 findings: gate race,
  install-check hang, kill deadline, prune race, temp sweep, relative edit
  paths, decline mapping, line counts, chat sign-in, history after a non-send
  restart. Round 2, 7 more: a stop-all effect that only worked once, history
  debt cleared before delivery, room history sent twice, a rejected lease left
  behind across processes, page opening tied to the wrong run, nested temp
  activity, an invented approval option. A final check found 4 narrower
  gaps (two sends both carrying the history, a replay taking the page-open
  claim, a lease surviving a whole-root move, huge orphan temp trees never
  cleaned). All fixed, and a fourth round's 5 edge cases led to simpler
  designs: the history debt is claimed only as the request goes to the
  provider; the starting tab sends a `requestId` the server echoes on the
  run, so only that tab opens Google's page; leases this process gave up on
  are dead to it wherever they end up (a per-process held-lease set); temp
  dirs are judged by process liveness, not file times. One finding was kept
  as is: if the provider takes a turn but saving the session then fails, the
  history goes again with the next message (twice is better than never).
  A fifth round confirmed those designs and found 5 more edge cases: 3 fixed
  (an empty pid marker, a day's wait for a dir with no agent recorded,
  rejected leases deleted again once another server puts them back), 2 kept
  as known limits (below).
- Live-verified on macOS with a spare Google account (throwaway stack):
  install, status card, model picker, a turn with read and edit approvals and
  +/- evidence, a question, a plan card with Implement, cancel, sign-out and
  sign-in from Settings (by Will), a second instance sharing the runtime, and
  Google sign-in started from the held-send notice and a Settings row (the
  Google page opened; sign-in not completed).

Not done / known limits:

- Windows and Linux are untested; the paste-back path is unit-tested only.
- Usage numbers, skills, and one long-lived agent process per instance (T3
  Code pools) are not built.
- The "approved but never executed" quirk is only handled for plan files.
- An expired token mid-session shows as a plain turn error, not a sign-in
  notice.
- Owed history is kept in memory: if a resume fails on a restart that wasn't
  a send (an access-mode change) and Threadlines restarts before the next
  message, that message goes without the history.
- On Windows, if something kills only the onefile bootloader while its Python
  child lives and the server is gone too, a sweep can delete the child's
  temp dir. The child has lost its server and exits anyway.
