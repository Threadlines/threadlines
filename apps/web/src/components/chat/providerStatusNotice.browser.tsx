import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

import { ComposerNoticeDock } from "./ComposerNoticeDock";
import { useProviderStatusNotice } from "./providerStatusNotice";

function ProviderStatusNoticeHarness({
  status,
  activeTurnInProgress = false,
  suppressed = false,
}: {
  status: ServerProvider | null;
  activeTurnInProgress?: boolean;
  suppressed?: boolean;
}) {
  const notice = useProviderStatusNotice({ activeTurnInProgress, status, suppressed });
  return <ComposerNoticeDock notices={notice ? [notice] : []} />;
}

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
    message: "Codex provider has limited availability.",
    ...overrides,
  };
}

describe("provider status composer notice", () => {
  afterEach(() => {
    refreshProvidersMock.mockClear();
    document.body.innerHTML = "";
  });

  it("stays hidden while a held-send notice names the same problem", async () => {
    // The held-send row carries the actions that fix the provider; without
    // suppression this error-severity row would outrank it in the dock.
    const provider = makeProvider({ status: "error", message: "Codex is unavailable." });
    await renderWithTestRouter(<ProviderStatusNoticeHarness status={provider} suppressed />);

    await expect.element(page.getByText("Codex provider status")).not.toBeInTheDocument();
  });

  it("offers targeted refresh and diagnostics actions for provider probe timeouts", async () => {
    const provider = makeProvider({
      statusReason: "provider_probe_timeout",
      message:
        "Codex status check timed out after 60 seconds. Existing sessions may still work; refresh provider status if this keeps happening.",
    });
    const screen = await renderWithTestRouter(<ProviderStatusNoticeHarness status={provider} />);

    try {
      await expect.element(page.getByText("Codex provider status", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Codex status check timed out after 60 seconds."))
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

  it("does not show provider probe warnings over an active turn", async () => {
    const screen = await renderWithTestRouter(
      <ProviderStatusNoticeHarness activeTurnInProgress status={makeProvider()} />,
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
      <ProviderStatusNoticeHarness activeTurnInProgress status={provider} />,
    );

    try {
      await expect.element(page.getByText("Codex provider status", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Codex CLI is not authenticated.")).toBeVisible();
      expect(
        document
          .querySelector("[data-composer-notice-severity]")
          ?.getAttribute("data-composer-notice-severity"),
      ).toBe("error");
    } finally {
      await screen.unmount();
    }
  });
});
