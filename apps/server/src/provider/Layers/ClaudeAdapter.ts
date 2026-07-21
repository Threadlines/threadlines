/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  type HookCallback,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type RewindFilesResult,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@threadlines/shared/cliArgs";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSteerTurnInput,
  type ProviderSubagentTranscriptEntry,
  type ProviderSubagentTranscriptResult,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeSessionExitKind,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@threadlines/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@threadlines/shared/model";
import { renderThreadContextSeed, withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { countStructuredPatchStats, type FileChangeStat } from "@threadlines/shared/diffStats";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  claudeProjectDirectoryName,
  ensureClaudeSessionTranscript,
  resolveClaudeConfigDir,
} from "../Drivers/ClaudeSessionTranscripts.ts";
import { addProviderAuthHint, isProviderAuthErrorMessage } from "../providerAuthHints.ts";
import {
  claudeModelSupportsAutoRuntimeMode,
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const COMPACT_CONTEXT_COMMAND = "/compact";
const MAX_CLAUDE_FALLBACK_MODELS = 3;
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function resolveClaudeFallbackModelOption(
  fallbackModel: ReadonlyArray<string>,
  primaryModels: ReadonlyArray<string | undefined>,
): string | undefined {
  const skippedPrimaryModels = new Set(
    primaryModels
      .map((model) => model?.trim())
      .filter((model): model is string => model !== undefined && model.length > 0),
  );
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of fallbackModel) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed) || skippedPrimaryModels.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_CLAUDE_FALLBACK_MODELS) {
      break;
    }
  }
  return normalized.length > 0 ? normalized.join(",") : undefined;
}

function splitClaudeFallbackModelOption(value: string | undefined): ReadonlyArray<string> {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  thinkingTokensEstimate?: number;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

type ClaudeTaskStatus = "pending" | "running" | "completed" | "failed" | "killed" | "paused";

interface ClaudeTaskSnapshot {
  readonly description?: string;
  readonly status?: ClaudeTaskStatus;
  /** tool_use_id of the call that started the task (from task_started), so
   *  every task.completed emitter can link back to the originating tool. */
  readonly toolUseId?: string;
  /** Subagent type of agent tasks (from task_started), replayed on progress
   *  events that omit it so consumers can keep classifying the task. */
  readonly subagentType?: string;
  /** SDK task type (e.g. "local_agent", "local_bash"), so notification
   *  handling can tell agent tasks from background commands. */
  readonly taskType?: string;
}

type ClaudeStructuredAgentToolResult =
  | {
      readonly status: "async_launched";
      readonly agentId: string;
      readonly description?: string;
      readonly raw: Record<string, unknown>;
    }
  | {
      readonly status: "remote_launched";
      readonly remoteTaskId: string;
      readonly description?: string;
      readonly raw: Record<string, unknown>;
    }
  | {
      readonly status: "completed";
      readonly agentId: string;
      readonly resultText?: string;
      readonly raw: Record<string, unknown>;
    };

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  // Interaction mode of the most recent turn. canUseTool consults it so plan
  // turns never inherit the auto-allow of permissive runtime modes.
  currentInteractionMode: ProviderInteractionMode | undefined;
  currentApiModelId: string | undefined;
  currentFlagSettings: ClaudeFlagSettingsSnapshot;
  readonly currentFallbackModelIds: ReadonlyArray<string>;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
    assistantUuid?: string;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  /** Subagent launches (collab-agent tool calls), keyed by tool_use_id. Kept
   *  for the session lifetime so a later task notification (background agents
   *  settle between turns and may notify more than once) can re-emit the
   *  originating tool item with the agent's real final message. */
  readonly collabAgentToolsByItemId: Map<string, ToolInFlight>;
  /** Final background-agent results already replayed onto their originating
   *  tool item. The SDK can surface the same completion through both a
   *  structured tool_use_result and a legacy task-notification message. */
  readonly completedCollabAgentItemIds: Set<string>;
  /** Structured final results already applied. Kept separately so a richer
   *  structured result can supersede an earlier legacy notification once. */
  readonly structuredCompletedCollabAgentItemIds: Set<string>;
  /** Per-file +/- counts captured by the PostToolUse hook, keyed by tool_use_id.
   *  Consumed when the matching tool_result is emitted. */
  readonly fileChangeStatsByToolUseId: Map<string, FileChangeStat>;
  readonly tasks: Map<string, ClaudeTaskSnapshot>;
  /** Task ids whose lifecycle start edge was already emitted in this Claude
   *  process. Kept separate from task metadata so reordered progress cannot
   *  suppress the real start edge. */
  readonly startedTaskIds: Set<string>;
  /** Whether this Claude process has demonstrated support for authoritative
   *  background-task snapshots. Older user-configured binaries retain the
   *  legacy edge-counting fallback until this becomes true. */
  backgroundTaskSnapshotObserved: boolean;
  /** Mirror of the SDK task tracker (TaskCreate/TaskUpdate/TaskList), keyed
   *  by task id once the create result reveals it. Session-scoped because the
   *  tracker list persists across turns. */
  readonly planTracker: Map<string, PlanTrackerTask>;
  lastEmittedPlanTrackerFingerprint: string | undefined;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastEmittedTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastCompletedTurnId: TurnId | undefined;
  lastThreadStartedId: string | undefined;
  // Rendered cross-driver handoff preamble, injected ahead of the first user
  // turn and cleared once consumed. Set only when a session starts from a
  // context seed (no native resume).
  pendingContextSeedText: string | undefined;
  stopped: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  /** Optional: absent on user-configured CLI builds that predate the
   *  apply_flag_settings control request. */
  readonly applyFlagSettings?: (settings: {
    readonly effortLevel?: ClaudeSdkEffort | null;
    readonly alwaysThinkingEnabled?: boolean | null;
    readonly fastMode?: boolean | null;
    readonly ultracode?: boolean | null;
  }) => Promise<void>;
  readonly getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
  readonly rewindFiles?: (
    userMessageId: string,
    options?: { readonly dryRun?: boolean },
  ) => Promise<RewindFilesResult>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Invoked whenever the SDK reports changed rate-limit info mid-turn. The
   * driver folds these into the instance's provider snapshot so account
   * usage updates live instead of waiting for the next probe.
   */
  readonly onAccountRateLimitsUpdated?: (rateLimitInfo: SDKRateLimitInfo) => Effect.Effect<void>;
  /**
   * Reports authoritative chat-auth edges from live turns. Provider discovery
   * only proves that a credential is configured; an assistant response
   * verifies it, while an authentication error invalidates the cached ready
   * state.
   */
  readonly onChatAuthStateChanged?: (status: "verified" | "unauthenticated") => Effect.Effect<void>;
}

/**
 * Directory a successful EnterWorktree call moved the session into.
 * Entering an existing worktree passes it as the `path` input; created
 * worktrees are parsed from the result sentence ("Created worktree at
 * <path> on branch <name>"). Undefined when unrecognized — the next
 * session init reports the effective cwd and self-corrects.
 */
export function parseEnterWorktreeCwd(
  input: Record<string, unknown>,
  resultText: string,
): string | undefined {
  const explicitPath = input["path"];
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    return explicitPath.trim();
  }
  const created = /Created worktree at (.+?) on branch /.exec(resultText);
  const parsed = created?.[1]?.trim();
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toProcessError(
  cause: unknown,
  fallback: string,
  threadId: ThreadId,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: toMessage(cause, fallback),
    cause,
  });
}

function normalizeClaudeStreamMessages(
  cause: Cause.Cause<{ readonly message: string }>,
): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function getEffectiveClaudeAgentEffort(effort: string | null | undefined): ClaudeSdkEffort | null {
  const normalized = normalizeClaudeCliEffort(effort);
  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

/** Session option knobs that map to the SDK's flag-settings layer. Derived
 *  from the model selection at session start and re-derived per turn so
 *  changes apply in-session via `applyFlagSettings` instead of a restart. */
interface ClaudeFlagSettingsSnapshot {
  readonly effortLevel: ClaudeSdkEffort | null;
  readonly alwaysThinkingEnabled: boolean | null;
  readonly fastMode: boolean;
  readonly ultracode: boolean;
}

function deriveClaudeFlagSettings(
  modelSelection: ModelSelection | undefined,
): ClaudeFlagSettingsSnapshot {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const descriptors = getProviderOptionDescriptors({ caps });
  const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
  const effort = resolveClaudeEffort(caps, rawEffort) ?? null;
  const fastModeSupported = descriptors.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  const thinkingSupported = descriptors.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
  );
  const fastMode =
    getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true && fastModeSupported;
  const thinking = thinkingSupported
    ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
    : undefined;
  return {
    effortLevel: getEffectiveClaudeAgentEffort(effort),
    alwaysThinkingEnabled: typeof thinking === "boolean" ? thinking : null,
    fastMode,
    ultracode: isClaudeUltracodeEffort(effort),
  };
}

function claudeFlagSettingsEqual(
  left: ClaudeFlagSettingsSnapshot,
  right: ClaudeFlagSettingsSnapshot,
): boolean {
  return (
    left.effortLevel === right.effortLevel &&
    left.alwaysThinkingEnabled === right.alwaysThinkingEnabled &&
    left.fastMode === right.fastMode &&
    left.ultracode === right.ultracode
  );
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<{ readonly message: string }>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(
  cause: Cause.Cause<{ readonly message: string }>,
  fallback: string,
): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

/**
 * A SIGTERM exit (code 143) is always an intentional stop — app quit during
 * an update, session reaping, or an operator kill — never a Claude crash.
 * During app shutdown the child can die before this adapter's finalizer marks
 * the session stopped, so the stream reports it as a process failure; treat
 * it as an interruption instead of persisting a scary provider error.
 */
function isClaudeSigtermExitCause(cause: Cause.Cause<{ readonly message: string }>): boolean {
  return normalizeClaudeStreamMessages(cause).some(
    (message) => /exited with code 143\b/i.test(message) || /\bSIGTERM\b/.test(message),
  );
}

function interruptionMessageFromClaudeCause(
  cause: Cause.Cause<{ readonly message: string }>,
): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = value.contextWindow;
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

interface ClaudeUsageTotals {
  readonly totalProcessedTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

type ClaudeContextUsageReadResult =
  | {
      readonly ok: true;
      readonly value: SDKControlGetContextUsageResponse;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
    };

function asPositiveFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function readClaudeUsageTotals(value: unknown): ClaudeUsageTotals | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const rawInputTokens =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
  const cachedInputTokens =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0;
  const inputTokens = rawInputTokens + cacheCreationInputTokens + cachedInputTokens;
  const outputTokens =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : 0;
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  return {
    totalProcessedTokens: Math.round(totalProcessedTokens),
    ...(inputTokens > 0 ? { inputTokens: Math.round(inputTokens) } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens: Math.round(cachedInputTokens) } : {}),
    ...(outputTokens > 0 ? { outputTokens: Math.round(outputTokens) } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: Math.round(usage.tool_uses) }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: Math.round(usage.duration_ms) }
      : {}),
  };
}

function normalizeClaudeContextUsage(
  value: SDKControlGetContextUsageResponse | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!value) {
    return undefined;
  }

  const usedTokens = asPositiveFiniteInteger(value.totalTokens);
  if (usedTokens === undefined) {
    return undefined;
  }

  const maxTokens =
    asPositiveFiniteInteger(value.maxTokens) ?? asPositiveFiniteInteger(value.rawMaxTokens);

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    compactsAutomatically: value.isAutoCompactEnabled,
  };
}

const THREAD_TOKEN_USAGE_SNAPSHOT_KEYS = [
  "usedTokens",
  "totalProcessedTokens",
  "maxTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "lastUsedTokens",
  "lastInputTokens",
  "lastCachedInputTokens",
  "lastOutputTokens",
  "lastReasoningOutputTokens",
  "toolUses",
  "durationMs",
  "compactsAutomatically",
] as const satisfies ReadonlyArray<keyof ThreadTokenUsageSnapshot>;

