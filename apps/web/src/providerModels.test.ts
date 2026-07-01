import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";

import { getDefaultServerModel, providerModelSupportsInputModality } from "./providerModels";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function model(input: {
  readonly slug: string;
  readonly isCustom?: boolean;
  readonly isHidden?: boolean;
  readonly inputModalities?: NonNullable<
    NonNullable<ServerProviderModel["capabilities"]>["inputModalities"]
  >;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    isCustom: input.isCustom ?? false,
    ...(input.isHidden ? { isHidden: true } : {}),
    capabilities: {
      ...(input.inputModalities ? { inputModalities: input.inputModalities } : {}),
      optionDescriptors: [],
    },
  };
}

function provider(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-30T00:00:00.000Z",
    models: input.models,
    slashCommands: [],
    skills: [],
  };
}

describe("providerModelSupportsInputModality", () => {
  it("honors explicit model input modalities", () => {
    const models = [model({ slug: "text-only", inputModalities: ["text"] })];

    expect(providerModelSupportsInputModality(models, "text-only", CODEX, "text")).toBe(true);
    expect(providerModelSupportsInputModality(models, "text-only", CODEX, "image")).toBe(false);
  });

  it("treats missing modality metadata as supported for backward compatibility", () => {
    const models = [model({ slug: "legacy-model" })];

    expect(providerModelSupportsInputModality(models, "legacy-model", CODEX, "image")).toBe(true);
    expect(providerModelSupportsInputModality([], "missing-model", CODEX, "image")).toBe(true);
  });
});

describe("getDefaultServerModel", () => {
  it("prefers the configured provider default when it is in the live model list", () => {
    const providers = [
      provider({
        driver: CLAUDE,
        instanceId: "claudeAgent",
        models: [
          model({ slug: "claude-fable-5" }),
          model({ slug: "claude-sonnet-5" }),
          model({ slug: "claude-sonnet-4-6" }),
        ],
      }),
    ];

    expect(getDefaultServerModel(providers, CLAUDE)).toBe("claude-sonnet-5");
  });

  it("falls back to the first visible built-in when the configured default is unavailable", () => {
    const providers = [
      provider({
        driver: CLAUDE,
        instanceId: "claudeAgent",
        models: [
          model({ slug: "claude-sonnet-5", isHidden: true }),
          model({ slug: "claude-sonnet-4-6" }),
        ],
      }),
    ];

    expect(getDefaultServerModel(providers, CLAUDE)).toBe("claude-sonnet-4-6");
  });
});
