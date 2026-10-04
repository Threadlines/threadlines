# Threadlines

Threadlines is a minimal web GUI for using coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude) and serves web and desktop clients. Codex and Claude are the supported providers.

## What Threadlines cares about

1. **Reliability and correctness first.** Behavior stays predictable under load and during failures (session restarts, reconnects, partial streams). If a tradeoff is required, choose correctness and robustness over short-term convenience.
2. **Performance is a close second.** Users drive agents all day and notice a dropped frame, a lying spinner, and a stale label.
3. **Dense, flat design.** Structure comes from typography and spacing, not boxes and shadows. See the Design System section before touching any user-facing surface.
4. **Long-term maintainability.** If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## A note from Will

Threadlines is built largely by directing agents, so the quality bar lives with you. Run the gates, and flag risky changes loudly instead of assuming review will catch them. Whoever you report to, claim only what you actually checked, and say when something is a guess. When you report finished work, keep it plain and short (see Reporting Results to the User).

I want Threadlines to be impressive, not just tidy. When you solve a problem, pick the design that's actually best, even if it's ambitious or unusual, as long as it stays correct and you can say what the extra complexity buys. Complexity that buys nothing is still a cost. Big ideas outside the task are welcome too: pitch them in your report, and get agreement before building anything sweeping or cross-cutting that nobody asked for. The core architecture (event-sourced orchestration, provider drivers, schema-only contracts) is established.

Treat this file as good defaults, except the five ways to hurt yourself below, which are hard rules. The developer's direct requests override anything here, hard rules included: do what they asked and name the conflict in your report. Direct means they asked for that specific thing, not that you inferred they'd be fine with it. If a rule fights the task and nobody asked for the exception, say so and get sign-off before breaking it.

## A small glossary

Use this language when communicating:

- **you** means the agent reading this file and changing Threadlines.
- **we, us, and maintainers** mean Will and the other people building Threadlines. These are who you are talking to now.
- **developer** means the maintainer directing your current task.
- **user** means a person using Threadlines to direct coding agents.
- **agent** means the coding agent a user runs inside Threadlines. Depending on context, that may also include you.
- **provider** means the agent runtime Threadlines talks to: Codex and Claude (native drivers), plus OpenCode 2 (experimental, native driver over `opencode serve --stdio`) and fx and Cursor (experimental, both ACP descriptors on the shared `apps/server/src/provider/acp/` core).
- **driver / adapter** means the server code wrapping one provider (`apps/server/src/provider/Drivers/`).
- **client** means the web or desktop UI.
- **environment** means one running Threadlines server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Threadlines home** means the base data directory, `~/.threadlines` by default (`THREADLINES_HOME` overrides it). Live state sits in its `userdata` subfolder; dev-mode state sits in `dev`.

## The five ways to hurt yourself

