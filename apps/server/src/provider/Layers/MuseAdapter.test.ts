/**
 * The Muse adapter against scripted `muse serve` hosts: every request and
 * command is recorded, and the test plays the host's notifications (shapes
 * from Muse Code 1.4.9 and the published MSP schema) and checks the runtime
 * events that come out.
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
  type RuntimeMode,
  ThreadId,
  RuntimeTaskId,
} from "@threadlines/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { steerRejectionOf } from "../Errors.ts";
import {
  type MuseHost,
  MuseHostError,
  type MuseHostExit,
  type MuseHostOptions,
  type MuseNotification,
  type MuseServerRequest,
} from "../muse/MuseHost.ts";
import { makeMuseAdapter } from "./MuseAdapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("muse");
const SESSION = "01a14000-0000-7000-8000-000000000001";

interface Call {
  readonly kind: "request" | "command";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface FakeHost {
  readonly options: MuseHostOptions;
  readonly calls: Array<Call>;
  readonly notify: (method: string, params: Record<string, unknown>) => Effect.Effect<void>;
  readonly serverRequest: (method: string, params: Record<string, unknown>) => Effect.Effect<void>;
  readonly exit: (exit: MuseHostExit) => Effect.Effect<void>;
  /** Whether the adapter has closed (or the test has ended) this host. */
  readonly closed: Effect.Effect<boolean>;
}

/** Scripts a host's answer: a result, an error, or `undefined` for the default. */
type Responder = (call: Call) => Record<string, unknown> | MuseHostError | undefined;

/** A scripted host factory: each host the adapter starts is recorded in `hosts`. */
function scriptedHosts(responder: Responder = () => undefined) {
  const hosts: Array<FakeHost> = [];
  let commandIds = 0;
  const startHost = (options: MuseHostOptions) =>
    Effect.gen(function* () {
      const notifications = yield* Queue.unbounded<MuseNotification>();
      const serverRequests = yield* Queue.unbounded<MuseServerRequest>();
      const exited = yield* Deferred.make<MuseHostExit>();
      const calls: Array<Call> = [];
      const answer = (call: Call): Effect.Effect<Record<string, unknown>, MuseHostError> => {
        calls.push(call);
        const scripted = responder(call);
        if (scripted instanceof MuseHostError) return Effect.fail(scripted);
        return Effect.succeed(scripted ?? defaultAnswer(call));
      };
      const defaultAnswer = (call: Call): Record<string, unknown> => {
        switch (call.method) {
          case "session/start":
          case "session/resume":
            return {
              session: {
                sessionId: (call.params.sessionId as string | undefined) ?? SESSION,
                approvalMode: { mode: call.params.approvalMode ?? "promptUnmatched" },
                permissionState: { profileId: call.params.permissionProfile },
              },
              viewCursor: "v4:1",
              history: { mode: "none", noneReason: "excluded", items: null },
              pendingRequests: [],
            };
          case "turn/start":
            return { turnId: call.params.commandId, disposition: "started", status: "accepted" };
          case "approval/decide":
            return { status: "accepted", terminal: true };
          case "account/read":
            return { state: "accountLogin", credentialRequired: true };
          default:
            return {};
        }
      };
      yield* Effect.addFinalizer(() => Deferred.succeed(exited, { kind: "clean" }));
      const host: MuseHost = {
        initialize: {
          serverVersion: "1.4.9",
          grantedCapabilities: ["sessionMcp"],
          experimentalApi: true,
          museHome: "/tmp/muse",
          platformOs: "macos",
          sandboxAvailability: "available",
          sessionDurability: "durable",
        },
        request: (method, params) =>
          Effect.suspend(() => answer({ kind: "request", method, params: params ?? {} })),
        command: (method, params, commandOptions) =>
          Effect.suspend(() =>
            answer({
              kind: "command",
              method,
              params: { ...params, commandId: commandOptions?.commandId ?? `cmd-${++commandIds}` },
            }),
          ),
        mintCommandId: () => `01a14000-0000-7000-8000-${String(++commandIds).padStart(12, "0")}`,
        notifications: Stream.fromQueue(notifications),
        serverRequests: Stream.fromQueue(serverRequests),
        exited: Deferred.await(exited),
        hasExited: Deferred.isDone(exited),
        stderrTail: () => "",
      };
      hosts.push({
        options,
        calls,
        notify: (method, params) =>
          Queue.offer(notifications, { method, params }).pipe(Effect.asVoid),
        serverRequest: (method, params) =>
          Queue.offer(serverRequests, { method, params }).pipe(Effect.asVoid),
        exit: (exit) => Deferred.succeed(exited, exit).pipe(Effect.asVoid),
        closed: Deferred.isDone(exited),
      });
      return host;
    });
  return { hosts, startHost: startHost as never };
}

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "muse-adapter-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "threadlines-muse-test-")));

