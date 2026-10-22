import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes safety-buffering updates with a required turn and nullable faster model", () => {
    const parsed = decodeRuntimeEvent({
      type: "model.safety-buffering.updated",
      eventId: "event-safety-buffering-1",
      provider: "codex",
      createdAt: "2026-07-09T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        model: "gpt-5.6-sol",
        useCases: ["cyber"],
        reasons: ["additional-review"],
        showBufferingUi: true,
        fasterModel: null,
      },
    });

    expect(parsed.type).toBe("model.safety-buffering.updated");
    if (parsed.type !== "model.safety-buffering.updated") {
      throw new Error("expected model.safety-buffering.updated");
    }
    expect(parsed.turnId).toBe("turn-1");
    expect(parsed.payload).toEqual({
      model: "gpt-5.6-sol",
      useCases: ["cyber"],
      reasons: ["additional-review"],
      showBufferingUi: true,
      fasterModel: null,
    });

    expect(() =>
      decodeRuntimeEvent({
        ...parsed,
        turnId: undefined,
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });
});
