# Grok Build: integration plan (draft, 2026-10-15)

Status: research only, nothing built. Evidence tags: **[v]** verified (code,
binary, live probe, or official docs, re-checked by a second pass); **[r]**
reported by one research pass and not re-checked; **[i]** inference.

Research copies (may be gone): Grok probe `/tmp/grok-probe-20580` (1.0.60
install, probe scripts, ACP transcript), Grok source `/tmp/grok-src-32441/repo`
(xai-org/grok-build at 1.0.45), installers `/tmp/grok-installers-18992`, docs
mirror `/tmp/grokdocs-16316`, T3 Code main `/tmp/t3-grok-12221/repo`
(42da166d13), research notes `/tmp/grok-synth`.

## Recommendation

Make Grok a built-in ACP provider: a `GrokAcpSupport.ts` descriptor plus a
`GrokAcpExtension.ts` for xAI's `_x.ai/*` messages, on our generic ACP core,
running the user's own `grok` as `grok --no-auto-update --permission-mode <m>
agent --no-leader stdio`. Every integration we found runs Grok this way [v],
xAI documents ACP as the way to use Grok in other apps [v], and T3 Code
converged on the same shape (a small "flavor" over its shared ACP adapter) [v].

Where we can beat T3 Code, which ships the most complete Grok provider today:

- **One-click sign-in and sign-out inside the app.** Grok's ACP agent has a
  full sign-in API (`authenticate grok.com` plus `_x.ai/auth/get_url`,
  `submit_code`, `cancel`, `logout`, `info`) [v]. T3 tells users to run
  `grok login` in a terminal [v].
- **One-click install** on all three systems through xAI's own installers [v].
  T3 has none [v].
- **Usage meters through Grok itself** (`_x.ai/billing`, which sends Grok's own
  headers and refreshes the token) [v], instead of T3's direct call to an
  undocumented endpoint with a token read from `auth.json` [v].
- **Avoid T3's open bugs**: effort never applied (#15251), background work
  holding a turn open for hours (#15888, #17159), `$skill` not invoked
  (#13457), false sign-outs from parsing `grok models` text (#14285), Homebrew
  updates hitting the wrong copy (#18768) [v].
- Later: steering (`_x.ai/interject`), revert (`_x.ai/rewind/*`) and fork
  (`_x.ai/session/fork`), which map onto our flagship features [r].

## Fix first (bugs found during the research, independent of Grok)

Status 2026-10-15: 1 and 2 are fixed on branch `fix/acp-cancel-and-cursor-binary`
(uncommitted; reviewed by Sol, gates green). Cursor now runs `cursor-agent`,
and a saved bare `agent` (the old default most configs hold) decodes to it.
That also fixes Homebrew installs (the `cursor-cli` cask installs only
`cursor-agent`) and the chat's reconnect command. 3 is left for the Grok work.

1. **Stop is broken for every ACP agent.** `packages/effect-acp/src/protocol.ts:467-478`
   sends notifications as requests: `{"method":"session/cancel",...,"id":"","headers":[]}`,
   and `protocol.test.ts:168` asserts that frame [v]. Grok answers
   `-32601 Method not found` [v], and so does **Cursor** (probed Oct 15 with
   Cursor's `agent acp`, throwaway HOME: `"\"Method not found\": session/cancel"`;
   a proper id-less notification got no error) [v]. Today every Stop on an ACP
   agent waits out `ACP_CANCEL_DEADLINE` (15 s, `AcpAdapter.ts:116`), then kills
   the process and shows "did not stop in time" [v]. T3 fixed the same code in
   #9154 (`a434677eca`): encode a real JSON-RPC notification and drop
   `@effect/rpc` `Interrupt` control messages [v].
2. **Grok steals Cursor's `agent` command.** xAI's installers create an `agent`
   alias next to `grok` (`~/.grok/bin/agent`, `agent.exe` on Windows, the
   Homebrew cask too) and put `~/.grok/bin` first on PATH in shell profiles
   (Windows: prepends to the user PATH) [v]. Our Cursor provider runs `agent` by
   default (`CursorAcpSupport.ts:91`, update at `:755`, `contracts/settings.ts:391`)
   [v], so after a Grok install a new Threadlines server can launch Grok as
   "Cursor". If `~/.grok/bin` is not on the installer's PATH, `install.sh` also
   `ln -sf`s `agent` over `~/.local/bin/agent`, which is where Cursor's own
   installer puts its link [v] (`install.sh:418-430`). Cursor's installers ship
   both names on macOS/Linux and Windows, calling `agent` primary and
   `cursor-agent` legacy (cursor.com/install, `install.sh:128-131`,
   `install.ps1:26-38`, fetched Oct 15) [v]. Fix: when the binary setting is the
   default, look up `cursor-agent` first and fall back to `agent`, and refuse an
   `agent` whose `--version` says `grok` (T3 #4094 switched to `cursor-agent`
   outright) [i].
3. **The community grok-build install is broken and touches the user's real
   Grok.** Grok's npm postinstall turns `bin/grok` into a symlink to
   `./grok-native`; `findNpmBin` (`acpRegistry/NpmPackage.ts:537-538`) requires
   `lstat().isFile()`, so the install fails on macOS and Linux [v]. Before it
   fails, the postinstall (run because we pass `--ignore-scripts=false`) has
   repointed the real `~/.grok/bin/grok` to the registry's build, deleted older
   versioned binaries and re-serialized `~/.grok/config.toml` (comments lost)
   with `installer = "npm"`, which also switches the user's own `grok update`
   to `npm i -g` [v]. On Windows the npm bin stays Grok's JS launcher, which
   runs whatever `~/.grok/bin/grok.exe` exists, so the pinned version isn't
   what runs [v]. The registry also pins an alpha build (1.0.60; stable is 1.0.52),
   because it takes the highest plain semver and xAI publishes alphas without a
   suffix [v]. Hiding `grok-build` from the community list (below) removes the
   Grok case; the generic lesson is that npm postinstalls run with the user's
   real HOME [i: decide whether community npm installs should get a private
   HOME].

## What Grok Build is

- `grok`, a ~172 MB Rust binary, Apache-2.0 at github.com/xai-org/grok-build
  (synced from xAI's monorepo, issues off) [v]. Channels: stable 1.0.52
  (weekly), alpha 1.0.60 (about daily), enterprise 1.0.53; pointers at
  `https://x.ai/cli/{stable,alpha,enterprise}` [v].
- Installs [v]: `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS, Linux,
  Git Bash), `irm https://x.ai/cli/install.ps1 | iex` (Windows, also installs
  `grove*.exe` and a MinGit), npm `@xai-official/grok` (brotli binary per
  platform, postinstall unpacks into `$GROK_HOME/bin`), Homebrew cask
  `grok-build` (the `grok` formula is an unrelated tool), WinGet
  `xAI.GrokBuild`, Scoop `grok-cli`. No checksums or signatures from xAI
  (smoke test only); macOS binaries are signed "X.AI Corporation (5Y6N3AJ54S)".
- Update: `grok update [--check] [--json] [--version V] [--alpha|--stable]`;
  `--check --json` returns `{currentVersion, latestVersion, updateAvailable,
installer, channel, ...}` [v]. Per installer: npm runs `npm i -g` (always
  global), internal swaps the `~/.grok/bin` symlink, WinGet prints the winget
  command and changes nothing [v]; Homebrew probably gets a second copy in
  `~/.grok` (T3 #18768) [r].
- Auto-update: on by default; off with the top-level `--no-auto-update` (must
  come before `agent`), `GROK_DISABLE_AUTOUPDATER=1`, or `[cli] auto_update =
false` [v]. `agent stdio` self-updates when run from `$GROK_HOME/bin/grok`
  [r]. T3's health checks opened blank console windows on Windows through it
  (#18075) [r].
- State: everything under `GROK_HOME` (default `~/.grok`): `auth.json` (0600,
  plain file, no keychain), config, sessions
  (`sessions/<urlencoded cwd>/<id>/`), logs, bin, update cache [v]. The
  installers ignore `GROK_HOME` [v].
- Sign-in [v]: browser OAuth via auth.x.ai (`grok login`, loopback callback on
  `127.0.0.1:<random>`), device code (`grok login --device-auth`), enterprise
  OIDC, external auth command, API key (`XAI_API_KEY`, legacy
  `GROK_CODE_XAI_API_KEY`). No `auth status` command; `grok models` exits 0
  signed out and prints "You are not authenticated." [v].
- Billing: "The X Subscription" (Free / Plus $8 / Premium $30 / Super $100 /
  Ultra $200), a weekly pool shared with Cursor, top-ups at grok.com [r].
- Terms: xAI's own post "Use your SuperGrok or X Premium subscription inside
  OpenCode... more open-source agents and integrations are coming soon" (x.ai/news/grok-opencode)
  [r]; xAI lists Zed, Neovim, Emacs and marimo as compatible ACP clients [v].
  No clause found for or against third-party harnesses (x.ai/legal pages are
  behind Cloudflare) [r]. This is a lighter terms question than Antigravity's.

### ACP surface (probed live, 1.0.52 and 1.0.60, signed out)

- `initialize` answers in ~0.24 s [v] (T3 saw 8.9-13.4 s on 1.0.52 when run
  from `$HOME`, #18771 [r]: probe from a small scratch folder). Result:
  protocol 1, `loadSession`, `sessionCapabilities {list, resume, close}`,
  `promptCapabilities {image:false, embeddedContext:true}`, MCP http+sse, one
  auth method `grok.com` (no `type`, no terminal-auth). `_meta` carries
  `agentVersion`, `defaultAuthMethodId` (null signed out),
  `modelState.availableModels` (with `totalContextTokens` and per-model
  `reasoningEfforts`) and `availableCommands` [v].
- Signed-out `session/new` fails `-32000 Authentication required` after
  `_x.ai/session/setup` progress notifications, and still leaves a session
  folder behind [v].
- Every extension method needs a leading underscore on the wire:
  `_x.ai/auth/info` works, `x.ai/auth/info` is `-32601` [v]. Listen on both
  spellings, as T3 does.
- Requests Grok sends us [v/r]: `_x.ai/ask_user_question`,
  `_x.ai/exit_plan_mode`, `_x.ai/mcp/elicit`, `_x.ai/folder_trust/request`.
  Our core answers unknown ext requests with method-not-found
  (`effect-acp/src/client.ts:396-404`), so questions and plan exits fail today
  [v].
- Notifications [v/r]: `_x.ai/session_notification` / `_x.ai/session/update`
  (`turn_completed {prompt_id, stop_reason, usage, elapsed_ms}`,
  `subagent_spawned/progress/finished`, `retry_state`, `response_completed`,
  `background_tasks`, `tool_call_delta_chunk`...), `_x.ai/session/prompt_complete`,
  `_x.ai/task_backgrounded`, `_x.ai/task_completed`, `_x.ai/queue/changed`,
  `_x.ai/sessions/changed`, `_x.ai/models/update`, `_x.ai/mcp/*`.
- Methods we can call [v from source, not run signed in]: `_x.ai/auth/*`,
  `_x.ai/billing`, `_x.ai/session/usage`, `_x.ai/interject`,
  `_x.ai/queue/*`, `_x.ai/rewind/points|execute`,
  `_x.ai/session/fork|rename|delete`, `_x.ai/models/list`,
  `_x.ai/commands/list`, `_x.ai/skills/*`.
- Caveat on "from source": the public mirror is at 1.0.45 (synced Sep 29);
  stable is 1.0.52 [v]. Source claims describe 1.0.45 until checked live.

## Design

### Process

- Command: `<grok> --no-auto-update --permission-mode <mode> agent --no-leader [--always-approve] stdio`.
  Top-level flags go before `agent`, agent flags after it; the wrong order is
  a clap error (exit 2) [v]. `--no-leader` keeps our session out of a shared
  leader process (`~/.grok/leader.sock`, self-updating hourly) that a user's
  `[cli] use_leader` or a remote xAI setting can turn on; only the flag
  overrides it [v]. `--no-auto-update` is parsed but hidden from `--help` [v].
- Env: inherited env with `GROK_DISABLE_AUTOUPDATER=1` (non-TTY stdio does
  not stop the stdio agent's self-update [v]),
  `GROK_OAUTH2_REFERRER=threadlines` (xAI's attribution tag; T3 sends `t3code`)
  [v], and `XAI_API_KEY` / `GROK_CODE_XAI_API_KEY` removed plus
  `GROK_DISABLE_API_KEY_AUTH=1` unless the user chose API-key billing on that
  instance. With a key in the env, `initialize` alone makes `xai.api_key` the
  session's auth method, so every turn bills per token with no `authenticate`
  call [v: live, `acp_agent.rs:514-528`]; an expired session also falls back to
  it, and `authenticate xai.api_key` writes the key into `auth.json` [v].
  Nimbalyst, yepanywhere and zeroclaw strip it too [v].
- `initialize`: `_meta.clientType: "extension"` (without it, Auto-mode blocks
  are silent denials instead of prompts, per Grok's own permissions doc and T3
  #13732) [v]; client fs and terminal off (with fs on, Grok routes every read
  through the client, T3 #13623) [r]; and
  `clientCapabilities._meta["x.ai/folderTrust"].interactive = true` (below).
- **Folder trust (blocks project instructions by default).** Under ACP stdio
  Grok treats every folder as untrusted unless the client opts in to its trust
  prompt, and then silently ignores the repo's AGENTS.md/CLAUDE.md, `.mcp.json`,
  project `.grok/config.toml`, hooks and skills [v: live, `grok inspect --json`
  showed `projectTrusted:false, projectInstructions:[]`; `GROK_FOLDER_TRUST=0`
  loaded them]. AGENTS.md and CLAUDE.md are trust markers themselves
  (`xai-grok-workspace/src/folder_trust.rs:539-543`), so almost every real repo
  is gated [v]. The gate is on unless `GROK_FOLDER_TRUST`, config, managed
  config or a remote xAI flag turns it off (`folder_trust.rs:142-150` in
  permission-rules) [v]. Opt in and answer `_x.ai/folder_trust/request
{sessionId, cwd, workspace, configKinds}` with a question card ("Trust this
  folder? Grok will load its instructions, MCP servers and hooks"). The prompt
  is the path xAI built for GUI clients ("dormant" only because no client
  advertises it yet, `folder_trust_prompt.rs:1-16`) [v]. It runs detached for up
  to 30 minutes and never blocks a turn [v], and the grant is saved in Grok's
  trust store, so later sessions start trusted [v]. But a grant hot-reloads
  only MCP, plugins and hooks; project instructions and skills apply on the
  next agent build [v]. So: hold the thread's first prompt until the card is
  answered, and after a grant reopen the session (`session/load`) before
  sending it [i]. Grok's hidden `--trust` flag is wired only into the TUI and
  headless paths, not `agent stdio` [v]. Not `GROK_FOLDER_TRUST=0`: repo hooks
  and MCP servers run code, so the user should decide [i]. Verify live.
- **Signed-out probes write state.** A signed-out `session/new` still writes a
  session folder, logs, `agent_id`, docs and `config.toml` into `GROK_HOME` [v].
- One process per thread, lazy, as our core does today. Realpath the cwd
  (`/tmp` vs `/private/tmp`) [r].
- Generic core change: pass `runtimeMode` (and interaction mode) to
  `descriptor.spawn` (`AcpProviderRuntime.ts:75` passes only settings, cwd and
  env) [v]. Argv beats a repo's committed `.grok/config.toml` or
  `.claude/settings.json` that sets always-approve [r]. A mode change already
  restarts the session (`ProviderCommandReactor.ts:1304-1370`) [r].

### Install, update, versions

- **Binary lookup:** settings `binaryPath` (default `grok`), then PATH, then
  `~/.grok/bin/grok(.exe)` (the installer edits shell profiles, so a running
  server won't see the new PATH; same pattern as `opencode/OpenCodeBinary.ts`) [i].
- **Install (one click, every platform):** xAI's own installer.
  macOS/Linux `curl -fsSL https://x.ai/cli/install.sh | bash`, Windows
  `irm https://x.ai/cli/install.ps1 | iex`, through `descriptor.install`
  (Cursor's pattern, `CursorAcpSupport.ts:760-767`) [v]. Run it with
  `GROK_CHANNEL=stable` and `~/.grok/bin` prepended to its PATH so it skips the
  `~/.local/bin` force-links (`install.sh:419`) [v]. It still edits the shell
  profile and adds `agent`, which is what installing Grok means; the Cursor fix
  above handles the collision.
- **Update (one click):** pick by installer, never assume. Grok's updater knows
  only npm, internal, gh-release and WinGet; it treats Homebrew and Scoop
  installs as internal and would write a second copy into `~/.grok/bin` [v].
  So, after resolving links: Homebrew `Caskroom/grok-build/` (it's a cask, so
  not `Cellar`) → `brew upgrade --cask grok-build`; Scoop path →
  `scoop update grok-cli`; WinGet path → `winget upgrade --id xAI.GrokBuild -e`;
  otherwise `<resolved grok> update` (npm and internal) [i]. Run updates with
  the installation's own environment (default `GROK_HOME`), never an extra
  account's: the internal updater writes to `grok_home()/bin`
  (`auto_update.rs:1710`), so an account's `GROK_HOME` would get a private copy
  nobody runs [v]. Lock by installation path, and re-read the version at the
  path we execute afterwards. Don't pass `--stable`: it switches and saves the
  user's channel [v].
  "Update available" from `grok update --check --json` (`updateAvailable` is
  false when an alpha build is ahead of stable) [v]; it needs `npm` on PATH for
  npm installs, else `latestVersion` comes back null [r].
- **Considered and rejected: a Threadlines-owned copy** (Antigravity's model)
  from the npm platform package `@xai-official/grok-<platform>` (no scripts,
  npm sha512 integrity) [v]. It avoids the profile edit and the `agent` alias,
  but `grok update` would then write into the shared `~/.grok/bin` anyway, the
  user's terminal would run a different copy, and our other providers (Cursor,
  OpenCode) already install through the vendor's script [i].
- **Integrity:** xAI publishes no checksums [v]. macOS builds are Developer ID
  signed (team 5Y6N3AJ54S) and Windows `.exe` files carry an EV Authenticode
  signature from X.AI LLC [v]; checking the signature after install is cheap
  [i]. Homebrew, WinGet and Scoop packages are community repackagings, not
  xAI's [v].
- **Versions:** below 1.0.13 the backend answers 426 (T3 #14486) [r]. Set our
  floor at the oldest stable we test on (1.0.52 today), with an Update action
  in the notice [i].

### Sign-in, sign-out, account

- **Status (no browser, no session):** one `initialize` from a scratch folder,
  then `_x.ai/auth/info` → `{methodId, email, team, ...}` (nulls signed out)
  [v], plus `defaultAuthMethodId`. Never `authenticate` or `session/new` in a
  health check: authenticate can open a browser, session/new starts the user's
  MCP servers and leaves a session folder [v]. Not `grok models` text parsing
  (exits 0 either way; T3's false sign-outs #14285) [v].
- **Starting a session:** `session/new` needs an auth method set, and
  `initialize` sets `cached_token` only when a credential exists [v]. So call
  `authenticate cached_token` only when `defaultAuthMethodId` says
  `cached_token`. Signed out, that call falls through to an interactive login
  that opens a browser on the server and blocks, and `_meta.headless` does not
  stop it [v: source]. Signed out means "Sign in" on the chat, never a silent
  authenticate.
- **Sign in (one click):** in a sign-in process, `authenticate {methodId:
"grok.com", _meta: {request_seq}}` (it blocks until done) and in parallel poll
  `_x.ai/auth/get_url` → `{auth_url, mode: loopback|device|command}` [v from
  source]. Grok opens the browser on its own computer in both flows [v]. On
  the server's own computer that's the loopback flow, and we show the address
  too. From a phone or another computer, start the sign-in process with
  `GROK_LOGIN_DEVICE_FLOW=1` so `get_url` returns a device-code page that works
  from anywhere (RFC 8628) [v: source 1.0.45, string present in 1.0.52; not run],
  with `_x.ai/auth/submit_code` paste-back as the loopback fallback (our
  Antigravity pattern). xAI can flip the default flow remotely, so handle every
  `mode` [v]. Cancel with `_x.ai/auth/cancel {request_seq}`. Grox and four
  other apps ship this flow [r]. Fallback if the ACP flow fails: `grok login
--device-auth` in the sign-in terminal [r].
- **Signed in is not "can run":** an account without a qualifying plan hits a
  paywall gate (`grok_build_access_gate`); the sign-in response `_meta`
  carries email, tier and `gate {message,url,label}`, and
  `_x.ai/auth/check_subscription` re-checks it [v from source]. Show the gate
  as its own state with xAI's link, not as "signed out".
- **Sign out:** `_x.ai/auth/logout` returns `{ok, was_logged_in, email,
api_key_still_set}` [v from source]. Follow Will's rule: no Sign out on the
  default instance, which shares `~/.grok` with the terminal; Sign out only on
  extra accounts (own `GROK_HOME`).
- **API key (Will, 2026-10-15: offer both, sign-in is the default):** a stored
  session token beats `XAI_API_KEY` (xAI docs: "If you have already signed in
  interactively, the stored session token takes precedence") [v], so a key on
  the default instance would be ignored while the user is signed in. Make
  API-key billing its own Threadlines-owned profile (private `GROK_HOME`, no
  session token) with the key stored as a sensitive instance variable
  (`XAI_API_KEY`, forced secret in `serverSettings.ts` `isAlwaysSensitive`),
  and say "billed per use by xAI" wherever the instance shows [i]. Don't use
  `_x.ai/setApiKey`: it writes the key into `auth.json` [v].

### Session behavior

- **Models and effort:** standard `configOptions` `model` and
  `reasoning_effort` (category `thought_level`) through
  `session/set_config_option` [v]; our mapped configOptions path handles this
  (the "older `models` field" concern was refuted) [v]. Catalog before any
  session from `initialize._meta.modelState` [v]. Map `reasoning_effort` to our
  effort control and test that it reaches chat sessions (T3 #15251) [v].
- **Runtime modes:** Approval required → `--permission-mode default`; Auto →
  `--permission-mode auto` (Grok's classifier, still asking for blocked
  actions); Full access → `agent --always-approve` [v]. Plan → Grok's plan mode
  plus `_x.ai/exit_plan_mode` [i: check `--permission-mode plan`].
- **Approvals:** never answer `allow_always` for bash/monitor/MCP: it writes a
  permanent project-wide grant to `~/.grok/sessions/<cwd>/permission_*.toml`
  [v]. Full access already answers "allow once" (Antigravity PR) [r].
  `allow-edits-session` maps to "accept for session" [v]. Rejecting any prompt
  ends Grok's turn [v].
- **Questions and plans:** `_x.ai/ask_user_question` → `requestUserInput`
  (reply `{outcome:"accepted", answers:{<question>:[labels]}}`, free text as
  label "Other" plus notes) [v]; `_x.ai/exit_plan_mode` → proposed-plan card,
  reply so the turn doesn't hang (T3 answers `abandoned` with feedback; Grok
  intercepts it even under always-approve) [v]. An error reply makes Grok treat
  the client as gone, cancel the turn and stay in plan mode, which is what our
  method-not-found does today [v: source 1.0.45]. Replies mean
  [v: `tool_calls.rs:281-295`]: `approved` leaves plan mode and starts an
  implementation turn, `cancelled` stays in plan mode and starts a revise turn,
  `abandoned` leaves plan mode and waits. Never answer `approved` without the
  user; anything we can't show (unsupported UI, malformed request, teardown)
  fails closed with `abandoned` (Sol review, 2026-10-15). plan.md writes under
  `$GROK_HOME/sessions/.../plan.md` show live [r]; `_x.ai/mcp/elicit` blocks the
  turn and needs a typed reply (cancel or a result) [v].
  Todo lists are plain ACP `plan` updates and already work [r].
- **Prerequisite in effect-acp:** extension requests are handled inline on the
  stdin reader (`protocol.ts:240-249`, routed at `:301-305`, the reader at
  `:369-410` processes lines in order) [v]. While a question or trust card
  waits for the user, no later response, update or EOF from the agent is
  read. Cursor's `cursor/ask_question` already does this today [v]. Handle ext
  requests concurrently in a scope that is cancelled on teardown, before
  adding any human-answered extension.
- **Turn end:** race `session/prompt` against `_x.ai/session/prompt_complete`
  and `turn_completed` matched on an injected `_meta.promptId` (T3 #3156,
  #3839). Current builds resolve the RPC right after, so this is a guard, not a
  known hang [v]. `stopReason: rate_limit` → usage-limit failure;
  `stopReason: error` arrives before the RPC error and carries Grok's message
  [v].
- **Background shells, monitors, subagents (the big one):** Grok's
  subagents and background shells outlive the root turn and start their own
  "wake" turns (`task-completed-*`, `subagent-completed-*` prompt ids) [v].
  Our ACP core emits no `task.*`/subagent events and has no agent-started turns
  (Claude's adapter has `ensureSyntheticTurn`) [v]. Build these in the generic
  ACP core behind descriptor hooks, with an upper bound on how long background
  work may hold a turn (T3 has none and users saw 9-16 h holds, #15888) [v].
  End signals: `_x.ai/task_completed` (dedicated method on the wire; the
  `_x.ai/session/update` form is the persisted log), TaskOutput hydration
  (ids can be `call-<uuid>-N`), a completed kill (`KillTask`), and
  `subagent_finished` on the parent session [v].
- **Stop:** after the cancel fix, send `session/cancel` with
  `_meta.cancelTrigger: "ctrl_c"`. Grok's ACP cancel leaves background tasks
  running (`kill_background_tasks` defaults to false, `acp_agent.rs:1933`,
  `session/commands.rs:306`) [v], and our adapter recycles the process only
  when a prompt outlives the 15 s deadline (`AcpAdapter.ts:1468`) [v]. So once
  cancel works, background shells would outlive Stop. Add a generic,
  descriptor-selected teardown policy: a user Stop, during or between turns,
  ends the process tree we spawned and the next turn resumes (T3:
  `restartRuntimeAfterInterrupt` plus process-group teardown) [v]. Steering a
  running turn: `_x.ai/interject` (≥1.0.14) [r].
- **Tool output:** Grok resends the whole terminal buffer on every
  `tool_call_update`, ~10/s at 145 KB+ [r]. Our core turns each update into an
  event carrying the full raw payload (`AcpCoreRuntimeEvents.ts:187-220`) and
  has no size cap [v]. Add a generic tail cap (T3: 8 KB) and coalescing for
  in-progress updates [v: T3's numbers, 31.6 MB → 2.5 MB on a 1000-update
  flood].
- **Resume and crashes:** `session/resume` (advertised) or `session/load`
  with a replay-idle finish (Grok's load could hang, T3 #3156) [v]; a crashed
  process retires the session and the next turn resumes [r].
- **Images:** advertised `image:false`, but the prompt parser accepts image
  blocks and T3 sends them [r]. Test live before turning on.
- **Skills and slash commands:** from `available_commands_update` /
  `_x.ai/commands/list`; a skill runs only as `/name` at the very start of the
  first text block (T3 #13457) [r]. Hide `always-approve` (bypasses our
  approvals) and `context` (no output over ACP) [r].
- **MCP:** Grok adds our session MCP servers (browser, room tools) to the
  user's own, including ones it auto-imports from Claude Code and Cursor
  configs [v].
- **Text generation** (titles, commit messages): one short ACP session through
  `AcpTextGeneration.ts` with `isolateTextGeneration: true` (runs in an empty
  temp folder, like Antigravity, `AcpTextGeneration.ts:86-90`), because in a
  trusted repo Grok's startup hooks and MCP servers would otherwise run before
  the refused tool calls protect anything [v].
- **Context meter:** `session/update._meta.totalTokens` [r].

### Accounts

Extra accounts are extra instances with `GROK_HOME=<accounts folder>` [v].
`GROK_HOME` alone isn't enough: an inherited `GROK_AUTH_PATH` wins over it
(`xai-grok-login/src/storage.rs:47-55`) and `GROK_AUTH` supplies inline
credentials (`manager.rs:341-356`) [v], so an account's Sign out could clear
the terminal's login. Remove both (and the API-key variables) for every
Threadlines-owned profile, and use the same environment for status, sign-in,
chat, billing and sign-out.
Keep `auth.json` private; link config, rules, skills, agents and `sessions`
back to the main `~/.grok` so threads move between accounts with a native
resume (continuation key from the main home), like Claude's account overlay
[i]. The binary stays in `~/.grok/bin` (installers ignore `GROK_HOME`) [v].
Unverified: that `grok login`/`authenticate` writes to the custom
`GROK_HOME/auth.json` (needs one real sign-in).

### Usage

- **Limit meters:** `_x.ai/billing` → `creditUsagePercent`, `currentPeriod
{type: WEEKLY|MONTHLY, start, end}`, `subscriptionTier`, on-demand cap and
  prepaid balance [v from source; signed-out returns auth required]. A missing
  percent means nothing metered yet, not unsupported (T3 #12799) [v]. New
  `accountUsage.source` literal `grok-billing`; the ACP probe can already
  return `accountUsage` (`providerSnapshot.ts:46`) [r]. Report the email so one
  subscription merges across computers (T3 #12588) [r].
- **Usage page:** `$GROK_HOME/sessions/**/updates.jsonl` `turn_completed`
  usage with `costUsdTicks` (1 USD = 10^10 ticks), deduped by
  `sessionId:prompt_id:model` [r]. New `UsageProviderKind`.

### Surfaces

Full list with paths in `/tmp/grok-synth/ours.md` §2 [v]. Main ones: driver
registration (`builtInDrivers.ts`), contracts settings (new `GrokSettings` and
the legacy `providers.grok` block, without which no default instance exists),
model ids and display names (`contracts/model.ts`), `shared/acpRegistry.ts`
built-in ids, `shared/providerAuthCommands.ts` and `providerAuth.ts`, web icon,
driver meta (drives onboarding), picker options, settings card, usage labels,
telemetry driver keys, docs (`AGENTS.md` glossary, `community-agents.md`, new
`docs/providers/grok.md`) and the marketing provider strip.

### Moving off the community agent

Add `grok-build` to `ACP_REGISTRY_BUILT_IN_AGENT_IDS` [v]. That also hides an
existing community install from update checks [v], so add a small generic
"graduated agent" map (agent id → driver) that shows "Use the built-in Grok"
with Remove on an installed graduated agent [i]. Threads move by the existing
recap handoff [v]. PostHog shows no grok-build community installs in the last
30 days [r], and the install fails on macOS/Linux anyway (above).

## Testing

- Replay fixtures recorded from the real CLI, the way T3 records them
  (`record-grok-acp-replay-fixture.ts`): simple, multi-turn, steering,
  interrupt, questions, plan exit, background shell, monitor, subagent,
  prompt error, auto-mode blocked command [r]. Port the scenarios, record our
  own.
- A strict mock agent: T3's lenient mock hid the malformed-cancel bug [v].
- An opt-in live test against a real signed-in `grok`, like `OpenCodeLive`.
- Live checks in a throwaway stack: install, update, sign-in (local and
  paste-back), sign-out on an extra account, each runtime mode, approvals,
  questions, plan card, background shell and subagent, Stop, resume after
  restart, usage meter, Windows install and update.

## Will's decisions (2026-10-15)

1. **Testing account:** Will has an X Premium account for live checks. Use a
   throwaway stack with its own HOME and sign in there, so Will's terminal
   Grok (if any) is untouched. The paywall gate tells us whether X Premium
   includes Grok Build.
2. **Billing:** offer both subscription sign-in (default) and an xAI API key
   (per use, own profile, see Sign-in).
3. **Install:** one-click install runs xAI's own installer; ship the Cursor
   binary-lookup fix first.

## Review dispositions (GPT-6.1-Sol, 2026-10-15)

All eight findings checked against the Grok 1.0.45 source and our code, and
accepted: (1) `GROK_AUTH_PATH`/`GROK_AUTH` beat `GROK_HOME` for accounts; (2)
never auto-approve a plan exit; (3) effect-acp handles ext requests inline on
the reader; (4) a trust grant doesn't load instructions until the agent is
rebuilt; (5) Stop needs a background-process teardown policy; (6) the
Homebrew package is a cask (`Caskroom`); (7) updates must use the
installation's environment, not an account's; (8) text generation must run
in an empty folder. Sol's side note, that a Threadlines-owned copy could
replace its own download instead of relying on `grok update`, is fair; Will
chose xAI's installer, so it stays rejected.

## Order of work

1. Separate fixes: ACP notification encoding (all ACP agents), Cursor binary
   lookup (`cursor-agent` first, refuse a Grok `agent`).
2. Generic ACP core: concurrent ext request handling in effect-acp, runtime
   mode to spawn, initialize/cancel `_meta` hooks, ext request/notification
   hooks for questions and plans, prompt-completion hook, Stop teardown
   policy, tool-output cap, background tasks/subagents with agent-started
   turns.
3. Grok descriptor and extension: process, install/update, sign-in/out,
   models/effort, modes, approvals, questions/plans, text generation, all UI
   surfaces, docs, community-list graduation.
4. Accounts, usage meters, usage page.
5. Steering, revert/fork, context meter.

Size: about Antigravity's (#374, 73 files) plus the generic background-work
core [i].

## As built (2026-10-15, in progress)

Branch `feat/grok-build-provider`, on top of PR #461 (the Stop and Cursor
fixes).

Generic ACP core (every ACP agent can use these; Grok is the first):

- Extension requests run beside the protocol reader, so a question card
  never stalls the agent's other messages (Cursor's `ask_question` did).
- The descriptor sees the runtime mode at launch, and can add `_meta` to
  `initialize`, `session/cancel` and each `session/prompt`.
- Agent turns (`agentTurns`): output after the session opened is live, not
  replay; a turn opens on the extension's notice or on first output, and
  closes on the agent's end notice, on the user's next message, on Stop (same
  15 s deadline as a prompt), or after 15 quiet minutes. A tool call that
  started in an earlier turn keeps reporting to that turn.
- Updates for another session id (a subagent's) never reach the thread.
- Extensions can emit task and subagent events, report how the running prompt
  ended (a failed turn shows the agent's own words), and mark permission
  options whose "always" outlives the session (never offered or chosen).
- `session/close` before the process ends, for agents that advertise it.
- Steering (`descriptor.steer`), per-turn session mode
  (`sessionModeForTurn`), a context fill read from the agent's own updates
  (`contextUsage`), and a continuation key shared by instances that keep one
  conversation store (`continuationKey`).

Decisions that differ from the plan above:

- **Folder trust: off (`GROK_FOLDER_TRUST=0`).** Grok spawns its trust
  question just before it answers `session/new`, so it can land on either
  side of the first prompt, and a session only opens when the first message
  is sent: the first turn in every new project would run without the repo's
  AGENTS.md. Opening a project in Threadlines trusts it, as it does for Claude
  and Codex. Flag for Will.
- **Stop keeps background shells.** Grok's cancel can't kill them (only
  `session/close` does), and Claude's background shells also outlive Stop in
  Threadlines. `session/close` at session end stops them.
- **No prompt hang guard.** Recordings show `session/prompt` answers right
  after `prompt_complete`.
- **No extra tool-output cap.** In-progress tool updates only reach the
  thread when their title or summary changes, and the activity projection
  already compacts stored payloads.
- **API key billing runs in its own sign-in-free `GROK_HOME`**, laid over
  the folder the instance would otherwise use (an account's, or `~/.grok`),
  because Grok prefers a stored sign-in to a key. Instances share a
  continuation key when their real `sessions` folder is the same.
- **Revert and fork map by message, not by turn count.** Each turn records
  where its prompt sits among `_x.ai/rewind/points` (matched by the
  preview's text, first after the previous turn's position), asked once the
  turn has ended; the positions ride in the ACP resume cursor (last 200
  turns) and are saved when a session stops. A revert rewinds to the first
  reverted message's prompt (`_x.ai/rewind/execute`, `conversation_only`;
  only `success: true` counts). A fork copies the session
  (`_x.ai/session/fork`), opens the copy, and rewinds it to the boundary; a
  boundary it can't place exactly (no position, or a Grok wake-up turn right
  after it) fails the native fork and the thread is seeded from a recap.
  Live-verified on Grok 1.0.52 with X Premium (2026-10-15): points come as
  `rewind_points[{prompt_index, prompt_preview}]` with the preview being the
  prompt's first line; a steer adds no point; `rewind/execute` needs
  `force: true` (without it: `success: false`, `error: null`) and drops the
  target prompt and everything after it; `session/fork` takes
  `{sourceSessionId, sourceCwd, newCwd, targetPromptIndex}` and copies
  through that prompt, inclusive, so a fork needs no rewind of the copy. A
  revert of message 2 of 3 left Grok remembering only the first; a fork
  before message 4 knew only the first; Stop settled in 0.2 s; plan mode
  gave a plan card and wrote nothing.
- **Check key asks xAI** (`GET /v1/models`, free) before Grok's own pick
  (`defaultAuthMethodId`); a run right after a method or key change waits
  for the instance rebuild (`builtFrom`).
- **Usage history reads `~/.grok/sessions` only** (with `GROK_HOME` from the
  server's environment), as Claude and Codex read their main folders: an
  account folder with sessions of its own isn't counted.

- **Grok's own turns, in order with its updates.** Its turn starts
  (`queue/changed` naming a prompt that isn't ours, once per prompt id: the
  notice repeats as the queue moves) and ends (`turn_completed`) arrive as
  notices beside the update stream. Each one is queued where it arrived
  among the updates (`markAgentTurnBoundary` ends the reply there, `inOrder`
  hands the work to the reader), so a wake-up that starts before the
  prompt's answer, or two back to back, each get their own output. A prompt
  whose turn is still open when its wake-up begins closes without waiting
  for the reader (it has had all its output); the wake-up opens once it has.
  What the extension emits that names the running turn (tasks, subagents,
  plans) goes through the reader too, a new message waits for the reader to
  catch up before it starts, and a question or approval names its turn once
  the reader has reached it.

- **Setup on a fresh install, live (temp HOME):** tile, one-click Install
  (no `~/.local/bin` links), then Sign in with Grok, Ready. Seen there, in a
  first switch-on of a provider that isn't installed: the row sometimes kept
  "Install guide" until the next refresh. One cause found and fixed in the
  shared managed provider: an enrichment published at its check's own
  `checkedAt`, so the registry, reading a new instance and streaming it at
  once, could keep the plain copy. Enrichments are now dated after the check.
  The other cause: the registry forked a provider's change stream and then
  read its snapshot, but a stream subscribes only when first pulled, so an
  update in between was lost. Managed providers now offer `streamSnapshots`
  (joined under the lock that orders every change and its publish: the
  current snapshot, then every change), and the registry follows it with one
  fiber. 3 of 5 first switch-ons failed before; 3 of 3 showed Install after.

Sol review, round 2 (2026-10-15): fixed the account-removal sign-out
inheriting `GROK_AUTH_PATH`/`GROK_AUTH`, steer-vs-prompt preview matching,
forks keeping a following wake-up turn, prompt positions lost when an idle
session is reaped, two wake-up replies sharing one message id, a wake-up
lost while the position was being asked, signed-in accounts switched to an
API key keeping their sign-in, unknown rewind answers counting as success,
steering dropping file notes, and a failed resume dropping the new
session's early updates (all ACP agents). Not changed: usage history for
independent Grok folders (above), and folder trust (flagged for Will).
Round 3 fixed a wake-up that starts as a prompt's turn closes (above), a
stop losing the last prompt's position, a steer from an earlier turn taken
for the next prompt, stale overlay links when an account's folder drops a
file (kept when the user re-pointed them), and the continuation key before
Grok makes its sessions folder. Round 4 (narrow) left the edge above.
