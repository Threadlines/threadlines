/**
 * Running-session count sentence shared by the desktop confirmation dialogs
 * (quit, restart-to-install), so both prompts describe agent work the same way.
 * `onThisComputer` names the place when other computers have work too, so the
 * count reads as this computer's alone.
 */
export function describeRunningAgentSessions(count: number, onThisComputer = false): string {
  const where = onThisComputer ? " on this computer" : "";
  if (count <= 0) return `No agent sessions are running${where}.`;
  if (count === 1) return `An agent session is still running${where}.`;
  return `${count} agent sessions are still running${where}.`;
}

/**
 * What quitting does to this computer's scheduled tasks, or null when it has
 * none: they run only while Threadlines is running here.
 */
export function describeStoppedScheduledTasks(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "This computer's scheduled task won't run until you open Threadlines again."
    : `This computer's ${count} scheduled tasks won't run until you open Threadlines again.`;
}

/**
 * Says that work on other computers outlives closing this app, or null when no
 * other computer has any. Machines are named when there are at most two and
 * every name is known; otherwise the sentence stays general.
 */
export function describeAgentWorkElsewhere(
  machineLabels: ReadonlyArray<string | null>,
): string | null {
  if (machineLabels.length === 0) return null;
  const names = machineLabels.filter((label): label is string => label !== null);
  if (names.length === machineLabels.length) {
    if (names.length === 1) return `Work on ${names[0]} keeps running.`;
    if (names.length === 2) return `Work on ${names[0]} and ${names[1]} keeps running.`;
  }
  return machineLabels.length === 1
    ? "Work on your other computer keeps running."
    : "Work on your other computers keeps running.";
}
