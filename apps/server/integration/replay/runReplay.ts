/**
 * Runs a replay scenario on the integration harness, against a recorded
 * transcript (replay) or the real provider with a recorder attached (record).
 */
import * as Stream from "effect/Stream";
import type { SecretScrubberShape } from "../../src/secrets/SecretScrubber.ts";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  type OrchestrationThread,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";

import { makeClaudeAdapter } from "../../src/provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../../src/provider/Layers/CodexAdapter.ts";
import {
  makeOrchestrationIntegrationHarness,
  type RealProviderAdapter,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClaudeRecordingQuery, makeClaudeReplayQuery } from "./claudeTransport.ts";
import { makeCodexRecordingSpawner, makeCodexReplaySpawner } from "./codexTransport.ts";
import type { Recorder, ReplayPaths } from "./recorder.ts";
import {
  makeScenarioContext,
  setUpScenarioThread,
  THREAD_ID,
  type ReplayProvider,
  type ReplayScenario,
} from "./scenarios.ts";
import type { ReplayCursor, Transcript } from "./transcript.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

/** Settings that would make our code send requests at times a replay can't reproduce. */
const REPLAY_SERVER_SETTINGS = { codexSuggestions: false } as const;

type ProviderMode =
  | { readonly kind: "replay"; readonly transcript: Transcript }
  | { readonly kind: "record"; readonly recorder: (paths: ReplayPaths) => Recorder };

function codexAdapter(
  mode: ProviderMode,
  paths: ReplayPaths,
  onCursor: (cursor: ReplayCursor) => void,
  onRecorder: (recorder: Recorder) => void,
): RealProviderAdapter {
  return {
    kind: ProviderDriverKind.make("codex"),
    make: Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      let spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
      if (mode.kind === "replay") {
        const replay = makeCodexReplaySpawner(real, mode.transcript, paths);
        onCursor(replay.cursor);
        spawner = replay.spawner;
      } else {
        const recorder = mode.recorder(paths);
        onRecorder(recorder);
        spawner = makeCodexRecordingSpawner(real, recorder);
      }
      const settings = yield* decodeCodexSettings({});
      return yield* makeCodexAdapter(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    }).pipe(Effect.orDie),
  };
}

function claudeAdapter(
  mode: ProviderMode,
  paths: ReplayPaths,
  onCursor: (cursor: ReplayCursor) => void,
  onRecorder: (recorder: Recorder) => void,
): RealProviderAdapter {
  return {
    kind: ProviderDriverKind.make("claudeAgent"),
    make: Effect.gen(function* () {
      if (mode.kind === "replay") {
        const replay = makeClaudeReplayQuery(mode.transcript, paths);
        onCursor(replay.cursor);
        // Never run: the replay answers instead of the Claude program, which
        // need not be installed.
        const settings = yield* decodeClaudeSettings({ binaryPath: process.execPath });
        return yield* makeClaudeAdapter(settings, { createQuery: replay.createQuery });
      }
      const recorder = mode.recorder(paths);
      onRecorder(recorder);
      const { query } = yield* Effect.promise(() => import("@anthropic-ai/claude-agent-sdk"));
      const settings = yield* decodeClaudeSettings({});
      return yield* makeClaudeAdapter(settings, {
        createQuery: makeClaudeRecordingQuery(
          (input) => query(input as Parameters<typeof query>[0]) as never,
          recorder,
        ),
      });
    }).pipe(Effect.orDie),
  };
}

export interface ScenarioOutcome {
  readonly thread: OrchestrationThread;
  readonly cursor: ReplayCursor | null;
  readonly recorder: Recorder | null;
}

/**
 * Runs `scenario` for `provider` and checks it. In replay mode it also fails
 * unless the whole recording was used.
 */
export const runReplayScenario = (input: {
  readonly provider: ReplayProvider;
  readonly scenario: ReplayScenario;
  readonly mode: ProviderMode;
  readonly timeoutMs: number;
  /** Keys to watch from the start (docs/design/secret-scrubbing.md); the scenario's own check is skipped, since hiding changes its text. */
  readonly secretScrubber?: SecretScrubberShape;
  /** Runs on every stored event and the final thread instead of the scenario's check. */
  readonly inspect?: (stored: {
    readonly events: ReadonlyArray<unknown>;
    readonly thread: OrchestrationThread;
  }) => void;
}) =>
  Effect.gen(function* () {
    let cursor: ReplayCursor | null = null;
    let recorder: Recorder | null = null;
    const harness = yield* makeOrchestrationIntegrationHarness({
      provider: ProviderDriverKind.make(input.provider),
      serverSettings: REPLAY_SERVER_SETTINGS,
      ...(input.secretScrubber !== undefined ? { secretScrubber: input.secretScrubber } : {}),
      realAdapter: (paths) =>
        (input.provider === "codex" ? codexAdapter : claudeAdapter)(
          input.mode,
          paths,
          (value) => (cursor = value),
          (value) => (recorder = value),
        ),
    });
    const outcome = yield* Effect.gen(function* () {
      yield* setUpScenarioThread(harness, input.provider, input.scenario);
      const context = makeScenarioContext({
        harness,
        provider: input.provider,
        scenario: input.scenario,
        failure: () => (cursor as ReplayCursor | null)?.failure ?? null,
        timeoutMs: input.timeoutMs,
      });
      yield* input.scenario.run(context);
      const snapshot = yield* harness.snapshotQuery.getSnapshot().pipe(Effect.orDie);
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      if (thread === undefined)
        return yield* Effect.die(new Error("The scenario's thread is gone."));
      if (input.inspect !== undefined) {
        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(Effect.orDie);
        input.inspect({ events: [...events], thread });
      } else {
        input.scenario.check(thread, context);
      }
      (cursor as ReplayCursor | null)?.assertComplete();
      return { thread, cursor, recorder } satisfies ScenarioOutcome;
    }).pipe(Effect.ensuring(harness.dispose));
    // Shutting the session down sends frames too: a mismatch then fails the test.
    const failure = (cursor as ReplayCursor | null)?.failure ?? null;
    if (failure !== null) return yield* Effect.die(failure);
    return outcome;
  });
