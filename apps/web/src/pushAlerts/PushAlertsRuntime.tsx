/**
 * Mounted once at the root. Keeps this phone registered for alerts with every
 * paired computer (pushAlerts.ts), opens an alert's thread in this window when
 * the service worker asks, and tells the open thread's computer that someone
 * is looking at it, so that thread stays quiet meanwhile. Presence comes from
 * every client, the desktop app too: a thread open on the Mac shouldn't buzz
 * the phone.
 */
import type { ThreadId } from "@threadlines/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  readEnvironmentConnection,
  readEnvironmentDescriptor,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { isPageAttended, onPageAttentionChange } from "../lib/pageAttention";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { startPushAlerts } from "./pushAlerts";

/** How often an open thread's presence is renewed; the computer's lease is 90 s. */
const PRESENCE_RENEW_MS = 30_000;

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
  const [attended, setAttended] = useState(isPageAttended);
  useEffect(() => onPageAttentionChange(() => setAttended(isPageAttended())), []);

  useEffect(() => {
    if (environmentId === null || threadId === null || !attended) return;
    const report = (viewing: ThreadId | null) => {
      if (readEnvironmentDescriptor(environmentId)?.capabilities.pushAlerts !== true) return;
      void readEnvironmentConnection(environmentId)
        ?.client.presence.setViewing({ threadId: viewing })
        .catch(() => undefined);
    };
    report(threadId);
    const renew = setInterval(() => report(threadId), PRESENCE_RENEW_MS);
    // A reconnect starts a new connection, which the computer knows nothing about yet.
    const stopWatching = subscribeEnvironmentConnections(() => report(threadId));
    return () => {
      clearInterval(renew);
      stopWatching();
      report(null);
    };
  }, [environmentId, threadId, attended]);
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
  return null;
}
