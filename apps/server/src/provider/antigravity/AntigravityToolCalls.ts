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

import { type AcpToolCallState, makeToolCallState } from "../acp/AcpRuntimeModel.ts";

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
  // A command line is budgeted before any other field, so a large field
  // beside it can never leave it just the cut marker. The keys keep their order.
  const entries = Object.entries(value);
  const bounded = new Map<string, unknown>();
  for (const [key, entry] of [
    ...entries.filter(([key]) => COMMAND_LINE_FIELDS.has(key)),
    ...entries.filter(([key]) => !COMMAND_LINE_FIELDS.has(key)),
  ]) {
    if (budget.nodes <= 0) break;
    if (image && (key === "data" || key === "blob")) continue;
    bounded.set(key, boundValue(entry, budget, depth + 1, key));
  }
  const kept: Record<string, unknown> = {};
  for (const [key] of entries) {
    const entry = bounded.get(key);
    if (entry !== undefined) kept[key] = entry;
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
  if (entry.type === "terminal") {
    const terminalId = boundAntigravityCommandLine(entry.terminalId, 256);
    budget.text -= terminalId.length;
    return { type: "terminal", terminalId };
  }
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
      // A `data:` link is the bytes themselves, like an image.
      if (/^data:/iu.test(block.uri)) return undefined;
      bounded = {
        type: "content",
        content: {
          type: "resource_link",
          uri: boundField(block.uri, budget, "command"),
          name: boundField(block.name, budget),
          ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
          ...(typeof block.title === "string" ? { title: boundField(block.title, budget) } : {}),
          ...(typeof block.size === "number" ? { size: block.size } : {}),
        },
      };
      break;
    case "resource": {
      const resource = block.resource;
      if (!("text" in resource) || /^data:/iu.test(resource.uri)) return undefined;
      bounded = {
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: boundField(resource.uri, budget, "command"),
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
  // What says what runs (the input) is budgeted first, then what it printed.
  const budget = { text: UPDATE_TEXT_BUDGET };
  const rawInput =
    update.rawInput !== undefined
      ? boundAntigravityToolPayload(update.rawInput, budget)
      : undefined;
  const rawOutput =
    update.rawOutput !== undefined
      ? boundAntigravityToolPayload(update.rawOutput, budget)
      : undefined;
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
      ...(update.rawInput !== undefined ? { rawInput } : {}),
      ...(update.rawOutput !== undefined ? { rawOutput } : {}),
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

/** Server and tool names kept, at most this long. */
const NAME_LIMIT = 256;

/**
 * The MCP tool this update positively says it runs through `call_mcp_tool`,
 * read from the update exactly as the agent sent it (before any bounding):
 * an `execute` call titled exactly "MCP Tool <ToolName>", whose input holds
 * exactly `ServerName` and `ToolName` (non-empty text) and `Arguments` (an
 * object), with no command or edit about it (agy 1.5.12, T3 Code
 * 7f928416b2). Anything else is `undefined` and stays what the agent
 * called it.
 */
export function antigravityProxiedMcpTool(
  update: AntigravityToolCallUpdate,
): AntigravityProxiedMcpTool | undefined {
  const input = update.rawInput;
  if (!isRecord(input) || commandOrEditEvidence(update)) return undefined;
  if (update.kind !== "execute") return undefined;
  const keys = Object.keys(input);
  if (keys.length !== WRAPPER_INPUT_KEYS.size || !keys.every((key) => WRAPPER_INPUT_KEYS.has(key)))
    return undefined;
  const { ServerName: server, ToolName: tool, Arguments: args } = input;
  if (typeof server !== "string" || typeof tool !== "string" || !server || !tool) return undefined;
  if (!isRecord(args)) return undefined;
  if (update.title !== `MCP Tool ${tool}`) return undefined;
  return { server, tool, arguments: args };
}

/**
 * What an approval for the call shows: the server and the tool first, then
 * its arguments, so a cut short loses the arguments' tail, never the target.
 */
export function antigravityMcpToolLabel(mcp: AntigravityProxiedMcpTool): string {
  const args = mcp.arguments === undefined ? "" : ` ${JSON.stringify(mcp.arguments)}`;
  return boundAntigravityCommandLine(`MCP tool ${mcp.server} · ${mcp.tool}${args}`);
}

/** The MCP tool a call was already shown as, from the fields `asMcpToolCall` set. */
function shownMcpTool(toolCall: AcpToolCallState): { server: string; tool: string } | undefined {
  const { server, tool } = toolCall.data;
  return typeof server === "string" && typeof tool === "string" ? { server, tool } : undefined;
}

/**
 * The call as that MCP tool. Its arguments come from the merged, bounded
 * input (the newest restatement of them), never from the unbounded report.
 */
function asMcpToolCall(
  toolCall: AcpToolCallState,
  names: { readonly server: string; readonly tool: string },
): AcpToolCallState {
  const { item: _item, command: _command, ...data } = toolCall.data;
  const { command: _shown, ...rest } = toolCall;
  const input = isRecord(data.rawInput) ? data.rawInput : undefined;
  const mcp: AntigravityProxiedMcpTool = {
    server: boundAntigravityCommandLine(names.server, NAME_LIMIT),
    tool: boundAntigravityCommandLine(names.tool, NAME_LIMIT),
    ...(isRecord(input?.Arguments) ? { arguments: input.Arguments } : {}),
  };
  const { arguments: _old, ...withoutArguments } = data;
  return {
    ...rest,
    kind: "other",
    itemType: "mcp_tool_call",
    // The approval panel names a tool call by its title.
    title: mcp.tool,
    detail: antigravityMcpToolLabel(mcp),
    data: {
      ...withoutArguments,
      kind: "other",
      server: mcp.server,
      tool: mcp.tool,
      ...(mcp.arguments !== undefined ? { arguments: mcp.arguments } : {}),
    },
  };
}

/**
 * The merged call as the core would show it without the MCP look an earlier
 * update gave it: rebuilt from its merged data, so neither the MCP title nor
 * its label stays. Its kind is the report's, else an edit when a diff says
 * it changed a file (so the diff still counts as file-change evidence), else
 * the `execute` a wrapper was.
 */
function withoutMcpTool(
  toolCall: AcpToolCallState,
  update: AntigravityToolCallUpdate,
): AcpToolCallState {
  const { server: _server, tool: _tool, arguments: _args, item: _item, ...data } = toolCall.data;
  const diff =
    (update.content ?? []).some((entry) => entry.type === "diff") ||
    (Array.isArray(data.content) &&
      data.content.some((entry) => isRecord(entry) && entry.type === "diff"));
  const kind = update.kind ?? (diff ? "edit" : "execute");
  const rebuilt = makeToolCallState({
    toolCallId: toolCall.toolCallId,
    title: update.title,
    kind: kind as EffectAcpSchema.ToolKind,
    ...(toolCall.status !== undefined
      ? { status: toolCall.status === "inProgress" ? "in_progress" : toolCall.status }
      : {}),
    rawInput: data.rawInput,
    rawOutput: data.rawOutput,
    content: data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent> | undefined,
    locations: data.locations as ReadonlyArray<EffectAcpSchema.ToolCallLocation> | undefined,
  });
  const { itemType: _itemType, ...rest } = toolCall;
  return rebuilt ?? { ...rest, kind, data: { ...data, kind } };
}

/**
 * A tool call as the timeline should show it, given the update that just
 * arrived, as the agent sent it. A call the update positively shows to be
 * `call_mcp_tool` is that MCP tool, with its server and tool, not a command;
 * a later update with no command or edit about it keeps it so, with the
 * newest arguments. Anything else stays, or goes back to, what the agent
 * described.
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
    (update.title !== undefined &&
      update.title !== null &&
      update.title !== `MCP Tool ${shown.tool}`) ||
    (restated !== undefined &&
      (!Object.keys(restated).every((key) => WRAPPER_INPUT_KEYS.has(key)) ||
        restated.ServerName !== shown.server ||
        restated.ToolName !== shown.tool ||
        (restated.Arguments !== undefined && !isRecord(restated.Arguments))));
  return conflicting ? withoutMcpTool(toolCall, update) : asMcpToolCall(toolCall, shown);
}
