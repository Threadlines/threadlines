/**
 * Recognizes Claude's Agent/Task tool activities and reshapes them into the
 * collab-agent item shape the Codex driver emits natively (`data.item`), so
 * every consumer of the subagent roster — the web session derivation and the
 * server's durable projection — reads one canonical shape. Claude's tool rows
 * carry `data.toolName` + `data.input` instead of a nested item, and their
 * lifecycle is spread across tool status, background-launch acknowledgments,
 * structured results, and task-notification replays; this module owns all of
 * that interpretation.
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeStatusToken(value: string | null): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[_\s-]+/gu, "") ?? ""
  );
}

export function isSpawnAgentTool(tool: string | null): boolean {
  return tool?.trim().toLowerCase() === "spawnagent";
}

export function isClaudeSubagentToolName(toolName: string | null): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return (
    normalized === "agent" ||
    normalized === "task" ||
    normalized === "subagent" ||
    normalized === "sub-agent" ||
    normalized?.includes("subagent") === true ||
    normalized?.includes("sub-agent") === true
  );
}

export function claudeSubagentStateStatus(itemStatus: string): string {
  const normalized = normalizeStatusToken(itemStatus);
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "errored" || normalized === "error") {
    return "errored";
  }
  if (normalized === "interrupted" || normalized === "aborted" || normalized === "cancelled") {
    return "interrupted";
  }
  return "running";
}

function claudeSubagentStatusFromActivityKind(activityKind: string): string {
  if (activityKind === "tool.completed") {
    return "completed";
  }
  return "inProgress";
}

export function isTerminalClaudeSubagentState(stateStatus: string): boolean {
  return stateStatus === "completed" || stateStatus === "errored" || stateStatus === "interrupted";
}

export function extractClaudeSubagentResultText(result: unknown): string | null {
  const direct = asTrimmedString(result);
  if (direct) {
    return sanitizeClaudeSubagentResultText(direct);
  }

  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return null;
  }

  const text =
    extractClaudeTextContent(resultRecord.content) ??
    extractClaudeTextContent(resultRecord.text) ??
    extractClaudeTextContent(resultRecord.message);
  return sanitizeClaudeSubagentResultText(text);
}

function sanitizeClaudeSubagentResultText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const withoutFooter = stripClaudeContinuationFooter(stripTrailingUsageBlocks(value)).trim();
  return withoutFooter.length > 0 ? withoutFooter : null;
}

/** Strips trailing `<usage>…</usage>` blocks (and the whitespace around them)
 *  by index arithmetic. The result text is provider-influenced input, so this
 *  deliberately avoids a backtracking regex over the whole string. */
function stripTrailingUsageBlocks(value: string): string {
  let result = value.trimEnd();
  for (;;) {
    const lower = result.toLowerCase();
    if (!lower.endsWith("</usage>")) {
      return result;
    }
    const open = lower.lastIndexOf("<usage>", result.length - "</usage>".length);
    if (open === -1) {
      return result;
    }
    result = result.slice(0, open).trimEnd();
  }
}

/** The footer is one short parenthetical; anchoring the pattern to a bounded
 *  slice from the last `agentId:` keeps the regex input — and its worst
 *  case — small. The parenthetical wording varies by harness version ("use
 *  SendMessage with ..." vs "internal ID - do not mention to user. Use
 *  SendMessage ..."). */
