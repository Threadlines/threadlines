// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AntigravitySettings,
  ApprovalRequestId,
  type ChatAttachment,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadContextSeed,
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
import { type AcpTurnMachineSeam, makeAcpAdapter } from "../acp/AcpAdapter.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAntigravityDescriptor } from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityFailure,
  antigravityTurnBehavior,
  antigravityTurnUsageTotals,
  antigravityWorkAfterPrompt,
} from "./AntigravityTurns.ts";
import { normalizeAntigravityToolCall } from "./AntigravityToolCalls.ts";

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
  runtimeMode: "full-access" | "approval-required" | "auto-accept-edits" = "full-access",
  turnMachineSeams?: (seam: AcpTurnMachineSeam) => Effect.Effect<void>,
  contextSeed?: ThreadContextSeed,
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
    // What the adapter put on the provider status (`onSessionCommands`).
    const commandReports: Array<ReadonlyArray<string> | undefined> = [];
    const newAdapter = Effect.gen(function* () {
      const made = yield* makeAcpAdapter(
        descriptor,
        decodeSettings({ enabled: true, binaryPath: mock.wrapper }),
        {
          recordTurnUsage: (entry) => Effect.sync(() => void usage.push(entry)),
          onSessionCommands: (_sessionKey, commands) =>
            Effect.sync(() => void commandReports.push(commands?.map((command) => command.name))),
          // The status lists one skill.
          skillNames: Effect.succeed(new Set(["review"])),
          ...(turnMachineSeams !== undefined ? { turnMachineSeams } : {}),
        },
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
      ...(contextSeed !== undefined ? { contextSeed } : {}),
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
      commandReports,
      threadId,
      session,
      waitFor,
      newAdapter,
      frames: () => Effect.promise(() => readFrames(mock.log)),
    };
  });

