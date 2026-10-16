import { isProviderAuthErrorMessage } from "@threadlines/shared/providerAuth";

import { keyedMemo } from "./derivationMemo";

/**
 * Whether a chat message is a provider sign-in error, the same answer as
 * `isProviderAuthErrorMessage(message.text)`.
 *
 * The chat asks this of every assistant message each time it is opened, and
 * the patterns run over the whole text, so the answer is remembered per
 * message (and checked against its text). A streamed message is a new object
 * with each delta, so only the message that changed is tested again.
 */
export function isProviderAuthErrorChatMessage(message: { readonly text: string }): boolean {
  return classifyMessage(message, message.text);
}

const classifyMessage = keyedMemo((_message: object, text: string) =>
  isProviderAuthErrorMessage(text),
);
