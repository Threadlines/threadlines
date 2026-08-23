import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-checkout-switch");
const projectId = ProjectId.make("project-checkout-switch");
const workspaceRoot = "/repos/project";
const worktreeA = "/repos/project/.worktrees/feature-a";
const worktreeB = "/repos/project/.worktrees/feature-b";

function makeSession(input: {
  status: OrchestrationSession["status"];
  checkoutCwd?: string | null;
}): OrchestrationSession {
  return {
    threadId,
    status: input.status,
    providerName: "codex",
    providerSessionId: "session-1",
    providerThreadId: "provider-thread-1",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    ...(input.checkoutCwd !== undefined ? { checkoutCwd: input.checkoutCwd } : {}),
    updatedAt: now,
  };
}

function makeReadModel(input: {
  session: OrchestrationSession | null;
  effectiveCwd: string | null;
  worktreePath?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        kind: "workspace",
        title: "Checkout Switch Project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Checkout Switch Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature-a",
        worktreePath: input.worktreePath !== undefined ? input.worktreePath : worktreeA,
        effectiveCwd: input.effectiveCwd,
        ...(input.effectiveCwd !== null ? { effectiveCwdSource: "session" as const } : {}),
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
        session: input.session,
      },
    ],
  };
}

function metaUpdateCommand(input: {
  worktreePath?: string | null;
  title?: string;
}): Extract<OrchestrationCommand, { type: "thread.meta.update" }> {
  return {
    type: "thread.meta.update",
    commandId: CommandId.make("cmd-meta-update"),
    threadId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.worktreePath !== undefined
      ? { branch: "main", worktreePath: input.worktreePath }
      : {}),
  };
}

function sessionSetCommand(
  session: OrchestrationSession,
): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  return {
    type: "thread.session.set",
    commandId: CommandId.make("cmd-session-set"),
    threadId,
    session,
    createdAt: "2026-01-01T00:00:10.000Z",
  };
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  return Array.isArray(decided) ? decided : [decided];
}

describe("decider checkout switch effectiveCwd", () => {
  it("clears the stale effectiveCwd when a stopped thread's worktree changes", async () => {
    const events = await decide(
      metaUpdateCommand({ worktreePath: worktreeB }),
      makeReadModel({
        session: makeSession({ status: "stopped", checkoutCwd: worktreeA }),
        effectiveCwd: worktreeA,
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "thread.meta-updated" });
    expect(events[1]).toMatchObject({
      type: "thread.effective-cwd-set",
      payload: { threadId, effectiveCwd: null },
    });
    expect(events[1]?.causationEventId).toBe(events[0]?.eventId);
  });

  it("keeps the effectiveCwd while a live session still runs in the old checkout", async () => {
    const events = await decide(
      metaUpdateCommand({ worktreePath: worktreeB }),
      makeReadModel({
        session: makeSession({ status: "running", checkoutCwd: worktreeA }),
        effectiveCwd: worktreeA,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thread.meta-updated" });
  });

  it("keeps effectiveCwd when a branch-only update carries the unchanged worktree path", async () => {
    const events = await decide(
      metaUpdateCommand({ worktreePath: worktreeA }),
      makeReadModel({
        session: makeSession({ status: "stopped", checkoutCwd: worktreeA }),
        effectiveCwd: `${worktreeA}/packages/deep`,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thread.meta-updated" });
  });

  it("leaves effectiveCwd alone for meta updates that do not move the checkout", async () => {
    const events = await decide(
      metaUpdateCommand({ title: "Renamed" }),
      makeReadModel({ session: null, effectiveCwd: worktreeA }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thread.meta-updated" });
  });

  it("applies a queued switch when the session stops away from the thread checkout", async () => {
    const events = await decide(
      sessionSetCommand(makeSession({ status: "stopped", checkoutCwd: worktreeA })),
      makeReadModel({
        session: makeSession({ status: "running", checkoutCwd: worktreeA }),
        effectiveCwd: worktreeA,
        worktreePath: worktreeB,
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "thread.session-set" });
    expect(events[1]).toMatchObject({
      type: "thread.effective-cwd-set",
      payload: { threadId, effectiveCwd: null },
    });
  });

  it("keeps a cwd-follow effectiveCwd when the session stops in its own checkout", async () => {
    const events = await decide(
      sessionSetCommand(makeSession({ status: "stopped", checkoutCwd: worktreeA })),
      makeReadModel({
        session: makeSession({ status: "running", checkoutCwd: worktreeA }),
        effectiveCwd: `${worktreeA}/packages/deep`,
        worktreePath: worktreeA,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thread.session-set" });
  });
});
