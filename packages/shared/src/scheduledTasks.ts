/**
 * Scheduled tasks' schedules (docs/design/fleet.md, Part 6): turning a
 * cadence into the UTC instants ("slots") it runs at, checking one can be
 * saved, and naming it for people ("Weekdays at 9:00"). The server's
 * scheduler and the client's form read the same rules from here.
 *
 * Every cadence but `manual` compiles to a 5-field cron expression (minute
 * resolution) evaluated with `effect/Cron` in the task's own time zone; a
 * `once` cadence is the one instant that expression gives on its date. Time
 * zone changes follow Effect's compatible resolution: a wall time that doesn't
 * exist on a spring-forward day (02:30) runs at the same distance past the
 * jump (03:30), and a wall time the clocks pass twice on a fall-back day runs
 * once, at the earlier instant.
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
 * The 5-field cron expression a cadence runs on; null for `manual`. A `once`
 * cadence's expression recurs every year; only its date's instance counts.
 */
export function cadenceCronExpression(cadence: ScheduledTaskCadence): string | null {
  switch (cadence.kind) {
    case "manual":
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

const cronSchedule = (cron: Cron.Cron): CadenceSchedule => ({
  next: (after) => {
    try {
      return Result.succeed(Cron.next(cron, after));
    } catch {
      return Result.fail("This schedule never runs.");
    }
  },
});

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
  if (cadence.kind === "manual") return Result.succeed(null);
  if (cadence.kind === "once") return compileOnce(cadence, timeZone);
  const expression = cadenceCronExpression(cadence) ?? "";
  const fields = expression.split(/\s+/u).filter((field) => field.length > 0);
  if (fields.length !== 5) {
    return Result.fail(
      "A custom schedule takes 5 fields: minute, hour, day of month, month and day of week.",
    );
  }
  return Cron.parse(expression, timeZone).pipe(
    Result.map(cronSchedule),
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
  const instant = Cron.parse(expression, timeZone).pipe(
    Result.mapError(() => `"${cadence.date}" isn't a date.`),
    Result.flatMap((cron) => cronSchedule(cron).next(from)),
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
 * Whether a cadence can be saved: it parses, and (unless manual) runs within
 * a year of `now`. Null when it can; otherwise why not, in one sentence.
 */
export function cadenceSaveRefusal(
  cadence: ScheduledTaskCadence,
  timeZone: string,
  now: Date,
): string | null {
  const next = upcomingSlots(cadence, timeZone, now, 1);
  if (Result.isFailure(next)) return next.failure;
  if (cadence.kind === "manual") return null;
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
  }
}
