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
  type ProviderFailureCategory,
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
  type UsageTokenTotals,
} from "@threadlines/contracts";
import { withFailureCategory } from "../providerFailureCategory.ts";
import { makeAgentProcessLedger } from "../agentProcessLedger.ts";
import {
  type ProjectBriefPreface,
  projectBriefPreface,
  readProjectBriefHash,
} from "../projectBriefPreface.ts";
import {
  isProviderPlanGateMessage,
  isProviderPlanGateReply,
} from "@threadlines/shared/providerPlan";
import { renderThreadContextSeed, withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { countTextReplacementStats } from "@threadlines/shared/textReplacementStats";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { UsageLedgerEntry } from "../../usage/usageLedger.ts";
import {
  BROWSER_MCP_SERVER_NAME,
  mcpEndpointUrl,
  mcpCommandsEndpointUrl,
  mcpDeviceEndpointUrl,
  mcpPagesEndpointUrl,
  mcpRoomEndpointUrl,
} from "../../mcp/McpHttpServer.ts";
import { PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { COMMANDS_MCP_SERVER_NAME } from "../../mcp/commandTools.ts";
import { DEVICE_MCP_SERVER_NAME } from "../../mcp/deviceTools.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import {
  ROOM_MCP_SERVER_NAME,
  roomEndpointGrant,
  roomSideKindOf,
} from "../../mcp/roomToolAccess.ts";
import { driverAnswersOnTheSide } from "../sideAnswerDrivers.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  steerRejectedError,
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
  AcpPromptFailure,
  AcpPromptOutcome,
  AcpPromptPlanMode,
  AcpProviderDescriptor,
  AcpProviderSettings,
  AcpSubagents,
  AcpTurnOutcome,
  AcpWorkAfterPrompt,
} from "./AcpProviderDescriptor.ts";
import { type AcpAttachmentBudget, acpAttachmentContent } from "./AcpPromptAttachments.ts";
import { type AcpSubagentRoster, makeAcpSubagentRoster } from "./AcpSubagentRoster.ts";
import {
  applyAcpModelSelection,
  defaultResolveAcpModelId,
  makeAcpProviderRuntime,
} from "./AcpProviderRuntime.ts";
import {
  type AcpPermissionRequest,
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  acpTurnUsageTotals,
  parsePermissionRequest,
} from "./AcpRuntimeModel.ts";
import { THREADLINES_ACP_CLIENT_INFO } from "./acpClientInfo.ts";
import { type AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const decodeLostSessions = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const ACP_RESUME_VERSION = 1 as const;
/**
 * How long a cancelled prompt may take to return. Past it the turn settles
 * as cancelled here and the process is recycled; the next turn resumes the
 * conversation in a fresh one.
 */
const ACP_CANCEL_DEADLINE = Duration.seconds(15);
/** How long a revert lets the agent stop its work before its session ends. */
const ACP_REVERT_WIND_DOWN = Duration.seconds(3);
/**
 * An agent's own turn (see `agentTurns`) that has gone this long without
 * output is closed here, in case its end notice never comes. Long: a command
 * running inside the turn reports nothing until it changes or ends.
 */
const ACP_AGENT_TURN_QUIET_LIMIT = Duration.minutes(15);
const ACP_AGENT_TURN_QUIET_CHECK = Duration.seconds(30);
/** How often a held turn (`heldTurns`) looks whether the agent's work is done. */
const ACP_HELD_TURN_CHECK = Duration.millis(250);
/**
 * A held turn ends this long after the agent's last word once nothing holds
 * it: another wake can follow straight after a reply.
 */
const ACP_HELD_TURN_SETTLE = Duration.seconds(2);
/** A reply the agent started by itself whose closing `usage_update` never comes ends after this. */
const ACP_HELD_REPLY_QUIET_LIMIT = Duration.minutes(2);
/**
 * The most turns a resume cursor remembers the agent's prompt positions for
 * (see `conversationHistory`); a revert further back trims Threadlines' turn
 * list only.
 */
const ACP_HISTORY_CURSOR_LIMIT = 200;
/** How long asking the agent where a prompt landed may take before it goes unanswered. */
const ACP_HISTORY_POSITION_TIMEOUT = Duration.seconds(5);
/** The most lost agent sessions an instance remembers (`markSessionLost`). */
const ACP_LOST_SESSIONS_LIMIT = 100;
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
  /**
   * Writes down a finished turn's usage for the Usage page (the usage
   * ledger), for agents that keep no usage of their own on disk. Never fails.
   */
  readonly recordTurnUsage?: (entry: UsageLedgerEntry) => Effect.Effect<void>;
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
  /** A room's side runtime: read-only, every request declined, its mode never changed. */
  readonly lockdown: "side-answer" | "side-review" | undefined;
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
  /** The agent's session id, as its usage is recorded under. */
  readonly acpSessionId: string;
  /** What the agent's `initialize` answer says it reads in a prompt. */
  readonly promptCapabilities: EffectAcpSchema.PromptCapabilities | null | undefined;
  /** The subagents this session's tool calls launched (`subagents`), as the thread shows them. */
  readonly subagentRoster: AcpSubagentRoster | undefined;
  /**
   * The session's running cost at the last turn boundary, when it is known
   * exactly: zero for a session opened here, or a report between turns. A turn
   * that ends without a report leaves it unknown, since later totals include
   * a turn whose cost was estimated instead.
   */
  costBaselineUsd: number | undefined;
  /** The running cost the agent last reported. */
  latestCostUsd: number | undefined;
  /** A prompt is open whose cost isn't settled yet; reports outside one mark the boundary. */
  costTurnOpen: boolean;
  /** The agent reported its running cost during the open turn. */
  costReportedThisTurn: boolean;
  /** The thought being streamed; closes when reply text, a tool call, or the turn end arrives. */
  activeReasoning: { readonly itemId: string; readonly turnId: TurnId; text: string } | undefined;
  /** The session cwd and its real path: agents report real paths (macOS `/private/tmp`). */
  readonly cwdRoots: ReadonlyArray<string>;
  /** The plan the agent wrote this turn (prompt-command plan mode). */
  planMarkdown: string | undefined;
  /** Earlier conversation for an agent that starts without it, sent with the first turn. */
  pendingContextPreamble: string | undefined;
  /** The project's brief for the next turn, and the hash the conversation then holds (projectBriefPreface). */
  projectBrief: ProjectBriefPreface;
  /** The brief's hash this conversation holds, kept in the resume cursor. */
  projectBriefHash: string | undefined;
  /**
   * The turn whose prompt last carried the brief, and the hash held before
   * it: a prompt the agent refused, or one a revert removed, queues it again.
   */
  projectBriefCarrier:
    | {
        readonly turnId: TurnId;
        readonly preface: ProjectBriefPreface;
        readonly hashBefore: string | undefined;
      }
    | undefined;
  /** Held while a turn starts, so concurrent sends queue instead of racing. */
  readonly turnStartLock: Semaphore.Semaphore;
  /** The active turn is one the agent started itself; settled when it ends. */
  agentTurn: { readonly turnId: TurnId; readonly ended: Deferred.Deferred<void> } | undefined;
  /** When the agent's own turn last produced anything (ms since epoch). */
  agentTurnLastActivityMs: number;
  /**
   * The agent's own turn as far as the reader has read: begun (its id chosen
   * then, `after` the prompt open at that point) and not yet ended, though the
   * event fiber may not have opened it.
   */
  agentTurnAhead:
    | { readonly turnId: TurnId; readonly after: AcpSessionContext["openPrompt"] }
    | undefined;
  /**
   * The agent's own turn starts (by id) and ends the reader has read and the
   * event fiber has not reached yet, oldest first: output just ahead of a
   * start notice opens that turn.
   */
  readonly queuedAgentTurns: Array<TurnId | "end">;
  /** The turn each running tool call started in, for updates that land after it. */
  readonly toolCallTurns: Map<string, TurnId>;
  /** How the agent said the running prompt ended, from its own notice. */
  promptOutcome: AcpTurnOutcome | undefined;
  /**
   * The prompt whose turn is open. `drained` once the reader is past its
   * last output (the agent began a turn of its own after it), `closed` once
   * its turn has closed.
   */
  openPrompt:
    | {
        readonly turnId: TurnId;
        readonly drained: Deferred.Deferred<void>;
        readonly closed: Deferred.Deferred<void>;
      }
    | undefined;
  /** The newest position the agent has listed, so a later prompt is placed after it. */
  newestPosition: number | undefined;
  /** The turn whose prompts run or last ran (a steered turn has several). */
  turnRun: AcpTurnRun | undefined;
  /** The turn kept open while the agent's work goes on (`heldTurns`). */
  held: AcpHeldTurn | undefined;
  /** Work the agent goes on with after its prompt answered, by tool call id (`heldTurns`). */
  readonly workAfterPrompt: Map<string, AcpWorkAfterPrompt>;
  /** Subagent launches counted so far, by tool call id, so a repeated update counts once. */
  readonly subagentLaunches: Set<string>;
  /** Subagents launched and not heard back from (a reply the agent started by itself ended since). */
  subagentsOut: number;
  /** A reply the agent started by itself has output and no closing `usage_update` yet. */
  replyOpen: boolean;
  /** A held command or timer ended since the last reply: the next reply is its wake. */
  workEndedSinceReply: boolean;
  /** When the agent last sent anything, for a held turn's quiet limits (ms since epoch). */
  lastAgentActivityMs: number;
  stopped: boolean;
}

/**
 * One turn's prompts: the first, and each one a steer sent after it
 * (`steerWithPrompt`). The newest prompt's answer settles the turn; the agent
 * answers an older one as the newer takes over.
 */
