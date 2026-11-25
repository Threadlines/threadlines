import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import { OtlpResource, OtlpTracer } from "effect/observability";

import { RotatingFileSink } from "./logging.ts";

const FLUSH_BUFFER_THRESHOLD = 32;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 30_000;
const traceTextEncoder = new TextEncoder();

export type TraceAttributes = Readonly<Record<string, unknown>>;

export interface TraceRecordEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TraceRecordLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

interface BaseTraceRecord {
  readonly name: string;
  readonly kind: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<TraceRecordEvent>;
  readonly links: ReadonlyArray<TraceRecordLink>;
}

export interface EffectTraceRecord extends BaseTraceRecord {
  readonly type: "effect-span";
  readonly exit:
    | {
        readonly _tag: "Success";
      }
    | {
        readonly _tag: "Interrupted";
        readonly cause: string;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: string;
      };
}

export interface OtlpTraceRecord extends BaseTraceRecord {
  readonly type: "otlp-span";
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<{
    readonly name?: string;
    readonly version?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly status?:
    | {
        readonly code?: string;
        readonly message?: string;
      }
    | undefined;
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxBufferedBytes?: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

/**
 * What a trace filter decides from: the parts of a record that are cheap to
 * read off a finished span, so a span the filter drops is never turned into a
 * record. A whole `TraceRecord` is one too.
 */
export interface TraceRecordHead {
  readonly type: TraceRecord["type"];
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly durationMs: number;
  /** Absent on OTLP records. */
  readonly exit?: { readonly _tag: EffectTraceRecord["exit"]["_tag"] };
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<{ readonly attributes: Readonly<Record<string, unknown>> }>;
}

export type TraceRecordFilter = (record: TraceRecordHead) => boolean;

export interface LocalFileTracerOptions extends TraceSinkOptions {
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
  readonly shouldRecord?: TraceRecordFilter;
}

type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];
type OtlpSpanEvent = OtlpSpan["events"][number];
type OtlpSpanLink = OtlpSpan["links"][number];
type OtlpSpanStatus = OtlpSpan["status"];

interface SerializableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly status: Tracer.SpanStatus;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly events: ReadonlyArray<
    readonly [name: string, startTime: bigint, attributes: Record<string, unknown>]
  >;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markSeen(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  return false;
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return value.map((entry) => normalizeJsonValue(entry, seen));
  }
  if (value instanceof Map) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Object.fromEntries(
      Array.from(value.entries(), ([key, entryValue]) => [
        String(key),
        normalizeJsonValue(entryValue, seen),
      ]),
    );
  }
  if (value instanceof Set) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Array.from(value.values(), (entry) => normalizeJsonValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  if (markSeen(value, seen)) {
    return "[Circular]";
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeJsonValue(entryValue, seen)]),
  );
}

export function compactTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeJsonValue(value)]),
  );
}

function traceExitTag(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"]["_tag"] {
  if (ExitRuntime.isSuccess(exit)) {
    return "Success";
  }
  return Cause.hasInterruptsOnly(exit.cause) ? "Interrupted" : "Failure";
}

function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (ExitRuntime.isSuccess(exit)) {
    return { _tag: "Success" };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      _tag: "Interrupted",
      cause: Cause.pretty(exit.cause),
    };
  }
  return {
    _tag: "Failure",
    cause: Cause.pretty(exit.cause),
  };
}

