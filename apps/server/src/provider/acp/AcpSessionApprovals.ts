/**
 * Client-side session approval grants for ACP agents whose `request_permission`
 * offers only `allow_once` (such as Antigravity's `agy acp`).
 *
 * Grants live in memory on the open session and die when it stops; nothing is
 * persisted to disk or sent to the agent as `allow_always`.
 *
 * Scoping rules:
 * - Command grants are always bound to their resolved working directory (`cwd`)
 *   and never derived from truncated command text or display labels.
 * - Prefix generalization on POSIX applies only to reviewed read-only `git`
 *   and `gh` subcommands without mutating/output/exec flags; everything else
 *   (including pipelines, Windows shells, redirects, substitutions, env
 *   overrides, and mutating subcommands) requires an exact command + cwd match.
 * - Workspace edit grants verify realpath containment (walking up to the
 *   nearest existing ancestor for new files) so symlinks inside the workspace
 *   cannot escape it, and never trim file paths.
 * - Revised cards whose `toolCall.kind` conflicts with `request.kind` never
 *   create or match a session grant.
 *
 * @module provider/acp/AcpSessionApprovals
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import type { AcpPermissionRequest, AcpToolCallState } from "./AcpRuntimeModel.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strictly read-only `git` subcommands safe to generalize by subcommand prefix. */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-tree",
  "merge-base",
  "cat-file",
  "rev-list",
]);

/** Git flags that can execute helpers, redirect output to disk, or target another repo. */
const DISALLOWED_GIT_FLAGS = new Set([
  "-c",
  "--config-env",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--git-dir",
  "--work-tree",
  "--ext-diff",
  "-o",
  "--output",
]);

/** Strictly read-only `gh <noun> <verb>` pairs safe to generalize by prefix. */
const READONLY_GH_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list"]),
  run: new Set(["view", "list", "watch"]),
  workflow: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  search: new Set(["repos", "issues", "prs", "code", "commits"]),
};