const AGENT_CONTINUATION_FOOTER_PATTERN =
  /^agentId:\s*[A-Za-z0-9_-]+\s*\([^()]*?use\s+SendMessage\s+with\s+to:\s*['"`][^'"`]+['"`],\s*summary:\s*['"`][\s\S]*?['"`]\s+to\s+continue\s+this\s+agent\.?\)$/iu;

const AGENT_CONTINUATION_FOOTER_MAX_CHARS = 600;

function stripClaudeContinuationFooter(value: string): string {
  const trimmed = value.trimEnd();
  const start = trimmed.toLowerCase().lastIndexOf("agentid:");
  if (start === -1 || trimmed.length - start > AGENT_CONTINUATION_FOOTER_MAX_CHARS) {
    return trimmed;
  }
  return AGENT_CONTINUATION_FOOTER_PATTERN.test(trimmed.slice(start))
    ? trimmed.slice(0, start).trimEnd()
    : trimmed;
}

/** The Task tool_result for a `run_in_background` launch is an acknowledgment
 *  ("Async agent launched successfully. agentId: ..."), not the agent's
 *  output — the agent is still running at that point. */
function isClaudeAsyncAgentLaunchAcknowledgment(value: string | null): boolean {
  return value !== null && /^async agent launched successfully\b/iu.test(value);
}

function extractClaudeTextContent(content: unknown): string | null {
  const direct = asTrimmedString(content);
  if (direct) {
    return direct;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((entry) => {
      const text = asTrimmedString(entry);
      if (text) {
        return [text];
      }
      const entryRecord = asRecord(entry);
      const entryText = asTrimmedString(entryRecord?.text);
      return entryText ? [entryText] : [];
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export interface ClaudeSubagentActivitySource {
  /** Fallback identity when the activity payload carries no tool call id. */
  readonly activityId: string;
  /** The projected activity kind (e.g. "tool.updated", "tool.completed"). */
  readonly activityKind: string;
  readonly payload: UnknownRecord;
  readonly data: UnknownRecord | null;
}

/**
 * Builds a collab-agent item from a Claude Agent/Task tool activity, or null
 * when the activity is not a Claude subagent tool call. The returned shape
 * mirrors `data.item` on Codex collab activities: the spawn's tool_use id
 * doubles as the agent id, and `agentsStates` carries the lifecycle state and
 * (once terminal) the agent's final message.
 */
export function claudeSubagentActivityItem(
  input: ClaudeSubagentActivitySource,
): UnknownRecord | null {
  const toolName = asTrimmedString(input.data?.toolName);
  if (!isClaudeSubagentToolName(toolName)) {
    return null;
  }

  const toolInput = asRecord(input.data?.input);
  const toolCallId =
    asTrimmedString(input.payload.toolCallId) ??
    asTrimmedString(input.data?.itemId) ??
    input.activityId;
  const itemStatus =
    asTrimmedString(input.payload.status) ??
    claudeSubagentStatusFromActivityKind(input.activityKind);
  const resultText = extractClaudeSubagentResultText(input.data?.result);
  const notificationStatus = asTrimmedString(asRecord(input.data?.taskNotification)?.status);
  const structuredResultStatus = asTrimmedString(asRecord(input.data?.structuredResult)?.status);
  // A background launch acknowledgment is harness plumbing, not agent output:
  // the agent keeps running and its real message arrives later through the
  // task-notification completion replay (which carries data.taskNotification).
  const stateStatus =
    notificationStatus !== null
      ? claudeSubagentStateStatus(
          notificationStatus === "stopped" ? "interrupted" : notificationStatus,
        )
      : structuredResultStatus === "async_launched" || structuredResultStatus === "remote_launched"
        ? "running"
        : isClaudeAsyncAgentLaunchAcknowledgment(resultText)
          ? "running"
          : claudeSubagentStateStatus(itemStatus);
  const agentMessage = isTerminalClaudeSubagentState(stateStatus) ? resultText : null;
  const role =
    asTrimmedString(toolInput?.subagent_type) ??
    asTrimmedString(toolInput?.subagentType) ??
    asTrimmedString(toolInput?.agent_type) ??
    asTrimmedString(toolInput?.agentType);
  const nickname =
    asTrimmedString(toolInput?.agentNickname) ??
    asTrimmedString(toolInput?.agent_nickname) ??
    asTrimmedString(toolInput?.nickname) ??
    asTrimmedString(toolInput?.name) ??
    asTrimmedString(toolInput?.displayName);
  const prompt =
    asTrimmedString(toolInput?.description) ??
    asTrimmedString(toolInput?.prompt) ??
    asTrimmedString(input.payload.detail);
  // A spawn only names a model when the parent overrides one, and names it as
  // an alias ("opus"). The agent's own forwarded messages state the resolved
  // id, which is what the UI should prefer.
  const model = asTrimmedString(toolInput?.model);
  const resolvedModel = asTrimmedString(input.data?.subagentModel);
  const reasoningEffort =
    asTrimmedString(toolInput?.effort) ?? asTrimmedString(toolInput?.reasoning_effort);

  return {
    id: toolCallId,
    type: "collabAgentToolCall",
    tool: toolName,
    status: itemStatus,
    ...(prompt ? { prompt } : {}),
    ...(role ? { agentRole: role } : {}),
    ...(nickname ? { agentNickname: nickname } : {}),
    ...(model ? { model } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    receiverThreadIds: [toolCallId],
    agentsStates: {
      [toolCallId]: {
        status: stateStatus,
        ...(agentMessage ? { message: agentMessage } : { message: null }),
      },
    },
  };
}
