import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveOrchestrationBatchEffects,
  serverMergeSwitchTurnedOff,
} from "./orchestrationEventEffects";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.make("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("deriveOrchestrationBatchEffects", () => {
  it("targets draft promotion and terminal cleanup from thread lifecycle events", () => {
    const createdThreadId = ThreadId.make("thread-created");
    const deletedThreadId = ThreadId.make("thread-deleted");
    const archivedThreadId = ThreadId.make("thread-archived");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.created", {
        threadId: createdThreadId,
        projectId: ProjectId.make("project-1"),
        title: "Created thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeEvent("thread.deleted", {
        threadId: deletedThreadId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.archived", {
        threadId: archivedThreadId,
        archivedAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.promoteDraftThreadIds).toEqual([createdThreadId]);
    expect(effects.clearDeletedThreadIds).toEqual([deletedThreadId]);
    expect(effects.removeTerminalStateThreadIds).toEqual([deletedThreadId, archivedThreadId]);
    expect(effects.needsProviderInvalidation).toBe(false);
  });

  it("keeps only the final lifecycle outcome for a thread within one batch", () => {
    const threadId = ThreadId.make("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.deleted", {
        threadId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.created", {
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Recreated thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("thread.turn-diff-completed", {
        threadId,
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
    ]);

    expect(effects.promoteDraftThreadIds).toEqual([threadId]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.needsProviderInvalidation).toBe(true);
  });

  it("does not retain archive cleanup when a thread is unarchived later in the same batch", () => {
    const threadId = ThreadId.make("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.archived", {
        threadId,
        archivedAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.unarchived", {
        threadId,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.promoteDraftThreadIds).toEqual([]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
  });

  it("re-reads pull requests only when a thread's server-held merge switch turns off", () => {
    const threadId = ThreadId.make("thread-1");
    const automation = (
      payload: Omit<
        Extract<OrchestrationEvent, { type: "thread.pull-request-automation-changed" }>["payload"],
        "threadId" | "updatedAt"
      >,
    ) =>
      deriveOrchestrationBatchEffects([
        makeEvent("thread.pull-request-automation-changed", {
          threadId,
          updatedAt: "2026-02-27T00:00:01.000Z",
          ...payload,
        }),
      ]).needsPullRequestInvalidation;

    // The server turns it off once it has merged, queued, or given up.
    expect(automation({ autoMerge: null })).toBe(true);
    expect(automation({ autoMerge: "squash" })).toBe(false);
    expect(automation({ autoFix: false })).toBe(false);
  });
});

describe("serverMergeSwitchTurnedOff", () => {
  const url = "https://github.com/acme/widgets/pull/294";

  it("sees the thread's own switch or a linked pull request's going off, not coming on", () => {
    expect(
      serverMergeSwitchTurnedOff(
        { pullRequestAutoMerge: "squash" },
        { pullRequestAutoMerge: null },
      ),
    ).toBe(true);
    expect(
      serverMergeSwitchTurnedOff(
        { linkedPullRequests: [{ number: 294, url, autoMerge: "squash" }] },
        { linkedPullRequests: [{ number: 294, url, autoMerge: null }] },
      ),
    ).toBe(true);
    expect(
      serverMergeSwitchTurnedOff(
        { linkedPullRequests: [{ number: 294, url, autoMerge: null }] },
        { linkedPullRequests: [{ number: 294, url, autoMerge: "squash" }] },
      ),
    ).toBe(false);
    // A thread the client is seeing for the first time has nothing to compare.
    expect(serverMergeSwitchTurnedOff(undefined, { pullRequestAutoMerge: null })).toBe(false);
  });
});
