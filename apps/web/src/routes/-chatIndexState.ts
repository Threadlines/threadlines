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

export type ChatIndexState =
  | HostedStaticIndexState
  /** A directly paired browser waiting on its own first workspace snapshot. */
  | { readonly kind: "workspace-loading" };

/**
 * Which surface `/` shows, for both ways of reaching this app: the hosted phone
 * app (which depends on a saved desktop) and a browser paired straight to a
 * computer.
 *
 * The shared rule is that an empty project list only means "nothing here" once
 * a workspace snapshot has actually arrived. Before that, showing the cold-start
 * empty state tells a device that just finished pairing to start its first
 * thread, a second before its existing projects and threads appear.
 */
export function deriveChatIndexState(
  input: {
    readonly hostedStatic: boolean;
    /** Whether the primary environment has applied a shell snapshot. */
    readonly bootstrapComplete: boolean;
  } & Parameters<typeof deriveHostedStaticIndexState>[0],
): ChatIndexState {
  if (input.hostedStatic) {
    return deriveHostedStaticIndexState(input);
  }

  return input.bootstrapComplete ? { kind: "ready" } : { kind: "workspace-loading" };
}

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
