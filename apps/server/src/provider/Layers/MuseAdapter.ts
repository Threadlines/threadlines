/**
 * MuseAdapter — `ProviderAdapterShape` for Muse Code over `muse serve` (the
 * Muse Session Protocol, JSON-RPC over stdio).
 *
 * One host process per thread (docs/providers/muse-code-plan.md): Muse takes
 * one client command at a time, and a host holds the lease on every session
 * it loaded until it exits, so threads never share one. A host's flags and
 * permission profile are fixed for its life; a change of access level, plan
 * mode or data sharing between turns closes the host and resumes the
 * conversation on a new one. That only happens when nothing is running —
 * no turn, no queued input, no open approval or question, no background
 * subagent, workflow or command — so a switch never cuts off work.
 *
 * How Muse's model maps onto Threadlines turns:
 *
 * - A turn's id is the `commandId` of its `turn/start` (Muse derives the turn
 *   id from it), so `turn/started` and `turn/completed` name it directly.
 * - A turn Muse starts on its own (a finished workflow reporting back) is a
 *   provider-started turn, like Claude's.
 * - Items replace only at a higher `revision`, and terminals are deduplicated
 *   by turn id, so events replayed to fill a delivery gap are harmless.
 * - Stop stops everything: the turn, queued input, subagents, workflows and
 *   background commands; and work the user stopped never wakes the agent.
 *
 * @module provider/Layers/MuseAdapter
 */
import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type MuseSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSubagentTranscriptEntry,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeMode,
  type ServerProviderModel,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  MANAGED_WORKTREE_INSTRUCTION,
  renderThreadContextSeed,
  withContextSeedPreamble,
} from "@threadlines/shared/contextSeed";
import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path arithmetic on Muse's paths.
import * as NodePath from "node:path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpCommandsEndpointUrl,
  mcpEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import {
  buildCommandRequestInstructions,
  COMMANDS_MCP_SERVER_NAME,
} from "../../mcp/commandTools.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { buildAgentPageInstructions, PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { ROOM_MCP_SERVER_NAME } from "../../mcp/roomToolAccess.ts";
import { ensurePageAssetsDir } from "../../pages/PageStore.ts";
import { isLinkedWorktreeCheckout } from "../../vcs/CheckoutPresence.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  steerRejectedError,
} from "../Errors.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import { FILE_LINK_INSTRUCTIONS } from "../fileLinkInstructions.ts";
import {
  describeMuseExit,
  type MuseHost,
  type MuseHostError,
  type MuseNotification,
  startMuseHost,
} from "../muse/MuseHost.ts";
import {
  describeMuseBillingRefusal,
  museBillingRefusal,
  type MuseHostProfile,
  museHostProfile,
  museHostProfilesDiffer,
  museWorkspaceRoot,
} from "../muse/MuseLaunch.ts";
import {
  type MuseApproval,
  MuseApprovalResolved,
  MuseApprovalUpdate,
  type MuseApprovalChoice,
  MuseAccountState,
  museApprovalDetail,
  museAvailableDecisions,
  museChoicesByDecision,
  MuseCompactResult,
  MuseApproval as MuseApprovalSchema,
  MuseContextUsage,
  type MuseItem,
  MuseItemDelta,
  MuseItemEvent,
  museItemDeclined,
  museItemFailed,
  MuseModelChanged,
  MuseReadOutputResult,
  museRequestType,
  MuseSessionClosed,
  type MuseSessionResult,
  MuseSessionResult as MuseSessionResultSchema,
  MuseSubscriptionUsage,
  MuseTodoList,
  MuseTokenUsageEvent,
  type MuseTurnCompleted,
  MuseTurnCompleted as MuseTurnCompletedSchema,
  MuseTurnForegroundCompleted,
  MuseTurnRetry,
  MuseTurnStarted,
  MuseTurnStartResult,
  MuseTurnUnqueued,
  type MuseUserInput,
  MuseUserInput as MuseUserInputSchema,
  MuseUserInputSettled,
  MuseViewGap,
  MuseViewHealth,
} from "../muse/MuseProtocol.ts";
import {
  identifyMuseTool,
  isMuseNativeRowTool,
  museCommandOutput,
  museToolFailed,
  museToolData,
  museToolDetail,
  museToolTitle,
} from "../muse/MuseToolItems.ts";
import { buildPreviewPanelInstructions } from "../previewPanelInstructions.ts";
import type { MuseAdapterShape } from "../Services/MuseAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const RESUME_SCHEMA_VERSION = 1;
/** How long a stop waits for Muse's `turn/completed` before the host is recycled. */
const STOP_SETTLE_TIMEOUT = Duration.seconds(15);
/** How long a resume keeps trying while the previous host still holds the lease. */
const LEASE_RETRY_WINDOW = Duration.seconds(12);
/** A stored patch larger than this is not read; the edit keeps its own counts. */
const PATCH_READ_LIMIT_BYTES = 4 * 1024 * 1024;
/** Muse refuses an answer's free text over this length. */
const ANSWER_TEXT_MAX = 500;
const AUTH_HINT = "Sign in to Muse Code (Settings → Muse Code → Sign in, or run `muse login`).";
const BACKGROUND_WORK_REFUSAL =
  "Muse Code is still finishing background work from an earlier message. Stop it or wait for it to finish, then send again.";
/** Prepended to a plan-mode turn: the host is read-only, the answer is the plan. */
export const MUSE_PLAN_MODE_INSTRUCTION = `<threadlines_plan_mode>
You are in plan mode. Explore the code and think it through, but do not change any files or run anything that changes state. Then reply with the plan as Markdown: what you will change and in what order, the files involved, risks, and how you will check it works. The user reviews the plan and decides whether to implement it.
</threadlines_plan_mode>`;

export interface MuseAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  /** The binary, looked up each time (a one-click install lands off PATH). */
  readonly binaryPath: () => string;
  /** Every host's environment (see `museHostEnvironment`). */
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  /** The data-sharing choice at launch time; `undefined` when it cannot be read. */
  readonly readContributorMode: Effect.Effect<boolean | undefined>;
  /** Whether the last host reported it can enforce the shell sandbox. */
  readonly sandboxAvailable: () => boolean | undefined;
  /** The provider's current model list, for effort validation. */
  readonly models: () => ReadonlyArray<ServerProviderModel>;
  /** Subscription usage a host reported (`usage/changed`). */
  readonly onSubscriptionUsage: (usage: typeof MuseSubscriptionUsage.Type) => Effect.Effect<void>;
  /** A host saw the account change (`account/changed`). */
  readonly onAccountChanged: Effect.Effect<void>;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  /**
   * Muse's model provider for new sessions: `meta`, the plan's, unless a
   * test runs Muse's offline `echo` provider (with `hostArgs`).
   */
  readonly providerId?: string | undefined;
  /** More `muse serve` flags, for tests (`--provider echo`). */
  readonly hostArgs?: ReadonlyArray<string> | undefined;
  /** Starts a host; tests pass a scripted one. */
  readonly startHost?: typeof startMuseHost | undefined;
}

type Terminal =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "interrupted"; readonly reason: string };

interface HostState {
  readonly generation: number;
  readonly host: MuseHost;
  readonly scope: Scope.Closeable;
  readonly profile: MuseHostProfile;
  readonly contributorMode: boolean | undefined;
  readonly plan: boolean;
  /** Closed on purpose: its exit is not a failure. */
  closing: boolean;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly origin: "user" | "provider";
  readonly plan: boolean;
  readonly done: Deferred.Deferred<void>;
  stopRequested: boolean;
  /**
   * Muse reported the turn's visible work done; background checks still hold
   * it open. A message sent now belongs to the next turn, not this one.
   */
  foregroundDone: boolean;
  /** The latest final-answer text, for a plan turn's proposed plan. */
  finalText: string | undefined;
  /** Patch reads still running; the turn settles after them. */
  readonly pendingReads: Set<Deferred.Deferred<void>>;
}

interface ItemState {
  item: MuseItem;
  readonly turnId: TurnId | undefined;
  /** Text streamed so far (assistant text, reasoning summary, command output). */
  streamed: string;
  readonly summaryStreamed: Map<number, string>;
  started: boolean;
  completed: boolean;
  /** For subagents, workflows and background shells: still counted as background work. */
  background: boolean;
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  approval: MuseApproval;
  readonly turnId: TurnId | undefined;
  /** The decision the user sent, before Muse confirmed it. */
  decided: ProviderApprovalDecision | undefined;
}

interface PendingQuestion {
  readonly requestId: ApprovalRequestId;
  readonly input: MuseUserInput;
  readonly turnId: TurnId | undefined;
}

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly scope: Scope.Closeable;
  readonly runtimeMode: RuntimeMode;
  readonly roomTools: boolean;
  readonly agentPageAssetsDir: string | undefined;
  readonly commandRequests: boolean;
  readonly managedWorktree: boolean;
  readonly mcpToken: string;
  museSessionId: string;
  host: HostState | undefined;
  nextGeneration: number;
  model: string | undefined;
  pendingSeed: string | undefined;
  /** Threadlines' instructions still have to reach this conversation. */
  instructionsPending: boolean;
  activeTurn: ActiveTurn | undefined;
  /** Our `turn/start`s Muse queued instead of starting. */
  readonly queued: Set<string>;
  /**
   * Turns Muse started on its own while one of ours ran (a workflow's
   * report), shown as part of the running turn.
   */
  readonly joined: Map<string, TurnId>;
  readonly items: Map<string, ItemState>;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly approvalIds: Map<string, ApprovalRequestId>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly questionIds: Map<string, ApprovalRequestId>;
  /** Patch bodies read for finished edits, by item id. */
  readonly storedPatches: Map<string, string>;
  /** Subagents, workflows and background commands the user stopped. */
  readonly stoppedWork: Set<string>;
  readonly turns: Array<{ readonly id: TurnId }>;
  /**
   * Turns Muse has reported starting. Each start counts once: one replayed
   * after a delivery gap must not reopen a turn that has ended.
   */
  readonly startedTurnIds: Set<string>;
  readonly lifecycle: Semaphore.Semaphore;
  stopped: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseMuseResumeCursor(raw: unknown): { readonly sessionId: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== RESUME_SCHEMA_VERSION) return undefined;
  return typeof raw.sessionId === "string" && raw.sessionId.length > 0
    ? { sessionId: raw.sessionId }
    : undefined;
}

const decodeWith =
  <S extends Schema.Top>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownOption(schema as never)(value) as Option.Option<S["Type"]>;

