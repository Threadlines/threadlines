import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCommitDetailsInput,
  type VcsCommitDetailsResult,
  type VcsCommitGraphInput,
  type VcsCommitGraphResult,
  type VcsDiscardChangesInput,
  type VcsDiscardChangesResult,
  type VcsStageChangesInput,
  type VcsStageChangesResult,
  type VcsUnstageChangesInput,
  type VcsUnstageChangesResult,
  type VcsWorkingTreeDiffInput,
  type VcsWorkingTreeDiffResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateTagInput,
  type VcsCreateTagResult,
  type VcsDeleteBranchInput,
  type VcsDeleteBranchResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListWorktreesInput,
  type VcsListWorktreesResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsMergeRefInput,
  type VcsMergeRefResult,
  type VcsApplyStashInput,
  type VcsApplyStashResult,
  type VcsCreateStashInput,
  type VcsCreateStashResult,
  type VcsDropStashInput,
  type VcsDropStashResult,
  type VcsListStashesInput,
  type VcsListStashesResult,
  type VcsPullInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@threadlines/contracts";
import { CHECKPOINT_REFS_PREFIX, LEGACY_CHECKPOINT_REFS_PREFIX } from "./checkpointRefs.ts";
import * as GitVcsDriverCore from "./GitVcsDriverCore.ts";
import { mergeRegionEditsIntoCurrent, parseUnifiedDiffRegions } from "./LineRegionMerge.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  headSha: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

/** Start point for a new worktree: a local branch or a remote-tracking ref. */
export interface GitWorktreeBaseRef {
  readonly refName: string;
  readonly isRemote: boolean;
}