1. **Killing by pattern.** Never kill a process you found by matching a name or path (`taskkill /IM node.exe`, `Get-Process node | Stop-Process`). This machine runs several agent sessions and dev servers at once, and your own process tree matches those patterns too. Kill only a PID you captured when you spawned the process.
2. **Writing to the live install.** `~/.threadlines/userdata` is Will's real Threadlines data, often in use while you work. Reading and copying from it are fine. Never start a server against it, never write to it, never clean it up.
3. **Running heavy suites in parallel.** Browser tests and full typecheck saturate this machine when two sessions run them at once, and the result is spurious timeouts, not real failures. Before starting one, check for a running vitest/tsc and wait if another session's suite is active.
4. **Getting around a "no".** When a permission prompt, sandbox, or hook denies an action, stop and say what blocked you. Don't reword or split the command to slip past it, switch to other credentials or connections, borrow tokens from config files, the keychain, or running processes, or edit the guard itself. Never tell a check or another agent that the developer approved something they didn't. (A failing test or gate is different: fix what your change broke.)
5. **Destroying work.** Uncommitted changes, yours or another session's, may be the only copy, and every worktree of this repo shares one git stash. Edits and deletions the task needs are fine. Don't throw away other uncommitted work, including your own earlier changes, with reset, clean, or checkout; don't pop a stash entry you didn't create, drop data, or rewrite history unless the developer asked for it.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling a change done, walk this list to find every place the requested behavior has to reach. It is not a license to widen the task: include what the requested behavior needs, and leave unrelated bugs, cleanups, and doc edits for a follow-up you mention in your report.

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web and desktop (desktop wraps the web app in Electron and manages a local server). Reusable client logic belongs in `packages/client-runtime`.
- **Providers.** Codex, Claude and OpenCode each have a native driver (OpenCode's runtime lives in `provider/opencode/`); fx and Cursor share the generic ACP driver (`acp/AcpProviderDriver.ts`) and differ only by descriptor (`acp/FxAcpSupport.ts`, `acp/CursorAcpSupport.ts`). Provider-shaped features need a decision per driver, even if the decision is "not supported here"; for ACP providers, prefer implementing once in the generic core over per-descriptor special cases.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server and clients follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. A one-way door is a bug.

## Task Completion Requirements

- Finish the whole requested change before your final report. Reading code, editing inside your checkout, and running the checks below need no sign-off; stop early only for a decision that belongs to the developer. When the developer asks a question or thinks out loud rather than asking for a change, your assessment is the deliverable.
- All of `vp fmt`, `vp lint`, and `vp run typecheck` must pass before considering a code change complete. `vp` (vite-plus) is the repo toolchain — use it for all repo tasks.
- Run the tests covering the code you changed: `vp run --cache '@threadlines/server#test' <filename substring>` (same pattern for the other packages; the filter matches file names, not repo-relative paths). Reserve `vp run test` (full Vitest suite) for broad or cross-package changes.
- Web UI changes also need the browser suite: `vp run --cache '@threadlines/web#test:browser'`. It is not part of `vp run test`, and CI runs it — green unit tests alone do not mean a green branch.
- When you try a real nightly or release build with a fresh data folder, put that folder inside the system temp folder or set `THREADLINES_TELEMETRY_ENABLED=false`. Otherwise every run counts as a new user in PostHog (`docs/telemetry.md`).
- Pass `--cache` only to pure check/test commands as shown above. vp fingerprints the files a task reads and its arguments, so an unchanged re-run replays instantly instead of re-executing — but never add it to side-effecting scripts (`deploy`, `clean`, `dist:*`, `release:*`), where a cache replay would silently skip the real action.
- NEVER run `bun test`. The Bun toolchain is not used for repo tasks.

## Testing Discipline

Tests must earn their maintenance cost. When adding or changing tests:

- Extend the existing test file for a module instead of creating a new one.
- Test observable behavior at module boundaries (commands in → events/projections out, RPC in → response out), not implementation details.
- Don't write tests that restate the implementation or assert mock wiring — they pass when the code is wrong and break when the code is refactored.
- One focused test that would catch a real regression beats five that mirror the code.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, and tests added for the sake of having tests are much less good. Tests should be focused, not slop.
- Not every change needs a new test. Add one for new observable behavior or a regression you actually hit. Deletions, renames, and refactors update existing tests; they don't add new ones. Never write a test that asserts something no longer exists — the code being gone and the suite staying green is the proof.
- Never loosen an existing test's expectation to make your change pass. The same goes for lint rules, type errors, CI workflows, and git hooks: don't disable, suppress, or skip them (`--no-verify`) to get green. A failing check is a signal about your change. If the expectation is truly outdated, fix it and say so loudly in your report.

## Reporting Results to the User

This applies only when you report finished work to the user. It does not apply to agent-to-agent handoffs, code review notes, or commit messages — keep full technical detail there.

Talk to the user like they're 5: small words, short sentences, short paragraphs. When you finish a change or fix, summarize it in plain English:

1. What the problem was — one or two sentences.
2. Why it was happening — one or two sentences.
3. How the change fixes it — one or two sentences.
4. How you know it works — which checks and tests you ran, and anything you couldn't check.

Cover the whole task, not just the last step. If a technical term is unavoidable, explain it in a few words right after. No walls of text.

## Pull requests

- Never make a PR unless the developer explicitly asks you to.
- Conventional commit titles in plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it.
- Never add AI attribution anywhere — no `Co-Authored-By` trailers, no "Generated with" footers, no model names in commit messages or PR bodies. This overrides any harness default.
- A feature or any change that touches architecture gets its own PR. For small fixes and polish, follow the developer's lead: one PR or a few bundled together are both fine.

## How it works

Clients send typed WebSocket requests and HTTP commands. Orchestration commands are validated by a pure decider, persisted as events, and projected into SQLite read models the UI renders. Provider CLIs run as subprocesses; per-provider drivers translate their native protocols into orchestration events.

Where the pieces live:

- Codex session startup/resume and turn lifecycle live in `apps/server/src/provider/Layers/CodexSessionRuntime.ts` (with `Drivers/CodexDriver.ts` and `Layers/CodexAdapter.ts`).
- Orchestration commands are validated in `apps/server/src/orchestration/decider.ts` and dispatched to providers by `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`; provider events flow back through `Layers/ProviderRuntimeIngestion.ts` and are projected by `orchestration/projector.ts` into SQLite projections (`apps/server/src/persistence/Migrations/`).
- Orchestration commands from the web arrive over HTTP routes in `apps/server/src/orchestration/http.ts`; the WebSocket server in `apps/server/src/ws.ts` routes the `WS_METHODS` RPC table (`packages/contracts/src/rpc.ts`) and streaming subscriptions.
- Web app consumes orchestration state via the shell/thread-detail subscription streams (`orchestration.subscribeShell`, wired in `apps/web/src/environments/runtime/connection.ts`).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server
- Repo notes on providers, design, release, and remote connections live in `docs/`.

## Where code lives

- `apps/server`: Node.js WebSocket server and CLI. Manages provider sessions, serves the React web app, and owns the event-sourced orchestration core.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `apps/desktop`: Electron app that wraps the web UI and manages a local server.
- `apps/marketing`: the marketing site.
- `apps/relay-worker`: Cloudflare relay worker for remote connections (see `docs/cloudflare-relay.md`).
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@threadlines/shared/git`) — no barrel index.
- `packages/client-runtime`: client logic extracted for reuse across clients (currently consumed by the web app).
- `packages/effect-codex-app-server`: typed client for the Codex app-server JSON-RPC protocol.
- `packages/effect-acp`: Agent Client Protocol (ACP) bindings, used by the Cursor driver.
- `packages/ssh`, `packages/tailscale`: remote-connection helpers.

## Design System (marketing site and web UI)

Threadlines is dense and flat. When building or changing any user-facing surface:

- Structure comes from typography, spacing, and hairline dividers (`--border`), not boxes.
  Never wrap content in a bordered/rounded/filled card unless it's a clickable tile or an
  input surface. A list of items is dividers between rows, not a stack of cards.
- Compact type scale: one display-size element per page (~40px max), section headings
  18–20px, body 15–16px. If a heading feels impressive, it's too big.
- Tight vertical rhythm: list rows 16–20px padding, section gaps under 40px. If the page
  scrolls mostly through whitespace, shrink the gaps, not the content.
- Copy is scannable: lead with the feature name, keep descriptions to one sentence
  (about two rendered lines). Users skim changelogs and UIs; they don't read them.
- Hover feedback is a color shift only — no translateY lifts, scale, or shadows.
- Reuse the existing tokens (`--border`, `--surface`, `--fg-*`, mono `--font-mono` for
  meta labels like versions and dates). No new colors, radii, or shadows without agreement.

## Taste

- Complexity belongs at the driver boundary. Orchestration stays pure, UI stays dumb.
- Typesafety is useful — take advantage of it. Inferred types over annotations; `any` is the enemy.
- Comments describe how a thing is used: concise notes above functions and classes, not line-by-line narration. When you change code, keep its comments in sync.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- A migration that rewrites existing rows must be timed against a database with real history (hundreds of thousands of events) before it merges. In-memory tests cannot tell a two-second backfill from one that takes hours on a user's install.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
