import { createModelCapabilities } from "@threadlines/shared/model";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAcpModelsFromConfigOptions,
  GENERIC_ACP_MODEL_OPTION_MAPPING,
} from "./AcpProviderModels.ts";

// Shape of fx's `session/new` response: a provider picker filed under the
// `model` category ahead of the model itself, then the session mode.
const fxConfigOptions = [
  {
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "gateway",
    options: [
      { value: "gateway", name: "Vercel AI Gateway" },
      { value: "codex", name: "Codex subscription" },
      { value: "grok", name: "Grok subscription" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "moonshotai/kimi-k3",
    options: [
      { value: "moonshotai/kimi-k3", name: "moonshotai/kimi-k3" },
      { value: "anthropic/claude-sonnet-5", name: "anthropic/claude-sonnet-5" },
    ],
  },
  {
    id: "mode",
    name: "Session Mode",
    description: "Controls how the agent requests permission",
    category: "mode",
    type: "select",
    currentValue: "code",
    options: [
      { value: "ask", name: "Ask" },
      { value: "code", name: "Code" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("GENERIC_ACP_MODEL_OPTION_MAPPING", () => {
  it("mirrors non-model options as descriptors and ignores the session mode", () => {
    expect(GENERIC_ACP_MODEL_OPTION_MAPPING.capabilitiesFromConfigOptions(fxConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "provider",
            label: "Provider",
            type: "select",
            currentValue: "gateway",
            options: [
              { id: "gateway", label: "Vercel AI Gateway", isDefault: true },
              { id: "codex", label: "Codex subscription" },
              { id: "grok", label: "Grok subscription" },
            ],
          },
        ],
      }),
    );
  });

  it("maps selections back onto the agent's config ids and drops unknown values", () => {
    expect(
      GENERIC_ACP_MODEL_OPTION_MAPPING.configUpdatesFromSelections(fxConfigOptions, [
        { id: "provider", value: "codex" },
        { id: "mode", value: "ask" },
        { id: "model", value: "anthropic/claude-sonnet-5" },
        { id: "provider", value: "nope" },
      ]),
    ).toEqual([{ configId: "provider", value: "codex" }]);
  });
});

describe("buildAcpModelsFromConfigOptions", () => {
  it("shares the live capabilities across the catalog when they do not vary by model", () => {
    const models = buildAcpModelsFromConfigOptions({
      configOptions: fxConfigOptions,
      mapping: GENERIC_ACP_MODEL_OPTION_MAPPING,
      sharedCapabilities: true,
    });
    expect(models.map((model) => model.slug)).toEqual([
      "moonshotai/kimi-k3",
      "anthropic/claude-sonnet-5",
    ]);
    expect(models.every((model) => model.capabilities?.optionDescriptors?.length === 1)).toBe(true);
  });
});
