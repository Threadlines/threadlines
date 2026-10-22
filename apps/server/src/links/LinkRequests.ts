/**
 * LinkRequests: the child's computer's side of computer links
 * (docs/design/fleet.md, "Records on B").
 *
 * Another computer's agent (a `peer` session, over `/peer`) asks this server
 * to start a thread or to send one a message. Each request is written to the
 * ledger first, with its whole payload and the ids reserved for it, so every
 * stage resumes after a crash and a retry finds its own work. A start under
 * "ask first" waits for this computer's user; an allowed one is set up by
 * the same staged bootstrap local children use, with a remote origin instead
 * of a parent here (the thread then gets no Threadlines agent tools). The
 * turn its message starts answers it, by the same rules a local child's
 * answer follows; the answer is written with the request's end in one step
 * and offered on the asking computer's watch until it acks it. A cancel that
 * arrives before its request leaves a tombstone.
 *
 * Work on one request (its setup, a send's delivery, a cancel's clean-up)
 * runs one piece at a time, and each piece re-reads the ledger and the
 * link's current access before it acts, so a cancel or a link turned off
 * always wins, including across a restart.
 */
import {
  type AgentThreadReadResult,
  type ChildRequestId,
  type ChildRequestOutcome,
  type ChildThreadLaunch,
  type ChildThreadWorkspace,
  CommandId,
  type ComputerLinkAccess,
  ComputerLinkError,
  type ComputerLinkPendingRequest,
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  type LinksRespondRequestInput,
  type MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type PeerCancelResult,
  type PeerRequestOutcome,
  type PeerRequestStatus,
  type PeerSendInput,
  type PeerSendResult,
  type PeerStartInput,
  type PeerStartResult,
  type PeerThreadListResult,
  type PeerThreadReadInput,
  type PeerThreadStopResult,
  type PeerWatchEvent,
  PeerRpcError,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type ThreadRemoteOrigin,
  TurnId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { readThreadPage, summarizeThread, threadStatusWord } from "../mcp/threadToolHandlers.ts";
import { childRequestCommandId } from "../orchestration/childRequestIds.ts";
import { childAgentProviderName, childAgentRefusal } from "../orchestration/childThreadAgents.ts";
import { clampLaunchToCeiling } from "../orchestration/childThreadDecisions.ts";
import {
  type ChildDelivery,
  type ChildDeliveryRequest,
  childDeliveryAfterRestart,
  childDeliveryForQuietCandidate,
  childDeliveryForTurnEnd,
  finishedTurnAfterRestart,
  isQuietCandidate,
} from "../orchestration/childThreadDelivery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RemoteRequestGate,
  type RemoteRequestGateShape,
} from "../orchestration/Services/RemoteRequestGate.ts";
import {
  RemoteRequestTurnEnds,
  type RemoteRequestTurnEndsShape,
} from "../orchestration/Services/RemoteRequestTurnEnds.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RelayDeviceRepository, type RelayDeviceRow } from "../relay/RelayDeviceRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeKeyedLock } from "./keyedLock.ts";
import { linkBootstrapKey, linkCommandId, linkMessageId, linkThreadId } from "./linkIds.ts";
import {
  isTerminalLinkRequest,
  LinkRequestRepository,
  type LinkRequestRow,
} from "./LinkRequestRepository.ts";

/** A linked computer, as its `peer` session presents it here. */
export interface PeerLink {
  readonly deviceId: string;
  readonly label: string;
  readonly environmentId: string | null;
  /** `environmentId` was fixed by the invite this computer made for it. */
  readonly environmentPinned: boolean;
  readonly access: ComputerLinkAccess;
  readonly maxRuntimeMode: RuntimeMode;
}

/**
 * How `/peer` refuses a link that was removed here; the asking computer reads
 * it as "already unlinked on this side".
 */
export const PEER_LINK_REMOVED = "This link was removed.";

/**
 * Why a linked computer can't go on as the computer it now says it is: its
 * link here belongs to another one. A link's computer never changes once
 * known: pinned by the invite made for it, or else (an invite that named no
 * computer) the first one it said it was, which clients show as unconfirmed.
 * Null when it may go on.
 */
export const linkIdentityRefusal = (link: PeerLink, environmentId: string): string | null =>
  link.environmentId !== null && link.environmentId !== environmentId
    ? "This link was made for a different computer."
    : null;

/** How long a start waits for this computer's user before it expires. */
export const LINK_APPROVAL_TTL_MS = 24 * 60 * 60_000;
/** A finishing answer stands once the thread stays this quiet (as for local children). */
const QUIET_GRACE = Duration.seconds(15);
const STOP_GRACE = Duration.seconds(5);
const GIT_TIMEOUT_MS = 60_000;
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** How often an unlink that still owes stops tries again. */
export const OWED_STOPS_RETRY_EVERY = Duration.minutes(1);
/** Ends that mean a request never runs: its turn is taken back if it hasn't started. */
const TAKEN_BACK_STATUSES: ReadonlySet<PeerRequestStatus> = new Set([
  "cancelled",
  "denied",
  "expired",
]);

export interface LinkRequestsShape {
  readonly start: (link: PeerLink, input: PeerStartInput) => Effect.Effect<PeerStartResult>;
  readonly send: (
    link: PeerLink,
    input: PeerSendInput,
  ) => Effect.Effect<PeerSendResult, PeerRpcError>;
  /**
   * Takes a request back (and with `stopThread` stops the thread it runs
   * in); fails unless both are durably done, so the asking computer retries.
   */
  readonly cancel: (
    link: PeerLink,
    requestId: ChildRequestId,
    options?: { readonly stopThread?: boolean },
  ) => Effect.Effect<PeerCancelResult, PeerRpcError>;
  readonly stopThread: (
    link: PeerLink,
    threadId: ThreadId,
  ) => Effect.Effect<PeerThreadStopResult, PeerRpcError>;
  readonly readThread: (
    link: PeerLink,
    input: PeerThreadReadInput,
  ) => Effect.Effect<AgentThreadReadResult, PeerRpcError>;
  readonly listThreads: (link: PeerLink) => Effect.Effect<PeerThreadListResult>;
  /** Open requests' status and unacked reports, `synced`, then live changes. */
  readonly watch: (link: PeerLink) => Stream.Stream<PeerWatchEvent>;
  /** Fails unless the ack was recorded, so the asking computer acks again. */
  readonly ack: (link: PeerLink, reportId: string) => Effect.Effect<void, PeerRpcError>;
  /** This computer's user allows or denies a start that waits for them. */
  readonly respond: (input: LinksRespondRequestInput) => Effect.Effect<void, ComputerLinkError>;
  readonly pending: Effect.Effect<ReadonlyArray<ComputerLinkPendingRequest>>;
  /** Fires when the waiting starts change. */
  readonly pendingChanges: Stream.Stream<void>;
  /**
   * An inbound link was removed: what it still had open is cancelled. With
   * `stopRunning` (an unlink), the requests' threads are stopped too, and so
   * is every thread it started that still runs a turn asked for before
   * `turnsBefore` (when its link went off: a later turn is this computer's
   * user's, as the link can't start one then), its request answered or not.
   * Each such thread owes its stop until it is seen stopped (asked for again
   * every minute).
   */
  readonly dropLink: (
    deviceId: string,
    options?: { readonly stopRunning?: boolean; readonly turnsBefore?: string },
  ) => Effect.Effect<void, ComputerLinkError>;
  /**
   * An unlink of this link (call it as its access goes off, in the same
   * transaction) owes a full pass over what it started, until `drainDone`
   * with the generation this returns. `since` is when the first unlink
   * owed it: the link has been off since. Call again when a pass falls short.
   */
  readonly oweDrain: (
    deviceId: string,
    error?: string,
  ) => Effect.Effect<{ readonly generation: number; readonly since: string }, ComputerLinkError>;
  /** A pass after the link's session ended got through. */
  readonly drainDone: (deviceId: string, generation: number) => Effect.Effect<void>;
  /** Unlinks still owing a pass (an unlink cut off part way, or one that fell short). */
  readonly drainsOwed: Effect.Effect<
    ReadonlyArray<{
      readonly linkDeviceId: string;
      readonly generation: number;
      readonly since: string;
    }>,
    ComputerLinkError
  >;
  readonly onTurnEnd: RemoteRequestTurnEndsShape["onTurnEnd"];
  /** See RemoteRequestGate. */
  readonly messageVerdict: RemoteRequestGateShape["messageVerdict"];
  /** Start reacting to thread events and settle what the previous process left. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LinkRequests extends Context.Service<LinkRequests, LinkRequestsShape>()(
  "threadlines/links/LinkRequests",
) {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The most access a linked computer's thread gets, until its link is set
 * otherwise: what a new thread here starts with.
 */
export const DEFAULT_LINK_MAX_RUNTIME_MODE: RuntimeMode = DEFAULT_NEW_THREAD_RUNTIME_MODE;

/** A device row as the link it is: its access settings with their defaults. */
export const peerLinkOf = (row: RelayDeviceRow): PeerLink => ({
  deviceId: row.deviceId,
  label: row.label,
  environmentId: row.linkEnvironmentId,
  environmentPinned: row.linkEnvironmentPinned,
  access: row.linkAccess ?? "ask",
  maxRuntimeMode: row.linkMaxRuntimeMode ?? DEFAULT_LINK_MAX_RUNTIME_MODE,
});

const toOutcome = (outcome: ChildRequestOutcome): PeerRequestOutcome =>
  outcome === "declined" ? "denied" : outcome;

/** A ledger row as the shared delivery rules read a request. */
const deliveryRequest = (row: LinkRequestRow): ChildDeliveryRequest => ({
  requestId: row.requestId,
  status:
    row.status === "running"
      ? "running"
      : row.status === "awaiting_background"
        ? "awaiting_background"
        : "queued",
  childMessageId: row.messageId ?? ("" as MessageId),
  ...(row.candidateTurnId !== null ? { candidateTurnId: row.candidateTurnId } : {}),
});

const startPayload = (row: LinkRequestRow) =>
  row.payload?.kind === "start" ? row.payload.input : null;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const bootstrap = yield* ThreadBootstrap;
  const turns = yield* ProjectionTurnRepository;
  const threadRows = yield* ProjectionThreadRepository;
  const ledger = yield* LinkRequestRepository;
  const devices = yield* RelayDeviceRepository;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const identities = yield* RepositoryIdentityResolver;
  const git = yield* GitVcsDriver;
  const environment = yield* ServerEnvironment;
  const ownLabel = (yield* environment.getDescriptor).label;
  const sql = yield* SqlClient.SqlClient;
  const readStartupSequence = Effect.suspend(() => snapshots.getSnapshotSequence()).pipe(
    Effect.map((read) => read.snapshotSequence),
  );
  /**
   * The last event before this process could start any work, read while the
   * server is still being built (before any reactor runs): a turn asked for
   * after it is this process's own, live work. Null while unread: restart
   * recovery then classifies nothing until it has read it.
   */
  let startupSequence: number | null = yield* readStartupSequence.pipe(
    Effect.retry(Schedule.recurs(3)),
    Effect.catch((error) =>
      Effect.logWarning("link requests could not read where this process started", {
        detail: String(error),
      }).pipe(Effect.as(null)),
    ),
  );
  /**
   * Orchestration events from the moment this was built, so every turn this
   * process asks for is seen (startReactor consumes them).
   */
  const domainEvents = yield* engine.subscribeDomainEvents;
  /**
   * Message ids of linked computers' turns this process saw asked for: live
   * work, whatever the boundary.
   */
  const turnsStartedHere = new Set<string>();
  /** Whether those turn starts are being recorded yet. */
  let liveTurnsTracked = false;
  /** Requests restart recovery hasn't settled yet: the live session rules leave them to it. */
  const recovering = new Set<string>();

