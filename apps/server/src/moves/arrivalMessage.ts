/**
 * The message Threadlines writes for a thread's agent when the thread moved,
 * or when its move didn't happen (docs/design/fleet.md, Part 3e, "The
 * arrival message" and "Put back"): what the move's stop took from it (a
 * goal that was working, check-backs that ended with its session) and what
 * to do about each. It is queued ahead of the user's own messages and sent
 * like any of them, so the agent gets its conversation first (a carried
 * session, or the summary). Pure: the decider and the import both build it.
 */

/** A check-back as the message names it. */
export interface ArrivalCheckBack {
  readonly scheduledFor: string;
  readonly recurring: boolean;
  readonly schedule?: string | undefined;
  readonly cron?: string | undefined;
  readonly description?: string | undefined;
  readonly prompt?: string | undefined;
}

export interface ArrivalMessageInput {
  /** `moved`: the thread arrived here from `from`. `stayed`: its move to `to` didn't happen. */
  readonly kind: "moved" | "stayed";
  readonly from: string;
  readonly to: string;
  /** A goal that was working, to carry on with; null: none. */
  readonly goal: { readonly objective: string } | null;
  /** The check-backs its stop ended. */
  readonly checkBacks: ReadonlyArray<ArrivalCheckBack>;
  /** The agent here can set check-backs (Claude); false: it is told once, to act on them. */
  readonly canSetCheckBacks: boolean;
  /** When the message is written, to tell a time that passed during the move. */
  readonly now: string;
}

/** When one check-back fires, as the agent reads it. */
function whenWords(checkBack: ArrivalCheckBack, nowMs: number): string {
  if (checkBack.recurring) {
    const schedule = checkBack.schedule ?? "on a schedule";
    return checkBack.cron !== undefined ? `${schedule} (${checkBack.cron})` : schedule;
  }
  const due = Date.parse(checkBack.scheduledFor);
  return Number.isFinite(due) && due < nowMs
    ? `was due at ${checkBack.scheduledFor}`
    : `at ${checkBack.scheduledFor}`;
}

/** The message a moved thread's agent gets when its user resumes the goal it arrived with. */
export const resumedGoalMessageText = (objective: string) =>
  `This thread moved here from another computer, and its goal is on again: ${objective}. Carry on with it.`;

/** The message, or null when there is nothing to tell the agent. */
export function arrivalMessageText(input: ArrivalMessageInput): string | null {
  if (input.goal === null && input.checkBacks.length === 0) return null;
  const nowMs = Date.parse(input.now);
  const lines = [
    input.kind === "moved"
      ? `This thread moved from ${input.from} to ${input.to}, and your session was restarted for it.`
      : `The move to ${input.to} didn't happen, and your session was restarted for it.`,
  ];
  if (input.goal !== null) {
    lines.push(`- Your goal is still on: ${input.goal.objective}. Carry on with it.`);
  }
  if (input.checkBacks.length > 0) {
    lines.push(
      input.canSetCheckBacks
        ? "- Your check-backs ended with the move. Run CronList, then set again the ones you still need:"
        : "- Your check-backs ended with the move, and you can't set them here. This is what you had planned:",
    );
    for (const checkBack of input.checkBacks) {
      const what = checkBack.prompt ?? checkBack.description ?? "(no prompt recorded)";
      lines.push(`  - ${whenWords(checkBack, nowMs)}: ${what}`);
    }
  }
  return lines.join("\n");
}
