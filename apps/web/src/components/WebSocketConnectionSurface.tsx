import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  type WsConnectionUiState,
  useWsConnectionStatus,
} from "../rpc/wsConnectionState";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
const RECONNECT_TOAST_GRACE_MS = 10_000;
type WsAutoReconnectTrigger = "focus" | "online";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function formatConnectionMoment(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function parseConnectionMomentMs(isoDate: string | null): number | null {
  if (!isoDate) {
    return null;
  }

  const timestamp = new Date(isoDate).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

function describeOfflineToast(): string {
  return "WebSocket disconnected. Waiting for network.";
}

function formatReconnectAttemptLabel(status: WsConnectionStatus): string {
  return `Attempt ${Math.max(1, status.reconnectAttemptCount)}`;
}

function getConnectionDisplayName(status: WsConnectionStatus): string {
  return status.connectionLabel?.trim() || "Threadlines Server";
}

function buildReconnectTitle(status: WsConnectionStatus): string {
  return `Disconnected from ${getConnectionDisplayName(status)}`;
}

function buildRecoveredTitle(status: WsConnectionStatus): string {
  return `Reconnected to ${getConnectionDisplayName(status)}`;
}

function describeRecoveredToast(
  previousDisconnectedAt: string | null,
  connectedAt: string | null,
): string {
  const reconnectedAtLabel = formatConnectionMoment(connectedAt);
  const disconnectedAtLabel = formatConnectionMoment(previousDisconnectedAt);

  if (disconnectedAtLabel && reconnectedAtLabel) {
    return `Disconnected at ${disconnectedAtLabel} and reconnected at ${reconnectedAtLabel}.`;
  }

  if (reconnectedAtLabel) {
    return `Connection restored at ${reconnectedAtLabel}.`;
  }

  return "Connection restored.";
}

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return uiState === "offline" || uiState === "reconnecting" || uiState === "error";
  }

  return status.online && status.hasConnected && uiState === "reconnecting";
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

export function shouldShowReconnectIssueToast(status: WsConnectionStatus, nowMs: number): boolean {
  const disconnectedAtMs = parseConnectionMomentMs(status.disconnectedAt);
  return (
    status.hasConnected &&
    disconnectedAtMs !== null &&
    nowMs - disconnectedAtMs >= RECONNECT_TOAST_GRACE_MS &&
    getWsConnectionUiState(status) === "reconnecting"
  );
}

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastForcedReconnectAtRef = useRef(0);
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const toastResetTimerRef = useRef<number | null>(null);
  const hasShownConnectionIssueToastRef = useRef(false);
  const previousUiStateRef = useRef<WsConnectionUiState>(getWsConnectionUiState(status));
  const previousDisconnectedAtRef = useRef<string | null>(status.disconnectedAt);

  const runReconnect = useEffectEvent((showFailureToast: boolean) => {
    if (toastResetTimerRef.current !== null) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
        if (!showFailureToast) {
          console.warn("Automatic WebSocket reconnect failed", { error });
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Reconnect failed",
            description:
              error instanceof Error ? error.message : "Unable to restart the WebSocket.",
            data: {
              dismissAfterVisibleMs: 8_000,
              hideCopyButton: true,
            },
          }),
        );
      });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerManualReconnect = useEffectEvent(() => {
    runReconnect(true);
  });
  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect(false);
  });

  useEffect(() => {
    const handleOnline = () => {
      triggerAutoReconnect("online");
    };
    const handleFocus = () => {
      triggerAutoReconnect("focus");
    };

    syncBrowserOnlineStatus();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", syncBrowserOnlineStatus);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", syncBrowserOnlineStatus);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status.nextRetryAt, status.reconnectPhase]);

  useEffect(() => {
    if (
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect(false);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    status.hasConnected,
    status.nextRetryAt,
    status.online,
    status.reconnectAttemptCount,
    status.reconnectPhase,
  ]);

  useEffect(() => {
    const uiState = getWsConnectionUiState(status);
    const previousUiState = previousUiStateRef.current;
    const previousDisconnectedAt = previousDisconnectedAtRef.current;
    const shouldShowReconnectToast = shouldShowReconnectIssueToast(status, nowMs);
    const shouldShowOfflineToast = uiState === "offline" && status.disconnectedAt !== null;

    if (
      toastResetTimerRef.current !== null &&
      (shouldShowReconnectToast || shouldShowOfflineToast)
    ) {
      window.clearTimeout(toastResetTimerRef.current);
      toastResetTimerRef.current = null;
    }

    if (shouldShowReconnectToast || shouldShowOfflineToast) {
      hasShownConnectionIssueToastRef.current = true;
      const toastPayload = shouldShowOfflineToast
        ? stackedThreadToast({
            data: {
              hideCopyButton: true,
            },
            description: describeOfflineToast(),
            timeout: 0,
            title: "Offline",
            type: "warning",
          })
        : stackedThreadToast({
            actionProps: {
              children: "Retry now",
              onClick: triggerManualReconnect,
            },
            data: {
              hideCopyButton: true,
            },
            description:
              status.nextRetryAt === null
                ? `Reconnecting... ${formatReconnectAttemptLabel(status)}`
                : `Reconnecting in ${formatRetryCountdown(status.nextRetryAt, nowMs)}... ${formatReconnectAttemptLabel(status)}`,
            timeout: 0,
            title: buildReconnectTitle(status),
            type: "loading",
          });

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, toastPayload);
      } else {
        toastIdRef.current = toastManager.add(toastPayload);
      }
    } else if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }

    if (
      uiState === "connected" &&
      hasShownConnectionIssueToastRef.current &&
      (previousUiState === "offline" || previousUiState === "reconnecting") &&
      previousDisconnectedAt !== null
    ) {
      const successToast = {
        description: describeRecoveredToast(previousDisconnectedAt, status.connectedAt),
        title: buildRecoveredTitle(status),
        type: "success" as const,
        timeout: 0,
        data: {
          dismissAfterVisibleMs: 8_000,
          hideCopyButton: true,
        },
      };

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, successToast);
      } else {
        toastIdRef.current = toastManager.add(successToast);
      }
      hasShownConnectionIssueToastRef.current = false;

      toastResetTimerRef.current = window.setTimeout(() => {
        toastIdRef.current = null;
        toastResetTimerRef.current = null;
      }, 8_250);
    } else if (uiState === "connected") {
      hasShownConnectionIssueToastRef.current = false;
    }

    previousUiStateRef.current = uiState;
    previousDisconnectedAtRef.current = status.disconnectedAt;
  }, [nowMs, status]);

  useEffect(() => {
    return () => {
      if (toastResetTimerRef.current !== null) {
        window.clearTimeout(toastResetTimerRef.current);
      }
    };
  }, []);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
