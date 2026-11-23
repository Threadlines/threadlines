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
  /** First day every reading since has seen in full. Absent until one has. */
  completeFrom: Schema.optionalKey(Schema.String),
  /** The day of the last reading that saw its days in full. */
  completeThrough: Schema.optionalKey(Schema.String),
});
type SavedTokenHistory = typeof SavedTokenHistory.Type;

const decodeSavedTokenHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SavedTokenHistory),
);

type DayTotals = ReadonlyMap<string, number>;

/** The days a history has seen in full: every day in it has its true total, zeros included. */
export interface TokenUsageCompleteRange {
  readonly from: string;
  readonly through: string;
}

const laterDateKey = (left: string, right: string): string => (left > right ? left : right);
const earlierDateKey = (left: string, right: string): string => (left < right ? left : right);

const rangesOverlap = (left: TokenUsageCompleteRange, right: TokenUsageCompleteRange): boolean =>
  left.from <= right.through && right.from <= left.through;

/**
 * Extend the range a history has seen in full with one reading that saw
 * `readingFrom` through `today` in full. A range's last day was only seen up
 * to the moment of that read, so the reading has to cover it again to join:
 * the history then stays complete from its first day. A reading after a gap
 * starts the range over; one entirely before the range (a clock set back, a
 * read that started before another one finished) leaves it as it is.
 */
export const extendTokenUsageCompleteRange = (
  previous: TokenUsageCompleteRange | undefined,
  readingFrom: string,
  today: string,
): TokenUsageCompleteRange => {
  const reading = { from: readingFrom, through: today };
  if (!previous) return reading;
  if (rangesOverlap(previous, reading)) {
    return {
      from: earlierDateKey(previous.from, reading.from),
      through: laterDateKey(previous.through, reading.through),
    };
  }
  return reading.through < previous.from ? previous : reading;
};

/** Combine two ranges known for one history: joined when they overlap, else the later one. */
const combineKnownRanges = (
  left: TokenUsageCompleteRange | undefined,
  right: TokenUsageCompleteRange | undefined,
): TokenUsageCompleteRange | undefined => {
  if (!left || !right) return left ?? right;
  if (rangesOverlap(left, right)) {
    return {
      from: earlierDateKey(left.from, right.from),
      through: laterDateKey(left.through, right.through),
    };
  }
  return left.through >= right.through ? left : right;
};

const sameRange = (
  left: TokenUsageCompleteRange | undefined,
  right: TokenUsageCompleteRange | undefined,
): boolean => left?.from === right?.from && left?.through === right?.through;

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
const sessionRanges = new Map<string, TokenUsageCompleteRange>();

/**
 * Open the saved history for one source folder. `remember` merges a fresh
 * reading into it, saves the last 366 days, and returns every day from the
 * reading and the saved history together, sorted by date, with the range of
 * days the history has seen in full. A reading passes `completeFrom` only when
 * it saw every day from there through today in full.
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
      const empty = { days: new Map<string, number>(), range: undefined };
      if (!exists) return { ...empty, writable: true };
      const raw = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
      if (raw === undefined) return { ...empty, writable: false };
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
          range:
            document.completeFrom !== undefined &&
            document.completeThrough !== undefined &&
            parseProviderTokenUsageDateKey(document.completeFrom) !== null &&
            parseProviderTokenUsageDateKey(document.completeThrough) !== null &&
            document.completeFrom <= document.completeThrough
              ? { from: document.completeFrom, through: document.completeThrough }
              : undefined,
          writable: true,
        })),
        Effect.catchCause(() =>
          Effect.logWarning("saved token history is unreadable, leaving it alone", {
            path: filePath,
          }).pipe(Effect.as({ ...empty, writable: false })),
        ),
      );
    });

    const save = (days: DayTotals, range: TokenUsageCompleteRange | undefined) =>
      writeFileStringAtomically({
        filePath,
        contents: `${JSON.stringify({
          version: 1,
          source: input.source,
          days: Object.fromEntries(days),
          ...(range ? { completeFrom: range.from, completeThrough: range.through } : {}),
        } satisfies SavedTokenHistory)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not save token history", { path: filePath, cause }),
        ),
      );

    const remember = (input: {
      readonly reading: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
      readonly today: string;
      readonly completeFrom?: string;
    }): Effect.Effect<{
      readonly buckets: ReadonlyArray<ServerProviderAccountTokenUsageDailyBucket>;
      readonly completeRange?: TokenUsageCompleteRange;
    }> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const { reading } = input;
          const file = yield* load;
          const readingDays = reading.map((bucket) => [bucket.startDate, bucket.tokens] as const);
          const merged = mergeTokenUsageDays([
            file.days,
            sessionDays.get(filePath) ?? [],
            readingDays,
          ]);
          // A reading can carry an older "today" than days already saved: it
          // started before another finished, or the clock was set back. Those
          // later days stay, and the year kept counts from the latest of them
          // within a week, so one far-off date can't push the rest out.
          const latestAllowed = shiftProviderTokenUsageDateKey(input.today, 7) ?? input.today;
          const latestDateKey = [...merged.keys()]
            .filter((dateKey) => dateKey <= latestAllowed)
            .reduce(laterDateKey, input.today);
          const firstKept = shiftProviderTokenUsageDateKey(
            latestDateKey,
            -(PROVIDER_TOKEN_USAGE_RETENTION_DAYS - 1),
          );
          const kept = new Map(
            [...mergeTokenUsageDays([merged], firstKept)].toSorted(([left], [right]) =>
              left.localeCompare(right),
            ),
          );
          // This process may know a range a failed save left out of the file.
          const knownRange = combineKnownRanges(file.range, sessionRanges.get(filePath));
          const range =
            input.completeFrom === undefined
              ? knownRange
              : extendTokenUsageCompleteRange(knownRange, input.completeFrom, input.today);
          sessionDays.set(filePath, kept);
          if (range) sessionRanges.set(filePath, range);
          if (file.writable && (!sameDays(kept, file.days) || !sameRange(range, file.range))) {
            yield* save(kept, range);
          }
          // Older days in the reading (Claude's own stats cache keeps them)
          // still count toward streaks, so they come back too.
          return {
            buckets: toBuckets(mergeTokenUsageDays([readingDays, kept])),
            ...(range ? { completeRange: range } : {}),
          };
        }),
      );

    return { filePath, remember } as const;
  },
);
