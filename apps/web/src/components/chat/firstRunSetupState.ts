/**
 * "Is this environment still being set up?", answered from live app state.
 *
 * `firstRunSetup.ts` owns the rules and the dismissal record; this module
 * feeds them the environment's bootstrap and message history. It exists as its
 * own module because the answer is needed outside the chat view: the
 * provider-update prompt has to stay quiet until setup is done, and it renders
 * at the app root with none of the chat view's state in reach.
 *
 * @module firstRunSetupState
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { useMemo } from "react";

import { isHostedStaticApp } from "../../hostedPairing";
import { selectEnvironmentState, useStore } from "../../store";
import { isFirstRunSetupPending, useFirstRunSetupDismissal } from "./firstRunSetup";

/**
 * Whether the given environment is still in its first run: setup has not been
 * completed, skipped, or ruled out. True regardless of which surface is on
 * screen, so callers that only need "is the user still being onboarded" do not
 * have to reach into chat state.
 */
export function useFirstRunSetupPending(environmentId: EnvironmentId | null | undefined): boolean {
  const isHostedStatic = useMemo(() => isHostedStaticApp(), []);
  const { isDismissed } = useFirstRunSetupDismissal(environmentId);
  const bootstrapComplete = useStore(
    (state) => selectEnvironmentState(state, environmentId).bootstrapComplete,
  );
  const hasUserMessagedThread = useStore((state) => {
    const environmentState = selectEnvironmentState(state, environmentId);
    return environmentState.threadIds.some(
      (threadId) =>
        environmentState.sidebarThreadSummaryById[threadId]?.latestUserMessageAt != null,
    );
  });

  return isFirstRunSetupPending({
    isHostedStatic,
    bootstrapComplete,
    hasUserMessagedThread,
    isDismissed,
  });
}

/** `useFirstRunSetupPending` for the environment the shell is pointed at. */
export function useActiveEnvironmentFirstRunSetupPending(): boolean {
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  return useFirstRunSetupPending(activeEnvironmentId);
}