const decodeItemEvent = decodeWith(MuseItemEvent);
const decodeDelta = decodeWith(MuseItemDelta);
const decodeApproval = decodeWith(MuseApprovalSchema);
const decodeApprovalUpdate = decodeWith(MuseApprovalUpdate);
const decodeApprovalResolved = decodeWith(MuseApprovalResolved);
const decodeUserInput = decodeWith(MuseUserInputSchema);
const decodeUserInputSettled = decodeWith(MuseUserInputSettled);
const decodeTurnStarted = decodeWith(MuseTurnStarted);
const decodeTurnCompleted = decodeWith(MuseTurnCompletedSchema);
const decodeTurnUnqueued = decodeWith(MuseTurnUnqueued);
const decodeTurnForegroundCompleted = decodeWith(MuseTurnForegroundCompleted);
const decodeTurnRetry = decodeWith(MuseTurnRetry);
const decodeTokenUsage = decodeWith(MuseTokenUsageEvent);
const decodeContextUsage = decodeWith(MuseContextUsage);
const decodeTodoList = decodeWith(MuseTodoList);
const decodeViewGap = decodeWith(MuseViewGap);
const decodeSessionClosed = decodeWith(MuseSessionClosed);
const decodeViewHealth = decodeWith(MuseViewHealth);
const decodeModelChanged = decodeWith(MuseModelChanged);
const decodeSessionResult = decodeWith(MuseSessionResultSchema);
const decodeTurnStartResult = decodeWith(MuseTurnStartResult);
const decodeCompactResult = decodeWith(MuseCompactResult);
const decodeReadOutput = decodeWith(MuseReadOutputResult);
const decodeSubscriptionUsage = decodeWith(MuseSubscriptionUsage);
const decodeAccountState = decodeWith(MuseAccountState);

/** A Muse turn error in the words the chat shows. */
export function museTurnErrorMessage(completed: MuseTurnCompleted): string {
  const error = completed.error;
  if (error?.quota) {
    const resets = new Date(error.quota.resetsAtMs);
    const when = Number.isFinite(resets.getTime()) ? ` It resets at ${resets.toISOString()}.` : "";
    return `Your Muse Code plan's usage limit is reached.${when}`;
  }
  if (error?.kind === "authRequired") {
    return `Muse Code is not signed in. ${AUTH_HINT}`;
  }
  const message = error?.message?.trim() || completed.reason?.trim();
  if (message && /not logged in/iu.test(message)) {
    return `Muse Code is not signed in. ${AUTH_HINT}`;
  }
  return message || "Muse Code reported the turn failed.";
}

/** Plan-step status for a Muse todo. */
function todoStatus(status: string): "pending" | "inProgress" | "completed" {
  return status === "completed" ? "completed" : status === "inProgress" ? "inProgress" : "pending";
}

/** The subagent status Threadlines tracks, from a Muse `subagent` item. */
function subagentStatus(item: MuseItem): "running" | "completed" | "failed" | "interrupted" {
  if (item.status === "inProgress") {
    return item.controlStatus === "resultReady" ? "completed" : "running";
  }
  if (item.status === "cancelled") return "interrupted";
  return museItemFailed(item) ? "failed" : "completed";
}

