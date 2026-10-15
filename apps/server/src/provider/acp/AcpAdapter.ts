/**
 * AcpAdapter — generic `ProviderAdapterShape` for any ACP agent.
 *
 * One ACP child process per thread. Session setup, prompt streaming, mode
 * selection, permission requests and cancellation are protocol-level and
 * identical across agents; a descriptor contributes the spawn command, the
 * model-option mapping and optional vendor extension handlers.
 *
 * @module provider/acp/AcpAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  isProviderPlanGateMessage,
  isProviderPlanGateReply,
} from "@threadlines/shared/providerPlan";
import { renderThreadContextSeed, withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { countTextReplacementStats } from "@threadlines/shared/diffStats";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import { PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { ROOM_MCP_SERVER_NAME } from "../../mcp/roomToolAccess.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  acpAvailableDecisions,
  acpPermissionOptionId,
  isAcpAuthRequiredError,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "./AcpNativeLogging.ts";
import type {
  AcpExtensionContext,
  AcpProviderDescriptor,
  AcpProviderSettings,
  AcpTurnOutcome,
} from "./AcpProviderDescriptor.ts";
import {
  applyAcpModelSelection,
  defaultResolveAcpModelId,
  makeAcpProviderRuntime,
} from "./AcpProviderRuntime.ts";
import {
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  parsePermissionRequest,
} from "./AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const ACP_RESUME_VERSION = 1 as const;
/**
 * How long a cancelled prompt may take to return. Past it the turn settles
 * as cancelled here and the process is recycled; the next turn resumes the
 * conversation in a fresh one.
 */
const ACP_CANCEL_DEADLINE = Duration.seconds(15);
/**
 * An agent's own turn (see `agentTurns`) that has gone this long without
 * output is closed here, in case its end notice never comes. Long: a command
 * running inside the turn reports nothing until it changes or ends.
 */
const ACP_AGENT_TURN_QUIET_LIMIT = Duration.minutes(15);
const ACP_AGENT_TURN_QUIET_CHECK = Duration.seconds(30);
/**
 * The most turns a resume cursor remembers the agent's prompt positions for
 * (see `conversationHistory`); a revert further back trims Threadlines' turn
 * list only.
 */
const ACP_HISTORY_CURSOR_LIMIT = 200;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export type AcpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface AcpAdapterOptions<Settings extends AcpProviderSettings> {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored when `modelSelection.instanceId` matches this value. */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. Production binds settings to the
   * instance scope (the hydration layer rebuilds the adapter on config
   * change); tests that swap `binaryPath` mid-suite pass a live resolver.
   */
  readonly resolveSettings?: Effect.Effect<Settings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface AcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  /** The in-flight `session/prompt`; ACP runs one prompt per session at a time. */
  promptFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /** This session's turns in order, for the agent's own rewind and fork. */
  history: Array<AcpHistoryEntry>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Head of the current turn's assistant text, kept for plan-gate detection. */
  activeTurnText: string;
  /** Last provider status this turn (fx rate-limit retries etc.), for failure detail. */
  lastProviderStatus: string | undefined;
  /** Last context fill reported, so repeated identical `usage_update`s stay quiet. */
  lastContextUsageKey: string | undefined;
  /** The thought being streamed; closes when reply text, a tool call, or the turn end arrives. */
  activeReasoning: { readonly itemId: string; readonly turnId: TurnId; text: string } | undefined;
  /** The session cwd and its real path: agents report real paths (macOS `/private/tmp`). */
  readonly cwdRoots: ReadonlyArray<string>;
  /** The turn a `session/cancel` was sent for, so the agent's cancel notice is dropped. */
  cancelledTurnId: TurnId | undefined;
  /** The plan the agent wrote this turn (prompt-command plan mode). */
  planMarkdown: string | undefined;
  /** Earlier conversation for an agent that starts without it, sent with the first turn. */
  pendingContextPreamble: string | undefined;
  /** Held while a turn starts, so concurrent sends queue instead of racing. */
  readonly turnStartLock: Semaphore.Semaphore;
  /** The active turn is one the agent started itself; settled when it ends. */
  agentTurn: { readonly turnId: TurnId; readonly ended: Deferred.Deferred<void> } | undefined;
  /** When the agent's own turn last produced anything (ms since epoch). */
  agentTurnLastActivityMs: number;
  /** The turn each running tool call started in, for updates that land after it. */
  readonly toolCallTurns: Map<string, TurnId>;
  /** How the agent said the running prompt ended, from its own notice. */
  promptOutcome: AcpTurnOutcome | undefined;
  stopped: boolean;
}

/** Plan-gate replies are one short sentence; more text than this is content. */
const PLAN_GATE_SCAN_MAX_CHARS = 500;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One Threadlines turn on a session, and where its prompt sits in the
 * agent's own history once the agent has said (see `conversationHistory`).
 */
interface AcpHistoryEntry {
  readonly turnId: string;
  /** The user message the turn sent. */
  readonly messageId?: string;
  /** A turn the agent started itself: it sent no prompt, so it has no position. */
  readonly agentTurn?: true;
  position?: number;
}

function parseHistoryEntry(raw: unknown): AcpHistoryEntry | undefined {
  if (!isRecord(raw) || typeof raw.turnId !== "string" || !raw.turnId) return undefined;
  return {
    turnId: raw.turnId,
    ...(typeof raw.messageId === "string" && raw.messageId ? { messageId: raw.messageId } : {}),
    ...(raw.agentTurn === true ? { agentTurn: true as const } : {}),
    ...(typeof raw.position === "number" && Number.isInteger(raw.position) && raw.position >= 0
      ? { position: raw.position }
      : {}),
  };
}

