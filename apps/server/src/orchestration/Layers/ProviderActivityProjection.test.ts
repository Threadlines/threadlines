import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH,
  MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH,
} from "@threadlines/shared/threadLimits";
import { describe, expect, it } from "vitest";

import { projectRuntimeEventToActivities } from "./ProviderActivityProjection.ts";

function mcpStatusEvent(
  status: unknown,
  options: { readonly providerInstanceId?: string | undefined } = {},
): ProviderRuntimeEvent {
  return {
    type: "mcp.status.updated",
    eventId: EventId.make("evt-mcp-status"),
    provider: ProviderDriverKind.make("codex"),
    ...(options.providerInstanceId
      ? { providerInstanceId: ProviderInstanceId.make(options.providerInstanceId) }
      : {}),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-06-01T12:00:00.000Z",
    payload: {
      status,
    },
  } satisfies ProviderRuntimeEvent;
}

describe("ProviderActivityProjection", () => {
  it("projects model fallback reroutes with explicit fallback wording", () => {
    const activities = projectRuntimeEventToActivities({
      type: "model.rerouted",
      eventId: EventId.make("evt-model-fallback"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
        reason: "fallback:unavailable",
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "provider.model.rerouted",
        summary: "Using fallback model: claude-opus-4-8",
        payload: {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
          reason: "fallback:unavailable",
          detail: "Claude is using claude-opus-4-8 because claude-fable-5 was unavailable.",
        },
      }),
    ]);
  });

  it("uses one transient activity for safety-buffering show and hide updates", () => {
    const base = {
      type: "model.safety-buffering.updated" as const,
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-07-09T00:00:00.000Z" as const,
      providerRefs: { providerThreadId: "provider-child-thread-1" },
      payload: {
        model: "gpt-5.6-sol",
        useCases: ["cyber"],
        reasons: ["additional-review"],
        fasterModel: null,
      },
    };
    const visible = projectRuntimeEventToActivities({
      ...base,
      eventId: EventId.make("evt-safety-buffering-visible"),
      payload: { ...base.payload, showBufferingUi: true },
    } satisfies ProviderRuntimeEvent);
    const hidden = projectRuntimeEventToActivities({
      ...base,
      eventId: EventId.make("evt-safety-buffering-hidden"),
      payload: { ...base.payload, showBufferingUi: false },
    } satisfies ProviderRuntimeEvent);

    expect(visible).toEqual([
      expect.objectContaining({
        id: "activity:model-safety-buffering:thread-1:turn-1:provider-child-thread-1",
        kind: "provider.model.safety-buffering",
        tone: "thinking",
        summary: "Additional safety checks",
        payload: {
          detail: "This request requires additional safety checks, which can take extra time.",
          model: "gpt-5.6-sol",
          useCases: ["cyber"],
          reasons: ["additional-review"],
          showBufferingUi: true,
          fasterModel: null,
          status: "inProgress",
        },
      }),
    ]);
    expect(hidden).toEqual([
      expect.objectContaining({
        id: visible[0]?.id,
        summary: "Additional safety checks",
        payload: expect.not.objectContaining({ status: expect.anything() }),
      }),
    ]);
  });

  it("projects provider prompt suggestions for composer reuse", () => {
    const activities = projectRuntimeEventToActivities({
      type: "turn.prompt-suggestion.updated",
      eventId: EventId.make("evt-prompt-suggestion"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        suggestion: "Add regression tests for this edge case.",
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "prompt-suggestion.updated",
        summary: "Prompt suggestion",
        payload: {
          suggestion: "Add regression tests for this edge case.",
        },
      }),
    ]);
  });

  it("keeps provider metadata on runtime warnings", () => {
    const activities = projectRuntimeEventToActivities({
      type: "runtime.warning",
      eventId: EventId.make("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        message: "Reconnecting... 2/5",
        warningKind: "api-retry",
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "runtime.warning",
        summary: "Runtime warning",
        payload: {
          message: "Reconnecting... 2/5",
          provider: "codex",
          warningKind: "api-retry",
        },
      }),
    ]);
  });

  it("suppresses routine MCP startup status updates", () => {
    for (const status of ["starting", "ready", "connected", "cancelled"]) {
      expect(
        projectRuntimeEventToActivities(
          mcpStatusEvent({
            name: "github",
            status,
          }),
        ),
      ).toEqual([]);
    }

    expect(projectRuntimeEventToActivities(mcpStatusEvent("ready"))).toEqual([]);
    expect(projectRuntimeEventToActivities(mcpStatusEvent("cancelled"))).toEqual([]);
  });

  it("keeps MCP startup failures visible", () => {
    const activities = projectRuntimeEventToActivities(
      mcpStatusEvent({
        name: "github",
        status: "failed",
        error: "OAuth token expired",
      }),
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      tone: "warning",
      kind: "mcp.status.updated",
      summary: "MCP startup failed",
      payload: {
        detail: "OAuth token expired",
        provider: "codex",
        status: {
          name: "github",
          status: "failed",
          error: "OAuth token expired",
        },
      },
    });
  });

  it("preserves provider instance metadata on MCP startup failures", () => {
    const activities = projectRuntimeEventToActivities(
      mcpStatusEvent(
        {
          name: "github",
          status: "failed",
          error: "OAuth token expired",
        },
        { providerInstanceId: "codex-work" },
      ),
    );

    expect(activities[0]).toMatchObject({
      payload: {
        provider: "codex",
        providerInstanceId: "codex-work",
      },
    });
  });

  it("keeps cancelled MCP startup updates visible when an error is present", () => {
    const activities = projectRuntimeEventToActivities(
      mcpStatusEvent({
        name: "github",
        status: "cancelled",
        error: "OAuth token expired",
      }),
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      tone: "warning",
      kind: "mcp.status.updated",
      summary: "MCP startup cancelled",
      payload: {
        detail: "OAuth token expired",
        status: {
          name: "github",
          status: "cancelled",
          error: "OAuth token expired",
        },
      },
    });
  });

  it("does not project synthetic manual compacting status as a separate activity", () => {
    const activities = projectRuntimeEventToActivities({
      type: "session.state.changed",
      eventId: EventId.make("evt-manual-compact-dispatched"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        state: "waiting",
        reason: "status:compacting",
        detail: {
          trigger: "manual",
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([]);
  });

  it("still projects provider compacting status as a context compaction activity", () => {
    const activities = projectRuntimeEventToActivities({
      type: "session.state.changed",
      eventId: EventId.make("evt-provider-compacting"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        state: "waiting",
        reason: "status:compacting",
        detail: {
          status: "compacting",
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "context-compaction",
      summary: "Compacting context...",
      payload: {
        status: "inProgress",
        state: "waiting",
      },
    });
  });

  it("compacts large tool lifecycle payload data before projection", () => {
    const largeOutput = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
    const activities = projectRuntimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-tool-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          item: {
            command: "rg something",
            status: "completed",
            aggregatedOutput: largeOutput,
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    const payload = activities[0]?.payload as
      | { data?: { item?: { command?: string; status?: string; aggregatedOutput?: string } } }
      | undefined;
    const item = payload?.data?.item;

    expect(item?.command).toBe("rg something");
    expect(item?.status).toBe("completed");
    expect(item?.aggregatedOutput).toEqual(expect.stringContaining("line 999"));
    expect(item?.aggregatedOutput?.startsWith("...")).toBe(true);
    expect(item?.aggregatedOutput?.length).toBeLessThanOrEqual(
      MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH,
    );
  });

  it("preserves completed tool lifecycle status for flat provider payloads", () => {
    const activities = projectRuntimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-claude-agent-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("tool-agent-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Subagent task",
        data: {
          toolName: "Agent",
          result: { type: "tool_result", content: "done" },
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities[0]?.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolCallId: "tool-agent-1",
      status: "completed",
    });
  });

  it("preserves image generation result payloads for inline previews", () => {
    const imageResult = `iVBORw0KGgo${"A".repeat(MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH + 128)}`;
    const activities = projectRuntimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-image-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        itemType: "image_view",
        title: "Image view",
        data: {
          item: {
            id: "ig_123",
            result: imageResult,
            type: "imageGeneration",
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    const payload = activities[0]?.payload as { data?: { item?: { result?: string } } } | undefined;

    expect(payload?.data?.item?.result).toBe(imageResult);
    expect(payload?.data?.item?.result?.startsWith("...")).toBe(false);
  });

  it("still compacts non-image result payload strings", () => {
    const largeResult = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
    const activities = projectRuntimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-dynamic-tool-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          item: {
            id: "tool_123",
            result: largeResult,
            type: "toolResult",
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    const payload = activities[0]?.payload as { data?: { item?: { result?: string } } } | undefined;
    const result = payload?.data?.item?.result;

    expect(result).toEqual(expect.stringContaining("line 999"));
    expect(result?.startsWith("...")).toBe(true);
    expect(result?.length).toBeLessThanOrEqual(MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH);
  });

  it("preserves long collab agent results up to the agent result cap", () => {
    const agentResult = Array.from({ length: 400 }, (_, index) => `finding ${index}`).join("\n");
    expect(agentResult.length).toBeGreaterThan(MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH);
    expect(agentResult.length).toBeLessThanOrEqual(
      MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH,
    );
    const activities = projectRuntimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-collab-agent-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("tool-agent-long"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Subagent task",
        data: {
          toolName: "Agent",
          result: {
            type: "tool_result",
            tool_use_id: "tool-agent-long",
            content: [{ type: "text", text: agentResult }],
          },
          taskNotification: {
            taskId: "task-agent-long",
            status: "completed",
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    const payload = activities[0]?.payload as
      | { data?: { result?: { content?: Array<{ text?: string }> } } }
      | undefined;

    expect(payload?.data?.result?.content?.[0]?.text).toBe(agentResult);
  });

  it("projects task lifecycle linkage fields for background agents", () => {
    const started = projectRuntimeEventToActivities({
      type: "task.started",
      eventId: EventId.make("evt-task-started-agent"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        taskId: RuntimeTaskId.make("task-bg-agent"),
        description: "Inventory features",
        taskType: "local_agent",
        toolUseId: "tool-task-bg-1",
        subagentType: "Explore",
      },
    } satisfies ProviderRuntimeEvent);

    expect(started[0]?.payload).toMatchObject({
      taskId: "task-bg-agent",
      taskType: "local_agent",
      toolUseId: "tool-task-bg-1",
      subagentType: "Explore",
    });

    const progress = projectRuntimeEventToActivities({
      type: "task.progress",
      eventId: EventId.make("evt-task-progress-agent"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-06-01T12:00:05.000Z",
      payload: {
        taskId: RuntimeTaskId.make("task-bg-agent"),
        description: "Reading contracts",
        toolUseId: "tool-task-bg-1",
        subagentType: "Explore",
      },
    } satisfies ProviderRuntimeEvent);

    expect(progress[0]?.payload).toMatchObject({
      taskId: "task-bg-agent",
      toolUseId: "tool-task-bg-1",
      subagentType: "Explore",
    });
  });

  it("links task completions to their originating tool call", () => {
    const activities = projectRuntimeEventToActivities({
      type: "task.completed",
      eventId: EventId.make("evt-task-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-06-01T12:00:00.000Z",
      payload: {
        taskId: RuntimeTaskId.make("task-bg-agent"),
        status: "completed",
        summary: 'Agent "Inventory features" finished',
        toolUseId: "tool-task-bg-1",
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "task.completed",
        payload: {
          taskId: "task-bg-agent",
          status: "completed",
          detail: 'Agent "Inventory features" finished',
          toolUseId: "tool-task-bg-1",
        },
      }),
    ]);
  });
});
