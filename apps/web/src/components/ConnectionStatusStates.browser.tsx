import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { HostedStaticOnboardingState } from "./ConnectionStatusStates";
import { SidebarProvider } from "./ui/sidebar";

const DESKTOP_VIEWPORT = { height: 900, width: 1280 };
const PHONE_VIEWPORT = { height: 844, width: 390 };

function renderWithTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => <SidebarProvider>{children}</SidebarProvider>,
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const connectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/connections",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, connectionsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("HostedStaticOnboardingState", () => {
  afterEach(async () => {
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    document.body.innerHTML = "";
  });

  it("offers a download and a route to pairing on a desktop browser", async () => {
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    renderWithTestRouter(<HostedStaticOnboardingState />);

    await expect
      .element(page.getByRole("link", { name: "Download the desktop app" }))
      .toHaveAttribute("href", "https://threadlines.dev/download");
    await expect
      .element(page.getByRole("link", { name: "Pair this browser" }))
      .toHaveAttribute("href", "/settings/connections");
  });

  it("walks a phone through pairing instead of offering it a desktop download", async () => {
    await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
    renderWithTestRouter(<HostedStaticOnboardingState />);

    await expect.element(page.getByText("Pair with your computer")).toBeVisible();
    await expect
      .element(page.getByText("Threadlines runs on your computer; this phone connects to it."))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "threadlines.dev/download" }))
      .toHaveAttribute("href", "https://threadlines.dev/download");
    await expect.element(page.getByText("Settings → Devices → Add device")).toBeVisible();
    await expect
      .element(page.getByText("Scan the QR code it shows with this phone’s camera"))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "I have a setup link" }))
      .toHaveAttribute("href", "/settings/connections");
    await expect
      .element(page.getByRole("link", { name: "Download the desktop app" }))
      .not.toBeInTheDocument();
  });
});
