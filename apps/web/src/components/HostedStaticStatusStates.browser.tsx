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
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { HostedStaticOnboardingState } from "./HostedStaticStatusStates";
import { SidebarProvider } from "./ui/sidebar";

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
  it("offers a download and a route to pairing instead of dead-ending", async () => {
    renderWithTestRouter(<HostedStaticOnboardingState />);

    await expect
      .element(page.getByRole("link", { name: "Download the desktop app" }))
      .toHaveAttribute("href", "https://threadlines.dev/download");
    await expect
      .element(page.getByRole("link", { name: "Pair this browser" }))
      .toHaveAttribute("href", "/settings/connections");
  });
});
