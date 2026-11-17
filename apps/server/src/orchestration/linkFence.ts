/**
 * The linked-computer fence (docs/design/fleet.md, "Fence"): work that came
 * from another computer gets no Threadlines tools here, so it can't reach
 * other threads, schedules or this computer's settings. Two kinds of thread
 * work behind it: one another computer's agent started here (`remoteOrigin`),
 * for good, and one that moved here (`movedFrom.fenced`, Part 3e), until a
 * message the user sends here starts a turn in it. Every place the fence
 * applies asks this one rule.
 */
import type { OrchestrationThread } from "@threadlines/contracts";

export type LinkFencedThread = Pick<OrchestrationThread, "remoteOrigin" | "movedFrom">;

/** Whether the thread works behind the fence. */
export const isLinkFenced = (thread: LinkFencedThread): boolean =>
  (thread.remoteOrigin ?? null) !== null || thread.movedFrom?.fenced === true;

/** Why a fenced thread's agent can't use `tools` ("thread tools", "schedule tools"), in its words. */
export function linkFenceRefusal(thread: LinkFencedThread, tools: string): string {
  return (thread.remoteOrigin ?? null) !== null
    ? `This thread was started by an agent on another computer, so it has no ${tools}.`
    : `This thread moved here from ${thread.movedFrom?.label ?? "another computer"}, so it has no ${tools} until the user here sends it a message.`;
}
