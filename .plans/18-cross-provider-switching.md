# Plan: Cross-provider model switching within a thread

## Status (2026-06-10)

Feature complete end-to-end (typecheck + lint + format all green; 171 runnable
tests pass):

- [x] Step 1 — Contracts: `ThreadContextSeed` + `contextSeed` on `ProviderSessionStartInput`.
- [x] Step 2 — Shared: `renderThreadContextSeed`, `withContextSeedPreamble`, budget split.
- [x] Step 3 — Server: `ThreadContextSeedBuilder` (deterministic seed + truncation
      fallback + injected-summarizer seam).
- [x] Step 4 — Reactor: cross-driver throw replaced with a seeded handoff in
      `ensureSessionForThread`; layer wiring updated.
- [x] Step 5 — Adapters: Codex + Claude inject the rendered seed on the first turn.
- [x] Step 6 — Web: picker unlocked (`lockedProvider={null}`), `classifyModelSwitch`
      routes a driver change through a confirm dialog with "Don't ask again"
      (`suppressCrossProviderSwitchWarning` client setting).
- [x] Step 7 — Reactor handoff tests rewritten from "reject" to "seeded handoff"
      (active + stopped session). SQLite-backed: run under bun/CI, typecheck-clean here.
- [ ] Follow-up — wire the real cheap-model summarizer into the builder's
      `summarize` seam (currently truncation-only; seam is in place).

Note: local env is Node 22.13.1 with no bun, so SQLite-backed tests (reactor,
integration, full server suite) and browser web tests can't run here — validated
via full typecheck + lint. Pure tests (contracts, shared, builder, adapters,
ChatView.logic) run and pass.

## Goal

Allow a single thread to switch between providers (Codex ↔ Claude, and any
driver pair) mid-conversation. Today a thread hard-locks to one driver on its
first turn. We relax that lock and carry conversation continuity across the
switch by rehydrating the new provider from a provider-agnostic **context
seed** built from the orchestration transcript — instead of the opaque,
adapter-owned `resumeCursor`, which is not portable across drivers.

## Why this is tractable here

- The orchestration layer already stores a provider-agnostic source of truth:
  `OrchestrationThread.messages` (user/assistant/system text) and `activities`
  (tool/approval summaries via the `summary` field, raw detail in `payload`).
- The working tree is shared across providers (same `cwd`) and git checkpoints
  are provider-agnostic (keyed by `threadId` + turn count). In a coding agent,
  the disk is most of the context, and it carries over for free.
- Switching a provider session is already a battle-tested operation:
  `ProviderCommandReactor.ensureSessionForThread` stops + restarts sessions on
  model/instance/runtime/cwd changes (within a driver), reusing `resumeCursor`.
  Cross-driver is the only case currently blocked.

## Current constraints (what blocks it today)

