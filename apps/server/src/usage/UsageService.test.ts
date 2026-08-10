// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, UsageDay, type UsageSummary } from "@threadlines/contracts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UsageService, UsageServiceLive } from "./UsageService.ts";

const CLAUDE_MODEL = "claude-fable-5";
const CODEX_MODEL = "gpt-5.6-sol";

/** Minimal LiteLLM document covering just the two models the fixtures use. */
const RATE_DOCUMENT = {
  [CLAUDE_MODEL]: {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  },
  [CODEX_MODEL]: {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 2e-7,
  },
};

const ratesHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(RATE_DOCUMENT), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ),
);

function claudeAssistantLine(input: {
  readonly messageId: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly outputTokens: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    sessionId: input.sessionId,
    requestId: input.requestId,
    message: {
      id: input.messageId,
      role: "assistant",
      model: CLAUDE_MODEL,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: input.outputTokens,
      },
    },
  });
}

function codexRollout(input: {
  readonly sessionId: string;
  readonly forkedFromId?: string;
  /** `[timestamp, inputTokens, outputTokens]` per usage event. */
  readonly events: readonly (readonly [string, number, number])[];
  readonly openedAt: string;
}): string {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: input.openedAt,
      payload: {
        id: input.sessionId,
        forked_from_id: input.forkedFromId ?? null,
        source: "vscode",
      },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: input.openedAt,
      payload: { model: CODEX_MODEL },
    }),
  ];
  for (const [timestamp, inputTokens, outputTokens] of input.events) {
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: inputTokens,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: outputTokens,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lays out a throwaway provider home pair and the server state dir the scan
 * cache lives in. Real files on disk: the whole point of the service is what it
 * finds by walking them.
 */
const makeFixture = Effect.fn("makeFixture")(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "threadlines-usage-")),
  );
  const claudeHome = NodePath.join(root, "claude-home");
  const claudeProjects = NodePath.join(claudeHome, ".claude", "projects", "-tmp-project");
  const codexHome = NodePath.join(root, "codex-home");
  const codexSessions = NodePath.join(codexHome, "sessions", "2026", "08", "07");

  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(claudeProjects, { recursive: true });
    await NodeFSP.mkdir(codexSessions, { recursive: true });

    // Two content blocks of one message repeat the same usage, and the same
    // message is replayed into a second transcript: one record must survive.
    const repeated = [
      claudeAssistantLine({
        messageId: "msg_1",
        requestId: "req_1",
        timestamp: "2026-08-07T12:00:00.000Z",
        sessionId: "claude-session",
        outputTokens: 40,
      }),
      claudeAssistantLine({
        messageId: "msg_1",
        requestId: "req_1",
        timestamp: "2026-08-07T12:00:00.000Z",
        sessionId: "claude-session",
        outputTokens: 40,
      }),
    ];
    await NodeFSP.writeFile(
      NodePath.join(claudeProjects, "session-a.jsonl"),
      `${repeated.join("\n")}\n`,
    );
    await NodeFSP.writeFile(NodePath.join(claudeProjects, "session-b.jsonl"), `${repeated[0]!}\n`);

    await NodeFSP.writeFile(
      NodePath.join(codexSessions, "rollout-parent.jsonl"),
      codexRollout({
        sessionId: "codex-parent",
        openedAt: "2026-08-07T12:00:00.000Z",
        events: [["2026-08-07T12:00:10.000Z", 500, 20]],
      }),
    );
    // The fork replays the parent's turn re-stamped to the fork instant, then
    // runs one turn of its own. Only the second may be counted.
    await NodeFSP.writeFile(
      NodePath.join(codexSessions, "rollout-fork.jsonl"),
      codexRollout({
        sessionId: "codex-fork",
        forkedFromId: "codex-parent",
        openedAt: "2026-08-07T13:00:00.000Z",
        events: [
          ["2026-08-07T13:00:00.001Z", 500, 20],
          ["2026-08-07T13:00:30.000Z", 700, 35],
        ],
      }),
    );
  });

  const derivedPaths = yield* deriveServerPaths(NodePath.join(root, "state"), undefined).pipe(
    Effect.provide(NodeServices.layer),
  );
  const config: ServerConfigShape = {
    appVersion: "0.0.0-test",
    logLevel: "Info",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 1024,
    traceMaxFiles: 1,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "threadlines-server",
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    advertisedHost: undefined,
    cwd: root,
    baseDir: NodePath.join(root, "state"),
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
  yield* Effect.promise(() => NodeFSP.mkdir(config.stateDir, { recursive: true }));

  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: claudeHome },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: codexHome },
    },
  };

  const layer = UsageServiceLive.pipe(
    Layer.provide(
      Layer.mock(ServerSettingsService)({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(settings),
        updateSettings: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
      }),
    ),
    Layer.provide(Layer.succeed(ServerConfig, config)),
    Layer.provide(ratesHttpClientLayer),
    Layer.provide(NodeServices.layer),
  );

  return { root, claudeProjects, config, layer } as const;
});

