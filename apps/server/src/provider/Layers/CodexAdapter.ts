/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ChatAttachment,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  EventId,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ProviderSubagentTranscriptEntry,
  type ProviderSubagentTranscriptResult,
  type RuntimeThreadGoalSnapshot,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  type ProviderStartReviewInput,
  ThreadId,
  TurnId,
  type ProviderSteerTurnInput,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@threadlines/shared/model";
import { renderThreadContextSeed, withContextSeedPreamble } from "@threadlines/shared/contextSeed";
import { resolveCodexServiceTier } from "../../codexServiceTier.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { addProviderAuthHint, isProviderAuthErrorMessage } from "../providerAuthHints.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildFileAttachmentNote } from "../fileAttachmentPrompt.ts";
import { ServerConfig } from "../../config.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");
const CODEX_SUBAGENT_TRANSCRIPT_DEFAULT_LIMIT = 200;
const CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS = 4_000;
const CODEX_SUBAGENT_TRANSCRIPT_OUTPUT_MAX_CHARS = 2_000;
const CODEX_SUBAGENT_TRANSCRIPT_TOOL_SUMMARY_MAX_CHARS = 1_000;
const CODEX_SUBAGENT_MAX_ANCESTRY_DEPTH = 32;

type CodexStoredThread = EffectCodexSchema.V2ThreadReadResponse["thread"];
type CodexStoredThreadItem = CodexStoredThread["turns"][number]["items"][number];

function capCodexTranscriptText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function codexJsonPreview(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return capCodexTranscriptText(serialized ?? String(value), maxChars);
  } catch {
    return capCodexTranscriptText(String(value), maxChars);
  }
}

function codexToolEntry(input: {
  readonly name: string;
  readonly summary?: string | undefined;
  readonly outputPreview?: string | undefined;
}): ProviderSubagentTranscriptEntry {
  const summary = capCodexTranscriptText(
    input.summary ?? "",
    CODEX_SUBAGENT_TRANSCRIPT_TOOL_SUMMARY_MAX_CHARS,
  );
  const outputPreview = capCodexTranscriptText(
    input.outputPreview ?? "",
    CODEX_SUBAGENT_TRANSCRIPT_OUTPUT_MAX_CHARS,
  );
  return {
    role: "assistant",
    text: "",
    toolUses: [{ name: input.name, summary }],
    ...(outputPreview.length > 0 ? { outputPreview } : {}),
  };
}

function codexMcpOutputPreview(
  result: Extract<CodexStoredThreadItem, { readonly type: "mcpToolCall" }>["result"],
): string {
  if (!result) {
    return "";
  }
  const text = result.content.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }
    if (part && typeof part === "object" && "text" in part) {
      const candidate = (part as { readonly text?: unknown }).text;
      return typeof candidate === "string" ? [candidate] : [];
    }
    return [];
  });
  if (text.length > 0) {
    return text.join("\n");
  }
  return codexJsonPreview(result.structuredContent, CODEX_SUBAGENT_TRANSCRIPT_OUTPUT_MAX_CHARS);
}

