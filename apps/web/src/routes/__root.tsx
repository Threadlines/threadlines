import {
  markPullRequestListSettled,
  startPullRequestAttentionRefresh,
} from "../lib/pullRequestsReactQuery";
import { startPullRequestWatch } from "../lib/pullRequestWatch";
import {
  type DesktopTaskbarStatusInput,
  type DesktopTaskbarThreadSummary,
  type ScopedThreadRef,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
} from "@threadlines/contracts";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  type MakeRouteMatchUnion,
  useLocation,
  useMatches,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette, preloadCommandPaletteDialog } from "../components/CommandPalette";
import { preloadDestinationLists } from "../components/sidebar/destinationLists";
import { PushAlertsRuntime } from "../pushAlerts/PushAlertsRuntime";
import { BrowserHostLayer } from "../components/browser/BrowserHostLayer";
import { BrowserProfileReconciler } from "../components/desktop/BrowserProfileReconciler";
import { DesktopUpdateInstallDialog } from "../components/desktop/DesktopUpdateInstallDialog";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { QuitConfirmationDialog } from "../components/desktop/QuitConfirmationDialog";
import { ThreadDeleteDialogHost } from "../components/ThreadDeleteDialog";
import {
  preloadProjectSetupDialog,
  ProjectSetupDialogHost,
} from "../components/ProjectSetupDialog";
import { preloadThreadMoveDialog, ThreadMoveDialogHost } from "../components/ThreadMoveDialog";
import { DeviceRenameDialogHost } from "../components/DeviceRenameDialog";
import { ThreadRenameDialogHost } from "../components/ThreadRenameDialog";
import {
  ConnectComputerDialogHost,
  preloadConnectComputerDialog,
} from "../components/settings/connections/JoinComputerDialog";
import { ExpandedImageViewerHost } from "../components/chat/ExpandedImageDialog";
import {
  preloadProviderSignInDialog,
  ProviderSignInDialogHost,
} from "../components/chat/ProviderSignInDialog";
import { OutsideAgentsHost } from "../components/outsideAgents/OutsideAgentsHost";
import { preloadOutsideAgentDialog } from "../components/outsideAgents/outsideAgentDialog";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import { ProviderUpdateProgress } from "../components/ProviderUpdateProgress";
import { SourceControlToolUpdateLaunchNotification } from "../components/SourceControlToolUpdateLaunchNotification";
import { SavedEnvironmentConnectionOverlay } from "../components/SavedEnvironmentConnectionOverlay";
import { AppReloadingState, AppReloadNeededState } from "../components/ConnectionStatusStates";
import {
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import {
  failureNotice,
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import {
  countActiveScheduledTasks,
  countWorkingScheduledRuns,
  ScheduledTasksSync,
  useScheduledTasksStore,
} from "../lib/scheduledTasksState";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { refreshSourceControlDiscoveryAfterReconnect } from "../lib/sourceControlDiscoveryState";
import { useInboxThreads } from "../hooks/useInboxThreads";
import { useSettings } from "../hooks/useSettings";
import { isUnreadFinishedWork } from "../components/Sidebar.logic";
import { toSortableTimestamp } from "../lib/threadSort";
import type { SidebarThreadSummary } from "../types";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  clearServerConfig,
  getServerConfig,
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  setServerConfigSnapshot,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  describedAwaitedTasks,
  formatAwaitedTasks,
  isWaitingOnBackgroundTasks,
} from "../session-logic";
import {
  type AppState,
  isThreadOnPrimaryEnvironment,
  selectBootstrapCompleteForActiveEnvironment,
  selectRunningSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectBusyTerminals, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  listSavedEnvironmentRecords,
  waitForSavedEnvironmentRegistryHydration,
  startEnvironmentConnectionService,
  bindThreadRowIntentPrewarm,
  startRelayJoinWatchers,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { startComputerLinksSync } from "../environments/links/computerLinks";
import { startProjectSetupsSync } from "../environments/projectSetups/projectSetups";
import { startComputerStallsSync } from "../environments/stalls/computerStalls";
import { startPullRequestRecordsSync } from "../environments/pullRequests/pullRequestRecords";
import { ComputerStallNotices } from "../components/ComputerStallNotices";
import { configureClientTracing } from "../observability/clientTracing";
import {
  ensurePrimaryEnvironmentReady,
  getPrimaryKnownEnvironment,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../environments/primary";
import { hasHostedPairingRouteIntent, isHostedStaticApp } from "../hostedPairing";
import { readLastVisitedThreadRoute } from "../lastVisitedThreadRoute";
import { isLaunchVisitConsumed } from "../launchVisit";
import { resolveThreadRouteRef } from "../threadRoutes";
import {
  isStaleBuildError,
  resolveStaleBuildRecovery,
  STALE_BUILD_RECHECK_MS,
  type StaleBuildRecovery,
} from "../staleBuild";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  beforeLoad: async ({ location }) => {
    if (
      (location.pathname === "/pair" &&
        hasHostedPairingRouteIntent(new URL(window.location.href))) ||
      // The join page strips its secret from the address bar on arrival, so
      // the path alone keeps it in place; with no link it says to rescan.
      location.pathname === "/join"
    ) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      await waitForSavedEnvironmentRegistryHydration();
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const [, authGateState] = await Promise.all([
      ensurePrimaryEnvironmentReady(),
      resolveInitialServerAuthGateState(),
    ]);
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  // The page the outlet is drawing: the root's child route, or none while it
  // draws the not-found page (an unmatched address keeps the nearest route as
  // a match). A navigation moves the location first and swaps the page only
  // once the next one has loaded, so the shell around the outlet follows
  // this: picked from the location, it would be taken away from under a page
  // that still needs it.
  const shownRouteId = useMatches({
    select: (matches) => (matches[0]?._notFound ? undefined : matches[1]?.routeId),
  });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (shownRouteId === "/pair") {
    return <Outlet />;
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  // Setup takes the whole window: no sidebar, but the same services, toasts
  // and command palette (its folder picker runs there).
  const appShell = (
    <CommandPalette>
      {shownRouteId === "/setup" ? (
        <Outlet />
      ) : (
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      )}
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? <ServerStateBootstrap /> : null}
        <EnvironmentConnectionManagerBootstrap />
        <AppShellIdlePreloads />
        <PushAlertsRuntime />
        {isElectron ? <DesktopTaskbarStatusSync /> : null}
        {primaryEnvironmentAuthenticated ? <ScheduledTasksSync /> : null}
        {isElectron ? <BrowserProfileReconciler /> : null}
        {isElectron ? <BrowserHostLayer /> : null}
        <SshPasswordPromptDialog />
        <QuitConfirmationDialog />
        <DesktopUpdateInstallDialog />
        <ThreadDeleteDialogHost />
        <ThreadMoveDialogHost />
        <ProjectSetupDialogHost />
        <ThreadRenameDialogHost />
        <DeviceRenameDialogHost />
        <ConnectComputerDialogHost />
        <ExpandedImageViewerHost />
        <ProviderSignInDialogHost />
        {primaryEnvironmentAuthenticated ? <OutsideAgentsHost /> : null}
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
        <ProviderUpdateProgress />
        {primaryEnvironmentAuthenticated ? <SourceControlToolUpdateLaunchNotification /> : null}
        {primaryEnvironmentAuthenticated ? <WebSocketConnectionCoordinator /> : null}
        <ComputerStallNotices />
        {primaryEnvironmentAuthenticated ? (
          <WebSocketConnectionSurface>{appShell}</WebSocketConnectionSurface>
        ) : (
          appShell
        )}
        {authGateState.status === "hosted-static" ? <HostedStaticServerStateBridge /> : null}
        {authGateState.status === "hosted-static" ? <SavedEnvironmentConnectionOverlay /> : null}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function describeWorking(count: number): string {
  return count === 1 ? "1 thread is working" : `${count} threads are working`;
}

function describeCompleted(count: number): string {
  return count === 1 ? "1 thread completed" : `${count} threads completed`;
}

// Bounds the taskbar status IPC payload; the desktop menu shows fewer and
// summarizes the rest.
const TASKBAR_MENU_THREAD_LIMIT = 20;

// How long nothing must run before the taskbar says the work is done. Work
// hands over with a gap of a few hundred milliseconds (a queued message, or a
// child thread's answer, starts the next turn just after one ends), and a
// "completed" flash in that gap would be a false alarm.
const TASKBAR_COMPLETION_SETTLE_MS = 1_500;

function taskbarThreadKey(
  thread: Pick<DesktopTaskbarThreadSummary, "environmentId" | "threadId">,
): string {
  return `${thread.environmentId}:${thread.threadId}`;
}

function selectRunningTaskbarThreads(state: AppState): DesktopTaskbarThreadSummary[] {
  return selectRunningSidebarThreadsAcrossEnvironments(state).map((thread) => {
    const summary = {
      threadId: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
    };
    if (!isWaitingOnBackgroundTasks(thread.latestTurn, thread.session)) {
      return { ...summary, state: "running" as const };
    }
    const awaitedTasks = describedAwaitedTasks(thread.session);
    const waitingOn = awaitedTasks ? formatAwaitedTasks(awaitedTasks) : null;
    return { ...summary, state: "waiting" as const, ...(waitingOn ? { waitingOn } : {}) };
  });
}

/** Most recently finished first, so the menu leads with what just landed. */
function compareByCompletion(left: SidebarThreadSummary, right: SidebarThreadSummary): number {
  return (
    (toSortableTimestamp(right.latestTurn?.completedAt ?? undefined) ?? 0) -
    (toSortableTimestamp(left.latestTurn?.completedAt ?? undefined) ?? 0)
  );
}

/**
 * Keeps the desktop app's Dock, taskbar and menu bar item in step with the
 * threads: how many are running, and how many finished without the user
 * opening them yet. That second count is the inbox's own unread finished work,
 * so it holds while the user is in the app looking elsewhere, and drops as
 * each thread is opened, here or on another device.
 */
function DesktopTaskbarStatusSync() {
  // Subscribe to a compact signature so re-renders happen only when the
  // running set or what a running thread shows changes: its title, whether it
  // works or waits, and what it waits on.
  const runningThreadsSignature = useStore((state) =>
    selectRunningTaskbarThreads(state)
      .map(
        (thread) =>
          `${taskbarThreadKey(thread)}:${thread.state}:${thread.waitingOn ?? ""}:${thread.title}`,
      )
      .join("|"),
  );
  const { entries, generalChatEntries } = useInboxThreads();
  const unreadThreads = [...entries, ...generalChatEntries]
    .filter((entry) => isUnreadFinishedWork({ isDone: false, ...entry }))
    .map((entry) => entry.thread)
    .toSorted(compareByCompletion)
    .map((thread): DesktopTaskbarThreadSummary => ({
      threadId: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
      state: "completed",
    }));
  const unreadThreadsSignature = unreadThreads
    .map((thread) => `${taskbarThreadKey(thread)}:${thread.title}`)
    .join("|");
  // Quitting stops only this computer's threads, so the desktop app is told
  // how many of the running ones are local.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // And this computer's active schedules: they keep it awake when the user
  // asked for that, and quitting stops them.
  const activeScheduledTaskCount = useScheduledTasksStore((state) =>
    primaryEnvironmentId === null
      ? 0
      : countActiveScheduledTasks(state.byEnvironment[primaryEnvironmentId]),
  );
  // Its scheduled runs at work keep it awake too, a one-time task's included.
  const workingScheduledRunCount = useScheduledTasksStore((state) =>
    primaryEnvironmentId === null
      ? 0
      : countWorkingScheduledRuns(state.byEnvironment[primaryEnvironmentId]),
  );
  // Quitting stops this computer's terminals too: a busy one makes it ask.
  const localBusyTerminalCount = useTerminalStateStore(
    (state) => selectBusyTerminals(state, primaryEnvironmentId).length,
  );
  const hadRunningThreadRef = useRef(false);
  const lastStatusInputRef = useRef<DesktopTaskbarStatusInput | null>(null);
  const completionSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStatusKeyRef = useRef<string | null>(null);

  const setTaskbarStatus = useEffectEvent((status: DesktopTaskbarStatusInput) => {
    const bridge = window.desktopBridge;
    if (!bridge?.setTaskbarStatus) {
      return;
    }
    const input: DesktopTaskbarStatusInput = {
      ...status,
      activeScheduledTaskCount,
      workingScheduledRunCount,
    };

    const threadsKey = (input.threads ?? [])
      .map(
        (thread) =>
          `${taskbarThreadKey(thread)}:${thread.state}:${thread.waitingOn ?? ""}:${thread.title}`,
      )
      .join("|");
    const statusKey = `${input.status}:${input.description ?? ""}:${input.runningThreadCount ?? ""}:${input.localRunningThreadCount ?? ""}:${input.localBusyTerminalCount ?? ""}:${input.completedThreadCount ?? ""}:${input.activeScheduledTaskCount ?? ""}:${input.workingScheduledRunCount ?? ""}:${threadsKey}`;
    lastStatusInputRef.current = input;
    if (lastStatusKeyRef.current === statusKey) {
      return;
    }
    lastStatusKeyRef.current = statusKey;
    void bridge.setTaskbarStatus(input).catch(() => {
      lastStatusKeyRef.current = null;
    });
  });

  const syncTaskbarStatus = useEffectEvent(() => {
    const runningThreads = selectRunningTaskbarThreads(useStore.getState());
    const runningKeys = new Set(runningThreads.map(taskbarThreadKey));
    const unread = unreadThreads.filter((thread) => !runningKeys.has(taskbarThreadKey(thread)));

    if (runningThreads.length > 0) {
      if (completionSettleTimerRef.current !== null) {
        clearTimeout(completionSettleTimerRef.current);
        completionSettleTimerRef.current = null;
      }
      hadRunningThreadRef.current = true;
      setTaskbarStatus({
        status: "working",
        runningThreadCount: runningThreads.length,
        localRunningThreadCount: runningThreads.filter((thread) =>
          isThreadOnPrimaryEnvironment(thread, primaryEnvironmentId),
        ).length,
        localBusyTerminalCount,
        completedThreadCount: unread.length,
        description: describeWorking(runningThreads.length),
        threads: [...unread, ...runningThreads].slice(0, TASKBAR_MENU_THREAD_LIMIT),
      });
      return;
    }

    if (hadRunningThreadRef.current) {
      // Keep showing the work until nothing has run for a moment; the next
      // turn of a handover cancels this.
      if (completionSettleTimerRef.current === null) {
        completionSettleTimerRef.current = setTimeout(() => {
          completionSettleTimerRef.current = null;
          settleTaskbarStatus();
        }, TASKBAR_COMPLETION_SETTLE_MS);
      }
      // The status waits out the settle, but what quitting would stop and
      // what keeps the computer awake can't.
      const last = lastStatusInputRef.current;
      if (
        last !== null &&
        (last.localBusyTerminalCount !== localBusyTerminalCount ||
          last.activeScheduledTaskCount !== activeScheduledTaskCount ||
          last.workingScheduledRunCount !== workingScheduledRunCount)
      ) {
        setTaskbarStatus({ ...last, localBusyTerminalCount });
      }
      return;
    }

    if (unread.length === 0) {
      setTaskbarStatus({
        status: "idle",
        description: "No threads are working",
        localBusyTerminalCount,
        threads: [],
      });
      return;
    }
    setTaskbarStatus({
      status: "completed",
      localBusyTerminalCount,
      completedThreadCount: unread.length,
      description: describeCompleted(unread.length),
      threads: unread.slice(0, TASKBAR_MENU_THREAD_LIMIT),
    });
  });

  /** Nothing has run for the settle time: say the work is done. */
  const settleTaskbarStatus = useEffectEvent(() => {
    if (selectRunningTaskbarThreads(useStore.getState()).length === 0) {
      hadRunningThreadRef.current = false;
    }
    syncTaskbarStatus();
  });

  useEffect(() => {
    syncTaskbarStatus();
  }, [
    activeScheduledTaskCount,
    localBusyTerminalCount,
    primaryEnvironmentId,
    runningThreadsSignature,
    unreadThreadsSignature,
    workingScheduledRunCount,
  ]);

  useEffect(
    () => () => {
      if (completionSettleTimerRef.current !== null) {
        clearTimeout(completionSettleTimerRef.current);
        completionSettleTimerRef.current = null;
      }
      setTaskbarStatus({ status: "idle", description: "No threads are working" });
    },
    [],
  );

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );

  useEffect(() => {
    if (getPrimaryKnownEnvironment()) {
      return;
    }

    const currentActiveEnvironmentId = useStore.getState().activeEnvironmentId;
    if (currentActiveEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = listSavedEnvironmentRecords()[0];
    if (!firstSavedEnvironment) {
      return;
    }

    useStore.getState().setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [savedEnvironmentCount]);

  return null;
}

/**
 * The hosted app has no backend of its own, so app-level server state (used by
 * settings, provider status, and extensions) mirrors the paired computer the
 * user is currently looking at. Without this those surfaces wait forever on a
 * config snapshot that can never arrive.
 */
function HostedStaticServerStateBridge() {
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const serverConfig = useSavedEnvironmentRuntimeStore((state) =>
    activeEnvironmentId ? (state.byId[activeEnvironmentId]?.serverConfig ?? null) : null,
  );

  useEffect(() => {
    if (!serverConfig) {
      clearServerConfig();
      return;
    }
    setServerConfigSnapshot(serverConfig);
  }, [serverConfig]);

  return null;
}

function RootRouteErrorView(props: ErrorComponentProps) {
  return isStaleBuildError(props.error) ? <StaleBuildErrorView /> : <RouteErrorView {...props} />;
}

/**
 * A part of the app failed to load because the page outlived its build (see
 * staleBuild.ts). Trying again can't fetch it, so this reloads on its own
 * once the app can be reached, checking again while it can't.
 */
function StaleBuildErrorView() {
  const [recovery, setRecovery] = useState<StaleBuildRecovery | "checking">("checking");

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const stopWatching = () => {
      window.clearInterval(intervalId);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", checkWhenShown);
    };
    async function check() {
      if (checking) {
        return;
      }
      checking = true;
      const next = await resolveStaleBuildRecovery();
      checking = false;
      if (disposed) {
        return;
      }
      if (next !== "unreachable") {
        stopWatching();
      }
      if (next === "reload") {
        window.location.reload();
      }
      setRecovery(next);
    }
    function checkWhenShown() {
      if (document.visibilityState === "visible") {
        void check();
      }
    }
    // While the app can't be reached: again on a timer, when the device says
    // it is back online, and when the page is shown again.
    const intervalId = window.setInterval(() => void check(), STALE_BUILD_RECHECK_MS);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", checkWhenShown);
    void check();
    return () => {
      disposed = true;
      stopWatching();
    };
  }, []);

  return recovery === "checking" || recovery === "reload" ? (
    <AppReloadingState />
  ) : (
    <AppReloadNeededState unreachable={recovery === "unreachable"} />
  );
}

function RouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function ServerStateBootstrap() {
  useEffect(() => {
    if (!getPrimaryKnownEnvironment()) {
      return;
    }

    return startServerStateSync(getPrimaryEnvironmentConnection().client.server);
  }, []);

  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

/**
 * The chat this page load opens into, so its detail is requested before any
 * other thread's: the routed thread, or on `/` the thread the launch visit
 * restores (see the index route). Null for drafts, home, settings and setup.
 * A restore target that no longer exists costs one request the shell
 * snapshot then cancels.
 */
function resolveLaunchForegroundThreadRef(
  matches: ReadonlyArray<MakeRouteMatchUnion>,
): ScopedThreadRef | null {
  const leaf = matches.at(-1);
  if (leaf?.routeId === "/_chat/$environmentId/$threadId") {
    return resolveThreadRouteRef(leaf.params);
  }
  if (leaf?.routeId !== "/_chat/" || isLaunchVisitConsumed()) {
    return null;
  }
  const environmentId =
    getPrimaryKnownEnvironment()?.environmentId ??
    useStore.getState().activeEnvironmentId ??
    listSavedEnvironmentRecords()[0]?.environmentId ??
    null;
  const entry = readLastVisitedThreadRoute(environmentId);
  return environmentId && entry?.kind === "server"
    ? scopeThreadRef(environmentId, entry.threadId as ThreadId)
    : null;
}

function EnvironmentConnectionManagerBootstrap() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    const stopConnections = startEnvironmentConnectionService(queryClient, {
      foregroundThreadRef: resolveLaunchForegroundThreadRef(router.state.matches),
    });
    // Joins waiting for a host's Allow survive restarts; pick them back up.
    const stopRelayJoins = startRelayJoinWatchers();
    // Each connected computer's links, for Fleet, the inbox's link requests
    // and Settings' linked computers.
    const stopComputerLinks = startComputerLinksSync();
    // Each connected computer's project setups, for the setup dialog, its
    // toasts and Fleet.
    const stopProjectSetups = startProjectSetupsSync();
    // Each connected computer's latest freeze or sleep, for its notice and Fleet.
    const stopComputerStalls = startComputerStallsSync();
    // Each connected computer's record of every pull request it read, which
    // every surface showing a pull request reads (pullRequestRecords.ts).
    // Pull request polls stop while nobody looks; coming back reads what went stale.
    const stopPullRequestAttention = startPullRequestAttentionRefresh(queryClient);
    // Sidebar rows on screen keep their pull requests current (pullRequestWatch.ts).
    const stopPullRequestWatch = startPullRequestWatch(queryClient);
    const stopPullRequestRecords = startPullRequestRecordsSync({
      onSettled: (environmentId, record) => {
        if (record.state === "open") return;
        markPullRequestListSettled(queryClient, { environmentId, state: record.state });
      },
    });
    // Thread rows anywhere in the shell carry `data-thread-key`. Bound here
    // rather than by the sidebar, which on a phone unmounts the moment a tap
    // closes it, mid-prewarm.
    const unbindRowIntent = bindThreadRowIntentPrewarm(document);
    return () => {
      unbindRowIntent();
      stopPullRequestRecords();
      stopPullRequestAttention();
      stopPullRequestWatch();
      stopComputerStalls();
      stopProjectSetups();
      stopComputerLinks();
      stopRelayJoins();
      stopConnections();
    };
  }, [queryClient, router]);

  return null;
}

/** Deferred past the first paint: on the way to it, these competed with it. */
function whenIdleAfterFirstPaint(task: () => void): () => void {
  let cancelIdle: (() => void) | null = null;
  const frame = window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(task, { timeout: 3_000 });
      cancelIdle = () => window.cancelIdleCallback(handle);
    } else {
      const handle = window.setTimeout(task, 500);
      cancelIdle = () => window.clearTimeout(handle);
    }
  });
  return () => {
    window.cancelAnimationFrame(frame);
    cancelIdle?.();
  };
}