  const watchHub = yield* PubSub.unbounded<{
    readonly deviceId: string;
    readonly event: PeerWatchEvent;
  }>();
  const pendingHub = yield* PubSub.sliding<void>(1);
  /** Setups running in this process, so a second call doesn't queue behind the first. */
  const inFlight = new Set<string>();
  /** Requests this process recorded: live work, never the previous process's. */
  const ownRequests = new Set<string>();
  const quietChecks = new Set<string>();
  const stopChecks = new Set<string>();
  /** The status word last sent per thread, so watches only hear changes. */
  const lastThreadStatus = new Map<string, string>();

  const requestKey = (deviceId: string, requestId: string) => `${deviceId}\u0000${requestId}`;

  /**
   * One piece of work per request at a time: its setup, a send's delivery
   * and a cancel's clean-up wait for each other, so a cancel's clean-up sees
   * everything the work before it did.
   */
  const requestLock = makeKeyedLock();
  const withRequestLock = (deviceId: string, requestId: string) =>
    requestLock(requestKey(deviceId, requestId));

  /**
   * Whether the link that asked still lets its request go on: a link removed
   * since ends it cancelled, one turned off ends it denied. Read afresh
   * before every stage, so a change made while it waited (or across a
   * restart) holds.
   */
  const linkAuthority = (deviceId: string) =>
    devices.getDevice(deviceId).pipe(
      Effect.map(
        (
          found,
        ):
          | {
              readonly ok: true;
              readonly maxRuntimeMode: RuntimeMode;
              /** The computer the link was made for, when pinned by its invite. */
              readonly pinnedEnvironmentId: string | null;
            }
          | { readonly ok: false; readonly outcome: PeerRequestOutcome; readonly text: string } => {
          if (
            Option.isNone(found) ||
            found.value.state !== "active" ||
            found.value.grant !== "peer"
          ) {
            return { ok: false, outcome: "cancelled", text: `${ownLabel} removed the link.` };
          }
          if (found.value.linkAccess === "off") {
            return {
              ok: false,
              outcome: "denied",
              text: `${ownLabel} doesn't take work from ${found.value.label}.`,
            };
          }
          return {
            ok: true,
            maxRuntimeMode: found.value.linkMaxRuntimeMode ?? DEFAULT_LINK_MAX_RUNTIME_MODE,
            pinnedEnvironmentId: found.value.linkEnvironmentPinned
              ? found.value.linkEnvironmentId
              : null,
          };
        },
      ),
      Effect.orElseSucceed(() => ({
        ok: false as const,
        outcome: "failed" as const,
        text: `${ownLabel} couldn't check the link.`,
      })),
    );

  const peerError = (detail: string) => new PeerRpcError({ detail });

  /** Whether a link takes a new request now, read afresh: with its access, or why not. */
  const linkStanding = (deviceId: string) =>
    devices.getDevice(deviceId).pipe(
      Effect.map(
        (
          found,
        ):
          | { readonly open: true; readonly access: ComputerLinkAccess }
          | {
              readonly open: false;
              readonly settled: { readonly outcome: PeerRequestOutcome; readonly text: string };
            } => {
          const row = Option.getOrNull(found);
          if (row === null || row.state !== "active" || row.grant !== "peer") {
            return {
              open: false,
              settled: { outcome: "cancelled", text: `${ownLabel} removed the link.` },
            };
          }
          const access = peerLinkOf(row).access;
          return access === "off"
            ? {
                open: false,
                settled: {
                  outcome: "denied",
                  text: `${ownLabel} doesn't take work from ${row.label}.`,
                },
              }
            : { open: true, access };
        },
      ),
    );

  /**
   * Records a request as its link stands: open (waiting for this computer's
   * user under Ask first), or already ended when the link is off or gone.
   * The link is read again once the request is recorded, and one turned off
   * or removed meanwhile ends it there: an unlink turns the link off before
   * it lists what the link has open, so either the unlink finds the request
   * open and ends it, or the request finds the link off. What the link said
   * when the call came in doesn't count. (A read that fails after the
   * insert leaves it to the checks before its setup and its turn.)
   */
  const admit = (
    deviceId: string,
    record: (
      standing: Effect.Success<ReturnType<typeof linkStanding>>,
    ) => Parameters<typeof ledger.insert>[0],
  ) =>
    Effect.gen(function* () {
      const row = yield* ledger.insert(record(yield* linkStanding(deviceId)));
      if (isTerminalLinkRequest(row)) return row;
      const after = yield* linkStanding(deviceId).pipe(Effect.option);
      if (Option.isNone(after) || after.value.open) return row;
      yield* settleOrFail(row, after.value.settled.outcome, after.value.settled.text);
      const ended = yield* ledger.get(row.linkDeviceId, row.requestId);
      return Option.getOrElse(ended, () => row);
    });

