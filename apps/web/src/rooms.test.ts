import { ProviderInstanceId, ThreadParticipantId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "./providerInstances";
import {
  buildRoomAgentLabels,
  resolveRoomDelivery,
  resolveRoomRecipient,
  roomAgentKey,
} from "./rooms";

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

  it("names every agent by its model and numbers agents on the same model", () => {
    const entries = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }],
      },
    ] as unknown as ReadonlyArray<ProviderInstanceEntry>;
    const secondAstraId = ThreadParticipantId.make("agent-astra-2");
    const labels = buildRoomAgentLabels(
      {
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus-9" },
        participants: [astra, { ...astra, id: secondAstraId }],
      },
      entries,
      (model) => model.name,
    );
    // A model this client does not know keeps its id.
    expect(labels?.get(roomAgentKey(null))?.name).toBe("opus-9");
    expect(labels?.get(roomAgentKey(astraId))?.name).toBe("GPT-6 Astra");
    expect(labels?.get(roomAgentKey(secondAstraId))?.name).toBe("GPT-6 Astra 2");
  });

  it("asks another agent now while one works, and queues when asked to or when it cannot", () => {
    const delivery = (overrides: Partial<Parameters<typeof resolveRoomDelivery>[0]>) =>
      resolveRoomDelivery({
        recipientId: astraId,
        holderId: null,
        holderBusy: true,
        recipientDriverKind: "codex",
        preferred: "steer",
        ...overrides,
      });
    expect(delivery({})).toBe("ask");
    expect(delivery({ preferred: "queue" })).toBe("queue");
    // A provider that cannot answer read-only on the side always waits.
    expect(delivery({ recipientDriverKind: "cursor" })).toBe("queue");
    // The agent at work gets a steer, and an idle room just sends.
    expect(delivery({ holderId: astraId })).toBe("direct");
    expect(delivery({ holderBusy: false })).toBe("direct");
  });
});
