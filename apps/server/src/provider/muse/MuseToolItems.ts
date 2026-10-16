/**
 * Muse Code tool calls as Threadlines tool items.
 *
 * Muse names its tools (`shell`, `edit_file`, `write_file`, `apply_patch`,
 * `read_file`, `grep`, `glob`, `web_search`, `web_fetch`, MCP tools as
 * `mcp__<server>__<tool>`) and passes the model's arguments as verbatim JSON
 * text. The chat reads a few `data` fields: a command and its exit code, a
 * file edit's `changes` (also the turn's diff evidence), an MCP call's server
 * and tool. Muse's own words for a call (`displayLabel`) title the row.
 *
 * A finished shell call's `visibleOutput` is a JSON record of the run (Muse
 * 1.4.9: `output`, `exit_code`, `terminal_status`) where the streamed updates
 * carried plain text; the record's output and exit code are what the row shows.
 *
 * File edits count their lines exactly when they can: from the stored patch
 * (`patchRef`, read by the adapter), from an `apply_patch` body, or from
 * Muse's `patchSummary` when the call touched one file. An edit with no exact
 * count still shows; it just adds nothing to the turn's diff stats.
 *
 * @module provider/muse/MuseToolItems
 */
import type { CanonicalItemType } from "@threadlines/contracts";

import { BROWSER_MCP_SERVER_NAME } from "../../mcp/McpHttpServer.ts";
import { PAGES_MCP_SERVER_NAME } from "../../mcp/pageTools.ts";
import { ROOM_MCP_SERVER_NAME } from "../../mcp/roomToolAccess.ts";
import { museItemFailed, type MuseItem } from "./MuseProtocol.ts";

const DETAIL_MAX_CHARS = 400;
const OUTPUT_MAX_CHARS = 20_000;

export type MuseToolKind =
  | "shell"
  | "edit"
  | "read"
  | "search"
  | "webfetch"
  | "websearch"
  | "mcp"
  | "skill"
  /** A tool whose result shows as its own row (todos, questions, workflows). */
  | "native"
  | "other";

export interface MuseToolIdentity {
  readonly kind: MuseToolKind;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly mcp?: { readonly server: string; readonly tool: string };
}

/** Names of the session MCP servers Threadlines passes on `session/start`. */
export const MUSE_THREADLINES_MCP_SERVERS = {
  browser: "threadlines_browser",
  room: "threadlines_room",
  pages: "threadlines_pages",
} as const;

const THREADLINES_SERVER_BY_SESSION_NAME: Readonly<Record<string, string>> = {
  [MUSE_THREADLINES_MCP_SERVERS.browser]: BROWSER_MCP_SERVER_NAME,
  [MUSE_THREADLINES_MCP_SERVERS.room]: ROOM_MCP_SERVER_NAME,
  [MUSE_THREADLINES_MCP_SERVERS.pages]: PAGES_MCP_SERVER_NAME,
};