1. Server guard: `ensureSessionForThread`
   (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:430`) throws
   `ProviderAdapterRequestError` when a turn requests a different driver than the
   bound session ("cannot switch from driver X to Y"). A second block (`:438`)
   rejects same-driver instance switches with incompatible `continuationKey`.
2. Client lock: `deriveLockedProvider`
   (`apps/web/src/components/ChatView.logic.ts:406`) locks the model picker to
   the session's provider once the thread has started.
3. Continuity is provider-native: `ProviderSession.resumeCursor` is opaque and
   adapter-owned (Codex rollout/thread ref vs Claude session id +
   `resumeSessionAt`). `continuationKey` (`ProviderDriver.ts:76`) exists to gate
   compatibility; cross-driver keys never match.

## Design

The thread transcript is canonical; a provider session is a disposable
execution context seeded from it. On a **cross-driver** switch:

1. Stop the old provider session.
2. Build a `ThreadContextSeed` from the orchestration read model.
3. Start the new driver's session with `contextSeed` (no native resume).
4. Rebind the thread→session binding (existing `ProviderSessionDirectory`).

Same-driver switches keep the existing native-resume fast path untouched. Only
cross-driver falls back to seed rehydration.

### Seed fidelity (tiered, deterministic-first)

The seed is built with per-component policies — bloat comes from raw tool
output, not the conversation:

1. **Messages (user + assistant): verbatim.** The narrative spine.
2. **Tool actions: existing `activity.summary` strings, not raw `payload`.**
3. **Working tree: not embedded** — a one-line pointer ("the repo at `<cwd>`
   reflects in-progress work from this thread; run `git diff` to see changes").
4. **Compaction: budget-triggered only.** Keep the last K turns verbatim
   (recency window); if the rendered seed exceeds a token budget, LLM-summarize
   only the older prefix using the cheap text-generation model
   (`DEFAULT_GIT_TEXT_GENERATION_MODEL` = `gpt-5.4-mini`, per-provider defaults
   exist). Deterministic fallback: if the summarizer fails/times out, drop the
   oldest entries with a `[earlier history omitted]` marker. The switch must
   never hard-depend on a model call. Cache the compacted prefix by
   `(threadId, upToTurn)`.

### Trigger & scope

- Universal capability; no per-thread flag. Backwards compatible because the
  trigger is an explicit user provider switch — threads that never cross a
  driver boundary behave exactly as today.
- Trigger: the existing model picker, made cross-provider (relax the lock), with
  a one-time confirm dialog ("don't ask again") shown only when the selection
  crosses a *driver* boundary. Copy sets the right expectation: carries a recap
  + working tree, not the other model's full internal reasoning.
- v1 scope: **different-driver** switches only. Same-driver incompatible-instance
  switches (the `:438` guard) keep current behavior; the seed mechanism could
  smooth them later.

## Build order (each step typechecks independently)

### Step 1 — Contracts (additive, safe)
- Add `ThreadContextSeed` schema to `packages/contracts/src/provider.ts`
  (or a new `contextSeed.ts`): `version`, `fromProvider`, `entries`
  (recent verbatim messages + tool summaries), optional `olderSummary`
  (compacted prefix), optional `workspacePointer`.
- Add optional `contextSeed: ThreadContextSeed` to `ProviderSessionStartInput`.
- Contract tests for decode + back-compat (absent field).

### Step 2 — Shared rendering/selection (additive, pure)
- `packages/shared/src/contextSeed.ts`:
  - `renderThreadContextSeed(seed): string` → markdown block adapters inject.
  - `selectSeedEntries(...)` → recency-window selection + budget estimate.
- Unit tests (pure functions).

### Step 3 — Server seed builder (additive, not yet wired)
- `apps/server/src/provider/contextSeed/ThreadContextSeedBuilder.ts` service:
  reads thread detail via `ProjectionSnapshotQuery.getThreadDetailById`, builds
  the seed, runs budget-triggered compaction via `TextGeneration` with the
  deterministic truncation fallback + prefix cache.
- Tests with a fake TextGeneration (success + failure→fallback paths).

### Step 4 — Reactor handoff (behavioral)
- In `ensureSessionForThread`, replace the cross-driver throw at `:430` with the
  handoff: build seed → `startProviderSession({ contextSeed })` on the new
  driver → rebind. Keep the `:438` same-driver-incompatible block as-is.
- Reactor tests: cross-driver switch starts a new session carrying the seed;
  same-driver path unchanged.

### Step 5 — Adapter seed injection (behavioral)
- `CodexAdapter` + `ClaudeAdapter`: when `startSession` receives `contextSeed`
  and there is no native resume, inject the rendered seed as a priming preamble
  on the first user message (Claude: `buildPromptText`/`buildUserMessageEffect`;
  Codex: equivalent first-input path).
- Adapter tests asserting the seed text reaches the first prompt.

### Step 6 — Web (UX)
- Relax `deriveLockedProvider` so the picker stays cross-provider after start.
- Cross-driver confirm dialog with "don't ask again" (client settings).
- Dispatch path already carries `modelSelection` per turn; ensure a cross-driver
  pick flows through.

### Step 7 — Integration tests
- Orchestration-level: Codex thread → switch to Claude → Claude session starts
  seeded, turn completes, working tree intact, checkpoints continue.

## Non-goals
- No multi-warm-session (one live session per provider) — a later optimization.
- No new WS channels.
- No per-thread "multi-model mode" flag.
- Not storing per-driver resume cursors to resume natively on switch-back (later).

## Open risks
- Seed fidelity vs. token cost on long threads — mitigated by recency window +
  compaction + leaning on the shared working tree.
- Claude/Codex differ on how cleanly a "priming preamble" is accepted; verify
  each adapter renders the seed without confusing turn accounting.
