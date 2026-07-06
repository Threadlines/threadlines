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
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsMergeRefInput,
  type VcsMergeRefResult,
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

export interface GitVcsDriverShape {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsRemote: (
    cwd: string,
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
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
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
        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["read-tree", "HEAD"],
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

        const message = `threadlines checkpoint ref=${input.checkpointRef}`;
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

      return result.stdout;
    }),

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
