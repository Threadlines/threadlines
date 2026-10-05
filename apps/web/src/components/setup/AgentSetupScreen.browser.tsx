import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useSearch,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import { ToastProvider } from "../ui/toast";
import { parseSetupStep } from "./agentSetup.logic";
import { AgentSetupScreen } from "./AgentSetupScreen";
import { SETUP_PROGRESS_STORAGE_KEY, useSetupProgressStore } from "./setupProgress";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function serverConfig(providers: ReadonlyArray<ServerProvider>): ServerConfig {
  return {
    environment: {
      environmentId: ENVIRONMENT_ID,
      label: "Test Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "threadlines_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.threadlines/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [...providers],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.threadlines/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

/** A computer that has loaded and never been used: a first run. */
function seedFreshComputer() {
  useStore.setState({
    activeEnvironmentId: ENVIRONMENT_ID,
    environmentStateById: {
      [ENVIRONMENT_ID]: {
        projectIds: [],
        projectById: {},
        threadIds: [],
        threadIdsByProjectId: {},
        threadShellById: {},
        threadSessionById: {},
        threadTurnStateById: {},
        messageIdsByThreadId: {},
        messageByThreadId: {},
        activityIdsByThreadId: {},
        activityByThreadId: {},
        proposedPlanIdsByThreadId: {},
        proposedPlanByThreadId: {},
        turnDiffIdsByThreadId: {},
        turnDiffSummaryByThreadId: {},
        agentRequestsByThreadId: {},
        sidebarThreadSummaryById: {},
        bootstrapComplete: true,
      },
    },
  } as never);
}

function SetupRoute() {
  const search = useSearch({ strict: false }) as { step?: unknown };
  return <AgentSetupScreen routeStep={parseSetupStep(search.step)} />;
}

function renderSetup() {
  const rootRoute = createRootRoute({
    component: () => (
      <TestProviders>
        <Outlet />
      </TestProviders>
    ),
  });
  const setupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup",
    component: SetupRoute,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <h1>Home</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([setupRoute, indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/setup"] }),
  });
  return {
    router,
    mounted: render(<RouterProvider router={router} />),
  };
}

function TestProviders({ children }: { children: ReactNode }) {
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

describe("AgentSetupScreen", () => {
  let mounted: Awaited<ReturnType<typeof renderSetup>["mounted"]> | null = null;

  beforeEach(async () => {
    localStorage.removeItem(SETUP_PROGRESS_STORAGE_KEY);
    useSetupProgressStore.setState({ byEnvironmentId: {} });
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
    resetServerStateForTests();
    writePrimaryEnvironmentDescriptor(serverConfig([]).environment);
    seedFreshComputer();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    resetPrimaryEnvironmentDescriptorForTests();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} } as never);
    resetServerStateForTests();
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
  });

  it("picks what is on this computer and turns on exactly the picked agents", async () => {
    const updateSettings = vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { updateSettings },
    } as unknown as LocalApi;
    setServerConfigSnapshot(
      serverConfig([
        // Signed in and on: picked.
        provider("codex"),
        // On by default but not installed: left unpicked, and turned off.
        provider("claudeAgent", {
          installed: false,
          status: "error",
          auth: { status: "unknown" },
        }),
        // Off, but the file-only look found it: picked, and turned on.
        provider("cursor", {
          enabled: false,
          installed: false,
          status: "disabled",
          auth: { status: "unknown" },
          detection: { status: "found", path: "/usr/local/bin/cursor-agent" },
        }),
        provider("opencode", {
          enabled: false,
          installed: false,
          status: "disabled",
          auth: { status: "unknown" },
          detection: { status: "notFound" },
        }),
      ]),
    );

    const rendered = renderSetup();
    mounted = await rendered.mounted;

    await expect
      .element(page.getByRole("checkbox", { name: /^Codex: / }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("checkbox", { name: /^Cursor: On this Mac/ }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("checkbox", { name: /^Claude: Not installed/ }))
      .toHaveAttribute("aria-checked", "false");
    await expect
      .element(page.getByRole("checkbox", { name: /^OpenCode: Not installed/ }))
      .toHaveAttribute("aria-checked", "false");

    await page.getByTestId("setup-continue").click();

    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0]![0] as {
      providerInstances: Record<string, { enabled?: boolean }>;
    };
    expect(patch.providerInstances.cursor?.enabled).toBe(true);
    expect(patch.providerInstances.claudeAgent?.enabled).toBe(false);
    expect(patch.providerInstances.codex).toBeUndefined();

    // Cursor still needs its check and sign-in, so Connect is not skipped,
    // and it lists only what was picked.
    await vi.waitFor(() =>
      expect(rendered.router.state.location.search).toEqual({ step: "connect" }),
    );
    const rows = page.getByTestId("setup-agent-row");
    await expect.element(rows.first()).toHaveAttribute("data-driver-kind", "codex");
    expect(rows.all().map((row) => row.element().getAttribute("data-driver-kind"))).toEqual([
      "codex",
      "cursor",
    ]);
  });

  it("keeps its top bar clear of the window's own buttons", async () => {
    // Setup takes the whole window, outside the sidebar layout, so its bar
    // meets the desktop window's buttons on both sides.
    const root = document.documentElement;
    setServerConfigSnapshot(serverConfig([]));
    // macOS: buttons over the top-left corner. Windows and Linux: buttons on
    // the right, as wide as the system reports (`.wco` computes this).
    root.classList.add("electron", "mac");
    root.style.setProperty("--workspace-controls-right", "150px");
    try {
      const rendered = renderSetup();
      mounted = await rendered.mounted;

      const bar = page.getByTestId("agent-setup").element().querySelector("header")!;
      const wordmark = bar.firstElementChild!.getBoundingClientRect();
      const close = page.getByTestId("setup-later").element().getBoundingClientRect();
      // The three macOS buttons end about 70px in.
      expect(wordmark.left).toBeGreaterThanOrEqual(80);
      expect(close.right).toBeLessThanOrEqual(window.innerWidth - 150);
    } finally {
      root.classList.remove("electron", "mac");
      root.style.removeProperty("--workspace-controls-right");
    }
  });
});
