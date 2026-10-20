/**
 * When a standard 5-field cron expression ("M H DoM Mon DoW") next fires,
 * in a given time zone. Used where a provider reports a schedule without its
 * next run time (Claude's CronCreate jobs).
 *
 * Supports `*`, numbers, `a-b` ranges, `,` lists and `/n` steps; day of week
 * 0-7 with both 0 and 7 meaning Sunday. When both day fields are restricted a
 * day matching either counts, as in Vixie cron.
 */

interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

/** How far ahead a schedule is searched before it counts as never firing. */
const SEARCH_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    if (range === undefined || range.length === 0) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [from, to] = range.split("-").map(Number);
      if (from === undefined || to === undefined) return null;
      start = from;
      end = to;
    } else {
      start = Number(range);
      // "5/15" steps from 5 to the end of the range, as cron does.
      end = stepText === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max) {
      return null;
    }
    if (start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCronExpression(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const daysOfMonth = parseField(dayOfMonth, 1, 31);
  const months = parseField(month, 1, 12);
  const weekdays = parseField(dayOfWeek, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !weekdays) return null;
  const daysOfWeek = new Set([...weekdays].map((day) => day % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayOfMonth !== "*",
    dayOfWeekRestricted: dayOfWeek !== "*",
  };
}

interface WallClock {
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function wallClockReader(timeZone: string | undefined): (instant: number) => WallClock {
  const format = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  });
  return (instant) => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(instant)) parts[part.type] = part.value;
    return {
      month: Number(parts.month),
      day: Number(parts.day),
      weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  };
}

function dayMatches(fields: CronFields, wall: WallClock): boolean {
  const byMonthDay = fields.daysOfMonth.has(wall.day);
  const byWeekday = fields.daysOfWeek.has(wall.weekday);
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return byMonthDay || byWeekday;
  return byMonthDay && byWeekday;
}

/**
 * The first minute strictly after `after` that the expression matches, in
 * `timeZone` (an IANA name; the process's own zone when absent). Null for an
 * expression that doesn't parse, or that never matches within five years.
 */
export function nextCronMatch(
  expression: string,
  after: Date,
  timeZone?: string | undefined,
): Date | null {
  const fields = parseCronExpression(expression);
  if (!fields) return null;
  let wallAt: (instant: number) => WallClock;
  try {
    wallAt = wallClockReader(timeZone);
  } catch {
    return null;
  }
  const limit = after.getTime() + SEARCH_HORIZON_MS;
  let instant = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  while (instant <= limit) {
    const wall = wallAt(instant);
    if (!fields.months.has(wall.month) || !dayMatches(fields, wall)) {
      // On toward the next day, stopping three hours short of the clock's
      // midnight: a day the clocks go forward on is shorter (by up to two
      // hours, in Antarctica/Troll), and a whole day's worth of minutes would
      // pass its midnight. The next checks take the rest of the way.
      const toMidnight = (23 - wall.hour) * 60 + (60 - wall.minute);
      instant += Math.max(toMidnight - 180, 60 - wall.minute) * MINUTE_MS;
      continue;
    }
    if (!fields.hours.has(wall.hour)) {
      instant += (60 - wall.minute) * MINUTE_MS;
      continue;
    }
    if (!fields.minutes.has(wall.minute)) {
      instant += MINUTE_MS;
      continue;
    }
    return new Date(instant);
  }
  return null;
}
