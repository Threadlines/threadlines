import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import {
  AgentPageId,
  AgentPageVersionId,
  CheckpointRef,
  type OrchestrationWorkflowRunPatch,
  ChildRequestBatchId,
  ChildRequestId,
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RoomAgentRequestId,
  SideTurnId,
  ThreadId,
  ThreadParticipantId,
  ThreadMoveId,
  TurnId,
  OrchestrationThread,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import { deriveSubagentActivityState, deriveTimelineEntries } from "./session-logic";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  onProjectRemoved,
  removeEnvironmentState,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadExistsByRef,
  selectSidebarThreadsForProjectRef,
  restoreThreadCheckout,
  selectThreadCheckout,
  setThreadBranch,
  selectThreadsAcrossEnvironments,
  selectRunningSidebarThreadsAcrossEnvironments,
  selectRunningSidebarThreadsByLocation,
  selectThreadDetailLoaded,
  markThreadDetailUnloaded,
  setScheduleApprovalThreads,
  syncServerThreadDetail,
  type AppState,
  type EnvironmentState,
  useStore,
} from "./store";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_COMPOSER_RUNTIME_MODE,
  type SidebarThreadSummary,
  type Thread,
  type ThreadSession,
} from "./types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
/** A shell no other thread started, with no threads of its own. */
const NO_CHILD_THREAD_SHELL_FIELDS = {
  parentThreadId: null,
  parentTurnId: null,
  attachedToParent: false,
  handedBackAt: null,
  handedBackTurnId: null,
  awaitedChildThreadCount: 0,
  pendingChildApproval: false,
} as const;

function withActiveEnvironmentState(
  environmentState: EnvironmentState,
  overrides: Partial<AppState & EnvironmentState> = {},
): AppState {
  const {
    activeEnvironmentId: overrideActiveEnvironmentId,
    environmentStateById: overrideEnvironmentStateById,
    ...environmentOverrides
  } = overrides;
  const activeEnvironmentId = overrideActiveEnvironmentId ?? localEnvironmentId;
  const mergedEnvironmentState = {
    ...environmentState,
    ...environmentOverrides,
  };
  const environmentStateById =
    overrideEnvironmentStateById ??
    (activeEnvironmentId
      ? {
          [activeEnvironmentId]: mergedEnvironmentState,
        }
      : {});

  return {
    activeEnvironmentId,
    environmentStateById,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    pullRequestAutoFix: false,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    voiceActive: false,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.make("project-1");
  const project = {
    id: projectId,
    environmentId: thread.environmentId,
    kind: "workspace" as const,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: EnvironmentState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  const environmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        error: thread.error,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        pinnedAt: thread.pinnedAt,
        doneOverride: thread.doneOverride,
        lastSeenAt: thread.lastSeenAt,
        updatedAt: thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        effectiveCwd: thread.effectiveCwd,
        goal: null,
        voiceActive: thread.voiceActive ?? false,
        diffStatBaselineTurnCount: thread.diffStatBaselineTurnCount ?? 0,
      },
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messagesByThreadId: {
      [thread.id]: thread.messages,
    },
    activitiesByThreadId: {
      [thread.id]: thread.activities,
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as EnvironmentState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
    },
    agentRequestsByThreadId: {},
    childRequestsByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, {
    activeEnvironmentId: thread.environmentId,
  });
}

function makeEmptyState(overrides: Partial<AppState & EnvironmentState> = {}): AppState {
  const environmentState: EnvironmentState = {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messagesByThreadId: {},
    activitiesByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    agentRequestsByThreadId: {},
    childRequestsByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, overrides);
}

function localEnvironmentStateOf(state: AppState): EnvironmentState {
  return selectEnvironmentState(state, localEnvironmentId);
}

function environmentStateOf(state: AppState, environmentId: EnvironmentId): EnvironmentState {
  return selectEnvironmentState(state, environmentId);
}

function projectsOf(state: AppState) {
  return selectProjectsAcrossEnvironments(state);
}

function threadsOf(state: AppState) {
  return selectThreadsAcrossEnvironments(state);
}

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

describe("environment state removal", () => {
  it("drops local state for removed environments", () => {
    const removedThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-removed"),
    });
    const keptThread = makeThread({ id: ThreadId.make("thread-kept") });
    const removedState = makeState(removedThread).environmentStateById[remoteEnvironmentId]!;
    const keptState = makeState(keptThread).environmentStateById[localEnvironmentId]!;
    const state: AppState = {
      activeEnvironmentId: remoteEnvironmentId,
      environmentStateById: {
        [remoteEnvironmentId]: removedState,
        [localEnvironmentId]: keptState,
      },
    };

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next.activeEnvironmentId).toBeNull();
    expect(next.environmentStateById[remoteEnvironmentId]).toBeUndefined();
    expect(next.environmentStateById[localEnvironmentId]).toBe(keptState);
  });

  it("preserves active environment when removing a different environment", () => {
    const state = makeState(makeThread());

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next).toBe(state);
  });
});

const decodeOrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread);

describe("thread detail loaded", () => {
  const threadId = ThreadId.make("thread-1");
  const threadRef = scopeThreadRef(localEnvironmentId, threadId);
  const detail = decodeOrchestrationThread({
    id: threadId,
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  });

  it("counts a thread's history as loaded only from its detail snapshot", () => {
    // A streamed event fills the thread's messages too, but only partly.
    const fromEvents = applyOrchestrationEvent(
      makeState(makeThread()),
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.make("message-1"),
        role: "assistant",
        text: "Done.",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );
    expect(selectThreadDetailLoaded(fromEvents, threadRef)).toBe(false);

    const loaded = syncServerThreadDetail(fromEvents, detail, localEnvironmentId);
    expect(selectThreadDetailLoaded(loaded, threadRef)).toBe(true);
    // Its detail feed ended, or the thread is gone: no longer known whole.
    expect(selectThreadDetailLoaded(markThreadDetailUnloaded(loaded, threadRef), threadRef)).toBe(
      false,
    );
    const deleted = applyOrchestrationEvent(
      loaded,
      makeEvent("thread.deleted", { threadId, deletedAt: "2026-02-27T00:00:03.000Z" }),
      localEnvironmentId,
    );
    expect(selectThreadDetailLoaded(deleted, threadRef)).toBe(false);
  });
});

describe("project removal listeners", () => {
  it("hears a project the environment deleted, and nothing else", () => {
    const heard: string[] = [];
    const stop = onProjectRemoved((_environmentId, projectId) => heard.push(projectId));
    try {
      // A project arriving or changing (as when two in one folder are merged)
      // is not a deletion; only the deletion event is.
      useStore.getState().applyShellEvent(
        {
          kind: "project-upserted",
          sequence: 1,
          project: {
            id: ProjectId.make("project-kept"),
            kind: "workspace",
            title: "Kept",
            workspaceRoot: "/tmp/kept",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        },
        localEnvironmentId,
      );
      useStore
        .getState()
        .applyShellEvent(
          { kind: "project-removed", sequence: 2, projectId: ProjectId.make("project-gone") },
          localEnvironmentId,
        );
    } finally {
      stop();
    }
    expect(heard).toEqual(["project-gone"]);
  });
});

describe("thread selection memoization", () => {
  it("returns stable thread references for repeated reads of the same state", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "working",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-13T00:01:30.000Z",
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "plan",
          implementedAt: null,
          implementationThreadId: null,
          dismissedAt: null,
          createdAt: "2026-02-13T00:02:00.000Z",
          updatedAt: "2026-02-13T00:02:00.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-13T00:03:00.000Z",
          files: [],
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(state, ref);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.messages).toBe(first?.messages);
    expect(second?.activities).toBe(first?.activities);
    expect(second?.proposedPlans).toBe(first?.proposedPlans);
    expect(second?.turnDiffSummaries).toBe(first?.turnDiffSummaries);
  });

  it("reuses the derived thread when the app state wrapper changes but thread data does not", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "done",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const wrappedState: AppState = {
      ...state,
      environmentStateById: { ...state.environmentStateById },
    };

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(wrappedState, ref);

    expect(second).toBe(first);
  });

  it("updates the derived thread when the underlying thread data changes", () => {
    const thread = makeThread();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const firstState = makeState(thread);
    const secondState = makeState({
      ...thread,
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "user",
          text: "new",
          createdAt: "2026-02-13T00:04:00.000Z",
          streaming: false,
        },
      ],
    });

    const first = selectThreadByRef(firstState, ref);
    const second = selectThreadByRef(secondState, ref);

    expect(second).not.toBe(first);
    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).toBe("new");
  });

  it("checks thread existence without materializing the full thread", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    expect(selectThreadExistsByRef(state, ref)).toBe(true);
    expect(
      selectThreadExistsByRef(
        state,
        scopeThreadRef(thread.environmentId, ThreadId.make("missing")),
      ),
    ).toBe(false);
    expect(selectThreadExistsByRef(state, null)).toBe(false);
  });
});

