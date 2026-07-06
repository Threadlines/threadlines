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

import { SESSION_STARTUP_SLOW_NOTICE_DELAY_MS, SessionStartupNotice } from "./SessionStartupNotice";

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
    status: "ready",
    version: null,
    ...overrides,
  };
}

function slowStartedAt(): string {
  return new Date(Date.now() - SESSION_STARTUP_SLOW_NOTICE_DELAY_MS - 1_000).toISOString();
}

describe("SessionStartupNotice", () => {
  afterEach(() => {
    refreshProvidersMock.mockClear();
    document.body.innerHTML = "";
  });

  it("offers targeted refresh and diagnostics actions once startup runs long", async () => {
    const provider = makeProvider();
    const screen = await renderWithTestRouter(
      <SessionStartupNotice
        isSessionStarting
        startedAt={slowStartedAt()}
        providerStatus={provider}
      />,
    );

    try {
      await expect.element(page.getByText("Turn startup:", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Preparing this turn is taking longer than usual."))
        .toBeVisible();
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

  it("stays hidden before the slow-startup threshold", async () => {
    const screen = await renderWithTestRouter(
      <SessionStartupNotice
        isSessionStarting
        startedAt={new Date().toISOString()}
        providerStatus={makeProvider()}
      />,
    );

    try {
      await expect
        .element(page.getByText("Turn startup:", { exact: true }))
        .not.toBeInTheDocument();
      expect(refreshProvidersMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("stays hidden while another status banner is already visible", async () => {
    const screen = await renderWithTestRouter(
      <SessionStartupNotice
        isSessionStarting
        suppressed
        startedAt={slowStartedAt()}
        providerStatus={makeProvider()}
      />,
    );

    try {
      await expect
        .element(page.getByText("Turn startup:", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("omits the refresh action without a provider snapshot", async () => {
    const screen = await renderWithTestRouter(
      <SessionStartupNotice isSessionStarting startedAt={slowStartedAt()} providerStatus={null} />,
    );

    try {
      await expect.element(page.getByText("Turn startup:", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Refresh provider status" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("link", { name: "Open diagnostics" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
