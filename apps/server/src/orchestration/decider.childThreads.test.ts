import {
  type ChildThreadLaunch,
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { childReportMessageId } from "./childThreadDecisions.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-10-04T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const projectId = ProjectId.make("project-1");
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");
const CALLER_TURN = TurnId.make("parent-turn-1");
const PRIMARY = { participantId: null };
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" };

function session(
  threadId: ThreadId,
  overrides: Partial<OrchestrationSession> = {},
): OrchestrationSession {
  return {
    threadId,
    status: "running",
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    runtimeMode: "auto-accept-edits",
    activeTurnId: CALLER_TURN,
    lastError: null,
    updatedAt: now,
    ...overrides,
  };
}

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId,
    title: id === PARENT ? "Ship the 0.6 release" : "Write the changelog",
    modelSelection: model,
    runtimeMode: "auto-accept-edits",
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
    pullRequestAutoFix: false,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    agentRequests: EMPTY_AGENT_REQUEST_STATE,
    parentThreadId: null,
    parentTurnId: null,
    attachedToParent: false,
    parentAttachmentEpoch: 0,
    handedBackAt: null,
    handedBackTurnId: null,
    archivedWithParentAt: null,
    childRequests: EMPTY_CHILD_REQUEST_STATE,
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    diffStatBaselineTurnCount: 0,
    session: null,
    ...overrides,
  };
}

function readModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        kind: "workspace",
        title: "threadlines",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads,
  };
}

const launch = (overrides: Partial<ChildThreadLaunch> = {}): ChildThreadLaunch => ({
  title: "Write the changelog",
  prompt: "Write the 0.6 changelog from the merged PRs.",
  modelSelection: model,
  runtimeMode: "auto-accept-edits",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  reportBack: true,
  runSetup: true,
  workspace: { kind: "worktree", projectCwd: "/repo", baseRef: "main" },
  ...overrides,
});

const REQUEST = ChildRequestId.make("request-1");
const BATCH = ChildRequestBatchId.make("batch-1");
const CHILD_MESSAGE = MessageId.make("child-message-1");

const startCommand = (
  mode: "ask" | "auto",
  overrides: Partial<ChildThreadLaunch> = {},
): Extract<OrchestrationCommand, { type: "thread.child.start" }> => ({
  type: "thread.child.start",
  commandId: CommandId.make("start"),
  threadId: PARENT,
  batchId: BATCH,
  from: PRIMARY,
  callerTurnId: CALLER_TURN,
  mode,
  children: [
    {
      requestId: REQUEST,
      childThreadId: CHILD,
      childMessageId: CHILD_MESSAGE,
      launch: launch(overrides),
    },
  ],
  createdAt: at(1),
});

type Planned = Omit<OrchestrationEvent, "sequence">;