describe("setThreadBranch", () => {
  it("an explicit main selection replaces a followed worktree immediately", () => {
    const thread = makeThread({
      branch: "main",
      worktreePath: null,
      effectiveCwd: "/tmp/project-worktree",
    });
    const state = makeState(thread);
    const threadRef = scopeThreadRef(localEnvironmentId, thread.id);

    const next = selectThreadCheckout(state, threadRef, "main", null);
    const shell = environmentStateOf(next, localEnvironmentId).threadShellById[thread.id];
    expect(shell?.branch).toBe("main");
    expect(shell?.worktreePath).toBeNull();
    expect(shell?.effectiveCwd).toBeNull();
  });

  it("updates only the scoped thread environment", () => {
    const sharedThreadId = ThreadId.make("thread-shared");
    const localThread = makeThread({
      id: sharedThreadId,
      environmentId: localEnvironmentId,
      branch: "local-branch",
    });
    const remoteThread = makeThread({
      id: sharedThreadId,
      environmentId: remoteEnvironmentId,
      branch: "remote-branch",
    });
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: environmentStateOf(makeState(localThread), localEnvironmentId),
        [remoteEnvironmentId]: environmentStateOf(makeState(remoteThread), remoteEnvironmentId),
      },
    };

    const next = setThreadBranch(
      state,
      scopeThreadRef(remoteEnvironmentId, sharedThreadId),
      "remote-next",
      "/tmp/remote-worktree",
    );

    expect(
      environmentStateOf(next, localEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("local-branch");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("remote-next");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.worktreePath,
    ).toBe("/tmp/remote-worktree");
  });

  it("restoreThreadCheckout brings back the session an optimistic switch cleared", () => {
    const session: ThreadSession = {
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      orchestrationStatus: "running",
      checkoutCwd: "/tmp/worktree-a",
      createdAt: "2026-02-13T00:00:00.000Z",
      updatedAt: "2026-02-13T00:00:00.000Z",
    };
    const thread = makeThread({
      branch: "feature-a",
      worktreePath: "/tmp/worktree-a",
      effectiveCwd: "/tmp/worktree-a",
      session,
    });
    const state = makeState(thread);
    const threadRef = scopeThreadRef(localEnvironmentId, thread.id);

    const afterOptimistic = selectThreadCheckout(state, threadRef, "main", null);
    expect(
      environmentStateOf(afterOptimistic, localEnvironmentId).threadSessionById[thread.id],
    ).toBeNull();
    expect(
      environmentStateOf(afterOptimistic, localEnvironmentId).threadShellById[thread.id]
        ?.effectiveCwd,
    ).toBeNull();

    const restored = restoreThreadCheckout(afterOptimistic, threadRef, {
      branch: "feature-a",
      worktreePath: "/tmp/worktree-a",
      effectiveCwd: "/tmp/worktree-a",
      session,
    });
    const shell = environmentStateOf(restored, localEnvironmentId).threadShellById[thread.id];
    expect(shell?.branch).toBe("feature-a");
    expect(shell?.worktreePath).toBe("/tmp/worktree-a");
    expect(shell?.effectiveCwd).toBe("/tmp/worktree-a");
    expect(environmentStateOf(restored, localEnvironmentId).threadSessionById[thread.id]).toEqual(
      session,
    );
  });
});