function mapCodexStoredItem(
  item: CodexStoredThreadItem,
): ProviderSubagentTranscriptEntry | undefined {
  switch (item.type) {
    case "userMessage": {
      const text = item.content
        .map((content) => {
          switch (content.type) {
            case "text":
              return content.text;
            case "image":
              return "[image]";
            case "localImage":
              return `[local image: ${content.path}]`;
            case "skill":
              return `[$${content.name} skill]`;
            case "mention":
              return `[@${content.name}]`;
          }
        })
        .join("\n");
      return {
        role: "user",
        text: capCodexTranscriptText(text, CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS),
        toolUses: [],
      };
    }
    case "hookPrompt": {
      const text = item.fragments.map((fragment) => fragment.text).join("\n");
      return text.trim().length > 0
        ? {
            role: "system",
            text: capCodexTranscriptText(text, CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS),
            toolUses: [],
          }
        : undefined;
    }
    case "agentMessage":
      return {
        role: "assistant",
        text: capCodexTranscriptText(item.text, CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS),
        toolUses: [],
      };
    case "plan":
      return {
        role: "assistant",
        text: capCodexTranscriptText(item.text, CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS),
        toolUses: [],
      };
    case "reasoning": {
      const text = item.summary?.join("\n") ?? "";
      return text.trim().length > 0
        ? {
            role: "thinking",
            text: capCodexTranscriptText(text, CODEX_SUBAGENT_TRANSCRIPT_TEXT_MAX_CHARS),
            toolUses: [],
          }
        : undefined;
    }
    case "commandExecution":
      return codexToolEntry({
        name: "shell_command",
        summary: item.command,
        ...(item.aggregatedOutput ? { outputPreview: item.aggregatedOutput } : {}),
      });
    case "fileChange":
      return codexToolEntry({
        name: "apply_patch",
        summary: item.changes.map((change) => `${change.kind} ${change.path}`).join(", "),
      });
    case "mcpToolCall":
      return codexToolEntry({
        name: `${item.server}.${item.tool}`,
        summary: codexJsonPreview(item.arguments, CODEX_SUBAGENT_TRANSCRIPT_TOOL_SUMMARY_MAX_CHARS),
        outputPreview: item.error?.message ?? codexMcpOutputPreview(item.result),
      });
    case "dynamicToolCall":
      return codexToolEntry({
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        summary: codexJsonPreview(item.arguments, CODEX_SUBAGENT_TRANSCRIPT_TOOL_SUMMARY_MAX_CHARS),
        outputPreview: (item.contentItems ?? [])
          .map((content) =>
            content.type === "inputText" ? content.text : `[image: ${content.imageUrl}]`,
          )
          .join("\n"),
      });
    case "collabAgentToolCall":
      return codexToolEntry({
        name: item.tool,
        summary: item.prompt ?? item.receiverThreadIds.join(", "),
      });
    case "subAgentActivity":
      return codexToolEntry({
        name: "subagent",
        summary: `${item.kind}: ${item.agentPath}`,
      });
    case "webSearch":
      return codexToolEntry({ name: "web_search", summary: item.query });
    case "imageView":
      return codexToolEntry({ name: "view_image", summary: item.path });
    case "sleep":
      return codexToolEntry({ name: "sleep", summary: `${item.durationMs} ms` });
    case "imageGeneration":
      return codexToolEntry({
        name: "image_generation",
        summary: item.revisedPrompt ?? item.status,
        outputPreview: item.result,
      });
    case "enteredReviewMode":
      return { role: "system", text: item.review, toolUses: [] };
    case "exitedReviewMode":
      return { role: "system", text: item.review, toolUses: [] };
    case "contextCompaction":
      return { role: "system", text: "Context compacted", toolUses: [] };
  }
}

export function mapCodexSubagentTranscript(
  thread: CodexStoredThread,
  options?: { readonly limit?: number },
): ProviderSubagentTranscriptResult {
  const entries = thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const entry = mapCodexStoredItem(item);
      return entry === undefined ? [] : [entry];
    }),
  );
  const limit = options?.limit ?? CODEX_SUBAGENT_TRANSCRIPT_DEFAULT_LIMIT;
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

/** Prefer the canonical parentThreadId, with the source metadata retained by
 * older app-server versions as a compatibility fallback. */