export function parseAcpResumeCursor(
  raw: unknown,
): { sessionId: string; history: ReadonlyArray<AcpHistoryEntry> } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const history = Array.isArray(raw.history)
    ? raw.history.flatMap((entry) => parseHistoryEntry(entry) ?? [])
    : [];
  return { sessionId: raw.sessionId.trim(), history };
}

function makeAcpResumeCursor(sessionId: string, history: ReadonlyArray<AcpHistoryEntry>) {
  return {
    schemaVersion: ACP_RESUME_VERSION,
    sessionId,
    ...(history.length > 0
      ? { history: history.slice(-ACP_HISTORY_CURSOR_LIMIT).map((entry) => ({ ...entry })) }
      : {}),
  };
}

/**
 * Where a fork's copy of the source conversation is rewound to, by the
 * boundary the fork asks for: before a turn (its prompt and what came after
 * go), or through one (the next prompt after it and what follows go).
 * `undefined` keeps the whole copy; `"unknown"` when the source's positions
 * don't cover the boundary, and the fork can't be made exactly.
 */
function forkRewindPosition(
  history: ReadonlyArray<AcpHistoryEntry> | undefined,
  boundary: {
    readonly beforeTurnId?: string | undefined;
    readonly lastTurnId?: string | undefined;
  },
): number | undefined | "unknown" {
  if (boundary.beforeTurnId === undefined && boundary.lastTurnId === undefined) return undefined;
  if (history === undefined) return "unknown";
  if (boundary.beforeTurnId !== undefined) {
    return history.find((entry) => entry.turnId === boundary.beforeTurnId)?.position ?? "unknown";
  }
  const index = history.findIndex((entry) => entry.turnId === boundary.lastTurnId);
  if (index < 0) return "unknown";
  // The agent's own turns right after it stay with it: they have no prompt
  // to rewind to.
  const next = history.slice(index + 1).find((entry) => entry.agentTurn !== true);
  if (next === undefined) return undefined;
  return next.position ?? "unknown";
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

/**
 * Picks the ACP session mode for the requested interaction/runtime mode.
 * Exported for tests; agents name their modes differently, so matching is
 * alias-based with a "first non-plan mode" fallback.
 */
export function resolveRequestedAcpModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

/**
 * File-change evidence from a finished edit's ACP `diff` content: exact
 * per-file +/- for paths inside the session's workspace. Only an edit that
 * completed counts; a denied or failed one changed nothing. A relative path
 * is the agent's, so it resolves against the session cwd (`cwdRoots[0]`).
 */
export function acpDiffFileChanges(
  toolCall: AcpToolCallState,
  cwdRoots: ReadonlyArray<string>,
  pathApi: Pick<Path.Path, "relative" | "isAbsolute" | "resolve" | "sep">,
): ReadonlyArray<{
  readonly path: string;
  readonly kind: "add" | "update" | "delete";
  readonly additions: number;
  readonly deletions: number;
}> {
  if (toolCall.status !== "completed") return [];
  if (toolCall.kind !== "edit" && toolCall.kind !== "delete" && toolCall.kind !== "move") return [];
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry: unknown) => {
    if (!isRecord(entry) || entry.type !== "diff") return [];
    const { path: filePath, oldText, newText } = entry;
    if (typeof filePath !== "string" || typeof newText !== "string") return [];
    const sessionCwd = cwdRoots[0];
    const absolute =
      pathApi.isAbsolute(filePath) || sessionCwd === undefined
        ? filePath
        : pathApi.resolve(sessionCwd, filePath);
    const relative = relativeToAnyRoot(absolute, cwdRoots, pathApi);
    if (relative === undefined) return [];
    const before = typeof oldText === "string" ? oldText : undefined;
    const stats = countTextReplacementStats(before, newText);
    const kind =
      toolCall.kind === "delete" && newText.length === 0
        ? "delete"
        : before === undefined
          ? "add"
          : "update";
    return [{ path: relative, kind, ...stats }];
  });
}

function relativeToAnyRoot(
  filePath: string,
  roots: ReadonlyArray<string>,
  pathApi: Pick<Path.Path, "relative" | "isAbsolute" | "sep">,
): string | undefined {
  for (const root of roots) {
    const relative = pathApi.relative(root, filePath);
    if (relative.length > 0 && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      return relative.split(pathApi.sep).join("/");
    }
  }
  return undefined;
}