interface AcpTurnRun {
  readonly turnId: TurnId;
  readonly planMode: AcpPromptPlanMode | undefined;
  readonly resolvedModel: string | undefined;
  /** The turn's model as picked (a picker slug where known), for `promptOutcome.watch`. */
  readonly model: string | undefined;
  /** The first prompt's text, for placing it in the agent's history. */
  readonly promptText: string;
  readonly newestBefore: number | undefined;
  /** The open prompt (`openPrompt`) while one runs; undefined between prompts. */
  phase: NonNullable<AcpSessionContext["openPrompt"]> | undefined;
  /** How many prompts the turn has sent; the newest is this one. */
  prompts: number;
  /** Tokens every answered prompt of the turn reported, added up. */
  usage: UsageTokenTotals | null;
}

type AcpPromptOutcomeCheck = Effect.Success<ReturnType<AcpPromptOutcome["watch"]>>;

type AcpTurnCompletedPayload = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"];

/** A failed turn's completion, from how the agent's own words say it failed. */
function failedTurnPayload(
  failure: AcpPromptFailure,
  stopReason: string | null,
): AcpTurnCompletedPayload {
  return {
    state: "failed",
    stopReason,
    errorMessage: failure.errorMessage,
    ...withFailureCategory(failure.failureCategory),
    ...(failure.usageLimit !== undefined ? { usageLimit: failure.usageLimit } : {}),
  };
}

