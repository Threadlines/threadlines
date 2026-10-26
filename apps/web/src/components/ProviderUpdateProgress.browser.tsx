import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@threadlines/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { endProviderUpdateRun } from "../providerUpdateRunStore";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { setServerConfigSnapshot } from "../rpc/serverState";
import { ProviderUpdateProgress } from "./ProviderUpdateProgress";
import { ToastProvider, toastManager } from "./ui/toast";

function serverConfig(updateState: ServerProvider["updateState"], version = "1.0.0"): ServerConfig {
  const codex: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-23T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: version,
      latestVersion: "1.1.0",
      message: null,
      checkedAt: "2026-10-23T10:00:00.000Z",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      installCommand: null,
      canInstall: false,
    },
    ...(updateState ? { updateState } : {}),
  };
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
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
    providers: [codex],
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

const running = {
  status: "running" as const,
  startedAt: "2026-10-23T10:01:00.000Z",
  finishedAt: null,
  message: null,
  output: null,
};

async function mountProgress() {
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <ProviderUpdateProgress />
        <Outlet />
      </ToastProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>conversation</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
}

const noticeTitles = () =>
  Array.from(document.querySelectorAll("[data-slot='toast-title']"), (el) => el.textContent);

describe("ProviderUpdateProgress", () => {
  afterEach(() => {
    toastManager.close();
    endProviderUpdateRun();
    resetAppAtomRegistryForTests();
    document.body.innerHTML = "";
  });

  it("reports an update however it started, and ends it in the same notice", async () => {
    setServerConfigSnapshot(serverConfig(running));
    const mounted = await mountProgress();

    try {
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Updating Codex"]));
      const notice = document.querySelector("[data-slot='toast-title']")!.closest("[data-type]");

      setServerConfigSnapshot(
        serverConfig(
          { ...running, status: "succeeded", finishedAt: "2026-10-23T10:02:00.000Z" },
          "1.1.0",
        ),
      );
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Codex updated to v1.1.0"]));
      expect(document.querySelector("[data-slot='toast-title']")!.closest("[data-type]")).toBe(
        notice,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("brings a failure back after its notice was closed mid-run", async () => {
    setServerConfigSnapshot(serverConfig(running));
    const mounted = await mountProgress();

    try {
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Updating Codex"]));
      document.querySelector<HTMLButtonElement>("[data-slot='toast-close']")!.click();
      await vi.waitFor(() => expect(noticeTitles()).toEqual([]));

      setServerConfigSnapshot(
        serverConfig({
          ...running,
          status: "failed",
          finishedAt: "2026-10-23T10:02:00.000Z",
          message: "npm ERR! EACCES: permission denied",
        }),
      );
      await vi.waitFor(() => expect(noticeTitles()).toEqual(["Couldn't update Codex"]));
      expect(document.body.textContent).toContain("npm ERR! EACCES: permission denied");
      expect(document.querySelector("[data-slot='toast-action']")?.textContent).toBe("Settings");
    } finally {
      await mounted.unmount();
    }
  });
});
