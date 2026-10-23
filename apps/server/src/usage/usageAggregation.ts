// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, provider, model)` buckets, and
 * the trailing hours into `(hour, provider, model)` buckets.
 *
 * `Intl.DateTimeFormat` is the only reliable way to resolve a wall-clock day in
 * an arbitrary IANA zone, and it takes a `Date`. That is why the raw `Date`
 * construction is allowed here; nothing in this module reads the clock.
 *
 * Pure, so the bucketing and de-duplication rules are testable without touching
 * the filesystem or the network.
 *
 * @module usageAggregation
 */
import type {
  UsageBucket,
  UsageDay,
  UsageHourBucket,
  UsageTokenTotals,
} from "@threadlines/contracts";

import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

/**
 * Formats an instant as a `YYYY-MM-DD` day in `timeZone`.
 *
 * `en-CA` yields ISO-ordered parts, which is why it is used here rather than
 * assembling the day from `Date` getters (those are host-local only).
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than fail the whole scan.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

const HOUR_MS = 60 * 60 * 1000;

/** The furthest instant a `Date` can hold. */
const MAX_DATE_MS = 8.64e15;

/** Start of the hour holding `timestampMs`, in absolute time. */
export function hourStartOf(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

interface MutableHourBucket {
  readonly hourStartMs: number;
  readonly provider: UsageHourBucket["provider"];
  readonly model: string;
  readonly source: number | undefined;
  totals: UsageTokenTotals;
  costUsd: number;
  records: number;
}

interface MutableBucket {
  readonly day: string;
  readonly provider: UsageBucket["provider"];
  readonly model: string;
  readonly source: number | undefined;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  /**
   * In-window records at or after this instant are also bucketed by hour.
   * Omitted, nothing is.
   */
  readonly hourlySinceMs?: number;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly hourlyBuckets: readonly UsageHourBucket[];
  /** Records dropped because an earlier record carried the same dedupe key. */
  readonly duplicatesDropped: number;
  /** Records whose day fell outside the requested window. */
  readonly outOfWindow: number;
}

/**
 * Accumulates records across many files.
 *
 * De-duplication is global across the whole scan, not per file: Claude Code
 * copies a message's records forward when a session is resumed or relocated, so
 * the same `dedupeKey` legitimately appears in several transcripts.
 */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #hourlyBuckets = new Map<string, MutableHourBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #options: AggregateOptions;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
  }

  /**
   * Folds one record in. Returns whether it actually contributed, so callers
   * can derive per-window facts (distinct sessions, for one) from the records
   * that landed rather than everything the mtime prefilter happened to admit.
   *
   * `source` is the index of the summary source the record was read from; it
   * keeps one source's records in buckets of their own.
   */
  add(record: UsageRecord, source?: number): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    // A damaged record's time can be past what a Date holds, and formatting
    // it would throw and fail the whole summary.
    if (!Number.isFinite(record.timestampMs) || Math.abs(record.timestampMs) > MAX_DATE_MS) {
      this.#outOfWindow += 1;
      return false;
    }
    const day = this.#toDay(record.timestampMs);
    if (day < this.#options.sinceDay || day > this.#options.untilDay) {
      this.#outOfWindow += 1;
      return false;
    }

    const key = `${day}\u0000${record.provider}\u0000${record.model}\u0000${source ?? ""}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        day,
        provider: record.provider,
        model: record.model,
        source,
        totals: EMPTY_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    const priced = priceUsage(this.#options.rates, record);

    bucket.totals = addTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(this.#options.rates, record.model, record.totals);
    bucket.records += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);

    const hourlySinceMs = this.#options.hourlySinceMs;
    if (hourlySinceMs !== undefined && record.timestampMs >= hourlySinceMs) {
      const hourStartMs = hourStartOf(record.timestampMs);
      const hourKey = `${hourStartMs}\u0000${record.provider}\u0000${record.model}\u0000${source ?? ""}`;
      let hour = this.#hourlyBuckets.get(hourKey);
      if (hour === undefined) {
        hour = {
          hourStartMs,
          provider: record.provider,
          model: record.model,
          source,
          totals: EMPTY_TOTALS,
          costUsd: 0,
          records: 0,
        };
        this.#hourlyBuckets.set(hourKey, hour);
      }
      hour.totals = addTotals(hour.totals, record.totals);
      hour.costUsd += priced.costUsd;
      hour.records += 1;
    }
    return true;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const bucket of this.#buckets.values()) {
      buckets.push({
        day: bucket.day as UsageDay,
        provider: bucket.provider,
        model: bucket.model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
        ...(bucket.source === undefined ? {} : { source: bucket.source }),
      });
    }
    // Stable ordering keeps payloads diffable and snapshot tests meaningful.
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        (a.source ?? -1) - (b.source ?? -1),
    );

    const hourlyBuckets: UsageHourBucket[] = [];
    for (const hour of this.#hourlyBuckets.values()) {
      hourlyBuckets.push({
        hourStartMs: hour.hourStartMs,
        provider: hour.provider,
        model: hour.model,
        totals: hour.totals,
        costUsd: hour.costUsd,
        records: hour.records,
        ...(hour.source === undefined ? {} : { source: hour.source }),
      });
    }
    hourlyBuckets.sort(
      (a, b) =>
        a.hourStartMs - b.hourStartMs ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        (a.source ?? -1) - (b.source ?? -1),
    );

    return {
      buckets,
      hourlyBuckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

/**
 * A bucket mixes records from one model, but their cost provenance can differ
 * when only some records carried a reported cost. The weakest provenance in the
 * bucket wins so the UI never overstates confidence.
 */
function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
