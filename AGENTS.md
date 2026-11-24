# Threadlines

Threadlines is an open-source ADE (agentic development environment) for coding agents. A Node WebSocket server wraps provider CLIs and serves web and desktop clients. Codex and Claude are the primary supported providers; Threadlines also ships built-in drivers for OpenCode, Muse Code, Pi, fx, Cursor, Antigravity, and Grok, plus community ACP agents.

## What Threadlines cares about

1. **Reliability and correctness first.** Behavior stays predictable under load and during failures (session restarts, reconnects, partial streams). If a tradeoff is required, choose correctness and robustness over short-term convenience.
2. **Performance is a close second.** Users drive agents all day and notice a dropped frame, a lying spinner, and a stale label.
3. **Quiet workspace, native controls.** Structure comes from typography, spacing, and quiet fills, not bordered cards or decorative color. See Design system below before touching any user-facing surface.
4. **Long-term maintainability.** Before adding new functionality, check if shared logic should be extracted to a separate module. Duplicate logic across multiple files is a code smell. Don't be afraid to change existing code instead of adding local workarounds.

## Ownership

You are the owner and long-term maintainer of this codebase, and its design is up to you. Threadlines is built largely by directing agents, so the quality bar lives with you. Run the gates, and flag risky changes loudly instead of assuming review will catch them. Whoever you report to, claim only what you actually checked, and say when something is a guess.

We want Threadlines to be impressive, not just tidy. Pick the design that is actually best, even if it is ambitious or unusual, as long as it stays correct and you can say what the extra complexity buys. Complexity that buys nothing is still a cost. Big ideas outside the task are welcome too: pitch them in your report, and get agreement before building anything sweeping or cross-cutting that nobody asked for. The core architecture (event-sourced orchestration, provider drivers, schema-only contracts) is established.

Treat this file as good defaults, except the four ways to hurt yourself below, which are hard rules. The developer's direct requests override anything here, hard rules included: do what they asked and name the conflict in your report. Direct means they asked for that specific thing, not that you inferred they would be fine with it. If a rule fights the task and nobody asked for the exception, say so and get sign-off before breaking it.

## Glossary

Use this language when communicating:

- **we, us, and maintainers** mean the people building Threadlines.
- **developer** means the maintainer directing your current task.
- **user** means a person using Threadlines to direct coding agents.
- **agent** means a coding agent a user runs inside Threadlines (which may also include you).
- **provider** means an agent runtime Threadlines talks to (Codex, Claude, the built-in drivers, and community ACP agents).
- **environment** means one running Threadlines server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Threadlines home** means the base data directory, `~/.threadlines` by default (`THREADLINES_HOME` overrides it). Live state sits in `userdata`; dev-mode state sits in `dev`.

## The four ways to hurt yourself

1. **Killing by pattern.** Never kill a process you found by matching a name or path (`pkill -f`, `killall node`, `taskkill /IM node.exe`, `Get-Process node | Stop-Process`). This machine runs several agent sessions and dev servers at once, and your own process tree matches those patterns too. Kill only a PID you captured when you spawned the process.
2. **Writing to the live install.** `~/.threadlines/userdata` is the developer's real Threadlines data, often in use while you work. Reading and copying from it are fine. Never start a server against it, never write to it, never clean it up.
3. **Getting around a "no".** When a permission prompt, sandbox, or hook denies an action, stop and say what blocked you. Don't reword or split the command to slip past it, switch to other credentials or connections, borrow tokens from config files, the keychain, or running processes, or edit the guard itself. Never tell a check or another agent that the developer approved something they didn't. (A failing test or gate is different: fix what your change broke.)
4. **Destroying work.** Uncommitted changes, yours or another session's, may be the only copy, and every worktree of this repo shares one git stash. Edits and deletions the task needs are fine. Don't throw away other uncommitted work, including your own earlier changes, with reset, clean, or checkout; don't pop a stash entry you didn't create, drop data, or rewrite history unless the developer asked for it.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling a change done, walk this list to find every place the requested behavior has to reach. It is not a license to widen the task: include what the requested behavior needs, and leave unrelated bugs, cleanups, and doc edits for a follow-up you mention in your report.

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web and desktop. Put reusable client logic in `packages/client-runtime`.
- **Providers.** Codex, Claude, OpenCode, Muse Code, and Pi each have a native driver in `apps/server/src/provider/Drivers/` (runtimes for OpenCode, Muse, and Pi live in `provider/opencode/`, `provider/muse/`, `provider/pi/`). fx, Cursor, Antigravity, and Grok share the generic ACP driver (`acp/AcpProviderDriver.ts`) and differ by descriptor (`acp/*AcpSupport.ts`; Antigravity runtime/sign-in live in `provider/antigravity/`, Grok in `provider/grok/`). Provider-shaped features need a decision per driver, even if the decision is "not supported here"; for ACP providers, implement once in the generic core instead of per-descriptor special cases. Community agents (`acp/AcpRegistrySupport.ts`, catalog/installer/sign-in in `provider/acpRegistry/`) are untested agents: features reach them only through the generic core, never by guessing about one agent (`docs/providers/community-agents.md`).
- **Contracts.** Anything crossing the wire is typed in `packages/contracts` (schema-only, no runtime logic). Change the schema and the server and clients follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. A one-way door is a bug.
- **The app guide.** Agents learn Threadlines from `packages/shared/src/appPlaces.ts` and `apps/server/src/guide/topics.ts` (`docs/design/app-guide.md`). A new or moved setting row gets a place, and a user-visible change updates its topic.