function areThreadTokenUsageSnapshotsEqual(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return THREAD_TOKEN_USAGE_SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}

function normalizeClaudeCompactBoundaryUsage(
  value: SDKMessage,
  lastKnownUsage: ThreadTokenUsageSnapshot | undefined,
  lastKnownContextWindow: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (sdkMessageSubtype(value) !== "compact_boundary") {
    return undefined;
  }

  const metadata =
    value && typeof value === "object"
      ? (value as { readonly compact_metadata?: unknown }).compact_metadata
      : undefined;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const postTokens = asPositiveFiniteInteger(
    (metadata as { readonly post_tokens?: unknown }).post_tokens,
  );
  if (postTokens === undefined) {
    return undefined;
  }

  const maxTokens = lastKnownUsage?.maxTokens ?? lastKnownContextWindow;
  return {
    usedTokens: postTokens,
    lastUsedTokens: postTokens,
    ...(maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0
      ? { maxTokens: Math.round(maxTokens) }
      : {}),
    ...(lastKnownUsage?.compactsAutomatically !== undefined
      ? { compactsAutomatically: lastKnownUsage.compactsAutomatically }
      : {}),
  };
}

function mergeClaudeProcessedUsageTotals(
  usage: ThreadTokenUsageSnapshot,
  totals: ClaudeUsageTotals | undefined,
): ThreadTokenUsageSnapshot {
  if (!totals) {
    return usage;
  }

  return {
    ...usage,
    ...(totals.totalProcessedTokens > usage.usedTokens
      ? { totalProcessedTokens: totals.totalProcessedTokens }
      : {}),
    ...(totals.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
    ...(totals.cachedInputTokens !== undefined
      ? { cachedInputTokens: totals.cachedInputTokens }
      : {}),
    ...(totals.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
    ...(totals.inputTokens !== undefined ? { lastInputTokens: totals.inputTokens } : {}),
    ...(totals.cachedInputTokens !== undefined
      ? { lastCachedInputTokens: totals.cachedInputTokens }
      : {}),
    ...(totals.outputTokens !== undefined ? { lastOutputTokens: totals.outputTokens } : {}),
    ...(totals.toolUses !== undefined ? { toolUses: totals.toolUses } : {}),
    ...(totals.durationMs !== undefined ? { durationMs: totals.durationMs } : {}),
  };
}

function normalizeClaudeThinkingTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const estimatedTokens = record.estimated_tokens;
  if (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens)) {
    return undefined;
  }

  return Math.max(0, Math.round(estimatedTokens));
}

function applyClaudeThinkingTokenUsage(
  usage: ThreadTokenUsageSnapshot | undefined,
  turnState: ClaudeTurnState | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || turnState?.thinkingTokensEstimate === undefined) {
    return usage;
  }

  const reasoningOutputTokens = Math.max(
    usage.reasoningOutputTokens ?? 0,
    turnState.thinkingTokensEstimate,
  );
  if (reasoningOutputTokens <= 0) {
    return usage;
  }

  return {
    ...usage,
    reasoningOutputTokens,
    lastReasoningOutputTokens: Math.max(
      usage.lastReasoningOutputTokens ?? 0,
      reasoningOutputTokens,
    ),
  };
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  // MCP tools first: an MCP tool named e.g. `mcp__fs__write_file` must not
  // fall into the file-change keyword bucket below.
  if (normalized.startsWith("mcp__") || normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  // TodoWrite is a planning surface, not a workspace file change, despite
  // the "write" in its name.
  if (isTodoTool(normalized)) {
    return "dynamic_tool_call";
  }
  // Task tracker tools are a planning surface too; "TaskCreate" must not
  // fall into the file-change "create" keyword bucket below.
  if (taskTrackerToolKind(normalized) !== undefined) {
    return "dynamic_tool_call";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type PlanTrackerTask = {
  readonly subject: string;
  readonly status: "pending" | "inProgress" | "completed";
};

type TaskTrackerToolKind = "create" | "update" | "get" | "list";

/** Newer Claude Code builds track plans with the incremental task tools
 *  (TaskCreate/TaskUpdate/TaskGet/TaskList) instead of TodoWrite; both must
 *  drive the same plan UI. */
function taskTrackerToolKind(toolName: string): TaskTrackerToolKind | undefined {
  switch (toolName.toLowerCase()) {
    case "taskcreate":
      return "create";
    case "taskupdate":
      return "update";
    case "taskget":
      return "get";
    case "tasklist":
      return "list";
    default:
      return undefined;
  }
}

function planTrackerStatus(value: unknown): PlanTrackerTask["status"] | undefined {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

function planStepsFromPlanTracker(planTracker: ReadonlyMap<string, PlanTrackerTask>): PlanStep[] {
  return [...planTracker.values()].map((task) => ({
    step: task.subject,
    status: task.status,
  }));
}

/** TaskCreate inputs carry no task id; the id only arrives in the tool
 *  result, so fresh tasks are keyed provisionally by tool_use id until the
 *  result rebinds them. */
const PROVISIONAL_PLAN_TASK_KEY_PREFIX = "toolUse:";

function applyPlanTrackerToolInput(
  planTracker: Map<string, PlanTrackerTask>,
  kind: TaskTrackerToolKind,
  toolUseId: string,
  input: Record<string, unknown>,
): boolean {
  if (kind === "create") {
    const key = `${PROVISIONAL_PLAN_TASK_KEY_PREFIX}${toolUseId}`;
    const subject = nonEmptyString(input.subject) ?? "Task";
    const existing = planTracker.get(key);
    if (existing?.subject === subject) {
      return false;
    }
    planTracker.set(key, { subject, status: existing?.status ?? "pending" });
    return true;
  }
  if (kind !== "update") {
    return false;
  }
  const taskId = nonEmptyString(input.taskId);
  if (!taskId) {
    return false;
  }
  if (input.status === "deleted") {
    return planTracker.delete(taskId);
  }
  const status = planTrackerStatus(input.status);
  const subject = nonEmptyString(input.subject);
  const existing = planTracker.get(taskId);
  if (!existing) {
    // Updates can reference tasks created before this process attached
    // (resumed session); render a placeholder so progress still shows until
    // a TaskList result resyncs the real subjects.
    planTracker.set(taskId, {
      subject: subject ?? `Task #${taskId}`,
      status: status ?? "pending",
    });
    return true;
  }
  const next = { subject: subject ?? existing.subject, status: status ?? existing.status };
  if (next.subject === existing.subject && next.status === existing.status) {
    return false;
  }
  planTracker.set(taskId, next);
  return true;
}

const TASK_CREATE_RESULT_PATTERN = /^Task #(\S+) created successfully(?::\s*(.*))?$/;
const TASK_LIST_RESULT_LINE_PATTERN = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/;

function applyPlanTrackerToolResult(
  planTracker: Map<string, PlanTrackerTask>,
  kind: TaskTrackerToolKind,
  toolUseId: string,
  result: { readonly text: string; readonly isError: boolean },
): boolean {
  if (kind === "create") {
    const provisionalKey = `${PROVISIONAL_PLAN_TASK_KEY_PREFIX}${toolUseId}`;
    if (result.isError) {
      return planTracker.delete(provisionalKey);
    }
    const match = TASK_CREATE_RESULT_PATTERN.exec(result.text.trim().split("\n")[0] ?? "");
    const taskId = match?.[1];
    if (!taskId) {
      return false;
    }
    const provisional = planTracker.get(provisionalKey);
    if (!provisional) {
      // Input was never observed (e.g. replayed history): insert from the result.
      if (planTracker.has(taskId)) {
        return false;
      }
      planTracker.set(taskId, {
        subject: nonEmptyString(match?.[2]) ?? `Task #${taskId}`,
        status: "pending",
      });
      return true;
    }
    // Re-key provisional → real id, preserving creation order. The rendered
    // plan is unchanged, so no emission is needed.
    const rebuilt = [...planTracker.entries()].map(
      ([key, task]) => [key === provisionalKey ? taskId : key, task] as const,
    );
    planTracker.clear();
    for (const [key, task] of rebuilt) {
      planTracker.set(key, task);
    }
    return false;
  }
  if (kind !== "list" || result.isError) {
    return false;
  }
  const parsed: Array<readonly [string, PlanTrackerTask]> = [];
  for (const line of result.text.split("\n")) {
    const match = TASK_LIST_RESULT_LINE_PATTERN.exec(line.trim());
    if (!match) {
      continue;
    }
    parsed.push([
      match[1] as string,
      {
        subject: nonEmptyString(match[3]) ?? `Task #${match[1]}`,
        status: planTrackerStatus(match[2]) ?? "pending",
      },
    ]);
  }
  if (parsed.length === 0) {
    return false;
  }
  // TaskList output is the authoritative snapshot: resync the local mirror.
  planTracker.clear();
  for (const [key, task] of parsed) {
    planTracker.set(key, task);
  }
  return true;
}

function normalizeClaudeTaskStatus(value: unknown): ClaudeTaskStatus | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "killed":
    case "paused":
      return value;
    default:
      return undefined;
  }
}

function completedTaskStatusFromClaudeStatus(
  status: ClaudeTaskStatus | undefined,
): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}

function isClaudeAgentTaskType(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "local_agent" || normalized === "remote_agent";
}

function describeClaudeTaskStatus(status: ClaudeTaskStatus | undefined): string {
  switch (status) {
    case "pending":
      return "Task pending";
    case "paused":
      return "Task paused";
    case "running":
      return "Task running";
    case "completed":
      return "Task completed";
    case "failed":
      return "Task failed";
    case "killed":
      return "Task stopped";
    default:
      return "Task updated";
  }
}

/** Strips the workspace root from absolute paths so activity rows read
 *  `apps/web/src/...` instead of `C:\Users\...`. Comparison is
 *  case-insensitive to cover Windows paths. */
function relativizePathForDisplay(value: string, cwd: string | undefined): string {
  if (!cwd) {
    return value;
  }
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    normalizedCwd.length > 0 &&
    normalizedValue.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
  ) {
    return normalizedValue.slice(normalizedCwd.length + 1);
  }
  return value;
}

function isMcpToolName(toolName: string): boolean {
  return toolName.toLowerCase().startsWith("mcp__");
}

/** `mcp__linear__create_issue` → `linear · create_issue`. */
function formatMcpToolDisplayName(toolName: string): string {
  const segments = toolName.split("__").filter((segment) => segment.length > 0);
  if (segments.length >= 3 && segments[0]?.toLowerCase() === "mcp") {
    return `${segments[1]} · ${segments.slice(2).join("__")}`;
  }
  return toolName;
}

function summarizeTodoInput(input: Record<string, unknown>): string | undefined {
  const steps = extractPlanStepsFromTodoInput(input);
  if (!steps || steps.length === 0) {
    return undefined;
  }
  const active = steps.find((step) => step.status === "inProgress");
  const completed = steps.filter((step) => step.status === "completed").length;
  const progress = `${completed}/${steps.length}`;
  return active ? `${progress} · ${active.step}` : `${progress} done`;
}