export function readCodexSubagentParentThreadId(thread: CodexStoredThread): string | undefined {
  if (thread.parentThreadId?.trim()) {
    return thread.parentThreadId;
  }
  const source = thread.source as unknown;
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = (source as { readonly subAgent?: unknown }).subAgent;
  if (!subAgent || typeof subAgent !== "object" || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = (subAgent as { readonly thread_spawn?: unknown }).thread_spawn;
  if (!spawn || typeof spawn !== "object" || !("parent_thread_id" in spawn)) {
    return undefined;
  }
  const parentThreadId = (spawn as { readonly parent_thread_id?: unknown }).parent_thread_id;
  return typeof parentThreadId === "string" && parentThreadId.trim().length > 0
    ? parentThreadId
    : undefined;
}

function providerErrorClass(message: string): "authentication_error" | "provider_error" {
  return isProviderAuthErrorMessage(message) ? "authentication_error" : "provider_error";
}

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Invoked whenever the app-server pushes a rolling rate-limit update. The
   * driver folds these into the instance's provider snapshot so account
   * usage updates live instead of waiting for the next probe.
   */
  readonly onAccountRateLimitsUpdated?: (
    rateLimits: EffectCodexSchema.V2AccountRateLimitsUpdatedNotification["rateLimits"],
  ) => Effect.Effect<void>;
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  // Rendered cross-driver handoff preamble, prepended to the first turn's input
  // and cleared once consumed. Set only when a session starts from a context
  // seed (no native resume).
  pendingContextSeedText: string | undefined;
  stopped: boolean;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexSubAgentActivityItem = Extract<CodexLifecycleItem, { readonly type: "subAgentActivity" }>;

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

/** Codex stamps goal timestamps as int64 epoch values without documenting the
 *  unit. Disambiguate on magnitude: values >= 1e12 can only be milliseconds
 *  (as seconds they'd be past year 33000), smaller values only seconds. */
function codexEpochToIso(value: number): string {
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function normalizeCodexThreadGoal(
  goal: EffectCodexSchema.V2ThreadGoalUpdatedNotification["goal"],
): RuntimeThreadGoalSnapshot {
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: codexEpochToIso(goal.createdAt),
    updatedAt: codexEpochToIso(goal.updatedAt),
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("sub agent activity")) return "collab_agent_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("entered review") || type.includes("review entered")) {
    return "review_entered";
  }
  if (type.includes("exited review") || type.includes("review exited")) {
    return "review_exited";
  }
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function canonicalSubAgentActivityItem(item: CodexSubAgentActivityItem): Record<string, unknown> {
  const running = item.kind !== "interrupted";
  return {
    ...item,
    // Keep the native fields above while exposing the stable collab-agent
    // fields consumed by projections shared across providers.
    tool:
      item.kind === "started"
        ? "spawnAgent"
        : item.kind === "interacted"
          ? "sendInput"
          : "closeAgent",
    status: running ? "inProgress" : "completed",
    receiverThreadIds: [item.agentThreadId],
    agentsStates: {
      [item.agentThreadId]: {
        status: running ? "running" : "interrupted",
      },
    },
  };
}

function canonicalItemLifecycleData(
  payload:
    | EffectCodexSchema.V2ItemStartedNotification
    | EffectCodexSchema.V2ItemCompletedNotification,
  item: CodexLifecycleItem,
): unknown {
  if (item.type !== "subAgentActivity") {
    return payload;
  }

  return {
    ...payload,
    item: canonicalSubAgentActivityItem(item),
  };
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "review_entered":
      return "Review started";
    case "review_exited":
      return "Review completed";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "review" in item ? item.review : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function basenameFromPath(path: string | undefined | null): string | undefined {
  const trimmed = trimText(path);
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(/[\\/]/u);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part) {
      return part;
    }
  }
  return trimmed;
}

function hookOutputText(
  entries: ReadonlyArray<{ readonly kind: string; readonly text: string }> | undefined,
): string | undefined {
  const text = entries
    ?.map((entry) => trimText(entry.text))
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");
  return trimText(text);
}

function hookOutcomeFromStatus(status: string | undefined): "success" | "error" | "cancelled" {
  switch (status) {
    case "completed":
      return "success";
    case "stopped":
      return "cancelled";
    default:
      return "error";
  }
}

function firstStringField(value: unknown, fields: ReadonlyArray<string>): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const trimmed = trimText(typeof record[field] === "string" ? record[field] : undefined);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function summarizeReviewAction(action: unknown): string | undefined {
  return firstStringField(action, ["type", "kind", "name", "command", "tool"]);
}

function summarizePatchChanges(
  changes: ReadonlyArray<{ readonly kind: unknown; readonly path: string }>,
): string {
  if (changes.length === 0) {
    return "Patch updated";
  }
  const [first] = changes;
  const suffix = changes.length > 1 ? ` +${changes.length - 1} more` : "";
  return `${String(first?.kind ?? "updated")} ${first?.path ?? "file"}${suffix}`;
}

function rawResponseItemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  for (const key of ["id", "call_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function rawSearchDetail(
  item: EffectCodexSchema.V2RawResponseItemCompletedNotification["item"],
): string | undefined {
  if (item.type === "tool_search_call") {
    return trimText(item.execution);
  }
  if (item.type === "tool_search_output") {
    return trimText(item.execution);
  }
  if (item.type !== "web_search_call") {
    return undefined;
  }

  const action = item.action;
  if (!action) {
    return undefined;
  }
  switch (action.type) {
    case "search":
      return trimText(action.query) ?? trimText(action.queries?.join(", "));
    case "open_page":
      return trimText(action.url);
    case "find_in_page":
      return trimText(action.pattern) ?? trimText(action.url);
    case "other":
      return undefined;
  }
}

function rawResponseItemStatus(
  status: string | null | undefined,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  const normalized = trimText(status)
    ?.toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!normalized) {
    return "completed";
  }
  if (normalized === "failed" || normalized === "failure" || normalized === "error") {
    return "failed";
  }
  if (normalized === "declined") {
    return "declined";
  }
  if (normalized === "inprogress" || normalized === "running" || normalized === "pending") {
    return "inProgress";
  }
  return "completed";
}

