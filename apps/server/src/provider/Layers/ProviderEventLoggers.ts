// @effect-diagnostics nodeBuiltinImport:off
/**
 * ProviderEventLoggers — single observability service that owns the two
 * shared NDJSON streams the provider runtime writes:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     should share one underlying log writer per stream — opening N writers
 *     against the same rotating file would race the rotation logic. Owning
 *     the loggers on a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional. `makeEventNdjsonLogger` returns `undefined` when
 * the target directory cannot be created; we forward that as `undefined`
 * rather than failing the boot Layer, matching the previous best-effort
 * behavior of `server.ts`.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import path from "node:path";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { SecretScrubber, type SecretScrubberShape } from "../../secrets/SecretScrubber.ts";
import {
  cleanupProviderEventLogDirectory,
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "./EventNdjsonLogger.ts";

export interface ProviderEventLoggersShape {
  readonly native: EventNdjsonLogger | undefined;
  readonly canonical: EventNdjsonLogger | undefined;
}

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`ProviderEventLoggersLive`); consumers (drivers, `ProviderService`) read
 * one tag and pluck the field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()("threadlines/provider/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggersShape = {
  native: undefined,
  canonical: undefined,
};

/**
 * A record's JSON line with saved keys hidden. The text is only searched; a
 * line with a match is parsed and its strings and member names scrubbed, so
 * a value that ends in a quote can't eat the line's own quote and break it.
 */
function scrubJsonLine(
  scrubber: Pick<SecretScrubberShape, "scrubText" | "scrubDeep">,
  line: string,
): string {
  const found = scrubber.scrubText(line);
  if (found.names.length === 0) return line;
  try {
    return JSON.stringify(scrubber.scrubDeep(JSON.parse(line) as unknown));
  } catch {
    return found.text;
  }
}

/**
 * Live Layer that builds both loggers from `ServerConfig.providerEventLogPath`.
 * If the directory create fails for either stream, the corresponding field
 * is `undefined` and writes from that stream become no-ops downstream.
 */
export const ProviderEventLoggersLive = Layer.effect(
  ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    // Token-sized stream pieces are left out of both logs unless this is set
    // (see EventLogWriteOptions.streamFragment).
    const keepStreamFragments = yield* Config.Boolean(
      "THREADLINES_PROVIDER_LOG_STREAM_FRAGMENTS",
    ).pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false),
    );
    // Raw provider messages, written before any event passes the hook in
    // ProviderService: saved keys are hidden here, line by line. The
    // canonical log only ever gets events the hook already scrubbed.
    const secretScrubber = yield* SecretScrubber;
    const native = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
      keepStreamFragments,
      scrubLine: (line) => scrubJsonLine(secretScrubber, line),
    });
    const canonical = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
      keepStreamFragments,
    });
    yield* cleanupProviderEventLogDirectory(path.dirname(providerEventLogPath), {
      isFileActive: (candidatePath) =>
        (native?.hasActivePath?.(candidatePath) ?? false) ||
        (canonical?.hasActivePath?.(candidatePath) ?? false),
    }).pipe(
      Effect.flatMap((cleanup) => {
        if (cleanup.deletedFiles > 0 || cleanup.errorCount > 0) {
          const logCleanupResult = cleanup.errorCount > 0 ? Effect.logWarning : Effect.logInfo;
          return logCleanupResult("provider event log cleanup completed", {
            deletedFiles: cleanup.deletedFiles,
            deletedBytes: cleanup.deletedBytes,
            retainedBytes: cleanup.retainedBytes,
            errorCount: cleanup.errorCount,
          });
        }
        return Effect.void;
      }),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.all([native?.close() ?? Effect.void, canonical?.close() ?? Effect.void], {
        discard: true,
      }).pipe(Effect.ignore),
    );
    return {
      native,
      canonical,
    } satisfies ProviderEventLoggersShape;
  }),
);
