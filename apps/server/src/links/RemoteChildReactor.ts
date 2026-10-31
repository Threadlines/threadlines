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
 * 2. The watch. While any request there is open, or an ack failed, or
 *    since startup it hasn't replayed what it held, or a parent here that is
 *    neither archived nor deleted holds a child there (and the link is still
 *    usable), `peer.watch` stays open. It asks for those children's state
 *    on connect, and hears every change after, so the parent's record of
 *    each says how it stands there now and how that computer files it
 *    (`RemoteChildThread.filing`). Status changes update the request; a
 *    report records the child it names and settles the request with the
 *    answer (written into the parent like a local child's), then is acked,
 *    saying whether the answer reached the parent (that computer then marks
 *    the answering turn handed back). A report whose request already settled
 *    here is acked too. An ack that fails is retried until it lands; the
 *    other computer keeps the report until then, and replays it.
 * 3. Wraps. The user's Wrap up or Reopen of a child there, given here
 *    (`RemoteChildThread.override`), goes to that computer as
 *    `peer.thread.wrap` once it can take it, with the same stamp.
 * 4. Restart: the outbox is the parent's durable state, so a restart finds
 *    it again; every linked computer is watched once to drain what it held.
 *
 * Parents are read from their stored rows, archived and deleted ones too:
 * archiving or deleting a parent is exactly when cancels are owed. A deleted
 * parent's own requests are owed nothing more. A read that fails is never
 * taken for "not here": a report is acked only once it is recorded, or once
 * reads that worked show nothing is open for it.
 */
import {
  type ChildRequestId,
  type ChildRequestOutcome,
  CommandId,
  EMPTY_CHILD_REQUEST_STATE,
  type EnvironmentId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type PeerRequestOutcome,
  type PeerRequestStatus,
  type PeerWatchEvent,
  type RemoteChildCancel,
  type RemoteChildThread,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { remoteChildOf, sameRemoteThreadFiling } from "@threadlines/shared/childThreads";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { childReportMessageId } from "../orchestration/childThreadDecisions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ComputerLinkClient, type ComputerLinkUnavailableError } from "./ComputerLinkClient.ts";
import { ComputerLinkRepository, isUsableLink } from "./ComputerLinkRepository.ts";

/** How often owed work is retried while a computer can't be reached. */
const RETRY_EVERY = Duration.seconds(15);

/** How long a watch with nothing left to wait for stays open. */
const WATCH_LINGER_MS = 10_000;
const WATCH_CHECK_EVERY = Duration.seconds(5);

export interface RemoteChildReactorShape {
  /** Start reacting, after reloading what the previous process left owed. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class RemoteChildReactor extends Context.Service<
  RemoteChildReactor,
  RemoteChildReactorShape
>()("threadlines/links/RemoteChildReactor") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** What the reactor needs of a parent, read from its stored row. */
type Parent = Pick<OrchestrationThread, "id" | "title" | "participants" | "childRequests"> & {
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
};

/** Its children there, while it still shows them: neither archived nor deleted. */
const childrenFollowed = (parent: Parent, environmentId: string) =>
  parent.deletedAt !== null || parent.archivedAt !== null
    ? []
    : (parent.childRequests.remoteChildren ?? []).filter(
        (child) => child.environmentId === environmentId,
      );

/** The user's word on a child given here that that computer hasn't taken yet. */
const wrapOwed = (child: RemoteChildThread) => {
  const mine = child.override;
  if (mine === undefined || child.filing?.archived === true) return false;
  const theirs = child.filing?.override ?? null;
  return theirs === null || Date.parse(theirs.at) < Date.parse(mine.at);
};

const childKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

/** A parent's open requests to one computer; a deleted parent's are owed nothing. */
const openRemote = (parent: Parent, environmentId: string) =>
  parent.deletedAt !== null
    ? []
    : parent.childRequests.open.filter(
        (request) => request.remote?.environmentId === environmentId,
      );

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

/** A report couldn't be recorded here; it isn't acked, and the watch replays it. */
class ReportNotRecordedError extends Data.TaggedError("ReportNotRecordedError")<{
  readonly requestId: string;
}> {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const threadRows = yield* ProjectionThreadRepository;
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
  /**
   * Reports recorded here whose ack hasn't reached their computer yet, each
   * with whether its answer reached the parent.
   */
  const pendingAcks = new Map<string, Map<string, boolean>>();
  /** Parents that may hold children there, by computer (see `parentsFollowing`). */
  const followersByEnvironment = new Map<string, Set<ThreadId>>();
  /** The parents holding each child, by `childKey`, so its news reads only them. */
  const holdersByChild = new Map<string, Set<ThreadId>>();
  /**
   * Wraps sent this process, by `childKey`: the stamp sent, and the word that
   * computer had when it went. Sent again only if that computer's word moved
   * since and is still older (a word given there that arrived late).
   */
  const wrapsSent = new Map<string, { readonly at: string; readonly against: string | null }>();
  const wrapLanes = new Map<string, Semaphore.Semaphore>();
  /** Computers whose watch should start again, to ask about the children held there now. */
  const rewatch = new Set<string>();
  /** The children each open watch asked about when it connected. */
  const watchedThreads = new Map<string, ReadonlySet<ThreadId>>();
  /**
   * Parents with a Wrap up or Reopen given here, by computer, archived ones
   * too: a word is owed to that computer however the parent is filed here.
   */
  const wrapOwers = new Map<string, Set<ThreadId>>();

  const laneOf = (lanes: Map<string, Semaphore.Semaphore>, environmentId: string) => {
    let lane = lanes.get(environmentId);
    if (lane === undefined) {
      lane = Semaphore.makeUnsafe(1);
      lanes.set(environmentId, lane);
    }
    return lane;
  };

  const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
    let values = map.get(key);
    if (values === undefined) {
      values = new Set();
      map.set(key, values);
    }
    values.add(value);
  };

  const track = (environmentId: string, parentId: ThreadId) =>
    addTo(parentsByEnvironment, environmentId, parentId);

  /** A parent holds a child there: the watch follows it. */
  const follow = (environmentId: string, parentId: ThreadId, childThreadId: ThreadId) => {
    addTo(followersByEnvironment, environmentId, parentId);
    addTo(holdersByChild, childKey(environmentId, childThreadId), parentId);
  };

  /** A parent as stored, archived and deleted ones included; undefined only when there is none. */
  const readParent = (threadId: ThreadId) =>
    threadRows.getById({ threadId }).pipe(
      Effect.map((found): Parent | undefined =>
        Option.isNone(found)
          ? undefined
          : {
              id: found.value.threadId,
              title: found.value.title,
              participants: found.value.participants ?? [],
              childRequests: found.value.childRequests ?? EMPTY_CHILD_REQUEST_STATE,
              archivedAt: found.value.archivedAt,
              deletedAt: found.value.deletedAt,
            },
      ),
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
      const parents: Array<Parent> = [];
      for (const id of ids) {
        const parent = yield* readParent(id);
        const owes =
          parent !== undefined &&
          (openRemote(parent, environmentId).length > 0 ||
            (parent.childRequests.remoteCancels ?? []).some(
              (cancel) => cancel.environmentId === environmentId,
            ));
        if (owes) parents.push(parent);
        else parentsByEnvironment.get(environmentId)?.delete(id);
      }
      return parents;
    });

  /** The parents still showing a child there (neither archived nor deleted), read afresh. */
  const parentsFollowing = (environmentId: string) =>
    Effect.gen(function* () {
      // A copy: reading may drop parents from the set.
      const ids = [...(followersByEnvironment.get(environmentId) ?? [])];
      const parents: Array<Parent> = [];
      for (const id of ids) {
        const parent = yield* readParent(id);
        if (parent !== undefined && childrenFollowed(parent, environmentId).length > 0) {
          parents.push(parent);
        } else {
          followersByEnvironment.get(environmentId)?.delete(id);
        }
      }
      return parents;
    });

  /** Whether a computer's link still works, so following its children can get anywhere. */
  const linkUsable = (environmentId: string) =>
    links.getByEnvironment(environmentId as EnvironmentId).pipe(
      Effect.map((found) => Option.isSome(found) && isUsableLink(found.value)),
      Effect.orElseSucceed(() => false),
    );

  /** Whether a computer has children here to follow: some held, and a link that works. */
  const isFollowing = (environmentId: string) =>
    Effect.gen(function* () {
      if ((followersByEnvironment.get(environmentId)?.size ?? 0) === 0) return false;
      if (!(yield* linkUsable(environmentId))) return false;
      return (yield* parentsFollowing(environmentId)).length > 0;
    });

  /**
   * The parents a computer's word about one of its threads is for: those
   * holding it, then any with a request open to it whose record isn't
   * followed yet. A read that fails fails.
   */
  const parentsHolding = (environmentId: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const byId = new Map<ThreadId, Parent>();
      for (const id of holdersByChild.get(childKey(environmentId, threadId)) ?? []) {
        const parent = yield* readParent(id);
        if (parent !== undefined && remoteChildOf(parent.childRequests, threadId) !== undefined) {
          byId.set(id, parent);
        }
      }
      for (const parent of yield* parentsOwing(environmentId)) {
        if (byId.has(parent.id)) continue;
        if (remoteChildOf(parent.childRequests, threadId) !== undefined)
          byId.set(parent.id, parent);
      }
      return [...byId.values()];
    });

  /**
   * The open request a computer's status or report is about: among the
   * tracked parents, then any stored parent whose requests mention it (one
   * not tracked, its startup scan having failed). Undefined only when the
   * reads worked and it is open nowhere; a read that fails fails.
   */
  const findRequest = (environmentId: string, requestId: string) =>
    Effect.gen(function* () {
      for (const parent of yield* parentsOwing(environmentId)) {
        const request = openRemote(parent, environmentId).find(
          (entry) => entry.requestId === requestId,
        );
        if (request !== undefined) return { parent, request };
      }
      const mentioning = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_threads
        WHERE child_requests LIKE ${`%"requestId":"${requestId}"%`}
      `;
      for (const row of mentioning) {
        const parent = yield* readParent(row.threadId as ThreadId);
        const request =
          parent === undefined
            ? undefined
            : openRemote(parent, environmentId).find((entry) => entry.requestId === requestId);
        if (parent !== undefined && request !== undefined) {
          track(environmentId, parent.id);
          return { parent, request };
        }
      }
      return undefined;
    });

  // ---------------------------------------------------------------------------
  // Recording what the other computer said
  // ---------------------------------------------------------------------------

  const agentName = (parent: Parent, request: OrchestrationChildRequest) =>
    (request.from.participantId !== null
      ? parent.participants.find((entry) => entry.id === request.from.participantId)?.handle
      : undefined) ?? "Agent";

  const settleRequest = (
    parent: Parent,
    request: OrchestrationChildRequest,
    settlement: {
      readonly outcome: ChildRequestOutcome;
      readonly text: string | undefined;
      readonly turnId?: string | null;
      readonly error?: string | undefined;
      /** The thread there the report named, recorded in the same write. */
      readonly child?: RemoteChildThread;
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
          ...(settlement.child !== undefined ? { remoteChild: settlement.child } : {}),
          createdAt: yield* nowIso,
        },
        "settle a request to a linked computer",
      );
    });

  /** The parent's record of a child there, as it stands now. */
  const childRecord = (
    parent: Parent,
    request: OrchestrationChildRequest,
    threadId: ThreadId,
    cachedStatus: string,
    updatedAt: string,
  ): RemoteChildThread => {
    const remote = request.remote!;
    const existing = remoteChildOf(parent.childRequests, threadId);
    return {
      environmentId: remote.environmentId,
      label: remote.label,
      threadId,
      handle: existing?.handle ?? agentName(parent, request),
      title: existing?.title ?? request.launch?.title ?? "A thread",
      attachmentEpoch: existing?.attachmentEpoch ?? 0,
      cachedStatus,
      updatedAt,
      // The record's filing and the user's word stay as it has them (the decider keeps them).
    };
  };

  /** Keeps the parent's record of a child there, created once its thread exists. */
  const recordChild = (
    parent: Parent,
    request: OrchestrationChildRequest,
    threadId: ThreadId,
    cachedStatus: string,
  ) =>
    Effect.gen(function* () {
      const existing = remoteChildOf(parent.childRequests, threadId);
      if (existing !== undefined && existing.cachedStatus === cachedStatus) return;
      yield* dispatch(
        {
          type: "thread.remote-child.update",
          commandId: CommandId.make(
            `server:remote-child:${request.remote!.environmentId}:${threadId}:${request.requestId}:${cachedStatus}`,
          ),
          threadId: parent.id,
          child: childRecord(parent, request, threadId, cachedStatus, yield* nowIso),
          createdAt: yield* nowIso,
        },
        "record a child on a linked computer",
      );
    });

  const updateRequest = (
    parent: Parent,
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
          for (const parent of yield* parentsHolding(environmentId, event.threadId)) {
            const existing = remoteChildOf(parent.childRequests, event.threadId);
            if (existing === undefined || existing.environmentId !== environmentId) continue;
            const filing = event.filing ?? existing.filing;
            if (
              existing.cachedStatus === event.status &&
              existing.title === event.title &&
              sameRemoteThreadFiling(existing.filing, filing)
            ) {
              continue;
            }
            yield* dispatch(
              {
                type: "thread.remote-child.update",
                commandId: CommandId.make(
                  `server:remote-child:${parent.id}:${environmentId}:${event.threadId}:${event.updatedAt}`,
                ),
                threadId: parent.id,
                child: {
                  ...existing,
                  title: event.title,
                  cachedStatus: event.status,
                  updatedAt: event.updatedAt,
                  ...(filing !== undefined ? { filing } : {}),
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
          if (found !== undefined) {
            const { parent, request } = found;
            const silent =
              (event.outcome === "answered" && request.launch?.reportBack === false) ||
              event.text.trim().length === 0;
            const result = yield* settleRequest(parent, request, {
              outcome: parentOutcome(event.outcome),
              text: silent ? undefined : event.text,
              turnId: event.turnId,
              error: event.error,
              // A report names its thread only when that thread exists there,
              // even when this computer never heard the start was accepted
              // (it was offline while that computer's user allowed it).
              ...(event.threadId !== null
                ? {
                    child: childRecord(
                      parent,
                      request,
                      event.threadId,
                      reportedStatus(parent, event.threadId, event.outcome),
                      yield* nowIso,
                    ),
                  }
                : {}),
            });
            // Refused means it was settled meanwhile (Stop, a wrap): recorded.
            if (!result.ok && !result.refused) {
              return yield* new ReportNotRecordedError({ requestId: event.requestId });
            }
          }
          // Read whatever settled it, now or before a restart: the answer
          // reached the parent only if it was written there.
          const delivered = yield* answerWritten(event.requestId).pipe(
            Effect.mapError(() => new ReportNotRecordedError({ requestId: event.requestId })),
          );
          yield* ackReport(environmentId, event.reportId, delivered);
          return;
        }
      }
    });

  /**
   * How a child stands once a request to it ended: what the report says,
   * unless that computer tells its threads' state itself (`filing`), whose
   * word, newer than any request's end, stands.
   */
  const reportedStatus = (parent: Parent, threadId: ThreadId, outcome: PeerRequestOutcome) => {
    const existing = remoteChildOf(parent.childRequests, threadId);
    if (existing?.filing !== undefined) return existing.cachedStatus;
    return outcome === "answered" ? "idle" : "failed";
  };

  /** Whether a request's answer was written into its parent (not dropped by Stop, a wrap, ...). */
  const answerWritten = (requestId: ChildRequestId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS "found" FROM projection_thread_messages
      WHERE message_id = ${childReportMessageId(requestId)}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * Acks a recorded report, saying whether its answer reached the parent; one
   * that doesn't land is kept, and the watch stays open, until a later try does.
   */
  const ackReport = (environmentId: string, reportId: string, delivered: boolean) =>
    client
      .withPeer(environmentId as EnvironmentId, (peer) =>
        peer["peer.report.ack"]({ reportId, delivered }),
      )
      .pipe(
        Effect.matchEffect({
          onSuccess: () =>
            Effect.sync(() => {
              pendingAcks.get(environmentId)?.delete(reportId);
            }),
          onFailure: () =>
            Effect.sync(() => {
              let owed = pendingAcks.get(environmentId);
              if (owed === undefined) {
                owed = new Map();
                pendingAcks.set(environmentId, owed);
              }
              owed.set(reportId, delivered);
            }),
        }),
      );

  const retryAcks = (environmentId: string) =>
    Effect.gen(function* () {
      // A Map may lose the entry being visited: an ack that lands removes it.
      for (const [reportId, delivered] of pendingAcks.get(environmentId) ?? []) {
        yield* ackReport(environmentId, reportId, delivered);
      }
    });

  // ---------------------------------------------------------------------------
  // The outbox
  // ---------------------------------------------------------------------------

  /** The link was removed (here or there): nothing owed to it can be done. */
  const abandon = (environmentId: string, error: ComputerLinkUnavailableError) =>
    Effect.gen(function* () {
      pendingAcks.delete(environmentId);
      for (const parent of yield* parentsOwing(environmentId)) {
        for (const request of openRemote(parent, environmentId)) {
          if (request.remote === undefined) continue;
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

  const sendRequest = (environmentId: string, parent: Parent, request: OrchestrationChildRequest) =>
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
            environmentLabel: environment.currentLabel(),
            threadId: parent.id,
            threadTitle: parent.title,
            handle: agentName(parent, request),
          },
          projectKey: launch.workspace.kind === "remote" ? launch.workspace.projectKey : "",
          ...(launch.workspace.kind === "remote" &&
          launch.workspace.projectSubdirectory !== undefined
            ? { projectSubdirectory: launch.workspace.projectSubdirectory }
            : {}),
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

  const sendSend = (environmentId: string, parent: Parent, request: OrchestrationChildRequest) =>
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
            openRemote(parent, environmentId)
              .filter(
                (request) =>
                  request.remote?.status === "sending" && request.status !== "awaiting_user",
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
          const reread = yield* readParent(parent.id);
          const current =
            reread === undefined
              ? undefined
              : openRemote(reread, environmentId).find(
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
              // With the request, that computer finds and stops its thread
              // itself: this one may never have heard the thread's id.
              if (cancel.cancelRequest) {
                yield* client.withPeer(environmentId as EnvironmentId, (peer) =>
                  peer["peer.request.cancel"]({
                    requestId: cancel.requestId,
                    ...(cancel.stopThread ? { stopThread: true } : {}),
                  }),
                );
              } else if (cancel.stopThread && cancel.threadId !== null) {
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

  /**
   * Whether a computer's watch still has anything to wait for (owed work, or
   * children held here to follow); fails when that can't be read.
   */
  const needsWatch = (environmentId: string) =>
    Effect.gen(function* () {
      const parents = yield* parentsOwing(environmentId);
      const owed =
        !drained.has(environmentId) ||
        (pendingAcks.get(environmentId)?.size ?? 0) > 0 ||
        parents.some((parent) =>
          openRemote(parent, environmentId).some((request) => request.remote?.status !== "sending"),
        );
      return owed || (yield* isFollowing(environmentId));
    });

  /** The children held here on a computer, for its watch to tell how they stand. */
  const followedThreadIds = (environmentId: string) =>
    Effect.map(parentsFollowing(environmentId), (parents) => [
      ...new Set(
        parents.flatMap((parent) =>
          childrenFollowed(parent, environmentId).map((child) => child.threadId),
        ),
      ),
    ]);

  const ensureWatch = (environmentId: string) =>
    Effect.gen(function* () {
      if (watching.has(environmentId)) return;
      if (!(yield* needsWatch(environmentId))) return;
      watching.add(environmentId);
      rewatch.delete(environmentId);
      const threads = yield* followedThreadIds(environmentId).pipe(Effect.orElseSucceed(() => []));
      watchedThreads.set(environmentId, new Set(threads));
      let restarting = false;
      // Ends the watch once nothing has been owed for a while, events or not,
      // or so a new one asks about the children held now.
      const settledDown = Effect.gen(function* () {
        let quietSince: number | null = null;
        while (true) {
          yield* Effect.sleep(WATCH_CHECK_EVERY);
          if (rewatch.delete(environmentId)) {
            restarting = true;
            return;
          }
          // A read that fails keeps it open.
          if (yield* needsWatch(environmentId).pipe(Effect.orElseSucceed(() => true))) {
            quietSince = null;
          } else if (quietSince === null) {
            quietSince = Date.now();
          } else if (Date.now() - quietSince >= WATCH_LINGER_MS) {
            return;
          }
        }
      });
      yield* client
        .peerStream(environmentId as EnvironmentId, (peer) => peer["peer.watch"]({ threads }))
        .pipe(
          Stream.mapEffect((event) => onWatchEvent(environmentId, event)),
          Stream.interruptWhen(settledDown),
          Stream.runDrain,
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Something wasn't recorded here: the next watch replays all
              // that computer still holds.
              drained.delete(environmentId);
              yield* handleUnavailable(environmentId, error);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("remote child reactor watch ended", {
              environmentId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              watching.delete(environmentId);
              watchedThreads.delete(environmentId);
              return restarting ? pump(environmentId) : Effect.void;
            }),
          ),
          Effect.forkDetach,
        );
    });

  // ---------------------------------------------------------------------------
  // Wraps given here
  // ---------------------------------------------------------------------------

  /**
   * The user's Wrap up or Reopen of children there, given here, to that
   * computer, once per word: one it took (or had a newer word for) is done,
   * and one it can't take (an older computer, or a thread no longer its
   * link's) stays a word on this side only.
   */
  const pumpWraps = (environmentId: string) =>
    laneOf(wrapLanes, environmentId).withPermits(1)(
      Effect.gen(function* () {
        const owed: Array<{
          readonly child: RemoteChildThread;
          readonly override: NonNullable<RemoteChildThread["override"]>;
        }> = [];
        // A copy: reading drops parents that owe nothing more.
        const owerIds = [...(wrapOwers.get(environmentId) ?? [])];
        for (const id of owerIds) {
          const parent = yield* readParent(id);
          const words = (parent?.deletedAt === null ? parent.childRequests.remoteChildren : [])
            ?.filter((child) => child.environmentId === environmentId && wrapOwed(child))
            .flatMap((child) => {
              const sent = wrapsSent.get(childKey(environmentId, child.threadId));
              return child.override !== undefined &&
                !(
                  sent?.at === child.override.at &&
                  sent.against === (child.filing?.override?.at ?? null)
                )
                ? [{ child, override: child.override }]
                : [];
            });
          if (words === undefined || words.length === 0) {
            wrapOwers.get(environmentId)?.delete(id);
          } else {
            owed.push(...words);
          }
        }
        if (owed.length === 0) return;
        const descriptor = yield* client
          .describe(environmentId as EnvironmentId)
          .pipe(Effect.orElseSucceed(() => null));
        if (descriptor === null || descriptor.threadFiling !== true) return;
        for (const { child, override } of owed) {
          const sent = yield* client
            .withPeer(environmentId as EnvironmentId, (peer) =>
              peer["peer.thread.wrap"]({ threadId: child.threadId, override }),
            )
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                handleUnavailable(environmentId, error).pipe(Effect.as(false)),
              ),
            );
          // Tried again with the next pump.
          if (!sent) return;
          wrapsSent.set(childKey(environmentId, child.threadId), {
            at: override.at,
            against: child.filing?.override?.at ?? null,
          });
        }
      }),
    );

  const pump = (environmentId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* pumpCancels(environmentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("remote child reactor could not send owed cancels", {
            environmentId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.forkDetach,
      );
      yield* retryAcks(environmentId);
      yield* pumpRequests(environmentId);
      yield* ensureWatch(environmentId);
      yield* pumpWraps(environmentId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("remote child reactor could not send owed work", {
          environmentId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Follows every child a parent still shows; the computers they're on. */
  const followAll = (parent: Parent) => {
    const environments = new Set<string>();
    if (parent.deletedAt !== null || parent.archivedAt !== null) return environments;
    for (const child of parent.childRequests.remoteChildren ?? []) {
      follow(child.environmentId, parent.id, child.threadId);
      environments.add(child.environmentId);
    }
    return environments;
  };

  /**
   * Parents with remote work at startup: open remote requests, or owed
   * cancels (archived and deleted parents included), and the parents still
   * showing children on linked computers.
   */
  let loaded = false;
  const loadOwing = Effect.gen(function* () {
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE child_requests IS NOT NULL
        AND ((deleted_at IS NULL AND child_requests LIKE '%"remote":{%')
          OR child_requests LIKE '%"remoteCancels":[{%'
          OR (deleted_at IS NULL AND child_requests LIKE '%"remoteChildren":[{%'))
    `;
    for (const row of rows) {
      const parent = yield* readParent(row.threadId as ThreadId);
      if (parent === undefined) continue;
      for (const request of parent.deletedAt === null ? parent.childRequests.open : []) {
        if (request.remote !== undefined) track(request.remote.environmentId, parent.id);
      }
      for (const cancel of parent.childRequests.remoteCancels ?? []) {
        track(cancel.environmentId, parent.id);
      }
      followAll(parent);
      for (const child of parent.deletedAt === null
        ? (parent.childRequests.remoteChildren ?? [])
        : []) {
        if (wrapOwed(child)) addTo(wrapOwers, child.environmentId, parent.id);
      }
    }
    loaded = true;
  }).pipe(
    // Tried again with the retries below until it works.
    Effect.catchCause((cause) =>
      Effect.logWarning("remote child reactor could not load owed work", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /** What one orchestration event means for owed work; a failure is logged, never fatal. */
  const onEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.remote-child-updated") {
        // Followed from its first record; a word the user gave here goes out.
        const child = event.payload.child;
        const environmentId = child.environmentId;
        follow(environmentId, event.payload.threadId, child.threadId);
        const owed = wrapOwed(child);
        if (owed) addTo(wrapOwers, environmentId, event.payload.threadId);
        // A child the open watch didn't ask about: a new one asks how it stands.
        const unasked =
          watching.has(environmentId) && !watchedThreads.get(environmentId)?.has(child.threadId);
        if (unasked) rewatch.add(environmentId);
        if (!watching.has(environmentId) || owed) {
          yield* pump(environmentId).pipe(Effect.forkDetach);
        }
        return;
      }
      if (event.type === "thread.unarchived") {
        // Shown again: its children are followed again, and a watch already
        // open starts over to ask how they stand now.
        const parent = yield* readParent(event.payload.threadId);
        if (parent === undefined) return;
        for (const environmentId of followAll(parent)) {
          if (!watching.has(environmentId)) {
            yield* pump(environmentId).pipe(Effect.forkDetach);
          } else if (
            (parent.childRequests.remoteChildren ?? []).some(
              (child) =>
                child.environmentId === environmentId &&
                !watchedThreads.get(environmentId)?.has(child.threadId),
            )
          ) {
            rewatch.add(environmentId);
          }
        }
        return;
      }
      if (
        event.type === "thread.child-request-submitted" &&
        event.payload.request.remote !== undefined
      ) {
        const environmentId = event.payload.request.remote.environmentId;
        track(environmentId, event.payload.threadId);
        yield* pump(environmentId).pipe(Effect.forkDetach);
        return;
      }
      if (event.type === "thread.child-request-updated" && event.payload.status === "starting") {
        const parent = yield* readParent(event.payload.threadId);
        const request = parent?.childRequests.open.find(
          (entry) => entry.requestId === event.payload.requestId,
        );
        if (request?.remote !== undefined) {
          yield* pump(request.remote.environmentId).pipe(Effect.forkDetach);
        }
        return;
      }
      if (event.type === "thread.remote-cancel-queued") {
        const environmentId = event.payload.cancel.environmentId;
        track(environmentId, event.payload.threadId);
        yield* pumpCancels(environmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("remote child reactor could not send owed cancels", {
              environmentId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.forkDetach,
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("remote child reactor could not handle an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const start: RemoteChildReactorShape["start"] = () =>
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* loadOwing;
      // Every linked computer is watched once, to drain what it held for us.
      const all = yield* links.list.pipe(Effect.orElseSucceed(() => []));
      for (const link of all) {
        if (!isUsableLink(link)) continue;
        yield* pump(link.remoteEnvironmentId).pipe(Effect.forkDetach);
      }
      for (const environmentId of new Set([
        ...parentsByEnvironment.keys(),
        ...followersByEnvironment.keys(),
      ])) {
        if (all.some((link) => link.remoteEnvironmentId === environmentId)) continue;
        yield* pump(environmentId).pipe(Effect.forkDetach);
      }
      yield* Effect.forkScoped(Stream.runForEach(events, onEvent));
      // Owed work is retried while a computer can't be reached, and so is
      // the first drain of a computer that was offline at startup (and the
      // startup scan, until it works), and the watch and wraps of one whose
      // children are followed.
      yield* Effect.gen(function* () {
        if (!loaded) yield* loadOwing;
        const environments = new Set([...parentsByEnvironment.keys(), ...pendingAcks.keys()]);
        for (const link of yield* links.list.pipe(Effect.orElseSucceed(() => []))) {
          if (isUsableLink(link) && !drained.has(link.remoteEnvironmentId)) {
            environments.add(link.remoteEnvironmentId);
          }
        }
        // And computers whose children are followed: a watch that dropped,
        // or a wrap that didn't go out.
        for (const environmentId of [...followersByEnvironment.keys(), ...wrapOwers.keys()]) {
          environments.add(environmentId);
        }
        for (const environmentId of environments) {
          yield* pump(environmentId);
        }
      }).pipe(Effect.repeat(Schedule.spaced(RETRY_EVERY)), Effect.forkScoped);
    });

  return RemoteChildReactor.of({ start });
});

export const RemoteChildReactorLive = Layer.effect(RemoteChildReactor, make);
