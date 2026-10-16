import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationWorkflowRun,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const THREAD = ThreadId.make("thread-workflow");

const run = (
  taskId: string,
  status: OrchestrationWorkflowRun["status"],
): OrchestrationWorkflowRun => ({
  taskId,
  runId: null,
  turnId: TurnId.make("turn-1"),
  toolCallId: null,
  owner: { participantId: null, providerInstanceId: ProviderInstanceId.make("claudeAgent") },
  name: "audit",
  description: null,
  status,
  statusReason: null,
  hiddenScript: false,
  startedAt: now,
  endedAt: status === "running" ? null : now,
  totalTokens: 0,
  totalToolCalls: 0,
  transcriptDir: null,
  scriptPath: null,
  summary: null,
  phases: [],
  agents: [],
  updatedAt: now,
});

// Only what the workflow rules read; the rest of a thread plays no part in them.
const readModelWith = (thread: Partial<OrchestrationThread>): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [{ id: THREAD, deletedAt: null, workflowRuns: [], ...thread }],
  }) as unknown as OrchestrationReadModel;

const stop = (
  taskId: string,
): Extract<OrchestrationCommand, { type: "thread.background-task.stop" }> => ({
  type: "thread.background-task.stop",
  commandId: CommandId.make(`cmd-stop-${taskId}`),
  threadId: THREAD,
  taskId,
  createdAt: now,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel }));

describe("decider workflow runs", () => {
  it("asks to stop a workflow run that is still running", async () => {
    const decided = await decide(
      stop("task-running"),
      readModelWith({ workflowRuns: [run("task-running", "running")] }),
    );
    expect(decided).toMatchObject({
      type: "thread.background-task-stop-requested",
      payload: { threadId: THREAD, taskId: "task-running" },
    });
  });

  it("refuses to stop a workflow run the thread never recorded", async () => {
    await expect(
      decide(stop("task-unknown"), readModelWith({ workflowRuns: [run("task-other", "running")] })),
    ).rejects.toThrow(/no workflow run 'task-unknown'/);
  });

  it("refuses to stop a workflow run that already ended", async () => {
    await expect(
      decide(stop("task-done"), readModelWith({ workflowRuns: [run("task-done", "completed")] })),
    ).rejects.toThrow(/already ended/);
  });

  it("records a workflow run update as the driver reported it", async () => {
    const patch = {
      taskId: "task-new",
      status: "running" as const,
      turnId: TurnId.make("turn-1"),
      owner: { participantId: null },
      agents: [{ index: 0, label: "scan", state: "queued" as const }],
    };
    const decided = await decide(
      {
        type: "thread.workflow-run.record",
        commandId: CommandId.make("cmd-record"),
        threadId: THREAD,
        patch,
        createdAt: now,
      },
      readModelWith({}),
    );
    expect(decided).toMatchObject({
      type: "thread.workflow-run-recorded",
      payload: { threadId: THREAD, patch, createdAt: now },
    });
  });

  it("refuses a revert while a workflow is still running, and allows it once it ended", async () => {
    const revert: OrchestrationCommand = {
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("cmd-revert"),
      threadId: THREAD,
      turnCount: 0,
      createdAt: now,
    };
    const thread = (status: OrchestrationWorkflowRun["status"]) =>
      readModelWith({
        participants: [],
        agentRequests: {
          open: [],
          hold: false,
          chainEpoch: 0,
          requestsSinceUser: 0,
          invitesPaused: false,
        },
        childRequests: { open: [] },
        parentThreadId: null,
        queuedFollowUps: [],
        workflowRuns: [run("task-a", status)],
      } as unknown as Partial<OrchestrationThread>);
    await expect(decide(revert, thread("running"))).rejects.toThrow(
      "A workflow is still running. Stop it first.",
    );
    await expect(decide(revert, thread("stopped"))).resolves.toMatchObject({
      type: "thread.checkpoint-revert-requested",
    });
  });
});
