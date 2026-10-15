// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GrokSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { grokInstallKind } from "../grok/GrokBinary.ts";
import { makeAcpAdapter } from "./AcpAdapter.ts";
import {
  emptyGrokBackgroundWork,
  grokAskUserQuestionReply,
  grokBackgroundChange,
} from "./GrokAcpExtension.ts";
import {
  GROK_ACP_DESCRIPTOR,
  GROK_MODEL_OPTION_MAPPING,
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
  return { wrapper, log: path.join(dir, "frames.jsonl") };
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
        environment: { ...process.env, GROK_MOCK_SCENARIO: scenario, GROK_MOCK_LOG: mock.log },
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
const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "threadlines-grok-adapter-test-",
});

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
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
  );

  it.live("fails a turn with Grok's own words rather than the bare RPC error", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("error");
      yield* grok.adapter.sendTurn({ threadId: grok.threadId, input: "go", attachments: [] });
      yield* grok.waitFor((events) => completedTurns(events).length === 1);
      expect(completedTurns(grok.events)[0]).toMatchObject({
        payload: { state: "failed", errorMessage: "Grok's model is overloaded. Try again soon." },
      });
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
  );

  it.live("closes the session before the process ends", () =>
    Effect.gen(function* () {
      const grok = yield* startGrok("simple");
      yield* grok.adapter.stopSession(grok.threadId);
      const frames = yield* grok.frames();
      expect(frames.some((frame) => frame.method === "session/close")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testServices), Effect.provide(NodeServices.layer)),
  );
});
