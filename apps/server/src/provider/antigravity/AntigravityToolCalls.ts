/**
 * How Antigravity's tool calls reach the timeline: bounded text, no inline
 * image data, and an MCP call made through `call_mcp_tool` shown as that
 * tool rather than as a shell command.
 *
 * `agy acp` puts whole command output, file text and screenshots on its tool
 * updates. Each update is bounded here before the ACP core reads it, so the
 * runtime events (what is stored and shown) never carry more than
 * `ANTIGRAVITY_TOOL_TEXT_LIMIT` characters per field, marker included. An
 * edit's `diff` block is the exception: the core counts the edit's lines
 * from its old and new text, so they stay whole. Content blocks keep the
 * shape ACP gives them, so the core can read every field it expects.
 * Rules follow T3 Code's (AntigravityProtocol.ts, commits df67c4f7f9,
 * c4dc9ed55b, 7f928416b2): a command line keeps its start (the program and
 * its target are there), output and other text keep their end, and a cut
 * never splits a character.
 *
 * @module provider/antigravity/AntigravityToolCalls
 */
import * as Schema from "effect/Schema";
import * as EffectAcpSchema from "effect-acp/schema";

import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";

/** The most characters one tool text field keeps, its cut marker included. */
export const ANTIGRAVITY_TOOL_TEXT_LIMIT = 8_000;
/** All text kept from one tool update, across its fields. */
const UPDATE_TEXT_BUDGET = 64_000;
/** Values kept from one payload, so a huge array or object can't flood it. */
const PAYLOAD_NODE_BUDGET = 512;
const MAX_DEPTH = 12;

const OUTPUT_CUT = "[Earlier output truncated]\n\n";
const COMMAND_CUT = "\n\n[Command truncated]";

/** Fields that hold a command line: the start says what runs. The core reads the same ones. */
const COMMAND_LINE_FIELDS = new Set([
  "CommandLine",
  "command_line",
  "commandLine",
  "command",
  "cmd",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A fresh copy, so the engine can't keep the large original alive through a slice. */
const copyText = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");

/** Keeps the end of long text, within `limit` with its marker; never half a character. */
export function boundAntigravityText(text: string, limit = ANTIGRAVITY_TOOL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - OUTPUT_CUT.length);
  const tail = room === 0 ? "" : text.slice(-room).replace(/^[\uDC00-\uDFFF]/u, "");
  return copyText(`${OUTPUT_CUT}${tail}`);
}

/** Keeps the start of a long command line, within `limit` with its marker; never half a character. */
export function boundAntigravityCommandLine(
  text: string,
  limit = ANTIGRAVITY_TOOL_TEXT_LIMIT,
): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - COMMAND_CUT.length);
  const head = text.slice(0, room).replace(/[\uD800-\uDBFF]$/u, "");
  return copyText(`${head}${COMMAND_CUT}`);
}

interface Budget {
  nodes: number;
  text: number;
}

/** One text field within the update's budget; a field past it keeps only its marker. */
function boundField(value: string, budget: { text: number }, field?: string): string {
  const limit = Math.min(ANTIGRAVITY_TOOL_TEXT_LIMIT, Math.max(0, budget.text));
  const text =
    field !== undefined && COMMAND_LINE_FIELDS.has(field)
      ? boundAntigravityCommandLine(value, limit)
      : boundAntigravityText(value, limit);
  budget.text -= text.length;
  return text;
}

const isInlineImage = (record: Record<string, unknown>) =>
  record.type === "image" ||
  (typeof record.mimeType === "string" && record.mimeType.toLowerCase().startsWith("image/"));

/**
 * A free-form payload value (`rawInput`, `rawOutput`, `_meta`: any JSON to
 * ACP) with its text bounded and inline image data left out. `undefined`
 * means "drop it".
 */
function boundValue(value: unknown, budget: Budget, depth: number, field?: string): unknown {
  if (depth > MAX_DEPTH || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value)) return undefined;
    return boundField(value, budget, field);
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
export function boundAntigravityToolPayload(
  payload: unknown,
  budget: { text: number } = { text: UPDATE_TEXT_BUDGET },
): unknown {
  const nodes: Budget = { nodes: PAYLOAD_NODE_BUDGET, text: budget.text };
  const bounded = boundValue(payload, nodes, 0);
  budget.text = nodes.text;
  return bounded;
}

