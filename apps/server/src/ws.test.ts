import {
  AgentPageId,
  AgentPageVersionId,
  CommandId,
  EventId,
  MessageId,
  RoomAgentRequestId,
  SettingsChangeRequestId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

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
  it("streams a page an agent shows, so it appears without a reload", () => {
    const event = makeThreadEvent("thread.page-published", {
      threadId: ThreadId.make("thread-1"),
      page: {
        pageId: AgentPageId.make("page-1"),
        versionId: AgentPageVersionId.make("version-1"),
        version: 1,
        turnId: TurnId.make("turn-1"),
        participantId: null,
        title: "Funnel",
        kind: "html",
        height: 400,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(isThreadDetailEvent(event)).toBe(true);
  });

  it("streams an agent's settings card and how it ends, so the card comes and goes live", () => {
    const threadId = ThreadId.make("thread-1");
    const requestId = SettingsChangeRequestId.make("settings-1");
    const at = "2026-01-01T00:00:00.000Z";
    const claim = { claimId: "claim-1", deviceLabel: "iPhone" };
    const events = [
      makeThreadEvent("thread.settings-change-requested", {
        threadId,
        request: {
          requestId,
          participantId: null,
          turnId: TurnId.make("turn-1"),
          changes: [{ place: "general.theme", value: "light" }],
          status: "waiting",
          createdAt: at,
          noted: false,
        },
      }),
      makeThreadEvent("thread.settings-change-claimed", {
        threadId,
        requestId,
        claim,
        claimedAt: at,
      }),
      makeThreadEvent("thread.settings-change-settled", {
        threadId,
        requestId,
        ending: "changed",
        settledAt: at,
      }),
      makeThreadEvent("thread.settings-change-device-reported", {
        threadId,
        requestId,
        device: { applied: ["general.theme"], failed: [] },
        reportedAt: at,
      }),
      makeThreadEvent("thread.settings-change-notes-delivered", {
        threadId,
        requestIds: [requestId],
        deliveredAt: at,
      }),
    ];

    expect(events.map(isThreadDetailEvent)).toEqual([true, true, true, true, true]);
  });

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

  it("streams agents' requests, which only an open thread's detail carries", () => {
    const event = makeThreadEvent("thread.agent-request-updated", {
      threadId: ThreadId.make("thread-1"),
      requestId: RoomAgentRequestId.make("request-1"),
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(isThreadDetailEvent(event)).toBe(true);
  });
});
