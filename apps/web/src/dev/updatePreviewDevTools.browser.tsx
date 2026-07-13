import "../index.css";

import type { DesktopBridge, DesktopUpdateState } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { APP_BUILD_CHANNEL_LABEL } from "../branding";
import { SidebarVersionTag } from "../components/sidebar/SidebarVersionTag";
import {
  desktopUpdateQueryKeys,
  setDesktopUpdateStateQueryData,
} from "../lib/desktopUpdateReactQuery";
import {
  DESKTOP_UPDATE_PREVIEW_STORAGE_KEY,
  installUpdatePreviewDevTools,
} from "./updatePreviewDevTools";

let mounted: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  window.localStorage.removeItem(DESKTOP_UPDATE_PREVIEW_STORAGE_KEY);
  delete window.threadlinesUpdatePreview;
  delete window.__threadlinesDesktopUpdatePreviewCheckForUpdate;
  Reflect.deleteProperty(window, "desktopBridge");
  document.body.innerHTML = "";
});

async function installAndMount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  installUpdatePreviewDevTools(queryClient);

  mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ position: "fixed", bottom: 8, left: 8 }}>
        <SidebarVersionTag />
      </div>
    </QueryClientProvider>,
  );
  await page.getByTestId("sidebar-version-chip").hover();
}

it("pins an up-to-date boot preview by default so the updater card renders without a bridge", async () => {
  await installAndMount();

  // The mount fetch resolves null (no bridge) after the pin was applied — the
  // pin must win, or the card would render bridge-less without the action.
  await expect.element(page.getByText(APP_BUILD_CHANNEL_LABEL)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Check now" })).toBeVisible();

  // Releasing via the console API reverts to the real bridge-less card.
  window.threadlinesUpdatePreview?.clearDesktopUpdate();
  await expect.element(page.getByRole("button", { name: "Check now" })).not.toBeInTheDocument();
});

it("re-applies inert boot preview overwrites outside the query notification stack", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  installUpdatePreviewDevTools(queryClient);
  const getState = () =>
    queryClient.getQueryData<DesktopUpdateState | null>(desktopUpdateQueryKeys.state()) ?? null;
  const pinnedState = getState();

  expect(pinnedState?.status).toBe("up-to-date");

  setDesktopUpdateStateQueryData(queryClient, null);

  expect(getState()).toBeNull();
  await new Promise<void>((resolve) => window.queueMicrotask(resolve));
  expect(getState()).toEqual(pinnedState);
});

it("releases the boot preview when a real update check starts", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  installUpdatePreviewDevTools(queryClient);
  const getState = () =>
    queryClient.getQueryData<DesktopUpdateState | null>(desktopUpdateQueryKeys.state()) ?? null;
  const pinnedState = getState();

  setDesktopUpdateStateQueryData(queryClient, {
    ...pinnedState!,
    status: "checking",
    checkedAt: new Date().toISOString(),
  });

  expect(getState()?.status).toBe("checking");
  await new Promise<void>((resolve) => window.queueMicrotask(resolve));
  expect(getState()?.status).toBe("checking");

  setDesktopUpdateStateQueryData(queryClient, null);
  await new Promise<void>((resolve) => window.queueMicrotask(resolve));
  expect(getState()).toBeNull();
});

it("simulates check now while the boot desktop preview is pinned", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  installUpdatePreviewDevTools(queryClient);
  const getState = () =>
    queryClient.getQueryData<DesktopUpdateState | null>(desktopUpdateQueryKeys.state()) ?? null;

  const resultPromise = window.__threadlinesDesktopUpdatePreviewCheckForUpdate?.();

  expect(resultPromise).toBeDefined();
  expect(getState()?.status).toBe("checking");

  const result = await resultPromise!;
  expect(result).not.toBeNull();
  expect(result!.checked).toBe(true);
  expect(result!.state.status).toBe("up-to-date");
  expect(getState()?.status).toBe("up-to-date");
});

it("uses the preview check from the sidebar instead of the disabled dev desktop updater", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const realCheckForUpdate = vi.fn().mockResolvedValue({
    checked: false,
    state: {
      enabled: false,
      status: "disabled",
      channel: "latest",
      currentVersion: "0.0.1",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      checkedAt: null,
      message: "Automatic updates are not available in this build.",
      errorContext: null,
      canRetry: false,
    } satisfies DesktopUpdateState,
  });
  window.desktopBridge = {
    getUpdateState: vi.fn().mockResolvedValue(null),
    onUpdateState: vi.fn(() => () => undefined),
    checkForUpdate: realCheckForUpdate,
  } as unknown as DesktopBridge;
  installUpdatePreviewDevTools(queryClient);
  const previewCheckForUpdate = window.__threadlinesDesktopUpdatePreviewCheckForUpdate;
  expect(previewCheckForUpdate).toBeDefined();
  const previewCheckForUpdateSpy = vi.fn(previewCheckForUpdate!);
  window.__threadlinesDesktopUpdatePreviewCheckForUpdate = previewCheckForUpdateSpy;

  mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ position: "fixed", bottom: 8, left: 8 }}>
        <SidebarVersionTag />
      </div>
    </QueryClientProvider>,
  );

  await page.getByTestId("sidebar-version-chip").click();
  await page.getByRole("button", { name: "Check now" }).click();

  expect(previewCheckForUpdateSpy).toHaveBeenCalledTimes(1);
  expect(realCheckForUpdate).not.toHaveBeenCalled();
  await new Promise((resolve) => window.setTimeout(resolve, 1_300));
  await expect
    .element(page.getByText("Automatic updates are not available in this build."))
    .not.toBeInTheDocument();
});

it("boots into the mode picked via localStorage", async () => {
  window.localStorage.setItem(DESKTOP_UPDATE_PREVIEW_STORAGE_KEY, "downloaded");
  await installAndMount();

  const card = page.getByTestId("sidebar-version-card");
  await expect.element(card.getByText(/downloaded/)).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Restart to install" })).toBeVisible();
});

it("skips the boot preview when set to off", async () => {
  window.localStorage.setItem(DESKTOP_UPDATE_PREVIEW_STORAGE_KEY, "off");
  await installAndMount();

  await expect.element(page.getByTestId("sidebar-version-card")).toBeVisible();
  await expect.element(page.getByText(/Stable track/)).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Check now" })).not.toBeInTheDocument();
});
