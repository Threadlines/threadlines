/**
 * How Antigravity's tool calls reach the timeline: bounded text, no inline
 * image data, and an MCP call made through `call_mcp_tool` shown as that
 * tool rather than as a shell command.
 *
 * `agy acp` puts whole command output, file text and screenshots on its tool
 * updates. Each update is bounded here before the ACP core reads it, so the
 * runtime events (what is stored and shown) never carry more than
 * `ANTIGRAVITY_TOOL_TEXT_LIMIT` characters per field. An edit's old and new
 * text are the exception: the core counts the edit's lines from them. Rules follow T3 Code's
 * (AntigravityProtocol.ts, commits df67c4f7f9, c4dc9ed55b, 7f928416b2):
 * a command line keeps its start (the program and its target are there),
 * output and other text keep their end, and a cut never splits a character.
 *
 * @module provider/antigravity/AntigravityToolCalls
 */
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";

/** The most characters one tool text field keeps. */
export const ANTIGRAVITY_TOOL_TEXT_LIMIT = 8_000;
/** All text kept from one tool update, across its fields. */
const UPDATE_TEXT_BUDGET = 64_000;
/** Values kept from one update, so a huge array or object can't flood it. */
const UPDATE_NODE_BUDGET = 512;
const MAX_DEPTH = 12;

const OUTPUT_CUT = "[Earlier output truncated]\n\n";
const COMMAND_CUT = "\n\n[Command truncated]";

/** Fields that hold a command line: the start says what runs. */
const COMMAND_LINE_FIELDS = new Set(["CommandLine", "command_line", "commandLine", "command"]);
/**
 * Diff text is the file's own content: the ACP core counts an edit's lines
 * from it, and a cut copy would miscount them.
 */
const FILE_TEXT_FIELDS = new Set(["oldText", "newText"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A fresh copy, so the engine can't keep the large original alive through a slice. */
const copyText = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");

/** Keeps the end of long text; a lone low surrogate at the cut is dropped. */
export function boundAntigravityText(text: string, limit = ANTIGRAVITY_TOOL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, "");
  return copyText(`${OUTPUT_CUT}${tail}`);
}

/** Keeps the start of a long command line; a lone high surrogate at the cut is dropped. */
export function boundAntigravityCommandLine(
  text: string,
  limit = ANTIGRAVITY_TOOL_TEXT_LIMIT,
): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  return copyText(`${head}${COMMAND_CUT}`);
}

interface Budget {
  nodes: number;
  text: number;
}

const isInlineImage = (record: Record<string, unknown>) =>
  record.type === "image" ||
  (typeof record.mimeType === "string" && record.mimeType.toLowerCase().startsWith("image/"));

/**
 * One JSON value with its text bounded and inline image data left out.
 * `undefined` means "drop it".
 */
function boundValue(value: unknown, budget: Budget, depth: number, field?: string): unknown {
  if (depth > MAX_DEPTH || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value)) return undefined;
    if (field !== undefined && FILE_TEXT_FIELDS.has(field)) return value;
    if (budget.text <= 0) return undefined;
    const limit = Math.min(ANTIGRAVITY_TOOL_TEXT_LIMIT, budget.text);
    const text =
      field !== undefined && COMMAND_LINE_FIELDS.has(field)
        ? boundAntigravityCommandLine(value, limit)
        : boundAntigravityText(value, limit);
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const kept: Array<unknown> = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const bounded = boundValue(entry, budget, depth + 1);
      if (bounded !== undefined) kept.push(bounded);
    }
    return kept;
  }
  if (!isRecord(value)) return value;
  const image = isInlineImage(value);
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break;
    if (image && (key === "data" || key === "blob")) continue;
    const bounded = boundValue(entry, budget, depth + 1, key);
    if (bounded !== undefined) kept[key] = bounded;
  }
  return kept;
}

