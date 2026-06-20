import { scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, MessageId, ThreadId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_OPTIMISTIC_THREAD_MESSAGES,
  selectOptimisticThreadMessages,
  useOptimisticThreadMessagesStore,
} from "./optimisticThreadMessages";
import type { ChatMessage } from "./types";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

function makeMessage(id: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: `message ${id}`,
    createdAt: "2026-06-15T00:00:00.000Z",
    streaming: false,
  };
}

describe("optimistic thread messages", () => {
  beforeEach(() => {
    useOptimisticThreadMessagesStore.setState({ messagesByThreadKey: {} });
  });

  it("keeps pending messages keyed by scoped thread", () => {
    const message = makeMessage("message-1");

    useOptimisticThreadMessagesStore.getState().addMessage(threadRef, message);

    expect(
      selectOptimisticThreadMessages(useOptimisticThreadMessagesStore.getState(), threadRef),
    ).toEqual([message]);
  });

  it("deduplicates repeated optimistic adds for the same message id", () => {
    const message = makeMessage("message-1");

    useOptimisticThreadMessagesStore.getState().addMessage(threadRef, message);
    useOptimisticThreadMessagesStore.getState().addMessage(threadRef, {
      ...message,
      text: "duplicate",
    });

    expect(
      selectOptimisticThreadMessages(useOptimisticThreadMessagesStore.getState(), threadRef),
    ).toEqual([message]);
  });

  it("removes acknowledged messages and returns the shared empty value", () => {
    const first = makeMessage("message-1");
    const second = makeMessage("message-2");

    useOptimisticThreadMessagesStore.getState().addMessage(threadRef, first);
    useOptimisticThreadMessagesStore.getState().addMessage(threadRef, second);
    useOptimisticThreadMessagesStore
      .getState()
      .removeMessages(threadRef, new Set([first.id, second.id]));

    expect(
      selectOptimisticThreadMessages(useOptimisticThreadMessagesStore.getState(), threadRef),
    ).toBe(EMPTY_OPTIMISTIC_THREAD_MESSAGES);
  });
});
