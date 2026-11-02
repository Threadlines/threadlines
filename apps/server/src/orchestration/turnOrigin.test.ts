import { ChildRequestId, OutsideAgentConnectionId, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { turnMessageOrigin } from "./turnOrigin.ts";

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