export function makeMuseAdapter(options: MuseAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const boundInstanceId = options.instanceId;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const stamp = Effect.all({
      eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
      createdAt: nowIso,
    });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const eventBase = (
      ctx: SessionContext,
      turnId: TurnId | undefined,
      providerThreadId?: string,
    ) =>
      Effect.map(stamp, (s) => ({
        ...s,
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        ...(providerThreadId ? { providerRefs: { providerThreadId } } : {}),
      }));

    const logNative = (ctx: SessionContext, method: string, payload: unknown) =>
      options.nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            options.nativeEventLogger!.write(
              { observedAt, event: { provider: PROVIDER, method, payload } },
              ctx.threadId,
            ),
          ).pipe(Effect.ignore)
        : Effect.void;

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const requestError = (method: string) => (error: MuseHostError) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: error.detail,
        ...(error.kind ? { code: error.kind } : {}),
        cause: error,
      });

    const requireHost = (ctx: SessionContext, method: string) =>
      ctx.host && !ctx.host.closing
        ? Effect.succeed(ctx.host)
        : Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Muse Code is not running for this thread.",
            }),
          );

    const sessionCommand = (
      ctx: SessionContext,
      method: string,
      params: Record<string, unknown>,
      commandOptions?: { readonly commandId?: string; readonly maxAttempts?: number },
    ) =>
      Effect.flatMap(requireHost(ctx, method), (state) =>
        state.host
          .command(method, { sessionId: ctx.museSessionId, ...params }, commandOptions)
          .pipe(Effect.mapError(requestError(method))),
      );

    const sessionRequest = (
      ctx: SessionContext,
      method: string,
      params: Record<string, unknown> = {},
    ) =>
      Effect.flatMap(requireHost(ctx, method), (state) =>
        state.host
          .request(method, { sessionId: ctx.museSessionId, ...params })
          .pipe(Effect.mapError(requestError(method))),
      );

    // ── Turns ────────────────────────────────────────────────────────────

    const beginTurn = (
      ctx: SessionContext,
      input: {
        readonly turnId: TurnId;
        readonly origin: ActiveTurn["origin"];
        readonly plan: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const turn: ActiveTurn = {
          turnId: input.turnId,
          origin: input.origin,
          plan: input.plan,
          done: yield* Deferred.make<void>(),
          stopRequested: false,
          foregroundDone: false,
          finalText: undefined,
          pendingReads: new Set(),
        };
        ctx.activeTurn = turn;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turn.turnId,
          updatedAt: yield* nowIso,
        };
        yield* emit({
          type: "turn.started",
          ...(yield* eventBase(ctx, turn.turnId)),
          payload: ctx.model ? { model: ctx.model } : {},
        });
        return turn;
      });

    /**
     * Ends an item a turn left open, so no row spins forever. Subagents and
     * workflows outlive their turn: they become background work instead.
     */
    const closeOpenItems = (ctx: SessionContext, turnId: TurnId, failed: boolean) =>
      Effect.forEach(
        [...ctx.items.values()].filter(
          (state) =>
            state.turnId === turnId &&
            state.started &&
            !state.completed &&
            !state.background &&
            state.item.kind !== "subagent" &&
            state.item.kind !== "workflow",
        ),
        (state) =>
          emitItem(ctx, state, {
            ...state.item,
            status: failed ? "failed" : "completed",
          }),
        { discard: true },
      );

    const dropPendingRequests = (ctx: SessionContext, onlyTurn?: TurnId) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of Array.from(ctx.approvals)) {
          if (onlyTurn !== undefined && pending.turnId !== onlyTurn) continue;
          yield* resolveApproval(ctx, requestId, "cancel");
        }
        for (const [requestId, pending] of Array.from(ctx.questions)) {
          if (onlyTurn !== undefined && pending.turnId !== onlyTurn) continue;
          yield* resolveQuestion(ctx, requestId, {});
        }
      });

    const finishTurn = (ctx: SessionContext, turn: ActiveTurn, terminal: Terminal) =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn) return;
        // Edits read their stored patch before the turn settles.
        yield* Effect.forEach([...turn.pendingReads], (read) => Deferred.await(read), {
          discard: true,
        }).pipe(Effect.timeoutOption(Duration.seconds(10)));
        if (ctx.activeTurn !== turn) return;
        yield* closeOpenItems(ctx, turn.turnId, terminal.kind !== "completed");
        yield* dropPendingRequests(ctx, turn.turnId);
        // Subagents and workflows still running are background work now.
        for (const state of ctx.items.values()) {
          if (
            state.turnId === turn.turnId &&
            !state.completed &&
            !state.background &&
            (state.item.kind === "subagent" || state.item.kind === "workflow")
          ) {
            state.background = true;
            yield* emit({
              type: "task.started",
              ...(yield* eventBase(ctx, turn.turnId)),
              payload: {
                taskId: RuntimeTaskId.make(state.item.itemId),
                taskType: "local_agent",
                toolUseId: state.item.itemId,
                isBackgrounded: true,
                ...(state.item.objective || state.item.entryId
                  ? { description: (state.item.objective ?? state.item.entryId)!.slice(0, 400) }
                  : {}),
              },
            } as ProviderRuntimeEvent);
          }
        }
        ctx.activeTurn = undefined;
        for (const [museTurnId, owner] of ctx.joined) {
          if (owner === turn.turnId) ctx.joined.delete(museTurnId);
        }
        ctx.turns.push({ id: turn.turnId });
        const { activeTurnId: _active, ...session } = ctx.session;
        ctx.session = { ...session, status: "ready", updatedAt: yield* nowIso };
        if (turn.plan && terminal.kind === "completed" && turn.finalText?.trim()) {
          yield* emit({
            type: "turn.proposed.completed",
            ...(yield* eventBase(ctx, turn.turnId)),
            payload: { planMarkdown: turn.finalText.trim() },
          });
        }
        yield* emit({
          type: "turn.completed",
          ...(yield* eventBase(ctx, turn.turnId)),
          payload:
            terminal.kind === "completed"
              ? { state: "completed" }
              : terminal.kind === "failed"
                ? { state: "failed", errorMessage: terminal.message }
                : { state: "interrupted", stopReason: terminal.reason },
        });
        yield* Deferred.succeed(turn.done, undefined);
      });

    // ── Items ────────────────────────────────────────────────────────────

    const itemTurnId = (ctx: SessionContext, item: MuseItem): TurnId | undefined => {
      if (typeof item.turnId === "string" && item.turnId.length > 0) {
        const joined = ctx.joined.get(item.turnId);
        if (joined) return joined;
        return ctx.activeTurn?.turnId === item.turnId
          ? ctx.activeTurn.turnId
          : TurnId.make(item.turnId);
      }
      return ctx.activeTurn?.turnId;
    };

    const subagentData = (ctx: SessionContext, item: MuseItem) => {
      const childId = item.childSessionId ?? item.subagentId ?? item.itemId;
      const status = subagentStatus(item);
      const result = item.result?.text ?? item.result?.summary;
      return {
        toolName: "subagent",
        item: {
          id: item.itemId,
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status:
            status === "running" ? "inProgress" : status === "completed" ? "completed" : "failed",
          senderThreadId: ctx.museSessionId,
          receiverThreadIds: [childId],
          ...(item.objective ? { prompt: item.objective } : {}),
          ...(item.role ? { agentRole: item.role } : {}),
          agentsStates: {
            [childId]: { status, ...(result ? { message: result } : {}) },
          },
        },
      };
    };

    const emitSubagent = (ctx: SessionContext, state: ItemState, item: MuseItem) =>
      Effect.gen(function* () {
        const childId = item.childSessionId ?? item.subagentId ?? item.itemId;
        const status = subagentStatus(item);
        const result = item.result?.text ?? item.result?.summary;
        yield* emit({
          type: "subagent.metadata.updated",
          ...(yield* eventBase(ctx, state.turnId, childId)),
          payload: {
            agentThreadId: childId,
            transcriptAgentId: childId,
            callId: item.itemId,
            status,
            ...(item.role ? { agentRole: item.role } : {}),
            ...(item.objective ? { objective: item.objective.slice(0, 4_000) } : {}),
            ...(item.depth !== undefined ? { treeDepth: Math.max(1, Math.round(item.depth)) } : {}),
            ...(status !== "running" && result ? { resultBody: result } : {}),
          },
        } as ProviderRuntimeEvent);
      });

    /** Publishes one item revision, opening the row first if it was never opened. */
    const emitItem = (ctx: SessionContext, state: ItemState, item: MuseItem) =>
      Effect.gen(function* () {
        state.item = item;
        if (state.completed) return;
        const finished = item.status !== "inProgress";
        const base = yield* eventBase(ctx, state.turnId);
        const itemId = RuntimeItemId.make(item.itemId);
        switch (item.kind) {
          case "agentMessage": {
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: { itemType: "assistant_message", status: "inProgress" },
              });
            }
            const text = item.text ?? "";
            // A final text the deltas missed (a delivery gap) is made up here.
            if (text.startsWith(state.streamed) && text.length > state.streamed.length) {
              const delta = text.slice(state.streamed.length);
              state.streamed = text;
              yield* emit({
                type: "content.delta",
                ...base,
                itemId,
                payload: { streamKind: "assistant_text", delta },
              });
            }
            if (!finished) return;
            state.completed = true;
            const turn = ctx.activeTurn;
            if (
              turn &&
              state.turnId === turn.turnId &&
              item.messagePhase !== "commentary" &&
              text.trim()
            ) {
              turn.finalText = text;
            }
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: "assistant_message",
                status: museItemFailed(item) && !text.trim() ? "failed" : "completed",
                ...(text.trim() ? { detail: text.trim().slice(0, 4_000) } : {}),
              },
            });
            return;
          }
          case "reasoning": {
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: { itemType: "reasoning", status: "inProgress", title: "Thinking" },
              });
            }
            const parts = item.summary ?? [];
            for (const [index, part] of parts.entries()) {
              const seen = state.summaryStreamed.get(index) ?? "";
              if (part.startsWith(seen) && part.length > seen.length) {
                state.summaryStreamed.set(index, part);
                yield* emit({
                  type: "content.delta",
                  ...base,
                  itemId,
                  payload: {
                    streamKind: "reasoning_summary_text",
                    delta: part.slice(seen.length),
                    summaryIndex: index,
                  },
                });
              }
            }
            if (!finished) return;
            state.completed = true;
            const summary = parts.join("\n\n").trim();
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Thinking",
                ...(summary ? { data: { summary } } : {}),
              },
            });
            return;
          }
          case "subagent": {
            // The child session id names the agent everywhere (its own
            // events carry it), and Muse sends it a moment after the start:
            // a row opened under the short subagent id would stay a second,
            // forever-running agent.
            if (!item.childSessionId && subagentStatus(item) === "running") return;
            const data = subagentData(ctx, item);
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: {
                  itemType: "collab_agent_tool_call",
                  status: "inProgress",
                  title: "Subagent task",
                  ...(item.objective ? { detail: item.objective.slice(0, 400) } : {}),
                  data,
                },
              });
            } else if (!finished) {
              yield* emit({
                type: "item.updated",
                ...base,
                itemId,
                payload: {
                  itemType: "collab_agent_tool_call",
                  status: "inProgress",
                  title: "Subagent task",
                  data,
                },
              });
            }
            yield* emitSubagent(ctx, state, item);
            const final = subagentStatus(item);
            if (final === "running") return;
            state.completed = true;
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: "collab_agent_tool_call",
                status: final === "completed" ? "completed" : "failed",
                title: "Subagent task",
                data,
              },
            });
            yield* endBackground(ctx, state, final);
            return;
          }
          case "workflow": {
            const children = item.children ?? [];
            const detail = [
              item.entryId,
              children.length > 0
                ? `${children.filter((child) => child.terminal !== undefined).length}/${children.length} agents done`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ");
            const payload = {
              itemType: "dynamic_tool_call" as const,
              title: "Workflow",
              ...(detail ? { detail } : {}),
              data: {
                toolName: "workflow",
                ...(item.workflowRunId ? { workflowRunId: item.workflowRunId } : {}),
                children: children.map((child) => ({
                  id: child.childId,
                  ...(child.label ? { label: child.label } : {}),
                  status: child.terminal ?? child.status ?? "running",
                })),
                ...(item.finalSummary ? { result: item.finalSummary.slice(0, 20_000) } : {}),
              },
            };
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: { ...payload, status: "inProgress" },
              });
            } else if (!finished) {
              yield* emit({
                type: "item.updated",
                ...base,
                itemId,
                payload: { ...payload, status: "inProgress" },
              });
            }
            if (!finished) return;
            state.completed = true;
            const failed = museItemFailed(item);
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: { ...payload, status: failed ? "failed" : "completed" },
            });
            yield* endBackground(
              ctx,
              state,
              failed ? "failed" : item.status === "cancelled" ? "interrupted" : "completed",
            );
            return;
          }
          case "compaction": {
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: {
                  itemType: "context_compaction",
                  status: "inProgress",
                  data: { trigger: item.trigger ?? "auto" },
                },
              });
            }
            if (!finished) return;
            state.completed = true;
            const failed = museItemFailed(item);
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: "context_compaction",
                status: failed ? "failed" : "completed",
                ...(failed ? { title: "Context compaction failed" } : {}),
                data: { trigger: item.trigger ?? "auto" },
              },
            });
            if (!failed) {
              yield* emit({
                type: "thread.state.changed",
                ...base,
                payload: { state: "compacted" },
              } as ProviderRuntimeEvent);
            }
            return;
          }
          case "toolCall":
          case "userShell":
          case "webSearch": {
            if (isMuseNativeRowTool(item)) {
              state.completed = finished;
              return;
            }
            const identity = identifyMuseTool(item);
            const title = museToolTitle(item, identity);
            const detail = museToolDetail(item, identity);
            const data = museToolData({
              item,
              identity,
              root: ctx.directory,
              storedPatch: ctx.storedPatches.get(item.itemId),
            });
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: {
                  itemType: identity.itemType,
                  status: "inProgress",
                  title,
                  ...(detail ? { detail } : {}),
                  data,
                },
              });
            } else if (!finished) {
              yield* emit({
                type: "item.updated",
                ...base,
                itemId,
                payload: {
                  itemType: identity.itemType,
                  status: "inProgress",
                  title,
                  ...(detail ? { detail } : {}),
                  data,
                },
              });
            }
            // A shell moved to the background keeps running past its turn.
            if (
              identity.kind === "shell" &&
              item.background === true &&
              !state.background &&
              !finished
            ) {
              state.background = true;
              yield* emit({
                type: "task.started",
                ...base,
                payload: {
                  taskId: RuntimeTaskId.make(item.itemId),
                  taskType: "local_bash",
                  toolUseId: item.itemId,
                  isBackgrounded: true,
                  ...(detail ? { description: detail } : {}),
                },
              } as ProviderRuntimeEvent);
            }
            if (identity.kind === "shell") {
              const output = museCommandOutput(item);
              if (output.startsWith(state.streamed) && output.length > state.streamed.length) {
                const delta = output.slice(state.streamed.length);
                state.streamed = output;
                yield* emit({
                  type: "content.delta",
                  ...base,
                  itemId,
                  payload: { streamKind: "command_output", delta },
                });
              }
            }
            if (!finished) return;
            state.completed = true;
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: identity.itemType,
                status: museItemDeclined(item)
                  ? "declined"
                  : museToolFailed(item, identity)
                    ? "failed"
                    : "completed",
                title,
                ...(detail ? { detail } : {}),
                data: {
                  ...data,
                  ...(item.failureReason ? { error: item.failureReason } : {}),
                },
              },
            });
            if (state.background) {
              yield* endBackground(
                ctx,
                state,
                museToolFailed(item, identity) ? "failed" : "completed",
              );
            }
            return;
          }
          case "userMessage":
          case "reminderChild":
          case "hookRun":
          case "sideChat":
          case "monitorFeed":
            state.completed = finished;
            return;
          default: {
            // An item kind this driver does not know: shown generically.
            const summary = item.fallbackText ?? item.kind;
            if (!state.started) {
              state.started = true;
              yield* emit({
                type: "item.started",
                ...base,
                itemId,
                payload: {
                  itemType: "dynamic_tool_call",
                  status: "inProgress",
                  title: summary.slice(0, 200),
                },
              });
            }
            if (!finished) return;
            state.completed = true;
            yield* emit({
              type: "item.completed",
              ...base,
              itemId,
              payload: {
                itemType: "dynamic_tool_call",
                status: museItemFailed(item) ? "failed" : "completed",
                title: summary.slice(0, 200),
              },
            });
          }
        }
      });

    const endBackground = (
      ctx: SessionContext,
      state: ItemState,
      status: "completed" | "failed" | "interrupted",
    ) =>
      Effect.gen(function* () {
        if (!state.background) return;
        state.background = false;
        yield* emit({
          type: "task.completed",
          ...(yield* eventBase(ctx, state.turnId)),
          payload: {
            taskId: RuntimeTaskId.make(state.item.itemId),
            taskType: state.item.kind === "toolCall" ? "local_bash" : "local_agent",
            toolUseId: state.item.itemId,
            status:
              status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
          },
        } as ProviderRuntimeEvent);
      });

    /** Reads a finished edit's stored patch to the end, so its line counts are exact. */
    const readStoredPatch = (ctx: SessionContext, item: MuseItem) =>
      Effect.gen(function* () {
        const ref = item.patchRef;
        if (!ref || ctx.storedPatches.has(item.itemId)) return;
        if (ref.availability !== undefined && ref.availability !== "available") return;
        if ((ref.byteLen ?? 0) > PATCH_READ_LIMIT_BYTES) return;
        let content = "";
        let offset = 0;
        const result = yield* Effect.gen(function* () {
          for (let page = 0; page < 64; page += 1) {
            const raw = yield* sessionRequest(ctx, "item/readOutput", {
              itemId: item.itemId,
              outputRef: ref.id,
              offsetBytes: offset,
            });
            const decoded = decodeReadOutput(raw);
            if (Option.isNone(decoded)) return false;
            const chunk = decoded.value;
            content +=
              chunk.encoding === "base64"
                ? Buffer.from(chunk.content, "base64").toString("utf8")
                : chunk.content;
            offset = chunk.offsetBytes + chunk.byteLen;
            if (chunk.eof) return true;
            if (chunk.byteLen === 0) return false;
          }
          return false;
        }).pipe(Effect.orElseSucceed(() => false));
        if (result && content) ctx.storedPatches.set(item.itemId, content);
      });

    const applyItem = (ctx: SessionContext, item: MuseItem) =>
      Effect.gen(function* () {
        const existing = ctx.items.get(item.itemId);
        if (existing && existing.item.revision > item.revision) return;
        if (existing?.completed) {
          existing.item = item;
          return;
        }
        const state: ItemState = existing ?? {
          item,
          turnId: itemTurnId(ctx, item),
          streamed: "",
          summaryStreamed: new Map(),
          started: false,
          completed: false,
          background: false,
        };
        if (!existing) ctx.items.set(item.itemId, state);
        // A finished edit with a stored patch is published once the patch is read.
        if (
          item.status === "completed" &&
          item.patchRef !== undefined &&
          !ctx.storedPatches.has(item.itemId) &&
          (item.kind === "toolCall" || item.kind === "userShell")
        ) {
          const turn = ctx.activeTurn?.turnId === state.turnId ? ctx.activeTurn : undefined;
          // The turn settles only after this edit is published with its counts.
          const read = yield* Deferred.make<void>();
          turn?.pendingReads.add(read);
          state.item = item;
          yield* readStoredPatch(ctx, item).pipe(
            Effect.andThen(Effect.suspend(() => emitItem(ctx, state, state.item))),
            Effect.ensuring(
              Effect.suspend(() => {
                turn?.pendingReads.delete(read);
                return Deferred.succeed(read, undefined);
              }),
            ),
            Effect.forkIn(ctx.scope),
          );
          return;
        }
        yield* emitItem(ctx, state, item);
      });

    const applyDelta = (ctx: SessionContext, delta: typeof MuseItemDelta.Type) =>
      Effect.gen(function* () {
        const state = ctx.items.get(delta.itemId);
        if (!state || state.completed) return;
        const field = delta.field ?? "text";
        const item = state.item;
        if (field === "text") {
          yield* emitItem(ctx, state, { ...item, text: (item.text ?? "") + delta.delta });
        } else if (field === "output" || field === "visibleOutput") {
          yield* emitItem(ctx, state, {
            ...item,
            visibleOutput: (item.visibleOutput ?? "") + delta.delta,
          });
        } else if (field.startsWith("summary.")) {
          const index = Number(field.slice("summary.".length));
          if (!Number.isSafeInteger(index) || index < 0 || index > 100) return;
          const summary = [...(item.summary ?? [])];
          summary[index] = (summary[index] ?? "") + delta.delta;
          yield* emitItem(ctx, state, { ...item, summary });
        }
      });

    // ── Approvals and questions ──────────────────────────────────────────

    /** The tool call an approval is about, so the chat shows it on that call's row. */
    const approvalItemId = (approval: MuseApproval) =>
      approval.itemId ? { itemId: RuntimeItemId.make(approval.itemId) } : {};

    const resolveApproval = (
      ctx: SessionContext,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const pending = ctx.approvals.get(requestId);
        if (!pending) return;
        ctx.approvals.delete(requestId);
        if (ctx.approvalIds.get(pending.approval.approvalId) === requestId) {
          ctx.approvalIds.delete(pending.approval.approvalId);
        }
        yield* emit({
          type: "request.resolved",
          ...(yield* eventBase(ctx, pending.turnId)),
          ...approvalItemId(pending.approval),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: museRequestType(pending.approval.subject), decision },
        });
      });

    const resolveQuestion = (
      ctx: SessionContext,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const pending = ctx.questions.get(requestId);
        if (!pending) return;
        ctx.questions.delete(requestId);
        ctx.questionIds.delete(pending.input.userInputId);
        yield* emit({
          type: "user-input.resolved",
          ...(yield* eventBase(ctx, pending.turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const decideApproval = (
      ctx: SessionContext,
      approval: MuseApproval,
      choice: MuseApprovalChoice,
    ) =>
      sessionCommand(
        ctx,
        "approval/decide",
        {
          approvalId: approval.approvalId,
          requirementId: approval.currentRequirementId,
          choiceId: choice.choiceId,
        },
        { maxAttempts: 1 },
      );

    /** A file write inside the workspace roots that auto-accept edits may approve. */
    const isWorkspaceWrite = (ctx: SessionContext, approval: MuseApproval) =>
      Effect.gen(function* () {
        const subject = approval.subject;
        if (subject.kind !== "fileAccess" || subject.access === "read") return false;
        if (approval.protectedWrite === true || !subject.path) return false;
        if (!NodePath.isAbsolute(subject.path)) return false;
        // A file (or folder) that does not exist yet: its nearest existing
        // folder decides, so links are still resolved.
        const missing: Array<string> = [];
        let existing = NodePath.normalize(subject.path);
        let target: string | undefined;
        while (target === undefined) {
          const resolved = yield* fileSystem.realPath(existing).pipe(Effect.option);
          if (resolved._tag === "Some") {
            target = NodePath.join(resolved.value, ...missing.toReversed());
            break;
          }
          const parent = NodePath.dirname(existing);
          if (parent === existing) return false;
          missing.push(NodePath.basename(existing));
          existing = parent;
        }
        if (missing.includes("..")) return false;
        const root = ctx.directory.replace(/[\\/]+$/u, "");
        return target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`);
      });

    const openApproval = (ctx: SessionContext, approval: MuseApproval) =>
      Effect.gen(function* () {
        if (approval.sessionId !== ctx.museSessionId) return;
        const existingId = ctx.approvalIds.get(approval.approvalId);
        const existing = existingId ? ctx.approvals.get(existingId) : undefined;
        if (
          existing &&
          existing.approval.currentRequirementId.sourceIndex ===
            approval.currentRequirementId.sourceIndex
        ) {
          // The same stage again (request and notification both carry it).
          existing.approval = approval;
          return;
        }
        if (existing) {
          // The previous stage was decided; the next one is its own request.
          yield* resolveApproval(ctx, existing.requestId, existing.decided ?? "accept");
        }
        const host = ctx.host;
        const choices = museChoicesByDecision(approval.availableChoices);
        const once = choices.get("accept");
        const autoApprove =
          host !== undefined &&
          !host.plan &&
          once !== undefined &&
          once.scope === "once" &&
          ((approval.subagentOrigin !== undefined && host.profile.autoApproveSubagents) ||
            (host.profile.autoApproveWorkspaceWrites &&
              approval.subagentOrigin === undefined &&
              (yield* isWorkspaceWrite(ctx, approval))));
        if (autoApprove) {
          const approved = yield* decideApproval(ctx, approval, once).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Muse auto-approval failed; asking the user", { error }).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (approved) return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId =
          approval.subagentOrigin === undefined && approval.turnId
            ? ctx.activeTurn?.turnId === approval.turnId
              ? ctx.activeTurn.turnId
              : TurnId.make(approval.turnId)
            : ctx.activeTurn?.turnId;
        ctx.approvals.set(requestId, { requestId, approval, turnId, decided: undefined });
        ctx.approvalIds.set(approval.approvalId, requestId);
        const requestType = museRequestType(approval.subject);
        const detail = museApprovalDetail(approval);
        yield* emit({
          type: "request.opened",
          ...(yield* eventBase(ctx, turnId, approval.subagentOrigin?.childSessionId)),
          ...approvalItemId(approval),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType,
            ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
            availableDecisions: museAvailableDecisions(approval.availableChoices),
            args: {
              kind: approval.subject.kind,
              ...(approval.subject.command ? { command: approval.subject.command } : {}),
              ...(approval.subject.path ? { path: approval.subject.path } : {}),
              ...(approval.subject.host ? { host: approval.subject.host } : {}),
              ...(approval.toolName ? { toolName: approval.toolName } : {}),
            },
          },
          raw: { source: "muse.msp.notification", method: "approval/requested", payload: approval },
        });
      });

    const updateApproval = (ctx: SessionContext, update: typeof MuseApprovalUpdate.Type) =>
      Effect.gen(function* () {
        const requestId = ctx.approvalIds.get(update.approvalId);
        const pending = requestId ? ctx.approvals.get(requestId) : undefined;
        if (!pending) return;
        yield* openApproval(ctx, {
          ...pending.approval,
          currentRequirementId: update.currentRequirementId,
          availableChoices: update.availableChoices,
          subject: update.subject,
        });
      });

    const openQuestion = (ctx: SessionContext, input: MuseUserInput) =>
      Effect.gen(function* () {
        if (input.sessionId !== ctx.museSessionId || ctx.questionIds.has(input.userInputId)) return;
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const turnId = ctx.activeTurn?.turnId;
        ctx.questions.set(requestId, { requestId, input, turnId });
        ctx.questionIds.set(input.userInputId, requestId);
        yield* emit({
          type: "user-input.requested",
          ...(yield* eventBase(ctx, turnId)),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            questions: input.questions.map((question) => ({
              id: question.id,
              header: question.header.trim() || "Question",
              question: question.question.trim() || question.header.trim() || "Question",
              options: question.options
                .filter((option) => option.label.trim())
                .map((option) => ({
                  label: option.label.trim(),
                  description: option.description?.trim() || option.label.trim(),
                })),
              multiSelect: question.selection.mode === "multiple",
            })),
          },
          raw: { source: "muse.msp.notification", method: "userInput/requested", payload: input },
        });
      });

    // ── Notifications ────────────────────────────────────────────────────

    const onHostLost = (ctx: SessionContext, state: HostState, reason: string) =>
      Effect.gen(function* () {
        if (ctx.host !== state || state.closing || ctx.stopped) return;
        yield* stopContext(ctx, reason);
      });

    /** Pages the durable events a delivery gap dropped and applies them like live ones. */
    const fillGap = (ctx: SessionContext, gap: typeof MuseViewGap.Type, generation: number) =>
      Effect.gen(function* () {
        let cursor: string = gap.after;
        for (let page = 0; page < 200; page += 1) {
          const raw = yield* sessionRequest(ctx, "view/page", {
            cursor,
            direction: "forward",
            limit: 500,
          });
          const events = Array.isArray(raw.events) ? raw.events : [];
          for (const event of events) {
            if (!isRecord(event) || typeof event.method !== "string") continue;
            const params = isRecord(event.params) ? event.params : {};
            yield* handleNotification(ctx, generation, { method: event.method, params });
            if (params.viewCursor === gap.next) return;
          }
          const next = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
          if (!next || next === cursor) return;
          cursor = next;
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // The turn cannot be observed any more: stop its work before saying so.
            const turn = ctx.activeTurn;
            if (!turn) return;
            yield* sessionCommand(ctx, "turn/interrupt", { turnId: turn.turnId }).pipe(
              Effect.ignore,
            );
            yield* finishTurn(ctx, turn, {
              kind: "failed",
              message: `Lost part of Muse Code's progress and could not read it back: ${error.message}`,
            });
          }),
        ),
      );

    const handleNotification = (
      ctx: SessionContext,
      generation: number,
      notification: MuseNotification,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.host?.generation !== generation) return;
        const { method, params } = notification;
        if (method !== "item/delta") yield* logNative(ctx, method, params);
        // Host-level notifications carry no session id.
        switch (method) {
          case "usage/changed": {
            const usage = decodeSubscriptionUsage(params);
            if (Option.isSome(usage)) yield* options.onSubscriptionUsage(usage.value);
            return;
          }
          case "account/changed":
            yield* options.onAccountChanged;
            return;
          case "session/listChanged":
          case "account/loginCompleted":
            return;
        }
        if (params.sessionId !== ctx.museSessionId) return;
        switch (method) {
          case "turn/started": {
            const started = decodeTurnStarted(params);
            if (Option.isNone(started)) return;
            const turnId = started.value.turnId;
            ctx.queued.delete(turnId);
            if (ctx.startedTurnIds.has(turnId)) return;
            ctx.startedTurnIds.add(turnId);
            if (ctx.activeTurn?.turnId === turnId) return;
            if (ctx.activeTurn) {
              // Muse runs its own turn next to ours: the running turn shows it.
              ctx.joined.set(turnId, ctx.activeTurn.turnId);
              return;
            }
            // Muse started a turn on its own: a finished workflow or task reporting back.
            if (ctx.stoppedWork.size > 0) {
              yield* sessionCommand(ctx, "turn/interrupt", { turnId }).pipe(Effect.ignore);
              return;
            }
            yield* beginTurn(ctx, {
              turnId: TurnId.make(turnId),
              origin: "provider",
              plan: ctx.host?.plan ?? false,
            });
            return;
          }
          case "turn/completed": {
            const completed = decodeTurnCompleted(params);
            if (Option.isNone(completed)) return;
            if (ctx.joined.delete(completed.value.turnId)) return;
            const turn = ctx.activeTurn;
            if (!turn || turn.turnId !== completed.value.turnId) return;
            const value = completed.value;
            yield* finishTurn(
              ctx,
              turn,
              value.terminal === "completed"
                ? { kind: "completed" }
                : value.terminal === "cancelled" || turn.stopRequested
                  ? {
                      kind: "interrupted",
                      reason: turn.stopRequested ? "user" : (value.reason ?? "cancelled"),
                    }
                  : { kind: "failed", message: museTurnErrorMessage(value) },
            );
            if (value.error?.kind === "authRequired") yield* options.onAccountChanged;
            return;
          }
          case "turn/foregroundCompleted": {
            const foreground = decodeTurnForegroundCompleted(params);
            if (Option.isNone(foreground)) return;
            if (ctx.activeTurn?.turnId === foreground.value.turnId) {
              ctx.activeTurn.foregroundDone = true;
            }
            return;
          }
          case "turn/unqueued": {
            const unqueued = decodeTurnUnqueued(params);
            if (Option.isNone(unqueued)) return;
            ctx.queued.delete(unqueued.value.turnId);
            const turn = ctx.activeTurn;
            if (turn && turn.turnId === unqueued.value.turnId) {
              yield* finishTurn(ctx, turn, { kind: "interrupted", reason: "user" });
            }
            return;
          }
          case "turn/retryScheduled":
          case "turn/modelRetryScheduled": {
            const retry = decodeTurnRetry(params);
            if (Option.isNone(retry) || !ctx.activeTurn) return;
            const attempt = retry.value.nextAttempt;
            const reason = retry.value.reason?.trim();
            yield* emit({
              type: "runtime.warning",
              ...(yield* eventBase(ctx, ctx.activeTurn.turnId)),
              payload: {
                message: `Muse Code is retrying the model request${attempt ? ` (attempt ${attempt}${retry.value.maxAttempts ? ` of ${retry.value.maxAttempts}` : ""})` : ""}${reason ? `: ${reason}` : "."}`,
                warningKind: "api-retry",
              },
            } as ProviderRuntimeEvent);
            return;
          }
          case "item/started":
          case "item/updated":
          case "item/completed": {
            const event = decodeItemEvent(params);
            if (Option.isSome(event)) yield* applyItem(ctx, event.value.item);
            return;
          }
          case "item/delta": {
            const delta = decodeDelta(params);
            if (Option.isSome(delta)) yield* applyDelta(ctx, delta.value);
            return;
          }
          case "approval/requested": {
            const approval = decodeApproval(params);
            if (Option.isSome(approval)) yield* openApproval(ctx, approval.value);
            return;
          }
          case "approval/updated": {
            const update = decodeApprovalUpdate(params);
            if (Option.isSome(update)) yield* updateApproval(ctx, update.value);
            return;
          }
          case "approval/resolved": {
            const resolved = decodeApprovalResolved(params);
            if (Option.isNone(resolved)) return;
            const requestId = ctx.approvalIds.get(resolved.value.approvalId);
            const pending = requestId ? ctx.approvals.get(requestId) : undefined;
            if (!requestId || !pending) return;
            const decision =
              pending.decided ??
              (resolved.value.decision.startsWith("approved")
                ? "accept"
                : resolved.value.decision === "abort"
                  ? "cancel"
                  : "decline");
            yield* resolveApproval(ctx, requestId, decision);
            return;
          }
          case "userInput/requested": {
            const input = decodeUserInput(params);
            if (Option.isSome(input)) yield* openQuestion(ctx, input.value);
            return;
          }
          case "userInput/settled": {
            const settled = decodeUserInputSettled(params);
            if (Option.isNone(settled)) return;
            const requestId = ctx.questionIds.get(settled.value.userInputId);
            if (requestId) yield* resolveQuestion(ctx, requestId, {});
            return;
          }
          case "session/todoListChanged": {
            const todo = decodeTodoList(params);
            if (Option.isNone(todo)) return;
            const plan = todo.value.items
              .filter((entry) => entry.text.trim() && entry.status !== "cancelled")
              .map((entry) => ({ step: entry.text.trim(), status: todoStatus(entry.status) }));
            yield* emit({
              type: "turn.plan.updated",
              ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
              payload: { plan },
            });
            return;
          }
          case "session/tokenUsage": {
            const usage = decodeTokenUsage(params);
            if (Option.isNone(usage)) return;
            const raw = usage.value.usage;
            const prompt = Math.round(usage.value.promptTokens ?? raw.inputTokens ?? 0);
            const output = Math.round(raw.outputTokens ?? 0);
            const used = prompt + output;
            if (used <= 0) return;
            yield* emit({
              type: "thread.token-usage.updated",
              ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
              payload: {
                usage: {
                  usedTokens: used,
                  lastUsedTokens: used,
                  lastInputTokens: prompt,
                  lastCachedInputTokens: Math.round(raw.cacheReadTokens ?? raw.cachedTokens ?? 0),
                  lastOutputTokens: output,
                  ...(raw.reasoningTokens
                    ? { lastReasoningOutputTokens: Math.round(raw.reasoningTokens) }
                    : {}),
                  compactsAutomatically: true,
                },
              },
            });
            return;
          }
          case "session/contextUsage": {
            const usage = decodeContextUsage(params);
            if (Option.isNone(usage)) return;
            yield* emit({
              type: "thread.token-usage.updated",
              ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
              payload: {
                usage: {
                  usedTokens: Math.round(usage.value.usedTokens),
                  ...(usage.value.windowTokens && usage.value.windowTokens > 0
                    ? { maxTokens: Math.round(usage.value.windowTokens) }
                    : {}),
                  compactsAutomatically: true,
                },
              },
            });
            return;
          }
          case "session/modelChanged": {
            const changed = decodeModelChanged(params);
            if (Option.isSome(changed) && changed.value.modelId) {
              ctx.model = changed.value.modelId;
              ctx.session = { ...ctx.session, model: changed.value.modelId };
            }
            return;
          }
          case "view/gap": {
            const gap = decodeViewGap(params);
            if (Option.isSome(gap)) yield* fillGap(ctx, gap.value, generation);
            return;
          }
          case "session/closed": {
            const closed = decodeSessionClosed(params);
            if (Option.isSome(closed) && ctx.host && !ctx.host.closing) {
              yield* onHostLost(ctx, ctx.host, "Muse Code closed this conversation.");
            }
            return;
          }
          case "session/viewHealthChanged": {
            const health = decodeViewHealth(params);
            if (Option.isSome(health) && health.value.health === "unavailable" && ctx.host) {
              yield* onHostLost(
                ctx,
                ctx.host,
                "Muse Code can no longer report this conversation's progress.",
              );
            }
            return;
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Muse notification handling failed", {
            method: notification.method,
            cause,
          }),
        ),
      );

    const handleServerRequest = (
      ctx: SessionContext,
      generation: number,
      request: { readonly method: string; readonly params: Record<string, unknown> },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.host?.generation !== generation) return;
        yield* logNative(ctx, request.method, request.params);
        if (request.method === "approval/request") {
          const approval = decodeApproval(request.params);
          if (Option.isSome(approval)) yield* openApproval(ctx, approval.value);
        } else if (request.method === "userInput/request") {
          const input = decodeUserInput(request.params);
          if (Option.isSome(input)) yield* openQuestion(ctx, input.value);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Muse server request handling failed", {
            method: request.method,
            cause,
          }),
        ),
      );

    // ── Hosts ────────────────────────────────────────────────────────────

    const mcpConfig = (ctx: SessionContext, granted: ReadonlyArray<string>) => {
      if (!granted.includes("sessionMcp")) return undefined;
      const headers = { Authorization: `Bearer ${ctx.mcpToken}` };
      // Optional: Muse fails every turn when a required server is unreachable.
      const server = (url: string) => ({
        transport: "streamableHttp",
        mode: "optional",
        url,
        headers,
      });
      return {
        mcpServers: {
          [BROWSER_MCP_SERVER_NAME]: server(mcpEndpointUrl(serverConfig.port)),
          ...(ctx.roomTools
            ? { [ROOM_MCP_SERVER_NAME]: server(mcpRoomEndpointUrl(serverConfig.port)) }
            : {}),
          ...(ctx.agentPageAssetsDir !== undefined
            ? { [PAGES_MCP_SERVER_NAME]: server(mcpPagesEndpointUrl(serverConfig.port)) }
            : {}),
          ...(ctx.commandRequests
            ? { [COMMANDS_MCP_SERVER_NAME]: server(mcpCommandsEndpointUrl(serverConfig.port)) }
            : {}),
        },
      };
    };

    const instructionsFor = (ctx: SessionContext) =>
      [
        buildPreviewPanelInstructions("muse"),
        ...(ctx.agentPageAssetsDir !== undefined
          ? [buildAgentPageInstructions({ assetsDir: ctx.agentPageAssetsDir })]
          : []),
        // Muse's own names for outside tools are not ours to guess; the bare name is unambiguous.
        ...(ctx.commandRequests ? [buildCommandRequestInstructions({ toolPrefix: "" })] : []),
        FILE_LINK_INSTRUCTIONS,
        ...(ctx.managedWorktree ? [MANAGED_WORKTREE_INSTRUCTION] : []),
      ].join("\n\n");

    /** Refuses an API-key credential unless the instance allows per-use billing. */
    const checkBilling = (host: MuseHost) =>
      Effect.gen(function* () {
        if (options.settings.allowApiKeyBilling) return;
        const accountState = host.initialize.experimentalApi
          ? yield* host.request("account/read", {}).pipe(
              Effect.map((raw) => Option.getOrUndefined(decodeAccountState(raw))?.state),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const refusal = museBillingRefusal({
          allowApiKeyBilling: options.settings.allowApiKeyBilling,
          accountState,
          instanceEnvironment: options.instanceEnvironment,
        });
        if (refusal) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: describeMuseBillingRefusal(refusal),
          });
        }
      });

    /**
     * Starts a host for `ctx` and loads its conversation on it: resume, fork,
     * or a new one. The previous host must be gone (its lease released).
     */
    const launchHost = (
      ctx: SessionContext,
      input: {
        readonly plan: boolean;
        readonly mode:
          | { readonly kind: "resume"; readonly sessionId: string }
          | {
              readonly kind: "fork";
              readonly sourceSessionId: string;
              readonly lastTurnId?: string;
            }
          | { readonly kind: "new"; readonly modelId?: string };
      },
    ) =>
      Effect.gen(function* () {
        const contributorMode = yield* options.readContributorMode;
        const profile = museHostProfile({
          purpose: input.plan ? "plan" : "chat",
          runtimeMode: ctx.runtimeMode,
          contributorMode,
          sandboxAvailable: options.sandboxAvailable(),
        });
        const scope = yield* Scope.make("sequential");
        const generation = ctx.nextGeneration++;
        return yield* Effect.gen(function* () {
          const host = yield* (options.startHost ?? startMuseHost)({
            binaryPath: options.binaryPath(),
            args: [...profile.args, ...(options.hostArgs ?? [])],
            environment: options.environment,
            cwd: ctx.directory,
            experimentalApi: true,
            requestedCapabilities: ["sessionMcp"],
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
          yield* checkBilling(host);
          const config = mcpConfig(ctx, host.initialize.grantedCapabilities);
          const permission = profile.permissionProfile
            ? { permissionProfile: profile.permissionProfile }
            : {};
          const load = (() => {
            switch (input.mode.kind) {
              case "resume": {
                const sessionId = input.mode.sessionId;
                // The previous host can take a moment to release the lease.
                return host
                  .command("session/resume", {
                    sessionId,
                    excludeItems: true,
                    ...permission,
                    ...(config ? { config } : {}),
                  })
                  .pipe(
                    Effect.retry({
                      while: (error) => error.kind === "sessionInUse",
                      schedule: Schedule.spaced(Duration.millis(500)),
                      times: 24,
                    }),
                    Effect.timeoutOption(LEASE_RETRY_WINDOW),
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          Effect.fail(
                            new ProviderAdapterRequestError({
                              provider: PROVIDER,
                              method: "session/resume",
                              detail: "Another Muse Code process is still using this conversation.",
                              code: "sessionInUse",
                            }),
                          ),
                        onSome: Effect.succeed,
                      }),
                    ),
                    Effect.mapError((error) =>
                      error._tag === "MuseHostError"
                        ? requestError("session/resume")(error)
                        : error,
                    ),
                  );
              }
              case "fork":
                return host
                  .command("session/fork", {
                    sessionId: input.mode.sourceSessionId,
                    excludeItems: true,
                    ...(input.mode.lastTurnId
                      ? { cutPoint: { lastTurnId: input.mode.lastTurnId } }
                      : {}),
                  })
                  .pipe(Effect.mapError(requestError("session/fork")));
              case "new":
                return host
                  .command("session/start", {
                    workspaceRoot: ctx.workspaceRoot,
                    providerId: options.providerId ?? "meta",
                    approvalMode: profile.approvalMode,
                    ...permission,
                    ...(input.mode.modelId ? { modelId: input.mode.modelId } : {}),
                    ...(config ? { config } : {}),
                  })
                  .pipe(Effect.mapError(requestError("session/start")));
            }
          })();
          const loaded = yield* load;
          const result = decodeSessionResult(loaded);
          if (Option.isNone(result)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: input.mode.kind === "new" ? "session/start" : `session/${input.mode.kind}`,
              detail: "Muse Code answered with a session Threadlines could not read.",
            });
          }
          const session: MuseSessionResult = result.value;
          const noneReason = session.history?.noneReason;
          if (noneReason === "projectionUnavailable" || noneReason === "projectionReadLimit") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail: "Muse Code could not load this conversation's progress.",
              code: "viewUnavailable",
            });
          }
          ctx.museSessionId = session.session.sessionId;
          // A resumed session keeps the approval mode it was saved with. A
          // fork is reopened as a resume right after (startSession).
          if (
            input.mode.kind === "resume" &&
            session.session.approvalMode?.mode !== profile.approvalMode
          ) {
            yield* host
              .command("session/setApprovalMode", {
                sessionId: ctx.museSessionId,
                mode: profile.approvalMode,
              })
              .pipe(Effect.mapError(requestError("session/setApprovalMode")));
          }
          const effectiveProfile = session.session.permissionState?.profileId;
          if (
            input.mode.kind !== "fork" &&
            profile.permissionProfile &&
            effectiveProfile &&
            effectiveProfile !== profile.permissionProfile
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail: `Muse Code kept the ${effectiveProfile} permission profile instead of ${profile.permissionProfile}.`,
            });
          }
          if (session.session.modelId) ctx.model = session.session.modelId;
          const state: HostState = {
            generation,
            host,
            scope,
            profile,
            contributorMode,
            plan: input.plan,
            closing: false,
          };
          ctx.host = state;
          yield* Stream.merge(
            host.notifications.pipe(
              Stream.map((n) => ({ kind: "notification" as const, value: n })),
            ),
            host.serverRequests.pipe(Stream.map((r) => ({ kind: "request" as const, value: r }))),
          ).pipe(
            Stream.runForEach((entry) =>
              entry.kind === "notification"
                ? handleNotification(ctx, generation, entry.value)
                : handleServerRequest(ctx, generation, entry.value),
            ),
            Effect.forkIn(scope),
          );
          yield* host.exited.pipe(
            Effect.flatMap((exit) =>
              onHostLost(ctx, state, describeMuseExit(exit, host.stderrTail())),
            ),
            Effect.forkIn(scope),
          );
          // Pending approvals and questions on resume come back as server
          // requests right after the response; nothing more to read here.
          return session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    /** Closes the thread's host on purpose and waits for the process to go. */
    const closeHost = (ctx: SessionContext) =>
      Effect.gen(function* () {
        const state = ctx.host;
        if (!state) return;
        state.closing = true;
        ctx.host = undefined;
        yield* Scope.close(state.scope, Exit.void);
      });

    /** Subagents, workflows or background commands still running on the host. */
    const hasBackgroundWork = (ctx: SessionContext) =>
      [...ctx.items.values()].some((state) => state.background);

    /** Whether the host can be replaced without cutting off work. */
    const canRecycle = (ctx: SessionContext) =>
      ctx.activeTurn === undefined &&
      ctx.queued.size === 0 &&
      ctx.approvals.size === 0 &&
      ctx.questions.size === 0 &&
      !hasBackgroundWork(ctx);

    /** Makes the host match what the next turn needs, replacing it between turns. */
    const ensureHost = (ctx: SessionContext, plan: boolean) =>
      Effect.gen(function* () {
        const current = ctx.host;
        const contributorMode = yield* options.readContributorMode;
        const wanted = museHostProfile({
          purpose: plan ? "plan" : "chat",
          runtimeMode: ctx.runtimeMode,
          contributorMode,
          sandboxAvailable: options.sandboxAvailable(),
        });
        if (
          current &&
          !current.closing &&
          current.plan === plan &&
          !museHostProfilesDiffer(current.profile, wanted)
        ) {
          return;
        }
        if (current && !canRecycle(ctx)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: BACKGROUND_WORK_REFUSAL,
          });
        }
        yield* closeHost(ctx);
        yield* launchHost(ctx, { plan, mode: { kind: "resume", sessionId: ctx.museSessionId } });
      });

    // ── Session lifecycle ────────────────────────────────────────────────

    /**
     * Ends a context: pending requests settle, a running turn ends, the host
     * goes, and the thread hears `session.exited`. `failure` is set when the
     * session ended on its own (the host died or Muse closed it).
     */
    const stopContext = (ctx: SessionContext, failure: string | undefined) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        yield* dropPendingRequests(ctx);
        const turn = ctx.activeTurn;
        if (turn) {
          ctx.activeTurn = undefined;
          yield* emit({
            type: "turn.completed",
            ...(yield* eventBase(ctx, turn.turnId)),
            payload: failure
              ? { state: "failed", errorMessage: failure }
              : { state: "interrupted", stopReason: "session-stopped" },
          });
          yield* Deferred.succeed(turn.done, undefined);
        }
        for (const state of ctx.items.values()) {
          if (state.background) yield* endBackground(ctx, state, "interrupted");
        }
        if (ctx.host) ctx.host.closing = true;
        yield* Scope.close(ctx.scope, Exit.void);
        if (failure) {
          yield* emit({
            type: "runtime.error",
            ...(yield* eventBase(ctx, undefined)),
            payload: { message: failure, class: "provider_error" },
          });
        }
        yield* emit({
          type: "session.exited",
          ...(yield* eventBase(ctx, undefined)),
          payload: failure ? { exitKind: "error", reason: failure } : { exitKind: "graceful" },
        } as ProviderRuntimeEvent);
      });

    const startSession: MuseAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        // Muse loads the user's hooks, plugins and MCP servers in every host,
        // so a locked-down side answer cannot be promised.
        if (input.lockdown !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Muse Code cannot answer on the side while another agent works.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (!options.settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Muse Code is turned off in Settings.",
          });
        }
        // A restart (an access change) replaces the host, which would kill
        // background work; it waits for that the way a switch between turns
        // does. A running turn ends as it would on any provider.
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* existing.lifecycle.withPermit(
            Effect.gen(function* () {
              if (hasBackgroundWork(existing)) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: BACKGROUND_WORK_REFUSAL,
                });
              }
              yield* stopContext(existing, undefined);
            }),
          );
        }

        // Muse rejects symlinked workspace roots (macOS /tmp) and reports
        // canonical paths in approvals.
        const directory = yield* fileSystem.realPath(input.cwd.trim()).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Working directory not found: ${input.cwd}`,
                cause,
              }),
          ),
        );
        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          const roomTools = input.roomTools === true;
          const commandRequests = input.commandRequests === true;
          const agentPageAssetsDir =
            input.agentPages === true
              ? yield* ensurePageAssetsDir(parseSessionKey(input.threadId).threadId).pipe(
                  Effect.map((dir): string | undefined => dir),
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined;
          const credential = yield* mcpSessionRegistry.credentialFor({
            sessionKey: input.threadId,
            browser: true,
            room: roomTools,
            pages: agentPageAssetsDir !== undefined,
            commands: commandRequests,
          });
          yield* Scope.addFinalizer(
            scope,
            mcpSessionRegistry.revoke(input.threadId, credential.generation),
          );
          const managedWorktree = yield* isLinkedWorktreeCheckout(directory).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          const boundSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const now = yield* nowIso;
          const ctx: SessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: directory,
              ...(boundSelection ? { model: boundSelection.model } : {}),
              threadId: input.threadId,
              ...(roomTools ? { roomTools: true } : {}),
              createdAt: now,
              updatedAt: now,
            },
            directory,
            workspaceRoot: museWorkspaceRoot(directory),
            scope,
            runtimeMode: input.runtimeMode,
            roomTools,
            agentPageAssetsDir,
            commandRequests,
            managedWorktree,
            mcpToken: credential.token,
            museSessionId: "",
            host: undefined,
            nextGeneration: 1,
            model: boundSelection?.model,
            pendingSeed: undefined,
            instructionsPending: true,
            activeTurn: undefined,
            queued: new Set(),
            joined: new Map(),
            items: new Map(),
            approvals: new Map(),
            approvalIds: new Map(),
            questions: new Map(),
            questionIds: new Map(),
            storedPatches: new Map(),
            stoppedWork: new Set(),
            turns: [],
            startedTurnIds: new Set(),
            lifecycle: yield* Semaphore.make(1),
            stopped: false,
          };
          // Hosts live inside the context's scope: closing it ends them all.
          yield* Scope.addFinalizer(scope, closeHost(ctx));

          // Plan mode is chosen per turn; a plan turn moves the conversation to a plan host.
          const plan = false;
          const resumeId = parseMuseResumeCursor(input.resumeCursor)?.sessionId;
          let resumed = false;
          if (resumeId) {
            resumed = yield* launchHost(ctx, {
              plan,
              mode: { kind: "resume", sessionId: resumeId },
            }).pipe(
              Effect.as(true),
              // A conversation Muse no longer has starts fresh, with the
              // thread's history, unless the caller needs that exact one.
              Effect.catchIf(
                (error) =>
                  input.resumePolicy !== "required" &&
                  error._tag === "ProviderAdapterRequestError" &&
                  (error.code === "sessionNotFound" ||
                    error.code === "notFound" ||
                    error.code === "viewUnavailable"),
                () =>
                  closeHost(ctx).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        ctx.session = { ...ctx.session, resumeFailed: true };
                      }),
                    ),
                    Effect.as(false),
                  ),
              ),
            );
          }
          if (!resumed && input.forkFrom) {
            if (input.forkFrom.beforeTurnId) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Muse Code can only fork a conversation after a whole turn.",
              });
            }
            yield* launchHost(ctx, {
              plan,
              mode: {
                kind: "fork",
                sourceSessionId: input.forkFrom.providerThreadId,
                ...(input.forkFrom.lastTurnId ? { lastTurnId: input.forkFrom.lastTurnId } : {}),
              },
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: `Muse Code could not fork the conversation there: ${error.message}`,
                  }),
              ),
            );
            // session/fork takes no config or permission profile, so the
            // copy has neither Threadlines' tools nor this access level yet:
            // reopen it the way a resume does.
            yield* closeHost(ctx);
            yield* launchHost(ctx, {
              plan,
              mode: { kind: "resume", sessionId: ctx.museSessionId },
            });
            resumed = true;
          }
          if (!resumed) {
            yield* launchHost(ctx, {
              plan,
              mode: { kind: "new", ...(boundSelection ? { modelId: boundSelection.model } : {}) },
            });
            if (input.contextSeed !== undefined) {
              ctx.pendingSeed = renderThreadContextSeed(input.contextSeed);
            }
          } else {
            // A resumed or forked conversation already holds Threadlines' instructions.
            ctx.instructionsPending = false;
          }
          ctx.session = {
            ...ctx.session,
            resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: ctx.museSessionId },
            providerThreadId: ctx.museSessionId,
            ...(ctx.model ? { model: ctx.model } : {}),
          };
          sessions.set(input.threadId, ctx);
          yield* emit({
            type: "session.started",
            ...(yield* eventBase(ctx, undefined)),
            payload: {},
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* eventBase(ctx, undefined)),
            payload: { state: "ready", reason: "Muse Code session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* eventBase(ctx, undefined)),
            payload: { providerThreadId: ctx.museSessionId },
          });
          return ctx.session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    /** Text, images and staged files as Muse turn input parts. */
    const inputParts = (
      method: "turn/start" | "turn/steer",
      input: {
        readonly input?: string | undefined;
        readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const parts: Array<Record<string, unknown>> = [];
        const notes: Array<string> = [];
        for (const attachment of input.attachments ?? []) {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          if (attachment.type === "file") {
            notes.push(buildFileAttachmentNote(attachment, path));
            continue;
          }
          const bytes = yield* fileSystem.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: `Failed to read attachment file: ${cause.message}.`,
                  cause,
                }),
            ),
          );
          parts.push({
            type: "image",
            base64Data: Buffer.from(bytes).toString("base64"),
            mediaType: attachment.mimeType,
          });
        }
        const text = [input.input?.trim() ?? "", ...notes].filter(Boolean).join("\n\n");
        return { text, parts };
      });

    const reasoningEffortFor = (
      selection: { readonly model: string; readonly options?: unknown } | undefined,
    ) => {
      if (!selection) return undefined;
      const effort = getModelSelectionStringOptionValue(selection as never, "reasoningEffort");
      if (!effort) return undefined;
      const model = options.models().find((entry) => entry.slug === selection.model);
      const descriptor = model?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "reasoningEffort",
      );
      if (!descriptor || descriptor.type !== "select") return effort;
      return descriptor.options.some((option) => option.id === effort) ? effort : undefined;
    };

    const sendTurn: MuseAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        ctx.lifecycle.withPermit(
          Effect.gen(function* () {
            // One turn at a time: a send while Muse works on its own turn
            // starts once that turn ends.
            if (ctx.activeTurn) yield* Deferred.await(ctx.activeTurn.done);
            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            const plan = input.interactionMode === "plan";
            yield* ensureHost(ctx, plan);
            // The user is talking again: earlier stops no longer gate wakes.
            ctx.stoppedWork.clear();
            const content = yield* inputParts("turn/start", input);
            if (!content.text && content.parts.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Turn for ${input.threadId} requires text or attachments.`,
              });
            }
            const selection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            if (selection && selection.model !== ctx.model) {
              yield* sessionCommand(ctx, "session/setModel", {
                model: { modelId: selection.model, providerId: options.providerId ?? "meta" },
              });
              ctx.model = selection.model;
              ctx.session = { ...ctx.session, model: selection.model };
            }
            const effort = reasoningEffortFor(selection);
            const host = yield* requireHost(ctx, "turn/start");
            const turnId = TurnId.make(host.host.mintCommandId());
            const preface = [
              ...(ctx.instructionsPending ? [instructionsFor(ctx)] : []),
              ...(plan ? [MUSE_PLAN_MODE_INSTRUCTION] : []),
            ];
            const userText = ctx.pendingSeed
              ? withContextSeedPreamble(ctx.pendingSeed, content.text)
              : content.text;
            const turn = yield* beginTurn(ctx, { turnId, origin: "user", plan });
            const sent = yield* sessionCommand(
              ctx,
              "turn/start",
              {
                input: [
                  ...preface.map((text) => ({ type: "text", text })),
                  ...(userText ? [{ type: "text", text: userText }] : []),
                  ...content.parts,
                ],
                displayText: content.text || "Image attachment",
                workspaceRoots: [ctx.workspaceRoot],
                ifBusy: "queue",
                ...(effort ? { reasoningEffort: effort } : {}),
              },
              { commandId: turnId },
            ).pipe(Effect.exit);
            if (Exit.isFailure(sent)) {
              yield* finishTurn(ctx, turn, {
                kind: "failed",
                message: `Muse Code did not accept the message: ${Cause.squash(sent.cause) instanceof Error ? (Cause.squash(sent.cause) as Error).message : String(Cause.squash(sent.cause))}`,
              });
            } else {
              const ack = decodeTurnStartResult(sent.value);
              if (Option.isSome(ack) && ack.value.disposition === "queued") ctx.queued.add(turnId);
              ctx.instructionsPending = false;
              ctx.pendingSeed = undefined;
            }
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          }),
        ),
      );

    const steerTurn: NonNullable<MuseAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turn = ctx.activeTurn;
        // Steering a turn whose visible work is done reaches only its background
        // checks, and the agent never answers: the message waits for the next turn.
        const steerable = Effect.suspend(() =>
          !turn || ctx.activeTurn !== turn || turn.turnId !== input.expectedTurnId
            ? Effect.fail(steerRejectedError(PROVIDER, "Muse Code", "no-active-turn"))
            : turn.stopRequested || turn.foregroundDone
              ? Effect.fail(steerRejectedError(PROVIDER, "Muse Code", "turn-finishing"))
              : Effect.succeed(turn),
        );
        yield* steerable;
        const content = yield* inputParts("turn/steer", input);
        // Reading attachments can outlast the turn's visible work.
        const live = yield* steerable;
        const result = yield* sessionCommand(ctx, "turn/steer", {
          expectedTurnId: live.turnId,
          input: [
            ...(content.text ? [{ type: "text", text: content.text }] : []),
            ...content.parts,
          ],
        });
        const ack = decodeTurnStartResult(result);
        if (Option.isSome(ack) && ack.value.turnId !== live.turnId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steer",
            detail: "Muse Code added the message to a different turn.",
          });
        }
        return {
          threadId: input.threadId,
          turnId: live.turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    /**
     * Stop means everything stops: queued input is withdrawn, subagents,
     * workflows and background commands are stopped, and their reports do not
     * wake the agent. If Muse has not ended the turn within the grace period,
     * the host is recycled and the turn ends interrupted.
     */
    const interruptTurn: MuseAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turn = ctx.activeTurn;
        // A stop that arrives late, for a turn that already ended, must not stop the next one.
        if (turnId !== undefined && turn?.turnId !== turnId) return;
        if (turn) turn.stopRequested = true;
        for (const queuedTurn of Array.from(ctx.queued)) {
          yield* sessionCommand(ctx, "turn/unqueue", { turnId: queuedTurn }).pipe(Effect.ignore);
        }
        for (const state of ctx.items.values()) {
          if (state.completed || state.item.status !== "inProgress") continue;
          if (state.item.kind === "subagent" && state.item.subagentId) {
            ctx.stoppedWork.add(state.item.itemId);
            yield* sessionCommand(ctx, "subagent/stop", { subagentId: state.item.subagentId }).pipe(
              Effect.ignore,
            );
          } else if (state.item.kind === "workflow" && state.item.workflowRunId) {
            ctx.stoppedWork.add(state.item.itemId);
            yield* sessionCommand(ctx, "workflow/cancel", {
              workflowRunId: state.item.workflowRunId,
            }).pipe(Effect.ignore);
          } else if (state.background) {
            ctx.stoppedWork.add(state.item.itemId);
          }
        }
        yield* sessionCommand(ctx, "task/stopAll", {}).pipe(Effect.ignore);
        for (const joinedTurn of Array.from(ctx.joined.keys())) {
          yield* sessionCommand(ctx, "turn/interrupt", { turnId: joinedTurn }).pipe(Effect.ignore);
        }
        yield* dropPendingRequests(ctx);
        if (!turn) return;
        yield* sessionCommand(ctx, "turn/interrupt", { turnId: turn.turnId }).pipe(Effect.ignore);
        const settled = yield* Deferred.await(turn.done).pipe(
          Effect.timeoutOption(STOP_SETTLE_TIMEOUT),
        );
        if (Option.isSome(settled) || ctx.activeTurn !== turn) return;
        yield* emit({
          type: "runtime.warning",
          ...(yield* eventBase(ctx, turn.turnId)),
          payload: { message: "Muse Code did not stop in time; restarting it." },
        } as ProviderRuntimeEvent);
        // The host goes before the turn ends. A send waiting for this turn
        // holds the lifecycle permit, so taking it here would wait forever,
        // and closing after the turn ends would close the host the next turn
        // starts on. Nothing uses the host while the turn is active (that
        // send waits first), and closeHost detaches it at once.
        yield* closeHost(ctx);
        // Subagents, workflows and background commands went with the host
        // (the turn's own become background work as it ends).
        const lost = [...ctx.items.values()].filter((state) => !state.completed);
        yield* finishTurn(ctx, turn, { kind: "interrupted", reason: "user" });
        for (const state of lost) yield* endBackground(ctx, state, "interrupted");
      });

    const respondToRequest: MuseAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.approvals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "approval/decide",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        const choice = museChoicesByDecision(pending.approval.availableChoices).get(decision);
        if (!choice) {
          if (decision === "cancel") {
            yield* interruptTurn(threadId);
            return;
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "approval/decide",
            detail: "Muse Code did not offer that answer for this request.",
          });
        }
        // Recorded first: Muse can settle the approval before it acknowledges.
        pending.decided = decision;
        const result = yield* decideApproval(ctx, pending.approval, choice).pipe(
          Effect.tapError(() => Effect.sync(() => (pending.decided = undefined))),
        );
        // A multi-stage approval stays open for its next stage (it arrives as an update).
        if (result.terminal !== false) yield* resolveApproval(ctx, requestId, decision);
      });

    const respondToUserInput: MuseAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.questions.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "userInput/answer",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        const entries = pending.input.questions.map((question) => {
          const raw = answers[question.id];
          const values = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
            .map((value) => String(value).trim())
            .filter(Boolean);
          const labels = new Set(question.options.map((option) => option.label.trim()));
          const selected = values.filter((value) => labels.has(value));
          const freeText = values
            .filter((value) => !labels.has(value))
            .join("\n")
            .slice(0, ANSWER_TEXT_MAX);
          return { question, selected, freeText };
        });
        const answered = entries.some((entry) => entry.selected.length > 0 || entry.freeText);
        if (!answered) {
          yield* sessionCommand(ctx, "userInput/cancel", {
            userInputId: pending.input.userInputId,
            reason: "The user dismissed the question without answering.",
          });
        } else {
          yield* sessionCommand(ctx, "userInput/answer", {
            userInputId: pending.input.userInputId,
            answers: entries.map(({ question, selected, freeText }) => {
              const multiple = question.selection.mode === "multiple";
              if (selected.length === 0)
                return { questionId: question.id, freeText: freeText || "(no answer)" };
              return {
                questionId: question.id,
                ...(multiple ? { selectedLabels: selected } : { selectedLabel: selected[0] }),
                ...(freeText ? { note: freeText } : {}),
              };
            }),
          });
        }
        yield* resolveQuestion(ctx, requestId, answers);
      });

    const compactContext: NonNullable<MuseAdapterShape["compactContext"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const raw = yield* sessionCommand(ctx, "session/compact", {});
        const result = decodeCompactResult(raw);
        if (Option.isSome(result) && result.value.status === "noop") {
          yield* emit({
            type: "runtime.warning",
            ...(yield* eventBase(ctx, ctx.activeTurn?.turnId)),
            payload: { message: "Muse Code had nothing to compact yet." },
          } as ProviderRuntimeEvent);
        }
      });

    /** Threadlines trims its own turn list; Muse still remembers the reverted turns. */
    const rollbackThread: MuseAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })) };
      });

    /** A subagent's conversation, when Muse can read its session; else its brief and result. */
    const readSubagentTranscript: NonNullable<MuseAdapterShape["readSubagentTranscript"]> = (
      threadId,
      input,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const state = [...ctx.items.values()].find(
          (entry) =>
            entry.item.kind === "subagent" &&
            (entry.item.childSessionId === input.agentId ||
              entry.item.subagentId === input.agentId ||
              entry.item.itemId === input.agentId),
        );
        if (!state) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readSubagentTranscript",
            detail: `Agent ${input.agentId} does not belong to this thread.`,
          });
        }
        const entries: Array<ProviderSubagentTranscriptEntry> = [];
        const childSessionId = state.item.childSessionId;
        const read = childSessionId
          ? yield* Effect.flatMap(requireHost(ctx, "session/read"), (host) =>
              host.host.request("session/read", { sessionId: childSessionId, excludeItems: false }),
            ).pipe(
              Effect.map(decodeSessionResult),
              Effect.orElseSucceed(() => Option.none()),
            )
          : Option.none<MuseSessionResult>();
        const items = Option.isSome(read) ? (read.value.history?.items ?? []) : [];
        for (const item of items) {
          if (item.kind === "userMessage" && item.text) {
            entries.push({ id: item.itemId, role: "user", text: item.text, toolUses: [] });
          } else if (item.kind === "agentMessage" && item.text) {
            entries.push({ id: item.itemId, role: "assistant", text: item.text, toolUses: [] });
          } else if (item.kind === "reasoning" && item.summary?.length) {
            entries.push({ role: "thinking", text: item.summary.join("\n\n"), toolUses: [] });
          } else if (item.kind === "toolCall") {
            const identity = identifyMuseTool(item);
            entries.push({
              id: item.itemId,
              role: "assistant",
              text: "",
              toolUses: [
                {
                  name: item.tool ?? identity.title,
                  summary: museToolDetail(item, identity) ?? identity.title,
                },
              ],
              ...(item.visibleOutput ? { outputPreview: item.visibleOutput.slice(0, 2_000) } : {}),
              ...(museItemFailed(item) ? { outputIsError: true } : {}),
            });
          }
        }
        if (entries.length === 0) {
          if (state.item.objective) {
            entries.push({ role: "user", text: state.item.objective, toolUses: [] });
          }
          const result = state.item.result?.text ?? state.item.result?.summary;
          if (result) entries.push({ role: "assistant", text: result, toolUses: [] });
        }
        const total = entries.length;
        const limit = input.limit && input.limit > 0 ? input.limit : total;
        const offset = input.fromEnd
          ? Math.max(0, total - limit)
          : Math.min(input.offset ?? 0, total);
        return {
          entries: entries.slice(offset, offset + limit),
          truncated: offset + limit < total || offset > 0,
          offset,
          totalEntries: total,
          agent: {
            id: input.agentId,
            ...(state.item.role ? { agentType: state.item.role } : {}),
            ...(state.item.objective ? { description: state.item.objective.slice(0, 200) } : {}),
            directInput: "parentOnly",
          },
        };
      });

    const stopSession: MuseAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        // Background work nobody would hear from is stopped with the host.
        if (ctx.host && !ctx.host.closing) {
          yield* sessionCommand(ctx, "task/stopAll", {}).pipe(
            Effect.ignore,
            Effect.timeoutOption(Duration.seconds(3)),
          );
        }
        yield* ctx.lifecycle.withPermit(stopContext(ctx, undefined));
      });

    const stopAll: MuseAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.keys()], stopSession, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        manualContextCompaction: "supported",
        activeTurnSteering: "supported",
        nativeThreadFork: "supported",
        conversationRollback: "none",
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      compactContext,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()].map((ctx) => ({
            ...ctx.session,
            pendingBackgroundTaskCount: [...ctx.items.values()].filter((state) => state.background)
              .length,
          })),
        ),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (ctx) => ({
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: [] })),
        })),
      rollbackThread,
      readSubagentTranscript,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies MuseAdapterShape;
  });
}
