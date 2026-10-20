/**
 * How the app words an agent's check-backs: the times it set itself to come
 * back to a thread (OrchestrationCheckBack). Shared by the chat's line under
 * the last turn, the sidebar's countdown and the chat's notes about them.
 */
import type { OrchestrationCheckBack } from "@threadlines/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** "3:42 PM", "tomorrow at 9:00 AM", "Mon at 9:00 AM", "Oct 30 at 9:00 AM". */
export function formatCheckBackTime(iso: string, nowMs: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "later";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const now = new Date(nowMs);
  if (sameDay(at, now)) return time;
  if (sameDay(at, new Date(nowMs + DAY_MS))) return `tomorrow at ${time}`;
  if (at.getTime() - nowMs < 6 * DAY_MS && at.getTime() > nowMs) {
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} at ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/** Time left until `iso`: "now", "in 14m", "in 2h 5m", "in 3d". */
export function formatCheckBackCountdown(iso: string, nowMs: number): string {
  const left = Date.parse(iso) - nowMs;
  if (!Number.isFinite(left) || left < MINUTE_MS) return "now";
  if (left < HOUR_MS) return `in ${Math.round(left / MINUTE_MS)}m`;
  if (left < DAY_MS) {
    const hours = Math.floor(left / HOUR_MS);
    const minutes = Math.round((left - hours * HOUR_MS) / MINUTE_MS);
    return minutes > 0 && hours < 10 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }
  return `in ${Math.round(left / DAY_MS)}d`;
}

/** The short form a sidebar row has room for: "14m", "2h", "3d". */
export function formatCheckBackCountdownShort(iso: string, nowMs: number): string {
  const countdown = formatCheckBackCountdown(iso, nowMs);
  return countdown === "now" ? "now" : countdown.replace(/^in /u, "").replace(/ \d+m$/u, "");
}

/**
 * What the line under the chat says about the soonest check-back: when it
 * comes back, and how long until then. A repeating one says how often.
 */
export function describeCheckBack(
  checkBack: OrchestrationCheckBack,
  nowMs: number,
): { readonly label: string; readonly when: string } {
  const time = formatCheckBackTime(checkBack.scheduledFor, nowMs);
  if (checkBack.recurring) {
    return {
      label: checkBack.schedule ? `Checks back ${checkBack.schedule}` : "Checks back on a schedule",
      when: `next ${checkBack.exact ? "at" : "around"} ${time}`,
    };
  }
  const at = time.includes(" at ") ? "" : checkBack.exact ? "at " : "around ";
  return {
    label: `Checks back ${at}${time}`,
    when: formatCheckBackCountdown(checkBack.scheduledFor, nowMs),
  };
}

/** The soonest check-back, the one the chat and the sidebar name. */
export function nextCheckBack(
  checkBacks: ReadonlyArray<OrchestrationCheckBack> | undefined,
): OrchestrationCheckBack | null {
  if (!checkBacks || checkBacks.length === 0) return null;
  return checkBacks.reduce((soonest, checkBack) =>
    checkBack.scheduledFor < soonest.scheduledFor ? checkBack : soonest,
  );
}

/** A chat note about a check-back (activity kinds `check-back.*`), worded
 *  with its time in the reader's own clock. Null for any other activity. */
export function checkBackActivityLabel(
  kind: string,
  payload: unknown,
  nowMs: number,
): string | null {
  const scheduledFor =
    payload !== null && typeof payload === "object"
      ? (payload as { readonly scheduledFor?: unknown }).scheduledFor
      : undefined;
  const at =
    typeof scheduledFor === "string" ? ` at ${formatCheckBackTime(scheduledFor, nowMs)}` : "";
  switch (kind) {
    case "check-back.fired":
      return `Checked back${at}`;
    case "check-back.skipped":
      return `Skipped the check-back${at}: another agent was working`;
    case "check-back.ended":
      return `Check-back${at} cancelled: the agent's session stopped`;
    default:
      return null;
  }
}
