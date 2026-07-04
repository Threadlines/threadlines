import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { EnvironmentId } from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@threadlines/contracts/settings";
import { __resetLocalApiForTests } from "../../localApi";
import { CLIENT_SETTINGS_STORAGE_KEY } from "../../clientPersistenceStorage";

// Mock the environments/runtime module to provide a mock primary environment connection
vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        getConfig: vi.fn(),
        updateSettings: vi.fn(),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    environmentUsesRelayTransport: () => false,
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
    ],
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
    ],
  },
];

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

async function mountPicker(props: {
  activeInstanceId?: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  providers?: ReadonlyArray<ServerProvider>;
  settings?: UnifiedSettings;
  triggerVariant?: "ghost" | "outline";
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onInstanceModelChange = vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const instanceEntries = filterMaintainedProviderInstanceEntries(
    sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
  );
  const activeInstanceId = props.activeInstanceId ?? CODEX_INSTANCE_ID;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    props.settings ?? DEFAULT_UNIFIED_SETTINGS,
    providers,
    activeInstanceId,
    props.model,
  );
  const screen = await render(
    <ProviderModelPicker
      activeInstanceId={activeInstanceId}
      model={props.model}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      triggerVariant={props.triggerVariant}
      onInstanceModelChange={onInstanceModelChange}
    />,
    { container: host },
  );

  return {
    onInstanceModelChange,
    // Back-compat alias used by callers that still assert on the old callback
    // name. Delegates to the instance-aware mock so existing expectations work.
    get onProviderModelChange() {
      return onInstanceModelChange;
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function getModelPickerListElement() {
  const modelPickerList = document.querySelector<HTMLElement>(".model-picker-list");
  expect(modelPickerList).not.toBeNull();
  return modelPickerList!;
}

function getModelPickerListText() {
  return getModelPickerListElement().textContent ?? "";
}

function getVisibleModelNames() {
  return Array.from(
    getModelPickerListElement().querySelectorAll<HTMLDivElement>("[data-model-picker-model-name]"),
  )
    .map((element) => element.textContent?.trim() ?? "")
    .filter((text) => text.length > 0);
}

function getModelPickerTabOrder() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-model-picker-tab]")).map(
    (element) => element.dataset.modelPickerTab ?? "",
  );
}

function getModelPickerTabText(tabId: string) {
  const tab = document.querySelector<HTMLElement>(`[data-model-picker-tab="${tabId}"]`);
  expect(tab).not.toBeNull();
  return tab!.textContent?.replace(/\s+/g, "") ?? "";
}

async function openModelPicker() {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-chat-provider-model-picker="true"]',
  );
  expect(trigger).not.toBeNull();
  trigger!.click();

  await vi.waitFor(() => {
    expect(document.querySelector(".model-picker-list")).not.toBeNull();
  });
}

// The search field is collapsed to an icon until the user types or clicks
// the toggle; expand it explicitly so the input is visible and fillable.
async function fillModelPickerSearch(query: string) {
  const toggle = document.querySelector<HTMLButtonElement>("[data-model-picker-search-toggle]");
  expect(toggle).not.toBeNull();
  toggle!.click();

  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Clear search"]')).not.toBeNull();
  });

  await page.getByPlaceholder("Search models...").fill(query);
}

async function clickModelPickerTab(tabId: string) {
  const tab = document.querySelector<HTMLButtonElement>(`[data-model-picker-tab="${tabId}"]`);
  expect(tab).not.toBeNull();
  tab!.click();

  await vi.waitFor(() => {
    expect(tab!.getAttribute("aria-selected")).toBe("true");
  });
}

