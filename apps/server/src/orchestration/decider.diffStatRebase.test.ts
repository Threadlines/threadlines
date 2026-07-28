import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-diffstat");

function makeReadModel(diffStatBaselineTurnCount: number): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-diffstat"),
        title: "Diff Stat Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
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
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        diffStatBaselineTurnCount,
        session: null,
      },
    ],
  };
}

function rebaseCommand(input: {
  baselineTurnCount: number;
  threadId?: ThreadId;
}): Extract<OrchestrationCommand, { type: "thread.diffstat.rebase" }> {
  return {
    type: "thread.diffstat.rebase",
    commandId: CommandId.make("cmd-diffstat-rebase"),
    threadId: input.threadId ?? threadId,
    baselineTurnCount: input.baselineTurnCount,
    createdAt: "2026-01-01T00:00:10.000Z",
  };
}

describe("decider diff-stat rebase", () => {
  it("emits a rebase event when the baseline moves forward", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: rebaseCommand({ baselineTurnCount: 4 }),
        readModel: makeReadModel(2),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.diffstat-rebased",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        baselineTurnCount: 4,
        occurredAt: "2026-01-01T00:00:10.000Z",
      },
    });
  });

  // A checkout that simply stays clean re-derives the same baseline on every
  // status refresh. If that were accepted, the event log would grow by one
  // event per poll per thread forever.
  it("rejects a baseline that repeats the current one", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: rebaseCommand({ baselineTurnCount: 3 }),
          readModel: makeReadModel(3),
        }),
      ),
    );

    expect(failure.commandType).toBe("thread.diffstat.rebase");
    expect(failure.detail).toContain("cannot move to 3");
  });

  it("rejects a baseline that would walk the rollup backwards", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: rebaseCommand({ baselineTurnCount: 1 }),
          readModel: makeReadModel(5),
        }),
      ),
    );

    expect(failure.commandType).toBe("thread.diffstat.rebase");
    expect(failure.detail).toContain("cannot move to 1");
  });

  it("rejects a rebase for a thread that does not exist", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: rebaseCommand({
            baselineTurnCount: 2,
            threadId: ThreadId.make("thread-missing"),
          }),
          readModel: makeReadModel(0),
        }),
      ),
    );

    expect(failure.commandType).toBe("thread.diffstat.rebase");
    expect(failure.detail).toContain("thread-missing");
  });
});
