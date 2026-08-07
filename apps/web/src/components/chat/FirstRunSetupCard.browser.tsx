import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

/**
 * The sign-in row drives the real server-side auth flow, so the card needs a
 * primary environment. This is the same shape `SettingsPanels.browser` mocks:
 * events reach only the subscribers of the matching instance.
 */
const providerAuthHarness = vi.hoisted(() => {
  type AuthEvent = {
    readonly instanceId: string;
    readonly createdAt: string;
  } & (
    | { readonly type: "command"; readonly flow: string; readonly command: string }
    | { readonly type: "output"; readonly data: string }
    | {
        readonly type: "status";
        readonly status: string;
        readonly exitCode: number | null;
        readonly detail: string | null;
      }
  );

  const listeners = new Set<{
    readonly instanceId: string;
    readonly listener: (event: AuthEvent) => void;
  }>();
  const startCalls: Array<{ instanceId: string; flow: string }> = [];
  const installCalls: Array<{ provider: string; instanceId?: string; action?: string }> = [];

  return {
    startCalls,
    installCalls,
    // The install row calls the same server RPC the Update button uses.
    server: {
      updateProvider: (input: { provider: string; instanceId?: string; action?: string }) => {
        installCalls.push(input);
        return Promise.resolve({ providers: [] });
      },
    },
    reset() {
      listeners.clear();
      startCalls.length = 0;
      installCalls.length = 0;
    },
    emit(event: AuthEvent) {
      for (const entry of listeners) {
        if (entry.instanceId === event.instanceId) {
          entry.listener(event);
        }
      }
    },
    client: {
      start: (input: { instanceId: string; flow: string }) => {
        startCalls.push({ instanceId: input.instanceId, flow: input.flow });
        return Promise.resolve();
      },
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscribe: (input: { instanceId: string }, listener: (event: AuthEvent) => void) => {
        const entry = { instanceId: input.instanceId, listener };
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
        };
      },
    },
  };
});

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    client: { providerAuth: providerAuthHarness.client, server: providerAuthHarness.server },
  } as never;
  const notUsed = () => undefined as never;
  return {
    environmentUsesRelayTransport: () => false,
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    readSavedEnvironmentBearerToken: () => null,
    resetSavedEnvironmentRegistryStoreForTests: notUsed,
    resetSavedEnvironmentRuntimeStoreForTests: notUsed,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    useSavedEnvironmentRegistryStore: (selector: (state: { byId: object }) => unknown) =>
      selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (selector: (state: { byId: object }) => unknown) =>
      selector({ byId: {} }),
    addSavedEnvironment: notUsed,
    connectDesktopSshEnvironment: notUsed,
    disconnectSavedEnvironment: notUsed,
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    markRelaySavedEnvironmentLinkExpired: notUsed,
    readBackendEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: notUsed,
    RELAY_LINK_EXPIRED_MESSAGE: "",
    removeSavedEnvironment: notUsed,
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: notUsed,
    startEnvironmentConnectionService: notUsed,
    subscribeEnvironmentConnections: () => () => {},
  };
});

import { FirstRunSetupCard } from "./FirstRunSetupCard";
import type { FirstRunSetupProvider } from "./firstRunSetup";

function buildProvider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly auth: ServerProvider["auth"];
}): FirstRunSetupProvider {
  const driverKind = ProviderDriverKind.make(input.driver);
  const snapshot: ServerProvider = {
    driver: driverKind,
    instanceId: ProviderInstanceId.make(input.instanceId),
    displayName: input.displayName,
    enabled: true,
    installed: input.installed,
    version: input.version,
    status: input.installed ? "ready" : "error",
    auth: input.auth,
    checkedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
  };
  return {
    instanceId: snapshot.instanceId,
    driverKind,
    displayName: input.displayName,
    enabled: true,
    snapshot,
  };
}

const SIGNED_OUT_CODEX = buildProvider({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  installed: true,
  version: "0.146.1",
  auth: { status: "unauthenticated" },
});

const MISSING_CLAUDE = buildProvider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  installed: false,
  version: null,
  auth: { status: "unknown" },
});

/** Same missing CLI, but the server derived an install command for it. */
function withInstallCapability(
  provider: FirstRunSetupProvider,
  updateState?: ServerProvider["updateState"],
): FirstRunSetupProvider {
  return {
    ...provider,
    snapshot: {
      ...provider.snapshot,
      versionAdvisory: {
        status: "unknown",
        currentVersion: null,
        latestVersion: null,
        updateCommand: null,
        canUpdate: false,
        installCommand: "npm install -g @anthropic-ai/claude-code@latest",
        canInstall: true,
        checkedAt: null,
        message: null,
      },
      ...(updateState ? { updateState } : {}),
    },
  };
}

const SIGNED_IN_CLAUDE = buildProvider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  installed: true,
  version: "2.4.0",
  auth: { status: "authenticated", label: "Claude Max" },
});

/**
 * The install-guide action is a router `Link`, so every case mounts through a
 * throwaway memory router rather than special-casing one test.
 */
