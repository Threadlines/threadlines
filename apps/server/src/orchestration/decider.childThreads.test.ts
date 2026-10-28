import {
  type ChildThreadLaunch,
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EnvironmentId,
  EMPTY_CHILD_REQUEST_STATE,
  EventId,
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

import { childReportMessageId, isCancelledReport } from "./childThreadDecisions.ts";
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

  it("records a report steered into the parent's running turn there, without starting another", async () => {
    const delivered = await run(await familyWithRunningChild(), settleAnswered());
    const steered = await run(delivered.model, {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("steer-report"),
      threadId: PARENT,
      messageId: childReportMessageId(REQUEST),
      steeredTurnId: CALLER_TURN,
      createdAt: at(12),
    });
    expect(steered.events.map((event) => event.type)).toEqual([
      "thread.follow-up-unqueued",
      "thread.message-sent",
    ]);
    const parent = threadIn(steered.model, PARENT);
    expect(parent.queuedFollowUps).toEqual([]);
    expect(
      parent.messages.find((message) => message.id === childReportMessageId(REQUEST)),
    ).toMatchObject({
      turnId: CALLER_TURN,
      fromThread: { threadId: CHILD, kind: "report" },
      createdAt: at(10),
    });
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

  it("never makes a child whose request was stopped while its worktree was cut, whether or not it reports back", async () => {
    for (const reportBack of [true, false]) {
      const started = await run(
        readModel([thread(PARENT, { session: session(PARENT) })]),
        startCommand("auto", { reportBack }),
      );
      const turnId = CommandId.make("server:child-request:request-1:turn");
      const childStart: OrchestrationCommand = {
        type: "thread.start",
        commandId: turnId,
        threadId: CHILD,
        create: {
          projectId,
          title: "Write the changelog",
          modelSelection: model,
          runtimeMode: "auto-accept-edits",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: "threadlines/0c1d2e3f",
          worktreePath: "/repo-worktrees/0c1d2e3f",
          parentThreadId: PARENT,
          parentTurnId: CALLER_TURN,
          attachedToParent: reportBack,
          createdAt: at(1),
        },
        setupScriptClaim: {
          id: EventId.make(`setup-claim-${reportBack}`),
          tone: "info",
          kind: "setup-script.requested",
          summary: "Starting setup script",
          payload: { worktreePath: "/repo-worktrees/0c1d2e3f" },
          turnId: null,
          createdAt: at(3),
        },
        first: {
          type: "thread.turn.start",
          commandId: turnId,
          threadId: CHILD,
          message: {
            messageId: CHILD_MESSAGE,
            role: "user",
            text: launch().prompt,
            attachments: [],
          },
          runtimeMode: "auto-accept-edits",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          fromThread: { threadId: PARENT, requestId: REQUEST, kind: "request" },
          createdAt: at(3),
        },
      };
      // Not stopped: the child appears in its worktree, working on the request.
      const made = await run(started.model, childStart);
      expect(threadIn(made.model, CHILD).worktreePath).toBe("/repo-worktrees/0c1d2e3f");
      expect(threadIn(made.model, PARENT).childRequests.open[0]?.status).toBe("running");
      // Stopped first: it is never made.
      const stopped = await run(started.model, {
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop-parent"),
        threadId: PARENT,
        createdAt: at(2),
      });
      expect(await refused(stopped.model, childStart)).toBe(true);
    }
  });

  it("stopping a child still being set up settles its request, so it is never made", async () => {
    const started = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("auto"),
    );
    // Its thread doesn't exist yet: a message to it waits for it to start.
    expect(
      await refused(started.model, {
        type: "thread.child.send",
        commandId: CommandId.make("send-early"),
        threadId: PARENT,
        requestId: ChildRequestId.make("send-1"),
        from: PRIMARY,
        callerTurnId: CALLER_TURN,
        childThreadId: CHILD,
        childMessageId: MessageId.make("send-early-message"),
        text: "Also do X",
        createdAt: at(2),
      }),
    ).toBe(true);
    const stopped = await run(started.model, {
      type: "thread.children.stop",
      commandId: CommandId.make("stop-child"),
      threadId: PARENT,
      childThreadIds: [CHILD],
      createdAt: at(2),
    });
    expect(threadIn(stopped.model, PARENT).childRequests.open).toEqual([]);
    expect(stopped.model.threads.some((entry) => entry.id === CHILD)).toBe(false);
  });

  it("a child whose setup failed before it was made still reports to the agent that asked, and Stop still catches it", async () => {
    const started = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("auto"),
    );
    const failed = await run(started.model, {
      type: "thread.child-request.settle",
      commandId: CommandId.make("server:child-request:request-1:settle"),
      threadId: PARENT,
      requestId: REQUEST,
      outcome: "failed",
      reply: {
        messageId: childReportMessageId(REQUEST),
        text: "Couldn't start 'Write the changelog': Couldn't set up its worktree: disk full",
        turnId: null,
      },
      error: "Couldn't set up its worktree: disk full",
      createdAt: at(5),
    });
    expect(
      threadIn(failed.model, PARENT).messages.find(
        (message) => message.id === childReportMessageId(REQUEST),
      )?.fromThread,
    ).toMatchObject({ threadId: CHILD, kind: "report", neverMade: true });
    expect(failed.model.threads.some((entry) => entry.id === CHILD)).toBe(false);
    // The parent's turn has ended by now: the report goes out as its next turn.
    const idle: OrchestrationReadModel = {
      ...failed.model,
      threads: failed.model.threads.map((entry) =>
        entry.id === PARENT
          ? { ...entry, session: session(PARENT, { status: "ready", activeTurnId: null }) }
          : entry,
      ),
    };
    const sendReport = {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("send-report"),
      threadId: PARENT,
      messageId: childReportMessageId(REQUEST),
      createdAt: at(6),
    } as const;
    const sent = await run(idle, sendReport);
    expect(sent.events.map((event) => event.type)).toContain("thread.turn-start-requested");
    // Stop while that turn is prepared still catches it: with no family left
    // to move it, the delivery epoch moves for the report alone.
    const stopped = await run(sent.model, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop"),
      threadId: PARENT,
      createdAt: at(7),
    });
    const parent = threadIn(stopped.model, PARENT);
    const origin = parent.messages.find(
      (message) => message.id === childReportMessageId(REQUEST),
    )?.fromThread;
    expect(origin !== undefined && isCancelledReport(parent, origin, null)).toBe(true);
  });

  it("deleting a child that runs on its own while it is set up settles its start, so nothing reports a thread the user deleted", async () => {
    const started = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("auto", { reportBack: false }),
    );
    // Made before its setup finished (as an older build did), on its own.
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
      attachedToParent: false,
      createdAt: at(2),
    });
    const deleted = await run(created.model, {
      type: "thread.delete",
      commandId: CommandId.make("delete-child"),
      threadId: CHILD,
    });
    expect(threadIn(deleted.model, PARENT).childRequests.open).toEqual([]);
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

  it("a separated child keeps the parent's message still queued for it, as its own work", async () => {
    const family = await familyWithRunningChild();
    const busyChild = (model: OrchestrationReadModel) => ({
      ...model,
      threads: model.threads.map((entry) =>
        entry.id === CHILD
          ? { ...entry, session: session(CHILD, { activeTurnId: TurnId.make("child-turn-1") }) }
          : entry,
      ),
    });
    const sent = await run(busyChild(family), {
      type: "thread.child.send",
      commandId: CommandId.make("send"),
      threadId: PARENT,
      requestId: ChildRequestId.make("send-1"),
      from: PRIMARY,
      callerTurnId: CALLER_TURN,
      childThreadId: CHILD,
      childMessageId: MessageId.make("send-message"),
      text: "Also update the README",
      createdAt: at(6),
    });
    const separated = await run(sent.model, {
      type: "thread.parent-attachment.set",
      commandId: CommandId.make("separate"),
      threadId: CHILD,
      attached: false,
      createdAt: at(7),
    });
    const idle: OrchestrationReadModel = {
      ...separated.model,
      threads: separated.model.threads.map((entry) =>
        entry.id === CHILD
          ? { ...entry, session: session(CHILD, { status: "ready", activeTurnId: null }) }
          : entry,
      ),
    };
    const ran = await run(idle, {
      type: "thread.follow-up.send-queued",
      commandId: CommandId.make("send-queued"),
      threadId: CHILD,
      messageId: MessageId.make("send-message"),
      createdAt: at(8),
    });
    expect(ran.events.map((event) => event.type)).toContain("thread.turn-start-requested");
  });

  it("deleting a parent with its threads leaves archived children alone, separated", async () => {
    const archivedChild = thread(ThreadId.make("archived-child"), {
      parentThreadId: PARENT,
      attachedToParent: true,
      archivedAt: at(1),
    });
    const liveChild = thread(CHILD, { parentThreadId: PARENT, attachedToParent: true });
    const deleted = await run(readModel([thread(PARENT), liveChild, archivedChild]), {
      type: "thread.delete",
      commandId: CommandId.make("delete-all"),
      threadId: PARENT,
      withChildren: true,
    });
    expect(threadIn(deleted.model, CHILD).deletedAt).not.toBeNull();
    expect(threadIn(deleted.model, archivedChild.id).deletedAt).toBeNull();
    expect(threadIn(deleted.model, archivedChild.id).attachedToParent).toBe(false);
  });

  it("archiving a parent separates a child that is still being set up instead of archiving it", async () => {
    const started = await run(
      readModel([thread(PARENT, { session: session(PARENT) })]),
      startCommand("auto"),
    );
    const settingUp: OrchestrationReadModel = {
      ...started.model,
      threads: [
        ...started.model.threads,
        thread(CHILD, { parentThreadId: PARENT, attachedToParent: true }),
      ],
    };
    const archived = await run(settingUp, {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: PARENT,
    });
    expect(threadIn(archived.model, CHILD).archivedAt).toBeNull();
    expect(threadIn(archived.model, CHILD).attachedToParent).toBe(false);
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

// ---------------------------------------------------------------------------
// Children on a linked computer (docs/design/fleet.md, Part 2)
// ---------------------------------------------------------------------------

const MAC_MINI = EnvironmentId.make("env-mac-mini");
const REMOTE_CHILD = ThreadId.make("remote-child");
const remoteTarget = {
  environmentId: MAC_MINI,
  label: "Mac mini",
  threadId: REMOTE_CHILD,
  status: "accepted" as const,
};

/** A parent whose child on a linked computer has started and is working. */
async function familyWithRemoteChild() {
  const started = await run(readModel([thread(PARENT, { session: session(PARENT) })]), {
    ...startCommand("auto"),
    children: [
      {
        requestId: REQUEST,
        childThreadId: REMOTE_CHILD,
        childMessageId: CHILD_MESSAGE,
        launch: launch({
          workspace: { kind: "remote", projectKey: "github.com/x/y", checkout: "worktree" },
          target: { environmentId: MAC_MINI, label: "Mac mini" },
        }),
      },
    ],
  });
  const accepted = await run(started.model, {
    type: "thread.child-request.update",
    commandId: CommandId.make("remote-accepted"),
    threadId: PARENT,
    requestId: REQUEST,
    status: "running",
    remote: remoteTarget,
    createdAt: at(2),
  });
  const recorded = await run(accepted.model, {
    type: "thread.remote-child.update",
    commandId: CommandId.make("remote-child"),
    threadId: PARENT,
    child: {
      environmentId: MAC_MINI,
      label: "Mac mini",
      threadId: REMOTE_CHILD,
      handle: "Claude",
      title: "Write the changelog",
      attachmentEpoch: 0,
      cachedStatus: "working",
      updatedAt: at(2),
    },
    createdAt: at(2),
  });
  return { started, model: recorded.model };
}

describe("decider child threads on a linked computer", () => {
  it("keeps a start for a linked computer on the parent only, waiting to be sent", async () => {
    const { started, model: family } = await familyWithRemoteChild();
    expect(new Set(started.events.map((event) => event.aggregateId))).toEqual(new Set([PARENT]));
    expect(started.events[0]?.payload).toMatchObject({
      request: { remote: { environmentId: MAC_MINI, status: "sending", threadId: null } },
    });
    expect(family.threads.some((entry) => entry.id === REMOTE_CHILD)).toBe(false);
    expect(threadIn(family, PARENT).childRequests.remoteChildren?.[0]?.threadId).toBe(REMOTE_CHILD);
  });

  it("delivers a linked computer's answer as a report from that computer, writing nothing else", async () => {
    const { model: family } = await familyWithRemoteChild();
    const delivered = await run(family, settleAnswered());
    expect(delivered.events.map((event) => event.type)).toEqual([
      "thread.child-request-settled",
      "thread.message-sent",
      "thread.follow-up-queued",
    ]);
    const parent = threadIn(delivered.model, PARENT);
    const report = parent.messages.find((message) => message.id === childReportMessageId(REQUEST));
    expect(report?.fromThread).toMatchObject({
      threadId: REMOTE_CHILD,
      kind: "report",
      environmentId: MAC_MINI,
      attachmentEpoch: 0,
    });
    // The child record outlives the request, for thread_read and thread_send.
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.remoteChildren?.map((child) => child.threadId)).toEqual([
      REMOTE_CHILD,
    ]);
  });

  it("drops a linked computer's report whose epoch went stale before it was sent", async () => {
    const { model: family } = await familyWithRemoteChild();
    const delivered = await run(family, settleAnswered());
    const moved: OrchestrationReadModel = {
      ...delivered.model,
      threads: delivered.model.threads.map((entry) =>
        entry.id === PARENT
          ? {
              ...entry,
              childRequests: { ...entry.childRequests, deliveryEpoch: 1 },
            }
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

  it("Stop in the parent settles the request and owes the linked computer a cancel that stops it there", async () => {
    const { model: family } = await familyWithRemoteChild();
    const stopped = await run(family, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("stop"),
      threadId: PARENT,
      createdAt: at(5),
    });
    const parent = threadIn(stopped.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.remoteCancels).toEqual([
      {
        requestId: REQUEST,
        environmentId: MAC_MINI,
        threadId: REMOTE_CHILD,
        cancelRequest: true,
        stopThread: true,
        createdAt: at(5),
      },
    ]);
    // Its answer, arriving after Stop, comes back to no one.
    expect(await refused(stopped.model, settleAnswered())).toBe(true);
    // Once the linked computer confirmed, the cancel leaves the outbox.
    const confirmed = await run(stopped.model, {
      type: "thread.remote-cancels.delivered",
      commandId: CommandId.make("cancels-delivered"),
      threadId: PARENT,
      requestIds: [REQUEST],
      createdAt: at(6),
    });
    expect(threadIn(confirmed.model, PARENT).childRequests.remoteCancels).toEqual([]);
  });

  it("thread_stop on a child there cuts off its answers and owes that computer a stop", async () => {
    const { model: family } = await familyWithRemoteChild();
    const stopped = await run(family, {
      type: "thread.children.stop",
      commandId: CommandId.make("children-stop"),
      threadId: PARENT,
      childThreadIds: [REMOTE_CHILD],
      createdAt: at(5),
    });
    // Nothing is stopped here: the child isn't here.
    expect(stopped.events.some((event) => event.type === "thread.session-stop-requested")).toBe(
      false,
    );
    const parent = threadIn(stopped.model, PARENT);
    expect(parent.childRequests.open).toEqual([]);
    expect(parent.childRequests.remoteChildren?.[0]?.attachmentEpoch).toBe(1);
    expect(parent.childRequests.remoteCancels?.[0]).toMatchObject({
      requestId: REQUEST,
      stopThread: true,
      threadId: REMOTE_CHILD,
    });
  });

  it("keeps a message to a child there on the parent, with its text, until that computer has it", async () => {
    const { model: family } = await familyWithRemoteChild();
    const answered = await run(family, settleAnswered());
    const SEND = ChildRequestId.make("send-1");
    const sent = await run(answered.model, {
      type: "thread.child.send",
      commandId: CommandId.make("send"),
      threadId: PARENT,
      requestId: SEND,
      from: PRIMARY,
      callerTurnId: CALLER_TURN,
      childThreadId: REMOTE_CHILD,
      childMessageId: MessageId.make("send-message-1"),
      text: "Add the security fixes too.",
      createdAt: at(13),
    });
    expect(new Set(sent.events.map((event) => event.aggregateId))).toEqual(new Set([PARENT]));
    expect(threadIn(sent.model, PARENT).childRequests.open[0]).toMatchObject({
      requestId: SEND,
      kind: "send",
      status: "queued",
      text: "Add the security fixes too.",
      remote: { environmentId: MAC_MINI, threadId: REMOTE_CHILD, status: "sending" },
    });
  });

  it("only the thread a link started takes that computer's message, and keeps where it came from", async () => {
    const origin = {
      linkDeviceId: "device-windows",
      environmentId: EnvironmentId.make("env-windows"),
      environmentLabel: "Windows PC",
      threadId: ThreadId.make("windows-parent"),
      threadTitle: "Ship the 0.6 release",
    };
    const queue = (threadId: ThreadId): OrchestrationCommand => ({
      type: "thread.remote-request.queue",
      commandId: CommandId.make(`queue-${threadId}`),
      threadId,
      messageId: MessageId.make("remote-message-1"),
      text: "Add the security fixes too.",
      fromThread: {
        threadId: origin.threadId,
        requestId: ChildRequestId.make("send-1"),
        kind: "request",
        environmentId: origin.environmentId,
      },
      createdAt: at(1),
    });
    const current = readModel([thread(CHILD, { remoteOrigin: origin }), thread(PARENT)]);
    expect(await refused(current, queue(PARENT))).toBe(true);
    const queued = await run(current, queue(CHILD));
    expect(queued.events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.follow-up-queued",
    ]);
    expect(threadIn(queued.model, CHILD).queuedFollowUps?.[0]?.fromThread).toMatchObject({
      environmentId: origin.environmentId,
      kind: "request",
    });
  });
});
