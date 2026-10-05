# Community agents (ACP registry): build plan (2026-10-05, revised after two reviews)

Piece 4 of the four Will approved on 2026-10-04 (see `agent-setup-plan.md`).
Pieces 1 to 3 are merged (#381, #387, #389).

Markers: **[v]** verified by reading the source today; **[d]** read by a
research pass and spot-checked; **[i]** inference.

## What Will approved (mockup)

- Settings › Providers gets a third group under "In use" and "Not in use":
  **Community agents**, the agents in the open ACP registry that Threadlines
  doesn't already support itself. Intro line: "Made by other teams and listed
  in the open ACP registry. We haven't tested them, so some features may not
  work." A "What works" link opens three short columns (works with every
  agent / depends on the agent / not available yet). A search field filters
  the list. Footnote: "Want one that isn't here? Agents join by adding
  themselves to the ACP registry."
- Each row: icon, name (plus the registry id when two share a name), "by
  <author> · <description>", version, **Install**.
- Install asks once per agent, inline under the row: "<Name> is made by
  <author>. Threadlines hasn't reviewed it. It runs on this Mac and can read
  and change files in your projects." Cancel / Install.
- Then, on the row: installing (from npm / downloading), "Checking that it
  starts", "Not signed in" with **Sign in**, or ready.
- An installed agent moves up to "In use" with a **Community** tag and shows
  in the model picker like any other agent.
- Setup's Agents step gets a "Browse community agents" link under the grid.
- Will, 2026-10-05: use the live registry; freeze the version at install;
  updates are a click, never silent.

## Decisions waiting on Will

1. **Hide quarantined agents** (29 listed instead of 36). The registry's own
   maintainers set them aside as broken, but still publish them.
2. **Bring our own Node.js** for npm-installed agents (15 of the 29 on a
   Mac). A pinned, hash-checked Node that Threadlines downloads once (about
   45 MB) and always uses for these agents, so they install with one click on
   any computer, behave the same everywhere, keep working when the user's own
   Node changes, and never need a shell on Windows. Without it, a computer
   with no Node shows "Needs Node.js" instead of Install. Recommended: yes.
3. **Sign-in is the agent's own.** Threadlines runs whatever sign-in the
   agent offers. From a phone or another computer, many agents can only
   finish signing in on the computer that runs them (their browser page
   answers to that computer). The row will say so.
4. **Approvals.** For these agents Threadlines doesn't translate "Approval
   required / Full access" into the agent's own modes, because it can't know
   what an unknown agent's modes mean. The agent's modes show as a choice in
   the composer; Threadlines still answers every permission question the
   agent asks according to the approval setting.
5. **A live check that runs other people's code on this Mac** (throwaway
   data folder and `HOME`): start each listed agent once to record what it
   says about itself. See Tests.
6. **Telemetry:** one event when a community agent is installed or removed,
   carrying its public registry id and version.
7. **One pull request or three.** The work splits cleanly: (A) bring our ACP
   library up to the current protocol and make the shared agent core handle
   agents it has never seen, with no visible change; (B) the install store,
   the archive extractor and our own Node, with no visible change; (C) the
   community agents feature. Recommended: three, so a regression in the
   shared core shows up alone.

## Verified facts

What the 29 listed agents actually report (recorded on 2026-10-05, after the
plan was reviewed) is in `community-agents-live-record.md`. Where it changed
the design, the sections below say so.

### The registry

- Index: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  (`max-age=300`). Today 41 agents; top-level keys `version`, `agents`,
  `extensions` (the registry's own schema forbids `extensions`, so a strict
  decoder would reject the live file). [v]
- Entry: `id`, `name`, `version`, `description`, optional `repository`,
  `website`, `authors`, `license`, `icon`; `distribution` with any of
  `binary` (per platform: `archive` URL, optional `sha256`, `cmd`, `args`,
  `env`), `npx` (`package@exact`, `args`, `env`), `uvx`. [v]
- Mix today (42 folders, 41 published): 21 npx only, 17 binary only, 2 uvx
  only, 2 binary + npx. Archives: 59 tar.gz, 34 zip, 4 tar.bz2 (goose), 4 raw
  executables. 53 of 101 archives carry a sha256; 9 of 19 binary agents carry
  none. [v]
- Five entries are agents we support natively and will hide: `claude-acp`,
  `codex-acp`, `cursor`, `opencode`, `antigravity-acp`. fx is not listed. [v]
- `quarantine.json` (7 ids today, reasons like "ACP initialize fails",
  "Missing npm dependency", "Postinstall script") lives only in the GitHub
  repo. Quarantined agents are **still in the published index**. 36 entries
  remain after hiding ours, 29 after also hiding quarantined ones; on an
  Apple Silicon Mac those 29 are 14 downloads and 15 npm packages. [v]
- New agents arrive by pull request. CI launches each agent on Linux x64 and
  requires an `initialize` answer with sign-in methods. It is not a security
  review; macOS and Windows archives are never downloaded by CI. [d]
- An hourly bot bumps versions from npm / PyPI / GitHub releases and pushes
  straight to main, which publishes to the CDN within minutes. No person
  reviews a bump. Versions can also move backward. [d]
- Some agents update themselves; two entries (`auggie`, `factory-droid`) turn
  that off through the entry's `env`. [v]

### Sign-in in ACP today

- `initialize` returns `authMethods`. Types: `agent` (the default when `type`
  is absent: the client sends `authenticate {methodId}` and the agent does the
  rest, usually opening a browser on its own computer and listening on a
  loopback port) and `terminal` (stable since 2026-08-20: the client runs the
  **same agent command** with the method's `args` appended and `env` applied
  in an interactive terminal, exit code 0 means success, then reconnects; the
  client must not send `authenticate`). [v]
