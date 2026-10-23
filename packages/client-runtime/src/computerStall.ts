/**
 * What the app says when a computer froze and couldn't answer for a while (a
 * server's `subscribeServerStalls` report): the notice once it answers again,
 * and the note Fleet shows beside the computer while the freeze is recent.
 * Shared so every client words it the same way.
 */
import type { ServerStall } from "@threadlines/contracts";

/** How long after it ended a stall is worth mentioning: as long as servers report one. */
export const COMPUTER_STALL_RECENT_MS = 10 * 60_000;

/** A stall as this app received it, timed on this app's own clock. */
export interface ReceivedComputerStall {
  readonly stall: ServerStall;
  /** When it ended on this app's clock: received, less how long ago the server said. */
  readonly endedAtMs: number;
}

export function receiveComputerStall(
  stall: ServerStall,
  receivedAtMs: number,
): ReceivedComputerStall {
  return { stall, endedAtMs: receivedAtMs - stall.agoMs };
}

/** A clock moved back since then can't make an old freeze look new: that one counts as old. */
const CLOCK_SLACK_MS = 5_000;

export function isComputerStallRecent(received: ReceivedComputerStall, nowMs: number): boolean {
  const ageMs = nowMs - received.endedAtMs;
  return ageMs >= -CLOCK_SLACK_MS && ageMs <= COMPUTER_STALL_RECENT_MS;
}

/** How long a stall lasted, in words: "12s", "4 min", "2 hours", "3 days". */
export function formatStallDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

function formatLoad(load: number): string {
  return Number.isInteger(load) ? String(load) : load.toFixed(1);
}

export interface ComputerStallNotice {
  readonly title: string;
  readonly description: string;
}

/**
 * The notice for a freeze, once the computer answers again. `name` is the
 * computer as the app names it; `thisComputer` is the one the app itself runs
 * on.
 */
export function describeComputerStall(
  stall: ServerStall,
  computer: { readonly name: string; readonly thisComputer: boolean },
): ComputerStallNotice {
  const duration = formatStallDuration(stall.durationMs);
  const threadlines = computer.thisComputer ? "Threadlines" : `Threadlines on ${computer.name}`;
  switch (stall.cause) {
    case "busy":
      return {
        title: `${threadlines} froze for ${duration}`,
        description: "It was busy with its own work, so it couldn't answer.",
      };
    case "overloaded":
      return {
        title: `${computer.thisComputer ? "This computer" : computer.name} froze for ${duration}`,
        description: stall.load
          ? `Its CPU was overloaded (load ${formatLoad(stall.load.average1m)} on ${stall.load.cpuCount} cores).`
          : "Its CPU was overloaded.",
      };
    case "unknown":
      return {
        title: `${threadlines} stopped answering for ${duration}`,
        description: "It's answering again.",
      };
  }
}

/** Fleet's note beside a computer while a freeze is recent: "Froze 3 min ago". */
export function describeComputerStallNote(received: ReceivedComputerStall, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - received.endedAtMs) / 60_000);
  return minutes < 1 ? "Froze just now" : `Froze ${minutes} min ago`;
}
