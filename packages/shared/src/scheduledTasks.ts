/**
 * Scheduled tasks' schedules (docs/design/fleet.md, Part 6): turning a
 * cadence into the UTC instants ("slots") it runs at, checking one can be
 * saved, and naming it for people ("Weekdays at 9:00"). The server's
 * scheduler and the client's form read the same rules from here.
 *
 * Every cadence but `manual` compiles to a 5-field cron expression (minute
 * resolution) evaluated with `effect/Cron` in the task's own time zone; a
 * `once` cadence is the one instant that expression gives on its date. A
 * cadence that runs every hour (its hour field is `*`: hourly, every 15
 * minutes) keeps to real time through clock changes: it runs whenever the
 * wall clock reads a matching time, in both passes of a repeated stretch and
 * never in a skipped one. One with set hours runs each wall time once: a time
 * the clocks skip (02:30) runs the same distance past the jump (03:30), and
 * one they repeat runs at the earlier instant.
 *
 * Every call that evaluates a schedule catches what `effect/Cron` throws, so
 * one task's bad schedule can only fail that task.
 *
 * This is not `cronSchedule.ts`, which predicts when Claude's own scheduler
 * fires a check-back and follows Claude's rules.
 */
import type { ScheduledTaskCadence, ScheduledTaskClock } from "@threadlines/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { describeWebhookCadence } from "./webhookTasks.ts";

/** A schedule must run within this long of being saved. */
export const SCHEDULED_TASK_SAVE_HORIZON_MS = 366 * 24 * 60 * 60_000;
/** Missed slots older than this never get a catch-up run. */
export const SCHEDULED_TASK_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * A slot handled this late still counts as on time: the scheduler looks every
 * 30 seconds, so anything later means the computer was off, asleep or busy.
 */
export const SCHEDULED_TASK_ON_TIME_MS = 90_000;
/** Runs that may be working at once on one computer. */
export const SCHEDULED_TASK_RUN_CAP = 3;

const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DAY_MS = 24 * 60 * 60_000;

/** A `once` cadence's date as numbers; null when it isn't a calendar day. */
function dateParts(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/**
 * The 5-field cron expression a cadence runs on; null for `manual` and
 * `webhook` (an event task runs when an event arrives, never on a clock). A
 * `once` cadence's expression recurs every year; only its date's instance
 * counts.
 */
export function cadenceCronExpression(cadence: ScheduledTaskCadence): string | null {
  switch (cadence.kind) {
    case "manual":
    case "webhook":
      return null;
    case "once": {
      const parts = dateParts(cadence.date);
      return parts === null
        ? null
        : `${cadence.time.minute} ${cadence.time.hour} ${parts.day} ${parts.month} *`;
    }
    case "hourly":
      return `${cadence.minute} * * * *`;
    case "daily":
      return `${cadence.time.minute} ${cadence.time.hour} * * *`;
    case "weekdays":
      return `${cadence.time.minute} ${cadence.time.hour} * * 1-5`;
    case "weekly":
      return `${cadence.time.minute} ${cadence.time.hour} * * ${cadence.weekday}`;
    case "custom":
      return cadence.cron.trim();
  }
}

/**
 * Whether two cadences run at the same times: an edit that sends a task's
 * schedule back unchanged (a form always sends it) changes nothing.
 */
export function sameCadence(left: ScheduledTaskCadence, right: ScheduledTaskCadence): boolean {
  const key = (cadence: ScheduledTaskCadence) =>
    cadence.kind === "once"
      ? `once ${cadence.date} ${cadence.time.hour}:${cadence.time.minute}`
      : cadence.kind === "webhook"
        ? `webhook ${JSON.stringify(cadence)}`
        : `${cadence.kind} ${cadenceCronExpression(cadence) ?? ""}`;
  return key(left) === key(right);
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  return Option.isSome(DateTime.zoneMakeNamed(timeZone));
}

/**
 * A cadence worked out in its time zone: its slots, the UTC instants it runs
 * at, one after another.
 */
export interface CadenceSchedule {
  /**
   * The first slot strictly after `after`; null when it has no more (a
   * `once` cadence past its time). Fails when a schedule stops making sense.
   */
  readonly next: (after: Date) => Result.Result<Date | null, string>;
}

/**
 * No zone changes its offset twice within this long (the closest pair in the
 * time zone database, Morocco's pause for Ramadan, is weeks apart), so two
 * readings this far apart that agree have no change between them.
 */
const OFFSET_PROBE_MS = 6 * 60 * 60_000;

/**
 * Wider than any one clock change (two hours at most, in Antarctica/Troll),
 * and than the spread of any zone's offsets. A clock change moves a match by
 * less than this, so a match is never more than this from where the wall
 * clock says it is.
 */
const CHANGE_REACH_MS = 3 * 60 * 60_000;

/**
 * Passes past the first in an every-hour cadence's search: each one means the
 * last matching day's only matches were in a stretch the clocks skipped, which
 * takes a clock change on a matching day. Eight in a row never happen.
 */
const MAX_SKIPPED_DAYS = 8;

/** `zone`'s offset from UTC at the instant `at`, in milliseconds. */
const offsetAt = (zone: DateTime.TimeZone, at: number) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(at, { timeZone: zone }));

