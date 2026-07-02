import {
  ApprovalRequestId,
  EventId,
  isToolLifecycleItemType,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
} from "@threadlines/contracts";
import {
  MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH,
  MAX_THREAD_ACTIVITY_PAYLOAD_ARRAY_ITEMS,
  MAX_THREAD_ACTIVITY_PAYLOAD_DEPTH,
  MAX_THREAD_ACTIVITY_PAYLOAD_OBJECT_KEYS,
  MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH,
} from "@threadlines/shared/threadLimits";

type ContentDeltaEvent = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
type ContentStreamKind = ContentDeltaEvent["payload"]["streamKind"];

export interface ProviderActivityStreamSnapshot {
  readonly activityId: EventId;
  readonly streamKind: ContentStreamKind;
  readonly text: string;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly redacted?: boolean;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function truncateBlock(value: string, limit = 1_200): string {
  if (value.length <= limit) {
    return value;
  }
  return `...${value.slice(value.length - limit + 3)}`;
}

const OUTPUT_LIKE_PAYLOAD_KEYS = new Set([
  "aggregatedOutput",
  "content",
  "diff",
  "output",
  "patch",
  "stderr",
  "stdout",
]);

interface PayloadTextCompactionLimits {
  /** Cap for any string value. */
  readonly text: number;
  /** Tighter cap for output-like keys (stdout, diff, content, ...). */
  readonly outputText: number;
}

const DEFAULT_PAYLOAD_TEXT_LIMITS: PayloadTextCompactionLimits = {
  text: MAX_THREAD_ACTIVITY_PAYLOAD_TEXT_LENGTH,
  outputText: 1_200,
};

/** A collab agent's final message is the product of the call and often lands
 *  under an output-like key, so both caps get the agent-result length. */
const COLLAB_AGENT_PAYLOAD_TEXT_LIMITS: PayloadTextCompactionLimits = {
  text: MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH,
  outputText: MAX_THREAD_ACTIVITY_PAYLOAD_AGENT_RESULT_TEXT_LENGTH,
};

function shouldCompactPayloadString(
  key: string | undefined,
  value: string,
  limits: PayloadTextCompactionLimits,
): boolean {
  return (
    value.length > limits.text ||
    (key !== undefined && OUTPUT_LIKE_PAYLOAD_KEYS.has(key) && value.length > limits.outputText)
  );
}

function isImageGenerationPayloadRecord(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  if (type === "imagegeneration" || type === "image_generation") {
    return true;
  }

  const tool = typeof value.tool === "string" ? value.tool.trim().toLowerCase() : "";
  const namespace = typeof value.namespace === "string" ? value.namespace.trim().toLowerCase() : "";
  return (
    typeof value.result === "string" && (tool.includes("image") || namespace.includes("image"))
  );
}

function compactActivityPayloadData(
  value: unknown,
  key?: string | undefined,
  depth = 0,
  limits: PayloadTextCompactionLimits = DEFAULT_PAYLOAD_TEXT_LIMITS,
): unknown {
  if (typeof value === "string") {
    return shouldCompactPayloadString(key, value, limits)
      ? truncateBlock(value, limits.text)
      : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_THREAD_ACTIVITY_PAYLOAD_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_THREAD_ACTIVITY_PAYLOAD_ARRAY_ITEMS)
      .map((entry) => compactActivityPayloadData(entry, key, depth + 1, limits));
    if (value.length > MAX_THREAD_ACTIVITY_PAYLOAD_ARRAY_ITEMS) {
      compacted.push({
        truncated: true,
        remainingItems: value.length - MAX_THREAD_ACTIVITY_PAYLOAD_ARRAY_ITEMS,
      });
    }
    return compacted;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const compacted: Record<string, unknown> = {};
  const preserveImageResult = isImageGenerationPayloadRecord(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, MAX_THREAD_ACTIVITY_PAYLOAD_OBJECT_KEYS)) {
    compacted[entryKey] =
      preserveImageResult && entryKey === "result" && typeof entryValue === "string"
        ? entryValue
        : compactActivityPayloadData(entryValue, entryKey, depth + 1, limits);
  }
  if (entries.length > MAX_THREAD_ACTIVITY_PAYLOAD_OBJECT_KEYS) {
    compacted.__truncatedKeys = entries.length - MAX_THREAD_ACTIVITY_PAYLOAD_OBJECT_KEYS;
  }
  return compacted;
}

