import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@threadlines/contracts";

import { projectSubagentActivity } from "./subagentProjection.ts";

const TURN_ID = TurnId.make("11111111-1111-4111-8111-111111111111");
const RESUME_TURN_ID = TurnId.make("22222222-2222-4222-8222-222222222222");
const SPAWN_TOOL_USE_ID = "toolu_01GSFNVFM8ppotb3KXjK3ASy";

function activity(input: {
  id: string;
  kind: string;
  payload: unknown;
  turnId?: TurnId | null;
  createdAt?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "tool",
    kind: input.kind,
    summary: "Subagent task",
    payload: input.payload,
    turnId: input.turnId ?? null,
    createdAt: input.createdAt ?? "2026-08-15T00:00:00.000Z",
  };
}

/** The shape ClaudeAdapter projects for an Agent/Task tool call: itemType +
 *  toolName/input under data, no nested `data.item`. */
function claudeSpawnActivity(input: {
  id: string;
  kind: string;
  status: string;
  turnId?: TurnId | null;
  data?: Record<string, unknown>;
  createdAt?: string;
}): OrchestrationThreadActivity {
  return activity({
    id: input.id,
    kind: input.kind,
    turnId: input.turnId ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    payload: {
      itemType: "collab_agent_tool_call",
      toolCallId: SPAWN_TOOL_USE_ID,
      status: input.status,
      title: "Subagent task",
      detail: "claude: Fix missing-worktree bug trio",
      data: {
        toolName: "Agent",
        input: {
          description: "Fix missing-worktree bug trio",
          subagent_type: "claude",
          model: "opus",
        },
        ...input.data,
      },
    },
  });
}

