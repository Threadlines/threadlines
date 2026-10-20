/**
 * RemoteChildReactor: the parent's computer's side of children on linked
 * computers (docs/design/fleet.md, "Records and reactors on A").
 *
 * It owns every child request that carries `remote` (ChildThreadReactor and
 * runtime ingestion skip them). Per linked computer:
 *
 * 1. The outbox. Starts and sends still `sending` go out as
 *    `peer.request.start` / `peer.request.send` in the order they were
 *    recorded, each retried with its own request id until that computer
 *    answers. Cancels and stops (`remoteCancels`) go out on their own lane,
 *    never behind a start in flight; recording a cancel already removed the
 *    request's unsent start or send, since the decision that cancels it
 *    settles it.
 * 2. The watch. While any request there is open, or a cancel is owed, or
 *    since startup it hasn't replayed what it held, `peer.watch` stays open.
 *    Status changes update the request; a report settles it with the answer
 *    (written into the parent like a local child's) and is then acked. A
 *    report whose request already settled here is acked too.
 * 3. Restart: the outbox is the parent's durable state, so a restart finds
 *    it again; every linked computer is watched once to drain what it held.
 */
import {
  type ChildRequestOutcome,
  CommandId,
  type EnvironmentId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationThread,
  type PeerRequestOutcome,
  type PeerRequestStatus,
  type PeerWatchEvent,
  type RemoteChildCancel,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { remoteChildOf } from "@threadlines/shared/childThreads";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { childReportMessageId } from "../orchestration/childThreadDecisions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ComputerLinkClient, type ComputerLinkUnavailableError } from "./ComputerLinkClient.ts";
import { ComputerLinkRepository } from "./ComputerLinkRepository.ts";

/** How often owed work is retried while a computer can't be reached. */
const RETRY_EVERY = Duration.seconds(15);
/** How long a watch with nothing left to wait for stays open. */
const WATCH_LINGER_MS = 10_000;

export interface RemoteChildReactorShape {
  /** Start reacting, after reloading what the previous process left owed. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class RemoteChildReactor extends Context.Service<
  RemoteChildReactor,
  RemoteChildReactorShape
>()("threadlines/links/RemoteChildReactor") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const settleCommandId = (requestId: string) =>
  CommandId.make(`server:child-request:${requestId}:settle`);

/** A linked computer's outcome as the parent records it. */
const parentOutcome = (outcome: PeerRequestOutcome): ChildRequestOutcome =>
  outcome === "denied" ? "declined" : outcome === "expired" ? "cancelled" : outcome;

/** How far a request has come; a status from the other computer never moves it back. */
const STATUS_RANK: Record<OrchestrationChildRequest["status"], number> = {
  awaiting_user: 0,
  starting: 1,
  queued: 2,
  running: 3,
  awaiting_background: 4,
};

/** A linked computer's request status as the parent's request reads it. */
const parentStatus = (status: PeerRequestStatus): OrchestrationChildRequest["status"] | null =>
  status === "running"
    ? "running"
    : status === "awaiting_background"
      ? "awaiting_background"
      : status === "received" || status === "queued"
        ? "queued"
        : null;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const client = yield* ComputerLinkClient;
  const links = yield* ComputerLinkRepository;
  const environment = yield* ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const self = yield* environment.getDescriptor;

  /** Parents with remote work, by the computer it is owed to. */
  const parentsByEnvironment = new Map<string, Set<ThreadId>>();
  const requestLanes = new Map<string, Semaphore.Semaphore>();
  const cancelLanes = new Map<string, Semaphore.Semaphore>();
  const watching = new Set<string>();
  /** Computers whose watch has replayed what they held since this process started. */
  const drained = new Set<string>();

  const laneOf = (lanes: Map<string, Semaphore.Semaphore>, environmentId: string) => {
    let lane = lanes.get(environmentId);
    if (lane === undefined) {
      lane = Semaphore.makeUnsafe(1);
      lanes.set(environmentId, lane);
    }
    return lane;
  };

  const track = (environmentId: string, parentId: ThreadId) => {
    let parents = parentsByEnvironment.get(environmentId);
    if (parents === undefined) {
      parents = new Set();
      parentsByEnvironment.set(environmentId, parents);
    }
    parents.add(parentId);
  };

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatch = (command: OrchestrationCommand, what: string) =>
    engine.dispatch(command).pipe(
      Effect.as({ ok: true as const }),
      Effect.catch((error) =>
        Effect.logInfo(`remote child reactor could not ${what}`, { detail: String(error) }).pipe(
          Effect.as({
            ok: false as const,
            refused:
              (error as { readonly _tag?: string })._tag === "OrchestrationCommandInvariantError" ||
              (error as { readonly _tag?: string })._tag ===
                "OrchestrationCommandPreviouslyRejectedError",
          }),
        ),
      ),
    );

  /** The parents still owing anything to a computer, read afresh. */
  const parentsOwing = (environmentId: string) =>
    Effect.gen(function* () {
      const ids = [...(parentsByEnvironment.get(environmentId) ?? [])];
      const parents: Array<OrchestrationThread> = [];
      for (const id of ids) {
        const parent = yield* readThread(id);
        const owes =
          parent !== undefined &&
          (parent.childRequests.open.some(
            (request) => request.remote?.environmentId === environmentId,
          ) ||
            (parent.childRequests.remoteCancels ?? []).some(
              (cancel) => cancel.environmentId === environmentId,
            ));
        if (owes) parents.push(parent);
        else parentsByEnvironment.get(environmentId)?.delete(id);
      }
      return parents;
    });

  const findRequest = (environmentId: string, requestId: string) =>
    Effect.gen(function* () {
      for (const parent of yield* parentsOwing(environmentId)) {
        const request = parent.childRequests.open.find(
          (entry) => entry.requestId === requestId && entry.remote?.environmentId === environmentId,
        );
        if (request !== undefined) return { parent, request };
      }
      return undefined;
    });

  // ---------------------------------------------------------------------------
  // Recording what the other computer said
  // ---------------------------------------------------------------------------

  const agentName = (parent: OrchestrationThread, request: OrchestrationChildRequest) =>
    (request.from.participantId !== null
      ? parent.participants.find((entry) => entry.id === request.from.participantId)?.handle
      : undefined) ?? "Agent";

  const settleRequest = (
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
    settlement: {
      readonly outcome: ChildRequestOutcome;
      readonly text: string | undefined;
      readonly turnId?: string | null;
      readonly error?: string | undefined;
    },
  ) =>
    Effect.gen(function* () {
      return yield* dispatch(
        {
          type: "thread.child-request.settle",
          commandId: settleCommandId(request.requestId),
          threadId: parent.id,
          requestId: request.requestId,
          outcome: settlement.outcome,
          ...(settlement.text !== undefined
            ? {
                reply: {
                  messageId: childReportMessageId(request.requestId),
                  text: settlement.text,
                  turnId:
                    settlement.turnId !== undefined && settlement.turnId !== null
                      ? TurnId.make(settlement.turnId)
                      : null,
                },
              }
            : {}),
          ...(settlement.error !== undefined && settlement.error.trim().length > 0
            ? { error: settlement.error }
            : {}),
          createdAt: yield* nowIso,
        },
        "settle a request to a linked computer",
      );
    });

  /** Keeps the parent's record of a child there, created once its thread exists. */
  const recordChild = (
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
    threadId: ThreadId,
    cachedStatus: string,
  ) =>
    Effect.gen(function* () {
      const remote = request.remote!;
      const existing = remoteChildOf(parent.childRequests, threadId);
      if (existing !== undefined && existing.cachedStatus === cachedStatus) return;
      yield* dispatch(
        {
          type: "thread.remote-child.update",
          commandId: CommandId.make(
            `server:remote-child:${remote.environmentId}:${threadId}:${request.requestId}:${cachedStatus}`,
          ),
          threadId: parent.id,
          child: {
            environmentId: remote.environmentId,
            label: remote.label,
            threadId,
            handle: existing?.handle ?? agentName(parent, request),
            title: existing?.title ?? request.launch?.title ?? "A thread",
            attachmentEpoch: existing?.attachmentEpoch ?? 0,
            cachedStatus,
            updatedAt: yield* nowIso,
          },
          createdAt: yield* nowIso,
        },
        "record a child on a linked computer",
      );
    });

  const updateRequest = (
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
    patch: {
      readonly status?: OrchestrationChildRequest["status"];
      readonly remoteStatus?: NonNullable<OrchestrationChildRequest["remote"]>["status"];
      readonly threadId?: ThreadId | null;
    },
  ) =>
    Effect.gen(function* () {
      const remote = request.remote!;
      const next = {
        ...remote,
        ...(patch.remoteStatus !== undefined ? { status: patch.remoteStatus } : {}),
        ...(patch.threadId !== undefined && patch.threadId !== null
          ? { threadId: patch.threadId }
          : {}),
      };
      const wanted = patch.status ?? request.status;
      // Answers can arrive out of order (the start's reply after the watch
      // said it runs): a request never moves back, except a finished turn's
      // follow-up running again after waiting on background work.
      const status =
        STATUS_RANK[wanted] >= STATUS_RANK[request.status] ||
        (request.status === "awaiting_background" && wanted === "running")
          ? wanted
          : request.status;
      if (
        status === request.status &&
        next.status === remote.status &&
        next.threadId === remote.threadId
      ) {
        return;
      }
      yield* dispatch(
        {
          type: "thread.child-request.update",
          commandId: CommandId.make(
            `server:child-request:${request.requestId}:remote:${status}:${next.status}:${next.threadId ?? "none"}`,
          ),
          threadId: parent.id,
          requestId: request.requestId,
          status,
          remote: next,
          createdAt: yield* nowIso,
        },
        "update a request to a linked computer",
      );
    });

  const onWatchEvent = (environmentId: string, event: PeerWatchEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "synced":
          drained.add(environmentId);
          return;
        case "status": {
          const found = yield* findRequest(environmentId, event.requestId);
          if (found === undefined) return;
          const { parent, request } = found;
          if (event.status === "awaiting_approval") {
            yield* updateRequest(parent, request, {
              remoteStatus: "awaiting_approval",
              threadId: event.threadId,
            });
            return;
          }
          const status = parentStatus(event.status);
          if (status === null) return;
          yield* updateRequest(parent, request, {
            status,
            remoteStatus: "accepted",
            threadId: event.threadId,
          });
          if (event.threadId !== null) {
            yield* recordChild(
              parent,
              request,
              event.threadId,
              status === "running" ? "working" : "waiting",
            );
          }
          return;
        }
        case "thread": {
          for (const parent of yield* parentsOwing(environmentId)) {
            const existing = remoteChildOf(parent.childRequests, event.threadId);
            if (existing === undefined || existing.environmentId !== environmentId) continue;
            if (existing.cachedStatus === event.status && existing.title === event.title) continue;
            yield* dispatch(
              {
                type: "thread.remote-child.update",
                commandId: CommandId.make(
                  `server:remote-child:${environmentId}:${event.threadId}:${event.updatedAt}`,
                ),
                threadId: parent.id,
                child: {
                  ...existing,
                  title: event.title,
                  cachedStatus: event.status,
                  updatedAt: event.updatedAt,
                },
                createdAt: yield* nowIso,
              },
              "record a linked computer's thread status",
            );
          }
          return;
        }
        case "report": {
          const found = yield* findRequest(environmentId, event.requestId);
          let recorded = found === undefined;
          if (found !== undefined) {
            const { parent, request } = found;
            // Only a thread that exists there is remembered.
            if (event.threadId !== null && request.remote?.status === "accepted") {
              yield* recordChild(
                parent,
                request,
                event.threadId,
                event.outcome === "answered" ? "idle" : "failed",
              );
            }
            const silent =
              (event.outcome === "answered" && request.launch?.reportBack === false) ||
              event.text.trim().length === 0;
            const result = yield* settleRequest(parent, request, {
              outcome: parentOutcome(event.outcome),
              text: silent ? undefined : event.text,
              turnId: event.turnId,
              error: event.error,
            });
            // Refused means it was settled meanwhile (Stop, a wrap): recorded.
            recorded = result.ok || result.refused;
          }
          if (recorded) {
            yield* client
              .withPeer(environmentId as EnvironmentId, (peer) =>
                peer["peer.report.ack"]({ reportId: event.reportId }),
              )
              .pipe(Effect.ignore);
          }
          return;
        }
      }
    });

  // ---------------------------------------------------------------------------
  // The outbox
  // ---------------------------------------------------------------------------

  /** The link was removed (here or there): nothing owed to it can be done. */
  const abandon = (environmentId: string, error: ComputerLinkUnavailableError) =>
    Effect.gen(function* () {
      for (const parent of yield* parentsOwing(environmentId)) {
        for (const request of parent.childRequests.open) {
          if (request.remote?.environmentId !== environmentId) continue;
          yield* settleRequest(parent, request, {
            outcome: "failed",
            text: `'${request.launch?.title ?? remoteChildOf(parent.childRequests, request.childThreadId)?.title ?? "A thread"}' on ${request.remote.label} can't be reached: ${error.detail}`,
            error: error.detail,
          });
        }
        const cancels = (parent.childRequests.remoteCancels ?? []).filter(
          (cancel) => cancel.environmentId === environmentId,
        );
        if (cancels.length > 0) {
          yield* deliveredCancels(parent.id, cancels);
        }
      }
    });

  const deliveredCancels = (parentId: ThreadId, cancels: ReadonlyArray<RemoteChildCancel>) =>
    Effect.gen(function* () {
      yield* dispatch(
        {
          type: "thread.remote-cancels.delivered",
          commandId: CommandId.make(
            `server:remote-cancels:${parentId}:${cancels.map((cancel) => cancel.requestId).join(",")}`,
          ),
          threadId: parentId,
          requestIds: cancels.map((cancel) => cancel.requestId),
          createdAt: yield* nowIso,
        },
        "record cancels a linked computer confirmed",
      );
    });

  /** The computer's link is gone for good, or it can't be reached right now. */
  const isGone = (environmentId: string) =>
    links.getByEnvironment(environmentId as EnvironmentId).pipe(
      Effect.map(Option.isNone),
      Effect.orElseSucceed(() => false),
    );

  const handleUnavailable = (environmentId: string, error: unknown) =>
    Effect.gen(function* () {
      const unavailable = error as Partial<ComputerLinkUnavailableError>;
      if (
        unavailable._tag === "ComputerLinkUnavailableError" &&
        (unavailable.revoked === true || (yield* isGone(environmentId)))
      ) {
        yield* abandon(environmentId, error as ComputerLinkUnavailableError);
      }
    });

  const sendRequest = (
    environmentId: string,
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
  ) =>
    Effect.gen(function* () {
      const remote = request.remote!;
      if (request.kind === "send") {
        return yield* sendSend(environmentId, parent, request);
      }
      const launch = request.launch;
      if (launch === undefined || launch.workspace.kind !== "remote") {
        yield* settleRequest(parent, request, {
          outcome: "failed",
          text: "A thread on another computer could not be started: its request was incomplete.",
          error: "The request had no launch details.",
        });
        return true;
      }
      const answer = yield* client.withPeer(environmentId as EnvironmentId, (peer) =>
        peer["peer.request.start"]({
          requestId: request.requestId,
          parent: {
            environmentId: self.environmentId,
            environmentLabel: self.label,
            threadId: parent.id,
            threadTitle: parent.title,
            handle: agentName(parent, request),
          },
          projectKey: launch.workspace.kind === "remote" ? launch.workspace.projectKey : "",
          workspace:
            launch.workspace.kind === "remote" && launch.workspace.checkout === "worktree"
              ? {
                  kind: "worktree",
                  ...(launch.workspace.branch !== undefined
                    ? { branch: launch.workspace.branch }
                    : {}),
                }
              : { kind: "local" },
          title: launch.title,
          prompt: launch.prompt,
          agent: {
            instanceId: launch.modelSelection.instanceId,
            model: launch.modelSelection.model,
            ...(launch.modelSelection.options !== undefined &&
            launch.modelSelection.options.length > 0
              ? { options: launch.modelSelection.options }
              : {}),
          },
          runtimeMode: launch.runtimeMode,
          interactionMode: launch.interactionMode,
          reportBack: launch.reportBack,
          runSetup: launch.runSetup,
        }),
      );
      switch (answer.status) {
        case "started":
          yield* updateRequest(parent, request, {
            status: "queued",
            remoteStatus: "accepted",
            threadId: answer.threadId ?? null,
          });
          if (answer.threadId !== undefined) {
            yield* recordChild(parent, request, answer.threadId, "working");
          }
          return true;
        case "awaiting_approval":
          yield* updateRequest(parent, request, {
            remoteStatus: "awaiting_approval",
            threadId: answer.threadId ?? null,
          });
          return true;
        case "refused":
          yield* settleRequest(parent, request, {
            outcome: "failed",
            text: `'${launch.title}' couldn't start on ${remote.label}: ${answer.reason ?? "it was refused."}`,
            error: answer.reason ?? "It was refused.",
          });
          return true;
        case "cancelled":
          yield* settleRequest(parent, request, { outcome: "cancelled", text: undefined });
          return true;
      }
    });

  const sendSend = (
    environmentId: string,
    parent: OrchestrationThread,
    request: OrchestrationChildRequest,
  ) =>
    Effect.gen(function* () {
      const remote = request.remote!;
      const text = request.text;
      if (text === undefined || text.trim().length === 0 || remote.threadId === null) {
        yield* settleRequest(parent, request, {
          outcome: "failed",
          text: `Your message to a thread on ${remote.label} was lost before it was sent.`,
          error: "The message text was not found.",
        });
        return true;
      }
      const answer = yield* client.withPeer(environmentId as EnvironmentId, (peer) =>
        peer["peer.request.send"]({
          requestId: request.requestId,
          threadId: remote.threadId!,
          text,
        }),
      );
      if (answer.status === "queued") {
        yield* updateRequest(parent, request, { status: "queued", remoteStatus: "accepted" });
        return true;
      }
      const title =
        remoteChildOf(parent.childRequests, request.childThreadId)?.title ?? "the thread";
      yield* settleRequest(
        parent,
        request,
        answer.status === "cancelled"
          ? { outcome: "cancelled", text: undefined }
          : {
              outcome: "failed",
              text: `Your message to '${title}' on ${remote.label} was refused: ${answer.reason ?? "it couldn't take it."}`,
              error: answer.reason ?? "It was refused.",
            },
      );
      return true;
    });

  /** Starts and sends to one computer, in the order they were recorded. */
  const pumpRequests = (environmentId: string) =>
    laneOf(requestLanes, environmentId).withPermits(1)(
      Effect.gen(function* () {
        const owed = (yield* parentsOwing(environmentId))
          .flatMap((parent) =>
            parent.childRequests.open
              .filter(
                (request) =>
                  request.remote?.environmentId === environmentId &&
                  request.remote.status === "sending" &&
                  request.status !== "awaiting_user",
              )
              .map((request) => ({ parent, request })),
          )
          .toSorted(
            (left, right) =>
              left.request.createdAt.localeCompare(right.request.createdAt) ||
              left.request.requestId.localeCompare(right.request.requestId),
          );
        for (const { parent, request } of owed) {
          // Read again: a cancel may have settled it while the one before went out.
          const current = (yield* readThread(parent.id))?.childRequests.open.find(
            (entry) => entry.requestId === request.requestId,
          );
          if (current === undefined || current.remote?.status !== "sending") continue;
          const sent = yield* sendRequest(environmentId, parent, current).pipe(
            Effect.catch((error) => handleUnavailable(environmentId, error).pipe(Effect.as(false))),
          );
          // Later ones wait behind it, in order.
          if (!sent) return;
        }
      }),
    );

  /** Cancels and stops owed to one computer: their own lane, never behind a start. */
  const pumpCancels = (environmentId: string) =>
    laneOf(cancelLanes, environmentId).withPermits(1)(
      Effect.gen(function* () {
        for (const parent of yield* parentsOwing(environmentId)) {
          const cancels = (parent.childRequests.remoteCancels ?? []).filter(
            (cancel) => cancel.environmentId === environmentId,
          );
          for (const cancel of cancels) {
            const done = yield* Effect.gen(function* () {
              if (cancel.cancelRequest) {
                yield* client.withPeer(environmentId as EnvironmentId, (peer) =>
                  peer["peer.request.cancel"]({ requestId: cancel.requestId }),
                );
              }
              if (cancel.stopThread && cancel.threadId !== null) {
                const threadId = cancel.threadId;
                yield* client.withPeer(environmentId as EnvironmentId, (peer) =>
                  peer["peer.thread.stop"]({ threadId }),
                );
              }
              return true;
            }).pipe(
              Effect.catch((error) =>
                handleUnavailable(environmentId, error).pipe(Effect.as(false)),
              ),
            );
            if (!done) return;
            yield* deliveredCancels(parent.id, [cancel]);
          }
        }
      }),
    );

  /** Whether a computer's watch still has anything to wait for. */
  const needsWatch = (environmentId: string) =>
    Effect.map(
      parentsOwing(environmentId),
      (parents) =>
        !drained.has(environmentId) ||
        parents.some((parent) =>
          parent.childRequests.open.some(
            (request) =>
              request.remote?.environmentId === environmentId &&
              request.remote.status !== "sending",
          ),
        ),
    );

  const ensureWatch = (environmentId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (watching.has(environmentId)) return;
      if (!(yield* needsWatch(environmentId))) return;
      watching.add(environmentId);
      let quietSince: number | null = null;
      yield* client
        .peerStream(environmentId as EnvironmentId, (peer) => peer["peer.watch"]({}))
        .pipe(
          Stream.mapEffect((event) =>
            onWatchEvent(environmentId, event).pipe(
              Effect.andThen(needsWatch(environmentId)),
              Effect.map((needed) => {
                quietSince = needed ? null : (quietSince ?? Date.now());
                return quietSince === null || Date.now() - quietSince < WATCH_LINGER_MS;
              }),
            ),
          ),
          Stream.takeWhile((keep) => keep),
          Stream.runDrain,
          Effect.catch((error) => handleUnavailable(environmentId, error)),
          Effect.catchCause((cause) =>
            Effect.logWarning("remote child reactor watch ended", {
              environmentId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.ensuring(Effect.sync(() => watching.delete(environmentId))),
          Effect.forkDetach,
        );
    });

  const pump = (environmentId: string) =>
    Effect.gen(function* () {
      yield* pumpCancels(environmentId).pipe(Effect.forkDetach);
      yield* pumpRequests(environmentId);
      yield* ensureWatch(environmentId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("remote child reactor could not send owed work", {
          environmentId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Parents with remote work at startup: open remote requests or owed cancels. */
  const loadOwing = Effect.gen(function* () {
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE deleted_at IS NULL
        AND child_requests IS NOT NULL
        AND (child_requests LIKE '%"remote":{%' OR child_requests LIKE '%"remoteCancels":[{%')
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      const parent = yield* readThread(row.threadId as ThreadId);
      if (parent === undefined) continue;
      for (const request of parent.childRequests.open) {
        if (request.remote !== undefined) track(request.remote.environmentId, parent.id);
      }
      for (const cancel of parent.childRequests.remoteCancels ?? []) {
        track(cancel.environmentId, parent.id);
      }
    }
  });

  const start: RemoteChildReactorShape["start"] = () =>
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* loadOwing;
      // Every linked computer is watched once, to drain what it held for us.
      const all = yield* links.list.pipe(Effect.orElseSucceed(() => []));
      for (const link of all) {
        if (link.state === "revoked") continue;
        yield* pump(link.remoteEnvironmentId).pipe(Effect.forkDetach);
      }
      for (const environmentId of parentsByEnvironment.keys()) {
        if (all.some((link) => link.remoteEnvironmentId === environmentId)) continue;
        yield* pump(environmentId).pipe(Effect.forkDetach);
      }
      yield* Effect.forkScoped(
        Stream.runForEach(events, (event) => {
          if (
            event.type === "thread.child-request-submitted" &&
            event.payload.request.remote !== undefined
          ) {
            const environmentId = event.payload.request.remote.environmentId;
            track(environmentId, event.payload.threadId);
            return pump(environmentId).pipe(Effect.forkDetach, Effect.asVoid);
          }
          if (
            event.type === "thread.child-request-updated" &&
            event.payload.status === "starting"
          ) {
            return Effect.gen(function* () {
              const parent = yield* readThread(event.payload.threadId);
              const request = parent?.childRequests.open.find(
                (entry) => entry.requestId === event.payload.requestId,
              );
              if (request?.remote !== undefined) {
                yield* pump(request.remote.environmentId).pipe(Effect.forkDetach);
              }
            });
          }
          if (event.type === "thread.remote-cancel-queued") {
            const environmentId = event.payload.cancel.environmentId;
            track(environmentId, event.payload.threadId);
            return pumpCancels(environmentId).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.forkDetach,
              Effect.asVoid,
            );
          }
          return Effect.void;
        }),
      );
      // Owed work is retried while a computer can't be reached.
      yield* Effect.gen(function* () {
        for (const environmentId of parentsByEnvironment.keys()) {
          yield* pump(environmentId);
        }
      }).pipe(Effect.repeat(Schedule.spaced(RETRY_EVERY)), Effect.forkScoped);
    });

  return RemoteChildReactor.of({ start });
});

export const RemoteChildReactorLive = Layer.effect(RemoteChildReactor, make);