function isFallbackModelRerouteReason(reason: string): boolean {
  return reason.toLowerCase().includes("fallback");
}

function describeModelRerouteDetail(input: {
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: string;
}): string {
  if (input.reason === "fallback:refusal") {
    return `Claude retried with ${input.toModel} after ${input.fromModel} refused the request.`;
  }
  if (isFallbackModelRerouteReason(input.reason)) {
    return `Claude is using ${input.toModel} because ${input.fromModel} was unavailable.`;
  }
  return input.reason;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function contextCompactionActivityId(event: ProviderRuntimeEvent): EventId {
  const scopeKey = event.turnId ?? event.itemId ?? "session";
  return EventId.make(`activity:context-compaction:${event.threadId}:${scopeKey}`);
}

function compactingSessionStatusReason(event: ProviderRuntimeEvent): string | undefined {
  if (event.type !== "session.state.changed" || event.payload.state !== "waiting") {
    return undefined;
  }
  const reason = event.payload.reason?.trim().toLowerCase();
  if (reason === "status:compacting" || reason === "compacting") {
    return event.payload.reason;
  }
  const detail = event.payload.detail;
  if (detail && typeof detail === "object") {
    const status = (detail as Record<string, unknown>).status;
    if (typeof status === "string" && status.trim().toLowerCase() === "compacting") {
      return `status:${status}`;
    }
  }
  return undefined;
}

function isManualSyntheticCompactingStatusEvent(event: ProviderRuntimeEvent): boolean {
  if (event.type !== "session.state.changed") {
    return false;
  }
  const detail = event.payload.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return false;
  }
  const trigger = (detail as Record<string, unknown>).trigger;
  return typeof trigger === "string" && trigger.trim().toLowerCase() === "manual";
}

function contextCompactionStatusFromItemEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.completed" | "item.updated" }
  >,
): "inProgress" | "completed" | "failed" {
  if (event.type === "item.completed") {
    return event.payload.status === "failed" || event.payload.status === "declined"
      ? "failed"
      : "completed";
  }
  if (event.payload.status === "completed") {
    return "completed";
  }
  if (event.payload.status === "failed" || event.payload.status === "declined") {
    return "failed";
  }
  return "inProgress";
}

function contextCompactionSummary(status: "inProgress" | "completed" | "failed"): string {
  switch (status) {
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "inProgress":
      return "Compacting context...";
  }
}

function contextCompactionTone(
  status: "inProgress" | "completed" | "failed",
): OrchestrationThreadActivity["tone"] {
  return status === "failed" ? "warning" : "info";
}

function projectContextCompactionActivity(
  event: ProviderRuntimeEvent,
  input: {
    readonly status: "inProgress" | "completed" | "failed";
    readonly detail?: unknown;
    readonly sourceItemType?: string;
    readonly state?: string;
  },
): ReadonlyArray<OrchestrationThreadActivity> {
  return [
    baseActivity(event, {
      id: contextCompactionActivityId(event),
      tone: contextCompactionTone(input.status),
      kind: "context-compaction",
      summary: contextCompactionSummary(input.status),
      payload: {
        status: input.status,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.sourceItemType !== undefined ? { sourceItemType: input.sourceItemType } : {}),
        ...(input.detail !== undefined ? { detail: compactActivityPayloadData(input.detail) } : {}),
      },
    }),
  ];
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | "permissions" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "permissions_approval":
      return "permissions";
    default:
      return undefined;
  }
}

function maybeSequence(event: ProviderRuntimeEvent): { sequence: number } | Record<string, never> {
  const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
  return eventWithSequence.sessionSequence !== undefined
    ? { sequence: eventWithSequence.sessionSequence }
    : {};
}

