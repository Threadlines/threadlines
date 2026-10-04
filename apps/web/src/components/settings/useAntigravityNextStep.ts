import type { ProviderInstanceId } from "@threadlines/contracts";
import {
  type AntigravityNextStep,
  antigravityNextStep,
  readAntigravitySignInSetup,
} from "@threadlines/shared/antigravitySignIn";
import { ANTIGRAVITY_DRIVER_KIND } from "@threadlines/shared/providerAuthCommands";
import { useMemo } from "react";

import { useSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import { deriveMaintainedProviderRows } from "./providerEnablement";

/**
 * An Antigravity instance's next sign-in step, for surfaces that only know
 * the instance id (composer notices): run its sign-in or check, or open its
 * Account tab when only a field there can fix it. `null` for other agents.
 */
export function useAntigravityNextStep(
  instanceId: ProviderInstanceId | null,
): AntigravityNextStep | null {
  const settings = useSettings();
  const providers = useServerProviders();
  return useMemo(() => {
    if (instanceId === null) return null;
    const row = deriveMaintainedProviderRows(settings).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!row || String(row.driver) !== ANTIGRAVITY_DRIVER_KIND) return null;
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    return antigravityNextStep({
      setup: readAntigravitySignInSetup(row.instance),
      ...(snapshot ? { snapshot } : {}),
    });
  }, [instanceId, providers, settings]);
}
