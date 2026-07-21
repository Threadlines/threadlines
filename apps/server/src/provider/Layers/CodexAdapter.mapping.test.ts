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
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  mapCodexSubagentTranscript,
  mapToRuntimeEvents,
  readCodexSubagentParentThreadId,
} from "./CodexAdapter.ts";

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

  it("maps a stored Codex child thread into the shared transcript shape", () => {
    const thread = {
      id: "child-thread",
      parentThreadId: "parent-thread",
      source: {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "parent-thread",
          },
        },
      },
      turns: [
        {
          id: "turn-child-1",
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Inspect the update path" }],
            },
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: ["Checking the runtime wiring"],
            },
            {
              id: "command-1",
              type: "commandExecution",
              command: "rg -n update apps/server",
              commandActions: [],
              cwd: "C:/repo",
              status: "completed",
              aggregatedOutput: "apps/server/src/update.ts:10",
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              phase: "final_answer",
              text: "The update path is correctly wired.",
            },
          ],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.equal(readCodexSubagentParentThreadId(thread), "parent-thread");
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread), {
      truncated: false,
      entries: [
        { role: "user", text: "Inspect the update path", toolUses: [] },
        { role: "thinking", text: "Checking the runtime wiring", toolUses: [] },
        {
          role: "assistant",
          text: "",
          toolUses: [{ name: "shell_command", summary: "rg -n update apps/server" }],
          outputPreview: "apps/server/src/update.ts:10",
        },
        {
          role: "assistant",
          text: "The update path is correctly wired.",
          toolUses: [],
        },
      ],
    });
  });

  it("uses source ancestry metadata and honors transcript limits", () => {
    const thread = {
      id: "grandchild-thread",
      source: {
        subAgent: {
          thread_spawn: {
            depth: 2,
            parent_thread_id: "child-thread",
          },
        },
      },
      turns: [
        {
          id: "turn-grandchild-1",
          status: "completed",
          items: [
            { id: "assistant-1", type: "agentMessage", text: "First" },
            { id: "assistant-2", type: "agentMessage", text: "Second" },
          ],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.equal(readCodexSubagentParentThreadId(thread), "child-thread");
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1 }), {
      truncated: true,
      entries: [{ role: "assistant", text: "First", toolUses: [] }],
    });
  });
});
