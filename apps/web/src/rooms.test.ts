import { ProviderInstanceId, ThreadParticipantId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseLeadingRoomMention, resolveRoomRecipient, suggestParticipantHandle } from "./rooms";

const astraId = ThreadParticipantId.make("agent-astra");
const astra = {
  id: astraId,
  handle: "astra",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  joinedAt: "2026-01-01T00:00:00.000Z",
  leftAt: null,
};

describe("rooms", () => {
  it("addresses the agent that worked last unless the user chose another", () => {
    const thread = { participants: [astra], session: { participantId: astraId } };
    expect(resolveRoomRecipient(thread, undefined)).toBe(astraId);
    expect(resolveRoomRecipient(thread, null)).toBeNull();
    // A choice of an agent that has since left falls back to the thread's own agent.
    const left = {
      participants: [{ ...astra, leftAt: "2026-01-02T00:00:00.000Z" }],
      session: null,
    };
    expect(resolveRoomRecipient(left, astraId)).toBeNull();
  });

  it("routes a message that starts with @handle", () => {
    const thread = { participants: [astra] };
    expect(parseLeadingRoomMention("@Astra review this", thread)?.id).toBe(astraId);
    expect(parseLeadingRoomMention("ask @astra later", thread)).toBeNull();
    expect(parseLeadingRoomMention("@astral review", thread)).toBeNull();
  });

  it("suggests a short handle and avoids taken ones", () => {
    const base = { model: "gpt-6-astra", providerName: "Cursor" };
    expect(suggestParticipantHandle({ ...base, modelDisplayName: "GPT-6 Astra", taken: [] })).toBe(
      "astra",
    );
    expect(
      suggestParticipantHandle({ ...base, modelDisplayName: "GPT-6 Astra", taken: ["astra"] }),
    ).toBe("astra-cursor");
    expect(
      suggestParticipantHandle({
        model: "claude-opus-5",
        providerName: "Claude",
        modelDisplayName: "Claude Opus 5",
        taken: [],
      }),
    ).toBe("opus");
  });
});