export function makeAcpAdapter<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  settings: Settings,
  options?: AcpAdapterOptions<Settings>,
) {
  const PROVIDER = descriptor.driverKind;
  const resolveModelId = descriptor.resolveModelId ?? defaultResolveAcpModelId;
  const extensionSource = descriptor.extensions?.source;

  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, AcpSessionContext>();
    /**
     * Each agent session's turn history by its id, kept after the session
     * stops: a fork of it finds its boundary here.
     */
    const historyBySession = new Map<string, ReadonlyArray<AcpHistoryEntry>>();
    const adapterScope = yield* Scope.Scope;
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    /** Saves the session's turn history in its resume cursor, and for forks of it. */
    const recordHistory = (ctx: AcpSessionContext) => {
      const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
      if (sessionId === undefined) return;
      ctx.session = { ...ctx.session, resumeCursor: makeAcpResumeCursor(sessionId, ctx.history) };
      historyBySession.set(
        sessionId,
        ctx.history.map((entry) => ({ ...entry })),
      );
    };

    /**
     * Asks the agent where the prompt this turn sent sits in its history,
     * once the turn has ended, for a later revert or fork to rewind to.
     */
    const recordPromptPosition = (ctx: AcpSessionContext, turnId: TurnId, promptText: string) =>
      Effect.gen(function* () {
        const history = descriptor.conversationHistory;
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        const entry = ctx.history.find((candidate) => candidate.turnId === turnId);
        if (history === undefined || sessionId === undefined || entry === undefined) return;
        const position = yield* history
          .promptPosition({ acp: ctx.acp, sessionId, promptText })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("acp.history.position-unavailable", {
                provider: PROVIDER,
                threadId: ctx.threadId,
                cause: cause.message,
              }).pipe(Effect.as(undefined)),
            ),
          );
        if (position === undefined) return;
        entry.position = position;
        recordHistory(ctx);
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    /**
     * ACP streams reasoning as `agent_thought_chunk`s. A run of them becomes
     * one "Thinking" reasoning item, the same shape Claude's thinking blocks
     * take: started on the first chunk, the text streamed as a readable
     * summary, and the whole thought carried on completion.
     */
    const appendReasoning = (ctx: AcpSessionContext, text: string, rawPayload: unknown) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (!turnId) {
          return;
        }
        if (!ctx.activeReasoning) {
          ctx.activeReasoning = { itemId: `reasoning:${yield* randomUUIDv4}`, turnId, text: "" };
          yield* offerRuntimeEvent({
            type: "item.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(ctx.activeReasoning.itemId),
            payload: { itemType: "reasoning", status: "inProgress", title: "Thinking" },
          });
        }
        ctx.activeReasoning.text += text;
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(ctx.activeReasoning.itemId),
          payload: { streamKind: "reasoning_summary_text", delta: text },
          raw: { source: "acp.jsonrpc", method: "session/update", payload: rawPayload },
        });
      });

    const closeReasoning = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        const reasoning = ctx.activeReasoning;
        if (!reasoning) {
          return;
        }
        ctx.activeReasoning = undefined;
        const summary = reasoning.text.trim();
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: reasoning.turnId,
          itemId: RuntimeItemId.make(reasoning.itemId),
          payload: {
            itemType: "reasoning",
            status: "completed",
            title: "Thinking",
            ...(summary.length > 0 ? { data: { summary } } : {}),
          },
        });
      });

    const emitPlanUpdate = (
      ctx: AcpSessionContext,
      payload: AcpPlanUpdate,
      rawPayload: unknown,
      source: "acp.jsonrpc" | `acp.${string}.extension`,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    /** Clears what a turn accumulates, for a turn starting now. */
    const resetTurnState = (ctx: AcpSessionContext) => {
      ctx.lastPlanFingerprint = undefined;
      ctx.activeTurnText = "";
      ctx.lastProviderStatus = undefined;
      ctx.cancelledTurnId = undefined;
      ctx.planMarkdown = undefined;
      ctx.promptOutcome = undefined;
    };

    /**
     * Opens a turn the agent started itself (`agentTurns`): its wake-up
     * after background work, opened on the extension's notice or on the
     * first output that arrives while no turn runs, the way Claude's
     * synthetic turns open.
     */
    const openAgentTurn = (ctx: AcpSessionContext, raw: { method: string; payload: unknown }) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.activeTurnId !== undefined) return;
        const turnId = TurnId.make(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.agentTurn = { turnId, ended: yield* Deferred.make<void>() };
        ctx.agentTurnLastActivityMs = Date.now();
        ctx.history.push({ turnId, agentTurn: true });
        recordHistory(ctx);
        resetTurnState(ctx);
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {},
          raw: {
            source: extensionSource ?? "acp.jsonrpc",
            method: raw.method,
            payload: raw.payload,
          },
        });
        yield* watchAgentTurnQuiet(ctx, turnId).pipe(Effect.forkIn(ctx.scope));
      });

    /** Closes the agent's own turn once every update queued before the end is out. */
    const closeAgentTurn = (ctx: AcpSessionContext, outcome: AcpTurnOutcome) =>
      Effect.gen(function* () {
        const agentTurn = ctx.agentTurn;
        if (agentTurn === undefined) return;
        yield* ctx.acp.flushEvents;
        if (ctx.agentTurn !== agentTurn) return;
        yield* closeReasoning(ctx);
        ctx.agentTurn = undefined;
        if (ctx.activeTurnId === agentTurn.turnId) ctx.activeTurnId = undefined;
        ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: agentTurn.turnId,
          payload: {
            state: outcome.state,
            stopReason: outcome.stopReason ?? null,
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          },
        });
        yield* Deferred.succeed(agentTurn.ended, undefined);
      });

    /** Closes an agent turn whose end notice never came, after a long quiet. */
    const watchAgentTurnQuiet = (ctx: AcpSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        while (ctx.agentTurn?.turnId === turnId) {
          yield* Effect.sleep(ACP_AGENT_TURN_QUIET_CHECK);
          if (ctx.agentTurn?.turnId !== turnId) return;
          if (
            Date.now() - ctx.agentTurnLastActivityMs >=
            Duration.toMillis(ACP_AGENT_TURN_QUIET_LIMIT)
          ) {
            yield* closeAgentTurn(ctx, { state: "completed" });
            return;
          }
        }
      });

    /**
     * The turn an update belongs to: for a tool call that started in an
     * earlier turn (a background shell), that turn; else the active one;
     * else, for an agent that starts its own turns, a new agent turn.
     */
    const turnForOutput = (ctx: AcpSessionContext, toolCallId?: string) =>
      Effect.gen(function* () {
        if (ctx.agentTurn !== undefined) ctx.agentTurnLastActivityMs = Date.now();
        const earlier = toolCallId === undefined ? undefined : ctx.toolCallTurns.get(toolCallId);
        if (earlier !== undefined) return earlier;
        if (ctx.activeTurnId !== undefined) return ctx.activeTurnId;
        if (!descriptor.agentTurns) return undefined;
        yield* openAgentTurn(ctx, { method: "session/update", payload: {} });
        return ctx.activeTurnId;
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.promptFiber) {
          yield* Fiber.interrupt(ctx.promptFiber);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * Tells the descriptor when the agent answered `auth_required`, given the
     * ACP error or the adapter error that wraps it. Never fails or dies: a
     * turn must complete whatever the hook does.
     */
    const notifyAuthRequired = (error: unknown): Effect.Effect<void> => {
      const onAuthRequired = descriptor.onAuthRequired;
      if (!onAuthRequired) return Effect.void;
      const wrapped =
        typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
      if (!isAcpAuthRequiredError(error) && !isAcpAuthRequiredError(wrapped)) return Effect.void;
      return Effect.suspend(() => onAuthRequired(settings)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ACP onAuthRequired hook failed", {
            provider: PROVIDER,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const applyRequestedSessionConfiguration = (input: {
      readonly runtime: AcpSessionRuntimeShape;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode | undefined;
      readonly modelSelection:
        | {
            readonly model: string;
            readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
          }
        | undefined;
    }): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (input.modelSelection) {
          yield* applyAcpModelSelection({
            descriptor,
            runtime: input.runtime,
            model: input.modelSelection.model,
            selections: input.modelSelection.options,
            mapError: ({ cause }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });
        }

        // Native controls: the agent's mode is the user's to pick (an option),
        // never inferred from the runtime mode.
        if (descriptor.sessionControls === "native") {
          return;
        }
        const modeState = yield* input.runtime.getModeState;
        const mappedModeId = descriptor.agentModeFor?.({
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
        });
        const requestedModeId =
          mappedModeId !== undefined &&
          modeState?.availableModes.some((mode) => mode.id === mappedModeId)
            ? mappedModeId
            : resolveRequestedAcpModeId({
                interactionMode: input.interactionMode,
                runtimeMode: input.runtimeMode,
                modeState,
              });
        if (!requestedModeId) {
          return;
        }
        yield* input.runtime
          .setMode(requestedModeId)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
            ),
          );
        // An agent can also answer `auth_required` to a model or option change.
      }).pipe(Effect.tapError(notifyAuthRequired));

    const startSession: AcpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          // A side answer must be read-only for certain; this driver cannot
          // promise that, so it never runs one.
          if (input.lockdown !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "This provider cannot answer on the side while another agent works.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
          const boundModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AcpSessionContext;

          const resumed = parseAcpResumeCursor(input.resumeCursor);
          const resumeSessionId = resumed?.sessionId;
          // A native fork opens on the agent's copy of the source conversation,
          // rewound to the boundary. One it can't make exactly fails here, and
          // the caller seeds the thread from its transcript instead.
          const conversationHistory = descriptor.conversationHistory;
          let forkRewind: number | undefined;
          if (input.forkFrom !== undefined) {
            const rewindTo =
              conversationHistory === undefined
                ? "unknown"
                : forkRewindPosition(
                    historyBySession.get(input.forkFrom.providerThreadId),
                    input.forkFrom,
                  );
            if (rewindTo === "unknown") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "This conversation can't be forked at that turn.",
              });
            }
            forkRewind = rewindTo;
          }
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const effectiveSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : settings;
          // The browser the user has open, offered as tools: the same HTTP
          // endpoint Codex and Claude use, with a credential naming the thread
          // because the tools take no thread argument. In a room, the room
          // tools too, on the same credential. Neither when the agent cannot
          // reach this machine's loopback (fx under WSL). The credential dies
          // with the session's scope.
          const reachesHost = descriptor.reachesHostLoopback?.(process.platform) !== false;
          const roomToolsRequested = input.roomTools === true;
          // The page tools ride the same credential. An ACP agent hears no
          // instructions of ours, so the tool descriptions carry the rules and
          // a misplaced image's error names the thread's image folder.
          const agentPagesRequested = input.agentPages === true;
          const credential = reachesHost
            ? yield* mcpSessionRegistry.credentialFor({
                sessionKey: input.threadId,
                browser: true,
                room: roomToolsRequested,
                pages: agentPagesRequested,
              })
            : undefined;
          if (credential !== undefined) {
            yield* Scope.addFinalizer(
              sessionScope,
              mcpSessionRegistry.revoke(input.threadId, credential.generation),
            );
          }
          const authorization = [
            { name: "Authorization", value: `Bearer ${credential?.token ?? ""}` },
          ];
          const mcpServers: Array<EffectAcpSchema.McpServer> =
            credential === undefined
              ? []
              : [
                  {
                    type: "http",
                    name: BROWSER_MCP_SERVER_NAME,
                    url: mcpEndpointUrl(serverConfig.port),
                    headers: authorization,
                  },
                  ...(roomToolsRequested
                    ? [
                        {
                          type: "http" as const,
                          name: ROOM_MCP_SERVER_NAME,
                          url: mcpRoomEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(agentPagesRequested
                    ? [
                        {
                          type: "http" as const,
                          name: PAGES_MCP_SERVER_NAME,
                          url: mcpPagesEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                ];

          const acp = yield* makeAcpProviderRuntime(descriptor, {
            settings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(input.forkFrom !== undefined && conversationHistory !== undefined
              ? {
                  forkFrom: {
                    sessionId: input.forkFrom.providerThreadId,
                    fork: conversationHistory.fork,
                  },
                }
              : resumeSessionId
                ? { resumeSessionId }
                : {}),
            clientInfo: { name: "threadlines", version: "0.0.0" },
            mcpServers,
            runtimeMode: input.runtimeMode,
            ...(descriptor.agentTurns ? { liveOutsidePrompt: true } : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const requestUserInput: AcpExtensionContext["requestUserInput"] = (request) =>
            Effect.gen(function* () {
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { questions: request.questions },
                ...(extensionSource
                  ? {
                      raw: {
                        source: extensionSource,
                        method: request.method,
                        payload: request.payload,
                      },
                    }
                  : {}),
              });
              const resolved = yield* Deferred.await(answers);
              pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              return resolved;
            });

          const extensionContext: AcpExtensionContext = {
            threadId: input.threadId,
            acp,
            sessionId: () => parseAcpResumeCursor(ctx?.session.resumeCursor)?.sessionId,
            activeTurnId: () => ctx?.activeTurnId,
            logNative: (method, payload) => logNative(input.threadId, method, payload),
            requestUserInput,
            emitProposedPlan: (request) =>
              Effect.gen(function* () {
                yield* offerRuntimeEvent({
                  type: "turn.proposed.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  payload: { planMarkdown: request.planMarkdown },
                  ...(extensionSource
                    ? {
                        raw: {
                          source: extensionSource,
                          method: request.method,
                          payload: request.payload,
                        },
                      }
                    : {}),
                });
              }),
            emitPlanUpdate: (request) =>
              ctx && extensionSource
                ? emitPlanUpdate(
                    ctx,
                    request.plan,
                    request.payload,
                    extensionSource,
                    request.method,
                  )
                : Effect.void,
            emitRuntimeEvent: (request) =>
              Effect.gen(function* () {
                const turnId = request.event.turnId ?? ctx?.activeTurnId;
                const event = {
                  ...request.event,
                  ...(turnId ? { turnId } : {}),
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  ...(extensionSource
                    ? {
                        raw: {
                          source: extensionSource,
                          method: request.method,
                          payload: request.payload,
                        },
                      }
                    : {}),
                } as ProviderRuntimeEvent;
                yield* offerRuntimeEvent(event);
              }),
            beginAgentTurn: (request) => (ctx ? openAgentTurn(ctx, request) : Effect.void),
            endAgentTurn: (request) => (ctx ? closeAgentTurn(ctx, request.outcome) : Effect.void),
            reportPromptOutcome: (outcome) =>
              Effect.sync(() => {
                if (ctx && ctx.activeTurnId !== undefined && ctx.agentTurn === undefined) {
                  ctx.promptOutcome = outcome;
                }
              }),
          };

          const started = yield* Effect.gen(function* () {
            if (descriptor.extensions) {
              yield* descriptor.extensions.register(extensionContext);
            }
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const selected = (optionId: string | undefined) =>
                  optionId === undefined
                    ? { outcome: { outcome: "cancelled" as const } }
                    : { outcome: { outcome: "selected" as const, optionId } };
                // A question in permission clothing goes to the user, whatever
                // the runtime mode: auto-approving would answer for them.
                const question = descriptor.classifyPermissionRequest?.(params);
                if (question) {
                  const answers = yield* requestUserInput({
                    method: "session/request_permission",
                    payload: params,
                    questions: question.questions,
                  });
                  return selected(question.optionIdForAnswers(answers));
                }
                const permissionRequest = parsePermissionRequest(params);
                const planFileWrite =
                  permissionRequest.toolCall !== undefined &&
                  descriptor.planMode?.isPlanFile(permissionRequest.toolCall) === true;
                if (planFileWrite && permissionRequest.toolCall) {
                  const planMarkdown = descriptor.planMode?.planMarkdown(
                    permissionRequest.toolCall,
                  );
                  if (planMarkdown !== undefined && ctx) ctx.planMarkdown = planMarkdown;
                }
                // Options whose "always" outlives the session are never ours to pick.
                const offered = descriptor.isLastingPermissionOption
                  ? params.options.filter(
                      (option) => !descriptor.isLastingPermissionOption!(option),
                    )
                  : params.options;
                // Full access answers each request once: an "always" option
                // would leave a standing rule behind in the agent's own store.
                // A request with no "once" to give goes to the user instead.
                if (input.runtimeMode === "full-access" || planFileWrite) {
                  const once = acpPermissionOptionId("accept", offered);
                  if (once !== undefined) return selected(once);
                }
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                const warningFor = (kind: EffectAcpSchema.PermissionOption["kind"]) => {
                  const option = offered.find((candidate) => candidate.kind === kind);
                  return option ? descriptor.permissionOptionWarning?.(option) : undefined;
                };
                const acceptForSessionWarning = warningFor("allow_always");
                const acceptWarning = warningFor("allow_once");
                const decisionWarnings =
                  acceptForSessionWarning || acceptWarning
                    ? {
                        ...(acceptWarning ? { accept: acceptWarning } : {}),
                        ...(acceptForSessionWarning
                          ? { acceptForSession: acceptForSessionWarning }
                          : {}),
                      }
                    : undefined;
                const availableDecisions = acpAvailableDecisions(offered);
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    ...(availableDecisions ? { availableDecisions } : {}),
                    ...(decisionWarnings ? { decisionWarnings } : {}),
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return resolved === "cancel"
                  ? { outcome: { outcome: "cancelled" as const } }
                  : selected(acpPermissionOptionId(resolved, offered));
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.tapError(notifyAuthRequired),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (forkRewind !== undefined && conversationHistory !== undefined) {
            yield* conversationHistory
              .rewind({ acp, sessionId: started.sessionId, position: forkRewind })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/fork", error),
                ),
              );
          }

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: boundModelSelection,
          });

          // A resumed conversation keeps the turn history its cursor carried.
          const history =
            resumed !== undefined &&
            started.sessionId === resumed.sessionId &&
            started.resumeFailure === undefined
              ? resumed.history.map((entry) => ({ ...entry }))
              : [];
          const now = yield* nowIso;
          // ACP passes an HTTP server only to an agent that says it speaks
          // HTTP MCP (see supportedMcpServers); without that, it has no room
          // tools, and says so.
          const roomToolsAttached =
            credential !== undefined &&
            started.initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: boundModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: makeAcpResumeCursor(started.sessionId, history),
            ...(roomToolsRequested ? { roomTools: roomToolsAttached } : {}),
            ...(started.resumeFailure !== undefined ? { resumeFailed: true } : {}),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            promptFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            history,
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            activeTurnText: "",
            lastProviderStatus: undefined,
            lastContextUsageKey: undefined,
            activeReasoning: undefined,
            cwdRoots: realCwd === cwd ? [cwd] : [cwd, realCwd],
            cancelledTurnId: undefined,
            planMarkdown: undefined,
            // A switch from another agent starts without the history: the
            // thread hands it over. (A failed resume is seeded by the reactor.)
            pendingContextPreamble:
              input.contextSeed !== undefined && resumeSessionId === undefined
                ? renderThreadContextSeed(input.contextSeed)
                : undefined,
            turnStartLock: yield* Semaphore.make(1),
            agentTurn: undefined,
            agentTurnLastActivityMs: 0,
            toolCallTurns: new Map(),
            promptOutcome: undefined,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "SessionStatus":
                    if (event.message === ctx.lastProviderStatus) {
                      return;
                    }
                    ctx.lastProviderStatus = event.message;
                    // Narrate provider-side recovery (rate-limit retries) on
                    // the live turn so it doesn't read as a hang.
                    if (ctx.activeTurnId) {
                      yield* offerRuntimeEvent({
                        type: "turn.status.updated",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: { statusMessage: event.message },
                      });
                    }
                    return;
                  case "ContextUsage": {
                    // Drives the composer's context meter, same event Codex
                    // and Claude send. Not gated on a prompt: the fill after a
                    // resumed session's replay is still the right reading.
                    const usageKey = `${event.usedTokens}/${event.maxTokens ?? ""}`;
                    if (usageKey === ctx.lastContextUsageKey) {
                      return;
                    }
                    ctx.lastContextUsageKey = usageKey;
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {
                          usedTokens: event.usedTokens,
                          ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
                        },
                      },
                    });
                    return;
                  }
                  case "ModeChanged":
                    return;
                  case "ReasoningDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* turnForOutput(ctx);
                    yield* appendReasoning(ctx, event.text, event.rawPayload);
                    return;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted": {
                    yield* closeReasoning(ctx);
                    const turnId =
                      event._tag === "AssistantItemStarted"
                        ? yield* turnForOutput(ctx)
                        : ctx.activeTurnId;
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated":
                    yield* turnForOutput(ctx);
                    yield* closeReasoning(ctx);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    yield* closeReasoning(ctx);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    // The plan card stands for the agent's plan-file writes.
                    if (descriptor.planMode?.isPlanFile(event.toolCall)) {
                      const planMarkdown = descriptor.planMode.planMarkdown(event.toolCall);
                      if (planMarkdown !== undefined) ctx.planMarkdown = planMarkdown;
                      return;
                    }
                    const changes = descriptor.diffEvidence
                      ? acpDiffFileChanges(event.toolCall, ctx.cwdRoots, path)
                      : [];
                    const toolCallId = event.toolCall.toolCallId;
                    const turnId = yield* turnForOutput(ctx, toolCallId);
                    if (
                      event.toolCall.status === "completed" ||
                      event.toolCall.status === "failed"
                    ) {
                      ctx.toolCallTurns.delete(toolCallId);
                    } else if (turnId !== undefined) {
                      ctx.toolCallTurns.set(toolCallId, turnId);
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        toolCall:
                          changes.length > 0
                            ? { ...event.toolCall, data: { ...event.toolCall.data, changes } }
                            : event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ContentDelta":
                    if (
                      descriptor.cancellationNotice !== undefined &&
                      ctx.cancelledTurnId !== undefined &&
                      ctx.cancelledTurnId === ctx.activeTurnId &&
                      event.text.trim() === descriptor.cancellationNotice
                    ) {
                      return;
                    }
                    yield* turnForOutput(ctx);
                    yield* closeReasoning(ctx);
                    if (ctx.activeTurnText.length < PLAN_GATE_SCAN_MAX_CHARS) {
                      ctx.activeTurnText += event.text;
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
            // Tied to the session, not to whichever fiber called startSession:
            // a child fork dies with its caller, which in the server is a
            // short-lived command fiber — and with it every later delta.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;
          recordHistory(ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              state: "ready",
              reason: `${descriptor.presentation.displayName} ACP session ready`,
            },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          if (started.resumeFailure !== undefined) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message: `${descriptor.presentation.displayName} could not reopen its earlier conversation, so it starts a new one with this thread's history.`,
                detail: started.resumeFailure,
                warningKind: "resume-failed",
              },
            });
          }
          if (descriptor.onSessionConfigOptions) {
            yield* descriptor
              .onSessionConfigOptions(effectiveSettings, yield* acp.getConfigOptions)
              .pipe(Effect.ignore);
          }

          return session;
        }).pipe(Effect.scoped),
      );

    /**
     * A message as ACP content: its text, then each attachment (an image's
     * bytes, or a note naming a file the agent reads from disk: ACP prompt
     * input has no document type, see buildFileAttachmentNote).
     */
    const promptContent = (
      text: string | undefined,
      attachments: Parameters<AcpAdapterShape["sendTurn"]>[0]["attachments"],
      method: string,
    ) =>
      Effect.gen(function* () {
        const parts: Array<EffectAcpSchema.ContentBlock> = [];
        if (text !== undefined) parts.push({ type: "text", text });
        for (const attachment of attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          if (attachment.type === "file") {
            parts.push({ type: "text", text: buildFileAttachmentNote(attachment, attachmentPath) });
            continue;
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          parts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return parts;
      });

    // The turn id is returned as soon as `session/prompt` is dispatched —
    // orchestration marks the turn accepted from that result, so it must
    // land before the streamed items and the completion, exactly as the
    // native drivers behave. The prompt itself runs in the session scope.
    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      Effect.flatMap(requireSession(input.threadId), (ctx) =>
        // One turn start at a time per session: two sends racing here would
        // both see no prompt in flight and run their prompts interleaved.
        ctx.turnStartLock.withPermit(startTurn(ctx, input)),
      );

    const startTurn = (ctx: AcpSessionContext, input: Parameters<AcpAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        if (ctx.promptFiber) {
          // ACP serializes prompts per session; a turn sent while one is in
          // flight starts after it, never interleaved with it.
          yield* Fiber.await(ctx.promptFiber);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // A message sent while the agent runs a turn of its own ends that
        // turn here; the agent takes the message after it, as Claude does.
        if (ctx.agentTurn !== undefined) {
          yield* closeAgentTurn(ctx, { state: "completed" });
        }
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveModelId(model);

        // Prompt-command plan mode (Antigravity's `/plan`) is a text prefix.
        const planMode = input.interactionMode === "plan" ? descriptor.planMode : undefined;
        const contextPreamble = ctx.pendingContextPreamble;
        const userText = input.input?.trim() ?? "";
        const seededText =
          contextPreamble !== undefined
            ? withContextSeedPreamble(contextPreamble, userText)
            : userText;
        const promptParts = yield* promptContent(
          seededText.length > 0 || planMode
            ? planMode
              ? `${planMode.promptPrefix}${seededText}`
              : seededText
            : undefined,
          input.attachments,
          "session/prompt",
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,
          threadId: input.threadId,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection:
            model === undefined ? undefined : { model, options: turnModelSelection?.options },
        });
        const turnModeId = descriptor.sessionModeForTurn?.(input.interactionMode);
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        if (turnModeId !== undefined && sessionId !== undefined) {
          yield* ctx.acp
            .request("session/set_mode", { sessionId, modeId: turnModeId })
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
              ),
            );
        }
        ctx.activeTurnId = turnId;
        resetTurnState(ctx);
        ctx.pendingContextPreamble = undefined;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        ctx.history.push({
          turnId,
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        });
        recordHistory(ctx);
        const promptText = promptParts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const runPrompt = Effect.gen(function* () {
          const promptMeta = descriptor.promptMeta?.(turnId);
          const exit = yield* Effect.exit(
            ctx.acp.prompt({
              prompt: promptParts,
              ...(promptMeta ? { _meta: { ...promptMeta } } : {}),
            }),
          );
          // Deltas travel through the notification fiber; make sure every one
          // queued before the prompt returned is out before the turn closes.
          yield* ctx.acp.flushEvents;
          // A turn that ends mid-thought (or on one) still settles its row.
          yield* closeReasoning(ctx);
          // Where the prompt landed, known before the turn reads as ended so a
          // revert right after it can rewind the agent too.
          if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) {
            yield* recordPromptPosition(ctx, turnId, promptText);
          }
          if (Exit.isSuccess(exit)) {
            const result = exit.value;
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
            const planMarkdown = planMode ? ctx.planMarkdown?.trim() : undefined;
            if (planMarkdown && result.stopReason !== "cancelled") {
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { planMarkdown },
              });
            }
            ctx.session = {
              ...ctx.session,
              updatedAt: yield* nowIso,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            };
            // Multi-provider harnesses advertise their whole catalog and
            // reject a plan-gated model as a one-line "reply" — surface that
            // as the failure it is so the chat can offer the upgrade page.
            const turnText = ctx.activeTurnText.trim();
            const planGateMessage =
              result.stopReason !== "cancelled" && isProviderPlanGateReply(turnText)
                ? turnText
                : undefined;
            // A refusal that produced no text would render as a silently
            // empty turn; say so instead. (`refused` is fx's dialect.)
            const silentRefusal =
              (result.stopReason === "refusal" || result.stopReason === "refused") &&
              turnText.length === 0;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: planGateMessage
                ? { state: "failed", stopReason: "plan_gated", errorMessage: planGateMessage }
                : silentRefusal
                  ? {
                      state: "failed",
                      stopReason: result.stopReason ?? null,
                      // A rate-limit retry that ran out also surfaces as a
                      // bare refusal; the provider's own status tells them apart.
                      errorMessage: ctx.lastProviderStatus
                        ? `${descriptor.presentation.displayName} returned no output. Provider status: ${ctx.lastProviderStatus}`
                        : `${descriptor.presentation.displayName} reported the model refused this request and returned no output.`,
                    }
                  : {
                      state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                      stopReason: result.stopReason ?? null,
                    },
            });
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          const failure = Cause.squash(exit.cause);
          yield* notifyAuthRequired(failure);
          const reportedFailure =
            ctx.promptOutcome?.state === "failed" ? ctx.promptOutcome.errorMessage : undefined;
          const detail = reportedFailure
            ? reportedFailure
            : failure instanceof Error
              ? mapAcpToAdapterError(
                  PROVIDER,
                  input.threadId,
                  "session/prompt",
                  failure as EffectAcpErrors.AcpError,
                ).message
              : String(failure);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: "failed",
              stopReason: isProviderPlanGateMessage(detail) ? "plan_gated" : null,
              errorMessage: ctx.lastProviderStatus
                ? `${detail} Provider status: ${ctx.lastProviderStatus}`
                : detail,
            },
          });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
              }
            }),
          ),
        );
        ctx.promptFiber = yield* Effect.forkIn(runPrompt, ctx.scope);

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    /**
     * A prompt that outlived `ACP_CANCEL_DEADLINE` after `session/cancel`:
     * the process is stopped and reaped first, so nothing it does lands after
     * the turn is reported cancelled.
     */
    const recycleStuckTurn = (ctx: AcpSessionContext, turnId: TurnId) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (sessions.get(ctx.threadId) !== ctx || ctx.activeTurnId !== turnId) return;
          yield* stopSessionInternal(ctx);
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              message: `${descriptor.presentation.displayName} did not stop in time, so it was restarted. The next message picks the conversation up again.`,
              warningKind: "cancel-timeout",
            },
          });
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }),
      );

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turnId = ctx.activeTurnId;
        const promptFiber = ctx.promptFiber;
        if (turnId !== undefined) ctx.cancelledTurnId = turnId;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        // The agent's own turn has no prompt to wait on; its end notice
        // settles it, and the same deadline applies.
        const agentTurn = ctx.agentTurn?.turnId === turnId ? ctx.agentTurn : undefined;
        const settled =
          agentTurn !== undefined
            ? Deferred.await(agentTurn.ended)
            : promptFiber !== undefined
              ? Fiber.await(promptFiber).pipe(Effect.asVoid)
              : undefined;
        if (turnId !== undefined && settled !== undefined) {
          yield* settled.pipe(
            Effect.timeoutOption(ACP_CANCEL_DEADLINE),
            Effect.flatMap((outcome) =>
              Option.isSome(outcome) ? Effect.void : recycleStuckTurn(ctx, turnId),
            ),
            Effect.forkIn(adapterScope),
          );
        }
      });

    /** A message sent mid-turn, added to the running turn (`descriptor.steer`). */
    const steerTurn: AcpAdapterShape["steerTurn"] = descriptor.steer
      ? (input) =>
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const turnId = ctx.activeTurnId;
            const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
            if (turnId === undefined || turnId !== input.expectedTurnId || !sessionId) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail:
                  turnId === undefined
                    ? `No active ${descriptor.presentation.displayName} turn is available to steer.`
                    : `Expected active turn '${input.expectedTurnId}' but ${descriptor.presentation.displayName} is running '${turnId}'.`,
              });
            }
            const text = input.input?.trim() ?? "";
            const content = yield* promptContent(
              text.length > 0 ? text : undefined,
              input.attachments,
              "turn/steer",
            );
            yield* descriptor.steer!({ acp: ctx.acp, sessionId, text, content }).pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "turn/steer", cause),
              ),
            );
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          })
      : undefined;

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: AcpAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    /**
     * Trims the turn list, and with `conversationHistory` rewinds the agent
     * to the first reverted message's prompt, so it forgets the reverted
     * turns. Without a known position for that prompt (a turn before this
     * cursor's history, or a prompt the agent couldn't place) the agent
     * keeps them, and the result says so.
     */
    const rollbackThread: AcpAdapterShape["rollbackThread"] = (threadId, numTurns, options) =>
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
        const conversationHistory = descriptor.conversationHistory;
        const target = options?.targetUserMessageId;
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        const index =
          target === undefined ? -1 : ctx.history.findIndex((entry) => entry.messageId === target);
        const position = index < 0 ? undefined : ctx.history[index]?.position;
        if (
          conversationHistory === undefined ||
          sessionId === undefined ||
          position === undefined ||
          ctx.activeTurnId !== undefined
        ) {
          return { threadId, turns: ctx.turns, conversationRolledBack: false };
        }
        const rewound = yield* conversationHistory
          .rewind({ acp: ctx.acp, sessionId, position })
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("acp.history.rewind-failed", {
                provider: PROVIDER,
                threadId,
                position,
                cause: cause.message,
              }).pipe(Effect.as(false)),
            ),
          );
        if (rewound) {
          ctx.history.splice(index);
          recordHistory(ctx);
        }
        return { threadId, turns: ctx.turns, conversationRolledBack: rewound };
      });

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));

    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // A snapshot per run: stopping a session removes it from the map.
    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.suspend(() =>
        Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "none",
        ...(descriptor.steer ? { activeTurnSteering: "supported" as const } : {}),
        ...(descriptor.conversationHistory ? { nativeThreadFork: "supported" as const } : {}),
      },
      startSession,
      sendTurn,
      ...(steerTurn ? { steerTurn } : {}),
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AcpAdapterShape;
  });
}
