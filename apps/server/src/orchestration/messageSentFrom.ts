import type {
  AuthClientMetadata,
  MessageId,
  MessageSentFrom,
  OrchestrationCommand,
  OrchestrationMessage,
  ThreadParticipantId,
} from "@threadlines/contracts";

/**
 * The device a client session was issued to, as a user message records it
 * (see MessageSentFrom): by the name its user gave it, else what it called
 * itself. Undefined for a device of unknown kind.
 */
export function messageSentFromClient(client: AuthClientMetadata): MessageSentFrom | undefined {
  const kind =
    client.deviceType === "desktop"
      ? "computer"
      : client.deviceType === "mobile"
        ? "phone"
        : client.deviceType === "tablet"
          ? "tablet"
          : undefined;
  if (kind === undefined) {
    return undefined;
  }
  const name = client.name ?? client.label;
  return {
    kind,
    ...(name !== undefined ? { name } : {}),
    ...(client.os !== undefined ? { os: client.os } : {}),
  };
}

/**
 * A command a client app sent for its user, stamped with the device it came
 * from. Only the commands that write a user message carry the stamp; the
 * client schemas have no such field, so this is the only way in.
 */
export function withMessageSentFrom(
  command: OrchestrationCommand,
  sentFrom: MessageSentFrom | undefined,
): OrchestrationCommand {
  return sentFrom !== undefined && writesUserMessage(command) ? { ...command, sentFrom } : command;
}

const USER_MESSAGE_COMMANDS = [
  "thread.turn.start",
  "thread.follow-up.submit",
  "thread.fork",
  "thread.side-turn.start",
  "thread.user-input.respond",
] as const satisfies ReadonlyArray<OrchestrationCommand["type"]>;

/** Whether the command writes a user message, so `withMessageSentFrom` stamps it. */
export function writesUserMessage(
  command: OrchestrationCommand,
): command is Extract<OrchestrationCommand, { type: (typeof USER_MESSAGE_COMMANDS)[number] }> {
  return (USER_MESSAGE_COMMANDS as ReadonlyArray<string>).includes(command.type);
}

/** A device's name or OS as a note quotes it: one short line, no quotes of its own. */
function noteText(value: string): string {
  return value
    .replace(/["\u201C\u201D\s]+/g, " ")
    .trim()
    .slice(0, 60);
}

function describeDevice(sentFrom: MessageSentFrom): string {
  const name = sentFrom.name !== undefined ? noteText(sentFrom.name) : "";
  const os = sentFrom.os !== undefined ? noteText(sentFrom.os) : "";
  const details = [name.length > 0 ? `"${name}"` : "", os].filter((part) => part.length > 0);
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

/** A slash command only works as the first word, so it never gets a note. */
function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * The device the agent `participantId` (null: the thread's own agent) may
 * last have heard about, from the user's messages to it before
 * `beforeMessageId` (null: before the end of the thread); undefined when none
 * told it.
 *
 * With `answered` (turn starts), it reads the agent's latest delivered turn
 * that said anything about a device: a turn counts once it has an answer or
 * a steer in it (a send that failed never reached the agent), and within it a
 * phone or a tablet wins over a computer, since a driver may have left a
 * steer's note out (Claude, for words the user typed). So a computer note is
 * sent whenever the agent may still think the user is on a phone, at worst
 * once too often. A steer (`answered: false`) asks about the running turn
 * instead: the latest message that said anything.
 *
 * Messages with no device or a slash command say nothing; side questions and
 * answers are a lane of their own; messages a move brought from another
 * computer were heard by a conversation there.
 */
export function previousMessageSentFrom(
  messages: ReadonlyArray<OrchestrationMessage>,
  beforeMessageId: MessageId | null,
  participantId: ThreadParticipantId | null,
  options: { readonly answered: boolean } = { answered: true },
): MessageSentFrom | undefined {
  const index =
    beforeMessageId === null ? -1 : messages.findIndex((message) => message.id === beforeMessageId);
  // The turn being read, walking back from its newest message to its start.
  let delivered = false;
  let phone: MessageSentFrom | undefined;
  let computer: MessageSentFrom | undefined;
  for (let at = (index === -1 ? messages.length : index) - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (
      message.sideTurnId !== undefined ||
      message.imported === true ||
      (message.participantId ?? null) !== participantId
    ) {
      continue;
    }
    if (message.role === "assistant") {
      delivered = true;
      continue;
    }
    if (message.role !== "user") {
      continue;
    }
    const told =
      message.sentFrom !== undefined && !isSlashCommand(message.text)
        ? message.sentFrom
        : undefined;
    if (!options.answered) {
      if (told !== undefined) return told;
      continue;
    }
    // A user message with a turn id joined a running turn (a steer): it was
    // delivered, and so was the turn's start.
    const steer = message.turnId !== null;
    if (steer) {
      delivered = true;
    }
    if (told !== undefined) {
      if (told.kind !== "computer") {
        phone ??= told;
      } else {
        computer ??= told;
      }
    }
    if (steer) {
      continue;
    }
    // The turn's start: the whole turn is read.
    if (delivered && (phone !== undefined || computer !== undefined)) {
      return phone ?? computer;
    }
    delivered = false;
    phone = undefined;
    computer = undefined;
  }
  return undefined;
}

/**
 * What the agent is told about the device a message came from, or undefined
 * when there is nothing to say. A phone or a tablet is named on every message
 * that starts a turn, so a compacted conversation never loses it; a computer
 * only when the device the agent last heard about (`previous`) was a phone or
 * a tablet, so a user at their desk adds nothing to any transcript. A steer
 * into the running turn names its device only when its kind differs from the
 * turn's, so the turn's own device is not repeated. The note only says where
 * this message came from, so it stays true whatever device the user had in
 * between. A slash command gets no note.
 */
export function messageSentFromNote(input: {
  readonly sentFrom: MessageSentFrom | undefined;
  readonly previous: MessageSentFrom | undefined;
  readonly text: string;
  readonly steer?: boolean;
}): string | undefined {
  const { sentFrom, previous } = input;
  if (sentFrom === undefined || isSlashCommand(input.text)) {
    return undefined;
  }
  const device = describeDevice(sentFrom);
  switch (sentFrom.kind) {
    case "phone":
    case "tablet":
      if (input.steer === true && previous?.kind === sentFrom.kind) {
        return undefined;
      }
      return sentFrom.kind === "phone"
        ? `The user sent this message from their phone${device}, so they may be away from the computer you work on and reading on a small screen.`
        : `The user sent this message from their tablet${device}, so they may be away from the computer you work on.`;
    case "computer":
      return previous !== undefined && previous.kind !== "computer"
        ? `The user sent this message from a computer${device}.`
        : undefined;
  }
}
