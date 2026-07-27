/**
 * ClaudeSubagentTranscripts — locate and incrementally read Claude Code subagent transcripts.
 *
 * Claude Code stores subagents below a session directory, but resumed
 * sessions can keep writing under the project slug where they were created.
 * Agent files may also use Claude's internal agent id instead of the spawning
 * tool_use id and workflow agents add one directory of nesting. This module
 * resolves those layouts deterministically and retains parsed append-only
 * transcript state so polling does not re-read the full JSONL file.
 *
 * @module provider/Drivers/ClaudeSubagentTranscripts
 */
import type { ProviderSubagentTranscriptEntry } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { claudeProjectDirectoryName, resolveClaudeConfigDir } from "./ClaudeSessionTranscripts.ts";

/** Record-to-entry mapping lives with the Claude adapter, which owns the
 *  provider's message shapes. It is injected so this driver does not import
 *  back into the layer that uses it. */
export type ClaudeSubagentTranscriptLineMapper = (lines: Iterable<string>) => {
  readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
  /** Model the mapped records were produced by, when they state one. */
  readonly model?: string;
};

export interface ClaudeSubagentTranscriptMeta {
  readonly agentType?: string;
  readonly description?: string;
  readonly toolUseId?: string;
  readonly model?: string;
  readonly spawnDepth?: number;
}

export interface ClaudeSubagentTranscriptLocation {
  readonly transcriptPath: string;
  /** The on-disk agent id, which may differ from the requested id. */
  readonly agentId: string;
  readonly meta?: ClaudeSubagentTranscriptMeta;
}

const RESOLUTION_CACHE_MAX_ENTRIES = 64;
const READ_CACHE_MAX_PATHS = 16;
const RETAINED_ENTRY_LIMIT = 5_000;
const READ_CHUNK_BYTES = 64 * 1_024;

const resolutionCache = new Map<string, ClaudeSubagentTranscriptLocation>();

interface TranscriptReadCacheEntry {
  readonly size: bigint;
  readonly mtimeMs: number;
  readonly parsedBytes: bigint;
  readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
  readonly droppedEntries: number;
  readonly model?: string;
}

const readCache = new Map<string, TranscriptReadCacheEntry>();

function setCappedMapEntry<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      return;
    }
    cache.delete(oldest.value);
  }
}

function parseMeta(value: string): ClaudeSubagentTranscriptMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  // Sidecars are written by the provider and their shape drifts between
  // releases. Every field is read independently so one unexpected value never
  // costs us the toolUseId this module resolves by.
  const readOptionalString = (key: string): string | undefined => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim()
      : undefined;
  };
  const agentType = readOptionalString("agentType");
  const description = readOptionalString("description");
  const toolUseId = readOptionalString("toolUseId");
  const model = readOptionalString("model");
  const rawSpawnDepth = record["spawnDepth"];
  const spawnDepth =
    typeof rawSpawnDepth === "number" && Number.isInteger(rawSpawnDepth) && rawSpawnDepth >= 0
      ? rawSpawnDepth
      : undefined;
  return {
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(model ? { model } : {}),
    ...(spawnDepth !== undefined ? { spawnDepth } : {}),
  };
}

function fileExists(fileSystem: FileSystem.FileSystem, candidate: string) {
  return fileSystem.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)));
}

function readMetaFile(fileSystem: FileSystem.FileSystem, metaPath: string) {
  return fileSystem.readFileString(metaPath).pipe(
    Effect.map(parseMeta),
    Effect.catch(() => Effect.succeed<ClaudeSubagentTranscriptMeta | undefined>(undefined)),
  );
}

/**
 * Resolve an on-disk agent id or spawning tool_use id across all project
 * slugs that can own a session transcript.
 */