/** Compact `key=value` preview for tools without a dedicated summary. */
function summarizeGenericToolArguments(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const key of [
    "url",
    "uri",
    "path",
    "file_path",
    "filePath",
    "query",
    "pattern",
    "command",
    "skill",
    "name",
    "id",
    "task_id",
    "shell_id",
    "description",
    "prompt",
    "text",
  ]) {
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const compact = value.trim().replace(/\s+/gu, " ");
    parts.push(`${key}=${compact.length > 64 ? `${compact.slice(0, 63)}…` : compact}`);
    if (parts.length >= 2) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function summarizeToolRequest(
  toolName: string,
  input: Record<string, unknown>,
  options?: { readonly cwd?: string | undefined },
): string {
  const cwd = options?.cwd;
  const text = nonEmptyString;
  const displayPath = (value: unknown): string | undefined => {
    const trimmed = text(value);
    return trimmed ? relativizePathForDisplay(trimmed, cwd) : undefined;
  };

  const itemType = classifyToolItemType(toolName);
  const command = text(input.command ?? input.cmd);
  if (command && itemType === "command_execution") {
    return command.slice(0, 400);
  }

  switch (toolName.toLowerCase()) {
    case "read":
    case "edit":
    case "write": {
      const path = displayPath(input.file_path ?? input.filePath ?? input.path);
      if (path) {
        return path;
      }
      break;
    }
    case "notebookedit": {
      const path = displayPath(input.notebook_path);
      if (path) {
        return path;
      }
      break;
    }
    case "glob":
    case "grep": {
      const pattern = text(input.pattern);
      const scope = displayPath(input.path) ?? text(input.glob);
      if (pattern) {
        return scope ? `${pattern} in ${scope}` : pattern;
      }
      break;
    }
    case "webfetch": {
      const url = text(input.url);
      if (url) {
        return url;
      }
      break;
    }
    case "websearch":
    case "toolsearch": {
      const query = text(input.query);
      if (query) {
        return query;
      }
      break;
    }
    case "skill": {
      const skill = text(input.skill);
      const args = text(input.args);
      if (skill) {
        return args ? `${skill}: ${args.slice(0, 200)}` : skill;
      }
      break;
    }
    case "todowrite": {
      const todoSummary = summarizeTodoInput(input);
      if (todoSummary) {
        return todoSummary;
      }
      break;
    }
    case "taskcreate": {
      const subject = text(input.subject);
      if (subject) {
        return `Add task: ${subject.slice(0, 200)}`;
      }
      break;
    }
    case "taskupdate": {
      const taskId = text(input.taskId);
      if (taskId) {
        if (input.status === "deleted") {
          return `Task #${taskId} removed`;
        }
        const status = planTrackerStatus(input.status);
        if (status === "completed") {
          return `Task #${taskId} completed`;
        }
        if (status === "inProgress") {
          return `Task #${taskId} started`;
        }
        const subject = text(input.subject);
        if (subject) {
          return `Task #${taskId}: ${subject.slice(0, 200)}`;
        }
        return `Task #${taskId} updated`;
      }
      break;
    }
    case "taskget": {
      const taskId = text(input.taskId);
      if (taskId) {
        return `Task #${taskId}`;
      }
      break;
    }
    case "tasklist":
      return "Task list";
    case "askuserquestion": {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = questions[0];
      const question =
        first && typeof first === "object"
          ? text((first as Record<string, unknown>).question)
          : undefined;
      if (question) {
        return question.slice(0, 200);
      }
      break;
    }
    case "exitplanmode":
      // The `ExitPlanMode:` prefix is load-bearing: the web client filters
      // these rows out of the work log by matching it.
      return "ExitPlanMode: plan proposed";
    default:
      break;
  }

  // For agent/subagent tools, prefer human-readable description or prompt over raw JSON
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const subagentType =
      typeof input.subagent_type === "string" ? input.subagent_type.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return subagentType ? `${subagentType}: ${label}` : label;
    }
  }

  if (isMcpToolName(toolName)) {
    const displayName = formatMcpToolDisplayName(toolName);
    const argumentSummary = summarizeGenericToolArguments(input);
    return argumentSummary ? `${displayName}: ${argumentSummary}` : displayName;
  }

  const argumentSummary = summarizeGenericToolArguments(input);
  if (argumentSummary) {
    return `${toolName}: ${argumentSummary}`;
  }

  if (Object.keys(input).length === 0) {
    return toolName;
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? "[unserializable input]";
  if (serialized.length <= 200) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 197)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

/** Friendly titles for Claude Code's built-in tools; the generic item-type
 *  title is only a fallback. The web client keys row headings off these
 *  (e.g. "Read file" renders as "Read <basename>"). */
function titleForToolName(toolName: string, itemType: CanonicalItemType): string {
  switch (toolName.toLowerCase()) {
    case "read":
      return "Read file";
    case "glob":
    case "grep":
      return "Search";
    case "toolsearch":
      return "Tool search";
    case "webfetch":
      return "Web fetch";
    case "todowrite":
      return "Update todos";
    case "taskcreate":
    case "taskupdate":
      return "Update tasks";
    case "taskget":
    case "tasklist":
      return "Tasks";
    case "skill":
      return "Skill";
    case "askuserquestion":
      return "Question";
    case "enterplanmode":
    case "exitplanmode":
      return "Plan";
    default:
      return titleForTool(itemType);
  }
}

/** Renders an SDK `api_retry` system message as a short status line, e.g.
 *  "Claude API rate limited, retrying in 4s (attempt 2/10)". */
function describeApiRetry(message: unknown): string {
  const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const status = typeof record.error_status === "number" ? record.error_status : null;
  const reason =
    status === 429
      ? "Claude API rate limited"
      : status === 529
        ? "Claude API overloaded"
        : status !== null
          ? `Claude API error ${status}`
          : "Claude API connection issue";
  const delayMs = typeof record.retry_delay_ms === "number" ? record.retry_delay_ms : undefined;
  const delay =
    delayMs !== undefined
      ? `, retrying in ${Math.max(1, Math.round(delayMs / 1000))}s`
      : ", retrying";
  const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
  const maxRetries = typeof record.max_retries === "number" ? record.max_retries : undefined;
  const attempts =
    attempt !== undefined && maxRetries !== undefined ? ` (attempt ${attempt}/${maxRetries})` : "";
  return `${reason}${delay}${attempts}`;
}

/**
 * Derives per-file +/- counts from a PostToolUse hook payload for the
 * built-in file tools. `structuredPatch` is the exact diff of the single
 * edit; `gitDiff` (working-tree relative) is only a fallback.
 */
function fileChangeStatFromHookInput(hookInput: unknown): FileChangeStat | null {
  if (!hookInput || typeof hookInput !== "object") {
    return null;
  }
  const record = hookInput as Record<string, unknown>;
  if (record.hook_event_name !== "PostToolUse") {
    return null;
  }
  const response =
    record.tool_response && typeof record.tool_response === "object"
      ? (record.tool_response as Record<string, unknown>)
      : null;
  if (!response) {
    return null;
  }
  const toolInput =
    record.tool_input && typeof record.tool_input === "object"
      ? (record.tool_input as Record<string, unknown>)
      : {};

  const pathCandidates = [
    response.filePath,
    response.notebook_path,
    toolInput.file_path,
    toolInput.notebook_path,
  ];
  const path = pathCandidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!path) {
    return null;
  }

  const kind: FileChangeStat["kind"] =
    response.type === "create" || response.originalFile === null ? "add" : "update";

  const patchStats = countStructuredPatchStats(response.structuredPatch);
  if (patchStats) {
    return { path, kind, ...patchStats };
  }

  const gitDiff =
    response.gitDiff && typeof response.gitDiff === "object"
      ? (response.gitDiff as Record<string, unknown>)
      : null;
  if (
    gitDiff &&
    typeof gitDiff.additions === "number" &&
    Number.isFinite(gitDiff.additions) &&
    typeof gitDiff.deletions === "number" &&
    Number.isFinite(gitDiff.deletions)
  ) {
    return {
      path,
      kind: gitDiff.status === "added" ? "add" : "update",
      additions: gitDiff.additions,
      deletions: gitDiff.deletions,
    };
  }

  return null;
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

function buildPromptText(
  input: Pick<ProviderSendTurnInput | ProviderSteerTurnInput, "input">,
): string {
  return input.input?.trim() ?? "";
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
  readonly userMessageId?: MessageId;
}): SDKUserMessage {
  const uuid = input.userMessageId && isUuid(input.userMessageId) ? input.userMessageId : undefined;
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

/** Claude reads PDFs natively as base64 document blocks and text-shaped
 *  files (plain text, markdown, CSV) as text document sources; both were
 *  verified end-to-end through the agent SDK streaming input path. */
function buildClaudeDocumentContentBlock(input: {
  readonly kind: "pdf" | "text";
  readonly name: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "document",
    title: input.name,
    source:
      input.kind === "pdf"
        ? {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(input.bytes).toString("base64"),
          }
        : {
            type: "text",
            media_type: "text/plain",
            data: Buffer.from(input.bytes).toString("utf8"),
          },
  };
}

const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: Pick<
    ProviderSendTurnInput | ProviderSteerTurnInput,
    "messageId" | "input" | "attachments"
  >,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly method?: "turn/start" | "turn/steer";
    readonly seedPreamble?: string | undefined;
  },
) {
  const method = dependencies.method ?? "turn/start";
  const promptText = buildPromptText(input);
  // Cross-driver handoff: lead the first turn with the rendered seed.
  const text = dependencies.seedPreamble
    ? withContextSeedPreamble(dependencies.seedPreamble, promptText)
    : promptText;
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "image" &&
      !SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );

    sdkContent.push(
      attachment.type === "image"
        ? buildClaudeImageContentBlock({
            mimeType: attachment.mimeType,
            bytes,
          })
        : buildClaudeDocumentContentBlock({
            kind: attachment.kind,
            name: attachment.name,
            bytes,
          }),
    );
  }

  return buildUserMessage({
    sdkContent,
    ...(input.messageId !== undefined ? { userMessageId: input.messageId } : {}),
  });
});

