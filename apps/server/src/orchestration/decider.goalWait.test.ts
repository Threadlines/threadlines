import {
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  CommandRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadGoal,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-11-18T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const projectId = ProjectId.make("project-1");
const THREAD = ThreadId.make("goal-thread");

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
  return { events, model: { ...next, snapshotSequence: sequence } };
}

const emptyModel: OrchestrationReadModel = {
  snapshotSequence: 0,
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
  threads: [],
};

const goal = (status: OrchestrationThreadGoal["status"]): OrchestrationThreadGoal => ({
  threadId: THREAD,
  objective: "count.txt holds 1 to 8",
  status,
  tokenBudget: null,
  tokensUsed: 100,
  timeUsedSeconds: 10,
  createdAt: now,
  updatedAt: now,
});

/** What the provider says the goal is now (runtime ingestion). */
const reported = (status: OrchestrationThreadGoal["status"]): OrchestrationCommand => ({
  type: "thread.goal.state.set",
  commandId: CommandId.make(`reported-${status}-${Math.random()}`),
  threadId: THREAD,
  goal: goal(status),
  createdAt: at(1),
});

const sync = (scheduleAnswerWaiting = false): OrchestrationCommand => ({
  type: "thread.goal.wait.sync",
  commandId: CommandId.make(`sync-${Math.random()}`),
  threadId: THREAD,
  scheduleAnswerWaiting,
  createdAt: at(2),
});

const patchThread = (
  model: OrchestrationReadModel,
  patch: (thread: OrchestrationThread) => Partial<OrchestrationThread>,
): OrchestrationReadModel => ({
  ...model,
  threads: model.threads.map((thread) =>
    thread.id === THREAD ? { ...thread, ...patch(thread) } : thread,
  ),
});

const commandCard = {
  requestId: CommandRequestId.make("card-1"),
  turnId: TurnId.make("turn-1"),
  participantId: null,
  command: "pnpm install",
  reason: "Needs your network",
  dialect: "posix" as const,
  dismissedAt: null,
  createdAt: now,
  updatedAt: now,
};

const startedThread = (status: "running" | "awaiting_user") => ({
  requestId: ChildRequestId.make(`request-${status}`),
  batchId: ChildRequestBatchId.make("batch-1"),
  kind: "start" as const,
  from: { participantId: null },
  callerTurnId: TurnId.make("turn-1"),
  deliveryEpoch: 0,
  status,
  childThreadId: ThreadId.make(`child-${status}`),
  childMessageId: MessageId.make(`child-message-${status}`),
  createdAt: now,
});

