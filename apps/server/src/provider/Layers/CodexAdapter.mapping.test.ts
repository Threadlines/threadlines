// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";

import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, it } from "vite-plus/test";

import { mapToRuntimeEvents } from "./CodexAdapter.ts";

describe("CodexAdapter item mapping", () => {
  it("maps native subagent activity into the canonical collab-agent shape", () => {
    const [runtimeEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-subagent-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-13T18:38:47.000Z",
        method: "item/completed",
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("subagent-activity-1"),
        payload: {
          completedAtMs: 1_783_967_927_000,
          threadId: "provider-parent-thread",
          turnId: "provider-parent-turn",
          item: {
            id: "subagent-activity-1",
            type: "subAgentActivity",
            kind: "started",
            agentPath: "/root/implement_pull_server",
            agentThreadId: "019f5cf1-e2fc-74f2-a6c0-16502ecc4826",
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.ok(runtimeEvent);
    assert.equal(runtimeEvent.type, "item.completed");
    if (runtimeEvent.type !== "item.completed") {
      return;
    }
    assert.equal(runtimeEvent.payload.itemType, "collab_agent_tool_call");
    assert.equal(runtimeEvent.payload.status, "completed");
    assert.equal(runtimeEvent.payload.title, "Subagent task");
    assert.deepStrictEqual(runtimeEvent.payload.data, {
      completedAtMs: 1_783_967_927_000,
      threadId: "provider-parent-thread",
      turnId: "provider-parent-turn",
      item: {
        id: "subagent-activity-1",
        type: "subAgentActivity",
        kind: "started",
        agentPath: "/root/implement_pull_server",
        agentThreadId: "019f5cf1-e2fc-74f2-a6c0-16502ecc4826",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["019f5cf1-e2fc-74f2-a6c0-16502ecc4826"],
        agentsStates: {
          "019f5cf1-e2fc-74f2-a6c0-16502ecc4826": {
            status: "running",
          },
        },
      },
    });
  });
});