/** Tools whose result already shows as its own row: the todo list, the question card, the workflow. */
const NATIVE_ROW_TOOLS: ReadonlySet<string> = new Set([
  "write_todos",
  "request_user_input",
  "workflow",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A finished shell call's run record, when its output is one. */
function museShellRecord(
  item: Pick<MuseItem, "visibleOutput">,
): { readonly output: string; readonly exitCode?: number } | undefined {
  const text = item.visibleOutput?.trimStart();
  if (!text?.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || typeof parsed.output !== "string") return undefined;
    if (!("exit_code" in parsed) && !("terminal_status" in parsed)) return undefined;
    return {
      output: parsed.output,
      ...(typeof parsed.exit_code === "number" ? { exitCode: parsed.exit_code } : {}),
    };
  } catch {
    return undefined;
  }
}

/** A shell call's exit code: Muse's own field, else its run record's. */
export function museShellExitCode(item: MuseItem): number | undefined {
  return item.exitCode ?? museShellRecord(item)?.exitCode;
}

/** A tool call that failed: Muse's own failure, or a shell run that exited non-zero. */
export function museToolFailed(item: MuseItem, identity: MuseToolIdentity): boolean {
  if (museItemFailed(item)) return true;
  if (identity.kind !== "shell" || item.status === "inProgress") return false;
  const exitCode = museShellExitCode(item);
  return exitCode !== undefined && exitCode !== 0;
}

/** The model's arguments, when they parse (streaming arguments may not yet). */
export function museToolArgs(item: Pick<MuseItem, "args">): Record<string, unknown> | undefined {
  if (!item.args) return undefined;
  try {
    const parsed: unknown = JSON.parse(item.args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Classifies a `toolCall` (or `userShell`) item. */
export function identifyMuseTool(item: Pick<MuseItem, "kind" | "tool">): MuseToolIdentity {
  if (item.kind === "userShell") {
    return { kind: "shell", itemType: "command_execution", title: "Command" };
  }
  if (item.kind === "webSearch") {
    return { kind: "websearch", itemType: "web_search", title: "Web search" };
  }
  const name = item.tool ?? "";
  if (NATIVE_ROW_TOOLS.has(name)) {
    return { kind: "native", itemType: "dynamic_tool_call", title: name };
  }
  switch (name) {
    case "shell":
    case "bash":
    case "exec_command":
      return { kind: "shell", itemType: "command_execution", title: "Command" };
    case "edit_file":
    case "write_file":
    case "apply_patch":
      return { kind: "edit", itemType: "file_change", title: "File change" };
    case "read_file":
      return { kind: "read", itemType: "dynamic_tool_call", title: "Read file" };
    case "grep":
    case "glob":
      return { kind: "search", itemType: "dynamic_tool_call", title: "Search" };
    case "web_search":
      return { kind: "websearch", itemType: "web_search", title: "Web search" };
    case "web_fetch":
      return { kind: "webfetch", itemType: "dynamic_tool_call", title: "Web fetch" };
    // Titled like Claude's skill tool, so the chat says which skill it used.
    case "read_skill":
      return { kind: "skill", itemType: "dynamic_tool_call", title: "Skill" };
  }
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (mcp) {
    const server = THREADLINES_SERVER_BY_SESSION_NAME[mcp[1]!] ?? mcp[1]!;
    return {
      kind: "mcp",
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      mcp: { server, tool: mcp[2]! },
    };
  }
  if (/shell|bash|exec/iu.test(name)) {
    return { kind: "shell", itemType: "command_execution", title: "Command" };
  }
  if (/write|edit|patch/iu.test(name)) {
    return { kind: "edit", itemType: "file_change", title: "File change" };
  }
  return { kind: "other", itemType: "dynamic_tool_call", title: name || "Tool" };
}

/** Whether the item is a tool call whose row Threadlines hides (it shows natively). */
export function isMuseNativeRowTool(item: Pick<MuseItem, "kind" | "tool" | "status">): boolean {
  return (
    item.kind === "toolCall" &&
    item.tool !== undefined &&
    NATIVE_ROW_TOOLS.has(item.tool) &&
    item.status !== "failed"
  );
}

/** The row's title: Muse's own words for the call when it has them. */
export function museToolTitle(item: MuseItem, identity: MuseToolIdentity): string {
  const label = item.displayLabel;
  if (label) {
    const words =
      item.status === "inProgress"
        ? label.active
        : item.status === "completed"
          ? label.done
          : label.neutral;
    if (words.trim()) return truncate(words.trim(), DETAIL_MAX_CHARS);
  }
  return identity.title;
}

/** The command a shell item ran. */
export function museCommandText(item: MuseItem): string | undefined {
  return item.commandText ?? stringField(museToolArgs(item), "command", "cmd");
}

/** The one-line detail under the tool row. */
export function museToolDetail(item: MuseItem, identity: MuseToolIdentity): string | undefined {
  const args = museToolArgs(item);
  const detail = (() => {
    switch (identity.kind) {
      case "shell":
        return museCommandText(item);
      case "edit":
      case "read":
        return stringField(args, "path", "file_path", "filePath");
      case "search": {
        const pattern = stringField(args, "pattern", "query", "glob");
        const where = stringField(args, "path", "directory");
        return pattern && where ? `${pattern} in ${where}` : pattern;
      }
      case "webfetch":
        return stringField(args, "url");
      case "websearch":
        return stringField(args, "query");
      case "mcp": {
        const call = `${identity.mcp!.server} · ${identity.mcp!.tool}`;
        return args && Object.keys(args).length > 0 ? `${call}: ${JSON.stringify(args)}` : call;
      }
      case "skill":
        // `bundled:durable-test-collateral` reads as its last part.
        return stringField(args, "name")?.split(":").pop();
      case "native":
      case "other":
        return args && Object.keys(args).length > 0 ? JSON.stringify(args) : item.fallbackText;
    }
  })();
  return detail ? truncate(detail, DETAIL_MAX_CHARS) : undefined;
}

export interface MuseFileChange {
  readonly path: string;
  readonly kind: "add" | "update" | "delete";
  readonly diff?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

/**
 * Paths stay relative to the workspace root, as Threadlines' checkpoints list
 * them; the root is realpath'd, so an absolute path under it is cut back.
 */
export function relativeToWorkspace(root: string, file: string): string {
  const base = root.replace(/[\\/]+$/u, "");
  if (file.startsWith(`${base}/`) || file.startsWith(`${base}\\`)) {
    return file.slice(base.length + 1);
  }
  return file;
}

function changeKind(value: unknown): "add" | "update" | "delete" {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "add":
    case "added":
    case "create":
    case "created":
    case "new":
      return "add";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "delete";
    default:
      return "update";
  }
}

function countDiffLines(lines: ReadonlyArray<string>): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Files of an `apply_patch` body (`*** Begin Patch` / `*** Update File: …`),
 * with exact line counts.
 */
export function parseApplyPatchBody(body: string, root: string): ReadonlyArray<MuseFileChange> {
  if (!body.includes("*** Begin Patch")) return [];
  const files: Array<{ path: string; kind: MuseFileChange["kind"]; lines: string[] }> = [];
  let current: (typeof files)[number] | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header) {
      current = {
        path: relativeToWorkspace(root, header[2]!.trim()),
        kind: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update",
        lines: [],
      };
      files.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (move && current) {
      current.path = relativeToWorkspace(root, move[1]!.trim());
      continue;
    }
    if (line.startsWith("***")) continue;
    current?.lines.push(line);
  }
  return files.map((file) => ({
    path: file.path,
    kind: file.kind,
    ...countDiffLines(file.lines),
  }));
}

/**
 * Files of the stored structured patch (`patchRef`, `application/json`). The
 * document's exact layout is not published, so this reads the shapes a patch
 * document plausibly takes and gives up (empty) on anything else.
 */
export function parseStoredPatch(content: string, root: string): ReadonlyArray<MuseFileChange> {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return [];
  }
  const entries = Array.isArray(document)
    ? document
    : isRecord(document)
      ? (["files", "entries", "changes", "patches"]
          .map((key) => document[key])
          .find(Array.isArray) as ReadonlyArray<unknown> | undefined)
      : undefined;
  if (!entries) return [];
  return entries.flatMap((entry): ReadonlyArray<MuseFileChange> => {
    if (!isRecord(entry)) return [];
    const path = stringField(entry, "path", "file", "newPath", "new_path", "oldPath", "old_path");
    if (!path) return [];
    const kind = changeKind(entry.kind ?? entry.status ?? entry.op ?? entry.type);
    const diff = stringField(entry, "diff", "patch", "unifiedDiff", "unified_diff");
    const hunkLines = Array.isArray(entry.hunks)
      ? entry.hunks.flatMap((hunk) =>
          isRecord(hunk) && Array.isArray(hunk.lines)
            ? hunk.lines.filter((line): line is string => typeof line === "string")
            : typeof hunk === "string"
              ? hunk.split(/\r?\n/u)
              : [],
        )
      : [];
    const additions = entry.added ?? entry.additions;
    const deletions = entry.removed ?? entry.deletions;
    const counts =
      typeof additions === "number" && typeof deletions === "number"
        ? { additions, deletions }
        : diff
          ? countDiffLines(diff.split(/\r?\n/u))
          : hunkLines.length > 0
            ? countDiffLines(hunkLines)
            : undefined;
    return [
      {
        path: relativeToWorkspace(root, path),
        kind,
        ...(diff ? { diff } : {}),
        ...counts,
      },
    ];
  });
}

/**
 * A finished edit's file changes, best source first: the stored patch the
 * adapter read, an `apply_patch` body, then the call's own arguments (with
 * Muse's line counts when it touched one file).
 */
export function museFileChanges(input: {
  readonly item: MuseItem;
  readonly root: string;
  readonly storedPatch?: string | undefined;
}): ReadonlyArray<MuseFileChange> {
  const { item, root } = input;
  if (input.storedPatch) {
    const stored = parseStoredPatch(input.storedPatch, root);
    if (stored.length > 0) return stored;
  }
  const args = museToolArgs(item);
  const patchBody = stringField(args, "patch", "input", "diff") ?? item.args ?? "";
  const patched = parseApplyPatchBody(patchBody, root);
  if (patched.length > 0) return patched;
  const path = stringField(args, "path", "file_path", "filePath");
  if (!path) return [];
  const summary = item.patchSummary;
  const exact = summary && summary.files === 1;
  const isWrite = item.tool === "write_file";
  const oldText = stringField(args, "old_string", "old_str", "oldText");
  return [
    {
      path: relativeToWorkspace(root, path),
      kind: isWrite && !oldText && summary?.removed === 0 ? "add" : "update",
      ...(exact ? { additions: summary.added, deletions: summary.removed } : {}),
    },
  ];
}

/** `data` for a tool item, by kind. File changes count only once the call finished. */
export function museToolData(input: {
  readonly item: MuseItem;
  readonly identity: MuseToolIdentity;
  readonly root: string;
  readonly storedPatch?: string | undefined;
}): Record<string, unknown> {
  const { item, identity } = input;
  const args = museToolArgs(item);
  const base = {
    toolName: item.tool ?? identity.title,
    ...(args !== undefined ? { input: args } : item.args ? { input: item.args } : {}),
  };
  const finished = item.status !== "inProgress";
  const output = item.visibleOutput ? truncate(item.visibleOutput, OUTPUT_MAX_CHARS) : undefined;
  switch (identity.kind) {
    case "shell": {
      const exitCode = museShellExitCode(item);
      return {
        ...base,
        item: {
          command: museCommandText(item),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(finished && museToolFailed(item, identity) ? { status: "failed" } : {}),
        },
      };
    }
    case "edit":
      return !finished || item.status !== "completed"
        ? base
        : {
            ...base,
            changes: museFileChanges({
              item,
              root: input.root,
              storedPatch: input.storedPatch,
            }),
          };
    case "mcp":
      return {
        ...base,
        server: identity.mcp!.server,
        tool: identity.mcp!.tool,
        arguments: args ?? {},
        ...(output !== undefined ? { result: { content: [{ type: "text", text: output }] } } : {}),
      };
    default:
      return output !== undefined ? { ...base, result: output } : base;
  }
}

/** Shell output for the command row, capped: the run record's output once the call finished. */
export function museCommandOutput(item: MuseItem): string {
  return truncate(museShellRecord(item)?.output ?? item.visibleOutput ?? "", OUTPUT_MAX_CHARS);
}
