import { scopedThreadKey } from "@t3tools/client-runtime";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { ChatMessage } from "./types";

export const EMPTY_OPTIMISTIC_THREAD_MESSAGES: ChatMessage[] = [];

export interface OptimisticThreadMessagesState {
  messagesByThreadKey: Record<string, ChatMessage[]>;
  addMessage: (threadRef: ScopedThreadRef, message: ChatMessage) => void;
  removeMessages: (threadRef: ScopedThreadRef, messageIds: ReadonlySet<MessageId>) => void;
  clearThread: (threadRef: ScopedThreadRef) => void;
}

export function selectOptimisticThreadMessages(
  state: Pick<OptimisticThreadMessagesState, "messagesByThreadKey">,
  threadRef: ScopedThreadRef,
): ChatMessage[] {
  return state.messagesByThreadKey[scopedThreadKey(threadRef)] ?? EMPTY_OPTIMISTIC_THREAD_MESSAGES;
}

export const useOptimisticThreadMessagesStore = create<OptimisticThreadMessagesState>((set) => ({
  messagesByThreadKey: {},
  addMessage: (threadRef, message) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      const existingMessages =
        state.messagesByThreadKey[threadKey] ?? EMPTY_OPTIMISTIC_THREAD_MESSAGES;
      if (existingMessages.some((entry) => entry.id === message.id)) {
        return state;
      }

      return {
        messagesByThreadKey: {
          ...state.messagesByThreadKey,
          [threadKey]: [...existingMessages, message],
        },
      };
    }),
  removeMessages: (threadRef, messageIds) =>
    set((state) => {
      if (messageIds.size === 0) {
        return state;
      }

      const threadKey = scopedThreadKey(threadRef);
      const existingMessages = state.messagesByThreadKey[threadKey];
      if (!existingMessages || existingMessages.length === 0) {
        return state;
      }

      const nextMessages = existingMessages.filter((message) => !messageIds.has(message.id));
      if (nextMessages.length === existingMessages.length) {
        return state;
      }

      if (nextMessages.length === 0) {
        const { [threadKey]: _removed, ...messagesByThreadKey } = state.messagesByThreadKey;
        return { messagesByThreadKey };
      }

      return {
        messagesByThreadKey: {
          ...state.messagesByThreadKey,
          [threadKey]: nextMessages,
        },
      };
    }),
  clearThread: (threadRef) =>
    set((state) => {
      const threadKey = scopedThreadKey(threadRef);
      if (!(threadKey in state.messagesByThreadKey)) {
        return state;
      }

      const { [threadKey]: _removed, ...messagesByThreadKey } = state.messagesByThreadKey;
      return { messagesByThreadKey };
    }),
}));
