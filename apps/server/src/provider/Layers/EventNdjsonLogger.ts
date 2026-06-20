// @effect-diagnostics nodeBuiltinImport:off
/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import type { ThreadId } from "@threadlines/contracts";
import { RotatingFileSink } from "@threadlines/shared/logging";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 200;
const FLUSH_BUFFER_THRESHOLD = 32;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const DEFAULT_LOG_CLEANUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LOG_CLEANUP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LOG_CLEANUP_PROTECT_RECENT_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_LOG_FILE_NAME_PATTERN = /\.log(?:\.\d+)?$/;

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
}

export interface ProviderEventLogCleanupOptions {
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
  readonly maxTotalBytes?: number;
  readonly protectRecentMs?: number;
}

export interface ProviderEventLogCleanupResult {
  readonly scannedFiles: number;
  readonly deletedFiles: number;
  readonly deletedBytes: number;
  readonly retainedBytes: number;
  readonly errorCount: number;
}

interface ThreadWriter {
  writeMessage: (message: string) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

interface LoggerState {
  readonly threadWriters: Map<string, ThreadWriter>;
  readonly failedSegments: Set<string>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

interface LogCleanupCandidate {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isProviderLogFileName(fileName: string): boolean {
  return PROVIDER_LOG_FILE_NAME_PATTERN.test(fileName);
}

export function cleanupProviderEventLogDirectory(
  directory: string,
  options: ProviderEventLogCleanupOptions = {},
): Effect.Effect<ProviderEventLogCleanupResult> {
  return Effect.gen(function* () {
    const readAt = yield* DateTime.now;
    const nowMs = options.nowMs ?? DateTime.toEpochMillis(readAt);
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOG_CLEANUP_MAX_AGE_MS;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LOG_CLEANUP_MAX_TOTAL_BYTES;
    const protectRecentMs = options.protectRecentMs ?? DEFAULT_LOG_CLEANUP_PROTECT_RECENT_MS;
    return yield* Effect.sync(() => {
      let scannedFiles = 0;
      let deletedFiles = 0;
      let deletedBytes = 0;
      let errorCount = 0;
      let entries: fs.Dirent[];

      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        return {
          scannedFiles: 0,
          deletedFiles: 0,
          deletedBytes: 0,
          retainedBytes: 0,
          errorCount: isFileNotFoundError(error) ? 0 : 1,
        } satisfies ProviderEventLogCleanupResult;
      }

      const remaining: LogCleanupCandidate[] = [];
      const deleteCandidate = (candidate: LogCleanupCandidate): boolean => {
        try {
          fs.unlinkSync(candidate.filePath);
          deletedFiles += 1;
          deletedBytes += candidate.size;
          return true;
        } catch {
          errorCount += 1;
          return false;
        }
      };

      for (const entry of entries) {
        if (!entry.isFile() || !isProviderLogFileName(entry.name)) {
          continue;
        }

        const filePath = path.join(directory, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          errorCount += 1;
          continue;
        }

        if (!stat.isFile()) {
          continue;
        }

        scannedFiles += 1;
        const candidate = {
          filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        } satisfies LogCleanupCandidate;

        if (maxAgeMs >= 0 && nowMs - candidate.mtimeMs > maxAgeMs) {
          if (!deleteCandidate(candidate)) {
            remaining.push(candidate);
          }
          continue;
        }

        remaining.push(candidate);
      }

      let retainedBytes = remaining.reduce((total, candidate) => total + candidate.size, 0);
      if (retainedBytes > maxTotalBytes) {
        const protectedAfterMs = nowMs - protectRecentMs;
        const sizeCleanupCandidates = remaining
          .filter((candidate) => candidate.mtimeMs < protectedAfterMs)
          .toSorted((left, right) => left.mtimeMs - right.mtimeMs);

        for (const candidate of sizeCleanupCandidates) {
          if (retainedBytes <= maxTotalBytes) {
            break;
          }
          if (deleteCandidate(candidate)) {
            retainedBytes -= candidate.size;
          }
        }
      }

      return {
        scannedFiles,
        deletedFiles,
        deletedBytes,
        retainedBytes,
        errorCount,
      } satisfies ProviderEventLogCleanupResult;
    });
  });
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

function formatLogLine(streamLabel: string, observedAt: string, message: string): string {
  return `[${observedAt}] ${streamLabel}: ${message}\n`;
}

const toLogMessage = Effect.fnUntraced(function* (
  event: unknown,
): Effect.fn.Return<string | undefined> {
  const serialized = yield* Effect.sync(() => {
    try {
      return { ok: true as const, value: JSON.stringify(event) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!serialized.ok) {
    yield* logWarning("failed to serialize provider event log record", {
      error: serialized.error,
    });
    return undefined;
  }

  if (typeof serialized.value !== "string") {
    return undefined;
  }

  return serialized.value;
});

const makeThreadWriter = Effect.fnUntraced(function* (input: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly streamLabel: string;
}): Effect.fn.Return<ThreadWriter | undefined> {
  const sinkResult = yield* Effect.sync(() => {
    try {
      return {
        ok: true as const,
        sink: new RotatingFileSink({
          filePath: input.filePath,
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
          throwOnError: true,
        }),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!sinkResult.ok) {
    yield* logWarning("failed to initialize provider thread log file", {
      filePath: input.filePath,
      error: sinkResult.error,
    });
    return undefined;
  }

  const sink = sinkResult.sink;
  const scope = yield* Scope.make();
  let closed = false;
  let buffer: string[] = [];

  const flushUnsafe = (): { ok: true } | { ok: false; error: unknown } => {
    if (buffer.length === 0) {
      return { ok: true };
    }

    const messages = buffer;
    buffer = [];

    try {
      for (const message of messages) {
        sink.write(message);
      }
      return { ok: true };
    } catch (error) {
      buffer = [...messages, ...buffer];
      return { ok: false, error };
    }
  };

  const reportFlushResult = (result: ReturnType<typeof flushUnsafe>) =>
    result.ok
      ? Effect.void
      : logWarning("provider event log batch flush failed", {
          filePath: input.filePath,
          error: result.error,
        });

  const flush = Effect.sync(flushUnsafe).pipe(
    Effect.flatMap(reportFlushResult),
    Effect.withTracerEnabled(false),
  );

  if (input.batchWindowMs > 0) {
    yield* Effect.sleep(`${input.batchWindowMs} millis`).pipe(
      Effect.andThen(flush),
      Effect.forever,
      Effect.forkIn(scope),
    );
  }

  const writeMessage = (message: string) =>
    Effect.gen(function* () {
      const observedAt = DateTime.formatIso(yield* DateTime.now);

      return yield* Effect.sync(() => {
        if (closed) {
          return { ok: true as const };
        }
        buffer.push(formatLogLine(input.streamLabel, observedAt, message));
        return input.batchWindowMs <= 0 || buffer.length >= FLUSH_BUFFER_THRESHOLD
          ? flushUnsafe()
          : { ok: true as const };
      });
    }).pipe(Effect.flatMap(reportFlushResult), Effect.withTracerEnabled(false));

  const close = Effect.gen(function* () {
    closed = true;
    yield* Scope.close(scope, Exit.void);
    yield* flush;
  }).pipe(Effect.withTracerEnabled(false));

  return {
    writeMessage,
    close: () => close,
  } satisfies ThreadWriter;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const streamLabel = resolveStreamLabel(options.stream);

  const directoryReady = yield* Effect.sync(() => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return true;
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (directoryReady !== true) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  const stateRef = yield* SynchronizedRef.make<LoggerState>({
    threadWriters: new Map(),
    failedSegments: new Set(),
  });

  const resolveThreadWriter = Effect.fnUntraced(function* (
    threadSegment: string,
  ): Effect.fn.Return<ThreadWriter | undefined> {
    return yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
      if (state.failedSegments.has(threadSegment)) {
        return Effect.succeed([undefined, state] as const);
      }

      const existing = state.threadWriters.get(threadSegment);
      if (existing) {
        return Effect.succeed([existing, state] as const);
      }

      return makeThreadWriter({
        filePath: path.join(path.dirname(filePath), `${threadSegment}.log`),
        maxBytes,
        maxFiles,
        batchWindowMs,
        streamLabel,
      }).pipe(
        Effect.map((writer) => {
          if (!writer) {
            const nextFailedSegments = new Set(state.failedSegments);
            nextFailedSegments.add(threadSegment);
            return [
              undefined,
              {
                ...state,
                failedSegments: nextFailedSegments,
              },
            ] as const;
          }

          const nextThreadWriters = new Map(state.threadWriters);
          nextThreadWriters.set(threadSegment, writer);
          return [
            writer,
            {
              ...state,
              threadWriters: nextThreadWriters,
            },
          ] as const;
        }),
      );
    });
  });

  const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
    const threadSegment = resolveThreadSegment(threadId);
    const message = yield* toLogMessage(event);
    if (!message) {
      return;
    }

    const writer = yield* resolveThreadWriter(threadSegment);
    if (!writer) {
      return;
    }

    yield* writer.writeMessage(message);
  });

  const close = Effect.fnUntraced(function* () {
    yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        for (const writer of state.threadWriters.values()) {
          yield* writer.close();
        }

        return [
          undefined,
          {
            threadWriters: new Map<string, ThreadWriter>(),
            failedSegments: new Set<string>(),
          },
        ] as const;
      }),
    );
  });

  return {
    filePath,
    write: (event, threadId) => write(event, threadId).pipe(Effect.withTracerEnabled(false)),
    close,
  } satisfies EventNdjsonLogger;
});
