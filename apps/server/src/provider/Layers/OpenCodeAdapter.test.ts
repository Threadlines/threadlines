/**
 * The OpenCode adapter against a scripted OpenCode: requests are recorded,
 * and the test plays the server's event frames (shapes as recorded from
 * OpenCode 2.0.22) and checks the runtime events that come out.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  MessageId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { OpenCodeClient } from "../opencode/OpenCodeClient.ts";
import { decodeOpenCodeFrame } from "../opencode/OpenCodeEvents.ts";
import type {
  OpenCodeServerManagerShape,
  OpenCodeServerSignal,
} from "../opencode/OpenCodeServerManager.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("opencode");
const ROOT = "ses_root";

interface Call {
  readonly method: string;
  readonly input: unknown;
}

/** Only what the adapter calls; every call is recorded. */
function fakeClient(calls: Array<Call>, overrides: Record<string, (input: any) => unknown> = {}) {
  const call =
    (method: string, result: (input: any) => unknown = () => undefined) =>
    async (input: unknown) => {
      calls.push({ method, input });
      return (overrides[method] ?? result)(input);
    };
  return {
    agent: {
      list: call("agent.list", () => ({
        data: [
          {
            id: "build",
            mode: "primary",
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          },
        ],
      })),
    },
    model: { list: call("model.list", () => ({ data: [] })) },
    mcp: {
      add: call("mcp.add"),
      remove: call("mcp.remove"),
      list: call("mcp.list", () => ({ data: [] })),
    },
    command: { list: call("command.list", () => ({ data: [] })) },
    permission: { reply: call("permission.reply"), list: call("permission.list", () => []) },
    shell: { remove: call("shell.remove") },
    message: { list: call("message.list", () => ({ data: [], cursor: {} })) },
    session: {
      create: call("session.create", () => ({ id: ROOT, location: { directory: "/" } })),
      get: call("session.get", () => ({ id: ROOT })),
      update: call("session.update"),
      prompt: call("session.prompt", (input) => ({ id: input.id })),
      interrupt: call("session.interrupt", () => ({ interrupted: true })),
      active: call("session.active", () => ({})),
      list: call("session.list", () => ({ data: [] })),
      switchAgent: call("session.switchAgent"),
      switchModel: call("session.switchModel"),
      inbox: { list: call("session.inbox.list", () => []), cancel: call("session.inbox.cancel") },
      instructions: { entry: { put: call("instructions.put") } },
      form: {
        list: call("form.list", () => []),
        reply: call("form.reply"),
        cancel: call("form.cancel"),
      },
    },
  } as unknown as OpenCodeClient;
}

function frame(type: string, data: Record<string, unknown>) {
  return { id: "evt_x", created: Date.now(), type, data };
}

