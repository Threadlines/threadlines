// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { AcpSessionRuntime, type AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";
import type * as EffectAcpProtocol from "effect-acp/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const nodeExe = process.execPath;

describe("AcpSessionRuntime", () => {
  it.effect("merges custom initialize client capabilities into the ACP handshake", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const initializeStarted = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initializeStarted?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
            env: {
              T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("suppresses generic placeholder tool updates until completion", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 1)));
      expect(notes.map((note) => note._tag)).toEqual(["ToolCallUpdated"]);
      const toolCall = notes[0];
      expect(toolCall?._tag).toBe("ToolCallUpdated");
      if (toolCall?._tag === "ToolCallUpdated") {
        expect(toolCall.toolCall.status).toBe("completed");
        expect(toolCall.toolCall.title).toBe("Read file");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
            env: {
              T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("logs ACP requests from the shared runtime", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("skips no-op session config writes when the requested value is already active", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setConfigOption("model", "default");
      yield* runtime.setMode("ask");

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () => {
    const protocolEvents: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                protocolEvents.push(event);
              }),
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: nodeExe,
            args: [mockAgentPath],
            env: {
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps what the agent said about itself when it then refuses a session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);
      expect(error._tag === "AcpRequestError" && error.code).toBe(-32000);
      // A signed-out agent's sign-in methods are in the answer it did give.
      expect((yield* runtime.getInitializeResult)?.authMethods).toEqual([
        { id: "mock-login", name: "Log in to Mock" },
      ]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: { command: nodeExe, args: [mockAgentPath], env: { T3_ACP_AUTH_REQUIRED: "1" } },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("native controls drive the older modes and models fields as options", () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const optionIds = (yield* runtime.getConfigOptions).map((option) => [
        option.id,
        option.category,
        option.currentValue,
      ]);
      expect(optionIds).toEqual([
        ["mode", "mode", "ask"],
        ["model", "model", "default"],
      ]);

      yield* runtime.setConfigOption("mode", "code");
      yield* runtime.setModel("composer-2");

      // Each goes out the way that field is set, never as a config option.
      const sent = requests.filter((request) => request.method.startsWith("session/set_"));
      expect(sent).toEqual([
        { method: "session/set_mode", payload: { sessionId: "mock-session-1", modeId: "code" } },
        {
          method: "session/set_model",
          payload: { sessionId: "mock-session-1", modelId: "composer-2" },
        },
      ]);
      expect((yield* runtime.getConfigOptions).map((option) => option.currentValue)).toEqual([
        "code",
        "composer-2",
      ]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: { command: nodeExe, args: [mockAgentPath], env: { T3_ACP_LEGACY_CONTROLS: "1" } },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          sessionControls: "native",
          requestLogger: (event) =>
            Effect.sync(() => {
              if (event.status === "started") {
                requests.push({ method: event.method, payload: event.payload });
              }
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("native controls take the agent's own option updates; mapped ones don't", () => {
    const optionIdsAfterPrompt = (sessionControls: "native" | "mapped") =>
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
        return (yield* runtime.getConfigOptions).map((option) => option.id);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: nodeExe,
              args: [mockAgentPath],
              env: { T3_ACP_EMIT_CONFIG_OPTION_UPDATE: "1" },
            },
            cwd: process.cwd(),
            clientInfo: { name: "t3-test", version: "0.0.0" },
            sessionControls,
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    return Effect.gen(function* () {
      // The update lists only "effort"; the legacy mode stand-in is kept
      // because the agent still lists no mode option of its own.
      expect(yield* optionIdsAfterPrompt("native")).toEqual(["effort", "mode"]);
      expect(yield* optionIdsAfterPrompt("mapped")).toEqual(["model"]);
    });
  });
  it.effect("native controls set the mode through the agent's own option, whatever its id", () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      yield* runtime.setMode("code");
      expect(requests.filter((request) => request.method.startsWith("session/set_"))).toEqual([
        {
          method: "session/set_config_option",
          payload: { sessionId: "mock-session-1", configId: "permission", value: "code" },
        },
      ]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: { command: nodeExe, args: [mockAgentPath], env: { T3_ACP_NO_MODEL: "1" } },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          sessionControls: "native",
          requestLogger: (event) =>
            Effect.sync(() => {
              if (event.status === "started") {
                requests.push({ method: event.method, payload: event.payload });
              }
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
