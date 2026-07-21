import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";

function makeProposedPlan(
  overrides?: Partial<OrchestrationProposedPlan>,
): OrchestrationProposedPlan {
  return {
    id: "plan-1",
    turnId: TurnId.make("turn-plan"),
    planMarkdown: "# Ship it\n\n- step 1",
    implementedAt: null,
    implementationThreadId: null,
    dismissedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeReadModel(proposedPlan: OrchestrationProposedPlan): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-plan"),
        projectId: ProjectId.make("project-plan"),
        title: "Plan Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [proposedPlan],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

function dismissCommand(
  planId: string,
): Extract<OrchestrationCommand, { type: "thread.proposed-plan.dismiss" }> {
  return {
    type: "thread.proposed-plan.dismiss",
    commandId: CommandId.make("cmd-plan-dismiss"),
    threadId: ThreadId.make("thread-plan"),
    planId,
    createdAt: "2026-01-01T00:00:10.000Z",
  };
}

describe("decider proposed-plan dismissal", () => {
  it("marks an actionable plan dismissed while preserving its content", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: dismissCommand("plan-1"),
        readModel: makeReadModel(makeProposedPlan()),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.proposed-plan-upserted",
      payload: {
        threadId: ThreadId.make("thread-plan"),
        proposedPlan: {
          id: "plan-1",
          planMarkdown: "# Ship it\n\n- step 1",
          implementedAt: null,
          dismissedAt: "2026-01-01T00:00:10.000Z",
          updatedAt: "2026-01-01T00:00:10.000Z",
        },
      },
    });
  });

  it("keeps the original dismissal timestamp when dismissed twice", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: dismissCommand("plan-1"),
        readModel: makeReadModel(makeProposedPlan({ dismissedAt: "2026-01-01T00:00:05.000Z" })),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.proposed-plan-upserted",
      payload: {
        proposedPlan: {
          dismissedAt: "2026-01-01T00:00:05.000Z",
        },
      },
    });
  });

  it("rejects dismissing an already implemented plan", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: dismissCommand("plan-1"),
          readModel: makeReadModel(
            makeProposedPlan({
              implementedAt: "2026-01-01T00:00:05.000Z",
              implementationThreadId: ThreadId.make("thread-impl"),
            }),
          ),
        }),
      ),
    ).rejects.toThrow("already implemented");
  });

  it("rejects dismissing a plan that does not exist", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: dismissCommand("plan-missing"),
          readModel: makeReadModel(makeProposedPlan()),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });
});