## Task completion requirements

- Finish the whole requested change before your final report. Reading code, editing inside your checkout, and running the checks below need no sign-off; stop early only for a decision that belongs to the developer. When the developer asks a question or thinks out loud rather than asking for a change, your assessment is the deliverable.
- All of `vp fmt`, `vp lint`, and `vp run typecheck` must pass before considering a code change complete. `vp` (vite-plus) is the repo toolchain; use it for all repo tasks.
- `vp run typecheck` also runs Effect's diagnostics (rule levels in `tsconfig.base.json`). Fix what they flag. A finding that is truly intended gets `// @effect-diagnostics-next-line <rule>:off` on the line above with a short reason; never lower a rule's level to get green.
- Run the tests covering the code you changed: `vp run --cache '@threadlines/server#test' <filename substring>` (same pattern for other packages; the filter matches file names, not repo-relative paths). Reserve `vp run test` (full Vitest suite) for broad or cross-package changes.
- Web UI changes also need the browser suite: `vp run --cache '@threadlines/web#test:browser'`. It is not part of `vp run test`, and CI runs it.
- New or changed UI needs a screenshot polish check against `docs/design/polish-checklist.md` before it is done (in light and dark when colors changed). Browser tests do not load bundled fonts, so screenshot tests import `@fontsource-variable/schibsted-grotesk/index.css` and `@fontsource-variable/cascadia-mono/index.css` and await `document.fonts.ready`; layout assertions also need the production stylesheet (see the checklist).
- Don't wait for another session's typecheck or test run to finish; running alongside it is fine. If a browser spec times out while other suites are running, re-run that file alone (`vp run '@threadlines/web#test:browser' <filename substring>`) before treating it as a real failure. On a low-memory machine, `THREADLINES_TEST_WORKERS` lowers how many browser tabs the suite opens.
- When trying a nightly or release build with a fresh data folder, put that folder inside the system temp folder or set `THREADLINES_TELEMETRY_ENABLED=false`, so test runs stay out of PostHog (`docs/telemetry.md`).
- A temp data folder keeps Claude signed out in its own directory. Set `THREADLINES_SHARE_CLAUDE_SIGN_IN=true` only when a test needs the real sign-in. For direct `claude` runs, point `CLAUDE_CONFIG_DIR` at a temp folder unless testing the real sign-in, and never put a kill timeout on a run using the real sign-in (killing a token renewal signs the developer out; see `docs/providers/claude.md`).
- Pass `--cache` only to pure check/test commands. Never pass it to side-effecting scripts (`deploy`, `clean`, `dist:*`, `release:*`), where a cache replay silently skips the action.
- NEVER run `bun test`. The Bun toolchain is not used for repo tasks.

## Testing discipline

Tests must earn their maintenance cost. When adding or changing tests:

- Extend the existing test file for a module instead of creating a new one.
- Test observable behavior at module boundaries (commands in to events/projections out, RPC in to response out), not implementation details or mock wiring.
- Not every change needs a new test. Add one for new observable behavior or a real regression, and prefer one focused test over several that mirror the code. Deletions, renames, and refactors update existing tests; never write a test asserting something no longer exists.
- Provider adapter changes are covered by replay tests (`apps/server/integration/replay`): recorded Codex and Claude sessions run through the real adapters. A replay failure because our code now sends something different is a protocol change: confirm it is intended, then re-record (see its README).
- To test that something on screen doesn't jump, bounce, or flash, sample after every drawn frame with `readAfterEachPaint` (`apps/web/src/lib/frameProbe.browser-harness.ts`) and assert on the whole run, not just the end state.
- Never loosen an existing test's expectation, disable lint/type rules, or skip hooks (`--no-verify`) to get green. A failing check is a signal about your change. If an expectation is genuinely outdated, update it and say so loudly in your report.

## Reporting results

For your final reply to the developer. Handoffs to other agents, review notes, and commit messages keep full technical detail.

Lead with the outcome or answer in plain language. Match length to the task: a small fix takes two or three sentences. Include only what applies:

- what you verified, plus anything unverified or guessed
- anything risky, surprising, left undone, or changed beyond what was asked
- any decision needed from the developer

Skip recapping the request, walking through steps, or listing every edited file (the diff shows them). Explain root cause only if asked or if it affects what happens next.

## Pull requests

