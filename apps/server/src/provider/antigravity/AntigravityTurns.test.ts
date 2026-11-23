// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AntigravitySettings,
  type ChatAttachment,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { UsageLedgerEntry } from "../../usage/usageLedger.ts";
import { makeAcpAdapter } from "../acp/AcpAdapter.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAntigravityDescriptor } from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityFailure,
  antigravityTurnBehavior,
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

type AgyDescriptor = ReturnType<typeof makeAntigravityDescriptor>;

/**
 * Starts an Antigravity session on the stand-in, collecting every runtime
 * event. `adjust` changes the real descriptor for one test (a paused outcome
 * check, a shorter limit); `newAdapter` makes another adapter on the same
 * profile and state, as a server restart would.
 */
const startAgy = (
  scenario: string,
  adjust?: (descriptor: AgyDescriptor) => AgyDescriptor,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => makeAgyMock(scenario));
    const base = makeAntigravityDescriptor({
      paths: { profileDir: path.join(mock.dir, "profile"), tempRoot: path.join(mock.dir, "tmp") },
      runtime: undefined,
      releases: undefined,
      signIn: { method: "oauth-personal", project: "", location: "", key: "" },
    });
    const descriptor = adjust ? adjust(base) : base;
    const usage: Array<UsageLedgerEntry> = [];
    const events: Array<ProviderRuntimeEvent> = [];
    const newAdapter = Effect.gen(function* () {
      const made = yield* makeAcpAdapter(
        descriptor,
        decodeSettings({ enabled: true, binaryPath: mock.wrapper }),
        { recordTurnUsage: (entry) => Effect.sync(() => void usage.push(entry)) },
      );
      yield* made.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
        Effect.forkScoped,
      );
      return made;
    });
    const adapter = yield* newAdapter;
    const threadId = ThreadId.make(`agy-${scenario}`);
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("antigravity"),
      cwd: process.cwd(),
      runtimeMode,
    });
    const waitFor = (
      predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
      attempts = 1_000,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
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
      newAdapter,
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

/** Each subagent's latest status, by its launching call. */
const subagentStatuses = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  Object.fromEntries(
    events.flatMap((event) =>
      event.type === "subagent.metadata.updated" &&
      event.payload.callId !== undefined &&
      event.payload.status !== undefined
        ? [[event.payload.callId, event.payload.status] as const]
        : [],
    ),
  );

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
        // The prompt's tokens are written as it answers, not when the hold ends.
        expect(agy.usage.map((entry) => entry.turnId)).toEqual([turnId]);

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
      // The CLI's cancellation notice, after the stop, opens no turn of its own.
      expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(JSON.stringify(agy.events)).not.toContain("cancelled by the client");
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

  it.live("holds a turn until every subagent reported, and shows each with its steps", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent-records");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "find and review the flaky test",
        attachments: [],
      });
      // The first report and the reply to it leave the second subagent at work.
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("The researcher found it."));
      yield* Effect.sleep("2500 millis");
      expect(completedTurns(agy.events)).toHaveLength(0);
      expect(subagentStatuses(agy.events)).toEqual({
        call_research: "completed",
        call_review: "running",
      });

      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "completed" },
      });
      expect(replyTo(agy.events, turnId)).toContain("The reviewer agreed.");
      expect(subagentStatuses(agy.events)).toEqual({
        call_research: "completed",
        call_review: "completed",
      });
      // Each launch shows as a subagent with its role, prompt and report.
      const started = agy.events.filter(
        (event) => event.type === "subagent.metadata.updated" && event.payload.status === "running",
      );
      expect(started.map((event) => event.payload)).toEqual([
        expect.objectContaining({
          callId: "call_research",
          agentRole: "Researcher",
          objective: "Find the flaky test",
          isBackgrounded: true,
        }),
        expect.objectContaining({ callId: "call_review", agentRole: "Reviewer" }),
      ]);
      expect(
        agy.events.find(
          (event) =>
            event.type === "subagent.metadata.updated" &&
            event.payload.callId === "call_research" &&
            event.payload.status === "completed",
        ),
      ).toMatchObject({ turnId, payload: { resultBody: "The flaky test is api.test.ts." } });
      // Nothing is left running in the task snapshot.
      const snapshots = agy.events.flatMap((event) =>
        event.type === "task.snapshot.updated" ? [event.payload.tasks.length] : [],
      );
      expect(snapshots.at(-1)).toBe(0);

      // The subagent view reads the child's steps from the CLI's records.
      const transcript = yield* agy.adapter.readSubagentTranscript!(agy.threadId, {
        threadId: agy.threadId,
        agentId: "call_research",
      });
      expect(transcript.agent).toMatchObject({ id: "child-research", agentType: "Researcher" });
      expect(transcript.entries).toEqual([
        { id: "launch", role: "user", text: "Find the flaky test", toolUses: [] },
        {
          id: "step-1",
          role: "assistant",
          text: "",
          toolUses: [{ name: "view_file", summary: "/project/api.test.ts" }],
        },
        {
          id: "step-2",
          role: "system",
          text: "",
          toolUses: [],
          outputPreview: "1: it.skip('flaky')",
        },
        { id: "step-3", role: "assistant", text: "Found it.", toolUses: [] },
      ]);
      // A launch the records don't name says so.
      const missing = yield* Effect.flip(
        agy.adapter.readSubagentTranscript!(agy.threadId, {
          threadId: agy.threadId,
          agentId: "call_unknown",
        }),
      );
      expect(missing.message).toContain("Antigravity did not record which subagent this started");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("ends a held turn when several subagents report in one reply", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent-records-together");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "find and review the flaky test",
        attachments: [],
      });
      // Counting replies alone would hold this until the 30-minute limit.
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "completed" },
      });
      expect(replyTo(agy.events, turnId)).toContain("Both reported.");
      expect(subagentStatuses(agy.events)).toEqual({
        call_research: "completed",
        call_review: "completed",
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("does not hold a turn for a subagent killed within it", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent-killed");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "explore, then stop",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "completed" },
      });
      expect(subagentStatuses(agy.events)).toEqual({ call_stray: "interrupted" });
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
      // Both prompts' tokens count, each under an id of its own.
      expect(
        agy.usage.map((entry) => [entry.turnId, entry.totals.uncachedInputTokens]).toSorted(),
      ).toEqual([
        [turnId, 100],
        [`${turnId}:2`, 300],
      ]);
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

        // A server restart before the next message: a new adapter.
        const restartedAdapter = yield* agy.newAdapter;
        const restarted = yield* restartedAdapter.startSession({
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

describe("Antigravity turns, the hard cases", () => {
  it.live("keeps a turn open for a scheduled wake whose call never changes until it fires", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("schedule");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "remind me",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("Timer set."));
      yield* Effect.sleep("2500 millis");
      expect(completedTurns(agy.events)).toHaveLength(0);
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("Timer fired.");
      expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("fails a held turn and stops the session when the agent exits", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("exit");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "failed", errorMessage: "Antigravity stopped before its work finished." },
      });
      yield* agy.waitFor((events) => events.some((event) => event.type === "session.exited"));
      expect(agy.events.find((event) => event.type === "session.exited")).toMatchObject({
        payload: { exitKind: "error" },
      });
      expect(yield* agy.adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("recycles an agent that ignores Stop, even while another message waits", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("ignore-cancel");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "think",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("Thinking hard."));
      const waiting = yield* agy.adapter
        .sendTurn({ threadId: agy.threadId, input: "next", attachments: [] })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.sleep("100 millis");
      yield* agy.adapter.interruptTurn(agy.threadId);
      // The cancel deadline (15 seconds) passes and the agent is restarted.
      yield* agy.waitFor((events) => completedTurns(events).length === 1, 2_500);
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "cancelled" },
      });
      expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("settles a turn once when a steer comes while its answer is read", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      // The first prompt's outcome check waits for the test.
      const agy = yield* startAgy(
        "permission-second",
        (descriptor) => ({
          ...descriptor,
          promptOutcome: {
            watch: (sessionId, model) =>
              descriptor.promptOutcome!.watch(sessionId, model).pipe(
                Effect.map((check) => (answer: Parameters<typeof check>[0]) => {
                  if (!first) return check(answer);
                  first = false;
                  return Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(check(answer)),
                  );
                }),
              ),
          },
        }),
        "approval-required",
      );
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "first",
        attachments: [],
      });
      yield* Deferred.await(reading);
      const steer = yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "second",
      }).pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.sleep("200 millis");
      yield* Deferred.succeed(release, undefined);
      // The turn had ended: the steer is turned down, to be sent as a turn of its own.
      expect(Exit.isFailure(yield* Fiber.join(steer))).toBe(true);
      expect(completedTurns(agy.events)).toEqual([
        expect.objectContaining({
          turnId,
          payload: expect.objectContaining({ state: "completed" }),
        }),
      ]);
      const next = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "second",
        attachments: [],
      });
      yield* agy.waitFor((events) => events.some((event) => event.type === "request.opened"));
      expect(agy.events.find((event) => event.type === "request.opened")?.turnId).toBe(next.turnId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("steers without inheriting the error the earlier prompt left in the log", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("steer-log-error");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "go",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("Working on it."));
      yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "try again",
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]?.payload.state).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("holds a turn until each subagent has reported", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagents");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "research and test",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("The tester reported.");
      expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("frees a subagent whose report never sends its closing usage update", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent-quiet", (descriptor) => ({
        ...descriptor,
        heldTurns: { ...descriptor.heldTurns!, replyQuietLimit: Duration.seconds(1) },
      }));
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "research",
        attachments: [],
      });
      // Long before the 30-minute silent limit.
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("The researcher reported.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

const promptTexts = (frames: ReadonlyArray<Record<string, unknown>>) =>
  frames.flatMap((frame) => {
    if (frame.method !== "session/prompt") return [];
    const prompt = (frame.params as { prompt?: ReadonlyArray<{ type: string; text?: string }> })
      .prompt;
    return [(prompt ?? []).flatMap((block) => (block.text ? [block.text] : [])).join("\n")];
  });

describe("Antigravity commands and edits", () => {
  it.live("lists the session's own slash commands for its thread, less Threadlines' own", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("simple");
      yield* agy.waitFor((events) =>
        events.some((event) => event.type === "session.commands.updated"),
      );
      const listed = agy.events.find((event) => event.type === "session.commands.updated");
      expect(listed).toMatchObject({
        threadId: agy.threadId,
        payload: {
          commands: [
            { name: "goal", description: "Work toward a goal", input: { hint: "objective" } },
            { name: "compact", description: "Summarize the conversation" },
          ],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("sends a command as typed in plan mode, and plans the next message", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("simple");
      yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "/compact",
        interactionMode: "plan",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "/tmp/out.log is empty",
        interactionMode: "plan",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 2);
      expect(promptTexts(yield* agy.frames())).toEqual(["/compact", "/plan /tmp/out.log is empty"]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("forgets reverted turns by ending the session and starting a new one", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("simple");
      expect(agy.adapter.capabilities.conversationRollback).toBe("new-session");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "first", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      const [beforeRevert] = yield* agy.adapter.listSessions();

      const rolledBack = yield* agy.adapter.rollbackThread(agy.threadId, 1);
      expect(rolledBack.conversationRolledBack).toBe(true);
      expect(agy.events.some((event) => event.type === "session.exited")).toBe(true);
      expect(yield* agy.adapter.hasSession(agy.threadId)).toBe(false);

      // The next message opens a new conversation the thread seeds, also
      // after a server restart (a new adapter).
      const restartedAdapter = yield* agy.newAdapter;
      const restarted = yield* restartedAdapter.startSession({
        threadId: agy.threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: beforeRevert?.resumeCursor,
      });
      expect(restarted.resumeFailed).toBe(true);
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/new")).toHaveLength(2);
      expect(frames.some((frame) => frame.method === "session/resume")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("stops the agent's running work, and its turn once, before a revert ends it", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("hang");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
      yield* Effect.sleep("300 millis");

      yield* agy.adapter.rollbackThread(agy.threadId, 1);
      expect(completedTurns(agy.events)).toEqual([
        expect.objectContaining({
          turnId,
          payload: { state: "cancelled", stopReason: "cancelled" },
        }),
      ]);
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(1);
      expect(agy.events.some((event) => event.type === "session.exited")).toBe(true);
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

  it.effect(
    "gives a quota with no reset time the one the plan meter knows for the turn's model",
    () =>
      Effect.gen(function* () {
        const profileDir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "threadlines-agy-turn-")),
        );
        const asked: Array<string> = [];
        const behavior = antigravityTurnBehavior(profileDir, (model) =>
          Effect.sync(() => {
            asked.push(model);
            return { window: "weekly" as const, resetsAt: "2026-11-24T00:00:00.000Z" };
          }),
        );
        const check = yield* behavior.promptOutcome!.watch("session-1", "claude-sonnet-agent");
        const quota = {
          _tag: "AcpRequestError",
          errorMessage: "Details: [map[reason:QUOTA_EXHAUSTED]]",
        };
        expect(yield* check({ error: quota })).toMatchObject({
          failureCategory: "rate_limit",
          usageLimit: { window: "weekly", resetsAt: "2026-11-24T00:00:00.000Z" },
        });
        expect(asked).toEqual(["claude-sonnet-agent"]);

        // A reset time the agent gave wins, and the meter isn't asked.
        const timed = {
          _tag: "AcpRequestError",
          errorMessage:
            "Details: [map[metadata:map[quotaResetDelay:1h0m0s] reason:QUOTA_EXHAUSTED]]",
        };
        expect((yield* check({ error: timed }))?.usageLimit?.window).toBeUndefined();
        expect(asked).toHaveLength(1);
      }),
  );

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

describe("Antigravity tool rows and attachments", () => {
  const toolItem = (events: ReadonlyArray<ProviderRuntimeEvent>, id: string) =>
    events.findLast((event) => event.type === "item.completed" && String(event.itemId) === id) as
      | Extract<ProviderRuntimeEvent, { type: "item.completed" }>
      | undefined;

  it.live("shows call_mcp_tool as the MCP tool, keeps a command's start, drops images", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("tools");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);

      expect(toolItem(agy.events, "call_mcp")?.payload).toMatchObject({
        itemType: "mcp_tool_call",
        title: "list_issues",
        data: { server: "github", tool: "list_issues", arguments: { repo: "x/y" } },
      });
      expect(toolItem(agy.events, "call_mcp")?.payload.data).not.toHaveProperty("item");

      const command = toolItem(agy.events, "call_long")?.payload.data as {
        command: string;
        item: { command: string; aggregatedOutput: string };
      };
      expect(command.command.startsWith("echo start")).toBe(true);
      expect(command.command.endsWith("[Command truncated]")).toBe(true);
      expect(command.command.length).toBeLessThanOrEqual(8_000 + "\n\n[Command truncated]".length);
      expect(command.item.aggregatedOutput.endsWith("tail")).toBe(true);
      expect(command.item.aggregatedOutput.length).toBeLessThan(8_100);

      const shot = toolItem(agy.events, "call_shot");
      expect(JSON.stringify(shot)).not.toContain("aGVsbG8=");
      expect(shot?.payload.data).toMatchObject({
        content: [{ type: "content", content: { type: "text", text: "Screenshot taken." } }],
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "sends images and audio inline, PDFs as links, text files as text, the rest as paths",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const attachments: ReadonlyArray<ChatAttachment> = [
          { type: "image", id: "img-1", name: "shot.png", mimeType: "image/png", sizeBytes: 4 },
          {
            type: "file",
            kind: "pdf",
            id: "pdf-1",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 9,
          },
          {
            type: "file",
            kind: "text",
            id: "txt-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
          {
            type: "file",
            kind: "other",
            id: "u16-1",
            name: "log.txt",
            mimeType: "text/plain; charset=utf-16",
            sizeBytes: 8,
          },
          {
            type: "file",
            kind: "other",
            id: "aud-1",
            name: "memo.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: 3,
          },
          {
            type: "file",
            kind: "other",
            id: "xls-1",
            name: "budget.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: 2,
          },
        ];
        const bytes: Record<string, Uint8Array> = {
          "img-1": Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          "pdf-1": new TextEncoder().encode("%PDF-1.7\n"),
          "txt-1": new TextEncoder().encode("hello"),
          // "hi!" in UTF-16LE with its byte order mark.
          "u16-1": Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x21, 0x00]),
          "aud-1": Uint8Array.from([1, 2, 3]),
          "xls-1": Uint8Array.from([0x50, 0x4b]),
        };
        for (const attachment of attachments) {
          const file = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          })!;
          yield* Effect.promise(async () => {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, bytes[attachment.id]!);
          });
        }
        const agy = yield* startAgy("simple");
        yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "look", attachments });
        yield* agy.waitFor((events) => completedTurns(events).length === 1);

        const prompt = (yield* agy.frames()).find((frame) => frame.method === "session/prompt")
          ?.params as { prompt: ReadonlyArray<Record<string, unknown>> };
        const blocks = prompt.prompt;
        expect(blocks.map((block) => block.type)).toEqual([
          "text",
          "image",
          "resource_link",
          "resource",
          "resource",
          "audio",
          "text",
        ]);
        expect(blocks[1]).toMatchObject({ mimeType: "image/png", data: "iVBORw==" });
        expect(blocks[2]).toMatchObject({ name: "spec.pdf", mimeType: "application/pdf" });
        expect(String(blocks[2]!.uri).startsWith("file://")).toBe(true);
        expect(blocks[3]).toMatchObject({ resource: { mimeType: "text/plain", text: "hello" } });
        // The charset parameter is dropped; the byte order mark picks UTF-16.
        expect(blocks[4]).toMatchObject({ resource: { mimeType: "text/plain", text: "hi!" } });
        expect(blocks[5]).toMatchObject({ mimeType: "audio/mpeg", data: "AQID" });
        expect(blocks[6]).toMatchObject({ type: "text" });
        expect(String(blocks[6]!.text)).toContain('Attached file "budget.xlsx"');
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});
