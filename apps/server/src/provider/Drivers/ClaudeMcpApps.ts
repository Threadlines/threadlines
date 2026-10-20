/**
 * MCP Apps for Claude sessions (docs/mcp-apps.md). Claude reports which
 * tools ship an app in `mcpServerStatus()` (each tool's `_meta.ui`, from CLIs
 * that pass it on); a tool call's own messages carry no app. This module
 * keeps a session's view of its tools' apps and turns Claude's tool results
 * into the MCP `CallToolResult` a view expects.
 */
import type { McpAppToolResult } from "@threadlines/contracts";
import { type McpToolUi, mcpToolUiFromMeta } from "@threadlines/shared/mcpApps";

/** A tool's app, with the server and tool names Claude's status gives. */
export interface ClaudeMcpToolApp {
  readonly server: string;
  readonly tool: string;
  readonly ui: McpToolUi | null;
}

/** A session's tools by Claude's tool name (`mcp__server__tool`), as last read. */
export interface ClaudeMcpAppState {
  tools: ReadonlyMap<string, ClaudeMcpToolApp>;
  /** When the tools were last read; 0 never. */
  readAtMs: number;
}

export function makeClaudeMcpAppState(): ClaudeMcpAppState {
  return { tools: new Map(), readAtMs: 0 };
}

/** How long a read of the tools stands before a tool it lacks is looked up
 *  again (a server may add tools as it runs). */
export const CLAUDE_MCP_TOOLS_STALE_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Claude's name for a server's tool: the server name with anything but
 *  letters, digits, `_` and `-` made `_`. */
export function claudeMcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/gu, "_")}__${tool}`;
}

/** A session's tools from `mcpServerStatus()`, by Claude's tool name. */
export function claudeMcpToolApps(status: unknown): ReadonlyMap<string, ClaudeMcpToolApp> {
  const tools = new Map<string, ClaudeMcpToolApp>();
  if (!Array.isArray(status)) return tools;
  for (const entry of status) {
    const server = asRecord(entry);
    if (typeof server?.name !== "string" || !Array.isArray(server.tools)) continue;
    for (const candidate of server.tools) {
      const tool = asRecord(candidate);
      if (typeof tool?.name !== "string") continue;
      tools.set(claudeMcpToolName(server.name, tool.name), {
        server: server.name,
        tool: tool.name,
        ui: mcpToolUiFromMeta(tool._meta),
      });
    }
  }
  return tools;
}

/**
 * A tool's result as an MCP `CallToolResult`. Claude gives a tool's content
 * as the model saw it: content blocks, or one string (the structured content
 * as JSON, when the tool returned some). A string becomes one text block.
 */
export function claudeMcpToolResult(input: {
  readonly content: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly meta?: unknown;
}): McpAppToolResult {
  const content =
    typeof input.content === "string"
      ? [{ type: "text", text: input.content }]
      : Array.isArray(input.content)
        ? input.content.filter((block) => asRecord(block) !== undefined)
        : [];
  const structuredContent = asRecord(input.structuredContent);
  const meta = asRecord(input.meta);
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(input.isError ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

/** The result of Claude's `mcp_call` control request, as a `CallToolResult`. */
export function claudeMcpCallResult(response: unknown): McpAppToolResult {
  const record = asRecord(asRecord(response)?.response) ?? asRecord(response) ?? {};
  return claudeMcpToolResult({
    content: record.content,
    structuredContent: record.structuredContent,
    isError: record.isError === true,
    meta: record._meta,
  });
}
