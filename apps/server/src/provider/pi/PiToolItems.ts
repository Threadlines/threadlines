/**
 * PiToolItems — Pi tool calls as Threadlines tool items.
 *
 * The chat renders a tool row from its item type, title and detail, and reads
 * a few `data` fields: the command and exit code of a shell call, the
 * `changes` of a file edit (also the turn's diff evidence), and the server,
 * tool and result of an MCP call.
 *
 * Pi's built-in tools are `read`, `bash` (`powershell` on Windows), `edit`,
 * `write`, `grep`, `find` and `ls`, plus `codemode` and `tool_search` when
 * turned on. MCP tools, Threadlines' own included, are `mcp__<server>__<tool>`.
 *
 * @module provider/pi/PiToolItems
 */
import type { CanonicalItemType } from "@threadlines/contracts";

const DETAIL_MAX_CHARS = 400;
const OUTPUT_MAX_CHARS = 20_000;

export type PiToolKind =
  | "shell"
  | "edit"
  | "read"
  | "search"
  | "list"
  | "codemode"
  | "toolSearch"
  | "mcp"
  | "other";

export interface PiToolIdentity {
  readonly kind: PiToolKind;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly mcp?: { readonly server: string; readonly tool: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function identifyPiTool(name: string): PiToolIdentity {
  switch (name) {
    case "bash":
    case "powershell":
      return { kind: "shell", itemType: "command_execution", title: "Command" };
    case "edit":
    case "write":
      return { kind: "edit", itemType: "file_change", title: "File change" };
    case "read":
      return { kind: "read", itemType: "dynamic_tool_call", title: "Read file" };
    case "grep":
    case "find":
      return { kind: "search", itemType: "dynamic_tool_call", title: "Search" };
    case "ls":
      return { kind: "list", itemType: "dynamic_tool_call", title: "List files" };
    case "codemode":
      return { kind: "codemode", itemType: "dynamic_tool_call", title: "Script" };
    case "tool_search":
      return { kind: "toolSearch", itemType: "dynamic_tool_call", title: "Tool search" };
  }
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (mcp) {
    return {
      kind: "mcp",
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      mcp: { server: mcp[1]!, tool: mcp[2]! },
    };
  }
  return { kind: "other", itemType: "dynamic_tool_call", title: name };
}

/** The one-line detail the chat shows under the tool row. */
export function piToolDetail(identity: PiToolIdentity, args: unknown): string | undefined {
  const detail = (() => {
    switch (identity.kind) {
      case "shell":
        return stringField(args, "command");
      case "edit":
      case "read":
        return stringField(args, "path");
      case "search": {
        const pattern = stringField(args, "pattern");
        const where = stringField(args, "path");
        return pattern && where ? `${pattern} in ${where}` : (pattern ?? where);
      }
      case "list":
        return stringField(args, "path") ?? ".";
      case "codemode":
        return stringField(args, "code")?.split("\n")[0];
      case "toolSearch":
        return stringField(args, "query");
      case "mcp": {
        const call = `${identity.mcp!.server} · ${identity.mcp!.tool}`;
        const json = isRecord(args) ? JSON.stringify(args) : undefined;
        return json && json !== "{}" ? `${call}: ${json}` : call;
      }
      case "other":
        return isRecord(args) ? JSON.stringify(args) : undefined;
    }
  })();
  return detail ? truncate(detail, DETAIL_MAX_CHARS) : undefined;
}

/** Text of a tool result's content blocks. */
export function piToolOutputText(result: unknown): string {
  const content = isRecord(result) ? result.content : undefined;
  return (Array.isArray(content) ? content : [])
    .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/** Added and removed lines of a unified diff, headers excluded. */
export function countPatchLines(patch: string): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Paths relative to the session's folder, as Threadlines' checkpoints list
 * them; an absolute path inside it would read as a different file.
 */
function relativeToDirectory(directory: string, file: string): string {
  const root = directory.replace(/[\\/]+$/u, "");
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`)
    ? file.slice(root.length + 1)
    : file;
}

export interface PiFileChange {
  readonly path: string;
  readonly kind: "add" | "update";
  readonly diff?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

/**
 * `edit` reports an exact unified patch in `details.patch`. `write` reports
 * none, so it counts its own lines: exact for a new file, an overcount when
 * it replaces one.
 */
export function piFileChanges(input: {
  readonly directory: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
}): ReadonlyArray<PiFileChange> {
  const path = stringField(input.args, "path");
  if (!path) return [];
  const relative = relativeToDirectory(input.directory, path);
  const details = isRecord(input.result) ? input.result.details : undefined;
  const patch = isRecord(details) && typeof details.patch === "string" ? details.patch : undefined;
  if (input.toolName === "edit") {
    return patch
      ? [{ path: relative, kind: "update", diff: patch, ...countPatchLines(patch) }]
      : [{ path: relative, kind: "update" }];
  }
  const content = isRecord(input.args) ? input.args.content : undefined;
  if (typeof content === "string") {
    const lines = content.length === 0 ? 0 : content.replace(/\n$/u, "").split("\n").length;
    return [{ path: relative, kind: "add", additions: lines, deletions: 0 }];
  }
  return [{ path: relative, kind: "update" }];
}

/** `data` for a tool item, by kind. */
export function piToolData(input: {
  readonly name: string;
  readonly identity: PiToolIdentity;
  readonly directory: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly failed?: boolean;
  /** The call has finished; only then do its file changes count. */
  readonly final?: boolean;
}): Record<string, unknown> {
  const base = { toolName: input.name, ...(input.args !== undefined ? { input: input.args } : {}) };
  switch (input.identity.kind) {
    case "shell": {
      const structured = isRecord(input.result) ? input.result.structuredContent : undefined;
      const exitCode = isRecord(structured) ? structured.exit_code : undefined;
      return {
        ...base,
        item: {
          command: stringField(input.args, "command"),
          ...(typeof exitCode === "number" ? { exitCode } : {}),
          ...(input.failed ? { status: "failed" } : {}),
        },
      };
    }
    case "edit":
      return !input.final || input.failed
        ? base
        : {
            ...base,
            changes: piFileChanges({
              directory: input.directory,
              toolName: input.name,
              args: input.args,
              result: input.result,
            }),
          };
    case "mcp": {
      const content = isRecord(input.result) ? input.result.content : undefined;
      return {
        ...base,
        server: input.identity.mcp!.server,
        tool: input.identity.mcp!.tool,
        arguments: input.args,
        ...(content !== undefined ? { result: { content } } : {}),
      };
    }
    default: {
      const output = piToolOutputText(input.result);
      return output ? { ...base, result: truncate(output, OUTPUT_MAX_CHARS) } : base;
    }
  }
}

/** Shell output for the command row, capped so a huge log never floods the event log. */
export const piCommandOutput = (result: unknown): string =>
  truncate(piToolOutputText(result), OUTPUT_MAX_CHARS);