- An agent may only advertise `terminal` when the client sent
  `clientCapabilities.auth.terminal: true`. [v]
- `env_var` was removed from the spec (2026-07-27). Two listed agents still
  advertise it, both alongside other types. [d]
- An older convention is still in the wild: the client sets
  `clientCapabilities._meta["terminal-auth"]: true` and the agent returns
  `_meta["terminal-auth"] = {command, args, label}` on a method. The registry's
  own CI speaks this form. Which listed agents speak which form is unknown
  without running them. [d]
- The registry's daily probe (legacy capability, Linux): 17 agents are
  `agent` only, 13 `terminal` only, 2 both. 23 refuse a session until signed
  in; 8 open one without signing in, so "a session opens" does not prove
  "signed in". [d]

### Ours

- `makeAcpProviderDriver(descriptor)` builds a full provider from a
  descriptor; `AntigravityDriver` already builds one descriptor per instance
  around a managed runtime. [v]
- `AntigravityRuntime` is a careful version store: staging then atomic rename,
  `active.json`, per-process leases, pruning, removal, hash and size checks.
  Its zip code accepts exactly Antigravity's two files. [v]
- The generic ACP core today: [v]
  - picks a session mode by name, with partial matches on name and
    description and a last resort of "the first mode that isn't plan", which
    for an unknown agent can be a mode that never asks;
  - changes mode and model only through `session/set_config_option` (`setMode`
    sends config option `mode`), and reads models only from `configOptions`.
    An agent that uses the older `modes` / `models` fields with
    `session/set_mode` / `session/set_model` gets no model picker and can
    fail when a mode is applied;
  - answers permission requests itself by runtime mode: approval-required
    waits for the user, full access picks "allow once";
  - returns the `initialize` result only as part of a successful start, so a
    session refused with `auth_required` loses the sign-in methods;
  - spawns through a shell on Windows unless told not to.
- `server.updateProvider` carries a driver, an instance id and
  install / update. It does not say which version the user saw. [v]
- Recognising "not signed in" in a failed turn is a list of message
  patterns that names Cursor and fx; `providerCanSignIn` is keyed by driver
  kind. [v]
- A one-click install on a turned-off agent is started by the open card
  (`pendingInstall` state in the browser), not by the server. [v]
- Web rows are derived per maintained driver and skip a driver that has no
  default slot. Icons are looked up by driver kind in 19 files; several
  callers pass only the driver kind. [v]
- `fallbackTextGenerationSelection` would pick any enabled instance,
  including a community agent, as the writing model. [v]
- `tar` 7.5 is already in the lockfile (transitive); there is no bzip2
  decoder. `yauzl` is a server dependency. [v]
- Our `effect-acp` bindings are generated from an older protocol revision:
  they have `session/elicitation` (needs a session id), where the current
  stable protocol has `elicitation/create`, which an agent can send during
  sign-in before any session exists. [v]
- Turning an instance off does not by itself stop every launch: session
  recovery (`ProviderService.ts`) calls `adapter.startSession` on the
  adapter it is handed, and a session that is still starting is not yet in
  the adapter's map when the instance is torn down. Antigravity closes this
  with a gate its `spawn` must pass. [v]
- A failed turn's error reaches the web as text only. The session
  projection stores `lastError` as a string. [v]

### How others do it

- **T3 Code** [d]: live index, one-click Add with no warning; sha256 checked
  only when declared; `npm install --global` into a managed prefix; registry
  `env` overrides the user's; no version pin, no update UI, old versions
  never removed, one global install lock; system `tar` / `unzip`; text
  generation disabled for registry agents; never changes an agent's native
  mode, and shows modes as a choice; reads models from config options only.
  Its input bounds (https only, exact versions, sizes, path checks) are worth
  copying.
- **Paseo** [v]: a fixed list bundled per release; 22 of 38 are "install it
  yourself"; no warning on that screen.
- **Zed** [v]: sha256 when declared, else GitHub's release digest, installs
  without either.

## Trust model

There is no sandbox, for these agents or for ours. What Threadlines promises,
and the wording it uses, is limited to what it controls:

- Nothing is installed without the per-agent confirm.
- **Threadlines never updates an agent by itself**, and an Update click
  installs exactly the entry the user was shown.
- What was installed can be reinstalled identically (same archive hash;
  same npm manifest, lockfile and Node release).
- Quarantined and malformed entries can't be installed.
- An agent that updates itself is outside that promise. Threadlines passes
  on the registry entry's settings (which is how two agents turn their
  updater off) and says so when an agent reports a different version than
  the one it had when installed.

## Design

### 1. Catalog (server)

`provider/acpRegistry/AcpRegistryCatalog.ts`

- Fetch the index (1 MiB cap, 30 s) and `quarantine.json` from
  `raw.githubusercontent.com/agentclientprotocol/registry/main/`. Both are
  cached under `<stateDir>/caches/acp-registry/`; a failed fetch falls back
  to the cache and marks the result stale. If the quarantine list has never
  been fetched, the catalog is shown but **nothing can be installed** until
  it has ("Couldn't check the registry's quarantine list. Try again.").
- When: opening Settings › Providers (served from memory if younger than
  5 minutes), and at most every 6 hours while a community agent is installed
  (for update advisories). Never otherwise.
- Tolerant decode: unknown keys ignored; each agent validated on its own and
  dropped with a logged reason, never failing the list. Bounds on every
  field: id `^[a-z][a-z0-9-]*$` up to 59 chars, version up to 64 chars of
  `[A-Za-z0-9._+-]`, name 160, description 1024, authors 16 × 256, args
  64 × 1024, env 64 entries with names matching
  `^[A-Za-z_][A-Za-z0-9_]*$`, at most 512 agents.
