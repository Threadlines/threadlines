import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import { isThreadDetailEvent } from "./ws.ts";

function makeThreadEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): Extract<OrchestrationEvent, { type: T }> {
  return {
    sequence: 1,
    eventId: EventId.make(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${type}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${type}`),
    metadata: {},
    payload,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("isThreadDetailEvent", () => {
  it("streams accepted follow-ups to active thread subscribers", () => {
    const event = makeThreadEvent("thread.follow-up-accepted", {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      messageId: MessageId.make("message-follow-up"),
      role: "user",
      text: "steer the active turn",
      attachments: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(isThreadDetailEvent(event)).toBe(true);
  });

  it("streams submitted follow-ups so active thread metadata stays current", () => {
    const event = makeThreadEvent("thread.follow-up-submitted", {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      messageId: MessageId.make("message-follow-up"),
      role: "user",
      text: "steer the active turn",
      attachments: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(isThreadDetailEvent(event)).toBe(true);
  });
});