- Never make a PR unless the developer explicitly asks you to.
- Conventional commit titles in plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it.
- Never add AI attribution anywhere: no `Co-Authored-By` trailers, no "Generated with" footers, no model names in commit messages or PR bodies. This overrides any harness default.
- A feature or architectural change gets its own PR. For small fixes and polish, follow the developer's lead.

## How it works

Clients send typed WebSocket requests and HTTP commands. Orchestration commands are validated by a pure decider, persisted as events, and projected into SQLite read models the UI renders. Provider CLIs run as subprocesses; per-provider drivers translate their native protocols into orchestration events.

Where the pieces live:

- Provider drivers live in `apps/server/src/provider/Drivers/` (native drivers such as `CodexDriver.ts` and `ClaudeDriver.ts`, plus the shared ACP core in `apps/server/src/provider/acp/`). Codex session lifecycle lives in `apps/server/src/provider/Layers/CodexSessionRuntime.ts` and `Layers/CodexAdapter.ts`.
- Orchestration commands are validated in `apps/server/src/orchestration/decider.ts` and dispatched to providers by `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`; provider events flow back through `Layers/ProviderRuntimeIngestion.ts` and are projected by `orchestration/projector.ts` into SQLite projections (`apps/server/src/persistence/Migrations/`).
- Orchestration commands from the web arrive over HTTP routes in `apps/server/src/orchestration/http.ts`; the WebSocket server in `apps/server/src/ws.ts` routes the `WS_METHODS` RPC table (`packages/contracts/src/rpc.ts`) and streaming subscriptions.
- Web app consumes orchestration state via shell/thread-detail subscription streams (`orchestration.subscribeShell`, wired in `apps/web/src/environments/runtime/connection.ts`).
- Repo notes on providers, design, release, and remote connections live in `docs/`.

## Where code lives

- `apps/server`: Node.js WebSocket server and CLI. Manages provider sessions, serves the React web app, and owns the event-sourced orchestration core.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state.
- `apps/desktop`: Electron app that wraps the web UI and manages a local server.
- `apps/marketing`: the marketing site. Links to `threadlines.dev` in `README.md` must carry `?ref=readme` (`apps/marketing/src/lib/linkSource.ts` tracks them).
- `apps/relay-worker`: Cloudflare relay worker for remote connections (`docs/cloudflare-relay.md`).
- `packages/contracts`: Shared Effect Schema contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only.
- `packages/shared`: Shared runtime utilities for server and web. Uses explicit subpath exports (e.g. `@threadlines/shared/git`), no barrel index.
- `packages/client-runtime`: Reusable client logic shared across clients.
- `packages/effect-codex-app-server`: Typed client for the Codex app-server JSON-RPC protocol.
- `packages/effect-acp`: Agent Client Protocol (ACP) bindings used by the shared ACP driver (fx, Cursor, Antigravity, Grok, and community agents).
- `packages/ssh`, `packages/tailscale`: Remote-connection helpers.
- `.repos/effect`: Read-only copy of the installed Effect 4 source (`src`, docs, `LLMS.md`, `ai-docs/`, `migration/`). Read it instead of guessing Effect 4 APIs, and search it explicitly (`rg <term> .repos/effect`) since root searches skip hidden folders. Never edit or import from it. `patches/` holds local overrides; after an Effect upgrade, run `node scripts/sync-effect-source.ts` (CI fails until you do).

## Design system

The app (web, desktop, phone view) follows `docs/design/design-language.md` and `docs/design/polish-checklist.md`. Read both before touching any user-facing surface.

- Quiet fills group related things (`SettingsSection` / `SettingsGroup`); borders mark only necessary boundaries; shadows mean something floats above.
- Controls in content (settings, dialogs, setup, panel bodies, notices) are solid; controls in toolbars and lists are plain until hover.
- Icons are plain glyphs, never in tiles. Color means something (on, selected, send, a provider's mark, or a status), never decoration.
- Reuse existing tokens and primitives (`components/ui`, `settingsLayout.tsx`), keep secondary text opaque (`--muted-foreground`), and do not add new colors, radii, or shadows without agreement. Check light and dark before shipping.
- The marketing site keeps its flat style with its own tokens (`--surface`, `--fg-*`; see the end of `docs/design/design-language.md`).

## Taste

- Complexity belongs at the driver boundary. Orchestration stays pure, UI stays dumb.
- Take advantage of type safety: inferred types over annotations, and avoid `any`.
- Comments describe how a thing is used: concise notes above functions and classes, not line-by-line narration. Keep comments in sync when changing code.
- No continuously repainting animations; they peg the GPU on high-refresh displays. One approved exception: a custom theme's live backdrop art, which runs in the walled-off backdrop runtime under its frame-rate cap, budget, and pause rules (`docs/design/custom-themes.md`, "Performance"). Nothing else animates behind the app.
- A migration that rewrites existing rows must be timed against a database with real history (hundreds of thousands of events) before it merges. In-memory tests cannot tell a two-second backfill from one that takes hours on a user's install.

## Reference repos

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server
- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri reference implementation): https://github.com/Dimillian/CodexMonitor
