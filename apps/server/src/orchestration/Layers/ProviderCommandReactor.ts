import * as fs from "node:fs";
import * as path from "node:path";

import {
  type ChatAttachment,
  type ChatSkillReference,
  CheckoutMissingError,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type ProviderSessionForkFrom,
  type RuntimeMode,
  type ThreadContextSeed,
  ThreadCheckoutMissingActivityKind,
  type ThreadCheckoutMissingPayload,
  ThreadCheckoutSwitchDeferredActivityKind,
  type ThreadCheckoutSwitchDeferredPayload,
  ThreadForkContextPayload,
  ThreadForkSeedOutcomeActivityKind,
  type ThreadForkSeedOutcomePayload,
  type TurnId,
} from "@threadlines/contracts";
import { withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@threadlines/shared/git";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  PENDING_REQUEST_EXPIRED_REASON,
  PENDING_REQUEST_INTERRUPTED_REASON,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeKeyedSequentialWorker } from "@threadlines/shared/KeyedSequentialWorker";

import {
  checkpointPreTurnRefForThreadTurnCount,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ensureGeneralChatThreadScratchCwd } from "../generalChats.ts";
import { pauseActiveThreadGoalForStop } from "../threadGoalLifecycle.ts";
import { canReplaceThreadTitle } from "../threadTitle.ts";
import {
  increment,
  orchestrationEventsProcessedTotal,
  providerSessionRestartsTotal,
  providerSessionStartDuration,
  withMetrics,
} from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ThreadContextSeedBuilder } from "../../provider/contextSeed/ThreadContextSeedBuilder.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { checkoutPresence } from "../../vcs/CheckoutPresence.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isCheckoutMissingError = Schema.is(CheckoutMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isThreadForkContextPayload = Schema.is(ThreadForkContextPayload);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.meta-updated"
      | "thread.turn-start-requested"
      | "thread.follow-up-submitted"
      | "thread.turn-interrupt-requested"
      | "thread.activity-appended"
      | "thread.realtime-start-requested"
      | "thread.realtime-stop-requested"
      | "thread.context-compact-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.session-set"
      | "thread.goal-set-requested"
      | "thread.goal-clear-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export interface ForkTurnBoundary {
  /** Exact experimental boundary used to exclude a selected user turn. */
  readonly beforeTurnId?: TurnId;
  /** Stable inclusive boundary used directly or as the compatibility fallback. */
  readonly lastTurnId?: TurnId;
}

/** Resolves provider turn boundaries for a message-anchored native fork. */
export function resolveForkTurnBoundary(
  messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly turnId: TurnId | null;
  }>,
  sourceMessageId: MessageId,
): ForkTurnBoundary | undefined {
  const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId);
  if (sourceIndex === -1) {
    return undefined;
  }

  if (messages[sourceIndex]?.role === "user") {
    let beforeTurnId: TurnId | undefined;
    for (let index = sourceIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (index > sourceIndex && message?.role === "user") {
        break;
      }
      if (message?.turnId !== null && message?.turnId !== undefined) {
        beforeTurnId = message.turnId;
        break;
      }
    }

    let lastTurnId: TurnId | undefined;
    for (let index = sourceIndex - 1; index >= 0; index -= 1) {
      const turnId = messages[index]?.turnId;
      if (turnId !== null && turnId !== undefined) {
        lastTurnId = turnId;
        break;
      }
    }
    return beforeTurnId !== undefined || lastTurnId !== undefined
      ? {
          ...(beforeTurnId !== undefined ? { beforeTurnId } : {}),
          ...(lastTurnId !== undefined ? { lastTurnId } : {}),
        }
      : undefined;
  }

  for (let index = sourceIndex; index >= 0; index -= 1) {
    const turnId = messages[index]?.turnId;
    if (turnId !== null && turnId !== undefined) {
      return { lastTurnId: turnId };
    }
  }
  return undefined;
}

function resolveWorkspaceRealPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Providers may report a session cwd through a different alias than the one
 *  we derived (macOS `/tmp` vs `/private/tmp`, worktree symlinks). A spurious
 *  mismatch here silently restarts the provider session on every turn. */
