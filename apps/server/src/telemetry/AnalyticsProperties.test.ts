import { assert, describe, it } from "@effect/vitest";

import {
  analyticsModelProperties,
  classifyProviderSessionStart,
  classifyModelRerouteReason,
  classifyProviderFailure,
  normalizeAnalyticsModel,
} from "./AnalyticsProperties.ts";

describe("AnalyticsProperties", () => {
  it("keeps known public model slugs", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel(" GPT-5.4 "), {
      model: "gpt-5.4",
      modelKind: "known",
      modelFamily: "gpt",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("claude-sonnet-4-6"), {
      model: "claude-sonnet-4-6",
      modelKind: "known",
      modelFamily: "claude",
    });
  });

  it("redacts custom and provider-prefixed model strings", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel("openai/private-gpt-5-prod"), {
      model: "custom",
      modelKind: "custom",
      modelFamily: "gpt",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("my-internal-model"), {
      model: "custom",
      modelKind: "custom",
      modelFamily: "other",
    });
  });

  it("emits prefixed model properties", () => {
    assert.deepStrictEqual(analyticsModelProperties({ model: "claude-opus-4-8", prefix: "from" }), {
      fromModel: "claude-opus-4-8",
      fromModelKind: "known",
      fromModelFamily: "claude",
    });
  });

  it("categorizes provider failures without exposing raw messages", () => {
    assert.strictEqual(
      classifyProviderFailure({ message: "API Error: 429 rate limit exceeded" }),
      "rate_limit",
    );
    assert.strictEqual(
      classifyProviderFailure({ errorClass: "authentication_error", message: "raw detail" }),
      "auth",
    );
    assert.strictEqual(
      classifyProviderFailure({ message: "Context window exceeded for this request" }),
      "context_length",
    );
  });

  it("categorizes model reroutes", () => {
    assert.deepStrictEqual(classifyModelRerouteReason("fallback:model-unavailable"), {
      reasonCategory: "model_unavailable",
      isFallback: true,
    });
    assert.deepStrictEqual(classifyModelRerouteReason("fallback:refusal"), {
      reasonCategory: "refusal",
      isFallback: true,
    });
  });

  it("classifies provider session starts", () => {
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: false,
        nextProvider: "codex",
        nextInstanceId: "codex",
        hasContextSeed: false,
        hasResumeCursor: false,
      }),
      "fresh",
    );
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: true,
        previousProvider: "codex",
        previousInstanceId: "codex",
        nextProvider: "claudeAgent",
        nextInstanceId: "claudeAgent",
        hasContextSeed: true,
        hasResumeCursor: false,
      }),
      "provider_switch",
    );
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: true,
        previousProvider: "codex",
        previousInstanceId: "codex",
        nextProvider: "codex",
        nextInstanceId: "codex",
        hasContextSeed: false,
        hasResumeCursor: true,
      }),
      "resume",
    );
  });
});
