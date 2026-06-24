import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

const { refreshProvidersMock } = vi.hoisted(() => ({
  refreshProvidersMock: vi.fn(async () => ({ providers: [] })),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: vi.fn(() => ({
    server: {
      refreshProviders: refreshProvidersMock,
    },
  })),
}));

import { ProviderStatusBanner } from "./ProviderStatusBanner";

function renderWithTestRouter(children: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => children,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    auth: { status: "unknown" },
    checkedAt: "2026-06-01T12:00:00.000Z",
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Codex",
    installed: true,
    instanceId: ProviderInstanceId.make("codex"),
    models: [],
    slashCommands: [],
    skills: [],
    status: "warning",
    version: null,
    message: "Codex provider status check timed out.",
    ...overrides,
  };
}

describe("ProviderStatusBanner", () => {
  afterEach(() => {
    refreshProvidersMock.mockClear();
    document.body.innerHTML = "";
  });

  it("offers targeted refresh and diagnostics actions for provider warnings", async () => {
    const provider = makeProvider();
    const screen = await renderWithTestRouter(<ProviderStatusBanner status={provider} />);

    try {
      await expect.element(page.getByText("Codex provider status", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Codex provider status check timed out.")).toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Open diagnostics" }))
        .toHaveAttribute("href", "/settings/diagnostics");

      await page.getByRole("button", { name: "Refresh provider status" }).click();

      await vi.waitFor(() => {
        expect(refreshProvidersMock).toHaveBeenCalledWith({ instanceId: provider.instanceId });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not float provider probe warnings over an active turn", async () => {
    const provider = makeProvider();
    const screen = await renderWithTestRouter(
      <ProviderStatusBanner activeTurnInProgress status={provider} />,
    );

    try {
      await expect
        .element(page.getByText("Codex provider status", { exact: true }))
        .not.toBeInTheDocument();
      expect(refreshProvidersMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("still shows provider errors during an active turn", async () => {
    const provider = makeProvider({
      status: "error",
      message: "Codex CLI is not authenticated.",
    });
    const screen = await renderWithTestRouter(
      <ProviderStatusBanner activeTurnInProgress status={provider} />,
    );

    try {
      await expect.element(page.getByText("Codex provider status", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Codex CLI is not authenticated.")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