  /**
   * A thread here, or undefined when there is none; a read that fails
   * fails, so a cancel or a stop never mistakes it for a thread that's gone.
   */
  const readThreadOrFail = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => peerError(`${ownLabel} couldn't read that thread.`)),
    );

  const readThread = (threadId: ThreadId) =>
    readThreadOrFail(threadId).pipe(Effect.orElseSucceed(() => undefined));

  const readRequest = (deviceId: string, requestId: ChildRequestId) =>
    ledger
      .get(deviceId, requestId)
      .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't read the request.`)));

  /**
   * Dispatches a command; `failed` when the engine refused it or couldn't
   * write it. A call cut off while its command waits in the engine's queue
   * lets go of its request before the command lands; for a send that is
   * harmless: the provider reactor asks this ledger before it sends a
   * linked computer's message (RemoteRequestGate), and takes back one whose
   * request was cancelled meanwhile.
   */
  const dispatch = (command: OrchestrationCommand, what: string) =>
    engine.dispatch(command).pipe(
      Effect.as("ok" as const),
      Effect.catch((error) =>
        Effect.logInfo(`link requests could not ${what}`, { detail: String(error) }).pipe(
          Effect.as("failed" as const),
        ),
      ),
    );

  /** A dispatch the asking computer must hear failed, so it tries again. */
  const mustDispatch = (command: OrchestrationCommand, what: string) =>
    dispatch(command, what).pipe(
      Effect.flatMap((result) =>
        result === "ok" ? Effect.void : Effect.fail(peerError(`${ownLabel} couldn't ${what}.`)),
      ),
    );

  const publish = (deviceId: string, event: PeerWatchEvent) =>
    PubSub.publish(watchHub, { deviceId, event }).pipe(Effect.asVoid);

  /**
   * A report names its thread only when that thread exists here: a start
   * reserves its thread's id long before (or without ever) creating it, and
   * the asking computer remembers every thread a report names.
   */
  const existingThreadId = (row: LinkRequestRow) =>
    row.threadId === null
      ? Effect.succeed(null)
      : threadRows.getById({ threadId: row.threadId }).pipe(
          Effect.map((found) =>
            Option.isSome(found) && found.value.deletedAt === null ? row.threadId : null,
          ),
          Effect.orElseSucceed(() => null),
        );

  const reportEvent = (row: LinkRequestRow) =>
    Effect.gen(function* () {
      if (row.reportId === null || row.reportOutcome === null || row.settledAt === null) {
        return null;
      }
      return {
        type: "report",
        reportId: row.reportId,
        requestId: row.requestId,
        threadId: yield* existingThreadId(row),
        outcome: row.reportOutcome,
        text: row.reportText ?? "",
        turnId: row.reportTurnId,
        ...(row.reportError !== null && row.reportError.trim().length > 0
          ? { error: row.reportError }
          : {}),
        settledAt: row.settledAt,
      } satisfies PeerWatchEvent;
    });

  const statusEvent = (row: LinkRequestRow): PeerWatchEvent => ({
    type: "status",
    requestId: row.requestId,
    threadId: row.threadId,
    status: row.status,
    updatedAt: row.updatedAt,
  });

  const publishRow = (deviceId: string, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const row = yield* ledger.get(deviceId, requestId).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(row)) return;
      const report = yield* reportEvent(row.value);
      yield* publish(deviceId, report ?? statusEvent(row.value));
      if (row.value.status === "awaiting_approval" || isTerminalLinkRequest(row.value)) {
        yield* PubSub.publish(pendingHub, undefined);
      }
    });

  /**
   * Moves an open request on and tells its computer: false when it had
   * already ended or moved on (`from`); fails when the write failed.
   */
  const progressOrFail = (
    row: LinkRequestRow,
    patch: {
      readonly status: PeerRequestStatus;
      /** Only from these statuses (it may have moved on meanwhile). */
      readonly from?: ReadonlyArray<PeerRequestStatus>;
      readonly turnId?: TurnId | null;
      readonly candidateTurnId?: TurnId | null;
    },
  ) =>
    Effect.gen(function* () {
      const moved = yield* ledger
        .progress({
          linkDeviceId: row.linkDeviceId,
          requestId: row.requestId,
          ...patch,
          now: yield* nowIso,
        })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't record the request.`)));
      if (moved) yield* publishRow(row.linkDeviceId, row.requestId);
      return moved;
    });

  /** progressOrFail, where a failed write is left for a later event or restart. */
  const progress = (row: LinkRequestRow, patch: Parameters<typeof progressOrFail>[1]) =>
    progressOrFail(row, patch).pipe(Effect.orElseSucceed(() => false));

  /**
   * Ends a request with its report, in one write, and tells its computer:
   * false when it had already ended; fails when the write failed.
   */
  const settleOrFail = (
    row: Pick<LinkRequestRow, "linkDeviceId" | "requestId">,
    outcome: PeerRequestOutcome,
    text: string,
    options: { readonly turnId?: TurnId | null; readonly error?: string } = {},
  ) =>
    Effect.gen(function* () {
      const settled = yield* ledger
        .settle({
          linkDeviceId: row.linkDeviceId,
          requestId: row.requestId,
          outcome,
          text,
          turnId: options.turnId ?? null,
          error: options.error,
          now: yield* nowIso,
        })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't record the request's end.`)));
      if (settled) yield* publishRow(row.linkDeviceId, row.requestId);
      return settled;
    });

  /** settleOrFail, where a failed write is left for a later event or restart. */
  const settle = (
    row: Pick<LinkRequestRow, "linkDeviceId" | "requestId">,
    outcome: PeerRequestOutcome,
    text: string,
    options: { readonly turnId?: TurnId | null; readonly error?: string } = {},
  ) => settleOrFail(row, outcome, text, options).pipe(Effect.orElseSucceed(() => false));

  const settleDelivery = (row: LinkRequestRow, delivery: ChildDelivery) =>
    delivery.type === "thread.child-request.update"
      ? progress(row, { status: "awaiting_background", candidateTurnId: delivery.candidateTurnId })
      : settle(row, toOutcome(delivery.outcome), delivery.reply.text, {
          turnId: delivery.reply.turnId,
          ...(delivery.error !== undefined ? { error: delivery.error } : {}),
        });

  // ---------------------------------------------------------------------------
  // Where a start runs: the project, its checkout, the agent
  // ---------------------------------------------------------------------------

  const projectForKey = (canonicalKey: string) =>
    Effect.gen(function* () {
      const catalog = yield* snapshots
        .getProjectCatalog()
        .pipe(Effect.orElseSucceed(() => ({ projects: [] as const })));
      for (const project of catalog.projects) {
        if (project.deletedAt !== null || project.kind === "general-chat") continue;
        const identity = yield* identities.resolve(project.workspaceRoot);
        if (identity?.canonicalKey === canonicalKey) return project;
      }
      return undefined;
    });

  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "LinkRequests.resolveBase",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: 16_384,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );

  /**
   * Where the child works: its own new worktree off the asking computer's
   * pushed branch when this computer can fetch it, otherwise off this
   * computer's default branch; a project without git shares its folder.
   */
  const resolveWorkspace = (projectCwd: string, input: PeerStartInput) =>
    Effect.gen(function* () {
      if ((yield* runGit(projectCwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
        return { kind: "project_folder" } satisfies ChildThreadWorkspace;
      }
      const commitOf = (ref: string) =>
        runGit(projectCwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      const branch = input.workspace.kind === "worktree" ? input.workspace.branch : undefined;
      if (branch !== undefined && /^[\w./-]+$/u.test(branch) && !branch.includes("..")) {
        yield* runGit(projectCwd, ["fetch", "--quiet", "origin", branch]);
        const fetched = yield* commitOf(`refs/remotes/origin/${branch}`);
        if (fetched !== null) {
          return { kind: "worktree", projectCwd, baseRef: fetched } satisfies ChildThreadWorkspace;
        }
      }
      const base = (yield* commitOf("refs/remotes/origin/HEAD")) ?? (yield* commitOf("HEAD"));
      if (base === null) {
        return { kind: "project_folder" } satisfies ChildThreadWorkspace;
      }
      return { kind: "worktree", projectCwd, baseRef: base } satisfies ChildThreadWorkspace;
    });

  /** The agent the asking computer named, with a model: this computer's own instance ids. */
  const resolveAgent = (input: PeerStartInput) =>
    Effect.gen(function* () {
      const all = yield* providers.getProviders;
      const provider = all.find((entry) => entry.instanceId === input.agent.instanceId);
      if (provider === undefined) {
        return { refused: `${ownLabel} has no agent "${input.agent.instanceId}".` };
      }
      const refusal = childAgentRefusal(provider, input.interactionMode);
      if (refusal !== null) {
        return { refused: `${ownLabel} can't start that agent: ${refusal}.` };
      }
      const defaults = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
      const preferred =
        defaults?.newThreadModelSelection?.instanceId === provider.instanceId
          ? defaults.newThreadModelSelection.model
          : undefined;
      const model =
        input.agent.model ??
        preferred ??
        provider.models.find((entry) => entry.isHidden !== true)?.slug;
      if (model === undefined) {
        return { refused: `${ownLabel} has no model for that agent.` };
      }
      if (
        input.agent.model !== undefined &&
        !provider.models.some((entry) => entry.slug === input.agent.model)
      ) {
        return {
          refused: `${ownLabel}'s ${childAgentProviderName(provider)} has no model "${input.agent.model}".`,
        };
      }
      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make(provider.instanceId),
        model,
        ...(input.agent.options !== undefined && input.agent.options.length > 0
          ? { options: [...input.agent.options] }
          : {}),
      };
      return { selection };
    });

  // ---------------------------------------------------------------------------
  // Starting
  // ---------------------------------------------------------------------------

  const startAnswer = (row: LinkRequestRow): PeerStartResult => {
    switch (row.status) {
      case "awaiting_approval":
        return { status: "awaiting_approval", ...(row.threadId ? { threadId: row.threadId } : {}) };
      case "cancelled":
        return { status: "cancelled" };
      case "denied":
      case "expired":
        return { status: "refused", reason: row.reportText ?? `${ownLabel} didn't allow it.` };
      // A start that failed before any turn ran never started.
      case "failed":
        return row.turnId === null && row.reportTurnId === null
          ? { status: "refused", reason: row.reportText ?? "It couldn't be started." }
          : { status: "started", ...(row.threadId ? { threadId: row.threadId } : {}) };
      default:
        return { status: "started", ...(row.threadId ? { threadId: row.threadId } : {}) };
    }
  };

  /**
   * Sets a request's thread up and starts its first turn, resuming whatever
   * an earlier run left done. Before every stage the ledger and the link are
   * read again: a cancel that lands meanwhile, or the link removed or turned
   * off, stops it before anything more runs.
   */
  const bootstrapRequest = (deviceId: string, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const key = requestKey(deviceId, requestId);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      yield* withRequestLock(
        deviceId,
        requestId,
      )(
        Effect.gen(function* () {
          const found = yield* ledger
            .get(deviceId, requestId)
            .pipe(Effect.orElseSucceed(Option.none));
          if (Option.isNone(found)) return;
          const row = found.value;
          const input = startPayload(row);
          if (row.status !== "received" || input === null || row.threadId === null) return;
          const authority = yield* linkAuthority(deviceId);
          if (!authority.ok) {
            yield* settle(row, authority.outcome, authority.text);
            return;
          }
          const fail = (detail: string) =>
            settle(
              row,
              "failed",
              `'${input.title}' couldn't be started on ${ownLabel}: ${detail}`,
              {
                error: detail,
              },
            );
          const project = yield* projectForKey(input.projectKey);
          if (project === undefined) {
            return yield* fail(`${ownLabel} doesn't have this project.`);
          }
          const agent = yield* resolveAgent(input);
          if ("refused" in agent) {
            return yield* fail(agent.refused);
          }
          const workspace = yield* resolveWorkspace(project.workspaceRoot, input);
          const launch: ChildThreadLaunch = clampLaunchToCeiling(
            {
              title: input.title,
              prompt: input.prompt,
              modelSelection: agent.selection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              reportBack: input.reportBack,
              runSetup: input.runSetup ?? true,
              workspace,
            },
            { runtimeMode: authority.maxRuntimeMode, interactionMode: input.interactionMode },
          );
          const remoteOrigin: ThreadRemoteOrigin = {
            linkDeviceId: deviceId,
            environmentId: input.parent.environmentId,
            environmentPinned: authority.pinnedEnvironmentId === input.parent.environmentId,
            environmentLabel: input.parent.environmentLabel,
            threadId: input.parent.threadId,
            threadTitle: input.parent.threadTitle,
          };
          // Still open, and the link still lets it go on; a link that no
          // longer does ends it here, with the reason.
          const mayGoOn = Effect.gen(function* () {
            const current = yield* ledger
              .get(deviceId, requestId)
              .pipe(Effect.orElseSucceed(Option.none));
            if (Option.isNone(current) || current.value.status !== "received") return false;
            const now = yield* linkAuthority(deviceId);
            if (!now.ok) {
              yield* settle(current.value, now.outcome, now.text);
              return false;
            }
            return true;
          });
          const exit = yield* Effect.exit(
            bootstrap.startChild({
              lineage: { kind: "remote", remoteOrigin },
              projectId: project.id,
              requestId: linkBootstrapKey(deviceId, requestId),
              childThreadId: row.threadId,
              childMessageId: row.messageId ?? linkMessageId(deviceId, requestId),
              launch,
              fromThread: {
                threadId: input.parent.threadId,
                requestId,
                kind: "request",
                environmentId: input.parent.environmentId,
              },
              createdAt: row.createdAt,
              checkpoint: () => mayGoOn,
            }),
          );
          if (exit._tag === "Failure") {
            const failure = Cause.findErrorOption(exit.cause);
            const current = yield* ledger
              .get(deviceId, requestId)
              .pipe(Effect.orElseSucceed(Option.none));
            // A cancel, or the link changing, already ended it.
            if (Option.isSome(current) && isTerminalLinkRequest(current.value)) return;
            return yield* fail(Option.isSome(failure) ? failure.value.detail : "its setup failed.");
          }
          if (!input.reportBack) {
            yield* settle(row, "answered", "");
            return;
          }
          // Its turn may have started already (then it is running): never back.
          yield* progress(row, { status: "queued", from: ["received"] });
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(key))));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("link requests could not set a thread up", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: LinkRequestsShape["start"] = (link, input) =>
    Effect.gen(function* () {
      // Its thread here names the computer that asked: never one it isn't.
      const impostor = linkIdentityRefusal(link, input.parent.environmentId);
      if (impostor !== null) {
        yield* Effect.logWarning("links.identity-mismatch", {
          deviceId: link.deviceId,
          claimed: input.parent.environmentId,
        });
        return { status: "refused", reason: impostor } as const;
      }
      const existing = yield* ledger
        .get(link.deviceId, input.requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(existing)) {
        // A first call cut off before its setup began: this one begins it.
        if (existing.value.status === "received") {
          yield* bootstrapRequest(link.deviceId, input.requestId).pipe(Effect.forkDetach);
        }
        return startAnswer(existing.value);
      }
      const now = yield* nowIso;
      const threadId = linkThreadId(link.deviceId, input.requestId);
      const messageId = linkMessageId(link.deviceId, input.requestId);
      // A link that is off (or gone) is refused in the same write that
      // records the request, so no restart can find it waiting to be set up.
      ownRequests.add(requestKey(link.deviceId, input.requestId));
      const inserted = yield* admit(link.deviceId, (admission) => ({
        linkDeviceId: link.deviceId,
        requestId: input.requestId,
        status: admission.open && admission.access === "ask" ? "awaiting_approval" : "received",
        payload: { kind: "start", input },
        threadId,
        messageId,
        ...(admission.open ? {} : { settled: admission.settled }),
        now,
      })).pipe(Effect.option);
      if (Option.isNone(inserted)) {
        return { status: "refused", reason: `${ownLabel} couldn't record the request.` } as const;
      }
      const row = inserted.value;
      // Another call won the insert (a retry racing itself): its answer stands.
      if (row.createdAt !== now || startPayload(row) === null) {
        return startAnswer(row);
      }
      if (isTerminalLinkRequest(row)) {
        yield* publishRow(link.deviceId, input.requestId);
        return startAnswer(row);
      }
      // Refused early when this computer can't do it at all.
      if ((yield* projectForKey(input.projectKey)) === undefined) {
        const reason = `${ownLabel} doesn't have this project.`;
        yield* settle(row, "failed", reason, { error: reason });
        return { status: "refused", reason } as const;
      }
      const agent = yield* resolveAgent(input);
      if ("refused" in agent) {
        yield* settle(row, "failed", agent.refused, { error: agent.refused });
        return { status: "refused", reason: agent.refused } as const;
      }
      yield* devices
        .touchLink({ deviceId: link.deviceId, environmentId: input.parent.environmentId, now })
        .pipe(Effect.ignore);
      if (row.status === "awaiting_approval") {
        yield* publishRow(link.deviceId, input.requestId);
        return { status: "awaiting_approval", threadId } as const;
      }
      yield* bootstrapRequest(link.deviceId, input.requestId).pipe(Effect.forkDetach);
      return { status: "started", threadId } as const;
    });

  // ---------------------------------------------------------------------------
  // Sending, cancelling, stopping
  // ---------------------------------------------------------------------------

  /** A thread this link started, or undefined; fails when it can't be read. */
  const linkThread = (link: PeerLink, threadId: ThreadId) =>
    readThreadOrFail(threadId).pipe(
      Effect.map((thread) =>
        thread !== undefined &&
        thread.deletedAt === null &&
        thread.remoteOrigin?.linkDeviceId === link.deviceId
          ? thread
          : undefined,
      ),
    );

  const sendAnswer = (row: LinkRequestRow): PeerSendResult =>
    row.status === "cancelled"
      ? { status: "cancelled" }
      : row.status === "denied" || row.status === "expired" || row.status === "failed"
        ? { status: "refused", reason: row.reportText ?? "It couldn't be sent." }
        : { status: "queued" };

  /**
   * Writes a recorded send (`received`) into its thread and marks it
   * delivered (`queued`). Runs under the request's lock and reads the
   * ledger again first, so a cancel that ended it meanwhile wins; replaying
   * it after a restart is safe, its command id being the request's own.
   */
  const deliverSend = (deviceId: string, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const found = yield* readRequest(deviceId, requestId);
      if (Option.isNone(found)) {
        return { status: "refused", reason: "That message wasn't recorded." } as const;
      }
      const row = found.value;
      if (row.status !== "received" || row.payload?.kind !== "send") return sendAnswer(row);
      const input = row.payload.input;
      const thread = row.threadId === null ? undefined : yield* readThreadOrFail(row.threadId);
      const origin = thread?.remoteOrigin ?? null;
      if (thread === undefined || origin === null || row.messageId === null) {
        const reason = `That thread is gone from ${ownLabel}.`;
        yield* settleOrFail(row, "failed", reason, { error: reason });
        return { status: "refused", reason } as const;
      }
      const sent = yield* dispatch(
        {
          type: "thread.remote-request.queue",
          commandId: linkCommandId(deviceId, requestId, "queue"),
          threadId: thread.id,
          messageId: row.messageId,
          text: input.text,
          fromThread: {
            threadId: origin.threadId,
            requestId,
            kind: "request",
            environmentId: origin.environmentId,
          },
          createdAt: row.createdAt,
        },
        "queue a linked computer's message",
      );
      if (sent === "failed") {
        const reason = "The thread couldn't take the message.";
        yield* settleOrFail(row, "failed", reason, { error: reason });
        return { status: "refused", reason } as const;
      }
      // Its turn may have started already (then it is running): never back.
      yield* progressOrFail(row, { status: "queued", from: ["received"] });
      return { status: "queued" } as const;
    });

  /**
   * A recorded send not delivered yet (its first call was cut off, or the
   * process stopped): delivered now, unless its link no longer lets it in.
   * Call under the request's lock.
   */
  const resumeSend = (row: LinkRequestRow) =>
    Effect.gen(function* () {
      const authority = yield* linkAuthority(row.linkDeviceId);
      if (!authority.ok) {
        yield* settleOrFail(row, authority.outcome, authority.text);
        return authority.outcome === "cancelled"
          ? ({ status: "cancelled" } as const)
          : ({ status: "refused", reason: authority.text } as const);
      }
      return yield* deliverSend(row.linkDeviceId, row.requestId);
    });

  const send: LinkRequestsShape["send"] = (link, input) =>
    withRequestLock(
      link.deviceId,
      input.requestId,
    )(
      Effect.gen(function* () {
        const existing = yield* ledger
          .get(link.deviceId, input.requestId)
          .pipe(Effect.orElseSucceed(Option.none));
        if (Option.isSome(existing)) {
          // A first call cut off before it delivered: this one delivers it.
          if (existing.value.status === "received" && existing.value.payload?.kind === "send") {
            const answer = yield* resumeSend(existing.value);
            yield* publishRow(link.deviceId, input.requestId);
            return answer;
          }
          return sendAnswer(existing.value);
        }
        const thread = yield* linkThread(link, input.threadId);
        if (thread === undefined) {
          return {
            status: "refused",
            reason: "That thread wasn't started by this link.",
          } as const;
        }
        const now = yield* nowIso;
        // Recorded before it is delivered: a restart finds it and delivers
        // it. Refused in that same write when the link is off or gone.
        ownRequests.add(requestKey(link.deviceId, input.requestId));
        const inserted = yield* admit(link.deviceId, (admission) => ({
          linkDeviceId: link.deviceId,
          requestId: input.requestId,
          status: "received",
          payload: { kind: "send", input },
          threadId: thread.id,
          messageId: linkMessageId(link.deviceId, input.requestId),
          ...(admission.open ? {} : { settled: admission.settled }),
          now,
        })).pipe(Effect.option);
        if (Option.isNone(inserted)) {
          return {
            status: "refused",
            reason: `${ownLabel} couldn't record the message.`,
          } as const;
        }
        const row = inserted.value;
        if (row.createdAt !== now || row.payload?.kind !== "send") return sendAnswer(row);
        if (isTerminalLinkRequest(row)) {
          yield* publishRow(link.deviceId, input.requestId);
          return sendAnswer(row);
        }
        const answer = yield* deliverSend(link.deviceId, input.requestId);
        yield* publishRow(link.deviceId, input.requestId);
        return answer;
      }),
    );

  /** Whether a thread still has anything going: a turn, a session at work, queued messages. */
  /**
   * Whether a thread's agent is at work: a turn, a session at work, a
   * background task. (Unlike isWorking, messages queued for later don't
   * count: a stop leaves those, and an unlink takes back its own.)
   */
  const isRunning = (thread: OrchestrationThread) => {
    const session = thread.session;
    return (
      thread.latestTurn?.state === "running" ||
      (session !== null &&
        (session.activeTurnId !== null ||
          session.status === "running" ||
          session.status === "starting" ||
          (session.pendingBackgroundTaskCount ?? 0) > 0))
    );
  };

  const isWorking = (thread: OrchestrationThread) => {
    const session = thread.session;
    return (
      thread.latestTurn?.state === "running" ||
      (session !== null &&
        (session.activeTurnId !== null ||
          session.status === "running" ||
          session.status === "starting" ||
          (session.pendingBackgroundTaskCount ?? 0) > 0)) ||
      (thread.queuedFollowUps ?? []).length > 0
    );
  };

  /** Which turn a thread is at, for telling "still at it" from "moved on". */
  const turnKeyOf = (thread: OrchestrationThread) => thread.latestTurn?.turnId ?? "none";

  /**
   * Stops a link's thread if it is still working; fails if the stop wasn't
   * recorded. `retry` makes it a new stop (the first one, already recorded,
   * didn't take), not a replay of the first.
   */
  const stopIfWorking = (deviceId: string, thread: OrchestrationThread, retry?: string) =>
    Effect.gen(function* () {
      if (!isWorking(thread)) return "not_running" as const;
      yield* mustDispatch(
        {
          type: "thread.session.stop",
          commandId: CommandId.make(
            `server:link-stop:${deviceId}:${thread.id}:${turnKeyOf(thread)}${
              retry === undefined ? "" : `:retry:${retry}`
            }`,
          ),
          threadId: thread.id,
          createdAt: yield* nowIso,
        },
        "stop that thread",
      );
      return "stopped" as const;
    });

  /**
   * What a cancel still owes the request's thread (the ledger's `cleanup`,
   * written with the cancel): its message, if it still waits there, is taken
   * back; with `stop` the thread is stopped if it is still working. Then it
   * is marked done. Runs under the request's lock, after any setup or
   * delivery in flight; again on every retry of the cancel, and at startup
   * for one the previous process didn't finish.
   */
  const cleanUpCancel = (deviceId: string, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const found = yield* readRequest(deviceId, requestId);
      if (Option.isNone(found) || found.value.cleanup === null) return;
      const row = found.value;
      const cleanup = found.value.cleanup;
      const thread = row.threadId === null ? undefined : yield* readThreadOrFail(row.threadId);
      const messageId = row.messageId;
      if (
        thread !== undefined &&
        row.status === "cancelled" &&
        messageId !== null &&
        (thread.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId)
      ) {
        yield* mustDispatch(
          {
            type: "thread.follow-up.unqueue",
            commandId: linkCommandId(deviceId, requestId, "cancel-unqueue"),
            threadId: thread.id,
            messageId,
            createdAt: yield* nowIso,
          },
          "take back the cancelled message",
        );
      }
      if (thread !== undefined && cleanup === "stop") {
        const current = yield* readThreadOrFail(thread.id);
        if (current !== undefined) yield* stopIfWorking(deviceId, current);
      }
      yield* ledger
        .finishCleanup({ linkDeviceId: deviceId, requestId, cleanup })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't record the cancel.`)));
    });

  /**
   * Ends a request `cancelled` (a tombstone when it hasn't arrived yet),
   * recording in the same write what its thread is still owed, so work in
   * flight stops at its next check and a restart finishes the clean-up; then
   * cleans up. Answered only once both are durable.
   */
  const cancelRequest = (
    deviceId: string,
    requestId: ChildRequestId,
    text: string,
    stopThread: boolean,
  ) =>
    Effect.gen(function* () {
      const result = yield* ledger
        .cancel({ linkDeviceId: deviceId, requestId, text, stopThread, now: yield* nowIso })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't record the cancel.`)));
      if (result.cancelled) yield* publishRow(deviceId, requestId);
      yield* withRequestLock(deviceId, requestId)(cleanUpCancel(deviceId, requestId));
      return {
        status: result.row.status === "cancelled" ? "cancelled" : "already_settled",
      } as const;
    });

  const cancel: LinkRequestsShape["cancel"] = (link, requestId, options) =>
    cancelRequest(
      link.deviceId,
      requestId,
      "The thread that asked took the request back.",
      options?.stopThread === true,
    );

  const stopThread: LinkRequestsShape["stopThread"] = (link, threadId) =>
    Effect.gen(function* () {
      const thread = yield* linkThread(link, threadId);
      if (thread === undefined) {
        return { status: "not_yours" } as const;
      }
      return { status: yield* stopIfWorking(link.deviceId, thread) } as const;
    });

  // ---------------------------------------------------------------------------
  // Reading and listing
  // ---------------------------------------------------------------------------

  const readLinkThread: LinkRequestsShape["readThread"] = (link, input) =>
    Effect.gen(function* () {
      const none = { messages: [], next: null, more: false };
      const target = yield* linkThread(link, input.threadId);
      if (target === undefined) {
        return {
          outcome: "refused",
          detail: "That thread isn't one this computer's link started.",
          ...none,
        } as const;
      }
      const all = yield* providers.getProviders;
      const shell = yield* snapshots.getThreadShellById(target.id).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const titles = new Map<string, string>();
      return {
        outcome: "ok",
        ...(shell !== undefined
          ? {
              thread: summarizeThread(shell, { providers: all, titleOf: () => undefined }),
            }
          : {}),
        ...readThreadPage(target, {
          providers: all,
          titles,
          after: input.after,
          limit: input.limit,
        }),
      } satisfies AgentThreadReadResult;
    });

  const listThreads: LinkRequestsShape["listThreads"] = (link) =>
    Effect.gen(function* () {
      const shell = yield* snapshots
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => ({ threads: [] as const })));
      const all = yield* providers.getProviders;
      return {
        threads: shell.threads
          .filter((thread) => thread.remoteOrigin?.linkDeviceId === link.deviceId)
          .map((thread) => summarizeThread(thread, { providers: all, titleOf: () => undefined })),
      };
    });

  // ---------------------------------------------------------------------------
  // The watch
  // ---------------------------------------------------------------------------

  const watch: LinkRequestsShape["watch"] = (link) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the replay is read, so nothing falls between.
        const live = yield* PubSub.subscribe(watchHub);
        const rows = yield* ledger.listForWatch(link.deviceId).pipe(Effect.orElseSucceed(() => []));
        const replay: Array<PeerWatchEvent> = [];
        for (const row of rows) {
          replay.push((yield* reportEvent(row)) ?? statusEvent(row));
        }
        replay.push({ type: "synced" });
        return Stream.concat(
          Stream.fromIterable(replay),
          Stream.fromSubscription(live).pipe(
            Stream.filter((entry) => entry.deviceId === link.deviceId),
            Stream.map((entry) => entry.event),
          ),
        );
      }),
    );

  const ack: LinkRequestsShape["ack"] = (link, reportId) =>
    Effect.gen(function* () {
      yield* ledger
        .markDelivered({ linkDeviceId: link.deviceId, reportId, now: yield* nowIso })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't record that.`)));
    });

  // ---------------------------------------------------------------------------
  // Ask first
  // ---------------------------------------------------------------------------

  const respond: LinkRequestsShape["respond"] = (input) =>
    Effect.gen(function* () {
      const found = yield* ledger
        .get(input.deviceId, input.requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(found) || found.value.status !== "awaiting_approval") {
        return yield* new ComputerLinkError({ detail: "That request is no longer waiting." });
      }
      const row = found.value;
      if (!input.allow) {
        yield* settle(row, "denied", `${ownLabel} didn't allow it.`);
        return;
      }
      yield* progress(row, { status: "received" });
      yield* bootstrapRequest(row.linkDeviceId, row.requestId).pipe(Effect.forkDetach);
    });

  const pending: LinkRequestsShape["pending"] = Effect.gen(function* () {
    const open = yield* ledger.listOpen.pipe(Effect.orElseSucceed(() => []));
    const waiting = open.filter((row) => row.status === "awaiting_approval");
    const result: Array<ComputerLinkPendingRequest> = [];
    for (const row of waiting) {
      const input = startPayload(row);
      if (input === null) continue;
      const device = yield* devices
        .getDevice(row.linkDeviceId)
        .pipe(Effect.orElseSucceed(Option.none));
      const project = yield* projectForKey(input.projectKey);
      result.push({
        deviceId: row.linkDeviceId,
        requestId: row.requestId,
        fromLabel: Option.isSome(device) ? device.value.label : input.parent.environmentLabel,
        parentThreadTitle: input.parent.threadTitle,
        title: input.title,
        prompt: input.prompt.slice(0, 2_000),
        projectName: project?.title ?? input.projectKey,
        createdAt: row.createdAt,
        expiresAt: DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse(row.createdAt) + LINK_APPROVAL_TTL_MS),
        ),
      });
    }
    return result;
  });

  const dropLink: LinkRequestsShape["dropLink"] = (deviceId, options) =>
    Effect.gen(function* () {
      const stopRunning = options?.stopRunning === true;
      // An unlink must not claim its work stopped when some of it didn't:
      // it fails, the link stays, and the unlink is tried again.
      let incomplete = false;
      const open = yield* ledger.listOpen.pipe(
        Effect.catch((error) =>
          Effect.logWarning("link requests could not list a removed link's requests", {
            detail: String(error),
          }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                incomplete = true;
                return [] as ReadonlyArray<LinkRequestRow>;
              }),
            ),
          ),
        ),
      );
      for (const row of open) {
        if (row.linkDeviceId !== deviceId) continue;
        yield* cancelRequest(
          deviceId,
          row.requestId,
          `${ownLabel} removed the link.`,
          stopRunning,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("link requests could not cancel a removed link's request", {
              detail: error.detail,
            }).pipe(Effect.andThen(Effect.sync(() => (incomplete = true)))),
          ),
        );
      }
      if (stopRunning) {
        // Its threads whose requests already settled can still be at work
        // (a follow-up, a background task): an unlink stops them too.
        const threadIds = yield* threadRows.listIdsByRemoteLink({ linkDeviceId: deviceId }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("link requests could not list a removed link's threads", {
              detail: String(error),
            }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  incomplete = true;
                  return [] as ReadonlyArray<ThreadId>;
                }),
              ),
            ),
          ),
        );
        for (const threadId of threadIds) {
          yield* Effect.gen(function* () {
            const thread = yield* readThreadOrFail(threadId);
            if (thread === undefined || thread.deletedAt !== null) return;
            if (thread.remoteOrigin?.linkDeviceId !== deviceId) return;
            if (!isRunning(thread)) return;
            // A turn asked for once the link was off is this computer's user's.
            const turnsBefore = options?.turnsBefore;
            const requestedAt = thread.latestTurn?.requestedAt;
            if (
              turnsBefore !== undefined &&
              requestedAt !== undefined &&
              requestedAt > turnsBefore
            ) {
              return;
            }
            // Owed before it is asked for: a stop that doesn't take is asked
            // for again until the thread is seen stopped.
            yield* ledger.oweThreadStop({
              linkDeviceId: deviceId,
              threadId,
              turnKey: turnKeyOf(thread),
              now: yield* nowIso,
            });
            yield* stopIfWorking(deviceId, thread);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("link requests could not stop a removed link's thread", {
                    threadId,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.andThen(Effect.sync(() => (incomplete = true)))),
            ),
          );
        }
      }
      if (stopRunning && incomplete) {
        return yield* new ComputerLinkError({
          detail: `${ownLabel} couldn't stop everything the link started. Try again.`,
        });
      }
    });

  const oweDrain: LinkRequestsShape["oweDrain"] = (deviceId, error) =>
    Effect.gen(function* () {
      return yield* ledger.oweDrain({
        linkDeviceId: deviceId,
        ...(error !== undefined ? { error } : {}),
        now: yield* nowIso,
      });
    }).pipe(
      Effect.mapError(
        () =>
          new ComputerLinkError({ detail: `${ownLabel} couldn't record the unlink. Try again.` }),
      ),
    );

  const drainDone: LinkRequestsShape["drainDone"] = (deviceId, generation) =>
    ledger.clearDrainOwed({ linkDeviceId: deviceId, generation }).pipe(
      Effect.catch((error) =>
        // Left owed: the next pass gets through and clears it.
        Effect.logWarning("link requests could not clear an unlink's pass", {
          detail: String(error),
        }),
      ),
    );

  const drainsOwed: LinkRequestsShape["drainsOwed"] = ledger.listDrainsOwed.pipe(
    Effect.mapError(
      () => new ComputerLinkError({ detail: `${ownLabel} couldn't read its unlinks.` }),
    ),
  );

  /**
   * One pass over stops unlinks still owe: a thread still at work on the
   * turn it was at is asked to stop again (as a new stop, not a replay); one
   * stopped, or gone on to a later turn (its user's: the link was off by
   * then), owes nothing more. A whole-link pass an unlink still owes is
   * ComputerLinks' to finish, since it ends the link's session too.
   */
  const finishOwedStops = Effect.gen(function* () {
    const stops = yield* ledger.listThreadStopsOwed.pipe(Effect.option);
    if (Option.isNone(stops)) {
      yield* Effect.logWarning("link requests could not list threads that owe a stop");
      return;
    }
    const attempt = yield* nowIso;
    for (const owed of stops.value) {
      yield* Effect.gen(function* () {
        const thread = yield* readThreadOrFail(owed.threadId);
        if (
          thread === undefined ||
          thread.deletedAt !== null ||
          !isRunning(thread) ||
          turnKeyOf(thread) !== owed.turnKey
        ) {
          yield* ledger.clearThreadStopOwed(owed);
          yield* Effect.logInfo("link requests saw an unlinked link's thread stop", {
            threadId: owed.threadId,
          });
          return;
        }
        yield* stopIfWorking(owed.linkDeviceId, thread, attempt);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("link requests could not stop an unlinked link's thread", {
                threadId: owed.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Turns ending, sessions changing
  // ---------------------------------------------------------------------------

  const openRowsForThread = (thread: OrchestrationThread) =>
    ledger.listByThread(thread.id).pipe(
      Effect.map((rows) => rows.filter((row) => !isTerminalLinkRequest(row))),
      Effect.orElseSucceed(() => []),
    );

  const onTurnEnd: LinkRequestsShape["onTurnEnd"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* openRowsForThread(input.child);
      if (rows.length === 0) return;
      const delivery = childDeliveryForTurnEnd({
        // The turn its own message started answers it, even if the ledger
        // hasn't heard yet that it started.
        owned: rows.map((row) => {
          const request = deliveryRequest(row);
          return row.messageId !== null &&
            row.messageId === input.pendingMessageId &&
            request.status === "queued"
            ? { ...request, status: "running" as const }
            : request;
        }),
        child: input.child,
        end: input.end,
        pendingMessageId: input.pendingMessageId,
        awaitedBackgroundTaskCount: input.child.session?.awaitedBackgroundTaskCount ?? 0,
      });
      if (delivery === null) return;
      const row = rows.find((entry) => entry.requestId === delivery.requestId);
      if (row === undefined) return;
      if (row.turnId === null && input.pendingMessageId === row.messageId) {
        yield* progress(row, { status: row.status, turnId: input.end.turnId });
      }
      yield* settleDelivery(row, delivery);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("link requests could not record a turn's end", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const settleIfStillQuiet = (threadId: ThreadId, row: LinkRequestRow) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      const current = yield* ledger
        .get(row.linkDeviceId, row.requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (thread === undefined || Option.isNone(current)) return;
      if (recovering.has(requestKey(row.linkDeviceId, row.requestId))) return;
      const request = deliveryRequest(current.value);
      if (current.value.status !== "awaiting_background" || !isQuietCandidate(thread, request)) {
        return;
      }
      const delivery = childDeliveryForQuietCandidate(thread, request);
      if (delivery !== null) yield* settleDelivery(current.value, delivery);
    });

  const settleStopped = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      const status = thread?.session?.status;
      if (thread === undefined || (status !== "stopped" && status !== "error")) return;
      for (const row of yield* openRowsForThread(thread)) {
        if (row.status !== "running" && row.status !== "awaiting_background") continue;
        if (recovering.has(requestKey(row.linkDeviceId, row.requestId))) continue;
        yield* status === "stopped"
          ? settle(
              row,
              "stopped",
              `The user on ${ownLabel} stopped '${thread.title}' before it finished.`,
            )
          : settle(
              row,
              "failed",
              `'${thread.title}' failed on ${ownLabel}: ${thread.session?.lastError ?? "its session ended"}`,
              { error: thread.session?.lastError ?? "Its session ended." },
            );
      }
    });

  const onSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      if (thread === undefined || (thread.remoteOrigin ?? null) === null) return;
      yield* publishThreadStatus(thread.id);
      for (const row of yield* openRowsForThread(thread)) {
        const key = requestKey(row.linkDeviceId, row.requestId);
        if (
          row.status === "awaiting_background" &&
          isQuietCandidate(thread, deliveryRequest(row)) &&
          !quietChecks.has(key)
        ) {
          quietChecks.add(key);
          yield* Effect.sleep(QUIET_GRACE).pipe(
            Effect.andThen(settleIfStillQuiet(thread.id, row)),
            Effect.ensuring(Effect.sync(() => quietChecks.delete(key))),
            Effect.forkDetach,
          );
        }
      }
      const status = thread.session?.status;
      if ((status === "stopped" || status === "error") && !stopChecks.has(thread.id)) {
        stopChecks.add(thread.id);
        yield* Effect.sleep(STOP_GRACE).pipe(
          Effect.andThen(settleStopped(thread.id)),
          Effect.ensuring(Effect.sync(() => stopChecks.delete(thread.id))),
          Effect.forkDetach,
        );
      }
    });

  /** The asking computer's record of a thread its link started: its status word, when it moves. */
  const publishThreadStatus = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* snapshots.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const origin = shell?.remoteOrigin ?? null;
      if (shell === undefined || origin === null) return;
      const word = threadStatusWord(shell);
      if (lastThreadStatus.get(threadId) === word) return;
      lastThreadStatus.set(threadId, word);
      yield* publish(origin.linkDeviceId, {
        type: "thread",
        threadId,
        title: shell.title,
        status: word,
        updatedAt: yield* nowIso,
      });
    });

  const onEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          const origin = event.payload.fromThread;
          if (origin?.kind !== "request" || origin.environmentId === undefined) {
            yield* publishThreadStatus(event.payload.threadId);
            return;
          }
          turnsStartedHere.add(event.payload.messageId);
          const thread = yield* readThread(event.payload.threadId);
          const deviceId = thread?.remoteOrigin?.linkDeviceId;
          if (deviceId === undefined) return;
          const row = yield* ledger
            .get(deviceId, origin.requestId)
            .pipe(Effect.orElseSucceed(Option.none));
          if (Option.isSome(row) && !isTerminalLinkRequest(row.value)) {
            yield* progress(row.value, { status: "running" });
          }
          yield* publishThreadStatus(event.payload.threadId);
          return;
        }
        case "thread.session-set":
          yield* onSession(event.payload.threadId);
          return;
        case "thread.turn-completed":
        case "thread.activity-appended":
        case "thread.done-override-set":
          yield* publishThreadStatus(event.payload.threadId);
          return;
        case "thread.follow-up-unqueued": {
          if (event.payload.reason === "sent") return;
          const thread = yield* readThread(event.payload.threadId);
          const deviceId = thread?.remoteOrigin?.linkDeviceId;
          if (thread === undefined || deviceId === undefined) return;
          const rows = yield* openRowsForThread(thread);
          for (const row of rows) {
            if (row.messageId !== event.payload.messageId) continue;
            yield* settle(
              row,
              "cancelled",
              `Your message to '${thread.title}' on ${ownLabel} was taken back before it ran.`,
            );
          }
          return;
        }
        case "thread.archived":
        case "thread.deleted": {
          const rows = yield* ledger
            .listByThread(event.payload.threadId)
            .pipe(Effect.orElseSucceed(() => []));
          for (const row of rows) {
            if (isTerminalLinkRequest(row)) continue;
            yield* settle(
              row,
              "failed",
              `The user on ${ownLabel} ${event.type === "thread.deleted" ? "deleted" : "archived"} that thread before it finished.`,
            );
          }
          return;
        }
        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("link requests could not handle an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * The turns asked for in a thread, straight from its turn-start events (a
   * pending start included): each message id with the sequence it was last
   * asked for at. One query per thread, served by the events table's
   * (aggregate_kind, stream_id, sequence) index; the event type is filtered
   * within the thread's own events.
   */
  const readTurnStarts = (threadId: ThreadId) =>
    sql<{ readonly messageId: string | null; readonly sequence: number }>`
      SELECT json_extract(payload_json, '$.messageId') AS "messageId", sequence AS "sequence"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'thread.turn-start-requested'
      ORDER BY sequence
    `.pipe(
      Effect.map((rows) => {
        const starts = new Map<string, number>();
        for (const row of rows) {
          if (row.messageId !== null) starts.set(row.messageId, Number(row.sequence));
        }
        return starts;
      }),
      Effect.mapError(() => peerError(`${ownLabel} couldn't read the thread's turns.`)),
    );

  /**
   * One request the previous process left open, read afresh (a retry may
   * come much later), classified by its own message (a start's first
   * message, or a send): asked for as a turn since this process started is
   * live work, which the live path answers; asked for before and never
   * finished was cut off by the restart; never asked for and no longer
   * waiting was taken back. A request this process recorded is live too.
   * Fails when a read or a write fails, so the caller tries again; a request
   * that had already ended is simply done.
   */
  const reconcileAfterRestart = (
    found: LinkRequestRow,
    pass: {
      readonly boundary: number;
      /** A thread's turn starts, shared within the pass; `fresh` reads them again. */
      readonly turnStarts: (
        threadId: ThreadId,
        fresh?: boolean,
      ) => Effect.Effect<Map<string, number>, PeerRpcError>;
    },
  ) =>
    Effect.gen(function* () {
      const latest = yield* readRequest(found.linkDeviceId, found.requestId);
      if (Option.isNone(latest) || isTerminalLinkRequest(latest.value)) return;
      const before = latest.value;
      if (
        before.status === "awaiting_approval" ||
        ownRequests.has(requestKey(before.linkDeviceId, before.requestId))
      ) {
        return;
      }
      if (before.status === "received" && before.kind === "start") {
        const turnReceipt = yield* engine
          .getCommandReceipt(
            childRequestCommandId(linkBootstrapKey(before.linkDeviceId, before.requestId), "turn"),
          )
          .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't read the request's turn.`)));
        if (Option.isNone(turnReceipt) || turnReceipt.value.status !== "accepted") {
          yield* bootstrapRequest(before.linkDeviceId, before.requestId).pipe(Effect.forkDetach);
          return;
        }
        // Its first turn was committed before the restart: past setup.
        yield* progressOrFail(before, { status: "running", from: ["received"] });
      }
      if (before.status === "received" && before.kind === "send") {
        yield* withRequestLock(before.linkDeviceId, before.requestId)(resumeSend(before));
      }
      const reread = yield* readRequest(before.linkDeviceId, before.requestId);
      if (Option.isNone(reread) || isTerminalLinkRequest(reread.value)) return;
      const row = reread.value;
      const thread = row.threadId === null ? undefined : yield* readThreadOrFail(row.threadId);
      if (thread === undefined) {
        yield* settleOrFail(row, "failed", `That thread is gone from ${ownLabel}.`, {
          error: "The thread is gone.",
        });
        return;
      }
      const messageId = row.messageId;
      // Its message still waits in the thread: it runs the normal way.
      if (
        messageId !== null &&
        (thread.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId)
      ) {
        return;
      }
      const request = deliveryRequest(row);
      if (row.status !== "awaiting_background") {
        // Not among the starts read so far: read them again, after the thread
        // was read (a message leaves the queue in the same write that asks
        // for its turn), before concluding it never started.
        let startedAt =
          messageId === null ? undefined : (yield* pass.turnStarts(thread.id)).get(messageId);
        if (messageId !== null && startedAt === undefined) {
          startedAt = (yield* pass.turnStarts(thread.id, true)).get(messageId);
        }
        // Its own turn was asked for by this process: live work.
        if (
          messageId !== null &&
          (turnsStartedHere.has(messageId) ||
            (startedAt !== undefined && startedAt > pass.boundary))
        ) {
          return;
        }
        if (startedAt === undefined && row.status === "queued" && row.turnId === null) {
          // Delivered, then neither waiting nor ever started: it was taken back.
          yield* settleOrFail(
            row,
            "cancelled",
            `Your message to '${thread.title}' never ran on ${ownLabel}.`,
          );
          return;
        }
      }
      const childTurns = yield* turns
        .listByThreadId({ threadId: thread.id })
        .pipe(Effect.mapError(() => peerError(`${ownLabel} couldn't read the thread's turns.`)));
      const finishedTurnId = finishedTurnAfterRestart(childTurns, {
        ...request,
        status: row.status === "awaiting_background" ? "awaiting_background" : "running",
      });
      const delivery = childDeliveryAfterRestart(thread, request, finishedTurnId);
      yield* settleOrFail(
        row,
        toOutcome(delivery.type === "thread.child-request.settle" ? delivery.outcome : "failed"),
        delivery.type === "thread.child-request.settle"
          ? delivery.reply.text.replace(
              "was interrupted by a Threadlines restart",
              `was interrupted by a restart on ${ownLabel}`,
            )
          : "",
        delivery.type === "thread.child-request.settle"
          ? {
              turnId: delivery.reply.turnId,
              ...(delivery.error !== undefined ? { error: delivery.error } : {}),
            }
          : {},
      );
    });

  /**
   * What the previous process left open, as a recovery pass that can run
   * again: a setup not yet past its first turn resumes (one whose turn was
   * already committed is past it); a send recorded but never delivered is
   * delivered; an answer that durably finished is delivered; a turn the
   * restart cut off is reported as interrupted. Nothing is classified while
   * the startup boundary is unknown. Requests it couldn't settle (a read or
   * a write failed) stay for the next pass; true once none is left.
   */
  const makeRecovery = () => {
    let left: ReadonlyArray<LinkRequestRow> | null = null;
    return Effect.gen(function* () {
      if (startupSequence === null) {
        // Read late, the boundary may come after this process's first turns;
        // those are known all the same, from the turn starts it saw.
        if (!liveTurnsTracked) return false;
        const late = yield* readStartupSequence.pipe(Effect.option);
        if (Option.isNone(late)) {
          yield* Effect.logWarning("link requests could not read where this process started");
          return false;
        }
        startupSequence = late.value;
      }
      const boundary = startupSequence;
      if (left === null) {
        const listed = yield* ledger.listOpen.pipe(Effect.option);
        if (Option.isNone(listed)) {
          yield* Effect.logWarning("link requests could not list open requests after a restart");
          return false;
        }
        left = listed.value;
        for (const row of left) recovering.add(requestKey(row.linkDeviceId, row.requestId));
      }
      // Each thread's turn starts are read once per pass.
      const startsByThread = new Map<ThreadId, Map<string, number>>();
      const turnStarts = (threadId: ThreadId, fresh = false) =>
        Effect.gen(function* () {
          const cached = startsByThread.get(threadId);
          if (cached !== undefined && !fresh) return cached;
          const starts = yield* readTurnStarts(threadId);
          startsByThread.set(threadId, starts);
          return starts;
        });
      const unfinished: Array<LinkRequestRow> = [];
      for (const row of left) {
        const settled = yield* reconcileAfterRestart(row, { boundary, turnStarts }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("link requests could not settle a request after a restart", {
              requestId: row.requestId,
              detail: error.detail,
            }).pipe(Effect.as(false)),
          ),
        );
        if (settled) recovering.delete(requestKey(row.linkDeviceId, row.requestId));
        else unfinished.push(row);
      }
      left = unfinished;
      return unfinished.length === 0;
    });
  };

  /**
   * One pass over cancels whose clean-up isn't done (the previous process
   * stopped first, or a read or write failed); true when none is left. Their
   * messages can't run meanwhile: the queued-send gate holds them.
   */
  const finishCleanups = Effect.gen(function* () {
    const owed = yield* ledger.listCleanup.pipe(Effect.option);
    if (Option.isNone(owed)) {
      yield* Effect.logWarning("link requests could not list unfinished cancels");
      return false;
    }
    let done = true;
    for (const row of owed.value) {
      const finished = yield* withRequestLock(
        row.linkDeviceId,
        row.requestId,
      )(cleanUpCancel(row.linkDeviceId, row.requestId)).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("link requests could not finish a cancel's clean-up", {
            requestId: row.requestId,
            detail: error.detail,
          }).pipe(Effect.as(false)),
        ),
      );
      done = done && finished;
    }
    return done;
  });

  /** Backoff for recovery that failed: a second, doubling, then once a minute. */
  const RECOVERY_RETRY = Schedule.min([
    Schedule.exponential(Duration.seconds(1), 2),
    Schedule.spaced(Duration.minutes(1)),
  ]);

  /** Runs a recovery pass now, then again with backoff in the background until it is done. */
  const untilDone = (pass: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      if (yield* pass) return;
      yield* Effect.gen(function* () {
        if (!(yield* pass)) return yield* Effect.fail("unfinished" as const);
      }).pipe(
        Effect.retry(RECOVERY_RETRY),
        Effect.ignore,
        Effect.delay(Duration.seconds(1)),
        Effect.forkScoped,
      );
    });

  /**
   * The verdict on a turn a linked computer's request asked for (by the
   * message id reserved for it): it never runs once the asking computer took
   * the request back (`revokedAt`, set by every cancel whatever the status:
   * a start that reports nothing back is already settled `answered` before
   * its turn runs), once the request ended without running (refused,
   * expired), or once its link is gone or off (an unlink turns it off before
   * anything else, so nothing it started runs after that). A request still
   * open then ends with the link's reason, so the asking computer hears it.
   */
  const messageVerdict: LinkRequestsShape["messageVerdict"] = ({ threadId, messageId }) =>
    Effect.gen(function* () {
      const rows = yield* ledger.listByThread(threadId);
      const row = rows.find((entry) => entry.messageId === messageId);
      if (row === undefined) return "run" as const;
      if (row.revokedAt !== null || TAKEN_BACK_STATUSES.has(row.status)) {
        return "taken-back" as const;
      }
      const authority = yield* linkAuthority(row.linkDeviceId);
      if (authority.ok) return "run" as const;
      // The link couldn't be read: hold the turn and ask again.
      if (authority.outcome === "failed") return "unknown" as const;
      if (!isTerminalLinkRequest(row)) {
        yield* settleOrFail(row, authority.outcome, authority.text);
      }
      return "taken-back" as const;
    }).pipe(Effect.orElseSucceed(() => "unknown" as const));

  const expireWaiting = Effect.gen(function* () {
    const open = yield* ledger.listOpen.pipe(Effect.orElseSucceed(() => []));
    const now = Date.now();
    for (const row of open) {
      if (row.status !== "awaiting_approval") continue;
      if (Date.parse(row.createdAt) + LINK_APPROVAL_TTL_MS > now) continue;
      yield* settle(row, "expired", `Nobody on ${ownLabel} answered within a day.`);
    }
    yield* ledger
      .prune({
        deliveredBefore: DateTime.formatIso(DateTime.makeUnsafe(now - DELIVERED_RETENTION_MS)),
      })
      .pipe(Effect.ignore);
  });

  const startReactor: LinkRequestsShape["startReactor"] = () =>
    Effect.gen(function* () {
      // A cancel's message is taken back first; one that fails is tried
      // again until it lands, and the queued-send gate holds it meanwhile.
      yield* untilDone(finishCleanups);
      const recovery = makeRecovery();
      yield* untilDone(recovery);
      yield* Effect.forkScoped(Stream.runForEach(domainEvents, onEvent));
      liveTurnsTracked = true;
      yield* expireWaiting.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("link requests could not expire requests", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.forkScoped,
      );
      // Unlinks that still owe stops: now, then every minute.
      yield* finishOwedStops.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("link requests could not finish an unlink's stops", {
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.repeat(Schedule.spaced(OWED_STOPS_RETRY_EVERY)),
        Effect.forkScoped,
      );
    });

  return LinkRequests.of({
    start,
    send,
    cancel,
    stopThread,
    readThread: readLinkThread,
    listThreads,
    watch,
    ack,
    respond,
    pending,
    pendingChanges: Stream.fromPubSub(pendingHub),
    dropLink,
    oweDrain,
    drainDone,
    drainsOwed,
    onTurnEnd,
    messageVerdict,
    startReactor,
  });
});

export const LinkRequestsLive = Layer.effect(LinkRequests, make);

/** Runtime ingestion's hook for turns that end in a linked computer's thread. */
export const RemoteRequestTurnEndsLive = Layer.effect(
  RemoteRequestTurnEnds,
  Effect.gen(function* () {
    const service = yield* LinkRequests;
    return RemoteRequestTurnEnds.of({ onTurnEnd: service.onTurnEnd });
  }),
);

/** The provider reactor's check before it sends a linked computer's queued message. */
export const RemoteRequestGateLive = Layer.effect(
  RemoteRequestGate,
  Effect.gen(function* () {
    const service = yield* LinkRequests;
    return RemoteRequestGate.of({ messageVerdict: service.messageVerdict });
  }),
);