function renderCard(props: {
  readonly providers: ReadonlyArray<FirstRunSetupProvider>;
  readonly projectName: string | null;
  readonly onChooseProject?: () => void;
  readonly onSkip?: () => void;
  readonly onStart?: () => void;
}) {
  const rootRoute = createRootRoute({
    component: () => (
      <FirstRunSetupCard
        providers={props.providers}
        projectName={props.projectName}
        projectCwd={props.projectName === null ? null : "C:/code/B-git-project"}
        projectEnvironmentId={null}
        isOnlyWorkspaceProject
        onChooseProject={props.onChooseProject ?? vi.fn()}
        onSkip={props.onSkip ?? vi.fn()}
        onStart={props.onStart ?? vi.fn()}
      />
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const providersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/providers",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, providersRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

function rowStates(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll("[data-testid='first-run-setup-row']")).map((row) => [
      row.getAttribute("data-row-id") ?? "",
      row.getAttribute("data-row-state") ?? "",
    ]),
  );
}

describe("FirstRunSetupCard", () => {
  beforeEach(() => {
    providerAuthHarness.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("gives every provider state its own dot and action, and holds the start button back", async () => {
    const screen = await renderCard({
      providers: [SIGNED_OUT_CODEX, MISSING_CLAUDE],
      projectName: "B-git-project",
    });

    expect(rowStates()).toEqual({
      codex: "needsSignIn",
      claudeAgent: "notInstalled",
      project: "ready",
    });

    const dots = Array.from(document.querySelectorAll("[data-testid='first-run-setup-dot']"));
    expect(dots.map((dot) => dot.getAttribute("data-row-state"))).toEqual([
      "needsSignIn",
      "notInstalled",
      "ready",
    ]);
    // Amber for a fixable sign-in, red for a missing CLI, green for the folder.
    expect(dots.map((dot) => dot.className)).toEqual([
      expect.stringContaining("bg-warning"),
      expect.stringContaining("bg-destructive"),
      expect.stringContaining("bg-success"),
    ]);

    await expect
      .element(page.getByText("B-git-project · the folder you launched from"))
      .toBeVisible();
    expect(
      document.querySelector<HTMLAnchorElement>('a[href="/settings/providers"]')?.textContent,
    ).toContain("Install guide");

    await expect.element(page.getByRole("button", { name: "Start first thread" })).toBeDisabled();

    await screen.unmount();
  });

  it("runs the sign-in in place and swaps the row action for its live status", async () => {
    const screen = await renderCard({
      providers: [SIGNED_OUT_CODEX],
      projectName: "B-git-project",
    });

    await page.getByRole("button", { name: "Sign in to Codex" }).click();

    await vi.waitFor(() => {
      expect(providerAuthHarness.startCalls).toEqual([{ instanceId: "codex", flow: "login" }]);
    });

    providerAuthHarness.emit({
      instanceId: "codex",
      createdAt: "2026-08-06T00:00:00.000Z",
      type: "command",
      flow: "login",
      command: "codex login",
    });
    providerAuthHarness.emit({
      instanceId: "codex",
      createdAt: "2026-08-06T00:00:00.000Z",
      type: "status",
      status: "running",
      exitCode: null,
      detail: null,
    });
    providerAuthHarness.emit({
      instanceId: "codex",
      createdAt: "2026-08-06T00:00:01.000Z",
      type: "output",
      data: "Opening browser to complete sign-in\r\n",
    });

    await expect
      .element(page.getByText("Signing in… Opening browser to complete sign-in"))
      .toBeVisible();
    // The action is gone while the run owns the row: clicking it again would
    // only restart the flow the user is in the middle of.
    await expect
      .element(page.getByRole("button", { name: "Sign in to Codex" }))
      .not.toBeInTheDocument();

    providerAuthHarness.emit({
      instanceId: "codex",
      createdAt: "2026-08-06T00:00:05.000Z",
      type: "status",
      status: "failed",
      exitCode: 1,
      detail: "The sign-in command exited with code 1.",
    });

    await expect
      .element(page.getByText("Sign-in failed. The sign-in command exited with code 1."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in to Codex" })).toBeVisible();

    await screen.unmount();
  });

  it("installs a missing agent from the row instead of pointing at a guide", async () => {
    const screen = await renderCard({
      providers: [withInstallCapability(MISSING_CLAUDE)],
      projectName: "B-git-project",
    });

    // Never both: an install the row can run replaces the guide link.
    expect(document.querySelector<HTMLAnchorElement>('a[href="/settings/providers"]')).toBeNull();

    await page.getByRole("button", { name: "Install Claude" }).click();

    await vi.waitFor(() => {
      expect(providerAuthHarness.installCalls).toEqual([
        { provider: "claudeAgent", instanceId: "claudeAgent", action: "install" },
      ]);
    });

    await screen.unmount();
  });

  it("reports a live install on the row it belongs to", async () => {
    const screen = await renderCard({
      providers: [
        withInstallCapability(MISSING_CLAUDE, {
          status: "running",
          startedAt: "2026-08-06T00:00:00.000Z",
          finishedAt: null,
          message: "Installing provider.",
          output: "added 1 package",
        }),
      ],
      projectName: "B-git-project",
    });

    await expect.element(page.getByText("Installing… added 1 package")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Install Claude" }))
      .not.toBeInTheDocument();

    await screen.unmount();
  });

  it("enables the start action once one agent is signed in and a folder exists", async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const screen = await renderCard({
      providers: [SIGNED_OUT_CODEX, SIGNED_IN_CLAUDE],
      projectName: "B-git-project",
      onStart,
      onSkip,
    });

    expect(rowStates()).toMatchObject({ claudeAgent: "ready" });
    await expect.element(page.getByText("Signed in · Claude Max")).toBeVisible();

    await page.getByRole("button", { name: "Start first thread" }).click();
    expect(onStart).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "Skip for now" }).click();
    expect(onSkip).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it("asks for a folder, and stays disabled, when no project exists", async () => {
    const onChooseProject = vi.fn();
    const screen = await renderCard({
      providers: [SIGNED_IN_CLAUDE],
      projectName: null,
      onChooseProject,
    });

    expect(rowStates()).toMatchObject({ project: "missing" });

    await page.getByRole("button", { name: "Choose a folder" }).click();
    expect(onChooseProject).toHaveBeenCalledTimes(1);

    await expect.element(page.getByRole("button", { name: "Start first thread" })).toBeDisabled();

    await screen.unmount();
  });
});
