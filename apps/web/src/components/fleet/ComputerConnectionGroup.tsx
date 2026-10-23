import type { EnvironmentId } from "@threadlines/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import {
  cancelPendingRelayJoin,
  disconnectSavedEnvironmentByUser,
  reconnectSavedEnvironment,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  ConnectionStatusDot,
  formatAccessTimestamp,
} from "../settings/connections/ConnectionStatusDot";
import { openConnectComputerDialog } from "../settings/connections/JoinComputerDialog";
import { formatDesktopSshTarget } from "../settings/connections/sshTarget";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** "Connected for 3m", or "Connected just now" in its first seconds. */
function connectedForLabel(since: string, nowMs: number): string {
  const elapsed = formatElapsedDurationLabel(since, nowMs);
  return elapsed === "just now" ? "Connected just now" : `Connected for ${elapsed}`;
}

function statusTooltip(
  runtime: SavedEnvironmentRuntimeState | null,
  record: SavedEnvironmentRecord,
  nowMs: number,
): string | null {
  const connectionState = runtime?.connectionState ?? "disconnected";
  if (connectionState === "connected") {
    const connectedAt = runtime?.connectedAt ?? record.lastConnectedAt;
    return connectedAt ? connectedForLabel(connectedAt, nowMs) : null;
  }
  if (connectionState === "connecting") return null;
  if (connectionState === "error") {
    return runtime?.lastError ?? "An unknown connection error occurred.";
  }
  return record.lastConnectedAt
    ? `Last connected at ${formatAccessTimestamp(record.lastConnectedAt)}`
    : "Not connected yet.";
}

async function runConnectionAction(
  action: () => Promise<void>,
  failure: { readonly title: string; readonly fallback: string },
): Promise<void> {
  try {
    await action();
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failure.title,
        description: error instanceof Error ? error.message : failure.fallback,
      }),
    );
  }
}

/**
 * A saved computer's Connection group on its Fleet page: every piece of the
 * row Settings › Connections used to show (docs/design/fleet.md, R4.2). Its
 * live state, how this app reaches it (the route, the SSH target), when it
 * was last connected and the last problem in plain words; a version warning;
 * Disconnect, or Stop trying while the app waits for a computer that didn't
 * answer, both keeping it saved; Reconnect; "Connect again with a new code"
 * once that computer removed this app's access; and while it is still being
 * added, the number to compare and Cancel.
 */
export function ComputerConnectionGroup({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const nowMs = useRelativeTimeTick(30_000);
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "cancel" | null>(null);
  if (record === null) return null;

  const relayLink = record.relay && "version" in record.relay ? record.relay : null;
  const pending = relayLink?.pendingRequest ?? null;
  const connectionState = runtime?.connectionState ?? "disconnected";
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || busy === "connect";
  const isWaitingToReconnect =
    !isConnected && !isConnecting && runtime?.waitingToReconnect === true;
  const canDisconnect = isConnected || isWaitingToReconnect;
  const displayLabel = record.label.trim() || runtime?.descriptor?.label || "this computer";
  const versionMismatch = resolveServerConfigVersionMismatch(runtime?.serverConfig);
  // A code-joined computer that removed this app needs a new code, not a retry.
  const needsNewCode = relayLink !== null && !pending && runtime?.authState === "requires-auth";

  const dotClassName = pending
    ? "bg-amber-400"
    : isConnected
      ? "bg-success"
      : connectionState === "connecting"
        ? "bg-warning"
        : connectionState === "error" || runtime?.authState === "requires-auth"
          ? "bg-destructive"
          : "bg-muted-foreground/40";

  const title = pending
    ? "Waiting for approval"
    : needsNewCode
      ? "Access removed"
      : isConnected
        ? "Connected"
        : isConnecting
          ? "Connecting"
          : isWaitingToReconnect
            ? "Not answering"
            : "Not connected";
  // How this app reaches it while connected, as the page's header says it.
  const route = !isConnected
    ? null
    : runtime?.route === "direct"
      ? "On your network"
      : runtime?.route === "relay"
        ? "Through the relay"
        : record.relay && !relayLink
          ? "Old phone link"
          : null;
  const lastConnected = record.lastConnectedAt
    ? `Last connected ${formatRelativeTimeLabel(record.lastConnectedAt, nowMs)}`
    : "Not connected yet";
  const description = pending
    ? pending.matchNumber
      ? `Waiting for ${displayLabel} to allow this app. Check it shows ${pending.matchNumber}.`
      : `Waiting for ${displayLabel} to allow this app.`
    : needsNewCode
      ? `${displayLabel} removed this app's access. Connect again with a new code from ${displayLabel}.`
      : [
          isConnected
            ? runtime?.connectedAt
              ? connectedForLabel(runtime.connectedAt, nowMs)
              : "Connected now"
            : lastConnected,
          route,
          record.desktopSsh ? `SSH ${formatDesktopSshTarget(record.desktopSsh)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const lastError = !isConnected && !pending ? (runtime?.lastError ?? null) : null;

  const controls = pending ? (
    <Button
      size="xs"
      variant="outline"
      disabled={busy !== null}
      onClick={() => {
        setBusy("cancel");
        void runConnectionAction(() => cancelPendingRelayJoin(environmentId), {
          title: "Could not cancel",
          fallback: "Failed to cancel.",
        }).finally(() => setBusy(null));
      }}
    >
      Cancel
    </Button>
  ) : needsNewCode ? (
    <Button size="xs" variant="outline" onClick={openConnectComputerDialog}>
      Connect again with a new code
    </Button>
  ) : (
    <Button
      size="xs"
      variant="outline"
      data-testid="fleet-connection-action"
      disabled={canDisconnect ? busy === "disconnect" : isConnecting}
      onClick={() => {
        if (canDisconnect) {
          setBusy("disconnect");
          void runConnectionAction(() => disconnectSavedEnvironmentByUser(environmentId), {
            title: "Could not disconnect",
            fallback: "Failed to disconnect.",
          }).finally(() => setBusy(null));
          return;
        }
        setBusy("connect");
        void runConnectionAction(() => reconnectSavedEnvironment(environmentId), {
          title: "Could not connect",
          fallback: "Failed to connect.",
        }).finally(() => setBusy(null));
      }}
    >
      {isConnected
        ? busy === "disconnect"
          ? "Disconnecting…"
          : "Disconnect"
        : isWaitingToReconnect
          ? busy === "disconnect"
            ? "Stopping…"
            : "Stop trying"
          : isConnecting
            ? "Connecting…"
            : "Reconnect"}
    </Button>
  );

  return (
    <SettingsSection title="Connection" data-testid="fleet-connection-group">
      <SettingsRow
        title={
          <span className="flex items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip(runtime, record, nowMs)}
              dotClassName={dotClassName}
              pingClassName={isConnecting && !pending ? "bg-warning/60 duration-2000" : null}
            />
            {title}
          </span>
        }
        description={description}
        status={
          lastError || versionMismatch ? (
            <span className="flex flex-col gap-1">
              {lastError ? <span className="text-destructive-foreground">{lastError}</span> : null}
              {versionMismatch ? (
                <span className="flex items-center gap-1 text-warning">
                  <TriangleAlertIcon className="size-3.5 shrink-0" />
                  It runs Threadlines {versionMismatch.serverVersion} and this app runs{" "}
                  {versionMismatch.clientVersion}. Update both if things act up.
                </span>
              ) : null}
            </span>
          ) : null
        }
        control={controls}
      />
    </SettingsSection>
  );
}