describe("incremental orchestration updates", () => {
  it("preserves message order through clock rollback and streaming updates", () => {
    const thread = makeThread();
    const before = "2026-02-27T00:10:00.000Z";
    const after = "2026-02-27T00:05:00.000Z";
    let state = makeState(thread);
    const messages = [
      { id: "first", role: "user", text: "Start", createdAt: before, streaming: false },
      { id: "reply", role: "assistant", text: "Working", createdAt: before, streaming: true },
      { id: "follow-up", role: "user", text: "Continue", createdAt: after, streaming: false },
      { id: "reply", role: "assistant", text: "Done", createdAt: after, streaming: false },
    ] as const;
    for (const [index, message] of messages.entries()) {
      state = applyOrchestrationEvent(
        state,
        makeEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.make(message.id),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
            streaming: message.streaming,
            turnId: null,
          },
          { sequence: index + 10 },
        ),
        localEnvironmentId,
      );
    }
    const result = threadsOf(state)[0]!;
    const timeline = deriveTimelineEntries(result.messages, [], []);
    expect(timeline.map((entry) => entry.eventSequence)).toEqual([10, 11, 12]);
    expect(result.messages.map((message) => message.id)).toEqual(["first", "reply", "follow-up"]);
    expect(result.messages[1]).toMatchObject({ text: "Done", streaming: false, createdAt: before });
  });

  it("merges a workflow run's updates, and drops runs of turns a revert took back", () => {
    const threadId = ThreadId.make("thread-1");
    const record = (
      sequence: number,
      turnId: string,
      patch: Omit<OrchestrationWorkflowRunPatch, "turnId">,
    ) =>
      makeEvent(
        "thread.workflow-run-recorded",
        {
          threadId,
          patch: { ...patch, turnId: TurnId.make(turnId) },
          createdAt: "2026-02-27T00:00:00.000Z",
        },
        { sequence },
      );
    const summary = (turnId: string, checkpointTurnCount: number) => ({
      turnId: TurnId.make(turnId),
      completedAt: "2026-02-27T00:00:01.000Z",
      status: "ready" as const,
      checkpointTurnCount,
      checkpointRef: CheckpointRef.make(`ref-${checkpointTurnCount}`),
      files: [],
    });
    let state = makeState(
      makeThread({ turnDiffSummaries: [summary("turn-1", 1), summary("turn-2", 2)] }),
    );
    for (const event of [
      record(1, "turn-1", {
        taskId: "task-a",
        name: "review-changes",
        startedAt: "2026-02-27T00:00:00.000Z",
        agents: [
          { index: 0, label: "review:a", state: "running" },
          { index: 1, label: "review:b", state: "running" },
        ],
      }),
      record(2, "turn-1", {
        taskId: "task-a",
        status: "completed",
        agents: [{ index: 1, label: "review:b", state: "done" }],
      }),
      record(3, "turn-2", { taskId: "task-b", startedAt: "2026-02-27T00:00:02.000Z" }),
    ]) {
      state = applyOrchestrationEvent(state, event, localEnvironmentId);
    }

    const [first] = threadsOf(state)[0]?.workflowRuns ?? [];
    expect(first).toMatchObject({ taskId: "task-a", status: "completed" });
    // The run's end cut off the agent still going.
    expect(first?.agents.map((agent) => agent.state)).toEqual(["skipped", "done"]);

    const reverted = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", { threadId, turnCount: 1 }, { sequence: 4 }),
      localEnvironmentId,
    );
    expect(threadsOf(reverted)[0]?.workflowRuns?.map((run) => run.taskId)).toEqual(["task-a"]);
  });

  it("projects realtime voice state into thread detail and shell state", () => {
    const state = makeState(makeThread());

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.realtime-state-set", {
        threadId: ThreadId.make("thread-1"),
        active: true,
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.voiceActive).toBe(true);
    expect(
      localEnvironmentStateOf(next).threadShellById[ThreadId.make("thread-1")]?.voiceActive,
    ).toBe(true);
  });

  it("projects an observed cwd change into the sidebar thread summary", () => {
    const state = makeState(makeThread());

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.effective-cwd-set", {
        threadId: ThreadId.make("thread-1"),
        effectiveCwd: "/tmp/project/.worktrees/feature",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    // Sidebar rows and status chips resolve their git cwd from the summary, so
    // dropping this field points them at the configured checkout instead of the
    // worktree the session actually moved into.
    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.effectiveCwd,
    ).toBe("/tmp/project/.worktrees/feature");
  });

  it("records a linked pull request and its own switches, apart from the thread's", () => {
    const threadId = ThreadId.make("thread-1");
    const url = "https://github.com/acme/widgets/pull/294";
    const linked = applyOrchestrationEvent(
      makeState(makeThread()),
      makeEvent("thread.pull-request-linked", {
        threadId,
        number: 294,
        url,
        linkedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const armed = applyOrchestrationEvent(
      linked,
      makeEvent("thread.pull-request-automation-changed", {
        threadId,
        pullRequestNumber: 294,
        autoMerge: "squash",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    // Each switch is set on its own and leaves the other as it was.
    const fixing = applyOrchestrationEvent(
      armed,
      makeEvent("thread.pull-request-automation-changed", {
        threadId,
        pullRequestNumber: 294,
        autoFix: true,
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
      localEnvironmentId,
    );

    const expected = [{ number: 294, url, autoFix: true, autoMerge: "squash" }];
    expect(threadsOf(fixing)[0]?.linkedPullRequests).toEqual(expected);
    expect(threadsOf(fixing)[0]?.pullRequestAutoMerge).toBeNull();
    expect(threadsOf(fixing)[0]?.pullRequestAutoFix).toBe(false);
    // The sidebar files a thread away only once these land too, so its summary carries them.
    expect(
      localEnvironmentStateOf(fixing).sidebarThreadSummaryById[threadId]?.linkedPullRequests,
    ).toEqual(expected);
  });

  it("keeps an async question answerable after its activity leaves the recent log", () => {
    const threadId = ThreadId.make("thread-1");
    const requested = applyOrchestrationEvent(
      makeState(makeThread()),
      makeEvent("thread.activity-appended", {
        threadId,
        activity: {
          id: EventId.make("question-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Question",
          payload: {
            requestId: "async-question",
            isBlocking: false,
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Which option?",
                options: [{ label: "First", description: "Use the first" }],
              },
            ],
          },
          turnId: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(requested).sidebarThreadSummaryById[threadId]).toMatchObject({
      hasPendingUserInput: true,
      hasBlockingUserInput: false,
    });

    const working = applyOrchestrationEvents(
      requested,
      Array.from({ length: MAX_THREAD_ACTIVITIES + 5 }, (_, index) =>
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.make(`working-${index}`),
            tone: "info",
            kind: "runtime.note",
            summary: "Still working",
            payload: {},
            turnId: null,
            createdAt: "2026-09-05T00:00:01.000Z",
          },
        }),
      ),
      localEnvironmentId,
    );
    expect(threadsOf(working)[0]?.activities).toHaveLength(MAX_THREAD_ACTIVITIES + 1);
    expect(threadsOf(working)[0]?.activities[0]?.id).toBe("question-requested");
    expect(localEnvironmentStateOf(working).sidebarThreadSummaryById[threadId]).toMatchObject({
      hasPendingUserInput: true,
      hasBlockingUserInput: false,
    });

    const resolved = applyOrchestrationEvent(
      working,
      makeEvent("thread.activity-appended", {
        threadId,
        activity: {
          id: EventId.make("question-resolved"),
          tone: "info",
          kind: "user-input.resolved",
          summary: "Answered",
          payload: { requestId: "async-question" },
          turnId: null,
          createdAt: "2026-09-05T00:00:02.000Z",
        },
      }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(resolved).sidebarThreadSummaryById[threadId]).toMatchObject({
      hasPendingUserInput: false,
      hasBlockingUserInput: false,
    });
    expect(threadsOf(resolved)[0]?.activities).toHaveLength(MAX_THREAD_ACTIVITIES);
  });

  it("keeps naming an agent after its spawn leaves the recent activity log", () => {
    const threadId = ThreadId.make("thread-1");
    const toolUseId = "toolu_competitor_research";
    const taskId = "a183626e8dc569a78";
    const activityEvent = (id: string, kind: string, payload: unknown, sequence: number) =>
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.make(id),
            tone: "tool",
            kind,
            summary: "Subagent task",
            payload,
            turnId: null,
            createdAt: "2026-10-18T08:09:00.000Z",
          },
        },
        { sequence },
      );
    // Claude's Agent tool call, then the task stream that links its task id.
    const spawned = applyOrchestrationEvents(
      makeState(makeThread()),
      [
        activityEvent(
          "spawn",
          "tool.started",
          {
            itemType: "collab_agent_tool_call",
            toolCallId: toolUseId,
            status: "inProgress",
            title: "Subagent task",
            data: {
              toolName: "Agent",
              input: { description: "Competitor research", subagent_type: "general-purpose" },
            },
          },
          1,
        ),
        activityEvent("task-start", "task.started", { taskId, toolUseId }, 2),
      ],
      localEnvironmentId,
    );
    // A long-running agent's own progress pushes its spawn out of the window.
    const working = applyOrchestrationEvents(
      spawned,
      Array.from({ length: MAX_THREAD_ACTIVITIES + 5 }, (_, index) =>
        activityEvent(`progress-${index}`, "task.progress", { taskId, toolUseId }, index + 3),
      ),
      localEnvironmentId,
    );
    const thread = threadsOf(working)[0]!;
    expect(thread.activities.map((activity) => activity.id)).not.toContain("spawn");
    expect(
      deriveSubagentActivityState({
        activities: thread.activities,
        subagents: thread.subagents ?? [],
      }).history,
    ).toMatchObject([{ item: { agentThreadId: toolUseId, status: "running" } }]);

    const finished = applyOrchestrationEvent(
      working,
      activityEvent("task-done", "task.completed", { taskId, status: "completed" }, 600),
      localEnvironmentId,
    );
    expect(threadsOf(finished)[0]?.subagents).toMatchObject([
      { id: toolUseId, objective: "Competitor research", status: "completed" },
    ]);

    // A reload starts from the server's roster, not from activities.
    const reloaded = syncServerThreadDetail(
      finished,
      decodeOrchestrationThread({
        id: threadId,
        projectId: "project-1",
        title: "Thread",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-10-18T08:00:00.000Z",
        updatedAt: "2026-10-18T08:40:00.000Z",
        deletedAt: null,
        messages: [],
        activities: [],
        subagents: threadsOf(finished)[0]?.subagents,
        checkpoints: [],
        session: null,
      }),
      localEnvironmentId,
    );
    expect(threadsOf(reloaded)[0]?.subagents).toMatchObject([
      { id: toolUseId, status: "completed" },
    ]);
  });

  it("carries the server's per-thread diff stat from a shell upsert into the sidebar summary", () => {
    const state = makeState(makeThread());

    const next = applyShellEvent(
      state,
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: {
          id: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          effectiveCwd: null,
          goal: null,
          latestTurn: null,
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
          archivedAt: null,
          pinnedAt: null,
          pullRequestAutoFix: false,
          pullRequestAutoMerge: null,
          linkedPullRequests: [],
          participants: [],
          doneOverride: null,
          lastSeenAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          cumulativeDiffStat: { additions: 12, deletions: 4 },
          diffStatBaselineTurnCount: 0,
          ...NO_CHILD_THREAD_SHELL_FIELDS,
        },
      },
      localEnvironmentId,
    );

    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toEqual({ additions: 12, deletions: 4 });
  });

  it("takes a new background wait even when it shares the previous update's timestamp", () => {
    const upsert = (awaitedBackgroundTasks: OrchestrationSession["awaitedBackgroundTasks"]) =>
      ({
        kind: "thread-upserted",
        sequence: 2,
        thread: {
          id: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
          runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          effectiveCwd: null,
          goal: null,
          latestTurn: null,
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
          archivedAt: null,
          pinnedAt: null,
          pullRequestAutoFix: false,
          pullRequestAutoMerge: null,
          linkedPullRequests: [],
          participants: [],
          doneOverride: null,
          lastSeenAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
            activeTurnId: null,
            pendingBackgroundTaskCount: 1,
            awaitedBackgroundTaskCount: 1,
            awaitedBackgroundTasks,
            lastError: null,
            updatedAt: "2026-02-27T00:00:01.000Z",
          },
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          cumulativeDiffStat: null,
          diffStatBaselineTurnCount: 0,
          ...NO_CHILD_THREAD_SHELL_FIELDS,
        },
      }) as const;

    // A `codex exec` run goes out as a command, then is relisted as the agent
    // it is within the same millisecond.
    const listed = applyShellEvent(
      makeState(makeThread()),
      upsert([{ kind: "command", description: "Review the diff" }]),
      localEnvironmentId,
    );
    const relisted = applyShellEvent(
      listed,
      upsert([{ kind: "agent", description: "Review the diff" }]),
      localEnvironmentId,
    );

    expect(
      localEnvironmentStateOf(relisted).sidebarThreadSummaryById[ThreadId.make("thread-1")]?.session
        ?.awaitedBackgroundTasks,
    ).toEqual([{ kind: "agent", description: "Review the diff" }]);
  });

  it("keeps a room's participants while repeated shell pushes carry the same agents", () => {
    const upsert = (updatedAt: string, leftAt: string | null = null) =>
      ({
        kind: "thread-upserted",
        sequence: 2,
        thread: {
          id: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
          runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          effectiveCwd: null,
          goal: null,
          latestTurn: null,
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt,
          archivedAt: null,
          pinnedAt: null,
          pullRequestAutoFix: false,
          pullRequestAutoMerge: null,
          linkedPullRequests: [],
          // Decoded afresh on every push, as the shell stream does.
          participants: [
            {
              id: ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"),
              handle: "agent-2",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
              joinedAt: "2026-02-13T00:00:00.000Z",
              leftAt,
            },
          ],
          doneOverride: null,
          lastSeenAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          cumulativeDiffStat: null,
          diffStatBaselineTurnCount: 0,
          ...NO_CHILD_THREAD_SHELL_FIELDS,
        },
      }) as const;
    const participantsOf = (state: ReturnType<typeof makeState>) =>
      localEnvironmentStateOf(state).threadShellById[ThreadId.make("thread-1")]?.participants;

    const first = applyShellEvent(
      makeState(makeThread()),
      upsert("2026-02-27T00:00:01.000Z"),
      localEnvironmentId,
    );
    // A streaming turn pushes the shell again with only its time moved on.
    const streamed = applyShellEvent(first, upsert("2026-02-27T00:00:02.000Z"), localEnvironmentId);
    expect(participantsOf(streamed)).toBe(participantsOf(first));

    const left = applyShellEvent(
      streamed,
      upsert("2026-02-27T00:00:03.000Z", "2026-02-27T00:00:03.000Z"),
      localEnvironmentId,
    );
    expect(participantsOf(left)).not.toBe(participantsOf(first));
    expect(participantsOf(left)?.[0]?.leftAt).toBe("2026-02-27T00:00:03.000Z");
  });

  it("sums the thread's own turn diffs into the sidebar summary as turns land", () => {
    const state = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:00.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            checkpointTurnCount: 1,
            files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 2 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("checkpoint-2"),
        status: "ready",
        files: [{ path: "b.ts", kind: "added", additions: 5, deletions: 3 }],
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    // The sidebar badge is a per-thread total, so the open thread's own stream
    // has to keep it moving rather than waiting on the next shell push.
    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toEqual({ additions: 15, deletions: 5 });
  });

  it("marks a row whose agent's scheduled-task change waits for the user, through rewrites", () => {
    const threadId = ThreadId.make("thread-1");
    const statusOf = (state: AppState) => {
      const summary = localEnvironmentStateOf(state).sidebarThreadSummaryById[threadId];
      return summary === undefined
        ? null
        : (resolveThreadStatusPill({ thread: summary })?.label ?? null);
    };
    // Marked before its row is built: the row it gets carries the mark.
    const marked = setScheduleApprovalThreads(makeState(makeThread()), localEnvironmentId, [
      threadId,
    ]);
    const renamed = applyOrchestrationEvent(
      marked,
      makeEvent("thread.meta-updated", {
        threadId,
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    expect(statusOf(renamed)).toBe("Pending Approval");

    // Answered: the row the user sees loses it.
    const answered = setScheduleApprovalThreads(renamed, localEnvironmentId, []);
    expect(
      localEnvironmentStateOf(answered).sidebarThreadSummaryById[threadId]?.pendingScheduleApproval,
    ).toBe(false);
    expect(statusOf(answered)).toBe(null);
  });

  it("leaves the sidebar diff stat null until a turn reports a file", () => {
    const state = makeState(makeThread());

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    // Null is "nothing to say", not "+0 -0": a thread that has not touched a
    // file yet must not render a badge claiming a clean slate.
    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toBe(null);
  });

  it("stops counting turns the checkout has already committed away", () => {
    const state = makeState(
      makeThread({
        // The checkout was observed clean after turn 1, so only turn 2 is still
        // uncommitted work this thread can claim.
        diffStatBaselineTurnCount: 1,
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:00.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            checkpointTurnCount: 1,
            files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 2 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("checkpoint-2"),
        status: "ready",
        files: [{ path: "b.ts", kind: "added", additions: 5, deletions: 3 }],
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toEqual({ additions: 5, deletions: 3 });
  });

  it("starts the badge from the newest measured turn and adds later turns' live edits", () => {
    const state = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:00.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            checkpointTurnCount: 1,
            files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 2 }],
          },
        ],
      }),
    );

    // Turn 2 finished with a measurement: what the thread still has
    // uncommitted, which replaces the summed summaries up to that turn.
    const measured = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("checkpoint-2"),
        status: "ready",
        files: [{ path: "b.ts", kind: "added", additions: 5, deletions: 3 }],
        threadDiffStat: { additions: 4, deletions: 0 },
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    expect(
      localEnvironmentStateOf(measured).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toEqual({ additions: 4, deletions: 0 });

    // A running turn's live summary adds on top until it is measured itself.
    const running = applyOrchestrationEvent(
      measured,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-3"),
        checkpointTurnCount: 3,
        checkpointRef: CheckpointRef.make("checkpoint-3"),
        status: "ready",
        files: [{ path: "c.ts", kind: "modified", additions: 2, deletions: 1 }],
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:02.000Z",
        completesTurn: false,
      }),
      localEnvironmentId,
    );
    expect(
      localEnvironmentStateOf(running).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toEqual({ additions: 6, deletions: 1 });
  });

  it("clears the open thread's badge when a rebase event lands", () => {
    const state = makeState(
      makeThread({
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:00.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            checkpointTurnCount: 1,
            files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 2 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.diffstat-rebased", {
        threadId: ThreadId.make("thread-1"),
        baselineTurnCount: 1,
        occurredAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    // The user committed everything the thread had produced, so the open
    // thread's own recomputation has to go quiet too -- not just the sidebar.
    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toBe(null);
  });

  it("keeps the open thread's badge clear while every turn is below the baseline", () => {
    const state = makeState(
      makeThread({
        diffStatBaselineTurnCount: 2,
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:00.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            checkpointTurnCount: 1,
            files: [{ path: "a.ts", kind: "modified", additions: 10, deletions: 2 }],
          },
          {
            turnId: TurnId.make("turn-2"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointRef: CheckpointRef.make("checkpoint-2"),
            checkpointTurnCount: 2,
            files: [{ path: "b.ts", kind: "added", additions: 5, deletions: 3 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    // Same "nothing to say" the server rollup produces when the baseline has
    // swallowed every turn, so the open thread and the sidebar agree.
    expect(
      localEnvironmentStateOf(next).sidebarThreadSummaryById[ThreadId.make("thread-1")]
        ?.cumulativeDiffStat,
    ).toBe(null);
  });

  it("does not mark bootstrap complete for incremental events", () => {
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(makeThread())), {
      bootstrapComplete: false,
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(next).bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.make("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.make("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const state: AppState = makeEmptyState({
      projectIds: [originalProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          kind: "workspace" as const,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        kind: "workspace" as const,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(projectsOf(next)).toHaveLength(1);
    expect(projectsOf(next)[0]?.id).toBe(recreatedProjectId);
    expect(projectsOf(next)[0]?.cwd).toBe("/tmp/project");
    expect(projectsOf(next)[0]?.name).toBe("Project Recreated");
    expect(localEnvironmentStateOf(next).projectIds).toEqual([recreatedProjectId]);
    expect(localEnvironmentStateOf(next).projectById[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).projectById[recreatedProjectId]?.id).toBe(
      recreatedProjectId,
    );
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const threadId = ThreadId.make("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(thread)), {
      projectIds: [originalProjectId, recreatedProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          kind: "workspace" as const,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [recreatedProjectId]: {
          id: recreatedProjectId,
          environmentId: localEnvironmentId,
          kind: "workspace" as const,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.projectId).toBe(recreatedProjectId);
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[recreatedProjectId]).toEqual([
      threadId,
    ]);
  });

  it("surfaces detail-stream thread startup in sidebar summaries before shell projection", () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-starting");
    const messageId = MessageId.make("message-starting");
    const state = makeEmptyState({
      projectIds: [projectId],
      projectById: {
        [projectId]: {
          id: projectId,
          environmentId: localEnvironmentId,
          kind: "workspace" as const,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const created = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId,
        title: "Smooth startup",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        // Started over a link: the sidebar nests it under the Mac thread.
        remoteOrigin: {
          linkDeviceId: "link-mac",
          environmentId: EnvironmentId.make("environment-mac"),
          environmentLabel: "MacBook Pro",
          threadId: ThreadId.make("thread-on-mac"),
          threadTitle: "Fix background screenshots",
        },
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const withMessage = applyOrchestrationEvent(
      created,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "user",
        text: "Start this thread",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );
    const starting = applyOrchestrationEvent(
      withMessage,
      makeEvent("thread.turn-start-requested", {
        threadId,
        messageId,
        runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    const sidebarThreads = selectSidebarThreadsForProjectRef(
      starting,
      scopeProjectRef(localEnvironmentId, projectId),
    );
    expect(sidebarThreads).toHaveLength(1);
    expect(sidebarThreads[0]?.title).toBe("Smooth startup");
    expect(sidebarThreads[0]?.latestUserMessageAt).toBe("2026-02-27T00:00:02.000Z");
    expect(sidebarThreads[0]?.session?.status).toBe("connecting");
    expect(sidebarThreads[0]?.session?.orchestrationStatus).toBe("starting");
    expect(sidebarThreads[0]?.remoteOrigin?.threadId).toBe("thread-on-mac");
  });

  it("adds accepted follow-ups as inline user messages", () => {
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-1");
    const messageId = MessageId.make("message-follow-up-1");
    const baseState = makeState(makeThread({ id: threadId }));

    const nextState = applyOrchestrationEvent(
      baseState,
      makeEvent("thread.follow-up-accepted", {
        threadId,
        turnId,
        messageId,
        role: "user",
        text: "steer the running work",
        sentFrom: { kind: "phone", name: "iPhone", os: "iOS" },
        createdAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    const thread = selectThreadByRef(nextState, scopeThreadRef(localEnvironmentId, threadId));
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      id: messageId,
      role: "user",
      text: "steer the running work",
      turnId,
      streaming: false,
      createdAt: "2026-02-27T00:00:02.000Z",
      completedAt: "2026-02-27T00:00:02.000Z",
      // Shown live, not only after a reload.
      sentFrom: { kind: "phone", name: "iPhone", os: "iOS" },
    });
  });

  it("follows a side answer live, from the question to its settle", () => {
    const threadId = ThreadId.make("thread-1");
    const sideTurnId = SideTurnId.make("side-live-1");
    const questionId = MessageId.make("side-question-1");
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const apply = (state: AppState, event: OrchestrationEvent) =>
      applyOrchestrationEvent(state, event, localEnvironmentId);

    let state = makeState(makeThread({ id: threadId }));
    state = apply(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId: questionId,
        role: "user",
        text: "how many attempts?",
        sideTurnId,
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    state = apply(
      state,
      makeEvent("thread.side-turn-started", {
        threadId,
        sideTurn: {
          sideTurnId,
          participantId: null,
          messageId: questionId,
          status: "starting",
          startedAt: "2026-02-27T00:00:02.000Z",
        },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      }),
    );
    state = apply(
      state,
      makeEvent("thread.side-turn-running", {
        threadId,
        sideTurnId,
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );
    const answering = selectThreadByRef(state, ref);
    expect(answering?.messages[0]?.sideTurnId).toBe(sideTurnId);
    expect(answering?.sideTurn?.status).toBe("running");

    state = apply(
      state,
      makeEvent("thread.side-turn-settled", {
        threadId,
        sideTurnId,
        participantId: null,
        messageId: questionId,
        outcome: "completed",
        settledAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.sideTurn ?? null).toBeNull();
  });

  it("follows an agent's request live, from its message to the user writing again", () => {
    const threadId = ThreadId.make("thread-1");
    const astraId = ThreadParticipantId.make("agent-astra");
    const requestId = RoomAgentRequestId.make("request-1");
    const sideTurnId = SideTurnId.make("side-review-1");
    const requestMessageId = MessageId.make("request-message-1");
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const apply = (state: AppState, event: OrchestrationEvent) =>
      applyOrchestrationEvent(state, event, localEnvironmentId);
    const reviewInput = {
      basis: {
        kind: "uncommitted" as const,
        files: 4,
        truncated: false,
        capturedAt: "2026-02-27T00:00:02.000Z",
      },
      diff: "diff --git a/lock.ts b/lock.ts",
    };

    let state = makeState(makeThread({ id: threadId }));
    state = apply(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId: requestMessageId,
        role: "user",
        text: "Check the lock is released on every path.",
        participantId: astraId,
        sideTurnId,
        fromAgent: { participantId: null },
        requestId,
        requestKind: "review",
        reviewInput,
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    state = apply(
      state,
      makeEvent("thread.side-turn-started", {
        threadId,
        sideTurn: {
          sideTurnId,
          participantId: astraId,
          messageId: requestMessageId,
          status: "starting",
          startedAt: "2026-02-27T00:00:02.000Z",
          kind: "review",
          askedBy: { participantId: null },
          requestId,
        },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      }),
    );
    state = apply(
      state,
      makeEvent("thread.agent-request-submitted", {
        threadId,
        request: {
          requestId,
          kind: "review",
          from: { participantId: null },
          to: { participantId: astraId },
          callerTurnId: TurnId.make("turn-1"),
          chainEpoch: 0,
          status: "running",
          requestMessageId,
          sideTurnId,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );
    const running = selectThreadByRef(state, ref);
    expect(running?.messages[0]).toMatchObject({
      fromAgent: { participantId: null },
      requestKind: "review",
      reviewInput,
    });
    expect(running?.sideTurn).toMatchObject({ kind: "review", askedBy: { participantId: null } });
    expect(running?.agentRequests).toMatchObject({
      open: [{ requestId, status: "running" }],
      requestsSinceUser: 1,
    });

    state = apply(
      state,
      makeEvent("thread.agent-request-settled", {
        threadId,
        requestId,
        requestMessageId,
        outcome: "stopped",
        settledAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    state = apply(
      state,
      makeEvent("thread.agent-requests-held", {
        threadId,
        chainEpoch: 1,
        createdAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    const stopped = selectThreadByRef(state, ref);
    expect(stopped?.agentRequests).toMatchObject({
      open: [],
      hold: true,
      chainEpoch: 1,
      requestsSinceUser: 1,
    });
    // The outcome stays on the message, beside what the review was given.
    expect(stopped?.messages[0]).toMatchObject({ requestOutcome: "stopped", reviewInput });

    state = apply(
      state,
      makeEvent("thread.agent-requests-reset", {
        threadId,
        createdAt: "2026-02-27T00:00:12.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.agentRequests).toMatchObject({
      hold: false,
      chainEpoch: 1,
      requestsSinceUser: 0,
    });
  });

  it("folds a family of child threads: lineage, open requests, answers and separating", () => {
    const parentId = ThreadId.make("thread-1");
    const childId = ThreadId.make("thread-child");
    const callerTurnId = TurnId.make("turn-parent");
    const answerTurnId = TurnId.make("turn-child-answer");
    const startRequestId = ChildRequestId.make("child-request-1");
    const apply = (state: AppState, event: OrchestrationEvent) =>
      applyOrchestrationEvent(state, event, localEnvironmentId);
    const summaryOf = (state: AppState, threadId: ThreadId) =>
      localEnvironmentStateOf(state).sidebarThreadSummaryById[threadId];
    const launch = {
      title: "Write the changelog",
      prompt: "Write the 0.6 changelog.",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      runtimeMode: DEFAULT_COMPOSER_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      reportBack: true,
      runSetup: true,
      workspace: { kind: "project_folder" as const },
    };
    const request = (requestId: ChildRequestId, status: "awaiting_user" | "running") => ({
      requestId,
      batchId: ChildRequestBatchId.make(`batch-${requestId}`),
      kind: "start" as const,
      from: { participantId: null },
      callerTurnId,
      deliveryEpoch: 0,
      status,
      childThreadId: childId,
      childMessageId: MessageId.make(`message-${requestId}`),
      launch,
      createdAt: "2026-02-27T00:00:02.000Z",
    });

    let state = makeState(makeThread({ id: parentId }));
    state = apply(
      state,
      makeEvent("thread.created", {
        threadId: childId,
        projectId: ProjectId.make("project-1"),
        title: launch.title,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        branch: null,
        worktreePath: null,
        parentThreadId: parentId,
        parentTurnId: callerTurnId,
        attachedToParent: true,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );
    expect(summaryOf(state, childId)).toMatchObject({
      parentThreadId: parentId,
      parentTurnId: callerTurnId,
      attachedToParent: true,
    });

    // The parent's open requests: one under way, one waiting for the user.
    state = apply(
      state,
      makeEvent("thread.child-request-submitted", {
        threadId: parentId,
        request: request(startRequestId, "running"),
        createdAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    state = apply(
      state,
      makeEvent("thread.child-request-submitted", {
        threadId: parentId,
        request: request(ChildRequestId.make("child-request-2"), "awaiting_user"),
        createdAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    expect(summaryOf(state, parentId)).toMatchObject({
      awaitedChildThreadCount: 1,
      pendingChildApproval: true,
    });
    expect(selectThreadByRef(state, scopeThreadRef(localEnvironmentId, parentId))).toMatchObject({
      childRequests: { startsSinceUser: 2 },
    });

    // The parent's request lands in the child as another thread's message.
    state = apply(
      state,
      makeEvent("thread.message-sent", {
        threadId: childId,
        messageId: MessageId.make("message-child-request-1"),
        role: "user",
        text: launch.prompt,
        fromThread: { threadId: parentId, requestId: startRequestId, kind: "request" },
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:04.000Z",
        updatedAt: "2026-02-27T00:00:04.000Z",
      }),
    );
    expect(selectThreadByRef(state, scopeThreadRef(localEnvironmentId, childId))?.messages).toEqual(
      [
        expect.objectContaining({
          fromThread: { threadId: parentId, requestId: startRequestId, kind: "request" },
        }),
      ],
    );
    // It is not the user writing.
    expect(summaryOf(state, childId)?.latestUserMessageAt).toBeNull();

    // Answered: the parent no longer waits, and the child knows which of its
    // turns went back, without that counting as activity.
    state = apply(
      state,
      makeEvent("thread.child-request-settled", {
        threadId: parentId,
        requestId: startRequestId,
        childThreadId: childId,
        outcome: "answered",
        settledAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    expect(summaryOf(state, parentId)?.awaitedChildThreadCount).toBe(0);
    const updatedAtBefore = summaryOf(state, childId)?.updatedAt;
    state = apply(
      state,
      makeEvent("thread.handed-back", {
        threadId: childId,
        turnId: answerTurnId,
        handedBackAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    expect(summaryOf(state, childId)).toMatchObject({
      handedBackTurnId: answerTurnId,
      updatedAt: updatedAtBefore,
    });

    // Made its own thread: still started by the parent, no longer in its family.
    state = apply(
      state,
      makeEvent("thread.parent-attachment-set", {
        threadId: childId,
        attached: false,
        attachmentEpoch: 1,
        at: "2026-02-27T00:00:10.000Z",
      }),
    );
    expect(summaryOf(state, childId)).toMatchObject({
      parentThreadId: parentId,
      attachedToParent: false,
    });
  });

  it("follows a move to a linked computer, and drops steps of a move that already ended", () => {
    const threadId = ThreadId.make("thread-1");
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const transferId = ThreadMoveId.make("move-1");
    const macMini = {
      environmentId: EnvironmentId.make("environment-mac-mini"),
      label: "Mac mini",
    };
    const apply = (state: AppState, event: OrchestrationEvent) =>
      applyOrchestrationEvent(state, event, localEnvironmentId);
    const summaryOf = (state: AppState) =>
      localEnvironmentStateOf(state).sidebarThreadSummaryById[threadId];

    let state = makeState(makeThread({ id: threadId }));
    state = apply(
      state,
      makeEvent("thread.move-started", {
        threadId,
        transferId,
        target: macMini,
        agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        startedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.move).toMatchObject({
      phase: "exporting",
      cancelRequested: false,
      target: macMini,
    });
    expect(summaryOf(state)?.moveStatus).toBe("moving");

    state = apply(
      state,
      makeEvent("thread.move-progressed", {
        threadId,
        transferId,
        phase: "sending",
        sentBytes: 400,
        totalBytes: 1_000,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    // A step from another move is not this one's.
    state = apply(
      state,
      makeEvent("thread.move-progressed", {
        threadId,
        transferId: ThreadMoveId.make("move-old"),
        phase: "importing",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.move).toMatchObject({
      phase: "sending",
      sentBytes: 400,
      totalBytes: 1_000,
    });

    state = apply(
      state,
      makeEvent("thread.move-cancel-requested", {
        threadId,
        transferId,
        updatedAt: "2026-02-27T00:00:04.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.move?.cancelRequested).toBe(true);

    // The other computer confirmed it dropped the move: the thread is its own again.
    state = apply(
      state,
      makeEvent("thread.move-aborted", {
        threadId,
        transferId,
        reason: "The user stopped it.",
        updatedAt: "2026-02-27T00:00:05.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.move).toBeUndefined();
    expect(summaryOf(state)?.moveStatus).toBeUndefined();

    // A second move that lands: the thread lives on Mac mini now.
    const secondTransferId = ThreadMoveId.make("move-2");
    state = apply(
      state,
      makeEvent("thread.move-started", {
        threadId,
        transferId: secondTransferId,
        target: macMini,
        agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        startedAt: "2026-02-27T00:00:06.000Z",
      }),
    );
    state = apply(
      state,
      makeEvent("thread.moved-away", {
        threadId,
        transferId: secondTransferId,
        movedThreadId: ThreadId.make("thread-on-mac-mini"),
        movedAt: "2026-02-27T00:00:07.000Z",
      }),
    );
    expect(selectThreadByRef(state, ref)?.move?.movedAway).toEqual({
      threadId: ThreadId.make("thread-on-mac-mini"),
      movedAt: "2026-02-27T00:00:07.000Z",
    });
    expect(summaryOf(state)?.moveStatus).toBe("moved");
  });

  it("keeps a moved thread's imported history marked, and out of its latest turn", () => {
    const threadId = ThreadId.make("thread-1");
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    let state = makeState(makeThread({ id: threadId }));
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.make("imported-answer"),
        role: "assistant",
        text: "Done on the other computer.",
        turnId: TurnId.make("turn-imported"),
        streaming: false,
        imported: true,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      localEnvironmentId,
    );
    const thread = selectThreadByRef(state, ref);
    expect(thread?.messages).toEqual([
      expect.objectContaining({ id: MessageId.make("imported-answer"), imported: true }),
    ]);
    expect(thread?.latestTurn).toBeNull();
  });

  it("shows an agent's new name and reasoning as soon as they are saved", () => {
    const threadId = ThreadId.make("thread-1");
    const astraId = ThreadParticipantId.make("agent-astra");
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const astra = {
      id: astraId,
      handle: "GPT-6 Astra",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
      joinedAt: "2026-02-27T00:00:00.000Z",
      leftAt: null,
    };
    let state = makeState(makeThread({ id: threadId }));
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.participant-added", {
        threadId,
        participant: astra,
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      localEnvironmentId,
    );
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.participant-updated", {
        threadId,
        participantId: astraId,
        role: "Reviewer",
        modelSelection: {
          ...astra.modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        updatedAt: "2026-02-27T00:00:05.000Z",
      }),
      localEnvironmentId,
    );
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.participant-updated", {
        threadId,
        participantId: null,
        role: "Researcher",
        updatedAt: "2026-02-27T00:00:06.000Z",
      }),
      localEnvironmentId,
    );
    const thread = selectThreadByRef(state, ref);
    expect(thread?.participants?.[0]).toMatchObject({
      role: "Reviewer",
      modelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
    });
    expect(thread?.agentRole).toBe("Researcher");
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.make("thread-1"),
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.make("thread-2") });
    const baseState = makeState(thread1);
    const baseEnvironmentState = localEnvironmentStateOf(baseState);
    const state = withActiveEnvironmentState(baseEnvironmentState, {
      threadIds: [thread1.id, thread2.id],
      threadShellById: {
        ...baseEnvironmentState.threadShellById,
        [thread2.id]: {
          id: thread2.id,
          environmentId: thread2.environmentId,
          codexThreadId: thread2.codexThreadId,
          projectId: thread2.projectId,
          title: thread2.title,
          modelSelection: thread2.modelSelection,
          runtimeMode: thread2.runtimeMode,
          interactionMode: thread2.interactionMode,
          error: thread2.error,
          createdAt: thread2.createdAt,
          archivedAt: thread2.archivedAt,
          pinnedAt: thread2.pinnedAt,
          doneOverride: null,
          lastSeenAt: null,
          updatedAt: thread2.updatedAt,
          branch: thread2.branch,
          worktreePath: thread2.worktreePath,
        },
      },
      threadSessionById: {
        ...baseEnvironmentState.threadSessionById,
        [thread2.id]: thread2.session,
      },
      threadTurnStateById: {
        ...baseEnvironmentState.threadTurnStateById,
        [thread2.id]: {
          latestTurn: thread2.latestTurn,
        },
      },
      messagesByThreadId: {
        ...baseEnvironmentState.messagesByThreadId,
        [thread2.id]: [],
      },
      activitiesByThreadId: {
        ...baseEnvironmentState.activitiesByThreadId,
        [thread2.id]: [],
      },
      proposedPlanIdsByThreadId: {
        ...baseEnvironmentState.proposedPlanIdsByThreadId,
        [thread2.id]: [],
      },
      proposedPlanByThreadId: {
        ...baseEnvironmentState.proposedPlanByThreadId,
        [thread2.id]: {},
      },
      turnDiffIdsByThreadId: {
        ...baseEnvironmentState.turnDiffIdsByThreadId,
        [thread2.id]: [],
      },
      turnDiffSummaryByThreadId: {
        ...baseEnvironmentState.turnDiffSummaryByThreadId,
        [thread2.id]: {},
      },
      sidebarThreadSummaryById: {
        ...baseEnvironmentState.sidebarThreadSummaryById,
      },
      threadIdsByProjectId: {
        [thread1.projectId]: [thread1.id, thread2.id],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.make("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello world");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    const nextEnvironmentState = next.environmentStateById[localEnvironmentId];
    const previousEnvironmentState = state.environmentStateById[localEnvironmentId];
    expect(nextEnvironmentState?.threadShellById[thread2.id]).toBe(
      previousEnvironmentState?.threadShellById[thread2.id],
    );
    expect(nextEnvironmentState?.threadSessionById[thread2.id]).toBe(
      previousEnvironmentState?.threadSessionById[thread2.id],
    );
    expect(nextEnvironmentState?.messagesByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messagesByThreadId[thread2.id],
    );
  });

  it("keeps a launching session's agent through updates that leave it out, until cleared", () => {
    const thread = makeThread();
    const at = "2026-02-27T00:00:02.000Z";
    const sessionSet = (sequence: number, startup: OrchestrationSession["startup"] | "absent") =>
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "starting",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            ...(startup === "absent" ? {} : { startup }),
            lastError: null,
            // Marking and clearing keep the turn's start time.
            updatedAt: at,
          },
        },
        { sequence },
      );
    const launching = {
      phase: "launching",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    } as const;

    const marked = applyOrchestrationEvents(
      makeState(thread),
      [sessionSet(2, launching), sessionSet(3, "absent")],
      localEnvironmentId,
    );
    expect(threadsOf(marked)[0]?.session?.launchingInstanceId).toBe(
      ProviderInstanceId.make("claudeAgent"),
    );

    const cleared = applyOrchestrationEvents(marked, [sessionSet(4, null)], localEnvironmentId);
    expect(threadsOf(cleared)[0]?.session?.launchingInstanceId).toBeUndefined();
  });

  it("hides a closed error from the composer while the failed turn keeps it", () => {
    const thread = makeThread();
    const offline = "API Error: Can't reach the API server (ENOTFOUND)";
    const sessionSet = (sequence: number, lastError: string, dismissedAt?: string) =>
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError,
            ...(dismissedAt ? { lastErrorDismissedAt: dismissedAt } : {}),
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence },
      );

    const failed = applyOrchestrationEvents(
      makeState(thread),
      [sessionSet(2, offline)],
      localEnvironmentId,
    );
    expect(threadsOf(failed)[0]?.error).toBe(offline);

    const closed = applyOrchestrationEvent(
      failed,
      makeEvent(
        "thread.error-dismissed",
        {
          threadId: thread.id,
          lastError: offline,
          lastErrorAt: null,
          dismissedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
      localEnvironmentId,
    );
    expect(threadsOf(closed)[0]?.error).toBeNull();
    expect(threadsOf(closed)[0]?.session?.lastError).toBe(offline);

    // Later updates say whether it is still closed.
    const stillClosed = applyOrchestrationEvent(
      closed,
      sessionSet(4, offline, "2026-02-27T00:00:03.000Z"),
      localEnvironmentId,
    );
    expect(threadsOf(stillClosed)[0]?.error).toBeNull();
    const failedAgain = applyOrchestrationEvent(
      stillClosed,
      sessionSet(5, offline),
      localEnvironmentId,
    );
    expect(threadsOf(failedAgain)[0]?.error).toBe(offline);
  });

  it("keeps legacy assistant completion events non-terminal while their turn is active", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(
      state,
      [
        makeEvent(
          "thread.session-set",
          {
            threadId: thread.id,
            session: {
              threadId: thread.id,
              providerThreadId: null,
              providerSessionId: null,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          },
          { sequence: 2 },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.make("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:00:03.000Z",
            updatedAt: "2026-02-27T00:00:03.000Z",
          },
          { sequence: 3 },
        ),
      ],
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.session?.status).toBe("running");
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-1"),
      state: "running",
      completedAt: null,
      assistantMessageId: MessageId.make("assistant-1"),
    });
    expect(threadsOf(next)[0]?.messages).toHaveLength(1);

    const completed = applyOrchestrationEvent(
      next,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: MessageId.make("assistant-1"),
        role: "assistant",
        text: "done",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        completesTurn: true,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(completed)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-1"),
      state: "completed",
      completedAt: "2026-02-27T00:00:04.000Z",
    });
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
  });

  it("settles the running turn when a turn ends without a checkpoint", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    const turnCompleted = (turnId: string) =>
      makeEvent("thread.turn-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make(turnId),
        state: "error",
        completedAt: "2026-02-27T00:00:04.000Z",
      });

    // An end for an older turn leaves the running one alone.
    const stale = applyOrchestrationEvent(state, turnCompleted("turn-1"), localEnvironmentId);
    expect(threadsOf(stale)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);

    const ended = applyOrchestrationEvent(stale, turnCompleted("turn-2"), localEnvironmentId);
    expect(threadsOf(ended)[0]?.latestTurn).toMatchObject({
      turnId: "turn-2",
      state: "error",
      startedAt: "2026-02-27T00:00:03.000Z",
      completedAt: "2026-02-27T00:00:04.000Z",
    });
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.make("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.make("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            assistantMessageId: MessageId.make("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            dismissedAt: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.make("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
    ]);
  });

  it("shows a page a turn published, and drops the pages of turns a revert took back", () => {
    const message = (
      id: string,
      role: "user" | "assistant",
      turn: string,
      eventSequence: number,
    ) => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: TurnId.make(turn),
      createdAt: `2026-02-27T00:00:0${eventSequence}.000Z`,
      completedAt: `2026-02-27T00:00:0${eventSequence}.000Z`,
      eventSequence,
      streaming: false,
    });
    const publish = (turn: string, versionId: string, version: number, sequence: number) =>
      makeEvent(
        "thread.page-published",
        {
          threadId: ThreadId.make("thread-1"),
          page: {
            pageId: AgentPageId.make("page-1"),
            versionId: AgentPageVersionId.make(versionId),
            version,
            turnId: TurnId.make(turn),
            participantId: null,
            title: "Funnel",
            kind: "html",
            height: 400,
          },
          createdAt: "2026-02-27T00:00:05.000Z",
        },
        { sequence },
      );
    let state = makeState(
      makeThread({
        messages: [
          message("user-1", "user", "turn-1", 1),
          message("assistant-1", "assistant", "turn-1", 3),
          message("user-2", "user", "turn-2", 4),
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            files: [],
          },
        ],
      }),
    );
    state = applyOrchestrationEvent(
      state,
      publish("turn-1", "version-1", 1, 2),
      localEnvironmentId,
    );
    state = applyOrchestrationEvent(
      state,
      publish("turn-2", "version-2", 2, 5),
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.pages?.map((page) => page.versionId)).toEqual([
      "version-1",
      "version-2",
    ]);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", { threadId: ThreadId.make("thread-1"), turnCount: 1 }),
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.pages?.map((page) => page.versionId)).toEqual(["version-1"]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.make("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.make("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.make("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(reverted)[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          providerThreadId: null,
          providerSessionId: null,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-3"),
      state: "running",
    });
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});

describe("selectRunningSidebarThreadsAcrossEnvironments", () => {
  function makeSidebarSummary(
    overrides: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "id">,
  ): SidebarThreadSummary {
    return {
      environmentId: localEnvironmentId,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      createdAt: "2026-02-13T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      doneOverride: null,
      lastSeenAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      cumulativeDiffStat: null,
      ...overrides,
    };
  }

  it("keeps a settled thread live while background provider tasks are still running", () => {
    const settledSession: ThreadSession = {
      provider: ProviderDriverKind.make("claude"),
      status: "ready",
      orchestrationStatus: "ready",
      checkoutCwd: "/tmp/project",
      createdAt: "2026-02-13T00:00:00.000Z",
      updatedAt: "2026-02-13T00:05:00.000Z",
    };
    const settledTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      assistantMessageId: null,
      requestedAt: "2026-02-13T00:00:00.000Z",
      startedAt: "2026-02-13T00:00:00.000Z",
      completedAt: "2026-02-13T00:05:00.000Z",
    };
    const waiting = makeSidebarSummary({
      id: ThreadId.make("thread-waiting"),
      session: { ...settledSession, pendingBackgroundTaskCount: 2, awaitedBackgroundTaskCount: 2 },
      latestTurn: settledTurn,
    });
    const finished = makeSidebarSummary({
      id: ThreadId.make("thread-finished"),
      session: { ...settledSession, pendingBackgroundTaskCount: 0 },
      latestTurn: settledTurn,
    });
    const state = makeEmptyState({
      threadIds: [waiting.id, finished.id],
      sidebarThreadSummaryById: {
        [waiting.id]: waiting,
        [finished.id]: finished,
      },
    });

    expect(selectRunningSidebarThreadsAcrossEnvironments(state).map((thread) => thread.id)).toEqual(
      [waiting.id],
    );
  });

  it("keeps a room live while an agent answers on the side and the others are idle", () => {
    const answering = makeSidebarSummary({
      id: ThreadId.make("thread-answering"),
      sideTurn: {
        sideTurnId: SideTurnId.make("side-1"),
        participantId: null,
        messageId: MessageId.make("question-1"),
        status: "running",
        startedAt: "2026-02-13T00:06:00.000Z",
      },
    });
    const state = makeEmptyState({
      threadIds: [answering.id],
      sidebarThreadSummaryById: { [answering.id]: answering },
    });

    // The taskbar count and the quit and update warnings read this list.
    expect(selectRunningSidebarThreadsAcrossEnvironments(state).map((thread) => thread.id)).toEqual(
      [answering.id],
    );
  });

  it("splits running threads into this computer's and other computers'", () => {
    const runningSession: ThreadSession = {
      provider: ProviderDriverKind.make("claude"),
      status: "running",
      orchestrationStatus: "running",
      checkoutCwd: "/tmp/project",
      createdAt: "2026-02-13T00:00:00.000Z",
      updatedAt: "2026-02-13T00:05:00.000Z",
    };
    const local = makeSidebarSummary({
      id: ThreadId.make("thread-local"),
      session: runningSession,
    });
    const remote = makeSidebarSummary({
      id: ThreadId.make("thread-remote"),
      environmentId: remoteEnvironmentId,
      session: runningSession,
    });
    const localState = makeEmptyState({
      threadIds: [local.id],
      sidebarThreadSummaryById: { [local.id]: local },
    });
    const remoteState = makeEmptyState({
      threadIds: [remote.id],
      sidebarThreadSummaryById: { [remote.id]: remote },
    });
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: localEnvironmentStateOf(localState),
        [remoteEnvironmentId]: localEnvironmentStateOf(remoteState),
      },
    };
    const ids = (threads: ReadonlyArray<SidebarThreadSummary>) =>
      threads.map((thread) => thread.id);

    const split = selectRunningSidebarThreadsByLocation(state, localEnvironmentId);
    expect(ids(split.local)).toEqual([local.id]);
    expect(ids(split.remote)).toEqual([remote.id]);

    // Before this computer's server is known, all work counts as local, so
    // quitting still asks.
    const unknown = selectRunningSidebarThreadsByLocation(state, null);
    expect(ids(unknown.local)).toEqual([local.id, remote.id]);
    expect(unknown.remote).toEqual([]);
  });
});
