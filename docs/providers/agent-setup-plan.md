# Agent setup + Settings › Providers redesign: build plan (2026-10-04)

Status: plan for the first of four pieces Will approved on 2026-10-04. Mockups
(clickable) were reviewed with Will in the Threadlines browser panel; the
relevant decisions are restated here so this document stands alone.

Pieces, in build order. **This plan covers piece 1 only.**

1. Full-screen first-run setup + Settings › Providers redesign + install detection.
2. One-click "Add another account" (auto-created per-instance home folder).
3. Antigravity sign-in methods: Gemini Enterprise, Gemini API key, Vertex AI
   (per-use billing approved by Will).
4. ACP registry agents as a separate, clearly labeled "Community" tier.

## Problems today (verified in a throwaway stack with fake HOME)

- First run lists only _enabled_ providers. Cursor, fx, OpenCode and
  Antigravity default to off (`packages/contracts/src/settings.ts`), so a new
  user never sees them there. The card also caps at three rows.
- Turned-off providers are never examined: every driver's disabled branch
  returns `installed: false` with the message "X is disabled in Threadlines
  settings" (`CodexProvider.ts`, `ClaudeProvider.ts`, `acp/AcpProvider.ts`
  `checkAcpProviderStatus`, OpenCode). Nobody can tell whether it's installed.
- Settings › Providers is six boxed cards with a switch each; amber dots for
  "off"; inconsistent signed-out colors (Codex red, Claude amber); a forever
  bouncing update arrow (`ProviderInstanceCard.tsx`, `animation:bounce ...infinite`).
- Bug: the provider update toast opens on top of first-run setup on a fresh
  install. `isFirstRunSetupPending` returns false while `bootstrapComplete` is
  false, so `shouldOpenProviderUpdatePrompt` sees "not in setup" and fires
  before the environment finishes loading.

## Design (approved)

### Setup: its own full-window route, three steps

Route `/setup` (top-level, like `/settings`), rendered without the app
sidebar (root layout special-cases it the way it special-cases `/pair`), with
the desktop drag region. Step in the URL: `/setup?step=agents|connect|folder`
so reload and quit-relaunch resume the same step.

Top bar: brand, step indicator (Agents · Connect · Folder; finished steps are
clickable; a skipped Connect shows "skipped"), and "Set up later". A fixed
bottom bar holds Back / hint / primary button so the primary never moves.

1. **Agents.** A 3×2 tile grid of the six built-in drivers (2 columns, then 1,
   on narrow widths). Each tile: logo, name, grey "Experimental" label where the
   driver has `badgeLabel`, status line (On this Mac · signed in / On this Mac
   / Not installed / Installing…), and a short "what it needs" line. Pre-picked
   = enabled-and-installed, or disabled-and-detected. Lede names what we found
   on this computer, by environment label. With nothing found: a hint that
   OpenCode's free models need no account. Continue writes `enabled` for all
   six default instances = picked (see "Enabling" below); then goes to
   Connect, or straight to Folder (Connect marked skipped) when every picked
   agent is already ready.
2. **Connect.** Only the picked agents, in driver order, each one shared agent
   row with exactly one next step: Install (existing `ProviderInstallAction`),
   Sign in (existing `useProviderConnectFlow` / `ProviderSignInButton`;
   Antigravity keeps "Sign in with Google"), Installing…/Checking… as text, or
   a green Ready. Continue enables once one picked agent is ready; the hint says
   "N of M ready. You can finish the rest later in Settings."
3. **Folder.** The project row (pre-filled from the launch folder / first
   workspace project; "Choose a folder" opens the existing add-project flow),
   then Git and GitHub rows moved from `FirstRunSetupCard`'s
   `SourceControlSetupRows` (GitHub optional). Primary: "Start first thread",
   enabled when a folder exists.

Finishing dismisses first-run for the environment (existing per-environment
dismissal store) and replace-navigates to a new draft in the chosen project
(`useHandleNewThread`). "Set up later" dismisses and goes to `/`.

Entry points:

- Fresh launch: `_chat.index.tsx` redirects to `/setup` when first-run is
  pending for the active environment, before it creates the default draft.
  This covers both landings today's card covers (npx draft, desktop
  no-project canvas). The old card (`FirstRunSetupCard`) and its mounts in
  `ChatView` and `NoActiveThreadState` are deleted.
- Way back: "Open setup" in the Settings › Providers header and a command
  palette action "Set up agents". Reopening works on a set-up environment:
  picks = currently enabled defaults.
- The composer's existing readiness notice ("X needs sign-in." / "X isn't
  installed.", `providerReadinessNotice.tsx`) gains an "Open setup" action when
  first-run was skipped and no enabled provider is ready. No new notice type.

Gate fix: replace the boolean with a tri-state (`pending | done | unknown`);
`unknown` until `bootstrapComplete`. Update toasts (provider and source-control
tools) open only on `done`, and never on `/setup`.

### Detection: look first, check only what's on

New optional contract field on `ServerProvider`:

```ts
detection: Schema.optionalKey(
  Schema.Struct({
    status: Schema.Literals(["found", "notFound", "unknown"]),
    path: Schema.optional(TrimmedNonEmptyString), // where it was found
    reason: Schema.optional(TrimmedNonEmptyString), // why we can't tell
  }),
);
```

Set only on snapshots of **disabled** instances (enabled ones already report
real `installed`). Each driver's disabled branch fills it through one shared
helper, `provider/providerDetection.ts`, so the rule lives in one place:

- Pure filesystem lookup. Never spawns, never touches the network, never boots
  WSL, never starts OpenCode's background service. Runs whenever the disabled
  snapshot is rebuilt (startup, settings change, "Check again").
- **Must agree with the probe.** It resolves the binary exactly the way the
  enabled probe/spawn would, with the same environment (instance environment
  overrides included), so "Found" never lies:
  - Codex: `isCommandAvailable(binaryPath || "codex", env)` as in
    `CodexProvider.ts` today.
  - Claude: the same command resolution the Claude probe spawns with.
  - ACP (Cursor, fx, Antigravity): a new optional descriptor hook
    `detect(settings, env)`; default implementation resolves through
    `resolveAcpBinaryPath`. fx on Windows (`resolveBinaryOnHost` false) returns
    `unknown` with reason "fx runs in WSL. Turning it on starts WSL to check."
    Antigravity checks its managed runtime (`runtime.installed`, filesystem
    only) unless a custom `binaryPath` is set.
  - OpenCode: `resolveOpenCodeBinary` with a found/not-found result.
- No auth detection for disabled agents (reading credential stores can prompt
  the macOS keychain). Sign-in state is learned after the user turns it on.

### Settings › Providers: two groups, flat rows

`ProviderSettingsPanel` groups default and custom instances into **In use**
(enabled) and **Not in use** (disabled), fixed driver order within each.

- Rows are hairline dividers (no card box, no shadow); one row height.
- **In use row:** logo, name, grey "Experimental" label, version, a static
  update tag (`↑ 2.1.301`) that opens the existing update popover (same
  content, including the Windows process-lock recovery), account line, and on
  the right either the row's next action (Install / Sign in / Connect a
  provider) or a compact usage meter (existing usage presentation; full usage
  stays in the Usage tab). Status color only when action is needed: amber dot
  for needs sign-in, red for broken; a healthy agent has no dot. The per-row
  switch is removed.
- **Opened row:** the existing tabs (Account, Usage, Models, Configuration)
  restyled flat, plus a footer with "Turn off <name>" (and delete for custom
  instances, as today).
- **Not in use row:** what it needs, detection ("Found on this Mac" /
  "Not installed" / the `unknown` reason), and one button: "Turn on" (found or
  unknown) or "Install" (not found; enables, then runs the existing install).
  Rows can still open to reach Configuration (e.g. to set a binary path before
  turning on).
- Header: "Checked …", "Check again" (labeled), "Open setup". The tiny "+"
  stays as-is until piece 2 replaces it.
- Intro copy names the environment instead of "the paired computer".

### One agent row, everywhere

New shared module pair under `apps/web/src/components/providers/`:

