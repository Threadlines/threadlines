import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-inbox");

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-inbox"),
        title: "Inbox Thread",
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
        doneOverride: null,
        lastSeenAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        diffStatBaselineTurnCount: 0,
        session: null,
      },
    ],
  };
}

describe("decider inbox lifecycle", () => {
  it("stores the client's stamp verbatim so the inbox can weigh it against activity", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.done-override.set",
          commandId: CommandId.make("cmd-done-override"),
          threadId,
          state: "done",
          at: "2026-01-02T09:30:00.000Z",
        },
        readModel: makeReadModel(),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.done-override-set",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: { threadId, state: "done", at: "2026-01-02T09:30:00.000Z" },
    });
    // Filing a thread is not work on it: an `updatedAt` here would make the
    // override look fresher than the activity it is supposed to be judged
    // against, and would restart the auto-wrap idle clock.
    expect(event?.payload).not.toHaveProperty("updatedAt");
  });

  it("accepts a seen stamp that moves backwards, which is how mark-unread works", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.seen.set",
          commandId: CommandId.make("cmd-seen-backwards"),
          threadId,
          at: "1999-01-01T00:00:00.000Z",
        },
        readModel: makeReadModel(),
      }),
    );
    const event = Array.isArray(decided) ? decided[0] : decided;

    expect(event).toMatchObject({
      type: "thread.seen-set",
      payload: { threadId, at: "1999-01-01T00:00:00.000Z" },
    });
    expect(event?.payload).not.toHaveProperty("updatedAt");
  });

  it("rejects filing a thread that does not exist", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.done-override.set",
            commandId: CommandId.make("cmd-done-missing"),
            threadId: ThreadId.make("thread-missing"),
            state: "done",
            at: now,
          },
          readModel: makeReadModel(),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });
});