function decodeBase64Text(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation";
    case "item/permissions/requestApproval":
      return "permissions_approval";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    case "attestation/generate":
      return "attestation_generate";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "permissions":
      return "permissions_approval";
    default:
      return "unknown";
  }
}

function readPayloadEnvironmentId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).environmentId;
  return typeof value === "string" ? trimText(value) : undefined;
}

function describePermissionsRequest(
  permissions:
    | EffectCodexSchema.PermissionsRequestApprovalParams__RequestPermissionProfile
    | undefined,
): string | undefined {
  if (!permissions) {
    return undefined;
  }
  const parts: string[] = [];
  if (permissions.network?.enabled === true) {
    parts.push("network access");
  }
  const fileSystem = permissions.fileSystem;
  const readCount = fileSystem?.read?.length ?? 0;
  const writeCount = fileSystem?.write?.length ?? 0;
  const entriesCount = fileSystem?.entries?.length ?? 0;
  if (writeCount > 0 || entriesCount > 0) {
    parts.push("filesystem access");
  } else if (readCount > 0) {
    parts.push("filesystem read access");
  }
  return parts.length > 0 ? `Requesting ${parts.join(", ")}` : undefined;
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function isoFromEpochMillis(
  value: number | undefined,
): ProviderRuntimeEvent["createdAt"] | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  });
}

