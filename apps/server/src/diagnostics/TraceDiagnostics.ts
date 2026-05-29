import type {
  ServerTraceDiagnosticsErrorKind,
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
  ServerTraceDiagnosticsSpanSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

interface TraceRecordLike {
  readonly name?: unknown;
  readonly traceId?: unknown;
  readonly spanId?: unknown;
  readonly startTimeUnixNano?: unknown;
  readonly endTimeUnixNano?: unknown;
  readonly durationMs?: unknown;
  readonly exit?: unknown;
  readonly events?: unknown;
}

interface TraceEventLike {
  readonly name?: unknown;
  readonly timeUnixNano?: unknown;
  readonly attributes?: unknown;
}

export interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
  readonly readAt?: DateTime.Utc;
}

export interface TraceDiagnosticsShape {
  readonly read: (options: TraceDiagnosticsOptions) => Effect.Effect<ServerTraceDiagnosticsResult>;
}

export class TraceDiagnostics extends Context.Service<TraceDiagnostics, TraceDiagnosticsShape>()(
  "t3/diagnostics/TraceDiagnostics",
) {}

interface TraceDiagnosticsInput {
  readonly traceFilePath: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly scannedFilePaths?: ReadonlyArray<string>;
  readonly slowSpanThresholdMs?: number;
  readonly readAt: DateTime.Utc;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}

interface TraceDiagnosticsErrorSummary {
  readonly kind: ServerTraceDiagnosticsErrorKind;
  readonly message: string;
}

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
function toRotatedTracePaths(traceFilePath: string, maxFiles: number): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  const backups = Array.from(
    { length: backupCount },
    (_, index) => `${traceFilePath}.${backupCount - index}`,
  );
  return [...backups, traceFilePath];
}

