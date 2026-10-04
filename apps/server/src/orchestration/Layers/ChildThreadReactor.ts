import {
  type ChildRequestId,
  CommandId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
} from "@threadlines/contracts";
import { makeDrainableWorker } from "@threadlines/shared/DrainableWorker";
import { agentThreadsMode } from "@threadlines/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isAgentOrigin } from "@threadlines/shared/roomAgentRequests";
import { childReportMessageId, clampLaunchToCeiling } from "../childThreadDecisions.ts";
import {
  childDeliveryAfterRestart,
  childDeliveryForQuietCandidate,
  isQuietCandidate,
} from "../childThreadDelivery.ts";
import {
  ChildThreadReactor,
  type ChildThreadReactorShape,
} from "../Services/ChildThreadReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../Services/ThreadBootstrap.ts";

/**
 * How long a child that was finishing its own background work has to stay
 * quiet before its answer so far stands. Background work that finishes starts
 * a follow-up turn on its own, a beat after the last task is reported done;
 * this keeps that beat from cutting the real answer off.
 */
const QUIET_GRACE = Duration.seconds(15);

/**
 * How long a child session that stopped mid-answer gets for its turn's own
 * end to arrive (which settles the request with whatever it said) before the
 * request is settled from the stop.
 */
const STOP_GRACE = Duration.seconds(5);

type ReactorEvent = Extract<
  OrchestrationEvent,
  { type: "thread.child-request-submitted" | "thread.child-request-updated" | "thread.session-set" }
