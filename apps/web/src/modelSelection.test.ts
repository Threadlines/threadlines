import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@threadlines/contracts/settings";
import { describe, expect, it } from "vitest";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveDefaultTextGenerationBackupModelSelectionState,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
  resolveTextGenerationBackupModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<
    | string
    | {
        readonly slug: string;
        readonly isDefault?: boolean;
        readonly isHidden?: boolean;
      }
  >;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((entry) => {
      const slug = typeof entry === "string" ? entry : entry.slug;
      return {
        slug,
        name: slug,
        isCustom: false,
        ...(typeof entry !== "string" && entry.isDefault === true ? { isDefault: true } : {}),
        ...(typeof entry !== "string" && entry.isHidden === true ? { isHidden: true } : {}),
        capabilities: {},
      };
    }),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("deduplicates the official GPT-5.6 alias against the Sol built-in", () => {
    const providers = [
      provider({
        instanceId: "codex",
        models: ["gpt-5.6-sol"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { customModels: ["gpt-5.6"] },
        },
      },
    };
    const codex = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "codex",
    )!;

    expect(getAppModelOptionsForInstance(settings, codex)).toEqual([
      expect.objectContaining({ slug: "gpt-5.6-sol", isCustom: false }),
    ]);
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("omits provider-hidden models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: [{ slug: "claude-opus-4-6", isHidden: true }, "claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).toEqual(["claude-sonnet-4-6"]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("prefers the visible live default when the instance model list is reordered", () => {
    const providers = [
      provider({
        instanceId: "codex",
        models: ["gpt-5.6-terra", { slug: "gpt-5.5", isDefault: true }, "gpt-5.6-sol"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("codex"),
        DEFAULT_UNIFIED_SETTINGS,
        providers,
        null,
      ),
    ).toBe("gpt-5.5");
  });

  it("uses the configured provider default before the first visible model", () => {
    const providers = [
      provider({
        instanceId: "codex",
        models: ["gpt-5.6-terra", "gpt-5.5", "gpt-5.6-sol"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("codex"),
        DEFAULT_UNIFIED_SETTINGS,
        providers,
        undefined,
      ),
    ).toBe("gpt-5.5");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });

  it("resolves the default backup text generation model to a different provider", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: ["gpt-5.4-mini"],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: ["claude-haiku-4-5"],
      }),
    ];
    const primarySelection = resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, providers);

    expect(
      resolveDefaultTextGenerationBackupModelSelectionState(
        DEFAULT_UNIFIED_SETTINGS,
        providers,
        primarySelection,
      ),
    ).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-4-5",
    });
  });

  it("preserves a configured backup text generation instance on a different provider", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: ["gpt-5.4-mini"],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const primarySelection = resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, providers);
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationBackupModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(
      resolveTextGenerationBackupModelSelectionState(settings, providers, primarySelection),
    ).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });

  it("clears backup text generation when only same-provider instances are available", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: ["gpt-5.4-mini"],
      }),
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex_work",
        models: ["gpt-5.4"],
      }),
    ];
    const primarySelection = resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, providers);
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationBackupModelSelection: {
        instanceId: ProviderInstanceId.make("codex_work"),
        model: "gpt-5.4",
      },
    };

    expect(
      resolveTextGenerationBackupModelSelectionState(settings, providers, primarySelection),
    ).toBeNull();
  });
});
