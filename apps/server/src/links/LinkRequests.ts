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

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { readThreadPage, summarizeThread, threadStatusWord } from "../mcp/threadToolHandlers.ts";
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
  RemoteRequestTurnEnds,
  type RemoteRequestTurnEndsShape,
} from "../orchestration/Services/RemoteRequestTurnEnds.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
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
  readonly access: ComputerLinkAccess;
  readonly maxRuntimeMode: RuntimeMode;
}

/** How long a start waits for this computer's user before it expires. */
export const LINK_APPROVAL_TTL_MS = 24 * 60 * 60_000;
/** A finishing answer stands once the thread stays this quiet (as for local children). */
const QUIET_GRACE = Duration.seconds(15);
const STOP_GRACE = Duration.seconds(5);
const GIT_TIMEOUT_MS = 60_000;
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface LinkRequestsShape {
  readonly start: (link: PeerLink, input: PeerStartInput) => Effect.Effect<PeerStartResult>;
  readonly send: (link: PeerLink, input: PeerSendInput) => Effect.Effect<PeerSendResult>;
  readonly cancel: (link: PeerLink, requestId: ChildRequestId) => Effect.Effect<PeerCancelResult>;
  readonly stopThread: (link: PeerLink, threadId: ThreadId) => Effect.Effect<PeerThreadStopResult>;
  readonly readThread: (
    link: PeerLink,
    input: PeerThreadReadInput,
  ) => Effect.Effect<AgentThreadReadResult>;
  readonly listThreads: (link: PeerLink) => Effect.Effect<PeerThreadListResult>;
  /** Open requests' status and unacked reports, `synced`, then live changes. */
  readonly watch: (link: PeerLink) => Stream.Stream<PeerWatchEvent>;
  readonly ack: (link: PeerLink, reportId: string) => Effect.Effect<void>;
  /** This computer's user allows or denies a start that waits for them. */
  readonly respond: (input: LinksRespondRequestInput) => Effect.Effect<void, ComputerLinkError>;
  readonly pending: Effect.Effect<ReadonlyArray<ComputerLinkPendingRequest>>;
  /** Fires when the waiting starts change. */
  readonly pendingChanges: Stream.Stream<void>;
  /** An inbound link was removed: what it still had open is cancelled. */
  readonly dropLink: (deviceId: string) => Effect.Effect<void>;
  readonly onTurnEnd: RemoteRequestTurnEndsShape["onTurnEnd"];
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
  const ledger = yield* LinkRequestRepository;
  const devices = yield* RelayDeviceRepository;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const identities = yield* RepositoryIdentityResolver;
  const git = yield* GitVcsDriver;
  const environment = yield* ServerEnvironment;
  const ownLabel = (yield* environment.getDescriptor).label;

  const watchHub = yield* PubSub.unbounded<{
    readonly deviceId: string;
    readonly event: PeerWatchEvent;
  }>();
  const pendingHub = yield* PubSub.sliding<void>(1);
  /** Per request: one piece of work at a time (rev 3: cancels re-checked before each stage). */
  const inFlight = new Set<string>();
  const quietChecks = new Set<string>();
  const stopChecks = new Set<string>();
  /** The status word last sent per thread, so watches only hear changes. */
  const lastThreadStatus = new Map<string, string>();

  const requestKey = (deviceId: string, requestId: string) => `${deviceId}\u0000${requestId}`;

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatch = (command: OrchestrationCommand, what: string) =>
    engine.dispatch(command).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logInfo(`link requests could not ${what}`, { detail: String(error) }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const publish = (deviceId: string, event: PeerWatchEvent) =>
    PubSub.publish(watchHub, { deviceId, event }).pipe(Effect.asVoid);

  const reportEvent = (row: LinkRequestRow): PeerWatchEvent | null =>
    row.reportId !== null && row.reportOutcome !== null && row.settledAt !== null
      ? {
          type: "report",
          reportId: row.reportId,
          requestId: row.requestId,
          threadId: row.threadId,
          outcome: row.reportOutcome,
          text: row.reportText ?? "",
          turnId: row.reportTurnId,
          ...(row.reportError !== null && row.reportError.trim().length > 0
            ? { error: row.reportError }
            : {}),
          settledAt: row.settledAt,
        }
      : null;

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
      const report = reportEvent(row.value);
      yield* publish(deviceId, report ?? statusEvent(row.value));
      if (row.value.status === "awaiting_approval" || isTerminalLinkRequest(row.value)) {
        yield* PubSub.publish(pendingHub, undefined);
      }
    });

  /** Moves an open request on and tells its computer. */
  const progress = (
    row: LinkRequestRow,
    patch: {
      readonly status: PeerRequestStatus;
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
        .pipe(Effect.orElseSucceed(() => false));
      if (moved) yield* publishRow(row.linkDeviceId, row.requestId);
      return moved;
    });

  /** Ends a request with its report, in one write, and tells its computer. */
  const settle = (
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
        .pipe(Effect.orElseSucceed(() => false));
      if (settled) yield* publishRow(row.linkDeviceId, row.requestId);
      return settled;
    });

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
   * an earlier run left done. The tombstone is checked before every stage,
   * so a cancel that lands meanwhile stops it before anything more runs.
   */
  const bootstrapRequest = (deviceId: string, requestId: ChildRequestId) =>
    Effect.gen(function* () {
      const key = requestKey(deviceId, requestId);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      yield* Effect.gen(function* () {
        const found = yield* ledger
          .get(deviceId, requestId)
          .pipe(Effect.orElseSucceed(Option.none));
        if (Option.isNone(found)) return;
        const row = found.value;
        const input = startPayload(row);
        if (row.status !== "received" || input === null || row.threadId === null) return;
        const fail = (detail: string) =>
          settle(row, "failed", `'${input.title}' couldn't be started on ${ownLabel}: ${detail}`, {
            error: detail,
          });
        const project = yield* projectForKey(input.projectKey);
        if (project === undefined) {
          return yield* fail(`${ownLabel} doesn't have this project.`);
        }
        const agent = yield* resolveAgent(input);
        if ("refused" in agent) {
          return yield* fail(agent.refused);
        }
        const link = yield* devices.getDevice(deviceId).pipe(Effect.orElseSucceed(Option.none));
        const maxRuntimeMode =
          (Option.isSome(link) ? link.value.linkMaxRuntimeMode : null) ??
          DEFAULT_LINK_MAX_RUNTIME_MODE;
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
          { runtimeMode: maxRuntimeMode, interactionMode: input.interactionMode },
        );
        const remoteOrigin: ThreadRemoteOrigin = {
          linkDeviceId: deviceId,
          environmentId: input.parent.environmentId,
          environmentLabel: input.parent.environmentLabel,
          threadId: input.parent.threadId,
          threadTitle: input.parent.threadTitle,
        };
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
            checkpoint: () =>
              ledger.get(deviceId, requestId).pipe(
                Effect.map(
                  (current) => Option.isSome(current) && current.value.status === "received",
                ),
                Effect.orElseSucceed(() => false),
              ),
          }),
        );
        if (exit._tag === "Failure") {
          const failure = Cause.findErrorOption(exit.cause);
          const current = yield* ledger
            .get(deviceId, requestId)
            .pipe(Effect.orElseSucceed(Option.none));
          // A cancel that stopped it already ended it.
          if (Option.isSome(current) && isTerminalLinkRequest(current.value)) return;
          return yield* fail(Option.isSome(failure) ? failure.value.detail : "its setup failed.");
        }
        if (!input.reportBack) {
          yield* settle(row, "answered", "");
          return;
        }
        // Its turn may have started already (then it is running): never back.
        const after = yield* ledger
          .get(deviceId, requestId)
          .pipe(Effect.orElseSucceed(Option.none));
        if (Option.isSome(after) && after.value.status === "received") {
          yield* progress(after.value, { status: "queued" });
        }
      }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(key))));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("link requests could not set a thread up", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: LinkRequestsShape["start"] = (link, input) =>
    Effect.gen(function* () {
      const existing = yield* ledger
        .get(link.deviceId, input.requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(existing)) {
        return startAnswer(existing.value);
      }
      const now = yield* nowIso;
      const threadId = linkThreadId(link.deviceId, input.requestId);
      const messageId = linkMessageId(link.deviceId, input.requestId);
      const inserted = yield* ledger
        .insert({
          linkDeviceId: link.deviceId,
          requestId: input.requestId,
          status: link.access === "ask" ? "awaiting_approval" : "received",
          payload: { kind: "start", input },
          threadId,
          messageId,
          now,
        })
        .pipe(Effect.option);
      if (Option.isNone(inserted)) {
        return { status: "refused", reason: `${ownLabel} couldn't record the request.` } as const;
      }
      const row = inserted.value;
      // Another call won the insert (a retry racing itself): its answer stands.
      if (row.createdAt !== now || startPayload(row) === null) {
        return startAnswer(row);
      }
      if (link.access === "off") {
        const reason = `${ownLabel} doesn't take work from ${link.label}.`;
        yield* settle(row, "denied", reason);
        return { status: "refused", reason } as const;
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

  /** A thread this link started, or undefined. */
  const linkThread = (link: PeerLink, threadId: ThreadId) =>
    readThread(threadId).pipe(
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

  const send: LinkRequestsShape["send"] = (link, input) =>
    Effect.gen(function* () {
      const existing = yield* ledger
        .get(link.deviceId, input.requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(existing)) {
        return sendAnswer(existing.value);
      }
      const thread = yield* linkThread(link, input.threadId);
      if (thread === undefined) {
        return { status: "refused", reason: "That thread wasn't started by this link." } as const;
      }
      const now = yield* nowIso;
      const messageId = linkMessageId(link.deviceId, input.requestId);
      const inserted = yield* ledger
        .insert({
          linkDeviceId: link.deviceId,
          requestId: input.requestId,
          status: "queued",
          payload: { kind: "send", input },
          threadId: thread.id,
          messageId,
          now,
        })
        .pipe(Effect.option);
      if (Option.isNone(inserted)) {
        return { status: "refused", reason: `${ownLabel} couldn't record the message.` } as const;
      }
      const row = inserted.value;
      if (row.createdAt !== now || row.payload?.kind !== "send") {
        return sendAnswer(row);
      }
      if (link.access === "off") {
        const reason = `${ownLabel} doesn't take work from ${link.label}.`;
        yield* settle(row, "denied", reason);
        return { status: "refused", reason } as const;
      }
      const origin = thread.remoteOrigin!;
      const sent = yield* dispatch(
        {
          type: "thread.remote-request.queue",
          commandId: linkCommandId(link.deviceId, input.requestId, "queue"),
          threadId: thread.id,
          messageId,
          text: input.text,
          fromThread: {
            threadId: origin.threadId,
            requestId: input.requestId,
            kind: "request",
            environmentId: origin.environmentId,
          },
          createdAt: now,
        },
        "queue a linked computer's message",
      );
      if (!sent) {
        const reason = "The thread couldn't take the message.";
        yield* settle(row, "failed", reason, { error: reason });
        return { status: "refused", reason } as const;
      }
      yield* publishRow(link.deviceId, input.requestId);
      return { status: "queued" } as const;
    });

  const cancelRequest = (deviceId: string, requestId: ChildRequestId, text: string) =>
    Effect.gen(function* () {
      const before = yield* ledger.get(deviceId, requestId).pipe(Effect.orElseSucceed(Option.none));
      const result = yield* ledger
        .cancel({ linkDeviceId: deviceId, requestId, text, now: yield* nowIso })
        .pipe(Effect.option);
      if (Option.isNone(result)) return false;
      const { row, cancelled } = result.value;
      if (!cancelled && Option.isSome(before)) return false;
      yield* publishRow(deviceId, requestId);
      // Its message, if it still waits in the thread, never runs now.
      if (
        Option.isSome(before) &&
        before.value.threadId !== null &&
        before.value.messageId !== null &&
        (before.value.status === "queued" || before.value.status === "received")
      ) {
        const thread = yield* readThread(before.value.threadId);
        const messageId = before.value.messageId;
        if ((thread?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId)) {
          yield* dispatch(
            {
              type: "thread.follow-up.unqueue",
              commandId: linkCommandId(deviceId, requestId, "cancel-unqueue"),
              threadId: before.value.threadId,
              messageId,
              createdAt: yield* nowIso,
            },
            "take back a cancelled message",
          );
        }
      }
      return row.status === "cancelled";
    });

  const cancel: LinkRequestsShape["cancel"] = (link, requestId) =>
    Effect.gen(function* () {
      const before = yield* ledger
        .get(link.deviceId, requestId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(before) && isTerminalLinkRequest(before.value)) {
        return {
          status: before.value.status === "cancelled" ? "cancelled" : "already_settled",
        } as const;
      }
      yield* cancelRequest(
        link.deviceId,
        requestId,
        "The thread that asked took the request back.",
      );
      return { status: "cancelled" } as const;
    });

  const stopThread: LinkRequestsShape["stopThread"] = (link, threadId) =>
    Effect.gen(function* () {
      const thread = yield* linkThread(link, threadId);
      if (thread === undefined) {
        return { status: "not_yours" } as const;
      }
      const session = thread.session;
      const working =
        thread.latestTurn?.state === "running" ||
        (session !== null &&
          (session.activeTurnId !== null ||
            session.status === "running" ||
            session.status === "starting" ||
            (session.pendingBackgroundTaskCount ?? 0) > 0)) ||
        (thread.queuedFollowUps ?? []).length > 0;
      if (!working) {
        return { status: "not_running" } as const;
      }
      const now = yield* nowIso;
      yield* dispatch(
        {
          type: "thread.session.stop",
          commandId: CommandId.make(
            `server:link-stop:${link.deviceId}:${threadId}:${thread.latestTurn?.turnId ?? "none"}`,
          ),
          threadId,
          createdAt: now,
        },
        "stop a linked computer's thread",
      );
      return { status: "stopped" } as const;
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
        const replay: Array<PeerWatchEvent> = rows.map(
          (row) => reportEvent(row) ?? statusEvent(row),
        );
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
        .pipe(Effect.ignore);
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

  const dropLink: LinkRequestsShape["dropLink"] = (deviceId) =>
    Effect.gen(function* () {
      const open = yield* ledger.listOpen.pipe(Effect.orElseSucceed(() => []));
      for (const row of open) {
        if (row.linkDeviceId !== deviceId) continue;
        yield* cancelRequest(deviceId, row.requestId, `${ownLabel} removed the link.`);
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
   * What the previous process left: a setup not yet past its first turn
   * resumes; an answer that durably finished is delivered; a turn the
   * restart cut off is reported as interrupted; a start nobody answered for
   * a day expires.
   */
  const settleFromPreviousProcess = Effect.gen(function* () {
    const open = yield* ledger.listOpen.pipe(Effect.orElseSucceed(() => []));
    for (const row of open) {
      if (row.status === "awaiting_approval") continue;
      if (row.status === "received" && row.kind === "start") {
        yield* bootstrapRequest(row.linkDeviceId, row.requestId).pipe(Effect.forkDetach);
        continue;
      }
      const thread = row.threadId === null ? undefined : yield* readThread(row.threadId);
      if (thread === undefined) {
        yield* settle(row, "failed", `That thread is gone from ${ownLabel}.`, {
          error: "The thread is gone.",
        });
        continue;
      }
      // Its message still waits in the thread: it runs the normal way.
      if (
        row.messageId !== null &&
        (thread.queuedFollowUps ?? []).some((queued) => queued.messageId === row.messageId)
      ) {
        continue;
      }
      const request = deliveryRequest(row);
      if (row.status === "queued" && row.turnId === null) {
        // Queued but never started and not waiting: it was taken back.
        const started = (yield* turns
          .listByThreadId({ threadId: thread.id })
          .pipe(Effect.orElseSucceed(() => []))).some(
          (turn) => turn.pendingMessageId === row.messageId,
        );
        if (!started) {
          yield* settle(
            row,
            "cancelled",
            `Your message to '${thread.title}' never ran on ${ownLabel}.`,
          );
          continue;
        }
      }
      const childTurns = yield* turns
        .listByThreadId({ threadId: thread.id })
        .pipe(Effect.orElseSucceed(() => []));
      const finishedTurnId = finishedTurnAfterRestart(childTurns, {
        ...request,
        status: row.status === "awaiting_background" ? "awaiting_background" : "running",
      });
      const delivery = childDeliveryAfterRestart(thread, request, finishedTurnId);
      yield* settle(
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
    }
  });

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
      const events = yield* engine.subscribeDomainEvents;
      yield* settleFromPreviousProcess.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("link requests could not settle the previous process's requests", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* Effect.forkScoped(Stream.runForEach(events, onEvent));
      yield* expireWaiting.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("link requests could not expire requests", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
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
    onTurnEnd,
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