/** Decide a command, project its events, and hand back both. */
async function run(
  current: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{ readonly events: ReadonlyArray<Planned>; readonly model: OrchestrationReadModel }> {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<Planned>;
  let next = current;
  let sequence = current.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return { events, model: next };
}

const refused = async (current: OrchestrationReadModel, command: OrchestrationCommand) =>
  Exit.isFailure(
    await Effect.runPromiseExit(decideOrchestrationCommand({ command, readModel: current })),
  );

const threadIn = (current: OrchestrationReadModel, id: ThreadId) => {
  const found = current.threads.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no thread ${id}`);
  return found;
};

/** A parent whose child has been created and is working on its first request. */
async function familyWithRunningChild() {
  const started = await run(
    readModel([thread(PARENT, { session: session(PARENT) })]),
    startCommand("auto"),
  );
  const created = await run(started.model, {
    type: "thread.create",
    commandId: CommandId.make("server:child-request:request-1:create"),
    threadId: CHILD,
    projectId,
    title: "Write the changelog",
    modelSelection: model,
    runtimeMode: "auto-accept-edits",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    parentThreadId: PARENT,
    parentTurnId: CALLER_TURN,
    attachedToParent: true,
    createdAt: at(2),
  });
  const turn = await run(created.model, {
    type: "thread.turn.start",
    commandId: CommandId.make("server:child-request:request-1:turn"),
    threadId: CHILD,
    message: { messageId: CHILD_MESSAGE, role: "user", text: launch().prompt, attachments: [] },
    runtimeMode: "auto-accept-edits",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
    createdAt: at(3),
  });
  return turn.model;
}

const settleAnswered = (
  createdAt = at(10),
): Extract<OrchestrationCommand, { type: "thread.child-request.settle" }> => ({
  type: "thread.child-request.settle",
  commandId: CommandId.make("server:child-request:request-1:settle"),
  threadId: PARENT,
  requestId: REQUEST,
  outcome: "answered",
  reply: {
    messageId: childReportMessageId(REQUEST),
    text: "Changelog written: 14 entries.",
    turnId: TurnId.make("child-turn-1"),
  },
  createdAt,
});

describe("decider child threads", () => {
  it("waits for the user in ask mode, and starts only after a yes", async () => {
    const asked = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("ask"),
    );
    expect(
      threadIn(asked.model, PARENT).childRequests.open.map((request) => request.status),
    ).toEqual(["awaiting_user"]);

    const declined = await run(asked.model, {
      type: "thread.child-request.respond",
      commandId: CommandId.make("decline"),
      threadId: PARENT,
      batchId: BATCH,
      choice: "decline",
      createdAt: at(2),
    });
    const parent = threadIn(declined.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.pendingNotes[0]?.text).toContain("not now");

    const approved = await run(asked.model, {
      type: "thread.child-request.respond",
      commandId: CommandId.make("approve"),
      threadId: PARENT,
      batchId: BATCH,
      choice: "start",
      createdAt: at(2),
    });
    expect(threadIn(approved.model, PARENT).childRequests.open[0]?.status).toBe("starting");
  });

  it("never starts a child with more access than its parent", async () => {
    const parent = thread(PARENT, { session: session(PARENT) });
    expect(
      await refused(readModel([parent]), startCommand("auto", { runtimeMode: "full-access" })),
    ).toBe(true);
    const planning = thread(PARENT, { session: session(PARENT), interactionMode: "plan" });
    expect(await refused(readModel([planning]), startCommand("auto"))).toBe(true);
    expect(
      await refused(readModel([planning]), startCommand("auto", { interactionMode: "plan" })),
    ).toBe(false);
  });

  it("marks the request running when the child's turn for it starts, without counting as the user", async () => {
    const family = await familyWithRunningChild();
    expect(threadIn(family, PARENT).childRequests.open[0]?.status).toBe("running");
    const child = threadIn(family, CHILD);
    expect(child.parentThreadId).toBe(PARENT);
    expect(child.attachedToParent).toBe(true);
    expect(child.messages[0]?.fromThread?.kind).toBe("request");
  });

  it("delivers an answer as a report queued for the agent that asked, and marks the child handed back", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    const parent = threadIn(delivered.model, PARENT);
    const report = parent.messages.find((message) => message.id === childReportMessageId(REQUEST));
    expect(report?.fromThread).toMatchObject({ threadId: CHILD, kind: "report" });
    expect(parent.queuedFollowUps?.map((queued) => queued.messageId)).toEqual([
      childReportMessageId(REQUEST),
    ]);
    expect(parent.childRequests.open).toEqual([]);
    expect(threadIn(delivered.model, CHILD).handedBackTurnId).toBe("child-turn-1");
  });

  it("Stop in the parent cancels what its children owe it, and a late answer comes back to no one", async () => {
    const stopped = await run(await familyWithRunningChild(), {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop"),
      threadId: PARENT,
      createdAt: at(5),
    });
    const parent = threadIn(stopped.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.deliveryEpoch).toBe(1);
    expect(parent.childRequests.pendingNotes[0]?.text).toContain("stopped");
    expect(await refused(stopped.model, settleAnswered())).toBe(true);
  });

  it("takes back a queued report when the parent is wrapped before it is sent", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    const wrapped = await run(delivered.model, {
      type: "thread.done-override.set",
      commandId: CommandId.make("wrap"),
      threadId: PARENT,
      state: "done",
      at: at(11),
    });
    expect(threadIn(wrapped.model, PARENT).queuedFollowUps).toEqual([]);
  });

  it("refuses to send a report whose delivery went stale after it was queued", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    // Separated after the report was queued: separating takes it back, so
    // simulate one that slipped through by moving the child's attachment on.
    const moved: OrchestrationReadModel = {
      ...delivered.model,
      threads: delivered.model.threads.map((entry) =>
        entry.id === CHILD
          ? { ...entry, parentAttachmentEpoch: entry.parentAttachmentEpoch + 2 }
          : entry,
      ),
    };
    const sent = await run(moved, {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("send-report"),
      threadId: PARENT,
      messageId: childReportMessageId(REQUEST),
      createdAt: at(12),
    });
    expect(sent.events.map((event) => event.type)).toEqual(["thread.follow-up-unqueued"]);
    expect(sent.events[0]?.payload).toMatchObject({ reason: "cancelled" });
  });

  it("sends a report with the parent's current access, never the access it was queued with", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    const widenedInQueue: OrchestrationReadModel = {
      ...delivered.model,
      threads: delivered.model.threads.map((entry) =>
        entry.id === PARENT
          ? {
              ...entry,
              runtimeMode: "approval-required",
              session: session(PARENT, { status: "ready", activeTurnId: null }),
              queuedFollowUps: (entry.queuedFollowUps ?? []).map((queued) => ({
                ...queued,
                runtimeMode: "full-access" as const,
              })),
            }
          : entry,
      ),
    };
    const sent = await run(widenedInQueue, {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("send-report"),
      threadId: PARENT,
      messageId: childReportMessageId(REQUEST),
      createdAt: at(12),
    });
    expect(sent.events.some((event) => event.type === "thread.runtime-mode-set")).toBe(false);
    expect(threadIn(sent.model, PARENT).runtimeMode).toBe("approval-required");
  });

  it("separating a child cancels its owed answer and tells the parent's agent, and put-back keeps families one level deep", async () => {
    const separated = await run(await familyWithRunningChild(), {
      type: "thread.parent-attachment.set",
      commandId: CommandId.make("separate"),
      threadId: CHILD,
      attached: false,
      createdAt: at(5),
    });
    const parent = threadIn(separated.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.pendingNotes[0]?.text).toContain("its own thread");
    expect(threadIn(separated.model, CHILD).attachedToParent).toBe(false);

    const grandchild = thread(ThreadId.make("grandchild"), {
      parentThreadId: CHILD,
      attachedToParent: true,
    });
    const withGrandchild: OrchestrationReadModel = {
      ...separated.model,
      threads: [...separated.model.threads, grandchild],
    };
    expect(
      await refused(withGrandchild, {
        type: "thread.parent-attachment.set",
        commandId: CommandId.make("put-back"),
        threadId: CHILD,
        attached: true,
        createdAt: at(6),
      }),
    ).toBe(true);
  });

  it("refuses a revert while a family still owes or works on answers", async () => {
    const family = await familyWithRunningChild();
    const revert = (threadId: ThreadId): OrchestrationCommand => ({
      type: "thread.checkpoint.revert",
      commandId: CommandId.make("revert"),
      threadId,
      turnCount: 0,
      createdAt: at(6),
    });
    expect(await refused(family, revert(PARENT))).toBe(true);
    expect(await refused(family, revert(CHILD))).toBe(true);
  });

  it("deleting a parent separates its children, or deletes them when asked to", async () => {
    const family = await familyWithRunningChild();
    const kept = await run(family, {
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: PARENT,
    });
    expect(threadIn(kept.model, CHILD).attachedToParent).toBe(false);
    expect(threadIn(kept.model, CHILD).deletedAt).toBeNull();

    const both = await run(family, {
      type: "thread.delete",
      commandId: CommandId.make("delete-all"),
      threadId: PARENT,
      withChildren: true,
    });
    expect(threadIn(both.model, CHILD).deletedAt).not.toBeNull();
  });

  it("archiving a parent takes settled children along and separates live ones; unarchive brings back only its own", async () => {
    const settled = thread(ThreadId.make("settled-child"), {
      parentThreadId: PARENT,
      attachedToParent: true,
    });
    const live = thread(ThreadId.make("live-child"), {
      parentThreadId: PARENT,
      attachedToParent: true,
      session: session(ThreadId.make("live-child")),
    });
    const archived = await run(readModel([thread(PARENT), settled, live]), {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: PARENT,
    });
    expect(threadIn(archived.model, settled.id).archivedAt).not.toBeNull();
    expect(threadIn(archived.model, live.id).archivedAt).toBeNull();
    expect(threadIn(archived.model, live.id).attachedToParent).toBe(false);

    const unarchived = await run(archived.model, {
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive"),
      threadId: PARENT,
    });
    expect(threadIn(unarchived.model, settled.id).archivedAt).toBeNull();
  });

  it("lets only the server start a thread as another's child, and never under a child", async () => {
    const childOfChild: OrchestrationCommand = {
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: ThreadId.make("deep"),
      projectId,
      title: "Too deep",
      modelSelection: model,
      runtimeMode: "auto-accept-edits",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      parentThreadId: CHILD,
      attachedToParent: true,
      createdAt: at(1),
    };
    const family = readModel([
      thread(PARENT),
      thread(CHILD, { parentThreadId: PARENT, attachedToParent: true }),
    ]);
    expect(await refused(family, childOfChild)).toBe(true);
  });

  it("runs nothing in a child before its setup is done, and never a first turn whose request was cancelled", async () => {
    const started = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("auto"),
    );
    const created = await run(started.model, {
      type: "thread.create",
      commandId: CommandId.make("create-child"),
      threadId: CHILD,
      projectId,
      title: "Write the changelog",
      modelSelection: model,
      runtimeMode: "auto-accept-edits",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      parentThreadId: PARENT,
      parentTurnId: CALLER_TURN,
      attachedToParent: true,
      createdAt: at(2),
    });
    // The user typing into the child before its worktree exists is refused.
    expect(
      await refused(created.model, {
        type: "thread.turn.start",
        commandId: CommandId.make("user-early"),
        threadId: CHILD,
        message: { messageId: MessageId.make("early"), role: "user", text: "hi", attachments: [] },
        runtimeMode: "auto-accept-edits",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: at(3),
      }),
    ).toBe(true);
    // So is the parent's agent sending it a message.
    expect(
      await refused(created.model, {
        type: "thread.child.send",
        commandId: CommandId.make("send-early"),
        threadId: PARENT,
        requestId: ChildRequestId.make("send-1"),
        from: PRIMARY,
        callerTurnId: CALLER_TURN,
        childThreadId: CHILD,
        childMessageId: MessageId.make("send-early-message"),
        text: "Also do X",
        createdAt: at(3),
      }),
    ).toBe(true);
    // Stopped while it was set up: its first turn never starts.
    const stopped = await run(created.model, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop-parent"),
      threadId: PARENT,
      createdAt: at(4),
    });
    expect(
      await refused(stopped.model, {
        type: "thread.turn.start",
        commandId: CommandId.make("server:child-request:request-1:turn"),
        threadId: CHILD,
        message: { messageId: CHILD_MESSAGE, role: "user", text: launch().prompt, attachments: [] },
        runtimeMode: "auto-accept-edits",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
        createdAt: at(5),
      }),
    ).toBe(true);
  });

  it("refuses to create a child with more access than its parent has now", async () => {
    const narrowed = readModel([thread(PARENT, { runtimeMode: "approval-required" })]);
    expect(
      await refused(narrowed, {
        type: "thread.create",
        commandId: CommandId.make("create-wide"),
        threadId: CHILD,
        projectId,
        title: "Too much access",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: PARENT,
        attachedToParent: true,
        createdAt: at(1),
      }),
    ).toBe(true);
  });

  it("stopping a child also cuts off an answer it had just queued for its parent", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    const stopped = await run(delivered.model, {
      type: "thread.children.stop",
      commandId: CommandId.make("stop-children"),
      threadId: PARENT,
      childThreadIds: [CHILD],
      createdAt: at(11),
    });
    expect(threadIn(stopped.model, PARENT).queuedFollowUps).toEqual([]);
    expect(threadIn(stopped.model, CHILD).parentAttachmentEpoch).toBe(1);
  });

  it("a user turn in a child that was finishing background work hands back its answer so far first", async () => {
    const family = await familyWithRunningChild();
    const candidateTurn = TurnId.make("child-turn-1");
    const waiting: OrchestrationReadModel = {
      ...family,
      threads: family.threads.map((entry) =>
        entry.id === PARENT
          ? {
              ...entry,
              childRequests: {
                ...entry.childRequests,
                open: entry.childRequests.open.map((request) => ({
                  ...request,
                  status: "awaiting_background" as const,
                  candidateTurnId: candidateTurn,
                })),
              },
            }
          : entry.id === CHILD
            ? {
                ...entry,
                session: session(CHILD, { status: "ready", activeTurnId: null }),
                messages: [
                  ...entry.messages,
                  {
                    id: MessageId.make("child-answer"),
                    role: "assistant" as const,
                    text: "Started two helpers; waiting on them.",
                    turnId: candidateTurn,
                    streaming: false,
                    createdAt: at(4),
                    updatedAt: at(4),
                  },
                ],
              }
            : entry,
      ),
    };
    const userTurn = await run(waiting, {
      type: "thread.turn.start",
      commandId: CommandId.make("user-turn"),
      threadId: CHILD,
      message: {
        messageId: MessageId.make("user-message"),
        role: "user",
        text: "Also do X",
        attachments: [],
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: at(8),
    });
    const parent = threadIn(userTurn.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(
      parent.messages.find((message) => message.id === childReportMessageId(REQUEST))?.text,
    ).toContain("waiting on them");
  });
});
