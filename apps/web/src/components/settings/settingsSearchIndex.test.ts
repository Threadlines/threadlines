import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@threadlines/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsPlaceSearchId, SettingsSurface } from "./settingsPlaceAvailability";
import { rankSettingsSearch, settingsSearchItems } from "./settingsSearchIndex";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    auth: { status: "authenticated" },
    checkedAt: new Date(0).toISOString(),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    models: [],
    slashCommands: [],
    skills: [],
    status: "ready",
    version: null,
    ...overrides,
  };
}

const claude = provider({
  displayName: "Claude",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
  ],
  skills: [{ name: "pdf", description: "Read and fill PDF forms.", path: "/s/pdf", enabled: true }],
});
const codex = provider({
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  displayName: "Codex",
  skills: [{ name: "pdf", path: "/c/pdf", enabled: true }],
});

function search(
  text: string,
  options: {
    readonly surface?: SettingsSurface;
    readonly shown?: (id: SettingsPlaceSearchId) => boolean;
  } = {},
) {
  const items = settingsSearchItems({
    surface: options.surface ?? "full",
    shown: options.shown ?? (() => true),
    providers: [claude, codex],
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  });
  return rankSettingsSearch(items, text);
}

const keysOf = (text: string) => search(text).results.map((result) => result.item.key);

describe("settings search", () => {
  it("finds a setting by the words people use for it, and says which", () => {
    const [first] = search("dark mode").results;
    expect(first?.item.key).toBe("general.theme");
    expect(first?.match.keyword).toBe("dark mode");
  });

  it("lists a section's settings before shortcuts that match as well", () => {
    const keys = keysOf("terminal");
    const textSize = keys.indexOf("general.terminalTextSize");
    const firstShortcut = keys.findIndex((key) => key.startsWith("shortcut:"));
    expect(textSize).toBeGreaterThanOrEqual(0);
    expect(firstShortcut).toBeGreaterThan(textSize);
  });

  it("finds a provider by one of its models, and each skill once with who offers it", () => {
    expect(keysOf("opus")).toContain("provider:claudeAgent");
    const skills = search("pdf").results.filter((result) => result.item.type === "skill");
    expect(skills).toHaveLength(1);
    expect(skills[0]?.item.type === "skill" && skills[0].item.providers).toEqual([
      "Claude",
      "Codex",
    ]);
  });

  it("doesn't list a whole page for the page's name", () => {
    const keys = keysOf("threads");
    expect(keys).toContain("settings.threads");
    expect(keys).toContain("threads.agentThreads");
    // Rooms sits on Threads but says nothing about threads itself.
    expect(keys).not.toContain("threads.enableRooms");
  });

  it("counts what each page holds, and leaves out what this screen doesn't show", () => {
    const shown = (id: SettingsPlaceSearchId) => id !== "settings.keybindings";
    const results = search("wrap", { shown }).results;
    expect(results.some((result) => result.item.type === "shortcut")).toBe(false);
    expect(search("wrap", { shown }).countByPage.get("settings.threads")).toBe(3);
  });

  it("files the phone's paired-computer settings under This computer", () => {
    const stream = search("stream replies", { surface: "phone" }).results[0]?.item;
    expect(stream?.type === "place" && stream.shownIn).toBe("general.thisComputer");
  });
});
