import "../../index.css";

import type { DesktopBridge, DesktopUpdateState } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
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
    await expect.element(page.getByText(`${APP_STAGE_LABEL} build · Stable updates`)).toBeVisible();
    await expect.element(checkNowAction()).toBeVisible();

    await page.getByRole("button", { name: "elsewhere" }).hover();
    await expect.element(versionCard()).not.toBeInTheDocument();
  });

  it("labels the build stage separately from the nightly update track", async () => {
    stubDesktopBridge({
      getUpdateState: vi.fn().mockResolvedValue({ ...idleUpdateState, channel: "nightly" }),
    });
    await mountTag();

    await versionChip().hover();
    await expect
      .element(page.getByText(`${APP_STAGE_LABEL} build · Nightly updates`))
      .toBeVisible();
  });

  it("pins a hover-opened card once the update action runs", async () => {
    const bridge = stubDesktopBridge();
    await mountTag();

    // Hover-open only — the trigger is never clicked, so the popover would
    // normally close as soon as the pointer leaves it.
    await versionChip().hover();
    await expect.element(checkNowAction()).toBeVisible();

    await checkNowAction().click();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "elsewhere" }).hover();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect.element(versionCard()).toBeVisible();

    // A real click away still dismisses the pinned card.
    await page.getByRole("button", { name: "elsewhere" }).click();
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

  it("keeps the card footprint stable after a completed update check", async () => {
    const bridge = stubDesktopBridge();
    await mountTag();

    await versionChip().click();
    await expect.element(checkNowAction()).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = versionCard().element().getBoundingClientRect();

    await checkNowAction().click();

    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText(/Checked just now/)).toBeVisible();
    const after = versionCard().element().getBoundingClientRect();
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    expect(Math.round(after.height)).toBe(Math.round(before.height));
  });

  it("keeps the card footprint stable while checking for updates", async () => {
    let updateStateListener: ((state: DesktopUpdateState) => void) | null = null;
    const bridge = stubDesktopBridge({
      onUpdateState: vi.fn((listener: (state: DesktopUpdateState) => void) => {
        updateStateListener = listener;
        return () => {
          updateStateListener = null;
        };
      }),
      checkForUpdate: vi.fn(() => {
        updateStateListener?.({
          ...idleUpdateState,
          status: "checking",
          checkedAt: new Date().toISOString(),
        });
        return new Promise(() => {});
      }),
    } as unknown as Partial<DesktopBridge>);
    await mountTag();

    await versionChip().click();
    await expect.element(checkNowAction()).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = versionCard().element().getBoundingClientRect();

    await checkNowAction().click();

    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText("Checking for updates…")).toBeVisible();
    const after = versionCard().element().getBoundingClientRect();
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    expect(Math.round(after.height)).toBe(Math.round(before.height));
  });

  it("uses compact controls for download, downloading, and restart states", async () => {
    let updateStateListener: ((state: DesktopUpdateState) => void) | null = null;
    stubDesktopBridge({
      getUpdateState: vi.fn().mockResolvedValue({
        ...idleUpdateState,
        status: "available",
        availableVersion: "1.0.1",
      }),
      onUpdateState: vi.fn((listener: (state: DesktopUpdateState) => void) => {
        updateStateListener = listener;
        return () => {
          updateStateListener = null;
        };
      }),
    } as unknown as Partial<DesktopBridge>);
    await mountTag();
    const emitUpdateState = (state: DesktopUpdateState) => {
      if (updateStateListener === null) {
        throw new Error("Desktop update listener was not registered.");
      }
      updateStateListener(state);
    };

    await versionChip().click();
    await expect.element(page.getByRole("button", { name: "Download update" })).toBeVisible();
    await expect.element(page.getByText("Download")).toBeVisible();
    // Let the popup's opening scale transition settle before taking the
    // reference footprint (same guard as the check-flow footprint tests).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const available = versionCard().element().getBoundingClientRect();

    emitUpdateState({
      ...idleUpdateState,
      status: "downloading",
      availableVersion: "1.0.1",
      downloadPercent: 42,
    });
    await expect.element(page.getByText("Downloading v1.0.1 · 42%")).toBeVisible();
    const downloading = versionCard().element().getBoundingClientRect();
    expect(Math.abs(downloading.height - available.height)).toBeLessThanOrEqual(1);

    emitUpdateState({
      ...idleUpdateState,
      status: "downloaded",
      availableVersion: "1.0.1",
      downloadedVersion: "1.0.1",
      downloadPercent: 100,
    });
    await expect
      .element(versionCard().getByRole("button", { name: "Restart to install" }))
      .toBeVisible();
    await expect.element(page.getByText("Restart")).toBeVisible();
    const downloaded = versionCard().element().getBoundingClientRect();
    expect(Math.abs(downloaded.height - available.height)).toBeLessThanOrEqual(1);
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