export function spanToTraceRecord(span: SerializableSpan): EffectTraceRecord {
  const status = span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>;
  const parentSpanId = Option.getOrUndefined(span.parent)?.spanId;

  return {
    type: "effect-span",
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sampled: span.sampled,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: compactTraceAttributes(Object.fromEntries(span.attributes)),
    events: span.events.map(([name, startTime, attributes]) => ({
      name,
      timeUnixNano: String(startTime),
      attributes: compactTraceAttributes(attributes),
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: compactTraceAttributes(link.attributes),
    })),
    exit: formatTraceExit(status.exit),
  };
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const batchWindowMs = Number.isFinite(options.batchWindowMs)
    ? Math.max(0, options.batchWindowMs)
    : 0;
  const initialRetryDelayMs =
    batchWindowMs > 0
      ? Math.max(1, Math.min(MAX_RETRY_DELAY_MS, batchWindowMs))
      : DEFAULT_RETRY_DELAY_MS;
  const requestedMaxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const maxBufferedBytes = Number.isFinite(requestedMaxBufferedBytes)
    ? Math.max(1, Math.trunc(requestedMaxBufferedBytes))
    : DEFAULT_MAX_BUFFERED_BYTES;
  const sink = new RotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    throwOnError: true,
  });

  const runFork = Effect.runForkWith(yield* Effect.context());
  const flushSemaphore = yield* Semaphore.make(1);
  let closed = false;
  let flushFiber: Fiber.Fiber<void, never> | undefined;
  let immediateFlushFiber: Fiber.Fiber<void, never> | undefined;
  let flushFailed = false;
  let nextRetryDelayMs = initialRetryDelayMs;
  let bufferedBytes = 0;
  let inFlightBytes = 0;
  let buffer: Array<{ readonly line: string; readonly bytes: number }> = [];

  const trimBufferedRecords = (): void => {
    while (bufferedBytes + inFlightBytes > maxBufferedBytes && buffer.length > 0) {
      const dropped = buffer.shift();
      if (!dropped) {
        break;
      }
      bufferedBytes -= dropped.bytes;
    }
  };

  const runFlushOnce = (allowDuringBackoff: boolean) =>
    flushSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (buffer.length === 0 || (!allowDuringBackoff && flushFailed)) {
          return;
        }

        const records = buffer;
        inFlightBytes = bufferedBytes;
        buffer = [];
        bufferedBytes = 0;
        let persistedCount = 0;

        try {
          while (persistedCount < records.length) {
            const firstRecord = records[persistedCount];
            if (!firstRecord) {
              break;
            }
            if (firstRecord.bytes > options.maxBytes) {
              inFlightBytes = Math.max(0, inFlightBytes - firstRecord.bytes);
              persistedCount += 1;
              continue;
            }

            let nextIndex = persistedCount + 1;
            let chunkBytes = firstRecord.bytes;
            while (nextIndex < records.length) {
              const nextRecord = records[nextIndex];
              if (!nextRecord || chunkBytes + nextRecord.bytes > options.maxBytes) {
                break;
              }
              chunkBytes += nextRecord.bytes;
              nextIndex += 1;
            }

            const chunk = records
              .slice(persistedCount, nextIndex)
              .map((record) => record.line)
              .join("");
            const written = yield* Effect.tryPromise(() => sink.writeAsync(chunk)).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (!written) {
              inFlightBytes = 0;
              buffer = [...records.slice(persistedCount), ...buffer];
              bufferedBytes = buffer.reduce((total, record) => total + record.bytes, 0);
              trimBufferedRecords();
              nextRetryDelayMs = flushFailed
                ? Math.min(MAX_RETRY_DELAY_MS, nextRetryDelayMs * 2)
                : initialRetryDelayMs;
              flushFailed = buffer.length > 0;
              return;
            }
            inFlightBytes = Math.max(0, inFlightBytes - chunkBytes);
            persistedCount = nextIndex;
          }
          flushFailed = false;
          nextRetryDelayMs = initialRetryDelayMs;
        } finally {
          inFlightBytes = 0;
        }
      }).pipe(Effect.uninterruptible, Effect.withTracerEnabled(false)),
    );

  const shouldFlushImmediately = (): boolean =>
    !flushFailed &&
    (batchWindowMs <= 0 ||
      buffer.length >= FLUSH_BUFFER_THRESHOLD ||
      bufferedBytes >= maxBufferedBytes);

  const triggerImmediateFlush = (): void => {
    if (closed || immediateFlushFiber !== undefined || buffer.length === 0) {
      return;
    }
    const scheduled = flushFiber;
    flushFiber = undefined;
    immediateFlushFiber = runFork(
      Effect.gen(function* () {
        if (scheduled) {
          yield* Fiber.interrupt(scheduled).pipe(Effect.ignore);
        }
        yield* runFlushOnce(false);
        immediateFlushFiber = undefined;
        if (!closed && buffer.length > 0) {
          if (shouldFlushImmediately()) {
            triggerImmediateFlush();
          } else {
            scheduleFlush();
          }
        }
      }).pipe(Effect.withTracerEnabled(false)),
    );
  };

  const scheduleFlush = (): void => {
    if (
      closed ||
      flushFiber !== undefined ||
      immediateFlushFiber !== undefined ||
      buffer.length === 0
    ) {
      return;
    }

    const delayMs = flushFailed ? nextRetryDelayMs : batchWindowMs;
    if (delayMs <= 0) {
      return;
    }

    flushFiber = runFork(
      Effect.sleep(`${delayMs} millis`).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* runFlushOnce(true);
            flushFiber = undefined;
            if (!closed && buffer.length > 0) {
              if (shouldFlushImmediately()) {
                triggerImmediateFlush();
              } else {
                scheduleFlush();
              }
            }
          }),
        ),
        Effect.withTracerEnabled(false),
      ),
    );
  };

  const flush = Effect.gen(function* () {
    const scheduled = flushFiber;
    flushFiber = undefined;
    if (scheduled) {
      yield* Fiber.interrupt(scheduled).pipe(Effect.ignore);
    }
    yield* runFlushOnce(true);
    scheduleFlush();
  }).pipe(Effect.withTracerEnabled(false));

  const close = Effect.gen(function* () {
    closed = true;
    const scheduled = flushFiber;
    flushFiber = undefined;
    if (scheduled) {
      yield* Fiber.interrupt(scheduled).pipe(Effect.ignore);
    }
    const immediate = immediateFlushFiber;
    if (immediate) {
      yield* Fiber.await(immediate).pipe(Effect.ignore);
      immediateFlushFiber = undefined;
    }
    yield* runFlushOnce(true);
  }).pipe(Effect.withTracerEnabled(false));

  yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));

  return {
    filePath: options.filePath,
    push(record) {
      if (closed) {
        return;
      }
      try {
        const line = `${JSON.stringify(record)}\n`;
        const bytes = traceTextEncoder.encode(line).byteLength;
        if (bytes > options.maxBytes) {
          return;
        }
        buffer.push({ line, bytes });
        bufferedBytes += bytes;
        if (flushFailed || inFlightBytes > 0) {
          trimBufferedRecords();
        }
        if (shouldFlushImmediately()) {
          triggerImmediateFlush();
        } else {
          scheduleFlush();
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => close,
  } satisfies TraceSink;
});

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;
  private readonly shouldRecord: TraceRecordFilter;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
    shouldRecord: TraceRecordFilter,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.shouldRecord = shouldRecord;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.delegate.end(endTime, exit);

    // The filter drops most spans while agents stream (it samples database
    // and per-message spans), so it reads a cheap summary first and only a
    // kept span is turned into a record.
    if (this.sampled) {
      const head: TraceRecordHead = {
        type: "effect-span",
        name: this.name,
        traceId: this.traceId,
        spanId: this.spanId,
        durationMs: Number(endTime - this.status.startTime) / 1_000_000,
        exit: { _tag: traceExitTag(exit) },
        attributes: Object.fromEntries(this.attributes),
        events: this.events.map(([, , attributes]) => ({ attributes })),
      };
      if (this.shouldRecord(head)) {
        this.push(spanToTraceRecord(this));
      }
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const nextAttributes = attributes ?? {};
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
      ...(options.maxBufferedBytes === undefined
        ? {}
        : { maxBufferedBytes: options.maxBufferedBytes }),
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(
        spanOptions,
        delegate.span(spanOptions),
        sink.push,
        options.shouldRecord ?? (() => true),
      );
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});

