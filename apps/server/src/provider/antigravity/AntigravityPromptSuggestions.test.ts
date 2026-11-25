import type { ServerProviderAccountUsage, ServerProviderModel } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTranscriptPromptSuggestionPrompt,
  PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE,
  PROMPT_SUGGESTION_MAX_MESSAGES,
} from "../promptSuggestions.ts";
import {
  isAntigravityPromptSuggestionAuthSupported,
  isAntigravitySuggestionUsageNearLimit,
  selectAntigravitySuggestionTarget,
} from "./AntigravityPromptSuggestions.ts";

const makeModel = (
  slug: string,
  name: string,
  efforts?: ReadonlyArray<string>,
): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: efforts
    ? {
        optionDescriptors: [
          {
            id: "thought_level",
            label: "Thinking Level",
            type: "select",
            options: efforts.map((id) => ({ id, label: id })),
          },
        ],
      }
    : null,
});

describe("selectAntigravitySuggestionTarget", () => {
  it("prefers Gemini Hydrogen over Flash and heavier models, with light thinking", () => {
    const models = [
      makeModel("gemini-4-neon", "Gemini 4 Neon", ["low", "medium", "high", "xhigh"]),
      makeModel("gemini-4-argon", "Gemini 4 Argon", ["low", "high"]),
      makeModel("gemini-4-hydrogen", "Gemini 4 Hydrogen", ["low", "medium", "high"]),
      makeModel("gemini-3.8-flash", "Gemini 3.8 Flash", ["minimal", "low", "high"]),
      makeModel("claude-opus-5-5", "Claude Opus 5.5", ["high"]),
    ];

    expect(selectAntigravitySuggestionTarget(models)).toEqual({
      model: "gemini-4-hydrogen",
      modelName: "Gemini 4 Hydrogen",
      options: [{ id: "thought_level", value: "low" }],
    });
  });

  it("falls back to non-lite Gemini Flash when Hydrogen is absent", () => {
    const models = [
      makeModel("gemini-4-argon", "Gemini 4 Argon", ["low", "high"]),
      makeModel("gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite", ["minimal", "low"]),
      makeModel("gemini-3.8-flash", "Gemini 3.8 Flash", ["minimal", "high"]),
    ];

    expect(selectAntigravitySuggestionTarget(models)).toEqual({
      model: "gemini-3.8-flash",
      modelName: "Gemini 3.8 Flash",
      options: [{ id: "thought_level", value: "minimal" }],
    });
  });

  it("skips suggestions rather than falling back to frontier models when neither Hydrogen nor Flash is listed", () => {
    const models = [makeModel("gemini-4-argon", "Gemini 4 Argon", ["low", "high"])];

    expect(selectAntigravitySuggestionTarget(models)).toBeUndefined();
    expect(selectAntigravitySuggestionTarget([])).toBeUndefined();
    const catalogWithDefault: ReadonlyArray<ServerProviderModel> = [
      { ...makeModel("gemini-4-argon", "Gemini 4 Argon", ["low", "high"]), isDefault: true },
    ];
    expect(selectAntigravitySuggestionTarget(catalogWithDefault)).toBeUndefined();
  });
});

describe("isAntigravityPromptSuggestionAuthSupported", () => {
  it("allows Google OAuth sign-ins and skips pay-per-token API key and Vertex AI methods", () => {
    expect(isAntigravityPromptSuggestionAuthSupported("oauth-personal")).toBe(true);
    expect(isAntigravityPromptSuggestionAuthSupported("oauth-business")).toBe(true);
    expect(isAntigravityPromptSuggestionAuthSupported("gemini-api-key")).toBe(false);
    expect(isAntigravityPromptSuggestionAuthSupported("agent-platform")).toBe(false);
  });
});

describe("isAntigravitySuggestionUsageNearLimit", () => {
  const nowMs = Date.parse("2026-11-23T18:00:00.000Z");
  const resetsAt = nowMs + 3_600_000;

  it("still enforces plan-wide limits when the model name is unknown", () => {
    const planWideUsage: ServerProviderAccountUsage = {
      source: "codex-rate-limits",
      checkedAt: "2026-11-23T17:59:00.000Z",
      limits: [
        {
          primary: {
            usedPercent: 92,
            remainingPercent: 8,
            resetsAt,
          },
        },
      ],
    };
    expect(isAntigravitySuggestionUsageNearLimit(planWideUsage, undefined, nowMs)).toBe(true);
    const scopedUsage: ServerProviderAccountUsage = {
      source: "grok-billing",
      checkedAt: "2026-11-23T17:59:00.000Z",
      limits: [
        {
          limitId: "antigravity",
          scoped: [
            {
              scopeLabel: "Claude & GPT",
              scopeModels: ["Claude", "GPT"],
              usedPercent: 95,
              remainingPercent: 5,
              resetsAt,
            },
          ],
        },
      ],
    };
    expect(isAntigravitySuggestionUsageNearLimit(scopedUsage, undefined, nowMs)).toBe(true);
  });

  it("pauses only when the chosen suggestion model's own pool hits 90%", () => {
    const usage: ServerProviderAccountUsage = {
      source: "grok-billing",
      checkedAt: "2026-11-23T17:59:00.000Z",
      limits: [
        {
          limitId: "antigravity",
          scoped: [
            {
              scopeLabel: "Gemini",
              scopeModels: ["Gemini"],
              usedPercent: 45,
              remainingPercent: 55,
              resetsAt,
            },
            {
              scopeLabel: "Claude & GPT",
              scopeModels: ["Claude", "GPT"],
              usedPercent: 95,
              remainingPercent: 5,
              resetsAt,
            },
          ],
        },
      ],
    };

    expect(isAntigravitySuggestionUsageNearLimit(usage, "Gemini 4 Hydrogen", nowMs)).toBe(false);
    expect(isAntigravitySuggestionUsageNearLimit(usage, "Claude Opus 5.5", nowMs)).toBe(true);
  });
});

describe("buildTranscriptPromptSuggestionPrompt", () => {
  it("keeps the newest messages and preserves the tail of a long assistant reply", () => {
    const messages = Array.from({ length: PROMPT_SUGGESTION_MAX_MESSAGES + 3 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn-${index}`,
    }));
    const longTail = "Should I run the browser tests now?";
    messages.push({
      role: "assistant",
      text: `${"x".repeat(PROMPT_SUGGESTION_MAX_CHARS_PER_MESSAGE + 500)}${longTail}`,
    });

    const prompt = buildTranscriptPromptSuggestionPrompt(messages);
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain("turn-0");
    expect(prompt).not.toContain("turn-3");
    expect(prompt).toContain("turn-4");
    expect(prompt).toContain(longTail);
  });
});