/** `gh` flags that open browsers, write files, or alter HTTP methods. */
const DISALLOWED_GH_FLAGS = new Set(["-w", "--web", "-o", "--output", "-X", "--method"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const CWD_KEYS = ["cwd", "Cwd", "workingDir", "working_dir", "WorkingDirectory"] as const;
const TRUNCATION_MARKERS = ["\n\n[Command truncated]", "[Earlier output truncated]\n\n"] as const;

/**
 * Splits a POSIX shell command into sequential segments separated by `&&`,
 * `||`, or `;` outside quotes. Rejects pipelines (`|`) and any construct that
 * can hide execution or alter I/O (newlines, redirects, substitutions,
 * subshells, brace expansion, backgrounding, or unterminated quotes).
 */
export function splitSafeShellChain(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> | undefined {
  // Windows shells (`cmd.exe` / PowerShell) do not share POSIX quoting rules.
  if (platform === "win32") return undefined;
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) return undefined;

  const segments: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    const next = trimmed[i + 1];

    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        if (next === undefined) return undefined;
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === "`" || (ch === "$" && (next === "(" || next === "{"))) {
        return undefined;
      }
      if (ch === '"') {
        quote = undefined;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      if (next === undefined) return undefined;
      current += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (
      ch === "`" ||
      ch === "<" ||
      ch === ">" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}" ||
      (ch === "$" && (next === "(" || next === "{"))
    ) {
      return undefined;
    }
    if (ch === "&") {
      if (next !== "&") return undefined;
      const part = current.trim();
      if (part.length === 0) return undefined;
      segments.push(part);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|") {
      // Only `||` is a sequential separator; single `|` pipes data between commands.
      if (next !== "|") return undefined;
      const part = current.trim();
      if (part.length === 0) return undefined;
      segments.push(part);
      current = "";
      i += 2;
      continue;
    }
    if (ch === ";") {
      const part = current.trim();
      if (part.length === 0) return undefined;
      segments.push(part);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (quote !== undefined) return undefined;
  const tail = current.trim();
  if (tail.length === 0) return undefined;
  segments.push(tail);
  return segments;
}

/** Tokenizes one already-validated simple POSIX shell segment into argv words. */
function tokenizeSimpleShellSegment(segment: string): ReadonlyArray<string> | undefined {
  const tokens: Array<string> = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | undefined;
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i]!;
    const next = segment[i + 1];

    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        if (next === undefined) return undefined;
        current += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = undefined;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      i += 1;
      continue;
    }

    inToken = true;
    if (ch === "\\") {
      if (next === undefined) return undefined;
      current += next;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  if (quote !== undefined) return undefined;
  if (inToken) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

function hasDisallowedFlag(args: ReadonlyArray<string>, disallowed: ReadonlySet<string>): boolean {
  return args.some((arg) => {
    const flag = arg.split("=")[0] ?? arg;
    return disallowed.has(flag);
  });
}

/**
 * Strictly read-only subcommand prefix key for one simple POSIX command
 * segment, bound to `cwd`, or `undefined` when exact command matching is
 * required.
 */
function safeReadOnlyCommandPrefixKey(segment: string, cwd: string): string | undefined {
  const tokens = tokenizeSimpleShellSegment(segment);
  if (!tokens || tokens.length === 0) return undefined;
  const [exe, sub1, sub2, ...rest] = tokens;
  if (!exe || ENV_ASSIGNMENT.test(exe) || exe.includes("/") || exe.includes("\\")) {
    return undefined;
  }

  if (exe === "git") {
    if (!sub1 || !READONLY_GIT_SUBCOMMANDS.has(sub1)) return undefined;
    if (hasDisallowedFlag([sub2 ?? "", ...rest], DISALLOWED_GIT_FLAGS)) return undefined;
    return `cmd:prefix:${cwd}\0git\0${sub1}`;
  }

  if (exe === "gh") {
    const verbs = sub1 ? READONLY_GH_VERBS[sub1] : undefined;
    if (!sub1 || !sub2 || !verbs?.has(sub2)) return undefined;
    if (hasDisallowedFlag(rest, DISALLOWED_GH_FLAGS)) return undefined;
    return `cmd:prefix:${cwd}\0gh\0${sub1}\0${sub2}`;
  }

  return undefined;
}

function isTruncatedText(text: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Complete command text from the tool call itself (never from display-only
 * `request.detail`, and never from truncated command text).
 */
function commandOf(request: AcpPermissionRequest): string | undefined {
  const fromToolCall = request.toolCall?.command?.trim();
  if (!fromToolCall || isTruncatedText(fromToolCall)) return undefined;
  return fromToolCall;
}

function resolveRealOrLexical(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return normalize(filePath);
  }
}

/**
 * Working directory the command runs in, resolved against the session's root
 * so identical relative commands in different directories never share a grant.
 */
function commandCwdOf(
  toolCall: AcpToolCallState | undefined,
  cwdRoots: ReadonlyArray<string>,
): string | undefined {
  const item = toolCall && isRecord(toolCall.data.item) ? toolCall.data.item : undefined;
  const rawInput =
    toolCall && isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  let rawCwd: string | undefined;
  if (typeof item?.cwd === "string" && item.cwd.length > 0) {
    rawCwd = item.cwd;
  } else if (rawInput) {
    for (const key of CWD_KEYS) {
      const value = rawInput[key];
      if (typeof value === "string" && value.length > 0) {
        rawCwd = value;
        break;
      }
    }
  }
  const base = cwdRoots[0];
  if (rawCwd !== undefined) {
    const absolute = isAbsolute(rawCwd) || base === undefined ? rawCwd : resolve(base, rawCwd);
    return resolveRealOrLexical(absolute);
  }
  return base !== undefined ? resolveRealOrLexical(base) : undefined;
}

/** Preserves exact path bytes (never trimmed: trailing spaces name another file). */
function pathsFromToolCall(toolCall: AcpToolCallState | undefined): ReadonlyArray<string> {
  if (!toolCall) return [];
  const raw: Array<string> = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) raw.push(value);
  };
  const { content, locations, rawInput } = toolCall.data;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (isRecord(entry)) push(entry.path);
    }
  }
  if (Array.isArray(locations)) {
    for (const entry of locations) {
      if (isRecord(entry)) push(entry.path);
    }
  }
  if (isRecord(rawInput)) {
    push(rawInput.file_path);
    push(rawInput.TargetFile);
    push(rawInput.AbsolutePath);
    push(rawInput.Path);
    push(rawInput.path);
  }
  return raw;
}

function resolveFilePath(filePath: string, cwdRoots: ReadonlyArray<string>): string {
  const base = cwdRoots[0];
  return isAbsolute(filePath) || base === undefined ? normalize(filePath) : resolve(base, filePath);
}

/**
 * Resolves `targetPath` through any symlinks on its existing prefix (including
 * the nearest existing parent directory for a not-yet-created file). Returns
 * `undefined` if no existing ancestor can be resolved.
 */
