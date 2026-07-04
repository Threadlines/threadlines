import "../../index.css";

import type { DesktopBridge, DesktopUpdateState } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { APP_VERSION } from "../../branding";
import { SidebarVersionTag } from "./SidebarVersionTag";

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

function stubDesktopBridge(overrides?: Partial<DesktopBridge>): DesktopBridge {
  const bridge = {
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    onUpdateState: vi.fn(() => () => {}),
    checkForUpdate: vi.fn().mockResolvedValue({
      checked: true,
      state: {
        ...idleUpdateState,
        status: "up-to-date",
        checkedAt: new Date().toISOString(),
      },
    }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    ...overrides,
  } as unknown as DesktopBridge;
  window.desktopBridge = bridge;
  return bridge;
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountTag() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mounted = await render(
    <QueryClientProvider client={queryClient}>
      {/* Decoy target so tests can move the pointer clearly off the tag. */}
      <button style={{ position: "fixed", top: 0, left: 0 }} type="button">
        elsewhere
      </button>
      <div style={{ position: "fixed", bottom: 8, left: 8 }}>
        <SidebarVersionTag />
      </div>
    </QueryClientProvider>,
  );
  return mounted;
}

function versionChip() {
  return page.getByTestId("sidebar-version-chip");
}

function versionCard() {
  return page.getByTestId("sidebar-version-card");
}

function checkNowAction() {
  return page.getByRole("button", { name: "Check now" });
}

describe("SidebarVersionTag", () => {
  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it("reveals the build card on hover and hides it again on hover-out", async () => {
    stubDesktopBridge();
    await mountTag();

    await versionChip().hover();
    await expect.element(versionCard()).toBeVisible();
    await expect.element(checkNowAction()).toBeVisible();

    await page.getByRole("button", { name: "elsewhere" }).hover();
    await expect.element(versionCard()).not.toBeInTheDocument();
  });

  it("pins the card open on click so the update check can run", async () => {
    const bridge = stubDesktopBridge();
    await mountTag();

    await versionChip().click();
    await expect.element(checkNowAction()).toBeVisible();

    // Pointer leaves the trigger — a click-opened popover must stay put.
    await userEvent.unhover(versionChip());
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect.element(checkNowAction()).toBeVisible();

    await checkNowAction().click();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText(/Checked just now/)).toBeVisible();
  });

  it("omits updater controls when no desktop bridge is present", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    await mountTag();

    await versionChip().hover();
    await expect.element(versionCard()).toBeVisible();
    // Scoped to the card: with a plain x.y.z version (e.g. tag-less CI
    // checkouts) the chip's compact label renders the identical string.
    await expect.element(versionCard().getByText(`v${APP_VERSION}`)).toBeVisible();
    await expect.element(checkNowAction()).not.toBeInTheDocument();
  });

  it("explains disabled updaters without offering the update action", async () => {
    stubDesktopBridge({
      getUpdateState: vi
        .fn()
        .mockResolvedValue({ ...idleUpdateState, enabled: false, status: "disabled" }),
    } as unknown as Partial<DesktopBridge>);
    await mountTag();

    await versionChip().hover();
    await expect.element(page.getByText("Updates unavailable in this build")).toBeVisible();
    await expect.element(checkNowAction()).not.toBeInTheDocument();
    await expect.element(page.getByText(/track/)).not.toBeInTheDocument();
  });
});
