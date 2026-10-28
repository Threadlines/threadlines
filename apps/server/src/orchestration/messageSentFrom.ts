import {
  type AuthClientMetadata,
  type MessageId,
  type MessageSentFrom,
  type OrchestrationCommand,
  type OrchestrationMessage,
  RELAY_DEVICE_SESSION_SUBJECT,
  type ThreadParticipantId,
} from "@threadlines/contracts";

import {
  DESKTOP_BOOTSTRAP_SUBJECT,
  isLoopbackAddress,
  thisComputerAddresses,
} from "../auth/utils.ts";

/**
 * Where a session's device is, as MessageSentFrom.place says it. This
 * computer's own app window is `here`; a device through the relay, or one
 * that connected straight from another address, is `elsewhere`. A connection
 * from one of this computer's own addresses proves nothing either way: a proxy
 * here (Tailscale Serve, an SSH tunnel) hands other computers' connections on
 * from it. Undefined then, and when no address was recorded at sign-in.
 *
 * The address is the one recorded at sign-in, so a browser on this computer
 * that signed in through its network address reads as `elsewhere` once that
 * address changes, and a browser in a VM or WSL on this computer reads as
 * `elsewhere` too (it is in another environment from the agent's). The app's
 * own window, and browsers on `localhost`, never do.
 */
export function sessionDevicePlace(
  session: { readonly subject: string; readonly client: AuthClientMetadata },
  ownAddresses: () => ReadonlySet<string> = thisComputerAddresses,
): MessageSentFrom["place"] {
  if (session.subject === DESKTOP_BOOTSTRAP_SUBJECT) return "here";
  if (session.subject === RELAY_DEVICE_SESSION_SUBJECT) return "elsewhere";
  const address = session.client.ipAddress;
  if (address === undefined || isLoopbackAddress(address) || ownAddresses().has(address)) {
    return undefined;
  }
  return "elsewhere";
}

/**
 * The device a client session was issued to, as a user message records it
 * (see MessageSentFrom): by the name its user gave it, else what it called
 * itself, and where it is (sessionDevicePlace). Undefined for a device of
 * unknown kind.
 */
export function messageSentFromClient(
  client: AuthClientMetadata,
  place: MessageSentFrom["place"],
): MessageSentFrom | undefined {
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
    // A phone or a tablet is away from the agent's computer whatever its
    // connection: only a computer's place says anything.
    ...(kind === "computer" && place !== undefined ? { place } : {}),
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
 * device away from the agent's computer (a phone, a tablet, another
 * computer) wins over one that isn't, since a driver may have left a steer's
 * note out (Claude, for words the user typed). So a note is sent whenever the
 * agent may still think the user is away, at worst once too often. A steer (`answered: false`) asks about the running turn
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
      if (isAway(told)) {
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
 * Whether the device is away from the computer the agent works on: a phone, a
 * tablet, or a computer that isn't this one.
 */
function isAway(sentFrom: MessageSentFrom): boolean {
  return sentFrom.kind !== "computer" || sentFrom.place === "elsewhere";
}

/** The same kind of device, in the same place: a steer from it adds nothing. */
function sameDevice(left: MessageSentFrom, right: MessageSentFrom): boolean {
  return left.kind === right.kind && left.place === right.place && left.name === right.name;
}

/**
 * What the agent is told about the device a message came from, or undefined
 * when there is nothing to say. A device away from the computer the agent
 * works on (a phone, a tablet, another computer) is named on every message
 * that starts a turn, so a compacted conversation never loses it; this
 * computer, or a computer the session can't place, only when the device the
 * agent last heard about (`previous`) was away, so a user at their desk adds
 * nothing to any transcript. A steer into the running turn names its device
 * only when it differs from the turn's, so the turn's own device is not
 * repeated. The note only says where this message came from, so it stays
 * true whatever device the user had in between. A slash command gets no note.
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
  if (isAway(sentFrom)) {
    if (input.steer === true && previous !== undefined && sameDevice(previous, sentFrom)) {
      return undefined;
    }
    switch (sentFrom.kind) {
      case "phone":
        return `The user sent this message from their phone${device}, so they may be away from the computer you work on and reading on a small screen.`;
      case "tablet":
        return `The user sent this message from their tablet${device}, so they may be away from the computer you work on.`;
      case "computer":
        return `The user sent this message from another computer${device}, not the one you work on, so what they see and the commands they run themselves are on that computer.`;
    }
  }
  if (previous === undefined || !isAway(previous)) {
    return undefined;
  }
  return sentFrom.place === "here"
    ? `The user sent this message from the computer you work on${device}.`
    : `The user sent this message from a computer${device}.`;
}
