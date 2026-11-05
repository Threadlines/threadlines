import {
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  SideTurnId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { makeAlertAssistantsToolHandler } from "./alertAssistantsToolHandlers.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { roomToolsFor } from "./roomToolAccess.ts";

const THREAD = ThreadId.make("thread-alert");
const TURN = TurnId.make("turn-1");
const PROJECT = ProjectId.make("project-1");
const GENERAL_CHATS = ProjectId.make("project-general");

const makeThread = (projectId: ProjectId = PROJECT): OrchestrationThread =>
  ({
    id: THREAD,
    projectId,
    title: "Alert",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    session: {
      threadId: THREAD,
      status: "running",
      providerName: "codex",
      runtimeMode: "auto-accept-edits",
      participantId: null,
      activeTurnId: TURN,
      lastError: null,
      updatedAt: "2026-11-05T10:00:00.000Z",
    },
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationThread;

const caller = (side?: "ask"): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(side, { guideOnly: side === undefined })),
  ...(side !== undefined ? { side: { sideTurnId: SideTurnId.make("side-1"), kind: side } } : {}),
});

/** The tool over alerts that remember what they were asked, as AssistantAlerts.ask does. */
function harness(options: { readonly receivers: number; readonly projectId?: ProjectId }) {
  const asked: Array<{ threadId: string; turnId: string; projectId: string }> = [];
  const handler = makeAlertAssistantsToolHandler({
    readThread: () => Effect.succeed(makeThread(options.projectId)),
    isGeneralChat: (projectId) => Effect.succeed(projectId === GENERAL_CHATS),
    alerts: {
      ask: (input) =>
        Effect.sync(() => {
          if (options.receivers === 0) return { receivers: 0, already: false };
          const already = asked.some((entry) => entry.turnId === input.turnId);
          if (!already) asked.push(input);
          return { receivers: options.receivers, already };
        }),
    },
  });
  return { handler, asked };
}

describe("alert_assistants", () => {
  it("marks the caller's running turn once, for threads with no room tools too", async () => {
    const { handler, asked } = harness({ receivers: 2 });
    const first = await Effect.runPromise(handler(caller()));
    expect(first.outcome).toBe("will_alert");
    const again = await Effect.runPromise(handler(caller()));
    expect(again).toEqual({
      outcome: "will_alert",
      detail:
        "This turn's alert is already set: it goes out when the turn ends. Nothing more to do.",
    });
    expect(asked).toEqual([{ threadId: THREAD, turnId: TURN, projectId: PROJECT }]);
  });

  it("says where to set one up when nobody takes the alert, and never marks General Chats", async () => {
    const none = harness({ receivers: 0 });
    const result = await Effect.runPromise(none.handler(caller()));
    expect(result.outcome).toBe("no_receiver");
    expect(result.detail).toContain("threadlines-place:connections.assistantAlerts");

    const general = harness({ receivers: 1, projectId: GENERAL_CHATS });
    expect(await Effect.runPromise(general.handler(caller()))).toEqual({
      outcome: "refused",
      detail: "Assistants aren't alerted about General Chats.",
    });
    expect(general.asked).toEqual([]);
  });

  it("refuses a side runtime, which answers one question and changes nothing", async () => {
    const { handler, asked } = harness({ receivers: 1 });
    const result = await Effect.runPromise(handler(caller("ask")));
    expect(result.outcome).toBe("not_allowed");
    expect(asked).toEqual([]);
  });
});