function baseActivity(
  event: ProviderRuntimeEvent,
  input: Omit<OrchestrationThreadActivity, "createdAt" | "turnId" | "sequence"> & {
    readonly createdAt?: OrchestrationThreadActivity["createdAt"];
    readonly turnId?: OrchestrationThreadActivity["turnId"];
  },
): OrchestrationThreadActivity {
  return {
    ...input,
    createdAt: input.createdAt ?? event.createdAt,
    turnId: input.turnId === undefined ? (toTurnId(event.turnId) ?? null) : input.turnId,
    ...maybeSequence(event),
  };
}

function compactUnknownDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? truncateDetail(trimmed) : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "summary", "detail", "error", "status", "name"]) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return truncateDetail(trimmed);
    }
  }
  return undefined;
}

function readMcpStartupStatus(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status.trim().toLowerCase() : undefined;
}

function hasMcpStartupError(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim().length > 0;
}

function shouldProjectMcpStatusUpdate(value: unknown): boolean {
  const status = readMcpStartupStatus(value);
  if (
    status === "starting" ||
    status === "ready" ||
    status === "connected" ||
    status === "cancelled"
  ) {
    return hasMcpStartupError(value);
  }
  return true;
}

function mcpStatusTone(value: unknown): OrchestrationThreadActivity["tone"] {
  const status = readMcpStartupStatus(value);
  return status === "failed" || status === "cancelled" || hasMcpStartupError(value)
    ? "warning"
    : "info";
}

function mcpStatusSummary(value: unknown): string {
  switch (readMcpStartupStatus(value)) {
    case "failed":
      return "MCP startup failed";
    case "cancelled":
      return "MCP startup cancelled";
    default:
      return "MCP status updated";
  }
}

function extractReasoningSummaryFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? truncateDetail(trimmed) : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = compactUnknownDetail(record.summary) ?? compactUnknownDetail(record.content);
  if (direct) {
    return direct;
  }

  const item = record.item;
  if (item && typeof item === "object") {
    const itemRecord = item as Record<string, unknown>;
    const summary = compactUnknownDetail(itemRecord.summary);
    if (summary) {
      return summary;
    }

    const summaryItems = itemRecord.summary;
    if (Array.isArray(summaryItems)) {
      const text = summaryItems
        .map((summaryItem) => compactUnknownDetail(summaryItem))
        .filter((part): part is string => part !== undefined)
        .join(" ")
        .trim();
      if (text.length > 0) {
        return truncateDetail(text);
      }
    }
  }

  return undefined;
}

function projectReasoningLifecycleActivity(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.completed" | "item.updated" }
  >,
): ReadonlyArray<OrchestrationThreadActivity> {
  const status =
    event.type === "item.completed"
      ? "completed"
      : event.payload.status === "completed"
        ? "completed"
        : event.payload.status === "failed" || event.payload.status === "declined"
          ? "failed"
          : "inProgress";
  const summary = extractReasoningSummaryFromUnknown(event.payload.data);
  return [
    baseActivity(event, {
      id: event.eventId,
      tone: status === "failed" ? "warning" : "thinking",
      kind: "thinking.progress",
      summary: "Thinking",
      payload: {
        status,
        sourceItemType: event.payload.itemType,
        ...(event.itemId ? { reasoningItemId: event.itemId } : {}),
        ...(summary ? { detail: summary, summary } : { detail: "Working through the next step" }),
        redacted: !summary,
      },
    }),
  ];
}

