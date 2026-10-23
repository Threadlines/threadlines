import "../index.css";

import { EnvironmentId } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { receiveServerStall, useComputerStallsStore } from "../environments/stalls/computerStalls";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { ComputerStallNotices } from "./ComputerStallNotices";
import { ToastProvider } from "./ui/toast";

const MAC_MINI = EnvironmentId.make("environment-stall-notices");

async function mount() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <AppAtomRegistryProvider>
          <ToastProvider>
            <ComputerStallNotices />
          </ToastProvider>
        </AppAtomRegistryProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  // The router draws its first route a moment after render returns.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return screen;
}

describe("ComputerStallNotices", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useComputerStallsStore.setState({ byEnvironmentId: {} });
    writePrimaryEnvironmentDescriptor({
      environmentId: MAC_MINI,
      label: "Mac mini",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.8.0",
      capabilities: { repositoryIdentity: true, stallReports: true },
    });
  });

  afterEach(() => {
    resetAppAtomRegistryForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    useComputerStallsStore.setState({ byEnvironmentId: {} });
  });

  it("says once why a computer went quiet, and not again after a reload", async () => {
    const stall = {
      id: "run-1",
      cause: "overloaded" as const,
      durationMs: 12_000,
      agoMs: 1_500,
      load: { average1m: 219, cpuCount: 18 },
    };
    let screen = await mount();
    receiveServerStall(MAC_MINI, stall);
    await expect.element(page.getByText("This computer froze for 12s")).toBeVisible();
    await expect
      .element(page.getByText("Its CPU was overloaded (load 219 on 18 cores)."))
      .toBeVisible();

    // The reconnect after it repeats the same report: no second notice.
    receiveServerStall(MAC_MINI, { ...stall, agoMs: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.body.textContent?.match(/This computer froze for 12s/g)).toHaveLength(1);

    // A reload keeps the report but not the notice.
    await screen.unmount();
    screen = await mount();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.body.textContent ?? "").not.toContain("This computer froze for 12s");
    await screen.unmount();
  });

  it("shows a report that was already there when it mounted", async () => {
    receiveServerStall(MAC_MINI, { id: "run-3", cause: "busy", durationMs: 9_000, agoMs: 2_000 });
    const screen = await mount();
    await expect.element(page.getByText("Threadlines froze for 9s")).toBeVisible();
    await screen.unmount();
  });

  it("says nothing about a freeze that ended long ago", async () => {
    const screen = await mount();
    receiveServerStall(MAC_MINI, {
      id: "run-2",
      cause: "busy",
      durationMs: 8_000,
      agoMs: 11 * 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.body.textContent ?? "").not.toContain("froze");
    await screen.unmount();
  });
});
