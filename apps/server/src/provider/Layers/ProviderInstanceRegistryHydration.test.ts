import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
  type ServerSettings,
} from "@threadlines/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("hydrates only maintained built-in providers from default legacy settings", () => {
    const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

    expect(Object.keys(configMap).toSorted()).toEqual(["claudeAgent", "codex"]);
  });

  it("preserves non-default legacy Cursor and OpenCode settings as deprecated instances", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          enabled: true,
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          serverUrl: "http://127.0.0.1:4096",
        },
      },
    };

    const configMap = deriveProviderInstanceConfigMap(settings);

    expect(configMap[ProviderInstanceId.make("cursor")]).toMatchObject({
      driver: ProviderDriverKind.make("cursor"),
      config: { enabled: true },
    });
    expect(configMap[ProviderInstanceId.make("opencode")]).toMatchObject({
      driver: ProviderDriverKind.make("opencode"),
      config: { serverUrl: "http://127.0.0.1:4096" },
    });
  });

  it("does not overwrite explicit provider instance entries with deprecated legacy settings", () => {
    const cursorId = defaultInstanceIdForDriver(ProviderDriverKind.make("cursor"));
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          enabled: true,
        },
      },
      providerInstances: {
        [cursorId]: {
          driver: ProviderDriverKind.make("cursor"),
          displayName: "Explicit Cursor",
          config: { enabled: false },
        },
      },
    };

    const configMap = deriveProviderInstanceConfigMap(settings);

    expect(configMap[cursorId]).toMatchObject({
      displayName: "Explicit Cursor",
      config: { enabled: false },
    });
  });
});