function isRecordObject(value: unknown): value is TraceRecordLike {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixNanoToDateTime(value: unknown): DateTime.Utc | null {
  const text = toStringValue(value);
  if (!text) return null;
  try {
    const millis = Number(BigInt(text) / 1_000_000n);
    return Option.getOrNull(DateTime.make(millis));
  } catch {
    return null;
  }
}

function readExitTag(exit: unknown): string | null {
  if (!isRecordObject(exit) || !("_tag" in exit)) return null;
  return toStringValue(exit._tag);
}

function readExitCause(exit: unknown): string {
  if (!isRecordObject(exit) || !("cause" in exit)) return "Failure";
  return toStringValue(exit.cause)?.trim() ?? "Failure";
}

function isSubscriptionSpan(name: string): boolean {
  return name.startsWith("ws.rpc.subscribe") || name.startsWith("ws.rpc.orchestration.subscribe");
}

function isExpectedSubscriptionInterruption(name: string, cause: string): boolean {
  if (!isSubscriptionSpan(name)) {
    return false;
  }
  const normalizedCause = cause.toLowerCase();
  return (
    normalizedCause.includes("all fibers interrupted without error") ||
    normalizedCause.includes("socketcloseerror") ||
    normalizedCause.includes("socket closed") ||
    normalizedCause.includes("websocket closed")
  );
}

function isTraceEvent(value: unknown): value is TraceEventLike {
  return typeof value === "object" && value !== null;
}

function readEventAttributes(event: TraceEventLike): Readonly<Record<string, unknown>> {
  return typeof event.attributes === "object" && event.attributes !== null
    ? (event.attributes as Readonly<Record<string, unknown>>)
    : {};
}

function makeEmptyDiagnostics(input: {
  readonly traceFilePath: string;
  readonly scannedFilePaths: ReadonlyArray<string>;
  readonly readAt: DateTime.Utc;
  readonly slowSpanThresholdMs: number;
  readonly error?: TraceDiagnosticsErrorSummary;
  readonly partialFailure?: boolean;
}): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths: [...input.scannedFilePaths],
    readAt: input.readAt,
    recordCount: 0,
    parseErrorCount: 0,
    firstSpanAt: Option.none(),
    lastSpanAt: Option.none(),
    failureCount: 0,
    interruptionCount: 0,
    slowSpanThresholdMs: input.slowSpanThresholdMs,
    slowSpanCount: 0,
    logLevelCounts: {},
    topSpansByCount: [],
    slowestSpans: [],
    subscriptionSpanCount: 0,
    topSubscriptionSpansByCount: [],
    longestSubscriptionSpans: [],
    commonFailures: [],
    latestFailures: [],
    latestWarningAndErrorLogs: [],
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

function platformErrorMessage(error: PlatformError.PlatformError): string {
  return error.message || String(error);
}

function insertBoundedSlowestSpan(
  slowestSpans: ServerTraceDiagnosticsSpanOccurrence[],
  span: ServerTraceDiagnosticsSpanOccurrence,
): void {
  if (
    slowestSpans.length >= TOP_LIMIT &&
    span.durationMs <= slowestSpans[slowestSpans.length - 1]!.durationMs
  ) {
    return;
  }

  slowestSpans.push(span);
  slowestSpans.sort((left, right) => right.durationMs - left.durationMs);
  if (slowestSpans.length > TOP_LIMIT) {
    slowestSpans.length = TOP_LIMIT;
  }
}

function insertBoundedLatestFailure(
  latestFailures: ServerTraceDiagnosticsRecentFailure[],
  failure: ServerTraceDiagnosticsRecentFailure,
): void {
  if (
    latestFailures.length >= RECENT_LIMIT &&
    DateTime.isLessThan(failure.endedAt, latestFailures[latestFailures.length - 1]!.endedAt)
  ) {
    return;
  }

  latestFailures.push(failure);
  latestFailures.sort(
    (left, right) => DateTime.toEpochMillis(right.endedAt) - DateTime.toEpochMillis(left.endedAt),
  );
  if (latestFailures.length > RECENT_LIMIT) {
    latestFailures.length = RECENT_LIMIT;
  }
}

function insertBoundedLatestLog(
  latestLogs: ServerTraceDiagnosticsLogEvent[],
  log: ServerTraceDiagnosticsLogEvent,
): void {
  if (
    latestLogs.length >= RECENT_LIMIT &&
    DateTime.isLessThan(log.seenAt, latestLogs[latestLogs.length - 1]!.seenAt)
  ) {
    return;
  }

  latestLogs.push(log);
  latestLogs.sort(
    (left, right) => DateTime.toEpochMillis(right.seenAt) - DateTime.toEpochMillis(left.seenAt),
  );
  if (latestLogs.length > RECENT_LIMIT) {
    latestLogs.length = RECENT_LIMIT;
  }
}

export function aggregateTraceDiagnostics(
  input: TraceDiagnosticsInput,
): ServerTraceDiagnosticsResult {
  const readAt = input.readAt;
  const slowSpanThresholdMs = input.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
  const scannedFilePaths = input.scannedFilePaths ?? input.files.map((file) => file.path);
  if (input.files.length === 0) {
    return makeEmptyDiagnostics({
      traceFilePath: input.traceFilePath,
      scannedFilePaths,
      readAt,
      slowSpanThresholdMs,
      error: input.error ?? {
        kind: "trace-file-not-found",
        message: "No local trace files were found.",
      },
      ...(input.partialFailure ? { partialFailure: true } : {}),
    });
  }

  let parseErrorCount = 0;
  let recordCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let subscriptionSpanCount = 0;
  let firstSpanAt: DateTime.Utc | null = null;
  let lastSpanAt: DateTime.Utc | null = null;

  const spansByName = new Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >();
  const subscriptionSpansByName = new Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >();
  const failuresByKey = new Map<string, ServerTraceDiagnosticsFailureSummary>();
  const latestFailures: ServerTraceDiagnosticsRecentFailure[] = [];
  const slowestSpans: ServerTraceDiagnosticsSpanOccurrence[] = [];
  const longestSubscriptionSpans: ServerTraceDiagnosticsSpanOccurrence[] = [];
  const latestWarningAndErrorLogs: ServerTraceDiagnosticsLogEvent[] = [];
  const logLevelCounts: Record<string, number> = {};

  for (const file of input.files) {
    const lines = file.text.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrorCount += 1;
        continue;
      }

      if (!isRecordObject(parsed)) {
        parseErrorCount += 1;
        continue;
      }

      const name = toStringValue(parsed.name);
      const traceId = toStringValue(parsed.traceId);
      const spanId = toStringValue(parsed.spanId);
      const durationMs = toNumberValue(parsed.durationMs);
      const endedAt = unixNanoToDateTime(parsed.endTimeUnixNano);
      const startedAt = unixNanoToDateTime(parsed.startTimeUnixNano);

      if (!name || !traceId || !spanId || durationMs === null || !endedAt) {
        parseErrorCount += 1;
        continue;
      }

      recordCount += 1;
      firstSpanAt =
        startedAt && (firstSpanAt === null || DateTime.isLessThan(startedAt, firstSpanAt))
          ? startedAt
          : firstSpanAt;
      lastSpanAt =
        lastSpanAt === null || DateTime.isGreaterThan(endedAt, lastSpanAt) ? endedAt : lastSpanAt;

      const exitTag = readExitTag(parsed.exit);
      const failureCause = exitTag === "Failure" ? readExitCause(parsed.exit) : null;
      const expectedSubscriptionInterruption =
        failureCause !== null && isExpectedSubscriptionInterruption(name, failureCause);
      const isFailure = exitTag === "Failure" && !expectedSubscriptionInterruption;
      const isInterrupted = exitTag === "Interrupted" || expectedSubscriptionInterruption;
      const subscriptionSpan = isSubscriptionSpan(name);
      if (isFailure) failureCount += 1;
      if (isInterrupted) interruptionCount += 1;

      const spanSummaryMap = subscriptionSpan ? subscriptionSpansByName : spansByName;
      const spanSummary = spanSummaryMap.get(name) ?? {
        count: 0,
        failureCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
      };
      spanSummary.count += 1;
      spanSummary.totalDurationMs += durationMs;
      spanSummary.maxDurationMs = Math.max(spanSummary.maxDurationMs, durationMs);
      if (isFailure) spanSummary.failureCount += 1;
      spanSummaryMap.set(name, spanSummary);

      const spanItem = { name, durationMs, endedAt, traceId, spanId };
      if (subscriptionSpan) {
        subscriptionSpanCount += 1;
        insertBoundedSlowestSpan(longestSubscriptionSpans, spanItem);
      } else if (durationMs >= slowSpanThresholdMs) {
        slowSpanCount += 1;
      }
      if (!subscriptionSpan) {
        insertBoundedSlowestSpan(slowestSpans, spanItem);
      }

      if (isFailure) {
        const cause = failureCause ?? readExitCause(parsed.exit);
        insertBoundedLatestFailure(latestFailures, { ...spanItem, cause });

        const failureKey = `${name}\0${cause}`;
        const existing = failuresByKey.get(failureKey);
        const isLatestFailure = !existing || DateTime.isGreaterThan(endedAt, existing.lastSeenAt);
        failuresByKey.set(failureKey, {
          name,
          cause,
          count: (existing?.count ?? 0) + 1,
          lastSeenAt: isLatestFailure ? endedAt : existing!.lastSeenAt,
          traceId: isLatestFailure ? traceId : existing!.traceId,
          spanId: isLatestFailure ? spanId : existing!.spanId,
        });
      }

      if (Array.isArray(parsed.events)) {
        for (const rawEvent of parsed.events) {
          if (!isTraceEvent(rawEvent)) continue;
          const attributes = readEventAttributes(rawEvent);
          const level = toStringValue(attributes["effect.logLevel"]);
          if (!level) continue;

          logLevelCounts[level] = (logLevelCounts[level] ?? 0) + 1;
          const normalizedLevel = level.toLowerCase();
          if (
            normalizedLevel !== "warning" &&
            normalizedLevel !== "warn" &&
            normalizedLevel !== "error" &&
            normalizedLevel !== "fatal"
          ) {
            continue;
          }

          const seenAt = unixNanoToDateTime(rawEvent.timeUnixNano) ?? endedAt;
          const message = toStringValue(rawEvent.name)?.trim() ?? "Log event";
          insertBoundedLatestLog(latestWarningAndErrorLogs, {
            spanName: name,
            level,
            message,
            seenAt,
            traceId,
            spanId,
          });
        }
      }
    }
  }

  const topSpansByCount: ServerTraceDiagnosticsSpanSummary[] = [...spansByName.entries()]
    .map(([name, span]) => ({
      name,
      count: span.count,
      failureCount: span.failureCount,
      totalDurationMs: span.totalDurationMs,
      averageDurationMs: span.count > 0 ? span.totalDurationMs / span.count : 0,
      maxDurationMs: span.maxDurationMs,
    }))
    .toSorted((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
    .slice(0, TOP_LIMIT);
  const topSubscriptionSpansByCount: ServerTraceDiagnosticsSpanSummary[] = [
    ...subscriptionSpansByName.entries(),
  ]
    .map(([name, span]) => ({
      name,
      count: span.count,
      failureCount: span.failureCount,
      totalDurationMs: span.totalDurationMs,
      averageDurationMs: span.count > 0 ? span.totalDurationMs / span.count : 0,
      maxDurationMs: span.maxDurationMs,
    }))
    .toSorted((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
    .slice(0, TOP_LIMIT);

  return {
    traceFilePath: input.traceFilePath,
    scannedFilePaths,
    readAt,
    recordCount,
    parseErrorCount,
    firstSpanAt: Option.fromNullishOr(firstSpanAt),
    lastSpanAt: Option.fromNullishOr(lastSpanAt),
    failureCount,
    interruptionCount,
    slowSpanThresholdMs,
    slowSpanCount,
    logLevelCounts,
    topSpansByCount,
    slowestSpans,
    subscriptionSpanCount,
    topSubscriptionSpansByCount,
    longestSubscriptionSpans,
    commonFailures: [...failuresByKey.values()]
      .toSorted(
        (left, right) =>
          right.count - left.count ||
          DateTime.toEpochMillis(right.lastSeenAt) - DateTime.toEpochMillis(left.lastSeenAt),
      )
      .slice(0, TOP_LIMIT),
    latestFailures,
    latestWarningAndErrorLogs,
    partialFailure: input.partialFailure ? Option.some(true) : Option.none(),
    error: Option.fromNullishOr(input.error),
  };
}

type TraceFileReadResult =
  | { readonly _tag: "Loaded"; readonly path: string; readonly text: string }
  | { readonly _tag: "Missing"; readonly path: string }
  | { readonly _tag: "Failed"; readonly path: string; readonly message: string };

function readTraceFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<TraceFileReadResult> {
  return fileSystem.readFileString(path).pipe(
    Effect.map((text) => ({ _tag: "Loaded" as const, path, text })),
    Effect.catch((error: PlatformError.PlatformError) =>
      Effect.succeed(
        isNotFoundError(error)
          ? { _tag: "Missing" as const, path }
          : { _tag: "Failed" as const, path, message: platformErrorMessage(error) },
      ),
    ),
  );
}

export const make = Effect.fn("makeTraceDiagnostics")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const read: TraceDiagnosticsShape["read"] = Effect.fn("TraceDiagnostics.read")(
    function* (options) {
      const readAt = options.readAt ?? (yield* DateTime.now);
      const slowSpanThresholdMs = options.slowSpanThresholdMs ?? DEFAULT_SLOW_SPAN_THRESHOLD_MS;
      const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
      const results = yield* Effect.all(
        paths.map((path) => readTraceFile(fileSystem, path)),
        {
          concurrency: 1,
        },
      );
      const files = results.flatMap((result) =>
        result._tag === "Loaded" ? [{ path: result.path, text: result.text }] : [],
      );
      const readFailure = results.find((result) => result._tag === "Failed");
      const readFailureError = readFailure
        ? ({
            kind: "trace-file-read-failed",
            message: readFailure.message.trim() || `Failed to read ${readFailure.path}.`,
          } satisfies TraceDiagnosticsErrorSummary)
        : undefined;

      if (files.length === 0) {
        return makeEmptyDiagnostics({
          traceFilePath: options.traceFilePath,
          scannedFilePaths: paths,
          readAt,
          slowSpanThresholdMs,
          error:
            readFailureError ??
            ({
              kind: "trace-file-not-found",
              message: "No local trace files were found.",
            } satisfies TraceDiagnosticsErrorSummary),
        });
      }

      return aggregateTraceDiagnostics({
        traceFilePath: options.traceFilePath,
        files,
        scannedFilePaths: paths,
        readAt,
        slowSpanThresholdMs,
        ...(readFailureError ? { partialFailure: true, error: readFailureError } : {}),
      });
    },
  );

  return TraceDiagnostics.of({ read });
});

export const layer = Layer.effect(TraceDiagnostics, make());

export function readTraceDiagnostics(
  options: TraceDiagnosticsOptions,
): Effect.Effect<ServerTraceDiagnosticsResult, never, TraceDiagnostics> {
  return Effect.gen(function* () {
    const diagnostics = yield* TraceDiagnostics;
    return yield* diagnostics.read(options);
  });
}
