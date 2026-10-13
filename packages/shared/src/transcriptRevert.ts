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
import { compareTranscriptOrder, compareTranscriptPosition } from "./transcriptOrder.ts";

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

export interface MessageRevertInput<Message extends RevertableMessage> {
  readonly messages: ReadonlyArray<Message>;
  readonly idOf: (message: Message) => string;
  readonly retainedTurnIds: ReadonlySet<string>;
  /** Messages known to belong to kept turns (the SQL turn rows name them). */
  readonly retainedMessageIds?: Iterable<string>;
  readonly turnCount: number;
}

export function retainMessagesAfterRevert<Message extends RevertableMessage>(
  input: MessageRevertInput<Message>,
): ReadonlyArray<Message> {
  return revertMessages(input).messages;
}

/**
 * The kept messages, and the first message the revert removes: where the
 * transcript is cut. What a turn put in the transcript beside its messages
 * (agent pages) follows them; see `retainTurnItemsAfterRevert`.
 */
export function revertMessages<Message extends RevertableMessage>(
  input: MessageRevertInput<Message>,
): {
  readonly messages: ReadonlyArray<Message>;
  readonly cut: (TranscriptPosition & { readonly id: string }) | undefined;
  /** The turns the revert keeps: those it was told to, and any a kept message is stamped with. */
  readonly keptTurnIds: ReadonlySet<string>;
} {
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
  const kept = messages.filter((message) => retained.has(idOf(message)));
  const keptTurnIds = new Set(retainedTurnIds);
  for (const message of kept) {
    if (message.turnId != null) keptTurnIds.add(message.turnId);
  }
  return {
    messages: kept,
    keptTurnIds,
    cut:
      firstRemoved === undefined
        ? undefined
        : {
            id: idOf(firstRemoved),
            createdAt: firstRemoved.createdAt,
            eventSequence: firstRemoved.eventSequence,
          },
  };
}

interface TranscriptPosition {
  readonly eventSequence?: number | undefined;
  readonly createdAt: string;
}

/**
 * What survives a revert among things a turn put in the transcript beside its
 * messages (agent pages): whatever came before the revert's cut, and whatever
 * a kept turn put there later. The first covers a turn kept by order alone,
 * known by no id; the second a page that reached the transcript after its
 * turn's last message, behind the next turn's first. A revert that removes no
 * message keeps everything.
 */
export function retainTurnItemsAfterRevert<
  Item extends TranscriptPosition & { readonly turnId: string },
>(
  items: ReadonlyArray<Item>,
  reverted: {
    readonly keptTurnIds: ReadonlySet<string>;
    readonly cut: (TranscriptPosition & { readonly id: string }) | undefined;
  },
): ReadonlyArray<Item> {
  const { cut, keptTurnIds } = reverted;
  if (cut === undefined) return items;
  return items.filter(
    (item) => compareTranscriptPosition(item, cut) < 0 || keptTurnIds.has(item.turnId),
  );
}
