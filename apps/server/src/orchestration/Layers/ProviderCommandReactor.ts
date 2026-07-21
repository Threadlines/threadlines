import * as fs from "node:fs";
import * as path from "node:path";

import {
  type ChatAttachment,
  type ChatSkillReference,
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
  type RuntimeMode,
  type ThreadContextSeed,
  ThreadForkContextPayload,
  type TurnId,
} from "@threadlines/contracts";
import { withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@threadlines/shared/git";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  PENDING_REQUEST_EXPIRED_REASON,
  USER_INPUT_ACTIVITY_KINDS,
} from "@threadlines/shared/pendingRequests";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isThreadForkContextPayload = Schema.is(ThreadForkContextPayload);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.follow-up-submitted"
      | "thread.turn-interrupt-requested"
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
const DEFAULT_THREAD_TITLE = "New thread";
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

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
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

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.follow-up.failed"
      | "provider.turn.interrupt.failed"
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

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly excludeContextSeedMessageId?: MessageId;
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

    const startProviderSession = (
      input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderDriverKind;
        readonly contextSeed?: ThreadContextSeed;
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
        const mappedStatus = mapProviderSessionStatusToOrchestrationStatus(session.status);
        const shouldPreservePendingTurnStartup =
          thread.session?.status === "starting" && mappedStatus === "ready";
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: shouldPreservePendingTurnStartup ? "starting" : mappedStatus,
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: shouldPreservePendingTurnStartup
              ? (thread.session?.updatedAt ?? session.updatedAt)
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
      return handoffSession.threadId;
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
        return existingSessionThreadId;
      }

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
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
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
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      excludeContextSeedMessageId: input.messageId,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const messageText =
      input.providerContext !== undefined
        ? withContextSeedPreamble(input.providerContext, input.messageText)
        : input.messageText;
    const normalizedInput = toNonEmptyProviderInput(messageText);
    const normalizedAttachments = [
      ...(input.providerAttachments ?? []),
      ...(input.attachments ?? []),
    ];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
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
    const telemetryContext =
      forkContext !== undefined
        ? {
            kind: "thread_fork" as const,
            ...(sourceThread?.modelSelection !== undefined
              ? { sourceModelSelection: sourceThread.modelSelection }
              : {}),
            includedMessageCount: forkContext.includedMessageCount,
            includedToolSummaryCount: forkContext.includedToolSummaryCount,
            includedAttachmentCount: forkContext.includedAttachmentCount,
            omittedAttachmentCount: forkContext.omittedAttachmentCount,
          }
        : undefined;
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
      messageId: input.messageId,
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
      const {
        textGenerationModelSelection: modelSelection,
        textGenerationBackupModelSelection: backupModelSelection,
      } = yield* serverSettingsService.getSettings;

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

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });

    // `turn/interrupt` is an acknowledgement that the provider accepted the
    // cancellation. Settle the orchestration session immediately instead of
    // leaving the Stop button active while waiting for the asynchronous
    // provider completion notification. That notification can still advance
    // the session from interrupted to ready when it arrives.
    const interruptedThread = yield* resolveThread(event.payload.threadId);
    const interruptedSession = interruptedThread?.session;
    if (
      interruptedSession &&
      (interruptedSession.status === "running" || interruptedSession.activeTurnId !== null)
    ) {
      const interruptedAt = yield* nowIso;
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...interruptedSession,
          status: "interrupted",
          activeTurnId: null,
          lastError: null,
          updatedAt: interruptedAt,
        },
        createdAt: interruptedAt,
      });
    }
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
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
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
      return;
    }
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const expirations = [
      ...collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS).map((open) => ({
        open,
        kind: APPROVAL_ACTIVITY_KINDS.resolved,
        summary: "Approval request expired",
      })),
      ...collectOpenPendingRequests(thread.activities, USER_INPUT_ACTIVITY_KINDS).map((open) => ({
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
        threadId: event.payload.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind,
          summary,
          payload: {
            requestId: open.requestId,
            reason: PENDING_REQUEST_EXPIRED_REASON,
            detail: "The provider session stopped before the request was answered.",
          },
          turnId: open.activity.turnId,
          createdAt,
        },
        createdAt,
      });
    }
  });

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
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.follow-up-submitted":
        yield* processFollowUpSubmitted(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
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

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.follow-up-submitted" ||
        event.type === "thread.turn-interrupt-requested" ||
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
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
