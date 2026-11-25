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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  CLAUDE_GOAL_TRANSCRIPT_MARKER,
  type ClaudeGoalRecord,
  parseClaudeGoalTranscript,
  parseClaudeGoalTranscriptLine,
} from "./ClaudeGoals.ts";

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
    const found = yield* findClaudeSessionTranscript(input);
    if (found === undefined) {
      return { outcome: "missing" };
    }
    if (found.transcriptPath === found.expectedPath) {
      return { outcome: "present", transcriptPath: found.expectedPath };
    }
    yield* fileSystem.makeDirectory(path.dirname(found.expectedPath), { recursive: true });
    yield* fileSystem.copyFile(found.transcriptPath, found.expectedPath);
    return {
      outcome: "relocated",
      transcriptPath: found.expectedPath,
      sourcePath: found.transcriptPath,
    };
  },
);

/** Where a session's transcript is: under the cwd's project directory when
 *  it is there, otherwise under whichever project directory holds it. */
const findClaudeSessionTranscript = Effect.fn("findClaudeSessionTranscript")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly sessionId: string;
}): Effect.fn.Return<
  { readonly transcriptPath: string; readonly expectedPath: string } | undefined,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsDir = path.join(resolveClaudeConfigDir(input.environment, path), "projects");
  const transcriptFileName = `${input.sessionId}.jsonl`;
  const expectedPath = path.join(
    projectsDir,
    claudeProjectDirectoryName(input.cwd),
    transcriptFileName,
  );
  if (yield* fileSystem.exists(expectedPath)) {
    return { transcriptPath: expectedPath, expectedPath };
  }
  const projectDirectories = yield* fileSystem
    .readDirectory(projectsDir)
    .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
  const matches = yield* Effect.forEach(
    projectDirectories,
    (entry) => {
      const candidate = path.join(projectsDir, entry, transcriptFileName);
      return fileSystem.exists(candidate).pipe(
        Effect.map((exists) => (exists ? candidate : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    },
    { concurrency: 16 },
  );
  const foundPath = matches.find((candidate): candidate is string => candidate !== undefined);
  return foundPath !== undefined ? { transcriptPath: foundPath, expectedPath } : undefined;
});

/** The transcript a running session writes to, without moving anything.
 *  Undefined while Claude has not written it yet. */
export const locateClaudeSessionTranscript = Effect.fn("locateClaudeSessionTranscript")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly sessionId: string;
  }) {
    return (yield* findClaudeSessionTranscript(input))?.transcriptPath;
  },
);

const READ_CHUNK_BYTES = 64 * 1_024;

/** `length` bytes of a transcript from `offset`, or fewer at its end. */
export function readClaudeTranscriptRange(
  fileSystem: FileSystem.FileSystem,
  transcriptPath: string,
  offset: bigint,
  length: bigint,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(transcriptPath);
      yield* file.seek(offset, "start");
      const chunks: Uint8Array[] = [];
      let remaining = length;
      let bytesRead = 0;
      while (remaining > 0n) {
        const requestedBytes = Number(
          remaining > BigInt(READ_CHUNK_BYTES) ? BigInt(READ_CHUNK_BYTES) : remaining,
        );
        const chunk = yield* file.readAlloc(requestedBytes);
        if (Option.isNone(chunk) || chunk.value.length === 0) {
          break;
        }
        chunks.push(chunk.value);
        bytesRead += chunk.value.length;
        remaining -= BigInt(chunk.value.length);
      }
      const result = new Uint8Array(bytesRead);
      let writeOffset = 0;
      for (const chunk of chunks) {
        result.set(chunk, writeOffset);
        writeOffset += chunk.length;
      }
      return result;
    }),
  );
}

/**
 * Goal records Claude appended to a transcript since `offset`, and the offset
 * to read from next. Only complete lines count: a line still being written is
 * read next time. Undefined when the transcript cannot be read.
 */
export const readClaudeTranscriptGoalRecords = Effect.fn("readClaudeTranscriptGoalRecords")(
  function* (input: {
    readonly transcriptPath: string;
    readonly offset: bigint;
  }): Effect.fn.Return<
    { readonly records: ReadonlyArray<ClaudeGoalRecord>; readonly nextOffset: bigint } | undefined,
    never,
    FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const size = (yield* fileSystem.stat(input.transcriptPath)).size;
      // A transcript only grows; a smaller one was replaced, and what it held
      // before is not this session's news.
      if (size <= input.offset) {
        return { records: [], nextOffset: size };
      }
      const bytes = yield* readClaudeTranscriptRange(
        fileSystem,
        input.transcriptPath,
        input.offset,
        size - input.offset,
      );
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return { records: [], nextOffset: input.offset };
      }
      const complete = new TextDecoder().decode(bytes.subarray(0, lastNewline + 1));
      return {
        records: parseClaudeGoalTranscript(complete),
        nextOffset: input.offset + BigInt(lastNewline + 1),
      };
    }).pipe(Effect.orElseSucceed(() => undefined));
  },
);

