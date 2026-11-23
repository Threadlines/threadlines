// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { UsageLedgerEntry } from "../../usage/usageLedger.ts";
import { makeAcpAdapter } from "../acp/AcpAdapter.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAntigravityDescriptor } from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityFailure,
  antigravityTurnUsageTotals,
  antigravityWorkAfterPrompt,
} from "./AntigravityTurns.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/antigravity-mock-agent.ts",
);
const isWindows = process.platform === "win32";

/** An `agy` stand-in playing `scenario`: the mock behind a wrapper the descriptor launches. */
async function makeAgyMock(scenario: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-acp-mock-"));
  const log = path.join(dir, "frames.jsonl");
  const wrapper = path.join(dir, isWindows ? "agy.cmd" : "agy");
  await writeFile(
    wrapper,
    isWindows
      ? `@echo off\r\nset "AGYMOCK_SCENARIO=${scenario}"\r\nset "AGYMOCK_LOG=${log}"\r\n"${process.execPath}" "${mockAgentPath}" %*\r\n`
      : `#!/bin/sh\nexport AGYMOCK_SCENARIO=${JSON.stringify(scenario)}\nexport AGYMOCK_LOG=${JSON.stringify(log)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return { dir, wrapper, log };
}

async function readFrames(file: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Starts an Antigravity session on the stand-in, collecting every runtime event. */
const startAgy = (scenario: string) =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => makeAgyMock(scenario));
    const descriptor = makeAntigravityDescriptor({
      paths: { profileDir: path.join(mock.dir, "profile"), tempRoot: path.join(mock.dir, "tmp") },
      runtime: undefined,
      releases: undefined,
      signIn: { method: "oauth-personal", project: "", location: "", key: "" },
    });
    const usage: Array<UsageLedgerEntry> = [];
    const adapter = yield* makeAcpAdapter(
      descriptor,
      decodeSettings({ enabled: true, binaryPath: mock.wrapper }),
      { recordTurnUsage: (entry) => Effect.sync(() => void usage.push(entry)) },
    );
    const events: Array<ProviderRuntimeEvent> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.forkScoped,
    );
    const threadId = ThreadId.make(`agy-${scenario}`);
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("antigravity"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const waitFor = (predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
          if (predicate(events)) return;
          yield* Effect.sleep("10 millis");
        }
        throw new Error(`Timed out; saw ${events.map((event) => event.type).join(", ")}`);
      });
    return {
      adapter,
      events,
      usage,
      threadId,
      session,
      waitFor,
      frames: () => Effect.promise(() => readFrames(mock.log)),
    };
  });

const completedTurns = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "turn.completed" ? [event] : []));

const replyTo = (events: ReadonlyArray<ProviderRuntimeEvent>, turnId: TurnId) =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.turnId === turnId ? [event.payload.delta] : [],
    )
    .join("");

const testServices = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-agy-adapter-test-" }),
  NodeServices.layer,
);

describe("Antigravity turns", () => {
  it.live(
    "keeps a turn working while its command runs, then shows the reply the agent starts by itself",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("background");
        const { turnId } = yield* agy.adapter.sendTurn({
          threadId: agy.threadId,
          input: "build it",
          attachments: [],
        });
        // The prompt has answered, the command still runs: the turn is open.
        yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
        yield* Effect.sleep("200 millis");
        expect(completedTurns(agy.events)).toHaveLength(0);
        const [running] = yield* agy.adapter.listSessions();
        expect(running?.status).toBe("running");

        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(replyTo(agy.events, turnId)).toContain("The build passed.");
        expect(completedTurns(agy.events)[0]).toMatchObject({
          turnId,
          payload: { state: "completed" },
        });
        // One turn: the agent's reply did not open a second.
        expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        // Input is input plus cached reads; thinking sits inside output.
        expect(agy.usage).toEqual([
          expect.objectContaining({
            turnId,
            totals: {
              uncachedInputTokens: 1_000,
              cachedInputTokens: 4_000,
              cacheCreationTokens: 0,
              outputTokens: 50,
              reasoningTokens: 20,
            },
          }),
        ]);
        // The context meter reads Antigravity's usage_update.
        expect(
          agy.events.find((event) => event.type === "thread.token-usage.updated"),
        ).toMatchObject({ payload: { usage: { usedTokens: 9_000, maxTokens: 1_048_576 } } });
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("stops a turn held by a running command, once, and cancels the command", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("hang");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
      yield* Effect.sleep("300 millis");
      expect(completedTurns(agy.events)).toHaveLength(0);

      yield* agy.adapter.interruptTurn(agy.threadId);
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      // Long enough for a second settle to show if there were one.
      yield* Effect.sleep("2500 millis");
      expect(completedTurns(agy.events)).toEqual([
        expect.objectContaining({
          turnId,
          payload: { state: "cancelled", stopReason: "cancelled" },
        }),
      ]);
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(1);
      const [idle] = yield* agy.adapter.listSessions();
      expect(idle?.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("holds a turn for a launched subagent until its report ends", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "find the flaky test",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("The researcher found it.");
      expect(completedTurns(agy.events)[0]?.turnId).toBe(turnId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("opens a turn for a reply the agent starts after its turn ended", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("wake");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "set a timer",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* agy.waitFor((events) => completedTurns(events).length === 2);
      const [first, second] = completedTurns(agy.events);
      expect(first?.turnId).toBe(turnId);
      expect(second?.turnId).not.toBe(turnId);
      expect(replyTo(agy.events, second!.turnId!)).toBe("Woke up by myself.");
      expect(second?.payload.state).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("steers a running turn with a second prompt, never cancelling it", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("steer");
      expect(agy.adapter.capabilities.activeTurnSteering).toBe("supported");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "go",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("Working on it."));
      const steered = yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "also check the tests",
      });
      expect(steered.turnId).toBe(turnId);
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* Effect.sleep("300 millis");
      expect(completedTurns(agy.events)).toHaveLength(1);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "completed" },
      });
      expect(replyTo(agy.events, turnId)).toContain("Steered: also check the tests");
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(2);
      expect(frames.some((frame) => frame.method === "session/cancel")).toBe(false);
      expect(agy.usage.map((entry) => entry.totals.uncachedInputTokens)).toEqual([300]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("fails a turn whose normal end hid an upstream error, with the error's words", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("log-error");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]?.payload).toMatchObject({
        state: "failed",
        failureCategory: "server_error",
        errorMessage:
          "Antigravity: Bad Gateway: Failed to connect to backend API (502 Bad Gateway)",
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("carries an exhausted quota's reset time to the usage-limit notice", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("quota");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]?.payload).toMatchObject({
        state: "failed",
        failureCategory: "rate_limit",
        usageLimit: { resetsAt: "2026-11-24T01:05:00.000Z" },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "starts a new session with the thread's history when Google can't continue the old one",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("lost-signature");
        yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] });
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(completedTurns(agy.events)[0]?.payload).toMatchObject({ state: "failed" });
        yield* agy.waitFor((events) => events.some((event) => event.type === "session.exited"));

        const restarted = yield* agy.adapter.startSession({
          threadId: agy.threadId,
          provider: ProviderDriverKind.make("antigravity"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: agy.session.resumeCursor,
        });
        expect(restarted.resumeFailed).toBe(true);
        const frames = yield* agy.frames();
        expect(frames.filter((frame) => frame.method === "session/new")).toHaveLength(2);
        expect(frames.some((frame) => frame.method === "session/resume")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("Antigravity turn reading", () => {
  const tool = (fields: Partial<AcpToolCallState>): AcpToolCallState => ({
    toolCallId: "call",
    data: {},
    ...fields,
  });

  it("tells the work that outlives a prompt from what ends with it", () => {
    expect(
      antigravityWorkAfterPrompt(
        tool({ kind: "execute", data: { rawInput: { CommandLine: "npm test" } } }),
      ),
    ).toBe("command");
    // A daemon (a dev server) may never end.
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "execute",
          data: { rawInput: { CommandLine: "npm run dev", IsDaemon: true } },
        }),
      ),
    ).toBeUndefined();
    expect(antigravityWorkAfterPrompt(tool({ kind: "other", title: "Running schedule" }))).toBe(
      "wake",
    );
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "other",
          title: "Running invoke_subagent",
          data: { rawInput: { Role: "Artist", Prompt: "Paint" } },
        }),
      ),
    ).toBe("subagent");
    expect(antigravityWorkAfterPrompt(tool({ kind: "read", title: "Read file" }))).toBeUndefined();
  });

  it("reads Google's error renderings into retryable failures and a quota reset", () => {
    const nowMs = Date.UTC(2026, 10, 23, 12);
    expect(
      antigravityFailure({
        errorText: "UNAVAILABLE (code 503): The service is currently unavailable.",
        nowMs,
      }),
    ).toEqual({
      errorMessage: "Antigravity: The service is currently unavailable. (503 UNAVAILABLE)",
      failureCategory: "overloaded",
    });
    // A plain rate limit fails the turn without a usage-limit notice.
    expect(
      antigravityFailure({
        errorText:
          "Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [map[reason:RATE_LIMIT_EXCEEDED]]",
        nowMs,
      }),
    ).toMatchObject({ failureCategory: "rate_limit" });
    // A quota with only a delay resets that long from now.
    expect(
      antigravityFailure({
        errorText: "Details: [map[metadata:map[quotaResetDelay:1h30m0s] reason:QUOTA_EXHAUSTED]]",
        nowMs,
      })?.usageLimit,
    ).toEqual({ resetsAt: "2026-11-23T13:30:00.000Z" });
    // `refusal` is the stop reason an exhausted quota gets, with no text.
    expect(
      antigravityFailure({ errorText: undefined, stopReason: "refusal", nowMs }),
    ).toMatchObject({ failureCategory: "rate_limit", usageLimit: {} });
    expect(antigravityFailure({ errorText: undefined, stopReason: "end_turn", nowMs })).toBe(
      undefined,
    );
    // A 404 before the model answered: a model the account can't use.
    expect(
      antigravityFailure({
        errorText:
          "Error 404, Message: Requested entity was not found., Status: NOT_FOUND, Details: []",
        reachedModel: false,
        nowMs,
      })?.failureCategory,
    ).toBe("model_unavailable");
  });

  it("counts cached reads as input and thinking inside output", () => {
    expect(
      antigravityTurnUsageTotals({
        inputTokens: 1_000,
        cachedReadTokens: 4_000,
        outputTokens: 50,
        thoughtTokens: 80,
        totalTokens: 5_050,
      }),
    ).toEqual({
      uncachedInputTokens: 1_000,
      cachedInputTokens: 4_000,
      cacheCreationTokens: 0,
      outputTokens: 50,
      reasoningTokens: 50,
    });
  });
});
