import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { setPrimaryAccessRemoved } from "../environments/primary";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { WebSocketConnectionSurface } from "./WebSocketConnectionSurface";

function renderSurface() {
  // Deliberately no SidebarProvider: this surface sits outside the app shell in
  // the real tree, so anything it renders must stand on its own.
  const rootRoute = createRootRoute({
    component: () => (
      <AppAtomRegistryProvider>
        <WebSocketConnectionSurface>
          <p>Threads and composer</p>
        </WebSocketConnectionSurface>
      </AppAtomRegistryProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("WebSocketConnectionSurface", () => {
  afterEach(() => {
    setPrimaryAccessRemoved(false);
    document.body.innerHTML = "";
  });

  it("shows the app while this device still has access", async () => {
    renderSurface();

    await expect.element(page.getByText("Threads and composer")).toBeVisible();
  });

  it("replaces the app with a re-pair state once the computer removes this device", async () => {
    renderSurface();
    setPrimaryAccessRemoved(true);

    await expect.element(page.getByText("Access removed")).toBeVisible();
    await expect
      .element(
        page.getByText("This device was disconnected from the computer. Pair again to reconnect."),
      )
      .toBeVisible();
    await expect.element(page.getByText("Threads and composer")).not.toBeInTheDocument();
  });
});
