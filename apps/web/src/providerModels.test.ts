import { describe, expect, it } from "vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@threadlines/contracts";

import { providerModelSupportsInputModality } from "./providerModels";

const CODEX = ProviderDriverKind.make("codex");

function model(input: {
  readonly slug: string;
  readonly inputModalities?: NonNullable<
    NonNullable<ServerProviderModel["capabilities"]>["inputModalities"]
  >;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    isCustom: false,
    capabilities: {
      ...(input.inputModalities ? { inputModalities: input.inputModalities } : {}),
      optionDescriptors: [],
    },
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
