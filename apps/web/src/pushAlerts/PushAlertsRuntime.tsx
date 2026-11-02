/**
 * Mounted once at the root. Keeps this phone registered for alerts with every
 * paired computer (pushAlerts.ts), opens an alert's thread in this window when
 * the service worker asks, and tells the open thread's computer that someone
 * is looking at it, so that thread stays quiet meanwhile. Presence comes from
 * every client, the desktop app too: a thread open on the Mac shouldn't buzz
 * the phone. A computer's window also says when it's in use, for phones that
 * stay quiet meanwhile; it can only tell computers it's connected to, which are
 * the ones whose threads it can show.
 */
import type { ThreadId } from "@threadlines/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  listEnvironmentConnections,
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { isPageInUse, onPageUseChange, pageIdleMs, usePageInUse } from "../lib/pageAttention";
import { joinerKindForThisBrowser } from "../relayDevice";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { startPushAlerts } from "./pushAlerts";

/** How often an open thread's presence is renewed; the computer's lease is 90 s. */
const PRESENCE_RENEW_MS = 30_000;
/** How often a window in use says so; the computer holds it for COMPUTER_IN_USE_MS. */
const ACTIVITY_REPORT_MS = 30_000;

function usePresenceReporting() {
  const threadRef = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "server" ? target.threadRef : null;
    },
  });
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  // Null while the thread's computer is unreachable, and a new value on each
  // reconnect: a new connection knows nothing of what this window shows yet.
  const savedConnectionState = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.connectionState ?? null),
  );
  const primaryConnectedAt = useWsConnectionStatus().connectedAt;
  const connectedSince =
    savedConnectionState === null
      ? primaryConnectedAt
      : savedConnectionState === "connected"
        ? "connected"
        : null;
  const inUse = usePageInUse();

  useEffect(() => {
    if (environmentId === null || threadId === null || !inUse || connectedSince === null) {
      return;
    }
    const report = (viewing: ThreadId | null) => {
      if (readEnvironmentDescriptor(environmentId)?.capabilities.pushAlerts !== true) return;
      void readEnvironmentConnection(environmentId)
        ?.client.presence.setViewing({ threadId: viewing })
        .catch(() => undefined);
    };
    report(threadId);
    const renew = setInterval(() => report(threadId), PRESENCE_RENEW_MS);
    // A saved computer's connection is registered a moment after it says it's
    // connected: report again once it is.
    const stopWatching = subscribeEnvironmentConnections(() => report(threadId));
    return () => {
      clearInterval(renew);
      stopWatching();
      report(null);
    };
  }, [environmentId, threadId, inUse, connectedSince]);
}

/**
 * Tells every computer this window is connected to that it's in use: when it
 * starts, while it goes on, and to each connection that comes along, since one
 * that dropped was still in use and a restarted computer has forgotten.
 */
function useActivityReporting() {
  useEffect(() => {
    // Only a computer's use counts: the server checks, this saves a phone the traffic.
    if (joinerKindForThisBrowser() !== "browser") return;
    let reportedAt = 0;
    const report = () => {
      if (!isPageInUse()) return;
      reportedAt = Date.now();
      const idleMs = pageIdleMs();
      for (const connection of listEnvironmentConnections()) {
        const capable =
          readEnvironmentDescriptor(connection.environmentId)?.capabilities.phoneAlertControls ===
          true;
        if (capable) void connection.client.presence.noteActive({ idleMs }).catch(() => undefined);
      }
    };
    report();
    const timer = setInterval(() => {
      // Nothing new since the last report: the computer already knows.
      if (Date.now() - pageIdleMs() > reportedAt) report();
    }, ACTIVITY_REPORT_MS);
    const stopUse = onPageUseChange(report);
    const stopConnections = subscribeEnvironmentConnections(report);
    return () => {
      clearInterval(timer);
      stopUse();
      stopConnections();
    };
  }, []);
}

export function PushAlertsRuntime() {
  const router = useRouter();
  useEffect(() => startPushAlerts(), []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { readonly type?: unknown; readonly url?: unknown } | null;
      if (data?.type !== "threadlines:navigate" || typeof data.url !== "string") return;
      const url = new URL(data.url, window.location.origin);
      if (url.origin !== window.location.origin) return;
      event.ports[0]?.postMessage(true);
      router.history.push(`${url.pathname}${url.search}${url.hash}`);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  usePresenceReporting();
  useActivityReporting();
  return null;
}