function lifecycleCreatedAt(event: ProviderEvent): ProviderRuntimeEvent["createdAt"] | undefined {
  const started = readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload);
  if (started) {
    return isoFromEpochMillis(started.startedAtMs);
  }
  const completed = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  if (completed) {
    return isoFromEpochMillis(completed.completedAtMs);
  }
  return undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: lifecycleCreatedAt(event) ?? event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      data: canonicalItemLifecycleData(payload, item),
    },
  };
}

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: addProviderAuthHint(PROVIDER, event.message),
          class: providerErrorClass(event.message),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "item/permissions/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.PermissionsRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? describePermissionsRequest(payload?.permissions);
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();
    const environmentId = readPayloadEnvironmentId(event.payload);

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(environmentId ? { environmentId } : {}),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/deleted" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/deleted"
                ? "deleted"
                : event.method === "thread/closed"
                  ? "closed"
                  : event.method === "thread/compacted"
                    ? "compacted"
                    : payload
                      ? toThreadState(payload.status)
                      : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "thread/goal/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadGoalUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "goal.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          goal: normalizeCodexThreadGoal(payload.goal),
        },
      },
    ];
  }

  if (event.method === "thread/goal/cleared") {
    return [
      {
        type: "goal.cleared",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {},
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    const hintedErrorMessage = errorMessage
      ? addProviderAuthHint(PROVIDER, errorMessage)
      : undefined;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(hintedErrorMessage ? { errorMessage: hintedErrorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "hook/started") {
    const payload = readPayload(EffectCodexSchema.V2HookStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        ...(payload.turnId ? { turnId: TurnId.make(payload.turnId) } : {}),
        type: "hook.started",
        payload: {
          hookId: payload.run.id,
          hookName: basenameFromPath(payload.run.sourcePath) ?? payload.run.eventName,
          hookEvent: payload.run.eventName,
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const payload = readPayload(EffectCodexSchema.V2HookCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const output = hookOutputText(payload.run.entries);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        ...(payload.turnId ? { turnId: TurnId.make(payload.turnId) } : {}),
        type: "hook.completed",
        payload: {
          hookId: payload.run.id,
          outcome: hookOutcomeFromStatus(payload.run.status),
          ...(output ? { output } : {}),
          ...(payload.run.statusMessage ? { stderr: payload.run.statusMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ItemGuardianApprovalReviewStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const action = summarizeReviewAction(payload.action);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        ...(payload.targetItemId ? { itemId: RuntimeItemId.make(payload.targetItemId) } : {}),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(payload.reviewId),
          taskType: "approval-review",
          description: action ? `Reviewing ${action}` : "Reviewing approval request",
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2ItemGuardianApprovalReviewCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const action = summarizeReviewAction(payload.action);
    const decision =
      typeof payload.decisionSource === "string"
        ? payload.decisionSource
        : firstStringField(payload.decisionSource, ["type", "kind", "decision"]);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        ...(payload.targetItemId ? { itemId: RuntimeItemId.make(payload.targetItemId) } : {}),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(payload.reviewId),
          status: "completed",
          summary: action
            ? `Approval review completed for ${action}${decision ? `: ${decision}` : ""}`
            : "Approval review completed",
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/fileChange/patchUpdated") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangePatchUpdatedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        itemId: RuntimeItemId.make(payload.itemId),
        type: "item.updated",
        payload: {
          itemType: "file_change",
          status: "inProgress",
          title: "File change",
          detail: summarizePatchChanges(payload.changes),
          data: {
            changes: payload.changes,
          },
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "command/exec/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecOutputDeltaNotification,
      event.payload,
    );
    const delta = decodeBase64Text(payload?.deltaBase64);
    if (!payload || !delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        itemId: RuntimeItemId.make(payload.processId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "process/outputDelta") {
    const payload = readPayload(EffectCodexSchema.V2ProcessOutputDeltaNotification, event.payload);
    const delta = decodeBase64Text(payload?.deltaBase64);
    if (!payload || !delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        itemId: RuntimeItemId.make(payload.processHandle),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "rawResponseItem/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2RawResponseItemCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }

    const item = payload.item;
    if (
      item.type !== "tool_search_call" &&
      item.type !== "tool_search_output" &&
      item.type !== "web_search_call"
    ) {
      return [];
    }

    const itemId = rawResponseItemId(item) ?? event.itemId ?? `${payload.turnId}:raw-search`;
    const status =
      "status" in item && typeof item.status === "string"
        ? rawResponseItemStatus(item.status)
        : "completed";
    const detail = rawSearchDetail(item);

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        itemId: RuntimeItemId.make(itemId),
        type: "item.completed",
        payload: {
          itemType: "web_search",
          status,
          title: "Web search",
          ...(detail ? { detail } : {}),
          data: event.payload,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        itemId: RuntimeItemId.make(payload.itemId),
        type: "tool.progress",
        payload: {
          toolUseId: payload.itemId,
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "model/safetyBuffering/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ModelSafetyBufferingUpdatedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.safety-buffering.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: event.turnId ?? TurnId.make(payload.turnId),
        payload: {
          model: payload.model,
          useCases: payload.useCases,
          reasons: payload.reasons,
          showBufferingUi: payload.showBufferingUi,
          fasterModel: payload.fasterModel ?? null,
        },
      },
    ];
  }

  if (event.method === "model/verification") {
    const payload = readPayload(EffectCodexSchema.V2ModelVerificationNotification, event.payload);
    if (!payload || payload.verifications.length === 0) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        turnId: TurnId.make(payload.turnId),
        payload: {
          summary: "Model verification required",
          details: payload.verifications.join(", "),
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/login/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2AccountLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "auth.status",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          isAuthenticating: false,
          ...(payload.error ? { error: payload.error } : {}),
          output: [payload.success ? "Login completed" : "Login failed"],
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/startupStatus/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerStatusUpdatedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.status.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          status: {
            name: payload.name,
            status: payload.status,
            ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
          },
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: addProviderAuthHint(PROVIDER, message),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/transcript/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeTranscriptDeltaNotification,
      event.payload,
    );
    if (!payload || payload.delta.length === 0) {
      return [];
    }
    return [
      {
        type: "content.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          streamKind: payload.role === "assistant" ? "assistant_text" : "unknown",
          delta: payload.delta,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "warning") {
    const payload = readPayload(EffectCodexSchema.V2WarningNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Provider warning";
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "guardianWarning") {
    const payload = readPayload(EffectCodexSchema.V2GuardianWarningNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Guardian warning";
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    const errorClass = providerErrorClass(message);
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: addProviderAuthHint(PROVIDER, message),
          ...(!willRetry ? { class: errorClass } : {}),
          ...(willRetry ? { warningKind: "api-retry" } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message: addProviderAuthHint(PROVIDER, message),
              class: providerErrorClass(message),
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

function hasAuthenticationRuntimeError(events: ReadonlyArray<ProviderRuntimeEvent>): boolean {
  return events.some(
    (event) => event.type === "runtime.error" && event.payload.class === "authentication_error",
  );
}

function makeAuthenticationSessionExitedEvent(event: ProviderEvent): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase(event, event.threadId),
    eventId: EventId.make(`${event.id}:auth-session-exited`),
    type: "session.exited",
    payload: {
      reason: "Authentication failed",
      recoverable: true,
      exitKind: "error",
    },
  };
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        const serviceTier = resolveCodexServiceTier(input.modelSelection, {
          instanceId: boundInstanceId,
        });
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          cwd: input.cwd ?? process.cwd(),
          binaryPath: codexConfig.binaryPath,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          ...(input.forkFrom !== undefined ? { forkFrom: input.forkFrom } : {}),
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(serviceTier ? { serviceTier } : {}),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
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

        // The session context owns and explicitly interrupts this fiber. It
        // must not inherit the short-lived caller that happens to start the
        // session, otherwise provider events stop as soon as startup returns.
        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            // A dead child (crash or graceful close outside stopSession) must
            // not linger in the session map: hasSession/listSessions would
            // keep routing turns to it instead of letting the next turn start
            // a fresh session from the resume cursor.
            if (runtimeEvents.some((runtimeEvent) => runtimeEvent.type === "session.exited")) {
              const session = sessions.get(event.threadId);
              if (session && !session.stopped) {
                yield* stopSessionInternal(session, {
                  interruptEventFiber: false,
                });
              }
            }
            if (
              options?.onAccountRateLimitsUpdated &&
              event.method === "account/rateLimits/updated"
            ) {
              const rateLimitsPayload = readPayload(
                EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
                event.payload,
              );
              if (rateLimitsPayload) {
                yield* options
                  .onAccountRateLimitsUpdated(rateLimitsPayload.rateLimits)
                  .pipe(Effect.ignoreCause({ log: true }));
              }
            }
            if (hasAuthenticationRuntimeError(runtimeEvents)) {
              yield* Queue.offer(runtimeEventQueue, makeAuthenticationSessionExitedEvent(event));
              const session = sessions.get(event.threadId);
              if (session && !session.stopped) {
                yield* stopSessionInternal(session, {
                  interruptEventFiber: false,
                });
              }
            }
          }),
        ).pipe(Effect.forkDetach);

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        sessions.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          // Render the cross-driver handoff seed once at start; consumed on the
          // first turn. Only honored when there is no native resume cursor.
          pendingContextSeedText:
            input.contextSeed !== undefined && !isCodexResumeCursorSchema(input.resumeCursor)
              ? renderThreadContextSeed(input.contextSeed)
              : undefined,
          stopped: false,
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    method: "turn/start" | "turn/steer",
    attachment: ChatAttachment,
  ) {
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
      // Codex app-server input has no document type; the agent reads the
      // staged file from disk instead (see buildFileAttachmentNote).
      const stagedFileExists = yield* fileSystem
        .exists(attachmentPath)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!stagedFileExists) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Attachment file '${attachment.name}' is missing.`,
        });
      }
      return {
        type: "text" as const,
        text: buildFileAttachmentNote(attachment, attachmentPath),
      };
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
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
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/start", attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    // Cross-driver handoff: lead the first turn with the rendered seed, then
    // continue natively on subsequent turns.
    const pendingContextSeedText = session.pendingContextSeedText;
    const seededInput =
      pendingContextSeedText !== undefined
        ? withContextSeedPreamble(pendingContextSeedText, input.input)
        : input.input;
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier = resolveCodexServiceTier(input.modelSelection, {
      instanceId: boundInstanceId,
    });
    const turn = yield* session.runtime
      .sendTurn({
        ...(input.messageId !== undefined ? { clientUserMessageId: input.messageId } : {}),
        ...(seededInput !== undefined ? { input: seededInput } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.skills !== undefined
          ? {
              skills: input.skills.map((skill) => ({
                type: "skill" as const,
                name: skill.name,
                path: skill.path,
              })),
            }
          : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
    if (pendingContextSeedText !== undefined) {
      session.pendingContextSeedText = undefined;
    }
    return turn;
  });

  const steerTurn: NonNullable<CodexAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(function* (
    input: ProviderSteerTurnInput,
  ) {
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/steer", attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    return yield* session.runtime
      .steerTurn({
        expectedTurnId: input.expectedTurnId,
        ...(input.messageId !== undefined ? { clientUserMessageId: input.messageId } : {}),
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.skills !== undefined
          ? {
              skills: input.skills.map((skill) => ({
                type: "skill" as const,
                name: skill.name,
                path: skill.path,
              })),
            }
          : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/steer", cause)));
  });

  const startReview: NonNullable<CodexAdapterShape["startReview"]> = Effect.fn("startReview")(
    function* (input: ProviderStartReviewInput) {
      const session = yield* requireSession(input.threadId);
      return yield* session.runtime
        .startReview({
          target: input.target,
          ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
        })
        .pipe(
          Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "review/start", cause)),
        );
    },
  );

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.interruptTurn(turnId)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const compactContext: NonNullable<CodexAdapterShape["compactContext"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.compactContext),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/compact/start", cause),
      ),
    );

  const setThreadGoal: NonNullable<CodexAdapterShape["setThreadGoal"]> = (input) =>
    requireSession(input.threadId).pipe(
      Effect.flatMap((session) =>
        session.runtime.setGoal({
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        }),
      ),
      Effect.map(normalizeCodexThreadGoal),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(input.threadId, "thread/goal/set", cause),
      ),
    );

  const getThreadGoal: NonNullable<CodexAdapterShape["getThreadGoal"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.getGoal),
      Effect.map((goal) => (goal === null ? null : normalizeCodexThreadGoal(goal))),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/goal/get", cause),
      ),
    );

  const clearThreadGoal: NonNullable<CodexAdapterShape["clearThreadGoal"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.clearGoal),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/goal/clear", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const readSubagentTranscript: NonNullable<CodexAdapterShape["readSubagentTranscript"]> =
    Effect.fn("readSubagentTranscript")(function* (threadId, input) {
      const requestError = (detail: string) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "readSubagentTranscript",
          detail,
        });
      const context = yield* requireSession(threadId);
      const root = yield* context.runtime.readThread.pipe(
        Effect.mapError((cause) => mapCodexRuntimeError(threadId, "thread/read", cause)),
      );
      if (input.agentId === root.threadId) {
        return yield* requestError("The requested transcript belongs to the parent thread.");
      }

      const readStoredThread = (providerThreadId: string) =>
        context.runtime
          .readStoredThread(providerThreadId)
          .pipe(Effect.mapError((cause) => mapCodexRuntimeError(threadId, "thread/read", cause)));
      const candidate = yield* readStoredThread(input.agentId);
      const visited = new Set<string>([candidate.id]);
      let current = candidate;

      for (let depth = 0; depth < CODEX_SUBAGENT_MAX_ANCESTRY_DEPTH; depth += 1) {
        const parentThreadId = readCodexSubagentParentThreadId(current);
        if (parentThreadId === root.threadId) {
          return mapCodexSubagentTranscript(
            candidate,
            input.limit !== undefined ? { limit: input.limit } : undefined,
          );
        }
        if (!parentThreadId || visited.has(parentThreadId)) {
          return yield* requestError(
            `Codex thread '${input.agentId}' is not a subagent of this conversation.`,
          );
        }
        visited.add(parentThreadId);
        current = yield* readStoredThread(parentThreadId);
      }

      return yield* requestError(
        `Codex thread '${input.agentId}' exceeded the supported subagent nesting depth.`,
      );
    });

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const deleteThread: NonNullable<CodexAdapterShape["deleteThread"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.runtime.deleteThread.pipe(Effect.ensuring(stopSessionInternal(session))),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/delete", cause),
      ),
    );

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fnUntraced(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId).pipe(Effect.withTracerEnabled(false));
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
    options?: { readonly interruptEventFiber?: boolean },
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    sessions.delete(session.threadId);
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    if (options?.interruptEventFiber !== false) {
      yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
    }
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), (session) => stopSessionInternal(session), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      manualContextCompaction: "supported",
      activeTurnSteering: "supported",
      reviewStart: "supported",
      threadGoals: "supported",
      nativeThreadFork: "supported",
    },
    startSession,
    sendTurn,
    steerTurn,
    startReview,
    interruptTurn,
    compactContext,
    setThreadGoal,
    getThreadGoal,
    clearThreadGoal,
    readThread,
    readSubagentTranscript,
    rollbackThread,
    deleteThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
