import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { settingsChangeStateOn } from "@threadlines/shared/settingsChangeState";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { roomToolsFor } from "./roomToolAccess.ts";
import { makeSettingsChangeToolHandler } from "./settingsChangeToolHandlers.ts";

const THREAD = ThreadId.make("thread-settings");
const TURN = TurnId.make("turn-1");
const AT = "2026-11-02T10:00:00.000Z";

const makeThread = (): OrchestrationThread =>
  ({
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    title: "Settings",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    session: {
      threadId: THREAD,
      status: "running",
      providerName: "codex",
      runtimeMode: "auto-accept-edits",
      participantId: null,
      activeTurnId: TURN,
      lastError: null,
      updatedAt: AT,
    },
    archivedAt: null,
    deletedAt: null,
    settingsRequests: [],
  }) as unknown as OrchestrationThread;

const mainCaller = (): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(undefined)),
});

/** The tool over an engine that keeps receipts by command id and records requests as the decider would. */
function harness() {
  let thread = makeThread();
  const dispatched: OrchestrationCommand[] = [];
  const receipts = new Set<string>();
  const handler = makeSettingsChangeToolHandler({
    engine: {
      dispatch: (command) =>
        Effect.sync(() => {
          if (receipts.has(command.commandId)) return { sequence: 1 };
          receipts.add(command.commandId);
          dispatched.push(command);
          if (command.type === "thread.settings-change.request") {
            thread = {
              ...thread,
              settingsRequests: settingsChangeStateOn.requested(thread.settingsRequests ?? [], {
                requestId: command.requestId,
                participantId: command.participantId,
                turnId: command.turnId,
                changes: command.changes,
                status: "waiting",
                createdAt: command.createdAt,
                noted: false,
              }),
            };
          }
          return { sequence: dispatched.length };
        }),
    },
    readThread: () => Effect.sync(() => thread),
    settings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, enableAssistantStreaming: true }),
  });
  return { handler, dispatched, thread: () => thread };
}

describe("settings_change", () => {
  it("puts a card on the thread with each change, from what to what and where it lands", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), {
        changes: [
          { place: "general.streamReplies", value: false },
          { place: "general.theme", value: "light" },
        ],
      }),
    );
    expect(result.outcome).toBe("asked_user");
    expect(result.changes).toEqual([
      expect.objectContaining({
        place: "general.streamReplies",
        from: "On",
        to: "Off",
        lands: "computer",
      }),
      expect.objectContaining({ place: "general.theme", to: "Light", lands: "device" }),
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.settings-change.request",
      turnId: TURN,
      changes: [
        { place: "general.streamReplies", value: false, from: true },
        { place: "general.theme", value: "light" },
      ],
    });
  });

  it("makes one card for a retried call", async () => {
    const { handler, dispatched, thread } = harness();
    const call = { changes: [{ place: "general.theme", value: "dark" }] };
    await Effect.runPromise(handler(mainCaller(), call));
    const again = await Effect.runPromise(handler(mainCaller(), call));
    expect(again.outcome).toBe("asked_user");
    expect(dispatched).toHaveLength(1);
    expect(thread().settingsRequests).toHaveLength(1);
  });

  it("leaves a computer setting already at its value off, and asks nothing when that's all", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), { changes: [{ place: "general.streamReplies", value: true }] }),
    );
    expect(result.outcome).toBe("unchanged");
    expect(result.detail).toContain("Stream replies is already On");
    expect(dispatched).toHaveLength(0);
  });

  it("refuses a setting that widens agents' reach, linking it for the user", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), { changes: [{ place: "threads.agentThreads", value: "auto" }] }),
    );
    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("Only the user can change");
    expect(result.detail).toContain("(threadlines-place:threads.agentThreads)");
    expect(dispatched).toHaveLength(0);
  });

  it("is not for a side answer", async () => {
    const { handler } = harness();
    const result = await Effect.runPromise(
      handler(
        { ...mainCaller(), side: "ask", roomTools: new Set(roomToolsFor("ask")) },
        { changes: [{ place: "general.theme", value: "dark" }] },
      ),
    );
    expect(result.outcome).toBe("not_allowed");
  });
});
