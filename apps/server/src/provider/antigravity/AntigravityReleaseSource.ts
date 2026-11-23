/**
 * AntigravityReleaseSource — which Antigravity release Threadlines offers.
 *
 * Google's CLI update feed names the newest build for each platform. When it
 * is newer than the built-in release and fits what Threadlines knows how to
 * install (`parseAntigravityFeedManifest`), it is offered, so a new version
 * (and the models it brings) reaches users without waiting for a Threadlines
 * release. Otherwise, and whenever the feed can't be read, the built-in
 * release is offered. Nothing installs on its own: the offer becomes the
 * Install or Update button.
 *
 * @module provider/antigravity/AntigravityReleaseSource
 */
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import {
  ANTIGRAVITY_FEED_HOST,
  type AntigravityAssetKey,
  type AntigravityPlatformRelease,
  antigravityFeedUrl,
  parseAntigravityFeedManifest,
} from "./AntigravityRelease.ts";

export interface AntigravityReleaseSource {
  /**
   * The release to offer. Never fails. Asks the feed at most once an hour
   * and waits for it at most a few seconds; a slow answer is used by the
   * next call.
   */
  readonly newest: Effect.Effect<AntigravityPlatformRelease>;
}

/** Like the other providers' newest-version checks (`providerMaintenance`). */
const ASK_EVERY_MS = 60 * 60 * 1000;
/** After the feed couldn't be read, the last answer (or the built-in release) is used until then. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const WAIT_AT_MOST = Duration.seconds(4);
const READ_TIMEOUT_MS = 30_000;
/** A manifest is three short fields. */
const MAX_MANIFEST_BYTES = 16 * 1024;

/** Reads Google's feed only, on every redirect hop too. */
export const makeAntigravityFeedFetch = (): DownloadFetch =>
  makeHttpsFetch({ publicAddressesOnly: true, allowedHosts: [ANTIGRAVITY_FEED_HOST] });

/** The feed's manifest for `assetKey`, or undefined when it can't be read. */
async function readManifest(
  fetchFeed: DownloadFetch,
  assetKey: AntigravityAssetKey,
): Promise<unknown> {
  const response = await fetchFeed(antigravityFeedUrl(assetKey), {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`the feed answered ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) throw new Error("the manifest is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // `parseAntigravityFeedManifest` checks every field.
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function makeAntigravityReleaseSource(input: {
  readonly builtIn: AntigravityPlatformRelease;
  readonly assetKey: AntigravityAssetKey;
  /** Test seam for reading the feed. */
  readonly fetch?: DownloadFetch;
}): AntigravityReleaseSource {
  const { builtIn, assetKey } = input;
  const fetchFeed = input.fetch ?? makeAntigravityFeedFetch();

  /** What the feed offers now, or the built-in release when that is newer or the feed's isn't usable. */
  const ask = async () => {
    const listed = parseAntigravityFeedManifest(await readManifest(fetchFeed, assetKey), assetKey);
    return listed && compareSemverVersions(listed.version, builtIn.version) > 0 ? listed : builtIn;
  };

  let last: { readonly offer: AntigravityPlatformRelease; readonly askedAtMs: number } | undefined;
  let failedAtMs: number | undefined;
  /** One read at a time: a slow one is shared, and its answer kept for the next call. */
  let inFlight: Promise<void> | undefined;
  const within = (sinceMs: number | undefined, nowMs: number, spanMs: number) =>
    sinceMs !== undefined && nowMs - sinceMs >= 0 && nowMs - sinceMs < spanMs;

  const refresh = (nowMs: number) =>
    Effect.promise(() => {
      inFlight ??= ask()
        .then(
          (offer) => {
            last = { offer, askedAtMs: nowMs };
            failedAtMs = undefined;
          },
          () => {
            failedAtMs = nowMs;
          },
        )
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    });

  const newest = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const fresh = last && within(last.askedAtMs, nowMs, ASK_EVERY_MS);
    // While the feed is down, every refresh would ask again: wait a while.
    if (!fresh && !within(failedAtMs, nowMs, RETRY_AFTER_FAILURE_MS)) {
      yield* refresh(nowMs).pipe(Effect.timeoutOption(WAIT_AT_MOST));
    }
    return last?.offer ?? builtIn;
  });

  return { newest };
}
