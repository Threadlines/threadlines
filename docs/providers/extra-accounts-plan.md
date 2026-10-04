# Extra accounts: build plan (2026-10-04)

Piece 2 of the four Will approved on 2026-10-04 (see `agent-setup-plan.md`).
Stacked on piece 1 (PR #381, branch `threadlines/redesign-provider-onboarding`);
this branch is `feat/provider-extra-accounts`.

## What Will approved (mockup)

- An agent's opened row in Settings › Providers offers "Add another Claude
  account". It opens a small inline form: Name, Color (five swatches, live
  badge preview), one line ("It gets its own private folder, so signing in here
  won't sign you out of Claude in your terminal."), a "Use a folder I choose"
  link, Cancel and "Sign in to Claude".
- Submitting creates the account and goes straight to sign-in. A new row
  ("Claude · Work", logo with a colored letter badge) appears under the agent
  and walks through signing in → checking → ready with its own account line
  and usage.
- The colored letter shows wherever the account appears: Settings, the model
  picker and the thread. Each account shows its own usage, so the picker tells
  you which one has room.
- Claude, Codex and Antigravity first. Cursor, OpenCode and fx only if a second
  copy can keep its own login (checked below); otherwise the button stays
  hidden for them.

## What exists today

- Multi-instance plumbing is done: `ProviderInstanceConfig` (`displayName`,
  `accentColor`, `driver`, `config`), per-instance snapshots, picker entries,
  `ProviderInstanceIcon` badge (initials + accent), and `continuation.groupKey`
  (instances sharing a key can take over a thread with native resume;
  `ChatComposer` locks a running thread to its group).
- Adding one means the "+" wizard (`AddProviderInstanceDialog`): pick a driver,
  type a label and an instance id, then hand-type a folder path into the
  driver's config form. Nobody will do this.
- **Codex** already has the right model: `homePath` (shared `CODEX_HOME`,
  default `~/.codex`) plus `shadowHomePath`, an overlay folder that keeps
  `auth.json` private and symlinks everything else back to the shared home
  (`Drivers/CodexHomeLayout.ts`). Threads, sessions, config, skills are shared;
  the continuation key is the shared home, so a thread can move between Codex
  accounts with native resume. Sign-in already sets `CODEX_HOME` to the shadow
  home (`packages/shared/src/providerAuthCommands.ts`).
- **Antigravity** already gives every instance its own `GEMINI_HOME` under the
  state dir, keyed by instance id, with file-only credential storage
  (`antigravity/AntigravityProfile.ts`). A second instance is a second account
  with no config at all.
- **Claude** only has `homePath`, which overrides `HOME` for the CLI
  (`Drivers/ClaudeHome.ts`). That is the wrong tool for accounts:
  - the agent's own shell commands inherit the fake `HOME`, so they lose the
    user's git identity, SSH keys, `gh` login, npm/pip config;
  - on macOS it also moves the keychain lookup, so the login silently falls
    back to a plaintext `.credentials.json` (T3 Code hit this and moved to
    `CLAUDE_CONFIG_DIR`; their docs now say "Setting HOME instead can put
    credentials where this provider will not find them");
  - the second account sees none of the user's `CLAUDE.md`, settings, skills,
    agents or plugins.
- **Claude usage reads the wrong account.** `ClaudeUsage.readClaudeOAuthCredential`
  reads `<home>/.claude/.credentials.json`, then falls back to the _default_
  keychain entry `Claude Code-credentials` for every instance. Any extra Claude
  instance without a plaintext file shows the terminal account's usage.

### Verified in Claude Code 2.1.289's shipped source

The keychain service name is
`"Claude Code" + OAUTH_FILE_SUFFIX ("" in production) + "-credentials" + suffix`,
where `suffix` is empty unless `CLAUDE_CONFIG_DIR` is set, and otherwise
`"-" + sha256(configDir.normalize("NFC")).hex.slice(0, 8)` (the
`CLAUDE_SECURESTORAGE_CONFIG_DIR` override aside). The keychain account is
`$USER || os.userInfo().username` (falls back to `claude-code-user` when that
isn't `[a-zA-Z0-9._-]+`). So a login made with `CLAUDE_CONFIG_DIR` set lives in
its own keychain item and cannot overwrite the terminal's login; on Linux and
Windows it is `<configDir>/.credentials.json`. `.claude.json` (which holds
`oauthAccount`) moves into the config dir too.

## Design

Revised after Sol's review (findings and dispositions at the end).

### One server operation creates an account

The client may be a phone or another computer, so it cannot pick folders on the
server's disk. New RPCs (schemas in `packages/contracts`):

- `server.addProviderAccount({ driver, displayName, accentColor?, folder? })`
  → `{ instanceId }`.
  - Instance ids are permanent and never reused: `<driver>_<slug>_<4 random
hex>` (e.g. `claudeAgent_work_3f9a`). Old threads keep pointing at a
    removed id, so a reused id would silently hand them to a different
    account. The name stays an editable label.
  - Managed folder: exactly `<stateDir>/accounts/<instanceId>`, created `0700`
    with exclusive create, plus a provenance marker file
    (`.threadlines-account`, holding the instance id and driver). A folder the
    user chose is canonicalized (`realpath` of the nearest existing parent) and
    rejected when it lies inside `<stateDir>/accounts/`, equals or contains the
    main agent folder, or overlaps another account's folder.
  - The new instance copies the default instance's `binaryPath` and (Claude)
    `homePath`, so it runs the same CLI against the same main folder.
  - Settings are changed with a new `ServerSettingsService.updateSettingsWith`
    that computes the patch from the current settings inside the write lock, so
    a concurrent write can't be lost between read and write. A failed write
    deletes the folder it just created.
  - The RPC returns only after the provider registry has built the instance
    (snapshot published, Codex/Claude overlay materialized), so the client can
    start sign-in immediately. Per driver:
    - Codex: `config.shadowHomePath = <folder>`; shared home stays default.
    - Claude: `config.accountFolder = <folder>` (new field, below).
    - OpenCode: `config.accountFolder = <folder>` (new field): the instance
      runs with `OPENCODE_DB=<folder>/opencode.db`. Rejected when `serverUrl`
      is set.
    - Antigravity: nothing; its profile is already per instance id. `folder` is
      rejected.
- `server.removeProviderAccount({ instanceId })`, extra (non-default) instances
  only:
  1. stop any sign-in run for the instance;
  2. remove the instance from settings (`updateSettingsWith`), then wait for
     the registry to close it, which stops its sessions, probes and OpenCode
     server, so nothing can recreate the folder;
  3. write a cleanup record (`<stateDir>/accounts/.cleanup/<instanceId>.json`:
     driver, folder, binary, whether managed);
  4. for a managed folder (marker present, canonical path is exactly the
     allocated one): sign out with the agent's CLI (`claude auth logout` with
     `CLAUDE_CONFIG_DIR`, `codex logout` with `CODEX_HOME`; bounded timeout),
     then delete the folder. OpenCode's login lives in the folder's database, so
     deletion is the sign-out. Antigravity: delete its profile dir;
  5. delete the record. Server start retries leftover records, so a hung
     logout or a half-deleted folder is finished later rather than forgotten.
     A folder the user chose is never signed out or deleted.

The client starts sign-in through the new row's own connect-flow controller
(the row is mounted, then a pending-sign-in flag starts it, like piece 1's
pending install), so the browser-link handoff that only the owning controller
performs keeps working. If creation succeeds and sign-in fails to start, the
row stays with its normal "Sign in" button.

### Switching a thread between accounts

Today a same-agent switch between instances with different continuation keys is
refused, and a thread whose instance was removed fails before the requested
replacement is even looked at (`ProviderCommandReactor.ts` resolves the old
instance first).

- Server: a same-agent switch with a different continuation key becomes the
  same seeded handoff as switching agents (rehydrate from the orchestration
  transcript). A missing current instance with a requested replacement is
  treated the same way instead of failing.
- Web: `classifyModelSwitch` returns the existing confirm-with-recap result
  for a same-agent, different-history pick instead of "blocked", and the
  composer stops hiding instances outside the locked group.
- Accounts that share history (Codex shadow homes, Claude account folders on
  the same main folder) keep native resume and switch without the recap.

### Codex: keep `secrets` private

Codex 0.160 can store the login encrypted in `<CODEX_HOME>/secrets/codex_auth.age`
with a passphrase keyed by that home (`login/src/auth/storage.rs`,
`secrets/src/local.rs`). The shadow overlay currently symlinks `secrets` to the
shared home, so a second account's login would land in the first account's
store. `secrets` joins `PRIVATE_ENTRY_NAMES` (an existing link is replaced by a
real directory). The direct-keyring backend is already per home
(`compute_store_key` hashes the canonical home path), and `auth.json` was
already private.

### Claude: an account folder overlaid on the main folder

New `ClaudeSettings.accountFolder` ("Account folder"): when set, the CLI runs
with `CLAUDE_CONFIG_DIR=<accountFolder>` and `HOME` untouched.

Three separate notions, each with one resolver in `ClaudeHome.ts`:

- **main folder** (what the instance would use without an account folder:
  instance env `CLAUDE_CONFIG_DIR`, else inherited, else `<homePath or os
home>/.claude`): overlay source and continuation identity, so the default
  instance and its accounts share a continuation key;
- **effective folder** (account folder, else main): `CLAUDE_CONFIG_DIR` for the
  process, transcripts, skills/settings/hooks reading, token-usage history;
- **credential identity**: the exact environment the CLI is spawned with
  (`HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `USER`).

Account instances run with `CLAUDE_SECURESTORAGE_CONFIG_DIR` removed (an
inherited empty value would point every folder at the terminal's keychain item)
and with ambient credential variables (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) removed unless set on the
instance itself, for runtime, probes, sign-in, sign-out and usage alike: an
account's credentials come only from its own folder or its own variables.

The overlay shares an **allowlist**, built from the folder names Claude 2.1.289
reads from its config dir (`strings` audit), because Claude keeps account state
beside config and an unknown future file is safer private than shared:

- Shared: instructions and extensions (`CLAUDE.md`, `rules`, `settings.json`,
  `keybindings.json`, `themes`, `skills`, `agents`, `commands`,
  `output-styles`, `plugins`, `workflows`, `agent-memory`, `memory`) and
  conversation state (`projects`, `file-history`, `todos`, `tasks`, `plans`,
  `shell-snapshots`, `session-env`, `uploads`, `history.jsonl`).
- Private: everything else, notably `.credentials.json`, `.claude.json`
  (`oauthAccount`), `.config.json`, `hfi-auth.json`, `remote-settings.json`,
  `policy-limits.json`, `statsig`, `telemetry`, `cache`, `sessions`, `state`,
  `daemon*`, `teams`, `usage-data`, `mcp-*`.

Materialization (shared module `provider/accountOverlay.ts`, extracted from
`CodexHomeLayout.ts`, used by both) runs at instance creation and before each
session spawn:

- Shared directories are created in the main folder first, so the account
  never starts a private copy (`file-history`, `plugins`, …). Shared files are
  never created (an empty `settings.json` would be invalid); if the account
  already has a real file and the main folder has none, the file is moved into
  the main folder and linked; if both exist, the account's copy is left alone
  and logged, never a hard failure.
- Links: symlink everywhere. Windows without symlink rights: directory
  junctions, and files are hard-linked and re-linked from the main folder on
  every materialization when an atomic save has split them (main wins;
  documented). A main entry that is itself a symlink (e.g. Will's
  `settings.json` → dotfiles) is linked by path, not resolved, so the user's
  link keeps working.

What this buys: the second account follows the user's instructions, rules,
settings, skills and plugins; its conversations land in the shared `projects`,
so threads move between Claude accounts with native `--resume` (checkpoints in
`file-history` come along) and the Usage page counts them. Known gaps:
user-scope MCP servers live in `.claude.json` (private), so they don't carry
over; a `settings.json` with `apiKeyHelper` or credential `env` applies to every
account, and the row then shows the API-key sign-in the probe reports.

This reverses a stance in `docs/providers/claude.md` ("Threadlines keeps
separate Claude homes isolated instead of trying to share part of the state"),
written for whole-`HOME` overrides, where sharing meant sharing the login. The
allowlist shares config and conversations only. `claude.md` and `codex.md` get
rewritten around the one-click flow (manual folders stay as the advanced path).
`homePath` stays for existing users; its description warns that it also moves
git/SSH config for the agent's commands and points to Account folder.

### Claude usage reads the right login

`readClaudeOAuthCredential` mirrors the CLI for the exact spawn environment:

1. macOS: `security find-generic-password` run **with that environment**
   (so a `HOME` override affects it exactly as it affects the CLI), service
   `Claude Code-credentials` plus, when `CLAUDE_CONFIG_DIR` is set,
   `-` + sha256(raw value, NFC only).hex[0..8] (vectors: `/tmp/work` →
   `…-f9be197a`, `/tmp/work/` → `…-1370e28d`), account `$USER` (else OS user;
   `claude-code-user` when not `[a-zA-Z0-9._-]+`);
2. then `<effective folder>/.credentials.json`;
3. nothing else: no fallback to another instance's item.

### Settings › Providers

- Rows: extra accounts sit directly under their agent, in the same In use / Not
  in use grouping, named "Claude · Work" with the badge (initial + accent) on
  the logo. Same `AgentRow`, same status line and actions.
- Opened row footer, for Codex, Claude, OpenCode and Antigravity: "Add another
  Claude account". It opens an inline form inside the opened row: Name
  (prefilled "Work", then "Personal", then "Account 2"…, never a name in use),
  five color swatches with the live badge, the one-line note, "Use a folder I
  choose" (reveals a path field; server validates), Cancel and "Sign in to
  Claude". Submit → `addProviderAccount` → the new row mounts and opens → its
  controller starts sign-in ("Signing in… finish it in your browser", Copy
  link, Cancel) → checking → account line + usage. A rejected folder keeps the
  form open with the server's message.
- Extra account footer: "Remove account" with a confirm whose copy depends on
  the folder: managed ("Threadlines signs Claude · Work out and deletes its
  private folder. Its threads can continue on another Claude account.") or
  chosen ("Threadlines stops using this account. Your folder and its login are
  left as they are."). Turn off/on as any row. Name and color stay editable in
  Configuration (exists today).
- Header "+": a small menu: "Add a Codex account", "Add a Claude account", "Add
  an OpenCode account", "Add an Antigravity account", then "Custom instance…"
  (the existing wizard, for power users). An account item opens that agent's
  row with the form showing; if the agent is off, the row opens with "Turn on
  Claude first".

### Model picker and threads

- The picker's agent list already shows one entry per instance with the badge.
  Each account gets a compact usage figure there, chosen by the same rule the
  Settings meter uses (spend control, else the tightest window), with the
  window and reset time in its tooltip, inside the fixed-width pane.
- Threads: every place a thread names its agent (per-turn agent line, composer
  picker button, room roster, sidebar hover) shows "Claude · Work" and the
  badge for extra accounts.

### Cursor and fx: no button

A driver gets accounts only if a per-instance env var moves its credential store
without touching `HOME`, any keychain item is keyed by that location, and its
sign-in honors the same var. Cursor and fx fail that (findings below), so their
rows show no "Add another account" and the "+" menu omits them. The custom
wizard still allows a second Cursor/fx instance (same login), as today.

## Surfaces checklist

- Contracts: two RPCs + errors, `accountFolder` on Claude and OpenCode,
  `homePath` description.
- Server: settings `updateSettingsWith`; accounts service (allocate, create,
  remove, cleanup records + startup retry); `accountOverlay.ts` (Codex + Claude);
  Codex `secrets` private; Claude resolvers used by `makeClaudeEnvironment`,
  `ClaudeDriver` keys, `ClaudeSessionTranscripts`, `ClaudeTokenUsageHistory`,
  `ClaudeUsage`, `ClaudeTextGeneration`, `providerExtensions.ts` (skills,
  settings, hooks, plugins), `UsageService` transcript dirs;
  `ProviderAuthSessions` + `providerAuthCommands` (`CLAUDE_CONFIG_DIR`,
  `OPENCODE_DB`, credential stripping); OpenCode runtime env; reactor handoff
  for same-agent different-history and missing old instance.
- Web: Settings rows + form + footers + "+" menu; terminal fallback commands in
  `ProviderInstanceCard.tsx` (they build sign-in commands client-side); picker
  usage; switch classification; thread naming surfaces.
- Clients: web and desktop share this; the phone uses the same RPCs.
- Reverse states: Remove account (stop, sign out, delete, retried on failure);
  turning an account off keeps its login.
- Not in setup (setup manages the six default instances only).

## Tests

- Server: id allocation (unique, never reused), folder validation (inside
  accounts root, overlaps, aliases), concurrent add + other settings write,
  remove order (registry closed before cleanup), managed vs chosen folder,
  cleanup record retry; overlay (allowlist linked, private entries real, shared
  dirs pre-created, adopt/keep rules for real files, stale links fixed, symlinked
  main entry preserved); Codex `secrets` private; keychain service name vectors;
  usage lookup matrix (`homePath` × `accountFolder` × instance/inherited
  `CLAUDE_CONFIG_DIR` × `CLAUDE_SECURESTORAGE_CONFIG_DIR`); auth command env;
  reactor: same-agent different-history handoff, removed-instance handoff.
- Web: default-name and "+" menu logic; switch classification; browser test for
  the inline form → RPC → sign-in start on the new row; picker usage figure.
- Live (throwaway stack, fake `HOME`/`THREADLINES_HOME`): add a Codex and a
  Claude account, folder contents and links, sign-in reaches the browser page,
  remove cleans up. A real second-account sign-in needs Will (spare accounts).

## Findings: Cursor, OpenCode, fx (checked 2026-10-04, read-only)

| CLI (version)             | Login stored in                                                                                                                                                                                 | Isolating env var                                                                         | Verdict     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| Cursor `agent` 2026.05.05 | macOS keychain `cursor-access-token` / `cursor-refresh-token` / `cursor-api-key`, account always `cursor-user`; Linux `$XDG_CONFIG_HOME/cursor/auth.json`; Windows `%APPDATA%\Cursor\auth.json` | none on macOS (store name hard-coded); `XDG_CONFIG_HOME` / `APPDATA` elsewhere, too broad | unsupported |
| fx 0.0.12                 | macOS keychain `FX_OAUTH_SESSION_V1` (+ gateway key, MCP OAuth), account = OS user; `~/.fx/*-auth.json`                                                                                         | none; every path derives from `HOME`                                                      | unsupported |
| OpenCode 2.0.22           | SQLite `opencode.db` (`credential` table) in the data dir; no keychain                                                                                                                          | `OPENCODE_DB=<folder>/opencode.db`                                                        | supported   |

- Cursor: `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR` move config only; a second
  `agent login` overwrites the shared keychain tokens. `CURSOR_API_KEY` saves
  its exchanged tokens into the same entry.
- fx: native binary, only `HOME`/`USERPROFILE`; `FX_DISABLE_KEYCHAIN` still
  writes under `~/.fx`. Per-process `AI_GATEWAY_API_KEY` covers gateway keys
  only, and the chosen source is persisted in shared `~/.fx/settings.json`.
- OpenCode: `database-path.ts` reads `OPENCODE_DB`; `auth login --standalone`
  starts its private server with the caller's env, so sign-in honors it.
  Verified with the installed 2.0.22 in `/tmp`: `debug paths` and
  `serve --stdio` use the given DB, and a fresh DB starts with no credentials
  (legacy `auth.json` import is skipped for a new DB). Sessions and projects
  move with the DB (OpenCode's continuation key is already per instance, so
  nothing changes there); config, plugins, logs and cache stay shared. Not
  tested: a real second login.
- T3 Code offers accounts only for Codex, Claude and Grok.

## Review dispositions (GPT-6.1-Sol, 2026-10-04)

All sixteen findings checked against code or binaries; all accepted.
1 `CLAUDE_SECURESTORAGE_CONFIG_DIR` stripped for accounts. 2 Codex `secrets`
private (verified in Codex 0.160 source). 3 provenance marker + exact allocated
path + canonical validation. 4 seeded handoff for removed instances and
same-agent different-history switches (verified `ProviderCommandReactor.ts`
resolves the old instance first). 5 remove stops the instance before cleanup;
cleanup records retried at start. 6 `updateSettingsWith` under the write lock
(stale whole-map client writes remain a pre-existing limitation, noted). 7
permanent random-suffixed ids. 8 usage lookup mirrors the CLI's environment,
keychain first, raw NFC hash input. 9 main / effective / credential resolvers.
10 shared dirs pre-created; adopt/keep rules for files. 11 allowlist rebuilt
from the binary's config-dir names (`rules`, `workflows`, `themes`,
`keybindings.json`, `agent-memory`, `memory`, `uploads`). 12 ambient
credentials stripped for accounts; shared `apiKeyHelper` documented and shown
via the probe. 13 Windows hard links re-linked from main on each
materialization; symlinked main entries linked by path. 14 missed surfaces
added. 15 RPC waits for the registry; sign-in runs through the new row's
controller. 16 picker uses Settings' tightest-window rule.

## Decisions during the build (2026-10-04)

- The Claude overlay is laid at instance creation (instances are rebuilt on
  every settings change and server start), not before each spawn: shared
  directories are pre-created then, so only a shared _file_ that appears in
  the main folder later waits for the next rebuild. Windows hard-link re-links
  happen at the same moment.
- An account that shares the main folder's history reports no token history
  of its own: the same transcripts would otherwise count on two rows. The
  main row and the Usage page include it.
- Instance ids are `<driver>_<slug>_<4 hex>`; rows hide the id chip for any
  named instance, since the name now says which account it is.
- Names read "Claude · Work" everywhere through one rule
  (`formatProviderInstanceName`), unless the user's name already contains the
  agent's name. Badges spell the account ("W"), not the agent.
- The picker's per-account usage figure appears only when an agent has more
  than one account, using Settings' rule (`headlineUsageMeter`).
- OpenCode accounts are added without starting a sign-in: OpenCode works with
  free models out of the box, and its "connect a provider" step is optional.
- Same-agent switches between accounts that don't share history, and
  switches away from a removed account, use the existing confirm-and-recap
  handoff (built in a helper worktree from a spec, reviewed and applied).

## Diff review (GPT-6.1-Sol, 2026-10-04)

First pass (chat switching): a same-history switch after a restart lost the
conversation (ProviderService now reuses a persisted cursor across instances
with the same driver and continuation key), and moving off a removed account
skipped the recap confirmation (now confirm-handoff, plus a composer notice).

Second pass (accounts), all fixed: copyable terminal commands now carry the
account folder; Claude's environment refresh no longer restores the server's
credentials; folder validation covers every instance's real login folders,
environment included; cleanup checks ownership before signing out, requires a
successful sign-out, and skips records whose instance is still configured;
removal stops the sign-in run before and after the settings write; concurrent
adds re-validate inside the settings write; `~` folders resolve the same for
sign-in and runtime; ids are 6 hex chars and removed ids are retired; the
overlay keeps links it didn't make; account badges on the room roster, room
picker and sidebar hover; a slow start no longer fails the add; lifecycle
tests added. Declined: prefixing copyable Claude commands with
`env -u CLAUDE_SECURESTORAGE_CONFIG_DIR` (rare variable, noisier command).
A third pass couldn't run: the room's agent-request limit was reached.
