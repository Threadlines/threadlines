import type { ServerProvider } from "@threadlines/contracts";
import { useMemo } from "react";

import { resolveSignInEndsWarning, type SignInEndsWarning } from "../lib/signInEnds";

/**
 * The warning that `provider`'s saved sign-in is about to end, or null. It
 * counts in days, so the time of the provider's last check (every few
 * minutes) serves as "now", and each fresh check moves it along.
 */
export function useSignInEndsWarning(
  provider: Pick<ServerProvider, "instanceId" | "auth" | "checkedAt"> | null | undefined,
): SignInEndsWarning | null {
  const instanceId = provider?.instanceId;
  const signInEnds = provider?.auth.signInEnds;
  const checkedAt = provider?.checkedAt;
  return useMemo(() => {
    const nowMs = checkedAt === undefined ? Number.NaN : Date.parse(checkedAt);
    return instanceId === undefined || !Number.isFinite(nowMs)
      ? null
      : resolveSignInEndsWarning({ instanceId, signInEnds, nowMs });
  }, [checkedAt, instanceId, signInEnds]);
}