const isToolCallContent = Schema.is(EffectAcpSchema.ToolCallContent);

/**
 * One tool content block, bounded field by field in its own shape, or
 * `undefined` for a block that is only bytes (an image, audio, a binary
 * resource). A diff stays whole. A block this can't rebuild as valid ACP
 * content is left as it came.
 */
function boundContentEntry(
  entry: EffectAcpSchema.ToolCallContent,
  budget: { text: number },
): EffectAcpSchema.ToolCallContent | undefined {
  if (entry.type !== "content") return entry;
  const block = entry.content;
  let bounded: EffectAcpSchema.ToolCallContent;
  switch (block.type) {
    case "image":
    case "audio":
      return undefined;
    case "text":
      bounded = {
        type: "content",
        content: { type: "text", text: boundField(block.text, budget) },
      };
      break;
    case "resource_link":
      bounded = {
        type: "content",
        content: {
          type: "resource_link",
          uri: block.uri,
          name: boundField(block.name, budget),
          ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
          ...(typeof block.title === "string" ? { title: boundField(block.title, budget) } : {}),
          ...(typeof block.size === "number" ? { size: block.size } : {}),
        },
      };
      break;
    case "resource": {
      const resource = block.resource;
      if (!("text" in resource)) return undefined;
      bounded = {
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: resource.uri,
            text: boundField(resource.text, budget),
            ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
          },
        },
      };
      break;
    }
    default:
      return entry;
  }
  return isToolCallContent(bounded) ? bounded : entry;
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
  const budget = { text: UPDATE_TEXT_BUDGET };
  const content = update.content?.flatMap((entry) => {
    const bounded = boundContentEntry(entry, budget);
    return bounded === undefined ? [] : [bounded];
  });
  const meta =
    update._meta !== undefined && update._meta !== null
      ? boundAntigravityToolPayload(update._meta, budget)
      : undefined;
  return {
    ...notification,
    update: {
      ...update,
      ...(typeof update.title === "string" ? { title: boundAntigravityText(update.title) } : {}),
      ...(update.rawInput !== undefined
        ? { rawInput: boundAntigravityToolPayload(update.rawInput, budget) }
        : {}),
      ...(update.rawOutput !== undefined
        ? { rawOutput: boundAntigravityToolPayload(update.rawOutput, budget) }
        : {}),
      ...(update.content !== undefined && update.content !== null
        ? { content: content ?? [] }
        : {}),
      ...(update._meta !== undefined && update._meta !== null
        ? { _meta: isRecord(meta) ? meta : null }
        : {}),
    },
  } as EffectAcpSchema.SessionNotification;
}

// ── MCP tools reached through `call_mcp_tool` ────────────────────────

/** An MCP tool call through `call_mcp_tool`, as its input names it. */
export interface AntigravityProxiedMcpTool {
  readonly server: string;
  readonly tool: string;
  readonly arguments?: Record<string, unknown>;
}

/** The fields of a tool call update the wrapper check reads. */
export interface AntigravityToolCallUpdate {
  readonly title?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly rawInput?: unknown;
  readonly content?: ReadonlyArray<{ readonly type: string }> | null | undefined;
  readonly locations?: ReadonlyArray<unknown> | null | undefined;
}

/** The input of a `call_mcp_tool` call holds these and nothing else. */
const WRAPPER_INPUT_KEYS = new Set(["ServerName", "ToolName", "Arguments"]);

/** A sign that the call runs a command or changes a file: never an MCP wrapper then. */
function commandOrEditEvidence(update: AntigravityToolCallUpdate): boolean {
  if (update.kind === "edit" || update.kind === "delete" || update.kind === "move") return true;
  if (update.content?.some((entry) => entry.type === "diff" || entry.type === "terminal"))
    return true;
  if ((update.locations?.length ?? 0) > 0) return true;
  return (
    isRecord(update.rawInput) &&
    Object.keys(update.rawInput).some((key) => COMMAND_LINE_FIELDS.has(key))
  );
}

/**
 * The MCP tool this update positively says it runs through `call_mcp_tool`:
 * an `execute` call titled "MCP Tool <ToolName>" whose input is exactly
 * `ServerName`, `ToolName` and optional object `Arguments` (agy 1.5.12, T3
 * Code 7f928416b2), with no command or edit about it. Anything else is
 * `undefined` and stays what the agent called it.
 */