export interface GitRemoteStatusOptions {
  readonly forceRefresh?: boolean;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

/**
 * One checkout of a repository, as reported by `git worktree list`. Only
 * entries whose directory still exists are surfaced.
 */
export interface GitWorktreeEntry {
  /** Absolute path to the checkout, exactly as git reported it. */
  readonly path: string;
  /** Short branch name, or null for a detached or bare checkout. */
  readonly branch: string | null;
}

export interface GitVcsDriverShape {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsRemote: (
    cwd: string,
    options?: GitRemoteStatusOptions,
  ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  readonly previewCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
    options?: { readonly remoteName?: string | null },
  ) => Effect.Effect<GitPushResult, GitCommandError>;
  readonly readRangeContext: (
    cwd: string,
    baseRef: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, GitCommandError>;
  /**
   * Enumerate the repository's checkouts. Returns an empty list when `cwd` is
   * not a git repository rather than failing, so best-effort callers do not
   * need their own guard.
   */
  readonly listWorktrees: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<GitWorktreeEntry>, GitCommandError>;
  /**
   * The same enumeration plus the state a cleanup decision needs: uncommitted
   * changes and commits the default branch cannot reach. One extra pair of git
   * calls per checkout, run sequentially -- a repository has a handful of
   * checkouts, not thousands.
   */
  readonly listWorktreeStatuses: (
    input: VcsListWorktreesInput,
  ) => Effect.Effect<VcsListWorktreesResult, GitCommandError>;
  readonly commitGraph: (
    input: VcsCommitGraphInput,
  ) => Effect.Effect<VcsCommitGraphResult, GitCommandError>;
  readonly commitDetails: (
    input: VcsCommitDetailsInput,
  ) => Effect.Effect<VcsCommitDetailsResult, GitCommandError>;
  readonly workingTreeDiff: (
    input: VcsWorkingTreeDiffInput,
  ) => Effect.Effect<VcsWorkingTreeDiffResult, GitCommandError>;
  readonly discardChanges: (
    input: VcsDiscardChangesInput,
  ) => Effect.Effect<VcsDiscardChangesResult, GitCommandError>;
  readonly stageChanges: (
    input: VcsStageChangesInput,
  ) => Effect.Effect<VcsStageChangesResult, GitCommandError>;
  readonly unstageChanges: (
    input: VcsUnstageChangesInput,
  ) => Effect.Effect<VcsUnstageChangesResult, GitCommandError>;
  readonly pullCurrentBranch: (
    input: VcsPullInput,
  ) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly listStashes: (
    input: VcsListStashesInput,
  ) => Effect.Effect<VcsListStashesResult, GitCommandError>;
  readonly createStash: (
    input: VcsCreateStashInput,
  ) => Effect.Effect<VcsCreateStashResult, GitCommandError>;
  readonly applyStash: (
    input: VcsApplyStashInput,
  ) => Effect.Effect<VcsApplyStashResult, GitCommandError>;
  readonly dropStash: (
    input: VcsDropStashInput,
  ) => Effect.Effect<VcsDropStashResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  /**
   * Where a worktree cut "from `branch`" should start. Fetches the branch's
   * upstream (best effort, bounded) and answers with the upstream ref when it
   * is strictly ahead of the local branch, so a thread started from `main`
   * begins at the latest `main` rather than at a stale local copy. The local
   * branch wins whenever it has commits of its own or has no upstream.
   */
  readonly resolveFreshWorktreeBase: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<GitWorktreeBaseRef, GitCommandError>;
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly fetchRemoteTrackingBranch: (
    input: GitFetchRemoteTrackingBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly createTag: (
    input: VcsCreateTagInput,
  ) => Effect.Effect<VcsCreateTagResult, GitCommandError>;
  readonly deleteBranch: (
    input: VcsDeleteBranchInput,
  ) => Effect.Effect<VcsDeleteBranchResult, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
  readonly mergeRef: (input: VcsMergeRefInput) => Effect.Effect<VcsMergeRefResult, GitCommandError>;
  readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
}

export class GitVcsDriver extends Context.Service<GitVcsDriver, GitVcsDriverShape>()(
  "threadlines/vcs/GitVcsDriver",
) {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const GIT_PATH_ARGS_MAX_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
// Enough HEAD moves to cover any one turn; a window with more is not trusted.
const CHECKPOINT_REFLOG_MAX_ENTRIES = 1_000;
// Windows caps a whole command line at 32,767 characters.
const CHECKPOINT_DIFF_PATHSPEC_MAX_BYTES = 16 * 1024;
const CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES = 16_000_000;
const CHECKPOINT_MIGRATION_MAX_OUTPUT_BYTES = 16_000_000;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function chunkPathsByByteBudget(
  relativePaths: ReadonlyArray<string>,
  maxChunkBytes: number,
): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > maxChunkBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= maxChunkBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

// Like chunkPathsByByteBudget, but never splits a group across chunks.
function chunkPathGroupsByByteBudget(
  groups: ReadonlyArray<ReadonlyArray<string>>,
  maxChunkBytes: number,
): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;
  for (const group of groups) {
    const groupBytes = group.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0);
    if (chunk.length > 0 && chunkBytes + groupBytes > maxChunkBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(...group);
    chunkBytes += groupBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  return chunkPathsByByteBudget(relativePaths, GIT_CHECK_IGNORE_MAX_STDIN_BYTES);
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const ZERO_OID_PATTERN = /^0+$/u;
// Regular file blobs only; symlinks (120000) and gitlinks (160000) are flagged
// so selective revert refuses to touch them.
const SUPPORTED_CHECKPOINT_ENTRY_MODES = new Set(["000000", "100644", "100755"]);

interface RawCheckpointEntry {
  readonly path: string;
  readonly fromOid: string | null;
  readonly toOid: string | null;
  readonly hasUnsupportedMode: boolean;
}

// Parses `git diff-tree -r -z --no-renames` output: NUL-separated pairs of
// ":<srcmode> <dstmode> <srcoid> <dstoid> <status>" followed by the path.
function parseDiffTreeEntries(stdout: string): RawCheckpointEntry[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const entries: RawCheckpointEntry[] = [];

  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const meta = tokens[index];
    const entryPath = tokens[index + 1];
    if (!meta?.startsWith(":") || !entryPath) {
      continue;
    }
    const [srcMode = "", dstMode = "", srcOid = "", dstOid = ""] = meta.slice(1).split(" ");
    if (srcOid.length < 40 || dstOid.length < 40) {
      continue;
    }
    entries.push({
      path: entryPath,
      fromOid: ZERO_OID_PATTERN.test(srcOid) ? null : srcOid,
      toOid: ZERO_OID_PATTERN.test(dstOid) ? null : dstOid,
      hasUnsupportedMode:
        !SUPPORTED_CHECKPOINT_ENTRY_MODES.has(srcMode) ||
        !SUPPORTED_CHECKPOINT_ENTRY_MODES.has(dstMode),
    });
  }

  return entries;
}

// Snapshot commits are parentless, so the commit HEAD pointed at when the
// snapshot was taken rides along as a trailer. Diffs use it to tell edits made
// in the checkout apart from history that moved HEAD (a merge, a checkout).
const CHECKPOINT_HEAD_TRAILER = "threadlines-head";

function checkpointCommitMessage(checkpointRef: string, headCommit: string | null): string {
  const subject = `threadlines checkpoint ref=${checkpointRef}`;
  return headCommit === null ? subject : `${subject}\n\n${CHECKPOINT_HEAD_TRAILER}: ${headCommit}`;
}

interface CheckpointCommitMetadata {
  /** HEAD when the snapshot was taken; null on an unborn branch or for older snapshots. */
  readonly head: string | null;
  /** Committer time of the snapshot commit, in epoch seconds. */
  readonly capturedAtSeconds: number | null;
}

// Parses `git cat-file commit` output for a snapshot commit.
function parseCheckpointCommitMetadata(raw: string): CheckpointCommitMetadata {
  const separator = raw.indexOf("\n\n");
  const headers = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? "" : raw.slice(separator + 2);
  const committer = /^committer .* (\d+) [+-]\d{4}$/mu.exec(headers);
  const trailer = new RegExp(`^${CHECKPOINT_HEAD_TRAILER}: ([0-9a-f]{40,64})$`, "mu").exec(body);
  return {
    head: trailer?.[1] ?? null,
    capturedAtSeconds: committer?.[1] === undefined ? null : Number(committer[1]),
  };
}

// Parses `git diff --numstat -z`: "<add>\t<del>\t<path>\0", or for a rename
// "<add>\t<del>\t\0<old>\0<new>\0". Binary files report "-" and count as zero.
// A rename is keyed by its new path, as the patch parser names it, and keeps
// its old one in `previousPath`.
function parseNumstatEntries(stdout: string): VcsDriver.VcsCheckpointFileStat[] {
  const tokens = stdout.split("\0");
  const entries: VcsDriver.VcsCheckpointFileStat[] = [];
  let index = 0;
  while (index < tokens.length) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(tokens[index] ?? "");
    index += 1;
    if (!match) {
      continue;
    }
    let entryPath = match[3] ?? "";
    let previousPath: string | undefined;
    if (entryPath.length === 0) {
      previousPath = tokens[index];
      entryPath = tokens[index + 1] ?? "";
      index += 2;
    }
    if (entryPath.length === 0) {
      continue;
    }
    entries.push({
      path: entryPath,
      ...(previousPath ? { previousPath } : {}),
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return entries;
}

// Wraps a repo-relative path so git treats it verbatim (no glob expansion).
function literalPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`;
}

const gitCommand = (
  process: VcsProcess.VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly appendTruncationMarker?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    // Merged onto the parent env by the process runner; git must fail fast
    // instead of prompting for credentials on a terminal we do not have.
    env: { GIT_TERMINAL_PROMPT: "0", ...options?.env },
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriverShape["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.catch(() => Effect.succeed(null)));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriverShape["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriverShape["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriverShape["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriverShape["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const readCheckpointMetadata = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.readCheckpointMetadata",
      cwd,
      args: ["cat-file", "commit", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
      maxOutputBytes: 64 * 1024,
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? parseCheckpointCommitMetadata(result.stdout) : null,
      ),
    );

  // Paths whose content differs between two tree-ish revisions, renames split
  // into their two sides.
  const listChangedPaths = (cwd: string, fromRevision: string, toRevision: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.listChangedPaths",
      cwd,
      args: ["diff-tree", "-r", "-z", "--no-renames", "--name-only", fromRevision, toRevision],
      maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? null : new Set(splitNullSeparatedPaths(result.stdout, false)),
      ),
    );

  // Pairs each path with its rename partner between two revisions (as plain
  // `git diff` detects renames), so a diff scoped to the path still sees the
  // rename instead of an added file.
  const groupPathsWithRenamePartners = Effect.fn(
    "GitVcsDriver.checkpoints.groupPathsWithRenamePartners",
  )(function* (
    cwd: string,
    fromRevision: string,
    toRevision: string,
    paths: ReadonlyArray<string>,
  ) {
    const result = yield* execute({
      operation: "GitVcsDriver.checkpoints.groupPathsWithRenamePartners",
      cwd,
      args: ["diff", "--name-status", "-z", "--no-ext-diff", fromRevision, toRevision],
      maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
    });
    const partners = new Map<string, string>();
    if (!result.stdoutTruncated) {
      const tokens = result.stdout.split("\0");
      let index = 0;
      while (index < tokens.length) {
        const status = tokens[index] ?? "";
        if (status.startsWith("R") || status.startsWith("C")) {
          const source = tokens[index + 1] ?? "";
          const target = tokens[index + 2] ?? "";
          if (status.startsWith("R") && source.length > 0 && target.length > 0) {
            partners.set(source, target);
            partners.set(target, source);
          }
          index += 3;
        } else {
          index += 2;
        }
      }
    }
    const grouped = new Set<string>();
    const groups: string[][] = [];
    for (const path of paths) {
      if (grouped.has(path)) {
        continue;
      }
      const partner = partners.get(path);
      const group = partner === undefined || grouped.has(partner) ? [path] : [path, partner];
      for (const member of group) {
        grouped.add(member);
      }
      groups.push(group);
    }
    return groups;
  });

  // Paths touched by commits made in this checkout since `sinceSeconds`, read
  // from HEAD's reflog, which only this checkout writes. `commit` entries
  // (amend and a hand-finished merge included) and `revert` create new work
  // here; merges, pulls, rebases, cherry-picks, checkouts and resets only move
  // HEAD through history that already existed. Merge commits contribute just
  // the paths their resolution changed (`--cc`). Null when the reflog cannot
  // vouch for the window -- logging disabled, no entry since the snapshot even
  // though HEAD moved, or more entries than we read -- or the answer is too
  // large to trust.
  const listPathsCommittedSince = Effect.fn("GitVcsDriver.checkpoints.listPathsCommittedSince")(
    function* (cwd: string, sinceSeconds: number) {
      const operation = "GitVcsDriver.checkpoints.listPathsCommittedSince";
      const reflogResult = yield* execute({
        operation,
        cwd,
        args: [
          "log",
          "--walk-reflogs",
          "--format=%H%x09%gd%x09%gs",
          "--date=unix",
          `--max-count=${CHECKPOINT_REFLOG_MAX_ENTRIES}`,
          "HEAD",
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
      });
      if (reflogResult.exitCode !== 0 || reflogResult.stdoutTruncated) {
        return null;
      }

      // Newest first. Each entry's older neighbor is the HEAD it replaced.
      const entries = reflogResult.stdout.split("\n").flatMap((line) => {
        const [commit = "", selector = "", ...subjectParts] = line.split("\t");
        const movedAt = Number(/@\{(\d+)\}$/u.exec(selector)?.[1]);
        return commit.length > 0 && Number.isFinite(movedAt)
          ? [{ commit, movedAt, subject: subjectParts.join("\t") }]
          : [];
      });
      const windowEnd = entries.findIndex((entry) => entry.movedAt < sinceSeconds);
      const inWindow = windowEnd === -1 ? entries : entries.slice(0, windowEnd);
      if (
        inWindow.length === 0 ||
        (windowEnd === -1 && entries.length >= CHECKPOINT_REFLOG_MAX_ENTRIES)
      ) {
        return null;
      }

      // One `diff-tree --stdin` line per commit made here. An amend is
      // compared with the commit it replaced rather than its parent, so an
      // amend that takes a change back out still counts that file.
      const diffLines: string[] = [];
      inWindow.forEach((entry, index) => {
        if (!/^(?:commit(?: \([a-z]+\))?|revert): /u.test(entry.subject)) {
          return;
        }
        const replaced = entries[index + 1]?.commit;
        diffLines.push(
          entry.subject.startsWith("commit (amend): ") && replaced !== undefined
            ? `${entry.commit} ${replaced}`
            : entry.commit,
        );
      });
      if (diffLines.length === 0) {
        return new Set<string>();
      }

      const pathsResult = yield* execute({
        operation,
        cwd,
        args: [
          "diff-tree",
          "--stdin",
          "-r",
          "-z",
          "--no-renames",
          "--name-only",
          "--no-commit-id",
          "--cc",
          "--root",
        ],
        stdin: `${diffLines.join("\n")}\n`,
        maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
      });
      return pathsResult.stdoutTruncated
        ? null
        : new Set(splitNullSeparatedPaths(pathsResult.stdout, false));
    },
  );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  // Checkpoint snapshots store repository-root-relative paths; selective
  // restore operations anchor path arguments at the worktree toplevel so a
  // session cwd inside a subdirectory still addresses the right files.
  const resolveWorktreeToplevel = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveWorktreeToplevel",
      cwd,
      args: ["rev-parse", "--show-toplevel"],
    }).pipe(Effect.map((result) => result.stdout.trim()));

  const isInsideToplevel = (toplevel: string, absolutePath: string) => {
    const relativePath = nodePath.relative(toplevel, absolutePath);
    return (
      relativePath === "" || (!relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath))
    );
  };

  const parseRefListing = (stdout: string): ReadonlyArray<string> =>
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const migrateLegacyCheckpointRefs = Effect.fn(
    "GitVcsDriver.checkpoints.migrateLegacyCheckpointRefs",
  )(function* (cwd: string) {
    const operation = "GitVcsDriver.checkpoints.migrateLegacyCheckpointRefs";
    const legacyListing = yield* execute({
      operation,
      cwd,
      args: ["for-each-ref", "--format=%(refname) %(objectname)", LEGACY_CHECKPOINT_REFS_PREFIX],
      allowNonZeroExit: true,
      maxOutputBytes: CHECKPOINT_MIGRATION_MAX_OUTPUT_BYTES,
    });
    if (legacyListing.exitCode !== 0) {
      return;
    }
    const legacyRefs = parseRefListing(legacyListing.stdout).flatMap((line) => {
      const [refName = "", objectId = ""] = line.split(" ");
      return refName.startsWith(`${LEGACY_CHECKPOINT_REFS_PREFIX}/`) && objectId.length >= 40
        ? [{ refName, objectId }]
        : [];
    });
    if (legacyRefs.length === 0) {
      return;
    }

    const currentListing = yield* execute({
      operation,
      cwd,
      args: ["for-each-ref", "--format=%(refname)", CHECKPOINT_REFS_PREFIX],
      maxOutputBytes: CHECKPOINT_MIGRATION_MAX_OUTPUT_BYTES,
    });
    const currentRefs = new Set(parseRefListing(currentListing.stdout));

    // Single atomic transaction: rename every legacy ref, but never clobber a
    // ref the current namespace already has (post-rename captures win).
    const commands: string[] = [];
    let migratedCount = 0;
    for (const { refName, objectId } of legacyRefs) {
      const targetRef = `${CHECKPOINT_REFS_PREFIX}${refName.slice(LEGACY_CHECKPOINT_REFS_PREFIX.length)}`;
      if (!currentRefs.has(targetRef)) {
        commands.push(`create ${targetRef} ${objectId}`);
        migratedCount += 1;
      }
      commands.push(`delete ${refName} ${objectId}`);
    }
    yield* execute({
      operation,
      cwd,
      args: ["update-ref", "--stdin"],
      stdin: `${commands.join("\n")}\n`,
      timeoutMs: 30_000,
    });
    yield* Effect.logInfo("migrated legacy checkpoint refs to the threadlines namespace", {
      cwd,
      migrated: migratedCount,
      supersededByCurrentRefs: legacyRefs.length - migratedCount,
    });
  });

  const attemptedLegacyCheckpointMigrations = new Set<string>();

  const ensureLegacyCheckpointRefsMigrated = (cwd: string): Effect.Effect<void> => {
    if (attemptedLegacyCheckpointMigrations.has(cwd)) {
      return Effect.void;
    }
    attemptedLegacyCheckpointMigrations.add(cwd);
    return migrateLegacyCheckpointRefs(cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("legacy checkpoint ref migration failed; will retry on restart", {
          cwd,
          error: String(error),
        }),
      ),
    );
  };

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.captureCheckpoint";
      yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
      const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
      const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${randomUUID()}`);
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "Threadlines",
        GIT_AUTHOR_EMAIL: "threadlines@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Threadlines",
        GIT_COMMITTER_EMAIL: "threadlines@users.noreply.github.com",
      };

      const cleanupTempIndex = fileSystem
        .remove(tempIndexPath, { force: true })
        .pipe(Effect.ignore);

      yield* Effect.gen(function* () {
        // Read by oid so the recorded head is exactly the commit the snapshot
        // was layered on, even if HEAD moves while the capture runs.
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit !== null) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["read-tree", headCommit],
            env: commitEnv,
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = checkpointCommitMessage(input.checkpointRef, headCommit);
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }).pipe(Effect.ensuring(cleanupTempIndex));
    }),

