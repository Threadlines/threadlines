import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type DictationStatus,
  type EnvironmentApi,
  EnvironmentId,
  type LocalApi,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { __resetDictationStatusForTests } from "../../dictation/dictationStatusStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests } from "../../rpc/serverState";
import { DictationSettings } from "./DictationSettings";

const ENVIRONMENT_ID = EnvironmentId.make("environment-dictation-settings");

const STATUS: DictationStatus = {
  runtime: { supported: true, state: "ready", bytesDownloaded: 0, bytesTotal: 0, error: null },
  models: [
    {
      id: "parakeet",
      state: "missing",
      bytesDownloaded: 0,
      bytesTotal: 661_190_513,
      error: null,
    },
    {
      id: "moonshine",
      state: "missing",
      bytesDownloaded: 0,
      bytesTotal: 123_967_539,
      error: null,
    },
  ],
  engine: "idle",
  loadedModel: null,
  modelsDir: "/home/will/.threadlines/models/speech",
};

const downloadModel = vi.fn(async () => undefined);
const updateServerSettings = vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS);
const setClientSettings = vi.fn().mockResolvedValue(undefined);

describe("DictationSettings", () => {
  beforeEach(async () => {
    resetServerStateForTests();
    resetAppAtomRegistryForTests();
    __resetDictationStatusForTests();
    downloadModel.mockClear();
    updateServerSettings.mockClear();
    setClientSettings.mockClear();
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings,
      },
      server: { updateSettings: updateServerSettings },
    } as unknown as LocalApi;
    await __resetLocalApiForTests();
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_ID,
      label: "This computer",
    } as never);
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      dictation: {
        subscribeStatus: (callback: (next: DictationStatus) => void) => {
          callback(STATUS);
          return () => undefined;
        },
        downloadModel,
        cancelDownload: async () => undefined,
        removeModel: async () => undefined,
        warmUp: async () => undefined,
        transcribe: async () => ({ text: "" }),
      },
    } as unknown as EnvironmentApi);
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    __resetDictationStatusForTests();
    writePrimaryEnvironmentDescriptor(null);
    Reflect.deleteProperty(window, "nativeApi");
    await __resetLocalApiForTests();
    resetServerStateForTests();
    document.body.innerHTML = "";
  });

  it("picks a model, starts its download, and flips hold to record", async () => {
    const mounted = await render(
      <AppAtomRegistryProvider>
        <DictationSettings />
      </AppAtomRegistryProvider>,
    );

    const moonshine = page.getByRole("radio", { name: "Moonshine" });
    await expect.element(moonshine, { timeout: 5_000 }).toBeVisible();
    await moonshine.click();
    await vi.waitFor(
      () => expect(updateServerSettings).toHaveBeenCalledWith({ dictationModel: "moonshine" }),
      { timeout: 5_000 },
    );

    await page.getByRole("button", { name: "Download" }).first().click();
    await vi.waitFor(() => expect(downloadModel).toHaveBeenCalledWith({ model: "parakeet" }), {
      timeout: 5_000,
    });

    const holdSwitch = page.getByRole("switch", { name: "Hold the mic button to record" });
    await expect.element(holdSwitch, { timeout: 5_000 }).toHaveAttribute("aria-checked", "true");
    await holdSwitch.click();
    await vi.waitFor(
      () =>
        expect(setClientSettings).toHaveBeenCalledWith(
          expect.objectContaining({ dictationHoldToRecord: false }),
        ),
      { timeout: 5_000 },
    );
    await mounted.unmount();
  });
});
