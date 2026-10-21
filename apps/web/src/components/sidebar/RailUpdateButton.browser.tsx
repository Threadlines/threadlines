import "../../index.css";

import type { DesktopBridge, DesktopUpdateState } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DesktopUpdateInstallDialog } from "../desktop/DesktopUpdateInstallDialog";
import { RailUpdateButton } from "./RailUpdateButton";

const idleUpdateState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function stubDesktopBridge(state: DesktopUpdateState): DesktopBridge {
  const bridge = {
    getUpdateState: vi.fn().mockResolvedValue(state),
    onUpdateState: vi.fn(() => () => {}),
    checkForUpdate: vi.fn().mockResolvedValue({
      checked: true,
      state: { ...state, status: "up-to-date", checkedAt: new Date().toISOString() },
    }),
    downloadUpdate: vi.fn().mockResolvedValue({ accepted: true, completed: false, state }),
    installUpdate: vi.fn().mockResolvedValue({ accepted: true, completed: false, state }),
  } as unknown as DesktopBridge;
  window.desktopBridge = bridge;
  return bridge;
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ position: "fixed", top: 80, left: 8 }}>
        <RailUpdateButton />
      </div>
      {/* Root-mounted in the app; restarting opens it. */}
      <DesktopUpdateInstallDialog />
    </QueryClientProvider>,
  );
}

const button = () => page.getByTestId("rail-update");
const dot = () => page.getByTestId("rail-update-dot");

describe("RailUpdateButton", () => {
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it("is not shown in a browser, where there is no updater", async () => {
    await mountButton();
    await expect.element(button()).not.toBeInTheDocument();
  });

  it("checks for updates in one click when there is nothing pending", async () => {
    const bridge = stubDesktopBridge(idleUpdateState);
    await mountButton();

    await expect.element(dot()).not.toHaveAttribute("data-tone");
    await button().click();
    await vi.waitFor(() => expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1));
  });

  it("marks an available update and downloads it in one click", async () => {
    const bridge = stubDesktopBridge({
      ...idleUpdateState,
      status: "available",
      availableVersion: "1.0.1",
    });
    await mountButton();

    await expect.element(dot()).toHaveAttribute("data-tone", "progress");
    await button().click();
    await vi.waitFor(() => expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1));
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("asks before restarting into a downloaded update", async () => {
    const bridge = stubDesktopBridge({
      ...idleUpdateState,
      status: "downloaded",
      availableVersion: "1.0.1",
      downloadedVersion: "1.0.1",
    });
    await mountButton();

    await expect.element(dot()).toHaveAttribute("data-tone", "success");
    await button().click();
    // The confirmation comes first; nothing installs until it is accepted.
    await expect.element(page.getByRole("button", { name: "Restart" })).toBeVisible();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Restart" }).click();
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
  });
});