function projectContentDeltaActivity(
  event: ContentDeltaEvent,
  stream: ProviderActivityStreamSnapshot | undefined,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (!stream) {
    return [];
  }

  if (stream.streamKind === "reasoning_summary_text") {
    const detail = stream.text.trim();
    return [
      baseActivity(event, {
        id: stream.activityId,
        tone: "thinking",
        kind: "thinking.progress",
        summary: "Thinking",
        payload: {
          streamKind: stream.streamKind,
          ...(detail.length > 0 ? { detail: truncateDetail(detail) } : {}),
          ...(detail.length > 0 ? { summary: truncateDetail(detail) } : {}),
          byteCount: stream.byteCount,
          lineCount: stream.lineCount,
          truncated: stream.truncated,
          redacted: false,
        },
      }),
    ];
  }

  if (stream.streamKind === "reasoning_text") {
    return [
      baseActivity(event, {
        id: stream.activityId,
        tone: "thinking",
        kind: "thinking.progress",
        summary: "Thinking",
        payload: {
          streamKind: stream.streamKind,
          detail: "Working through the next step",
          byteCount: stream.byteCount,
          lineCount: stream.lineCount,
          truncated: stream.truncated,
          redacted: true,
        },
      }),
    ];
  }

  if (stream.streamKind === "command_output" || stream.streamKind === "file_change_output") {
    const isCommandOutput = stream.streamKind === "command_output";
    const detail = stream.text.trim();
    return [
      baseActivity(event, {
        id: stream.activityId,
        tone: "tool",
        kind: "tool.output.updated",
        summary: isCommandOutput ? "Command output" : "File-change output",
        payload: {
          itemType: isCommandOutput ? "command_execution" : "file_change",
          ...(event.itemId ? { toolCallId: event.itemId } : {}),
          status: "inProgress",
          title: isCommandOutput ? "Command output" : "File-change output",
          ...(detail.length > 0 ? { detail: truncateBlock(detail) } : {}),
          byteCount: stream.byteCount,
          lineCount: stream.lineCount,
          truncated: stream.truncated,
          streamKind: stream.streamKind,
        },
      }),
    ];
  }

  return [];
}