/** A tool payload (`rawInput`, `rawOutput`, `_meta`) with its text bounded and images left out. */
export function boundAntigravityToolPayload(payload: unknown): unknown {
  return boundValue(payload, { nodes: UPDATE_NODE_BUDGET, text: UPDATE_TEXT_BUDGET }, 0);
}

/** A tool content entry, or `undefined` for an inline image (its bytes are the only thing in it). */
function boundContentEntry(
  entry: EffectAcpSchema.ToolCallContent,
  budget: Budget,
): EffectAcpSchema.ToolCallContent | undefined {
  if (
    entry.type === "content" &&
    (entry.content.type === "image" || entry.content.type === "audio")
  )
    return undefined;
  const bounded = boundValue(entry, budget, 0);
  return isRecord(bounded) ? (bounded as EffectAcpSchema.ToolCallContent) : undefined;
}

/**
 * Bounds one session update before the ACP core reads it: a tool call's
 * title, payloads and content. Other updates pass through.
 */
export function normalizeAntigravitySessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return notification;
  }
  const budget: Budget = { nodes: UPDATE_NODE_BUDGET, text: UPDATE_TEXT_BUDGET };
  const content = update.content?.flatMap((entry) => {
    const bounded = boundContentEntry(entry, budget);
    return bounded === undefined ? [] : [bounded];
  });
  return {
    ...notification,
    update: {
      ...update,
      ...(typeof update.title === "string" ? { title: boundAntigravityText(update.title) } : {}),
      ...(update.rawInput !== undefined
        ? { rawInput: boundAntigravityToolPayload(update.rawInput) }
        : {}),
      ...(update.rawOutput !== undefined
        ? { rawOutput: boundAntigravityToolPayload(update.rawOutput) }
        : {}),
      ...(update.content !== undefined && update.content !== null
        ? { content: content ?? [] }
        : {}),
      ...(update._meta !== undefined && update._meta !== null
        ? { _meta: (boundAntigravityToolPayload(update._meta) ?? null) as Record<string, unknown> }
        : {}),
    },
  } as EffectAcpSchema.SessionNotification;
}

/**
 * The MCP tool an Antigravity `call_mcp_tool` call runs. Antigravity reaches
 * MCP tools its context budget left out through it: an `execute` call
 * titled "MCP Tool <tool>" whose input names `ServerName`, `ToolName` and
 * `Arguments` (T3 Code 7f928416b2).
 */
export function antigravityProxiedMcpTool(rawInput: unknown):
  | {
      readonly server: string;
      readonly tool: string;
      readonly arguments?: Record<string, unknown>;
    }
  | undefined {
  if (!isRecord(rawInput)) return undefined;
  const server = typeof rawInput.ServerName === "string" ? rawInput.ServerName.trim() : "";
  const tool = typeof rawInput.ToolName === "string" ? rawInput.ToolName.trim() : "";
  if (!server || !tool) return undefined;
  return {
    server,
    tool,
    ...(isRecord(rawInput.Arguments) ? { arguments: rawInput.Arguments } : {}),
  };
}

/**
 * A tool call as the timeline should show it. An MCP call through
 * `call_mcp_tool` is an MCP tool call with its server and tool, not a
 * command (and so never holds a turn as a command would).
 */
export function normalizeAntigravityToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  const mcp = antigravityProxiedMcpTool(toolCall.data.rawInput);
  if (mcp === undefined) return toolCall;
  const { item: _item, command: _command, ...data } = toolCall.data;
  const { command: _shown, ...rest } = toolCall;
  return {
    ...rest,
    kind: "other",
    itemType: "mcp_tool_call",
    // The approval panel names a tool call by its title.
    title: mcp.tool,
    detail: `${mcp.server} · ${mcp.tool}`,
    data: {
      ...data,
      kind: "other",
      server: mcp.server,
      tool: mcp.tool,
      ...(mcp.arguments !== undefined ? { arguments: mcp.arguments } : {}),
    },
  };
}