- **Recipe.** For this computer, the catalog reduces an entry to a recipe:
  agent id, version, the chosen distribution (kind, archive URL and sha256,
  or package spec), `cmd`, args and filtered env. Its **digest** (sha256 of
  the canonical JSON) is what every install and update names. Two entries
  with the same version but a different URL, hash, command or env have
  different digests.
- Distribution choice: `binary` when it has this platform, else `npx`. An
  agent with neither is left out and counted ("N more can't be installed on
  this computer"). That includes agents that only ship as Python packages
  (`uvx`): none of the 29 does, so there is no installer for them (see Out
  of scope).
- Registry `env` is filtered once, here: names compared case-insensitively
  against a reserved list (`PATH`, `HOME`, `USERPROFILE`, `APPDATA`,
  `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `PYTHON*`, proxy variables,
  `THREADLINES_*`) are dropped.
- **Fetch policy** for archives and icons, applied to every redirect hop
  (followed by hand, at most 5): https, no credentials, a hostname (no IP
  literals), and the address the connection actually resolves to must be
  public (a lookup hook rejects loopback, private, link-local and unique
  local ranges). Icons only from `cdn.agentclientprotocol.com`.
- Hidden: our five native ids (a constant in
  `@threadlines/shared/acpRegistry`) and quarantined ids.
- Icons: fetched by the server with the list (32 KiB cap each), cached by
  URL, sent inline. Clients never contact the CDN.

### 2. Install store (server)

Two modules. `provider/managedRuntime/ManagedRuntimeStore.ts` holds what is
common and is extracted **narrowly** from `AntigravityRuntime`: version
folders, `active.json`, leases, activation, retirement, pruning.
Antigravity's own download and two-file check stay where they are, and its
tests must pass unchanged. `provider/acpRegistry/AcpRegistryInstaller.ts`
holds the installers.

Root per agent: `<stateDir>/tools/acp/<sha256(agentId)[0:16]>/`. Folder names
are never registry strings (an id or version like `con` or `1.0.` is not a
safe Windows name).

```
trust.json                  durable: the confirmed recipe(s), first-seen archive hashes,
                            npm manifest + lockfile + Node release, the agent's
                            self-reported version
install.lock                one installer at a time, across processes (pid + start time)
active.json                 { recipeDigest } of the version to run
versions/<digest16>/        receipt.json, .install-complete.json, payload/
versions/<digest16>/.leases/
versions/.staging-*         a download in progress
```

- `trust.json` is written before any install starts, only ever under the
  per-agent lock, is never swept, and is deleted only by Remove. A reinstall whose archive hash differs from the
  first-seen hash fails ("the download changed since you installed it");
  missing trust data never resets to "first install".
- A version is complete only with its marker and is never written again.
  `active.json` only names a complete version. One in-process lock per agent
  (T3's single global lock stalls every agent behind one slow download), and
  `install.lock` across processes: created exclusively, stale only when its
  process is gone. The sweep of staging folders and markerless versions runs
  only while holding it.
- **Binary:** download to staging (1 GiB cap, 20 min, free-space check),
  hashed while streaming, compared with the recipe's sha256 when present and
  with the first-seen hash otherwise (recorded on first install). A URL path
  ending in `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2` or `.tbz2` is an archive;
  one with no suffix, or `.exe` / `.bin`, is the executable itself; anything
  else (`.xz`, `.zst`, `.7z`, `.gz`, `.dmg`, `.msi`, ...) is refused rather
  than run as a raw file. No archive listed today has a refused suffix. [v]
- **Extractor** (`provider/managedRuntime/ArchiveExtractor.ts`), in process,
  one policy for zip (`yauzl`), tar.gz and tar.bz2 (`tar`'s parser, gunzip
  from `node:zlib`, one small bzip2 decoder dependency for goose):
  - Pass 1 reads every entry header (after long-name and pax expansion) and
    decides before any byte is written. Allowed: files, folders, symbolic
    links, and hard links to a file earlier in the same archive (written as
    a copy). Refused: devices, FIFOs, sparse files, anything else. Each path
    is normalised and must stay inside the root: no absolute paths, drive
    letters, `..`, NUL, trailing dot or space, or Windows device names. Two
    entries that name the same destination, or differ only by case or
    Unicode form, fail the archive. A symbolic link's target, resolved
    lexically from its own folder, must stay inside the root and must not
    pass through another link.
  - Pass 2 writes folders and files only. A file is never written through a
    link: every parent must be a real folder this extraction created. Byte
    and entry budgets (4 GiB, 100,000 entries) are enforced as it writes.
  - Pass 3 creates the links.
  - Modes: Unix permission bits from tar headers and zip external
    attributes are kept, masked to `0755` / `0644`, with setuid, setgid and
    sticky cleared and folders always traversable, so helper programs inside
    an archive stay executable (Junie ships a whole application tree in a
    zip). `cmd` is normalised (backslashes, leading `./`), must be a regular
    file inside the root, and gets its exec bit regardless.
  - Staging is renamed into place only after all three passes.
- **Node for npm agents** (decision 2): official Node LTS builds, pinned per
  platform with sizes and hashes in the source as Antigravity's are (macOS
  arm64 / x64, Linux arm64 / x64 glibc, Windows x64 / arm64), installed
  through the same store under `<stateDir>/tools/node/<release>/` the first
  time an npm agent is installed. Always used for npm agents, even when the
  computer has its own Node. A platform with no official build (Linux musl)
  gets no npm agents. Each installed agent records the Node release it was
  installed with and leases it while running; a Node release is pruned only
  when no installed agent names it. The download honours `HTTPS_PROXY` and
  extra CA certificates from the environment.
- **npm:** staged like a download: `node <npm-cli.js> install --prefix
<staging>/payload <pkg@exact>` (never `npm.cmd`, so no shell on Windows),
  then renamed (a local npm tree is relocatable). The user's npm
  configuration is kept for registry, auth, proxy and CA, and overridden
  where it would change the result: `--global=false --package-lock=true
--save=true --save-exact --no-audit --no-fund`. The managed Node's folder
  is first on `PATH` for the install and for the agent, so scripts and
  agents that call `node`, `npm` or `npx` find the same one. The package's
  `engines.node` is checked against the managed release before install; a
  mismatch is refused with the reason. `package.json` and
  `package-lock.json` are copied into `trust.json`; a reinstall writes both
  back and runs `npm ci`, so the tree and its integrity hashes are the same
  as the first time. Install scripts run: that is when the package's own
  code first executes, which the confirm already covers. A native add-on
  that has to compile needs the computer's build tools; when that fails the
  row shows npm's own last lines. The executable is the package's `bin`
  entry (the single entry, else the one named like the package, else like
  the agent id); it must be a file inside the package. A JavaScript bin is
  launched as `node <file>` with no shell; another kind of bin is launched
  directly, and on Windows only through `node_modules/.bin/<name>.cmd` with
  the argument rule in section 3.
- Receipt: the recipe, the resolved command and args, the archive hash and
  how it was verified (`publisher` / `firstInstall` / `packageRegistry`), the
  Node release for an npm agent.
- Update = install the newly confirmed recipe, switch `active.json`, prune
  what no process leases. Remove = see section 5.

### 3. Driver and descriptor (server)

`provider/Drivers/AcpRegistryDriver.ts` builds a descriptor per instance, as
`AntigravityDriver` does. Driver kind `acpRegistry`, instance id
`acp_<agentId>`, one instance per agent, no default slot, no extra accounts.

- Settings (`AcpRegistrySettings` in contracts): `enabled`, `agentId`,
  `authMethodId` (the sign-in method the user picked, default empty),
  `binaryPath` (always empty, hidden) and `customModels`, which the generic
  ACP settings shape requires.
- **Gate.** One gate per agent, kept in the driver module so it outlives
  instance rebuilds (Antigravity's `AntigravityAuthGate`, moved to a shared
  helper). Every process the agent starts, for a chat, a check, a sign-in
  or a recovery, takes a hold in `spawn` before it launches and keeps it
  until it exits, so a process that is still starting is counted. Sign-in,
  sign-out and removal close the gate, stop the agent's sessions and wait for
  the holds to reach zero. A launch against a closed gate fails with a plain
  reason.
- **Spawn:** command and args from the receipt, `shell: false` always, a
  lease on the version (and on its Node release) for the life of the
  process. Environment: the
  server's, then the recipe's filtered env, then the instance's own
  variables on top (the user wins; T3 has it backwards). `HOME` is left
  alone, so an agent already signed in through its own CLI stays signed in.
  The one case that needs a shell is a non-JavaScript npm bin on Windows
  (`.cmd`): it is allowed only when every argument, from any source, matches
  `^[A-Za-z0-9_./:=@,+-]*$`; otherwise the launch is refused with a reason.
- **Client capabilities:** no client filesystem, no client terminal;
  `auth.terminal: true`; the legacy `_meta["terminal-auth"]: true` (see
  section 4); `elicitation.url` only in the sign-in runtime.
- **Status** keeps three things apart:
  - _Installed_ (files only): the active version and its receipt.
  - _What the agent offers_ (models, modes, options, commands, sign-in
    methods, capabilities, self-reported version): saved next to the receipt,
    tagged with the recipe digest and an auth generation. `initialize` data is
    saved **even when `session/new` is refused**, so a signed-out agent keeps
    its sign-in methods. Real sessions refresh it; a write from a process
    whose digest or generation is no longer current is dropped.
  - _Health_ (ready / not signed in / problem): from a real check
    (`initialize` + `session/new`, up to 90 s for slow starters), run after
    install, update, sign-in, sign-out, a settings change, "Check again", and
    otherwise at most once an hour while the agent is turned on. The
    descriptor's `probe` decides this itself (the generic five-minute refresh
    keeps calling it; between real checks it answers from the last result),
    runs one check at a time per agent, and stamps each result with the
    recipe digest and auth generation it was made under: a result or an
    `auth_required` from a process on an older digest or generation is
    ignored, and a result saved before a restart is shown as "Checking" until
    a fresh check confirms it. An `auth_required` from a current session
    flips health at once and bumps the auth generation. `auth_required`
    is "Not signed in"; another failure is a warning with the agent's first
    line (bounded, plain text) and "This agent may not work with Threadlines
    yet."; success is "Ready", never "Signed in".
- **Detect** (turned off): a complete active version on disk.
- **Maintenance:** install (the confirmed recipe, when nothing is active)
  and update. The catalog's newer recipe for an installed agent is a
  **candidate**: kept in memory, published on the snapshot as
  `{ version, recipeDigest }`, never written to `trust.json` on its own.
  "Newer" is a semver comparison; a registry version that moved backward
  offers nothing.
- **Text generation:** the driver's text generation fails with a clear
  message; `fallbackTextGenerationSelection` and the writing-model pickers
  skip the driver.
- **Logs:** agent-supplied strings are bounded before they are stored or
  shown (names 160, descriptions 1024, args 64 × 1024, error text 2000).
  The sign-in runtime writes no native protocol log (its payloads can carry
  login URLs and codes).

### 4. Protocol and generic ACP core changes (no change for fx, Cursor or

Antigravity; their existing tests are the guard)

- **Protocol.** The bindings stay on their pinned release. Regenerating
  them from the current schema was tried and dropped: the new schema is
  stricter where ours is open (it rejects a stop reason an existing agent
  sends), and it removes `session/set_model`, which the older API shape
  needs. The one new message we need, `elicitation/create`, is added by hand
  next to the old `session/elicitation` handlers, in the PR that uses it.
- **Both API shapes.** Models: `configOptions` with category `model`, else
  the `models` field with `session/set_model`, else a single "Default" that
  means "leave the agent's model alone" (no setter is ever called for it).
  Modes: a `mode` config option, else the `modes` field with
  `session/set_mode`. Today's paths for the existing agents are untouched:
  the new shapes are consulted only when the config option is absent.
- **Native modes.** A descriptor flag (`sessionControls: "native"`, set for
  `acpRegistry` only): the core never changes the agent's mode from the
  runtime mode, and the agent's modes appear as a "Mode" option in the
  composer, remembered per thread like other options, including on the
  "Default" model. Without the flag, mode options stay excluded as today
  (`AcpProviderModels.test.ts` pins that). Permission requests are still
  answered by runtime mode, unchanged.
- **`initialize` on its own.** The session runtime exposes the `initialize`
  result as soon as it arrives, whether or not the session then opens.
- **Stale option values.** A stored option value the agent no longer offers
  is skipped instead of failing the session.
- **Stray `fs/*` requests** get method-not-found.
- **Sign-in errors** need no new event field or migration: ACP error -32000
  at session start or mid-turn flips the instance's health to "Not signed in"
  through the driver, and the composer already offers Sign in for an
  instance in that state. The failed turn shows the agent's own text as
  today. `providerCanSignIn` keeps its driver table for the built-in agents
  and additionally says yes for an instance whose snapshot offers a sign-in.

### 5. Sign-in and removal (server)

`provider/acpRegistry/AcpRegistryAuth.ts`, exposed as the instance's
`authFlows` (`login`, and `logout` only when the agent advertises it). Both
close the agent's gate first, as Antigravity's do: its sessions stop, the
flow runs alone, and a health check follows.

- Methods come from the saved `initialize` data and are re-read from a fresh
  `initialize` when a sign-in starts. With several, the Account tab lists
  them (name and description) and remembers the pick in `authMethodId`.
- **`agent` method:** a sign-in runtime sends `authenticate` (5 minute
  limit), then `session/new` confirms. Most agents open the browser
  themselves on the computer they run on. If the agent instead sends an
  `elicitation/create` with an http(s) URL, the provider-auth stream carries
  a typed "the agent wants you to open this page" event with the flow and
  request ids; the panel shows the address with **Open sign-in page** and
  **Copy link**, and a new `providerAuth.respond` call answers the agent
  `accept` only on that click and `decline` on Cancel. Community URLs are
  never opened automatically (the existing flow auto-opens a printed URL
  for our own agents).
- **`terminal` method:** `ProviderInstanceAuthFlows` gains an optional
  `terminalCommand(flow)`. `ProviderAuthSessions` runs it in its existing
  terminal, shown from the start, and on exit code 0 runs a health check. A
  login that never exits is ended by Cancel. Which command line, from what
  the 29 listed agents actually send (`community-agents-live-record.md`):
  1. A legacy `terminal-auth` entry that passes the policy below is run as
     written. It is the only form seven agents offer, and where an agent
     sends both forms it spells out the whole line.
  2. Otherwise the stable `terminal` method: the receipt's executable with
     the method's `args` **in place of** the registry entry's args, and its
     `env` (filtered like registry env) applied. That is the registry
     guide's wording and what six of the seven agents using it mean; the
     protocol text says "append", which only devin means, and devin also
     sends the legacy line.
- **Legacy command policy:** the program an agent names must be a file
  inside its own installed version folder, or the runner (`node`, by name or
  by path) with a first argument that is a file inside that folder. So only
  code the user installed runs. GitHub Copilot (a native binary from one of
  its own packages), amp, kimi, poolside, auggie, dirac and pi pass. Refused,
  and shown as "signs in its own way" with the method's own description:
  autohand (`npm install -g ...`), kilo (`opencode auth login`), junie's
  legacy entry (`npx ...@latest`; its stable method is used).
- Both capabilities are declared on every launch: `auth.terminal` and the
  legacy `_meta["terminal-auth"]`. Without the second, auggie and poolside
  list no sign-in method at all.
- `env_var` methods are not run. The Account tab names the variables they
  ask for (dirac, glm) and points at the Configuration tab's environment
  editor, where a key is stored as a secret.
- **No usable method:** "This agent signs in its own way" with a link to its
  website or repository.
- **Remote clients** (decision 3): the terminal and any address the agent
  reports are visible from any client, which is enough for sign-ins that
  give a code. A sign-in whose browser page must answer to the agent's own
  computer can only be finished there, and Threadlines does not replay a
  pasted address to a local port chosen by an agent it doesn't know (the
  Antigravity-only replay stays as it is). The panel says "You may need to
  finish signing in on <computer name>."
- `logout`: the ACP `logout` request.

**Removal** (`server.removeAcpRegistryAgent`) is ordered so a failure stays
visible and retryable:

1. Close the agent's gate. From here no process of it can start: not a
   chat, a recovery, a check, a sign-in or an install.
2. Turn the instance off in settings, stop its sessions and its sign-in
   session, drop queued maintenance for it (the maintenance runner re-checks
   the instance and recipe after it takes its lock), wait for the holds to
   reach zero (30 s).
3. Retire the agent's files. If something still holds them, stop here and
   reopen the gate: the row stays, turned off, with "Couldn't remove <name>:
   it is still running. Try again."
4. Remove the instance and its secrets from settings in one write.

Threads that used the agent keep their history. A message queued for it is
kept and shown as blocked with the existing "this account was removed"
notice, and a room that lists it shows it as unavailable, as for any
removed account.

### 6. Contracts and RPC

- `packages/contracts/src/acpRegistry.ts`: `AcpRegistryCatalogAgent` (id,
  name, version, `recipeDigest`, description, authors, license, website,
  repository, `iconSvg`, `source` npm / pypi / download, `host` for
  downloads, `integrity` checksum / none / package, `requires`),
  `AcpRegistryCatalog` (agents, `fetchedAt`, `stale`, `quarantineKnown`,
  `unsupportedCount`), and the settings schema.
- `server.listAcpRegistryAgents`: the catalog.
- `server.addAcpRegistryAgent { agentId, recipeDigest }`: refuses unless the
  digest is the catalog's current one for that agent and the quarantine list
  is known; writes `trust.json`; adds the enabled instance in one settings
  write; **starts the install on the server** through the maintenance runner
  and returns the instance id. The install does not depend on the client
  staying connected.
- `server.updateProvider` gains an optional `recipeDigest`, required for an
  `acpRegistry` instance. **Install** (first install, Try again, repair)
  must name a recipe already confirmed in `trust.json`. **Update** must name
  the published candidate; the server takes a copy of that recipe as it
  accepts the request, records it in `trust.json` under the agent's lock, and
  installs that copy even if the catalog moves while it waits. A stale
  client gets "A newer version was listed. Look again."
- `providerAuth.respond { instanceId, flowId, requestId, accept }` and the
  matching stream event, for an agent's request to open a sign-in page.
- `server.removeAcpRegistryAgent { instanceId }`.
- `ServerProvider` gains optional `community`: `{ agentId, authors,
website, source, host, integrity, iconSvg, reportedVersionChanged,
updateCandidate: { version, recipeDigest } | null, signIn: { methods,
selected, canSignOut, remoteHint } }`.
- `@threadlines/shared/acpRegistry`: the hidden ids, the instance id rule,
  the confirm and status wording shared by web surfaces.

### 7. Web

- **Providers page:** the Community group after "Not in use", built from
  `server.listAcpRegistryAgents` minus agents already added (an installed
  agent leaves the list and comes back after Remove). Quiet group, flat
  rows, the same `AgentRow`. Search filters on name, author, description and
  id. A row whose name collides shows its id.
- **Confirm** (inline, per agent): the approved sentence with the computer's
  real name ("this Mac", or the paired computer's name from a phone), plus
  one source line: "Installs `<package>` from npm." / "Downloads from
  github.com. The download is checked against the publisher's checksum." /
  "Downloads from static.devin.ai. The publisher gives no checksum."
- **After Install** the instance exists, so the row is under "In use" with
  the Community tag, and the server's install shows through the existing
  progress, failure and Try again. A failed install leaves a visible row
  with Try again and Remove.
- **Installed row:** Community tag; status from the snapshot; Account tab
  (method list, Sign in / Sign out, the remote hint, or "signs in its own
  way") shown for every community agent, not only when a terminal login
  command exists; Models; Configuration (environment editor and an About
  block: by whom, source, version, how the download was verified, website,
  and "updated itself since you installed it" when the agent reports a
  different version); footer with Turn off and **Remove** (a confirm that
  names what is deleted). The update popover shows the candidate version and
  one line, "Threadlines hasn't reviewed this version.", and sends the
  candidate's digest.
- **Driver plumbing:** `acpRegistry` joins the maintained driver kinds;
  `deriveProviderSettingsRows` lists instances of a maintained driver that
  has no default instance; `providerDriverMeta` gets an entry without a
  generic settings form.
- **Icons:** every place that draws a provider glyph resolves it from the
  **instance** (id to snapshot), not the driver kind: the 19 files that use
  `ProviderInstanceIcon` or the driver-keyed tables, including the callers
  that today pass only a driver kind (`HeaderAgentFaces`, thread telemetry,
  the agents rail). The SVG is drawn as a CSS mask from an encoded
  `data:image/svg+xml` URL filled with the current text colour. It is never
  inserted as markup; a generic glyph stands in when there is none.
- **Sign-in outside Settings:** `useAntigravityNextStep` becomes
  `useInstanceSignInStep`, covering Antigravity and community agents, so the
  composer and setup buttons run the chosen method, or link to the Account
  tab when a method must be picked or the sign-in needs the terminal.
- **Composer:** the "Mode" option for community agents (section 4).
- **Setup:** "Browse community agents" under the Agents grid, opening
  Settings › Providers at the group. The command palette gets the same
  destination.
- **Writing-model pickers** leave community agents out.
- **Removed agents:** threads that used one keep their history and show the
  existing "this account was removed" notice from piece 2.
- **Links** from registry data (website, repository) open only when they are
  https; all registry and agent text is rendered as text.

### 8. Docs and telemetry

- `docs/providers/community-agents.md`: what they are, the trust statement
  in the words above, install / update / remove, the sign-in kinds and the
  remote limit, modes and approvals, what works, where files live.
- Telemetry (decision 6), `docs/telemetry.md` updated.

## Surfaces checklist

- Entry points: Settings › Providers, setup link, command palette, model
  picker, composer (notices and the Mode option), room agent lists.
- Clients: web, desktop, phone (everything through RPC; icons inline;
  terminal sign-in through the existing auth terminal stream; the remote
  hint for browser sign-ins).
- Providers: the protocol update and generic ACP core changes in section 4,
  with fx, Cursor and Antigravity pinned by their current tests;
  Antigravity's store extraction and shared gate.
- Contracts: catalog, settings, snapshot `community`, three new RPCs, one
  extended, one new provider-auth stream event; `elicitation/create` added
  by hand to `effect-acp` (the bindings are not regenerated, see section 4).
- Reverse states: Remove (retryable), Turn off, Sign out when offered, a
  failed install is retryable and removable, an update never applies by
  itself, a cancelled sign-in declines the agent's pending request.
- Platforms: macOS, Windows (no shell, device names, backslash `cmd`),
  Linux.

## Tests

- Server, catalog: tolerant decode, bounds, hidden, quarantined, quarantine
  never fetched, platform pick, recipe digest changes when anything in the
  recipe changes, env filter (case-insensitive), fetch policy including a
  hostname that resolves to a private address and a redirect to one.
- Server, store: against a local HTTP server: zip, tar.gz, tar.bz2, raw;
  checksum match and mismatch; first-seen hash recorded, enforced on
  reinstall, and still enforced after the version folder and its marker are
  deleted; traversal, escaping links, device entries, Windows device names;
  a bomb stops at the byte budget; interrupted install leaves nothing; two
  installers (two store instances on one folder) don't corrupt each other;
  update switches and prunes around a live lease; the Antigravity runtime
  tests unchanged.
- Server, extractor: built archives for each rule: a link followed by a
  write through it, two links that chain out of the root, duplicate and
  case-colliding names, hard links, long and pax names, a sparse entry, a
  device entry, exec bits from tar and from zip (a launcher that runs
  another extracted file), setuid cleared.
- Server, npm: a scripted fake `npm` for bin choice and failure text, and
  the **real** npm against a local registry fixture for the parts a fake
  can't show: a user config with `global=true` and `package-lock=false`
  still yields a local tree and a lockfile; a reinstall from the saved
  manifest and lock is identical; `engines` mismatch is refused.
- Server, driver and core: environment order; no shell; the Windows `.cmd`
  argument rule; status split (sign-in methods kept when `session/new` is
  refused, a result or sign-in error from an old digest or generation
  ignored, health recheck after sign-in, saved health not trusted after a
  restart, two refreshes at once run one check); the gate (a process still
  starting is counted, recovery can't start one while it is closed); both
  model / mode API shapes and the "Default" model that calls no setter,
  against scripted fake agents; native modes never changed by runtime mode;
  -32000 at start and mid-turn flips health; text-generation exclusion.
- Server, RPC: add with a stale digest; add when quarantine is unknown; the
  install runs with no client attached; update with a stale digest (the
  second-client race); remove while a session, a sign-in terminal and a
  queued install exist, and the retryable failure state.
- Server, sign-in: `agent` method with and without a URL request, answered
  only after `providerAuth.respond`, declined on cancel; terminal command
  building (append, env override); the legacy command policy (`node -e` and
  a program from `PATH` are refused); sign-out stops running sessions first.
- Web unit: catalog filter and collision labels, confirm wording, rows
  without a default slot, next-step table, instance icon resolution.
- Web browser: the Community group renders and filters; Install shows the
  confirm, sends id and digest, and the row lands in "In use" with its tag
  and progress; install blocked when quarantine is unknown; the update
  popover sends the digest it showed; Remove asks first and shows the
  retryable failure; the Mode option appears for a community agent; a
  sign-in page request waits for the click.
- **Live, on this Mac, after Will's OK (decision 5)**, in a throwaway data
  folder and `HOME`: start each listed agent once and record `initialize`
  (sign-in methods and their form, capabilities) and, separately, what
  `session/new` returns. For the agents that refuse a session until signed
  in, the model and mode shapes stay unknown; the PR says which. The results
  decide whether the legacy sign-in form is kept and become test fixtures. Then, through the real screen: one npm agent and two downloads
  (one with a checksum, one without): install, status, a forced older
  version to update from, remove. No real sign-ins.
- Not covered by anything above, and said so in the PR: real sign-ins, a
  phone finishing a browser sign-in, and Windows and Linux on real machines
  (CI runs the unit suites on Linux only).

## Out of scope

- A sandbox for any agent.
- "Local ACP command" (a hand-entered command for an agent that isn't in the
  registry). T3 has it; worth pitching separately.
- Agents that only ship as Python packages (`uvx`). Both such entries are
  quarantined today, so an installer could not be tried against a real one.
  They are counted under "can't be installed on this computer".
- Replaying a pasted sign-in address to a local port for community agents.
- Usage meters, subagent tracking, importing an agent's own past sessions.
- Extra accounts for community agents.
- Graduating an agent to the tested tier.

## Build order

Contracts first, then one thin slice end to end before the wide parts:

1. Core changes of section 4 with fixtures. (PR A)
2. Store extraction, extractor, managed Node. (PR B)
3. Contracts for the catalog, recipe, snapshot and RPCs; read-only catalog.
4. The live record of what listed agents report (after Will's OK), turned
   into fixtures.
5. One slice end to end on the server: an npm agent and a download, install,
   status, sign-in, update, remove.
6. Web: the group and installed rows, then the instance-based icon change
   across its 19 files as its own commit, then setup, palette, composer.
7. Docs, live checks through the screen, diff review. (PR C)

The installer (Node selection, npm configuration, archive rules and leases
working together on three systems) is the part most likely to be
underestimated.

## Review dispositions (GPT-6.1-Sol, 2026-10-05)

Seventeen findings, each checked against the code. Fifteen accepted as
written; two accepted in part.

1. Unconfirmed update candidates in `approved.json`, and an update request
   with no version: **accepted.** Recipes get a digest; candidates stay in
   memory; add and update name the digest; `trust.json` holds only what the
   user confirmed.
2. Limits applied after system `tar` has unpacked: **accepted.** One
   in-process extractor validates before writing and budgets while writing.
3. An exact package version doesn't freeze dependencies, and agents update
   themselves: **accepted in part.** The npm manifest and lockfile are kept and
   reused, so a reinstall is identical. Self-updating can't be stopped for an
   unknown agent; the promise is reworded to what Threadlines controls, the
   registry's own off-switches are passed on, and a changed self-reported
   version is shown.
4. Cleanup could delete the first-seen hash: **accepted.** `trust.json`
   lives outside version folders and is never swept.
5. In-place package installs break the store's guarantees: **accepted.** npm
   is staged and renamed under a cross-process `install.lock`; sweeping needs
   the lock. (The in-place `uv` install was cut in the second pass.)
6. A signed-out agent loses its sign-in methods: **accepted.** `initialize`
   data is kept separately from session results.
7. Browser sign-in from a remote client: **accepted in part.** URL
   elicitation is declared and handled with explicit consent. An agent that
   opens its own browser without reporting the address can't be finished
   remotely by any client; that limit is stated in the UI and put to Will
   (decision 3). (Pasting back a local redirect was cut in the second pass.)
8. A legacy sign-in command chosen by the agent sidesteps the pin:
   **accepted.** Only a command inside the installed version (or `node` on a
   file inside it) is run.
9. Mode matching can land on a mode that never asks: **accepted**, and my
   claim that it couldn't was wrong (`AcpAdapter.ts:271` falls back to the
   first non-plan mode; matching also searches descriptions). Community
   agents keep their own mode, shown as a choice.
10. The core only speaks the config-option API: **accepted.** Both shapes
    are supported, with fixtures.
11. Remove races with installs, sign-ins and new chats: **accepted.** The
    ordered removal in section 5.
12. Saved discovery can show a false "Ready": **accepted.** What the agent
    offers is cached; health is checked for real, with generations to drop
    late writes.
13. The "not signed in" text isn't recognised for unknown agents:
    **accepted**, and my claim that it was is wrong. (How it is handled
    changed in the second pass, item 7.)
14. Windows shell and agent-supplied arguments: **accepted.** No shell, one
    argument rule for the single `.cmd` case, bounds on agent strings, no
    protocol log for sign-in.
15. Quarantine unknown on first fetch; DNS to a private address; Windows
    device names: **accepted.** Installs wait for the list; addresses are
    checked at connection time; folders have opaque names.
16. Adding the row doesn't start the install, and several UI gates are keyed
    by driver: **accepted.** The server starts the install; the maintained
    driver list, tab gates and icon callers are listed in section 7.
17. A computer with no Node can't install half the list in one click:
    **accepted** as a decision for Will (2), with a managed Node recommended;
    Python-package agents are out of scope because no listed agent needs them.

### Second pass (same reviewer, same day)

Fifteen findings on the revision. Thirteen accepted; two resolved by cutting
scope.

1. Link and collision rules didn't confine extraction: **accepted.** Three
   passes; files are never written through links; duplicates and case
   collisions fail the archive.
2. Turning the instance off doesn't block every launch (recovery, a session
   still starting): **accepted.** A per-agent gate taken in `spawn`, closed
   first by removal, sign-in and sign-out.
3. The digest rule blocked Try again and repair: **accepted.** Install names
   a confirmed recipe, update names the candidate, the recipe is copied when
   the request is accepted.
4. Wrong prompt protocol (`session/elicitation` needs a session):
   **accepted.** The prompt gets a typed stream event and an explicit answer
   call. (Later changed: the bindings are not regenerated, since the newer
   schema is stricter than what listed agents send. `elicitation/create` is
   added by hand instead, see section 4.)
5. Managed Node lacked a launch contract: **accepted.** `PATH`, `node
npm-cli.js`, platforms, `engines`, proxy and CA, and each tree bound to
   and leasing its Node release.
6. A lockfile alone doesn't reproduce an npm tree, and user config can change
   the layout: **accepted.** Manifest and lock are both kept; layout options
   are forced; real npm is in the tests.
7. A structured sign-in marker would be lost before the composer:
   **resolved differently.** No marker: -32000 flips the instance's health,
   which the composer already acts on. No schema change or migration.
8. An instance-based `providerCanSignIn` would drop the built-in agents'
   buttons: **accepted.** The driver table stays; the snapshot adds to it.
9. Generations didn't cover health, restarts or cadence: **accepted.** See
   Health in section 3.
10. "Default" model would still call a setter: **accepted.**
11. Only `cmd` got its exec bit: **accepted.** Modes are kept and masked;
    `.tgz` / `.tbz2` are listed again.
12. The legacy command rule let `node -e` through: **accepted.** The whole
    launch prefix must match.
13. Replaying a pasted address to an agent-chosen local port is unsafe to
    generalise: **resolved by cutting it** for community agents.
14. "Terminal sign-in works from any client" overclaimed, and sign-out
    didn't stop running sessions: **accepted.** The remote wording covers
    both kinds; sign-in and sign-out close the gate.
15. The live record can't show model and mode shapes for agents that need a
    sign-in first: **accepted** as a stated limit.

Sequencing advice taken: contracts first, a read-only catalog and fixtures
before installers, one end-to-end slice before the wide web work. Cut on
that advice: the `uvx` installer. Not cut: instance-based icons, because a
community agent without its own glyph in the model picker and chat header
isn't the approved feature; it is its own commit instead.
