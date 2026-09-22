import "../../index.css";

import {
  type DictationStatus,
  type EnvironmentApi,
  EnvironmentId,
  type LocalApi,
} from "@threadlines/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { __resetDictationStatusForTests } from "../../dictation/dictationStatusStore";
import type { DictationControl } from "../../dictation/useDictation";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";
import { updateSettings } from "../../hooks/useSettings";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests } from "../../rpc/serverState";
import { ComposerDictationControl } from "./ComposerDictationControl";

const ENVIRONMENT_ID = EnvironmentId.make("environment-dictation-control");

const PARAKEET_BYTES = 661_190_513;
const MOONSHINE_BYTES = 123_967_539;

function makeStatus(parakeetState: DictationStatus["models"][number]["state"]): DictationStatus {
  return {
    runtime: { supported: true, state: "ready", bytesDownloaded: 0, bytesTotal: 0, error: null },
    models: [
      {
        id: "parakeet",
        state: parakeetState,
        bytesDownloaded: parakeetState === "ready" ? PARAKEET_BYTES : 0,
        bytesTotal: PARAKEET_BYTES,
        error: null,
      },
      {
        id: "moonshine",
        state: "missing",
        bytesDownloaded: 0,
        bytesTotal: MOONSHINE_BYTES,
        error: null,
      },
    ],
    engine: "idle",
    loadedModel: null,
    modelsDir: "/home/will/.threadlines/models/speech",
  };
}

const downloadModel = vi.fn(async () => undefined);

function installEnvironmentApi(status: DictationStatus) {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    dictation: {
      subscribeStatus: (callback: (next: DictationStatus) => void) => {
        callback(status);
        return () => undefined;
      },
      downloadModel,
      cancelDownload: async () => undefined,
      removeModel: async () => undefined,
      warmUp: async () => undefined,
      transcribe: async () => ({ text: "" }),
    },
  } as unknown as EnvironmentApi);
}

/** Stands in for `useDictation`, which `ChatComposer` owns in the real app. */
function useFakeDictation(): DictationControl {
  const [status, setStatus] = useState<DictationControl["status"]>("idle");
  return {
    status,
    elapsedMs: 7_000,
    error: null,
    start: () => setStatus("recording"),
    stop: () => setStatus("transcribing"),
    cancel: () => setStatus("idle"),
    clearError: () => undefined,
  };
}

function Harness({ disabled = false }: { disabled?: boolean }) {
  const dictation = useFakeDictation();
  return (
    <ComposerDictationControl
      environmentId={ENVIRONMENT_ID}
      disabled={disabled}
      disabledReason={disabled ? "Answer the question first" : null}
      isMobileViewport={false}
      dictation={dictation}
    />
  );
}

function renderInApp(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
}

describe("ComposerDictationControl", () => {
  beforeEach(async () => {
    resetServerStateForTests();
    resetAppAtomRegistryForTests();
    __resetDictationStatusForTests();
    downloadModel.mockClear();
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as LocalApi;
    await __resetLocalApiForTests();
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    __resetDictationStatusForTests();
    Reflect.deleteProperty(window, "nativeApi");
    await __resetLocalApiForTests();
    resetServerStateForTests();
    document.body.innerHTML = "";
  });

  it("offers the mic and its options once the model is on the server", async () => {
    installEnvironmentApi(makeStatus("ready"));
    const mounted = await renderInApp(<Harness />);

    await expect
      .element(page.getByRole("button", { name: "Dictate" }), { timeout: 5_000 })
      .toBeVisible();
    await page.getByRole("button", { name: "Dictation options" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Default" }), { timeout: 5_000 })
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: /Hold to record/ }), { timeout: 5_000 })
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Dictation settings" }), { timeout: 5_000 })
      .toBeVisible();
    await mounted.unmount();
  });

  it("records on click and offers a stop square when hold-to-record is off", async () => {
    installEnvironmentApi(makeStatus("ready"));
    updateSettings({ dictationHoldToRecord: false });
    const mounted = await renderInApp(<Harness />);

    await page.getByRole("button", { name: "Dictate" }).click();

    const stop = page.getByRole("button", { name: "Stop recording" });
    await expect.element(stop, { timeout: 5_000 }).toBeVisible();
    await expect.element(page.getByText("0:07"), { timeout: 5_000 }).toBeVisible();

    await stop.click();
    await expect.element(page.getByText("Transcribing…"), { timeout: 5_000 }).toBeVisible();
    await mounted.unmount();
    updateSettings({ dictationHoldToRecord: true });
  });

  it("asks to download the selected model instead of recording when it is missing", async () => {
    installEnvironmentApi(makeStatus("missing"));
    const mounted = await renderInApp(<Harness />);

    await page.getByRole("button", { name: "Dictate" }).click();

    await expect.element(page.getByText("Set up dictation"), { timeout: 5_000 }).toBeVisible();
    const download = page.getByRole("button", { name: "Download Parakeet · 631 MB" });
    await expect.element(download, { timeout: 5_000 }).toBeVisible();

    await download.click();
    await vi.waitFor(() => expect(downloadModel).toHaveBeenCalledWith({ model: "parakeet" }), {
      timeout: 5_000,
    });
    await mounted.unmount();
  });

  it("explains why the mic is off when the composer is blocked", async () => {
    installEnvironmentApi(makeStatus("ready"));
    const mounted = await renderInApp(<Harness disabled />);

    // The tooltip itself cannot open: a disabled button takes no pointer
    // events, so the inert control and its reason are what there is to assert.
    await expect
      .element(page.getByRole("button", { name: "Dictate" }), { timeout: 5_000 })
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Dictation options" }), { timeout: 5_000 })
      .toBeDisabled();
    await mounted.unmount();
  });
});
