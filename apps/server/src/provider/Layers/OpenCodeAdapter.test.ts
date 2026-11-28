/**
 * The OpenCode adapter against a scripted OpenCode: requests are recorded,
 * and the test plays the server's event frames (shapes as recorded from
 * OpenCode 2.0.22) and checks the runtime events that come out.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  MessageId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type RuntimeUsageLimit,
  type ServerProviderSlashCommand,
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
          {
            id: "plan",
            mode: "primary",
            permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          },
        ],
      })),
    },
    location: { reload: call("location.reload") },
    file: { read: call("file.read", () => Promise.reject(new Error("not found"))) },
    model: { list: call("model.list", () => ({ data: [] })) },
    mcp: { list: call("mcp.list", () => ({ data: [] })) },
    experimental: {
      mcp: { add: call("mcp.add"), remove: call("mcp.remove") },
      session: { instructions: { entry: { put: call("instructions.put") } } },
    },
    command: { list: call("command.list", () => ({ data: [] })) },
    permission: { reply: call("permission.reply"), list: call("permission.list", () => []) },
    shell: {
      remove: call("shell.remove"),
      get: call("shell.get"),
      output: call("shell.output", () => ({
        location: {},
        data: { output: "", cursor: 0, size: 0, truncated: false },
      })),
      list: call("shell.list", () => ({ location: {}, data: [] })),
    },
    message: { list: call("message.list", () => ({ data: [], cursor: {} })) },
    session: {
      create: call("session.create", () => ({ id: ROOT, location: { directory: "/" } })),
      get: call("session.get", () => ({ id: ROOT })),
      update: call("session.update"),
      prompt: call("session.prompt", (input) => ({ id: input.id })),
      command: call("session.command"),
      interrupt: call("session.interrupt", () => ({ interrupted: true })),
      active: call("session.active", () => ({})),
      list: call("session.list", () => ({ data: [] })),
      switchAgent: call("session.switchAgent"),
      switchModel: call("session.switchModel"),
      inbox: { list: call("session.inbox.list", () => []), cancel: call("session.inbox.cancel") },
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

const harnessWith = (
  overrides: Record<string, (input: any) => unknown> = {},
  options: {
    readonly serverUrl?: string;
    readonly external?: boolean;
    readonly isRunning?: boolean;
    readonly onSessionCommands?: (
      sessionKey: string,
      commands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
    ) => Effect.Effect<void>;
    readonly onCatalogChanged?: Effect.Effect<void>;
    readonly readUsageLimit?: Effect.Effect<RuntimeUsageLimit | undefined>;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const signals = yield* PubSub.unbounded<OpenCodeServerSignal>();
    const client = fakeClient(calls, overrides);
    const active = {
      generation: 1,
      server: {
        url: options.serverUrl ?? "http://127.0.0.1:1",
        client,
        version: "2.0.22",
        external: options.external ?? false,
        exited: Effect.never,
        pid: null,
      },
      streamReady: Effect.void,
    };
    const manager: OpenCodeServerManagerShape = {
      server: Effect.succeed(active),
      lease: Effect.void,
      retire: Effect.void,
      withServer: (use) => Effect.scoped(use(active)),
      signals: Stream.fromPubSub(signals),
      running: Effect.succeed(options.isRunning === false ? undefined : active.server),
    };
    const adapter = yield* makeOpenCodeAdapter({
      instanceId: INSTANCE_ID,
      settings: {
        enabled: true,
        binaryPath: "opencode",
        serverUrl: options.external ? (options.serverUrl ?? "http://127.0.0.1:1") : "",
        serverPassword: "",
        accountFolder: "",
        customModels: [],
      },
      manager,
      ...(options.onSessionCommands ? { onSessionCommands: options.onSessionCommands } : {}),
      ...(options.onCatalogChanged ? { onCatalogChanged: options.onCatalogChanged } : {}),
      ...(options.readUsageLimit ? { readUsageLimit: options.readUsageLimit } : {}),
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
    return { adapter, calls, signals, events, send, next, drain, threadId, cwd };
  });
const harness = harnessWith();

/** Plays a shell call that OpenCode moves to the background as `shellId`. */
const backgroundShell = (
  send: (type: string, data: Record<string, unknown>) => Effect.Effect<boolean>,
  shellId: string,
) =>
  Effect.gen(function* () {
    yield* send("session.tool.input.started", {
      sessionID: ROOT,
      assistantMessageID: "msg_a",
      id: `call_${shellId}`,
      name: "shell",
    });
    yield* send("session.tool.called", {
      sessionID: ROOT,
      assistantMessageID: "msg_a",
      id: `call_${shellId}`,
      input: { command: "npm run dev" },
      executed: false,
    });
    yield* send("session.tool.success", {
      sessionID: ROOT,
      id: `call_${shellId}`,
      metadata: { status: "running", shellID: shellId },
    });
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

  it.live("ends Threadlines' instructions entry with the project's brief", () =>
    Effect.gen(function* () {
      const { adapter, calls, threadId, cwd } = yield* harness;
      const brief = "Use pnpm here. Never touch the generated folder.";
      yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        projectInstructions: brief,
      });
      const put = calls.find((call) => call.method === "instructions.put")?.input as
        | { readonly key: string; readonly value: string }
        | undefined;
      expect(put?.key).toBe("threadlines");
      expect(put?.value.endsWith(`\n\n${brief}`)).toBe(true);
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

  it.live("names a failed run by OpenCode's error type", () =>
    Effect.gen(function* () {
      const { adapter, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "go",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m1" });
      yield* send("session.execution.failed", {
        sessionID: ROOT,
        error: { type: "provider.rate-limit", message: "Too many requests, slow down." },
      });
      const completed = yield* next((event) => event.type === "turn.completed");
      expect(completed).toMatchObject({
        turnId: turn.turnId,
        payload: { state: "failed", failureCategory: "rate_limit" },
      });
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

  it.live("confirms a stopped thread only once OpenCode says its shells ended", () =>
    Effect.gen(function* () {
      // The shared server ends the shell a moment after the stop removes it.
      let shellReads = 0;
      const { adapter, calls, send, next, threadId, cwd } = yield* harnessWith({
        "shell.get": () => ({
          location: {},
          data: { status: ++shellReads === 1 ? "running" : "killed" },
        }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "serve" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* backgroundShell(send, "sh_1");
      yield* next((event) => event.type === "task.started");

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.confirmThreadStopped!(threadId, [])).toEqual({ confirmed: true });
      expect(shellReads).toBe(2);
      expect(calls.some((call) => call.method === "session.active")).toBe(true);
      // Proven once, nothing is left to ask about.
      expect(yield* adapter.confirmThreadStopped!(threadId, [])).toEqual({ confirmed: true });
      expect(shellReads).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("after a restart, asks the server what still runs before it confirms", () =>
    Effect.gen(function* () {
      // This process never ran the thread: what its last stop knew is gone.
      let active: Record<string, unknown> = { [ROOT]: { type: "running" } };
      let shells: Array<{ status: string }> = [{ status: "running" }];
      const { adapter, calls, threadId, cwd } = yield* harnessWith({
        "session.active": () => active,
        "session.list": (input: { parentID: string }) => ({
          data: input.parentID === ROOT ? [{ id: "ses_child" }] : [],
        }),
        "shell.list": () => ({ location: {}, data: shells }),
      });
      const known = [
        { sessionKey: threadId, resumeCursor: { schemaVersion: 1, sessionId: ROOT }, cwd },
      ];
      expect(yield* adapter.confirmThreadStopped!(threadId, known)).toEqual({
        confirmed: false,
        reason: "OpenCode still runs its work; OpenCode still runs 1 shell in its folder",
      });
      // Its child counts too.
      active = { ses_child: { type: "running" } };
      shells = [];
      expect(yield* adapter.confirmThreadStopped!(threadId, known)).toEqual({
        confirmed: false,
        reason: "OpenCode still runs its work",
      });
      active = {};
      expect(yield* adapter.confirmThreadStopped!(threadId, known)).toEqual({ confirmed: true });
      expect(
        calls.some(
          (call) =>
            call.method === "shell.list" &&
            (call.input as { location: { directory: string } }).location.directory === cwd,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("stops one background shell, and its end is reported once", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "serve" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m1" });
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_sh",
        name: "shell",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_sh",
        input: { command: "npm run dev" },
        executed: false,
      });
      yield* send("session.tool.success", {
        sessionID: ROOT,
        id: "call_sh",
        metadata: { status: "running", shellID: "sh_1" },
      });
      const started = yield* next((event) => event.type === "task.started");
      expect(started.payload).toMatchObject({ taskId: "sh_1", stoppable: true });

      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("sh_1"))).toBe(true);
      expect(calls.find((call) => call.method === "shell.remove")?.input).toMatchObject({
        id: "sh_1",
      });
      const stopped = yield* next((event) => event.type === "task.completed");
      expect(stopped.payload).toMatchObject({ taskId: "sh_1", status: "stopped" });
      // The shell's own exit that follows ends nothing a second time: up to
      // the turn's end, no other task.completed arrives.
      yield* send("shell.exited", { id: "sh_1", exit: 143 });
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      const later: Array<ProviderRuntimeEvent> = [];
      yield* next((event) => {
        later.push(event);
        return event.type === "turn.completed";
      });
      expect(later.some((event) => event.type === "task.completed")).toBe(false);
      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("sh_1"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("ends a background shell that was already gone when Stop came", () =>
    Effect.gen(function* () {
      // Its exit was lost (a dropped stream): removing it fails, and OpenCode
      // says it already exited cleanly.
      const { adapter, send, next, threadId, cwd } = yield* harnessWith({
        "shell.remove": () => Promise.reject(new Error("no such shell")),
        "shell.get": () => ({ location: {}, data: { status: "exited", exit: 0 } }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "serve" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* backgroundShell(send, "sh_gone");
      yield* next((event) => event.type === "task.started");

      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("sh_gone"))).toBe(
        true,
      );
      const ended = yield* next((event) => event.type === "task.completed");
      expect(ended.payload).toMatchObject({ taskId: "sh_gone", status: "completed" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("reports a stopped subagent's end once, and its own end still clears its asks", () =>
    Effect.gen(function* () {
      // The interrupt finds nothing running, so the stop ends the run itself;
      // the child's own end that arrives after must not end it again.
      const { adapter, send, next, threadId, cwd } = yield* harnessWith({
        "session.interrupt": () => ({ interrupted: false }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "delegate" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m1" });
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg",
        name: "subagent",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg",
        input: { agent: "general", description: "Audit deps", prompt: "Audit", background: true },
        executed: false,
      });
      yield* send("session.created", { sessionID: "ses_bg", parentID: ROOT, agent: "general" });
      yield* send("session.tool.progress", {
        sessionID: ROOT,
        id: "call_bg",
        metadata: { sessionID: "ses_bg", status: "running" },
      });
      yield* next((event) => event.type === "task.started");

      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("ses_bg"))).toBe(true);
      const stopped = yield* next((event) => event.type === "task.completed");
      expect(stopped.payload).toMatchObject({ taskId: "ses_bg", status: "stopped" });
      // An ask the child had already sent lands after the Stop ended its run.
      yield* send("permission.asked", {
        id: "per_late",
        sessionID: "ses_bg",
        action: "shell",
        resources: ["npm audit"],
        save: [],
        source: { type: "tool", messageID: "msg_c", id: "call_late" },
      });
      const asked = yield* next((event) => event.type === "request.opened");
      yield* send("session.execution.succeeded", { sessionID: "ses_bg" });
      yield* next(
        (event) => event.type === "request.resolved" && event.requestId === asked.requestId,
      );
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      const later: Array<ProviderRuntimeEvent> = [];
      yield* next((event) => {
        later.push(event);
        return event.type === "turn.completed";
      });
      expect(later.some((event) => event.type === "task.completed")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("stops one background subagent without stopping the agent", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "delegate" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg",
        name: "subagent",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg",
        input: { agent: "general", description: "Audit deps", prompt: "Audit", background: true },
        executed: false,
      });
      yield* send("session.created", { sessionID: "ses_bg", parentID: ROOT, agent: "general" });
      yield* send("session.tool.progress", {
        sessionID: ROOT,
        id: "call_bg",
        metadata: { sessionID: "ses_bg", status: "running" },
      });
      const started = yield* next((event) => event.type === "task.started");
      expect(started.payload).toMatchObject({ taskId: "ses_bg", stoppable: true });

      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("ses_bg"))).toBe(true);
      const interrupts = calls
        .filter((call) => call.method === "session.interrupt")
        .map((call) => (call.input as { sessionID: string }).sessionID);
      expect(interrupts).toEqual(["ses_bg"]);
      yield* send("session.execution.interrupted", { sessionID: "ses_bg" });
      const stopped = yield* next((event) => event.type === "task.completed");
      expect(stopped.payload).toMatchObject({ taskId: "ses_bg", status: "stopped" });
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

  it.live("keeps tracking unconfirmed background shells across restart and ServerGone", () =>
    Effect.gen(function* () {
      let shellRunning = true;
      const { adapter, signals, send, next, threadId, cwd } = yield* harnessWith({
        "shell.get": () => ({
          location: {},
          data: { status: shellRunning ? "running" : "killed" },
        }),
        "shell.list": () => ({
          location: {},
          data: shellRunning ? [{ status: "running" }] : [],
        }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "serve" });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* backgroundShell(send, "sh_1");
      yield* next((event) => event.type === "task.started");

      // Stop leaves sh_1 unconfirmed; restarting and cleanly stopping must not drop it.
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.stopSession(threadId);

      // Even after ServerGone drops the stale generation's client, confirmThreadStopped
      // falls back to querying the server instead of trusting ranHere.
      yield* PubSub.publish(signals, {
        _tag: "ServerGone",
        generation: 1,
        unexpected: false,
        detail: "disconnected",
      });
      yield* Effect.sleep(Duration.millis(20));

      const known = [
        { sessionKey: threadId, resumeCursor: { schemaVersion: 1, sessionId: ROOT }, cwd },
      ];
      expect(yield* adapter.confirmThreadStopped!(threadId, known)).toEqual({
        confirmed: false,
        reason: "OpenCode still runs 1 shell in its folder",
      });

      shellRunning = false;
      expect(yield* adapter.confirmThreadStopped!(threadId, known)).toEqual({ confirmed: true });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "does not duplicate text when a queued text.ended frame arrives after reconnect resync",
    () =>
      Effect.gen(function* () {
        const now = Date.now();
        const { adapter, signals, events, send, next, threadId, cwd } = yield* harnessWith({
          "session.active": () => ({}),
          "message.list": () => ({
            data: [
              { type: "idle", outcome: "succeeded", time: { created: now + 1000 } },
              {
                id: "msg_1",
                type: "assistant",
                time: { created: now + 500, completed: now + 900 },
                content: [{ type: "text", text: "Hello once" }],
              },
            ],
            cursor: {},
          }),
        });
        yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "hi" });
        yield* send("session.execution.started", { sessionID: ROOT });
        yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m1" });

        yield* PubSub.publish(signals, { _tag: "StreamOpened", generation: 1 });
        const itemCompleted = yield* next(
          (event) => event.type === "item.completed" && event.itemId === "msg_1:text:0",
        );
        expect(itemCompleted.payload).toMatchObject({
          itemType: "assistant_message",
          detail: "Hello once",
        });
        const completed = yield* next((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });

        // Drain any prior events, then replay a queued text.ended for the same block.
        yield* Effect.sleep(Duration.millis(20));
        yield* Queue.clear(events);
        yield* send("session.text.ended", {
          sessionID: ROOT,
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: "Hello once",
        });
        yield* Effect.sleep(Duration.millis(30));
        const extra = yield* Queue.clear(events);
        expect(extra.filter((event) => event.type === "item.completed")).toHaveLength(0);
        expect(extra.filter((event) => event.type === "content.delta")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "shares one session.active call on reconnect and skips resync HTTP work for idle sessions",
    () =>
      Effect.gen(function* () {
        let createdCount = 0;
        const { adapter, calls, signals, cwd } = yield* harnessWith({
          "session.create": () => ({ id: `ses_reconnect_${++createdCount}` }),
          "session.active": () => ({}),
        });
        const idleThreadA = ThreadId.make("thread-idle-a");
        const idleThreadB = ThreadId.make("thread-idle-b");
        yield* adapter.startSession({ threadId: idleThreadA, cwd, runtimeMode: "full-access" });
        yield* adapter.startSession({ threadId: idleThreadB, cwd, runtimeMode: "full-access" });
        calls.length = 0;

        yield* PubSub.publish(signals, { _tag: "StreamOpened", generation: 1 });
        yield* Effect.sleep(Duration.millis(50));

        expect(calls.filter((call) => call.method === "session.active")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "session.list")).toHaveLength(0);
        expect(calls.filter((call) => call.method === "permission.list")).toHaveLength(0);
        expect(calls.filter((call) => call.method === "form.list")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("marks resumeFailed on missing sessions and fails startSession on transient errors", () =>
    Effect.gen(function* () {
      const notFound = yield* harnessWith({
        "session.get": () =>
          Promise.reject({ _tag: "SessionNotFoundError", message: "session missing" }),
      });
      const fallback = yield* notFound.adapter.startSession({
        threadId: notFound.threadId,
        cwd: notFound.cwd,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_gone" },
      });
      expect(fallback.resumeFailed).toBe(true);
      expect(fallback.providerThreadId).toBe(ROOT);

      // An unparseable cursor also reports resumeFailed on fallback and rejects when required.
      const invalidCursor = yield* notFound.adapter.startSession({
        threadId: ThreadId.make("thread-bad-cursor"),
        cwd: notFound.cwd,
        runtimeMode: "full-access",
        resumeCursor: { legacy: true },
      });
      expect(invalidCursor.resumeFailed).toBe(true);

      const requiredErr = yield* notFound.adapter
        .startSession({
          threadId: ThreadId.make("thread-bad-required"),
          cwd: notFound.cwd,
          runtimeMode: "full-access",
          resumeCursor: { legacy: true },
          resumePolicy: "required",
        })
        .pipe(Effect.flip);
      expect(requiredErr.message).toContain("cannot resume");

      // A transient error must not silently wipe the conversation and create a blank session.
      const transient = yield* harnessWith({
        "session.get": () => Promise.reject(new Error("connect ECONNREFUSED")),
      });
      const transientErr = yield* transient.adapter
        .startSession({
          threadId: transient.threadId,
          cwd: transient.cwd,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_alive" },
        })
        .pipe(Effect.flip);
      expect(transientErr.message).toContain("ECONNREFUSED");
      expect(transient.calls.some((call) => call.method === "session.create")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("applies the resumed agent's rules and keeps a custom primary agent on turns", () =>
    Effect.gen(function* () {
      let resumedDir = "";
      const { adapter, calls, threadId, cwd } = yield* harnessWith({
        "agent.list": () => ({
          data: [
            {
              id: "build",
              mode: "primary",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
            {
              id: "coder",
              mode: "primary",
              permissions: [
                { action: "*", resource: "*", effect: "allow" },
                { action: "shell", resource: "git push*", effect: "deny" },
              ],
            },
          ],
        }),
        "session.get": () => ({
          id: ROOT,
          agent: "coder",
          location: { directory: resumedDir },
        }),
      });
      resumedDir = cwd;
      yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: ROOT },
      });
      const initialUpdate = calls.find((call) => call.method === "session.update")?.input as
        | {
            readonly permissions: ReadonlyArray<{
              action: string;
              resource: string;
              effect: string;
            }>;
          }
        | undefined;
      expect(initialUpdate?.permissions).toContainEqual({
        action: "shell",
        resource: "git push*",
        effect: "deny",
      });

      // Sending a normal turn stays on the resumed custom agent rather than clobbering it with `build`.
      yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "check status",
      });
      expect(calls.some((call) => call.method === "session.switchAgent")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("returns undelivered on failed sends and contextDeferred on typed slash commands", () =>
    Effect.gen(function* () {
      let failPrompt = true;
      const { adapter, calls, send, next, threadId, cwd } = yield* harnessWith({
        "command.list": () => ({ data: [{ name: "review" }] }),
        "session.prompt": (input) =>
          failPrompt ? Promise.reject(new Error("model quota exceeded")) : { id: input.id },
      });
      yield* adapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
        contextSeed: {
          version: 1,
          fromProvider: "claudeAgent" as never,
          entries: [{ kind: "message", role: "user", text: "Earlier context" }],
        },
      });

      const failed = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "hi",
      });
      expect(failed.undelivered).toBe(true);
      const failedEvent = yield* next((event) => event.type === "turn.completed");
      expect(failedEvent.payload).toMatchObject({
        state: "failed",
        errorMessage: "OpenCode did not accept the message: model quota exceeded",
      });

      // Slash command with server-prepended context runs as a command and defers context.
      const cmd = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m2"),
        input: "Room catch-up\n\n/review src/index.ts",
        typed: { text: "/review src/index.ts", context: "Room catch-up" },
      });
      expect(cmd.contextDeferred).toBe(true);
      expect(calls.find((call) => call.method === "session.command")?.input).toMatchObject({
        name: "review",
        text: "src/index.ts",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.execution.succeeded", { sessionID: ROOT });
      yield* next((event) => event.type === "turn.completed" && event.turnId === cmd.turnId);

      // Pending seed is still delivered on the first successful regular prompt.
      failPrompt = false;
      const ok = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m3"),
        input: "now continue",
      });
      expect(ok.undelivered).toBeUndefined();
      expect(ok.contextDeferred).toBeUndefined();
      const promptCall = calls.findLast((call) => call.method === "session.prompt")?.input as {
        readonly text: string;
      };
      expect(promptCall.text).toContain("Earlier context");
      expect(promptCall.text).toContain("now continue");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("forwards skills on steerTurn", () =>
    Effect.gen(function* () {
      const { adapter, calls, send, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m1"),
        input: "start",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* adapter.steerTurn({
        threadId,
        expectedTurnId: turn.turnId,
        messageId: MessageId.make("m2"),
        input: "use this skill",
        skills: [{ name: "my-skill", path: "/skills/my-skill/SKILL.md" }],
      });
      expect(calls.findLast((call) => call.method === "session.prompt")?.input).toMatchObject({
        id: "msg_tl_m2",
        skills: [{ id: "my-skill" }],
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("backfills running tool inputs, declined tools, and compaction token usage", () =>
    Effect.gen(function* () {
      const now = Date.now();
      const { adapter, signals, send, next, threadId, cwd } = yield* harnessWith({
        "session.active": () => ({ [ROOT]: { type: "running" } }),
        "message.list": () => ({
          data: [
            {
              id: "msg_2",
              type: "assistant",
              time: { created: now + 500 },
              content: [
                {
                  type: "tool",
                  id: "call_running",
                  name: "shell",
                  state: { status: "running", input: { command: "pnpm test" } },
                },
                {
                  type: "tool",
                  id: "call_declined",
                  name: "edit",
                  state: {
                    status: "error",
                    input: { path: "README.md" },
                    error: { type: "permission.rejected", message: "User declined" },
                  },
                },
              ],
            },
          ],
          cursor: {},
        }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m1"), input: "work" });
      yield* send("session.execution.started", { sessionID: ROOT });

      yield* PubSub.publish(signals, { _tag: "StreamOpened", generation: 1 });
      const runningUpdated = yield* next(
        (event) => event.type === "item.updated" && event.itemId === "call_running",
      );
      expect(runningUpdated.payload).toMatchObject({
        itemType: "command_execution",
        detail: "pnpm test",
      });
      const declinedCompleted = yield* next(
        (event) => event.type === "item.completed" && event.itemId === "call_declined",
      );
      expect(declinedCompleted.payload).toMatchObject({
        itemType: "file_change",
        status: "declined",
      });

      // Compaction updates token usage when OpenCode includes post-compaction tokens.
      yield* send("session.compaction.started", { sessionID: ROOT, reason: "auto" });
      yield* send("session.compaction.ended", {
        sessionID: ROOT,
        reason: "auto",
        tokens: { input: 1200, output: 300, cache: { read: 500 } },
      });
      const usageEvent = yield* next((event) => event.type === "thread.token-usage.updated");
      expect(usageEvent.payload).toMatchObject({
        usage: { usedTokens: 2000, lastInputTokens: 1200, lastCachedInputTokens: 500 },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("skips loopback MCP registration for remote external servers and warns gracefully", () =>
    Effect.gen(function* () {
      const remote = yield* harnessWith(
        {},
        { serverUrl: "http://192.168.1.50:4096", external: true },
      );
      const session = yield* remote.adapter.startSession({
        threadId: remote.threadId,
        cwd: "/remote/only/project",
        runtimeMode: "full-access",
        roomTools: true,
      });
      expect(session.cwd).toBe("/remote/only/project");
      expect(session.roomTools).toBe(false);
      expect(remote.calls.some((call) => call.method === "mcp.add")).toBe(false);
      const warning = yield* remote.next((event) => event.type === "runtime.warning");
      expect(warning.payload).toMatchObject({ message: expect.stringContaining("remote") });

      // External loopback server where mcp.add fails degrades with a warning instead of failing.
      const externalLoopback = yield* harnessWith(
        { "mcp.add": () => Promise.reject(new Error("connection refused")) },
        { serverUrl: "http://127.0.0.1:4096", external: true },
      );
      const degraded = yield* externalLoopback.adapter.startSession({
        threadId: ThreadId.make("thread-ext-loopback"),
        cwd: externalLoopback.cwd,
        runtimeMode: "full-access",
        roomTools: true,
      });
      expect(degraded.roomTools).toBe(false);
      const degradedWarning = yield* externalLoopback.next(
        (event) => event.type === "runtime.warning",
      );
      expect(degradedWarning.payload).toMatchObject({
        message: expect.stringContaining("continuing without them"),
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("fails startup when the agent catalog cannot be loaded", () =>
    Effect.gen(function* () {
      const { adapter, threadId, cwd } = yield* harnessWith({
        "agent.list": () => Promise.reject(new Error("catalog unavailable")),
      });
      const err = yield* adapter
        .startSession({
          threadId,
          cwd,
          runtimeMode: "auto-accept-edits",
        })
        .pipe(Effect.flip);
      expect(err.message).toContain("catalog unavailable");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("keeps large file attachment notes when running a typed slash command", () =>
    Effect.gen(function* () {
      const { adapter, calls, threadId, cwd } = yield* harnessWith({
        "command.list": () => ({ data: [{ name: "review" }] }),
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const cmd = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("m-attach"),
        input: "Room catch-up\n\n/review check this",
        typed: { text: "/review check this", context: "Room catch-up" },
        attachments: [
          {
            type: "file",
            id: "att-large.patch",
            name: "big.patch",
            mimeType: "application/octet-stream",
            sizeBytes: 1024,
            kind: "other",
          },
        ],
      });
      expect(cmd.contextDeferred).toBe(true);
      const commandCall = calls.find((call) => call.method === "session.command")?.input as {
        readonly name: string;
        readonly text: string;
      };
      expect(commandCall.name).toBe("review");
      expect(commandCall.text).toContain("check this");
      expect(commandCall.text).toContain("big.patch");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("emits turn.proposed.completed for plan turns from plan file or final text", () =>
    Effect.gen(function* () {
      const { adapter, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });

      // Turn 1: plan agent writes `.opencode/plans/refactor.md` and prints a short summary.
      const planDir = join(cwd, ".opencode", "plans");
      mkdirSync(planDir, { recursive: true });
      const planFile = join(planDir, "refactor.md");
      writeFileSync(planFile, "# Refactor plan\n\n1. Extract parser\n2. Add tests\n");

      const turn1 = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("plan-1"),
        input: "plan this refactor",
        interactionMode: "plan",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_plan-1" });
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_p1",
        id: "call_plan_write",
        name: "write",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_p1",
        id: "call_plan_write",
        input: { filePath: ".opencode/plans/refactor.md" },
      });
      yield* send("session.tool.success", {
        sessionID: ROOT,
        id: "call_plan_write",
      });
      yield* send("session.text.delta", {
        sessionID: ROOT,
        assistantMessageID: "msg_p1",
        ordinal: 0,
        delta: "Wrote the plan to .opencode/plans/refactor.md.",
      });
      yield* send("session.text.ended", {
        sessionID: ROOT,
        assistantMessageID: "msg_p1",
        ordinal: 0,
        text: "Wrote the plan to .opencode/plans/refactor.md.",
      });
      yield* send("session.execution.succeeded", { sessionID: ROOT });

      const proposed1 = yield* next((event) => event.type === "turn.proposed.completed");
      expect(proposed1).toMatchObject({
        turnId: turn1.turnId,
        payload: { planMarkdown: "# Refactor plan\n\n1. Extract parser\n2. Add tests" },
      });
      yield* next((event) => event.type === "turn.completed" && event.turnId === turn1.turnId);

      // Turn 2: plan agent replies inline without writing a file.
      const turn2 = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("plan-2"),
        input: "plan step 2",
        interactionMode: "plan",
      });
      yield* send("session.execution.started", { sessionID: ROOT });
      yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_plan-2" });
      yield* send("session.text.delta", {
        sessionID: ROOT,
        assistantMessageID: "msg_p2",
        ordinal: 0,
        delta: "## Inline plan\n- Update routes",
      });
      yield* send("session.execution.succeeded", { sessionID: ROOT });

      const proposed2 = yield* next((event) => event.type === "turn.proposed.completed");
      expect(proposed2).toMatchObject({
        turnId: turn2.turnId,
        payload: { planMarkdown: "## Inline plan\n- Update routes" },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("reads live command output for in-flight and background shells", () =>
    Effect.gen(function* () {
      let outputText = "compiling...\n";
      const { adapter, send, next, threadId, cwd } = yield* harnessWith({
        "shell.output": (input: { id: string }) => {
          if (input.id === "sh_gone") {
            return Promise.reject({ _tag: "ShellNotFoundError", message: "missing" });
          }
          return {
            location: {},
            data: {
              output: outputText,
              cursor: outputText.length,
              size: outputText.length,
              truncated: false,
            },
          };
        },
      });
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m-out"), input: "build" });
      yield* send("session.execution.started", { sessionID: ROOT });

      // Unknown tool call is unavailable.
      expect(yield* adapter.readCommandOutput!(threadId, "call_unknown")).toEqual({
        status: "unavailable",
      });

      // Started shell before shellID arrives is pending.
      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_s",
        id: "call_sh_live",
        name: "shell",
      });
      yield* next((event) => event.type === "item.started" && event.itemId === "call_sh_live");
      expect(yield* adapter.readCommandOutput!(threadId, "call_sh_live")).toEqual({
        status: "pending",
      });

      // Once shellID arrives on progress, live output streams from shell.output.
      yield* send("session.tool.progress", {
        sessionID: ROOT,
        id: "call_sh_live",
        metadata: { shellID: "sh_live" },
      });
      yield* Effect.sleep(Duration.millis(20));
      expect(yield* adapter.readCommandOutput!(threadId, "call_sh_live")).toEqual({
        status: "running",
        output: "compiling...\n",
        totalBytes: 13,
      });

      // Backgrounded shell stays readable even after the tool call finishes.
      outputText = "listening on :3000\n";
      yield* send("session.tool.success", {
        sessionID: ROOT,
        id: "call_sh_live",
        metadata: { status: "running", shellID: "sh_live" },
      });
      yield* next((event) => event.type === "task.started");
      expect(yield* adapter.readCommandOutput!(threadId, "call_sh_live")).toEqual({
        status: "running",
        output: "listening on :3000\n",
        totalBytes: 19,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("releases background commands without releasing background subagents", () =>
    Effect.gen(function* () {
      const { adapter, send, next, threadId, cwd } = yield* harness;
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m-bg"), input: "run both" });
      yield* send("session.execution.started", { sessionID: ROOT });

      yield* backgroundShell(send, "sh_dev");
      yield* next((event) => event.type === "task.snapshot.updated");

      yield* send("session.tool.input.started", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg_agent",
        name: "subagent",
      });
      yield* send("session.tool.called", {
        sessionID: ROOT,
        assistantMessageID: "msg_a",
        id: "call_bg_agent",
        input: { background: true, description: "Audit deps" },
      });
      yield* send("session.created", {
        sessionID: "ses_bg_child",
        parentID: ROOT,
        agent: "general",
        title: "Audit deps",
      });
      yield* send("session.tool.progress", {
        sessionID: ROOT,
        id: "call_bg_agent",
        metadata: { sessionID: "ses_bg_child" },
      });
      yield* next(
        (event) =>
          event.type === "task.snapshot.updated" &&
          event.payload.tasks.some((task) => task.taskId === "ses_bg_child"),
      );

      yield* adapter.releaseBackgroundCommands!(threadId);
      const snapshot = yield* next(
        (event) =>
          event.type === "task.snapshot.updated" &&
          event.payload.tasks.some((task) => task.taskId === "sh_dev" && task.awaited === false),
      );
      if (snapshot.type !== "task.snapshot.updated") throw new Error("expected task snapshot");
      const shellTask = snapshot.payload.tasks.find((task) => task.taskId === "sh_dev");
      const agentTask = snapshot.payload.tasks.find((task) => task.taskId === "ses_bg_child");
      expect(shellTask).toMatchObject({ kind: "command", awaited: false });
      expect(agentTask).toMatchObject({ kind: "agent" });
      expect(agentTask?.awaited).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "reloads extensions, invalidates caches on SSE events, and publishes session commands",
    () =>
      Effect.gen(function* () {
        let commandList = [{ name: "review", description: "Review diff" }];
        let mcpList = [{ name: "linear" }];
        const publishedCommands: Array<{
          readonly sessionKey: string;
          readonly commands: ReadonlyArray<ServerProviderSlashCommand> | undefined;
        }> = [];
        let catalogChangeCount = 0;

        const { adapter, calls, send, threadId, cwd } = yield* harnessWith(
          {
            "command.list": () => ({ data: commandList }),
            "mcp.list": () => ({ data: mcpList }),
            "message.list": () => ({
              data: [
                {
                  id: "msg_c1",
                  type: "assistant",
                  content: [
                    {
                      type: "tool",
                      id: "call_mcp",
                      name: "linear_list_issues",
                      state: { status: "completed", input: { team: "ENG" } },
                    },
                  ],
                },
              ],
              cursor: {},
            }),
          },
          {
            onSessionCommands: (sessionKey, commands) =>
              Effect.sync(() => {
                publishedCommands.push({ sessionKey, commands });
              }),
            onCatalogChanged: Effect.sync(() => {
              catalogChangeCount += 1;
            }),
          },
        );

        yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
        expect(publishedCommands.at(-1)).toEqual({
          sessionKey: threadId,
          commands: [{ name: "review", description: "Review diff" }],
        });

        // Live `command.updated` refreshes session commands and notifies catalog change.
        commandList = [
          { name: "review", description: "Review diff" },
          { name: "deploy", description: "Deploy app" },
        ];
        yield* send("command.updated", {});
        yield* Effect.sleep(Duration.millis(40));
        expect(publishedCommands.at(-1)).toEqual({
          sessionKey: threadId,
          commands: [
            { name: "review", description: "Review diff" },
            { name: "deploy", description: "Deploy app" },
          ],
        });
        expect(catalogChangeCount).toBeGreaterThanOrEqual(1);

        // `noteExtensionsChanged` reloads the running OpenCode server and refreshes commands.
        commandList = [{ name: "fresh", description: "Fresh command" }];
        yield* adapter.noteExtensionsChanged!();
        expect(calls.some((call) => call.method === "location.reload")).toBe(true);
        expect(publishedCommands.at(-1)).toEqual({
          sessionKey: threadId,
          commands: [{ name: "fresh", description: "Fresh command" }],
        });

        // Subagent transcript uses cached MCP server names when summarizing MCP tools.
        yield* send("session.created", {
          sessionID: "ses_mcp_child",
          parentID: ROOT,
          agent: "general",
          title: "Check Linear",
        });
        yield* Effect.sleep(Duration.millis(20));
        const transcript = yield* adapter.readSubagentTranscript!(threadId, {
          threadId,
          agentId: "ses_mcp_child",
        });
        expect(transcript.entries[0]?.toolUses[0]?.summary).toContain("linear");

        // Stopping the session clears its published commands.
        yield* adapter.stopSession(threadId);
        expect(publishedCommands.at(-1)).toEqual({
          sessionKey: threadId,
          commands: undefined,
        });

        // Idle server: noteExtensionsChanged does not call location.reload.
        const idle = yield* harnessWith({}, { isRunning: false });
        yield* idle.adapter.noteExtensionsChanged!();
        expect(idle.calls.some((call) => call.method === "location.reload")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "emits runtime.error on failed turns and attaches usageLimit on rate-limit failures",
    () =>
      Effect.gen(function* () {
        const { adapter, send, next, threadId, cwd } = yield* harnessWith(
          {},
          {
            readUsageLimit: Effect.succeed({
              window: "session",
              resetsAt: "2026-05-01T15:00:00.000Z",
            }),
          },
        );
        yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });

        // Auth error emits `authentication_error` runtime.error after `turn.completed`.
        yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m-auth"), input: "hi" });
        yield* send("session.execution.started", { sessionID: ROOT });
        yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m-auth" });
        yield* send("session.execution.failed", {
          sessionID: ROOT,
          error: { type: "provider.auth", message: "Invalid API key" },
        });
        const authDone = yield* next((event) => event.type === "turn.completed");
        expect(authDone.payload).toMatchObject({ state: "failed", failureCategory: "auth" });
        const authRuntimeError = yield* next((event) => event.type === "runtime.error");
        expect(authRuntimeError.payload).toMatchObject({
          class: "authentication_error",
          failureCategory: "auth",
          message: expect.stringContaining("Invalid API key"),
        });

        // Rate-limit failure attaches `usageLimit` for Continue at reset.
        yield* adapter.sendTurn({ threadId, messageId: MessageId.make("m-rl"), input: "hi again" });
        yield* send("session.execution.started", { sessionID: ROOT });
        yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m-rl" });
        yield* send("session.execution.failed", {
          sessionID: ROOT,
          error: { type: "provider.rate-limit", message: "Go rolling limit reached" },
        });
        const rlDone = yield* next((event) => event.type === "turn.completed");
        expect(rlDone.payload).toMatchObject({
          state: "failed",
          failureCategory: "rate_limit",
          usageLimit: {
            window: "session",
            resetsAt: "2026-05-01T15:00:00.000Z",
          },
        });
        const rlRuntimeError = yield* next((event) => event.type === "runtime.error");
        expect(rlRuntimeError.payload).toMatchObject({
          class: "provider_error",
          failureCategory: "rate_limit",
        });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live(
    "reads remote plan files through client.file.read and reconciles shells on reconnect",
    () =>
      Effect.gen(function* () {
        let shellStatus = "running";
        const { adapter, send, next, signals, threadId, cwd } = yield* harnessWith(
          {
            "file.read": (input: { path: string }) =>
              input.path === ".opencode/plans/remote.md"
                ? new TextEncoder().encode("# Remote Plan\n\nShip it.")
                : Promise.reject(new Error("not found")),
            "shell.get": () => ({ location: {}, data: { status: shellStatus, exit: 0 } }),
          },
          { serverUrl: "http://192.168.1.50:4096", external: true },
        );

        // Put a decoy local file at the same path to prove an external server reads via client.file.read.
        const planDir = join(cwd, ".opencode", "plans");
        mkdirSync(planDir, { recursive: true });
        writeFileSync(join(planDir, "remote.md"), "# Wrong Local Plan");

        yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("m-rem-plan"),
          input: "plan remotely",
          interactionMode: "plan",
        });
        yield* send("session.execution.started", { sessionID: ROOT });
        yield* send("session.inbox.delivered", { sessionID: ROOT, inboxID: "msg_tl_m-rem-plan" });
        yield* send("session.tool.input.started", {
          sessionID: ROOT,
          assistantMessageID: "msg_rp",
          id: "call_rp",
          name: "write",
        });
        yield* send("session.tool.called", {
          sessionID: ROOT,
          assistantMessageID: "msg_rp",
          id: "call_rp",
          input: { filePath: ".opencode/plans/remote.md" },
        });
        yield* send("session.tool.success", { sessionID: ROOT, id: "call_rp" });
        yield* send("session.execution.succeeded", { sessionID: ROOT });

        const proposed = yield* next((event) => event.type === "turn.proposed.completed");
        expect(proposed.payload).toEqual({ planMarkdown: "# Remote Plan\n\nShip it." });
        yield* next((event) => event.type === "turn.completed");

        // Background shell exits while SSE is disconnected; resync reconciles and clears the snapshot.
        yield* adapter.sendTurn({
          threadId,
          messageId: MessageId.make("m-bg-reconcile"),
          input: "serve",
        });
        yield* send("session.execution.started", { sessionID: ROOT });
        yield* send("session.inbox.delivered", {
          sessionID: ROOT,
          inboxID: "msg_tl_m-bg-reconcile",
        });
        yield* backgroundShell(send, "sh_recon");
        yield* next((event) => event.type === "task.snapshot.updated");
        yield* send("session.execution.succeeded", { sessionID: ROOT });
        yield* next((event) => event.type === "turn.completed");

        shellStatus = "exited";
        yield* PubSub.publish(signals, { _tag: "StreamOpened", generation: 1 });
        const completedTask = yield* next(
          (event) => event.type === "task.completed" && event.payload.taskId === "sh_recon",
        );
        expect(completedTask.payload).toMatchObject({ status: "completed" });
        const emptySnapshot = yield* next(
          (event) => event.type === "task.snapshot.updated" && event.payload.tasks.length === 0,
        );
        expect(emptySnapshot.payload).toEqual({ tasks: [] });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
