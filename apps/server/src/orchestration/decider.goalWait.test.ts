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

/** The thread with the one command card waiting, then answered (skipped). */
const withCard = (model: OrchestrationReadModel) =>
  patchThread(model, () => ({ commandRequests: [commandCard] }));
const cardAnswered = (model: OrchestrationReadModel) =>
  patchThread(model, () => ({ commandRequests: [{ ...commandCard, dismissedAt: at(3) }] }));

/** Paused for the card, and the provider has confirmed it. */
async function pausedForCard() {
  const paused = await run(withCard(await threadWithActiveGoal()), sync());
  return (await run(paused.model, reported("paused"))).model;
}

const userGoal = (status: "active" | "paused"): OrchestrationCommand => ({
  type: "thread.goal.set",
  commandId: CommandId.make(`user-${status}-${Math.random()}`),
  threadId: THREAD,
  status,
  createdAt: at(3),
});

describe("decider goal wait pause", () => {
  it("pauses an active goal while a card waits, and resumes it once the card is answered", async () => {
    const paused = await run(withCard(await threadWithActiveGoal()), sync());
    expect(goalRequest(paused.events)).toMatchObject({ status: "paused", origin: "automatic" });
    expect(goalOf(paused.model)).toMatchObject({ status: "active", waitPause: "paused" });
    // Asked again before the provider confirms: nothing more.
    expect((await run(paused.model, sync())).events).toEqual([]);

    const confirmed = await run(paused.model, reported("paused"));
    expect(goalOf(confirmed.model)).toMatchObject({ status: "paused", waitPause: "paused" });

    const resumed = await run(cardAnswered(confirmed.model), sync());
    expect(goalRequest(resumed.events)).toMatchObject({ status: "active", origin: "automatic" });
    // Marked until the provider says it is active again.
    expect(goalOf(resumed.model)?.waitPause).toBe("resuming");
    const active = await run(resumed.model, reported("active"));
    expect(goalOf(active.model)?.waitPause).toBeUndefined();
  });

  it("keeps a resume the user made during the wait, and never pauses it again for that wait", async () => {
    const userResumed = await run(await pausedForCard(), userGoal("active"));
    expect(goalRequest(userResumed.events)).not.toHaveProperty("origin");
    const active = (await run(userResumed.model, reported("active"))).model;
    expect(goalOf(active)?.waitPause).toBe("user");
    // The card still waits: their resume stands.
    expect((await run(active, sync())).events).toEqual([]);
    // Once it's answered, the mark goes and nothing is sent.
    const over = await run(cardAnswered(active), sync());
    expect(goalRequest(over.events)).toBeUndefined();
    expect(goalOf(over.model)?.waitPause).toBeUndefined();
  });

  it("keeps a pause the user made, even one that landed before ours", async () => {
    // Paused by the user while the card already waited, before any sync.
    const userPaused = await run(withCard(await threadWithActiveGoal()), userGoal("paused"));
    expect(goalOf(userPaused.model)?.waitPause).toBe("user");
    // Our sync, while the provider still reports it active: no pause of ours.
    expect((await run(userPaused.model, sync())).events).toEqual([]);
    const confirmed = (await run(userPaused.model, reported("paused"))).model;
    // Answered: it stays paused.
    expect(goalRequest((await run(cardAnswered(confirmed), sync())).events)).toBeUndefined();
  });

  it("never resumes a goal the user cleared or stopped during the wait", async () => {
    const confirmed = await pausedForCard();
    const cleared = await run(confirmed, {
      type: "thread.goal.clear",
      commandId: CommandId.make("user-clear"),
      threadId: THREAD,
      createdAt: at(3),
    });
    expect(goalRequest((await run(cardAnswered(cleared.model), sync())).events)).toBeUndefined();

    const stopped = await run(confirmed, {
      type: "thread.session.stop",
      commandId: CommandId.make("user-stop"),
      threadId: THREAD,
      createdAt: at(3),
    });
    expect(goalOf(stopped.model)?.waitPause).toBe("user");
    expect(goalRequest((await run(cardAnswered(stopped.model), sync())).events)).toBeUndefined();
  });

  it("leaves a goal that completed alone", async () => {
    const paused = await run(withCard(await threadWithActiveGoal()), sync());
    const completed = await run(paused.model, reported("complete"));
    expect(goalOf(completed.model)?.waitPause).toBeUndefined();
    expect((await run(cardAnswered(completed.model), sync())).events).toEqual([]);
  });

  it("stays paused while threads it started still owe reports, and until the report's turn runs", async () => {
    const base = await threadWithActiveGoal();
    const waitingOnBoth = patchThread(base, (thread) => ({
      childRequests: { ...thread.childRequests, open: [startedThread("awaiting_user")] },
      commandRequests: [commandCard],
    }));
    const paused = (await run((await run(waitingOnBoth, sync())).model, reported("paused"))).model;

    // The card is answered and the threads start: still waiting on their reports.
    const started = patchThread(paused, (thread) => ({
      childRequests: { ...thread.childRequests, open: [startedThread("running")] },
      commandRequests: [],
    }));
    expect((await run(started, sync())).events).toEqual([]);

    // The last report arrives: its request settles and the report waits in
    // the queue to be sent, a turn about to start. The resume waits for it.
    const reportQueued = patchThread(started, (thread) => ({
      childRequests: { ...thread.childRequests, open: [] },
      queuedFollowUps: [
        {
          messageId: MessageId.make("report"),
          text: "ok",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: at(4),
        },
      ],
    }));
    expect((await run(reportQueued, sync())).events).toEqual([]);

    // Sent: the session is starting its turn.
    const reportStarting = patchThread(reportQueued, () => ({
      queuedFollowUps: [],
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

  it("waits for a command's output to go back, not just for the command to finish", async () => {
    const run1 = {
      runId: "run-1",
      terminalId: "terminal-1",
      mode: "run",
      dialect: "posix",
      command: "pnpm install",
      source: { kind: "request", requestId: commandCard.requestId },
      turnId: TurnId.make("turn-1"),
      participantId: null,
      cwd: "/repo",
      autoSend: true,
      status: "finished",
      startedAt: at(2),
      finishedAt: at(3),
      exitCode: 0,
      error: null,
      hasOutput: true,
      heldReason: null,
      outputSentAt: null,
      outputMessageId: null,
      createdAt: at(2),
      updatedAt: at(3),
    } as unknown as NonNullable<OrchestrationThread["commandRuns"]>[number];
    const finished = patchThread(await pausedForCard(), () => ({ commandRuns: [run1] }));
    expect((await run(finished, sync())).events).toEqual([]);
    const sent = patchThread(finished, () => ({
      commandRuns: [{ ...run1, outputSentAt: at(4) }],
      session: {
        threadId: THREAD,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.make("output"),
        lastError: null,
        updatedAt: at(4),
      },
    }));
    expect(goalRequest((await run(sent, sync())).events)).toMatchObject({ status: "active" });
  });

  it("pauses for a scheduled-task card, which the scheduler holds", async () => {
    const paused = await run(await threadWithActiveGoal(), sync(true));
    expect(goalRequest(paused.events)).toMatchObject({ status: "paused" });
  });

  it("resumes after a restart, whether the wait ended or the resume went unconfirmed", async () => {
    // The mark is part of the goal the projection keeps, so it is there
    // after a restart: only the answer is new.
    const answered = cardAnswered(await pausedForCard());
    const resumed = await run(answered, sync());
    expect(goalRequest(resumed.events)).toMatchObject({ status: "active" });
    // The server stopped before the provider got the resume: it goes again.
    expect(goalRequest((await run(resumed.model, sync())).events)).toMatchObject({
      status: "active",
    });
  });
});