const SPAN_KIND_MAP: Record<number, OtlpTraceRecord["kind"]> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

export function decodeOtlpTraceRecords(
  payload: OtlpTracer.TraceData,
): ReadonlyArray<OtlpTraceRecord> {
  const records: Array<OtlpTraceRecord> = [];

  for (const resourceSpan of payload.resourceSpans) {
    const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes ?? []);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        records.push(
          otlpSpanToTraceRecord({
            resourceAttributes,
            scopeAttributes: decodeAttributes(
              "attributes" in scopeSpan.scope && Array.isArray(scopeSpan.scope.attributes)
                ? scopeSpan.scope.attributes
                : [],
            ),
            scopeName: scopeSpan.scope.name,
            scopeVersion:
              "version" in scopeSpan.scope && typeof scopeSpan.scope.version === "string"
                ? scopeSpan.scope.version
                : undefined,
            span,
          }),
        );
      }
    }
  }

  return records;
}

function otlpSpanToTraceRecord(input: {
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scopeAttributes: Readonly<Record<string, unknown>>;
  readonly scopeName: string | undefined;
  readonly scopeVersion: string | undefined;
  readonly span: OtlpSpan;
}): OtlpTraceRecord {
  return {
    type: "otlp-span",
    name: input.span.name,
    traceId: input.span.traceId,
    spanId: input.span.spanId,
    ...(input.span.parentSpanId ? { parentSpanId: input.span.parentSpanId } : {}),
    sampled: true,
    kind: normalizeSpanKind(input.span.kind),
    startTimeUnixNano: input.span.startTimeUnixNano,
    endTimeUnixNano: input.span.endTimeUnixNano,
    durationMs:
      Number(parseBigInt(input.span.endTimeUnixNano) - parseBigInt(input.span.startTimeUnixNano)) /
      1_000_000,
    attributes: decodeAttributes(input.span.attributes),
    resourceAttributes: input.resourceAttributes,
    scope: {
      ...(input.scopeName ? { name: input.scopeName } : {}),
      ...(input.scopeVersion ? { version: input.scopeVersion } : {}),
      attributes: input.scopeAttributes,
    },
    events: decodeEvents(input.span.events),
    links: decodeLinks(input.span.links),
    status: decodeStatus(input.span.status),
  };
}

