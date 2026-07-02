# AGENTS.md

## Task Completion Requirements

- All of `vp fmt`, `vp lint`, and `vp run typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. The Bun toolchain is not used for repo tasks; use `vp run test` for the full Vitest suite.

## Project Snapshot

Threadlines is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Manages provider sessions (Codex, Claude, Cursor, OpenCode), serves the React web app, and owns the event-sourced orchestration core.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@threadlines/shared/git`) — no barrel index.

## Provider Sessions and Orchestration (Important)

Threadlines is multi-provider. Each provider is wrapped by a driver (`apps/server/src/provider/Drivers/` — Codex, Claude, Cursor, OpenCode); Codex still runs via `codex app-server` (JSON-RPC over stdio). Provider runtime activity is ingested into the event-sourced orchestration core and projected into read models that the browser consumes.

How the pieces fit:

- Codex session startup/resume and turn lifecycle live in `apps/server/src/provider/Layers/CodexSessionRuntime.ts` (with `Drivers/CodexDriver.ts` and `Layers/CodexAdapter.ts`).
- Orchestration commands are validated in `apps/server/src/orchestration/decider.ts` and dispatched to providers by `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`; provider events flow back through `Layers/ProviderRuntimeIngestion.ts` and are projected by `orchestration/projector.ts` into SQLite projections (`apps/server/src/persistence/Migrations/`).
- Orchestration commands from the web arrive over HTTP routes in `apps/server/src/orchestration/http.ts`; the WebSocket server in `apps/server/src/ws.ts` routes the `WS_METHODS` RPC table (`packages/contracts/src/rpc.ts`) and streaming subscriptions.
- Web app consumes orchestration state via the shell/thread-detail subscription streams (`orchestration.subscribeShell`, wired in `apps/web/src/environments/runtime/connection.ts`).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
