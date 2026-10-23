import "../index.css";

import { EnvironmentId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  resetSavedEnvironmentRegistryStoreForTests,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { DEFAULT_ALERT_KINDS, usePushAlertsStore } from "./pushAlerts";
import { PushAlertsSettingsSection } from "./PushAlertsSettings";

const MAC = EnvironmentId.make("env-mac");
const PC = EnvironmentId.make("env-pc");

function saveComputer(environmentId: EnvironmentId, label: string, paired: boolean) {
  useSavedEnvironmentRegistryStore.getState().upsert({
    environmentId,
    label,
    wsBaseUrl: "wss://relay.example/ws",
    httpBaseUrl: "https://relay.example",
    createdAt: "2026-10-23T12:00:00.000Z",
    lastConnectedAt: null,
    ...(paired
      ? {
          relay: {
            version: 2 as const,
            relayOrigin: "https://relay.example",
            hostId: `host-${label}`,
            deviceId: `device-${label}`,
          },
        }
      : {}),
  });
}

describe("PushAlertsSettingsSection", () => {
  afterEach(() => {
    resetSavedEnvironmentRegistryStoreForTests();
    usePushAlertsStore.setState({
      enabled: false,
      kinds: DEFAULT_ALERT_KINDS,
      permission: "default",
      statusByEnvironmentId: {},
      busy: false,
      error: null,
    });
    document.body.innerHTML = "";
  });

  it("shows only once a computer is paired through the relay", async () => {
    saveComputer(PC, "Office PC", false);
    const screen = await render(<PushAlertsSettingsSection />);
    try {
      await expect.element(page.getByText("Alerts on this device")).not.toBeInTheDocument();
      saveComputer(MAC, "Studio Mac", true);
      await expect.element(page.getByText("Alerts on this device")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("lists the three alerts and what each computer does once alerts are on", async () => {
    saveComputer(MAC, "Studio Mac", true);
    saveComputer(PC, "Office PC", true);
    usePushAlertsStore.setState({
      enabled: true,
      permission: "granted",
      statusByEnvironmentId: { [MAC]: { state: "on" }, [PC]: { state: "older" } },
    });
    const screen = await render(<PushAlertsSettingsSection />);
    try {
      await expect
        .element(page.getByRole("switch", { name: "Alerts on this device" }))
        .toBeChecked();
      for (const kind of ["Needs you", "Finished", "Failed"]) {
        await expect.element(page.getByRole("switch", { name: `${kind} alerts` })).toBeChecked();
      }
      await expect.element(page.getByText("Sends alerts to this device.")).toBeVisible();
      await expect
        .element(page.getByText("Needs a newer Threadlines to send alerts."))
        .toBeVisible();

      // Only a computer that sends alerts offers a test, and says what came of it.
      await page.getByRole("button", { name: "Send a test" }).click();
      await expect
        .element(page.getByText("That computer isn't connected right now."))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
