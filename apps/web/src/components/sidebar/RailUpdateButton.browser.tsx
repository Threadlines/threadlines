import "../../index.css";

import type { DesktopBridge, DesktopUpdateState } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DesktopUpdateInstallDialog } from "../desktop/DesktopUpdateInstallDialog";
import { describeRailUpdateCard } from "../desktopUpdate.logic";
import { RailUpdateButton } from "./RailUpdateButton";
import { RailUpdateCard } from "./RailUpdateCard";

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
    await button().hover();
    await expect.element(page.getByText("Not checked yet · click to check")).toBeVisible();
    await button().click();
    await vi.waitFor(() => expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1));
    // The card stays up through the click and shows the answer.
    await expect.element(page.getByText("Up to date · checked just now")).toBeVisible();
  });

  it("lands the card's version on the one a check finds", async () => {
    const bridge = stubDesktopBridge(idleUpdateState);
    vi.mocked(bridge.checkForUpdate).mockResolvedValue({
      checked: true,
      state: {
        ...idleUpdateState,
        status: "available",
        availableVersion: "9.8.7",
        checkedAt: new Date().toISOString(),
      },
    });
    await mountButton();

    await button().hover();
    const card = page.getByTestId("rail-update-card");
    await expect.element(card.getByText("Threadlines", { exact: true })).toBeVisible();
    await button().click();
    await expect.element(card.getByText("Update to", { exact: true })).toBeVisible();
    await expect
      .element(card.getByText("Click to download · you have", { exact: false }))
      .toBeVisible();
    // Each digit rolls on and rests on the new version, in the update color.
    const version = page.getByTestId("rail-update-card-version");
    await vi.waitFor(
      () => {
        const digits = [
          ...version.element().querySelectorAll<HTMLElement>(".will-change-transform"),
        ]
          .map(
            (strip) => Math.round(-new DOMMatrix(getComputedStyle(strip).transform).m42 / 16) % 10,
          )
          .join(".");
        expect(digits).toBe("9.8.7");
      },
      { timeout: 4_000 },
    );
    await expect.element(version).toHaveAttribute("data-changed", "");
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

  it("names what a waiting update brings, read from its GitHub release when the card opens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        tag_name: "v1.0.1",
        body: '## Highlights\n\n<!-- threadlines-release-notes {"v":1,"title":"Fleet: your computers work as one","changes":[]} -->',
        html_url: "https://github.com/Threadlines/threadlines/releases/tag/v1.0.1",
        published_at: "2026-10-30T12:00:00Z",
        draft: false,
      }),
    );
    stubDesktopBridge({ ...idleUpdateState, status: "available", availableVersion: "1.0.1" });
    await mountButton();
    await expect.element(dot()).toHaveAttribute("data-tone", "progress");
    expect(fetchSpy).not.toHaveBeenCalled();

    await button().hover();
    await expect
      .element(page.getByTestId("rail-update-card-note"))
      .toHaveTextContent("Fleet: your computers work as one");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/releases/tags/v1.0.1");
    fetchSpy.mockRestore();
  });

  it("rolls its line when what it says changes, and ticks a download's percent in place", async () => {
    const cardFor = (state: Partial<DesktopUpdateState>) =>
      describeRailUpdateCard({
        state: { ...idleUpdateState, ...state },
        appVersion: "1.0.0",
        buildChannel: "Stable",
        checkedAgo: null,
        nowMs: Date.now(),
        runs: true,
      });
    const downloading = (percent: number) =>
      cardFor({ status: "downloading", availableVersion: "1.0.1", downloadPercent: percent });
    mounted = await render(
      <RailUpdateCard card={cardFor({ status: "available", availableVersion: "1.0.1" })} />,
    );
    const lineEntries = () =>
      [
        ...document.querySelectorAll(
          '[data-testid="rail-update-card"] > span > span:last-child > span',
        ),
      ].map((entry) => entry.textContent);

    await mounted.rerender(<RailUpdateCard card={downloading(4)} />);
    // A new kind of line rolls in over the old one.
    expect(lineEntries()).toEqual(["Click to download · you have v1.0.0", "Downloading · 4%"]);
    await vi.waitFor(() => expect(lineEntries()).toEqual(["Downloading · 4%"]));
    await mounted.rerender(<RailUpdateCard card={downloading(8)} />);
    expect(lineEntries()).toEqual(["Downloading · 8%"]);
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
