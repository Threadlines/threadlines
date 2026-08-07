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
import type { ProviderSignInFlowView } from "./providerSignIn";
import { useProviderStatusNotice } from "./providerStatusNotice";

function makeSignInView(overrides: Partial<ProviderSignInFlowView> = {}): ProviderSignInFlowView {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    isActive: false,
    isStarting: false,
    hasRun: false,
    hasFailed: false,
    needsTerminal: false,
    lastLine: "",
    failureDetail: null,
    start: () => {},
    ...overrides,
  };
}

function ProviderStatusNoticeHarness({
  status,
  activeTurnInProgress = false,
  suppressed = false,
  signIn,
}: {
  status: ServerProvider | null;
  activeTurnInProgress?: boolean;
  suppressed?: boolean;
  signIn?: ProviderSignInFlowView;
}) {
  const notice = useProviderStatusNotice({ activeTurnInProgress, status, suppressed, signIn });
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
  const diagnosticsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/diagnostics",
  });
  const providersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/providers",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, diagnosticsRoute, providersRoute]),
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

  it("offers sign-in alone for a signed-out provider", async () => {
    const start = vi.fn();
    const provider = makeProvider({
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated.",
    });
    const screen = await renderWithTestRouter(
      <ProviderStatusNoticeHarness status={provider} signIn={makeSignInView({ start })} />,
    );

    try {
      await page.getByRole("button", { name: "Sign in" }).click();
      expect(start).toHaveBeenCalledTimes(1);
      // Nothing to refresh and nothing in the logs: the snapshot already knows.
      await expect
        .element(page.getByRole("button", { name: "Refresh provider status" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "Open diagnostics" }))
        .not.toBeInTheDocument();
      expect(refreshProvidersMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("routes a missing CLI to provider settings and keeps a refresh", async () => {
    const provider = makeProvider({
      installed: false,
      status: "error",
      message: "Codex CLI not detected on PATH. Install it from https://codex.dev/install.",
    });
    const screen = await renderWithTestRouter(<ProviderStatusNoticeHarness status={provider} />);

    try {
      await expect
        .element(page.getByRole("link", { name: "Open Settings" }))
        .toHaveAttribute("href", "/settings/providers");
      await expect
        .element(page.getByRole("button", { name: "Refresh provider status" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Open diagnostics" }))
        .not.toBeInTheDocument();
      // The install address in the server's message is clickable, not dead text.
      await expect
        .element(page.getByRole("link", { name: "https://codex.dev/install" }))
        .toHaveAttribute("href", "https://codex.dev/install");
    } finally {
      await screen.unmount();
    }
  });

  it("hands a stalled sign-in over to settings", async () => {
    const provider = makeProvider({ status: "error", auth: { status: "unauthenticated" } });
    const screen = await renderWithTestRouter(
      <ProviderStatusNoticeHarness
        status={provider}
        signIn={makeSignInView({
          isActive: true,
          hasRun: true,
          needsTerminal: true,
          lastLine: "Paste the code from your browser:",
        })}
      />,
    );

    try {
      await expect.element(page.getByText("Signing in to Codex.")).toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Open provider settings to finish signing in" }))
        .toHaveAttribute("href", "/settings/providers?instance=codex");
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
