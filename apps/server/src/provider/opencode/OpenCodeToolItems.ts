/**
 * OpenCodeToolItems — OpenCode 2 tool calls as Threadlines tool items.
 *
 * The chat renders a tool row from its item type, title and detail, and reads
 * a few `data` fields: the command and exit code of a shell call, the
 * `changes` of a file edit (also the turn's diff evidence), and the server,
 * tool and result of an MCP call. Generic calls are titled the way the chat
 * already words them ("Read file", "Search", "Web fetch").
 *
 * Tool names are OpenCode 2's (`shell`, not 1.x's `bash`; `subagent`, not
 * `task`), and input fields are 2.x's (`path`, not `filePath`).
 *
 * @module provider/opencode/OpenCodeToolItems
 */
import type { CanonicalItemType } from "@threadlines/contracts";

import { BROWSER_MCP_SERVER_NAME } from "../../mcp/McpHttpServer.ts";
import { ROOM_MCP_SERVER_NAME } from "../../mcp/roomToolAccess.ts";

const DETAIL_MAX_CHARS = 400;
const OUTPUT_MAX_CHARS = 20_000;

export type OpenCodeToolKind =
  | "shell"
  | "edit"
  | "read"
  | "search"
  | "webfetch"
  | "websearch"
  | "question"
  | "subagent"
  | "skill"
  | "mcp"
  | "other";

