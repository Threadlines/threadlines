/**
 * Running-session count sentence shared by the desktop confirmation dialogs
 * (quit, restart-to-install), so both prompts describe agent work the same way.
 */
export function describeRunningAgentSessions(count: number): string {
  if (count <= 0) return "No agent sessions are running.";
  if (count === 1) return "An agent session is still running.";
  return `${count} agent sessions are still running.`;
}