    hasCheckpointRef: Effect.fn("GitVcsDriver.checkpoints.hasCheckpointRef")(function* (input) {
      yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
      return (yield* resolveCheckpointCommit(input.cwd, input.checkpointRef)) !== null;
    }),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";
      yield* ensureLegacyCheckpointRefsMigrated(input.cwd);

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    }),

    resolveCheckpointCommit: Effect.fn("GitVcsDriver.checkpoints.resolveCheckpointCommit")(
      function* (input) {
        yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
        const commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (commitOid) {
          return commitOid;
        }
        if (input.fallbackToHead === true) {
          return yield* resolveHeadCommit(input.cwd);
        }
        return null;
      },
    ),

    diffCheckpointEntries: Effect.fn("GitVcsDriver.checkpoints.diffCheckpointEntries")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.diffCheckpointEntries";
        const result = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["diff-tree", "-r", "-z", "--no-renames", input.fromCommit, input.toCommit],
          maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
        });
        if (result.stdoutTruncated) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git diff-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "Checkpoint entry listing exceeded the output limit.",
          });
        }
        return parseDiffTreeEntries(result.stdout);
      },
    ),

    hashWorktreePaths: Effect.fn("GitVcsDriver.checkpoints.hashWorktreePaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.hashWorktreePaths";
      if (input.paths.length === 0) {
        return [];
      }
      const toplevel = yield* resolveWorktreeToplevel(input.cwd);

      const kinds = new Map<string, VcsDriver.VcsWorktreePathKind>();
      const hashablePaths: string[] = [];
      for (const relativePath of input.paths) {
        const info = yield* fileSystem
          .stat(path.join(toplevel, relativePath))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (info === null) {
          kinds.set(relativePath, "missing");
        } else if (info.type === "File") {
          kinds.set(relativePath, "file");
          hashablePaths.push(relativePath);
        } else {
          kinds.set(relativePath, "other");
        }
      }

      const oids = new Map<string, string>();
      for (const chunk of chunkPathsByByteBudget(hashablePaths, GIT_PATH_ARGS_MAX_BYTES)) {
        const result = yield* execute({
          operation,
          cwd: toplevel,
          args: ["hash-object", "--stdin-paths"],
          stdin: `${chunk.join("\n")}\n`,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        });
        const lines = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (lines.length !== chunk.length) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git hash-object",
            cwd: input.cwd,
            exitCode: 0,
            detail: `Expected ${chunk.length} hashes but received ${lines.length}.`,
          });
        }
        chunk.forEach((relativePath, index) => {
          oids.set(relativePath, lines[index] ?? "");
        });
      }

      return input.paths.map((relativePath) => {
        const kind = kinds.get(relativePath) ?? "missing";
        const oid = kind === "file" ? (oids.get(relativePath) ?? null) : null;
        return { path: relativePath, kind, oid };
      });
    }),

    restoreCheckpointPaths: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpointPaths")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.restoreCheckpointPaths";
        if (input.restorePaths.length === 0 && input.deletePaths.length === 0) {
          return;
        }
        const toplevel = yield* resolveWorktreeToplevel(input.cwd);

        for (const chunk of chunkPathsByByteBudget(input.restorePaths, GIT_PATH_ARGS_MAX_BYTES)) {
          yield* execute({
            operation,
            cwd: toplevel,
            args: [
              "restore",
              "--source",
              input.checkpointCommit,
              "--worktree",
              "--staged",
              "--",
              ...chunk.map(literalPathspec),
            ],
          });
        }

        for (const relativePath of input.deletePaths) {
          const absolutePath = nodePath.resolve(toplevel, relativePath);
          if (!isInsideToplevel(toplevel, absolutePath)) {
            return yield* new VcsProcessExitError({
              operation,
              command: "rm",
              cwd: input.cwd,
              exitCode: 1,
              detail: `Refusing to delete a path outside the worktree: ${relativePath}`,
            });
          }
          yield* fileSystem.remove(absolutePath, { force: true }).pipe(
            Effect.mapError(
              (error) =>
                new VcsProcessExitError({
                  operation,
                  command: "rm",
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: `Failed to delete '${relativePath}': ${error.message}`,
                }),
            ),
          );
        }

        // Mirror whole-checkout restore semantics: the index ends up matching
        // HEAD for the touched paths, leaving the revert as unstaged changes.
        const headExists = yield* hasHeadCommit(toplevel);
        if (headExists) {
          const touchedPaths = [...input.restorePaths, ...input.deletePaths];
          for (const chunk of chunkPathsByByteBudget(touchedPaths, GIT_PATH_ARGS_MAX_BYTES)) {
            yield* execute({
              operation,
              cwd: toplevel,
              args: ["reset", "--quiet", "--", ...chunk.map(literalPathspec)],
              allowNonZeroExit: true,
            });
          }
        }
      },
    ),

    // Undoes one or more of a file's snapshot transitions on the current
    // worktree file via exact coordinate merges. Each step's change
    // (fromCommit -> toCommit) and the drift between that step's base and
    // the evolving content are expressed against the same base, so disjoint
    // regions merge deterministically — including edits that merely touch,
    // like two sessions appending consecutive blocks at the end of a file,
    // which `git apply` and 3-way merges reject. Multi-step inputs roll a
    // thread's turns back one at a time so foreign edits made between turns
    // survive. All steps compose in memory and are written once; on any
    // overlap, verification mismatch, or content the parser cannot interpret
    // exactly (binary, missing-newline markers) the file is left untouched
    // and false is returned.
    restoreCheckpointFileEdits: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpointFileEdits")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.restoreCheckpointFileEdits";
        if (input.steps.length === 0) {
          return false;
        }
        const toplevel = yield* resolveWorktreeToplevel(input.cwd);

        // -U0 keeps regions minimal so nearby-but-separate edits stay
        // mergeable instead of fusing into one conflicting hunk.
        const diffArgs = (fromRevision: string, toRevision: string, pathspecs: string[]) => [
          "diff",
          "-U0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          fromRevision,
          toRevision,
          ...pathspecs,
        ];

        // The merged result is written back as UTF-8 text; refuse anything
        // that does not round-trip so untouched bytes can never be mangled.
        const absolutePath = path.join(toplevel, input.path);
        const contentBytes = yield* fileSystem
          .readFile(absolutePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (contentBytes === null) {
          return false;
        }
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes);
        } catch {
          return false;
        }
        const endsWithNewline = content.endsWith("\n");

        let currentLines = content.split("\n");
        if (endsWithNewline) {
          currentLines.pop();
        }
        let appliedStepCount = 0;

        for (const step of input.steps) {
          const inversePatch = yield* execute({
            operation,
            cwd: toplevel,
            args: diffArgs(step.fromCommit, step.toCommit, ["--", literalPathspec(input.path)]),
            maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          });
          if (inversePatch.stdoutTruncated) {
            return false;
          }
          const editRegions = parseUnifiedDiffRegions(inversePatch.stdout);
          if (editRegions === null) {
            return false;
          }
          if (editRegions.length === 0) {
            // The snapshots are identical for this path; nothing to undo.
            continue;
          }

          // Drift is diffed blob-to-blob: comparing the snapshot commit
          // against the worktree would consult the index and misreport files
          // that are not tracked there (e.g. created by an agent and never
          // staged) as deleted.
          const baseBlobResult = yield* execute({
            operation,
            cwd: toplevel,
            args: ["rev-parse", "--verify", "--quiet", `${step.fromCommit}:${input.path}`],
            allowNonZeroExit: true,
          });
          const baseBlobOid = baseBlobResult.exitCode === 0 ? baseBlobResult.stdout.trim() : "";
          if (baseBlobOid.length === 0) {
            return false;
          }
          const evolvingContent =
            currentLines.length === 0
              ? ""
              : currentLines.join("\n") + (endsWithNewline ? "\n" : "");
          const currentBlobResult = yield* execute({
            operation,
            cwd: toplevel,
            args: ["hash-object", "-w", "--stdin"],
            stdin: evolvingContent,
          });
          const currentBlobOid = currentBlobResult.stdout.trim();
          if (currentBlobOid.length === 0) {
            return false;
          }

          let driftRegions: ReturnType<typeof parseUnifiedDiffRegions> = [];
          if (currentBlobOid !== baseBlobOid) {
            const driftPatch = yield* execute({
              operation,
              cwd: toplevel,
              args: diffArgs(baseBlobOid, currentBlobOid, []),
              maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
            });
            if (driftPatch.stdoutTruncated) {
              return false;
            }
            driftRegions = parseUnifiedDiffRegions(driftPatch.stdout);
          }
          if (driftRegions === null) {
            return false;
          }

          const mergedLines = mergeRegionEditsIntoCurrent({
            editRegions,
            driftRegions,
            currentLines,
          });
          if (mergedLines === null) {
            return false;
          }
          currentLines = mergedLines;
          appliedStepCount += 1;
        }

        if (appliedStepCount === 0) {
          return false;
        }
        if (input.dryRun === true) {
          return true;
        }

        const nextContent =
          currentLines.length === 0 ? "" : currentLines.join("\n") + (endsWithNewline ? "\n" : "");
        yield* fileSystem.writeFileString(absolutePath, nextContent).pipe(
          Effect.mapError(
            (error) =>
              new VcsProcessExitError({
                operation,
                command: "write",
                cwd: input.cwd,
                exitCode: 1,
                detail: `Failed to write merged content for '${input.path}': ${error.message}`,
              }),
          ),
        );

        // Mirror whole-checkout restore semantics for the touched path.
        const headExists = yield* hasHeadCommit(toplevel);
        if (headExists) {
          yield* execute({
            operation,
            cwd: toplevel,
            args: ["reset", "--quiet", "--", literalPathspec(input.path)],
            allowNonZeroExit: true,
          });
        }

        return true;
      },
    ),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
        "checkpoint.file_path_count": input.filePaths?.length,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      // Patches are per file, so a long path list can run as several diffs
      // whose output concatenates cleanly; that keeps each command line under
      // Windows' limit. A rename only reads as one when both of its paths are
      // in the same diff, so each requested path travels with its partner.
      const pathspecChunks =
        input.filePaths === undefined
          ? [undefined]
          : chunkPathGroupsByByteBudget(
              yield* groupPathsWithRenamePartners(
                input.cwd,
                `${fromRevision}^{commit}`,
                `${input.toCheckpointRef}^{commit}`,
                input.filePaths,
              ),
              CHECKPOINT_DIFF_PATHSPEC_MAX_BYTES,
            ).map((chunk) => chunk.map(literalPathspec));
      const patches: string[] = [];
      for (const pathspecs of pathspecChunks) {
        const result = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            "diff",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            `${fromRevision}^{commit}`,
            `${input.toCheckpointRef}^{commit}`,
            ...(pathspecs === undefined ? [] : ["--", ...pathspecs]),
          ],
          allowNonZeroExit: true,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });

        if (result.exitCode !== 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git diff",
            cwd: input.cwd,
            exitCode: result.exitCode,
            detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
          });
        }
        patches.push(result.stdout);
      }

      return patches.join("");
    }),

    // A path counts as head movement when HEAD changed it between the two
    // snapshots and the checkout matched HEAD for it on both sides, so the
    // whole change is history (a merge, pull, rebase, cherry-pick, checkout,
    // or reset), not an edit. Paths touched by commits made in the checkout in
    // between stay edits. Any uncertainty (older snapshots without a recorded
    // head, an unusable reflog, oversized output) answers with no paths, which
    // keeps the plain snapshot diff.
    listHeadMovementPaths: Effect.fn("GitVcsDriver.checkpoints.listHeadMovementPaths")(
      function* (input) {
        yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
        const from = yield* readCheckpointMetadata(input.cwd, input.fromCheckpointRef);
        const to = yield* readCheckpointMetadata(input.cwd, input.toCheckpointRef);
        if (!from?.head || !to?.head || from.head === to.head || from.capturedAtSeconds === null) {
          return [];
        }

        const moved = yield* listChangedPaths(input.cwd, from.head, to.head);
        if (moved === null || moved.size === 0) {
          return [];
        }
        const editedBefore = yield* listChangedPaths(
          input.cwd,
          from.head,
          `${input.fromCheckpointRef}^{commit}`,
        );
        const editedAfter = yield* listChangedPaths(
          input.cwd,
          to.head,
          `${input.toCheckpointRef}^{commit}`,
        );
        if (editedBefore === null || editedAfter === null) {
          return [];
        }
        const candidates = [...moved].filter(
          (candidate) => !editedBefore.has(candidate) && !editedAfter.has(candidate),
        );
        if (candidates.length === 0) {
          return [];
        }

        const committedHere = yield* listPathsCommittedSince(input.cwd, from.capturedAtSeconds);
        if (committedHere === null) {
          return [];
        }
        return candidates.filter((candidate) => !committedHere.has(candidate));
      },
    ),

    // Per-path line counts between a snapshot and the HEAD it was layered on:
    // what was uncommitted in the checkout at that moment, untracked files
    // included. Null for snapshots without a recorded head.
    diffCheckpointAgainstHead: Effect.fn("GitVcsDriver.checkpoints.diffCheckpointAgainstHead")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.diffCheckpointAgainstHead";
        yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
        const metadata = yield* readCheckpointMetadata(input.cwd, input.checkpointRef);
        if (!metadata?.head) {
          return null;
        }
        const result = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            "diff",
            "--numstat",
            "-z",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            metadata.head,
            `${input.checkpointRef}^{commit}`,
          ],
          maxOutputBytes: CHECKPOINT_ENTRIES_MAX_OUTPUT_BYTES,
        });
        return result.stdoutTruncated ? null : parseNumstatEntries(result.stdout);
      },
    ),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* ensureLegacyCheckpointRefsMigrated(input.cwd);
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return VcsDriver.VcsDriver.of({
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  });
});

export const makeVcsDriver = Effect.fn("makeGitVcsDriver")(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.fn("makeGitVcsDriverService")(function* () {
  const git = yield* GitVcsDriverCore.makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver());
export const layer = Layer.effect(GitVcsDriver, make());
