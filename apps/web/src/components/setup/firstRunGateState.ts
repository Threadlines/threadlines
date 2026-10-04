/**
 * The first-run gate, answered from live app state, plus the two things that
 * act on it: the redirect into setup and the hold on launch prompts.
 *
 * `firstRunGate.ts` owns the rules and the dismissal record; this module feeds
 * them the primary environment's bootstrap and message history and the
 * current route.
 *
 * @module firstRunGateState
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { isHostedStaticApp } from "../../hostedPairing";
import { useServerProviders } from "../../rpc/serverState";
import { deriveAgentStatus, isAgentReady } from "../settings/agentStatus";
import { selectEnvironmentState, useStore } from "../../store";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import {
  deriveFirstRunSetupGate,
  useFirstRunSetupDismissed,
  type FirstRunSetupGate,
} from "./firstRunGate";

/** The setup screen's route. Outside the chat layout, so redirecting to it cannot loop. */
export const SETUP_ROUTE_PATH = "/setup";

/**
 * The environment setup is about: the computer this app's backend runs on
 * (the primary environment; on the hosted app, the paired computer on
 * screen). Settings › Providers, install and sign-in act on the same one, so
 * setup never dismisses one computer while changing another.
 */
export function useSetupEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const isHostedStatic = useMemo(() => isHostedStaticApp(), []);
  return primaryEnvironmentId ?? (isHostedStatic ? activeEnvironmentId : null);
}

export function useFirstRunSetupGate(environmentId: EnvironmentId | null): FirstRunSetupGate {
  const isHostedStatic = useMemo(() => isHostedStaticApp(), []);
  const isDismissed = useFirstRunSetupDismissed(environmentId);
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
  return deriveFirstRunSetupGate({
    isHostedStatic,
    environmentId,
    isDismissed,
    bootstrapComplete,
    hasUserMessagedThread,
  });
}

/**
 * True while launch prompts (update offers) should wait: setup is pending,
 * not known yet, or on screen. Prompts are deferred, not dropped.
 */
export function useHoldLaunchPromptsForSetup(): boolean {
  const gate = useFirstRunSetupGate(useSetupEnvironmentId());
  const onSetupScreen = useLocation({
    select: (location) => location.pathname === SETUP_ROUTE_PATH,
  });
  return gate !== "done" || onSetupScreen;
}

/**
 * True when no turned-on agent can take a turn: the moment the composer's
 * provider notice also offers "Open setup", the way back after skipping it.
 */
export function useNoAgentReady(): boolean {
  const providers = useServerProviders();
  return (
    providers.length > 0 &&
    !providers.some((provider) =>
      isAgentReady(
        deriveAgentStatus({
          enabled: provider.enabled,
          driverKind: provider.driver,
          snapshot: provider,
        }),
      ),
    )
  );
}

/**
 * Sends a first run to setup from any empty surface it lands on: home, an
 * empty project draft, or an empty thread (the server opens one for the
 * folder Threadlines was started from). Conversations, General Chat, and
 * every page outside the chat layout are left alone. Mounted once, in the
 * chat layout.
 */
export function FirstRunSetupRedirect() {
  const environmentId = useSetupEnvironmentId();
  const gate = useFirstRunSetupGate(environmentId);
  const navigate = useNavigate();
  const isHome = useLocation({ select: (location) => location.pathname === "/" });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // Primitives, not an object: a fresh object per read would re-render forever.
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId ? (store.getDraftSession(draftId)?.environmentId ?? null) : null,
  );
  const draftProjectId = useComposerDraftStore((store) =>
    draftId ? (store.getDraftSession(draftId)?.projectId ?? null) : null,
  );
  const serverThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const isEligibleSurface = useStore((state) => {
    if (isHome) return true;
    // A project that has not loaded yet could still be General Chat; wait.
    if (draftEnvironmentId && draftProjectId) {
      const project = selectEnvironmentState(state, draftEnvironmentId).projectById[draftProjectId];
      return project !== undefined && project.kind !== "general-chat";
    }
    if (serverThreadRef) {
      const environmentState = selectEnvironmentState(state, serverThreadRef.environmentId);
      const summary = environmentState.sidebarThreadSummaryById[serverThreadRef.threadId];
      if (!summary || summary.latestUserMessageAt != null) return false;
      const project = environmentState.projectById[summary.projectId];
      return project !== undefined && project.kind !== "general-chat";
    }
    return false;
  });

  useEffect(() => {
    if (gate !== "pending" || !isEligibleSurface) return;
    void navigate({ to: SETUP_ROUTE_PATH, replace: true });
  }, [gate, isEligibleSurface, navigate]);

  return null;
}
