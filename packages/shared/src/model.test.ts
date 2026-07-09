import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
} from "@threadlines/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
  resolveModelSlugForProvider,
  resolveSelectableModel,
  trimOrNull,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    expect(normalizeModelSlug("5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("sol")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("terra")).toBe("gpt-5.6-terra");
    expect(normalizeModelSlug("luna")).toBe("gpt-5.6-luna");
    expect(normalizeModelSlug("gpt-5-codex")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.5")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("fable", claude)).toBe("claude-fable-5");
    expect(normalizeModelSlug("fable-5", claude)).toBe("claude-fable-5");
    expect(normalizeModelSlug("sonnet", claude)).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("sonnet-5", claude)).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("sonnet-4.6", claude)).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("opus-4.7", claude)).toBe("claude-opus-4-7");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlugForProvider", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlugForProvider(ProviderDriverKind.make("codex"), undefined)).toBe(
      DEFAULT_MODEL,
    );
    expect(resolveModelSlugForProvider(ProviderDriverKind.make("claudeAgent"), undefined)).toBe(
      "claude-sonnet-5",
    );
    expect(resolveModelSlugForProvider(ProviderDriverKind.make("ollama"), undefined)).toBe(
      DEFAULT_MODEL,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(
      resolveModelSlugForProvider(ProviderDriverKind.make("codex"), "custom/internal-model"),
    ).toBe("custom/internal-model");
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slugs, labels, and aliases", () => {
    const options = [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
    ];
    expect(resolveSelectableModel(ProviderDriverKind.make("codex"), "gpt-5.3-codex", options)).toBe(
      "gpt-5.3-codex",
    );
    expect(resolveSelectableModel(ProviderDriverKind.make("codex"), "gpt-5.3 codex", options)).toBe(
      "gpt-5.3-codex",
    );
    expect(resolveSelectableModel(ProviderDriverKind.make("claudeAgent"), "sonnet", options)).toBe(
      "claude-sonnet-5",
    );
  });

  it("resolves the official GPT-5.6 alias to the Sol catalog entry", () => {
    const options = [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }];

    expect(resolveSelectableModel(ProviderDriverKind.make("codex"), "gpt-5.6", options)).toBe(
      "gpt-5.6-sol",
    );
  });
});

describe("misc helpers", () => {
  it("trims strings to null", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
    expect(trimOrNull("   ")).toBeNull();
  });
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "medium",
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});