function buildSlashCommandUserMessage(command: string): SDKUserMessage {
  return buildUserMessage({
    sdkContent: [{ type: "text", text: command }],
  });
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

function firstNonEmptyString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function describeClaudeModelFallbackReason(
  message: Record<string, unknown>,
  fallback: string,
): string {
  const trigger = firstNonEmptyString(message.trigger, message.reason, message.cause);
  if (trigger) {
    return trigger.startsWith("fallback:") ? trigger : `fallback:${trigger}`;
  }
  return fallback;
}

function extractClaudeModelFallback(
  context: ClaudeSessionContext,
  message: SDKMessage,
  fallbackReason: string,
):
  | {
      readonly fromModel: string;
      readonly toModel: string;
      readonly reason: string;
    }
  | undefined {
  const record = message as unknown as Record<string, unknown>;
  const fromModel = firstNonEmptyString(
    record.original_model,
    record.originalModel,
    record.primary_model,
    record.primaryModel,
    record.requested_model,
    record.requestedModel,
    record.from_model,
    record.fromModel,
    context.currentApiModelId,
    context.session.model,
  );
  const toModel = firstNonEmptyString(
    record.fallback_model,
    record.fallbackModel,
    record.effective_model,
    record.effectiveModel,
    record.actual_model,
    record.actualModel,
    record.to_model,
    record.toModel,
    context.currentFallbackModelIds[0],
  );
  if (!fromModel || !toModel || fromModel === toModel) {
    return undefined;
  }
  return {
    fromModel,
    toModel,
    reason: describeClaudeModelFallbackReason(record, fallbackReason),
  };
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

/** Latest live message cap per subagent; long messages truncate rather than
 *  growing runtime-event payloads unboundedly. */
const SUBAGENT_LIVE_TEXT_MAX_CHARS = 4_000;

const SUBAGENT_TRANSCRIPT_DEFAULT_LIMIT = 200;
const SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS = 4_000;
const SUBAGENT_TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS = 2_000;
/** Agent ids come from the client and end up in a filesystem path; anything
 *  outside this shape is rejected before it can traverse. */
const SUBAGENT_AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function capTranscriptText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Maps a subagent transcript JSONL (Claude Code's on-disk
 * `subagents/agent-<id>.jsonl`) into renderable entries: thinking becomes its
 * own muted entry, assistant text and tool calls stay together, and tool
 * results surface as capped output previews.
 */
export function mapClaudeSubagentTranscript(
  jsonl: string,
  options?: { readonly limit?: number },
): ProviderSubagentTranscriptResult {
  const limit =
    options?.limit !== undefined && options.limit > 0
      ? options.limit
      : SUBAGENT_TRANSCRIPT_DEFAULT_LIMIT;
  const entries: Array<ProviderSubagentTranscriptEntry> = [];
  let truncated = false;

  const push = (entry: ProviderSubagentTranscriptEntry): boolean => {
    if (entries.length >= limit) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  for (const line of jsonl.split("\n")) {
    if (truncated) {
      break;
    }
    const record = line.trim();
    if (record.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const { type, message } = parsed as { type?: unknown; message?: unknown };
    if (type !== "user" && type !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown } | undefined)?.content;

    if (typeof content === "string") {
      const text = capTranscriptText(content, SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS);
      if (text.length > 0) {
        push({ role: type, text, toolUses: [] });
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }

    const texts: string[] = [];
    const toolUses: Array<{ name: string; summary: string }> = [];
    const resultPreviews: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const blockRecord = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        input?: unknown;
        content?: unknown;
      };
      if (blockRecord.type === "thinking" && typeof blockRecord.thinking === "string") {
        const thinkingText = capTranscriptText(
          blockRecord.thinking,
          SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS,
        );
        if (thinkingText.length > 0) {
          push({ role: "thinking", text: thinkingText, toolUses: [] });
        }
        continue;
      }
      if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
        texts.push(blockRecord.text);
        continue;
      }
      if (blockRecord.type === "tool_use" && typeof blockRecord.name === "string") {
        const input =
          blockRecord.input && typeof blockRecord.input === "object"
            ? (blockRecord.input as Record<string, unknown>)
            : {};
        toolUses.push({
          name: blockRecord.name,
          summary: summarizeGenericToolArguments(input) ?? "",
        });
        continue;
      }
      if (blockRecord.type === "tool_result") {
        const preview = capTranscriptText(
          extractTextContent(blockRecord.content),
          SUBAGENT_TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS,
        );
        if (preview.length > 0) {
          resultPreviews.push(preview);
        }
      }
    }

    const text = capTranscriptText(texts.join("\n"), SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS);
    const outputPreview = capTranscriptText(
      resultPreviews.join("\n"),
      SUBAGENT_TRANSCRIPT_OUTPUT_PREVIEW_MAX_CHARS,
    );
    if (text.length > 0 || toolUses.length > 0 || outputPreview.length > 0) {
      push({
        role: type,
        text,
        toolUses,
        ...(outputPreview.length > 0 ? { outputPreview } : {}),
      });
    }
  }

  return { entries, truncated };
}

/** Non-null `parent_tool_use_id` marks a message forwarded from inside a
 *  subagent (`forwardSubagentText`); absent or null means main conversation. */
function readParentToolUseId(message: SDKMessage): string | undefined {
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(result)) {
    return undefined;
  }
  const parsed = result.value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

/** The SDK exposes Agent/Task results twice: a model-facing tool_result block
 *  and this structured, tool-specific value. Prefer the structured value for
 *  identity and final output; its shape is versioned with the installed SDK
 *  and avoids parsing human-readable launch acknowledgements. */
function structuredAgentToolResultFromUserMessage(
  message: SDKMessage,
): ClaudeStructuredAgentToolResult | undefined {
  if (message.type !== "user") {
    return undefined;
  }

  const value = (message as SDKUserMessage).tool_use_result;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const status = nonEmptyString(raw.status);
  if (status === "async_launched") {
    const agentId = nonEmptyString(raw.agentId);
    if (
      !agentId ||
      !nonEmptyString(raw.description) ||
      !nonEmptyString(raw.prompt) ||
      !nonEmptyString(raw.outputFile)
    ) {
      return undefined;
    }
    const description = nonEmptyString(raw.description);
    return {
      status,
      agentId,
      ...(description ? { description } : {}),
      raw,
    };
  }
  if (status === "remote_launched") {
    const remoteTaskId = nonEmptyString(raw.taskId);
    if (
      !remoteTaskId ||
      !nonEmptyString(raw.description) ||
      !nonEmptyString(raw.prompt) ||
      !nonEmptyString(raw.sessionUrl) ||
      !nonEmptyString(raw.outputFile)
    ) {
      return undefined;
    }
    const description = nonEmptyString(raw.description);
    return {
      status,
      remoteTaskId,
      ...(description ? { description } : {}),
      raw,
    };
  }
  if (status !== "completed") {
    return undefined;
  }

  const agentId = nonEmptyString(raw.agentId);
  if (
    !agentId ||
    !Array.isArray(raw.content) ||
    !nonEmptyString(raw.prompt) ||
    !raw.usage ||
    typeof raw.usage !== "object" ||
    Array.isArray(raw.usage) ||
    typeof raw.totalToolUseCount !== "number" ||
    typeof raw.totalDurationMs !== "number" ||
    typeof raw.totalTokens !== "number"
  ) {
    return undefined;
  }
  const resultText = extractTextContent(raw.content).trim();
  return {
    status,
    agentId,
    ...(resultText ? { resultText } : {}),
    raw,
  };
}

function toolResultBlockWithStructuredAgentOutput(
  toolResult: ReturnType<typeof toolResultBlocksFromUserMessage>[number],
  structuredResult: ClaudeStructuredAgentToolResult | undefined,
): Record<string, unknown> {
  if (structuredResult?.status !== "completed") {
    return toolResult.block;
  }
  const structuredContent = structuredResult.raw.content;
  if (!Array.isArray(structuredContent)) {
    return toolResult.block;
  }
  return {
    ...toolResult.block,
    content: structuredContent,
  };
}

interface ClaudeTaskNotification {
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly status: "completed" | "failed" | "stopped";
  readonly summary?: string;
  readonly result?: string;
}

const TASK_NOTIFICATION_BLOCK_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/gu;

/** Tag contents are XML-escaped by the harness; `&amp;` must decode last. */
function decodeTaskNotificationText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function taskNotificationTagValue(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(block);
  const value = match?.[1];
  if (value === undefined) {
    return undefined;
  }
  const decoded = decodeTaskNotificationText(value).trim();
  return decoded.length > 0 ? decoded : undefined;
}

/** Background tasks settle between turns via synthetic `<task-notification>`
 *  user messages. For subagents these carry the agent's full final message in
 *  `<result>` — the only place it surfaces, since the Task tool_result was just
 *  a launch acknowledgment. */
function taskNotificationsFromUserMessage(message: SDKMessage): ClaudeTaskNotification[] {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  const textParts: string[] = [];
  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const block = entry as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
  }

  const notifications: ClaudeTaskNotification[] = [];
  for (const part of textParts) {
    if (!part.includes("<task-notification>")) {
      continue;
    }
    for (const match of part.matchAll(TASK_NOTIFICATION_BLOCK_PATTERN)) {
      const block = match[1] ?? "";
      const taskId = taskNotificationTagValue(block, "task-id");
      const status = taskNotificationTagValue(block, "status");
      if (!taskId || (status !== "completed" && status !== "failed" && status !== "stopped")) {
        continue;
      }
      const toolUseId = taskNotificationTagValue(block, "tool-use-id");
      const summary = taskNotificationTagValue(block, "summary");
      const result = taskNotificationTagValue(block, "result");
      notifications.push({
        taskId,
        status,
        ...(toolUseId ? { toolUseId } : {}),
        ...(summary ? { summary } : {}),
        ...(result ? { result } : {}),
      });
    }
  }
  return notifications;
}

/** Last-resort discriminator when no in-memory task state survived a restart:
 *  the harness summarizes agent notifications as `Agent "<description>" ...`
 *  while background commands summarize as `Background command ...`. */