/** Two token counts added up (a steered turn's prompts each report their own). */
function addUsageTotals(total: UsageTokenTotals | null, next: UsageTokenTotals): UsageTokenTotals {
  if (total === null) return next;
  return {
    uncachedInputTokens: total.uncachedInputTokens + next.uncachedInputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    cacheCreationTokens: total.cacheCreationTokens + next.cacheCreationTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}

/**
 * A turn kept open after its prompt answered: the prompt's own completion,
 * sent when the work is done, or none for a turn the agent started itself.
 */
interface AcpHeldTurn {
  readonly turnId: TurnId;
  readonly completion:
    | {
        readonly payload: AcpTurnCompletedPayload;
        readonly model: string | undefined;
        readonly usage: UsageTokenTotals | null;
      }
    | undefined;
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

type AcpRawRequest = (
  method: string,
  payload: unknown,
) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;

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

export function parseAcpResumeCursor(raw: unknown):
  | {
      sessionId: string;
      history: ReadonlyArray<AcpHistoryEntry>;
      newestPosition: number | undefined;
      projectBriefHash: string | undefined;
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const history = Array.isArray(raw.history)
    ? raw.history.flatMap((entry) => parseHistoryEntry(entry) ?? [])
    : [];
  const newest = raw.newestPosition;
  return {
    sessionId: raw.sessionId.trim(),
    history,
    newestPosition:
      typeof newest === "number" && Number.isInteger(newest) && newest >= 0 ? newest : undefined,
    projectBriefHash: readProjectBriefHash(raw),
  };
}

function makeAcpResumeCursor(
  sessionId: string,
  history: ReadonlyArray<AcpHistoryEntry>,
  newestPosition: number | undefined,
  projectBriefHash: string | undefined,
) {
  return {
    schemaVersion: ACP_RESUME_VERSION,
    sessionId,
    ...(history.length > 0
      ? { history: history.slice(-ACP_HISTORY_CURSOR_LIMIT).map((entry) => ({ ...entry })) }
      : {}),
    ...(newestPosition !== undefined ? { newestPosition } : {}),
    ...(projectBriefHash !== undefined ? { projectBriefHash } : {}),
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
  const next = history[index + 1];
  if (next === undefined) return undefined;
  // The agent's own turn right after it has no prompt to rewind to: the copy
  // would keep it, beyond the fork's boundary.
  if (next.agentTurn === true) return "unknown";
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

/**
 * Whether a message starts with a slash command, as an agent with
 * `agentCommands` reads it: `/` and a name, then whitespace or the end. A
 * path (`/tmp/out.log is empty`) has a second `/` in its first word and is
 * not one.
 */
export function startsWithAgentCommand(text: string): boolean {
  return /^\/[\p{L}\p{N}_][\p{L}\p{N}_.:-]*(?:\s|$)/u.test(text);
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

/**
 * A failure category as reported, except a refusal that came with a provider
 * status: an exhausted rate-limit retry also ends as a bare refusal, and the
 * status, part of the message, tells them apart.
 */
function reportedFailureCategory(
  category: ProviderFailureCategory | undefined,
  providerStatus: string | undefined,
): ProviderFailureCategory | undefined {
  return category === "refusal" && providerStatus ? undefined : category;
}

/** An ACP sign-in-required error, as thrown or as the cause of the adapter's wrapper. */
function isAuthRequiredFailure(error: unknown): boolean {
  const wrapped =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return isAcpAuthRequiredError(error) || isAcpAuthRequiredError(wrapped);
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
    /** Each agent process it started, until proven gone (confirmThreadStopped). */
    const processes = yield* makeAgentProcessLedger();
    /**
     * Each agent session's turn history by its id, kept after the session
     * stops: a fork of it finds its boundary here.
     */
    const historyBySession = new Map<
      string,
      {
        readonly history: ReadonlyArray<AcpHistoryEntry>;
        readonly newest: number | undefined;
        readonly cwd: string;
      }
    >();
    const adapterScope = yield* Scope.Scope;
    /**
     * Agent sessions that can't go on (`AcpPromptFailure.sessionLost`): a
     * restart opens a new session instead, seeded with the thread's history.
     * Kept on disk per instance, so a server restart before the next message
     * doesn't reopen one.
     */
    const lostSessionsFile = path.join(
      serverConfig.stateDir,
      "acp-lost-sessions",
      `${encodeURIComponent(boundInstanceId)}.json`,
    );
    const lostSessions = new Set<string>(
      yield* fileSystem.readFileString(lostSessionsFile).pipe(
        Effect.map((raw): ReadonlyArray<string> => {
          const parsed = decodeLostSessions(raw);
          return Exit.isSuccess(parsed) ? parsed.value : [];
        }),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    );
    const saveLostSessions = Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(lostSessionsFile), { recursive: true });
      yield* fileSystem.writeFileString(
        lostSessionsFile,
        JSON.stringify([...lostSessions].slice(-ACP_LOST_SESSIONS_LIMIT)),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("acp.lost-sessions.save-failed", {
          provider: PROVIDER,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const markSessionLost = (sessionId: string) =>
      Effect.suspend(() => {
        lostSessions.add(sessionId);
        return saveLostSessions;
      });
    const forgetLostSession = (sessionId: string) =>
      Effect.suspend(() => (lostSessions.delete(sessionId) ? saveLostSessions : Effect.void));
    /**
     * A turn that can outlive its prompt or span several (`heldTurns`,
     * `steerWithPrompt`) writes each prompt's tokens as it answers.
     */
    const recordsEachPrompt =
      descriptor.heldTurns !== undefined || descriptor.steerWithPrompt === true;
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(
        // The subagent view follows the session's turns and usage updates.
        Effect.andThen(
          Effect.suspend(
            () => sessions.get(event.threadId)?.subagentRoster?.observe(event) ?? Effect.void,
          ),
        ),
      );

    /** The prompt that carried the brief is gone: the conversation holds what it held before. */
    const requeueProjectBrief = (ctx: AcpSessionContext) => {
      const carrier = ctx.projectBriefCarrier;
      if (carrier === undefined) return;
      ctx.projectBriefCarrier = undefined;
      ctx.projectBriefHash = carrier.hashBefore;
      ctx.projectBrief = carrier.preface;
      recordHistory(ctx);
    };

    /** Saves the session's turn history in its resume cursor, and for forks of it. */
    const recordHistory = (ctx: AcpSessionContext) => {
      const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
      if (sessionId === undefined) return;
      ctx.session = {
        ...ctx.session,
        resumeCursor: makeAcpResumeCursor(
          sessionId,
          ctx.history,
          ctx.newestPosition,
          ctx.projectBriefHash,
        ),
      };
      historyBySession.set(sessionId, {
        history: ctx.history.map((entry) => ({ ...entry })),
        newest: ctx.newestPosition,
        cwd: ctx.session.cwd ?? "",
      });
    };

    /**
     * Asks the agent where the prompt this turn sent sits in its history,
     * once the turn has ended, for a later revert or fork to rewind to.
     */
    const recordPromptPosition = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      promptText: string,
      newestBefore: number | undefined,
    ) =>
      Effect.gen(function* () {
        const history = descriptor.conversationHistory;
        const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
        const index = ctx.history.findIndex((candidate) => candidate.turnId === turnId);
        const entry = ctx.history[index];
        if (history === undefined || sessionId === undefined || entry === undefined) return;
        // Everything the agent had listed before this prompt went out is
        // older than it: an earlier turn's prompt, or what was steered in.
        const earlier = ctx.history
          .slice(0, index)
          .flatMap((candidate) => (candidate.position === undefined ? [] : [candidate.position]));
        if (newestBefore !== undefined) earlier.push(newestBefore);
        const placed = yield* history
          .promptPosition({
            acp: ctx.acp,
            sessionId,
            promptText,
            after: earlier.length > 0 ? Math.max(...earlier) : undefined,
          })
          .pipe(
            Effect.timeoutOption(ACP_HISTORY_POSITION_TIMEOUT),
            Effect.map(Option.getOrUndefined),
            Effect.catch((cause) =>
              Effect.logWarning("acp.history.position-unavailable", {
                provider: PROVIDER,
                threadId: ctx.threadId,
                cause: cause.message,
              }).pipe(Effect.as(undefined)),
            ),
          );
        if (placed === undefined) return;
        if (placed.newest !== undefined) {
          ctx.newestPosition = Math.max(ctx.newestPosition ?? placed.newest, placed.newest);
        }
        if (placed.position !== undefined) entry.position = placed.position;
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
      ctx.planMarkdown = undefined;
      ctx.promptOutcome = undefined;
      ctx.costTurnOpen = true;
      ctx.costReportedThisTurn = false;
    };

    /**
     * Writes down what a finished prompt spent: the tokens on its result and
     * the change in the session's running cost across it, when the cost is
     * known at both ends. Settles the cost boundary for the next turn either
     * way. A prompt the cancel deadline cut off records nothing: it returned
     * no tokens, and the session is gone.
     */
    const settleTurnUsage = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      model: string | undefined,
      totals: UsageTokenTotals | null,
    ) =>
      Effect.gen(function* () {
        const costUsd =
          ctx.costReportedThisTurn &&
          ctx.costBaselineUsd !== undefined &&
          ctx.latestCostUsd !== undefined
            ? Math.max(0, ctx.latestCostUsd - ctx.costBaselineUsd)
            : null;
        ctx.costBaselineUsd = ctx.costReportedThisTurn ? ctx.latestCostUsd : undefined;
        // Settled: a report from here on (one landing while this line is
        // written included) is the next turn's starting point.
        ctx.costTurnOpen = false;
        const record = options?.recordTurnUsage;
        if (!record || (totals === null && costUsd === null)) return;
        yield* record({
          atMs: yield* Clock.currentTimeMillis,
          sessionId: ctx.acpSessionId,
          turnId,
          model: model ?? ctx.session.model ?? "default",
          totals: totals ?? {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd,
        });
      });

    /** Writes down one answered prompt's tokens (`recordsEachPrompt`). */
    const recordPromptUsage = (
      ctx: AcpSessionContext,
      run: AcpTurnRun,
      promptNumber: number,
      totals: UsageTokenTotals,
    ) =>
      Effect.gen(function* () {
        const record = options?.recordTurnUsage;
        if (!record) return;
        yield* record({
          atMs: yield* Clock.currentTimeMillis,
          sessionId: ctx.acpSessionId,
          // The ledger keeps one line per id: a steer's prompt has its own.
          turnId: promptNumber === 1 ? run.turnId : `${run.turnId}:${promptNumber}`,
          model: run.resolvedModel ?? ctx.session.model ?? "default",
          totals,
          costUsd: null,
        });
      });

    /**
     * Opens a turn the agent started itself (`agentTurns`): its wake-up
     * after background work, opened on the extension's notice (in order with
     * the updates, `beginAgentTurnInOrder`) or on the first output that
     * arrives while no turn runs, the way Claude's synthetic turns open.
     */
    const openAgentTurn = (
      ctx: AcpSessionContext,
      raw: { method: string; payload: unknown },
      turnId: TurnId = TurnId.make(crypto.randomUUID()),
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.activeTurnId !== undefined) return;
        ctx.activeTurnId = turnId;
        ctx.agentTurn = { turnId, ended: yield* Deferred.make<void>() };
        ctx.agentTurnLastActivityMs = Date.now();
        // An agent whose own replies end with a `usage_update` (`heldTurns`)
        // keeps the turn open by that, and by the work the reply starts.
        const held: AcpHeldTurn | undefined =
          descriptor.heldTurns !== undefined ? { turnId, completion: undefined } : undefined;
        if (held !== undefined) {
          ctx.held = held;
          ctx.replyOpen = true;
          ctx.lastAgentActivityMs = Date.now();
        }
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
        yield* (
          held !== undefined ? watchHeldTurn(ctx, held) : watchAgentTurnQuiet(ctx, turnId)
        ).pipe(Effect.forkIn(ctx.scope));
      });

    /**
     * The extension's notice that the agent began a turn of its own, reached
     * in order. `after` is the prompt that was open when the notice arrived:
     * if its turn is still open it has had all its output by now, so it may
     * close without waiting for the reader, and the agent's turn opens once
     * it has. Its answer is due; one that never comes is a stuck prompt, which
     * Stop recycles.
     */
    const beginAgentTurnInOrder = (
      ctx: AcpSessionContext,
      raw: { method: string; payload: unknown },
      after: AcpSessionContext["openPrompt"],
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        ctx.queuedAgentTurns.shift();
        if (after !== undefined && ctx.openPrompt === after) {
          yield* Deferred.succeed(after.drained, undefined);
          yield* Deferred.await(after.closed);
        }
        // Opened already by the output just ahead of this notice, or opens now.
        yield* openAgentTurn(ctx, raw, turnId);
        // Not opened (a turn already runs): requests go to the running one.
        if (ctx.agentTurn?.turnId !== turnId && ctx.agentTurnAhead?.turnId === turnId) {
          ctx.agentTurnAhead = undefined;
        }
      });

    /**
     * Closes the agent's own turn. Reached in order (the extension's end
     * notice), everything before it is out and the runtime ended the reply at
     * the boundary. From anywhere else (a sent message, a long quiet) the
     * reply is ended and the queue flushed first.
     */
    const closeAgentTurn = (
      ctx: AcpSessionContext,
      outcome: AcpTurnOutcome,
      reached: "in-order" | "out-of-order" = "out-of-order",
    ) =>
      Effect.gen(function* () {
        const agentTurn = ctx.agentTurn;
        if (agentTurn === undefined) return;
        if (reached === "out-of-order") {
          // Its reply ends with it: the next turn's text is a message of its own.
          yield* ctx.acp.closeAssistantSegment;
          yield* ctx.acp.flushEvents();
          if (ctx.agentTurn !== agentTurn) return;
        }
        yield* closeReasoning(ctx);
        ctx.agentTurn = undefined;
        if (ctx.held?.turnId === agentTurn.turnId) ctx.held = undefined;
        if (ctx.agentTurnAhead?.turnId === agentTurn.turnId) ctx.agentTurnAhead = undefined;
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
            ...(outcome.state === "failed"
              ? withFailureCategory(
                  reportedFailureCategory(outcome.failureCategory, ctx.lastProviderStatus),
                )
              : {}),
          },
        });
        yield* Deferred.succeed(agentTurn.ended, undefined);
      });

    /**
     * Closes an agent turn whose end notice never came, after a long quiet.
     * One waiting on the user's approval or answer isn't quiet: it stays open.
     */
    const watchAgentTurnQuiet = (ctx: AcpSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        while (ctx.agentTurn?.turnId === turnId) {
          yield* Effect.sleep(ACP_AGENT_TURN_QUIET_CHECK);
          if (ctx.agentTurn?.turnId !== turnId) return;
          if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) {
            ctx.agentTurnLastActivityMs = Date.now();
            continue;
          }
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
     * A permission request as the descriptor describes its tool call
     * (`normalizeToolCall`): an MCP call the agent runs as a command asks as
     * a tool call, not a command.
     */
    const normalizedPermissionRequest = (request: AcpPermissionRequest): AcpPermissionRequest => {
      const normalize = descriptor.normalizeToolCall;
      if (normalize === undefined || request.toolCall === undefined) return request;
      const toolCall = normalize(request.toolCall);
      // A call the descriptor retyped is named by its own detail, not the command's.
      const detail = toolCall.itemType !== undefined ? toolCall.detail : request.detail;
      return {
        kind: toolCall.kind ?? request.kind,
        ...(detail !== undefined ? { detail } : {}),
        toolCall,
      };
    };

    /**
     * The agent sent something (`heldTurns`). Outside a prompt that is a
     * reply it started by itself, open until its closing `usage_update`.
     */
    const noteAgentOutput = (ctx: AcpSessionContext) => {
      if (descriptor.heldTurns === undefined) return;
      ctx.lastAgentActivityMs = Date.now();
      if (ctx.turnRun?.phase === undefined) ctx.replyOpen = true;
    };

    /**
     * The `usage_update` that ends each model call (`heldTurns`): a reply the
     * agent started by itself is over.
     */
    const noteReplyEnd = (ctx: AcpSessionContext) => {
      if (descriptor.heldTurns === undefined) return;
      ctx.lastAgentActivityMs = Date.now();
      if (ctx.replyOpen) endReply(ctx);
    };

    /**
     * A reply the agent started by itself ended (its `usage_update`, or a
     * long quiet). Subagents are known to end only by the report they wake
     * the agent to give, so a reply that no finished command or timer woke
     * counts as one subagent's report.
     */
    const endReply = (ctx: AcpSessionContext) => {
      ctx.replyOpen = false;
      if (ctx.workEndedSinceReply) ctx.workEndedSinceReply = false;
      else if (ctx.subagentsOut > 0) ctx.subagentsOut -= 1;
    };

    /** Keeps count of the work a tool call goes on with after its prompt (`heldTurns`). */
    const trackWorkAfterPrompt = (ctx: AcpSessionContext, toolCall: AcpToolCallState) => {
      const kind = descriptor.heldTurns?.workAfterPrompt(toolCall);
      const id = toolCall.toolCallId;
      if (kind === undefined) {
        ctx.workAfterPrompt.delete(id);
        return;
      }
      // A launch returns at once; the subagent works on until it reports.
      if (kind === "subagent") {
        if (toolCall.status === "completed" && !ctx.subagentLaunches.has(id)) {
          ctx.subagentLaunches.add(id);
          ctx.subagentsOut += 1;
        }
        return;
      }
      if (toolCall.status === "completed" || toolCall.status === "failed") {
        // Outside a prompt, its wake (not a subagent's report) is the reply
        // that follows.
        if (ctx.workAfterPrompt.delete(id) && ctx.turnRun?.phase === undefined) {
          ctx.workEndedSinceReply = true;
        }
      } else {
        ctx.workAfterPrompt.set(id, kind);
      }
    };

    /** Forgets the agent's outstanding work: it was stopped, or failed with its turn. */
    const clearWorkAfterPrompt = (ctx: AcpSessionContext) => {
      ctx.workAfterPrompt.clear();
      ctx.subagentsOut = 0;
      ctx.replyOpen = false;
      ctx.workEndedSinceReply = false;
    };

    /**
     * Ends a held turn, once: the turn the agent started itself as its own
     * end would, or a prompt's turn with the completion its prompt answered.
     * Run under `turnStartLock`, so a steer or a new message can't race it.
     */
    const closeHeldTurn = (
      ctx: AcpSessionContext,
      held: AcpHeldTurn,
      outcome: "completed" | "cancelled" | { readonly failed: string },
    ) =>
      Effect.gen(function* () {
        if (ctx.held !== held) return;
        ctx.held = undefined;
        if (outcome !== "completed") clearWorkAfterPrompt(ctx);
        const ended: AcpTurnOutcome | undefined =
          outcome === "cancelled"
            ? { state: "cancelled", stopReason: "cancelled" }
            : outcome === "completed"
              ? undefined
              : { state: "failed", errorMessage: outcome.failed };
        const completion = held.completion;
        if (completion === undefined) {
          yield* closeAgentTurn(ctx, ended ?? { state: "completed" });
          return;
        }
        // The reply the agent started by itself ends with the turn.
        yield* ctx.acp.closeAssistantSegment;
        yield* ctx.acp.flushEvents();
        yield* closeReasoning(ctx);
        if (ctx.activeTurnId === held.turnId) {
          ctx.activeTurnId = undefined;
          ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
        }
        if (ctx.turnRun?.turnId === held.turnId) ctx.turnRun = undefined;
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: held.turnId,
          payload:
            ended === undefined
              ? completion.payload
              : {
                  state: ended.state,
                  stopReason: ended.stopReason ?? null,
                  ...(ended.errorMessage !== undefined ? { errorMessage: ended.errorMessage } : {}),
                },
        });
        yield* settleTurnUsage(ctx, held.turnId, completion.model, completion.usage);
      });

    /**
     * Ends a held turn once the agent's work is done and it has gone quiet,
     * or once only commands and subagents hold it and it has said nothing
     * for the descriptor's silent limit (a lost wake must not leave the
     * thread working forever). A wait on the user's answer is not quiet.
     */
    const watchHeldTurn = (ctx: AcpSessionContext, held: AcpHeldTurn) =>
      Effect.gen(function* () {
        const silentLimitMs = Duration.toMillis(
          descriptor.heldTurns?.silentLimit ?? ACP_AGENT_TURN_QUIET_LIMIT,
        );
        const replyQuietMs = Duration.toMillis(
          descriptor.heldTurns?.replyQuietLimit ?? ACP_HELD_REPLY_QUIET_LIMIT,
        );
        while (ctx.held === held && !ctx.stopped) {
          yield* Effect.sleep(ACP_HELD_TURN_CHECK);
          if (ctx.held !== held) return;
          const now = Date.now();
          if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) {
            ctx.lastAgentActivityMs = now;
            continue;
          }
          const quietMs = now - ctx.lastAgentActivityMs;
          if (ctx.replyOpen && quietMs >= replyQuietMs) endReply(ctx);
          const work = [...ctx.workAfterPrompt.values()];
          const waiting = work.length > 0 || ctx.subagentsOut > 0 || ctx.replyOpen;
          const settled = !waiting && quietMs >= Duration.toMillis(ACP_HELD_TURN_SETTLE);
          const silent =
            waiting && !ctx.replyOpen && !work.includes("wake") && quietMs >= silentLimitMs;
          if (!settled && !silent) continue;
          const seenAt = ctx.lastAgentActivityMs;
          yield* ctx.turnStartLock.withPermit(
            Effect.suspend(() => {
              // Something arrived while the lock was busy: look again.
              if (ctx.held !== held || ctx.lastAgentActivityMs !== seenAt) return Effect.void;
              if (silent) clearWorkAfterPrompt(ctx);
              return closeHeldTurn(ctx, held, "completed");
            }),
          );
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
        noteAgentOutput(ctx);
        const earlier = toolCallId === undefined ? undefined : ctx.toolCallTurns.get(toolCallId);
        if (earlier !== undefined) return earlier;
        if (ctx.activeTurnId !== undefined) return ctx.activeTurnId;
        if (!descriptor.agentTurns) return undefined;
        // Output just ahead of a start notice is that turn's.
        const next = ctx.queuedAgentTurns[0];
        yield* openAgentTurn(
          ctx,
          { method: "session/update", payload: {} },
          next === "end" ? undefined : next,
        );
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

    const stopSessionInternal = (
      ctx: AcpSessionContext,
      exitKind: "graceful" | "error" = "graceful",
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        // The agent's process takes its subagents with it.
        if (ctx.subagentRoster !== undefined) yield* ctx.subagentRoster.end;
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
          payload: { exitKind },
        });
      });

    /**
     * The agent process ended by itself (`heldTurns`). A prompt in flight
     * fails on its own and settles first; a turn held open for the agent's
     * work has no request left to fail, so it ends failed here. The session
     * stops, and the next message starts the agent again.
     */
    const onAgentExited = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        yield* awaitPrompt(ctx).pipe(Effect.timeoutOption(ACP_CANCEL_DEADLINE));
        yield* ctx.turnStartLock.withPermit(
          Effect.suspend(() =>
            ctx.held === undefined || ctx.stopped
              ? Effect.void
              : closeHeldTurn(ctx, ctx.held, {
                  failed: `${descriptor.presentation.displayName} stopped before its work finished.`,
                }),
          ),
        );
        yield* withThreadLock(
          ctx.threadId,
          Effect.suspend(() =>
            sessions.get(ctx.threadId) === ctx ? stopSessionInternal(ctx, "error") : Effect.void,
          ),
        );
      });

    /**
     * Tells the descriptor when the agent answered `auth_required`, given the
     * ACP error or the adapter error that wraps it. Never fails or dies: a
     * turn must complete whatever the hook does.
     */
    const notifyAuthRequired = (error: unknown): Effect.Effect<void> => {
      const onAuthRequired = descriptor.onAuthRequired;
      if (!onAuthRequired || !isAuthRequiredFailure(error)) return Effect.void;
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
      /** A side runtime keeps the mode it started in: its lockdown. */
      readonly lockedDown: boolean;
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
        if (descriptor.sessionControls === "native" || input.lockedDown) {
          return;
        }
        const modeState = yield* input.runtime.getModeState;
        const mappedModeId = descriptor.agentModeFor?.({
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          availableModeIds: modeState?.availableModes.map((mode) => mode.id) ?? [],
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
          // A side answer must be read-only for certain. Only an agent whose
          // descriptor can lock it down here runs one, and always fresh: its
          // locked-down process can't reach the conversation it would fork.
          const lockdown = input.lockdown;
          const sideRuntime = lockdown === undefined ? undefined : descriptor.sideRuntime;
          if (
            lockdown !== undefined &&
            (sideRuntime === undefined || !driverAnswersOnTheSide(descriptor.driverKind))
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "This provider cannot answer on the side while another agent works.",
            });
          }
          if (lockdown !== undefined && input.forkFrom !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "A side answer from this provider starts fresh; it can't fork the conversation.",
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
          // A session the agent can no longer continue is not reopened: the
          // thread starts a new one with its history, as after a failed resume.
          const lostSession =
            resumed !== undefined && lostSessions.has(resumed.sessionId)
              ? resumed.sessionId
              : undefined;
          const resumeSessionId = lostSession === undefined ? resumed?.sessionId : undefined;
          // A native fork opens on the agent's copy of the source conversation,
          // up to the boundary. One it can't make exactly (a boundary it can't
          // place, or one before the first prompt) fails here, and the caller
          // seeds the thread from its transcript instead.
          const conversationHistory = descriptor.conversationHistory;
          let forkSession:
            | ((request: AcpRawRequest) => Effect.Effect<string, EffectAcpErrors.AcpError>)
            | undefined;
          let forkNewest: number | undefined;
          if (input.forkFrom !== undefined) {
            const source = historyBySession.get(input.forkFrom.providerThreadId);
            const rewindTo =
              conversationHistory === undefined
                ? "unknown"
                : forkRewindPosition(source?.history, input.forkFrom);
            if (conversationHistory === undefined || rewindTo === "unknown" || rewindTo === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "This conversation can't be forked at that turn.",
              });
            }
            const throughPosition = rewindTo === undefined ? undefined : rewindTo - 1;
            const sourceSessionId = input.forkFrom.providerThreadId;
            forkSession = (request) =>
              conversationHistory.fork({
                request,
                sessionId: sourceSessionId,
                sourceCwd: source?.cwd || cwd,
                cwd,
                throughPosition,
              });
            // The copy lists the source's prompts, up to the boundary.
            forkNewest = throughPosition ?? source?.newest;
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
          // The room endpoint, with every room tool its kind allows or the app
          // guide alone (roomEndpointGrant). A side runtime gets only the
          // room's read tools: no browser, pages, commands or schedules.
          const sideKind = roomSideKindOf(lockdown);
          const roomGrant = roomEndpointGrant(input, sideKind);
          // The page tools ride the same credential. An ACP agent hears no
          // instructions of ours, so the tool descriptions carry the rules and
          // a misplaced image's error names the thread's image folder.
          const agentPagesRequested = input.agentPages === true && lockdown === undefined;
          // `ask_user_to_run` likewise: its description carries the rules.
          const commandRequestsRequested = input.commandRequests === true && lockdown === undefined;
          // The device tools likewise.
          const deviceToolsRequested = input.deviceTools === true && lockdown === undefined;
          const credential =
            reachesHost && (lockdown === undefined || roomGrant.attach)
              ? yield* mcpSessionRegistry.credentialFor({
                  sessionKey: input.threadId,
                  browser: lockdown === undefined,
                  room: roomGrant.attach,
                  pages: agentPagesRequested,
                  commands: commandRequestsRequested,
                  device: deviceToolsRequested,
                  ...(sideKind !== undefined ? { sideKind } : {}),
                  scheduledRun: lockdown === undefined && input.scheduledRunTools === true,
                  guideOnly: roomGrant.guideOnly,
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
                  ...(lockdown === undefined
                    ? [
                        {
                          type: "http" as const,
                          name: BROWSER_MCP_SERVER_NAME,
                          url: mcpEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(roomGrant.attach
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
                  ...(commandRequestsRequested
                    ? [
                        {
                          type: "http" as const,
                          name: COMMANDS_MCP_SERVER_NAME,
                          url: mcpCommandsEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                  ...(deviceToolsRequested
                    ? [
                        {
                          type: "http" as const,
                          name: DEVICE_MCP_SERVER_NAME,
                          url: mcpDeviceEndpointUrl(serverConfig.port),
                          headers: authorization,
                        },
                      ]
                    : []),
                ];

          // A side runtime's process is the descriptor's locked-down one; what
          // it sets up (a throwaway home) goes with the session's scope.
          const side =
            sideRuntime === undefined || lockdown === undefined
              ? undefined
              : yield* sideRuntime({
                  settings: effectiveSettings,
                  cwd,
                  environment: options?.environment ?? process.env,
                  kind: lockdown === "side-review" ? "review" : "ask",
                  childProcessSpawner,
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
          const runtimeDescriptor =
            side === undefined ? descriptor : { ...descriptor, spawn: () => side.spawn };
          const acp = yield* makeAcpProviderRuntime(runtimeDescriptor, {
            settings: effectiveSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(forkSession !== undefined
              ? { forkSession }
              : resumeSessionId
                ? { resumeSessionId }
                : {}),
            clientInfo: THREADLINES_ACP_CLIENT_INFO,
            mcpServers,
            runtimeMode: input.runtimeMode,
            ...(descriptor.agentTurns ? { liveOutsidePrompt: true } : {}),
            ...(descriptor.heldTurns ? { trackSilentToolCalls: true } : {}),
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
          if (acp.process !== undefined) {
            yield* processes.track(input.threadId, acp.process);
          }

          /**
           * Shows a request from the agent in order with the output before it,
           * naming the turn running there, and resolves with that turn once
           * shown. While the reader waits on a prompt's answer to open a turn
           * the agent began, it shows at once under that turn instead: the
           * agent may hold the answer back until this request is answered.
           * A queued show can't end up behind a hand-off for an agent that
           * announces each turn before its requests and answers a prompt when
           * it finishes, as Grok (the one agent with turns of its own) does.
           */
          const showRequest = (show: (turnId: TurnId | undefined) => Effect.Effect<void>) =>
            Effect.gen(function* () {
              const shown = yield* Deferred.make<TurnId | undefined>();
              const showAs = (turnId: TurnId | undefined) =>
                show(turnId).pipe(Effect.andThen(Deferred.succeed(shown, turnId)), Effect.asVoid);
              const context = ctx;
              const ahead = context?.agentTurnAhead;
              if (context === undefined) {
                yield* showAs(undefined);
              } else if (ahead?.after !== undefined && context.openPrompt === ahead.after) {
                yield* showAs(ahead.turnId);
              } else {
                yield* acp.inOrder(
                  Effect.gen(function* () {
                    // A request the agent makes while no turn runs (`heldTurns`:
                    // its wake asks for a permission) opens one of its own.
                    if (descriptor.heldTurns !== undefined && context.activeTurnId === undefined) {
                      yield* openAgentTurn(context, {
                        method: "session/request_permission",
                        payload: {},
                      });
                    }
                    noteAgentOutput(context);
                    yield* showAs(context.activeTurnId);
                  }),
                );
              }
              return shown;
            });

          // A side runtime never reaches the user: its questions go unanswered
          // at once (no answers reads as declined), and nothing is shown.
          const requestUserInput: AcpExtensionContext["requestUserInput"] = (request) =>
            Effect.gen(function* () {
              if (lockdown !== undefined) {
                yield* logNative(input.threadId, `${request.method} (declined: side answer)`, {});
                return {};
              }
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, { answers });
              const shown = yield* showRequest((turnId) =>
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
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
                }),
              );
              const resolved = yield* Deferred.await(answers).pipe(
                Effect.ensuring(Effect.sync(() => pendingUserInputs.delete(requestId))),
              );
              const turnId = yield* Deferred.await(shown);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
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
            // What the extension emits names the running turn, so it goes
            // through the reader, in order with the updates and the turns the
            // agent starts and ends around it.
            emitProposedPlan: (request) =>
              acp.inOrder(
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
              ),
            emitPlanUpdate: (request) =>
              ctx && extensionSource
                ? acp.inOrder(
                    emitPlanUpdate(
                      ctx,
                      request.plan,
                      request.payload,
                      extensionSource,
                      request.method,
                    ),
                  )
                : Effect.void,
            emitRuntimeEvent: (request) =>
              acp.inOrder(
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
              ),
            // Both run on the reader, where the notice falls: the turn's id is
            // chosen here, so a request read after the start names it at once.
            beginAgentTurn: (request) => {
              if (!ctx) return Effect.void;
              const turnId = TurnId.make(crypto.randomUUID());
              const after = ctx.openPrompt;
              ctx.agentTurnAhead = { turnId, after };
              ctx.queuedAgentTurns.push(turnId);
              return acp.markAgentTurnBoundary.pipe(
                Effect.andThen(acp.inOrder(beginAgentTurnInOrder(ctx, request, after, turnId))),
              );
            },
            endAgentTurn: (request) => {
              const context = ctx;
              if (!context) return Effect.void;
              context.agentTurnAhead = undefined;
              context.queuedAgentTurns.push("end");
              return acp.markAgentTurnBoundary.pipe(
                Effect.andThen(
                  acp.inOrder(
                    Effect.suspend(() => {
                      context.queuedAgentTurns.shift();
                      return closeAgentTurn(context, request.outcome, "in-order");
                    }),
                  ),
                ),
              );
            },
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
                // A side runtime never shows a request. It is answered once,
                // as its descriptor says (AcpSideRuntime.approvals): declined,
                // or allowed where the agent's own sandbox keeps it read-only.
                // Never "always", and never `cancelled`, which ends the turn.
                if (side !== undefined) {
                  const kind = side.approvals === "approve-once" ? "allow_once" : "reject_once";
                  const once = params.options.find(
                    (option) => option.kind === kind && option.optionId.trim() !== "",
                  );
                  return once === undefined
                    ? { outcome: { outcome: "cancelled" as const } }
                    : { outcome: { outcome: "selected" as const, optionId: once.optionId } };
                }
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
                const permissionRequest = normalizedPermissionRequest(
                  parsePermissionRequest(params),
                );
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
                const shown = yield* showRequest((turnId) =>
                  Effect.gen(function* () {
                    yield* offerRuntimeEvent(
                      makeAcpRequestOpenedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
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
                  }),
                );
                // Gone however the wait ends (an interrupted handler included),
                // or the quiet watch would hold the agent's turn open forever.
                const resolved = yield* Deferred.await(decision).pipe(
                  Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))),
                );
                const turnId = yield* Deferred.await(shown);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
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
            const startedSession = yield* acp.start();
            // Up, but not trusted yet: the descriptor checks the agent really
            // came up locked down before anything is sent to it.
            if (side !== undefined) yield* side.verifyStarted;
            return startedSession;
          }).pipe(
            Effect.tapError(notifyAuthRequired),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            lockedDown: lockdown !== undefined,
            modelSelection: boundModelSelection,
          });

          const resumeFailure =
            started.resumeFailure ??
            (lostSession !== undefined
              ? `${descriptor.presentation.displayName} can no longer continue its earlier conversation.`
              : undefined);
          if (lostSession !== undefined) yield* forgetLostSession(lostSession);
          // A resumed conversation keeps the turn history its cursor carried.
          const keepsHistory =
            resumed !== undefined &&
            started.sessionId === resumed.sessionId &&
            resumeFailure === undefined;
          const history = keepsHistory ? resumed.history.map((entry) => ({ ...entry })) : [];
          const resumedNewestPosition = keepsHistory ? resumed.newestPosition : forkNewest;
          // The brief is sent again whenever it changed. Only the thread's
          // own resumed conversation is known to hold one; a side answer
          // never gets it.
          const projectBriefHash = keepsHistory ? resumed.projectBriefHash : undefined;
          const projectBrief =
            lockdown === undefined
              ? projectBriefPreface({
                  projectInstructions: input.projectInstructions,
                  sentHash: projectBriefHash,
                })
              : { text: undefined, hash: projectBriefHash };
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
            resumeCursor: makeAcpResumeCursor(
              started.sessionId,
              history,
              resumedNewestPosition,
              projectBriefHash,
            ),
            ...(roomToolsRequested ? { roomTools: roomToolsAttached } : {}),
            ...(resumeFailure !== undefined ? { resumeFailed: true } : {}),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            lockdown,
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
            acpSessionId: started.sessionId,
            promptCapabilities: started.initializeResult.agentCapabilities?.promptCapabilities,
            subagentRoster:
              descriptor.subagents === undefined
                ? undefined
                : makeAcpSubagentRoster({
                    subagents: descriptor.subagents,
                    sessionId: started.sessionId,
                    emit: (event, turnId) =>
                      Effect.gen(function* () {
                        yield* offerRuntimeEvent({
                          ...event,
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: input.threadId,
                          ...(turnId ? { turnId } : {}),
                        } as ProviderRuntimeEvent);
                      }),
                    fork: (effect) => effect.pipe(Effect.forkIn(sessionScope), Effect.asVoid),
                  }),
            // A session reopened from elsewhere has spent an unknown amount.
            costBaselineUsd:
              (resumeSessionId !== undefined || forkSession !== undefined) &&
              resumeFailure === undefined
                ? undefined
                : 0,
            latestCostUsd: undefined,
            costTurnOpen: false,
            costReportedThisTurn: false,
            activeReasoning: undefined,
            cwdRoots: realCwd === cwd ? [cwd] : [cwd, realCwd],
            planMarkdown: undefined,
            // A switch from another agent starts without the history: the
            // thread hands it over. (A failed resume is seeded by the reactor.)
            pendingContextPreamble:
              input.contextSeed !== undefined &&
              resumeSessionId === undefined &&
              lostSession === undefined
                ? renderThreadContextSeed(input.contextSeed)
                : undefined,
            projectBrief,
            projectBriefHash,
            projectBriefCarrier: undefined,
            turnStartLock: yield* Semaphore.make(1),
            agentTurn: undefined,
            agentTurnLastActivityMs: 0,
            agentTurnAhead: undefined,
            queuedAgentTurns: [],
            toolCallTurns: new Map(),
            promptOutcome: undefined,
            openPrompt: undefined,
            newestPosition: resumedNewestPosition,
            turnRun: undefined,
            held: undefined,
            workAfterPrompt: new Map(),
            subagentLaunches: new Set(),
            subagentsOut: 0,
            replyOpen: false,
            workEndedSinceReply: false,
            lastAgentActivityMs: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier": {
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    // Past a prompt's last update, what follows belongs to a
                    // later turn: it waits until the prompt's turn has closed.
                    if (event.holdUntil !== undefined) yield* Deferred.await(event.holdUntil);
                    return;
                  }
                  case "InOrder":
                    yield* event.run;
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
                    noteReplyEnd(ctx);
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
                  case "AvailableCommandsUpdated": {
                    // The composer's `/` list for this thread; a side runtime
                    // answers no messages of its own, so it lists none.
                    const agentCommands = descriptor.agentCommands;
                    if (agentCommands === undefined || ctx.lockdown !== undefined) return;
                    yield* offerRuntimeEvent({
                      type: "session.commands.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: {
                        commands: event.commands.filter(
                          (command) => !agentCommands.hidden.has(command.name),
                        ),
                      },
                    });
                    return;
                  }
                  case "SessionCost":
                    ctx.latestCostUsd = event.totalUsd;
                    // A report between turns marks the boundary exactly.
                    if (ctx.costTurnOpen) ctx.costReportedThisTurn = true;
                    else ctx.costBaselineUsd = event.totalUsd;
                    return;
                  case "ModeChanged":
                    return;
                  case "ToolCallTracked":
                    // A held turn counts work whose updates show nothing new
                    // (a timer's "Running schedule" stays as it started).
                    if (descriptor.heldTurns !== undefined) {
                      ctx.lastAgentActivityMs = Date.now();
                      trackWorkAfterPrompt(ctx, event.toolCall);
                    }
                    // A launch approved earlier completes with nothing new to show.
                    if (ctx.subagentRoster !== undefined) {
                      yield* ctx.subagentRoster.noteToolCall(
                        event.toolCall,
                        ctx.toolCallTurns.get(event.toolCall.toolCallId) ?? ctx.activeTurnId,
                      );
                    }
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
                    if (descriptor.heldTurns !== undefined)
                      trackWorkAfterPrompt(ctx, event.toolCall);
                    if (ctx.subagentRoster !== undefined) {
                      yield* ctx.subagentRoster.noteToolCall(event.toolCall, turnId);
                    }
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
          // Held turns wait on no request the exit would fail (`onAgentExited`).
          if (descriptor.heldTurns !== undefined && acp.process !== undefined) {
            const session = ctx;
            yield* acp.process.exited.pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  session.stopped
                    ? Effect.void
                    : onAgentExited(session).pipe(Effect.forkIn(adapterScope), Effect.asVoid),
                ),
              ),
              Effect.forkIn(sessionScope),
            );
          }
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
          if (resumeFailure !== undefined) {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message: `${descriptor.presentation.displayName} could not reopen its earlier conversation, so it starts a new one with this thread's history.`,
                detail: resumeFailure,
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
     * A message as ACP content: its text, then each attachment. By default an
     * image's bytes, or a note naming a file the agent reads from disk (see
     * buildFileAttachmentNote); an agent that reads more natively says how
     * (`attachmentDelivery`, see AcpPromptAttachments).
     */
    const promptContent = (
      ctx: AcpSessionContext,
      text: string | undefined,
      attachments: Parameters<AcpAdapterShape["sendTurn"]>[0]["attachments"],
      method: string,
    ) =>
      Effect.gen(function* () {
        const parts: Array<EffectAcpSchema.ContentBlock> = [];
        if (text !== undefined) parts.push({ type: "text", text });
        const budget: AcpAttachmentBudget = { inlineBytes: 0 };
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
          const delivery = descriptor.attachmentDelivery?.(attachment, ctx.promptCapabilities);
          if (delivery !== undefined) {
            const blocks = yield* acpAttachmentContent({
              attachment,
              path: attachmentPath,
              delivery,
              budget,
              fileSystem,
            }).pipe(
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
            parts.push(...blocks);
            continue;
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
        Effect.gen(function* () {
          // ACP serializes prompts per session; a turn sent while one is in
          // flight starts after it, never interleaved with it (nor with a
          // prompt a steer sent meanwhile). The wait is outside the lock: a
          // Stop or a settling prompt that needs the lock must not queue
          // behind a send that waits on them.
          while (true) {
            const awaited = yield* awaitPrompt(ctx);
            // One turn start at a time per session: two sends racing here
            // would both see no prompt in flight and run their prompts
            // interleaved. One that lost the race waits for the winner's.
            const started = yield* ctx.turnStartLock.withPermit(
              Effect.suspend(() =>
                ctx.promptFiber === awaited ? startTurn(ctx, input) : Effect.succeed(undefined),
              ),
            );
            if (started !== undefined) return started;
          }
        }),
      );

    /** Waits for the newest prompt (a steer may send another meanwhile); returns its fiber. */
    const awaitPrompt = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        while (ctx.promptFiber !== undefined) {
          const promptFiber = ctx.promptFiber;
          yield* Fiber.await(promptFiber);
          if (ctx.promptFiber === promptFiber) return promptFiber;
        }
        return undefined;
      });

    /** Waits for the turn's prompts: this one, and any a steer sent after it for the same turn. */
    const awaitTurnPrompts = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      first: NonNullable<AcpSessionContext["promptFiber"]>,
    ) =>
      Effect.gen(function* () {
        let promptFiber = first;
        while (true) {
          yield* Fiber.await(promptFiber);
          const next = ctx.promptFiber;
          if (next === undefined || next === promptFiber || ctx.turnRun?.turnId !== turnId) return;
          promptFiber = next;
        }
      });

    const startTurn = (ctx: AcpSessionContext, input: Parameters<AcpAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        // The reader catches up first, so a turn the agent began before this
        // message is open (and ended below) rather than taking its output.
        yield* ctx.acp.flushEvents();
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // A message sent while the agent runs a turn of its own, or while a
        // turn waits on the agent's work, ends that turn here; the agent takes
        // the message after it, as Claude does.
        if (ctx.held !== undefined) {
          yield* closeHeldTurn(ctx, ctx.held, "completed");
        }
        if (ctx.agentTurn !== undefined) {
          yield* closeAgentTurn(ctx, { state: "completed" });
        }
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const resolvedModel = resolveModelId(model);

        const userText = input.input?.trim() ?? "";
        // The agent runs a command (or a skill) only when the message starts
        // with it, so one goes as typed: no plan prefix, and the earlier
        // context and the project brief wait for the next message.
        const sendsAgentCommand =
          descriptor.agentCommands !== undefined && startsWithAgentCommand(userText);
        // Prompt-command plan mode (Antigravity's `/plan`) is a text prefix.
        const lockedDown = ctx.lockdown !== undefined;
        const planMode =
          input.interactionMode === "plan" && !lockedDown && !sendsAgentCommand
            ? descriptor.planMode
            : undefined;
        const contextPreamble = sendsAgentCommand ? undefined : ctx.pendingContextPreamble;
        const projectBrief: ProjectBriefPreface = sendsAgentCommand
          ? { text: undefined, hash: ctx.projectBrief.hash }
          : ctx.projectBrief;
        const contextText =
          contextPreamble !== undefined
            ? withContextSeedPreamble(contextPreamble, userText)
            : userText;
        // The project's brief leads, as a paragraph of its own.
        const seededText =
          projectBrief.text !== undefined
            ? contextText.length > 0
              ? `${projectBrief.text}\n\n${contextText}`
              : projectBrief.text
            : contextText;
        const promptParts = yield* promptContent(
          ctx,
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
          lockedDown,
          modelSelection:
            model === undefined ? undefined : { model, options: turnModelSelection?.options },
        });
        const turnModeId = lockedDown
          ? undefined
          : descriptor.sessionModeForTurn?.(input.interactionMode);
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
        const run: AcpTurnRun = {
          turnId,
          planMode,
          resolvedModel,
          model,
          promptText: promptParts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n"),
          newestBefore: ctx.newestPosition,
          phase: undefined,
          prompts: 0,
          usage: null,
        };
        ctx.turnRun = run;
        yield* openPromptPhase(ctx, run);
        resetTurnState(ctx);
        if (!sendsAgentCommand) ctx.pendingContextPreamble = undefined;
        if (projectBrief.text !== undefined) {
          ctx.projectBriefCarrier = {
            turnId,
            preface: projectBrief,
            hashBefore: ctx.projectBriefHash,
          };
          ctx.projectBrief = { text: undefined, hash: projectBrief.hash };
          ctx.projectBriefHash = projectBrief.hash;
        }
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        ctx.history.push({
          turnId,
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        });
        recordHistory(ctx);

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        yield* sendTurnPrompt(ctx, run, promptParts);

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    /** Starts reading how the turn's prompts end (`promptOutcome`); never fails. */
    const watchPromptOutcome = (ctx: AcpSessionContext, model: string | undefined) =>
      descriptor.promptOutcome === undefined
        ? Effect.succeed(undefined)
        : descriptor.promptOutcome.watch(ctx.acpSessionId, model).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("acp.prompt-outcome.watch-failed", {
                provider: PROVIDER,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(undefined)),
            ),
          );

    /** The turn's prompts' answer as the agent's own words tell it (`promptOutcome`). */
    const checkPromptOutcome = (
      checkOutcome: AcpPromptOutcomeCheck | undefined,
      answer: Parameters<AcpPromptOutcomeCheck>[0],
    ): Effect.Effect<AcpPromptFailure | undefined> =>
      checkOutcome === undefined
        ? Effect.succeed(undefined)
        : checkOutcome(answer).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("acp.prompt-outcome.check-failed", {
                provider: PROVIDER,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(undefined)),
            ),
          );

    /** The turn's open prompt (`openPrompt`), opened now unless a prompt is already open. */
    const openPromptPhase = (ctx: AcpSessionContext, run: AcpTurnRun) =>
      Effect.gen(function* () {
        if (run.phase !== undefined) return run.phase;
        const phase = {
          turnId: run.turnId,
          drained: yield* Deferred.make<void>(),
          closed: yield* Deferred.make<void>(),
        };
        run.phase = phase;
        ctx.openPrompt = phase;
        // What the agent did by itself is over: this prompt carries the turn on.
        ctx.replyOpen = false;
        ctx.workEndedSinceReply = false;
        return phase;
      });

    /**
     * Sends one of a turn's prompts: its first, or a steer
     * (`steerWithPrompt`). It runs in the session scope; the newest prompt's
     * answer settles the turn.
     */
    const sendTurnPrompt = (
      ctx: AcpSessionContext,
      run: AcpTurnRun,
      promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
    ) =>
      Effect.gen(function* () {
        // Each prompt reads its own outcome from where the agent's records
        // stand as it goes out, not where the turn's first prompt found them.
        const checkOutcome = yield* watchPromptOutcome(ctx, run.model);
        run.prompts += 1;
        const promptNumber = run.prompts;
        const phase = yield* openPromptPhase(ctx, run);
        const answered = yield* Deferred.make<void>();
        ctx.promptFiber = yield* Effect.forkIn(
          runTurnPrompt(ctx, run, { phase, answered, promptNumber, promptParts, checkOutcome }),
          ctx.scope,
        );
      });

    /**
     * One prompt of a turn, from its answer to the turn's end. `phase` is the
     * turn's open prompt, shared with a steer's; `answered` is this prompt's
     * own: the reader holds what follows its answer until it is settled, and
     * a superseded prompt releases it at once, so its successor's output (a
     * permission request included) is never stuck behind it.
     */
    const runTurnPrompt = (
      ctx: AcpSessionContext,
      run: AcpTurnRun,
      input: {
        readonly phase: NonNullable<AcpSessionContext["openPrompt"]>;
        readonly answered: Deferred.Deferred<void>;
        readonly promptNumber: number;
        readonly promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>;
        readonly checkOutcome: AcpPromptOutcomeCheck | undefined;
      },
    ) => {
      const { phase: prompt, answered, promptNumber, promptParts, checkOutcome } = input;
      const turnId = run.turnId;
      const threadId = ctx.threadId;
      const { planMode, resolvedModel, promptText, newestBefore } = run;
      const usageTotals = descriptor.turnUsageTotals ?? acpTurnUsageTotals;
      /** A newer prompt took the turn over (a steer): this one's answer settles nothing. */
      const superseded = () => promptNumber !== run.prompts;
      /**
       * Settling runs under the turn lock when a steer sends a prompt, so a
       * steer lands before the settle starts (and supersedes it) or after
       * it ended (and finds the turn over, or held).
       */
      const settleLocked = (settle: Effect.Effect<void>) =>
        descriptor.steerWithPrompt === true ? ctx.turnStartLock.withPermit(settle) : settle;
      let lostSession = false;
      let finalized = false;
      const finalize = Effect.gen(function* () {
        if (finalized || superseded()) return;
        finalized = true;
        if (run.phase === prompt) run.phase = undefined;
        if (ctx.held?.turnId !== turnId) {
          if (ctx.activeTurnId === turnId) {
            ctx.activeTurnId = undefined;
            ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* nowIso };
          }
          if (ctx.turnRun === run) ctx.turnRun = undefined;
        }
        if (ctx.openPrompt === prompt) ctx.openPrompt = undefined;
        yield* Deferred.succeed(prompt.closed, undefined);
        // The agent can't go on with this session: it is stopped, and
        // the next message opens a new one with the thread's history.
        if (lostSession) {
          yield* markSessionLost(ctx.acpSessionId);
          yield* withThreadLock(
            ctx.threadId,
            Effect.suspend(() =>
              sessions.get(ctx.threadId) === ctx ? stopSessionInternal(ctx) : Effect.void,
            ),
          ).pipe(Effect.forkIn(adapterScope));
        }
      });
      const settle = (exit: Exit.Exit<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>) =>
        Effect.gen(function* () {
          // A turn that ends mid-thought (or on one) still settles its row.
          yield* closeReasoning(ctx);
          // Where the prompt landed, known before the turn reads as ended,
          // so a revert or a stop right after it keeps it.
          if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) {
            yield* recordPromptPosition(ctx, turnId, promptText, newestBefore);
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
                threadId,
                turnId,
                payload: { planMarkdown },
              });
            }
            ctx.session = {
              ...ctx.session,
              updatedAt: yield* nowIso,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            };
            // An agent that ends a turn normally on an upstream error says so
            // in its own records (`promptOutcome`).
            const hidden =
              result.stopReason === "cancelled"
                ? undefined
                : yield* checkPromptOutcome(checkOutcome, { response: result });
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
            const payload: AcpTurnCompletedPayload = hidden
              ? failedTurnPayload(hidden, result.stopReason ?? null)
              : planGateMessage
                ? { state: "failed", stopReason: "plan_gated", errorMessage: planGateMessage }
                : silentRefusal
                  ? {
                      state: "failed",
                      stopReason: result.stopReason ?? null,
                      ...withFailureCategory(
                        reportedFailureCategory("refusal", ctx.lastProviderStatus),
                      ),
                      // A rate-limit retry that ran out also surfaces as a
                      // bare refusal; the provider's own status tells them apart.
                      errorMessage: ctx.lastProviderStatus
                        ? `${descriptor.presentation.displayName} returned no output. Provider status: ${ctx.lastProviderStatus}`
                        : `${descriptor.presentation.displayName} reported the model refused this request and returned no output.`,
                    }
                  : {
                      state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                      stopReason: result.stopReason ?? null,
                    };
            lostSession = hidden?.sessionLost === true;
            // The agent goes on with work it started (`heldTurns`): the turn
            // stays open, working and stoppable, until that work is done.
            if (
              payload.state === "completed" &&
              descriptor.heldTurns !== undefined &&
              (ctx.workAfterPrompt.size > 0 || ctx.subagentsOut > 0)
            ) {
              const held: AcpHeldTurn = {
                turnId,
                completion: { payload, model: resolvedModel, usage: run.usage },
              };
              ctx.held = held;
              ctx.replyOpen = false;
              ctx.lastAgentActivityMs = Date.now();
              yield* watchHeldTurn(ctx, held).pipe(Effect.forkIn(ctx.scope));
              return;
            }
            if (payload.state !== "completed") clearWorkAfterPrompt(ctx);
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId,
              payload,
            });
            yield* settleTurnUsage(ctx, turnId, resolvedModel, run.usage);
            return;
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          clearWorkAfterPrompt(ctx);
          // The agent may never have taken the prompt: the brief goes again.
          if (ctx.projectBriefCarrier?.turnId === turnId) requeueProjectBrief(ctx);
          const failure = Cause.squash(exit.cause);
          yield* notifyAuthRequired(failure);
          const reported = yield* checkPromptOutcome(checkOutcome, { error: failure });
          if (reported !== undefined) {
            lostSession = reported.sessionLost === true;
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId,
              payload: failedTurnPayload(reported, null),
            });
            yield* settleTurnUsage(ctx, turnId, resolvedModel, run.usage);
            return;
          }
          const reportedOutcome =
            ctx.promptOutcome?.state === "failed" ? ctx.promptOutcome : undefined;
          const reportedFailure = reportedOutcome?.errorMessage;
          const failureCategory =
            reportedFailureCategory(reportedOutcome?.failureCategory, ctx.lastProviderStatus) ??
            (isAuthRequiredFailure(failure) ? ("auth" as const) : undefined);
          const detail = reportedFailure
            ? reportedFailure
            : failure instanceof Error
              ? mapAcpToAdapterError(
                  PROVIDER,
                  threadId,
                  "session/prompt",
                  failure as EffectAcpErrors.AcpError,
                ).message
              : String(failure);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId,
            payload: {
              state: "failed",
              stopReason: isProviderPlanGateMessage(detail) ? "plan_gated" : null,
              errorMessage: ctx.lastProviderStatus
                ? `${detail} Provider status: ${ctx.lastProviderStatus}`
                : detail,
              ...withFailureCategory(failureCategory),
            },
          });
          // No result, so no tokens (but what a steered prompt before it
          // reported); a running cost the agent reported still counts.
          yield* settleTurnUsage(ctx, turnId, resolvedModel, run.usage);
        }).pipe(Effect.ensuring(finalize));
      return Effect.gen(function* () {
        const promptMeta = descriptor.promptMeta?.(turnId);
        const exit = yield* Effect.exit(
          ctx.acp.prompt({
            prompt: [...promptParts],
            ...(promptMeta ? { _meta: { ...promptMeta } } : {}),
          }),
        );
        if (Exit.isSuccess(exit)) {
          const totals = usageTotals(exit.value.usage);
          if (totals !== null) {
            // Written as the prompt answers, so a turn held open (or
            // stopped, or outlived by a restart) never loses it, and it is
            // dated when it was spent.
            if (recordsEachPrompt) yield* recordPromptUsage(ctx, run, promptNumber, totals);
            else run.usage = addUsageTotals(run.usage, totals);
          }
        }
        if (superseded()) return;
        // Deltas travel through the notification fiber; make sure every one
        // queued before the prompt returned is out before the turn closes.
        // The reader may be past them already, held at a turn the agent
        // began after them (`beginAgentTurnInOrder`).
        yield* Effect.raceFirst(ctx.acp.flushEvents(answered), Deferred.await(prompt.drained));
        // A steer sent while the reader caught up carries the turn on.
        yield* settleLocked(Effect.suspend(() => (superseded() ? Effect.void : settle(exit))));
      }).pipe(
        Effect.ensuring(finalize.pipe(Effect.andThen(Deferred.succeed(answered, undefined)))),
      );
    };

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
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (turnId === undefined) return;
        // A turn waiting on the agent's work (`heldTurns`) has no prompt to
        // wait on: the cancel stopped that work, and the turn ends here. Taken
        // under the turn lock, inside the deadline: a stuck holder of the lock
        // must not keep Stop from recycling the agent.
        const closeHeld =
          descriptor.heldTurns === undefined
            ? Effect.succeed(false)
            : ctx.turnStartLock.withPermit(
                Effect.suspend(() => {
                  const held = ctx.held;
                  return held?.turnId === turnId
                    ? closeHeldTurn(ctx, held, "cancelled").pipe(Effect.as(true))
                    : Effect.succeed(false);
                }),
              );
        // The agent's own turn has no prompt to wait on; its end notice
        // settles it, and the same deadline applies.
        const agentTurn = ctx.agentTurn?.turnId === turnId ? ctx.agentTurn : undefined;
        const awaitTurn =
          agentTurn !== undefined
            ? Deferred.await(agentTurn.ended)
            : promptFiber !== undefined
              ? awaitTurnPrompts(ctx, turnId, promptFiber)
              : undefined;
        const settled =
          descriptor.heldTurns === undefined
            ? awaitTurn
            : closeHeld.pipe(
                Effect.flatMap((closed) => (closed ? Effect.void : (awaitTurn ?? Effect.void))),
              );
        if (settled !== undefined) {
          yield* settled.pipe(
            Effect.timeoutOption(ACP_CANCEL_DEADLINE),
            Effect.flatMap((outcome) =>
              Option.isSome(outcome) ? Effect.void : recycleStuckTurn(ctx, turnId),
            ),
            Effect.forkIn(adapterScope),
          );
        }
      });

    /**
     * A message sent mid-turn, added to the running turn: by the agent's own
     * steer (`descriptor.steer`), or as another prompt (`steerWithPrompt`).
     */
    const steerTurn: AcpAdapterShape["steerTurn"] =
      descriptor.steer || descriptor.steerWithPrompt
        ? (input) =>
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              const turnId = ctx.activeTurnId;
              const sessionId = parseAcpResumeCursor(ctx.session.resumeCursor)?.sessionId;
              if (turnId === undefined) {
                return yield* steerRejectedError(
                  PROVIDER,
                  descriptor.presentation.displayName,
                  "no-active-turn",
                );
              }
              if (turnId !== input.expectedTurnId || !sessionId) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/steer",
                  detail: `Expected active turn '${input.expectedTurnId}' but ${descriptor.presentation.displayName} is running '${turnId}'.`,
                });
              }
              const text = input.input?.trim() ?? "";
              const content = yield* promptContent(
                ctx,
                text.length > 0 ? text : undefined,
                input.attachments,
                "turn/steer",
              );
              if (descriptor.steer === undefined) {
                yield* ctx.turnStartLock.withPermit(steerWithPrompt(ctx, turnId, content));
                return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
              }
              // The text of every block: a file travels as a note naming its path.
              const steerText = content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n\n");
              yield* descriptor
                .steer({ acp: ctx.acp, sessionId, text: steerText, content })
                .pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, "turn/steer", cause),
                  ),
                );
              return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
            })
        : undefined;

    /**
     * Steers the running turn with another prompt (`steerWithPrompt`): the
     * agent answers the prompt it was on and carries the turn on under this
     * one. A turn waiting on the agent's work, or one the agent started by
     * itself, takes it the same way: the prompt's answer settles it.
     */
    const steerWithPrompt = (
      ctx: AcpSessionContext,
      turnId: TurnId,
      content: ReadonlyArray<EffectAcpSchema.ContentBlock>,
    ) =>
      Effect.gen(function* () {
        // The turn ended while the lock was busy: the message starts its own.
        if (ctx.stopped || ctx.activeTurnId !== turnId) {
          return yield* steerRejectedError(
            PROVIDER,
            descriptor.presentation.displayName,
            "no-active-turn",
          );
        }
        if (ctx.held?.turnId === turnId) ctx.held = undefined;
        let run = ctx.turnRun;
        if (run?.turnId !== turnId) {
          // The agent's own turn: the prompt makes it an ordinary one.
          const agentTurn = ctx.agentTurn;
          if (agentTurn?.turnId === turnId) {
            ctx.agentTurn = undefined;
            if (ctx.agentTurnAhead?.turnId === turnId) ctx.agentTurnAhead = undefined;
            yield* Deferred.succeed(agentTurn.ended, undefined);
          }
          run = {
            turnId,
            planMode: undefined,
            resolvedModel: resolveModelId(ctx.session.model),
            promptText: content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
            newestBefore: ctx.newestPosition,
            phase: undefined,
            prompts: 0,
            usage: null,
            model: ctx.session.model,
          };
          ctx.turnRun = run;
        }
        yield* sendTurnPrompt(ctx, run, content);
      });

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
     * keeps them, and the result says so. With `rollbackByNewSession` the
     * session ends instead (`forgetByNewSession`).
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
        if (conversationHistory === undefined && descriptor.rollbackByNewSession === true) {
          yield* withThreadLock(
            threadId,
            Effect.suspend(() =>
              sessions.get(threadId) === ctx ? forgetByNewSession(ctx) : Effect.void,
            ),
          );
          return { threadId, turns: ctx.turns, conversationRolledBack: true };
        }
        // The last turn's prompt position may still be on its way.
        if (ctx.activeTurnId === undefined && ctx.promptFiber !== undefined) {
          yield* Fiber.await(ctx.promptFiber).pipe(
            Effect.timeoutOption(ACP_HISTORY_POSITION_TIMEOUT),
          );
        }
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
          // The agent now lists only the prompts before this one.
          ctx.newestPosition = position > 0 ? position - 1 : undefined;
          const carrier = ctx.projectBriefCarrier;
          if (
            carrier !== undefined &&
            !ctx.history.some((entry) => entry.turnId === carrier.turnId)
          ) {
            requeueProjectBrief(ctx);
          }
          recordHistory(ctx);
        }
        return { threadId, turns: ctx.turns, conversationRolledBack: rewound };
      });

    /**
     * For an agent that can't rewind (`rollbackByNewSession`): the session
     * ends and is marked lost, so it is never reopened. The next message
     * starts a new one, which the thread seeds with the turns it kept
     * (`resumeFailed`), and the agent forgets the reverted ones. Work still
     * going is stopped first as Stop does (a cancel ends the agent's commands
     * and subagents, Antigravity 1.5.10), and the agent gets a moment to wind
     * it down before its process ends.
     */
    const forgetByNewSession = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        yield* markSessionLost(ctx.acpSessionId);
        const working = () =>
          ctx.activeTurnId !== undefined || ctx.workAfterPrompt.size > 0 || ctx.subagentsOut > 0;
        if (working()) {
          yield* interruptTurn(ctx.threadId).pipe(Effect.ignore);
          yield* Effect.gen(function* () {
            while (working()) yield* Effect.sleep("50 millis");
          }).pipe(Effect.timeoutOption(ACP_REVERT_WIND_DOWN));
        }
        yield* stopSessionInternal(ctx);
      });

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.flatMap(requireSession(threadId), (ctx) => stopSessionInternal(ctx)),
      );

    /**
     * A turn in flight counts as running, waiting on the user's answer or
     * approval included: that's what keeps the idle reaper from stopping it
     * (and closing the prompt) while the user is away.
     */
    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values(), (c) =>
          c.activeTurnId !== undefined && c.session.status === "ready"
            ? { ...c.session, status: "running" as const }
            : { ...c.session },
        ),
      );

    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // A snapshot per run: stopping a session removes it from the map.
    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.suspend(() =>
        Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
          discard: true,
        }),
      );

    /**
     * A launched subagent's steps, read from the agent's own records
     * (`subagents`), by its launching call's id. The newest page by default,
     * like other agents' transcripts.
     */
    const readSubagentTranscript = (subagents: AcpSubagents) =>
      ((threadId, input) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const read = yield* subagents.transcript({
            sessionId: ctx.acpSessionId,
            launchCallId: input.agentId,
          });
          if (read === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "readSubagentTranscript",
              detail: subagents.unrecordedMessage,
            });
          }
          const total = read.entries.length;
          const limit = input.limit !== undefined && input.limit > 0 ? input.limit : total;
          const offset = input.fromEnd
            ? Math.max(0, total - limit)
            : Math.min(input.offset ?? 0, total);
          const role = read.launch.role.trim();
          return {
            entries: read.entries.slice(offset, offset + limit),
            truncated: read.truncated || offset > 0 || offset + limit < total,
            offset,
            totalEntries: total,
            agent: {
              id: read.childId,
              ...(role ? { agentType: role, description: role } : {}),
              spawnDepth: 1,
              directInput: "unsupported" as const,
            },
          };
        })) satisfies NonNullable<AcpAdapterShape["readSubagentTranscript"]>;

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (ctx) => stopSessionInternal(ctx), { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: descriptor.rollbackByNewSession ? "new-session" : "none",
        ...(descriptor.steer || descriptor.steerWithPrompt
          ? { activeTurnSteering: "supported" as const }
          : {}),
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
      noteBeforeStop: processes.beforeStop,
      confirmThreadStopped: processes.confirm,
      listProcesses: processes.owners,
      ...(descriptor.subagents
        ? { readSubagentTranscript: readSubagentTranscript(descriptor.subagents) }
        : {}),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AcpAdapterShape;
  });
}
