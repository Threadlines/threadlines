/**
 * ClaudeSessionTranscripts — locate and repair Claude Code session transcripts.
 *
 * Claude Code stores each conversation as
 * `<config-dir>/projects/<cwd-slug>/<session-id>.jsonl`, and `--resume` only
 * searches the project directory derived from the *current* cwd. When a
 * thread's working directory disappears between turns (a merged-and-removed
 * worktree is the common case), the next resume runs from a different cwd and
 * fails with "No conversation found with session ID" even though the
 * transcript still exists under the old cwd's slug — and every retry fails
 * the same way. `ensureClaudeSessionTranscript` runs before a native resume:
 * it copies the transcript into the expected project directory when it lives
 * under another one, or reports it missing so the caller can start a fresh
 * session instead of failing forever.
 *
 * @module provider/Drivers/ClaudeSessionTranscripts
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/**
 * Directory Claude Code keeps its state in: `$CLAUDE_CONFIG_DIR` when set,
 * otherwise `<home>/.claude` where home honors a `HOME` override in the
 * session environment (Threadlines sets one for instances with a custom
 * `homePath`).
 */
export function resolveClaudeConfigDir(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const configured = environment["CLAUDE_CONFIG_DIR"]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const home = environment["HOME"]?.trim();
  return path.join(home && home.length > 0 ? home : NodeOS.homedir(), ".claude");
}

/**
 * Claude Code's per-cwd project directory name: the absolute cwd with every
 * non-alphanumeric character replaced by `-` (verified against Claude Code's
 * on-disk layout; e.g. `/Users/will/repo` → `-Users-will-repo`).
 */
export function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export type ClaudeTranscriptResolution =
  | { readonly outcome: "present"; readonly transcriptPath: string }
  | {
      readonly outcome: "relocated";
      readonly transcriptPath: string;
      readonly sourcePath: string;
    }
  | { readonly outcome: "missing" };

/**
 * Make the transcript for `sessionId` resumable from `cwd`, copying it from
 * another project directory if that is where it lives. Returns `missing`
 * when no project directory holds the transcript — resuming would fail, so
 * the caller should start a fresh session instead.
 */
export const ensureClaudeSessionTranscript = Effect.fn("ensureClaudeSessionTranscript")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly sessionId: string;
  }): Effect.fn.Return<
    ClaudeTranscriptResolution,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsDir = path.join(resolveClaudeConfigDir(input.environment, path), "projects");
    const transcriptFileName = `${input.sessionId}.jsonl`;
    const expectedDir = path.join(projectsDir, claudeProjectDirectoryName(input.cwd));
    const expectedPath = path.join(expectedDir, transcriptFileName);

    if (yield* fileSystem.exists(expectedPath)) {
      return { outcome: "present", transcriptPath: expectedPath };
    }

    const projectDirectories = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
    for (const entry of projectDirectories) {
      const candidate = path.join(projectsDir, entry, transcriptFileName);
      const found = yield* fileSystem
        .exists(candidate)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!found) {
        continue;
      }
      yield* fileSystem.makeDirectory(expectedDir, { recursive: true });
      yield* fileSystem.copyFile(candidate, expectedPath);
      return { outcome: "relocated", transcriptPath: expectedPath, sourcePath: candidate };
    }

    return { outcome: "missing" };
  },
);
