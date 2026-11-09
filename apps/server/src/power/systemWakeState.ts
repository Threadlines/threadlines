/**
 * systemWakeState - Pure state for telling a fully awake computer from one
 * that woke only for upkeep.
 *
 * A sleeping Mac wakes for a few seconds at a time (a dark wake: screen and
 * sound stay off) to check mail, sync and back up, and macOS puts it back to
 * sleep whatever Threadlines asks. `pmset -g systemstate` lists the system's
 * capabilities; a dark wake lacks Graphics. Work started then crawls along a
 * few seconds per wake, so the scheduler waits for a full wake instead.
 *
 * A reading of "half awake" that lasts longer than any upkeep wake is not
 * trusted: past STREAK_LIMIT_MS of it with no sleep in between, the computer
 * counts as awake, so no Mac (one without a screen, say) can be left with
 * scheduled work that never starts. Each reading carries when macOS last
 * went to sleep (`sysctl kern.sleeptime`); a reading after a newer sleep
 * starts a new streak.
 *
 * @module systemWakeState
 */

/** Longer than any upkeep wake (macOS caps one at a few minutes). */
export const STREAK_LIMIT_MS = 10 * 60_000;

/**
 * Whether `pmset -g systemstate` says the Mac woke only for upkeep: its
 * capabilities lack Graphics. Null when the output doesn't list them.
 */
export function halfAwakeFromSystemState(output: string): boolean | null {
  const capabilities = /Current System Capabilities are:(.*)/.exec(output)?.[1];
  if (capabilities === undefined) return null;
  return !capabilities.trim().split(/\s+/).includes("Graphics");
}

/** When `sysctl kern.sleeptime` says macOS last went to sleep; null when it doesn't say. */
export function lastSleepFromSysctl(output: string): number | null {
  const match = /sec = (\d+), usec = (\d+)/.exec(output);
  if (match === null) return null;
  return Number(match[1]) * 1_000 + Math.floor(Number(match[2]) / 1_000);
}

/** One reading: half awake or not, when, and when the computer last went to sleep. */
export interface WakeReading {
  readonly halfAwake: boolean;
  readonly wallMs: number;
  /** Null when it couldn't be read: the streak keeps the last one it knew. */
  readonly lastSleepMs: number | null;
}

/** Back-to-back "half awake" readings with no sleep between them. */
export interface HalfAwakeStreak {
  readonly sinceWallMs: number;
  readonly last: WakeReading;
}

/** The streak after one reading; null once a reading says fully awake. */
export function nextHalfAwakeStreak(
  streak: HalfAwakeStreak | null,
  reading: WakeReading,
): HalfAwakeStreak | null {
  if (!reading.halfAwake) return null;
  if (streak === null) return { sinceWallMs: reading.wallMs, last: reading };
  const known = streak.last.lastSleepMs;
  const slept =
    reading.wallMs < streak.last.wallMs ||
    (reading.lastSleepMs !== null && known !== null && reading.lastSleepMs !== known);
  // A reading that couldn't say when the last sleep was keeps the one known,
  // so a sleep before it still shows against the next reading that can.
  const last = reading.lastSleepMs === null ? { ...reading, lastSleepMs: known } : reading;
  return slept ? { sinceWallMs: reading.wallMs, last } : { sinceWallMs: streak.sinceWallMs, last };
}

/** Whether work waits: half awake, for no longer than an upkeep wake lasts. */
export function waitsForFullWake(streak: HalfAwakeStreak | null): boolean {
  return streak !== null && streak.last.wallMs - streak.sinceWallMs < STREAK_LIMIT_MS;
}