- `agentStatus.ts` (logic, unit tested): derives, from a provider entry +
  snapshot + live flow state, one of `notInstalled | installing | checking |
needsSignIn | signingIn | ready | problem | off(found|notFound|unknown)`,
  the status line, and the single next action. Absorbs and replaces
  `firstRunSetup.ts`'s row derivation; language stays shared with
  `getProviderSummary` and `getModelPickerProviderAvailability`.
- `AgentRow.tsx` (presentational): logo slot, name, label, version, status
  line, action slot, optional trailing slot (chevron / meter). Used by setup's
  Connect step and both Settings groups.
- Per-driver presentation added to `providerDriverMeta.ts`: `needs` (short
  phrase, e.g. "ChatGPT plan or API key", "Free models, no account needed").

### Enabling

Setup and Settings flip `enabled` through one extracted function (today
inlined in `ProviderSettingsPanel`'s `onUpdate`): it writes the instance
envelope via `buildProviderInstanceUpdatePatch` and, when disabling, clears
the text-generation model selection and backup selection that point at that
instance. Setup's Continue applies it to all six default instances in one
settings write.

## Out of scope here

Extra accounts, Google sign-in methods, community agents (pieces 2–4).
No default changes in contracts: the per-driver `enabled` defaults stay;
setup writes explicit flags only when the user presses Continue, so users
who skip keep today's behavior.

## Surfaces checklist

- Clients: web and desktop share the route; desktop drag region via
  `PageTitlebar`. Hosted static (phone) never redirects (existing
  `isHostedStatic` clause).
- Environments: setup and Settings act on the same environment Settings
  already uses; first-run dismissal stays per environment.
- Providers: all six drivers get a detection decision (above). Custom
  instances appear in Settings groups; setup only manages default instances.
- Contracts: one optional field; no migration.
- Reverse states: "Set up later" → "Open setup" (Settings, palette, composer
  notice); Turn off ↔ Turn on.

## Tests

- Server: shared detection helper (found / notFound / unknown) with a fake
  filesystem; one disabled-snapshot test per driver family asserting
  `detection` is set and nothing was spawned (Codex, Claude, ACP incl. fx on
  `win32` → unknown, OpenCode).
- Web logic: `agentStatus` derivation table; setup step rules (pre-pick,
  skip Connect when all picked are ready, continue gating, enable writes);
  tri-state gate + update-toast rule (extend
  `ProviderUpdateLaunchNotification.logic.test.ts`).
- Web browser: setup route flow (replaces `FirstRunSetupCard.browser.tsx`);
  Settings provider tests updated for groups / Turn off / Turn on / Install
  from Not in use (existing install, sign-in, update and process-lock tests
  keep their assertions, re-targeted to the new layout).
- Live: throwaway stack (fake HOME and THREADLINES_HOME) for first run with
  nothing signed in; never click another provider's Update there (it updates
  the real binary).

## Questions for review

1. Is the disabled-branch-per-driver placement for detection right, or should
   the registry attach it centrally through a driver hook?
2. Any path where detection could disagree with the probe (Claude's native
   installer location, Windows known dirs, login-shell PATH on macOS GUI)?
3. Redirect from `_chat.index.tsx` only: does any launch path land elsewhere
   first (last-visited-thread restore, deep links, the server-created
   bootstrap thread)?
4. Writing six `enabled` flags on Continue: any risk to users with legacy
   `providers.<kind>` settings, custom instances, or text-generation selection?

## Changes after review (GPT-6.1-Sol, 2026-10-04)

All eleven findings were checked against the code and hold. The plan above is
amended as follows; where this section and the sections above disagree, this
section wins.

1. **Text-generation fallback (P1, existing bug).** `fallbackTextGenerationSelection`
   (`apps/server/src/serverSettings.ts`) picks from legacy `settings.providers`
   enabled flags, so turning off the instance that writes titles/commits can
   fall back to that same instance. Fix on the server: choose the fallback from
   the effective instance map (envelope `enabled` over legacy). Regression test
   in `serverSettings.test.ts`. The shared enable function stops resetting the
   selection to Codex and lets the server resolve it.
2. **One environment (P1).** Setup acts on the backend environment
   (`readBackendEnvironmentConnection`: primary on desktop/self-hosted), the
   same one Settings, install and sign-in already use. The redirect gate,
   dismissal key and project list use that environment id too, never
   `activeEnvironmentId`.
