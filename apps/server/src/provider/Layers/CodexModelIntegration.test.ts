import {
  EventId,
  ProviderDriverKind,
  type ProviderEvent,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapToRuntimeEvents } from "./CodexAdapter.ts";
import { parseCodexModelListResponse } from "./CodexProvider.ts";

describe("Codex model integration", () => {
  it("preserves model reasoning descriptions from the live catalog", () => {
    const [model] = parseCodexModelListResponse({
      data: [
        {
          defaultReasoningEffort: "low",
          description: "Fast coding model.",
          displayName: "gpt-5.6-sol",
          hidden: false,
          id: "model_catalog:gpt-5.6-sol",
          inputModalities: ["text", "image"],
          isDefault: false,
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast responses." },
            { reasoningEffort: "medium", description: "More deliberate reasoning." },
          ],
          supportsPersonality: false,
        },
      ],
    });

    expect(model?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "low",
      options: [
        { id: "low", description: "Fast responses.", isDefault: true },
        { id: "medium", description: "More deliberate reasoning." },
      ],
    });
  });

  it("maps safety buffering with the parent turn and complete upstream metadata", () => {
    const event = {
      id: EventId.make("evt-safety-buffering"),
      kind: "notification",
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-09T00:00:00.000Z",
      method: "model/safetyBuffering/updated",
      threadId: ThreadId.make("thread-1"),
      providerThreadId: "provider-child-thread-1",
      turnId: TurnId.make("parent-turn-1"),
      payload: {
        threadId: "provider-child-thread-1",
        turnId: "provider-child-turn-1",
        model: "gpt-5.6-sol",
        useCases: ["cyber"],
        reasons: ["additional-review"],
        showBufferingUi: true,
        fasterModel: "gpt-5.5",
      },
    } satisfies ProviderEvent;

    expect(mapToRuntimeEvents(event, ThreadId.make("thread-1"))).toEqual([
      expect.objectContaining({
        type: "model.safety-buffering.updated",
        turnId: "parent-turn-1",
        providerRefs: {
          providerThreadId: "provider-child-thread-1",
          providerTurnId: "parent-turn-1",
        },
        payload: {
          model: "gpt-5.6-sol",
          useCases: ["cyber"],
          reasons: ["additional-review"],
          showBufferingUi: true,
          fasterModel: "gpt-5.5",
        },
      }),
    ]);
  });
});
