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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { FirstRunSetupCard } from "./FirstRunSetupCard";
import type { FirstRunProviderRow, FirstRunSetupProvider } from "./firstRunSetup";

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
  readonly onSignIn?: (row: FirstRunProviderRow) => void;
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
        isOnlyWorkspaceProject
        onSignIn={props.onSignIn ?? vi.fn()}
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
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("gives every provider state its own dot and action, and holds the start button back", async () => {
    const onSignIn = vi.fn();
    const screen = await renderCard({
      providers: [SIGNED_OUT_CODEX, MISSING_CLAUDE],
      projectName: "B-git-project",
      onSignIn,
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

    await page.getByRole("button", { name: "Sign in to Codex" }).click();
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn.mock.calls[0]?.[0]).toMatchObject({
      name: "Codex",
      signInCommand: "codex login",
    });

    await expect.element(page.getByRole("button", { name: "Start first thread" })).toBeDisabled();

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
