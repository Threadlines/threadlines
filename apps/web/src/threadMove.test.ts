import {
  ComputerLinkId,
  EnvironmentId,
  type OrchestrationThreadMove,
  type OutboundComputerLink,
  ProviderInstanceId,
  ThreadId,
  ThreadMoveId,
  type ThreadMoveTargetPreview,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadMoveProgress,
  formatThreadMoveChanges,
  isThreadMoveOffered,
  isThreadMoveStalled,
  pickDefaultMoveAgent,
  pickDefaultMoveTarget,
  threadMoveAgentSelection,
} from "./threadMove";

const MAC_MINI = EnvironmentId.make("environment-mac-mini");

function move(overrides: Partial<OrchestrationThreadMove> = {}): OrchestrationThreadMove {
  return {
    transferId: ThreadMoveId.make("move-1"),
    target: { environmentId: MAC_MINI, label: "Mac mini" },
    agent: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    phase: "exporting",
    cancelRequested: false,
    startedAt: "2026-10-22T09:00:00.000Z",
    ...overrides,
  };
}

function link(overrides: Partial<OutboundComputerLink> = {}): OutboundComputerLink {
  return {
    linkId: ComputerLinkId.make("link-mac-mini"),
    remoteEnvironmentId: MAC_MINI,
    remoteLabel: "Mac mini",
    remotePlatform: null,
    state: "active",
    connection: "connected",
    route: "direct",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastConnectedAt: null,
    lastError: null,
    ...overrides,
  };
}

function target(overrides: Partial<ThreadMoveTargetPreview> = {}): ThreadMoveTargetPreview {
  return {
    environmentId: MAC_MINI,
    label: "Mac mini",
    projectName: "threadlines",
    access: "ask",
    agents: [
      {
        instanceId: "codex",
        name: "Codex",
        billing: "ChatGPT Pro",
        driver: "codex",
        models: [
          { model: "gpt-5", name: "GPT-5" },
          { model: "gpt-5-mini", name: "GPT-5 mini" },
        ],
      },
      {
        instanceId: "claudeAgent",
        name: "Claude",
        billing: "Claude Max",
        driver: "claudeAgent",
        models: [{ model: "claude-opus-5-5", name: "Opus 5.5" }],
      },
    ],
    ...overrides,
  };
}

describe("formatThreadMoveChanges", () => {
  it("says what goes with the thread, leaving out what is empty", () => {
    expect(
      formatThreadMoveChanges({
        messageCount: 12,
        branch: "fix/x",
        trackedFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 2,
      }),
    ).toBe("12 messages · branch fix/x · 3 changed files · 1 new file · 2 commits not pushed");
    expect(
      formatThreadMoveChanges({
        messageCount: 1,
        branch: null,
        trackedFiles: 0,
        untrackedFiles: 0,
        unpushedCommits: 1,
      }),
    ).toBe("1 message · not on a branch · 1 commit not pushed");
  });
});

describe("describeThreadMoveProgress", () => {
  it("names each step, the share sent, and a stop on its way", () => {
    expect(describeThreadMoveProgress(move())).toBe("Getting ready to move to Mac mini…");
    expect(describeThreadMoveProgress(move({ phase: "awaiting_approval" }))).toBe(
      "Waiting for Mac mini to allow the move",
    );
    expect(
      describeThreadMoveProgress(move({ phase: "sending", sentBytes: 409, totalBytes: 1_000 })),
    ).toBe("Sending to Mac mini · 40%");
    expect(describeThreadMoveProgress(move({ phase: "sending" }))).toBe("Sending to Mac mini…");
    expect(describeThreadMoveProgress(move({ phase: "importing" }))).toBe(
      "Setting up on Mac mini…",
    );
    expect(describeThreadMoveProgress(move({ phase: "sending", cancelRequested: true }))).toBe(
      "Stopping the move…",
    );
  });
});

describe("isThreadMoveStalled", () => {
  it("holds an unfinished move whose link is gone, revoked or can't reach the other computer", () => {
    expect(isThreadMoveStalled({ move: move(), outbound: [link()] })).toBe(false);
    expect(isThreadMoveStalled({ move: move(), outbound: [] })).toBe(true);
    expect(isThreadMoveStalled({ move: move(), outbound: [link({ state: "revoked" })] })).toBe(
      true,
    );
    expect(isThreadMoveStalled({ move: move(), outbound: [link({ connection: "offline" })] })).toBe(
      true,
    );
  });

  it("says nothing while the links aren't heard, or once the move is done", () => {
    expect(isThreadMoveStalled({ move: move(), outbound: null })).toBe(false);
    expect(
      isThreadMoveStalled({
        move: move({
          movedAway: {
            threadId: ThreadId.make("thread-there"),
            movedAt: "2026-10-22T09:05:00.000Z",
          },
        }),
        outbound: [],
      }),
    ).toBe(false);
  });
});

describe("isThreadMoveOffered", () => {
  it("needs a computer that moves threads, an active link, and a thread not already moving", () => {
    const offered = (input: Partial<Parameters<typeof isThreadMoveOffered>[0]>) =>
      isThreadMoveOffered({
        supportsThreadMove: true,
        outbound: [link()],
        moveStatus: undefined,
        ...input,
      });
    expect(offered({})).toBe(true);
    expect(offered({ supportsThreadMove: false })).toBe(false);
    expect(offered({ outbound: [link({ state: "unlinking" })] })).toBe(false);
    expect(offered({ outbound: null })).toBe(false);
    expect(offered({ moveStatus: "moving" })).toBe(false);
    expect(offered({ moveStatus: "moved" })).toBe(false);
  });
});

describe("picking where and with whom", () => {
  it("offers first the computer that can take it, and its suggested agent", () => {
    const refused = target({
      environmentId: EnvironmentId.make("environment-windows"),
      label: "Windows PC",
      refusal: "Windows PC has no project for this repository.",
    });
    const suggested = target({
      suggestedAgent: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });
    expect(pickDefaultMoveTarget([refused, suggested])).toBe(suggested);
    expect(pickDefaultMoveAgent(suggested)).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    // A suggestion it doesn't have: its first model instead.
    expect(
      pickDefaultMoveAgent(
        target({ suggestedAgent: { instanceId: ProviderInstanceId.make("pi"), model: "x" } }),
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
  });

  it("asks for the suggestion as it came, options included, and any other pick as picked", () => {
    const suggestedAgent = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const withSuggestion = target({ suggestedAgent });
    expect(threadMoveAgentSelection(withSuggestion, { instanceId: "codex", model: "gpt-5" })).toBe(
      suggestedAgent,
    );
    expect(
      threadMoveAgentSelection(withSuggestion, { instanceId: "codex", model: "gpt-5-mini" }),
    ).toEqual({ instanceId: "codex", model: "gpt-5-mini" });
  });
});