export function projectRuntimeEventToActivities(
  event: ProviderRuntimeEvent,
  options?: {
    readonly stream?: ProviderActivityStreamSnapshot | undefined;
  },
): ReadonlyArray<OrchestrationThreadActivity> {
  switch (event.type) {
    case "turn.started":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "thinking",
          kind: "provider.turn.started",
          summary: "Waiting for model response",
          payload: {
            phase: "waiting-for-model",
            provider: event.provider,
            ...(event.payload?.model ? { model: event.payload.model } : {}),
            ...(event.payload?.effort ? { effort: event.payload.effort } : {}),
            detail: "Provider accepted the turn and is preparing a response",
          },
        }),
      ];

    case "content.delta":
      return projectContentDeltaActivity(event, options?.stream);

    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : requestKind === "permissions"
                    ? "Permissions approval requested"
                    : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.environmentId ? { environmentId: event.payload.environmentId } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
        }),
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
        }),
      ];
    }

    case "runtime.error": {
      const isAuthenticationError = event.payload.class === "authentication_error";
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "error",
          kind: "runtime.error",
          summary: isAuthenticationError ? "Authentication required" : "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.class ? { class: event.payload.class } : {}),
            provider: event.provider,
          },
        }),
      ];
    }

    case "runtime.warning":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "warning",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            provider: event.provider,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
            ...(event.payload.warningKind !== undefined
              ? { warningKind: event.payload.warningKind }
              : {}),
          },
        }),
      ];

    case "turn.plan.updated":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
        }),
      ];

    case "turn.prompt-suggestion.updated":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "prompt-suggestion.updated",
          summary: "Prompt suggestion",
          payload: {
            suggestion: event.payload.suggestion,
          },
        }),
      ];

    case "user-input.requested":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
        }),
      ];

    case "user-input.resolved":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
        }),
      ];

    case "task.started":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
          },
        }),
      ];

    case "task.progress":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "thinking",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
          },
        }),
      ];

    case "task.completed":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
          },
        }),
      ];

    case "hook.started":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "tool",
          kind: "hook.started",
          summary: `${event.payload.hookEvent} hook started`,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent: event.payload.hookEvent,
            status: "inProgress",
          },
        }),
      ];

    case "hook.progress": {
      const detail = event.payload.output ?? event.payload.stdout ?? event.payload.stderr;
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: event.payload.stderr ? "warning" : "tool",
          kind: "hook.progress",
          summary: "Hook output",
          payload: {
            hookId: event.payload.hookId,
            status: "inProgress",
            ...(detail ? { detail: truncateBlock(detail) } : {}),
            ...(event.payload.stdout ? { stdout: truncateBlock(event.payload.stdout) } : {}),
            ...(event.payload.stderr ? { stderr: truncateBlock(event.payload.stderr) } : {}),
          },
        }),
      ];
    }

    case "hook.completed": {
      const detail = event.payload.output ?? event.payload.stdout ?? event.payload.stderr;
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: event.payload.outcome === "error" ? "error" : "tool",
          kind: "hook.completed",
          summary:
            event.payload.outcome === "success"
              ? "Hook completed"
              : event.payload.outcome === "cancelled"
                ? "Hook cancelled"
                : "Hook failed",
          payload: {
            hookId: event.payload.hookId,
            outcome: event.payload.outcome,
            status: event.payload.outcome === "success" ? "completed" : "failed",
            ...(detail ? { detail: truncateBlock(detail) } : {}),
            ...(event.payload.stdout ? { stdout: truncateBlock(event.payload.stdout) } : {}),
            ...(event.payload.stderr ? { stderr: truncateBlock(event.payload.stderr) } : {}),
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
          },
        }),
      ];
    }

    case "tool.progress":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "tool",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            itemType: "mcp_tool_call",
            ...(event.payload.toolUseId ? { toolCallId: event.payload.toolUseId } : {}),
            ...(event.itemId ? { toolCallId: event.itemId } : {}),
            status: "inProgress",
            ...(event.payload.toolName ? { title: event.payload.toolName } : {}),
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
          },
        }),
      ];

    case "tool.summary":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "tool.summary",
          summary: "Tool summary",
          payload: {
            detail: truncateDetail(event.payload.summary),
            ...(event.payload.precedingToolUseIds
              ? { precedingToolUseIds: event.payload.precedingToolUseIds }
              : {}),
          },
        }),
      ];

    case "session.state.changed": {
      const reason = compactingSessionStatusReason(event);
      if (!reason || isManualSyntheticCompactingStatusEvent(event)) {
        return [];
      }

      return projectContextCompactionActivity(event, {
        status: "inProgress",
        detail: event.payload.detail ?? reason,
        state: event.payload.state,
      });
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return projectContextCompactionActivity(event, {
        status: "completed",
        state: event.payload.state,
        ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
      });
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
        }),
      ];
    }

    case "item.updated": {
      if (event.payload.itemType === "reasoning") {
        return projectReasoningLifecycleActivity(event);
      }
      if (event.payload.itemType === "context_compaction") {
        const detail = event.payload.detail ?? event.payload.data;
        return projectContextCompactionActivity(event, {
          status: contextCompactionStatusFromItemEvent(event),
          sourceItemType: event.payload.itemType,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityPayloadData(event.payload.data) }
              : {}),
          },
        }),
      ];
    }

    case "item.completed": {
      if (event.payload.itemType === "reasoning") {
        return projectReasoningLifecycleActivity(event);
      }
      if (event.payload.itemType === "context_compaction") {
        const detail = event.payload.detail ?? event.payload.data;
        return projectContextCompactionActivity(event, {
          status: contextCompactionStatusFromItemEvent(event),
          sourceItemType: event.payload.itemType,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? {
                  data: compactActivityPayloadData(
                    event.payload.data,
                    undefined,
                    0,
                    event.payload.itemType === "collab_agent_tool_call"
                      ? COLLAB_AGENT_PAYLOAD_TEXT_LIMITS
                      : DEFAULT_PAYLOAD_TEXT_LIMITS,
                  ),
                }
              : {}),
          },
        }),
      ];
    }

    case "item.started": {
      if (event.payload.itemType === "reasoning") {
        return projectReasoningLifecycleActivity(event);
      }
      if (event.payload.itemType === "context_compaction") {
        const detail = event.payload.detail ?? event.payload.data;
        return projectContextCompactionActivity(event, {
          status: contextCompactionStatusFromItemEvent(event),
          sourceItemType: event.payload.itemType,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityPayloadData(event.payload.data) }
              : {}),
          },
        }),
      ];
    }

    case "model.rerouted":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "provider.model.rerouted",
          summary: isFallbackModelRerouteReason(event.payload.reason)
            ? `Using fallback model: ${event.payload.toModel}`
            : `Model switched to ${event.payload.toModel}`,
          payload: {
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            reason: event.payload.reason,
            detail: describeModelRerouteDetail(event.payload),
          },
        }),
      ];

    case "config.warning":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "warning",
          kind: "provider.config.warning",
          summary: event.payload.summary,
          payload: {
            detail: event.payload.details ?? event.payload.summary,
            ...(event.payload.path ? { path: event.payload.path } : {}),
            ...(event.payload.range !== undefined ? { range: event.payload.range } : {}),
          },
        }),
      ];

    case "deprecation.notice":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "warning",
          kind: "provider.deprecation.notice",
          summary: event.payload.summary,
          payload: {
            detail: event.payload.details ?? event.payload.summary,
          },
        }),
      ];

    case "auth.status":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: event.payload.error ? "warning" : "info",
          kind: "auth.status",
          summary: event.payload.error
            ? "Authentication issue"
            : event.payload.isAuthenticating
              ? "Authenticating"
              : "Authentication updated",
          payload: {
            ...(event.payload.error ? { detail: event.payload.error } : {}),
            ...(event.payload.output && event.payload.output.length > 0
              ? { output: truncateBlock(event.payload.output.join("\n")) }
              : {}),
            ...(event.payload.isAuthenticating !== undefined
              ? { isAuthenticating: event.payload.isAuthenticating }
              : {}),
          },
        }),
      ];

    case "account.updated":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "account.updated",
          summary: "Account updated",
          payload: {
            account: event.payload.account,
          },
        }),
      ];

    case "account.rate-limits.updated":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "account.rate-limits.updated",
          summary: "Rate limits updated",
          payload: {
            rateLimits: event.payload.rateLimits,
            ...(compactUnknownDetail(event.payload.rateLimits)
              ? { detail: compactUnknownDetail(event.payload.rateLimits) }
              : {}),
          },
        }),
      ];

    case "mcp.status.updated":
      if (!shouldProjectMcpStatusUpdate(event.payload.status)) {
        return [];
      }
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: mcpStatusTone(event.payload.status),
          kind: "mcp.status.updated",
          summary: mcpStatusSummary(event.payload.status),
          payload: {
            provider: event.provider,
            ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
            status: event.payload.status,
            ...(compactUnknownDetail(event.payload.status)
              ? { detail: compactUnknownDetail(event.payload.status) }
              : {}),
          },
        }),
      ];

    case "mcp.oauth.completed":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: event.payload.success ? "info" : "warning",
          kind: "mcp.oauth.completed",
          summary: event.payload.success
            ? "MCP authentication completed"
            : "MCP authentication failed",
          payload: {
            success: event.payload.success,
            ...(event.payload.name ? { name: event.payload.name } : {}),
            ...(event.payload.error ? { detail: event.payload.error } : {}),
          },
        }),
      ];

    case "files.persisted": {
      const failedCount = event.payload.failed?.length ?? 0;
      const fileCount = event.payload.files.length;
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: failedCount > 0 ? "warning" : "info",
          kind: "files.persisted",
          summary:
            failedCount > 0
              ? `${failedCount.toLocaleString()} file upload failed`
              : `${fileCount.toLocaleString()} file${fileCount === 1 ? "" : "s"} uploaded`,
          payload: {
            files: event.payload.files,
            ...(event.payload.failed ? { failed: event.payload.failed } : {}),
          },
        }),
      ];
    }

    case "thread.realtime.started":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "realtime.started",
          summary: "Realtime session started",
          payload: event.payload.realtimeSessionId
            ? { realtimeSessionId: event.payload.realtimeSessionId }
            : {},
        }),
      ];

    case "thread.realtime.error":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "error",
          kind: "realtime.error",
          summary: "Realtime error",
          payload: {
            message: event.payload.message,
          },
        }),
      ];

    case "thread.realtime.closed":
      return [
        baseActivity(event, {
          id: event.eventId,
          tone: "info",
          kind: "realtime.closed",
          summary: "Realtime session closed",
          payload: event.payload.reason ? { detail: event.payload.reason } : {},
        }),
      ];

    default:
      return [];
  }
}
