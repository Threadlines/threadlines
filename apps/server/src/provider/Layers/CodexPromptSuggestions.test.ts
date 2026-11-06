import type { ServerProviderModel } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_SUGGESTION_PROMPT,
  codexSuggestionEffort,
  codexSuggestionFromSample,
  modelReasoningEfforts,
} from "./CodexPromptSuggestions.ts";

describe("codexSuggestionFromSample", () => {
  it("keeps one short line, without the quotes the model added", () => {
    expect(codexSuggestionFromSample("  “Run the tests and fix what fails.” ")).toBe(
      "Run the tests and fix what fails.",
    );
    expect(codexSuggestionFromSample("Write the code.")).toBe("Write the code.");
  });

  it("makes none from no text, several lines, a long answer or a word for nothing", () => {
    expect(codexSuggestionFromSample(null)).toBeUndefined();
    expect(codexSuggestionFromSample("   ")).toBeUndefined();
    expect(codexSuggestionFromSample("Run the tests.\nThen commit.")).toBeUndefined();
    expect(codexSuggestionFromSample("word ".repeat(21))).toBeUndefined();
    expect(codexSuggestionFromSample("x".repeat(121))).toBeUndefined();
    expect(codexSuggestionFromSample("(none)")).toBeUndefined();
  });

  it("asks within Codex's 4,000-byte limit", () => {
    expect(new TextEncoder().encode(CODEX_SUGGESTION_PROMPT).length).toBeLessThanOrEqual(4000);
  });
});

describe("codexSuggestionEffort", () => {
  const model = (slug: string, efforts: ReadonlyArray<string>, isDefault = false) =>
    ({
      slug,
      name: slug,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: efforts.map((id) => ({ id, label: id })),
          },
        ],
      },
    }) as ServerProviderModel;
  const models = [model("gpt-a", ["high", "low"], true), model("gpt-pro", ["xhigh", "high"])];

  it("asks for low where the model has it, else keeps the thread's own", () => {
    expect(codexSuggestionEffort(modelReasoningEfforts(models, "gpt-a"))).toBe("low");
    expect(codexSuggestionEffort(modelReasoningEfforts(models, "gpt-pro"))).toBeUndefined();
    expect(codexSuggestionEffort(modelReasoningEfforts(models, "unknown"))).toBeUndefined();
    expect(codexSuggestionEffort(["minimal", "high"])).toBe("minimal");
  });

  it("reads a turn that named no model as the catalog's default", () => {
    expect(modelReasoningEfforts(models, undefined)).toEqual(["high", "low"]);
  });
});
