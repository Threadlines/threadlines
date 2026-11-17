/**
 * The linked-computer fence (docs/design/fleet.md, "Fence"): work that came
 * from another computer gets no Threadlines tools here, so it can't reach
 * other threads, schedules or this computer's settings. Two kinds of thread
 * work behind it: one another computer's agent started here (`remoteOrigin`),
 * for good, and one that moved here (`movedFrom.fenced`, Part 3e), until a
 * message the user sends here starts a turn in it. Every place the fence
 * applies asks this one rule.
 */
import type { MessageId, OrchestrationCommand, OrchestrationThread } from "@threadlines/contracts";

export type LinkFencedThread = Pick<OrchestrationThread, "remoteOrigin" | "movedFrom">;

/** Whether the thread works behind the fence. */
export const isLinkFenced = (thread: LinkFencedThread): boolean =>
  (thread.remoteOrigin ?? null) !== null || thread.movedFrom?.fenced === true;

type TurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

/**
 * Whether a turn start lifts a moved thread's fence: only one whose message a
 * person sent from the app, which `sentFrom` proves (the server alone stamps
 * it, from the connection's sign-in; see withMessageSentFrom). An allow-list,
 * so whatever else starts a turn (command output, pull request auto-fix, a
 * restart or usage-limit continue, a retry, another thread, an outside agent,
 * a scheduled task) carries no `sentFrom` and leaves the fence up. A message
 * the move carried (`imported`) or Threadlines wrote for it (`afterMove`)
 * never lifts it either, whatever it carries.
 */
export function turnLiftsMoveFence(
  thread: Pick<OrchestrationThread, "movedFrom" | "messages" | "queuedFollowUps">,
  command: Pick<
    TurnStartCommand,
    "sentFrom" | "fromThread" | "fromOutside" | "scheduledTaskId" | "trigger"
  > & { readonly message: { readonly messageId: MessageId } },
): boolean {
  if (thread.movedFrom?.fenced !== true || command.sentFrom === undefined) return false;
  if (
    command.fromThread !== undefined ||
    command.fromOutside !== undefined ||
    command.scheduledTaskId !== undefined ||
    command.trigger !== undefined
  ) {
    return false;
  }
  const messageId = command.message.messageId;
  const carried = (entry: {
    readonly imported?: true | undefined;
    readonly afterMove?: true | undefined;
  }) => entry.imported === true || entry.afterMove === true;
  return (
    !(thread.queuedFollowUps ?? []).some(
      (entry) => entry.messageId === messageId && carried(entry),
    ) && !thread.messages.some((message) => message.id === messageId && carried(message))
  );
}

/** Why a fenced thread's agent can't use `tools` ("thread tools", "schedule tools"), in its words. */
export function linkFenceRefusal(thread: LinkFencedThread, tools: string): string {
  return (thread.remoteOrigin ?? null) !== null
    ? `This thread was started by an agent on another computer, so it has no ${tools}.`
    : `This thread moved here from ${thread.movedFrom?.label ?? "another computer"}, so it has no ${tools} until the user here sends it a message.`;
}