function isSameWorkspaceCwd(left: string | undefined, right: string | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  if (areFilesystemPathsEqual(left, right)) {
    return true;
  }
  return areFilesystemPathsEqual(resolveWorkspaceRealPath(left), resolveWorkspaceRealPath(right));
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const PROVIDER_INTERRUPT_ACK_TIMEOUT = Duration.seconds(10);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending codex approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending codex approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function isNoActiveTurnSteerError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (!error || error.method !== "turn/steer") {
    return false;
  }

  const detail = error.detail.toLowerCase();
  return detail.includes("no active") && detail.includes("turn") && detail.includes("steer");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const seedBuilder = yield* ThreadContextSeedBuilder;
  const checkpointStore = yield* CheckpointStore;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;

  /** Checkout existence check, bound to the layer's filesystem. Never fails. */
  const checkoutPresenceFor = (cwd: string) =>
    checkoutPresence(cwd).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  /**
   * Threads whose queued checkout switch is currently deferred because the
   * session still owns running background tasks. Deferral repeats on every
   * turn until the tasks finish, so the explanatory activity is appended only
   * on the leading edge of a streak.
   */
  const deferredCheckoutSwitchThreads = new Set<ThreadId>();

  /**
   * Checkout path most recently reported missing per thread, so the same dead
   * folder is announced once rather than on every retry. Cleared as soon as the
   * thread starts a session somewhere that exists.
   */
  const reportedMissingCheckouts = new Map<ThreadId, string>();

  const noteCheckoutSwitchDeferred = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly fromCwd: string;
    readonly toCwd: string;
    readonly pendingBackgroundTaskCount: number;
    readonly createdAt: string;
  }) {
    yield* Effect.logInfo("provider command reactor deferred checkout switch", {
      threadId: input.threadId,
      fromCwd: input.fromCwd,
      toCwd: input.toCwd,
      pendingBackgroundTaskCount: input.pendingBackgroundTaskCount,
    });
    if (deferredCheckoutSwitchThreads.has(input.threadId)) {
      return;
    }
    deferredCheckoutSwitchThreads.add(input.threadId);
    const payload: ThreadCheckoutSwitchDeferredPayload = {
      fromCwd: input.fromCwd,
      toCwd: input.toCwd,
      pendingBackgroundTaskCount: input.pendingBackgroundTaskCount,
    };
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("thread-checkout-switch-deferred"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: ThreadCheckoutSwitchDeferredActivityKind,
          summary: "Checkout switch deferred: a background task is still running",
          payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.catch(() => Effect.void));
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.follow-up.failed"
      | "provider.turn.interrupt.failed"
      | "provider.realtime.start.failed"
      | "provider.realtime.stop.failed"
      | "provider.context-compact.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed"
      | "provider.goal.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  /**
   * Records that a thread's checkout is gone, so the thread view can offer the
   * way out (switch to the project root, or recreate the worktree) instead of a
   * Retry that is guaranteed to fail the same way.
   *
   * Idempotent per checkout: the same path is only reported once per streak, so
   * a user retrying, or the watcher and the pre-flight both noticing, does not
   * stack duplicate rows in the conversation. The record clears once the thread
   * is running somewhere that exists again.
   */
  const noteCheckoutMissing = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly payload: ThreadCheckoutMissingPayload;
    readonly createdAt: string;
  }) {
    const alreadyReported = reportedMissingCheckouts.get(input.threadId);
    if (
      alreadyReported !== undefined &&
      areFilesystemPathsEqual(alreadyReported, input.payload.cwd)
    ) {
      return;
    }
    reportedMissingCheckouts.set(input.threadId, input.payload.cwd);
    // The thread view decides to show the recovery actions from this checkout's
    // VCS status, which may still be a healthy snapshot taken before the folder
    // was deleted. Refresh it here so the affordance appears with the failure
    // instead of waiting for the watcher's next pass.
    yield* vcsStatusBroadcaster
      .refreshLocalStatus(input.payload.cwd)
      .pipe(Effect.ignoreCause({ log: true }));
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("thread-checkout-missing"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "warning",
          kind: ThreadCheckoutMissingActivityKind,
          summary: "This thread's folder no longer exists",
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  /** Extracts the missing-checkout failure out of a turn/follow-up cause. */
  const checkoutMissingFromCause = (cause: Cause.Cause<unknown>): CheckoutMissingError | null => {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason) && isCheckoutMissingError(reason.error)) {
        return reason.error;
      }
    }
    return null;
  };

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const setThreadSessionErrorOnRealtimeFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread?.session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...thread.session,
        status: "error",
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const setRealtimeState = (threadId: ThreadId, active: boolean, createdAt: string) =>
    orchestrationEngine.dispatch({
      type: "thread.realtime.state.set",
      commandId: serverCommandId("provider-realtime-state"),
      threadId,
      active,
      createdAt,
    });

  const markProviderTurnAccepted = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!thread || !session) {
      return;
    }

    if (
      session.status === "stopped" ||
      session.status === "error" ||
      session.status === "interrupted"
    ) {
      return;
    }

    if (session.activeTurnId !== null && session.activeTurnId !== input.turnId) {
      return;
    }

    if (thread.latestTurn?.turnId === input.turnId && thread.latestTurn.state !== "running") {
      return;
    }

    const updatedAt = yield* nowIso;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: "running",
        activeTurnId: input.turnId,
        lastError: null,
        updatedAt,
      },
      createdAt: updatedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Pending approval / user-input prompts are answered through the live
   * provider session. Once that runtime is gone — stopped, reaped, or replaced
   * by a restart into a different checkout/instance — the provider-side
   * request can never be answered, so close each open prompt with an expiry
   * activity instead of leaving clients a Submit that is guaranteed to fail.
   */
  const expireOpenPendingRequests = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly payload?: unknown;
      readonly turnId: TurnId | null;
    }>;
    readonly detail: string;
    readonly reason?: string;
  }) {
    const expirations = [
      ...collectOpenPendingRequests(input.activities, APPROVAL_ACTIVITY_KINDS).map((open) => ({
        open,
        kind: APPROVAL_ACTIVITY_KINDS.resolved,
        summary: "Approval request expired",
      })),
      ...collectOpenPendingRequests(input.activities, USER_INPUT_ACTIVITY_KINDS).map((open) => ({
        open,
        kind: USER_INPUT_ACTIVITY_KINDS.resolved,
        summary: "User input request expired",
      })),
    ];
    if (expirations.length === 0) {
      return;
    }

    const createdAt = yield* nowIso;
    for (const { open, kind, summary } of expirations) {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("pending-request-expired"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind,
          summary,
          payload: {
            requestId: open.requestId,
            reason: input.reason ?? PENDING_REQUEST_EXPIRED_REASON,
            detail: input.detail,
          },
          turnId: open.activity.turnId,
          createdAt,
        },
        createdAt,
      });
    }
  });

  const expireOpenPendingRequestsForInterruptedTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly payload?: unknown;
      readonly turnId: TurnId | null;
    }>;
  }) {
    yield* expireOpenPendingRequests({
      threadId: input.threadId,
      activities: input.activities,
      detail: "The provider turn was interrupted before the request was answered.",
      reason: PENDING_REQUEST_INTERRUPTED_REASON,
    });
  });

  const isPendingRequestActivityAppended = (
    event: OrchestrationEvent,
  ): event is Extract<ProviderIntentEvent, { type: "thread.activity-appended" }> => {
    if (event.type !== "thread.activity-appended") {
      return false;
    }
    const kind = event.payload.activity.kind;
    return (
      kind === APPROVAL_ACTIVITY_KINDS.requested || kind === USER_INPUT_ACTIVITY_KINDS.requested
    );
  };

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly excludeContextSeedMessageId?: MessageId;
      /** Same-driver native fork request for a fresh session start. Falls
       *  back to a plain start (context-seed seeding) when the fork fails. */
      readonly forkFrom?: ProviderSessionForkFrom;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId);
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    const hasProviderBinding =
      activeThreadSession !== null || thread.session?.providerName !== null;
    const instanceSwitchRequested =
      hasProviderBinding &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId;
    // Switching to a different *driver* mid-thread is allowed: we hand off by
    // rehydrating the new driver from a provider-agnostic context seed built
    // from the orchestration transcript, instead of the outgoing driver's
    // opaque (and non-portable) resume cursor. A same-driver switch to an
    // instance with an incompatible continuation key stays blocked — there the
    // native resume state matters and cannot be reconciled across instances.
    const isCrossDriverHandoff =
      instanceSwitchRequested && currentInfo.driverKind !== desiredInfo.driverKind;
    if (
      instanceSwitchRequested &&
      currentInfo.driverKind === desiredInfo.driverKind &&
      currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: preferredProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
      });
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd =
      project?.kind === "general-chat"
        ? yield* ensureGeneralChatThreadScratchCwd({
            workspaceRoot: project.workspaceRoot,
            threadId,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: preferredProvider,
                  method: "thread.turn.start",
                  detail: `Failed to prepare the General Chat scratch directory: ${cause.message}`,
                }),
            ),
          )
        : resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          });

    // Every provider start, restart and handoff funnels through here with the
    // checkout already resolved, so this is the one place that has to confirm
    // the directory is still on disk. Spawning into a directory that is gone
    // fails deep inside the provider SDK with an errno that reads as a missing
    // binary, which is how a deleted worktree used to present itself as a
    // broken Claude install. `checkoutPresence` only answers "missing" when it
    // is sure; a stat that fails for any other reason lets the start proceed.
    if (effectiveCwd !== undefined && project?.kind !== "general-chat") {
      const presence = yield* checkoutPresenceFor(effectiveCwd);
      if (presence === "missing") {
        return yield* new CheckoutMissingError({
          threadId,
          cwd: effectiveCwd,
          branch: thread.branch ?? null,
          projectCwd: project?.workspaceRoot ?? null,
        });
      }
      reportedMissingCheckouts.delete(threadId);
    }

    const startProviderSession = (
      input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderDriverKind;
        readonly contextSeed?: ThreadContextSeed;
        readonly forkFrom?: ProviderSessionForkFrom;
      },
      startKind: "fresh" | "restart" | "handoff" = "fresh",
    ) =>
      providerService
        .startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          ...(input?.contextSeed !== undefined ? { contextSeed: input.contextSeed } : {}),
          ...(input?.forkFrom !== undefined ? { forkFrom: input.forkFrom } : {}),
          runtimeMode: desiredRuntimeMode,
        })
        .pipe(
          withMetrics({
            timer: providerSessionStartDuration,
            attributes: { provider: preferredProvider, startKind },
          }),
        );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        // Starting a provider session and ingesting its `thread.started` event
        // happen concurrently. Re-read after startup so this bind cannot replace
        // provider-side identifiers that arrived while `startSession` was in flight.
        const latestThread = yield* resolveThread(threadId);
        if (!latestThread) {
          return yield* Effect.die(
            new Error(`Thread '${threadId}' was not found in read model after session startup.`),
          );
        }
        const latestSession = latestThread.session;
        const mappedStatus = mapProviderSessionStatusToOrchestrationStatus(session.status);
        const shouldPreservePendingTurnStartup =
          latestSession?.status === "starting" && mappedStatus === "ready";
        // Provider-side identifiers can arrive through runtime ingestion or
        // directly on the started session. Prefer the durable projection, but
        // let the runtime heal an older missing value. Projected identifiers
        // only survive while the same provider instance remains selected.
        const continuesSameInstance =
          latestSession?.providerInstanceId === session.providerInstanceId;
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: shouldPreservePendingTurnStartup ? "starting" : mappedStatus,
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            providerSessionId: continuesSameInstance
              ? (latestSession?.providerSessionId ?? null)
              : null,
            providerThreadId: continuesSameInstance
              ? (latestSession?.providerThreadId ?? session.providerThreadId ?? null)
              : (session.providerThreadId ?? null),
            runtimeMode: desiredRuntimeMode,
            // Checkout the runtime actually started in. The next turn compares
            // it against the thread's target checkout to decide whether the
            // session has to be cycled into a different worktree.
            checkoutCwd: session.cwd ?? effectiveCwd ?? null,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: shouldPreservePendingTurnStartup
              ? (latestSession?.updatedAt ?? session.updatedAt)
              : session.updatedAt,
          },
          createdAt,
        });
      });

    // Cross-driver switch: don't reuse the outgoing driver's resume cursor.
    // Build a provider-agnostic seed from the transcript and start the new
    // driver seeded. `ProviderService.startSession` stops the stale outgoing
    // session and won't carry over the old instance's resume cursor, so a
    // single start both rebinds and tears down the old runtime.
    if (isCrossDriverHandoff) {
      const contextSeed = yield* seedBuilder
        .build({
          threadId,
          fromProvider: currentInfo.driverKind,
          toProvider: desiredDriverKind,
          ...(options?.excludeContextSeedMessageId !== undefined
            ? { excludeMessageId: options.excludeContextSeedMessageId }
            : {}),
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        })
        .pipe(Effect.map(Option.getOrUndefined));
      yield* Effect.logInfo("provider command reactor cross-driver handoff", {
        threadId,
        fromDriver: currentInfo.driverKind,
        toDriver: desiredDriverKind,
        fromInstanceId: currentInstanceId,
        toInstanceId: desiredInstanceId,
        hasContextSeed: contextSeed !== undefined,
      });
      const handoffSession = yield* startProviderSession(
        contextSeed !== undefined ? { contextSeed } : undefined,
        "handoff",
      );
      yield* bindSessionToThread(handoffSession);
      return { sessionThreadId: handoffSession.threadId, nativeForkApplied: false };
    }

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = !isSameWorkspaceCwd(effectiveCwd, activeSession?.cwd);
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      // Model and option changes on a live session are applied in-session by
      // the adapters (Claude: setModel/applyFlagSettings on the running query;
      // Codex: per-turn model/effort params). A restart is only needed when
      // the driver reports model switching as unsupported.
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";

      if (!runtimeModeChanged && !cwdChanged && !instanceChanged && !shouldRestartForModelChange) {
        deferredCheckoutSwitchThreads.delete(threadId);
        return { sessionThreadId: existingSessionThreadId, nativeForkApplied: false };
      }

      // A checkout switch is the only restart reason that can wait. Background
      // tasks (subagents, backgrounded commands) run inside the session's
      // runtime, so cycling it to move checkouts would kill them — the adapter
      // refuses that outright, which used to fail the turn. Run the turn where
      // the session already is and keep the switch queued for the first turn
      // after the tasks finish.
      const pendingBackgroundTaskCount = thread.session?.pendingBackgroundTaskCount ?? 0;
      const restartRequiredBeyondCwd =
        runtimeModeChanged || instanceChanged || shouldRestartForModelChange;
      if (cwdChanged && !restartRequiredBeyondCwd && pendingBackgroundTaskCount > 0) {
        const currentCwd = activeSession?.cwd ?? thread.session?.checkoutCwd ?? null;
        if (currentCwd && effectiveCwd) {
          yield* noteCheckoutSwitchDeferred({
            threadId,
            fromCwd: currentCwd,
            toCwd: effectiveCwd,
            pendingBackgroundTaskCount,
            createdAt,
          });
        }
        return { sessionThreadId: existingSessionThreadId, nativeForkApplied: false };
      }
      deferredCheckoutSwitchThreads.delete(threadId);

      const restartReason = runtimeModeChanged
        ? "runtime_mode"
        : cwdChanged
          ? "cwd"
          : instanceChanged
            ? "instance"
            : "model";
      yield* increment(providerSessionRestartsTotal, {
        provider: preferredProvider,
        reason: restartReason,
      });
      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
        "restart",
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      // The outgoing runtime owned any still-open approval / user-input
      // prompts; they die with it, so close them the same way an explicit
      // session stop does.
      yield* expireOpenPendingRequests({
        threadId,
        activities: thread.activities,
        detail: "The provider session restarted before the request was answered.",
      });
      yield* bindSessionToThread(restartedSession);
      return { sessionThreadId: restartedSession.threadId, nativeForkApplied: false };
    }

    // Fresh start. When a native fork is requested, try it first; a fork
    // failure degrades (visibly, never silently) to a plain start so the
    // caller can fall back to context-seed seeding.
    deferredCheckoutSwitchThreads.delete(threadId);
    const forkFrom = options?.forkFrom;
    if (forkFrom !== undefined) {
      const forkedSession = yield* startProviderSession({ forkFrom }).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          Effect.logWarning(
            "provider command reactor native fork start failed; falling back to context seed",
            {
              threadId,
              sourceProviderThreadId: forkFrom.providerThreadId,
              lastTurnId: forkFrom.lastTurnId,
              error: String(error),
            },
          ).pipe(Effect.as(Option.none<ProviderSession>())),
        ),
      );
      if (Option.isSome(forkedSession)) {
        yield* bindSessionToThread(forkedSession.value);
        return { sessionThreadId: forkedSession.value.threadId, nativeForkApplied: true };
      }
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return { sessionThreadId: startedSession.threadId, nativeForkApplied: false };
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly providerMessageId?: MessageId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly skills?: ReadonlyArray<ChatSkillReference>;
    readonly providerContext?: string;
    readonly providerAttachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const forkContextActivity = thread.activities.find(
      (activity) =>
        activity.kind === "thread.fork.context" && isThreadForkContextPayload(activity.payload),
    );
    const isForkInitialTurn =
      forkContextActivity !== undefined &&
      input.messageId !== undefined &&
      thread.messages[0]?.id === input.messageId;
    const forkContext =
      forkContextActivity !== undefined &&
      isForkInitialTurn &&
      isThreadForkContextPayload(forkContextActivity.payload)
        ? forkContextActivity.payload
        : undefined;
    const sourceThread = forkContext ? yield* resolveThread(forkContext.sourceThreadId) : undefined;

    // Same-driver forks on the fork's initial turn can carry full provider
    // history natively instead of the budgeted context-seed preamble. The
    // source's provider thread must live in the very instance the new session
    // starts in (provider forks copy instance-local persisted history).
    let forkFrom: ProviderSessionForkFrom | undefined;
    if (forkContext !== undefined && sourceThread !== undefined) {
      const desiredInstanceId = (input.modelSelection ?? thread.modelSelection).instanceId;
      const sourceSession = sourceThread.session;
      const sourceProviderThreadId = sourceSession?.providerThreadId ?? null;
      if (
        sourceThread.projectId === thread.projectId &&
        sourceProviderThreadId !== null &&
        sourceSession?.providerInstanceId === desiredInstanceId
      ) {
        const capabilities = yield* providerService
          .getCapabilities(desiredInstanceId)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        const boundary = resolveForkTurnBoundary(
          sourceThread.messages,
          forkContext.sourceMessageId,
        );
        if (capabilities?.nativeThreadFork === "supported" && boundary !== undefined) {
          forkFrom = { providerThreadId: sourceProviderThreadId, ...boundary };
        }
      }
    }

    const ensured = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      excludeContextSeedMessageId: input.messageId,
      ...(forkFrom !== undefined ? { forkFrom } : {}),
    });
    const nativeForkApplied = ensured.nativeForkApplied;
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    // A natively forked session already holds the full source history; the
    // context-seed preamble and re-sent source attachments would duplicate it.
    const messageText =
      input.providerContext !== undefined && !nativeForkApplied
        ? withContextSeedPreamble(input.providerContext, input.messageText)
        : input.messageText;
    const normalizedInput = toNonEmptyProviderInput(messageText);
    const normalizedAttachments = [
      ...(nativeForkApplied ? [] : (input.providerAttachments ?? [])),
      ...(input.attachments ?? []),
    ];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const telemetryContext =
      forkContext !== undefined
        ? {
            kind: "thread_fork" as const,
            seedMode: nativeForkApplied ? ("provider-native" as const) : ("context-seed" as const),
            ...(sourceThread?.modelSelection !== undefined
              ? { sourceModelSelection: sourceThread.modelSelection }
              : {}),
            includedMessageCount: forkContext.includedMessageCount,
            includedToolSummaryCount: forkContext.includedToolSummaryCount,
            includedAttachmentCount: forkContext.includedAttachmentCount,
            omittedAttachmentCount: forkContext.omittedAttachmentCount,
          }
        : undefined;

    if (forkContext !== undefined) {
      const seedOutcomePayload: ThreadForkSeedOutcomePayload = {
        seedMode: nativeForkApplied ? "provider-native" : "context-seed",
        ...(forkFrom !== undefined
          ? {
              sourceProviderThreadId: forkFrom.providerThreadId,
              ...(forkFrom.beforeTurnId !== undefined
                ? { beforeTurnId: forkFrom.beforeTurnId }
                : {}),
              ...(forkFrom.lastTurnId !== undefined ? { lastTurnId: forkFrom.lastTurnId } : {}),
            }
          : {}),
      };
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("thread-fork-seed-outcome"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: "info",
            kind: ThreadForkSeedOutcomeActivityKind,
            summary: nativeForkApplied
              ? "Forked with full provider history"
              : "Forked with summarized context",
            payload: seedOutcomePayload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    const modelForTurn =
      input.modelSelection ??
      (activeSession?.model !== undefined
        ? {
            ...requestedModelSelection,
            model: activeSession.model,
          }
        : requestedModelSelection);

    return {
      threadId: input.threadId,
      messageId: input.providerMessageId ?? input.messageId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(input.skills !== undefined && input.skills.length > 0 ? { skills: input.skills } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(telemetryContext !== undefined ? { telemetryContext } : {}),
    };
  });

  const capturePreTurnCheckpointForTurnStart = Effect.fn("capturePreTurnCheckpointForTurnStart")(
    function* (input: { readonly threadId: ThreadId }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread) {
        return;
      }

      const project = yield* resolveProject(thread.projectId);
      if (project?.kind === "general-chat") {
        return;
      }
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      if (!cwd) {
        return;
      }

      const isRepository = yield* checkpointStore.isGitRepository(cwd).pipe(
        Effect.catch((error) =>
          Effect.logWarning("provider command reactor failed to inspect checkpoint workspace", {
            threadId: input.threadId,
            cwd,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!isRepository) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(input.threadId, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (!baselineExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: baselineCheckpointRef,
        });
      }

      const preTurnCountCheckpointRef = checkpointPreTurnRefForThreadTurnCount(
        input.threadId,
        currentTurnCount + 1,
      );
      const preTurnCountCheckpointExists = yield* checkpointStore.hasCheckpointRef({
        cwd,
        checkpointRef: preTurnCountCheckpointRef,
      });
      if (!preTurnCountCheckpointExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: preTurnCountCheckpointRef,
        });
      }
    },
  );

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      // Branch names are source control text, so they follow the dedicated
      // writer model when one is set.
      const modelSelection = resolveSourceControlWriterModelSelection(settings);
      const backupModelSelection = settings.textGenerationBackupModelSelection;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
        backupModelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const {
          textGenerationModelSelection: modelSelection,
          textGenerationBackupModelSelection: backupModelSelection,
        } = yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
          backupModelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      // Title generation forks before the provider session creates the
      // General Chat scratch directory, so ensure it exists here as well.
      const generationCwd =
        (project?.kind === "general-chat"
          ? yield* ensureGeneralChatThreadScratchCwd({
              workspaceRoot: project.workspaceRoot,
              threadId: thread.id,
            }).pipe(Effect.catch(() => Effect.succeed(project.workspaceRoot)))
          : resolveThreadWorkspaceCwd({
              thread,
              projects: project ? [project] : [],
            })) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      // A checkout that is gone is not a provider failure and has no useful
      // Retry: report it as the recoverable condition it is so the thread view
      // can offer switching checkouts or recreating the folder.
      const checkoutMissing = checkoutMissingFromCause(cause);
      if (checkoutMissing) {
        // The session still has to be released from "starting" so the composer
        // is usable again; the recovery activity is what the thread view reads
        // to replace the useless Retry with the two actions that can work.
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail: checkoutMissing.message,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() =>
            noteCheckoutMissing({
              threadId: event.payload.threadId,
              payload: {
                cwd: checkoutMissing.cwd,
                ...(checkoutMissing.branch !== undefined ? { branch: checkoutMissing.branch } : {}),
                ...(checkoutMissing.projectCwd !== undefined
                  ? { projectCwd: checkoutMissing.projectCwd }
                  : {}),
              },
              createdAt: event.payload.createdAt,
            }),
          ),
        );
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      ...(event.payload.providerMessageId !== undefined
        ? { providerMessageId: event.payload.providerMessageId }
        : {}),
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.skills !== undefined ? { skills: event.payload.skills } : {}),
      ...(event.payload.providerContext !== undefined
        ? { providerContext: event.payload.providerContext }
        : {}),
      ...(event.payload.providerAttachments !== undefined
        ? { providerAttachments: event.payload.providerAttachments }
        : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* capturePreTurnCheckpointForTurnStart({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to capture pre-turn checkpoint", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    yield* providerService.sendTurn(sendTurnRequest.value).pipe(
      Effect.flatMap((turn) =>
        markProviderTurnAccepted({
          threadId: event.payload.threadId,
          turnId: turn.turnId,
        }),
      ),
      Effect.catchCause(recoverTurnStartFailure),
      Effect.forkScoped,
    );
  });

  const processFollowUpSubmitted = Effect.fn("processFollowUpSubmitted")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.follow-up-submitted" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const session = thread.session;
    const activeTurnId = session?.activeTurnId ?? null;
    if (session?.status !== "running" || activeTurnId !== event.payload.turnId) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.follow-up.failed",
        summary: "Follow-up send failed",
        detail:
          activeTurnId === null
            ? "No active provider turn is available to steer."
            : `Expected active turn '${event.payload.turnId}' but thread is running '${activeTurnId}'.`,
        turnId: event.payload.turnId,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    }
    const normalizedInput = toNonEmptyProviderInput(event.payload.text);
    const attachments = event.payload.attachments ?? [];
    if (!normalizedInput && attachments.length === 0) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.follow-up.failed",
        summary: "Follow-up send failed",
        detail: "Either input text or at least one attachment is required.",
        turnId: event.payload.turnId,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    }

    const recoverFollowUpFailure = Effect.fnUntraced(function* (
      cause: Cause.Cause<ProviderServiceError>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return;
      }
      const detail = formatFailureDetail(cause);
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.follow-up.failed",
        summary: "Follow-up send failed",
        detail,
        turnId: event.payload.turnId,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });

      if (!isNoActiveTurnSteerError(cause)) {
        return;
      }

      // A provider's explicit "no active turn" rejection is authoritative.
      // Re-read before updating so a concurrent lifecycle event or new turn is
      // never overwritten by recovery from an older steer request.
      const latestThread = yield* resolveThread(event.payload.threadId);
      const latestSession = latestThread?.session;
      if (
        latestSession?.status !== "running" ||
        latestSession.activeTurnId !== event.payload.turnId
      ) {
        return;
      }

      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...latestSession,
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    });

    const delivered = yield* providerService
      .steerTurn({
        threadId: event.payload.threadId,
        expectedTurnId: event.payload.turnId,
        messageId: event.payload.messageId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(event.payload.skills !== undefined ? { skills: event.payload.skills } : {}),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          recoverFollowUpFailure(cause).pipe(
            Effect.catchCause((recoveryCause) =>
              Effect.logWarning("provider command reactor failed to recover follow-up failure", {
                eventType: event.type,
                threadId: event.payload.threadId,
                cause: Cause.pretty(recoveryCause),
                originalCause: Cause.pretty(cause),
              }),
            ),
            Effect.as(false),
          ),
        ),
      );
    if (!delivered) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.follow-up.accept",
      commandId: serverCommandId("follow-up-accepted"),
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      message: {
        messageId: event.payload.messageId,
        role: "user",
        text: event.payload.text,
        attachments,
        ...(event.payload.skills !== undefined ? { skills: event.payload.skills } : {}),
      },
      createdAt: event.payload.createdAt,
    });
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const session = thread.session;
    if (session.status === "interrupted" && session.activeTurnId === null) {
      yield* expireOpenPendingRequestsForInterruptedTurn({
        threadId: event.payload.threadId,
        activities: thread.activities,
      });
      return;
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    const interruptOutcome = yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(
        Effect.as({ _tag: "success" as const }),
        Effect.catchCause((cause) => Effect.succeed({ _tag: "failure" as const, cause })),
        Effect.timeoutOption(PROVIDER_INTERRUPT_ACK_TIMEOUT),
      );

    if (Option.isNone(interruptOutcome)) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: `Timed out waiting ${Duration.toMillis(PROVIDER_INTERRUPT_ACK_TIMEOUT) / 1000} seconds for the provider to acknowledge the interrupt.`,
        turnId: event.payload.turnId ?? session.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }
    if (interruptOutcome.value._tag === "failure") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: Cause.pretty(interruptOutcome.value.cause),
        turnId: event.payload.turnId ?? session.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // The provider has acknowledged cancellation. Settle the session and
    // provider-owned prompts now; a later completion notification may advance
    // the session from interrupted to ready.
    if (session.status === "running" || session.activeTurnId !== null) {
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...session,
          status: "interrupted",
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    }
    yield* expireOpenPendingRequestsForInterruptedTurn({
      threadId: event.payload.threadId,
      activities: thread.activities,
    });
  });

  const recoverRealtimeFailure = (input: {
    readonly event: Extract<
      ProviderIntentEvent,
      { type: "thread.realtime-start-requested" | "thread.realtime-stop-requested" }
    >;
    readonly operation: "start" | "stop";
    readonly cause: Cause.Cause<unknown>;
  }) => {
    if (Cause.hasInterruptsOnly(input.cause)) {
      return Effect.void;
    }
    const detail = formatFailureDetail(input.cause);
    return setRealtimeState(
      input.event.payload.threadId,
      false,
      input.event.payload.createdAt,
    ).pipe(
      Effect.andThen(
        setThreadSessionErrorOnRealtimeFailure({
          threadId: input.event.payload.threadId,
          detail,
          createdAt: input.event.payload.createdAt,
        }),
      ),
      Effect.andThen(
        appendProviderFailureActivity({
          threadId: input.event.payload.threadId,
          kind:
            input.operation === "start"
              ? "provider.realtime.start.failed"
              : "provider.realtime.stop.failed",
          summary:
            input.operation === "start"
              ? "Provider realtime start failed"
              : "Provider realtime stop failed",
          detail,
          turnId: null,
          createdAt: input.event.payload.createdAt,
        }),
      ),
      Effect.asVoid,
    );
  };

  const processRealtimeStartRequested = Effect.fn("processRealtimeStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.realtime-start-requested" }>,
  ) {
    yield* providerService.realtimeStart!({
      threadId: event.payload.threadId,
      ...(event.payload.outputModality !== undefined
        ? { outputModality: event.payload.outputModality }
        : {}),
    }).pipe(
      Effect.catchCause((cause) => recoverRealtimeFailure({ event, operation: "start", cause })),
    );
  });

  const processRealtimeStopRequested = Effect.fn("processRealtimeStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.realtime-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped" || thread.voiceActive !== true) {
      return;
    }
    yield* providerService.realtimeStop!({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) => recoverRealtimeFailure({ event, operation: "stop", cause })),
    );
  });

  const processGoalSetRequested = Effect.fn("processGoalSetRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-set-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    // Goals live provider-side, so the thread needs a live session before the
    // goal RPC. Cold threads get their session started (or resumed) here.
    yield* ensureSessionForThread(event.payload.threadId, event.payload.createdAt)
      .pipe(
        Effect.flatMap(() =>
          providerService.setThreadGoal({
            threadId: event.payload.threadId,
            ...(event.payload.objective !== undefined
              ? { objective: event.payload.objective }
              : {}),
            ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
            ...(event.payload.tokenBudget !== undefined
              ? { tokenBudget: event.payload.tokenBudget }
              : {}),
          }),
        ),
        Effect.asVoid,
      )
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.goal.failed",
            summary: "Goal update failed",
            detail: formatFailureDetail(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const processGoalClearRequested = Effect.fn("processGoalClearRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-clear-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(event.payload.threadId, event.payload.createdAt)
      .pipe(
        Effect.flatMap(() => providerService.clearThreadGoal({ threadId: event.payload.threadId })),
      )
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.goal.failed",
            summary: "Goal clear failed",
            detail: formatFailureDetail(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const processContextCompactRequested = Effect.fn("processContextCompactRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.context-compact-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;

    if ((session?.activeTurnId ?? null) !== null || thread.latestTurn?.state === "running") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.context-compact.failed",
        summary: "Context compaction failed",
        detail: "Context cannot be compacted while a provider turn is running.",
        turnId: session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService.compactContext({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.context-compact.failed",
          summary: "Context compaction failed",
          detail: formatFailureDetail(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* pauseActiveThreadGoalForStop({
        threadId: thread.id,
        projectionSnapshotQuery,
        providerService,
        orchestrationEngine,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.goal.pause-before-session-stop-failed", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      if (thread.voiceActive === true) {
        yield* providerService.realtimeStop!({ threadId: thread.id }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider realtime teardown failed during session stop", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        providerSessionId: thread.session?.providerSessionId ?? null,
        // Keep the provider-side thread identity on stopped sessions: native
        // forks and resumes of this thread still need it after the runtime
        // is gone.
        providerThreadId: thread.session?.providerThreadId ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        checkoutCwd: thread.session?.checkoutCwd ?? null,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  /**
   * Session statuses in which a queued checkout switch can apply right away:
   * the runtime is alive but owns no in-flight turn whose files a restart
   * would swap out from under it.
   */
  const idleSessionStatuses: ReadonlySet<OrchestrationSession["status"]> = new Set([
    "idle",
    "ready",
    "interrupted",
  ]);

  /**
   * A queued checkout switch normally applies when the next turn is
   * dispatched. When the session is already idle with no background tasks
   * left, waiting for the user's next message just leaves every surface
   * pointed at the old checkout, so cycle the session now instead. Only a
   * live, projected-and-bound session is moved — a thread without a running
   * runtime keeps lazy semantics (its next turn starts in the right place).
   */
  const maybeApplyQueuedCheckoutSwitch = Effect.fnUntraced(function* (
    threadId: ThreadId,
    occurredAt: string,
  ) {
    const thread = yield* resolveThread(threadId);
    const session = thread?.session;
    if (!thread || !session || !idleSessionStatuses.has(session.status)) {
      return;
    }
    if (session.activeTurnId !== null || (session.pendingBackgroundTaskCount ?? 0) > 0) {
      return;
    }
    // The projected checkoutCwd is rewritten on every (re)bind; null means we
    // never learned where the runtime runs, so leave the switch to the next
    // turn dispatch rather than guessing.
    const sessionCheckoutCwd = session.checkoutCwd ?? undefined;
    if (sessionCheckoutCwd === undefined) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project || project.kind === "general-chat") {
      return;
    }
    const targetCwd = resolveThreadWorkspaceCwd({ thread, projects: [project] });
    if (!targetCwd || isSameWorkspaceCwd(targetCwd, sessionCheckoutCwd)) {
      return;
    }
    const activeSession = (yield* providerService.listSessions()).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!activeSession || isSameWorkspaceCwd(targetCwd, activeSession.cwd)) {
      return;
    }
    yield* Effect.logInfo("provider command reactor applying queued checkout switch on idle", {
      threadId,
      fromCwd: sessionCheckoutCwd,
      toCwd: targetCwd,
    });
    const cachedModelSelection = threadModelSelections.get(threadId);
    yield* ensureSessionForThread(
      threadId,
      occurredAt,
      cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("provider command reactor failed to apply queued checkout switch", {
          threadId,
          toCwd: targetCwd,
          detail: String(error),
        }),
      ),
    );
  });

  /**
   * Pending approval / user-input prompts are answered through the live
   * provider session; once that session stops (explicit stop, inactivity
   * reap, startup reconcile after a server restart) the provider-side
   * request is gone and the prompt can never be answered. Close each open
   * prompt with an expiry activity so clients stop offering a Submit that
   * is guaranteed to fail.
   */
  const processSessionSet = Effect.fn("processSessionSet")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-set" }>,
  ) {
    if (event.payload.session.status !== "stopped") {
      // Cheap payload precheck; the apply path re-validates against the
      // freshly projected thread before touching the session.
      const session = event.payload.session;
      if (
        idleSessionStatuses.has(session.status) &&
        session.activeTurnId === null &&
        (session.pendingBackgroundTaskCount ?? 0) === 0
      ) {
        yield* maybeApplyQueuedCheckoutSwitch(event.payload.threadId, event.occurredAt);
      }
      if (event.payload.session.status === "interrupted") {
        const thread = yield* resolveThread(event.payload.threadId);
        if (thread) {
          yield* expireOpenPendingRequestsForInterruptedTurn({
            threadId: event.payload.threadId,
            activities: thread.activities,
          });
        }
      }
      return;
    }
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    // Session shutdown is the single close condition for provider-owned
    // realtime transport. Issue the provider stop before clearing the flag;
    // failures are non-blocking because the session is already stopping.
    if (thread.voiceActive === true) {
      yield* providerService.realtimeStop!({ threadId: thread.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider realtime teardown failed after session stopped", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* setRealtimeState(thread.id, false, event.payload.session.updatedAt);
    }

    yield* expireOpenPendingRequests({
      threadId: event.payload.threadId,
      activities: thread.activities,
      detail: "The provider session stopped before the request was answered.",
    });
  });

  const processPendingRequestActivityAppended = Effect.fn("processPendingRequestActivityAppended")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.activity-appended" }>) {
      if (!isPendingRequestActivityAppended(event)) {
        return;
      }
      const thread = yield* resolveThread(event.payload.threadId);
      const session = thread?.session;
      if (!thread || !session) {
        return;
      }
      const requestTurnWasInterrupted =
        event.payload.activity.turnId !== null &&
        thread.latestTurn?.turnId === event.payload.activity.turnId &&
        thread.latestTurn.state === "interrupted";
      if (session.status === "interrupted" || requestTurnWasInterrupted) {
        yield* expireOpenPendingRequestsForInterruptedTurn({
          threadId: event.payload.threadId,
          activities: thread.activities,
        });
        return;
      }
      if (session.status === "stopped") {
        yield* expireOpenPendingRequests({
          threadId: event.payload.threadId,
          activities: thread.activities,
          detail: "The provider session stopped before the request was answered.",
        });
      }
    },
  );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.meta-updated": {
        // Only a checkout retarget can queue a switch; title/model updates
        // (which fire constantly, e.g. auto-titling) never need this.
        if (event.payload.worktreePath === undefined) {
          return;
        }
        yield* maybeApplyQueuedCheckoutSwitch(event.payload.threadId, event.occurredAt);
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.follow-up-submitted":
        yield* processFollowUpSubmitted(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.realtime-start-requested":
        yield* processRealtimeStartRequested(event);
        return;
      case "thread.realtime-stop-requested":
        yield* processRealtimeStopRequested(event);
        return;
      case "thread.context-compact-requested":
        yield* processContextCompactRequested(event);
        return;
      case "thread.goal-set-requested":
        yield* processGoalSetRequested(event);
        return;
      case "thread.goal-clear-requested":
        yield* processGoalClearRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.activity-appended":
        yield* processPendingRequestActivityAppended(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.session-set":
        yield* processSessionSet(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // Keyed by thread so one thread's slow provider work (session spawn, turn
  // RPC round-trips) cannot delay other threads' commands. Events for the
  // same thread keep strict arrival order.
  const worker = yield* makeKeyedSequentialWorker((_key: string, event: ProviderIntentEvent) =>
    processDomainEventSafely(event),
  );

  /**
   * Fans a confirmed checkout disappearance out to every thread working in it.
   *
   * One deleted folder usually strands several threads, and each needs its own
   * record: the recovery actions (move to the project root, recreate the
   * worktree) are per-thread. Threads already reported for this same path are
   * skipped by `noteCheckoutMissing`, so a repeated signal is harmless.
   */
  const announceMissingCheckoutToThreads = Effect.fnUntraced(function* (observation: {
    readonly cwd: string;
  }) {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider command reactor could not resolve threads for missing checkout",
          {
            cwd: observation.cwd,
            cause: Cause.pretty(cause),
          },
        ).pipe(Effect.as(null)),
      ),
    );
    if (snapshot === null) {
      return;
    }
    const createdAt = yield* nowIso;
    for (const thread of snapshot.threads) {
      const threadCwd = thread.effectiveCwd ?? thread.worktreePath;
      if (threadCwd === null || !areFilesystemPathsEqual(threadCwd, observation.cwd)) {
        continue;
      }
      const projectCwd =
        snapshot.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? null;
      yield* noteCheckoutMissing({
        threadId: thread.id,
        payload: {
          cwd: threadCwd,
          branch: thread.branch,
          projectCwd,
        },
        createdAt,
      });
    }
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.meta-updated" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.follow-up-submitted" ||
        event.type === "thread.turn-interrupt-requested" ||
        isPendingRequestActivityAppended(event) ||
        event.type === "thread.realtime-start-requested" ||
        event.type === "thread.realtime-stop-requested" ||
        event.type === "thread.context-compact-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.session-set" ||
        event.type === "thread.goal-set-requested" ||
        event.type === "thread.goal-clear-requested"
      ) {
        return yield* worker.enqueue(String(event.aggregateId), event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );

    // A checkout deleted between turns is reported the moment the watcher
    // confirms it, so the thread shows its way out immediately instead of
    // waiting for the user to send a message that is guaranteed to fail.
    yield* Effect.forkScoped(
      Stream.runForEach(
        vcsStatusBroadcaster.observeMissingCheckouts(),
        announceMissingCheckoutToThreads,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
