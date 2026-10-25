import {
  isProviderAuthErrorReply,
  type ProviderAuthReplyInput,
} from "@threadlines/shared/providerAuth";

import { keyedMemo } from "./derivationMemo";

/**
 * Whether a chat message is a provider sign-in error, the same answer as
 * `isProviderAuthErrorReply(message)`: the sign-in card shows in its place,
 * and a later reply of the thread's own agent resolves it.
 *
 * The chat asks this of every assistant message each time it is opened, and
 * the patterns run over the whole text, so the answer is remembered per
 * message (and checked against what it reads). A streamed message is a new
 * object with each delta, so only the message that changed is tested again.
 */
export function isProviderAuthErrorChatMessage(message: ProviderAuthReplyInput): boolean {
  return classifyMessage(
    message,
    message.role,
    message.text,
    message.participantId,
    message.sideTurnId,
    message.streaming,
  );
}

const classifyMessage = keyedMemo(
  (
    message: ProviderAuthReplyInput,
    _role: string,
    _text: string,
    _participantId: unknown,
    _sideTurnId: unknown,
    _streaming: boolean | undefined,
  ) => isProviderAuthErrorReply(message),
);