const harness = Effect.gen(function* () {
  const calls: Array<Call> = [];
  const signals = yield* PubSub.unbounded<OpenCodeServerSignal>();
  const client = fakeClient(calls);
  const active = {
    generation: 1,
    server: {
      url: "http://127.0.0.1:1",
      client,
      version: "2.0.22",
      external: false,
      exited: Effect.never,
    },
    streamReady: Effect.void,
  };
  const manager: OpenCodeServerManagerShape = {
    server: Effect.succeed(active),
    lease: Effect.void,
    retire: Effect.void,
    withServer: (use) => Effect.scoped(use(active)),
    signals: Stream.fromPubSub(signals),
  };
  const adapter = yield* makeOpenCodeAdapter({
    instanceId: INSTANCE_ID,
    settings: {
      enabled: true,
      binaryPath: "opencode",
      serverUrl: "",
      serverPassword: "",
      accountFolder: "",
      customModels: [],
    },
    manager,
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  // Let the adapter's signal loop subscribe before anything is published.
  yield* Effect.sleep(Duration.millis(10));

  const send = (type: string, data: Record<string, unknown>) => {
    const decoded = decodeOpenCodeFrame(frame(type, data));
    if (decoded._tag !== "Event") throw new Error(`frame ${type} did not decode`);
    return PubSub.publish(signals, { _tag: "Event", generation: 1, event: decoded.event });
  };
  const next = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (predicate(event)) return event;
      }
    }).pipe(Effect.timeout(Duration.seconds(5)));
  const drain = Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(30));
    return yield* Queue.takeAll(events);
  });

  const threadId = ThreadId.make("thread-1");
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "opencode-adapter-")));
  return { adapter, calls, send, next, drain, threadId, cwd };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("OpenCodeAdapter", () => {
  it.live("keeps a turn open while steered input waits for the next execution", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, next, drain, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "go",
      });
      expect(turn.turnId).toBe("msg_tl_m1");
      expect(calls.find((call) => call.method === "session.prompt")?.input).toMatchObject({
        sessionID: ROOT,
        id: "msg_tl_m1",
        delivery: "steer",
      });

      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m1" });
      yield* adapter.steerTurn({
        threadId,
        expectedTurnId: turn.turnId,
        messageId: MessageId.make("m2"),
        input: "also this",
      });
      // The execution ends before reading the steer: the turn must not end.
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      expect((yield* drain).some((event) => event.type === "turn.completed")).toBe(false);

      // OpenCode starts another execution to deliver it; that one ends the turn.
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m2" });
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      const completed = yield* next((event) => event.type === "turn.completed");
      expect(completed).toMatchObject({ turnId: turn.turnId, payload: { state: "completed" } });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("turns an execution nobody asked for into the agent's own turn", () =>
    Effect.gen(function* () {
      const { adapter, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* send("session.execution.started", { sessionID: ROOT });
      const started = yield* next((event) => event.type === "turn.started");
      expect(started.turnId).toMatch(/^wake_/);
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      const completed = yield* next((event) => event.type === "turn.completed");
      expect(completed.turnId).toBe(started.turnId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("files a subagent's work under the agent, linked to its spawning call", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      const turn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "delegate",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_1",
        name: "subagent",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_1",
        input: { agent: "general", description: "Count lines", prompt: "Count the lines" },
        executed: false,
      });
      yield* send("session.created", {
        sessionID: "ses_child",
        parentID: ROOT,
        agent: "general",
        title: "Count lines",
      });
      yield* send("session.tool.progress", {
        sessionID: ROOT,
        id: "call_1",
        metadata: { sessionID: "ses_child", status: "running" },
      });
      yield* send("session.text.delta", {
        sessionID: "ses_child",
        assistantMessageID: "msg_c",
        ordinal: 0,
        delta: "42 lines",
      });

      const linked = yield* next(
        (event) => event.type === "subagent.metadata.updated" && event.payload.callId === "call_1",
      );
      expect(linked.payload).toMatchObject({
        agentThreadId: "ses_child",
        status: "running",
        isBackgrounded: false,
      });
      const childText = yield* next((event) => event.type === "content.delta");
      expect(childText).toMatchObject({
        turnId: turn.turnId,
        providerRefs: { providerThreadId: "ses_child" },
        payload: { delta: "42 lines" },
      });
      // The child got its parent's approval rules.
      expect(
        calls.some(
          (call) =>
            call.method === "session.update" &&
            (call.input as { sessionID: string }).sessionID === "ses_child",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("answers OpenCode's asks itself in full access and shows them otherwise", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, next, threadId, cwd } = yield* harness;
      const ask = {
        id: "per_1",
        sessionID: ROOT,
        action: "shell",
        resources: ["echo hi"],
        save: ["echo *"],
        source: { type: "tool", messageID: "msg_a", id: "call_9" },
      };
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* send("permission.asked", ask);
      yield* Effect.sleep(Duration.millis(30));
      expect(calls.find((call) => call.method === "permission.reply")?.input).toMatchObject({
        requestID: "per_1",
        decision: "once",
      });

      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      yield* send("permission.asked", { ...ask, id: "per_2" });
      const opened = yield* next((event) => event.type === "request.opened");
      expect(opened.payload).toMatchObject({ requestType: "exec_command_approval" });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "decline",
      );
      // A decline carries a note, so the model moves on instead of the run ending.
      expect(calls.findLast((call) => call.method === "permission.reply")?.input).toMatchObject({
        requestID: "per_2",
        decision: "reject",
        message: expect.stringContaining("declined"),
      });
      yield* next(
        (event) => event.type === "request.resolved" && event.payload.decision === "decline",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("ignores a stop meant for a turn that already ended", () =>
    Effect.gen(function* () {
      const { adapter, calls, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "go" });
      yield* adapter.interruptTurn(threadId, "msg_tl_old" as never);
      expect(calls.some((call) => call.method === "session.interrupt")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
