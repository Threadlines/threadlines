import "../../index.css";

import {
  EnvironmentId,
  type ProviderAuthEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { type ReactNode, useState } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

const { refreshProvidersMock, openExternalMock } = vi.hoisted(() => ({
  refreshProvidersMock: vi.fn(
    async (_input: { readonly environmentId: unknown; readonly instanceId: unknown }) => ({
      providers: [],
    }),
  ),
  openExternalMock: vi.fn(async (_url: string) => true),
}));

// Refresh asks the computer the thread runs on, through this module.
vi.mock("../../environments/providerStatusRefresh", () => ({
  refreshProviderStatus: refreshProvidersMock,
}));

// Sign-in pages open on this device.
vi.mock("../../localApi", () => {
  const api = { shell: { openExternal: openExternalMock } };
  return { ensureLocalApi: () => api, readLocalApi: () => api };
});

/** The computer the thread runs on in these tests. */
const THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-mac-mini");

import {
  __resetProviderAuthClientsForTests,
  __setProviderAuthClientForTests,
  type ProviderAuthClient,
} from "../../environments/providerComputer";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { ComposerNoticeDock } from "./ComposerNoticeDock";
import { closeProviderSignInDialog, ProviderSignInDialogHost } from "./ProviderSignInDialog";
import type { ProviderSignInFlowView } from "./providerSignIn";
import { useProviderStatusNotice } from "./providerStatusNotice";
import { useThreadProviderSignIn } from "./useThreadProviderSignIn";

function makeSignInView(overrides: Partial<ProviderSignInFlowView> = {}): ProviderSignInFlowView {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    isActive: false,
    isStarting: false,
    hasRun: false,
    elsewhere: null,
    canReachComputer: true,
    hasFailed: false,
    needsHandoff: false,
    asking: false,
    waitingInHandoff: false,
    lastLine: "",
    failureDetail: null,
    start: () => {},
    ...overrides,
  };
}

function ProviderStatusNoticeHarness({
  status,
  environmentId = THREAD_ENVIRONMENT_ID,
  activeTurnInProgress = false,
  suppressed = false,
  signIn,
}: {
  status: ServerProvider | null;
  /** The computer the thread runs on; null is the app's own. */
  environmentId?: EnvironmentId | null;
  activeTurnInProgress?: boolean;
  suppressed?: boolean;
  signIn?: ProviderSignInFlowView;
}) {
  const notice = useProviderStatusNotice({
    activeTurnInProgress,
    status,
    environmentId,
    suppressed,
    signIn,
  });
  return <ComposerNoticeDock notices={notice ? [notice] : []} />;
}

/**
 * The composer's own sign-in, for a thread on the Mac mini unless told
 * otherwise, with the sign-in window's host and a way to move to a Mac mini
 * thread, as the composer does when the user opens one.
 */