const setup = (
  input: {
    readonly responder?: Responder;
    readonly allowApiKeyBilling?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const scripted = scriptedHosts(input.responder);
    const adapter = yield* makeMuseAdapter({
      instanceId: INSTANCE_ID,
      settings: {
        enabled: true,
        binaryPath: "muse",
        allowApiKeyBilling: input.allowApiKeyBilling ?? false,
        customModels: [],
      },
      binaryPath: () => "muse",
      environment: {},
      instanceEnvironment: undefined,
      readContributorMode: Effect.succeed(false),
      sandboxAvailable: () => true,
      models: () => [],
      onSubscriptionUsage: () => Effect.void,
      onAccountChanged: Effect.void,
      startHost: scripted.startHost,
    });
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const nextEvent = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(events);
          if (predicate(event)) return event;
        }
      }).pipe(Effect.timeout(Duration.seconds(5)));
    const threadId = ThreadId.make("muse-thread");
    const start = (runtimeMode: RuntimeMode = "approval-required", cwd = workspace()) =>
      adapter.startSession({ threadId, cwd, runtimeMode }).pipe(Effect.as(cwd));
    const send = (text: string, interactionMode?: "plan") =>
      adapter.sendTurn({
        threadId,
        messageId: MessageId.make(`message-${text}`),
        input: text,
        ...(interactionMode ? { interactionMode } : {}),
      });
    return { ...scripted, adapter, events, nextEvent, threadId, start, send };
  });

const shellApproval = (input: {
  readonly approvalId: string;
  readonly turnId: string;
  readonly sourceIndex?: number;
  readonly choices?: ReadonlyArray<Record<string, unknown>>;
}) => ({
  approvalId: input.approvalId,
  sessionId: SESSION,
  turnId: input.turnId,
  itemId: "item-shell",
  toolName: "shell",
  rawArgs: '{"command":"rm -rf build"}',
  protectedWrite: false,
  judgeEscalated: false,
  currentRequirementId: { approvalId: input.approvalId, sourceIndex: input.sourceIndex ?? 0 },
  availableChoices: input.choices ?? [
    { choiceId: "c-once", decision: "approved", label: "Allow", scope: "once" },
    {
      choiceId: "c-session",
      decision: "approvedForSession",
      label: "Always this session",
      scope: "session",
    },
    { choiceId: "c-abort", decision: "abort", label: "Reject", scope: "once" },
  ],
  subject: { kind: "shell", command: "rm -rf build" },
});