/**
 * The first instant in (from, to] where `zone` is no longer at `offset`, the
 * offset it has at `from`; null when it keeps it throughout. Readings every
 * OFFSET_PROBE_MS find the stretch the change is in, and halving that
 * stretch finds the instant in at most 25 steps. Callers keep (from, to]
 * short: a few readings each.
 */
const firstOffsetChange = (
  zone: DateTime.TimeZone,
  from: number,
  to: number,
  offset: number,
): number | null => {
  let low = from;
  while (low < to) {
    let high = Math.min(low + OFFSET_PROBE_MS, to);
    if (offsetAt(zone, high) !== offset) {
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetAt(zone, middle) === offset) low = middle;
        else high = middle;
      }
      return high;
    }
    low = high;
  }
  return null;
};

/**
 * A cadence's next slot. `Cron.next` works in wall time: it takes the first
 * matching wall time after the input's, at that wall time's earlier instant,
 * and moves a wall time the clocks skip past the jump. That is fast at any
 * distance, and right except next to a clock change. Two kinds of cadence
 * want different things there:
 *
 * - An every-hour cadence (its hour field matches every hour) keeps to real
 *   time: its next slot is the first instant whose own wall clock matches.
 *   Between two clock changes the offset is fixed, so within a short window
 *   that is the first match of `wall` (the expression read in UTC) shifted by
 *   the offset, started again from each change at the new offset. Only two
 *   short windows can hold the answer (see `nextInRealTime`), so the work
 *   follows the clock changes near the answer, never the distance to it.
 * - A cadence with set hours runs each wall time once, so `Cron.next` is
 *   right, except in two places. Asked during a repeated stretch's second
 *   pass, it answers with the first pass's instant of a wall time still
 *   ahead, already gone: that stretch already ran, so the answer is the next
 *   one from where the first pass ended. Asked just after a jump, before a
 *   skipped time's moved instant (asked at 03:10 for 02:30, which runs at
 *   03:30), it has already passed that wall time: the skipped stretch's
 *   matches, read at the offset before the jump, come first.
 */