function ThreadSignInHarness({
  status,
  environmentId: initialEnvironmentId = THREAD_ENVIRONMENT_ID,
}: {
  status: ServerProvider;
  environmentId?: EnvironmentId | null;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const signIn = useThreadProviderSignIn({
    instanceId: status.instanceId,
    environmentId,
    providerLabel: "Codex",
  });
  return (
    <>
      <ProviderStatusNoticeHarness status={status} environmentId={environmentId} signIn={signIn} />
      <ProviderSignInDialogHost />
      <button type="button" onClick={() => setEnvironmentId(THREAD_ENVIRONMENT_ID)}>
        Open a Mac mini thread
      </button>
    </>
  );
}

/** A computer's sign-in calls, as its server would take them, and the events it sends back. */
function fakeProviderAuthClient() {
  const listeners = new Set<(event: ProviderAuthEvent) => void>();
  const start = vi.fn(async (_input: { readonly requestId?: string }) => undefined);
  const write = vi.fn(async (_input: { readonly data: string }) => undefined);
  const client = {
    start,
    write,
    resize: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined),
    subscribe: (_input: unknown, listener: (event: ProviderAuthEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ProviderAuthClient;
  const emit = (event: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener({
        instanceId: ProviderInstanceId.make("codex"),
        createdAt: new Date().toISOString(),
        ...event,
      } as ProviderAuthEvent);
    }
  };
  return { client, start, write, emit };
}

function saveMacMini() {
  // Its server replays a sign-in page's final address pasted from here.
  useSavedEnvironmentRuntimeStore.getState().patch(THREAD_ENVIRONMENT_ID, {
    descriptor: {
      environmentId: THREAD_ENVIRONMENT_ID,
      label: "Mac mini",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.8.0",
      capabilities: { repositoryIdentity: true, signInAddressReplay: true },
    },
  });
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [THREAD_ENVIRONMENT_ID]: {
        environmentId: THREAD_ENVIRONMENT_ID,
        label: "Mac mini",
        wsBaseUrl: "ws://mac-mini.local",
        httpBaseUrl: "http://mac-mini.local",
        createdAt: new Date().toISOString(),
        lastConnectedAt: null,
      },
    },
  });
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
    openExternalMock.mockClear();
    __resetProviderAuthClientsForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    closeProviderSignInDialog();
    document.body.innerHTML = "";
  });

  it("signs a thread's agent in on the computer the thread runs on, and finishes in the sign-in window", async () => {
    saveMacMini();
    const mac = fakeProviderAuthClient();
    const thisComputer = fakeProviderAuthClient();
    __setProviderAuthClientForTests(THREAD_ENVIRONMENT_ID, mac.client);
    __setProviderAuthClientForTests(null, thisComputer.client);
    const provider = makeProvider({ status: "error", auth: { status: "unauthenticated" } });
    const screen = await renderWithTestRouter(<ThreadSignInHarness status={provider} />);

    try {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await vi.waitFor(() => {
        expect(mac.start).toHaveBeenCalledWith(
          expect.objectContaining({ instanceId: "codex", flow: "login" }),
        );
      });
      expect(thisComputer.start).not.toHaveBeenCalled();
      const signInWindow = page.getByTestId("provider-sign-in-dialog");
      await expect
        .element(signInWindow.getByRole("heading", { name: "Sign in to Codex on Mac mini" }))
        .toBeVisible();

      // The Mac runs `codex login`, which opens its page on the Mac's own
      // screen and waits on the Mac's loopback: the page opens here too,
      // and the address it ends on goes back to the Mac to replay.
      const requestId = mac.start.mock.calls[0]![0].requestId;
      mac.emit({
        type: "command",
        flow: "login",
        command: "codex login",
        flowId: "flow-1",
        requestId,
        surface: "terminal",
        opensPageItself: true,
      });
      mac.emit({ type: "status", status: "running", exitCode: null, detail: null });
      const signInPage = `https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=${encodeURIComponent(
        "http://localhost:1455/auth/callback",
      )}&state=st-1`;
      mac.emit({
        type: "output",
        data: `Navigate to this URL to authenticate:\r\n\r\n${signInPage}\r\n`,
      });
      await vi.waitFor(() => {
        expect(openExternalMock).toHaveBeenCalledWith(signInPage);
      });
      const address = signInWindow.getByRole("textbox", { name: "Address the browser ended on" });
      await userEvent.fill(address, "http://localhost:1455/auth/callback?code=abc&state=st-1");
      await signInWindow.getByRole("button", { name: "Finish sign-in" }).click();
      await vi.waitFor(() => {
        expect(mac.write).toHaveBeenCalledWith(
          expect.objectContaining({
            data: "http://localhost:1455/auth/callback?code=abc&state=st-1",
            redirect: true,
            flowId: "flow-1",
          }),
        );
      });

      mac.emit({ type: "status", status: "succeeded", exitCode: 0, detail: null });
      await expect.element(signInWindow).not.toBeInTheDocument();
      expect(thisComputer.write).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("drops a sign-in's late answer once the composer moved to a thread elsewhere", async () => {
    saveMacMini();
    const thisComputer = fakeProviderAuthClient();
    let rejectStart: (error: Error) => void = () => {};
    thisComputer.start.mockImplementationOnce(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    __setProviderAuthClientForTests(null, thisComputer.client);
    const provider = makeProvider({ status: "error", auth: { status: "unauthenticated" } });
    const screen = await renderWithTestRouter(
      <ThreadSignInHarness status={provider} environmentId={null} />,
    );

    try {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await vi.waitFor(() => {
        expect(thisComputer.start).toHaveBeenCalledTimes(1);
      });
      // On to a Mac mini thread, whose own sign-in has its own answer.
      await page.getByRole("button", { name: "Open a Mac mini thread" }).click();
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const macAnswer =
        "Sign-in failed. The computer this agent runs on isn't connected right now.";
      await expect.element(page.getByText(macAnswer)).toBeVisible();

      rejectStart(new Error("This computer's sign-in broke."));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.body.textContent).toContain(macAnswer);
      expect(document.body.textContent).not.toContain("This computer's sign-in broke.");
    } finally {
      await screen.unmount();
    }
  });

  it("says the thread's computer isn't connected instead of a Sign in that does nothing", async () => {
    saveMacMini();
    const provider = makeProvider({ status: "error", auth: { status: "unauthenticated" } });
    const screen = await renderWithTestRouter(<ThreadSignInHarness status={provider} />);

    try {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Sign-in failed. The computer this agent runs on isn't connected right now.",
          ),
        )
        .toBeVisible();
      await expect.element(page.getByTestId("provider-sign-in-dialog")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
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
        expect(refreshProvidersMock).toHaveBeenCalledWith({
          environmentId: THREAD_ENVIRONMENT_ID,
          instanceId: provider.instanceId,
        });
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
    // A thread on the computer Settings shows.
    const screen = await renderWithTestRouter(
      <ProviderStatusNoticeHarness status={provider} environmentId={null} />,
    );

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

  it("offers no link into this computer's Settings for an agent on another computer", async () => {
    const provider = makeProvider({
      installed: false,
      status: "error",
      message: "Codex CLI not detected on PATH.",
    });
    const screen = await renderWithTestRouter(<ProviderStatusNoticeHarness status={provider} />);

    try {
      await expect
        .element(page.getByRole("button", { name: "Refresh provider status" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Open Settings" }))
        .not.toBeInTheDocument();
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
          needsHandoff: true,
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