describe("projectSubagentActivity", () => {
  it("creates a roster row from a Claude Agent tool call", () => {
    const roster = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );

    expect(roster).toHaveLength(1);
    const agent = roster[0];
    expect(agent?.id).toBe(SPAWN_TOOL_USE_ID);
    expect(agent?.spawnCallId).toBe(SPAWN_TOOL_USE_ID);
    expect(agent?.turnId).toBe(TURN_ID);
    expect(agent?.role).toBe("claude");
    expect(agent?.objective).toBe("Fix missing-worktree bug trio");
    expect(agent?.requestedModel).toBe("opus");
    expect(agent?.status).toBe("running");
  });

  it("keeps the spawn turn when later live-text updates arrive without a turn", () => {
    const spawned = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );
    const updated = projectSubagentActivity(
      spawned,
      claudeSpawnActivity({
        id: "a2",
        kind: "tool.updated",
        status: "inProgress",
        turnId: null,
        data: { subagentLiveText: "Now writing the shared server-side module." },
        createdAt: "2026-08-15T00:01:00.000Z",
      }),
    );

    expect(updated).toHaveLength(1);
    expect(updated[0]?.turnId).toBe(TURN_ID);
    expect(updated[0]?.status).toBe("running");
  });

  it("treats a background launch acknowledgment as still running", () => {
    const roster = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.completed",
        status: "completed",
        turnId: TURN_ID,
        data: {
          result: `Async agent launched successfully. agentId: agent-a46aeb71`,
        },
      }),
    );

    expect(roster).toHaveLength(1);
    expect(roster[0]?.status).toBe("running");
    expect(roster[0]?.resultBody).toBeNull();
  });

  it("settles a known agent from task.completed and ignores unknown tasks", () => {
    const spawned = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );

    const settled = projectSubagentActivity(
      spawned,
      activity({
        id: "a2",
        kind: "task.completed",
        payload: { taskId: "a46aeb71b8e19f84b", status: "completed", toolUseId: SPAWN_TOOL_USE_ID },
        createdAt: "2026-08-15T00:05:00.000Z",
      }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("completed");
    // Claude names the agent's transcript after its task id; the completion is
    // the last chance to learn the link.
    expect(settled[0]?.transcriptAgentId).toBe("a46aeb71b8e19f84b");

    // A background bash task's completion links to no roster row and must not
    // invent one.
    const unchanged = projectSubagentActivity(
      settled,
      activity({
        id: "a3",
        kind: "task.completed",
        payload: { taskId: "bash-1", status: "completed", toolUseId: "toolu_bash" },
      }),
    );
    expect(unchanged).toHaveLength(1);
  });

  it("links the transcript task id from task progress without inventing rows", () => {
    const spawned = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );

    const linked = projectSubagentActivity(
      spawned,
      activity({
        id: "a2",
        kind: "task.progress",
        payload: {
          taskId: "a46aeb71b8e19f84b",
          detail: "Running List provider dirs",
          toolUseId: SPAWN_TOOL_USE_ID,
          subagentType: "claude",
        },
      }),
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.transcriptAgentId).toBe("a46aeb71b8e19f84b");
    expect(linked[0]?.status).toBe("running");

    // A background bash task's progress names no known agent and must not
    // create one.
    const unchanged = projectSubagentActivity(
      linked,
      activity({
        id: "a3",
        kind: "task.progress",
        payload: { taskId: "bash-1", detail: "Running dev server", toolUseId: "toolu_bash" },
      }),
    );
    expect(unchanged).toHaveLength(1);
  });

  it("re-opens a settled agent whose task starts again under the resuming call", () => {
    const spawned = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );
    const settled = projectSubagentActivity(
      spawned,
      activity({
        id: "a2",
        kind: "task.completed",
        payload: { taskId: "a34bb18edee269135", status: "completed", toolUseId: SPAWN_TOOL_USE_ID },
        createdAt: "2026-08-15T00:05:00.000Z",
      }),
    );
    expect(settled[0]?.status).toBe("completed");

    // The model sent the agent another message: same task, but reported under
    // the call that resumed it and inside the turn that sent it.
    const resumed = projectSubagentActivity(
      settled,
      activity({
        id: "a3",
        kind: "task.started",
        turnId: RESUME_TURN_ID,
        createdAt: "2026-08-15T00:10:00.000Z",
        payload: {
          taskId: "a34bb18edee269135",
          toolUseId: "toolu_01WaB14B6ivDH4qPhA5QhpDx",
          taskType: "local_agent",
          subagentType: "claude",
          description: "Fix missing-worktree bug trio",
        },
      }),
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.status).toBe("running");
    expect(resumed[0]?.turnId).toBe(RESUME_TURN_ID);
    expect(resumed[0]?.spawnCallId).toBe(SPAWN_TOOL_USE_ID);

    // A background command starting under an unknown tool call is not an agent
    // and gets no row of its own.
    const unchanged = projectSubagentActivity(
      resumed,
      activity({
        id: "a4",
        kind: "task.started",
        payload: { taskId: "bash-1", toolUseId: "toolu_bash", taskType: "local_bash" },
      }),
    );
    expect(unchanged).toHaveLength(1);

    const finished = projectSubagentActivity(
      resumed,
      activity({
        id: "a5",
        kind: "task.completed",
        createdAt: "2026-08-15T00:20:00.000Z",
        payload: {
          taskId: "a34bb18edee269135",
          status: "completed",
          toolUseId: "toolu_01WaB14B6ivDH4qPhA5QhpDx",
        },
      }),
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]?.status).toBe("completed");
  });

  it("projects a failed Claude agent as failed, not running", () => {
    const roster = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.completed",
        status: "failed",
        turnId: TURN_ID,
      }),
    );

    expect(roster).toHaveLength(1);
    expect(roster[0]?.status).toBe("failed");
  });

  it("settles from a restart-synthesized completion that carries only the task id", () => {
    const spawned = projectSubagentActivity(
      [],
      claudeSpawnActivity({
        id: "a1",
        kind: "tool.started",
        status: "inProgress",
        turnId: TURN_ID,
      }),
    );
    const linked = projectSubagentActivity(
      spawned,
      activity({
        id: "a2",
        kind: "task.progress",
        payload: {
          taskId: "a46aeb71b8e19f84b",
          detail: "Running tests",
          toolUseId: SPAWN_TOOL_USE_ID,
          subagentType: "claude",
        },
      }),
    );

    const settled = projectSubagentActivity(
      linked,
      activity({
        id: "a3",
        kind: "task.completed",
        payload: { taskId: "a46aeb71b8e19f84b", status: "stopped" },
        createdAt: "2026-08-15T00:06:00.000Z",
      }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("interrupted");
  });

  it("coalesces a pending spawn with an id-keyed row instead of duplicating", () => {
    const codexItem = (item: Record<string, unknown>): OrchestrationThreadActivity =>
      activity({
        id: `codex-${String(item.id)}-${String(item.status)}`,
        kind: "tool.updated",
        turnId: TURN_ID,
        payload: { itemType: "collab_agent_tool_call", data: { item } },
      });

    // Spawn starts before the provider names the agent: a pending placeholder.
    const pending = projectSubagentActivity(
      [],
      codexItem({ id: "call-1", tool: "spawnAgent", status: "inProgress", prompt: "Review" }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("pending:call-1");

    // A wait item reveals the agent id first, as its own row.
    const revealed = projectSubagentActivity(
      pending,
      codexItem({
        id: "call-2",
        tool: "wait",
        status: "inProgress",
        receiverThreadIds: ["agent-x"],
      }),
    );
    expect(revealed).toHaveLength(2);

    // The spawn completion carries both keys. The two rows are the same agent;
    // leaving both behind would violate the roster table's unique constraints.
    const settled = projectSubagentActivity(
      revealed,
      codexItem({
        id: "call-1",
        tool: "spawnAgent",
        status: "completed",
        agentThreadId: "agent-x",
      }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.agentThreadId).toBe("agent-x");
    expect(settled[0]?.spawnCallId).toBe("call-1");
    expect(settled[0]?.objective).toBe("Review");
  });

  it("still folds Codex-shaped collab items", () => {
    const roster = projectSubagentActivity(
      [],
      activity({
        id: "a1",
        kind: "tool.updated",
        turnId: TURN_ID,
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              id: "call-1",
              tool: "spawnAgent",
              status: "inProgress",
              prompt: "Review the diff",
              agentThreadId: "agent-codex-1",
              receiverThreadIds: ["agent-codex-1"],
            },
          },
        },
      }),
    );

    expect(roster).toHaveLength(1);
    expect(roster[0]?.agentThreadId).toBe("agent-codex-1");
    expect(roster[0]?.spawnCallId).toBe("call-1");
  });
});