const cronSchedule = (zoned: Cron.Cron, wall: Cron.Cron): CadenceSchedule => {
  const zone = Option.getOrUndefined(zoned.tz);
  const everyHour = zoned.hours.size === 0 || zoned.hours.size === 24;
  /** The first instant after `at` whose wall time at a fixed `offset` matches. */
  const nextAtOffset = (at: number, offset: number) =>
    Cron.next(wall, new Date(at + offset)).getTime() - offset;
  /** The first instant in (from, to] whose own wall clock matches, if any. */
  const firstRealMatch = (tz: DateTime.TimeZone, from: number, to: number) => {
    let cursor = from;
    let offset = offsetAt(tz, from + 1);
    for (;;) {
      const candidate = nextAtOffset(cursor, offset);
      const change = firstOffsetChange(tz, cursor + 1, Math.min(candidate, to), offset);
      if (change === null) return candidate <= to ? candidate : null;
      cursor = change - 1;
      offset = offsetAt(tz, change);
    }
  };
  /**
   * The first instant after `at` whose own wall clock matches; null past
   * MAX_SKIPPED_DAYS. Take `landing`, the first match at the cursor's own
   * offset (the expression read in UTC: fast at any distance). A real match
   * R, read at that offset, is a match too, at most CHANGE_REACH_MS from R:
   * either that reading is at or before the cursor, so R is within
   * CHANGE_REACH_MS after it, or `landing` is no later than it, so R is at
   * most CHANGE_REACH_MS before `landing`. Those two windows hold the first
   * match, and nothing between them does.
   */
  const nextInRealTime = (tz: DateTime.TimeZone, at: number) => {
    let cursor = at;
    for (let pass = 0; pass <= MAX_SKIPPED_DAYS; pass += 1) {
      const nearEnd = cursor + 2 * CHANGE_REACH_MS;
      const near = firstRealMatch(tz, cursor, nearEnd);
      if (near !== null) return near;
      const landing = nextAtOffset(cursor, offsetAt(tz, cursor));
      const aroundEnd = landing + CHANGE_REACH_MS;
      if (aroundEnd > nearEnd) {
        const around = firstRealMatch(tz, Math.max(nearEnd, landing - CHANGE_REACH_MS), aroundEnd);
        if (around !== null) return around;
      }
      // The day it found had only skipped times: on from past it.
      cursor = Math.max(nearEnd, aroundEnd);
    }
    return null;
  };
  /** Asked just after a jump: the first skipped wall time still to come, at its moved instant. */
  const skippedAhead = (tz: DateTime.TimeZone, at: number, offset: number) => {
    const before = offsetAt(tz, at - CHANGE_REACH_MS);
    if (before >= offset) return null;
    const jump = firstOffsetChange(tz, at - CHANGE_REACH_MS, at, before);
    if (jump === null || at >= jump + (offset - before)) return null;
    // Read at the offset before the jump, a skipped wall time lands at its moved instant.
    const moved = nextAtOffset(at, before);
    return moved < jump + (offset - before) ? moved : null;
  };
  return {
    next: (after) => {
      try {
        const at = after.getTime();
        if (zone !== undefined && everyHour) {
          const slot = nextInRealTime(zone, at);
          if (slot !== null) return Result.succeed(new Date(slot));
        }
        const native = Cron.next(zoned, after).getTime();
        if (zone === undefined) return Result.succeed(new Date(native));
        const offset = offsetAt(zone, at);
        if (native > at) {
          const moved = skippedAhead(zone, at, offset);
          return Result.succeed(new Date(moved !== null && moved < native ? moved : native));
        }
        // A second pass: `native` is in the first, at the other offset.
        const firstPassEnd = firstOffsetChange(zone, native, at, offsetAt(zone, native));
        const resumed =
          firstPassEnd === null ? null : Cron.next(zoned, new Date(firstPassEnd - 1)).getTime();
        // Neither can happen; still, a match at today's offset beats failing.
        return Result.succeed(
          new Date(resumed !== null && resumed > at ? resumed : nextAtOffset(at, offset)),
        );
      } catch {
        return Result.fail("This schedule never runs.");
      }
    },
  };
};

/** A cron expression's schedule in `timeZone`, read in UTC too for `cronSchedule`. */
const parseCronSchedule = (expression: string, timeZone: string) =>
  Cron.parse(expression, timeZone).pipe(
    Result.flatMap((zoned) =>
      Cron.parse(expression, "UTC").pipe(Result.map((wall) => cronSchedule(zoned, wall))),
    ),
  );