export function antigravityProxiedMcpTool(
  update: AntigravityToolCallUpdate,
): AntigravityProxiedMcpTool | undefined {
  const input = update.rawInput;
  if (!isRecord(input) || commandOrEditEvidence(update)) return undefined;
  if (update.kind !== "execute") return undefined;
  if (!Object.keys(input).every((key) => WRAPPER_INPUT_KEYS.has(key))) return undefined;
  const server = typeof input.ServerName === "string" ? input.ServerName.trim() : "";
  const tool = typeof input.ToolName === "string" ? input.ToolName.trim() : "";
  if (!server || !tool) return undefined;
  if (input.Arguments !== undefined && !isRecord(input.Arguments)) return undefined;
  if (update.title?.trim() !== `MCP Tool ${tool}`) return undefined;
  return { server, tool, ...(isRecord(input.Arguments) ? { arguments: input.Arguments } : {}) };
}

/** What an approval for the call shows: the server, the tool and its arguments. */
export function antigravityMcpToolLabel(mcp: AntigravityProxiedMcpTool): string {
  const args = mcp.arguments === undefined ? "" : ` ${JSON.stringify(mcp.arguments)}`;
  return boundAntigravityCommandLine(`MCP tool ${mcp.server} · ${mcp.tool}${args}`);
}

/** The MCP tool a call was already shown as, from the fields `asMcpToolCall` set. */
function shownMcpTool(toolCall: AcpToolCallState): AntigravityProxiedMcpTool | undefined {
  const { server, tool, arguments: args } = toolCall.data;
  if (typeof server !== "string" || typeof tool !== "string") return undefined;
  return { server, tool, ...(isRecord(args) ? { arguments: args } : {}) };
}

function asMcpToolCall(toolCall: AcpToolCallState, mcp: AntigravityProxiedMcpTool) {
  const { item: _item, command: _command, ...data } = toolCall.data;
  const { command: _shown, ...rest } = toolCall;
  return {
    ...rest,
    kind: "other",
    itemType: "mcp_tool_call",
    // The approval panel names a tool call by its title.
    title: mcp.tool,
    detail: antigravityMcpToolLabel(mcp),
    data: {
      ...data,
      kind: "other",
      server: mcp.server,
      tool: mcp.tool,
      ...(mcp.arguments !== undefined ? { arguments: mcp.arguments } : {}),
    },
  } satisfies AcpToolCallState;
}

/**
 * The merged call without the MCP fields an earlier update gave it, back to
 * the kind the agent gives it (a wrapper was an `execute` call).
 */
function withoutMcpTool(toolCall: AcpToolCallState, kind: string): AcpToolCallState {
  const { server: _server, tool: _tool, arguments: _args, ...data } = toolCall.data;
  const { itemType: _itemType, ...rest } = toolCall;
  return { ...rest, kind, data: { ...data, kind } };
}

/**
 * A tool call as the timeline should show it, given the update that just
 * arrived. A call the update positively shows to be `call_mcp_tool` is that
 * MCP tool, with its server and tool, not a command; a later update with no
 * command or edit about it keeps it so. Anything else stays as the agent
 * described it.
 */
export function normalizeAntigravityToolCall(
  toolCall: AcpToolCallState,
  update: AntigravityToolCallUpdate,
): AcpToolCallState {
  const named = antigravityProxiedMcpTool(update);
  if (named !== undefined) return asMcpToolCall(toolCall, named);
  const shown = shownMcpTool(toolCall);
  if (shown === undefined) return toolCall;
  const restated = isRecord(update.rawInput) ? update.rawInput : undefined;
  const conflicting =
    commandOrEditEvidence(update) ||
    (update.kind !== undefined && update.kind !== null && update.kind !== "execute") ||
    (restated !== undefined &&
      (!Object.keys(restated).every((key) => WRAPPER_INPUT_KEYS.has(key)) ||
        restated.ServerName !== shown.server ||
        restated.ToolName !== shown.tool));
  return conflicting
    ? withoutMcpTool(toolCall, update.kind ?? "execute")
    : asMcpToolCall(toolCall, shown);
}