/**
 * Fetches code the first interactions need once the workspace has painted:
 * the thread page, which a launch into a draft or home would otherwise wait
 * for on its first switch to a thread, the command palette's body, so the
 * first shortcut press opens it at once, the pages' sidebar lists, so the
 * first switch from the rail shows its list at once, and the bodies of the
 * dialogs the menus open (move, set up, connect, sign in) and the one an
 * outside agent's sign-in opens, so they open at once and a web deploy that
 * replaced their files can't fail a later open.
 */
function AppShellIdlePreloads() {
  const router = useRouter();
  const workspaceLoaded = useStore(selectBootstrapCompleteForActiveEnvironment);

  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    return whenIdleAfterFirstPaint(() => {
      void router
        .loadRouteChunk(router.routesById["/_chat/$environmentId/$threadId"])
        ?.catch(() => undefined);
      preloadCommandPaletteDialog();
      preloadDestinationLists();
      void preloadThreadMoveDialog();
      void preloadProjectSetupDialog();
      void preloadConnectComputerDialog();
      void preloadProviderSignInDialog();
      void preloadOutsideAgentDialog();
    });
  }, [router, workspaceLoaded]);

  return null;
}

function EventRouter() {
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const serverConfig = useServerConfig();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    // Once the config stream has spoken it names the computer, in order; a
    // welcome may predate a rename since.
    const configured = getServerConfig()?.environment;
    updatePrimaryEnvironmentDescriptor(
      configured?.environmentId === payload.environment.environmentId
        ? configured
        : payload.environment,
    );
    setActiveEnvironmentId(payload.environment.environmentId);
    void refreshSourceControlDiscoveryAfterReconnect({
      environmentId: payload.environment.environmentId,
    });
    void (async () => {
      await ensureEnvironmentConnectionBootstrapped(payload.environment.environmentId);
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapEnvironmentState =
        useStore.getState().environmentStateById[payload.environment.environmentId];
      const bootstrapProject =
        bootstrapEnvironmentState?.projectById[payload.bootstrapProjectId] ?? null;
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "keybindings.json has a mistake",
          description: issue.message,
          actionVariant: "outline",
          actionProps: {
            children: "Open keybindings.json",
            onClick: () => {
              const api = readLocalApi();
              if (!api) {
                return;
              }

              void Promise.resolve(serverConfig ?? api.server.getConfig())
                .then((config) => {
                  const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                  if (!editor) {
                    throw new Error("No available editors found.");
                  }
                  return api.shell.openInEditor(config.keybindingsConfigPath, editor);
                })
                .catch((error) => {
                  toastManager.add(
                    failureNotice({
                      title: "Couldn't open keybindings.json",
                      error,
                    }),
                  );
                });
            },
          },
        }),
      );
    },
  );

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    updatePrimaryEnvironmentDescriptor(serverConfig.environment);
    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig, setActiveEnvironmentId]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