/**
 * The cadence's schedule in `timeZone`; null for `manual`. Fails with one
 * plain sentence when the expression, the date or the zone doesn't parse, or
 * when a custom expression has a seconds field.
 */
export function compileCadence(
  cadence: ScheduledTaskCadence,
  timeZone: string,
): Result.Result<CadenceSchedule | null, string> {
  if (!isKnownTimeZone(timeZone)) {
    return Result.fail(`"${timeZone}" isn't a time zone this computer knows.`);
  }
  // An event task runs when an event arrives: like manual, it has no clock.
  if (cadence.kind === "manual" || cadence.kind === "webhook") return Result.succeed(null);
  if (cadence.kind === "once") return compileOnce(cadence, timeZone);
  const expression = cadenceCronExpression(cadence) ?? "";
  const fields = expression.split(/\s+/u).filter((field) => field.length > 0);
  if (fields.length !== 5) {
    return Result.fail(
      "A custom schedule takes 5 fields: minute, hour, day of month, month and day of week.",
    );
  }
  return parseCronSchedule(expression, timeZone).pipe(
    Result.mapError(() => `"${expression}" isn't a schedule Threadlines can read.`),
  );
}

/**
 * A `once` cadence: its yearly expression's instance on its own date, found
 * from two days before (no zone is that far from UTC), so a time the clocks
 * skip or repeat that day resolves as every other cadence's does.
 */
function compileOnce(
  cadence: Extract<ScheduledTaskCadence, { readonly kind: "once" }>,
  timeZone: string,
): Result.Result<CadenceSchedule, string> {
  const parts = dateParts(cadence.date);
  const expression = cadenceCronExpression(cadence);
  if (parts === null || expression === null) {
    return Result.fail(`"${cadence.date}" isn't a date.`);
  }
  const from = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - 2 * DAY_MS);
  const instant = parseCronSchedule(expression, timeZone).pipe(
    Result.mapError(() => `"${cadence.date}" isn't a date.`),
    Result.flatMap((schedule) => schedule.next(from)),
    Result.flatMap((slot) =>
      slot !== null && slot.getTime() - from.getTime() < 4 * DAY_MS
        ? Result.succeed(slot)
        : Result.fail(`"${cadence.date}" isn't a date.`),
    ),
  );
  if (Result.isFailure(instant)) return Result.fail(instant.failure);
  const at = instant.success;
  return Result.succeed({
    next: (after) => Result.succeed(at.getTime() > after.getTime() ? at : null),
  });
}

/** The first slot strictly after `after`; null when the schedule has no more. */
export const nextSlotOf = (schedule: CadenceSchedule, after: Date) => schedule.next(after);

/**
 * The cadence's next slots after `after`, as many as it has up to `count`:
 * none for `manual`. Fails when the schedule doesn't parse or never runs.
 */
export function upcomingSlots(
  cadence: ScheduledTaskCadence,
  timeZone: string,
  after: Date,
  count: number,
): Result.Result<ReadonlyArray<Date>, string> {
  const compiled = compileCadence(cadence, timeZone);
  if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
  const schedule = compiled.success;
  if (schedule === null) return Result.succeed([]);
  const slots: Array<Date> = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = schedule.next(cursor);
    if (Result.isFailure(next)) {
      return slots.length > 0 ? Result.succeed(slots) : Result.fail(next.failure);
    }
    if (next.success === null) break;
    slots.push(next.success);
    cursor = next.success;
  }
  return Result.succeed(slots);
}

/**
 * Whether a cadence can be saved: it parses, and (unless manual or an event
 * task) runs within a year of `now`. Null when it can; otherwise why not, in
 * one sentence.
 */
