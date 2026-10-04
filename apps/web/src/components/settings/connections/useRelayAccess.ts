import type { RelayAccessSnapshot } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { getPrimaryEnvironmentConnection } from "~/environments/runtime";

/**
 * Live "Connect a device" state for this computer (open code, join requests
 * with their match numbers, today's relay use). Owner sessions only; returns
 * null until the first snapshot or when `enabled` is false.
 */
export function useRelayAccess(enabled: boolean): RelayAccessSnapshot | null {
  const [snapshot, setSnapshot] = useState<RelayAccessSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return getPrimaryEnvironmentConnection().client.relay.subscribeAccess((next) => {
      setSnapshot(next);
    });
  }, [enabled]);

  return enabled ? snapshot : null;
}

/** "9:58" countdown for a deadline, or null once it has passed. */
export function formatCountdown(deadlineIso: string, nowMs: number): string | null {
  const remainingMs = Date.parse(deadlineIso) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