export interface OpenCodeToolIdentity {
  readonly kind: OpenCodeToolKind;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  /** For MCP calls: the server the chat should name, and the tool on it. */
  readonly mcp?: { readonly server: string; readonly tool: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Threadlines' own tool servers are registered per thread under
 * `threadlines_b_<key>` / `threadlines_r_<key>`; the chat knows them by their
 * stable names, so that is what it is told.
 */
function threadlinesMcpTool(name: string): OpenCodeToolIdentity["mcp"] | undefined {
  const match = /^threadlines_([br])_[0-9a-f]+_(.+)$/u.exec(name);
  if (!match) return undefined;
  return {
    server: match[1] === "b" ? BROWSER_MCP_SERVER_NAME : ROOM_MCP_SERVER_NAME,
    tool: match[2]!,
  };
}

/**
 * Classifies a tool by its OpenCode name. `mcpServers` are the tool servers
 * registered for the session's directory; an MCP tool is `<server>_<tool>`,
 * and server names can contain `_`, so the longest registered prefix wins.
 */
export function identifyOpenCodeTool(
  name: string,
  mcpServers: ReadonlyArray<string> = [],
): OpenCodeToolIdentity {
  switch (name) {
    case "shell":
      return { kind: "shell", itemType: "command_execution", title: "Command" };
    case "edit":
    case "write":
    case "patch":
      return { kind: "edit", itemType: "file_change", title: "File change" };
    case "read":
      return { kind: "read", itemType: "dynamic_tool_call", title: "Read file" };
    case "glob":
    case "grep":
      return { kind: "search", itemType: "dynamic_tool_call", title: "Search" };
    case "webfetch":
      return { kind: "webfetch", itemType: "dynamic_tool_call", title: "Web fetch" };
    case "websearch":
      return { kind: "websearch", itemType: "web_search", title: "Web search" };
    case "question":
      return { kind: "question", itemType: "dynamic_tool_call", title: "Question" };
    case "subagent":
      return { kind: "subagent", itemType: "collab_agent_tool_call", title: "Subagent task" };
    case "skill":
      return { kind: "skill", itemType: "dynamic_tool_call", title: "Skill" };
  }
  const threadlines = threadlinesMcpTool(name);
  if (threadlines) {
    return { kind: "mcp", itemType: "mcp_tool_call", title: "MCP tool call", mcp: threadlines };
  }
  const server = mcpServers
    .filter((candidate) => name.startsWith(`${candidate}_`))
    .toSorted((left, right) => right.length - left.length)[0];
  if (server) {
    return {
      kind: "mcp",
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      mcp: { server, tool: name.slice(server.length + 1) },
    };
  }
  return { kind: "other", itemType: "dynamic_tool_call", title: name };
}

/** The one-line detail the chat shows under the tool row. */
export function openCodeToolDetail(
  identity: OpenCodeToolIdentity,
  input: unknown,
): string | undefined {
  const detail = (() => {
    switch (identity.kind) {
      case "shell":
        return stringField(input, "command");
      case "edit":
      case "read":
        return stringField(input, "path");
      case "search": {
        const pattern = stringField(input, "pattern");
        const where = stringField(input, "path");
        return pattern && where ? `${pattern} in ${where}` : pattern;
      }
      case "webfetch":
        return stringField(input, "url");
      case "websearch":
        return stringField(input, "query");
      case "question": {
        const questions = isRecord(input) ? input.questions : undefined;
        const first = Array.isArray(questions) ? questions[0] : undefined;
        return stringField(first, "question");
      }
      case "subagent": {
        const agent = stringField(input, "agent");
        const description = stringField(input, "description") ?? stringField(input, "prompt");
        return agent && description ? `${agent}: ${description}` : description;
      }
      case "skill":
        return stringField(input, "id");
      case "mcp": {
        const args = isRecord(input) ? JSON.stringify(input) : undefined;
        const call = `${identity.mcp!.server} · ${identity.mcp!.tool}`;
        return args && args !== "{}" ? `${call}: ${args}` : call;
      }
      case "other":
        return isRecord(input) ? JSON.stringify(input) : undefined;
    }
  })();
  return detail ? truncate(detail, DETAIL_MAX_CHARS) : undefined;
}

/** Text of a tool result's content blocks. */
export function openCodeToolOutputText(content: ReadonlyArray<unknown> | undefined): string {
  return (content ?? [])
    .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function changeKind(status: unknown): "add" | "update" | "delete" {
  switch (status) {
    case "added":
    case "add":
      return "add";
    case "deleted":
    case "delete":
      return "delete";
    default:
      return "update";
  }
}

/**
 * Paths stay relative to the session's directory, as OpenCode reports them
 * and as Threadlines' own checkpoints list them. The session directory is
 * realpath'd, which a symlinked project path (macOS /tmp) does not match, so
 * an absolute path would read as a different file.
 */
function relativeToDirectory(directory: string, file: string): string {
  const root = directory.replace(/[\\/]+$/u, "");
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`)
    ? file.slice(root.length + 1)
    : file;
}

/** OpenCode wraps a subagent's report in `<subagent ...>…</subagent>`; the chat wants the report. */
export function openCodeSubagentReport(text: string): string {
  const match = /<subagent\b[^>]*>([\s\S]*?)<\/subagent>/u.exec(text);
  return (match ? match[1]! : text).trim();
}

/**
 * `edit` and `patch` report exact per-file patches in `metadata.files`; these
 * become the item's `changes`. A successful `write` reports none (its preview
 * rides on the approval request, which the adapter passes in when it saw
 * one), so a write without it counts its own lines: exact for a new file, an
 * overcount when it replaces one.
 */
export function openCodeFileChanges(input: {
  readonly directory: string;
  readonly toolInput: unknown;
  readonly metadata: unknown;
}): ReadonlyArray<{
  readonly path: string;
  readonly kind: "add" | "update" | "delete";
  readonly diff?: string;
  readonly additions?: number;
  readonly deletions?: number;
}> {
  const files = isRecord(input.metadata) ? input.metadata.files : undefined;
  if (Array.isArray(files) && files.length > 0) {
    return files.flatMap((file) => {
      const path = stringField(file, "file") ?? stringField(file, "path");
      if (!path || !isRecord(file)) return [];
      return [
        {
          path: relativeToDirectory(input.directory, path),
          kind: changeKind(file.status),
          ...(typeof file.patch === "string" ? { diff: file.patch } : {}),
          ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
          ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
        },
      ];
    });
  }
  const path = stringField(input.toolInput, "path");
  if (!path) return [];
  const content = isRecord(input.toolInput) ? input.toolInput.content : undefined;
  if (typeof content === "string") {
    const lines = content.length === 0 ? 0 : content.replace(/\n$/u, "").split("\n").length;
    return [
      {
        path: relativeToDirectory(input.directory, path),
        kind: "add",
        additions: lines,
        deletions: 0,
      },
    ];
  }
  return [{ path: relativeToDirectory(input.directory, path), kind: "update" }];
}

/** `data` for a tool item, by kind. */
export function openCodeToolData(input: {
  readonly name: string;
  readonly identity: OpenCodeToolIdentity;
  readonly directory: string;
  readonly toolInput: unknown;
  readonly metadata?: unknown;
  readonly content?: ReadonlyArray<unknown>;
  readonly failed?: boolean;
  /** The call has finished; only then do its file changes count. */
  readonly final?: boolean;
}): Record<string, unknown> {
  const base = {
    toolName: input.name,
    ...(input.toolInput !== undefined ? { input: input.toolInput } : {}),
  };
  switch (input.identity.kind) {
    case "shell": {
      const exit = isRecord(input.metadata) ? input.metadata.exit : undefined;
      return {
        ...base,
        item: {
          command: stringField(input.toolInput, "command"),
          ...(typeof exit === "number" ? { exitCode: exit } : {}),
          ...(input.failed ? { status: "failed" } : {}),
        },
      };
    }
    case "edit":
      return !input.final || input.failed
        ? base
        : {
            ...base,
            changes: openCodeFileChanges({
              directory: input.directory,
              toolInput: input.toolInput,
              metadata: input.metadata,
            }),
          };
    case "mcp":
      return {
        ...base,
        server: input.identity.mcp!.server,
        tool: input.identity.mcp!.tool,
        arguments: input.toolInput,
        ...(input.content !== undefined ? { result: { content: input.content } } : {}),
      };
    default: {
      const output = openCodeToolOutputText(input.content);
      return output ? { ...base, result: truncate(output, OUTPUT_MAX_CHARS) } : base;
    }
  }
}

/** Shell output for the command row, capped so a huge log never floods the event log. */
export function openCodeCommandOutput(content: ReadonlyArray<unknown> | undefined): string {
  return truncate(openCodeToolOutputText(content), OUTPUT_MAX_CHARS);
}
