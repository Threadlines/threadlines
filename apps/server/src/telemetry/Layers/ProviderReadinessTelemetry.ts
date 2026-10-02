/**
 * ProviderReadinessTelemetry - reports whether this machine can chat with an
 * agent, so new installs that never send a message can be told apart: no
 * agent installed, installed but signed out, or ready and still unused.
 *
 * Reports once the provider checks settle after launch, then again only when
 * the answer changes (someone installs a CLI or signs in).
 *
 * @module ProviderReadinessTelemetry
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { providerChecksSettled, providerReadinessProperties } from "../AnalyticsProperties.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";

export const PROVIDER_READINESS_EVENT = "provider.readiness";

/**
 * How often the current list is re-read alongside the change stream. The
 * change stream doesn't replay, so a probe that finishes before it's
 * subscribed would otherwise go unreported until the next five-minute
 * refresh, and new users who leave sooner are exactly who this is for.
 * A re-read is an in-memory lookup; unchanged answers are dropped below.
 */
const READINESS_REREAD_INTERVAL = "15 seconds";

export const reportProviderReadiness = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const analytics = yield* AnalyticsService;

  const rereads = Stream.tick(READINESS_REREAD_INTERVAL).pipe(
    Stream.mapEffect(() => registry.getProviders),
  );
  yield* Stream.merge(rereads, registry.streamChanges).pipe(
    Stream.filter(providerChecksSettled),
    Stream.map(providerReadinessProperties),
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Stream.runForEach((properties) => analytics.record(PROVIDER_READINESS_EVENT, properties)),
  );
});

export const ProviderReadinessTelemetryLive = Layer.effectDiscard(
  reportProviderReadiness.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped),
);