describe("MuseAdapter", () => {
  it.effect("streams a turn's text and settles it on Muse's terminal", () =>
    Effect.gen(function* () {
      const { hosts, events, nextEvent, start, send } = yield* setup();
      yield* start();
      const turn = yield* send("hi");
      const host = hosts[0]!;
      const turnStart = host.calls.find((call) => call.method === "turn/start")!;
      expect(turnStart.params.commandId).toBe(turn.turnId);
      // Threadlines' instructions ride the first turn only.
      expect(JSON.stringify(turnStart.params.input)).toContain("threadlines_browser");
      expect(turnStart.params.displayText).toBe("hi");

      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      yield* host.notify("item/started", {
        sessionId: SESSION,
        item: {
          itemId: "msg-1",
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
          turnId: turn.turnId,
          text: "",
        },
      });
      yield* host.notify("item/delta", {
        sessionId: SESSION,
        itemId: "msg-1",
        delta: "Hello",
        field: "text",
      });
      const delta = yield* nextEvent((event) => event.type === "content.delta");
      expect(delta.type === "content.delta" && delta.payload.delta).toBe("Hello");
      // The completed item carries text the deltas never brought.
      yield* host.notify("item/completed", {
        sessionId: SESSION,
        item: {
          itemId: "msg-1",
          kind: "agentMessage",
          revision: 2,
          status: "completed",
          turnId: turn.turnId,
          text: "Hello there",
          messagePhase: "finalAnswer",
        },
      });
      const rest = yield* nextEvent((event) => event.type === "content.delta");
      expect(rest.type === "content.delta" && rest.payload.delta).toBe(" there");
      yield* host.notify("turn/completed", {
        sessionId: SESSION,
        turnId: turn.turnId,
        terminal: "completed",
      });
      const completed = yield* nextEvent((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("completed");

      // A start replayed after a delivery gap does not reopen the finished turn.
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      for (let i = 0; i < 5; i += 1) yield* Effect.yieldNow;
      const replayed = yield* Queue.clear(events);
      expect(replayed.some((event) => event.type === "turn.started")).toBe(false);
      yield* send("again");
      const second = host.calls.filter((call) => call.method === "turn/start")[1]!;
      expect(JSON.stringify(second.params.input)).not.toContain("threadlines_browser");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sends a message to the next turn once the turn's visible work is done", () =>
    Effect.gen(function* () {
      const { hosts, adapter, threadId, nextEvent, start, send } = yield* setup();
      yield* start();
      const turn = yield* send("hi");
      const host = hosts[0]!;
      const steer = (text: string) =>
        adapter.steerTurn({
          threadId,
          expectedTurnId: turn.turnId,
          messageId: MessageId.make(`message-${text}`),
          input: text,
        });
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      yield* steer("while it works");
      expect(host.calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);

      // Muse's order: the answer starts, the visible work is done while
      // background checks hold the turn open, then the answer completes.
      const answer = { itemId: "msg-1", kind: "agentMessage", turnId: turn.turnId };
      yield* host.notify("item/started", {
        sessionId: SESSION,
        item: { ...answer, revision: 1, status: "inProgress", text: "" },
      });
      yield* host.notify("turn/foregroundCompleted", {
        sessionId: SESSION,
        turnId: turn.turnId,
        blockingAgents: ["reminder-1"],
      });
      yield* host.notify("item/completed", {
        sessionId: SESSION,
        item: {
          ...answer,
          revision: 2,
          status: "completed",
          text: "Done.",
          messagePhase: "finalAnswer",
        },
      });
      yield* nextEvent((event) => event.type === "content.delta");

      // Steered in now, it would reach only the background checks.
      const refused = yield* steer("what did it print?").pipe(Effect.flip);
      expect(refused._tag === "ProviderAdapterRequestError" && steerRejectionOf(refused)).toBe(
        "turn-finishing",
      );
      expect(host.calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows a turn Muse starts after its message was reported as not accepted", () =>
    Effect.gen(function* () {
      const { hosts, nextEvent, start, send } = yield* setup({
        responder: (call) =>
          call.method === "turn/start"
            ? new MuseHostError({ operation: "turn/start", detail: "timed out", kind: "timeout" })
            : undefined,
      });
      yield* start();
      const turn = yield* send("hi");
      const failed = yield* nextEvent((event) => event.type === "turn.completed");
      expect(failed.type === "turn.completed" && failed.payload.state).toBe("failed");

      // Muse took the message after all: its work shows instead of running unseen.
      yield* hosts[0]!.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      const late = yield* nextEvent((event) => event.type === "turn.started");
      expect(late.turnId).toBe(turn.turnId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("answers a shell approval's decline with Muse's reject choice", () =>
    Effect.gen(function* () {
      const { hosts, adapter, nextEvent, start, send, threadId } = yield* setup();
      yield* start();
      const turn = yield* send("clean up");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      // The request and the notification carry the same approval: one card.
      yield* host.serverRequest(
        "approval/request",
        shellApproval({ approvalId: "a-1", turnId: turn.turnId }),
      );
      yield* host.notify(
        "approval/requested",
        shellApproval({ approvalId: "a-1", turnId: turn.turnId }),
      );
      const opened = yield* nextEvent((event) => event.type === "request.opened");
      expect(opened.type === "request.opened" && opened.payload.availableDecisions).toEqual([
        "accept",
        "acceptForSession",
        "decline",
        "cancel",
      ]);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "decline",
      );
      const decide = host.calls.find((call) => call.method === "approval/decide")!;
      expect(decide.params).toMatchObject({
        approvalId: "a-1",
        choiceId: "c-abort",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      });
      const resolved = yield* nextEvent((event) => event.type === "request.resolved");
      expect(resolved.type === "request.resolved" && resolved.payload.decision).toBe("decline");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a multi-stage approval open and asks again for its next stage", () =>
    Effect.gen(function* () {
      const { hosts, adapter, nextEvent, start, send, threadId } = yield* setup({
        responder: (call) =>
          call.method === "approval/decide" ? { status: "accepted", terminal: false } : undefined,
      });
      yield* start();
      const turn = yield* send("build it");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      // Muse 1.4.9 asks about a compound command part by part.
      const stage = (sourceIndex: number, argv: ReadonlyArray<string>) => ({
        requirementId: { approvalId: "a-2", sourceIndex },
        position: sourceIndex + 1,
        totalStages: 2,
        argv,
      });
      const subject = {
        kind: "shell",
        command: "make && make install",
        stages: [stage(0, ["make"]), stage(1, ["make", "install"])],
      };
      yield* host.notify("approval/requested", {
        ...shellApproval({ approvalId: "a-2", turnId: turn.turnId }),
        subject,
      });
      const first = yield* nextEvent((event) => event.type === "request.opened");
      // On the command's own row.
      expect(first.itemId).toBe("item-shell");
      expect(first.type === "request.opened" && first.payload.detail).toBe("Step 1 of 2: make");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(first.requestId!), "accept");
      yield* host.notify("approval/updated", {
        approvalId: "a-2",
        sessionId: SESSION,
        currentRequirementId: { approvalId: "a-2", sourceIndex: 1 },
        availableChoices: shellApproval({ approvalId: "a-2", turnId: turn.turnId })
          .availableChoices,
        subject,
        change: { kind: "stageResolved" },
      });
      const resolvedFirst = yield* nextEvent((event) => event.type === "request.resolved");
      expect(resolvedFirst.requestId).toBe(first.requestId);
      const second = yield* nextEvent((event) => event.type === "request.opened");
      expect(second.requestId).not.toBe(first.requestId);
      expect(second.type === "request.opened" && second.payload.detail).toBe(
        "Step 2 of 2: make install",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("approves file writes inside the workspace itself under auto-accept edits", () =>
    Effect.gen(function* () {
      const { hosts, nextEvent, start, send } = yield* setup();
      const cwd = yield* start("auto-accept-edits");
      const turn = yield* send("edit");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      const write = (approvalId: string, path: string) => ({
        ...shellApproval({ approvalId, turnId: turn.turnId }),
        toolName: "edit_file",
        subject: { kind: "fileAccess", access: "write", path },
      });
      yield* host.notify("approval/requested", write("a-in", join(cwd, "src", "app.ts")));
      yield* host.notify("approval/requested", write("a-out", join(tmpdir(), "elsewhere.txt")));
      const opened = yield* nextEvent((event) => event.type === "request.opened");
      expect(opened.type === "request.opened" && opened.payload.detail).toBe(
        join(tmpdir(), "elsewhere.txt"),
      );
      const decided = host.calls.filter((call) => call.method === "approval/decide");
      expect(decided.map((call) => [call.params.approvalId, call.params.choiceId])).toEqual([
        ["a-in", "c-once"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("names a subagent by its child session from its first row", () =>
    Effect.gen(function* () {
      const { hosts, nextEvent, start, send } = yield* setup();
      yield* start();
      const turn = yield* send("review");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      // Muse 1.4.9 starts the item before its child session exists.
      const subagent = (revision: number, fields: Record<string, unknown>) =>
        host.notify(revision === 1 ? "item/started" : "item/updated", {
          sessionId: SESSION,
          item: {
            itemId: "sub-1",
            kind: "subagent",
            revision,
            status: "inProgress",
            turnId: turn.turnId,
            subagentId: "subagent-1",
            objective: "review tip.js",
            ...fields,
          },
        });
      yield* subagent(1, {});
      yield* subagent(2, { childSessionId: "child-1" });
      yield* subagent(3, { childSessionId: "child-1", status: "completed" });
      const named = new Set<string>();
      yield* nextEvent((event) => {
        if (event.type !== "subagent.metadata.updated") return false;
        if (event.payload.agentThreadId) named.add(event.payload.agentThreadId);
        return event.payload.status === "completed";
      });
      expect(named).toEqual(new Set(["child-1"]));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("stops one subagent left running past its turn, and nothing else", () =>
    Effect.gen(function* () {
      const { hosts, adapter, nextEvent, start, send, threadId } = yield* setup();
      yield* start();
      const turn = yield* send("research");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      const subagent = (revision: number, status: string) =>
        host.notify(revision === 1 ? "item/started" : "item/updated", {
          sessionId: SESSION,
          item: {
            itemId: "sub-bg",
            kind: "subagent",
            revision,
            status,
            turnId: turn.turnId,
            subagentId: "agent-bg",
            childSessionId: "child-bg",
            objective: "audit dependencies",
          },
        });
      yield* subagent(1, "inProgress");
      yield* host.notify("turn/completed", {
        sessionId: SESSION,
        turnId: turn.turnId,
        terminal: "completed",
      });
      // The turn ended with the subagent still at work: it is background work now.
      const started = yield* nextEvent((event) => event.type === "task.started");
      expect(started.payload).toMatchObject({ taskId: "sub-bg", stoppable: true });

      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("sub-bg"))).toBe(true);
      const methods = host.calls.map((call) => call.method);
      expect(host.calls.find((call) => call.method === "subagent/stop")?.params).toMatchObject({
        subagentId: "agent-bg",
      });
      expect(methods).not.toContain("task/stopAll");
      expect(methods).not.toContain("turn/interrupt");

      yield* subagent(2, "cancelled");
      const stopped = yield* nextEvent((event) => event.type === "task.completed");
      expect(stopped.payload).toMatchObject({ taskId: "sub-bg", status: "stopped" });
      expect(yield* adapter.stopBackgroundTask!(threadId, RuntimeTaskId.make("sub-bg"))).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("stops the turn, its subagents and background work, and keeps their reports quiet", () =>
    Effect.gen(function* () {
      const { hosts, adapter, events, nextEvent, start, send, threadId } = yield* setup();
      yield* start();
      const turn = yield* send("research");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      yield* host.notify("item/started", {
        sessionId: SESSION,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: turn.turnId,
          subagentId: "agent-1",
          childSessionId: "child-1",
          objective: "look around",
        },
      });
      yield* nextEvent((event) => event.type === "subagent.metadata.updated");
      const stopping = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.notify("turn/completed", {
        sessionId: SESSION,
        turnId: turn.turnId,
        terminal: "cancelled",
      });
      const completed = yield* nextEvent((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("interrupted");
      yield* Fiber.join(stopping);
      const methods = host.calls.map((call) => call.method);
      expect(methods).toEqual(
        expect.arrayContaining(["subagent/stop", "task/stopAll", "turn/interrupt"]),
      );
      // The stopped subagent's report would start a turn of Muse's own: it is withdrawn.
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: "muse-wake-1" });
      yield* Effect.sleep(Duration.millis(50));
      expect(
        host.calls.some(
          (call) => call.method === "turn/interrupt" && call.params.turnId === "muse-wake-1",
        ),
      ).toBe(true);
      const started = yield* Queue.clear(events);
      expect(started.some((event) => event.type === "turn.started")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forks natively, then reopens the copy with Threadlines' tools and access", () =>
    Effect.gen(function* () {
      const FORK = "01a14000-0000-7000-8000-0000000000f0";
      const { hosts, adapter, threadId } = yield* setup({
        responder: (call) =>
          call.method === "session/fork"
            ? {
                // A fork keeps the source's profile until it is reopened.
                session: {
                  sessionId: FORK,
                  approvalMode: { mode: "promptUnmatched" },
                  permissionState: { profileId: ":unrestricted" },
                },
                viewCursor: "v4:1",
                history: { mode: "none", noneReason: "excluded", items: null },
                pendingRequests: [],
              }
            : undefined,
      });
      const session = yield* adapter.startSession({
        threadId,
        cwd: workspace(),
        runtimeMode: "approval-required",
        forkFrom: { providerThreadId: SESSION, lastTurnId: "turn-3" },
      });

      expect(session.resumeCursor).toMatchObject({ sessionId: FORK });
      expect(hosts).toHaveLength(2);
      const fork = hosts[0]!.calls.find((call) => call.method === "session/fork")!;
      expect(fork.params).toMatchObject({ sessionId: SESSION, cutPoint: { lastTurnId: "turn-3" } });
      expect(yield* hosts[0]!.closed).toBe(true);
      const reopen = hosts[1]!.calls.find((call) => call.method === "session/resume")!;
      expect(reopen.params).toMatchObject({ sessionId: FORK, permissionProfile: ":ask-me" });
      expect(Object.keys((reopen.params.config as { mcpServers: object }).mcpServers)).toContain(
        "threadlines_browser",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("recycles a host that ignores Stop before the next message starts on it", () =>
    Effect.gen(function* () {
      const { hosts, adapter, events, start, send, threadId } = yield* setup();
      yield* start();
      const turn = yield* send("research");
      const stuck = hosts[0]!;
      yield* stuck.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      yield* stuck.notify("item/started", {
        sessionId: SESSION,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: turn.turnId,
          subagentId: "agent-1",
          objective: "look around",
        },
      });
      const stopping = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkScoped);
      // Sent while the stop is pending: it waits for the stopped turn.
      const next = yield* send("next").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // Muse never confirms the stop.
      yield* TestClock.adjust(Duration.seconds(16));
      yield* Fiber.join(stopping);
      const nextTurn = yield* Fiber.join(next);

      expect(yield* stuck.closed).toBe(true);
      expect(hosts).toHaveLength(2);
      const startedOn = hosts[1]!.calls.find((call) => call.method === "turn/start");
      expect(startedOn?.params.commandId).toBe(nextTurn.turnId);
      expect(yield* hosts[1]!.closed).toBe(false);
      // The subagent died with the stuck host.
      const seen = yield* Queue.clear(events);
      expect(
        seen.some(
          (event) =>
            event.type === "task.completed" &&
            event.payload.taskId === "sub-1" &&
            event.payload.status === "stopped",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "moves to a read-only host for plan mode, but not while background work runs, nor restarts",
    () =>
      Effect.gen(function* () {
        const { hosts, nextEvent, start, send } = yield* setup();
        yield* start("full-access");
        const turn = yield* send("go");
        const host = hosts[0]!;
        yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
        yield* host.notify("item/started", {
          sessionId: SESSION,
          item: {
            itemId: "wf-1",
            kind: "workflow",
            revision: 1,
            status: "inProgress",
            turnId: turn.turnId,
            workflowRunId: "run-1",
            entryId: "review",
          },
        });
        yield* host.notify("turn/completed", {
          sessionId: SESSION,
          turnId: turn.turnId,
          terminal: "completed",
        });
        yield* nextEvent((event) => event.type === "turn.completed");
        const refused = yield* send("plan it", "plan").pipe(Effect.flip);
        expect(refused.message).toContain("still finishing background work");
        // An access change restarts the session, and waits the same way.
        const restart = yield* start("approval-required").pipe(Effect.flip);
        expect(restart.message).toContain("still finishing background work");
        expect(hosts).toHaveLength(1);

        yield* host.notify("item/completed", {
          sessionId: SESSION,
          item: {
            itemId: "wf-1",
            kind: "workflow",
            revision: 2,
            status: "completed",
            turnId: turn.turnId,
            workflowRunId: "run-1",
            entryId: "review",
          },
        });
        yield* nextEvent((event) => event.type === "task.completed");
        const planTurn = yield* send("plan it", "plan");
        expect(hosts).toHaveLength(2);
        const planHost = hosts[1]!;
        expect(planHost.options.args).toEqual(
          expect.arrayContaining(["--disable-write", "--contributor-mode", "off"]),
        );
        expect(planHost.options.args).not.toContain("--disable-sandbox");
        const resume = planHost.calls.find((call) => call.method === "session/resume")!;
        expect(resume.params).toMatchObject({
          sessionId: SESSION,
          permissionProfile: ":read-only",
        });
        // Read-only answers the plan: the final message becomes the proposed plan.
        yield* planHost.notify("turn/started", { sessionId: SESSION, turnId: planTurn.turnId });
        yield* planHost.notify("item/completed", {
          sessionId: SESSION,
          item: {
            itemId: "plan-msg",
            kind: "agentMessage",
            revision: 1,
            status: "completed",
            turnId: planTurn.turnId,
            text: "1. Do the thing",
            messagePhase: "finalAnswer",
          },
        });
        yield* planHost.notify("turn/completed", {
          sessionId: SESSION,
          turnId: planTurn.turnId,
          terminal: "completed",
        });
        const proposed = yield* nextEvent((event) => event.type === "turn.proposed.completed");
        expect(proposed.type === "turn.proposed.completed" && proposed.payload.planMarkdown).toBe(
          "1. Do the thing",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a running turn and ends the session when the host dies", () =>
    Effect.gen(function* () {
      const { hosts, nextEvent, start, send } = yield* setup();
      yield* start();
      const turn = yield* send("go");
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId: turn.turnId });
      yield* host.exit({ kind: "crash", code: 101 });
      const completed = yield* nextEvent((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.state).toBe("failed");
      const exited = yield* nextEvent((event) => event.type === "session.exited");
      expect(exited.type === "session.exited" && exited.payload.exitKind).toBe("error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads back the events a delivery gap dropped", () =>
    Effect.gen(function* () {
      let turnId = "";
      const { hosts, nextEvent, start, send } = yield* setup({
        responder: (call) =>
          call.method === "view/page"
            ? {
                events: [
                  {
                    method: "item/completed",
                    params: {
                      sessionId: SESSION,
                      viewCursor: "v4:9",
                      item: {
                        itemId: "msg-gap",
                        kind: "agentMessage",
                        revision: 2,
                        status: "completed",
                        turnId,
                        text: "recovered",
                      },
                    },
                  },
                ],
                nextCursor: null,
              }
            : undefined,
      });
      yield* start();
      const turn = yield* send("go");
      turnId = turn.turnId;
      const host = hosts[0]!;
      yield* host.notify("turn/started", { sessionId: SESSION, turnId });
      yield* host.notify("view/gap", { sessionId: SESSION, after: "v4:2", next: "v4:9" });
      const recovered = yield* nextEvent(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      expect(recovered.type === "item.completed" && recovered.payload.detail).toBe("recovered");
      expect(host.calls.find((call) => call.method === "view/page")?.params).toMatchObject({
        cursor: "v4:2",
        direction: "forward",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("says when the plan's usage limit stops a turn", () =>
    Effect.gen(function* () {
      const { hosts, nextEvent, start, send } = yield* setup();
      yield* start();
      const turn = yield* send("go");
      yield* hosts[0]!.notify("turn/completed", {
        sessionId: SESSION,
        turnId: turn.turnId,
        terminal: "failed",
        error: {
          kind: "modelError",
          message: "Subscription quota exhausted",
          retryable: false,
          quota: { limitKind: "tierLimit", resetsAtMs: Date.UTC(2026, 9, 16, 12) },
        },
      });
      const completed = yield* nextEvent((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" && completed.payload.errorMessage).toContain(
        "usage limit is reached",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses to run on an API key unless per-use billing is allowed", () =>
    Effect.gen(function* () {
      const apiKey: Responder = (call) =>
        call.method === "account/read" ? { state: "apiKey", credentialRequired: true } : undefined;
      const refused = yield* setup({ responder: apiKey }).pipe(
        Effect.flatMap(({ start }) => start()),
        Effect.flip,
      );
      expect(refused.message).toContain("bills per use");
      const allowed = yield* setup({ responder: apiKey, allowApiKeyBilling: true });
      yield* allowed.start();
      expect(allowed.hosts[0]!.calls.some((call) => call.method === "session/start")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
