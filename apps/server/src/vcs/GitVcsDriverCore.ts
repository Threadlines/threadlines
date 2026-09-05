import { randomUUID } from "node:crypto";

import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import {
  GitCommandError,
  type VcsCommitDetailsResult,
  type VcsCommitGraphResult,
  type VcsRef,
  type VcsStashEntry,
  type VcsWorkingTreeFileChangeKind,
} from "@threadlines/contracts";
import {
  classifyGitRemoteAuthFailure,
  dedupeRemoteBranchesWithLocalMatches,
} from "@threadlines/shared/git";
import { compactTraceAttributes } from "@threadlines/shared/observability";
import { decodeJsonResult } from "@threadlines/shared/schemaJson";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerConfig } from "../config.ts";
const isGitCommandError = Schema.is(GitCommandError);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 12_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.minutes(2);
/**
 * Git refuses to touch the index while another process holds
 * `.git/index.lock`. Our own mutations are serialized per checkout, but a
 * terminal, an editor, or a coding agent working in the same directory is
 * outside that mutex, and even a plain `git status` takes the lock to refresh
 * the index. The lock is normally held for milliseconds, so the failure is a
 * race rather than a real conflict — and surfacing it strands multi-step
 * flows partway through (a pull that already stashed leaves the user's work
 * in the stash). Retry for ~2s before giving up.
 */
const INDEX_LOCK_RETRY_DELAYS = [
  Duration.millis(100),
  Duration.millis(200),
  Duration.millis(400),
  Duration.millis(600),
  Duration.millis(800),
] as const;
// Healthy single-branch fetches have been observed taking up to ~6s on
// Windows (credential helper + network jitter), while large rewritten remotes
// can exceed 15s. Background pollers do not block interactive reads once the
// cache is warm; explicit refreshes surface a bounded failure to the caller.
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(60);
const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.minutes(10);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const REMOTE_REFS_REFRESH_INTERVAL = Duration.minutes(2);
const REMOTE_REFS_REFRESH_TIMEOUT = Duration.seconds(60);
const REMOTE_REFS_REFRESH_FAILURE_COOLDOWN = Duration.minutes(10);
const REMOTE_REFS_REFRESH_CACHE_CAPACITY = 2_048;
const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);
const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const LIST_REFS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_FETCH_NO_WRITE_FETCH_HEAD = "--no-write-fetch-head";
/** Upper bound on the pre-worktree fetch; past it the local branch is used as-is. */
const WORKTREE_BASE_FETCH_TIMEOUT = Duration.seconds(15);
const BACKGROUND_GIT_FETCH_ENV = Object.freeze({
  GCM_INTERACTIVE: "Never",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const GIT_COMMIT_GRAPH_DEFAULT_LIMIT = 24;
const GIT_COMMIT_GRAPH_MAX_OUTPUT_BYTES = 512 * 1024;
const GIT_COMMIT_DETAILS_MAX_OUTPUT_BYTES = 96 * 1024;
const UNTRACKED_TEXT_STAT_MAX_BYTES = 512 * 1024;
const GIT_GRAPH_RECORD_SEPARATOR = "\x1e";
const GIT_GRAPH_FIELD_SEPARATOR = "\x1f";
const GIT_STASH_RECORD_SEPARATOR = "\x1e";
const GIT_STASH_FIELD_SEPARATOR = "\x1f";
const THREADLINES_STASH_RECOVERY_REF_PREFIX = "refs/threadlines/recovery/stash/";
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  headSha: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
  branchName: string;
}> {}

class RemoteRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  includeTags: boolean;
}> {}

class ListRefsSnapshotCacheKey extends Data.Class<{
  gitCommonDir: string;
  epoch: number;
}> {}

class ListRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  generation: number;
}> {}

interface ListRefsRepositoryContext {
  readonly gitCommonDir: string;
  readonly resolvedCwd: string;
}

interface ListRefsSnapshot {
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
}

/**
 * Whether a git failure message is only the index lock being held elsewhere.
 * Matched on the message rather than the exit code, which git reports as a
 * generic failure. See `INDEX_LOCK_RETRY_DELAYS`.
 */
export function isIndexLockContentionMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("index.lock") && normalized.includes("file exists");
}

function isIndexLockContentionExit(
  outcome: Exit.Exit<GitVcsDriver.ExecuteGitResult, GitCommandError>,
): boolean {
  return Exit.match(outcome, {
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () => false,
        onSome: (error) => isIndexLockContentionMessage(error.detail),
      }),
    onSuccess: (result) => result.exitCode !== 0 && isIndexLockContentionMessage(result.stderr),
  });
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined || index + 1 >= value.length - 1) {
      decoded += "\\";
      continue;
    }
    index += 1;

    switch (escaped) {
      case "a":
        decoded += "\x07";
        break;
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "v":
        decoded += "\v";
        break;
      case "\\":
      case '"':
        decoded += escaped;
        break;
      default: {
        if (escaped < "0" || escaped > "7") {
          decoded += escaped;
          break;
        }

        let octal = escaped;
        for (let offset = 0; offset < 2; offset += 1) {
          const next = value[index + 1];
          if (next === undefined || next < "0" || next > "7" || index + 1 >= value.length - 1) {
            break;
          }
          octal += next;
          index += 1;
        }
        decoded += String.fromCharCode(Number.parseInt(octal, 8));
      }
    }
  }

  return decoded;
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: decodeGitQuotedPath(normalizedPath.length > 0 ? normalizedPath : rawPath),
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function countTextFileLines(contents: string): number {
  if (contents.includes("\0") || contents.length === 0) {
    return 0;
  }
  const normalized = contents.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.split("\n").length;
}

interface ParsedPorcelainChange {
  readonly path: string;
  readonly originalPath: string | null;
  readonly indexStatus: VcsWorkingTreeFileChangeKind | null;
  readonly worktreeStatus: VcsWorkingTreeFileChangeKind | null;
}

function parsePorcelainStatusCode(value: string): VcsWorkingTreeFileChangeKind | null {
  switch (value) {
    case ".":
      return null;
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "?":
      return "untracked";
    default:
      return null;
  }
}

function sliceAfterNthSpace(line: string, spaceCount: number): string | null {
  let index = -1;
  for (let count = 0; count < spaceCount; count += 1) {
    index = line.indexOf(" ", index + 1);
    if (index < 0) {
      return null;
    }
  }
  const value = line.slice(index + 1).trim();
  return value.length > 0 ? value : null;
}

function parsePorcelainChange(line: string): ParsedPorcelainChange | null {
  if (line.startsWith("? ")) {
    const path = decodeGitQuotedPath(line.slice(2).trim());
    return path.length > 0
      ? { path, originalPath: null, indexStatus: null, worktreeStatus: "untracked" }
      : null;
  }

  if (line.startsWith("1 ")) {
    const statusToken = line.slice(2, 4);
    const path = sliceAfterNthSpace(line, 8);
    if (!path) {
      return null;
    }
    return {
      path: decodeGitQuotedPath(path),
      originalPath: null,
      indexStatus: parsePorcelainStatusCode(statusToken[0] ?? "."),
      worktreeStatus: parsePorcelainStatusCode(statusToken[1] ?? "."),
    };
  }

  if (line.startsWith("2 ")) {
    const statusToken = line.slice(2, 4);
    const payload = sliceAfterNthSpace(line, 9);
    if (!payload) {
      return null;
    }
    const [filePath = "", originalPath = ""] = payload.split("\t");
    const path = decodeGitQuotedPath(filePath.trim());
    if (path.length === 0) {
      return null;
    }
    return {
      path,
      originalPath:
        originalPath.trim().length > 0 ? decodeGitQuotedPath(originalPath.trim()) : null,
      indexStatus: parsePorcelainStatusCode(statusToken[0] ?? "."),
      worktreeStatus: parsePorcelainStatusCode(statusToken[1] ?? "."),
    };
  }

  if (line.startsWith("u ")) {
    const rawPath = sliceAfterNthSpace(line, 10);
    const path = rawPath ? decodeGitQuotedPath(rawPath) : null;
    return path
      ? {
          path,
          originalPath: null,
          indexStatus: "unmerged",
          worktreeStatus: "unmerged",
        }
      : null;
  }

  return null;
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function isThreadlinesCheckpointRef(value: string): boolean {
  return (
    value === "threadlines/checkpoints" ||
    value.startsWith("threadlines/checkpoints/") ||
    value === "refs/threadlines/checkpoints" ||
    value.startsWith("refs/threadlines/checkpoints/") ||
    value === "refs/threadlines" ||
    value.startsWith("refs/threadlines/") ||
    value === "t3/checkpoints" ||
    value.startsWith("t3/checkpoints/") ||
    value === "refs/t3/checkpoints" ||
    value.startsWith("refs/t3/checkpoints/") ||
    value === "refs/t3" ||
    value.startsWith("refs/t3/")
  );
}

function isThreadlinesCheckpointSubject(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("threadlines checkpoint ref=refs/threadlines/") ||
    normalized.startsWith("t3 checkpoint ref=refs/t3/")
  );
}

