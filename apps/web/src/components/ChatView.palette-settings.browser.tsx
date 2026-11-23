import { MessageId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createSnapshotForTargetUser,
  DEFAULT_VIEWPORT,
  mountChatView,
  registerChatViewSuiteHooks,
  waitForServerConfigToApply,
} from "./ChatView.browser-harness";

// The palette's Settings source asks what exists exactly as Settings does.
// A browser here; the hosted phone app's Settings for one case, through the
// palette's own answer to "which Settings is this" (the app itself stays a
// browser, since hosted mode changes how it connects). The desktop app's case
// is in ChatView.desktop-window.browser.tsx, which runs as the desktop app.
const setup = vi.hoisted(() => ({ hosted: false }));
vi.mock("../commands/paletteSettingsSurface", () => ({
  paletteSettingsSurface: () => (setup.hosted ? "phone" : "full"),
}));
vi.mock("../lib/gitStatusState", () => ({
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const NARROW_VIEWPORT = { ...DEFAULT_VIEWPORT, width: 390, height: 844 };

async function searchPalette(text: string) {
  // A narrow screen keeps Search in the sheet: open it as its shortcut does.
  useCommandPaletteStore.getState().setOpen(true);
  await page.getByPlaceholder("Search commands, projects, and threads...").fill(text);
  return page.getByTestId("command-palette");
}

describe("ChatView (full app): the palette's Settings source", () => {
  registerChatViewSuiteHooks();

  afterEach(() => {
    setup.hosted = false;
  });

  it("offers Keybindings in a narrow browser", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-settings-narrow" as MessageId,
        targetText: "palette settings narrow",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("keybindings");
      await expect
        .element(palette.getByText("Keybindings", { exact: true }).first())
        .toBeInTheDocument();
      // Not in a browser, which can't take the desktop app's link.
      await page
        .getByPlaceholder("Search commands, projects, and threads...")
        .fill("one-time link");
      await expect
        .element(palette.getByText("One-time link for this network", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("doesn't offer Keybindings in the hosted phone app, where Settings has no such page", async () => {
    setup.hosted = true;
    const mounted = await mountChatView({
      viewport: NARROW_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-palette-settings-phone" as MessageId,
        targetText: "palette settings phone",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("keybindings");
      await expect
        .element(palette.getByText("Keybindings", { exact: true }))
        .not.toBeInTheDocument();
      // The phone's own settings page is there instead.
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("text size");
      await expect.element(palette.getByText("Text size", { exact: true })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
