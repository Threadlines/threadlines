import { ProviderInstanceId, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_WARM_UP_RENEW_MS, nextAgentWarmUp, type AgentWarmUpInput } from "./agentWarmUp.ts";

const typing: AgentWarmUpInput = {
  enabled: true,
  threadId: ThreadId.make("thread-1"),
  serverThreadExists: true,
  hasText: true,
  turnActive: false,
  participantId: null,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "auto",
};

describe("nextAgentWarmUp", () => {
  it("sends once per target, renews while typing goes on, and resends at once for a new target", () => {
    const first = nextAgentWarmUp(typing, null, 1_000);
    expect(first?.request).toEqual({
      threadId: typing.threadId,
      participantId: null,
      modelSelection: typing.modelSelection,
      runtimeMode: "auto",
    });

    expect(nextAgentWarmUp(typing, first!.sent, 1_000 + AGENT_WARM_UP_RENEW_MS - 1)).toBeNull();
    expect(nextAgentWarmUp(typing, first!.sent, 1_000 + AGENT_WARM_UP_RENEW_MS)).not.toBeNull();

    const otherModel = { ...typing, modelSelection: { ...typing.modelSelection, model: "other" } };
    expect(nextAgentWarmUp(otherModel, first!.sent, 1_001)).not.toBeNull();
  });

  it("sends nothing for a draft, an empty composer, a running turn, or when turned off", () => {
    for (const input of [
      { ...typing, serverThreadExists: false },
      { ...typing, hasText: false },
      { ...typing, turnActive: true },
      { ...typing, enabled: false },
      { ...typing, threadId: null },
    ]) {
      expect(nextAgentWarmUp(input, null, 1_000)).toBeNull();
    }
  });
});
