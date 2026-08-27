import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;
const CLIENT_TRACING_RESOURCE = {
  serviceName: "threadlines-web",
  attributes: {
    "service.runtime": "threadlines-web",
    "service.mode": isElectron ? "electron" : "browser",
    "service.version": APP_VERSION,
  },
} as const;

const delegateRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  OtlpExporter.layerFlusher,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

/**
 * Emits a zero-duration span straight onto the OTLP exporter, so plain
 * (non-Effect) code can put a fact in the server's trace file.
 *
 * The renderer's telemetry pipeline is traces-only — `OtlpTracer` posting to
 * `/api/observability/v1/traces`, which the server appends to
 * `server.trace.ndjson`. There is no log exporter, so a span *is* the
 * log-style event here; `OtlpTracer` exports on `end()`, hence start and end
 * at the same instant.
 *
 * Returns false when tracing has not been configured yet (the span would go
 * nowhere), so callers can decide whether a console fallback is worthwhile.
 */
export function recordClientTraceEvent(
  name: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  const delegate = activeDelegate;
  if (delegate === null) {
    return false;
  }

  try {
    const startTime = BigInt(Date.now()) * 1_000_000n;
    const span = delegate.span({
      name,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime,
      kind: "internal",
      root: true,
      sampled: true,
    });
    for (const [key, value] of Object.entries(attributes)) {
      span.attribute(key, value);
    }
    span.end(startTime, Exit.void);
    return true;
  } catch {
    // Diagnostics must never take down the code path they are observing.
    return false;
  }
}

export function configureClientTracing(config: ClientTracingConfig = {}): Promise<void> {
  if (config.exportIntervalMs === undefined && activeConfigKey !== null) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  const otlpTracesUrl = resolvePrimaryEnvironmentHttpUrl("/api/observability/v1/traces");
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && activeDelegate !== null) {
    return;
  }

  activeConfigKey = nextConfigKey;
  const generation = ++configurationGeneration;

  const previousRuntime = activeRuntime;
  const previousScope = activeScope;

  activeDelegate = null;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(previousRuntime, previousScope);

  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());

  try {
    const delegate = await runtime.runPromise(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: otlpTracesUrl,
          exportInterval: `${exportIntervalMs} millis`,
          resource: CLIENT_TRACING_RESOURCE,
        }),
      ),
    );

    if (generation !== configurationGeneration) {
      await disposeTracerRuntime(runtime, scope);
      return;
    }

    activeDelegate = delegate;
    activeRuntime = runtime;
    activeScope = scope;
  } catch (error) {
    await disposeTracerRuntime(runtime, scope);

    if (generation === configurationGeneration) {
      console.warn("Failed to configure client tracing exporter", {
        error: formatError(error),
        otlpTracesUrl,
      });
    }
  }
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }

  await runtime
    .runPromise(Scope.close(scope, Exit.void))
    .catch(() => undefined)
    .finally(() => {
      runtime.dispose();
    });
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

export async function __resetClientTracingForTests() {
  configurationGeneration++;
  activeConfigKey = null;
  activeDelegate = null;
  pendingConfiguration = Promise.resolve();

  const runtime = activeRuntime;
  const scope = activeScope;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(runtime, scope);
}
