import {
  ChildRequestId,
  EMPTY_AGENT_REQUEST_STATE,
  EnvironmentId,
  MessageId,
  OutsideAgentConnectionId,
  RoomAgentRequestId,
  ScheduledTaskId,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldSuggestNextMessage, turnMessageOrigin } from "./turnOrigin.ts";

const USER_THREAD = {
  parentThreadId: null,
  attachedToParent: false,
  remoteOrigin: null,
  scheduledRun: null,
  outsideOrigin: null,
  outsideWork: [],
  agentRequests: EMPTY_AGENT_REQUEST_STATE,
} as const;

describe("turnMessageOrigin", () => {
  it("counts a message as a person's only when a client app sent it for them", () => {
    expect([
      turnMessageOrigin({ message: { composer: "typed" } }),
      // A plan they chose to implement: not typed, but sent from their device.
      turnMessageOrigin({ message: { sentFrom: { kind: "phone" } } }),
      turnMessageOrigin({ message: { trigger: "accountSwitch" } }),
      // Server-written words with no mark (pull request automation).
      turnMessageOrigin({ message: {} }),
      turnMessageOrigin({ message: { trigger: "usageLimitReset" } }),
    ]).toEqual(["person", "person", "person", "automatic", "automatic"]);
  });

  it("names agents, other threads and task runs before anything else", () => {
    const fromThread = {
      threadId: ThreadId.make("thread-parent"),
      requestId: ChildRequestId.make("request-1"),
      kind: "report" as const,
    };
    const fromOutside = {
      connectionId: OutsideAgentConnectionId.make("connection-1"),
      name: "Claude Code",
    };
    expect([
      turnMessageOrigin({ message: { fromAgent: { participantId: null } } }),
      turnMessageOrigin({ message: { composer: "typed" }, askedByAgent: true }),
      turnMessageOrigin({ message: {}, fromThread }),
      turnMessageOrigin({ message: { fromOutside } }),
      turnMessageOrigin({ message: {}, scheduledTaskId: "task-1" }),
    ]).toEqual(["room_agent", "room_agent", "other_thread", "outside_agent", "task"]);
  });
});

describe("shouldSuggestNextMessage", () => {
  const childReport = {
    threadId: ThreadId.make("thread-child"),
    requestId: ChildRequestId.make("request-1"),
    kind: "report" as const,
  };
  const childRequest = {
    threadId: ThreadId.make("thread-parent"),
    requestId: ChildRequestId.make("request-2"),
    kind: "request" as const,
  };

  it("suggests for user messages and user-facing wakeups on a top-level thread", () => {
    expect(
      shouldSuggestNextMessage({
        origin: "person",
        message: {},
        thread: USER_THREAD,
      }),
    ).toBe(true);
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        thread: USER_THREAD,
      }),
    ).toBe(true);
    expect(
      shouldSuggestNextMessage({
        origin: "room_agent",
        message: {
          fromAgent: { participantId: ThreadParticipantId.make("reviewer") },
          requestKind: "reply",
        },
        thread: USER_THREAD,
      }),
    ).toBe(true);
    expect(
      shouldSuggestNextMessage({
        origin: "automatic",
        message: { trigger: "serverRestart" },
        thread: USER_THREAD,
      }),
    ).toBe(true);
    expect(
      shouldSuggestNextMessage({
        origin: "automatic",
        message: { trigger: "usageLimitReset" },
        thread: USER_THREAD,
      }),
    ).toBe(true);
  });

  it("skips agent-to-agent requests, automatic alerts, and non-user threads", () => {
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childRequest },
        fromThread: childRequest,
        thread: USER_THREAD,
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "room_agent",
        message: {
          fromAgent: { participantId: null },
          requestKind: "hand_off",
        },
        thread: USER_THREAD,
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "automatic",
        message: {},
        thread: USER_THREAD,
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "outside_agent",
        message: {},
        thread: USER_THREAD,
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "task",
        message: {},
        thread: USER_THREAD,
      }),
    ).toBe(false);
    // Child report waking an attached child, remote child, scheduled task, or outside-agent thread.
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        thread: {
          ...USER_THREAD,
          parentThreadId: ThreadId.make("thread-grandparent"),
          attachedToParent: true,
        },
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        thread: {
          ...USER_THREAD,
          remoteOrigin: {
            linkDeviceId: "device-remote",
            environmentId: EnvironmentId.make("env-remote"),
            environmentLabel: "Remote Mac",
            threadId: ThreadId.make("thread-remote-parent"),
            threadTitle: "Remote parent",
          },
        },
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        thread: {
          ...USER_THREAD,
          scheduledRun: {
            taskId: ScheduledTaskId.make("task-1"),
            taskName: "Nightly",
            slotUtc: "2026-11-24T00:00:00.000Z",
          },
        },
      }),
    ).toBe(false);
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        thread: {
          ...USER_THREAD,
          outsideOrigin: {
            connectionId: OutsideAgentConnectionId.make("conn-1"),
            name: "Grok Bot",
          },
        },
      }),
    ).toBe(false);
    // Outside work is scoped per participant: another participant's mark does not block primary.
    const otherAgent = ThreadParticipantId.make("agent-outside");
    const outsideWork = [
      {
        participantId: otherAgent,
        since: "2026-11-24T00:00:00.000Z",
        version: 1,
        connections: [
          {
            connectionId: OutsideAgentConnectionId.make("conn-1"),
            name: "Grok Bot",
          },
        ],
      },
    ];
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        participantId: null,
        thread: { ...USER_THREAD, outsideWork },
      }),
    ).toBe(true);
    expect(
      shouldSuggestNextMessage({
        origin: "other_thread",
        message: { fromThread: childReport },
        fromThread: childReport,
        participantId: otherAgent,
        thread: { ...USER_THREAD, outsideWork },
      }),
    ).toBe(false);
    // A nested room reply back to an agent still answering an outer hand-off.
    const nestedAgent = ThreadParticipantId.make("agent-b");
    expect(
      shouldSuggestNextMessage({
        origin: "room_agent",
        message: {
          fromAgent: { participantId: ThreadParticipantId.make("agent-c") },
          requestKind: "reply",
        },
        participantId: nestedAgent,
        thread: {
          ...USER_THREAD,
          agentRequests: {
            ...EMPTY_AGENT_REQUEST_STATE,
            chainEpoch: 1,
            open: [
              {
                requestId: RoomAgentRequestId.make("req-outer"),
                kind: "hand_off",
                status: "running",
                from: { participantId: null },
                to: { participantId: nestedAgent },
                callerTurnId: TurnId.make("turn-1"),
                requestMessageId: MessageId.make("msg-1"),
                chainEpoch: 1,
                createdAt: "2026-11-24T00:00:00.000Z",
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });
});
