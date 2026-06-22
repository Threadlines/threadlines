import type { EnvironmentId } from "@threadlines/contracts";

import type { SavedEnvironmentRuntimeState } from "../environments/runtime";
import type { EnvironmentState } from "../store";

interface HostedStaticSavedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export type HostedStaticIndexState =
  | { readonly kind: "unpaired" }
  | { readonly kind: "loading"; readonly label: string | null }
  | {
      readonly kind: "connection-error";
      readonly label: string | null;
      readonly message: string | null;
    }
  | { readonly kind: "ready" };

export function deriveHostedStaticIndexState(input: {
  readonly savedEnvironments: ReadonlyArray<HostedStaticSavedEnvironment>;
  readonly savedEnvironmentRuntimeById: Record<string, SavedEnvironmentRuntimeState | undefined>;
  readonly environmentStateById: Record<string, EnvironmentState | undefined>;
  readonly projectCount: number;
}): HostedStaticIndexState {
  if (input.savedEnvironments.length === 0) {
    return { kind: "unpaired" };
  }

  if (input.projectCount > 0) {
    return { kind: "ready" };
  }

  const firstError = input.savedEnvironments.find((environment) => {
    const runtime = input.savedEnvironmentRuntimeById[environment.environmentId];
    return runtime?.connectionState === "error" || Boolean(runtime?.lastError);
  });

  if (firstError) {
    const runtime = input.savedEnvironmentRuntimeById[firstError.environmentId];
    return {
      kind: "connection-error",
      label: firstError.label || null,
      message: runtime?.lastError ?? null,
    };
  }

  const hasPendingBootstrap = input.savedEnvironments.some((environment) => {
    const environmentState = input.environmentStateById[environment.environmentId];
    return environmentState?.bootstrapComplete !== true;
  });

  if (hasPendingBootstrap) {
    return {
      kind: "loading",
      label: input.savedEnvironments[0]?.label || null,
    };
  }

  return { kind: "ready" };
}
