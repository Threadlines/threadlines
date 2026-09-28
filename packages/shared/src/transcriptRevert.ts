/**
 * Which messages survive a revert to the first `turnCount` turns. The
 * server's read model, its SQL projection and the web store all go through
 * this, so a reverted transcript reads the same everywhere, reload included.
 *
 * A message stamped with a kept turn stays. A turn's user message is often
 * not stamped, so the first `turnCount` messages that start a main turn are
 * kept by transcript order (and the same for the answers). What agents did
 * beside a turn never starts one: an invite, and an invited review with its
 * answer (see docs/design/rooms-agent-invites.md). Those stay when they came
 * before the first message the revert removes, and go with it otherwise.
 */
import { compareTranscriptOrder } from "./transcriptOrder.ts";

export interface RevertableMessage {
  readonly role: string;
  readonly turnId?: string | null | undefined;
  readonly sideTurnId?: string | undefined;
  readonly requestKind?: string | undefined;
  readonly requestOutcome?: string | undefined;
  readonly createdAt: string;
  readonly eventSequence?: number | undefined;
}

/**
 * A message beside a turn, never the one that starts it: an invite, a side
 * exchange, or a reply taken back (Stop) before it was sent.
 */
export const isTurnAside = (
  message: Pick<RevertableMessage, "sideTurnId" | "requestKind" | "requestOutcome">,
) =>
  message.sideTurnId !== undefined ||
  message.requestKind === "invite" ||
  (message.requestKind === "reply" && message.requestOutcome === "cancelled");

export function retainMessagesAfterRevert<Message extends RevertableMessage>(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly idOf: (message: Message) => string;
  readonly retainedTurnIds: ReadonlySet<string>;
  /** Messages known to belong to kept turns (the SQL turn rows name them). */
  readonly retainedMessageIds?: Iterable<string>;
  readonly turnCount: number;
}): ReadonlyArray<Message> {
  const { messages, idOf, retainedTurnIds, turnCount } = input;
  const order = (left: Message, right: Message) =>
    compareTranscriptOrder({ ...left, id: idOf(left) }, { ...right, id: idOf(right) });
  const retained = new Set(input.retainedMessageIds ?? []);
  const main = messages.filter((message) => !isTurnAside(message));
  for (const message of main) {
    if (
      message.role === "system" ||
      (message.turnId != null && retainedTurnIds.has(message.turnId))
    ) {
      retained.add(idOf(message));
    }
  }

  for (const role of ["user", "assistant"]) {
    const missing =
      turnCount -
      main.filter((message) => message.role === role && retained.has(idOf(message))).length;
    if (missing <= 0) continue;
    const fallback = main
      .filter(
        (message) =>
          message.role === role &&
          !retained.has(idOf(message)) &&
          (message.turnId == null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(order)
      .slice(0, missing);
    for (const message of fallback) {
      retained.add(idOf(message));
    }
  }

  const firstRemoved = main
    .filter((message) => !retained.has(idOf(message)))
    .toSorted(order)
    .at(0);
  for (const message of messages) {
    if (isTurnAside(message) && (firstRemoved === undefined || order(message, firstRemoved) < 0)) {
      retained.add(idOf(message));
    }
  }
  return messages.filter((message) => retained.has(idOf(message)));
}