function isAgentTaskNotificationSummary(summary: string | undefined): boolean {
  return summary !== undefined && /^agent\b/iu.test(summary);
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

/**
 * Emitted by Claude Code CLIs around queued slash-command execution but not
 * declared in the SDK typings (absent as of 0.3.206). Observed states:
 * started, completed, cancelled, discarded.
 */
interface SDKCommandLifecycleMessage {
  readonly type: "command_lifecycle";
  readonly command_uuid?: string;
  readonly state?: string;
  readonly uuid?: string;
  readonly session_id?: string;
}

function isSdkCommandLifecycleMessage(value: unknown): value is SDKCommandLifecycleMessage {
  return sdkMessageType(value) === "command_lifecycle";
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const rememberClaudeContextUsage = (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot,
  ): void => {
    context.lastKnownTokenUsage = usage;
    if (usage.maxTokens !== undefined) {
      context.lastKnownContextWindow = usage.maxTokens;
    }
  };

  const readCurrentClaudeContextUsage = Effect.fn("readCurrentClaudeContextUsage")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly failureLogLevel?: "debug" | "warning";
    },
  ) {
    if (!context.query.getContextUsage) {
      return undefined;
    }

    const queryWithContextUsage = context.query as ClaudeQueryRuntime & {
      readonly getContextUsage: () => Promise<SDKControlGetContextUsageResponse>;
    };

    const currentContextUsage = yield* Effect.promise(
      async (): Promise<ClaudeContextUsageReadResult> => {
        try {
          return {
            ok: true,
            value: await queryWithContextUsage.getContextUsage(),
          };
        } catch (cause) {
          return {
            ok: false,
            cause,
          };
        }
      },
    ).pipe(
      Effect.flatMap((result) => {
        if (result.ok) {
          return Effect.succeed(result.value);
        }

        const detail = {
          threadId: context.session.threadId,
          cause: result.cause,
        };
        return options?.failureLogLevel === "debug"
          ? Effect.logDebug("claude.context-usage.failed", detail).pipe(Effect.as(undefined))
          : Effect.logWarning("claude.context-usage.failed", detail).pipe(Effect.as(undefined));
      }),
    );

    return normalizeClaudeContextUsage(currentContextUsage);
  });

  const buildClaudeContextUsageSnapshot = Effect.fn("buildClaudeContextUsageSnapshot")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly accumulatedTotals?: ClaudeUsageTotals;
      readonly allowLastKnownFallback?: boolean;
      readonly applyThinkingTokens?: boolean;
      readonly fallbackUsage?: ThreadTokenUsageSnapshot;
      readonly failureLogLevel?: "debug" | "warning";
      readonly preferFallbackUsage?: boolean;
    },
  ) {
    const readOptions = options?.failureLogLevel
      ? { failureLogLevel: options.failureLogLevel }
      : undefined;
    const currentContextSnapshot = yield* readCurrentClaudeContextUsage(context, readOptions);
    const freshUsage =
      options?.preferFallbackUsage === true
        ? (options.fallbackUsage ?? currentContextSnapshot)
        : (currentContextSnapshot ?? options?.fallbackUsage);
    if (freshUsage) {
      rememberClaudeContextUsage(context, freshUsage);
    }

    const lastGoodUsage =
      freshUsage ??
      (options?.allowLastKnownFallback === true ? context.lastKnownTokenUsage : undefined);
    if (!lastGoodUsage) {
      return undefined;
    }

    const maxTokens =
      currentContextSnapshot?.maxTokens ??
      lastGoodUsage.maxTokens ??
      context.lastKnownContextWindow;
    const compactsAutomatically =
      lastGoodUsage.compactsAutomatically ?? currentContextSnapshot?.compactsAutomatically;
    const usageWithContextWindow = {
      ...lastGoodUsage,
      ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? { maxTokens }
        : {}),
      ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
    };
    const withProcessedTotals = mergeClaudeProcessedUsageTotals(
      usageWithContextWindow,
      options?.accumulatedTotals,
    );

    return options?.applyThinkingTokens === false
      ? withProcessedTotals
      : applyClaudeThinkingTokenUsage(withProcessedTotals, context.turnState);
  });

  const emitClaudeContextUsageSnapshot = Effect.fn("emitClaudeContextUsageSnapshot")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly turnId?: TurnId;
    },
  ) {
    if (!usage) {
      return;
    }
    if (areThreadTokenUsageSnapshotsEqual(context.lastEmittedTokenUsage, usage)) {
      return;
    }
    context.lastEmittedTokenUsage = usage;

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      payload: {
        usage,
      },
      providerRefs: options?.turnId ? nativeProviderRefs(context) : {},
    });
  });

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* randomUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const providerMessage = addProviderAuthHint(PROVIDER, message);
    const isAuthenticationError = isProviderAuthErrorMessage(providerMessage);
    if (isAuthenticationError && options?.onChatAuthStateChanged) {
      yield* options
        .onChatAuthStateChanged("unauthenticated")
        .pipe(Effect.ignoreCause({ log: true }));
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message: providerMessage,
        class: isAuthenticationError ? "authentication_error" : "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
    options?: { readonly warningKind?: string },
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
        ...(options?.warningKind !== undefined ? { warningKind: options.warningKind } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const turnState = context.turnState;
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    const providerErrorMessage =
      status === "failed" && errorMessage
        ? addProviderAuthHint(PROVIDER, errorMessage)
        : errorMessage;
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    // Claude result usage is accumulated processed-token metadata, not the
    // current context window size. The snapshot builder queries context usage
    // first, then merges these totals only as extra metadata.
    const accumulatedTotals = readClaudeUsageTotals(result?.usage);
    const usageSnapshot = yield* buildClaudeContextUsageSnapshot(context, {
      ...(accumulatedTotals ? { accumulatedTotals } : {}),
      allowLastKnownFallback: true,
      failureLogLevel: "warning",
    });
    if (!turnState) {
      context.lastCompletedTurnId = undefined;
      yield* emitClaudeContextUsageSnapshot(context, usageSnapshot);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(providerErrorMessage ? { errorMessage: providerErrorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      const fileChangeStat = context.fileChangeStatsByToolUseId.get(tool.itemId);
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
            ...(fileChangeStat ? { changes: [fileChangeStat] } : {}),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();
    context.fileChangeStatsByToolUseId.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
      ...(context.lastAssistantUuid ? { assistantUuid: context.lastAssistantUuid } : {}),
    });
    context.lastCompletedTurnId = status === "completed" ? turnState.turnId : undefined;

    yield* emitClaudeContextUsageSnapshot(context, usageSnapshot, { turnId: turnState.turnId });

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(providerErrorMessage ? { errorMessage: providerErrorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && providerErrorMessage ? { lastError: providerErrorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput
          ? summarizeToolRequest(tool.toolName, parsedInput, { cwd: context.session.cwd })
          : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // Emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName)) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            });
          }
        }

        // The newer SDK task tracker drives the same plan UI: mirror
        // TaskCreate/TaskUpdate inputs into the session task list.
        if (parsedInput) {
          const trackerKind = taskTrackerToolKind(nextTool.toolName);
          if (
            trackerKind &&
            applyPlanTrackerToolInput(
              context.planTracker,
              trackerKind,
              nextTool.itemId,
              parsedInput,
            )
          ) {
            yield* emitPlanTrackerUpdated(context);
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput, { cwd: context.session.cwd });
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForToolName(toolName, itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });

      // Task tracker calls that arrive with their full input up front (no
      // streaming deltas) must still drive the plan UI.
      if (Object.keys(toolInput).length > 0) {
        const trackerKind = taskTrackerToolKind(toolName);
        if (
          trackerKind &&
          applyPlanTrackerToolInput(context.planTracker, trackerKind, itemId, toolInput)
        ) {
          yield* emitPlanTrackerUpdated(context);
        }
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  /** Emits the current task-tracker mirror as a `turn.plan.updated` event so
   *  TaskCreate/TaskUpdate drive the plan UI exactly like TodoWrite lists. */
  const emitPlanTrackerUpdated = Effect.fn("emitPlanTrackerUpdated")(function* (
    context: ClaudeSessionContext,
  ) {
    const planSteps = planStepsFromPlanTracker(context.planTracker);
    const fingerprint = encodeJsonStringForDiagnostics(planSteps) ?? "";
    if (fingerprint === context.lastEmittedPlanTrackerFingerprint) {
      return;
    }
    context.lastEmittedPlanTrackerFingerprint = fingerprint;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState
        ? {
            turnId: asCanonicalTurnId(context.turnState.turnId),
          }
        : {}),
      payload: {
        plan: planSteps,
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitTaskStartedOnce = Effect.fn("emitTaskStartedOnce")(function* (
    context: ClaudeSessionContext,
    task: {
      readonly taskId: string;
      readonly description?: string;
      readonly toolUseId?: string;
      readonly subagentType?: string;
      readonly taskType?: string;
    },
    message: SDKMessage,
  ) {
    const previous = context.tasks.get(task.taskId);
    if (completedTaskStatusFromClaudeStatus(previous?.status) !== undefined) {
      return false;
    }
    context.tasks.set(task.taskId, {
      ...previous,
      ...(task.description ? { description: task.description } : {}),
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task.subagentType ? { subagentType: task.subagentType } : {}),
      ...(task.taskType ? { taskType: task.taskType } : {}),
      status: "running",
    });
    if (context.startedTaskIds.has(task.taskId)) {
      return false;
    }
    context.startedTaskIds.add(task.taskId);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "task.started",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        taskId: RuntimeTaskId.make(task.taskId),
        ...(task.description ? { description: task.description } : {}),
        ...(task.taskType ? { taskType: task.taskType } : {}),
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        ...(task.subagentType ? { subagentType: task.subagentType } : {}),
        ...(context.backgroundTaskSnapshotObserved ? { pendingCountManagedBySnapshot: true } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(message),
        payload: message,
      },
    });
    return true;
  });

  const emitTaskCompletedOnce = Effect.fn("emitTaskCompletedOnce")(function* (
    context: ClaudeSessionContext,
    task: {
      readonly taskId: string;
      readonly status: "completed" | "failed" | "stopped";
      readonly summary?: string;
      readonly toolUseId?: string;
      readonly usage?: unknown;
    },
    message: SDKMessage,
  ) {
    const previous = context.tasks.get(task.taskId);
    if (completedTaskStatusFromClaudeStatus(previous?.status) !== undefined) {
      return false;
    }

    context.tasks.set(task.taskId, {
      ...previous,
      status:
        task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "killed",
    });
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "task.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        taskId: RuntimeTaskId.make(task.taskId),
        status: task.status,
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.usage !== undefined ? { usage: task.usage } : {}),
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        ...(context.backgroundTaskSnapshotObserved ? { pendingCountManagedBySnapshot: true } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(message),
        payload: message,
      },
    });
    return true;
  });

  // A background subagent's Task tool_result is only a launch acknowledgment;
  // the agent's real final message arrives later inside a <task-notification>
  // user message. Replay it as a completion of the originating tool item so
  // consumers see the agent's actual output attached to the original call.
  // The in-memory launch record does not survive session restarts, so a
  // notification without one still completes a synthesized collab-agent item
  // keyed by the notification's tool_use_id — dropping it would silently lose
  // the agent's only output.
  const emitCollabAgentNotificationResult = Effect.fn("emitCollabAgentNotificationResult")(
    function* (
      context: ClaudeSessionContext,
      notification: ClaudeTaskNotification,
      message: SDKMessage,
    ) {
      if (!notification.toolUseId) {
        return;
      }
      const tool = context.collabAgentToolsByItemId.get(notification.toolUseId);
      const knownTask = context.tasks.get(notification.taskId);
      // Background commands notify through the same channel; only agent tasks
      // get their notification replayed as a collab-agent completion.
      const isAgentTask =
        tool !== undefined ||
        isClaudeAgentTaskType(knownTask?.taskType) ||
        knownTask?.subagentType !== undefined ||
        isAgentTaskNotificationSummary(notification.summary);
      if (!isAgentTask || context.completedCollabAgentItemIds.has(notification.toolUseId)) {
        return;
      }
      context.completedCollabAgentItemIds.add(notification.toolUseId);
      const itemId = tool?.itemId ?? notification.toolUseId;
      const detail = tool?.detail ?? notification.summary;

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(itemId),
        payload: {
          itemType: tool?.itemType ?? "collab_agent_tool_call",
          status: notification.status === "completed" ? "completed" : "failed",
          title: tool?.title ?? "Subagent task",
          ...(detail ? { detail } : {}),
          data: {
            toolName: tool?.toolName ?? "Agent",
            input: tool?.input ?? {},
            ...(notification.result
              ? {
                  result: {
                    type: "tool_result",
                    tool_use_id: itemId,
                    content: [{ type: "text", text: notification.result }],
                  },
                }
              : {}),
            taskNotification: {
              taskId: notification.taskId,
              status: notification.status,
              ...(notification.summary ? { summary: notification.summary } : {}),
            },
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });
    },
  );

  const emitCollabAgentStructuredResult = Effect.fn("emitCollabAgentStructuredResult")(function* (
    context: ClaudeSessionContext,
    tool: ToolInFlight,
    toolResult: ReturnType<typeof toolResultBlocksFromUserMessage>[number],
    structuredResult: Extract<ClaudeStructuredAgentToolResult, { status: "completed" }>,
    message: SDKMessage,
  ) {
    if (context.structuredCompletedCollabAgentItemIds.has(tool.itemId)) {
      return;
    }
    context.structuredCompletedCollabAgentItemIds.add(tool.itemId);
    context.completedCollabAgentItemIds.add(tool.itemId);

    const linkedTaskEntry = Array.from(context.tasks.entries()).find(
      ([, task]) => task.toolUseId === tool.itemId,
    );
    const taskId = linkedTaskEntry?.[0];
    const task = linkedTaskEntry?.[1];
    if (task && taskId && completedTaskStatusFromClaudeStatus(task.status) === undefined) {
      yield* emitTaskCompletedOnce(
        context,
        {
          taskId,
          status: "completed",
          ...(structuredResult.resultText ? { summary: structuredResult.resultText } : {}),
          toolUseId: tool.itemId,
        },
        message,
      );
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      itemId: asRuntimeItemId(tool.itemId),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: tool.title,
        ...(tool.detail ? { detail: tool.detail } : {}),
        data: {
          toolName: tool.toolName,
          input: tool.input,
          result: toolResultBlockWithStructuredAgentOutput(toolResult, structuredResult),
          structuredResult: structuredResult.raw,
          taskNotification: {
            ...(taskId ? { taskId } : {}),
            status: "completed",
          },
        },
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: tool.itemId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: "claude/user",
        payload: message,
      },
    });
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }

    const toolResults = toolResultBlocksFromUserMessage(message);
    // SDKUserMessage.tool_use_result describes the matching Agent/Task output
    // but does not carry its tool_use_id. Current SDK messages contain one
    // tool_result when this field is present; do not guess if that changes.
    const structuredAgentResult =
      toolResults.length === 1 ? structuredAgentToolResultFromUserMessage(message) : undefined;
    for (const toolResult of toolResults) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        const completedTool = context.collabAgentToolsByItemId.get(toolResult.toolUseId);
        if (completedTool && structuredAgentResult?.status === "completed") {
          yield* emitCollabAgentStructuredResult(
            context,
            completedTool,
            toolResult,
            structuredAgentResult,
            message,
          );
        } else if (structuredAgentResult?.status === "completed") {
          // A resumed CLI process can deliver the structured final result after
          // the in-memory launch record was lost. Preserve the result on a
          // stable synthesized item instead of silently dropping it.
          yield* emitCollabAgentStructuredResult(
            context,
            {
              itemId: toolResult.toolUseId,
              itemType: "collab_agent_tool_call",
              toolName: "Agent",
              title: "Subagent task",
              input: {},
              partialInputJson: "",
            },
            toolResult,
            structuredAgentResult,
            message,
          );
        }
        continue;
      }

      const [index, tool] = toolEntry;
      if (tool.itemType === "collab_agent_tool_call") {
        // Background agents settle after this tool_result; keep the launch so
        // a later task notification can complete the item with the real result.
        context.collabAgentToolsByItemId.set(tool.itemId, tool);
        if (structuredAgentResult?.status === "completed") {
          context.structuredCompletedCollabAgentItemIds.add(tool.itemId);
          context.completedCollabAgentItemIds.add(tool.itemId);
        }
      }
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const fileChangeStat = context.fileChangeStatsByToolUseId.get(toolResult.toolUseId);
      context.fileChangeStatsByToolUseId.delete(toolResult.toolUseId);
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResultBlockWithStructuredAgentOutput(
          toolResult,
          tool.itemType === "collab_agent_tool_call" ? structuredAgentResult : undefined,
        ),
        ...(tool.itemType === "collab_agent_tool_call" && structuredAgentResult
          ? { structuredResult: structuredAgentResult.raw }
          : {}),
        ...(fileChangeStat ? { changes: [fileChangeStat] } : {}),
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      // TaskCreate results reveal the assigned task id; TaskList results are
      // an authoritative snapshot. Both keep the plan mirror in sync.
      const trackerKind = taskTrackerToolKind(tool.toolName);
      if (
        trackerKind &&
        applyPlanTrackerToolResult(context.planTracker, trackerKind, tool.itemId, toolResult)
      ) {
        yield* emitPlanTrackerUpdated(context);
      }

      // EnterWorktree/ExitWorktree move the session's working directory
      // mid-turn; report it immediately instead of waiting for the next
      // session init. A parse miss is safe — the next init self-corrects.
      if (!toolResult.isError) {
        const movedCwd =
          tool.toolName === "EnterWorktree"
            ? parseEnterWorktreeCwd(tool.input, toolResult.text)
            : tool.toolName === "ExitWorktree"
              ? context.session.cwd
              : undefined;
        if (movedCwd !== undefined && movedCwd.length > 0) {
          const cwdStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.cwd.changed",
            eventId: cwdStamp.eventId,
            provider: PROVIDER,
            createdAt: cwdStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              cwd: movedCwd,
              reason: tool.toolName === "EnterWorktree" ? "worktree-entered" : "worktree-exited",
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });
        }
      }

      context.inFlightTools.delete(index);
    }

    // Prefer structured Agent/Task output when both representations are
    // present on the same SDK message; the XML notification remains a
    // backward-compatible fallback for older Claude processes.
    for (const notification of taskNotificationsFromUserMessage(message)) {
      yield* emitCollabAgentNotificationResult(context, notification, message);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }
    if (options?.onChatAuthStateChanged) {
      yield* options.onChatAuthStateChanged("verified").pipe(Effect.ignoreCause({ log: true }));
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* randomUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);

    const usageSnapshot = yield* buildClaudeContextUsageSnapshot(context, {
      failureLogLevel: "debug",
    });
    yield* emitClaudeContextUsageSnapshot(
      context,
      usageSnapshot,
      context.turnState ? { turnId: context.turnState.turnId } : undefined,
    );
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);

    if (status === "failed" && isProviderAuthErrorMessage(errorMessage)) {
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
        exitKind: "error",
        exitReason: "Authentication failed",
        interruptStreamFiber: false,
        recoverable: true,
      });
    }
  });

  const handlePromptSuggestionMessage = Effect.fn("handlePromptSuggestionMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "prompt_suggestion") {
      return;
    }

    const suggestion = nonEmptyString(message.suggestion);
    const turnId = context.lastCompletedTurnId;
    context.lastCompletedTurnId = undefined;
    if (!suggestion || !turnId) {
      return;
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.prompt-suggestion.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: {
        suggestion,
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    });
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    if (sdkMessageSubtype(message) === "thinking_tokens") {
      const thinkingTokensEstimate = normalizeClaudeThinkingTokens(message);
      if (thinkingTokensEstimate !== undefined && context.turnState) {
        context.turnState.thinkingTokensEstimate = Math.max(
          context.turnState.thinkingTokensEstimate ?? 0,
          thinkingTokensEstimate,
        );
      }
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    if (sdkMessageSubtype(message) === "model_fallback") {
      const fallback = extractClaudeModelFallback(context, message, "fallback:model-unavailable");
      if (fallback) {
        yield* offerRuntimeEvent({
          ...base,
          type: "model.rerouted",
          payload: fallback,
        });
      } else {
        yield* emitRuntimeWarning(
          context,
          "Claude is using a fallback model, but did not report the model names.",
          message,
          { warningKind: "model-fallback" },
        );
      }
      return;
    }

    switch (message.subtype) {
      case "init": {
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        // Init reports where the session actually runs. Resumed sessions
        // keep a mid-session worktree switch (EnterWorktree) across turns,
        // so this diverges from the thread's configured checkout; ingestion
        // compares and records the divergence on the thread.
        const initCwd = (message as { cwd?: unknown }).cwd;
        if (typeof initCwd === "string" && initCwd.trim().length > 0) {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.cwd.changed",
            payload: { cwd: initCwd, reason: "session-init" },
          });
        }
        return;
      }
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        {
          const fallbackUsage = normalizeClaudeCompactBoundaryUsage(
            message,
            context.lastKnownTokenUsage,
            context.lastKnownContextWindow,
          );
          const usageSnapshot = yield* buildClaudeContextUsageSnapshot(context, {
            ...(fallbackUsage ? { fallbackUsage } : {}),
            failureLogLevel: "debug",
            preferFallbackUsage: true,
          });
          yield* emitClaudeContextUsageSnapshot(
            context,
            usageSnapshot,
            context.turnState ? { turnId: context.turnState.turnId } : undefined,
          );
        }
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "background_tasks_changed": {
        // This is a level signal with replace semantics. Forward the complete
        // set so orchestration can set the pending count absolutely; do not
        // infer terminal outcomes for disappeared ids because the snapshot
        // intentionally carries no completion status or tool correlation.
        context.backgroundTaskSnapshotObserved = true;
        const tasksById = new Map<
          string,
          {
            readonly taskId: RuntimeTaskId;
            readonly taskType?: string;
            readonly description?: string;
          }
        >();
        for (const task of message.tasks) {
          const description = nonEmptyString(task.description);
          const taskType = nonEmptyString(task.task_type);
          tasksById.set(task.task_id, {
            taskId: RuntimeTaskId.make(task.task_id),
            ...(description ? { description } : {}),
            ...(taskType ? { taskType } : {}),
          });
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.snapshot.updated",
          payload: {
            tasks: Array.from(tasksById.values()),
          },
        });
        return;
      }
      case "task_started": {
        const description = nonEmptyString(message.description);
        const toolUseId = nonEmptyString(message.tool_use_id);
        const subagentType = nonEmptyString(message.subagent_type);
        const taskType = nonEmptyString(message.task_type);
        yield* emitTaskStartedOnce(
          context,
          {
            taskId: message.task_id,
            ...(description ? { description } : {}),
            ...(toolUseId ? { toolUseId } : {}),
            ...(subagentType ? { subagentType } : {}),
            ...(taskType ? { taskType } : {}),
          },
          message,
        );
        return;
      }
      case "task_progress": {
        const description = nonEmptyString(message.description);
        const previous = context.tasks.get(message.task_id);
        if (completedTaskStatusFromClaudeStatus(previous?.status) !== undefined) {
          return;
        }
        const toolUseId = nonEmptyString(message.tool_use_id) ?? previous?.toolUseId;
        const subagentType = nonEmptyString(message.subagent_type) ?? previous?.subagentType;
        context.tasks.set(message.task_id, {
          ...previous,
          ...(description ? { description } : {}),
          ...(toolUseId ? { toolUseId } : {}),
          ...(subagentType ? { subagentType } : {}),
          status: "running",
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(toolUseId ? { toolUseId } : {}),
            ...(subagentType ? { subagentType } : {}),
          },
        });
        return;
      }
      case "task_updated": {
        const patch =
          message.patch && typeof message.patch === "object"
            ? (message.patch as Record<string, unknown>)
            : {};
        const status = normalizeClaudeTaskStatus(patch.status);
        const previous = context.tasks.get(message.task_id);
        // The SDK reports a finished background task twice: a terminal
        // task_updated patch and a task_notification. Whichever arrives first
        // settles the task; later task messages for it are dropped so consumers
        // see at most one task.completed per task (the session's pending
        // background task count decrements once per completion event).
        if (completedTaskStatusFromClaudeStatus(previous?.status) !== undefined) {
          return;
        }
        const description = nonEmptyString(patch.description) ?? previous?.description;
        const error = nonEmptyString(patch.error);
        const completedStatus = completedTaskStatusFromClaudeStatus(status);
        if (completedStatus) {
          const summary = error ?? description;
          yield* emitTaskCompletedOnce(
            context,
            {
              taskId: message.task_id,
              status: completedStatus,
              ...(summary ? { summary } : {}),
              ...(previous?.toolUseId ? { toolUseId: previous.toolUseId } : {}),
            },
            message,
          );
          return;
        }

        context.tasks.set(message.task_id, {
          ...previous,
          ...(description ? { description } : {}),
          ...(status ? { status } : {}),
        });

        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: description ?? describeClaudeTaskStatus(status),
            ...(error ? { summary: error } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const previous = context.tasks.get(message.task_id);
        // Dropped when a terminal task_updated patch already settled the task —
        // see the task_updated handler for the single-completion invariant.
        if (completedTaskStatusFromClaudeStatus(previous?.status) !== undefined) {
          return;
        }
        const toolUseId = nonEmptyString(message.tool_use_id) ?? previous?.toolUseId;
        yield* emitTaskCompletedOnce(
          context,
          {
            taskId: message.task_id,
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(toolUseId ? { toolUseId } : {}),
          },
          message,
        );
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "permission_denied": {
        const denied = message as typeof message & {
          readonly tool_name?: unknown;
          readonly decision_reason?: unknown;
        };
        const toolName =
          typeof denied.tool_name === "string" && denied.tool_name.trim().length > 0
            ? denied.tool_name.trim()
            : "unknown";
        const reason =
          typeof denied.decision_reason === "string" && denied.decision_reason.trim().length > 0
            ? `: ${denied.decision_reason.trim()}`
            : "";
        yield* emitRuntimeWarning(context, `Claude denied tool '${toolName}'${reason}.`, message);
        return;
      }
      case "mirror_error": {
        const mirrorError = message as typeof message & { readonly error?: unknown };
        const detail =
          typeof mirrorError.error === "string" && mirrorError.error.trim().length > 0
            ? mirrorError.error.trim()
            : "unknown mirror error";
        yield* emitRuntimeError(context, `Claude workspace mirror error: ${detail}`, message);
        return;
      }
      case "api_retry": {
        // First-attempt retries are routine stream hiccups the SDK absorbs on
        // its own; keep those in server diagnostics only. Cascades that reach
        // attempt 2+ still surface as an activity warning.
        const attempt = (message as { readonly attempt?: unknown }).attempt;
        if (typeof attempt === "number" && attempt <= 1) {
          yield* Effect.logInfo("claude.api-retry.first-attempt", {
            threadId: context.session.threadId,
            message,
          });
          return;
        }
        yield* emitRuntimeWarning(context, describeApiRetry(message), message, {
          warningKind: "api-retry",
        });
        return;
      }
      case "model_refusal_fallback": {
        const fallback = extractClaudeModelFallback(context, message, "fallback:refusal");
        if (fallback) {
          yield* offerRuntimeEvent({
            ...base,
            type: "model.rerouted",
            payload: fallback,
          });
        } else {
          yield* emitRuntimeWarning(
            context,
            "Claude substituted a fallback response after a refusal.",
            message,
            { warningKind: "model-fallback" },
          );
        }
        return;
      }
      // SDK bookkeeping with no user-facing activity. Notifications and
      // elicitations surface through the approval/user-input flows instead.
      case "commands_changed":
      case "elicitation_complete":
      case "local_command_output":
      case "memory_recall":
      case "notification":
      case "plugin_install":
      case "session_state_changed":
        return;
      default:
        // Exhaustive today; newer CLIs may add subtypes we don't know yet.
        // Diagnostics for developers, not a user-visible runtime warning.
        yield* Effect.logDebug("claude.sdk.system-message.unhandled", {
          threadId: context.session.threadId,
          subtype: (message as { subtype?: string }).subtype ?? "unknown",
          message,
        });
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage | SDKCommandLifecycleMessage,
  ) {
    if (message.type === "command_lifecycle") {
      // Slash-command bookkeeping; the raw payload is already captured by
      // logNativeSdkMessage and there is no user-facing activity to project.
      yield* Effect.logDebug("claude.sdk.command-lifecycle", {
        threadId: context.session.threadId,
        state: message.state,
        commandUuid: message.command_uuid,
      });
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      if (options?.onAccountRateLimitsUpdated) {
        yield* options
          .onAccountRateLimitsUpdated(message.rate_limit_info)
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return;
    }
  });

  /** Messages forwarded from inside a subagent (`forwardSubagentText`).
   *  Complete assistant envelopes stream into the spawning collab tool item
   *  as live progress text; parent-attributed stream deltas and the
   *  subagent's internal user/tool-result messages are dropped — per-message
   *  granularity keeps event volume bounded under parallel subagents. */
  const handleSubagentForwardedMessage = Effect.fn("handleSubagentForwardedMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    parentToolUseId: string,
  ) {
    if (message.type !== "assistant") {
      return;
    }
    // A foreground agent's Task tool is still in flight while its messages
    // stream (`collabAgentToolsByItemId` is only populated once the
    // tool_result lands); background agents are found through the launch
    // record kept for the session lifetime.
    const tool =
      Array.from(context.inFlightTools.values()).find(
        (inFlight) => inFlight.itemId === parentToolUseId,
      ) ?? context.collabAgentToolsByItemId.get(parentToolUseId);
    if (
      tool === undefined ||
      tool.itemType !== "collab_agent_tool_call" ||
      context.completedCollabAgentItemIds.has(parentToolUseId) ||
      context.structuredCompletedCollabAgentItemIds.has(parentToolUseId)
    ) {
      return;
    }
    const text = extractTextContent((message.message as { content?: unknown }).content)
      .trim()
      .slice(0, SUBAGENT_LIVE_TEXT_MAX_CHARS);
    if (text.length === 0) {
      return;
    }
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState
        ? {
            turnId: asCanonicalTurnId(context.turnState.turnId),
          }
        : {}),
      itemId: asRuntimeItemId(tool.itemId),
      payload: {
        itemType: tool.itemType,
        status: "inProgress",
        title: tool.title,
        ...(tool.detail ? { detail: tool.detail } : {}),
        data: {
          toolName: tool.toolName,
          input: tool.input,
          subagentLiveText: text,
          subagentLiveTextAt: stamp.createdAt,
        },
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: tool.itemId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: "claude/assistant/subagent-forwarded",
        payload: message,
      },
    });
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    // Forwarded subagent conversation (`forwardSubagentText`) must never
    // reach the main-transcript handlers below. Scoped to the conversation
    // message types: tool_progress also carries parent_tool_use_id but keeps
    // its existing telemetry routing.
    if (
      message.type === "assistant" ||
      message.type === "user" ||
      message.type === "stream_event"
    ) {
      const parentToolUseId = readParentToolUseId(message);
      if (parentToolUseId !== undefined) {
        yield* handleSubagentForwardedMessage(context, message, parentToolUseId);
        return;
      }
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "prompt_suggestion":
        yield* handlePromptSuggestionMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      default:
        if (isSdkCommandLifecycleMessage(message)) {
          yield* handleSdkTelemetryMessage(context, message);
          return;
        }
        // The CLI regularly ships message types ahead of the SDK typings;
        // they are diagnostics for developers, not something to surface as a
        // user-visible runtime warning.
        yield* Effect.logDebug("claude.sdk.message.unhandled", {
          threadId: context.session.threadId,
          messageType: sdkMessageType(message) ?? "unknown",
          message,
        });
        return;
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toProcessError(cause, "Claude runtime stream failed.", context.session.threadId),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => handleSdkMessage(context, message)),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else if (isClaudeSigtermExitCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude session was stopped.");
        }
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly emitExitEvent?: boolean;
      readonly exitKind?: RuntimeSessionExitKind;
      readonly exitReason?: string;
      readonly interruptStreamFiber?: boolean;
      readonly recoverable?: boolean;
    },
  ) {
    if (context.stopped) return;

    context.stopped = true;

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (
      options?.interruptStreamFiber !== false &&
      streamFiber &&
      streamFiber.pollUnsafe() === undefined
    ) {
      yield* Fiber.interrupt(streamFiber);
    }

    yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: toMessage(cause, "Failed to close Claude runtime query."),
          cause,
        }),
    }).pipe(
      Effect.catch((cause) =>
        emitRuntimeError(context, "Failed to close Claude runtime query.", cause),
      ),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: options?.exitReason ?? "Session stopped",
          ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}),
          exitKind: options?.exitKind ?? "graceful",
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        }).pipe(
          // Replacement cleanup is best-effort: never block the new session on
          // either typed failures or unexpected defects from tearing down the old one.
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.session.replace.stop-failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }

      const startedAt = yield* nowIso;
      const requestedResumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;

      // Claude Code scopes transcript lookup to the cwd-derived project
      // directory, so resuming after the session's original cwd disappeared
      // (e.g. a cleaned-up worktree) fails every retry even though the
      // transcript still exists. Relocate the transcript when it lives under
      // another project directory; start fresh when it is gone entirely.
      let resumeState = requestedResumeState;
      if (requestedResumeState?.resume !== undefined) {
        const transcriptResolution = yield* ensureClaudeSessionTranscript({
          environment: claudeEnvironment,
          cwd: input.cwd ?? process.cwd(),
          sessionId: requestedResumeState.resume,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          // Verification is best-effort: on filesystem errors keep the
          // native resume as-is rather than blocking session start.
          Effect.catch((cause) =>
            Effect.logWarning("claude.resume.transcript-check-failed", {
              threadId,
              sessionId: requestedResumeState.resume,
              cause,
            }).pipe(Effect.as(undefined)),
          ),
        );
        if (transcriptResolution?.outcome === "relocated") {
          yield* Effect.logInfo("claude.resume.transcript-relocated", {
            threadId,
            sessionId: requestedResumeState.resume,
            sourcePath: transcriptResolution.sourcePath,
            transcriptPath: transcriptResolution.transcriptPath,
          });
        } else if (transcriptResolution?.outcome === "missing") {
          yield* Effect.logWarning("claude.resume.transcript-missing", {
            threadId,
            sessionId: requestedResumeState.resume,
            cwd: input.cwd ?? process.cwd(),
            reason: "starting a fresh session because no project directory holds the transcript",
          });
          resumeState = undefined;
          // Degraded resume must be visible to the user, not just the server
          // log: the fresh session has none of the thread's earlier context.
          const fallbackStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            eventId: fallbackStamp.eventId,
            provider: PROVIDER,
            createdAt: fallbackStamp.createdAt,
            threadId,
            payload: {
              message:
                "Could not restore this thread's previous Claude session (its transcript is missing). Starting fresh — earlier context from this thread is not available to the model.",
              warningKind: "resume-fallback",
            },
            providerRefs: {},
          });
        }
      }

      const existingResumeSessionId = resumeState?.resume;
      const newSessionId = existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined;
      const sessionId = existingResumeSessionId ?? newSessionId;

      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<number, ToolInFlight>();
      const fileChangeStatsByToolUseId = new Map<string, FileChangeStat>();

      // Capture exact per-edit diff stats from the file tools' structured
      // output; the hook resolves before the SDK streams the matching
      // tool_result, so the stats are ready when the item events go out.
      const recordFileChangeStats: HookCallback = (hookInput, toolUseID) => {
        const stat = fileChangeStatFromHookInput(hookInput);
        const toolUseId =
          typeof (hookInput as { tool_use_id?: unknown }).tool_use_id === "string"
            ? ((hookInput as { tool_use_id: string }).tool_use_id ?? toolUseID)
            : toolUseID;
        if (stat && toolUseId) {
          fileChangeStatsByToolUseId.set(toolUseId, stat);
        }
        return Promise.resolve({});
      };

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: {
          readonly signal: AbortSignal;
          readonly toolUseID?: string;
        },
      ) {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);

        // Parse questions from the SDK's AskUserQuestion input.
        // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
        // up answers by question text in `mapToolResultToToolResultBlockParam`,
        // so the key the UI uses to keep its draft answer must match the SDK's
        // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
            header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === "string" ? opt.label : "",
                  description: typeof opt.description === "string" ? opt.description : "",
                }))
              : [],
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
          }),
        );

        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        let aborted = false;
        const pendingInput: PendingUserInput = {
          questions,
          answers: answersDeferred,
        };

        // Emit user-input.requested so the UI can present the questions.
        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { questions },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion",
            payload: {
              toolName: "AskUserQuestion",
              input: toolInput,
            },
          },
        });

        pendingUserInputs.set(requestId, pendingInput);

        // Handle abort (e.g. turn interrupted while waiting for user input).
        const onAbort = () => {
          if (!pendingUserInputs.has(requestId)) {
            return;
          }
          aborted = true;
          pendingUserInputs.delete(requestId);
          runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
        };
        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        // Block until the user provides answers.
        const answers = yield* Deferred.await(answersDeferred);
        pendingUserInputs.delete(requestId);

        // Emit user-input.resolved so the UI knows the interaction completed.
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { answers },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion/resolved",
            payload: { answers },
          },
        });

        if (aborted) {
          return {
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult;
        }

        // Return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: "allow",
          updatedInput: {
            questions: toolInput.questions,
            answers,
          },
        } satisfies PermissionResult;
      });

      const canUseToolEffect = Effect.fn("canUseTool")(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        // Plan turns route write tools here regardless of allow rules; never
        // inherit full-access auto-allow while planning, so a plan turn cannot
        // silently edit files. In "auto" mode the SDK classifier handles
        // approvals upstream and only fallback prompts reach this callback,
        // so those fall through to the in-app approval flow below.
        const runtimeMode = input.runtimeMode ?? "full-access";
        if (runtimeMode === "full-access" && context.currentInteractionMode !== "plan") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput, { cwd: input.cwd });
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        const decision = yield* Deferred.await(decisionDeferred);
        pendingApprovals.delete(requestId);

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            decision,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/decision",
            payload: {
              decision,
            },
          },
        });

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "acceptForSession" && pendingApproval.suggestions
              ? {
                  updatedPermissions: [...pendingApproval.suggestions],
                }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

      const claudeBinaryPath = claudeSettings.binaryPath;
      const extraArgs = parseCliArgs(claudeSettings.launchArgs).flags;
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
      const fallbackModel = resolveClaudeFallbackModelOption(claudeSettings.fallbackModel, [
        modelSelection?.model,
        apiModelId,
      ]);
      const fallbackModelIds = splitClaudeFallbackModelOption(fallbackModel);
      const flagSettings = deriveClaudeFlagSettings(modelSelection);
      const effectiveEffort = flagSettings.effortLevel;
      const runtimeModeToPermission: Record<string, PermissionMode> = {
        "auto-accept-edits": "acceptEdits",
        auto: "auto",
        "full-access": "bypassPermissions",
      };
      const requestedPermissionMode = runtimeModeToPermission[input.runtimeMode];
      // Auto mode needs a classifier-capable model (Opus 4.6+/Sonnet 4.6+).
      // Older models clamp to acceptEdits: edits keep flowing and everything
      // else falls back to in-app approval prompts instead of erroring.
      const autoModeClamped =
        requestedPermissionMode === "auto" &&
        !claudeModelSupportsAutoRuntimeMode(modelSelection?.model);
      const permissionMode = autoModeClamped ? "acceptEdits" : requestedPermissionMode;
      const settings = {
        ...(flagSettings.alwaysThinkingEnabled !== null
          ? { alwaysThinkingEnabled: flagSettings.alwaysThinkingEnabled }
          : {}),
        ...(flagSettings.fastMode ? { fastMode: true } : {}),
        ...(flagSettings.ultracode ? { ultracode: true } : {}),
      };
      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        ...(effectiveEffort
          ? {
              effort: effectiveEffort,
            }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(fallbackModel ? { fallbackModel } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        includePartialMessages: true,
        enableFileCheckpointing: true,
        promptSuggestions: true,
        // Subagent conversations arrive as messages tagged with
        // parent_tool_use_id; routing keeps them out of the main transcript
        // and streams them into the collab tool item instead. Travels via the
        // control-protocol initConfig, so older CLIs just ignore it.
        forwardSubagentText: true,
        canUseTool,
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|NotebookEdit",
              hooks: [recordFileChangeStats],
            },
          ],
        },
        env: claudeEnvironment,
        ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
      };

      yield* Effect.annotateCurrentSpan({
        "provider.kind": PROVIDER,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
        "claude.resume.source":
          existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
        "claude.resume.thread_id": resumeState?.threadId ?? "",
        "claude.resume.session_id": existingResumeSessionId ?? "",
        "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
        "claude.resume.turn_count": resumeState?.turnCount ?? -1,
        "claude.query.cwd": input.cwd ?? "",
        "claude.query.model": apiModelId ?? "",
        "claude.query.fallback_model": fallbackModel ?? "",
        "claude.query.effort": effectiveEffort ?? "",
        "claude.query.permission_mode": permissionMode ?? "",
        "claude.query.auto_mode_clamped": autoModeClamped,
        "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
        "claude.query.resume": existingResumeSessionId ?? "",
        "claude.query.session_id": newSessionId ?? "",
        "claude.query.include_partial_messages": true,
        "claude.query.enable_file_checkpointing": true,
        "claude.query.prompt_suggestions": true,
        "claude.query.additional_directories": input.cwd ? [input.cwd] : [],
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Claude runtime session."),
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentInteractionMode: undefined,
        currentApiModelId: apiModelId,
        currentFlagSettings: flagSettings,
        currentFallbackModelIds: fallbackModelIds,
        resumeSessionId: sessionId,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        collabAgentToolsByItemId: new Map(),
        completedCollabAgentItemIds: new Set(),
        structuredCompletedCollabAgentItemIds: new Set(),
        fileChangeStatsByToolUseId,
        tasks: new Map(),
        startedTaskIds: new Set(),
        backgroundTaskSnapshotObserved: false,
        planTracker: new Map(),
        lastEmittedPlanTrackerFingerprint: undefined,
        turnState: undefined,
        lastKnownContextWindow: undefined,
        lastKnownTokenUsage: undefined,
        lastEmittedTokenUsage: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastCompletedTurnId: undefined,
        lastThreadStartedId: undefined,
        // Render the cross-driver handoff seed once at start; consumed on the
        // first turn. Only honored when there is no native resume to defer to
        // (including when a requested resume fell back to a fresh start).
        pendingContextSeedText:
          input.contextSeed !== undefined && resumeState === undefined
            ? renderThreadContextSeed(input.contextSeed)
            : undefined,
        stopped: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        // Reflect the effective resume: when the transcript is gone and the
        // session fell back to a fresh start, don't claim a resume happened.
        payload:
          resumeState !== undefined && input.resumeCursor !== undefined
            ? { resume: input.resumeCursor }
            : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(fallbackModel ? { fallbackModel } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(flagSettings.fastMode ? { fastMode: true } : {}),
            fileCheckpointing: true,
            promptSuggestions: true,
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit);
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    // Apply option changes (effort, thinking, fast mode, ultracode) to the
    // running query instead of restarting the session. Best-effort: a failed
    // apply must not block the user's turn, and an un-updated snapshot means
    // the next turn retries.
    if (modelSelection !== undefined) {
      const desiredFlagSettings = deriveClaudeFlagSettings(modelSelection);
      if (!claudeFlagSettingsEqual(desiredFlagSettings, context.currentFlagSettings)) {
        const applyFlagSettings = context.query.applyFlagSettings?.bind(context.query);
        if (applyFlagSettings === undefined) {
          yield* Effect.logWarning("claude adapter cannot apply option changes in-session", {
            threadId: input.threadId,
            desiredFlagSettings,
          });
        } else {
          yield* Effect.tryPromise({
            try: () =>
              applyFlagSettings({
                effortLevel: desiredFlagSettings.effortLevel,
                alwaysThinkingEnabled: desiredFlagSettings.alwaysThinkingEnabled,
                fastMode: desiredFlagSettings.fastMode ? true : null,
                ultracode: desiredFlagSettings.ultracode ? true : null,
              }),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                context.currentFlagSettings = desiredFlagSettings;
              }),
            ),
            Effect.catch((error: { readonly message: string }) =>
              Effect.logWarning("claude adapter failed to apply option changes in-session", {
                threadId: input.threadId,
                desiredFlagSettings,
                error: error.message,
              }),
            ),
          );
        }
      }
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    // Plan turns always re-assert plan mode: the CLI exits plan mode on its
    // own when a plan is accepted, so our tracked mode may be stale. The
    // default branch only needs a round-trip when we previously entered plan.
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.currentInteractionMode = "plan";
    } else if (input.interactionMode === "default") {
      if (context.currentInteractionMode === "plan") {
        yield* Effect.tryPromise({
          try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
          catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
        });
      }
      context.currentInteractionMode = "default";
    }

    const turnId = TurnId.make(yield* randomUUIDv4);
    const turnState: ClaudeTurnState = {
      turnId,
      startedAt: yield* nowIso,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      nextSyntheticAssistantBlockIndex: -1,
    };

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.lastCompletedTurnId = undefined;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    const seedPreamble = context.pendingContextSeedText;
    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      ...(seedPreamble !== undefined ? { seedPreamble } : {}),
    });
    // Consume the handoff seed once; subsequent turns continue natively.
    context.pendingContextSeedText = undefined;

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const steerTurn: NonNullable<ClaudeAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(function* (
    input: ProviderSteerTurnInput,
  ) {
    const context = yield* requireSession(input.threadId);
    const activeTurn = context.turnState;
    if (!activeTurn) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/steer",
        detail: "No active Claude turn is available to steer.",
      });
    }
    if (activeTurn.turnId !== input.expectedTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/steer",
        detail: `Expected active turn '${input.expectedTurnId}' but Claude is running '${activeTurn.turnId}'.`,
      });
    }

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      method: "turn/steer",
    });

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/steer", cause)));

    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: activeTurn.turnId,
      updatedAt: yield* nowIso,
    };

    return {
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });
    },
  );

  const compactContext: NonNullable<ClaudeAdapterShape["compactContext"]> = Effect.fn(
    "compactContext",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    if (context.turnState) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/compact",
        detail: "Cannot compact Claude context while a turn is running.",
      });
    }

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message: buildSlashCommandUserMessage(COMPACT_CONTEXT_COMMAND),
    }).pipe(Effect.mapError((cause) => toRequestError(threadId, "thread/compact", cause)));
  });

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const readSubagentTranscript: NonNullable<ClaudeAdapterShape["readSubagentTranscript"]> =
    Effect.fn("readSubagentTranscript")(function* (threadId, input) {
      const requestError = (detail: string) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readSubagentTranscript",
          detail,
        });
      if (!SUBAGENT_AGENT_ID_PATTERN.test(input.agentId)) {
        return yield* requestError(`Invalid subagent id '${input.agentId}'.`);
      }
      const context = yield* requireSession(threadId);
      const sessionId = context.resumeSessionId;
      if (!sessionId) {
        return yield* requestError("The Claude session has not reported a session id yet.");
      }
      const cwd = context.session.cwd;
      if (!cwd) {
        return yield* requestError("The Claude session has no working directory.");
      }
      // Claude Code writes each spawned agent's conversation next to the
      // parent transcript: <config>/projects/<cwd-slug>/<sessionId>/subagents/.
      // Resolved through the instance environment so custom CLAUDE_CONFIG_DIR
      // and HOME overrides are honored.
      const projectDir = path.join(
        resolveClaudeConfigDir(claudeEnvironment, path),
        "projects",
        claudeProjectDirectoryName(cwd),
      );
      const transcriptFileName = `agent-${input.agentId}.jsonl`;
      const pathExists = (candidate: string) =>
        fileSystem.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)));
      let transcriptPath = path.join(projectDir, sessionId, "subagents", transcriptFileName);
      if (!(yield* pathExists(transcriptPath))) {
        // Session ids rotate on resume; the agent may have been spawned by an
        // earlier session of this cwd. Scan the project's session directories
        // for the transcript before giving up.
        const sessionDirs = yield* fileSystem
          .readDirectory(projectDir)
          .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
        let found: string | undefined;
        for (const entry of sessionDirs) {
          const candidate = path.join(projectDir, entry, "subagents", transcriptFileName);
          if (yield* pathExists(candidate)) {
            found = candidate;
            break;
          }
        }
        if (found === undefined) {
          return yield* requestError("No transcript found for this subagent yet.");
        }
        transcriptPath = found;
      }
      const transcript = yield* fileSystem
        .readFileString(transcriptPath)
        .pipe(
          Effect.mapError((cause) =>
            requestError(`Failed to read the subagent transcript: ${cause.message}`),
          ),
        );
      return mapClaudeSubagentTranscript(
        transcript,
        input.limit !== undefined ? { limit: input.limit } : {},
      );
    });

  const rewindFilesForRollback = Effect.fn("rewindFilesForRollback")(function* (
    context: ClaudeSessionContext,
    targetUserMessageId: MessageId | undefined,
  ) {
    const userMessageId =
      targetUserMessageId !== undefined && isUuid(targetUserMessageId)
        ? targetUserMessageId
        : undefined;
    const rewindFiles = context.query.rewindFiles;
    if (userMessageId === undefined || rewindFiles === undefined) {
      return;
    }

    const result = yield* Effect.promise(
      async (): Promise<
        | {
            readonly ok: true;
            readonly value: RewindFilesResult;
          }
        | {
            readonly ok: false;
            readonly cause: unknown;
          }
      > => {
        try {
          return {
            ok: true,
            value: await rewindFiles(userMessageId),
          };
        } catch (cause) {
          return {
            ok: false,
            cause,
          };
        }
      },
    );

    if (!result.ok) {
      yield* Effect.logWarning("claude.rewind-files.failed", {
        threadId: context.session.threadId,
        userMessageId,
        cause: result.cause,
      });
      return;
    }

    if (!result.value.canRewind) {
      yield* Effect.logWarning("claude.rewind-files.unavailable", {
        threadId: context.session.threadId,
        userMessageId,
        error: result.value.error ?? "Claude file checkpoint rewind was unavailable.",
      });
    }
  });

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns, options) {
      const context = yield* requireSession(threadId);
      yield* rewindFilesForRollback(context, options?.targetUserMessageId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      context.lastAssistantUuid = context.turns.at(-1)?.assistantUuid;
      yield* updateResumeCursor(context);
      return yield* snapshotThread(context);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      manualContextCompaction: "supported",
      activeTurnSteering: "supported",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    compactContext,
    readThread,
    readSubagentTranscript,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
