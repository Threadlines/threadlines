// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GrokSettings,
  MessageId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { grokInstallKind } from "../grok/GrokBinary.ts";
import { makeAcpAdapter } from "./AcpAdapter.ts";
import {
  emptyGrokBackgroundWork,
  grokAskUserQuestionReply,
  grokBackgroundChange,
  grokPromptPosition,
} from "./GrokAcpExtension.ts";
import {
  GROK_ACP_DESCRIPTOR,
  GROK_MODEL_OPTION_MAPPING,
  grokAccountUsage,
  grokProcessEnvironment,
  grokSpawnArgs,
} from "./GrokAcpSupport.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/grok-mock-agent.ts",
);
const isWindows = process.platform === "win32";

/** A `grok` stand-in: the mock agent behind a wrapper the descriptor can launch. */
async function makeGrokMock() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-"));
  const wrapper = path.join(dir, isWindows ? "grok.cmd" : "grok");
  await writeFile(
    wrapper,
    isWindows
      ? `@echo off\r\n"${process.execPath}" "${mockAgentPath}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return { wrapper, log: path.join(dir, "frames.jsonl"), store: path.join(dir, "sessions.json") };
}

async function readFrames(file: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Starts a Grok session on the mock playing `scenario`, collecting every runtime event. */
const startGrok = (
  scenario: string,
  runtimeMode: "approval-required" | "full-access" = "full-access",
) =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(makeGrokMock);
    const adapter = yield* makeAcpAdapter(
      GROK_ACP_DESCRIPTOR,
      decodeGrokSettings({ enabled: true, binaryPath: mock.wrapper }),
      {
        environment: {
          ...process.env,
          GROK_MOCK_SCENARIO: scenario,
          GROK_MOCK_LOG: mock.log,
          GROK_MOCK_STORE: mock.store,
        },
      },
    );
    const events: Array<ProviderRuntimeEvent> = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.forkScoped,
    );
    const threadId = ThreadId.make(`grok-${scenario}`);
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("grok"),
      cwd: process.cwd(),
      runtimeMode,
    });
    const waitFor = (predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (predicate(events)) return;
          yield* Effect.sleep("10 millis");
        }
        throw new Error(`Timed out; saw ${events.map((event) => event.type).join(", ")}`);
      });
    return {
      adapter,
      events,
      threadId,
      waitFor,
      frames: () => Effect.promise(() => readFrames(mock.log)),
    };
  });

const completedTurns = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event) => event.type === "turn.completed");

const replyTo = (events: ReadonlyArray<ProviderRuntimeEvent>, turnId: TurnId) =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.turnId === turnId ? [event.payload.delta] : [],
    )
    .join("");

/** Sends each message in turn on a `remember` mock, waiting out each turn. */
const sendAll = (
  grok: Effect.Success<ReturnType<typeof startGrok>>,
  threadId: ThreadId,
  messages: ReadonlyArray<readonly [input: string, messageId: string]>,
) =>
  Effect.gen(function* () {
    const turnIds: Array<TurnId> = [];
    for (const [input, messageId] of messages) {
      const before = completedTurns(grok.events).length;
      const started = yield* grok.adapter.sendTurn({
        threadId,
        input,
        attachments: [],
        messageId: MessageId.make(messageId),
      });
      yield* grok.waitFor((events) => completedTurns(events).length === before + 1);
      turnIds.push(started.turnId);
    }
    return turnIds;
  });

describe("Grok launch", () => {
  it("puts the runtime mode on the command line, top-level flags before `agent`", () => {
    expect(grokSpawnArgs()).toEqual(["--no-auto-update", "agent", "--no-leader", "stdio"]);
    expect(grokSpawnArgs({ runtimeMode: "approval-required" })).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "stdio",
    ]);
    expect(grokSpawnArgs({ runtimeMode: "full-access" })).toEqual([
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--always-approve",
      "stdio",
    ]);
  });

  it("drops inherited API keys unless the instance bills by key, and keeps an account to its folder", () => {
    const inherited = {
      PATH: "/bin",
      XAI_API_KEY: "sk-inherited",
      GROK_CODE_XAI_API_KEY: "sk-legacy",
      GROK_AUTH_PATH: "/Users/me/.grok/auth.json",
    };
    const subscription = grokProcessEnvironment(
      { accountFolder: "", authMethod: "subscription" },
      inherited,
    );
    expect(subscription.XAI_API_KEY).toBeUndefined();
    expect(subscription.GROK_CODE_XAI_API_KEY).toBeUndefined();
    expect(subscription.GROK_DISABLE_API_KEY_AUTH).toBe("1");
    expect(subscription.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(subscription.GROK_FOLDER_TRUST).toBe("0");

    const account = grokProcessEnvironment(
      { accountFolder: "/tmp/grok-work", authMethod: "subscription" },
      inherited,
    );
    expect(account.GROK_HOME).toBe("/tmp/grok-work");
    expect(account.GROK_AUTH_PATH).toBeUndefined();

    const byKey = grokProcessEnvironment(
      { accountFolder: "/tmp/k", authMethod: "api-key" },
      inherited,
    );
    expect(byKey.XAI_API_KEY).toBe("sk-inherited");
    expect(byKey.GROK_DISABLE_API_KEY_AUTH).toBeUndefined();
  });

  it("updates by how Grok was installed", () => {
    expect(grokInstallKind("/opt/homebrew/Caskroom/grok-build/1.0.52/grok")).toBe("homebrew");
    expect(grokInstallKind("C:\\Users\\me\\scoop\\apps\\grok-cli\\current\\grok.exe")).toBe(
      "scoop",
    );
    expect(
      grokInstallKind(
        "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\xAI.GrokBuild_x\\grok.exe",
      ),
    ).toBe("winget");
    expect(grokInstallKind("/Users/me/.grok/downloads/grok-macos-aarch64")).toBe("own");
  });
});

describe("Grok protocol mapping", () => {
  it("shows Grok's effort as the reasoning control and sends it back under Grok's id", () => {
    const configOptions = [
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        category: "thought_level",
        type: "select" as const,
        currentValue: "high",
        options: [
          { value: "high", name: "High" },
          { value: "low", name: "Low" },
        ],
      },
    ];
    const capabilities = GROK_MODEL_OPTION_MAPPING.capabilitiesFromConfigOptions(configOptions);
    expect(capabilities.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
    ]);
    expect(
      GROK_MODEL_OPTION_MAPPING.configUpdatesFromSelections(configOptions, [
        { id: "reasoningEffort", value: "low" },
      ]),
    ).toEqual([{ configId: "reasoning_effort", value: "low" }]);
  });

  it("reads the plan's weekly meter, with nothing metered yet as 0%", () => {
    const usage = grokAccountUsage(
      {
        config: {
          creditUsagePercent: 41.6,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-20T00:00:00Z" },
        },
        subscription_tier: "SuperGrok",
      },
      "2026-10-15T12:00:00.000Z",
    );
    expect(usage?.limits[0]).toMatchObject({
      planType: "SuperGrok",
      primary: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: Date.parse("2026-10-20T00:00:00Z"),
        windowDurationMins: 7 * 24 * 60,
      },
    });
    const fresh = grokAccountUsage(
      { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } },
      "2026-10-15T12:00:00.000Z",
    );
    expect(fresh?.limits[0]?.primary).toMatchObject({
      usedPercent: 0,
      windowDurationMins: 30 * 24 * 60,
    });
  });

  it("answers a question with the chosen labels, typed text as Grok's Other, and nothing as cancelled", () => {
    const request = {
      questions: [
        { question: "Which file?", options: [{ label: "a.ts" }, { label: "b.ts" }] },
        { question: "Anything else?", options: [{ label: "No" }] },
      ],
    };
    expect(
      grokAskUserQuestionReply(request, { "Which file?": "a.ts", "Anything else?": "Use tabs" }),
    ).toEqual({
      outcome: "accepted",
      answers: { "Which file?": ["a.ts"], "Anything else?": ["Other"] },
      annotations: { "Anything else?": { notes: "Use tabs" } },
    });
    expect(grokAskUserQuestionReply(request, {})).toEqual({ outcome: "cancelled" });
  });

  it("places a sent prompt among Grok's rewind points by the head Grok previews", () => {
    // Grok 1.0.52's own shape: the preview is the prompt's first line.
    const points = {
      rewind_points: [
        { prompt_index: 0, prompt_preview: "Fix tests" },
        { prompt_index: 1, prompt_preview: "Fix tests in auth only" },
        { prompt_index: 2, prompt_preview: "Refactor the session loader" },
        { prompt_index: 3, prompt_preview: "Refactor the session loader" },
      ],
    };
    expect(grokPromptPosition(points, "Fix tests", undefined)).toEqual({ position: 0, newest: 3 });
    // A prompt of several lines matches its first line, after the last placed turn.
    const long = "Refactor the session loader\n\nso it retries once";
    expect(grokPromptPosition(points, long, 2).position).toBe(3);
    // Two unplaced prompts that open alike (an earlier lookup failed) are no answer.
    expect(grokPromptPosition(points, long, 1).position).toBeUndefined();
    expect(grokPromptPosition(points, long, undefined).position).toBeUndefined();
  });

  it("tracks a subagent and a background shell, and lets a snapshot drop a killed shell", () => {
    const spawned = grokBackgroundChange(emptyGrokBackgroundWork(), {
      sessionUpdate: "subagent_spawned",
      subagent_id: "sub-1",
      description: "Look around",
    });
    const shell = grokBackgroundChange(spawned!.work, {
      sessionUpdate: "task_backgrounded",
      task_id: "call-1-0",
      command: "npm run dev",
    });
    expect(shell!.events.map((event) => event.type)).toEqual([
      "task.started",
      "task.snapshot.updated",
    ]);
    // A kill gets no `task_completed`; Grok's next snapshot no longer lists it.
    const snapshot = grokBackgroundChange(shell!.work, {
      sessionUpdate: "background_tasks",
      tasks: [],
    });
    const finished = grokBackgroundChange(snapshot!.work, {
      sessionUpdate: "subagent_finished",
      subagent_id: "sub-1",
      status: "completed",
      output: "done",
    });
    const last = finished!.events.at(-1);
    expect(last?.type === "task.snapshot.updated" ? last.payload.tasks : undefined).toEqual([]);
    expect(finished!.events[0]).toMatchObject({
      type: "task.completed",
      payload: { taskId: "sub-1", status: "completed", summary: "done" },
    });
  });
});

/** A test server config; each session test provides it with Node services. */
const testServices = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), {
    prefix: "threadlines-grok-adapter-test-",
  }),
  NodeServices.layer,
);

describe("Grok sessions", () => {
  it.live("runs a turn with Grok's prompt id, its turn mode and the extension client type", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("simple");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "hi", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 1);

      const frames = yield* grok.frames();
      const initialize = frames.find((frame) => frame.method === "initialize");
      expect((initialize?.params as { _meta?: unknown })._meta).toEqual({
        clientType: "extension",
      });
      const methods = frames.map((frame) => frame.method);
      expect(methods.indexOf("session/set_mode")).toBeLessThan(methods.indexOf("session/prompt"));
      const prompt = frames.find((frame) => frame.method === "session/prompt");
      const turnStarted = grok.events.find((event) => event.type === "turn.started");
      expect((prompt?.params as { _meta?: { promptId?: string } })._meta?.promptId).toBe(
        `threadlines-${turnStarted?.turnId}`,
      );
      const delta = grok.events.find((event) => event.type === "content.delta");
      expect(delta?.type === "content.delta" ? delta.payload.delta : undefined).toBe(
        "hello from grok",
      );
      expect(completedTurns(grok.events)[0]).toMatchObject({ payload: { state: "completed" } });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("steers a running turn and shows Grok's context fill against the model's window", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("steer");
      expect(grok.adapter.capabilities.activeTurnSteering).toBe("supported");
      const started = yield* grok.adapter.sendTurn({
        threadId: grok.threadId,
        input: "go",
        attachments: [],
      });
      yield* grok.waitFor((events) => events.some((event) => event.type === "content.delta"));
      const steered = yield* grok.adapter.steerTurn!({
        threadId: grok.threadId,
        expectedTurnId: started.turnId,
        input: "also check the tests",
      });
      expect(steered.turnId).toBe(started.turnId);
      yield* grok.waitFor((events) => completedTurns(events).length === 1);
      const text = grok.events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      expect(text).toContain("steered: also check the tests");
      const usage = grok.events.find((event) => event.type === "thread.token-usage.updated");
      expect(
        usage?.type === "thread.token-usage.updated" ? usage.payload.usage : undefined,
      ).toEqual({
        usedTokens: 1234,
        maxTokens: 500_000,
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("asks Grok's question as a question card and returns the answer in Grok's shape", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("question");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "pick", attachments: [] });
      yield* grok.waitFor((events) =>
        events.some((event) => event.type === "user-input.requested"),
      );
      const requested = grok.events.find((event) => event.type === "user-input.requested");
      if (requested?.type !== "user-input.requested" || requested.requestId === undefined) {
        throw new Error("no question card");
      }
      expect(requested.payload.questions[0]).toMatchObject({
        id: "Which file?",
        question: "Which file?",
      });
      yield* grok.adapter.respondToUserInput(grok.threadId, requested.requestId as never, {
        "Which file?": "b.ts",
      });
      yield* grok.waitFor((events) => completedTurns(events).length === 1);
      const text = grok.events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      expect(JSON.parse(text.replace("answered ", ""))).toEqual({
        outcome: "accepted",
        answers: { "Which file?": ["b.ts"] },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("puts Grok in plan mode, shows its plan and leaves plan mode without building", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("plan");
      yield* grok.adapter.sendTurn({
        threadId: grok.threadId,
        input: "plan it",
        attachments: [],
        interactionMode: "plan",
      });
      yield* grok.waitFor((events) => completedTurns(events).length === 1);
      const frames = yield* grok.frames();
      expect(frames.find((frame) => frame.method === "session/set_mode")?.params).toMatchObject({
        modeId: "plan",
      });
      const plan = grok.events.find((event) => event.type === "turn.proposed.completed");
      expect(plan?.type === "turn.proposed.completed" ? plan.payload.planMarkdown : undefined).toBe(
        "# Plan\n\n1. Do the thing",
      );
      const text = grok.events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      expect(text).toBe('plan reply {"outcome":"abandoned"}');
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("offers a session-wide approval only where Grok's grant lasts just the session", () =>
    Effect.gen(function* () {
      const decisionsFor = (scenario: string) =>
        Effect.gen(function* () {
          const grok = yield* startGrok(scenario, "approval-required");
          yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "go", attachments: [] });
          yield* grok.waitFor((events) => events.some((event) => event.type === "request.opened"));
          const opened = grok.events.find((event) => event.type === "request.opened");
          if (opened?.type !== "request.opened" || opened.requestId === undefined) {
            throw new Error("no approval");
          }
          yield* grok.adapter.respondToRequest(grok.threadId, opened.requestId as never, "accept");
          yield* grok.waitFor((events) => completedTurns(events).length === 1);
          return opened.payload.availableDecisions;
        });
      // A shell's "always" is a grant for the whole project: never offered.
      expect(yield* decisionsFor("permission-bash")).toEqual(["cancel", "decline", "accept"]);
      expect(yield* decisionsFor("permission-edit")).toEqual([
        "cancel",
        "decline",
        "acceptForSession",
        "accept",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("fails a turn with Grok's own words rather than the bare RPC error", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("error");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "go", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(grok.events)[0]).toMatchObject({
        payload: { state: "failed", errorMessage: "Grok's model is overloaded. Try again soon." },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live(
    "opens a turn for Grok's own wake-up and keeps the subagent's output out of the thread",
    () =>
      Effect.gen(function* () {
        const grok = yield* startGrok("wake");
        yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "spawn", attachments: [] });
        yield* grok.waitFor((events) => completedTurns(events).length === 2);

        const [userTurn, agentTurn] = completedTurns(grok.events);
        expect(userTurn?.turnId).not.toBe(agentTurn?.turnId);
        const wakeText = grok.events
          .flatMap((event) =>
            event.type === "content.delta" && event.turnId === agentTurn?.turnId
              ? [event.payload.delta]
              : [],
          )
          .join("");
        expect(wakeText).toBe("The subagent said SUBAGENT_DONE.");
        const allText = grok.events
          .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
          .join("");
        expect(allText).not.toContain("child output");
        expect(
          grok.events
            .filter((event) => event.type === "task.started" || event.type === "task.completed")
            .map((event) => [
              event.type,
              event.type === "task.completed" ? event.payload.status : undefined,
            ]),
        ).toEqual([
          ["task.started", undefined],
          ["task.completed", "completed"],
        ]);
      }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("rewinds Grok to the reverted message, and still can after a restart", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("remember");
      const revert = (messageId: string) =>
        grok.adapter
          .rollbackThread(grok.threadId, 1, { targetUserMessageId: MessageId.make(messageId) })
          .pipe(Effect.map((snapshot) => snapshot.conversationRolledBack));
      yield* sendAll(grok, grok.threadId, [
        ["first", "m1"],
        ["second", "m2"],
        ["third", "m3"],
      ]);
      expect(yield* revert("m2")).toBe(true);
      const [again] = yield* sendAll(grok, grok.threadId, [["again", "m4"]]);
      expect(replyTo(grok.events, again!)).toBe("remembers: first | again");
      // A message Grok never placed: only Threadlines' turn list is trimmed.
      expect(yield* revert("unknown")).toBe(false);

      // The resume cursor keeps where each prompt sits.
      const cursor = (yield* grok.adapter.listSessions()).find(
        (session) => session.threadId === grok.threadId,
      )?.resumeCursor;
      yield* grok.adapter.stopSession(grok.threadId);
      yield* grok.adapter.startSession({
        threadId: grok.threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: cursor,
      });
      expect(yield* revert("m4")).toBe(true);
      const [later] = yield* sendAll(grok, grok.threadId, [["later", "m5"]]);
      expect(replyTo(grok.events, later!)).toBe("remembers: first | later");
      const rewinds = (yield* grok.frames())
        .filter((frame) => frame.method === "_x.ai/rewind/execute")
        .map((frame) => frame.params);
      const rewind = {
        sessionId: "grok-session-1",
        targetPromptIndex: 1,
        mode: "conversation_only",
        force: true,
      };
      expect(rewinds).toEqual([rewind, rewind]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("forks Grok's conversation at a turn, and refuses a turn it can't place", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("remember");
      expect(grok.adapter.capabilities.nativeThreadFork).toBe("supported");
      const [, second] = yield* sendAll(grok, grok.threadId, [
        ["first", "m1"],
        ["second", "m2"],
        ["third", "m3"],
      ]);
      const fork = (threadId: string, beforeTurnId: string) =>
        grok.adapter.startSession({
          threadId: ThreadId.make(threadId),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          forkFrom: { providerThreadId: "grok-session-1", beforeTurnId },
        });
      yield* fork("grok-fork", second!);
      const [fourth] = yield* sendAll(grok, ThreadId.make("grok-fork"), [["fourth", "f1"]]);
      expect(replyTo(grok.events, fourth!)).toBe("remembers: first | fourth");
      // Grok copies through the prompt before the boundary, from where the source ran.
      const forked = (yield* grok.frames()).find((frame) => frame.method === "_x.ai/session/fork");
      expect(forked?.params).toEqual({
        sourceSessionId: "grok-session-1",
        sourceCwd: process.cwd(),
        newCwd: process.cwd(),
        targetPromptIndex: 0,
      });
      // The source keeps its whole conversation.
      const [fifth] = yield* sendAll(grok, grok.threadId, [["fifth", "m4"]]);
      expect(replyTo(grok.events, fifth!)).toBe("remembers: first | second | third | fifth");

      const refused = yield* fork("grok-fork-2", "never-seen").pipe(Effect.flip);
      expect(refused.message).toContain("can't be forked");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("opens Grok's own turn even when it starts as the prompt's turn closes", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("wake-now");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "spawn", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 2);
      const [userTurn, agentTurn] = completedTurns(grok.events);
      expect(replyTo(grok.events, userTurn!.turnId!)).toBe("ROOT_DONE");
      expect(replyTo(grok.events, agentTurn!.turnId!)).toBe("The subagent said SUBAGENT_DONE.");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("keeps a wake-up that starts before the prompt's answer out of the prompt's turn", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("wake-early");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "go", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 2);
      const [userTurn, agentTurn] = completedTurns(grok.events);
      expect(replyTo(grok.events, userTurn!.turnId!)).toBe("ROOT_DONE");
      expect(replyTo(grok.events, agentTurn!.turnId!)).toBe("WAKE_PART_1 WAKE_PART_2");
      // One message, though the prompt's answer arrived in the middle of it.
      const wakeItems = new Set(
        grok.events.flatMap((event) =>
          event.type === "content.delta" && event.turnId === agentTurn?.turnId
            ? [event.itemId]
            : [],
        ),
      );
      expect(wakeItems.size).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("gives back-to-back wake-ups each a message of their own", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("wake-twice");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "spawn", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 3);
      const [, first, second] = completedTurns(grok.events);
      const itemsOf = (turnId: TurnId | undefined) =>
        new Set(
          grok.events.flatMap((event) =>
            event.type === "content.delta" && event.turnId === turnId ? [event.itemId] : [],
          ),
        );
      const firstItems = itemsOf(first?.turnId);
      expect(firstItems.size).toBe(1);
      for (const itemId of itemsOf(second?.turnId)) expect(firstItems.has(itemId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("closes the session before the process ends", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("simple");
      yield* grok.adapter.stopSession(grok.threadId);
      const frames = yield* grok.frames();
      expect(frames.some((frame) => frame.method === "session/close")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});
