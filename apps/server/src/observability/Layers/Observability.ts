import {
  makeLocalFileTracer,
  makeTraceSink,
  type TraceRecord,
} from "@threadlines/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { ServerConfig } from "../../config.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";

const otlpSerializationLayer = OtlpSerialization.layerJson;
const SLOW_TRACE_RECORD_THRESHOLD_MS = 1_000;
const SQL_TRACE_SAMPLE_MODULO = 100;
const PROJECTION_TRACE_SAMPLE_MODULO = 20;

const sampledSqlSpanNames = new Set(["sql.execute", "sql.transaction"]);
const sampledProjectionSpanNames = new Set([
  "applyPendingApprovalsProjection",
  "applyProjectsProjection",
  "applyThreadActivitiesProjection",
  "applyThreadMessagesProjection",
  "applyThreadProposedPlansProjection",
  "applyThreadSessionsProjection",
  "applyThreadTurnsProjection",
  "applyThreadsProjection",
  "decideOrchestrationCommand",
  "processEvent",
  "refreshThreadShellSummary",
  "resolveThreadShell",
  "runProjectorForEvent",
]);

function traceSampleHash(input: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function shouldKeepSampledTraceRecord(record: TraceRecord, modulo: number): boolean {
  return traceSampleHash(`${record.traceId}:${record.spanId}:${record.name}`) % modulo === 0;
}

function hasWarningOrErrorEvent(record: TraceRecord): boolean {
  return record.events.some((event) => {
    const level = event.attributes["effect.logLevel"];
    if (typeof level !== "string") {
      return false;
    }
    const normalized = level.toLowerCase();
    return (
      normalized === "warning" ||
      normalized === "warn" ||
      normalized === "error" ||
      normalized === "fatal"
    );
  });
}

export function shouldRecordServerLocalTrace(record: TraceRecord): boolean {
  if (record.durationMs >= SLOW_TRACE_RECORD_THRESHOLD_MS || hasWarningOrErrorEvent(record)) {
    return true;
  }

  if (record.type === "effect-span" && record.exit._tag !== "Success") {
    return true;
  }

  if (sampledSqlSpanNames.has(record.name)) {
    return shouldKeepSampledTraceRecord(record, SQL_TRACE_SAMPLE_MODULO);
  }

  if (sampledProjectionSpanNames.has(record.name)) {
    return shouldKeepSampledTraceRecord(record, PROJECTION_TRACE_SAMPLE_MODULO);
  }

  return true;
}

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                resource: {
                  serviceName: config.otlpServiceName,
                  attributes: {
                    "service.runtime": "threadlines-server",
                    "service.mode": config.mode,
                  },
                },
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          shouldRecord: shouldRecordServerLocalTrace,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          Layer.succeed(BrowserTraceCollector, {
            record: (records) =>
              Effect.sync(() => {
                for (const record of records) {
                  sink.push(record);
                }
              }),
          }),
        );
      }),
    ).pipe(Layer.provideMerge(otlpSerializationLayer));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            resource: {
              serviceName: config.otlpServiceName,
              attributes: {
                "service.runtime": "threadlines-server",
                "service.mode": config.mode,
              },
            },
          }).pipe(Layer.provideMerge(otlpSerializationLayer));

    return Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer);
  }),
);
