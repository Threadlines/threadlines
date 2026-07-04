import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarVersionTag } from "../components/sidebar/SidebarVersionTag";
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
  await expect.element(page.getByText(/Stable track/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Check now" })).toBeVisible();

  // Releasing via the console API reverts to the real bridge-less card.
  window.threadlinesUpdatePreview?.clearDesktopUpdate();
  await expect.element(page.getByRole("button", { name: "Check now" })).not.toBeInTheDocument();
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
