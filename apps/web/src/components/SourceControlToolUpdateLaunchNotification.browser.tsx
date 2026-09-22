import "../index.css";

import {
  EnvironmentId,
  type LocalApi,
  type SourceControlDiscoveryResult,
  type SourceControlSetupState,
  type SourceControlToolUpdateResult,
  type SourceControlToolVersionAdvisory,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { resetSourceControlDiscoveryStateForTests } from "../lib/sourceControlDiscoveryState";
import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { useStore } from "../store";
import { SourceControlToolUpdateLaunchNotification } from "./SourceControlToolUpdateLaunchNotification";
import { ToastProvider } from "./ui/toast";

const ENVIRONMENT_ID = EnvironmentId.make("environment-update-toast");
const IDLE_SETUP: SourceControlSetupState = {
  tools: [],
  githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
};

function discoveryWithGitHubAdvisory(
  advisory: SourceControlToolVersionAdvisory,
): SourceControlDiscoveryResult {
  return {
    versionControlSystems: [],
    sourceControlProviders: [
      {
        kind: "github",
        label: "GitHub",
        executable: "gh",
        status: "available",
        version: Option.some("gh version 2.97.0"),
        installHint: "Install GitHub CLI.",
        detail: Option.none(),
        auth: {
          status: "authenticated",
          account: Option.some("octocat"),
          host: Option.some("github.com"),
          detail: Option.none(),
        },
        versionAdvisory: advisory,
      },
    ],
  };
}

const BEHIND_LATEST = discoveryWithGitHubAdvisory({
  status: "behind_latest",
  severity: "info",
  currentVersion: "2.97.0",
  latestVersion: "2.98.0",
  recommendedVersion: "2.98.0",
  checkedAt: null,
  message: "A newer GitHub CLI version is available for this environment.",
  notificationKey: "github-cli:2.98.0",
  actions: [{ label: "Update now", kind: "runUpdate", target: "github-cli" }],
});

const CURRENT = discoveryWithGitHubAdvisory({
  status: "current",
  severity: "info",
  currentVersion: "2.98.0",
  latestVersion: "2.98.0",
  recommendedVersion: null,
  checkedAt: null,
  message: null,
  notificationKey: null,
  actions: [],
});

function TestAppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AppAtomRegistryProvider>
        <ToastProvider>{children}</ToastProvider>
      </AppAtomRegistryProvider>
    </QueryClientProvider>
  );
}

function renderWithTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => children });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Link to="/settings/general">General settings</Link>,
  });
  const generalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <h1>General</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, generalRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("SourceControlToolUpdateLaunchNotification", () => {
  let mounted: Awaited<ReturnType<typeof renderWithTestRouter>> | null = null;

  beforeEach(async () => {
    localStorage.clear();
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
    resetSourceControlDiscoveryStateForTests();
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_ID,
      label: "Local",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "0.1.0",
      capabilities: { repositoryIdentity: false },
    });
    // No bootstrap yet means first-run setup is not pending, so the prompt may open.
    useStore.setState({ activeEnvironmentId: ENVIRONMENT_ID, environmentStateById: {} } as never);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} } as never);
    resetPrimaryEnvironmentDescriptorForTests();
    resetSourceControlDiscoveryStateForTests();
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
  });

  it("starts outside Settings and keeps progress across pages without opening Source Control", async () => {
    let resolveUpdate!: (result: SourceControlToolUpdateResult) => void;
    const updateSourceControlTool = vi.fn(
      () =>
        new Promise<SourceControlToolUpdateResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    let setup = IDLE_SETUP;
    window.nativeApi = {
      server: {
        discoverSourceControl: async () => BEHIND_LATEST,
        updateSourceControlTool,
        getSourceControlSetup: async () => setup,
      },
    } as unknown as LocalApi;

    mounted = await renderWithTestRouter(
      <TestAppProviders>
        <SourceControlToolUpdateLaunchNotification />
        <Outlet />
      </TestAppProviders>,
    );

    await expect
      .element(page.getByText("GitHub update available"), { timeout: 5_000 })
      .toBeVisible();
    await page.getByRole("button", { name: "Update now" }).click();
    expect(updateSourceControlTool).toHaveBeenCalledWith({ target: "github-cli" });

    // Same toast, now the progress surface: no button, server's phase message.
    await expect.element(page.getByText("Updating GitHub"), { timeout: 5_000 }).toBeVisible();
    await expect
      .element(page.getByText("GitHub update available"), { timeout: 5_000 })
      .not.toBeInTheDocument();
    setup = {
      ...IDLE_SETUP,
      tools: [
        {
          target: "github-cli",
          operation: "update",
          status: "running",
          message:
            "Downloading and installing. Windows may ask for permission after the download finishes.",
        },
      ],
    };
    await expect
      .element(
        page.getByText(
          "Downloading and installing. Windows may ask for permission after the download finishes.",
        ),
        { timeout: 5_000 },
      )
      .toBeVisible();

    await page.getByRole("link", { name: "General settings" }).click();
    await expect.element(page.getByRole("heading", { name: "General" })).toBeVisible();
    setup = {
      ...IDLE_SETUP,
      tools: [
        {
          target: "github-cli",
          operation: "update",
          status: "checking",
          message: "Checking installation.",
        },
      ],
    };
    await expect
      .element(page.getByText("Checking installation."), { timeout: 5_000 })
      .toBeVisible();
    expect(updateSourceControlTool).toHaveBeenCalledTimes(1);

    resolveUpdate({
      target: "github-cli",
      operation: "update",
      status: "succeeded",
      previousVersion: "2.97.0",
      currentVersion: "2.98.0",
      discovery: CURRENT,
    });
    await expect.element(page.getByText("GitHub updated"), { timeout: 5_000 }).toBeVisible();
    await expect.element(page.getByText("2.97.0 to 2.98.0"), { timeout: 5_000 }).toBeVisible();
  });
});