const WORKTREE_STATE_MARKER_BYTES = Buffer.from('"type":"worktree-state"', "utf8");
const GOAL_TRANSCRIPT_MARKER_BYTES = Buffer.from(CLAUDE_GOAL_TRANSCRIPT_MARKER, "utf8");
const VERSION_MARKER_BYTES = Buffer.from('"version":"', "utf8");
const NEWLINE_BYTE = 0x0a;
const QUOTE_BYTE = 0x22;

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function decodeLineSlice(buffer: Buffer, lineStart: number, lineEnd: number): string {
  const effectiveStart = lineStart === 0 && hasUtf8Bom(buffer) ? 3 : lineStart;
  return buffer.toString("utf8", effectiveStart, lineEnd);
}

/**
 * The worktree a Claude session was last inside, as its transcript records it.
 *
 * Claude Code appends a `worktree-state` line when EnterWorktree moves the
 * session and a cleared one when it leaves, and a plain `--resume` re-enters
 * the last recorded worktree regardless of the cwd it is launched from. A
 * forked resume skips that restore. Returns the worktree path, `null` when the
 * session is not in one, or `undefined` when the record cannot be read.
 */
function transcriptWorktreePathFromBytes(buffer: Buffer): string | null | undefined {
  const markerIndex = buffer.lastIndexOf(WORKTREE_STATE_MARKER_BYTES);
  if (markerIndex < 0) return null;
  const lineStart = buffer.lastIndexOf(NEWLINE_BYTE, markerIndex) + 1;
  const lineEnd = buffer.indexOf(NEWLINE_BYTE, markerIndex);
  try {
    const record = JSON.parse(
      decodeLineSlice(buffer, lineStart, lineEnd < 0 ? buffer.length : lineEnd),
    ) as { readonly worktreeSession?: { readonly worktreePath?: unknown } | null };
    const worktreePath = record.worktreeSession?.worktreePath;
    return typeof worktreePath === "string" && worktreePath.length > 0 ? worktreePath : null;
  } catch {
    return undefined;
  }
}

function parseClaudeGoalRecordsFromBytes(completeBuffer: Buffer): ReadonlyArray<ClaudeGoalRecord> {
  const records: Array<ClaudeGoalRecord> = [];
  let searchFrom = 0;
  while (searchFrom < completeBuffer.length) {
    const markerIndex = completeBuffer.indexOf(GOAL_TRANSCRIPT_MARKER_BYTES, searchFrom);
    if (markerIndex < 0) break;
    const lineStart = completeBuffer.lastIndexOf(NEWLINE_BYTE, markerIndex) + 1;
    const lineEnd = completeBuffer.indexOf(NEWLINE_BYTE, markerIndex);
    const sliceEnd = lineEnd < 0 ? completeBuffer.length : lineEnd;
    const record = parseClaudeGoalTranscriptLine(
      decodeLineSlice(completeBuffer, lineStart, sliceEnd),
    );
    if (record !== undefined) records.push(record);
    if (lineEnd < 0) break;
    searchFrom = lineEnd + 1;
  }
  return records;
}

function transcriptCliVersionFromBytes(buffer: Buffer): string | undefined {
  const markerIndex = buffer.lastIndexOf(VERSION_MARKER_BYTES);
  if (markerIndex < 0) return undefined;
  const valueStart = markerIndex + VERSION_MARKER_BYTES.length;
  const quoteEnd = buffer.indexOf(QUOTE_BYTE, valueStart);
  if (quoteEnd <= valueStart) return undefined;
  return buffer.toString("utf8", valueStart, quoteEnd);
}

/**
 * What a session being resumed needs from its transcript, in one read: the
 * worktree it was last in (see `transcriptWorktreePathFromBytes`), every goal
 * record (see ClaudeGoals.ts), where its complete lines end (where reading for
 * new goal records picks up), and the Claude Code version that wrote it last.
 * Undefined when the transcript cannot be read.
 */
export const readClaudeTranscriptResumeFacts = Effect.fn("readClaudeTranscriptResumeFacts")(
  function* (transcriptPath: string): Effect.fn.Return<
    | {
        readonly worktreePath: string | null | undefined;
        readonly goalRecords: ReadonlyArray<ClaudeGoalRecord>;
        readonly size: bigint;
        /** A line was still being written when this was read. */
        readonly endsMidLine: boolean;
        /** The Claude Code that last wrote the transcript, when it says. */
        readonly cliVersion: string | undefined;
      }
    | undefined,
    never,
    FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem
      .readFile(transcriptPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (bytes === undefined) return undefined;
    // Scan raw UTF-8 bytes for ASCII markers so multi-megabyte transcripts do
    // not allocate full-file JS strings on resume.
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // A line Claude is still writing is read later, from its start.
    const completeLength = buffer.lastIndexOf(NEWLINE_BYTE) + 1;
    return {
      worktreePath: transcriptWorktreePathFromBytes(buffer),
      goalRecords: parseClaudeGoalRecordsFromBytes(buffer.subarray(0, completeLength)),
      size: BigInt(completeLength),
      endsMidLine: completeLength < buffer.length,
      cliVersion: transcriptCliVersionFromBytes(buffer),
    };
  },
);
