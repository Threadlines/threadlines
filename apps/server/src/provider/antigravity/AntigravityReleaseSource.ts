/**
 * AntigravityReleaseSource — which Antigravity release Threadlines offers.
 *
 * Google lists each new Antigravity in the ACP registry. When that listing
 * is newer than the built-in release and fits what Threadlines knows how to
 * run (`antigravityListedRelease`), it is offered, so a new version (and the
 * models it brings) reaches users without waiting for a Threadlines release.
 * Otherwise, and whenever the registry can't be read, the built-in release
 * is offered. Nothing installs on its own: the offer becomes the Install or
 * Update button.
 *
 * @module provider/antigravity/AntigravityReleaseSource
 */
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AcpRegistryCatalogShape } from "../acpRegistry/AcpRegistryCatalog.ts";
import type { ManagedRuntimeError } from "../managedRuntime/ManagedRuntimeStore.ts";
import {
  ANTIGRAVITY_REGISTRY_AGENT_ID,
  type AntigravityAssetKey,
  type AntigravityListedRelease,
  type AntigravityPlatformRelease,
  antigravityListedRelease,
} from "./AntigravityRelease.ts";
import { type AntigravityFetch, resolveAntigravityListedRelease } from "./AntigravityRuntime.ts";

export interface AntigravityReleaseOffer {
  readonly version: string;
  /** The release with its file sizes, for `AntigravityRuntime.install`. */
  readonly release: Effect.Effect<AntigravityPlatformRelease, ManagedRuntimeError>;
}

export interface AntigravityReleaseSource {
  /**
   * The release to offer. Never fails. Asks the registry at most once an
   * hour and waits for it at most a few seconds; a slow answer is used by
   * the next call.
   */
  readonly newest: Effect.Effect<AntigravityReleaseOffer>;
}

/** Like the other providers' newest-version checks (`providerMaintenance`). */
const ASK_EVERY_MS = 60 * 60 * 1000;
/** After the registry couldn't be read, the saved copy is used until then. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const WAIT_AT_MOST = Duration.seconds(4);

export function makeAntigravityReleaseSource(input: {
  readonly builtIn: AntigravityPlatformRelease;
  readonly assetKey: AntigravityAssetKey;
  readonly platform: NodeJS.Platform;
  readonly catalog: Pick<AcpRegistryCatalogShape, "get" | "peek">;
  /** Test seam for reading a listed release's sizes. */
  readonly fetch?: AntigravityFetch;
}): AntigravityReleaseSource {
  const { builtIn } = input;
  const builtInOffer: AntigravityReleaseOffer = {
    version: builtIn.version,
    release: Effect.succeed(builtIn),
  };
  const executableName = builtIn.asset.executable.name;
  const harnessName = builtIn.asset.harness.name;

  /** Releases whose sizes were read, so each is read once. */
  const resolved = new Map<string, AntigravityPlatformRelease>();
  const offerFor = (listed: AntigravityListedRelease): AntigravityReleaseOffer => ({
    version: listed.version,
    release: Effect.suspend(() => {
      const key = [listed.version, listed.url, listed.sha256].join("\u0000");
      const known = resolved.get(key);
      if (known) return Effect.succeed(known);
      return resolveAntigravityListedRelease({
        listed,
        executableName,
        harnessName,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      }).pipe(Effect.tap((release) => Effect.sync(() => resolved.set(key, release))));
    }),
  });

  const fromRegistry = (ask: boolean) =>
    Effect.gen(function* () {
      const fresh = ask
        ? yield* input.catalog.get().pipe(
            Effect.timeoutOption(WAIT_AT_MOST),
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      const snapshot = fresh ?? (yield* input.catalog.peek);
      // A release the registry has pulled must not be offered, so nothing is
      // offered until the list of pulled agents has been read.
      const recipe =
        snapshot?.quarantineKnown !== true
          ? undefined
          : snapshot.builtIn.find(
              (candidate) => candidate.agentId === ANTIGRAVITY_REGISTRY_AGENT_ID,
            );
      const listed = recipe && antigravityListedRelease(recipe, input.assetKey, input.platform);
      const offer =
        listed && compareSemverVersions(listed.version, builtIn.version) > 0
          ? offerFor(listed)
          : builtInOffer;
      // Only an answer from the registry counts as asked; a saved copy (the
      // registry couldn't be read) is asked again next time.
      return { offer, asked: fresh !== undefined && !fresh.stale };
    });

  let last: { readonly offer: AntigravityReleaseOffer; readonly askedAtMs: number } | undefined;
  let failedAtMs: number | undefined;
  const within = (sinceMs: number | undefined, nowMs: number, spanMs: number) =>
    sinceMs !== undefined && nowMs - sinceMs >= 0 && nowMs - sinceMs < spanMs;
  const newest = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (last && within(last.askedAtMs, nowMs, ASK_EVERY_MS)) return last.offer;
    // While the registry is down, every refresh would ask again: wait a while.
    const ask = !within(failedAtMs, nowMs, RETRY_AFTER_FAILURE_MS);
    const { offer, asked } = yield* fromRegistry(ask);
    if (asked) {
      last = { offer, askedAtMs: nowMs };
      failedAtMs = undefined;
    } else if (ask) {
      failedAtMs = nowMs;
    }
    return offer;
  });

  return { newest };
}