function isSymbolicRemoteHeadRef(value: string): boolean {
  const normalized = value.trim().replace(/^refs\/remotes\//, "");
  return /^[^/]+\/HEAD$/i.test(normalized);
}

function parseCommitGraphRefs(value: string): string[] {
  return value
    .split(",")
    .flatMap((ref) => {
      const trimmed = ref.trim();
      if (trimmed.length === 0 || trimmed === "HEAD") {
        return [];
      }
      if (trimmed.startsWith("HEAD -> ")) {
        return [trimmed.slice("HEAD -> ".length).trim()];
      }
      if (trimmed.includes(" -> ")) {
        return [];
      }
      if (trimmed.startsWith("tag: ")) {
        return [trimmed.slice("tag: ".length).trim()];
      }
      return [trimmed];
    })
    .filter(
      (ref) => ref.length > 0 && !isThreadlinesCheckpointRef(ref) && !isSymbolicRemoteHeadRef(ref),
    );
}

function parseCommitGraphOutput(stdout: string, limit: number): VcsCommitGraphResult {
  const records = stdout
    .split(GIT_GRAPH_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0);
  const commits = records.flatMap((record) => {
    const [
      sha = "",
      parentsRaw = "",
      refsRaw = "",
      authorName = "",
      committedAt = "",
      subject = "",
    ] = record.split(GIT_GRAPH_FIELD_SEPARATOR);
    const trimmedSha = sha.trim();
    if (trimmedSha.length === 0) {
      return [];
    }

    const hasThreadlinesCheckpointRef = refsRaw
      .split(",")
      .map((ref) =>
        ref
          .trim()
          .replace(/^HEAD -> /, "")
          .replace(/^tag: /, ""),
      )
      .some(isThreadlinesCheckpointRef);
    const refs = parseCommitGraphRefs(refsRaw);
    const normalizedSubject = subject.trim();
    if (isThreadlinesCheckpointSubject(normalizedSubject) || hasThreadlinesCheckpointRef) {
      return [];
    }

    return [
      {
        sha: trimmedSha,
        shortSha: trimmedSha.slice(0, 7),
        parents: parentsRaw
          .split(" ")
          .map((parent) => parent.trim())
          .filter((parent) => parent.length > 0),
        refs,
        subject: normalizedSubject,
        authorName: authorName.trim(),
        committedAt: committedAt.trim(),
      },
    ];
  });

  return {
    commits: commits.slice(0, limit),
    truncated: commits.length > limit,
  };
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseGitHubCommitUrlFromRemoteUrl(remoteUrl: string, sha: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const sshMatch = /^git@([^:/\s]+):(.+)$/i.exec(trimmed);
  const urlMatch = /^(?:ssh:\/\/git@|https?:\/\/|git:\/\/)([^/\s]+)\/(.+)$/i.exec(trimmed);
  const host = (sshMatch?.[1] ?? urlMatch?.[1] ?? "").trim();
  const rawPath = (sshMatch?.[2] ?? urlMatch?.[2] ?? "").trim();
  const normalizedHost = host.toLowerCase();
  if (
    normalizedHost.length === 0 ||
    (!normalizedHost.includes("github") && normalizedHost !== "github.com")
  ) {
    return null;
  }

  const repositoryPath = rawPath
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const [owner = "", repo = ""] = repositoryPath.split("/");
  if (owner.length === 0 || repo.length === 0) {
    return null;
  }

  return `https://${host}/${owner}/${repo}/commit/${sha}`;
}

function parseGitHubCommitUrlFromRemoteList(stdout: string, sha: string): string | null {
  const remotes = parseRemoteFetchUrls(stdout);
  const remoteUrls = [remotes.get("origin"), ...remotes.values()].filter(
    (remoteUrl): remoteUrl is string => typeof remoteUrl === "string" && remoteUrl.length > 0,
  );
  for (const remoteUrl of remoteUrls) {
    const commitUrl = parseGitHubCommitUrlFromRemoteUrl(remoteUrl, sha);
    if (commitUrl) {
      return commitUrl;
    }
  }
  return null;
}

function normalizeCommitMessageOutput(stdout: string): string {
  return stdout.replace(/\r\n?/gu, "\n").trim();
}

function splitCommitMessage(message: string): { subject: string; body: string } {
  const firstNewline = message.indexOf("\n");
  if (firstNewline === -1) {
    return { subject: message, body: "" };
  }

  return {
    subject: message.slice(0, firstNewline),
    body: message.slice(firstNewline + 1).replace(/^\n+/u, ""),
  };
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  const remoteAuth = classifyGitRemoteAuthFailure(detail);
  return new GitCommandError({
    operation,
    command: quoteGitCommand(args),
    cwd,
    detail,
    ...(remoteAuth !== null ? { remoteAuth } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function remoteTrackingRef(remoteName: string, branchName: string): string {
  return `refs/remotes/${remoteName}/${branchName}`;
}

function remoteBranchFetchRefspec(remoteName: string, branchName: string): string {
  return `+refs/heads/${branchName}:${remoteTrackingRef(remoteName, branchName)}`;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

function toGitCommandError(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(Effect.catch(() => Effect.void));

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `threadlines-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const collectOutput = Effect.fnUntraced(function* <E>(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.mapError(toGitCommandError(input, "output stream failed.")),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { worktreesDir } = yield* ServerConfig;
  const backgroundScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  // Assigned once the ref snapshot cache is constructed below. Remote refresh
  // fibers can then invalidate snapshots without coupling their fetch cache to
  // the snapshot implementation's ordering in this service constructor.
  let invalidateListRefsSnapshotByCommonDir = (_gitCommonDir: string): Effect.Effect<void> =>
    Effect.void;

  const executeRaw: GitVcsDriver.GitVcsDriverShape["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make(
              "git",
              commandInput.args,
              hideWindowsConsole({
                cwd: commandInput.cwd,
                env: {
                  ...process.env,
                  // Git must never block waiting for credentials on a terminal
                  // the server does not have; fail fast so auth errors surface
                  // deterministically on every platform.
                  GIT_TERMINAL_PROMPT: "0",
                  ...input.env,
                  ...trace2Monitor.env,
                },
              }),
            ),
          )
          .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
              Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(toGitCommandError(commandInput, "failed to write stdin.")),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          const trimmedStderr = stderr.text.trim();
          return yield* createGitCommandError(
            commandInput.operation,
            commandInput.cwd,
            commandInput.args,
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
          );
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      return yield* runGitCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  operation: commandInput.operation,
                  command: quoteGitCommand(commandInput.args),
                  cwd: commandInput.cwd,
                  detail: `${quoteGitCommand(commandInput.args)} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  );

  const executeWithIndexLockRetry: GitVcsDriver.GitVcsDriverShape["execute"] = Effect.fnUntraced(
    function* (input) {
      // Both outcomes have to be inspected: callers that opted into
      // `allowNonZeroExit` get the lock message back as a result, everyone
      // else gets it as a `GitCommandError`.
      let outcome = yield* Effect.exit(executeRaw(input));
      for (const delay of INDEX_LOCK_RETRY_DELAYS) {
        if (!isIndexLockContentionExit(outcome)) break;
        yield* Effect.sleep(delay);
        outcome = yield* Effect.exit(executeRaw(input));
      }
      return yield* outcome;
    },
  );

  const execute: GitVcsDriver.GitVcsDriverShape["execute"] = (input) =>
    executeWithIndexLockRetry(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
        }
        if (options.fallbackErrorMessage) {
          return Effect.fail(
            createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
          );
        }
        return Effect.fail(
          createGitCommandError(
            operation,
            cwd,
            args,
            `${quoteGitCommand(args)} failed: code=${result.exitCode ?? "null"}`,
          ),
        );
      }),
    );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const gitMutationSemaphores = new Map<string, Semaphore.Semaphore>();
  const gitMutationSemaphoreForCommonDir = (
    gitCommonDir: string,
  ): Effect.Effect<Semaphore.Semaphore> =>
    Effect.sync(() => {
      const existing = gitMutationSemaphores.get(gitCommonDir);
      if (existing) return existing;
      const semaphore = Semaphore.makeUnsafe(1);
      gitMutationSemaphores.set(gitCommonDir, semaphore);
      return semaphore;
    });

  const withGitMutationPermitForCommonDir = <A, E, R>(
    gitCommonDir: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    gitMutationSemaphoreForCommonDir(gitCommonDir).pipe(
      Effect.flatMap((semaphore) => semaphore.withPermit(effect)),
    );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitVcsDriver.hasHeadCommit", cwd, ["rev-parse", "--verify", "HEAD"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const resolveCommitUrl = (
    cwd: string,
    sha: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    runGitStdout("GitVcsDriver.commitDetails.remoteUrls", cwd, ["remote", "-v"], true).pipe(
      Effect.map((stdout) => parseGitHubCommitUrlFromRemoteList(stdout, sha)),
      Effect.catch(() => Effect.succeed(null)),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* createGitCommandError(
      "GitVcsDriver.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    upstream: { readonly remoteName: string; readonly branchName: string },
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const fetchArgs = [
      "--git-dir",
      gitCommonDir,
      "fetch",
      GIT_FETCH_NO_WRITE_FETCH_HEAD,
      "--quiet",
      "--no-tags",
      upstream.remoteName,
      remoteBranchFetchRefspec(upstream.remoteName, upstream.branchName),
    ];
    return withGitMutationPermitForCommonDir(
      gitCommonDir,
      executeGit("GitVcsDriver.fetchRemoteForStatus", fetchCwd, fetchArgs, {
        allowNonZeroExit: true,
        env: BACKGROUND_GIT_FETCH_ENV,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : createGitCommandError(
                "GitVcsDriver.fetchRemoteForStatus",
                fetchCwd,
                fetchArgs,
                result.stderr.trim() || "git fetch upstream status failed",
              ),
        ),
      ),
    );
  };

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* runGitStdout("GitVcsDriver.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
  });

  const withGitMutationPermitForCwd = <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | GitCommandError, R> =>
    resolveGitCommonDir(cwd).pipe(
      Effect.flatMap((gitCommonDir) => withGitMutationPermitForCommonDir(gitCommonDir, effect)),
    );

  const gitCommonDirMetadataCwd = (gitCommonDir: string): string =>
    path.basename(gitCommonDir) === ".git"
      ? path.dirname(path.dirname(gitCommonDir))
      : path.dirname(gitCommonDir);

  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    yield* fetchRemoteForStatus(cacheKey.gitCommonDir, {
      remoteName: cacheKey.remoteName,
      branchName: cacheKey.branchName,
    });
    return true as const;
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // Keep successful refreshes warm and briefly back off failed refreshes to avoid retry storms.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN,
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
        branchName: upstream.branchName,
      }),
    );
  });

  const refreshStatusUpstreamInBackgroundBestEffort = Effect.fn(
    "refreshStatusUpstreamInBackgroundBestEffort",
  )(function* (cwd: string) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(backgroundScope),
      Effect.asVoid,
    );
  });

  const fetchRemoteRefsForRemote = Effect.fn("fetchRemoteRefsForRemote")(function* (
    gitCommonDir: string,
    remoteName: string,
    options?: { readonly includeTags?: boolean },
  ) {
    yield* withGitMutationPermitForCommonDir(
      gitCommonDir,
      Effect.gen(function* () {
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        const branchArgs = [
          "--git-dir",
          gitCommonDir,
          "fetch",
          GIT_FETCH_NO_WRITE_FETCH_HEAD,
          "--quiet",
          "--no-tags",
          "--prune",
          remoteName,
          `+refs/heads/*:refs/remotes/${remoteName}/*`,
        ];
        const result = yield* executeGit(
          "GitVcsDriver.fetchRemoteRefsForRemote",
          fetchCwd,
          branchArgs,
          {
            allowNonZeroExit: true,
            env: BACKGROUND_GIT_FETCH_ENV,
            timeoutMs: Duration.toMillis(REMOTE_REFS_REFRESH_TIMEOUT),
          },
        );
        if (result.exitCode !== 0) {
          return yield* createGitCommandError(
            "GitVcsDriver.fetchRemoteRefsForRemote",
            fetchCwd,
            branchArgs,
            result.stderr.trim() || "git fetch remote refs failed",
          );
        }

        if (options?.includeTags !== true) {
          return;
        }

        const tagArgs = [
          "--git-dir",
          gitCommonDir,
          "fetch",
          GIT_FETCH_NO_WRITE_FETCH_HEAD,
          "--quiet",
          "--no-tags",
          remoteName,
          "refs/tags/*:refs/tags/*",
        ];
        const tagResult = yield* executeGit(
          "GitVcsDriver.fetchRemoteTagsForRemote",
          fetchCwd,
          tagArgs,
          {
            allowNonZeroExit: true,
            env: BACKGROUND_GIT_FETCH_ENV,
            timeoutMs: Duration.toMillis(REMOTE_REFS_REFRESH_TIMEOUT),
          },
        );
        if (tagResult.exitCode !== 0) {
          yield* Effect.logWarning(
            `GitVcsDriver.fetchRemoteTagsForRemote: tag ref refresh failed for ${fetchCwd}: ${
              tagResult.stderr.trim() || "git fetch remote tags failed"
            }`,
          );
        }
      }),
    );
  });

  const refreshRemoteRefsCacheEntry = Effect.fn("refreshRemoteRefsCacheEntry")(function* (
    cacheKey: RemoteRefsRefreshCacheKey,
  ) {
    const metadataCwd = gitCommonDirMetadataCwd(cacheKey.gitCommonDir);
    const remoteNamesResult = yield* executeGit(
      "GitVcsDriver.refreshRemoteRefs.remoteNames",
      metadataCwd,
      ["--git-dir", cacheKey.gitCommonDir, "remote"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    );
    if (remoteNamesResult.exitCode !== 0) {
      return yield* createGitCommandError(
        "GitVcsDriver.refreshRemoteRefs.remoteNames",
        metadataCwd,
        ["--git-dir", cacheKey.gitCommonDir, "remote"],
        remoteNamesResult.stderr.trim() || "git remote failed",
      );
    }

    const remoteNames = parseRemoteNames(remoteNamesResult.stdout);
    if (remoteNames.length === 0) {
      return true as const;
    }
    yield* Effect.forEach(
      remoteNames,
      (remoteName) =>
        fetchRemoteRefsForRemote(cacheKey.gitCommonDir, remoteName, {
          includeTags: cacheKey.includeTags,
        }),
      { discard: true, concurrency: "unbounded" },
    ).pipe(Effect.ensuring(invalidateListRefsSnapshotByCommonDir(cacheKey.gitCommonDir)));
    return true as const;
  });

  const remoteRefsRefreshCache = yield* Cache.makeWith(refreshRemoteRefsCacheEntry, {
    capacity: REMOTE_REFS_REFRESH_CACHE_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? REMOTE_REFS_REFRESH_INTERVAL : REMOTE_REFS_REFRESH_FAILURE_COOLDOWN,
  });

  const refreshRemoteRefs = Effect.fn("refreshRemoteRefs")(function* (
    cwd: string,
    options?: { readonly includeTags?: boolean; readonly force?: boolean },
  ) {
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    const cacheKey = new RemoteRefsRefreshCacheKey({
      gitCommonDir,
      includeTags: options?.includeTags === true,
    });
    if (options?.force === true) {
      yield* Cache.invalidate(remoteRefsRefreshCache, cacheKey);
    }
    yield* Cache.get(remoteRefsRefreshCache, cacheKey);
  });

  const refreshRemoteRefsIfStale = (cwd: string, options?: { readonly includeTags?: boolean }) =>
    refreshRemoteRefs(cwd, options);

  const refreshRemoteRefsBestEffort = (
    operation: string,
    cwd: string,
    options?: { readonly includeTags?: boolean },
  ) =>
    refreshRemoteRefsIfStale(cwd, options).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      Effect.catch((error) =>
        Effect.logWarning(`${operation}: remote ref refresh failed for ${cwd}: ${error.message}`),
      ),
    );

  const refreshRemoteRefsInBackgroundBestEffort = (
    operation: string,
    cwd: string,
    options?: { readonly includeTags?: boolean },
  ) =>
    refreshRemoteRefsBestEffort(operation, cwd, options).pipe(
      Effect.forkIn(backgroundScope),
      Effect.asVoid,
    );

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    refName: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitVcsDriver.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.catch(() => Effect.succeed([])));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* createGitCommandError(
      "GitVcsDriver.resolvePrimaryRemoteName",
      cwd,
      ["remote"],
      "No git remote is configured for this repository.",
    );
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriverShape["ensureRemote"] = Effect.fn("ensureRemote")(
    function* (input) {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeRemoteUrl(input.url);
      const remoteFetchUrls = yield* runGitStdout(
        "GitVcsDriver.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

      for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
        if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
          return remoteName;
        }
      }

      let remoteName = preferredName;
      let suffix = 1;
      while (remoteFetchUrls.has(remoteName)) {
        remoteName = `${preferredName}-${suffix}`;
        suffix += 1;
      }

      yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        remoteName,
        input.url,
      ]);
      return remoteName;
    },
  );

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
        continue;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    refName: string,
  ) {
    const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);
    if (!baseRef) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  // Remote-only status for background pollers: branch identity and upstream /
  // default-branch divergence via rev-parse + rev-list, never `git status` or
  // numstat working-tree scans.
  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGit(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    if (branchResult.exitCode !== 0) {
      const stderr = branchResult.stderr.trim();
      return yield* createGitCommandError(
        "GitVcsDriver.statusDetailsRemote.branch",
        cwd,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        stderr || "git branch lookup failed",
      );
    }

    const branchValue = branchResult.stdout.trim();
    const branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
    const upstream = yield* resolveCurrentUpstream(cwd);
    const upstreamRef = upstream?.upstreamRef ?? null;
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(0)),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin").pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch).pipe(
              Effect.catch(() => Effect.succeed(0)),
            )
        : 0;

    return {
      isRepo: true,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    } satisfies GitVcsDriver.GitRemoteStatusDetails;
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const statusResult = yield* executeGit(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch", "--untracked-files=all"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      const stderr = statusResult.stderr.trim();
      return yield* createGitCommandError(
        "GitVcsDriver.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch", "--untracked-files=all"],
        stderr || "git status failed",
      );
    }

    const statusStdout = statusResult.stdout;

    let refName: string | null = null;
    let headSha: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesByPath = new Map<string, ParsedPorcelainChange>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.oid ")) {
        const value = line.slice("# branch.oid ".length).trim();
        headSha = value.length > 0 && !value.startsWith("(") ? value : null;
        continue;
      }
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        const change = parsePorcelainChange(line);
        if (change) {
          hasWorkingTreeChanges = true;
          changedFilesByPath.set(change.path, change);
        }
      }
    }

    // A single diff against HEAD produces accurate totals and can be
    // attributed to index or worktree whenever no individual path has both
    // kinds of changes. Mixed paths still need both comparisons to preserve
    // the staged/unstaged split. Unborn branches have no HEAD, so they use the
    // same exact fallback.
    const hasMixedIndexAndWorktreeChanges = Array.from(changedFilesByPath.values()).some(
      (change) => change.indexStatus !== null && change.worktreeStatus !== null,
    );
    const numstatDetails =
      headSha !== null && !hasMixedIndexAndWorktreeChanges
        ? runGitStdout("GitVcsDriver.statusDetails.combinedNumstat", cwd, [
            "diff",
            "HEAD",
            "--numstat",
          ]).pipe(
            Effect.map(
              (stdout) =>
                ({
                  mode: "combined",
                  entries: parseNumstatEntries(stdout),
                }) as const,
            ),
          )
        : Effect.all(
            [
              runGitStdout("GitVcsDriver.statusDetails.unstagedNumstat", cwd, [
                "diff",
                "--numstat",
              ]),
              runGitStdout("GitVcsDriver.statusDetails.stagedNumstat", cwd, [
                "diff",
                "--cached",
                "--numstat",
              ]),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(
              ([unstagedStdout, stagedStdout]) =>
                ({
                  mode: "split",
                  stagedEntries: parseNumstatEntries(stagedStdout),
                  unstagedEntries: parseNumstatEntries(unstagedStdout),
                }) as const,
            ),
          );
    const [workingTreeNumstat, defaultRefResult, hasPrimaryRemote] = yield* Effect.all(
      [
        numstatDetails,
        executeGit(
          "GitVcsDriver.statusDetails.defaultRef",
          cwd,
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            allowNonZeroExit: true,
          },
        ),
        originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      ],
      { concurrency: "unbounded" },
    );
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const fallbackAheadCount =
      !upstreamRef && refName
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(
            Effect.catch(() => Effect.succeed(0)),
          )
        : null;

    if (fallbackAheadCount !== null) {
      aheadCount = fallbackAheadCount;
      behindCount = 0;
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    if (refName && !isDefaultBranch) {
      aheadOfDefaultCount =
        fallbackAheadCount !== null
          ? fallbackAheadCount
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(
              Effect.catch(() => Effect.succeed(0)),
            );
    }

    const fileStatMap = new Map<
      string,
      {
        insertions: number;
        deletions: number;
        stagedInsertions: number;
        stagedDeletions: number;
        unstagedInsertions: number;
        unstagedDeletions: number;
      }
    >();
    const ensureFileStat = (filePath: string) => {
      const existing = fileStatMap.get(filePath);
      if (existing) {
        return existing;
      }
      const stat = {
        insertions: 0,
        deletions: 0,
        stagedInsertions: 0,
        stagedDeletions: 0,
        unstagedInsertions: 0,
        unstagedDeletions: 0,
      };
      fileStatMap.set(filePath, stat);
      return stat;
    };
    const readUntrackedTextInsertions = Effect.fn("readUntrackedTextInsertions")(function* (
      filePath: string,
    ) {
      const absolutePath = path.resolve(cwd, filePath);
      const stat = yield* fileSystem
        .stat(absolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File" || Number(stat.size) > UNTRACKED_TEXT_STAT_MAX_BYTES) {
        return 0;
      }

      const contents = yield* fileSystem
        .readFileString(absolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return contents ? countTextFileLines(contents) : 0;
    });

    if (workingTreeNumstat.mode === "combined") {
      for (const entry of workingTreeNumstat.entries) {
        const existing = ensureFileStat(entry.path);
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        const change = changedFilesByPath.get(entry.path);
        if (change?.indexStatus !== null && change?.indexStatus !== undefined) {
          existing.stagedInsertions += entry.insertions;
          existing.stagedDeletions += entry.deletions;
        } else {
          existing.unstagedInsertions += entry.insertions;
          existing.unstagedDeletions += entry.deletions;
        }
      }
    } else {
      for (const entry of workingTreeNumstat.stagedEntries) {
        const existing = ensureFileStat(entry.path);
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        existing.stagedInsertions += entry.insertions;
        existing.stagedDeletions += entry.deletions;
      }
      for (const entry of workingTreeNumstat.unstagedEntries) {
        const existing = ensureFileStat(entry.path);
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        existing.unstagedInsertions += entry.insertions;
        existing.unstagedDeletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }
    }
    for (const [filePath, change] of changedFilesByPath) {
      if (
        fileStatMap.has(filePath) ||
        change.indexStatus !== null ||
        change.worktreeStatus !== "untracked"
      ) {
        continue;
      }

      const insertionsForUntrackedFile = yield* readUntrackedTextInsertions(filePath);
      if (insertionsForUntrackedFile <= 0) {
        continue;
      }

      const existing = ensureFileStat(filePath);
      existing.insertions += insertionsForUntrackedFile;
      existing.unstagedInsertions += insertionsForUntrackedFile;
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        const change = changedFilesByPath.get(filePath);
        insertions += stat.insertions;
        deletions += stat.deletions;
        const file: {
          path: string;
          originalPath?: string | null;
          indexStatus?: VcsWorkingTreeFileChangeKind | null;
          worktreeStatus?: VcsWorkingTreeFileChangeKind | null;
          insertions: number;
          deletions: number;
          stagedInsertions: number;
          stagedDeletions: number;
          unstagedInsertions: number;
          unstagedDeletions: number;
        } = {
          path: filePath,
          insertions: stat.insertions,
          deletions: stat.deletions,
          stagedInsertions: stat.stagedInsertions,
          stagedDeletions: stat.stagedDeletions,
          unstagedInsertions: stat.unstagedInsertions,
          unstagedDeletions: stat.unstagedDeletions,
        };
        if (change?.originalPath) {
          file.originalPath = change.originalPath;
        }
        if (change) {
          file.indexStatus = change.indexStatus;
          file.worktreeStatus = change.worktreeStatus;
        }
        return file;
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const [filePath, change] of changedFilesByPath) {
      if (fileStatMap.has(filePath)) continue;
      files.push({
        path: filePath,
        ...(change.originalPath ? { originalPath: change.originalPath } : {}),
        indexStatus: change.indexStatus,
        worktreeStatus: change.worktreeStatus,
        insertions: 0,
        deletions: 0,
        stagedInsertions: 0,
        stagedDeletions: 0,
        unstagedInsertions: 0,
        unstagedDeletions: 0,
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
      headSha,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriverShape["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriverShape["statusDetails"] = Effect.fn("statusDetails")(
    function* (cwd) {
      yield* refreshStatusUpstreamInBackgroundBestEffort(cwd);
      return yield* readStatusDetailsLocal(cwd);
    },
  );

  const statusDetailsRemote: GitVcsDriver.GitVcsDriverShape["statusDetailsRemote"] = Effect.fn(
    "statusDetailsRemote",
  )(function* (cwd, options) {
    if (options?.forceRefresh === true) {
      yield* refreshRemoteRefs(cwd, { includeTags: true, force: true }).pipe(
        Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      );
    } else {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(
        Effect.catchIf(isMissingGitCwdError, () => Effect.void),
        Effect.ignoreCause({ log: true }),
      );
    }
    return yield* readStatusDetailsRemote(cwd);
  });

  const status: GitVcsDriver.GitVcsDriverShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        headSha: details.headSha,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const readStagedCommitContext = Effect.fn("readStagedCommitContext")(function* (
    operation: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const stagedSummary = yield* runGitStdoutWithOptions(
      `${operation}.stagedSummary`,
      cwd,
      ["diff", "--no-color", "--cached", "--name-status"],
      env ? { env } : {},
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatch = yield* runGitStdoutWithOptions(
      `${operation}.stagedPatch`,
      cwd,
      ["diff", "--no-color", "--no-ext-diff", "--cached", "--patch"],
      {
        ...(env ? { env } : {}),
        maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );

    return {
      stagedSummary,
      stagedPatch,
    };
  });

  const stageCommitContext = Effect.fn("stageCommitContext")(function* (
    operation: string,
    cwd: string,
    filePaths: readonly string[] | undefined,
    env?: NodeJS.ProcessEnv,
  ) {
    if (filePaths && filePaths.length > 0) {
      yield* executeGit(`${operation}.reset`, cwd, ["reset"], env ? { env } : undefined).pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
      yield* executeGit(
        `${operation}.addSelected`,
        cwd,
        ["add", "-A", "--", ...filePaths],
        env ? { env } : undefined,
      ).pipe(Effect.asVoid);
    } else {
      yield* executeGit(`${operation}.addAll`, cwd, ["add", "-A"], env ? { env } : undefined).pipe(
        Effect.asVoid,
      );
    }
  });

  const prepareCommitContext: GitVcsDriver.GitVcsDriverShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    const operation = "GitVcsDriver.prepareCommitContext";
    if (!filePaths || filePaths.length === 0) {
      const existingStagedContext = yield* readStagedCommitContext(operation, cwd);
      if (existingStagedContext) {
        return existingStagedContext;
      }
    }
    yield* stageCommitContext(operation, cwd, filePaths);
    return yield* readStagedCommitContext(operation, cwd);
  });

  const previewCommitContext: GitVcsDriver.GitVcsDriverShape["previewCommitContext"] = Effect.fn(
    "previewCommitContext",
  )(function* (cwd, filePaths) {
    const operation = "GitVcsDriver.previewCommitContext";
    if (!filePaths || filePaths.length === 0) {
      const existingStagedContext = yield* readStagedCommitContext(operation, cwd);
      if (existingStagedContext) {
        return existingStagedContext;
      }
    }
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    const tempIndexPath = path.join(gitCommonDir, `t3-preview-index-${randomUUID()}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
    };
    const cleanupTempIndex = fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);

    return yield* Effect.gen(function* () {
      const headResult = yield* executeGit(operation, cwd, ["rev-parse", "--verify", "HEAD"], {
        allowNonZeroExit: true,
        env,
      });
      if (headResult.exitCode === 0) {
        yield* executeGit(operation, cwd, ["read-tree", "HEAD"], { env }).pipe(Effect.asVoid);
      }
      yield* stageCommitContext(operation, cwd, filePaths, env);
      return yield* readStagedCommitContext(operation, cwd, env);
    }).pipe(Effect.ensuring(cleanupTempIndex));
  });

  const workingTreeDiff: GitVcsDriver.GitVcsDriverShape["workingTreeDiff"] = Effect.fn(
    "workingTreeDiff",
  )(function* (input) {
    const operation = "GitVcsDriver.workingTreeDiff";
    const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
    const tempIndexPath = path.join(gitCommonDir, `t3-working-tree-diff-index-${randomUUID()}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
    };
    const cleanupTempIndex = fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);

    return yield* Effect.gen(function* () {
      const headResult = yield* executeGit(
        operation,
        input.cwd,
        ["rev-parse", "--verify", "HEAD"],
        {
          allowNonZeroExit: true,
          env,
        },
      );
      if (headResult.exitCode === 0) {
        yield* executeGit(operation, input.cwd, ["read-tree", "HEAD"], { env }).pipe(Effect.asVoid);
      }
      yield* stageCommitContext(operation, input.cwd, input.filePaths, env);
      const diffArgs = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--cached",
        "--patch",
        "--minimal",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
      ];
      const diff = yield* runGitStdoutWithOptions(operation, input.cwd, diffArgs, {
        env,
        maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      });
      return { diff };
    }).pipe(Effect.ensuring(cleanupTempIndex));
  });

  const discardChanges: GitVcsDriver.GitVcsDriverShape["discardChanges"] = Effect.fn(
    "discardChanges",
  )(function* (input) {
    const operation = "GitVcsDriver.discardChanges";
    const discardScope = input.scope ?? "all";
    const requestedPaths = [...new Set(input.filePaths.map((filePath) => filePath.trim()))].filter(
      (filePath) => filePath.length > 0,
    );

    if (requestedPaths.length === 0) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["restore"],
        "No changed files were selected.",
      );
    }

    const details = yield* readStatusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["status", "--porcelain=2"],
        "No Git repository found.",
      );
    }

    const changedFilesByPath = new Map(
      details.workingTree.files.map((file) => [file.path, file] as const),
    );
    const missingPaths = requestedPaths.filter((filePath) => {
      const file = changedFilesByPath.get(filePath);
      return !file || (discardScope === "unstaged" && !file.worktreeStatus);
    });
    if (missingPaths.length > 0) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["status", "--porcelain=2"],
        discardScope === "unstaged"
          ? `Cannot discard files without unstaged changes: ${missingPaths.join(", ")}`
          : `Cannot discard unchanged or unknown files: ${missingPaths.join(", ")}`,
      );
    }

    const trackedPathspecs: string[] = [];
    const untrackedPathspecs: string[] = [];
    const discardedPaths: string[] = [];

    for (const filePath of requestedPaths) {
      const file = changedFilesByPath.get(filePath);
      if (!file) {
        continue;
      }
      discardedPaths.push(file.path);
      if (file.worktreeStatus === "untracked" && file.indexStatus === null) {
        untrackedPathspecs.push(file.path);
        continue;
      }
      trackedPathspecs.push(file.path);
      if (file.originalPath) {
        trackedPathspecs.push(file.originalPath);
      }
    }

    const headExists = yield* hasHeadCommit(input.cwd);
    const uniqueTrackedPathspecs = [...new Set(trackedPathspecs)];
    const pathspecsToClean = [...new Set(untrackedPathspecs)];

    if (discardScope === "unstaged") {
      if (uniqueTrackedPathspecs.length > 0) {
        yield* runGit(operation, input.cwd, [
          "--literal-pathspecs",
          "restore",
          "--worktree",
          "--",
          ...uniqueTrackedPathspecs,
        ]);
      }

      if (pathspecsToClean.length > 0) {
        yield* runGit(`${operation}.cleanUntracked`, input.cwd, [
          "--literal-pathspecs",
          "clean",
          "-fd",
          "--",
          ...pathspecsToClean,
        ]);
      }

      return { discardedPaths };
    }

    if (uniqueTrackedPathspecs.length > 0) {
      if (headExists) {
        yield* runGit(operation, input.cwd, [
          "--literal-pathspecs",
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...uniqueTrackedPathspecs,
        ]);
      } else {
        yield* runGit(
          `${operation}.removeFromInitialIndex`,
          input.cwd,
          ["--literal-pathspecs", "rm", "--cached", "-f", "--", ...uniqueTrackedPathspecs],
          true,
        );
        pathspecsToClean.push(...uniqueTrackedPathspecs);
      }
    }

    const cleanPathspecs = [...new Set(pathspecsToClean)];
    if (cleanPathspecs.length > 0) {
      yield* runGit(`${operation}.cleanUntracked`, input.cwd, [
        "--literal-pathspecs",
        "clean",
        "-fd",
        "--",
        ...cleanPathspecs,
      ]);
    }

    return { discardedPaths };
  });

  const stageChanges: GitVcsDriver.GitVcsDriverShape["stageChanges"] = Effect.fn("stageChanges")(
    function* (input) {
      const operation = "GitVcsDriver.stageChanges";
      const requestedPaths = [
        ...new Set(input.filePaths.map((filePath) => filePath.trim())),
      ].filter((filePath) => filePath.length > 0);

      if (requestedPaths.length === 0) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["add"],
          "No changed files were selected.",
        );
      }

      const details = yield* readStatusDetailsLocal(input.cwd);
      if (!details.isRepo) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["status", "--porcelain=2"],
          "No Git repository found.",
        );
      }

      const changedFilesByPath = new Map(
        details.workingTree.files.map((file) => [file.path, file] as const),
      );
      const missingPaths = requestedPaths.filter((filePath) => !changedFilesByPath.has(filePath));
      if (missingPaths.length > 0) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["status", "--porcelain=2"],
          `Cannot stage unchanged or unknown files: ${missingPaths.join(", ")}`,
        );
      }

      const pathspecs = new Set<string>();
      for (const filePath of requestedPaths) {
        const file = changedFilesByPath.get(filePath);
        if (!file) continue;
        pathspecs.add(file.path);
        if (file.originalPath) {
          pathspecs.add(file.originalPath);
        }
      }

      yield* runGit(operation, input.cwd, ["--literal-pathspecs", "add", "-A", "--", ...pathspecs]);

      return { stagedPaths: requestedPaths };
    },
  );

  const unstageChanges: GitVcsDriver.GitVcsDriverShape["unstageChanges"] = Effect.fn(
    "unstageChanges",
  )(function* (input) {
    const operation = "GitVcsDriver.unstageChanges";
    const requestedPaths = [...new Set(input.filePaths.map((filePath) => filePath.trim()))].filter(
      (filePath) => filePath.length > 0,
    );

    if (requestedPaths.length === 0) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["restore", "--staged"],
        "No staged files were selected.",
      );
    }

    const details = yield* readStatusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["status", "--porcelain=2"],
        "No Git repository found.",
      );
    }

    const changedFilesByPath = new Map(
      details.workingTree.files.map((file) => [file.path, file] as const),
    );
    const missingPaths = requestedPaths.filter((filePath) => {
      const file = changedFilesByPath.get(filePath);
      return !file || !file.indexStatus;
    });
    if (missingPaths.length > 0) {
      return yield* createGitCommandError(
        operation,
        input.cwd,
        ["status", "--porcelain=2"],
        `Cannot unstage files without staged changes: ${missingPaths.join(", ")}`,
      );
    }

    const pathspecs = new Set<string>();
    for (const filePath of requestedPaths) {
      const file = changedFilesByPath.get(filePath);
      if (!file) continue;
      pathspecs.add(file.path);
      if (file.originalPath) {
        pathspecs.add(file.originalPath);
      }
    }

    const headExists = yield* hasHeadCommit(input.cwd);
    if (headExists) {
      yield* runGit(operation, input.cwd, [
        "--literal-pathspecs",
        "restore",
        "--staged",
        "--",
        ...pathspecs,
      ]);
    } else {
      yield* runGit(
        `${operation}.removeFromInitialIndex`,
        input.cwd,
        ["--literal-pathspecs", "rm", "--cached", "-f", "--", ...pathspecs],
        true,
      );
    }

    return { unstagedPaths: requestedPaths };
  });

  const commit: GitVcsDriver.GitVcsDriverShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriverShape["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* createGitCommandError(
        "GitVcsDriver.pushCurrentBranch",
        cwd,
        ["push"],
        "Cannot push from detached HEAD.",
      );
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote", cwd, [
        "push",
        "-u",
        requestedRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
          Effect.catch(() => Effect.succeed(false)),
        );
        if (hasRemoteBranch) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
      if (!publishRemoteName) {
        return yield* createGitCommandError(
          "GitVcsDriver.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push because no git remote is configured for this repository.",
        );
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithUpstream", cwd, [
        "push",
        "-u",
        publishRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (currentUpstream) {
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushUpstream", cwd, [
        "push",
        currentUpstream.remoteName,
        `HEAD:refs/heads/${currentUpstream.branchName}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"]);
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const parseStashRecoveryBranches = (stdout: string): ReadonlyMap<string, string> => {
    const recoveryBranches = new Map<string, string>();
    for (const record of stdout.split(/\r?\n/gu).filter((value) => value.length > 0)) {
      const [id = "", refName = ""] = record.split("\t");
      if (
        !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(id) ||
        !refName.startsWith(THREADLINES_STASH_RECOVERY_REF_PREFIX)
      ) {
        continue;
      }
      const branchAndOperation = refName.slice(THREADLINES_STASH_RECOVERY_REF_PREFIX.length);
      const operationSeparatorIndex = branchAndOperation.lastIndexOf("/");
      if (operationSeparatorIndex <= 0) {
        continue;
      }
      recoveryBranches.set(id, branchAndOperation.slice(0, operationSeparatorIndex));
    }
    return recoveryBranches;
  };

  const parseStashEntries = (
    stdout: string,
    recoveryBranches: ReadonlyMap<string, string>,
  ): ReadonlyArray<VcsStashEntry> =>
    stdout
      .split(GIT_STASH_RECORD_SEPARATOR)
      .map((record) => record.replace(/^[\r\n]+|[\r\n]+$/gu, ""))
      .filter((record) => record.length > 0)
      .flatMap((record) => {
        const [id = "", selector = "", createdAtSeconds = "", message = ""] =
          record.split(GIT_STASH_FIELD_SEPARATOR);
        const createdAtMs = Number(createdAtSeconds) * 1_000;
        if (
          !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(id) ||
          selector.trim().length === 0 ||
          !Number.isFinite(createdAtMs)
        ) {
          return [];
        }
        return [
          {
            id,
            selector: selector.trim(),
            message: message.trim() || selector.trim(),
            createdAt: new Date(createdAtMs).toISOString(),
            recoveryBranch: recoveryBranches.get(id) ?? null,
          },
        ];
      });

  const listStashesUnlocked = Effect.fn("listStashesUnlocked")(function* (cwd: string) {
    const [stashOutput, recoveryRefOutput] = yield* Effect.all([
      runGitStdoutWithOptions(
        "GitVcsDriver.listStashes",
        cwd,
        ["stash", "list", "--format=%H%x1f%gd%x1f%ct%x1f%gs%x1e"],
        { maxOutputBytes: 512 * 1024 },
      ),
      runGitStdoutWithOptions(
        "GitVcsDriver.listStashRecoveryRefs",
        cwd,
        [
          "for-each-ref",
          "--format=%(objectname)%09%(refname)",
          THREADLINES_STASH_RECOVERY_REF_PREFIX,
        ],
        { maxOutputBytes: 512 * 1024 },
      ),
    ]);
    return parseStashEntries(stashOutput, parseStashRecoveryBranches(recoveryRefOutput));
  });

  const conflictedPaths = Effect.fn("conflictedPaths")(function* (cwd: string) {
    const stdout = yield* runGitStdout(
      "GitVcsDriver.stash.conflictedPaths",
      cwd,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      true,
    );
    return stdout.split("\0").filter((filePath) => filePath.length > 0);
  });

  const ensureStashableWorkingTree = Effect.fn("ensureStashableWorkingTree")(function* (
    cwd: string,
  ) {
    const details = yield* statusDetails(cwd);
    if (!details.hasWorkingTreeChanges) {
      return yield* createGitCommandError(
        "GitVcsDriver.createStash",
        cwd,
        ["stash", "push"],
        "There are no local changes to stash.",
      );
    }
    if (
      details.workingTree.files.some(
        (file) => file.indexStatus === "unmerged" || file.worktreeStatus === "unmerged",
      )
    ) {
      return yield* createGitCommandError(
        "GitVcsDriver.createStash",
        cwd,
        ["stash", "push"],
        "Resolve the current merge conflicts before stashing changes.",
      );
    }

    const porcelain = yield* runGitStdout(
      "GitVcsDriver.createStash.submoduleStatus",
      cwd,
      ["status", "--porcelain=2", "--untracked-files=all", "--ignore-submodules=none"],
      true,
    );
    const hasDirtySubmodule = porcelain.split(/\r?\n/gu).some((line) => {
      if (!line.startsWith("1 ") && !line.startsWith("2 ")) {
        return false;
      }
      const submoduleState = line.split(" ", 4)[2] ?? "";
      return submoduleState.startsWith("S") && submoduleState !== "S...";
    });
    if (hasDirtySubmodule) {
      return yield* createGitCommandError(
        "GitVcsDriver.createStash",
        cwd,
        ["stash", "push"],
        "A submodule contains local changes. Stash or commit the submodule changes before continuing.",
      );
    }
    return details;
  });

  const createStashUnlocked = Effect.fn("createStashUnlocked")(function* (input: {
    readonly cwd: string;
    readonly includeUntracked: boolean;
    readonly message?: string | undefined;
  }) {
    yield* ensureStashableWorkingTree(input.cwd);
    const previousStashes = yield* listStashesUnlocked(input.cwd);
    const args = [
      "stash",
      "push",
      ...(input.includeUntracked ? ["--include-untracked"] : []),
      ...(input.message ? ["--message", input.message] : []),
    ];
    yield* executeGit("GitVcsDriver.createStash", input.cwd, args, {
      timeoutMs: 30_000,
      fallbackErrorMessage: "git stash push failed",
    });
    const stashes = yield* listStashesUnlocked(input.cwd);
    const stash = stashes[0];
    if (!stash || stashes.length <= previousStashes.length) {
      return yield* createGitCommandError(
        "GitVcsDriver.createStash",
        input.cwd,
        args,
        "Git did not create a new stash. Review the working tree and try again.",
      );
    }
    return stash;
  });

  const verifyStashTarget = Effect.fn("verifyStashTarget")(function* (input: {
    readonly cwd: string;
    readonly selector: string;
    readonly expectedStashId: string;
    readonly operation: string;
  }) {
    const result = yield* executeGit(
      input.operation,
      input.cwd,
      ["rev-parse", "--verify", `${input.selector}^{commit}`],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    const actualId = result.stdout.trim();
    if (result.exitCode !== 0 || actualId.toLowerCase() !== input.expectedStashId.toLowerCase()) {
      return yield* createGitCommandError(
        input.operation,
        input.cwd,
        ["rev-parse", "--verify", `${input.selector}^{commit}`],
        "The selected stash changed after it was loaded. Refresh the stash list and try again.",
      );
    }
  });

  const dropVerifiedStashUnlocked = Effect.fn("dropVerifiedStashUnlocked")(function* (input: {
    readonly cwd: string;
    readonly selector: string;
    readonly expectedStashId: string;
    readonly strict: boolean;
  }) {
    const verification = yield* verifyStashTarget({
      cwd: input.cwd,
      selector: input.selector,
      expectedStashId: input.expectedStashId,
      operation: "GitVcsDriver.dropStash.verify",
    }).pipe(Effect.exit);
    if (Exit.isFailure(verification)) {
      if (input.strict) {
        return yield* Effect.failCause(verification.cause);
      }
      return false;
    }
    yield* executeGit("GitVcsDriver.dropStash", input.cwd, [
      "stash",
      "drop",
      "--quiet",
      input.selector,
    ]);
    return true;
  });

  const applyStashUnlocked = Effect.fn("applyStashUnlocked")(function* (input: {
    readonly cwd: string;
    readonly selector: string;
    readonly expectedStashId: string;
    readonly dropAfterApply: boolean;
  }) {
    yield* verifyStashTarget({
      cwd: input.cwd,
      selector: input.selector,
      expectedStashId: input.expectedStashId,
      operation: "GitVcsDriver.applyStash.verify",
    });
    const applyResult = yield* executeGit(
      "GitVcsDriver.applyStash",
      input.cwd,
      ["stash", "apply", "--index", input.expectedStashId],
      { allowNonZeroExit: true, timeoutMs: 30_000 },
    );
    const conflicts = yield* conflictedPaths(input.cwd);
    if (applyResult.exitCode !== 0) {
      if (conflicts.length > 0) {
        return {
          status: "conflicted" as const,
          stashId: input.expectedStashId,
          dropped: false,
          conflictedPaths: conflicts,
        };
      }
      return yield* createGitCommandError(
        "GitVcsDriver.applyStash",
        input.cwd,
        ["stash", "apply", "--index", input.expectedStashId],
        applyResult.stderr.trim() ||
          applyResult.stdout.trim() ||
          "Git could not restore the selected stash.",
      );
    }

    const dropped = input.dropAfterApply
      ? yield* dropVerifiedStashUnlocked({
          cwd: input.cwd,
          selector: input.selector,
          expectedStashId: input.expectedStashId,
          strict: false,
        })
      : false;
    return {
      status: "applied" as const,
      stashId: input.expectedStashId,
      dropped,
      conflictedPaths: [],
    };
  });

  const restoreProtectedStashUnlocked = Effect.fn("restoreProtectedStashUnlocked")(
    function* (input: {
      readonly cwd: string;
      readonly selector: string;
      readonly stashId: string;
      readonly recoveryRef: string;
    }) {
      const applyArgs = ["stash", "apply", "--index", input.recoveryRef] as const;
      const applyResult = yield* executeGit(
        "GitVcsDriver.pullCurrentBranch.restore",
        input.cwd,
        applyArgs,
        { allowNonZeroExit: true, timeoutMs: 30_000 },
      );
      const conflicts = yield* conflictedPaths(input.cwd);
      if (applyResult.exitCode !== 0) {
        return {
          status: conflicts.length > 0 ? ("conflicted" as const) : ("failed" as const),
          stashDropped: false,
          conflictedPaths: conflicts,
          detail:
            applyResult.stderr.trim() ||
            applyResult.stdout.trim() ||
            "Git could not restore the protected local changes.",
        };
      }

      const stashDropped = yield* dropVerifiedStashUnlocked({
        cwd: input.cwd,
        selector: input.selector,
        expectedStashId: input.stashId,
        strict: false,
      });
      yield* runGit(
        "GitVcsDriver.pullCurrentBranch.deleteStashRecoveryRef",
        input.cwd,
        ["update-ref", "-d", input.recoveryRef, input.stashId],
        true,
      );
      return {
        status: "applied" as const,
        stashDropped,
        conflictedPaths: [],
        detail: "",
      };
    },
  );

  const listStashes: GitVcsDriver.GitVcsDriverShape["listStashes"] = (input) =>
    withGitMutationPermitForCwd(
      input.cwd,
      listStashesUnlocked(input.cwd).pipe(Effect.map((stashes) => ({ stashes }))),
    );

  const createStash: GitVcsDriver.GitVcsDriverShape["createStash"] = (input) =>
    withGitMutationPermitForCwd(
      input.cwd,
      createStashUnlocked(input).pipe(Effect.map((stash) => ({ stash }))),
    );

  const applyStash: GitVcsDriver.GitVcsDriverShape["applyStash"] = (input) =>
    withGitMutationPermitForCwd(input.cwd, applyStashUnlocked(input));

  const dropStash: GitVcsDriver.GitVcsDriverShape["dropStash"] = (input) =>
    withGitMutationPermitForCwd(
      input.cwd,
      dropVerifiedStashUnlocked({
        cwd: input.cwd,
        selector: input.selector,
        expectedStashId: input.expectedStashId,
        strict: true,
      }).pipe(Effect.as({ stashId: input.expectedStashId })),
    );

  const pullRefsHaveCommonAncestor = Effect.fn("pullRefsHaveCommonAncestor")(function* (
    cwd: string,
    localSha: string,
    upstreamSha: string,
  ) {
    const args = ["merge-base", localSha, upstreamSha] as const;
    const result = yield* executeGit("GitVcsDriver.pullCurrentBranch.mergeBase", cwd, args, {
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    return yield* createGitCommandError(
      "GitVcsDriver.pullCurrentBranch.mergeBase",
      cwd,
      args,
      result.stderr.trim() || "git merge-base failed",
    );
  });

  const pullCanFastForward = Effect.fn("pullCanFastForward")(function* (
    cwd: string,
    localSha: string,
    upstreamSha: string,
  ) {
    const args = ["merge-base", "--is-ancestor", localSha, upstreamSha] as const;
    const result = yield* executeGit("GitVcsDriver.pullCurrentBranch.fastForwardCheck", cwd, args, {
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    return yield* createGitCommandError(
      "GitVcsDriver.pullCurrentBranch.fastForwardCheck",
      cwd,
      args,
      result.stderr.trim() || "git merge-base --is-ancestor failed",
    );
  });

  const findEquivalentUpstreamCommit = Effect.fn("findEquivalentUpstreamCommit")(function* (
    cwd: string,
    localSha: string,
    upstreamSha: string,
  ) {
    const localTree = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.localTree",
      cwd,
      ["rev-parse", `${localSha}^{tree}`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    const upstreamCommits = yield* runGitStdoutWithOptions(
      "GitVcsDriver.pullCurrentBranch.upstreamTrees",
      cwd,
      ["log", "--format=%H%x09%T", "--max-count=5000", upstreamSha],
      { maxOutputBytes: 1024 * 1024 },
    );
    for (const line of upstreamCommits.split(/\r?\n/u)) {
      const [commitSha, treeSha] = line.trim().split("\t");
      if (commitSha && treeSha === localTree) {
        return commitSha;
      }
    }
    return null;
  });

  const findReconciliationPreviousHead = Effect.fn("findReconciliationPreviousHead")(function* (
    cwd: string,
    reflogAction: string,
  ) {
    const reflog = yield* runGitStdoutWithOptions(
      "GitVcsDriver.pullCurrentBranch.reconciliationReflog",
      cwd,
      ["reflog", "show", "--format=%H%x09%gs", "--max-count=100", "HEAD"],
      { maxOutputBytes: 128 * 1024 },
    );
    const entries = reflog
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const resetSubject = `${reflogAction}: updating HEAD`;
    const resetIndex = entries.findIndex((entry) => entry.split("\t", 2)[1] === resetSubject);
    const previousEntry = resetIndex >= 0 ? entries[resetIndex + 1] : undefined;
    const previousSha = previousEntry?.split("\t", 1)[0]?.trim();
    if (previousSha) {
      return previousSha;
    }

    return yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.reconciliationOrigHead",
      cwd,
      ["rev-parse", "ORIG_HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriverShape["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (input) {
    const { cwd, historyReconciliation, stashLocalChanges = false } = input;
    if (historyReconciliation && stashLocalChanges) {
      return yield* createGitCommandError(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        ["pull", "--ff-only"],
        "Stashing local changes cannot be combined with rewritten-history reconciliation.",
      );
    }
    return yield* withGitMutationPermitForCwd(
      cwd,
      Effect.gen(function* () {
        const details = yield* statusDetails(cwd);
        const refName = details.branch;
        if (!refName) {
          return yield* createGitCommandError(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            ["pull", "--ff-only"],
            "Cannot pull from detached HEAD.",
          );
        }
        if (!details.hasUpstream) {
          return yield* createGitCommandError(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            ["pull", "--ff-only"],
            "Current branch has no upstream configured. Push with upstream first.",
          );
        }
        const currentUpstream = yield* resolveCurrentUpstream(cwd);
        if (!currentUpstream) {
          return yield* createGitCommandError(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            ["pull", "--ff-only"],
            "Current branch upstream could not be resolved.",
          );
        }
        const upstreamTrackingRef = remoteTrackingRef(
          currentUpstream.remoteName,
          currentUpstream.branchName,
        );
        yield* executeGit(
          "GitVcsDriver.pullCurrentBranch.fetch",
          cwd,
          [
            "fetch",
            GIT_FETCH_NO_WRITE_FETCH_HEAD,
            currentUpstream.remoteName,
            remoteBranchFetchRefspec(currentUpstream.remoteName, currentUpstream.branchName),
          ],
          {
            timeoutMs: 30_000,
            fallbackErrorMessage: "git fetch upstream failed",
          },
        );

        const refreshedBeforePull = yield* statusDetails(cwd);
        const refreshedUpstream = yield* resolveCurrentUpstream(cwd);
        if (
          refreshedBeforePull.branch !== refName ||
          refreshedUpstream?.upstreamRef !== currentUpstream.upstreamRef
        ) {
          return yield* createGitCommandError(
            "GitVcsDriver.pullCurrentBranch.revalidate",
            cwd,
            ["pull", "--ff-only"],
            "The current branch or its upstream changed while the pull was fetching. Review the updated repository state and pull again.",
          );
        }
        const localSha = yield* runGitStdout(
          "GitVcsDriver.pullCurrentBranch.localSha",
          cwd,
          ["rev-parse", "HEAD"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        const upstreamSha = yield* runGitStdout(
          "GitVcsDriver.pullCurrentBranch.upstreamSha",
          cwd,
          ["rev-parse", upstreamTrackingRef],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (historyReconciliation) {
          const mismatch =
            refName !== historyReconciliation.refName
              ? `Current branch changed from '${historyReconciliation.refName}' to '${refName}'.`
              : currentUpstream.upstreamRef !== historyReconciliation.upstreamRef
                ? `Upstream changed from '${historyReconciliation.upstreamRef}' to '${currentUpstream.upstreamRef}'.`
                : localSha !== historyReconciliation.expectedLocalSha
                  ? `Local HEAD changed from '${historyReconciliation.expectedLocalSha}' to '${localSha}'.`
                  : upstreamSha !== historyReconciliation.expectedUpstreamSha
                    ? `Upstream HEAD changed from '${historyReconciliation.expectedUpstreamSha}' to '${upstreamSha}'.`
                    : refreshedBeforePull.hasWorkingTreeChanges
                      ? "The working tree has uncommitted changes. Commit or stash them before reconciling rewritten history."
                      : null;
          if (mismatch) {
            return yield* createGitCommandError(
              "GitVcsDriver.pullCurrentBranch.reconcile",
              cwd,
              ["pull", "--ff-only"],
              `${mismatch} Review the updated repository state and confirm again.`,
            );
          }
        }
        const hasCommonAncestor = yield* pullRefsHaveCommonAncestor(cwd, localSha, upstreamSha);

        if (!hasCommonAncestor) {
          if (!historyReconciliation) {
            const equivalentUpstreamCommitSha = yield* findEquivalentUpstreamCommit(
              cwd,
              localSha,
              upstreamSha,
            ).pipe(Effect.catch(() => Effect.succeed(null)));
            return {
              status: "requires_history_reconciliation" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
              localSha,
              upstreamSha,
              equivalentUpstreamCommitSha,
            };
          }

          const preResetDetails = yield* statusDetails(cwd);
          const preResetUpstream = yield* resolveCurrentUpstream(cwd);
          const preResetLocalSha = yield* runGitStdout(
            "GitVcsDriver.pullCurrentBranch.preResetLocalSha",
            cwd,
            ["rev-parse", "HEAD"],
            true,
          ).pipe(Effect.map((stdout) => stdout.trim()));
          const preResetUpstreamSha = yield* runGitStdout(
            "GitVcsDriver.pullCurrentBranch.preResetUpstreamSha",
            cwd,
            ["rev-parse", upstreamTrackingRef],
            true,
          ).pipe(Effect.map((stdout) => stdout.trim()));
          const preResetMismatch =
            preResetDetails.branch !== historyReconciliation.refName
              ? `Current branch changed from '${historyReconciliation.refName}' to '${preResetDetails.branch ?? "detached HEAD"}'.`
              : preResetUpstream?.upstreamRef !== historyReconciliation.upstreamRef
                ? `Upstream changed from '${historyReconciliation.upstreamRef}' to '${preResetUpstream?.upstreamRef ?? "none"}'.`
                : preResetLocalSha !== historyReconciliation.expectedLocalSha
                  ? `Local HEAD changed from '${historyReconciliation.expectedLocalSha}' to '${preResetLocalSha}'.`
                  : preResetUpstreamSha !== historyReconciliation.expectedUpstreamSha
                    ? `Upstream HEAD changed from '${historyReconciliation.expectedUpstreamSha}' to '${preResetUpstreamSha}'.`
                    : preResetDetails.hasWorkingTreeChanges
                      ? "The working tree has uncommitted changes. Commit or stash them before reconciling rewritten history."
                      : null;
          if (preResetMismatch) {
            return yield* createGitCommandError(
              "GitVcsDriver.pullCurrentBranch.revalidateBeforeReset",
              cwd,
              ["pull", "--ff-only"],
              `${preResetMismatch} Review the updated repository state and confirm again.`,
            );
          }
          if (yield* pullRefsHaveCommonAncestor(cwd, preResetLocalSha, preResetUpstreamSha)) {
            return yield* createGitCommandError(
              "GitVcsDriver.pullCurrentBranch.revalidateBeforeReset",
              cwd,
              ["pull", "--ff-only"],
              "The local and upstream branches no longer have unrelated histories. Review the updated repository state and pull again.",
            );
          }

          const recoveryRef = `refs/threadlines/recovery/${refName}/${localSha.slice(0, 12)}-${randomUUID()}`;
          yield* runGit("GitVcsDriver.pullCurrentBranch.createRecoveryRef", cwd, [
            "update-ref",
            recoveryRef,
            localSha,
            "",
          ]);

          const reconciliationId = randomUUID();
          const reflogAction = `threadlines-history-reconciliation-${reconciliationId}`;
          yield* executeGit(
            "GitVcsDriver.pullCurrentBranch.reset",
            cwd,
            ["reset", "--keep", upstreamSha],
            {
              env: { GIT_REFLOG_ACTION: reflogAction },
              timeoutMs: 30_000,
              fallbackErrorMessage: "git history reconciliation reset failed",
            },
          );
          const actualPreviousHead = yield* findReconciliationPreviousHead(cwd, reflogAction);
          yield* runGit("GitVcsDriver.pullCurrentBranch.updateRecoveryRef", cwd, [
            "update-ref",
            recoveryRef,
            actualPreviousHead,
            localSha,
          ]);
          const [reconciledHeadSha, recoveredHeadSha, reconciledDetails, reconciledUpstream] =
            yield* Effect.all([
              runGitStdout("GitVcsDriver.pullCurrentBranch.reconciledHeadSha", cwd, [
                "rev-parse",
                "HEAD",
              ]).pipe(Effect.map((stdout) => stdout.trim())),
              runGitStdout("GitVcsDriver.pullCurrentBranch.recoveredHeadSha", cwd, [
                "rev-parse",
                recoveryRef,
              ]).pipe(Effect.map((stdout) => stdout.trim())),
              statusDetails(cwd),
              resolveCurrentUpstream(cwd),
            ]);
          if (
            reconciledHeadSha !== upstreamSha ||
            recoveredHeadSha !== actualPreviousHead ||
            reconciledDetails.branch !== refName ||
            reconciledUpstream?.upstreamRef !== currentUpstream.upstreamRef
          ) {
            return yield* createGitCommandError(
              "GitVcsDriver.pullCurrentBranch.verifyReconciliation",
              cwd,
              ["rev-parse", "HEAD"],
              `History reconciliation post-verification failed. The recovery ref '${recoveryRef}' preserves commit '${recoveredHeadSha}'. Review the repository state before continuing.`,
            );
          }
          return {
            status: "reconciled" as const,
            refName,
            upstreamRef: currentUpstream.upstreamRef,
            recoveryRef,
          };
        }

        if (historyReconciliation) {
          return yield* createGitCommandError(
            "GitVcsDriver.pullCurrentBranch.reconcile",
            cwd,
            ["pull", "--ff-only"],
            "The local and upstream branches no longer have unrelated histories. Review the updated repository state and pull again.",
          );
        }

        if (stashLocalChanges && refreshedBeforePull.hasWorkingTreeChanges) {
          if (localSha === upstreamSha) {
            return {
              status: "skipped_up_to_date" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
            };
          }
          if (!(yield* pullCanFastForward(cwd, localSha, upstreamSha))) {
            return yield* createGitCommandError(
              "GitVcsDriver.pullCurrentBranch.protectChanges",
              cwd,
              ["merge", "--ff-only", upstreamSha],
              "The local and upstream branches have diverged. Resolve the divergence before stashing and pulling.",
            );
          }

          const operationId = randomUUID();
          const stash = yield* createStashUnlocked({
            cwd,
            includeUntracked: true,
            message: `Threadlines pull ${refName} ${operationId}`,
          });
          const recoveryRef = `refs/threadlines/recovery/stash/${refName}/${operationId}`;
          const createRecoveryRefResult = yield* executeGit(
            "GitVcsDriver.pullCurrentBranch.createStashRecoveryRef",
            cwd,
            ["update-ref", recoveryRef, stash.id, ""],
            { allowNonZeroExit: true },
          );
          if (createRecoveryRefResult.exitCode !== 0) {
            return {
              status: "update_failed_with_protected_changes" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
              stashId: stash.id,
              recoveryRef: null,
              detail:
                "The branch was not updated because Threadlines could not create the extra recovery reference. Your local changes remain protected in the listed stash.",
              conflictedPaths: [],
            };
          }

          const restoreAfterStoppedUpdate = Effect.fn("restoreAfterStoppedUpdate")(function* (
            detail: string,
          ) {
            const restore = yield* restoreProtectedStashUnlocked({
              cwd,
              selector: stash.selector,
              stashId: stash.id,
              recoveryRef,
            });
            if (restore.status === "applied") {
              return yield* createGitCommandError(
                "GitVcsDriver.pullCurrentBranch.protectChanges",
                cwd,
                ["merge", "--ff-only", upstreamSha],
                detail,
              );
            }
            return {
              status: "update_failed_with_protected_changes" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
              stashId: stash.id,
              recoveryRef,
              detail: `${detail} ${restore.detail}`.trim(),
              conflictedPaths: restore.conflictedPaths,
            };
          });

          const [postStashDetails, postStashUpstream, postStashLocalSha, postStashUpstreamSha] =
            yield* Effect.all([
              statusDetails(cwd),
              resolveCurrentUpstream(cwd),
              runGitStdout("GitVcsDriver.pullCurrentBranch.postStashLocalSha", cwd, [
                "rev-parse",
                "HEAD",
              ]).pipe(Effect.map((stdout) => stdout.trim())),
              runGitStdout("GitVcsDriver.pullCurrentBranch.postStashUpstreamSha", cwd, [
                "rev-parse",
                upstreamTrackingRef,
              ]).pipe(Effect.map((stdout) => stdout.trim())),
            ]);
          const postStashMismatch =
            postStashDetails.branch !== refName
              ? "The current branch changed while local changes were being protected."
              : postStashUpstream?.upstreamRef !== currentUpstream.upstreamRef
                ? "The upstream changed while local changes were being protected."
                : postStashLocalSha !== localSha
                  ? "Local HEAD changed while local changes were being protected."
                  : postStashUpstreamSha !== upstreamSha
                    ? "Upstream HEAD changed while local changes were being protected."
                    : postStashDetails.hasWorkingTreeChanges
                      ? "The working tree changed while local changes were being protected."
                      : null;
          if (postStashMismatch) {
            return yield* restoreAfterStoppedUpdate(
              `${postStashMismatch} The protected update was stopped.`,
            );
          }

          const mergeResult = yield* executeGit(
            "GitVcsDriver.pullCurrentBranch.mergeProtected",
            cwd,
            ["merge", "--ff-only", upstreamSha],
            { allowNonZeroExit: true, timeoutMs: 30_000 },
          );
          if (mergeResult.exitCode !== 0) {
            return yield* restoreAfterStoppedUpdate(
              mergeResult.stderr.trim() ||
                mergeResult.stdout.trim() ||
                "The fast-forward update failed.",
            );
          }

          const afterProtectedMergeSha = yield* runGitStdout(
            "GitVcsDriver.pullCurrentBranch.afterProtectedMergeSha",
            cwd,
            ["rev-parse", "HEAD"],
          ).pipe(Effect.map((stdout) => stdout.trim()));
          if (afterProtectedMergeSha !== upstreamSha) {
            return yield* restoreAfterStoppedUpdate(
              "The branch did not reach the expected upstream commit.",
            );
          }

          const restore = yield* restoreProtectedStashUnlocked({
            cwd,
            selector: stash.selector,
            stashId: stash.id,
            recoveryRef,
          });
          if (restore.status === "conflicted") {
            return {
              status: "pulled_with_restore_conflicts" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
              stashId: stash.id,
              recoveryRef,
              conflictedPaths: restore.conflictedPaths,
            };
          }
          if (restore.status === "failed") {
            return {
              status: "pulled_with_restore_failure" as const,
              refName,
              upstreamRef: currentUpstream.upstreamRef,
              stashId: stash.id,
              recoveryRef,
              detail: restore.detail,
            };
          }
          return {
            status: "pulled_with_restored_changes" as const,
            refName,
            upstreamRef: currentUpstream.upstreamRef,
            stashId: stash.id,
            stashDropped: restore.stashDropped,
          };
        }

        yield* executeGit(
          "GitVcsDriver.pullCurrentBranch.merge",
          cwd,
          ["merge", "--ff-only", upstreamTrackingRef],
          {
            timeoutMs: 30_000,
            fallbackErrorMessage: "git fast-forward merge failed",
          },
        );

        const afterSha = yield* runGitStdout(
          "GitVcsDriver.pullCurrentBranch.afterSha",
          cwd,
          ["rev-parse", "HEAD"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        const refreshed = yield* statusDetails(cwd);
        return {
          status:
            localSha.length > 0 && localSha === afterSha
              ? ("skipped_up_to_date" as const)
              : ("pulled" as const),
          refName,
          upstreamRef: refreshed.upstreamRef,
        };
      }),
    );
  });

  const readRangeContext: GitVcsDriver.GitVcsDriverShape["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const range = `${baseRef}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", range],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--no-color", "--stat", range],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-color", "--no-ext-diff", "--patch", "--minimal", range],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriverShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  /**
   * Turn `git worktree list --porcelain` output into checkouts that actually
   * exist on disk. Git keeps listing worktrees whose directory was deleted by
   * hand, so callers that resolve a path (branch pickers, cwd inference) would
   * otherwise point at nothing.
   */
  const parseWorktreeList = Effect.fn("parseWorktreeList")(function* (
    result: GitVcsDriver.ExecuteGitResult,
  ) {
    if (result.exitCode !== 0) {
      return [] as ReadonlyArray<GitVcsDriver.GitWorktreeEntry>;
    }
    const entries: Array<GitVcsDriver.GitWorktreeEntry> = [];
    let currentPath: string | null = null;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        const candidatePath = line.slice("worktree ".length);
        const exists = yield* fileSystem.stat(candidatePath).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
        currentPath = exists ? candidatePath : null;
        if (currentPath) {
          entries.push({ path: currentPath, branch: null });
        }
      } else if (line.startsWith("branch refs/heads/") && currentPath) {
        const branch = line.slice("branch refs/heads/".length);
        const pending = entries.at(-1);
        if (pending && pending.path === currentPath) {
          entries[entries.length - 1] = { path: pending.path, branch };
        }
      } else if (line === "") {
        currentPath = null;
      }
    }
    return entries as ReadonlyArray<GitVcsDriver.GitWorktreeEntry>;
  });

  const listWorktrees: GitVcsDriver.GitVcsDriverShape["listWorktrees"] = Effect.fn("listWorktrees")(
    function* (input) {
      const worktreeList = yield* executeGit(
        "GitVcsDriver.listWorktrees",
        input.cwd,
        ["worktree", "list", "--porcelain"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchIf(isMissingGitCwdError, () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(128),
            stdout: "",
            stderr: "fatal: not a git repository",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      );
      return yield* parseWorktreeList(worktreeList);
    },
  );

  /**
   * Absolute path of the repository's main checkout, derived from the shared
   * git directory. Null when it cannot be determined (bare repositories), in
   * which case no listed checkout is reported as the root.
   */
  const resolveMainWorktreePath = Effect.fn("resolveMainWorktreePath")(function* (cwd: string) {
    const result = yield* executeGit(
      "GitVcsDriver.listWorktreeStatuses.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      { timeoutMs: 5_000, allowNonZeroExit: true },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
    if (result === null || result.exitCode !== 0) {
      return null;
    }
    const rawGitCommonDir = result.stdout.trim();
    if (rawGitCommonDir.length === 0) {
      return null;
    }
    const gitCommonDir = path.isAbsolute(rawGitCommonDir)
      ? path.normalize(rawGitCommonDir)
      : path.normalize(path.resolve(cwd, rawGitCommonDir));
    if (path.basename(gitCommonDir) !== ".git") {
      return null;
    }
    return path.dirname(gitCommonDir);
  });

  const realPathOrSelf = (candidate: string): Effect.Effect<string> =>
    fileSystem
      .realPath(candidate)
      .pipe(Effect.catch(() => Effect.succeed(path.resolve(candidate))));

  /** Uncommitted changes in one checkout. A checkout git can no longer read
   * (its directory was removed underneath us) counts as clean rather than
   * failing the whole listing. */
  const readWorktreeDirty = (cwd: string): Effect.Effect<boolean> =>
    executeGit("GitVcsDriver.listWorktreeStatuses.status", cwd, ["status", "--porcelain"], {
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => result.exitCode === 0 && result.stdout.trim().length > 0),
      Effect.catch(() => Effect.succeed(false)),
    );

  /**
   * Commits on `branch` the repository's default branch cannot reach.
   *
   * A branch with no merge base against that default branch reports
   * `unrelatedHistory` and no count: `rev-list` would answer with the whole of
   * its history, which reads as a mountain of unshipped work when the truth is
   * that the two histories were never joined (checkouts predating a history
   * rewrite are the usual source).
   */
  const readUnmergedCommits = (
    cwd: string,
    branch: string | null,
  ): Effect.Effect<{ readonly count: number | null; readonly unrelatedHistory: boolean }> =>
    Effect.gen(function* () {
      if (branch === null) {
        return { count: null, unrelatedHistory: false };
      }
      const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, branch);
      if (!baseRef) {
        return { count: null, unrelatedHistory: false };
      }
      const mergeBase = yield* executeGit(
        "GitVcsDriver.listWorktreeStatuses.mergeBase",
        cwd,
        ["merge-base", baseRef, branch],
        { timeoutMs: 10_000, allowNonZeroExit: true },
      );
      // Exit 1 is git's specific "no merge base"; anything higher is a broken
      // ref or a failed call, which says nothing about the histories.
      if (mergeBase.exitCode === 1) {
        return { count: null, unrelatedHistory: true };
      }
      if (mergeBase.exitCode !== 0 || mergeBase.stdout.trim().length === 0) {
        return { count: null, unrelatedHistory: false };
      }
      const result = yield* executeGit(
        "GitVcsDriver.listWorktreeStatuses.revList",
        cwd,
        ["rev-list", "--count", `${baseRef}..${branch}`],
        { timeoutMs: 10_000, allowNonZeroExit: true },
      );
      if (result.exitCode !== 0) {
        return { count: null, unrelatedHistory: false };
      }
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return {
        count: Number.isFinite(parsed) ? Math.max(0, parsed) : null,
        unrelatedHistory: false,
      };
    }).pipe(Effect.catch(() => Effect.succeed({ count: null, unrelatedHistory: false })));

  const listWorktreeStatuses: GitVcsDriver.GitVcsDriverShape["listWorktreeStatuses"] = Effect.fn(
    "listWorktreeStatuses",
  )(function* (input) {
    const entries = yield* listWorktrees({ cwd: input.cwd });
    if (entries.length === 0) {
      return { worktrees: [] };
    }
    const mainWorktreePath = yield* resolveMainWorktreePath(input.cwd);
    const mainRealPath = mainWorktreePath === null ? null : yield* realPathOrSelf(mainWorktreePath);

    const worktrees = [];
    for (const entry of entries) {
      const entryRealPath = yield* realPathOrSelf(entry.path);
      const isRoot = mainRealPath !== null && entryRealPath === mainRealPath;
      const unmerged = yield* readUnmergedCommits(entry.path, entry.branch);
      worktrees.push({
        path: entry.path,
        refName: entry.branch,
        isRoot,
        dirty: yield* readWorktreeDirty(entry.path),
        unmergedCommitCount: unmerged.count,
        unrelatedHistory: unmerged.unrelatedHistory,
      });
    }
    return { worktrees };
  });

  const readListRefsRepositoryContext = Effect.fn("readListRefsRepositoryContext")(function* (
    cwd: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.listRefs.repositoryContext",
      cwd,
      ["rev-parse", "--git-common-dir"],
      { timeoutMs: 5_000, allowNonZeroExit: true },
    ).pipe(
      Effect.catchIf(isMissingGitCwdError, () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(128),
          stdout: "",
          stderr: "fatal: not a git repository",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return null;
      }
      return yield* createGitCommandError(
        "GitVcsDriver.listRefs.repositoryContext",
        cwd,
        ["rev-parse", "--git-common-dir"],
        stderr || "git rev-parse failed",
      );
    }

    const rawGitCommonDir = result.stdout.trim();
    const gitCommonDir = path.isAbsolute(rawGitCommonDir)
      ? path.normalize(rawGitCommonDir)
      : path.normalize(path.resolve(cwd, rawGitCommonDir));
    const resolvedCwd = yield* fileSystem
      .realPath(cwd)
      .pipe(Effect.catch(() => Effect.succeed(path.resolve(cwd))));
    return { gitCommonDir, resolvedCwd } satisfies ListRefsRepositoryContext;
  });

  const readListRefsSnapshot = Effect.fn("readListRefsSnapshot")(function* (gitCommonDir: string) {
    const metadataCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const gitDirArgs = ["--git-dir", gitCommonDir] as const;
    const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.listRefs.snapshotRefs",
          metadataCwd,
          [
            ...gitDirArgs,
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 30_000,
            maxOutputBytes: LIST_REFS_MAX_OUTPUT_BYTES,
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.defaultRef",
          metadataCwd,
          [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
          { timeoutMs: 5_000, allowNonZeroExit: true },
        ),
        executeGit(
          "GitVcsDriver.listRefs.worktreeList",
          metadataCwd,
          [...gitDirArgs, "worktree", "list", "--porcelain"],
          {
            timeoutMs: 30_000,
            allowNonZeroExit: true,
            maxOutputBytes: LIST_REFS_MAX_OUTPUT_BYTES,
          },
        ),
        executeGit("GitVcsDriver.listRefs.remoteNames", metadataCwd, [...gitDirArgs, "remote"], {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: 2 },
    );

    const remoteNames =
      remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;
    const worktreeList = yield* parseWorktreeList(worktreeListResult);
    const worktreeMap = new Map<string, string>();
    for (const worktree of worktreeList) {
      if (worktree.branch !== null) {
        worktreeMap.set(worktree.branch, path.normalize(path.resolve(worktree.path)));
      }
    }

    const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
    const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
    for (const line of refsResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");
      if (!fullRefName || symbolicTarget) continue;
      const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

      if (fullRefName.startsWith("refs/heads/")) {
        const name = fullRefName.slice("refs/heads/".length);
        localBranches.push({
          ref: {
            name,
            current: false,
            isRemote: false,
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          },
          lastCommit,
        });
        continue;
      }
      if (!fullRefName.startsWith("refs/remotes/")) continue;

      const name = fullRefName.slice("refs/remotes/".length);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
      remoteBranches.push({
        ref: {
          name,
          current: false,
          isRemote: true,
          isDefault: false,
          worktreePath: null,
          ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
        },
        lastCommit,
      });
    }

    const byRecencyThenName = (
      left: { readonly ref: VcsRef; readonly lastCommit: number },
      right: { readonly ref: VcsRef; readonly lastCommit: number },
    ) =>
      left.lastCommit !== right.lastCommit
        ? right.lastCommit - left.lastCommit
        : left.ref.name.localeCompare(right.ref.name);

    return {
      localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      hasPrimaryRemote: remoteNames.includes("origin"),
    } satisfies ListRefsSnapshot;
  });

  const listRefsEpochByCommonDir = new Map<string, number>();
  const listRefsGenerationByCommonDir = new Map<string, number>();
  let listRefsEpochSequence = 0;
  let listRefsGenerationSequence = 0;
  const setBoundedListRefsState = (
    state: Map<string, number>,
    gitCommonDir: string,
    value: number,
  ): number => {
    state.delete(gitCommonDir);
    state.set(gitCommonDir, value);
    if (state.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = state.keys().next().value;
      if (oldestKey !== undefined) state.delete(oldestKey);
    }
    return value;
  };
  const bumpListRefsEpoch = (gitCommonDir: string): number =>
    setBoundedListRefsState(listRefsEpochByCommonDir, gitCommonDir, ++listRefsEpochSequence);
  const currentListRefsGeneration = (gitCommonDir: string): number => {
    const current = listRefsGenerationByCommonDir.get(gitCommonDir);
    return current === undefined
      ? setBoundedListRefsState(
          listRefsGenerationByCommonDir,
          gitCommonDir,
          ++listRefsGenerationSequence,
        )
      : setBoundedListRefsState(listRefsGenerationByCommonDir, gitCommonDir, current);
  };
  const bumpListRefsGeneration = (gitCommonDir: string): number =>
    setBoundedListRefsState(
      listRefsGenerationByCommonDir,
      gitCommonDir,
      ++listRefsGenerationSequence,
    );

  const listRefsSnapshotCache = yield* Cache.makeWith(
    (cacheKey: ListRefsSnapshotCacheKey) => readListRefsSnapshot(cacheKey.gitCommonDir),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  const listRefsRefreshCache = yield* Cache.makeWith(
    (cacheKey: ListRefsRefreshCacheKey) =>
      Effect.suspend(() =>
        Cache.get(
          listRefsSnapshotCache,
          new ListRefsSnapshotCacheKey({
            gitCommonDir: cacheKey.gitCommonDir,
            epoch: bumpListRefsEpoch(cacheKey.gitCommonDir),
          }),
        ),
      ),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : Duration.zero),
    },
  );
  const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
    gitCommonDir: string,
    refresh: boolean,
  ) {
    while (true) {
      const generation = currentListRefsGeneration(gitCommonDir);
      const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
      const snapshot =
        refresh || currentEpoch === undefined
          ? yield* Cache.get(
              listRefsRefreshCache,
              new ListRefsRefreshCacheKey({ gitCommonDir, generation }),
            )
          : yield* Cache.get(
              listRefsSnapshotCache,
              new ListRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
            );
      if (currentListRefsGeneration(gitCommonDir) === generation) {
        return snapshot;
      }
    }
  });

  invalidateListRefsSnapshotByCommonDir = (gitCommonDir) =>
    Effect.sync(() => {
      bumpListRefsGeneration(gitCommonDir);
      bumpListRefsEpoch(gitCommonDir);
    });
  const invalidateListRefsSnapshot = (cwd: string): Effect.Effect<void> =>
    resolveGitCommonDir(cwd).pipe(
      Effect.flatMap(invalidateListRefsSnapshotByCommonDir),
      Effect.catch(() => Effect.void),
    );

  const listRefs: GitVcsDriver.GitVcsDriverShape["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const repositoryContext = yield* readListRefsRepositoryContext(input.cwd);
      if (repositoryContext === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }

      yield* refreshRemoteRefsInBackgroundBestEffort("GitVcsDriver.listRefs", input.cwd);
      const snapshot = yield* resolveListRefsSnapshot(
        repositoryContext.gitCommonDir,
        input.refresh === true,
      );
      const normalizedCwd = path.normalize(repositoryContext.resolvedCwd);
      const currentWorktreePath = snapshot.localBranches
        .flatMap((ref) => (ref.worktreePath === null ? [] : [ref.worktreePath]))
        .filter(
          (worktreePath) =>
            normalizedCwd === worktreePath ||
            normalizedCwd.startsWith(`${worktreePath}${path.sep}`),
        )
        .toSorted((left, right) => right.length - left.length)[0];
      const localBranches = snapshot.localBranches
        .map((ref) => ({
          ...ref,
          current: currentWorktreePath !== undefined && ref.worktreePath === currentWorktreePath,
        }))
        .toSorted((left, right) => {
          const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
          const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
          return leftPriority - rightPriority;
        });
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(
          dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]),
          input.query,
        ),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const commitGraph: GitVcsDriver.GitVcsDriverShape["commitGraph"] = Effect.fn("commitGraph")(
    function* (input) {
      const limit = input.limit ?? GIT_COMMIT_GRAPH_DEFAULT_LIMIT;
      yield* refreshRemoteRefsInBackgroundBestEffort("GitVcsDriver.commitGraph", input.cwd, {
        includeTags: true,
      });
      const result = yield* executeGit(
        "GitVcsDriver.commitGraph",
        input.cwd,
        [
          "log",
          "--exclude=refs/threadlines/*",
          "--exclude=refs/threadlines/checkpoints/*",
          "--exclude=refs/t3/*",
          "--exclude=refs/t3/checkpoints/*",
          "--exclude=refs/stash",
          "--all",
          "--topo-order",
          "--decorate=short",
          `--max-count=${limit + 1}`,
          `--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s%x1e`,
        ],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
          maxOutputBytes: GIT_COMMIT_GRAPH_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode === 0) {
        return parseCommitGraphOutput(result.stdout, limit);
      }

      const stderr = result.stderr.trim().toLowerCase();
      if (
        stderr.includes("does not have any commits yet") ||
        stderr.includes("your current branch") ||
        stderr.includes("not a git repository")
      ) {
        return { commits: [], truncated: false };
      }

      return yield* createGitCommandError(
        "GitVcsDriver.commitGraph",
        input.cwd,
        ["log", "--exclude=refs/stash", "--all", "--topo-order"],
        result.stderr.trim() || "git log failed",
      );
    },
  );

  const commitDetails: GitVcsDriver.GitVcsDriverShape["commitDetails"] = Effect.fn("commitDetails")(
    function* (input) {
      const resolvedSha = (yield* runGitStdout("GitVcsDriver.commitDetails.revParse", input.cwd, [
        "rev-parse",
        "--verify",
        `${input.sha}^{commit}`,
      ])).trim();
      const messageOutput = yield* runGitStdoutWithOptions(
        "GitVcsDriver.commitDetails.message",
        input.cwd,
        ["log", "-1", "--format=%B", resolvedSha],
        {
          maxOutputBytes: GIT_COMMIT_DETAILS_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );
      const message = normalizeCommitMessageOutput(messageOutput) || resolvedSha;
      const { subject, body } = splitCommitMessage(message);
      const commitUrl = yield* resolveCommitUrl(input.cwd, resolvedSha);

      return {
        sha: resolvedSha,
        shortSha: resolvedSha.slice(0, 7),
        subject,
        body,
        message,
        commitUrl,
      } satisfies VcsCommitDetailsResult;
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriverShape["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
    // `--no-track`: a thread's branch may start from a remote-tracking ref
    // (see resolveFreshWorktreeBase) and must not inherit it as upstream, or a
    // later push would target the base branch itself.
    const args = input.newRefName
      ? ["worktree", "add", "--no-track", "-b", input.newRefName, worktreePath, input.refName]
      : ["worktree", "add", "--no-guess", worktreePath, input.refName];

    yield* executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
      fallbackErrorMessage: "git worktree add failed",
    }).pipe(
      Effect.catchIf(
        // A worktree whose folder was deleted out-of-band leaves its
        // registration behind, and git refuses to reuse the path ("missing but
        // already registered worktree"). Recreating at the same path is exactly
        // the recovery this serves, so clear the dead registrations — prune
        // only ever removes entries whose directories are gone — and retry.
        (error) => /missing but already registered/iu.test(error.detail ?? ""),
        () =>
          executeGit("GitVcsDriver.createWorktree.prune", input.cwd, ["worktree", "prune"], {
            fallbackErrorMessage: "git worktree prune failed",
          }).pipe(
            Effect.andThen(
              executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
                fallbackErrorMessage: "git worktree add failed",
              }),
            ),
          ),
      ),
    );

    const expectedRef = `refs/heads/${targetBranch}`;
    const readCreatedWorktreeHead = Effect.fn("GitVcsDriver.createWorktree.readHead")(function* () {
      const result = yield* executeGit(
        "GitVcsDriver.createWorktree.readHead",
        worktreePath,
        ["symbolic-ref", "--quiet", "HEAD"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      );
      return result.exitCode === 0 ? result.stdout.trim() : null;
    });

    const verifyCreatedWorktreeBranch = Effect.fn("GitVcsDriver.createWorktree.verifyBranch")(
      function* () {
        let actualRef = yield* readCreatedWorktreeHead();
        if (actualRef === expectedRef) {
          return;
        }

        yield* runGit("GitVcsDriver.createWorktree.checkoutTargetBranch", worktreePath, [
          "checkout",
          "--quiet",
          targetBranch,
        ]);

        actualRef = yield* readCreatedWorktreeHead();
        if (actualRef !== expectedRef) {
          return yield* createGitCommandError(
            "GitVcsDriver.createWorktree.verifyBranch",
            worktreePath,
            ["symbolic-ref", "--quiet", "HEAD"],
            `git worktree add checked out ${actualRef ?? "detached HEAD"} instead of ${expectedRef}.`,
          );
        }
      },
    );

    yield* verifyCreatedWorktreeBranch().pipe(
      Effect.tapError(() =>
        runGit("GitVcsDriver.createWorktree.cleanupAfterVerifyFailure", input.cwd, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]).pipe(Effect.catch(() => Effect.void)),
      ),
    );

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const resolveFreshWorktreeBase: GitVcsDriver.GitVcsDriverShape["resolveFreshWorktreeBase"] =
    Effect.fn("resolveFreshWorktreeBase")(function* (input) {
      const local = { refName: input.branch, isRemote: false } as const;
      const upstreamRef = (yield* runGitStdout(
        "GitVcsDriver.resolveFreshWorktreeBase.upstream",
        input.cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${input.branch}@{upstream}`],
        true,
      )).trim();
      if (upstreamRef.length === 0 || upstreamRef.includes("@{upstream}")) {
        return local;
      }
      const remoteNames = yield* runGitStdout(
        "GitVcsDriver.resolveFreshWorktreeBase.remotes",
        input.cwd,
        ["remote"],
      ).pipe(
        Effect.map(parseRemoteNames),
        Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
      );
      const remoteName = remoteNames.find((name) => upstreamRef.startsWith(`${name}/`));
      if (!remoteName) {
        return local;
      }
      const remoteBranch = upstreamRef.slice(remoteName.length + 1);

      // Best effort: an offline machine or a slow remote must not hold up the
      // thread, and a failed fetch simply leaves the tracking ref as it was.
      yield* withGitMutationPermitForCwd(
        input.cwd,
        executeGit(
          "GitVcsDriver.resolveFreshWorktreeBase.fetch",
          input.cwd,
          [
            "fetch",
            GIT_FETCH_NO_WRITE_FETCH_HEAD,
            "--quiet",
            "--no-tags",
            remoteName,
            remoteBranchFetchRefspec(remoteName, remoteBranch),
          ],
          {
            env: BACKGROUND_GIT_FETCH_ENV,
            timeoutMs: Duration.toMillis(WORKTREE_BASE_FETCH_TIMEOUT),
          },
        ),
      ).pipe(Effect.ignore);

      const [localSha, upstreamSha] = yield* Effect.all([
        runGitStdout(
          "GitVcsDriver.resolveFreshWorktreeBase.localSha",
          input.cwd,
          ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
          true,
        ),
        runGitStdout(
          "GitVcsDriver.resolveFreshWorktreeBase.upstreamSha",
          input.cwd,
          ["rev-parse", "--verify", "--quiet", `refs/remotes/${upstreamRef}`],
          true,
        ),
      ]);
      if (upstreamSha.trim().length === 0 || localSha.trim() === upstreamSha.trim()) {
        return local;
      }
      const localIsBehind = yield* executeGit(
        "GitVcsDriver.resolveFreshWorktreeBase.isAncestor",
        input.cwd,
        ["merge-base", "--is-ancestor", input.branch, upstreamRef],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      return localIsBehind ? { refName: upstreamRef, isRemote: true } : local;
    });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriverShape["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* withGitMutationPermitForCwd(
        input.cwd,
        executeGit(
          "GitVcsDriver.fetchPullRequestBranch",
          input.cwd,
          [
            "fetch",
            GIT_FETCH_NO_WRITE_FETCH_HEAD,
            "--quiet",
            "--no-tags",
            remoteName,
            `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
          ],
          {
            fallbackErrorMessage: "git fetch pull request branch failed",
          },
        ),
      );
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* withGitMutationPermitForCwd(
      input.cwd,
      runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        GIT_FETCH_NO_WRITE_FETCH_HEAD,
        "--quiet",
        "--no-tags",
        input.remoteName,
        remoteBranchFetchRefspec(input.remoteName, input.remoteBranch),
      ]),
    );

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* withGitMutationPermitForCwd(
        input.cwd,
        runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
          "fetch",
          GIT_FETCH_NO_WRITE_FETCH_HEAD,
          "--quiet",
          "--no-tags",
          input.remoteName,
          remoteBranchFetchRefspec(input.remoteName, input.remoteBranch),
        ]),
      );
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriverShape["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriverShape["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    // A worktree that has had its dependencies installed holds paths longer
    // than the Windows MAX_PATH limit. Without core.longpaths git deletes what
    // it can, drops the registration, and exits with "Filename too long",
    // leaving a dead folder that the app can no longer remove. The flag is a
    // no-op on other platforms.
    const args = ["-c", "core.longpaths=true", "worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    yield* executeGit("GitVcsDriver.removeWorktree", input.cwd, args, {
      timeoutMs: 15_000,
      fallbackErrorMessage: "git worktree remove failed",
    }).pipe(
      Effect.mapError((error) =>
        createGitCommandError(
          "GitVcsDriver.removeWorktree",
          input.cwd,
          args,
          `${quoteGitCommand(args)} failed (cwd: ${input.cwd}): ${error.message}`,
          error,
        ),
      ),
    );
  });

  const renameBranch: GitVcsDriver.GitVcsDriverShape["renameBranch"] = Effect.fn("renameBranch")(
    function* (input) {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitVcsDriver.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    },
  );

  const switchRef: GitVcsDriver.GitVcsDriverShape["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriverShape["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const createTag: GitVcsDriver.GitVcsDriverShape["createTag"] = Effect.fn("createTag")(
    function* (input) {
      const operation = "GitVcsDriver.createTag";
      const tagName = input.tagName.trim();
      const targetSha = input.targetSha.trim();
      const tagRefName = `refs/tags/${tagName}`;

      if (tagName.length === 0) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["tag", "--", tagName, targetSha],
          "Tag name is required.",
        );
      }

      const validRefName = yield* executeGit(
        `${operation}.validateName`,
        input.cwd,
        ["check-ref-format", tagRefName],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      if (!validRefName) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["check-ref-format", tagRefName],
          `Invalid tag name: ${tagName}`,
        );
      }

      const tagExists = yield* executeGit(
        `${operation}.tagExists`,
        input.cwd,
        ["show-ref", "--verify", "--quiet", tagRefName],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      if (tagExists) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["show-ref", "--verify", "--quiet", tagRefName],
          `Tag already exists: ${tagName}`,
        );
      }

      const targetExists = yield* executeGit(
        `${operation}.verifyTarget`,
        input.cwd,
        ["cat-file", "-e", `${targetSha}^{commit}`],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      if (!targetExists) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["cat-file", "-e", `${targetSha}^{commit}`],
          `Target commit was not found: ${targetSha}`,
        );
      }

      yield* executeGit(operation, input.cwd, ["tag", "--", tagName, targetSha], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git tag create failed",
      });

      const resolvedTargetSha = yield* runGitStdout(`${operation}.resolveTarget`, input.cwd, [
        "rev-parse",
        `${tagRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { tagName, targetSha: resolvedTargetSha };
    },
  );

  const deleteBranch: GitVcsDriver.GitVcsDriverShape["deleteBranch"] = Effect.fn("deleteBranch")(
    function* (input) {
      const operation = "GitVcsDriver.deleteBranch";
      const branchName = input.branchName.trim();
      const branchRefName = `refs/heads/${branchName}`;

      if (branchName.length === 0) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["branch", "--delete", "--", branchName],
          "Branch name is required.",
        );
      }

      const validRefName = yield* executeGit(
        `${operation}.validateName`,
        input.cwd,
        ["check-ref-format", branchRefName],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      if (!validRefName) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["check-ref-format", branchRefName],
          `Invalid branch name: ${branchName}`,
        );
      }

      const details = yield* statusDetails(input.cwd);
      if (!details.isRepo) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["branch", "--delete", "--", branchName],
          "Not a git repository.",
        );
      }
      if (details.branch === branchName) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["branch", "--delete", "--", branchName],
          `Cannot delete the checked out branch: ${branchName}`,
        );
      }

      const exists = yield* branchExists(input.cwd, branchName);
      if (!exists) {
        return yield* createGitCommandError(
          operation,
          input.cwd,
          ["show-ref", "--verify", "--quiet", branchRefName],
          `Branch was not found: ${branchName}`,
        );
      }

      yield* executeGit(operation, input.cwd, ["branch", "--delete", "--", branchName], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch delete failed",
      });

      return { branchName };
    },
  );

  const mergeRef: GitVcsDriver.GitVcsDriverShape["mergeRef"] = Effect.fn("mergeRef")(
    function* (input) {
      const details = yield* statusDetails(input.cwd);
      if (!details.isRepo) {
        return yield* createGitCommandError(
          "GitVcsDriver.mergeRef",
          input.cwd,
          ["merge", "--no-edit", input.refName],
          "Not a git repository.",
        );
      }
      if (!details.branch) {
        return yield* createGitCommandError(
          "GitVcsDriver.mergeRef",
          input.cwd,
          ["merge", "--no-edit", input.refName],
          "Cannot merge into a detached HEAD.",
        );
      }
      if (details.hasWorkingTreeChanges) {
        return yield* createGitCommandError(
          "GitVcsDriver.mergeRef",
          input.cwd,
          ["merge", "--no-edit", input.refName],
          "Commit or stash changes before merging.",
        );
      }

      yield* executeGit("GitVcsDriver.mergeRef", input.cwd, ["merge", "--no-edit", input.refName], {
        timeoutMs: 60_000,
        fallbackErrorMessage: "git merge failed",
      });

      return { refName: details.branch };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriverShape["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriverShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const withListRefsInvalidation = <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => effect.pipe(Effect.ensuring(invalidateListRefsSnapshot(cwd)));

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    prepareCommitContext,
    previewCommitContext,
    commit: (cwd, subject, body, options) =>
      withListRefsInvalidation(cwd, commit(cwd, subject, body, options)),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options)),
    pullCurrentBranch: (input) => withListRefsInvalidation(input.cwd, pullCurrentBranch(input)),
    listStashes,
    createStash,
    applyStash,
    dropStash,
    readRangeContext,
    readConfigValue,
    listRefs,
    listWorktrees,
    listWorktreeStatuses,
    commitGraph,
    commitDetails,
    workingTreeDiff,
    discardChanges,
    stageChanges,
    unstageChanges,
    createWorktree: (input) => withListRefsInvalidation(input.cwd, createWorktree(input)),
    resolveFreshWorktreeBase,
    fetchPullRequestBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchPullRequestBranch(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    fetchRemoteBranch: (input) => withListRefsInvalidation(input.cwd, fetchRemoteBranch(input)),
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    setBranchUpstream: (input) => withListRefsInvalidation(input.cwd, setBranchUpstream(input)),
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    createTag,
    deleteBranch: (input) => withListRefsInvalidation(input.cwd, deleteBranch(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    mergeRef: (input) => withListRefsInvalidation(input.cwd, mergeRef(input)),
    initRepo: (input) => withListRefsInvalidation(input.cwd, initRepo(input)),
    listLocalBranchNames,
  });
});
