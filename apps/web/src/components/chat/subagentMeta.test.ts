import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@threadlines/contracts";

import { formatSubagentModelSlug, resolveSubagentModelLabel } from "./subagentMeta";

const model = (slug: string, name: string, shortName?: string): ServerProviderModel =>
  ({
    slug,
    name,
    isCustom: false,
    capabilities: null,
    ...(shortName ? { shortName } : {}),
  }) as ServerProviderModel;

const PROVIDERS = [
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [model("claude-opus-5", "Claude Opus 5", "Opus 5")],
  },
  {
    driver: ProviderDriverKind.make("codex"),
    models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
  },
];

describe("resolveSubagentModelLabel", () => {
  it("names the model the way the picker does", () => {
    expect(resolveSubagentModelLabel(PROVIDERS, "claude-opus-5")).toBe("Opus 5");
    expect(resolveSubagentModelLabel(PROVIDERS, "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });

  it("falls back to a readable slug for models the catalog does not carry", () => {
    expect(resolveSubagentModelLabel(PROVIDERS, "claude-opus-4-8")).toBe("Opus 4 8");
    expect(resolveSubagentModelLabel(PROVIDERS, "opus")).toBe("Opus");
  });

  it("has nothing to show without a model", () => {
    expect(resolveSubagentModelLabel(PROVIDERS, null)).toBeNull();
    expect(resolveSubagentModelLabel(PROVIDERS, "  ")).toBeNull();
  });
});

describe("formatSubagentModelSlug", () => {
  it("drops the vendor prefix and reads the rest as words", () => {
    expect(formatSubagentModelSlug("claude-fable-5")).toBe("Fable 5");
    expect(formatSubagentModelSlug("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
  });
});
