/**
 * Messages agents send each other (a thread's request or report, a room
 * agent's question, review, hand-off or reply) show folded to their first
 * line; the agent's answer is what the reader reads. This keeps the ones the
 * reader opened, by thread and timeline row, while the app runs: the chat list
 * drops rows it scrolls past and draws them again, and a row comes back as it
 * was left. Find in chat and a jump from search open one the same way.
 */
import { create } from "zustand";

import type { InlineSkill } from "../../lib/inlineMarkdownTokens";
import type { ChatMessage } from "../../types";
import { markdownFirstLine } from "./chatFind/chatFindText";

interface OpenedAgentMessagesState {
  readonly opened: ReadonlySet<string>;
}

const useOpenedAgentMessagesStore = create<OpenedAgentMessagesState>(() => ({
  opened: new Set(),
}));

function openedKey(threadKey: string, rowId: string): string {
  return `${threadKey}\u0000${rowId}`;
}

/** Whether the reader opened this row's message in this thread. */
export function useAgentMessageOpened(threadKey: string, rowId: string): boolean {
  return useOpenedAgentMessagesStore((state) => state.opened.has(openedKey(threadKey, rowId)));
}

export function setAgentMessageOpened(threadKey: string, rowId: string, opened: boolean): void {
  const key = openedKey(threadKey, rowId);
  const current = useOpenedAgentMessagesStore.getState().opened;
  if (current.has(key) === opened) return;
  const next = new Set(current);
  if (opened) next.add(key);
  else next.delete(key);
  useOpenedAgentMessagesStore.setState({ opened: next });
}

const previews = new WeakMap<
  ChatMessage,
  {
    readonly text: string;
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<InlineSkill>;
    readonly preview: string;
  }
>();

/**
 * The line a folded message shows: its first block of text as the chat draws
 * it (a link as its words, a file as its name, no markdown marks), on one line.
 * Kept per message, so a row drawn again reads it back.
 */
export function agentMessagePreview(
  message: ChatMessage,
  cwd: string | undefined,
  skills: ReadonlyArray<InlineSkill>,
): string {
  const hit = previews.get(message);
  if (hit && hit.text === message.text && hit.cwd === cwd && hit.skills === skills) {
    return hit.preview;
  }
  const preview = markdownFirstLine({ text: message.text, cwd, skills });
  previews.set(message, { text: message.text, cwd, skills, preview });
  return preview;
}
