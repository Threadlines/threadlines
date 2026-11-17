import {
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LEAD_PASS_NOT_RUN_ACTIVITY_KIND,
  MessageId,
  type OrchestrationSession,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { childStartRefusal } from "@threadlines/shared/childThreads";
import { LEAD_MOVE_REFUSAL } from "@threadlines/shared/projectLead";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { isProjectLeadThread } from "./commandInvariants.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { threadMoveRefusals } from "./threadMoveDecisions.ts";

const now = "2026-11-16T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const LEAD = ThreadId.make("lead");
const OTHER = ThreadId.make("other");
const CHILD = ThreadId.make("child");
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-5-5" };

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId,
    title: id,
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

type Planned = Omit<OrchestrationEvent, "sequence">;

async function run(current: OrchestrationReadModel, command: OrchestrationCommand) {
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

const refusal = async (current: OrchestrationReadModel, command: OrchestrationCommand) => {
  const exit = await Effect.runPromiseExit(
    decideOrchestrationCommand({ command, readModel: current }),
  );
  return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : null;
};

const setLead = (threadId: ThreadId | null): OrchestrationCommand => ({
  type: "project.lead.set",
  commandId: CommandId.make(`lead-${threadId ?? "none"}`),
  projectId,
  threadId,
});

const leadOf = (current: OrchestrationReadModel) =>
  current.projects.find((project) => project.id === projectId)?.leadThreadId ?? null;

describe("project lead chat", () => {
  it("names a lead, replaces it in one event, and stops having one", async () => {
    const start = readModel([thread(LEAD), thread(OTHER)]);
    const first = await run(start, setLead(LEAD));
    expect(leadOf(first.model)).toBe(LEAD);
    expect(isProjectLeadThread(first.model, thread(LEAD))).toBe(true);

    const replaced = await run(first.model, setLead(OTHER));
    expect(replaced.events).toHaveLength(1);
    expect(leadOf(replaced.model)).toBe(OTHER);
    expect(isProjectLeadThread(replaced.model, thread(LEAD))).toBe(false);

    const cleared = await run(replaced.model, setLead(null));
    expect(leadOf(cleared.model)).toBeNull();
  });

  it("refuses a thread another thread owns, an archived one, and General Chats", async () => {
    const owned = thread(CHILD, { parentThreadId: LEAD, attachedToParent: true });
    const archived = thread(OTHER, { archivedAt: now });
    const start = readModel([thread(LEAD), owned, archived]);
    expect(await refusal(start, setLead(CHILD))).toContain("belongs to the thread that started");
    expect(await refusal(start, setLead(OTHER))).toContain("Archived threads");

    const generalChats = {
      ...start,
      projects: start.projects.map((project) => ({ ...project, kind: "general-chat" as const })),
    };
    expect(await refusal(generalChats, setLead(LEAD))).not.toBeNull();
  });

  it("ends the lead when its thread is archived or deleted", async () => {
    const start = (await run(readModel([thread(LEAD)]), setLead(LEAD))).model;
    const archived = await run(start, {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: LEAD,
    });
    expect(leadOf(archived.model)).toBeNull();
    // Coming back from the archive does not make it the lead again.
    const unarchived = await run(archived.model, {
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive"),
      threadId: LEAD,
    });
    expect(leadOf(unarchived.model)).toBeNull();

    const deleted = await run(start, {
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: LEAD,
    });
    expect(leadOf(deleted.model)).toBeNull();
  });

  it("reads a pointer at an archived or missing thread as no lead", () => {
    const ghost = readModel([thread(LEAD, { archivedAt: now })]);
    const pointing = {
      ...ghost,
      projects: ghost.projects.map((project) => ({ ...project, leadThreadId: LEAD })),
    };
    expect(isProjectLeadThread(pointing, thread(LEAD))).toBe(false);
    const missing = { ...pointing, threads: [] };
    expect(isProjectLeadThread(missing, thread(LEAD))).toBe(false);
  });

  it("keeps the lead top-level and on this computer", async () => {
    const separated = thread(LEAD, { parentThreadId: OTHER, attachedToParent: false });
    const start = (await run(readModel([thread(OTHER), separated]), setLead(LEAD))).model;
    expect(
      await refusal(start, {
        type: "thread.parent-attachment.set",
        commandId: CommandId.make("attach"),
        threadId: LEAD,
        attached: true,
        createdAt: now,
      }),
    ).toContain("lead chat");

    const lead = start.threads.find((entry) => entry.id === LEAD)!;
    expect(threadMoveRefusals(start, lead)).toContainEqual({
      kind: "blocked",
      code: "lead",
      words: LEAD_MOVE_REFUSAL,
    });
  });
});

const LEAD_TURN = TurnId.make("lead-turn-1");
const PRIMARY = { participantId: null };

function session(threadId: ThreadId, overrides: Partial<OrchestrationSession> = {}) {
  return {
    threadId,
    status: "running",
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    runtimeMode: "auto-accept-edits",
    activeTurnId: LEAD_TURN,
    lastError: null,
    updatedAt: now,
    ...overrides,
  } satisfies OrchestrationSession;
}

/** A lead at work, and a thread the user started by hand. */
async function leadAndHandMade(target: Partial<OrchestrationThread> = {}) {
  return (
    await run(
      readModel([
        thread(LEAD, { session: session(LEAD), runtimeMode: "auto-accept-edits" }),
        thread(OTHER, { runtimeMode: "approval-required", ...target }),
      ]),
      setLead(LEAD),
    )
  ).model;
}

const PASS_MESSAGE = MessageId.make("pass-message-1");
const pass = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.lead.pass" }>> = {},
) =>
  ({
    type: "thread.lead.pass",
    commandId: CommandId.make("pass-1"),
    threadId: LEAD,
    from: PRIMARY,
    callerTurnId: LEAD_TURN,
    targetThreadId: OTHER,
    requestId: ChildRequestId.make("pass-request-1"),
    messageId: PASS_MESSAGE,
    text: "Fix the flaky checkout test.",
    createdAt: now,
    ...overrides,
  }) satisfies OrchestrationCommand;

const sendQueued = (messageId: MessageId): OrchestrationCommand => ({
  type: "thread.follow-up.send-queued",
  commandId: CommandId.make(`send-${messageId}`),
  threadId: OTHER,
  messageId,
  createdAt: now,
});

describe("lead chat passes", () => {
  it("queues a pass in a thread the lead did not start, records no request, and runs it there", async () => {
    const start = await leadAndHandMade();
    const passed = await run(start, pass());
    const lead = threadIn(passed.model, LEAD);
    const target = threadIn(passed.model, OTHER);
    expect(lead.childRequests.open).toEqual([]);
    expect(lead.childRequests.sendsSinceUser).toBe(1);
    const message = target.messages.find((entry) => entry.id === PASS_MESSAGE);
    expect(message?.fromThread).toMatchObject({
      threadId: LEAD,
      kind: "request",
      ceiling: { runtimeMode: "auto-accept-edits" },
    });

    const ran = await run(passed.model, sendQueued(PASS_MESSAGE));
    expect(ran.events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
    // Nothing is owed back: no request settles anywhere.
    expect(ran.events.some((event) => event.type.startsWith("thread.child-request"))).toBe(false);
    expect(threadIn(ran.model, OTHER).childRequests.passCeiling).toEqual({
      runtimeMode: "auto-accept-edits",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });

  it("holds what a passed-to thread sends its own threads to the pass's ceiling", async () => {
    const RAISED = ThreadId.make("raised-child");
    const ran = (
      await run(
        await run(
          await leadAndHandMade({
            session: session(OTHER, { status: "ready", activeTurnId: null }),
          }),
          pass(),
        ).then((r) => r.model),
        sendQueued(PASS_MESSAGE),
      )
    ).model;
    const OTHER_TURN = TurnId.make("other-turn-1");
    const own = { parentThreadId: OTHER, attachedToParent: true };
    const working = {
      ...ran,
      threads: [
        ...ran.threads.map((entry) =>
          entry.id === OTHER
            ? { ...entry, session: session(OTHER, { activeTurnId: OTHER_TURN }) }
            : entry,
        ),
        // The user raised this one above its parent, and above the lead.
        thread(RAISED, { ...own, runtimeMode: "full-access" }),
        thread(CHILD, { ...own, runtimeMode: "approval-required" }),
      ],
    };
    const send = (childThreadId: ThreadId): OrchestrationCommand => ({
      type: "thread.child.send",
      commandId: CommandId.make(`send-to-${childThreadId}`),
      threadId: OTHER,
      requestId: ChildRequestId.make(`send-to-${childThreadId}`),
      from: PRIMARY,
      callerTurnId: OTHER_TURN,
      childThreadId,
      childMessageId: MessageId.make(`message-to-${childThreadId}`),
      text: "Run it with full access.",
      createdAt: now,
    });
    expect(await refusal(working, send(RAISED))).toContain("more access than the lead chat");
    const within = await run(working, send(CHILD));
    expect(threadIn(within.model, OTHER).childRequests.open).toHaveLength(1);
  });

  it("refuses rooms, threads another thread owns, and threads the user stopped", async () => {
    const room = await leadAndHandMade({
      participants: [
        {
          id: "agent-1" as never,
          handle: "Reviewer",
          modelSelection: model,
          addedAt: now,
        } as never,
      ],
    });
    expect(await refusal(room, pass())).toContain("Rooms take work from the user");
    const owned = await leadAndHandMade({ parentThreadId: CHILD, attachedToParent: true });
    expect(await refusal(owned, pass())).toContain("Message the thread that started it");
    const stopped = await leadAndHandMade({
      latestTurn: {
        turnId: TurnId.make("t"),
        state: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    });
    expect(await refusal(stopped, pass())).toContain("The user stopped that thread");
    // A thread that is not the lead can't pass anything.
    const notLead = (await run(await leadAndHandMade(), setLead(null))).model;
    expect(await refusal(notLead, pass())).toContain("not a thread you started");
  });

  it("takes a pass back when a user message queued ahead widened the thread's access", async () => {
    const passed = (await run(await leadAndHandMade(), pass())).model;
    // The user raised the thread's access while the pass waited.
    const widened = (
      await run(passed, {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("widen"),
        threadId: OTHER,
        runtimeMode: "full-access",
        createdAt: now,
      })
    ).model;
    const sent = await run(widened, sendQueued(PASS_MESSAGE));
    expect(sent.events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
    const target = threadIn(sent.model, OTHER);
    expect(target.queuedFollowUps ?? []).toEqual([]);
    expect(target.activities.some((entry) => entry.kind === LEAD_PASS_NOT_RUN_ACTIVITY_KIND)).toBe(
      true,
    );
    expect(threadIn(sent.model, LEAD).childRequests.pendingNotes[0]?.text).toContain("did not run");
    expect(target.messages.find((entry) => entry.id === PASS_MESSAGE)?.notSent).toBe(true);
  });

  it("marks a pass the user took off the queue as never sent", async () => {
    const passed = (await run(await leadAndHandMade(), pass())).model;
    const unqueued = await run(passed, {
      type: "thread.follow-up.unqueue",
      commandId: CommandId.make("unqueue-pass"),
      threadId: OTHER,
      messageId: PASS_MESSAGE,
      createdAt: now,
    });
    const message = threadIn(unqueued.model, OTHER).messages.find((m) => m.id === PASS_MESSAGE);
    expect(message?.notSent).toBe(true);
  });

  it("marks a pass refused right before it reached the agent, and never runs it again", async () => {
    const ran = (
      await run(
        await run(await leadAndHandMade(), pass()).then((r) => r.model),
        sendQueued(PASS_MESSAGE),
      )
    ).model;
    // The provider layer's last check refused it: the thread's access went up.
    const refused = await run(ran, {
      type: "thread.lead-pass.not-run",
      commandId: CommandId.make("not-run"),
      threadId: OTHER,
      messageId: PASS_MESSAGE,
      createdAt: now,
    });
    const target = threadIn(refused.model, OTHER);
    expect(target.messages.find((entry) => entry.id === PASS_MESSAGE)?.notSent).toBe(true);
    expect(target.activities.some((entry) => entry.kind === LEAD_PASS_NOT_RUN_ACTIVITY_KIND)).toBe(
      true,
    );
    expect(threadIn(refused.model, LEAD).childRequests.pendingNotes[0]?.text).toContain(
      "did not run",
    );
    // Said once: a second report changes nothing.
    expect(
      (
        await run(refused.model, {
          type: "thread.lead-pass.not-run",
          commandId: CommandId.make("not-run-again"),
          threadId: OTHER,
          messageId: PASS_MESSAGE,
          createdAt: now,
        })
      ).events,
    ).toEqual([]);
    // Back within the ceiling, a retry still doesn't send it.
    const failed = {
      ...refused.model,
      threads: refused.model.threads.map((entry) =>
        entry.id === OTHER
          ? {
              ...entry,
              session: session(OTHER, { status: "error", activeTurnId: null, lastError: "boom" }),
            }
          : entry,
      ),
    };
    expect(
      await refusal(failed, {
        type: "thread.turn.retry",
        commandId: CommandId.make("retry-not-sent"),
        threadId: OTHER,
        createdAt: now,
      }),
    ).toContain("was never sent. Send it yourself to run it");
  });

  it("refuses to retry a pass above its ceiling: the user sends it themselves", async () => {
    const ran = (
      await run(
        await run(await leadAndHandMade(), pass()).then((r) => r.model),
        sendQueued(PASS_MESSAGE),
      )
    ).model;
    const failed = {
      ...ran,
      threads: ran.threads.map((entry) =>
        entry.id === OTHER
          ? {
              ...entry,
              runtimeMode: "full-access" as const,
              session: session(OTHER, { status: "error", activeTurnId: null, lastError: "boom" }),
            }
          : entry,
      ),
    };
    expect(
      await refusal(failed, {
        type: "thread.turn.retry",
        commandId: CommandId.make("retry"),
        threadId: OTHER,
        createdAt: now,
      }),
    ).toContain("Send it yourself to run it");
  });

  it("retries the failed turn, never a pass still waiting in the queue", async () => {
    // The pass waits behind a turn of the user's that then fails.
    const userMessage = MessageId.make("user-own");
    const busy = await leadAndHandMade({
      messages: [
        {
          id: userMessage,
          role: "user",
          text: "Mine.",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const passed = (await run(busy, pass())).model;
    const failed = {
      ...passed,
      threads: passed.threads.map((entry) =>
        entry.id === OTHER
          ? {
              ...entry,
              session: session(OTHER, { status: "error", activeTurnId: null, lastError: "boom" }),
            }
          : entry,
      ),
    };
    const retried = await run(failed, {
      type: "thread.turn.retry",
      commandId: CommandId.make("retry-own"),
      threadId: OTHER,
      createdAt: now,
    });
    const requested = retried.events.find((event) => event.type === "thread.turn-start-requested");
    expect((requested?.payload as { messageId?: string }).messageId).toBe(userMessage);
    expect(threadIn(retried.model, OTHER).queuedFollowUps?.map((entry) => entry.messageId)).toEqual(
      [PASS_MESSAGE],
    );
  });

  it("keeps a passed-to thread from starting threads through a continue, until the user writes", async () => {
    const ran = (
      await run(
        await run(await leadAndHandMade(), pass()).then((r) => r.model),
        sendQueued(PASS_MESSAGE),
      )
    ).model;
    const blocked = (current: OrchestrationReadModel) =>
      // Asked from inside a turn of its own, as thread_start is.
      childStartRefusal(
        { ...threadIn(current, OTHER), session: session(OTHER) },
        { from: PRIMARY, callerTurnId: LEAD_TURN, count: 1 },
      );
    const idle = {
      ...ran,
      threads: ran.threads.map((entry) =>
        entry.id === OTHER
          ? { ...entry, session: session(OTHER, { status: "ready", activeTurnId: null }) }
          : entry,
      ),
    };
    const turn = (
      id: string,
      extra: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>>,
    ) =>
      ({
        type: "thread.turn.start",
        commandId: CommandId.make(`turn-${id}`),
        threadId: OTHER,
        message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
        ...extra,
      }) satisfies OrchestrationCommand;
    const continued = (await run(idle, turn("continue", { trigger: "usageLimitReset" }))).model;
    expect(blocked(continued)?.detail).toContain("the lead chat passed on");
    // Nor does a turn no person sent (an automatic fix, a scheduled run).
    const automatic = (
      await run(
        {
          ...continued,
          threads: continued.threads.map((entry) =>
            entry.id === OTHER
              ? { ...entry, session: session(OTHER, { status: "ready", activeTurnId: null }) }
              : entry,
          ),
        },
        turn("auto-fix", {}),
      )
    ).model;
    expect(blocked(automatic)?.detail).toContain("the lead chat passed on");
    const settled = {
      ...continued,
      threads: continued.threads.map((entry) =>
        entry.id === OTHER
          ? { ...entry, session: session(OTHER, { status: "ready", activeTurnId: null }) }
          : entry,
      ),
    };
    const wrote = (await run(settled, turn("user", { composer: "typed" }))).model;
    expect(threadIn(wrote, OTHER).childRequests.passCeiling).toBeUndefined();
  });

  it("starts only the threads the user left checked, and tells the agent which it didn't", async () => {
    const first = ChildRequestId.make("start-1");
    const second = ChildRequestId.make("start-2");
    const asked = (
      await run(readModel([thread(LEAD, { session: session(LEAD) })]), {
        type: "thread.child.start",
        commandId: CommandId.make("ask"),
        threadId: LEAD,
        batchId: ChildRequestBatchId.make("batch"),
        from: PRIMARY,
        callerTurnId: LEAD_TURN,
        mode: "ask",
        children: [first, second].map((requestId, index) => ({
          requestId,
          childThreadId: ThreadId.make(`kid-${index}`),
          childMessageId: MessageId.make(`kid-message-${index}`),
          launch: {
            title: `Task ${index + 1}`,
            prompt: "Do it.",
            modelSelection: model,
            runtimeMode: "auto-accept-edits",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            reportBack: true,
            runSetup: true,
            workspace: { kind: "worktree", projectCwd: "/repo", baseRef: "main" },
          },
        })),
        createdAt: now,
      })
    ).model;
    const answered = await run(asked, {
      type: "thread.child-request.respond",
      commandId: CommandId.make("respond"),
      threadId: LEAD,
      batchId: ChildRequestBatchId.make("batch"),
      choice: "start",
      requestIds: [first],
      createdAt: now,
    });
    const state = threadIn(answered.model, LEAD).childRequests;
    expect(state.open.map((request) => [request.requestId, request.status])).toEqual([
      [first, "starting"],
    ]);
    expect(state.pendingNotes[0]?.text).toContain("but not 'Task 2'");
  });
});

const threadIn = (current: OrchestrationReadModel, id: ThreadId) => {
  const found = current.threads.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no thread ${id}`);
  return found;
};
