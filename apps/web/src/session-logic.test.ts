import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveStatusLabel,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("keeps Codex permission approvals with environment identity", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-permissions",
        createdAt: "2026-06-04T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Permissions approval requested",
        tone: "approval",
        payload: {
          requestId: "req-permissions",
          requestType: "permissions_approval",
          environmentId: "env-remote",
          detail: "Requesting network access",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-permissions",
        requestKind: "permissions",
        createdAt: "2026-06-04T00:00:01.000Z",
        environmentId: "env-remote",
        detail: "Requesting network access",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending Codex approval request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail: "Unknown pending Codex user input request: req-user-input-stale-1",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-start"]);
  });

  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("shows thinking progress entries from provider reasoning summaries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: { summary: "Checking the event projection path" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Checking the event projection path");
    expect(entries[0]?.tone).toBe("thinking");
  });

  it("marks reasoning lifecycle activity as active thinking work", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "inProgress",
          detail: "Working through the next step",
          redacted: true,
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Thinking");
    expect(entries[0]?.detail).toBe("Working through the next step");
    expect(entries[0]?.tone).toBe("thinking");
    expect(entries[0]?.executionState).toBe("running");
  });

  it("adds inferred review context to generic thinking after a command", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-completed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          title: "Ran command",
          detail: "bun lint",
        },
      }),
      makeActivity({
        id: "thinking-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "inProgress",
          detail: "Working through the next step",
          redacted: true,
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[1]?.label).toBe("Thinking");
    expect(entries[1]?.detail).toBe("Reviewing command output");
  });

  it("collapses reasoning lifecycle rows and hides completed redacted thinking", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "inProgress",
          sourceItemType: "reasoning",
          detail: "Working through the next step",
          redacted: true,
        },
      }),
      makeActivity({
        id: "thinking-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "completed",
          sourceItemType: "reasoning",
          detail: "Working through the next step",
          redacted: true,
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(0);
  });

  it("keeps provider reasoning summary rows after completion", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "thinking-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "inProgress",
          reasoningItemId: "reasoning-1",
          detail: "Working through the next step",
          redacted: true,
        },
      }),
      makeActivity({
        id: "thinking-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "thinking.progress",
        summary: "Thinking",
        tone: "thinking",
        payload: {
          status: "completed",
          reasoningItemId: "reasoning-1",
          detail: "Checking the event projection path",
          summary: "Checking the event projection path",
          redacted: false,
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Checking the event projection path");
    expect(entries[0]?.executionState).toBe("completed");
  });

  it("collapses live command output updates into the active tool row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          title: "Ran command",
          detail: "bun lint",
        },
      }),
      makeActivity({
        id: "tool-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.output.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          status: "inProgress",
          title: "Command output",
          detail: "linting files",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-start");
    expect(entries[0]?.detail).toBe("linting files");
    expect(entries[0]?.executionState).toBe("running");
  });

  it("does not treat streamed command output as the command preview", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.output.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          status: "inProgress",
          title: "Command output",
          detail: "231: delta: string,\n232: ): BufferedActivityStream {",
          byteCount: 96,
          lineCount: 2,
          truncated: false,
          streamKind: "command_output",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBeUndefined();
    expect(entries[0]?.detail).toBe("2 output lines");
    expect(entries[0]?.executionState).toBe("running");
  });

  it("does not keep unpaired command output marked as running", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-output-unpaired",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.output.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Command output",
          detail: '"name":"threadlines-transition","description":"Threadlines fork separation"',
          byteCount: 128,
          lineCount: 1,
          truncated: false,
          streamKind: "command_output",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBeUndefined();
    expect(entries[0]?.detail).toBe("1 output line");
    expect(entries[0]?.executionState).toBeUndefined();
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("keeps activities from previous turns in the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1", "turn-2"]);
  });

  it("keeps generated image previews from previous turns", () => {
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "old-command",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        summary: "Ran command",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "old-image",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        summary: "Image view",
        kind: "tool.completed",
        payload: {
          itemType: "image_view",
          title: "Image view",
          data: {
            item: {
              id: "ig_old",
              result: imageBase64,
              savedPath: "C:\\Users\\wilfr\\.codex\\generated_images\\logo.png",
              type: "imageGeneration",
            },
          },
        },
      }),
      makeActivity({
        id: "new-command",
        createdAt: "2026-02-23T00:00:03.000Z",
        turnId: "turn-2",
        summary: "Ran command",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["old-command", "old-image", "new-command"]);
    expect(entries[1]?.images?.[0]).toMatchObject({
      id: "ig_old",
      name: "logo.png",
      previewUrl: `data:image/png;base64,${imageBase64}`,
    });
  });

  it("retains command output tail and exit code on the command row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Command run started",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          title: "Command run",
          detail: "rm does-not-exist.ts",
        },
      }),
      makeActivity({
        id: "tool-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.output.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          status: "inProgress",
          title: "Command output",
          detail:
            "rm: cannot remove 'does-not-exist.ts': No such file or directory\n<exited with exit code 1>",
          byteCount: 64,
          lineCount: 2,
          truncated: false,
          streamKind: "command_output",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outputPreview).toBe(
      "rm: cannot remove 'does-not-exist.ts': No such file or directory",
    );
    expect(entries[0]?.exitCode).toBe(1);
  });

  it("lifts the leading exit-code line out of Claude bash failure output", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-output",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.output.updated",
        summary: "Command output",
        payload: {
          itemType: "command_execution",
          toolCallId: "cmd-1",
          status: "inProgress",
          title: "Command output",
          detail: "Exit code 127\n/usr/bin/bash: line 1: Remove-Item: command not found",
          byteCount: 64,
          lineCount: 2,
          truncated: false,
          streamKind: "command_output",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outputPreview).toBe("/usr/bin/bash: line 1: Remove-Item: command not found");
    expect(entries[0]?.exitCode).toBe(127);
  });

  it("omits account rate-limit telemetry entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "rate-limits",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "account.rate-limits.updated",
        summary: "Rate limits updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("omits TodoWrite lifecycle entries covered by the plan progress UI", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "todo-write",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Update todos",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Update todos",
          detail: "1/3 · Wire stats into rows",
          data: { toolName: "TodoWrite", input: { todos: [] } },
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("omits task tracker tool entries covered by the plan progress UI", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-create",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Update tasks",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Update tasks",
          detail: "Add task: Wire stats into rows",
          data: { toolName: "TaskCreate", input: { subject: "Wire stats into rows" } },
        },
      }),
      makeActivity({
        id: "task-update",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Update tasks",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Update tasks",
          detail: "Task #1 completed",
          data: { toolName: "TaskUpdate", input: { taskId: "1", status: "completed" } },
        },
      }),
      makeActivity({
        id: "task-list",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tasks",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tasks",
          detail: "Task list",
          data: { toolName: "TaskList", input: {} },
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("collects Claude snake_case file paths and provider diff stats", () => {
    const filePath = "C:\\Users\\Will\\Desktop\\Projects\\badcode\\apps\\web\\src\\store.ts";
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-edit",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          toolCallId: "toolu_1",
          title: "File change",
          detail: "apps/web/src/store.ts",
          data: {
            toolName: "Edit",
            input: {
              file_path: filePath,
              old_string: "a",
              new_string: "b",
            },
            changes: [{ path: filePath, kind: "update", additions: 8, deletions: 1 }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changedFiles).toEqual([filePath]);
    expect(entries[0]?.changedFileStats).toEqual([
      { path: filePath, kind: "update", additions: 8, deletions: 1 },
    ]);
  });

  it("derives diff stats from Codex unified diff payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-patch",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          toolCallId: "item-1",
          title: "File change",
          data: {
            changes: [
              {
                path: "apps/web/src/store.ts",
                kind: { type: "update" },
                diff: [
                  "--- a/apps/web/src/store.ts",
                  "+++ b/apps/web/src/store.ts",
                  "@@ -1,3 +1,4 @@",
                  " context",
                  "-old line",
                  "+new line",
                  "+added line",
                ].join("\n"),
              },
            ],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changedFileStats).toEqual([
      { path: "apps/web/src/store.ts", kind: "update", additions: 2, deletions: 1 },
    ]);
  });

  it("does not treat read-only tool path arguments as changed files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-grep",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Search",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId: "toolu_2",
          title: "Search",
          detail: "formatActionHeading in apps/web/src",
          data: {
            toolName: "Grep",
            input: {
              pattern: "formatActionHeading",
              path: "C:\\Users\\Will\\Desktop\\Projects\\badcode\\apps\\web\\src",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changedFiles).toBeUndefined();
  });

  it("collapses repeated api-retry warnings into one updating row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "retry-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "warning",
        turnId: "turn-1",
        payload: {
          message: "Claude API rate limited, retrying in 4s (attempt 1/10)",
          warningKind: "api-retry",
        },
      }),
      makeActivity({
        id: "tool-between",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          detail: "bun test",
        },
      }),
      makeActivity({
        id: "retry-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "warning",
        turnId: "turn-1",
        payload: {
          message: "Claude API rate limited, retrying in 8s (attempt 2/10)",
          warningKind: "api-retry",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    const warningEntries = entries.filter((entry) => entry.tone === "warning");
    expect(warningEntries).toHaveLength(1);
    expect(warningEntries[0]?.label).toBe("Claude API rate limited, retrying in 8s (attempt 2/10)");
  });

  it("attaches a provider auth reconnect action to authentication runtime errors", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "claude-auth-error",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.error",
        summary: "Authentication required",
        tone: "error",
        turnId: "turn-1",
        payload: {
          provider: "claudeAgent",
          class: "authentication_error",
          message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
      }),
    ]);

    expect(entry?.authReconnect).toEqual({
      provider: "claudeAgent",
      command: "claude auth login",
      message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    });
  });

  it("attaches a Codex auth reconnect action to unauthenticated runtime errors", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "codex-auth-error",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.error",
        summary: "Runtime error",
        tone: "error",
        turnId: "turn-1",
        payload: {
          provider: "codex",
          class: "provider_error",
          message: "Not logged in Run `codex login` in a terminal, then retry.",
        },
      }),
    ]);

    expect(entry?.authReconnect).toEqual({
      provider: "codex",
      command: "codex login",
      message: "Not logged in Run `codex login` in a terminal, then retry.",
    });
  });

  it("renders tagged Codex stream retries without repeating the reconnect label", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "codex-retry",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "warning",
        turnId: "turn-1",
        payload: {
          message: "Reconnecting... 1/5",
          warningKind: "api-retry",
          detail: {
            error: {
              message: "Reconnecting... 1/5",
              additionalDetails:
                "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
            },
            willRetry: true,
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      id: "codex-retry",
      label: "Reconnecting... 1/5",
      detail:
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
      tone: "warning",
    });
  });

  it("keeps unrelated runtime warnings as separate rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "warning-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "warning",
        turnId: "turn-1",
        payload: { message: "Claude denied tool 'Bash'." },
      }),
      makeActivity({
        id: "warning-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "warning",
        turnId: "turn-1",
        payload: { message: "Claude denied tool 'WebFetch'." },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe("Runtime warning");
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts generated image previews from Codex image lifecycle payloads", () => {
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "image-generation-complete",
        kind: "tool.completed",
        summary: "Image view",
        payload: {
          itemType: "image_view",
          title: "Image view",
          data: {
            item: {
              id: "ig_123",
              result: imageBase64,
              savedPath: "C:\\Users\\wilfr\\.codex\\generated_images\\logo.png",
              status: "completed",
              type: "imageGeneration",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      itemType: "image_view",
      images: [
        {
          id: "ig_123",
          name: "logo.png",
          previewUrl: `data:image/png;base64,${imageBase64}`,
        },
      ],
    });
  });

  it("keeps thumbnails for image generation tools even when projected as dynamic calls", () => {
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "dynamic-image-generation-complete",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "image_gen",
          data: {
            item: {
              id: "ig_456",
              result: imageBase64,
              savedPath: "C:\\Users\\wilfr\\.codex\\generated_images\\badge.png",
              tool: "image_gen",
              type: "imageGeneration",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      itemType: "dynamic_tool_call",
      images: [
        {
          id: "ig_456",
          name: "badge.png",
          previewUrl: `data:image/png;base64,${imageBase64}`,
        },
      ],
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        turnId: "turn-file-change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
    expect(entry?.turnId).toBe(TurnId.make("turn-file-change"));
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-update",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-update",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("marks command tool updates as running and completed commands as terminal", () => {
    const runningEntries = deriveWorkLogEntries([
      makeActivity({
        id: "command-started",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-1",
          title: "Ran command",
          detail: "bun test",
        },
      }),
    ]);

    expect(runningEntries[0]).toMatchObject({
      id: "command-started",
      label: "Ran command started",
      toolTitle: "Ran command",
      executionState: "running",
    });

    const completedEntries = deriveWorkLogEntries([
      makeActivity({
        id: "command-started",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-1",
          title: "Ran command",
          detail: "bun test",
        },
      }),
      makeActivity({
        id: "command-running",
        kind: "tool.updated",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-1",
          title: "Ran command",
          data: {
            kind: "execute",
          },
        },
      }),
      makeActivity({
        id: "command-completed",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-1",
          title: "Ran command",
          data: {
            kind: "execute",
          },
        },
      }),
    ]);

    expect(completedEntries).toHaveLength(1);
    expect(completedEntries[0]).toMatchObject({
      id: "command-started",
      label: "Ran command",
      executionState: "completed",
    });
  });

  it("collapses command lifecycle events without tool call ids and preserves the command text", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "command-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          status: "inProgress",
          data: {
            item: {
              command: "bun run test src/session-logic.test.ts",
            },
          },
        },
      }),
      makeActivity({
        id: "command-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            item: {
              command: "bun run test src/session-logic.test.ts",
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "command-started",
      command: "bun run test src/session-logic.test.ts",
      executionState: "completed",
    });
  });

  it("collapses interleaved parallel command lifecycles by tool call id", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "command-a-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-a",
          title: "Ran command",
          data: {
            item: {
              command: "bun lint",
            },
          },
        },
      }),
      makeActivity({
        id: "command-b-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.started",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-b",
          title: "Ran command",
          data: {
            item: {
              command: "bun typecheck",
            },
          },
        },
      }),
      makeActivity({
        id: "command-b-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-b",
          title: "Ran command",
          data: {
            item: {
              command: "bun typecheck",
            },
          },
        },
      }),
      makeActivity({
        id: "command-a-completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "command-a",
          title: "Ran command",
          data: {
            item: {
              command: "bun lint",
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries).toMatchObject([
      {
        id: "command-a-started",
        command: "bun lint",
        executionState: "completed",
      },
      {
        id: "command-b-started",
        command: "bun typecheck",
        executionState: "completed",
      },
    ]);
  });

  it("shows running browser-style tool lifecycle rows with compact tool input", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "browser-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Tool call started",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          status: "inProgress",
          data: {
            item: {
              namespace: "browser",
              tool: "open",
              arguments: {
                url: "http://localhost:3000",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "browser-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            item: {
              namespace: "browser",
              tool: "open",
              arguments: {
                url: "http://localhost:3000",
              },
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "browser-started",
      toolTitle: "Browser control",
      detail: "Opening http://localhost:3000",
      executionState: "completed",
    });
  });

  it("labels Browser skill activity that is routed through node_repl.js", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "browser-node-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "MCP tool call started",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          status: "inProgress",
          data: {
            item: {
              server: "node_repl",
              tool: "js",
              arguments: {
                code: [
                  "const { setupBrowserRuntime } = await import('browser-client.mjs');",
                  "await setupBrowserRuntime({ globals: globalThis });",
                  "globalThis.browser = await agent.browsers.get('iab');",
                  "await tab.playwright.domSnapshot();",
                ].join("\n"),
              },
            },
          },
        },
      }),
      makeActivity({
        id: "browser-node-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "MCP tool call",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          data: {
            item: {
              server: "node_repl",
              tool: "js",
              arguments: {
                code: "await tab.playwright.domSnapshot();",
              },
            },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "browser-node-started",
      toolTitle: "Browser control",
      detail: "Inspecting page",
      executionState: "completed",
    });
  });

  it("labels non-browser node_repl.js calls as JavaScript REPL activity", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "node-repl-started",
        kind: "tool.started",
        summary: "MCP tool call started",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          status: "inProgress",
          data: {
            item: {
              server: "node_repl",
              tool: "js",
              arguments: {
                code: "console.log(process.version);",
              },
            },
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      id: "node-repl-started",
      toolTitle: "JavaScript REPL",
      detail: "Running JavaScript",
      executionState: "running",
    });
  });

  it("uses app-oriented labels for known MCP-backed providers", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "supabase-started",
        kind: "tool.started",
        summary: "MCP tool call started",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          status: "inProgress",
          data: {
            item: {
              server: "plugin:supabase:supabase",
              tool: "execute_sql",
              arguments: {
                query: "select 1",
              },
            },
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      id: "supabase-started",
      toolTitle: "Supabase",
      detail: "execute sql: query=select 1",
      executionState: "running",
    });
  });

  it("surfaces runtime warning messages as warning work-log details", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "runtime-warning",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Reconnecting... 5/5",
          detail: {
            error: {
              message: "Reconnecting... 5/5",
              additionalDetails:
                "stream disconnected before completion: websocket closed by server before response.completed",
            },
            willRetry: true,
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      id: "runtime-warning",
      label: "Runtime warning",
      detail:
        "Reconnecting... 5/5 - stream disconnected before completion: websocket closed by server before response.completed",
      tone: "warning",
    });
  });

  it("marks failed command executions distinctly", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "command-failed",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "error",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "command-1",
            kind: "execute",
          },
        },
      }),
    ]);

    expect(entry).toMatchObject({
      id: "command-failed",
      label: "Ran command",
      executionState: "failed",
    });
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-update",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-update-1",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-update", "tool-2-update"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("z-update-earlier");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.make("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "context-1",
        turnId: "turn-1",
        kind: "context-window.updated",
        summary: "Context window updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "compaction-1",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        tone: "info",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.make("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.make("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("keeps the session startup timestamp after the local send state clears", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "starting",
          activeTurnId: undefined,
          updatedAt: "2026-02-27T21:11:00.000Z",
        },
        null,
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("deriveActiveStatusLabel", () => {
  it("keeps running turn footer text generic while activity rows carry details", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "running",
        latestTurnId: TurnId.make("turn-1"),
        workLogEntries: [
          {
            id: "thinking",
            createdAt: "2026-02-23T00:00:02.000Z",
            label: "Checking event projection",
            tone: "thinking",
            turnId: TurnId.make("turn-1"),
          },
        ],
      }),
    ).toBe("Working");
  });

  it("keeps the generic live footer as working when no visible activity is available", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "running",
        latestTurnId: TurnId.make("turn-1"),
        workLogEntries: [],
      }),
    ).toBe("Working");
  });

  it("shows connecting while the first local draft turn is being sent", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "disconnected",
        workLogEntries: [],
        isSendBusy: true,
      }),
    ).toBe("Connecting");
  });

  it("keeps sending for an existing ready thread dispatch", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "ready",
        workLogEntries: [],
        isSendBusy: true,
      }),
    ).toBe("Sending");
  });

  it("shows explicit session startup after the server acknowledges a new turn", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "ready",
        workLogEntries: [],
        isSessionStarting: true,
      }),
    ).toBe("Starting session");
  });

  it("prioritizes pending approvals over generic running state", () => {
    expect(
      deriveActiveStatusLabel({
        phase: "running",
        workLogEntries: [],
        pendingApprovalCount: 1,
      }),
    ).toBe("Waiting for approval");
  });
});