function decodeStatus(input: OtlpSpanStatus): OtlpTraceRecord["status"] {
  const code = String(input.code);
  const message = input.message;

  return {
    code,
    ...(message ? { message } : {}),
  };
}

function decodeEvents(input: ReadonlyArray<OtlpSpanEvent>): ReadonlyArray<TraceRecordEvent> {
  return input.map((current) => ({
    name: current.name,
    timeUnixNano: current.timeUnixNano,
    attributes: decodeAttributes(current.attributes),
  }));
}

function decodeLinks(input: ReadonlyArray<OtlpSpanLink>): ReadonlyArray<TraceRecordLink> {
  return input.flatMap((current) => {
    const traceId = current.traceId;
    const spanId = current.spanId;
    return {
      traceId,
      spanId,
      attributes: decodeAttributes(current.attributes),
    };
  });
}

function decodeAttributes(
  input: ReadonlyArray<OtlpResource.KeyValue>,
): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};

  for (const attribute of input) {
    entries[attribute.key] = decodeValue(attribute.value);
  }

  return compactTraceAttributes(entries);
}

function decodeValue(input: OtlpResource.AnyValue | null | undefined): unknown {
  if (input == null) {
    return null;
  }
  if ("stringValue" in input) {
    return input.stringValue;
  }
  if ("boolValue" in input) {
    return input.boolValue;
  }
  if ("intValue" in input) {
    return input.intValue;
  }
  if ("doubleValue" in input) {
    return input.doubleValue;
  }
  if ("bytesValue" in input) {
    return input.bytesValue;
  }
  if (input.arrayValue) {
    return input.arrayValue.values.map((entry) => decodeValue(entry));
  }
  if (input.kvlistValue) {
    return decodeAttributes(input.kvlistValue.values);
  }
  return null;
}

function normalizeSpanKind(input: number): OtlpTraceRecord["kind"] {
  return SPAN_KIND_MAP[input] || "internal";
}

function parseBigInt(input: string): bigint {
  try {
    return BigInt(input);
  } catch {
    return 0n;
  }
}