function resolveRealPathThroughAncestors(targetPath: string): string | undefined {
  const suffix: Array<string> = [];
  let cursor = normalize(targetPath);
  while (true) {
    try {
      const real = realpathSync(cursor);
      return suffix.length === 0 ? real : join(real, ...suffix.toReversed());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.push(cursor.slice(parent.length).replace(/^[\\/]+/u, ""));
      cursor = parent;
    }
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Whether every resolved path sits inside a real workspace root after symlink
 * resolution, so a symlink inside the workspace pointing outside can never
 * inherit a workspace edit grant.
 */
function isRealPathInsideWorkspace(filePath: string, cwdRoots: ReadonlyArray<string>): boolean {
  const realRoots: Array<string> = [];
  for (const root of cwdRoots) {
    try {
      realRoots.push(realpathSync(root));
    } catch {
      // Unresolvable root cannot prove containment.
    }
  }
  if (realRoots.length === 0) return false;
  const resolvedTarget = resolveRealPathThroughAncestors(resolveFilePath(filePath, cwdRoots));
  if (resolvedTarget === undefined) return false;
  return realRoots.some((root) => isInsideRoot(root, resolvedTarget));
}

function urlOriginFromToolCall(toolCall: AcpToolCallState | undefined): string | undefined {
  const rawInput = toolCall?.data.rawInput;
  if (!isRecord(rawInput)) return undefined;
  const candidate = rawInput.url ?? rawInput.Url ?? rawInput.URL;
  if (typeof candidate !== "string") return undefined;
  try {
    const parsed = new URL(candidate.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

const GENERIC_TOOL_TITLES = new Set(["tool", "tool call", "terminal"]);

/**
 * Suppresses session approval when a revised (`reask`) tool call's kind or
 * command evidence conflicts with the permission request's original kind.
 */
function hasConflictingKind(request: AcpPermissionRequest): boolean {
  const toolCall = request.toolCall;
  if (!toolCall) return false;
  if (toolCall.itemType === "mcp_tool_call") return false;
  if (toolCall.kind !== undefined && toolCall.kind !== request.kind) return true;
  if (request.kind !== "execute" && toolCall.command !== undefined) return true;
  return false;
}

/**
 * The session-scoped grant key recorded when the user chooses "Always allow
 * this session" on `request`, or `undefined` when no safe key can be derived.
 */
export function acpSessionApprovalGrantKey(
  request: AcpPermissionRequest,
  cwdRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (hasConflictingKind(request)) return undefined;
  const toolCall = request.toolCall;

  // Normalized MCP tool calls (e.g. `threadlines_browser · browser_snapshot`).
  if (
    toolCall?.itemType === "mcp_tool_call" &&
    typeof toolCall.data.server === "string" &&
    typeof toolCall.data.tool === "string" &&
    toolCall.data.server.length > 0 &&
    toolCall.data.tool.length > 0
  ) {
    return `mcp:${toolCall.data.server}\0${toolCall.data.tool}`;
  }

  if (request.kind === "execute") {
    const command = commandOf(request);
    const cwd = commandCwdOf(toolCall, cwdRoots);
    if (!command || !cwd) return undefined;
    const segments = splitSafeShellChain(command, platform);
    if (segments && segments.length === 1) {
      const prefix = safeReadOnlyCommandPrefixKey(segments[0]!, cwd);
      if (prefix !== undefined) return prefix;
    }
    return `cmd:exact:${cwd}\0${command}`;
  }

  if (request.kind === "edit" || request.kind === "delete" || request.kind === "move") {
    const paths = pathsFromToolCall(toolCall);
    if (paths.length === 0) return undefined;
    if (paths.every((filePath) => isRealPathInsideWorkspace(filePath, cwdRoots))) {
      return `file:${request.kind}:workspace`;
    }
    const exact = [
      ...new Set(paths.map((filePath) => resolveFilePath(filePath, cwdRoots))),
    ].toSorted();
    return `file:${request.kind}:paths:${exact.join("\0")}`;
  }

  if (request.kind === "read") {
    const paths = pathsFromToolCall(toolCall);
    if (paths.length > 0) {
      const exact = [
        ...new Set(paths.map((filePath) => resolveFilePath(filePath, cwdRoots))),
      ].toSorted();
      return `file:read:paths:${exact.join("\0")}`;
    }
  }

  if (request.kind === "fetch" || request.kind === "search") {
    const origin = urlOriginFromToolCall(toolCall);
    if (origin !== undefined) return `web:${request.kind}:${origin}`;
  }

  const title = toolCall?.title?.trim();
  if (title && !GENERIC_TOOL_TITLES.has(title.toLowerCase())) {
    return `tool:${request.kind}:${title}`;
  }
  return undefined;
}

/**
 * Whether `request` is covered by the session's remembered grants. For chained
 * sequential commands without pipelines, redirects, or substitutions (`A && B`),
 * every segment must individually match a remembered grant in the same `cwd`.
 */
export function isAcpSessionApprovalGranted(
  request: AcpPermissionRequest,
  grants: ReadonlySet<string>,
  cwdRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (grants.size === 0 || hasConflictingKind(request)) return false;

  const key = acpSessionApprovalGrantKey(request, cwdRoots, platform);
  if (key !== undefined && grants.has(key)) return true;

  if (request.kind === "execute") {
    const command = commandOf(request);
    const cwd = commandCwdOf(request.toolCall, cwdRoots);
    if (!command || !cwd) return false;
    if (grants.has(`cmd:exact:${cwd}\0${command}`)) return true;
    const segments = splitSafeShellChain(command, platform);
    if (!segments || segments.length === 0) return false;
    return segments.every((segment) => {
      if (grants.has(`cmd:exact:${cwd}\0${segment}`)) return true;
      const prefix = safeReadOnlyCommandPrefixKey(segment, cwd);
      return prefix !== undefined && grants.has(prefix);
    });
  }

  return false;
}