export const locateClaudeSubagentTranscript = Effect.fn("locateClaudeSubagentTranscript")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly sessionId: string;
    /** On-disk agent id or the spawning tool_use id. */
    readonly agentId: string;
  }): Effect.fn.Return<
    ClaudeSubagentTranscriptLocation | null,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cacheKey = `${input.sessionId}\0${input.agentId}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached && (yield* fileExists(fileSystem, cached.transcriptPath))) {
      return cached;
    }
    if (cached) {
      resolutionCache.delete(cacheKey);
    }

    const projectsDir = path.join(resolveClaudeConfigDir(input.environment, path), "projects");
    const expectedProject = claudeProjectDirectoryName(input.cwd);
    const projectEntries = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.catch(() => Effect.succeed<Array<string>>([])));
    const projectDirectories = [
      expectedProject,
      ...projectEntries.filter((entry) => entry !== expectedProject).sort(),
    ];

    for (const projectDirectory of projectDirectories) {
      const searchRoot = path.join(projectsDir, projectDirectory, input.sessionId, "subagents");
      if (!(yield* fileExists(fileSystem, searchRoot))) {
        continue;
      }
      const workflowsRoot = path.join(searchRoot, "workflows");
      const workflowEntries = yield* fileSystem
        .readDirectory(workflowsRoot)
        .pipe(Effect.catch(() => Effect.succeed<Array<string>>([])));
      const searchedDirectories = [
        searchRoot,
        ...workflowEntries.sort().map((entry) => path.join(workflowsRoot, entry)),
      ];

      for (const searchedDirectory of searchedDirectories) {
        const directTranscriptPath = path.join(searchedDirectory, `agent-${input.agentId}.jsonl`);
        if (yield* fileExists(fileSystem, directTranscriptPath)) {
          const meta = yield* readMetaFile(
            fileSystem,
            path.join(searchedDirectory, `agent-${input.agentId}.meta.json`),
          );
          const location = {
            transcriptPath: directTranscriptPath,
            agentId: input.agentId,
            ...(meta ? { meta } : {}),
          };
          setCappedMapEntry(resolutionCache, cacheKey, location, RESOLUTION_CACHE_MAX_ENTRIES);
          return location;
        }

        const entries = yield* fileSystem
          .readDirectory(searchedDirectory)
          .pipe(Effect.catch(() => Effect.succeed<Array<string>>([])));
        for (const entry of entries.sort()) {
          const match = /^agent-(.+)\.meta\.json$/u.exec(entry);
          if (!match?.[1]) {
            continue;
          }
          const meta = yield* readMetaFile(fileSystem, path.join(searchedDirectory, entry));
          if (meta?.toolUseId !== input.agentId) {
            continue;
          }
          const transcriptPath = path.join(searchedDirectory, `agent-${match[1]}.jsonl`);
          if (!(yield* fileExists(fileSystem, transcriptPath))) {
            continue;
          }
          const location = {
            transcriptPath,
            agentId: match[1],
            meta,
          };
          setCappedMapEntry(resolutionCache, cacheKey, location, RESOLUTION_CACHE_MAX_ENTRIES);
          return location;
        }
      }
    }

    return null;
  },
);

function readFileRange(
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

function appendCompleteLines(
  bytes: Uint8Array,
  previous: {
    readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
    readonly droppedEntries: number;
    readonly model?: string;
  },
  mapLines: ClaudeSubagentTranscriptLineMapper,
): {
  readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
  readonly droppedEntries: number;
  readonly model?: string;
  readonly parsedByteCount: number;
} {
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { ...previous, parsedByteCount: 0 };
  }
  const parsedByteCount = lastNewline + 1;
  const decoded = new TextDecoder().decode(bytes.subarray(0, parsedByteCount));
  const appended = mapLines(decoded.split("\n"));
  const combined = [...previous.entries, ...appended.entries];
  const overflow = Math.max(0, combined.length - RETAINED_ENTRY_LIMIT);
  const model = appended.model ?? previous.model;
  return {
    entries: overflow > 0 ? combined.slice(overflow) : combined,
    droppedEntries: previous.droppedEntries + overflow,
    ...(model ? { model } : {}),
    parsedByteCount,
  };
}

/**
 * Read and map complete transcript records, parsing only appended bytes after
 * the first read.
 */
export const readClaudeSubagentTranscriptEntries = Effect.fn("readClaudeSubagentTranscriptEntries")(
  function* (input: {
    readonly transcriptPath: string;
    readonly mapLines: ClaudeSubagentTranscriptLineMapper;
  }): Effect.fn.Return<
    {
      readonly entries: ReadonlyArray<ProviderSubagentTranscriptEntry>;
      /** Entries dropped from the front of the cache; add to indices for absolute positions. */
      readonly droppedEntries: number;
      readonly model?: string;
    },
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(input.transcriptPath);
    const size = stat.size;
    const mtimeMs = Option.getOrUndefined(stat.mtime)?.getTime() ?? 0;
    const cached = readCache.get(input.transcriptPath);

    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return {
        entries: cached.entries,
        droppedEntries: cached.droppedEntries,
        ...(cached.model ? { model: cached.model } : {}),
      };
    }

    if (cached && size > cached.size && mtimeMs >= cached.mtimeMs) {
      const delta = yield* readFileRange(
        fileSystem,
        input.transcriptPath,
        cached.parsedBytes,
        size - cached.parsedBytes,
      );
      const appended = appendCompleteLines(delta, cached, input.mapLines);
      const next = {
        size,
        mtimeMs,
        parsedBytes: cached.parsedBytes + BigInt(appended.parsedByteCount),
        entries: appended.entries,
        droppedEntries: appended.droppedEntries,
        ...(appended.model ? { model: appended.model } : {}),
      };
      setCappedMapEntry(readCache, input.transcriptPath, next, READ_CACHE_MAX_PATHS);
      return {
        entries: next.entries,
        droppedEntries: next.droppedEntries,
        ...(next.model ? { model: next.model } : {}),
      };
    }

    const contents = yield* fileSystem.readFile(input.transcriptPath);
    const parsed = appendCompleteLines(
      contents,
      { entries: [], droppedEntries: 0 },
      input.mapLines,
    );
    const next = {
      size,
      mtimeMs,
      parsedBytes: BigInt(parsed.parsedByteCount),
      entries: parsed.entries,
      droppedEntries: parsed.droppedEntries,
      ...(parsed.model ? { model: parsed.model } : {}),
    };
    setCappedMapEntry(readCache, input.transcriptPath, next, READ_CACHE_MAX_PATHS);
    return {
      entries: next.entries,
      droppedEntries: next.droppedEntries,
      ...(next.model ? { model: next.model } : {}),
    };
  },
);

export function clearClaudeSubagentTranscriptCaches(): void {
  resolutionCache.clear();
  readCache.clear();
}
