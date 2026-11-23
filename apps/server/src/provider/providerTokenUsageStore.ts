/**
 * Saved daily token totals for usage history that a provider reads from local
 * files the provider itself deletes over time. Claude Code removes transcripts
 * `cleanupPeriodDays` (30 by default) after they were last written, so a
 * calendar built only from what is on disk shrinks to about a month.
 *
 * Each read folds what it saw into the saved days and gets the union back, so a
 * day keeps its total after its files are gone. A day only ever grows: a lower
 * reading for a saved day means files went missing, not that usage went down.
 *
 * The file lives in the server's state folder (one per source folder), apart
 * from the provider status cache: a status check that comes back signed out or
 * unknown can't wipe it, and a dev server never writes the installed app's copy.
 *
 * @module provider/providerTokenUsageStore
 */
import { createHash } from "node:crypto";

import type { ServerProviderAccountTokenUsageDailyBucket } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  parseProviderTokenUsageDateKey,
  PROVIDER_TOKEN_USAGE_RETENTION_DAYS,
  shiftProviderTokenUsageDateKey,
} from "./providerTokenUsageHistory.ts";

/** Folder under the server's state folder that holds the saved histories. */
export const PROVIDER_TOKEN_HISTORY_DIR_NAME = "provider-token-history";

const SavedTokenHistory = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.String,
  days: Schema.Record(Schema.String, Schema.Number),
});
type SavedTokenHistory = typeof SavedTokenHistory.Type;

const decodeSavedTokenHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SavedTokenHistory),
);

type DayTotals = ReadonlyMap<string, number>;

/**
 * Merge readings by day, keeping the larger total for a day both have.
 * Days before `firstDateKey` are left out when it is given.
 */
export const mergeTokenUsageDays = (
  readings: ReadonlyArray<Iterable<readonly [string, number]>>,
  firstDateKey?: string,
): Map<string, number> => {
  const merged = new Map<string, number>();
  for (const reading of readings) {
    for (const [dateKey, tokens] of reading) {
      if (firstDateKey !== undefined && dateKey < firstDateKey) continue;
      merged.set(dateKey, Math.max(merged.get(dateKey) ?? 0, tokens));
    }
  }
  return merged;
};

const sameDays = (left: DayTotals, right: DayTotals): boolean =>
  left.size === right.size && [...left].every(([dateKey, tokens]) => right.get(dateKey) === tokens);

const toBuckets = (days: DayTotals): ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket> =>
  [...days]
    .map(([startDate, tokens]) => ({ startDate, tokens }))
    .toSorted((left, right) => left.startDate.localeCompare(right.startDate));

// Every reader of one history file goes through the same lock and the same
// in-memory days, so two readers of one Claude folder (two instances, or an
// instance and its replacement after a settings change) can't overwrite each
// other from stale copies. The days also hold what a failed save left out.
const fileLocks = new Map<string, Semaphore.Semaphore>();
const sessionDays = new Map<string, Map<string, number>>();

/**
 * Open the saved history for one source folder. `remember` merges a fresh
 * reading into it, saves the last 366 days, and returns every day from the
 * reading and the saved history together, sorted by date.
 */
export const makeProviderTokenUsageStore = Effect.fn("makeProviderTokenUsageStore")(
  function* (input: {
    /** The server's state folder (`ServerConfig.stateDir`). */
    readonly stateDir: string;
    /** Names the history, e.g. `claude`. Part of the file name. */
    readonly provider: string;
    /** The folder the readings come from. Different folders keep different histories. */
    readonly source: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceHash = createHash("sha256").update(input.source).digest("hex").slice(0, 16);
    const filePath = path.join(
      input.stateDir,
      PROVIDER_TOKEN_HISTORY_DIR_NAME,
      `${input.provider}-${sourceHash}.json`,
    );
    let lock = fileLocks.get(filePath);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      fileLocks.set(filePath, lock);
    }

    // Read fresh on every use. `writable` is false when the file can't be read
    // right now or holds something this build doesn't understand (a newer
    // format, a damaged file): it is left alone and tried again next time.
    const load = Effect.gen(function* () {
      const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => true));
      if (!exists) return { days: new Map<string, number>(), writable: true };
      const raw = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
      if (raw === undefined) return { days: new Map<string, number>(), writable: false };
      return yield* decodeSavedTokenHistory(raw).pipe(
        Effect.map((document) => ({
          days: mergeTokenUsageDays([
            Object.entries(document.days).filter(
              ([dateKey, tokens]) =>
                parseProviderTokenUsageDateKey(dateKey) !== null &&
                Number.isSafeInteger(tokens) &&
                tokens >= 0,
            ),
          ]),
          writable: true,
        })),
        Effect.catchCause(() =>
          Effect.logWarning("saved token history is unreadable, leaving it alone", {
            path: filePath,
          }).pipe(Effect.as({ days: new Map<string, number>(), writable: false })),
        ),
      );
    });

    const save = (days: DayTotals) =>
      writeFileStringAtomically({
        filePath,
        contents: `${JSON.stringify({
          version: 1,
          source: input.source,
          days: Object.fromEntries(days),
        } satisfies SavedTokenHistory)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not save token history", { path: filePath, cause }),
        ),
      );

    const remember = (
      reading: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>,
      todayDateKey: string,
    ): Effect.Effect<ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* load;
          const readingDays = reading.map((bucket) => [bucket.startDate, bucket.tokens] as const);
          const firstKept = shiftProviderTokenUsageDateKey(
            todayDateKey,
            -(PROVIDER_TOKEN_USAGE_RETENTION_DAYS - 1),
          );
          const kept = new Map(
            [
              ...mergeTokenUsageDays(
                [file.days, sessionDays.get(filePath) ?? [], readingDays],
                firstKept,
              ),
            ]
              .filter(([dateKey]) => dateKey <= todayDateKey)
              .toSorted(([left], [right]) => left.localeCompare(right)),
          );
          sessionDays.set(filePath, kept);
          if (file.writable && !sameDays(kept, file.days)) yield* save(kept);
          // Older days in the reading (Claude's own stats cache keeps them)
          // still count toward streaks, so they come back too.
          return toBuckets(mergeTokenUsageDays([readingDays, kept]));
        }),
      );

    return { filePath, remember } as const;
  },
);