describe("ProviderModelPicker", () => {
  beforeEach(async () => {
    // Reset test environment before each test
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
  });

  it("selects the active provider tab and switches panes when clicked", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Opus 4.6");
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
        expect(getModelPickerListText()).not.toContain("GPT-5 Codex");
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      await clickModelPickerTab("codex");

      await vi.waitFor(() => {
        expect(getModelPickerListText()).toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects the favorites tab when the active model is favorited", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "claudeAgent", model: "claude-sonnet-4-6" }],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-sonnet-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
        expect(getVisibleModelNames()).toEqual(["Sonnet 4.6"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("hides non-maintained provider snapshots from the sidebar and search", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      ...TEST_PROVIDERS,
      {
        driver: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode"),
        displayName: "OpenCode",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: new Date().toISOString(),
        slashCommands: [],
        skills: [],
        models: [
          {
            slug: "openai/rogue-model",
            name: "Rogue Model",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      await fillModelPickerSearch("rogue");

      await vi.waitFor(() => {
        expect(getModelPickerListText()).not.toContain("Rogue Model");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists provider tabs in configured order with their models", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      await clickModelPickerTab("codex");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("GPT-5 Codex");
        expect(getVisibleModelNames()).not.toContain("Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses client model visibility and ordering preferences", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [CLAUDE_INSTANCE_ID]: {
            hiddenModels: ["claude-opus-4-6"],
            modelOrder: ["claude-haiku-4-5", "claude-sonnet-4-6"],
          },
        },
      },
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Haiku 4.5", "Sonnet 4.6"]);
        expect(getModelPickerListText()).not.toContain("Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the search input when the picker opens", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows locked provider header and only its models in locked mode", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex" },
          { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        ],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        // Should show locked provider label
        expect(text).toContain("Claude");
        expect(getVisibleModelNames()).toEqual(["Sonnet 4.6", "Opus 4.6", "Haiku 4.5"]);
      });
    } finally {
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
      await mounted.cleanup();
    }
  });

  it("shows instance tabs in locked mode when that provider has multiple instances", async () => {
    const defaultCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-work",
        name: "GPT Work",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const personalCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-personal",
        name: "GPT Personal",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const isolatedCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-isolated",
        name: "GPT Isolated",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const providers: ReadonlyArray<ServerProvider> = [
      {
        ...buildCodexProvider(defaultCodexModels),
        instanceId: "codex" as ProviderInstanceId,
        displayName: "Codex Work",
        accentColor: "#00347D",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(personalCodexModels),
        instanceId: "codex_personal" as ProviderInstanceId,
        displayName: "Codex Personal",
        accentColor: "#dc2626",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(isolatedCodexModels),
        instanceId: "codex_isolated" as ProviderInstanceId,
        displayName: "Codex Isolated",
        accentColor: "#16a34a",
        continuation: { groupKey: "codex:home:/Users/julius/.codex_isolated" },
      },
      TEST_PROVIDERS[1]!,
    ];
    const mounted = await mountPicker({
      activeInstanceId: "codex" as ProviderInstanceId,
      model: "gpt-work",
      lockedProvider: ProviderDriverKind.make("codex"),
      lockedContinuationGroupKey: "codex:home:/Users/julius/.codex",
      providers,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["codex", "codex_personal"]);
        expect(getModelPickerTabText("codex")).toContain("CodexWork");
        expect(getModelPickerTabText("codex_personal")).toContain("CodexPersonal");
        expect(getVisibleModelNames()).toEqual(["GPT Work"]);
      });

      await clickModelPickerTab("codex_personal");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["GPT Personal"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the active provider's first model when props.model belongs to another provider (#1982)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onInstanceModelChange = vi.fn();
    const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
      [
        "claudeAgent" as ProviderInstanceId,
        [
          { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      ],
      ["codex" as ProviderInstanceId, [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }]],
    ]);
    const instanceEntries = sortProviderInstanceEntries(
      deriveProviderInstanceEntries(TEST_PROVIDERS),
    );
    const screen = await render(
      <ProviderModelPicker
        activeInstanceId={"claudeAgent" as ProviderInstanceId}
        model="gpt-5-codex"
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        onInstanceModelChange={onInstanceModelChange}
      />,
      { container: host },
    );

    try {
      const trigger = document.querySelector<HTMLElement>(
        '[data-chat-provider-model-picker="true"]',
      );
      expect(trigger).not.toBeNull();
      const label = trigger?.textContent ?? "";
      expect(label).not.toContain("gpt-5-codex");
      expect(label).toContain("Opus 4.6");
      expect(label).not.toContain("Claude Opus 4.6");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("uses the trigger label for locked provider rows with sub-provider labels", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-5-enterprise",
            name: "Claude Opus 4.5",
            subProvider: "Enterprise",
            shortName: "Opus 4.5",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                ]),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-5-enterprise",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      providers,
    });

    try {
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        expect(trigger?.textContent).toContain("Enterprise");
        expect(trigger?.textContent).toContain("Opus 4.5");
      });

      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Enterprise · Opus 4.5"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by name across all providers", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Opus 4.6");
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
        expect(getModelPickerListText()).not.toContain("GPT-5 Codex");
      });

      await fillModelPickerSearch("claude");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Opus 4.6");
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
        expect(getModelPickerListText()).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports arrow-key navigation in the model picker", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await openModelPicker();

      // The collapsed search input is focused on open, so keyboard nav
      // works without clicking into it.
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Opus 4.6");
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Sonnet 4.6");
      });
      await userEvent.keyboard("{Enter}");

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("replaces the tab strip with global grouped results while searching", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      await fillModelPickerSearch("cla");

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual([]);
        expect(getVisibleModelNames()).toEqual(
          expect.arrayContaining(["Opus 4.6", "Sonnet 4.6", "Haiku 4.5"]),
        );
        // Matches render under a provider section header.
        expect(getModelPickerListText()).toContain("Claude");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("finds matches from other providers than the active tab while searching", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();
      await fillModelPickerSearch("gpt");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["GPT-5 Codex", "GPT-5.3 Codex"]);
        expect(getModelPickerListText()).not.toContain("Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("expands the collapsed search when the user starts typing", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      // The hidden search input holds focus, so typing anywhere in the
      // picker feeds the query and expands the field.
      await userEvent.keyboard("gpt");

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual([]);
        expect(document.querySelector('button[aria-label="Clear search"]')).not.toBeNull();
        expect(getVisibleModelNames()).toEqual(["GPT-5 Codex", "GPT-5.3 Codex"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a favorited match once in global search results", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "claudeAgent", model: "claude-opus-4-6" }],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();
      await fillModelPickerSearch("opus");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Opus 4.6"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("closes the picker when escape is pressed in search", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      const searchInputElement = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search models..."]',
      );
      expect(searchInputElement).not.toBeNull();
      searchInputElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears an active search on escape before closing the picker", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();
      await fillModelPickerSearch("gpt");

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()).toEqual([]);
      });

      const getSearchInputElement = () => {
        const element = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(element).not.toBeNull();
        return element!;
      };
      getSearchInputElement().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      // First escape collapses the search back to browsing.
      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(getModelPickerTabOrder()).toEqual(["favorites", "codex", "claudeAgent"]);
      });

      getSearchInputElement().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by provider name", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CODEX_INSTANCE_ID,
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        expect(text).not.toContain("Claude Opus 4.6");
      });

      await fillModelPickerSearch("codex");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("matches fuzzy multi-token queries across provider and model text", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5-codex",
          name: "GPT-5 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-7-enterprise",
            name: "Claude Opus 4.7",
            subProvider: "Enterprise",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                ]),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-7-enterprise",
      lockedProvider: null,
      providers,
    });

    try {
      await openModelPicker();
      await fillModelPickerSearch("entr op");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("Enterprise · Opus 4.7");
        expect(listText).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders favorite tab rows with their own provider branding", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-team-model" },
          { provider: "claudeAgent", model: "claude-opus-4-6" },
        ],
      }),
    );
    const providers: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-team-model",
          name: "Team Model",
          subProvider: "Team",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Claude Model",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                  { id: "max", label: "max" },
                ]),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: CODEX_INSTANCE_ID,
      model: "gpt-team-model",
      lockedProvider: null,
      providers,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(getVisibleModelNames()).toEqual(["Team · Team Model", "Model"]);
        expect(listText).toContain("Codex · Team");
        expect(listText).toContain("Claude");
        expect(listText).not.toContain("Claude Model");
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("toggles favorite stars when clicked", async () => {
    localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Opus 4.6");
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
      });

      const getFirstStarButton = () => {
        const starButton = document.querySelector<HTMLButtonElement>(
          'button[aria-label*="favorites"]',
        );
        expect(starButton).not.toBeNull();
        return starButton!;
      };

      const firstStar = getFirstStarButton();
      const initialAriaLabel = firstStar.getAttribute("aria-label");
      expect(
        initialAriaLabel === "Add to favorites" || initialAriaLabel === "Remove from favorites",
      ).toBe(true);

      await page.getByRole("button", { name: initialAriaLabel! }).first().click();

      const expectedAriaLabel =
        initialAriaLabel === "Add to favorites" ? "Remove from favorites" : "Add to favorites";

      await vi.waitFor(() => {
        expect(getFirstStarButton().getAttribute("aria-label")).toBe(expectedAriaLabel);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("does not duplicate favorited models within the active tab", async () => {
    localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Opus 4.6");
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
      });

      const favoriteButton = page.getByRole("button", {
        name: "Add to favorites",
      });
      await favoriteButton.first().click();

      await vi.waitFor(async () => {
        const favoritedModelRows = Array.from(
          getModelPickerListElement().querySelectorAll<HTMLDivElement>(
            "[data-model-picker-model-name]",
          ),
        ).filter((element) => element.textContent?.trim() === "Opus 4.6");
        expect(favoritedModelRows.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("opens the favorites tab for a favorited active model", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );

    const mounted = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getModelPickerTabOrder()[0]).toBe("favorites");
        expect(getVisibleModelNames()).toEqual(["GPT-5.3 Codex"]);
      });

      await clickModelPickerTab("codex");

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["GPT-5 Codex", "GPT-5.3 Codex"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("keeps favorited provider rows visible with a filled star", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "claudeAgent", model: "claude-opus-4-6" }],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();
      await clickModelPickerTab("claudeAgent");

      await vi.waitFor(() => {
        const favoriteButton = getModelPickerListElement().querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from favorites"]',
        );
        expect(favoriteButton).not.toBeNull();
        expect(getComputedStyle(favoriteButton!).opacity).toBe("1");
        expect(favoriteButton!.querySelector("svg")?.classList.contains("fill-current")).toBe(true);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    }
  });

  it("marks the selected model with a check indicator instead of a filled row", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const selectedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-selected]',
        );
        expect(selectedItem).not.toBeNull();
        expect(selectedItem?.textContent).toContain("Opus 4.6");
        // The check indicator is the selection marker.
        expect(selectedItem?.querySelector("svg.lucide-check")).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches callback with correct provider and model when selected", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toContain("Sonnet 4.6");
      });

      // Click on a model
      const modelRow = page.getByText("Sonnet 4.6").first();
      await modelRow.click();

      // Verify callback was called with correct values
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("hides disabled providers' models from the list", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.instanceId === ProviderInstanceId.make("claudeAgent"),
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }

    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await openModelPicker();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        // Disabled provider should not have its models shown
        expect(text).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected picker trigger button to be rendered.");
      }
      expect(button.className).toContain("border-input");
      expect(button.className).toContain("bg-popover");
    } finally {
      await mounted.cleanup();
    }
  });
});
