import type { ProviderInstanceConfig, ProviderInstanceId } from "@threadlines/contracts";
import {
  type AntigravityNextStep,
  antigravityAuthMethodInfo,
  antigravityNextStep,
  readAntigravitySignInSetup,
} from "@threadlines/shared/antigravitySignIn";
import {
  ANTIGRAVITY_DRIVER_KIND,
  GROK_DRIVER_KIND,
} from "@threadlines/shared/providerAuthCommands";
import { useMemo } from "react";

import { useSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import {
  grokAuthMethodInfo,
  grokNextStep,
  type GrokNextStep,
  readGrokSignInSetup,
} from "./grokSignIn.logic";
import { deriveMaintainedProviderRows } from "./providerEnablement";

/**
 * The next sign-in step of an agent whose sign-in follows a method picked on
 * its Account tab (Antigravity, Grok): run its sign-in or check (`run`), or
 * open the Account tab when only a field there can fix it (`settings`).
 * `hint` says what that field wants, where there is room to say it.
 */
export interface SignInNextStep {
  readonly kind: (AntigravityNextStep | GrokNextStep)["kind"];
  readonly label: string;
  readonly hint?: string | undefined;
}

/** The instance's next step, or `null` for agents without a method choice. */
export function signInNextStep(input: {
  readonly driverKind: string | null;
  readonly instance: Pick<ProviderInstanceConfig, "config" | "environment">;
  /** The instance's last status, when there is one. */
  readonly snapshot?:
    | {
        readonly status: string;
        readonly auth: { readonly status: string; readonly type?: string | undefined };
      }
    | undefined;
}): SignInNextStep | null {
  switch (input.driverKind) {
    case ANTIGRAVITY_DRIVER_KIND:
      return antigravityNextStep({
        setup: readAntigravitySignInSetup(input.instance),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      });
    case GROK_DRIVER_KIND:
      return grokNextStep(readGrokSignInSetup(input.instance));
    default:
      return null;
  }
}

/**
 * The method's name when it isn't the agent's default ("xAI API key"), for
 * rows that say what an agent needs. `null`: the driver's own `needs`.
 */
export function signInMethodNeeds(
  driverKind: string | null,
  instance: Pick<ProviderInstanceConfig, "config" | "environment">,
): string | null {
  switch (driverKind) {
    case ANTIGRAVITY_DRIVER_KIND: {
      const setup = readAntigravitySignInSetup(instance);
      return setup.method === "oauth-personal"
        ? null
        : antigravityAuthMethodInfo(setup.method).name;
    }
    case GROK_DRIVER_KIND: {
      const setup = readGrokSignInSetup(instance);
      return setup.method === "subscription" ? null : grokAuthMethodInfo(setup.method).name;
    }
    default:
      return null;
  }
}

/**
 * `signInNextStep` for surfaces that only know the instance id (composer
 * notices, setup): `null` for other agents.
 */
export function useSignInNextStep(instanceId: ProviderInstanceId | null): SignInNextStep | null {
  const settings = useSettings();
  const providers = useServerProviders();
  return useMemo(() => {
    if (instanceId === null) return null;
    const row = deriveMaintainedProviderRows(settings).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!row) return null;
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    return signInNextStep({ driverKind: String(row.driver), instance: row.instance, snapshot });
  }, [instanceId, providers, settings]);
}
