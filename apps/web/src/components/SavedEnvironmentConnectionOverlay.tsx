import { useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import {
  markRelaySavedEnvironmentLinkExpired,
  readRelayDeviceCredentials,
  readSavedEnvironmentBearerToken,
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "../environments/runtime";
import { probeRelayDeviceStatus, type RelayDeviceStatusProbe } from "../relayDevice";
import {
  assessRelaySessionProbe,
  probeRelaySessionStatus,
  type RelaySessionStatusProbe,
} from "../relaySessionStatus";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

// Hides the overlay during the initial connect and brief reconnect blips so
// it only takes over the screen when the connection is genuinely gone.
export const OVERLAY_INITIAL_GRACE_MS = 1_500;
export const OVERLAY_RECONNECT_GRACE_MS = 4_000;
const RELAY_STATUS_PROBE_INTERVAL_MS = 10_000;

export type SavedEnvironmentOverlayPhase =
  | "hidden"
  | "connecting"
  | "reconnecting"
  | "desktop-offline"
  | "browser-offline"
  | "link-expired"
  | "access-removed"
  | "daily-limit"
  | "relay-busy"
  | "awaiting-approval";

export interface SavedEnvironmentOverlayInput {
  readonly connectionState: SavedEnvironmentRuntimeState["connectionState"];
  readonly authState: SavedEnvironmentRuntimeState["authState"];
  readonly online: boolean;
  readonly hasConnectedThisLoad: boolean;
  readonly msSinceDisconnect: number;
  /** Old (v1) phone-link session probe. */
  readonly probe: RelaySessionStatusProbe | null;
  /** "Connect a device" (v2) device probe. */
  readonly deviceProbe?: RelayDeviceStatusProbe | null;
  /** A code join still waiting for the host to click Allow. */
  readonly awaitingApproval?: boolean;
}

export function deriveSavedEnvironmentOverlayPhase(
  input: SavedEnvironmentOverlayInput,
): SavedEnvironmentOverlayPhase {
  if (input.connectionState === "connected") {
    return "hidden";
  }

  if (input.awaitingApproval) {
    return "awaiting-approval";
  }

  const probeAssessment = assessRelaySessionProbe(input.probe);
  const device = input.deviceProbe ?? null;

  // Terminal states surface immediately; waiting out the grace period would
  // just delay telling the user they need to re-pair.
  if (device?.kind === "status" && device.status.revoked) {
    return "access-removed";
  }
  if (
    input.authState === "requires-auth" ||
    probeAssessment === "link-invalid" ||
    device?.kind === "unauthorized"
  ) {
    return "link-expired";
  }
  if (device?.kind === "status" && device.status.limited) {
    return "daily-limit";
  }
  if (device?.kind === "status" && device.status.relayBusy) {
    return "relay-busy";
  }

  const graceMs = input.hasConnectedThisLoad
    ? OVERLAY_RECONNECT_GRACE_MS
    : OVERLAY_INITIAL_GRACE_MS;
  if (input.msSinceDisconnect < graceMs) {
    return "hidden";
  }

  if (!input.online) {
    return "browser-offline";
  }

  if (
    probeAssessment === "desktop-offline" ||
    (device?.kind === "status" && !device.status.hostOnline)
  ) {
    return "desktop-offline";
  }

  return input.hasConnectedThisLoad ? "reconnecting" : "connecting";
}

interface OverlayCopy {
  readonly title: string;
  readonly description: string;
  readonly showSpinner: boolean;
  readonly showRetry: boolean;
}

export function describeSavedEnvironmentOverlay(
  phase: Exclude<SavedEnvironmentOverlayPhase, "hidden">,
  input: { readonly label: string; readonly isRelay: boolean; readonly matchNumber?: string },
): OverlayCopy {
  const target = input.isRelay ? "your computer" : input.label;
  switch (phase) {
    case "awaiting-approval":
      return {
        title: `Waiting for ${input.label}`,
        description: input.matchNumber
          ? `On your computer, check that it shows ${input.matchNumber}, then click Allow.`
          : "On your computer, click Allow.",
        showSpinner: true,
        showRetry: false,
      };
    case "connecting":
      return {
        title: `Connecting to ${input.label}`,
        description: input.isRelay
          ? "Reaching your computer through the Threadlines relay."
          : "Reaching this backend.",
        showSpinner: true,
        showRetry: false,
      };
    case "reconnecting":
      return {
        title: "Connection lost",
        description: `Reconnecting to ${target} automatically. You can keep this page open — it will resume on its own.`,
        showSpinner: true,
        showRetry: true,
      };
    case "desktop-offline":
      return {
        title: `Can't reach ${input.isRelay ? "your computer" : input.label}`,
        description: `${input.label} may be asleep, off, or offline. Open Threadlines on it and this page will reconnect on its own.`,
        showSpinner: true,
        showRetry: true,
      };
    case "access-removed":
      return {
        title: `${input.label} removed this device`,
        description:
          "To connect again, open Threadlines on your computer, go to Settings › Connections › Connect a device, and scan the new QR code.",
        showSpinner: false,
        showRetry: false,
      };
    case "daily-limit":
      return {
        title: "Today's relay allowance is used up",
        description: `${input.label} used its free relay time for today. It resets at midnight UTC. On the same network? Turn on Same network on your computer for unlimited use.`,
        showSpinner: false,
        showRetry: true,
      };
    case "relay-busy":
      return {
        title: "The relay is busy",
        description: "Too many people are using the free relay today. Try again later.",
        showSpinner: false,
        showRetry: true,
      };
    case "browser-offline":
      return {
        title: "You're offline",
        description: "Waiting for a network connection on this device.",
        showSpinner: true,
        showRetry: false,
      };
    case "link-expired":
      return {
        title: input.isRelay ? "This link doesn't work anymore" : "Pairing expired",
        description: input.isRelay
          ? "On your computer, open Threadlines, go to Settings › Connections › Connect a device, and scan the new QR code."
          : "The saved credential for this backend is no longer valid. Pair it again.",
        showSpinner: false,
        showRetry: false,
      };
  }
}

/**
 * Full-screen connection surface for hosted (phone) sessions, where the saved
 * environment is the only content source. Without it, a dead relay session
 * renders as an empty shell with no messaging at all.
 */
export function SavedEnvironmentConnectionOverlay() {
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const record: SavedEnvironmentRecord | null = useSavedEnvironmentRegistryStore((state) =>
    activeEnvironmentId === null ? null : (state.byId[activeEnvironmentId] ?? null),
  );
  const runtime: SavedEnvironmentRuntimeState | null = useSavedEnvironmentRuntimeStore((state) =>
    activeEnvironmentId === null ? null : (state.byId[activeEnvironmentId] ?? null),
  );

  const connectionState = runtime?.connectionState ?? "disconnected";
  const isConnected = connectionState === "connected";
  const hasConnectedThisLoad = runtime?.connectedAt != null || isConnected;
  const relay = record?.relay ?? null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [probe, setProbe] = useState<RelaySessionStatusProbe | null>(null);
  const [deviceProbe, setDeviceProbe] = useState<RelayDeviceStatusProbe | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const notConnectedSinceRef = useRef<number | null>(null);
  const expiredHandledRef = useRef(false);

  useEffect(() => {
    const syncOnline = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  useEffect(() => {
    if (isConnected || record === null) {
      notConnectedSinceRef.current = null;
      setProbe(null);
      setDeviceProbe(null);
      return;
    }

    notConnectedSinceRef.current ??= Date.now();
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [isConnected, record === null]);

  const relayOrigin = relay?.relayOrigin ?? null;
  const relaySessionId = relay && "sessionId" in relay ? relay.sessionId : null;
  const pendingApproval = relay && "version" in relay ? (relay.pendingRequest ?? null) : null;
  const relayDevice =
    relay && "version" in relay && !relay.pendingRequest
      ? { hostId: relay.hostId, deviceId: relay.deviceId }
      : null;
  const relayHostId = relayDevice?.hostId ?? null;
  const relayDeviceId = relayDevice?.deviceId ?? null;
  const shouldProbe =
    activeEnvironmentId !== null &&
    relayOrigin !== null &&
    (relaySessionId !== null || relayDeviceId !== null) &&
    !isConnected &&
    online;

  useEffect(() => {
    if (!shouldProbe || activeEnvironmentId === null || !relayOrigin) {
      return;
    }

    let disposed = false;
    const controller = new AbortController();
    const runProbe = async () => {
      if (relayHostId && relayDeviceId) {
        // Only the relay secret goes to the relay; the device's end-to-end
        // key stays on this device.
        const credentials = await readRelayDeviceCredentials(activeEnvironmentId).catch(() => null);
        if (!credentials || disposed) return;
        const result = await probeRelayDeviceStatus({
          relayOrigin,
          hostId: relayHostId,
          deviceId: relayDeviceId,
          deviceSecret: credentials.deviceSecret,
          signal: controller.signal,
        });
        if (!disposed) setDeviceProbe(result);
        return;
      }
      const token = await readSavedEnvironmentBearerToken(activeEnvironmentId).catch(() => null);
      if (!token || disposed || !relaySessionId) return;
      const result = await probeRelaySessionStatus({
        relayOrigin,
        sessionId: relaySessionId,
        token,
        signal: controller.signal,
      });
      if (!disposed) {
        setProbe(result);
      }
    };

    void runProbe();
    const intervalId = window.setInterval(() => void runProbe(), RELAY_STATUS_PROBE_INTERVAL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [shouldProbe, activeEnvironmentId, relayOrigin, relaySessionId, relayHostId, relayDeviceId]);

  const phase =
    record === null
      ? "hidden"
      : deriveSavedEnvironmentOverlayPhase({
          connectionState,
          authState: runtime?.authState ?? "unknown",
          online,
          hasConnectedThisLoad,
          msSinceDisconnect:
            notConnectedSinceRef.current === null ? 0 : nowMs - notConnectedSinceRef.current,
          probe,
          deviceProbe,
          awaitingApproval: pendingApproval !== null,
        });

  useEffect(() => {
    if (phase !== "link-expired") {
      expiredHandledRef.current = false;
      return;
    }
    if (expiredHandledRef.current || activeEnvironmentId === null) {
      return;
    }
    expiredHandledRef.current = true;
    if (relaySessionId !== null && runtime?.authState !== "requires-auth") {
      // Stop the transport from retrying a handshake that can never succeed.
      void markRelaySavedEnvironmentLinkExpired(activeEnvironmentId);
    }
  }, [phase, activeEnvironmentId, relay !== null, runtime?.authState]);

  if (phase === "hidden" || record === null) {
    return null;
  }

  const copy = describeSavedEnvironmentOverlay(phase, {
    label: record.label,
    isRelay: relay !== null,
    ...(pendingApproval ? { matchNumber: pendingApproval.matchNumber } : {}),
  });

  const handleRetry = () => {
    if (activeEnvironmentId === null || isRetrying) {
      return;
    }
    setIsRetrying(true);
    setProbe(null);
    setDeviceProbe(null);
    void reconnectSavedEnvironment(activeEnvironmentId)
      .catch(() => undefined)
      .finally(() => setIsRetrying(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_12%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <div className="mt-3 flex items-center gap-3">
          {copy.showSpinner ? <Spinner className="size-5 shrink-0 text-muted-foreground" /> : null}
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{copy.title}</h1>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.description}</p>

        {runtime?.lastError && phase !== "link-expired" ? (
          <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            {runtime.lastError}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          {copy.showRetry ? (
            <Button disabled={isRetrying} onClick={handleRetry} size="sm">
              {isRetrying ? "Retrying..." : "Retry now"}
            </Button>
          ) : null}
          <Button onClick={() => window.location.reload()} size="sm" variant="outline">
            Reload app
          </Button>
        </div>
      </section>
    </div>
  );
}