/** Steering, which Antigravity ships without (`ANTIGRAVITY_STEERS`), on for one test. */
const withSteering = (descriptor: AgyDescriptor): AgyDescriptor => ({
  ...descriptor,
  turnMachine: { ...descriptor.turnMachine!, steer: true },
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

  it.live(
    "holds a turn for a launched subagent until its report ends, with no records to read",
    () =>
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

  it.live("shows each subagent with its role, prompt, report and steps", () =>
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
      const agy = yield* startAgy("steer", withSteering);
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

  it.live(
    "fails a held turn when an upstream error lands during its post-prompt wake-up reply",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("background-log-error");
        yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "build it", attachments: [] });
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(completedTurns(agy.events)[0]?.payload).toMatchObject({
          state: "failed",
          failureCategory: "server_error",
          errorMessage:
            "Antigravity: Bad Gateway: Failed to connect to backend API (502 Bad Gateway)",
        });
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "folds ask_question form elicitations into a question card and returns flat ACP answers",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("ask-question");
        const { turnId } = yield* agy.adapter.sendTurn({
          threadId: agy.threadId,
          input: "ask me",
          attachments: [],
        });
        yield* agy.waitFor((events) =>
          events.some((event) => event.type === "user-input.requested"),
        );
        const requested = agy.events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
            event.type === "user-input.requested",
        )!;
        expect(requested.payload.questions).toEqual([
          {
            id: "q1",
            header: "Question 1",
            question: "Which runtime should we target?",
            options: [
              { label: "Node.js", description: "Default runtime" },
              { label: "Deno", description: "Deno" },
            ],
            multiSelect: false,
          },
          {
            id: "q2",
            header: "Question 2",
            question: "Which checks should run?",
            options: [
              { label: "Typecheck", description: "Typecheck" },
              { label: "Unit tests", description: "Unit tests" },
              { label: "Lint", description: "Lint" },
            ],
            multiSelect: true,
          },
        ]);
        yield* agy.adapter.respondToUserInput(
          agy.threadId,
          ApprovalRequestId.make(String(requested.requestId)),
          { q1: "Bun instead", q2: ["Typecheck", "Lint"] },
        );
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(replyTo(agy.events, turnId)).toContain(
          JSON.stringify({
            action: "accept",
            content: { q1_other: "Bun instead", q2: ["1", "3"] },
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("attaches HTTP MCP servers even when agy omits mcpCapabilities.http in initialize", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("simple");
      const frames = yield* agy.frames();
      const initFrame = frames.find((frame) => frame.method === "initialize") as
        | { params?: { clientCapabilities?: { elicitation?: unknown } } }
        | undefined;
      expect(initFrame?.params?.clientCapabilities?.elicitation).toEqual({ form: {} });
      const newSessionFrame = frames.find((frame) => frame.method === "session/new") as
        | { params?: { mcpServers?: ReadonlyArray<{ type?: string; name?: string }> } }
        | undefined;
      expect(newSessionFrame?.params?.mcpServers?.some((server) => server.type === "http")).toBe(
        true,
      );
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

  it.live("ends a session Google can't continue, saying its conversation is lost", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("lost-signature");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(agy.events)[0]?.payload).toMatchObject({ state: "failed" });
      yield* agy.waitFor((events) => events.some((event) => event.type === "session.exited"));
      // ProviderService forgets the conversation off this (see its tests),
      // so the next start opens a new one seeded with the thread's history.
      expect(agy.events.find((event) => event.type === "session.exited")).toMatchObject({
        // Named, so only a binding still on this session forgets it.
        payload: { conversationLost: { sessionCreatedAt: agy.session.createdAt } },
      });
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

  it.live("ends a held turn when its session is stopped", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("hang");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
      yield* Effect.sleep("300 millis");
      yield* agy.adapter.stopSession(agy.threadId);
      expect(agy.events.filter((event) => event.type === "turn.aborted")).toEqual([
        expect.objectContaining({ turnId }),
      ]);
      expect(completedTurns(agy.events)).toEqual([]);
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

  it.live("takes a steer sent while the answer is read, and shows the steer's permission", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      // The first prompt's outcome check waits for the test.
      const agy = yield* startAgy(
        "permission-second",
        (descriptor) => {
          const machine = descriptor.turnMachine!;
          const outcome = machine.outcome!;
          return {
            ...descriptor,
            turnMachine: {
              ...machine,
              steer: true,
              outcome: {
                watch: (sessionId, model) =>
                  outcome.watch(sessionId, model).pipe(
                    Effect.map((watch) => ({
                      ...watch,
                      check: (answer: Parameters<typeof watch.check>[0]) => {
                        if (!first) return watch.check(answer);
                        first = false;
                        return Deferred.succeed(reading, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(watch.check(answer)),
                        );
                      },
                    })),
                  ),
              },
            },
          };
        },
        "approval-required",
      );
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "first",
        attachments: [],
      });
      yield* Deferred.await(reading);
      // The steer lands while the first answer is read: it carries the turn on.
      const steered = yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "second",
      });
      expect(steered.turnId).toBe(turnId);
      yield* agy.waitFor((events) => events.some((event) => event.type === "request.opened"));
      const opened = agy.events.find((event) => event.type === "request.opened");
      expect(opened?.turnId).toBe(turnId);
      yield* agy.adapter.respondToRequest(agy.threadId, opened!.requestId as never, "accept");
      // The first answer's reading finishes late: it settles nothing.
      yield* Deferred.succeed(release, undefined);
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* Effect.sleep("300 millis");
      expect(completedTurns(agy.events)).toEqual([
        expect.objectContaining({
          turnId,
          payload: expect.objectContaining({ state: "completed" }),
        }),
      ]);
      expect(replyTo(agy.events, turnId)).toContain("Second done.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("steers without inheriting the error the earlier prompt left in the log", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("steer-log-error", withSteering);
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

  it.live("steers without inheriting an error the earlier prompt writes late", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("steer-late-log-error", withSteering);
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

  it.live(
    "fails a steer whose own error is logged before the earlier prompt answers (finding 5)",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("steer-own-log-error", withSteering);
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
        // Moving the reading past the older prompt's answer would hide this.
        expect(completedTurns(agy.events)[0]?.payload).toMatchObject({
          state: "failed",
          errorMessage: expect.stringContaining("502"),
        });
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("writes the cost the agent reports with the prompt that spent it", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("cost");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* Effect.sleep("100 millis");
      const lines = agy.usage.map((entry) => ({
        turnId: entry.turnId,
        input: entry.totals.uncachedInputTokens,
        cost: Math.round((entry.costUsd ?? -1) * 1000) / 1000,
      }));
      // The tokens and the cost spent up to the answer share one line; the
      // cost of the agent's own reply after it has a line of its own.
      expect(lines).toEqual([
        { turnId, input: 400, cost: 0.02 },
        { turnId: `${turnId}:after`, input: 0, cost: 0.03 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "opens a new conversation when the lost one is resumed before its binding forgets it",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("lost-signature");
        yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] });
        yield* agy.waitFor((events) => events.some((event) => event.type === "session.exited"));
        // A message sent at once restarts the thread on its old cursor, before
        // ProviderService has written the forget into its binding.
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

  it.live("ends the hold when the records show every child reported in one reply", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("records-one-reply");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "research and review",
        attachments: [],
      });
      // Counting one subagent per reply would hold the second for 30 minutes.
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("Both agents reported.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("stops holding a child the agent killed", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("records-killed");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "research and review",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("I stopped the reviewer.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("frees a subagent whose report never sends its closing usage update", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("subagent-quiet", (descriptor) => ({
        ...descriptor,
        turnMachine: { ...descriptor.turnMachine!, replyQuietLimit: Duration.seconds(1) },
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
  it.live(
    "puts the session's own commands on the status, less Threadlines' own, and clears them",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("simple");
        yield* agy.waitFor(() => agy.commandReports.length > 0);
        expect(agy.commandReports).toEqual([["goal", "compact"]]);
        yield* agy.adapter.stopSession(agy.threadId);
        expect(agy.commandReports.at(-1)).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("reports a list that keeps changing at most once per interval, the newest last", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("flapping");
      yield* agy.waitFor(() => agy.commandReports.length > 0);
      yield* Effect.sleep("1 second");
      // The first list went at once; the nine changes after it wait.
      expect(agy.commandReports).toHaveLength(1);
      yield* agy.waitFor(() => agy.commandReports.length > 1, 700);
      yield* Effect.sleep("500 millis");
      expect(agy.commandReports).toEqual([["goal", "compact"], ["goal"]]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("runs only the person's typed command the session lists, as typed, in plan mode", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("simple");
      yield* agy.waitFor(() => agy.commandReports.length > 0);
      const send = (input: string, typed?: { text: string; context?: string }) =>
        Effect.gen(function* () {
          const before = completedTurns(agy.events).length;
          const turn = yield* agy.adapter.sendTurn({
            threadId: agy.threadId,
            input,
            interactionMode: "plan",
            attachments: [],
            ...(typed ? { typed } : {}),
          });
          yield* agy.waitFor((events) => completedTurns(events).length === before + 1);
          return turn;
        });
      // Advertised, and a skill the status lists: commands.
      yield* send("/compact", { text: "/compact" });
      yield* send("/review the diff", { text: "/review the diff" });
      // Not listed, a path and plain text: ordinary text.
      yield* send("/etc is missing", { text: "/etc is missing" });
      yield* send("/tmp/out.log is empty", { text: "/tmp/out.log is empty" });
      yield* send("/compact");
      // Spaces in front change nothing: the trimmed text decides.
      yield* send("  /compact", { text: "  /compact" });
      // The server's context in front: the command goes alone, its context deferred.
      const deferred = yield* send("Earlier turns\n\n---\n\n/compact", {
        text: "/compact",
        context: "Earlier turns",
      });
      expect(deferred.contextDeferred).toBe(true);
      expect(promptTexts(yield* agy.frames())).toEqual([
        "/compact",
        "/review the diff",
        "/plan /etc is missing",
        "/plan /tmp/out.log is empty",
        "/plan /compact",
        "/compact",
        "/compact",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("ends the session on a revert, its running work and turn stopped first", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("hang");
      expect(agy.adapter.capabilities.conversationRollback).toBe("new-session");
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
      yield* Effect.sleep("300 millis");

      const rolledBack = yield* agy.adapter.rollbackThread(agy.threadId, 1);
      expect(rolledBack.conversationRolledBack).toBe(true);
      expect(completedTurns(agy.events)).toEqual([
        expect.objectContaining({
          turnId,
          payload: { state: "cancelled", stopReason: "cancelled" },
        }),
      ]);
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(1);
      expect(agy.events.some((event) => event.type === "session.exited")).toBe(true);
      expect(yield* agy.adapter.hasSession(agy.threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

/**
 * Holds the turn machine's driver at the first seam `matches` picks, until
 * released (`AcpAdapterOptions.turnMachineSeams`); `reached` waits for it to
 * get there. A seam can also just be watched (`seen`).
 */
const makeGate = (matches: (seam: AcpTurnMachineSeam) => boolean) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen: Array<AcpTurnMachineSeam> = [];
    let held = false;
    const seams = (seam: AcpTurnMachineSeam) =>
      Effect.suspend(() => {
        seen.push(seam);
        if (held || !matches(seam)) return Effect.void;
        held = true;
        return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)));
      });
    return {
      seams,
      seen,
      reached: Deferred.await(reached),
      release: Deferred.succeed(release, undefined),
    };
  });

const eventIndex = (events: ReadonlyArray<ProviderRuntimeEvent>, type: string) =>
  events.findIndex((event) => event.type === type);

describe("Antigravity turn driver, the orderings", () => {
  it.live("publishes a turn's end that a session stop lands on (finding 1)", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate(
        (seam) => seam.point === "stepCommitted" && seam.commands.includes("endTurn"),
      );
      const agy = yield* startAgy("simple", undefined, "full-access", gate.seams);
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "hi",
        attachments: [],
      });
      // The step that ends the turn is committed; its commands haven't run.
      yield* gate.reached;
      const stopping = yield* agy.adapter.stopSession(agy.threadId).pipe(Effect.forkScoped);
      yield* Effect.sleep("200 millis");
      yield* gate.release;
      yield* Fiber.join(stopping);
      expect(completedTurns(agy.events).map((event) => event.turnId)).toEqual([turnId]);
      expect(agy.events.some((event) => event.type === "turn.aborted")).toBe(false);
      expect(eventIndex(agy.events, "turn.completed")).toBeLessThan(
        eventIndex(agy.events, "session.exited"),
      );
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("sends a steer only after the prompt it steers, whose setup ran first (finding 2)", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate((seam) => seam.point === "promptSetup" && seam.prompt === 1);
      const agy = yield* startAgy("steer", withSteering, "full-access", gate.seams);
      // The send returns once its prompt is written, so it waits on the gate too.
      const sending = yield* agy.adapter
        .sendTurn({ threadId: agy.threadId, input: "first message", attachments: [] })
        .pipe(Effect.forkScoped);
      yield* gate.reached;
      const started = agy.events.find((event) => event.type === "turn.started");
      const turnId = started!.turnId!;
      // The first prompt's setup hasn't returned; the steer is taken anyway.
      yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "the steer",
      });
      yield* Effect.sleep("200 millis");
      const prompts = (frames: ReadonlyArray<Record<string, unknown>>) =>
        frames.flatMap((frame) =>
          frame.method === "session/prompt" ? [JSON.stringify(frame.params)] : [],
        );
      expect(prompts(yield* agy.frames())).toEqual([]);
      yield* gate.release;
      expect((yield* Fiber.join(sending)).turnId).toBe(turnId);
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      const sent = prompts(yield* agy.frames());
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain("first message");
      expect(sent[1]).toContain("the steer");
      expect(replyTo(agy.events, turnId)).toContain("Steered:");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("keeps a wake that follows the answer at once in the answered turn (finding 6)", () =>
    Effect.gen(function* () {
      // The answer is read and held back while the command's end and the
      // start of its wake sit behind it.
      const gate = yield* makeGate((seam) => seam.point === "answerRead" && seam.prompt === 1);
      const agy = yield* startAgy("background-quick", undefined, "full-access", gate.seams);
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* gate.reached;
      yield* Effect.sleep("150 millis");
      yield* gate.release;
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* Effect.sleep("500 millis");
      expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(completedTurns(agy.events).map((event) => event.turnId)).toEqual([turnId]);
      expect(replyTo(agy.events, turnId)).toContain("The build passed.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("writes an answered prompt's usage when the session stops right after (finding 8)", () =>
    Effect.gen(function* () {
      // The reader is held on the reply's text; the answer queues behind it.
      const gate = yield* makeGate(
        (seam) => seam.point === "stepCommitted" && seam.event === "agentOutput",
      );
      const agy = yield* startAgy("simple", undefined, "full-access", gate.seams);
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "hi",
        attachments: [],
      });
      yield* gate.reached;
      yield* Effect.sleep("200 millis");
      const stopping = yield* agy.adapter.stopSession(agy.threadId).pipe(Effect.forkScoped);
      yield* Effect.sleep("100 millis");
      yield* gate.release;
      yield* Fiber.join(stopping);
      yield* Effect.sleep("100 millis");
      expect(agy.usage.map((entry) => [entry.turnId, entry.totals.uncachedInputTokens])).toEqual([
        [turnId, 10],
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("drops an older reading of the records that lands after a newer one (finding 4)", () =>
    Effect.gen(function* () {
      // The first reading (both children at work) is held until the newer
      // one (both reported) is in.
      const gate = yield* makeGate(
        (seam) => seam.point === "childrenRead" && seam.generation === 1,
      );
      const agy = yield* startAgy("records-one-reply", undefined, "full-access", gate.seams);
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "research and review",
        attachments: [],
      });
      yield* gate.reached;
      yield* agy.waitFor(() =>
        gate.seen.some(
          (seam) =>
            seam.point === "stepCommitted" &&
            seam.event === "childrenAtWork" &&
            seam.commands.includes("armTimer"),
        ),
      );
      yield* gate.release;
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(replyTo(agy.events, turnId)).toContain("Both agents reported.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("counts a quiet limit from the agent's last activity (finding 7)", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("quiet-activity", (descriptor) => ({
        ...descriptor,
        turnMachine: { ...descriptor.turnMachine!, silentLimit: Duration.millis(1_500) },
      }));
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
      const answeredAt = Date.now();
      yield* agy.waitFor((events) => completedTurns(events).length === 1, 1_000);
      const elapsed = Date.now() - answeredAt;
      // Activity 100 ms in: the limit ends 1.6 s in, not after a second full wait (3 s).
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(2_500);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "keeps a stopped command until the agent ends it, recycling one that won't (finding 3)",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("stuck");
        const { turnId } = yield* agy.adapter.sendTurn({
          threadId: agy.threadId,
          input: "build it",
          attachments: [],
        });
        yield* agy.waitFor((events) => replyTo(events, turnId).includes("I'll report"));
        yield* Effect.sleep("300 millis");
        yield* agy.adapter.interruptTurn(agy.threadId);
        // The turn shows cancelled at once.
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(completedTurns(agy.events)[0]?.payload.state).toBe("cancelled");
        // A message sent now waits for the stop, which the agent never confirms.
        const waiting = yield* agy.adapter
          .sendTurn({ threadId: agy.threadId, input: "next", attachments: [] })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.sleep("500 millis");
        expect(agy.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        // The cancel deadline (15 seconds) passes and the agent is restarted.
        yield* agy.waitFor(
          (events) =>
            events.some(
              (event) =>
                event.type === "runtime.warning" && event.payload.warningKind === "cancel-timeout",
            ),
          2_000,
        );
        expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true);
        yield* agy.waitFor((events) => events.some((event) => event.type === "session.exited"));
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "reports a send whose mode setup failed undelivered, keeping its history for the next",
    () =>
      Effect.gen(function* () {
        const agy = yield* startAgy("mode-fails-once", undefined, "auto-accept-edits", undefined, {
          version: 1,
          fromProvider: ProviderDriverKind.make("claudeAgent"),
          entries: [{ kind: "message", role: "user", text: "the earlier conversation" }],
        });
        // The first prompt after a handoff: plan mode asks for the `default`
        // mode, and switching to it fails once.
        const first = yield* agy.adapter.sendTurn({
          threadId: agy.threadId,
          input: "plan it",
          interactionMode: "plan",
          attachments: [],
        });
        expect(first.undelivered).toBe(true);
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        expect(completedTurns(agy.events)[0]?.payload.state).toBe("failed");
        const prompts = () =>
          agy
            .frames()
            .pipe(
              Effect.map((frames) => frames.filter((frame) => frame.method === "session/prompt")),
            );
        expect(yield* prompts()).toHaveLength(0);

        const second = yield* agy.adapter.sendTurn({
          threadId: agy.threadId,
          input: "plan it again",
          interactionMode: "plan",
          attachments: [],
        });
        expect(second.undelivered).toBeUndefined();
        yield* agy.waitFor((events) => completedTurns(events).length === 2);
        const sent = yield* prompts();
        expect(sent).toHaveLength(1);
        // The history the first send took went with the one that went out.
        expect(JSON.stringify(sent[0])).toContain("the earlier conversation");
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "returns a send undelivered, never hanging, when the session stops before its prompt goes out",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeGate((seam) => seam.point === "promptSetup" && seam.prompt === 1);
        const agy = yield* startAgy("simple", undefined, "full-access", gate.seams);
        // The send returns once its prompt is written: it waits on the gate.
        const sending = yield* agy.adapter
          .sendTurn({ threadId: agy.threadId, input: "hi", attachments: [] })
          .pipe(Effect.forkScoped);
        yield* gate.reached;
        yield* agy.adapter.stopSession(agy.threadId);
        expect((yield* Fiber.join(sending)).undelivered).toBe(true);
        const frames = yield* agy.frames();
        expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("returns a send undelivered when the agent stopped reading its stdin", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("deaf", undefined, "full-access", undefined, {
        version: 1,
        fromProvider: ProviderDriverKind.make("claudeAgent"),
        entries: [{ kind: "message", role: "user", text: "the earlier conversation" }],
      });
      yield* Effect.sleep("300 millis");
      // The prompt can be queued, but never written: the send says so, and
      // doesn't wait on an answer that can't come.
      const sent = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "hello",
        attachments: [],
      });
      expect(sent.undelivered).toBe(true);
      const frames = yield* agy.frames();
      expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("lets go of each prompt's record once its answer is in, a steered one's too", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate(() => false);
      const agy = yield* startAgy("steer", withSteering, "full-access", gate.seams);
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "go",
        attachments: [],
      });
      yield* agy.waitFor((events) => replyTo(events, turnId).includes("Working on it."));
      // The first prompt is answered after the steer that replaced it.
      yield* agy.adapter.steerTurn!({
        threadId: agy.threadId,
        expectedTurnId: turnId,
        input: "try again",
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      yield* Effect.sleep("200 millis");
      // The next message's first step finds no record left of either prompt.
      const before = gate.seen.length;
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "next", attachments: [] });
      const sendStep = gate.seen
        .slice(before)
        .find((seam) => seam.point === "stepCommitted" && seam.event === "send");
      expect(sendStep).toMatchObject({ promptsHeld: 0 });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("sends a prompt whose log baseline can't be read in time, judged by its own answer", () =>
    Effect.gen(function* () {
      // The profile's file system stalls: noting where the log stands never returns.
      const agy = yield* startAgy("log-error", (descriptor) => ({
        ...descriptor,
        turnMachine: {
          ...descriptor.turnMachine!,
          outcome: { watch: () => Effect.never },
        },
      }));
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "hi",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 1, 800);
      // With no baseline the log's error can't be tied to the prompt: its own answer stands.
      expect(completedTurns(agy.events)[0]).toMatchObject({
        turnId,
        payload: { state: "completed" },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("lets a revert wait for a stop under way until the agent's process is gone", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate((seam) => seam.point === "processTeardown");
      const agy = yield* startAgy("simple", undefined, "full-access", gate.seams);
      // The stand-in's session ids carry its process id.
      const sessionId = (agy.session.resumeCursor as { readonly sessionId: string }).sessionId;
      const pid = Number(sessionId.split("-")[1]);
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const stopping = yield* agy.adapter.stopSession(agy.threadId).pipe(Effect.forkScoped);
      yield* gate.reached;
      // The stop has begun: the session reads as gone, but its process isn't.
      expect(yield* agy.adapter.hasSession(agy.threadId)).toBe(false);
      expect(alive()).toBe(true);
      const waiting = yield* agy.adapter.whenStopped!(agy.threadId).pipe(Effect.forkScoped);
      yield* Effect.sleep("200 millis");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* gate.release;
      yield* Fiber.join(waiting);
      expect(alive()).toBe(false);
      yield* Fiber.join(stopping);
      // With nothing running, it answers at once.
      yield* agy.adapter.whenStopped!(agy.threadId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("holds a turn through an approval asked again while the user waits", () =>
    Effect.gen(function* () {
      const opened = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
        events.flatMap((event) => (event.type === "request.opened" ? [event] : []));
      // Quiet limits far shorter than the wait: a request the machine lost
      // track of would end the turn under the open card.
      const agy = yield* startAgy(
        "wake-permission-reask",
        (descriptor) => ({
          ...descriptor,
          turnMachine: {
            ...descriptor.turnMachine!,
            silentLimit: Duration.millis(500),
            replyQuietLimit: Duration.millis(500),
          },
        }),
        "approval-required",
      );
      const { turnId } = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      yield* agy.waitFor((events) => opened(events).length === 2);
      // Past the reply's quiet limit and the settle after it (2 seconds).
      yield* Effect.sleep("3000 millis");
      expect(completedTurns(agy.events)).toHaveLength(0);
      const reasked = opened(agy.events)[1]!;
      yield* agy.adapter.respondToRequest(
        agy.threadId,
        ApprovalRequestId.make(String(reasked.requestId)),
        "accept",
      );
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      // One turn, ended once the reply after the answer was done.
      expect(completedTurns(agy.events).map((event) => event.turnId)).toEqual([turnId]);
      expect(replyTo(agy.events, turnId)).toContain("Done after asking.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("queues a message sent mid-turn, steering being off for Antigravity", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("background");
      expect(agy.adapter.steerTurn).toBeUndefined();
      expect(agy.adapter.capabilities.activeTurnSteering).toBeUndefined();
      const first = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "build it",
        attachments: [],
      });
      // Sent while the first prompt runs: it waits for that turn to end.
      const second = yield* agy.adapter.sendTurn({
        threadId: agy.threadId,
        input: "and then lint",
        attachments: [],
      });
      yield* agy.waitFor((events) => completedTurns(events).length === 2);
      expect(completedTurns(agy.events).map((event) => event.turnId)).toEqual([
        first.turnId,
        second.turnId,
      ]);
      const prompts = (yield* agy.frames()).filter((frame) => frame.method === "session/prompt");
      expect(prompts).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("Antigravity turn reading", () => {
  const tool = (fields: Partial<AcpToolCallState>): AcpToolCallState => ({
    toolCallId: "call",
    data: {},
    ...fields,
  });

  it("holds nothing for a real call_mcp_tool call, as normalized before the turn sees it", () => {
    const update = {
      title: "MCP Tool list_issues",
      kind: "execute",
      rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: { repo: "x/y" } },
    };
    const call = tool({
      toolCallId: "call_mcp",
      kind: "execute",
      title: update.title,
      data: update,
    });
    expect(antigravityWorkAfterPrompt(normalizeAntigravityToolCall(call, update))).toBeUndefined();
    // A later update that shows a command makes it one again: it holds the turn.
    const shown = { kind: "execute", rawInput: { CommandLine: "rm -rf build" } };
    const command = normalizeAntigravityToolCall(normalizeAntigravityToolCall(call, update), shown);
    expect(antigravityWorkAfterPrompt(command)).toEqual({
      kind: "command",
    });
  });

  it("tells the work that outlives a prompt from what ends with it", () => {
    expect(
      antigravityWorkAfterPrompt(
        tool({ kind: "execute", data: { rawInput: { CommandLine: "npm test" } } }),
      ),
    ).toEqual({ kind: "command" });
    // A daemon (a dev server) may never end.
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "execute",
          data: { rawInput: { CommandLine: "npm run dev", IsDaemon: true } },
        }),
      ),
    ).toBeUndefined();
    expect(antigravityWorkAfterPrompt(tool({ kind: "other", title: "Running schedule" }))).toEqual({
      kind: "timer",
    });
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "other",
          title: "Running invoke_subagent",
          data: { rawInput: { Role: "Artist", Prompt: "Paint" } },
        }),
      ),
    ).toEqual({ kind: "subagents", count: 1 });
    // agy 1.5 titles a launch it ran without asking "Run invoke_subagent".
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "other",
          title: "Run invoke_subagent",
          data: { rawInput: { Role: "Artist", Prompt: "Paint" } },
        }),
      ),
    ).toEqual({ kind: "subagents", count: 1 });
    // A batch launch counts each subagent.
    expect(
      antigravityWorkAfterPrompt(
        tool({
          kind: "other",
          title: "Running invoke_subagent",
          data: {
            rawInput: {
              Subagents: [
                { Role: "Artist", Prompt: "Paint" },
                { Role: "Critic", Prompt: "Judge" },
              ],
            },
          },
        }),
      ),
    ).toEqual({ kind: "subagents", count: 2 });
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
    // 1.5 JSON quota details + retryDelay + protobuf length byte prefix before status name.
    expect(
      antigravityFailure({
        errorText:
          'PRESOURCE_EXHAUSTED (code 429): Exhausted. {"details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"quotaResetTimeStamp":"2026-11-23T11:00:00Z","retryDelay":"45.2s"}}]}',
        nowMs,
      }),
    ).toEqual({
      errorMessage: "You've reached your Antigravity quota for now.",
      failureCategory: "rate_limit",
      usageLimit: { resetsAt: "2026-11-23T12:00:45.200Z" },
    });
    expect(
      antigravityFailure({
        errorText: "PRESOURCE_EXHAUSTED (code 429): Too many requests.",
        nowMs,
      }),
    ).toEqual({
      errorMessage: "Antigravity: Too many requests. (429 RESOURCE_EXHAUSTED)",
      failureCategory: "rate_limit",
    });
    // VALIDATION_REQUIRED surfaces only allowlisted Google verification URLs.
    expect(
      antigravityFailure({
        errorText:
          'PERMISSION_DENIED: Verify your account. {"reason":"VALIDATION_REQUIRED","validation_url":"https://accounts.google.com/v3/signin/continue?plt=xyz"}',
        nowMs,
      }),
    ).toEqual({
      errorMessage:
        "Google needs you to verify this account before Antigravity can continue. Verify it at https://accounts.google.com/v3/signin/continue?plt=xyz, then try again.",
      failureCategory: "auth",
    });
    expect(
      antigravityFailure({
        errorText: "VALIDATION_REQUIRED https://evil.example/v3/signin/continue",
        nowMs,
      })?.errorMessage,
    ).not.toContain("evil.example");
    // Mid-turn 401 after the model already answered is retryable; initial 401 is auth.
    expect(
      antigravityFailure({
        errorText: "UNAUTHENTICATED (code 401): Request had invalid authentication credentials.",
        reachedModel: true,
        nowMs,
      })?.failureCategory,
    ).toBe("server_error");
    expect(
      antigravityFailure({
        errorText: "UNAUTHENTICATED (code 401): Request had invalid authentication credentials.",
        reachedModel: false,
        nowMs,
      })?.failureCategory,
    ).toBe("auth");
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
        const { check } = yield* behavior.turnMachine!.outcome!.watch(
          "session-1",
          "claude-sonnet-agent",
        );
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

  it("keeps a result that only wrote to the cache", () => {
    expect(
      antigravityTurnUsageTotals({
        inputTokens: 0,
        outputTokens: 0,
        cachedWriteTokens: 1_200,
        totalTokens: 1_200,
      }),
    ).toMatchObject({ cacheCreationTokens: 1_200 });
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

describe("Antigravity tool rows and attachments", () => {
  const toolItem = (events: ReadonlyArray<ProviderRuntimeEvent>, id: string) =>
    events.findLast((event) => event.type === "item.completed" && String(event.itemId) === id) as
      | Extract<ProviderRuntimeEvent, { type: "item.completed" }>
      | undefined;

  it.live.each(["approval-required", "full-access"] as const)(
    "asks %s for a call_mcp_tool call as a command that names the server, tool and arguments",
    (runtimeMode) =>
      Effect.gen(function* () {
        const agy = yield* startAgy("mcp-permission", undefined, runtimeMode);
        yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
        if (runtimeMode === "approval-required") {
          // Supervised asks for both, as it did before.
          for (let asked = 1; asked <= 2; asked += 1) {
            yield* agy.waitFor(
              (events) =>
                events.filter((event) => event.type === "request.opened").length === asked,
            );
            const request = agy.events.filter((event) => event.type === "request.opened")[
              asked - 1
            ] as Extract<ProviderRuntimeEvent, { type: "request.opened" }>;
            yield* agy.adapter.respondToRequest(
              agy.threadId,
              ApprovalRequestId.make(String(request.requestId)),
              "accept",
            );
          }
          const [mcp, spoof] = agy.events.filter(
            (event) => event.type === "request.opened",
          ) as ReadonlyArray<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>;
          // The same kind of request as before; what runs is in its words.
          expect(mcp?.payload).toMatchObject({
            requestType: "exec_command_approval",
            detail: 'MCP tool github · list_issues {"repo":"x/y"}',
          });
          // A command naming an MCP tool shows the command it runs.
          expect(spoof?.payload).toMatchObject({
            requestType: "exec_command_approval",
            detail: "rm -rf build",
          });
        }
        yield* agy.waitFor((events) => completedTurns(events).length === 1);
        // Full access approves both once, as before; supervised passes on the answers.
        const answers = (yield* agy.frames()).flatMap((frame) =>
          frame.result !== undefined && JSON.stringify(frame.result).includes("optionId")
            ? [JSON.stringify(frame.result)]
            : [],
        );
        expect(answers).toEqual([
          JSON.stringify({ outcome: { outcome: "selected", optionId: "allow" } }),
          JSON.stringify({ outcome: { outcome: "selected", optionId: "allow" } }),
        ]);
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  const opened = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    events.filter((event) => event.type === "request.opened") as ReadonlyArray<
      Extract<ProviderRuntimeEvent, { type: "request.opened" }>
    >;
  const answers = (frames: ReadonlyArray<Record<string, unknown>>) =>
    frames.flatMap((frame) =>
      frame.result !== undefined && JSON.stringify(frame.result).includes("outcome")
        ? [frame.result]
        : [],
    );

  it.live("asks about a call named by its id alone with what the session knows of it", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("permission-partial", undefined, "approval-required");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => opened(events).length === 1);
      expect(opened(agy.events)[0]?.payload).toMatchObject({
        requestType: "exec_command_approval",
        detail: "rm -rf build",
      });
      yield* agy.adapter.respondToRequest(
        agy.threadId,
        ApprovalRequestId.make(String(opened(agy.events)[0]!.requestId)),
        "decline",
      );
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("withdraws an open approval when an update shows it is for something else", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("permission-reask", undefined, "approval-required");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => opened(events).length === 2);
      const [asked, reasked] = opened(agy.events);
      expect(asked?.payload.detail).toBe("MCP tool github · list_issues {}");
      expect(reasked?.payload).toMatchObject({
        requestType: "exec_command_approval",
        detail: "rm -rf build",
      });
      // The first card was closed unanswered, and can't be answered now.
      expect(
        agy.events.find(
          (event) => event.type === "request.resolved" && event.requestId === asked?.requestId,
        ),
      ).toMatchObject({ payload: { requestType: "exec_command_approval" } });
      const stale = yield* Effect.flip(
        agy.adapter.respondToRequest(
          agy.threadId,
          ApprovalRequestId.make(String(asked!.requestId)),
          "accept",
        ),
      );
      expect(stale.message).toContain("Unknown pending approval request");
      yield* agy.adapter.respondToRequest(
        agy.threadId,
        ApprovalRequestId.make(String(reasked!.requestId)),
        "decline",
      );
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(answers(yield* agy.frames())).toEqual([
        { outcome: { outcome: "selected", optionId: "deny" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("asks again when only an open approval's edit text changes", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("permission-edit-changed", undefined, "approval-required");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => opened(events).length === 2);
      const [asked, reasked] = opened(agy.events);
      // Same title and path; the old card is closed and can't approve the new edit.
      expect(reasked?.payload.detail).toBe(asked?.payload.detail);
      expect(
        agy.events.some(
          (event) => event.type === "request.resolved" && event.requestId === asked?.requestId,
        ),
      ).toBe(true);
      const stale = yield* Effect.flip(
        agy.adapter.respondToRequest(
          agy.threadId,
          ApprovalRequestId.make(String(asked!.requestId)),
          "accept",
        ),
      );
      expect(stale.message).toContain("Unknown pending approval request");
      yield* agy.adapter.respondToRequest(
        agy.threadId,
        ApprovalRequestId.make(String(reasked!.requestId)),
        "decline",
      );
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      expect(answers(yield* agy.frames())).toEqual([
        { outcome: { outcome: "selected", optionId: "deny" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("asks before writing another session's plan or a look-alike name", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("plan-file-foreign", undefined, "approval-required");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "plan", attachments: [] });
      for (let asked = 1; asked <= 2; asked += 1) {
        yield* agy.waitFor((events) => opened(events).length === asked);
        yield* agy.adapter.respondToRequest(
          agy.threadId,
          ApprovalRequestId.make(String(opened(agy.events)[asked - 1]!.requestId)),
          "decline",
        );
      }
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      // Both were asked about; only this session's own plan went through unasked.
      expect(opened(agy.events)).toHaveLength(2);
      expect(answers(yield* agy.frames())).toEqual([
        { outcome: { outcome: "selected", optionId: "deny" } },
        { outcome: { outcome: "selected", optionId: "deny" } },
        { outcome: { outcome: "selected", optionId: "allow" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("approves only an edit of the plan file itself without asking", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("plan-file-permission", undefined, "approval-required");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "plan", attachments: [] });
      // The command naming the plan file is asked about.
      yield* agy.waitFor((events) => opened(events).length === 1);
      expect(opened(agy.events)[0]?.payload.requestType).toBe("exec_command_approval");
      yield* agy.adapter.respondToRequest(
        agy.threadId,
        ApprovalRequestId.make(String(opened(agy.events)[0]!.requestId)),
        "decline",
      );
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      // The plan edit was allowed with no card of its own.
      expect(opened(agy.events)).toHaveLength(1);
      expect(answers(yield* agy.frames())).toEqual([
        { outcome: { outcome: "selected", optionId: "deny" } },
        { outcome: { outcome: "selected", optionId: "allow" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("classifies a call by what the agent sent, not by the bounded copy", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("mcp-lossy");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      // Bounding drops the trailing `Cwd`; the call still isn't the wrapper.
      expect(toolItem(agy.events, "call_lossy")?.payload.itemType).not.toBe("mcp_tool_call");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("stops showing a call as MCP once a later update names a file", () =>
    Effect.gen(function* () {
      const agy = yield* startAgy("mcp-then-location");
      yield* agy.adapter.sendTurn({ threadId: agy.threadId, input: "go", attachments: [] });
      yield* agy.waitFor((events) => completedTurns(events).length === 1);
      const rows = agy.events.flatMap((event) =>
        (event.type === "item.updated" || event.type === "item.completed") &&
        String(event.itemId) === "call_wrapped"
          ? [event.payload]
          : [],
      );
      expect(rows[0]).toMatchObject({ itemType: "mcp_tool_call", title: "list_issues" });
      // The later, still-running update is shown at once, with no MCP label.
      expect(rows).toHaveLength(3);
      for (const row of rows.slice(1)) {
        expect(row?.itemType).toBe("command_execution");
        expect(row?.title).not.toBe("list_issues");
        expect(row?.detail ?? "").not.toContain("MCP tool");
      }
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

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