>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeChildThreadReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const bootstrap = yield* ThreadBootstrap;
  const settingsService = yield* ServerSettingsService;
  const turns = yield* ProjectionTurnRepository;

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatch = (command: OrchestrationCommand, what: string) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logInfo(`child thread reactor could not ${what}`, {
          threadId: "threadId" in command ? command.threadId : undefined,
          detail: String(error),
        }),
      ),
    );

  const settle = (
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
    settlement: {
      readonly outcome: "answered" | "failed" | "stopped" | "cancelled";
      readonly text?: string;
      readonly note?: string;
      readonly error?: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* dispatch(
        {
          type: "thread.child-request.settle",
          commandId: CommandId.make(`server:child-request:${request.requestId}:settle`),
          threadId: parent.id,
          requestId: request.requestId,
          outcome: settlement.outcome,
          ...(settlement.text !== undefined
            ? {
                reply: {
                  messageId: childReportMessageId(request.requestId),
                  text: settlement.text,
                  turnId: null,
                },
              }
            : {}),
          ...(settlement.note !== undefined ? { note: settlement.note } : {}),
          ...(settlement.error !== undefined ? { error: settlement.error } : {}),
          createdAt: yield* nowIso,
        },
        "settle a child request",
      );
    });

  // One setup per request at a time: the same request seen twice (its event
  // replayed, a restart resuming it) never runs two. Likewise one pending
  // quiet check per request and one stop check per child, however many
  // session updates arrive meanwhile.
  const settingUp = new Set<ChildRequestId>();
  const quietChecks = new Set<ChildRequestId>();
  const stopChecks = new Set<ThreadId>();

  /**
   * Set a child up: staged and resumable (ThreadBootstrap.startChild). Its
   * first turn's start marks the request running (the decider does that); a
   * child started on its own owes nothing, so its request ends there; a
   * failure goes back to the agent that asked.
   */
  const setUpChild = (parentId: ThreadId, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      if (settingUp.has(requestId)) {
        return;
      }
      settingUp.add(requestId);
      yield* Effect.gen(function* () {
        const parent = yield* readThread(parentId);
        const request = parent?.childRequests.open.find((entry) => entry.requestId === requestId);
        if (parent === undefined || request === undefined || request.status !== "starting") {
          return;
        }
        const launch = request.launch;
        if (launch === undefined) {
          yield* settle(parent, request, {
            outcome: "failed",
            text: "A thread could not be started: its request was incomplete.",
            error: "The request had no launch details.",
          });
          return;
        }
        const exit = yield* Effect.exit(
          bootstrap.startChild({
            parentThreadId: parent.id,
            parentTurnId: request.callerTurnId,
            projectId: parent.projectId,
            requestId,
            childThreadId: request.childThreadId,
            childMessageId: request.childMessageId,
            // Never more access than the parent has now, whatever it had
            // when it asked (an approval can come much later).
            launch: clampLaunchToCeiling(launch, parent),
            fromThread: { threadId: parent.id, requestId, kind: "request" },
            createdAt: request.createdAt,
          }),
        );
        const latest = yield* readThread(parentId);
        const open = latest?.childRequests.open.find((entry) => entry.requestId === requestId);
        if (latest === undefined || open === undefined) {
          return;
        }
        if (Exit.isFailure(exit)) {
          const failure = Cause.squash(exit.cause);
          const detail = failure instanceof Error ? failure.message : "Its setup failed.";
          yield* settle(latest, open, {
            outcome: "failed",
            text: `Couldn't start '${launch.title}': ${detail}`,
            error: detail,
          });
          return;
        }
        if (!launch.reportBack) {
          yield* settle(latest, open, { outcome: "answered" });
        }
      }).pipe(Effect.ensuring(Effect.sync(() => settingUp.delete(requestId))));
    });

  /**
   * A child's session changed. If it had gone quiet while its parent's answer
   * waited on its background work, the answer so far stands once it stays
   * quiet. If it stopped or failed with a request mid-answer and no turn end
   * settled it, it is settled from the stop.
   */
  const onChildSession = (childId: ThreadId) =>
    Effect.gen(function* () {
      const child = yield* readThread(childId);
      if (child === undefined || child.parentThreadId === null) {
        return;
      }
      const parent = yield* readThread(child.parentThreadId);
      const owed =
        parent?.childRequests.open.filter((entry) => entry.childThreadId === childId) ?? [];
      if (parent === undefined || owed.length === 0) {
        return;
      }
      for (const request of owed) {
        if (isQuietCandidate(child, request) && !quietChecks.has(request.requestId)) {
          quietChecks.add(request.requestId);
          yield* Effect.sleep(QUIET_GRACE).pipe(
            Effect.andThen(settleIfStillQuiet(parent.id, childId, request.requestId)),
            Effect.ensuring(Effect.sync(() => quietChecks.delete(request.requestId))),
            Effect.forkDetach,
          );
        }
      }
      const status = child.session?.status;
      if ((status === "stopped" || status === "error") && !stopChecks.has(childId)) {
        stopChecks.add(childId);
        yield* Effect.sleep(STOP_GRACE).pipe(
          Effect.andThen(settleStoppedAnswers(parent.id, childId, status)),
          Effect.ensuring(Effect.sync(() => stopChecks.delete(childId))),
          Effect.forkDetach,
        );
      }
    });

  const settleIfStillQuiet = (parentId: ThreadId, childId: ThreadId, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const [parent, child] = [yield* readThread(parentId), yield* readThread(childId)];
      const request = parent?.childRequests.open.find((entry) => entry.requestId === requestId);
      if (parent === undefined || child === undefined || request === undefined) {
        return;
      }
      if (!isQuietCandidate(child, request)) {
        return;
      }
      const delivery = childDeliveryForQuietCandidate(child, request);
      if (delivery !== null) {
        yield* dispatch(
          { ...delivery, threadId: parent.id, createdAt: yield* nowIso },
          "deliver a quiet child's answer",
        );
      }
    });

  const settleStoppedAnswers = (
    parentId: ThreadId,
    childId: ThreadId,
    status: "stopped" | "error",
  ) =>
    Effect.gen(function* () {
      const [parent, child] = [yield* readThread(parentId), yield* readThread(childId)];
      if (parent === undefined || child === undefined) {
        return;
      }
      const latestStatus = child.session?.status;
      if (latestStatus !== "stopped" && latestStatus !== "error") {
        return;
      }
      for (const request of parent.childRequests.open) {
        if (
          request.childThreadId !== childId ||
          (request.status !== "running" && request.status !== "awaiting_background")
        ) {
          continue;
        }
        yield* settle(
          parent,
          request,
          status === "stopped"
            ? {
                outcome: "stopped",
                text: `The user stopped '${child.title}' before it finished.`,
              }
            : {
                outcome: "failed",
                text: `'${child.title}' failed: ${child.session?.lastError ?? "its session ended with an error."}`,
                error: child.session?.lastError ?? "Its session ended with an error.",
              },
        );
      }
    });

  /** Approvals waiting for the user are taken back when the setting goes off. */
  const cancelAwaitingApprovals = Effect.gen(function* () {
    const shell = yield* snapshots.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined));
    for (const summary of shell?.threads ?? []) {
      if (!summary.pendingChildApproval) continue;
      const parent = yield* readThread(summary.id);
      for (const request of parent?.childRequests.open ?? []) {
        if (parent === undefined || request.status !== "awaiting_user") continue;
        yield* settle(parent, request, {
          outcome: "cancelled",
          note: `Starting threads was turned off in Settings, so '${request.launch?.title ?? "a thread"}' was not started.`,
        });
      }
    }
  });

  /**
   * Whatever the previous process left open. A setup that had not reached
   * the child's first turn resumes (every stage is idempotent); an answer that
   * finished durably is delivered; anything else was cut off and is reported
   * as interrupted, so the agent that asked can send the child a message to
   * continue. Its message still queued in the child is taken back, so nothing
   * runs with no one to read it.
   */
  const settleFromPreviousProcess = Effect.gen(function* () {
    const shell = yield* snapshots.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined));
    const mode = agentThreadsMode(
      yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined)),
    );
    for (const summary of shell?.threads ?? []) {
      if (summary.awaitedChildThreadCount === 0 && !summary.pendingChildApproval) continue;
      const parent = yield* readThread(summary.id);
      if (parent === undefined) continue;
      for (const request of parent.childRequests.open) {
        if (request.status === "awaiting_user") {
          if (mode === "off") {
            yield* settle(parent, request, {
              outcome: "cancelled",
              note: `Starting threads was turned off in Settings, so '${request.launch?.title ?? "a thread"}' was not started.`,
            });
          }
          continue;
        }
        if (request.status === "starting") {
          yield* setUpChild(parent.id, request.requestId).pipe(Effect.forkDetach);
          continue;
        }
        const child = yield* readThread(request.childThreadId);
        if (child === undefined) {
          yield* settle(parent, request, {
            outcome: "cancelled",
            note: "A thread you started is gone, so its answer won't come back.",
          });
          continue;
        }
        const childTurns = yield* turns
          .listByThreadId({ threadId: child.id })
          .pipe(Effect.orElseSucceed(() => [] as const));
        // The turn that durably finished the answer, if one did: the turn the
        // request's message started, or for an answer waiting on background
        // work, the latest follow-up that work started on its own.
        const candidateEnded =
          childTurns.find((entry) => entry.turnId === request.candidateTurnId)?.completedAt ?? "";
        const finishedTurn =
          request.status === "running"
            ? childTurns.find(
                (turn) =>
                  turn.pendingMessageId === request.childMessageId && turn.state === "completed",
              )
            : request.status === "awaiting_background"
              ? childTurns
                  .filter(
                    (turn) =>
                      turn.state === "completed" &&
                      turn.pendingMessageId === null &&
                      turn.turnId !== null &&
                      turn.turnId !== request.candidateTurnId &&
                      turn.requestedAt >= candidateEnded,
                  )
                  .toSorted((left, right) => left.requestedAt.localeCompare(right.requestedAt))
                  .at(-1)
              : undefined;
        const finishedTurnId = finishedTurn?.turnId ?? null;
        const delivery = childDeliveryAfterRestart(child, request, finishedTurnId);
        yield* dispatch(
          { ...delivery, threadId: parent.id, createdAt: yield* nowIso },
          "settle a child request after a restart",
        );
        if (
          (child.queuedFollowUps ?? []).some(
            (queued) => queued.messageId === request.childMessageId,
          )
        ) {
          yield* dispatch(
            {
              type: "thread.follow-up.unqueue",
              commandId: CommandId.make(
                `server:child-request:${request.requestId}:restart-unqueue`,
              ),
              threadId: child.id,
              messageId: request.childMessageId,
              createdAt: yield* nowIso,
            },
            "take back a child's queued request after a restart",
          );
        }
      }
    }
  });

  /**
   * A report the previous process queued for a parent but never sent: the
   * normal queue only sends when a turn ends, and there is no turn after a
   * restart. Sent now, through the same send that checks it was not
   * cancelled meanwhile, unless the user's own queued messages come first
   * (those wait for the user, as they always have).
   */
  const sendReportsQueuedBeforeRestart = Effect.gen(function* () {
    const shell = yield* snapshots.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined));
    for (const summary of shell?.threads ?? []) {
      const queued = summary.queuedFollowUps ?? [];
      const report = queued.find((entry) => entry.fromThread?.kind === "report");
      const status = summary.session?.status;
      if (
        report === undefined ||
        queued.some((entry) => !isAgentOrigin(entry)) ||
        status === "running" ||
        status === "starting"
      ) {
        continue;
      }
      yield* dispatch(
        {
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make(`server:child-report-after-restart:${report.messageId}`),
          threadId: summary.id,
          messageId: report.messageId,
          createdAt: yield* nowIso,
        },
        "send a report queued before a restart",
      );
    }
  });

  const processEvent = (event: ReactorEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.session-set") {
        yield* onChildSession(event.payload.threadId);
        return;
      }
      const startsNow =
        event.type === "thread.child-request-submitted"
          ? event.payload.request.status === "starting"
            ? event.payload.request.requestId
            : undefined
          : event.payload.status === "starting"
            ? event.payload.requestId
            : undefined;
      if (startsNow !== undefined) {
        yield* setUpChild(event.payload.threadId, startsNow).pipe(Effect.forkDetach);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("child thread reactor failed to process an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEvent);

  const start: ChildThreadReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribed before the previous process's requests are settled, so the
    // events that settling writes are seen here too.
    const events = yield* engine.subscribeDomainEvents;
    yield* settleFromPreviousProcess.pipe(
      Effect.andThen(sendReportsQueuedBeforeRestart),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "child thread reactor could not settle requests from the previous process",
          {
            cause: Cause.pretty(cause),
          },
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        event.type === "thread.child-request-submitted" ||
        event.type === "thread.child-request-updated" ||
        event.type === "thread.session-set"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(
        settingsService.streamChanges.pipe(
          Stream.map(agentThreadsMode),
          Stream.changes,
          Stream.filter((mode) => mode === "off"),
        ),
        () =>
          cancelAwaitingApprovals.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("child thread reactor could not take back approvals", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ChildThreadReactorShape;
});

export const ChildThreadReactorLive = Layer.effect(ChildThreadReactor, makeChildThreadReactor).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