const window = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "UTC",
};

function bucketFor(summary: UsageSummary, provider: "claude" | "codex") {
  return summary.buckets.find((bucket) => bucket.provider === provider);
}

describe("UsageService.readSummary", () => {
  // it.live throughout: the service walks real directories and reads the real
  // clock, both of which stall under it.effect's TestClock.
  it.live("prices a window, dropping repeated Claude usage and copied fork turns", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const summary = yield* Effect.provide(
        Effect.flatMap(UsageService, (usage) => usage.readSummary(window)),
        fixture.layer,
      );

      const claude = bucketFor(summary, "claude");
      // One message, repeated twice in one file and once more in a second.
      expect(claude?.records).toBe(1);
      expect(claude?.totals.outputTokens).toBe(40);
      // 10*1e-5 + 1000*1e-6 + 100*1.25e-5 + 40*5e-5
      expect(claude?.costUsd).toBeCloseTo(0.00435, 9);
      expect(claude?.costSource).toBe("modelPriced");

      const codex = bucketFor(summary, "codex");
      // Parent's single turn plus the fork's own turn; the fork's replayed copy
      // of the parent turn must not be counted a second time.
      expect(codex?.records).toBe(2);
      expect(codex?.totals.outputTokens).toBe(55);
      expect(codex?.sessions).toBe(2);

      expect(summary.pricing.status).toBe("fresh");
      expect(summary.sources.map((source) => source.status)).toEqual(["ok", "ok"]);
      expect(summary.sources.every((source) => source.lastScannedAt.length > 0)).toBe(true);
      yield* Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true }));
    }),
  );

  it.live("picks up a transcript that changed and leaves the rest memoised", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const read = Effect.provide(
        Effect.flatMap(UsageService, (usage) => usage.readSummary(window)),
        fixture.layer,
      );

      const before = yield* read;
      expect(bucketFor(before, "claude")?.totals.outputTokens).toBe(40);

      yield* Effect.promise(() =>
        NodeFSP.appendFile(
          NodePath.join(fixture.claudeProjects, "session-a.jsonl"),
          `${claudeAssistantLine({
            messageId: "msg_2",
            requestId: "req_2",
            timestamp: "2026-08-08T12:00:00.000Z",
            sessionId: "claude-session",
            outputTokens: 7,
          })}\n`,
        ),
      );

      const after = yield* read;
      const claudeBuckets = after.buckets.filter((bucket) => bucket.provider === "claude");
      expect(claudeBuckets.map((bucket) => bucket.day)).toEqual(["2026-08-07", "2026-08-08"]);
      expect(claudeBuckets[1]?.totals.outputTokens).toBe(7);

      yield* Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true }));
    }),
  );

  it.live("rejects a window longer than the cache retains", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const failure = yield* Effect.provide(
        Effect.flatMap(UsageService, (usage) =>
          usage.readSummary({
            sinceDay: UsageDay.make("2025-08-01"),
            untilDay: UsageDay.make("2026-08-31"),
            timeZone: "UTC",
          }),
        ),
        fixture.layer,
      ).pipe(Effect.flip);

      expect(failure.reason).toBe("invalidWindow");
      yield* Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true }));
    }),
  );
});
