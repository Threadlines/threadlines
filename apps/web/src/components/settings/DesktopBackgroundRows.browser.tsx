import "../../index.css";

import type { DesktopBackgroundOptions, DesktopBridge } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DesktopBackgroundRows } from "./DesktopBackgroundRows";
import { SettingsSection } from "./settingsLayout";

/** The desktop app's side: its saved options, and what the page asked to change. */
function installBridge(initial: DesktopBackgroundOptions) {
  let options = initial;
  const setBackgroundOptions = vi.fn(async (patch: Partial<DesktopBackgroundOptions>) => {
    options = { ...options, ...patch };
    return options;
  });
  window.desktopBridge = {
    getBackgroundOptions: async () => options,
    setBackgroundOptions,
  } as unknown as DesktopBridge;
  return { setBackgroundOptions };
}

describe("DesktopBackgroundRows", () => {
  afterEach(() => {
    delete (window as { desktopBridge?: DesktopBridge }).desktopBridge;
    document.body.innerHTML = "";
  });

  it("saves keep-awake to the desktop app, and offers background running only where closing quits", async () => {
    const windows = installBridge({
      keepAwakeForScheduledTasks: false,
      runInBackground: false,
      runInBackgroundSupported: true,
    });
    const screen = await render(
      <SettingsSection title="This computer">
        <DesktopBackgroundRows />
      </SettingsSection>,
    );
    try {
      const keepAwake = page.getByRole("switch", {
        name: "Keep this computer awake for scheduled tasks",
      });
      await expect.element(keepAwake).toBeInTheDocument();
      await expect
        .element(
          page.getByRole("switch", {
            name: "Keep running in the background when the window closes",
          }),
        )
        .toBeInTheDocument();
      await keepAwake.click();
      expect(windows.setBackgroundOptions).toHaveBeenCalledWith({
        keepAwakeForScheduledTasks: true,
      });
      await expect.element(keepAwake).toBeChecked();
    } finally {
      await screen.unmount();
    }

    // macOS always keeps running when the window closes: no such switch.
    installBridge({
      keepAwakeForScheduledTasks: false,
      runInBackground: false,
      runInBackgroundSupported: false,
    });
    const mac = await render(
      <SettingsSection title="This computer">
        <DesktopBackgroundRows />
      </SettingsSection>,
    );
    try {
      await expect
        .element(page.getByRole("switch", { name: "Keep this computer awake for scheduled tasks" }))
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("switch", {
            name: "Keep running in the background when the window closes",
          }),
        )
        .not.toBeInTheDocument();
    } finally {
      await mac.unmount();
    }
  });
});