/** A Codex thread whose goal the provider reports active. */
async function threadWithActiveGoal() {
  const created = await run(emptyModel, {
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: THREAD,
    projectId,
    title: "Count",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.2-sol" },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
  return (await run(created.model, reported("active"))).model;
}

const goalOf = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === THREAD)?.goal ?? null;
const goalRequest = (events: ReadonlyArray<Planned>) =>
  events.find((event) => event.type === "thread.goal-set-requested")?.payload;

describe("decider goal wait pause", () => {
  it("pauses an active goal while a card waits, and resumes it once the card is answered", async () => {
    const waiting = patchThread(await threadWithActiveGoal(), () => ({
      commandRequests: [commandCard],
    }));
    const paused = await run(waiting, sync());
    expect(goalRequest(paused.events)).toMatchObject({ status: "paused", origin: "automatic" });
    expect(goalOf(paused.model)).toMatchObject({ status: "active", pausedForWait: true });
    // Asked again before the provider confirms: nothing more.
    expect((await run(paused.model, sync())).events).toEqual([]);

    // The provider confirms; the mark stays through its report.
    const confirmed = await run(paused.model, reported("paused"));
    expect(goalOf(confirmed.model)).toMatchObject({ status: "paused", pausedForWait: true });

    const answered = patchThread(confirmed.model, () => ({
      commandRequests: [{ ...commandCard, dismissedAt: at(3) }],
    }));
    const resumed = await run(answered, sync());
    expect(goalRequest(resumed.events)).toMatchObject({ status: "active", origin: "automatic" });
    expect(goalOf(resumed.model)?.pausedForWait).toBeUndefined();
  });

  it("leaves the goal to the user once they paused, resumed or cleared it themselves", async () => {
    const paused = await run(
      patchThread(await threadWithActiveGoal(), () => ({ commandRequests: [commandCard] })),
      sync(),
    );
    const confirmed = (await run(paused.model, reported("paused"))).model;
    const answered = (thread: OrchestrationReadModel) =>
      patchThread(thread, () => ({ commandRequests: [] }));

    // The user resumed while the card waited: their goal now, never paused again by the answer.
    const userResumed = await run(confirmed, {
      type: "thread.goal.set",
      commandId: CommandId.make("user-resume"),
      threadId: THREAD,
      status: "active",
      createdAt: at(3),
    });
    expect(goalOf(userResumed.model)?.pausedForWait).toBeUndefined();
    expect(goalRequest(userResumed.events)).not.toHaveProperty("origin");

    // The user paused it themselves, then answered: it stays paused.
    const userPaused = await run(confirmed, {
      type: "thread.goal.set",
      commandId: CommandId.make("user-pause"),
      threadId: THREAD,
      status: "paused",
      createdAt: at(3),
    });
    expect((await run(answered(userPaused.model), sync())).events).toEqual([]);

    // Cleared: nothing resumes, whatever the provider reports first.
    const cleared = await run(confirmed, {
      type: "thread.goal.clear",
      commandId: CommandId.make("user-clear"),
      threadId: THREAD,
      createdAt: at(3),
    });
    expect(goalOf(cleared.model)?.pausedForWait).toBeUndefined();
    expect((await run(answered(cleared.model), sync())).events).toEqual([]);
  });

  it("leaves a goal that completed alone", async () => {
    const paused = await run(
      patchThread(await threadWithActiveGoal(), () => ({ commandRequests: [commandCard] })),
      sync(),
    );
    const completed = await run(paused.model, reported("complete"));
    expect(goalOf(completed.model)?.pausedForWait).toBeUndefined();
    const answered = patchThread(completed.model, () => ({ commandRequests: [] }));
    expect((await run(answered, sync())).events).toEqual([]);
  });

  it("stays paused while threads it started still owe reports, and until the last wait ends", async () => {
    const base = await threadWithActiveGoal();
    const waitingOnBoth = patchThread(base, (thread) => ({
      childRequests: { ...thread.childRequests, open: [startedThread("awaiting_user")] },
      commandRequests: [commandCard],
    }));
    const paused = (await run(await (await run(waitingOnBoth, sync())).model, reported("paused")))
      .model;

    // The card is answered and the threads start: still waiting on their reports.
    const started = patchThread(paused, (thread) => ({
      childRequests: { ...thread.childRequests, open: [startedThread("running")] },
      commandRequests: [],
    }));
    expect((await run(started, sync())).events).toEqual([]);

    // The last report arrives as a turn about to start: the resume waits for it.
    const reportStarting = patchThread(started, (thread) => ({
      childRequests: { ...thread.childRequests, open: [] },
      session: {
        threadId: THREAD,
        status: "starting",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: at(4),
      },
    }));
    expect((await run(reportStarting, sync())).events).toEqual([]);

    // Running now: the goal carries on after that turn.
    const reportRunning = patchThread(reportStarting, (thread) => ({
      session: { ...thread.session!, status: "running", activeTurnId: TurnId.make("report") },
    }));
    expect(goalRequest((await run(reportRunning, sync())).events)).toMatchObject({
      status: "active",
      origin: "automatic",
    });
  });

  it("pauses for a scheduled-task card, which the scheduler holds", async () => {
    const paused = await run(await threadWithActiveGoal(), sync(true));
    expect(goalRequest(paused.events)).toMatchObject({ status: "paused" });
  });

  it("resumes a goal it paused when the wait ended while the server was down", async () => {
    // The mark is part of the goal the projection keeps, so it is there
    // after a restart: only the answer is new.
    const paused = await run(
      patchThread(await threadWithActiveGoal(), () => ({ commandRequests: [commandCard] })),
      sync(),
    );
    const restarted = patchThread((await run(paused.model, reported("paused"))).model, () => ({
      commandRequests: [],
    }));
    expect(goalRequest((await run(restarted, sync())).events)).toMatchObject({ status: "active" });
  });
});