3. **Redirect coverage (P1).** No index-only redirect. One reactive redirect in
   the `_chat` layout: while the gate is `pending`, any eligible surface (`/`,
   an empty draft, the no-project canvas, an empty server thread such as the
   bootstrap thread the root welcome handler opens) is replaced with `/setup`.
   Threads with user messages and General Chat drafts are never redirected.
   `/setup` sits outside `_chat`, so it cannot loop.
4. **Update in setup (P1).** Connect rows offer Update when the snapshot has a
   one-click update (required for OpenCode below its minimum version), with the
   same popover content as Settings, including the Windows process-lock
   recovery. The update runner moves out of `ProviderSettingsPanel` into a
   shared hook used by both surfaces.
5. **Folder selection stays in setup (P2).** The add-project flow gains a
   select-only mode that reports the chosen/created project instead of
   navigating; setup uses it.
6. **Detection is filesystem evidence (P2).** `found` means the same check the
   driver's probe/spawn depends on succeeds (executable on PATH or known dirs
   for bare names; for explicit paths, the probe's own existence/executable
   rule). OpenCode with `serverUrl` set, and fx on Windows, report `unknown`
   with a reason. Detection says nothing about health.
7. **Provisional snapshots (P2).** `statusReason: "provider_probe_pending"`
   maps to Checking, never to Ready or Not installed. Step 1 picks initialize
   once, after every enabled snapshot has left pending (5 s cap), and user
   edits are never overwritten. Readiness is re-derived when Continue/Start is
   pressed, including zero picks and direct `?step=folder` entry.
8. **Batch write + acknowledgement (P2).** A batch builder applies `enabled` to
   several instances on one copy of the full `providerInstances` map
   (preserving every envelope, config and custom instance) and is persisted
   with an awaited `server.updateSettings`. One-click Install from Not in use
   enables, awaits persistence, waits for the enabled snapshot to offer the
   install (bounded), then runs it.
9. **Resume across relaunch (P2).** Setup progress (step, picks, selected
   project) persists per environment in client storage; the URL step is only
   the in-session mirror.
10. **Toasts on `/setup` (P2).** Entering `/setup` closes an open provider or
    source-control update prompt without dismissing it, and clears its "seen"
    mark so it can show again after setup.
11. **Model picker (P2).** Picker search copy for a turned-off agent says it is
    off (and found, when detected) and points to Settings, instead of "isn't
    installed".

Also: `/setup` keeps the authenticated root services and command palette
(only the sidebar layout is skipped); sign-in that needs a terminal still
hands off to Settings, and setup's persisted progress plus "Open setup" brings
the user back; browser sign-in keeps the remote paste-back field; reset to
defaults moves into the opened row's footer. Telemetry is unchanged in this
piece (disabled instances stay excluded).

## Decisions during the build (2026-10-04)

- Will dropped the "Experimental" label from fx, Cursor, OpenCode and
  Antigravity everywhere (setup tiles, Settings rows, the add-instance dialog,
  and the server presentations that set it): it was visual clutter. The
  client-side label mechanism went with it; `ServerProvider.badgeLabel` stays
  in the contract for other clients.
- Second review (Sol, on the built diff) found eight issues, all fixed: a
  one-click Install lost when its row moved groups (rows now render as one
  keyed list), the text-generation fallback skipping custom instances,
  setup on the hosted app using a null environment, OpenCode's pending
  snapshot lacking `provider_probe_pending`, a reopened setup re-picking from
  detection instead of what is on, `/setup` missing the pairing guard, an
  unloaded General Chat draft counting as redirect-eligible, and the held-send
  notice dropping "Open setup".
- Sol's re-check confirmed those and found four follow-ons, all fixed: setup
  froze picks from default settings before the server config loaded (picks and
  the bounded wait now start after load); saved picks outlived the visit
  (leaving setup any way now forgets them, except mid first run so a relaunch
  resumes); a one-click Install after a failed attempt never restarted; and the
  held-send notice still hid "Open setup" while a sign-in ran.
