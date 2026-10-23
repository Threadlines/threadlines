import {
  AuthSessionId,
  EnvironmentId,
  type InboundComputerLink,
  MessageId,
  type ServerProvider,
  type ThreadId,
  WS_METHODS,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __setComputerLinksClientForTests,
  useComputerLinksStore,
} from "../environments/links/computerLinks";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import {
  THREAD_ID,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  fixture,
  rpcHarness,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  setSidebarThreadWork,
  waitForThreadDetailLoaded,
  injectRemoteEnvironmentThreads,
  FLEET_REMOTE_ENVIRONMENT_ID,
  FLEET_OFFLINE_ENVIRONMENT_ID,
  saveFleetComputers,
  setPrimaryLinksSnapshot,
  withComputerLinksFixture,
  fleetLinksSnapshot,
  fleetOutboundLink,
  fleetPendingRequest,
  fleetInvite,
  fakeComputerLinksClient,
  waitForURL,
  waitForServerConfigToApply,
  mountChatView,
  registerChatViewSuiteHooks,
} from "./ChatView.browser-harness";

vi.mock("../lib/gitStatusState", () => ({
  // Read synchronously by the draft seeder to skip a checkout already known
  // to be missing; these suites never exercise a deleted checkout.
  getGitStatusSnapshot: () => ({ data: null, error: null, cause: null, isPending: false }),
  GIT_STATUS_STALE_MESSAGE: "Source control status isn't updating.",
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  rebuildGitStatusSubscription: () => undefined,
  refreshGitStatus: () => Promise.resolve(null),
  refreshLocalGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

/**
 * `from`'s link to the computer whose snapshot holds it, pinned to `from` as
 * the app's own links are (null: it hasn't said who it is).
 */
function fleetInboundLink(
  from: EnvironmentId | null,
  label: string,
  overrides: Partial<InboundComputerLink> = {},
): InboundComputerLink {
  return {
    deviceId: `device-${from ?? label}`,
    environmentId: from,
    environmentPinned: from !== null,
    label,
    platform: null,
    sessionId: AuthSessionId.make(`session-${from ?? label}`),
    access: "ask",
    maxRuntimeMode: "auto",
    createdAt: NOW_ISO,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("ChatView (full app): Fleet and computer links", () => {
  registerChatViewSuiteHooks();

  it("pauses the fleet's traveling dots while the window is in the background", async () => {
    const workingThreadId = "thread-fleet-paused" as ThreadId;
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-fleet-paused" as MessageId,
          targetText: "fleet paused",
        }),
        workingThreadId,
      ),
      initialPath: "/fleet",
    });
    const hasFocus = vi.spyOn(document, "hasFocus");

    try {
      await waitForServerConfigToApply();
      await waitForThreadDetailLoaded(workingThreadId);
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, workingThreadId, "working", {
        title: "Double charges at checkout",
      });
      const dot = () =>
        document.querySelector<HTMLElement>('[data-testid="fleet-traveling-dots"] .fleet-dot');
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => {
        expect(getComputedStyle(dot()!).animationPlayState).toBe("running");
      });

      // A window in the background draws no frames for the dots.
      hasFocus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      await vi.waitFor(() => {
        expect(getComputedStyle(dot()!).animationPlayState).toBe("paused");
      });
    } finally {
      hasFocus.mockRestore();
      await mounted.cleanup();
    }
  });

  it("draws the fleet from saved computers and their threads, and a computer opens its page", async () => {
    const workingThreadId = "thread-fleet-working" as ThreadId;
    const remoteThreadId = "thread-fleet-remote" as ThreadId;
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-fleet" as MessageId,
          targetText: "fleet",
        }),
        workingThreadId,
      ),
      initialPath: "/fleet",
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
        {
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          label: "Mac mini",
          os: "darwin",
          state: "disconnected",
          // Half past the hour, so the page's clock (taken at mount) reads 2h.
          lastConnectedAt: new Date(Date.now() - 150 * 60_000).toISOString(),
        },
      ]);
      injectRemoteEnvironmentThreads(FLEET_REMOTE_ENVIRONMENT_ID, [
        { id: remoteThreadId, title: "Sign the installer" },
      ]);
      setSidebarThreadWork(FLEET_REMOTE_ENVIRONMENT_ID, remoteThreadId, "needs-you");
      await waitForThreadDetailLoaded(workingThreadId);
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, workingThreadId, "working", {
        title: "Double charges at checkout",
      });

      await expect
        .element(page.getByTestId("fleet-summary"))
        .toMatchTextContent("1 working and 1 needs you, on 2 computers. Mac mini is offline.");
      const remoteNode = page.getByTestId(`fleet-node-${FLEET_REMOTE_ENVIRONMENT_ID}`);
      await expect.element(remoteNode.getByTestId("fleet-connection-connected")).toBeVisible();
      await expect
        .element(
          page
            .getByTestId(`fleet-node-${FLEET_OFFLINE_ENVIRONMENT_ID}`)
            .getByTestId("fleet-connection-offline"),
        )
        .toBeVisible();
      await expect
        .element(page.getByTestId(`fleet-thread-${workingThreadId}`))
        .toMatchTextContent("Double charges at checkout");
      await expect.element(page.getByTestId(`fleet-thread-${remoteThreadId}`)).toBeVisible();
      await expect
        .element(page.getByTestId("fleet-quiet"))
        .toMatchTextContent("Mac mini was last seen 2h ago.");
      // The rail counts the work too.
      await expect.element(page.getByTestId("rail-fleet")).toHaveAttribute("aria-current", "page");
      await expect
        .element(page.getByTestId("fleet-list-all"))
        .toHaveAttribute("aria-current", "page");

      // A computer in the graph opens its page, and so does its row in the list.
      await remoteNode.click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/fleet/${FLEET_REMOTE_ENVIRONMENT_ID}`,
        "A computer in the graph should open its page.",
      );
      const working = page.getByTestId("fleet-working-now");
      await expect.element(working.getByTestId(`fleet-thread-${remoteThreadId}`)).toBeVisible();
      await expect
        .element(working.getByTestId(`fleet-thread-${workingThreadId}`))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByTestId(`fleet-list-computer-${FLEET_REMOTE_ENVIRONMENT_ID}`))
        .toHaveAttribute("aria-current", "page");
      await page.getByTestId(`fleet-list-computer-${FLEET_OFFLINE_ENVIRONMENT_ID}`).click();
      await expect
        .element(page.getByText("Mac mini is offline. Its work shows here when it's back."))
        .toBeVisible();
      await page.getByTestId("fleet-list-all").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/fleet" || pathname === "/fleet/",
        "All computers should go back to the graph.",
      );

      await page.getByTestId(`fleet-thread-${remoteThreadId}`).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${FLEET_REMOTE_ENVIRONMENT_ID}/${remoteThreadId}`,
        "A Fleet row should open its thread.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("draws each computer's agents with that computer's own icons", async () => {
    const remoteThreadId = "thread-fleet-lookalike" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-icons" as MessageId,
        targetText: "fleet icons",
      }),
      initialPath: "/fleet",
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      // The Windows PC calls a community agent "codex", the same instance id
      // as this computer's own Codex.
      const codex = fixture.serverConfig.providers[0]!;
      useSavedEnvironmentRuntimeStore.getState().patch(FLEET_REMOTE_ENVIRONMENT_ID, {
        serverConfig: {
          ...fixture.serverConfig,
          providers: [
            {
              ...codex,
              community: {
                agentId: "lookalike",
                authors: ["Someone"],
                website: null,
                repository: null,
                iconSvg:
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
                source: "npm",
                packageSpec: "lookalike@1.0.0",
                host: null,
                verification: "packageRegistry",
              } as unknown as NonNullable<ServerProvider["community"]>,
            },
          ],
        },
      });
      injectRemoteEnvironmentThreads(FLEET_REMOTE_ENVIRONMENT_ID, [
        { id: remoteThreadId, title: "Lookalike at work" },
      ]);
      setSidebarThreadWork(FLEET_REMOTE_ENVIRONMENT_ID, remoteThreadId, "working");
      await waitForThreadDetailLoaded(THREAD_ID);
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, THREAD_ID, "working");

      const drawsCommunityIcon = (element: Element) =>
        element.querySelector('span[style*="mask-image"]') !== null;
      await vi.waitFor(() => {
        // This computer's agents come first in the graph, then the others'.
        const [local, remote] = Array.from(
          document.querySelectorAll('[data-testid="fleet-provider-codex"]'),
        );
        expect(local && remote).toBeTruthy();
        expect(drawsCommunityIcon(local!)).toBe(false);
        expect(drawsCommunityIcon(remote!)).toBe(true);
      });
      // The list's rows look up their agent on their own computer too.
      expect(
        drawsCommunityIcon(document.querySelector(`[data-testid="fleet-thread-${THREAD_ID}"]`)!),
      ).toBe(false);
      expect(
        drawsCommunityIcon(
          document.querySelector(`[data-testid="fleet-thread-${remoteThreadId}"]`)!,
        ),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks to connect another computer while this is the only one", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-alone" as MessageId,
        targetText: "fleet alone",
      }),
      initialPath: "/fleet",
    });

    try {
      await expect
        .element(page.getByText("Connect another computer to see it here."))
        .toBeVisible();
      await page
        .getByTestId("fleet-view")
        .getByRole("button", { name: "Connect to a computer", exact: true })
        .click();
      await expect
        .element(page.getByRole("dialog", { name: "Connect to a computer" }))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists linked computers this app doesn't save, and one waiting to say which it is", async () => {
    const buildBox = EnvironmentId.make("environment-build-box");
    const linkedSnapshot = fleetLinksSnapshot({
      outbound: [fleetOutboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "DESKTOP-42")],
      inbound: [
        fleetInboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "DESKTOP-42"),
        fleetInboundLink(buildBox, "build box"),
        fleetInboundLink(null, "Studio"),
      ],
    });
    setPrimaryLinksSnapshot(linkedSnapshot);
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-linked" as MessageId,
        targetText: "fleet linked",
      }),
      configureFixture: withComputerLinksFixture,
      initialPath: "/fleet",
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      const list = page.getByTestId("fleet-computers-list");
      // Saved and linked: one row, under the name this app saved it with.
      await expect
        .element(list.getByTestId(`fleet-list-computer-${FLEET_REMOTE_ENVIRONMENT_ID}`))
        .toMatchTextContent("Windows PC");
      await expect.element(list.getByText("DESKTOP-42")).not.toBeInTheDocument();
      await expect
        .element(list.getByTestId(`fleet-list-computer-${buildBox}`))
        .toMatchTextContent("build boxLinked with Local environment");
      await expect
        .element(list.getByTestId("fleet-list-computer-device:device-Studio"))
        .toMatchTextContent("StudioWaiting to hear from it");

      // It says which computer it is: its own entry from then on.
      const studio = EnvironmentId.make("environment-studio");
      rpcHarness.emitStreamValue(
        WS_METHODS.linksSubscribe,
        fleetLinksSnapshot({
          ...linkedSnapshot,
          inbound: [
            fleetInboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "DESKTOP-42"),
            fleetInboundLink(buildBox, "build box"),
            fleetInboundLink(studio, "Studio", { deviceId: "device-Studio" }),
          ],
        }),
      );
      await expect
        .element(list.getByTestId(`fleet-list-computer-${studio}`))
        .toMatchTextContent("Studio");
      await expect
        .element(list.getByTestId("fleet-list-computer-device:device-Studio"))
        .not.toBeInTheDocument();

      // Linked but not in this app: its work is out of sight, never "idle".
      await list.getByTestId(`fleet-list-computer-${buildBox}`).click();
      await expect.element(page.getByText("Connect to build box to see its work.")).toBeVisible();
      await expect
        .element(page.getByTestId("fleet-computer-meta"))
        .toMatchTextContent("Not connected to this app");
    } finally {
      await mounted.cleanup();
    }
  });

  it("sets each direction on the computer it runs on, and links the other direction", async () => {
    const windowsLinks = fakeComputerLinksClient();
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "Windows PC")],
      }),
    );
    const linkCalls: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-directions" as MessageId,
        targetText: "fleet directions",
      }),
      configureFixture: withComputerLinksFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.linksCreateInvite) {
          linkCalls.push(body);
          return fleetInvite(LOCAL_ENVIRONMENT_ID, "Local environment");
        }
        return undefined;
      },
      initialPath: `/fleet/${FLEET_REMOTE_ENVIRONMENT_ID}`,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      __setComputerLinksClientForTests(FLEET_REMOTE_ENVIRONMENT_ID, windowsLinks.client);
      useComputerLinksStore.getState().put(
        FLEET_REMOTE_ENVIRONMENT_ID,
        fleetLinksSnapshot({
          inbound: [fleetInboundLink(LOCAL_ENVIRONMENT_ID, "Local environment")],
        }),
      );

      const pair = page.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}`);
      // On Windows PC's page, "outward" is Windows PC's agents on this computer.
      const linked = pair.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}-inward`);
      await expect
        .element(linked)
        .toMatchTextContent("Local environment's agents can start work on Windows PC");
      await linked.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}-inward-access`).click();
      await page.getByRole("option", { name: "Allowed", exact: true }).click();
      await vi.waitFor(() => {
        expect(windowsLinks.setAccess).toHaveBeenCalledWith({
          deviceId: `device-${LOCAL_ENVIRONMENT_ID}`,
          access: "allowed",
        });
      });

      // The other way isn't linked: Link for just that direction.
      const unlinked = pair.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}-outward`);
      await expect
        .element(unlinked)
        .toMatchTextContent("Windows PC's agents can start work on Local environment");
      await unlinked.getByRole("button", { name: "Link", exact: true }).click();
      await vi.waitFor(() => {
        expect(linkCalls).toHaveLength(1);
        expect(windowsLinks.accept).toHaveBeenCalledWith({
          invite: fleetInvite(LOCAL_ENVIRONMENT_ID, "Local environment"),
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a request from the inbox in the thread that asked, where its card decides it", async () => {
    const askingThreadId = "thread-asking-windows" as ThreadId;
    const windowsLinks = fakeComputerLinksClient();
    const request = {
      ...fleetPendingRequest(
        LOCAL_ENVIRONMENT_ID,
        "request-ask",
        "Run the Windows installer tests",
      ),
      parentEnvironmentId: LOCAL_ENVIRONMENT_ID,
      parentThreadId: askingThreadId,
      parentThreadTitle: "Release checklist",
      prompt: "Run the installer tests on Windows\nand say which ones fail.",
    };
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-request-card" as MessageId,
          targetText: "request card",
        }),
        askingThreadId,
      ),
      configureFixture: withComputerLinksFixture,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      __setComputerLinksClientForTests(FLEET_REMOTE_ENVIRONMENT_ID, windowsLinks.client);
      useComputerLinksStore
        .getState()
        .put(FLEET_REMOTE_ENVIRONMENT_ID, fleetLinksSnapshot({ pending: [request] }));

      // The inbox row reads as a request; clicking it opens the thread that asked.
      await expect
        .element(page.getByTestId("link-request-where-request-ask"))
        .toMatchTextContent("Asked by “Release checklist”");
      await page.getByTestId("link-request-title-request-ask").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${askingThreadId}`,
        "The request should open the thread that asked.",
      );

      // There its card says everything, and answers on the computer it would run on.
      const card = page.getByTestId("remote-start-panel");
      await expect.element(card).toMatchTextContent("needs your OK on Windows PC");
      await expect.element(card).toMatchTextContent("Run the Windows installer tests");
      await expect.element(card).toMatchTextContent("with up to Auto access");
      await expect
        .element(page.getByTestId("remote-start-panel-prompt"))
        .toMatchTextContent("and say which ones fail.");
      await page.getByTestId("remote-start-panel-allow").click();
      await vi.waitFor(() => {
        expect(windowsLinks.respondRequest).toHaveBeenCalledWith({
          deviceId: request.deviceId,
          requestId: request.requestId,
          allow: true,
        });
      });
      // One answer per request: the inbox row holds too, until it leaves.
      await expect.element(page.getByTestId("link-request-deny-request-ask")).toBeDisabled();
      expect(windowsLinks.respondRequest).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an offline computer's settings, disabled, and answers requests from a computer's page", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
        inbound: [fleetInboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
        pending: [
          fleetPendingRequest(FLEET_OFFLINE_ENVIRONMENT_ID, "request-allow", "Fix the build"),
          fleetPendingRequest(FLEET_OFFLINE_ENVIRONMENT_ID, "request-deny", "Rewrite history"),
        ],
      }),
    );
    const responses: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-requests" as MessageId,
        targetText: "fleet requests",
      }),
      configureFixture: withComputerLinksFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.linksRespondRequest) {
          responses.push(body);
          return {};
        }
        return undefined;
      },
      initialPath: `/fleet/${LOCAL_ENVIRONMENT_ID}`,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          label: "Mac mini",
          os: "darwin",
          state: "disconnected",
        },
      ]);
      useComputerLinksStore.getState().put(
        FLEET_OFFLINE_ENVIRONMENT_ID,
        fleetLinksSnapshot({
          inbound: [
            fleetInboundLink(LOCAL_ENVIRONMENT_ID, "Local environment", { access: "allowed" }),
          ],
        }),
      );
      useComputerLinksStore.getState().markStale(FLEET_OFFLINE_ENVIRONMENT_ID);

      const pair = page.getByTestId(`fleet-pair-${FLEET_OFFLINE_ENVIRONMENT_ID}`);
      // This computer's agents on Mac mini: Mac mini's setting, last known.
      const outward = pair.getByTestId(`fleet-pair-${FLEET_OFFLINE_ENVIRONMENT_ID}-outward`);
      await expect
        .element(outward.getByTestId(`fleet-pair-${FLEET_OFFLINE_ENVIRONMENT_ID}-outward-access`))
        .toMatchTextContent("Allowed");
      await expect
        .element(outward.getByTestId(`fleet-pair-${FLEET_OFFLINE_ENVIRONMENT_ID}-outward-access`))
        .toBeDisabled();
      await expect.element(outward).toMatchTextContent("Mac mini is offline.");

      // Mac mini's requests to start threads here wait at the top of its row.
      await expect
        .element(pair.getByTestId("link-request-request-allow"))
        .toMatchTextContent("Mac mini wants to start a thread: Fix the build");
      await pair.getByTestId("link-request-allow-request-allow").click();
      await pair.getByTestId("link-request-deny-request-deny").click();
      await vi.waitFor(() => {
        expect(responses).toEqual([
          expect.objectContaining({ requestId: "request-allow", allow: true }),
          expect.objectContaining({ requestId: "request-deny", allow: false }),
        ]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("unlinks both ways, stopping what the links started, and says which computer finishes later", async () => {
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
        inbound: [fleetInboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const removals: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-unlink" as MessageId,
        targetText: "fleet unlink",
      }),
      configureFixture: withComputerLinksFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.linksRemove) {
          removals.push(body);
          return {
            otherComputer: body.direction === "outbound" ? "pending" : "not_asked",
          };
        }
        return undefined;
      },
      initialPath: `/fleet/${FLEET_OFFLINE_ENVIRONMENT_ID}`,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          label: "Mac mini",
          os: "darwin",
          state: "disconnected",
        },
      ]);
      // A thread Mac mini's agent started here is still at work.
      await waitForThreadDetailLoaded(THREAD_ID);
      setSidebarThreadWork(LOCAL_ENVIRONMENT_ID, THREAD_ID, "working", {
        remoteOrigin: {
          linkDeviceId: `device-${FLEET_OFFLINE_ENVIRONMENT_ID}`,
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          environmentLabel: "Mac mini",
          threadId: "thread-on-mini" as ThreadId,
          threadTitle: "Ship the release",
        },
      });

      await page.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}-unlink`).click();
      const dialog = page.getByTestId("fleet-unlink-dialog");
      await expect
        .element(dialog.getByTestId("fleet-unlink-running"))
        .toMatchTextContent(
          "1 thread Mac mini started on Local environment is still running. Unlinking stops it.",
        );
      await expect
        .element(dialog.getByTestId("fleet-unlink-offline"))
        .toMatchTextContent("Mac mini is offline. Mac mini finishes when it's back.");
      await dialog
        .getByRole("button", { name: "Unlink on Local environment now", exact: true })
        .click();
      await vi.waitFor(() => {
        expect(removals).toEqual([
          expect.objectContaining({
            direction: "inbound",
            deviceId: `device-${FLEET_OFFLINE_ENVIRONMENT_ID}`,
            stopRunning: true,
          }),
          expect.objectContaining({
            direction: "outbound",
            linkId: `link-to-${FLEET_OFFLINE_ENVIRONMENT_ID}`,
          }),
        ]);
      });
      // Mac mini's halves wait for it; nothing is claimed done that isn't.
      await expect
        .element(dialog.getByTestId("fleet-unlink-results"))
        .toMatchTextContent(
          "Local environment's agents on Mac mini: Mac mini finishes when it's back.",
        );
      expect(removals[1]).not.toHaveProperty("otherHalfRemoved");
    } finally {
      await mounted.cleanup();
    }
  });

  it("never promises an offline computer finishes an unlink nothing can tell it about", async () => {
    // Only Mac mini's agents work here: this computer has no link to Mac mini.
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        inbound: [fleetInboundLink(FLEET_OFFLINE_ENVIRONMENT_ID, "Mac mini")],
      }),
    );
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-unlink-one-way" as MessageId,
        targetText: "fleet unlink one way",
      }),
      configureFixture: withComputerLinksFixture,
      resolveRpc: (body) =>
        body._tag === WS_METHODS.linksRemove ? { otherComputer: "not_asked" } : undefined,
      initialPath: `/fleet/${FLEET_OFFLINE_ENVIRONMENT_ID}`,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_OFFLINE_ENVIRONMENT_ID,
          label: "Mac mini",
          os: "darwin",
          state: "disconnected",
        },
      ]);
      await page.getByTestId(`fleet-pair-${LOCAL_ENVIRONMENT_ID}-unlink`).click();
      const dialog = page.getByTestId("fleet-unlink-dialog");
      await expect
        .element(dialog.getByTestId("fleet-unlink-keeps-side"))
        .toMatchTextContent(
          "Mac mini is offline. It can't start work on Local environment after this, but it still lists the link until you unlink again while it's online.",
        );
      await expect.element(dialog.getByTestId("fleet-unlink-offline")).not.toBeInTheDocument();
      await dialog
        .getByRole("button", { name: "Unlink on Local environment now", exact: true })
        .click();
      await expect
        .element(dialog.getByTestId("fleet-unlink-results"))
        .toMatchTextContent(
          "Mac mini's agents on Local environment: unlinked on Local environment. Mac mini still lists it until you unlink again while it's online.",
        );
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes a computer from this app without unlinking it", async () => {
    const windowsLinks = fakeComputerLinksClient();
    setPrimaryLinksSnapshot(
      fleetLinksSnapshot({
        outbound: [fleetOutboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "Windows PC")],
        inbound: [fleetInboundLink(FLEET_REMOTE_ENVIRONMENT_ID, "Windows PC")],
      }),
    );
    const removals: Array<NormalizedWsRpcRequestBody> = [];
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-fleet-remove" as MessageId,
        targetText: "fleet remove",
      }),
      configureFixture: withComputerLinksFixture,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.linksRemove) {
          removals.push(body);
          return { otherComputer: "confirmed" };
        }
        return undefined;
      },
      initialPath: `/fleet/${FLEET_REMOTE_ENVIRONMENT_ID}`,
    });

    try {
      await waitForServerConfigToApply();
      await saveFleetComputers([
        {
          environmentId: FLEET_REMOTE_ENVIRONMENT_ID,
          label: "Windows PC",
          os: "windows",
          state: "connected",
        },
      ]);
      __setComputerLinksClientForTests(FLEET_REMOTE_ENVIRONMENT_ID, windowsLinks.client);
      await page.getByTestId("fleet-remove-from-app").click();
      const dialog = page.getByTestId("fleet-remove-dialog");
      await expect
        .element(dialog.getByTestId("fleet-remove-stays-linked"))
        .toMatchTextContent(
          "Windows PC and Local environment stay linked. Unlink them first to stop agents working across them.",
        );
      await dialog.getByTestId("fleet-remove-confirm").click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === "/fleet" || pathname === "/fleet/",
        "Removing a computer should go back to All computers.",
      );
      await vi.waitFor(() => {
        expect(
          useSavedEnvironmentRegistryStore.getState().byId[FLEET_REMOTE_ENVIRONMENT_ID],
        ).toBeUndefined();
      });
      expect(removals).toEqual([]);
      expect(windowsLinks.remove).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
