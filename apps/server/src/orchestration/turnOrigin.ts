import type { OrchestrationMessage, ProviderTurnOrigin } from "@threadlines/contracts";

/**
 * Who the message that starts a turn came from (ProviderTurnOrigin), read
 * from the marks the message and its turn already carry. A person's message
 * is one a client app sent for its user: the server stamps the device it came
 * from (`sentFrom`) and the composer marks what they typed (`composer`). A
 * message with no mark is one the server wrote, so it never counts as a
 * person's. A user's own script on the app's sign-in also gets a device
 * stamp, and counts as a person.
 */
export function turnMessageOrigin(input: {
  readonly message: Pick<
    OrchestrationMessage,
    "fromAgent" | "fromThread" | "fromOutside" | "composer" | "sentFrom" | "trigger"
  >;
  /** The turn start's own marks (`thread.turn-start-requested`), when it has them. */
  readonly fromThread?: unknown;
  readonly fromOutside?: unknown;
  readonly scheduledTaskId?: unknown;
  /** A side answer another agent in the room asked for. */
  readonly askedByAgent?: boolean;
}): ProviderTurnOrigin {
  const { message } = input;
  if (input.fromOutside !== undefined || message.fromOutside !== undefined) return "outside_agent";
  if (input.fromThread !== undefined || message.fromThread !== undefined) return "other_thread";
  if (input.askedByAgent === true || message.fromAgent !== undefined) return "room_agent";
  if (input.scheduledTaskId !== undefined) return "task";
  // Moving the thread to another account is the user's choice from the
  // limit notice, though Threadlines wrote the words.
  if (
    message.composer !== undefined ||
    message.sentFrom !== undefined ||
    message.trigger === "accountSwitch"
  ) {
    return "person";
  }
  return "automatic";
}