export function cadenceSaveRefusal(
  cadence: ScheduledTaskCadence,
  timeZone: string,
  now: Date,
): string | null {
  const next = upcomingSlots(cadence, timeZone, now, 1);
  if (Result.isFailure(next)) return next.failure;
  // No clock to check; an event task's own settings are checked with its
  // instructions (webhookTasks.ts webhookCadenceProblem).
  if (cadence.kind === "manual" || cadence.kind === "webhook") return null;
  const first = next.success[0];
  if (first === undefined && cadence.kind === "once") return "That time has already passed.";
  if (first === undefined || first.getTime() - now.getTime() > SCHEDULED_TASK_SAVE_HORIZON_MS) {
    return cadence.kind === "once"
      ? "That's more than a year away."
      : "This schedule doesn't run within the next year.";
  }
  return null;
}

/**
 * The slots due by `now`, starting at `from` (the task's next slot, which is
 * due itself when it is not after `now`): the latest, how many came before
 * it, and the first of those. At most `limit` slots are walked; past that
 * the walk jumps to the newest stretch, since only the latest runs.
 */
export function dueSlots(
  schedule: CadenceSchedule,
  from: Date,
  now: Date,
  limit = 20_000,
): Result.Result<
  { readonly latest: Date; readonly earlier: number; readonly firstEarlier: Date | null } | null,
  string
> {
  if (from.getTime() > now.getTime()) return Result.succeed(null);
  let latest = from;
  let earlier = 0;
  let firstEarlier: Date | null = null;
  let walked = 0;
  for (;;) {
    const next = schedule.next(latest);
    if (Result.isFailure(next)) return Result.fail(next.failure);
    if (next.success === null || next.success.getTime() > now.getTime()) break;
    if (firstEarlier === null) firstEarlier = latest;
    earlier += 1;
    latest = next.success;
    walked += 1;
    if (walked >= limit) {
      // A schedule that ran every minute for weeks: count no further, and
      // pick the walk up again from just before the catch-up window.
      const resume = new Date(now.getTime() - SCHEDULED_TASK_CATCH_UP_WINDOW_MS);
      if (resume.getTime() <= latest.getTime()) {
        walked = 0;
        continue;
      }
      const after = schedule.next(resume);
      if (Result.isFailure(after)) return Result.fail(after.failure);
      if (after.success === null || after.success.getTime() > now.getTime()) break;
      latest = after.success;
      earlier += 1;
      walked = 0;
    }
  }
  return Result.succeed({ latest, earlier, firstEarlier });
}

/** "2026-10-22 09:00, Thursday": an instant's wall time in `timeZone`, for agents to read. */
export function formatWallTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}, ${part("weekday")}`;
}

/** "9:00" for a clock; callers pass their own formatter for the viewer's locale. */
export const formatClock24 = (clock: ScheduledTaskClock): string =>
  `${clock.hour}:${String(clock.minute).padStart(2, "0")}`;

/** "Oct 22, 2026" for a `once` cadence's date; callers pass their own for the viewer's locale. */
export const formatCadenceDate = (date: string): string => {
  const parts = dateParts(date);
  return parts === null ? date : `${MONTH_NAMES[parts.month - 1]} ${parts.day}, ${parts.year}`;
};

/** A cadence in a few words: "Weekdays at 9:00", "Every hour at :15", "Manual". */
export function describeCadence(
  cadence: ScheduledTaskCadence,
  formatClock: (clock: ScheduledTaskClock) => string = formatClock24,
  formatDate: (date: string) => string = formatCadenceDate,
): string {
  switch (cadence.kind) {
    case "manual":
      return "Manual";
    case "once":
      return `Once, ${formatDate(cadence.date)} at ${formatClock(cadence.time)}`;
    case "hourly":
      return cadence.minute === 0
        ? "Every hour"
        : `Every hour at :${String(cadence.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${formatClock(cadence.time)}`;
    case "weekdays":
      return `Weekdays at ${formatClock(cadence.time)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[cadence.weekday] ?? "Weekly"} at ${formatClock(cadence.time)}`;
    case "custom":
      return `Custom (${cadence.cron.trim()})`;
    case "webhook":
      return describeWebhookCadence(cadence);
  }
}
