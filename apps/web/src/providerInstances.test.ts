import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";
import { DRIVER_OPTIONS } from "./components/settings/providerDriverMeta";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  MAINTAINED_PROVIDER_DRIVER_KINDS,
  resolveComposerProviderSelection,
  resolveSelectableProviderInstance,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("filterMaintainedProviderInstanceEntries", () => {
  it("keeps maintained entries (including the ACP providers) and drops the rest", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({ provider: ProviderDriverKind.make("fx"), instanceId: "fx" }),
      provider({ provider: ProviderDriverKind.make("cursor"), instanceId: "cursor" }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
      provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" }),
      provider({ provider: ProviderDriverKind.make("retiredDriver"), instanceId: "retired" }),
    ]);

    expect(
      filterMaintainedProviderInstanceEntries(entries).map((entry) => entry.instanceId),
    ).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
      ProviderInstanceId.make("fx"),
      ProviderInstanceId.make("cursor"),
      ProviderInstanceId.make("opencode"),
      ProviderInstanceId.make("grok"),
    ]);
  });

  it("agrees with the settings client definitions about which drivers are maintained", () => {
    // Community agents are maintained too, with no tile to pick them from.
    expect([...MAINTAINED_PROVIDER_DRIVER_KINDS]).toEqual([
      ...DRIVER_OPTIONS.map((definition) => definition.value),
      ProviderDriverKind.make("acpRegistry"),
    ]);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveComposerProviderSelection", () => {
  const codex = ProviderDriverKind.make("codex");
  const claude = ProviderDriverKind.make("claudeAgent");
  const select = (
    providers: ReadonlyArray<ServerProvider>,
    candidates: ReadonlyArray<string | null>,
    lockedProvider: ProviderDriverKind | null = null,
  ) =>
    resolveComposerProviderSelection({
      entries: deriveProviderInstanceEntries(providers),
      candidates,
      lockedProvider,
      fallbackDriverKind: codex,
    });

  it("moves off a saved instance that is turned off, and the agent goes with it", () => {
    // The thread was made with Codex's default model; Codex is now off.
    const providers = [
      provider({ provider: codex, instanceId: "codex", enabled: false }),
      provider({ provider: claude, instanceId: "claudeAgent" }),
    ];
    expect(select(providers, [null, null, "codex"])).toEqual({
      instanceId: "claudeAgent",
      driverKind: "claudeAgent",
    });
  });

  it("takes the user's pick first, and stays with the same agent when its instance is off", () => {
    const providers = [
      provider({ provider: codex, instanceId: "codex" }),
      provider({ provider: claude, instanceId: "claudeAgent" }),
      provider({ provider: claude, instanceId: "claude_work", enabled: false }),
      provider({ provider: claude, instanceId: "claude_openrouter" }),
    ];
    expect(select(providers, ["claude_openrouter", null, "codex"]).instanceId).toBe(
      "claude_openrouter",
    );
    // Another Claude account stands in, not the first agent that is on.
    expect(select(providers, [null, null, "claude_work"])).toEqual({
      instanceId: "claudeAgent",
      driverKind: "claudeAgent",
    });
  });

  it("keeps a thread bound to one agent on that agent", () => {
    const providers = [
      provider({ provider: claude, instanceId: "claudeAgent" }),
      provider({ provider: codex, instanceId: "codex" }),
    ];
    expect(select(providers, ["claudeAgent", null, "codex"], codex)).toEqual({
      instanceId: "codex",
      driverKind: "codex",
    });
  });
});
