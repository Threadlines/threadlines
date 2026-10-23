/**
 * "Sign in" outside the settings page.
 *
 * The setup screen and the composer notices drive the same server-side flow
 * the Providers settings page uses (`useProviderConnectFlow`) rather than
 * typing a login command into a terminal, and report it as one line of text
 * on the row they already occupy.
 *
 * Neither surface has room for the interactive terminal that settings can
 * open, so a run that stalls past the auto-expand threshold hands off: the
 * action becomes "Open Settings", deep-linked to this instance's card, where
 * the same live session is waiting with its terminal and copy fallback. A
 * question the agent asks (Pi's list of providers) hands off the same way
 * from the composer; the setup screen answers it in its own row.
 *
 * An agent on a computer Settings doesn't show (a thread on another computer)
 * signs in on that computer (`elsewhere`): there the hand-off is the sign-in
 * window (`ProviderSignInDialog`), opened as the run starts.
 *
 * @module providerSignIn
 */
import type { EnvironmentId, ProviderInstanceId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { LoaderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { openProviderSignInDialog } from "./ProviderSignInDialog";
import { useIsCommunityAgent } from "../settings/communityAgents";
import { useSignInNextStep } from "../settings/useSignInNextStep";
import {
  type ProviderConnectFlowController,
  useProviderConnectFlow,
} from "../settings/useProviderConnectFlow";
import { Button } from "../ui/button";

/**
 * A sign-in that runs on a computer the app's Settings doesn't show. It
 * finishes in the sign-in window, named for that computer and agent.
 */
export interface ProviderSignInElsewhere {
  /** The computer that runs the agent; null is the app's own backend. */
  readonly environmentId: EnvironmentId | null;
  readonly displayName: string;
  readonly computerLabel: string | null;
  readonly driver: string | null;
}

/**
 * The slice of a `ProviderConnectFlowController` the chat surfaces read.
 * Declared structurally so a controller passes through unchanged and the
 * notice builders stay free of hooks.
 */
export interface ProviderSignInFlowView {
  readonly instanceId: ProviderInstanceId | null;
  /** Set when the agent signs in on a computer Settings doesn't show. */
  readonly elsewhere: ProviderSignInElsewhere | null;
  /** This app can reach the computer the sign-in runs on. */
  readonly canReachComputer: boolean;
  readonly isActive: boolean;
  readonly isStarting: boolean;
  readonly hasRun: boolean;
  readonly hasFailed: boolean;
  /**
   * True once the run needs what only the hand-off can show (Settings, or
   * the sign-in window for `elsewhere`): the terminal, or (where this
   * surface can't answer them) the agent's questions.
   */
  readonly needsHandoff: boolean;
  /** The agent is waiting on the user: a question, or a device code to type. */
  readonly asking: boolean;
  /** `asking`, on a surface that can't show it: the user continues in the hand-off. */
  readonly waitingInHandoff: boolean;
  /** Last visible output line, already stripped of control sequences. */
  readonly lastLine: string;
  /** The server's plain-language failure reason, when it gave one. */
  readonly failureDetail: string | null;
  readonly start: () => void;
}

export function toProviderSignInFlowView(input: {
  readonly instanceId: ProviderInstanceId | null;
  readonly controller: ProviderConnectFlowController;
  /** The surface shows the agent's questions itself (the setup screen). */
  readonly answersQuestions?: boolean;
  /** Set when the agent runs on a computer Settings doesn't show. */
  readonly elsewhere?: ProviderSignInElsewhere | null | undefined;
}): ProviderSignInFlowView {
  const { controller, instanceId } = input;
  const { question, pageRequest } = controller.state;
  const asking = controller.isActive && (question !== null || pageRequest?.code != null);
  const waitingInHandoff = controller.hasRun && asking && input.answersQuestions !== true;
  return {
    instanceId,
    elsewhere: input.elsewhere ?? null,
    canReachComputer: controller.canReachComputer,
    isActive: controller.isActive,
    isStarting: controller.isStarting,
    hasRun: controller.hasRun,
    // A start that never reached the computer failed too, and says why.
    hasFailed:
      controller.hasRun &&
      (controller.state.status === "failed" ||
        (controller.startError !== null && !controller.isActive)),
    // A surface that shows the question needs no help while it waits on the user.
    needsHandoff: waitingInHandoff || (controller.hasRun && controller.needsTerminal && !asking),
    asking,
    waitingInHandoff,
    lastLine: controller.state.lastLine,
    failureDetail: controller.startError ?? controller.state.detail,
    start: controller.start,
  };
}

/** True while the surface should describe the flow instead of offering it. */
export function isProviderSignInInFlight(view: ProviderSignInFlowView): boolean {
  return view.isActive || view.isStarting;
}

/**
 * One line describing where the run is, or null when there is nothing to say
 * yet. Deliberately short: every surface that shows it truncates.
 */
export function providerSignInStatusText(view: ProviderSignInFlowView): string | null {
  if (view.asking) {
    if (!view.waitingInHandoff) return "Signing in…";
    return view.elsewhere
      ? "Signing in… continue in the sign-in window."
      : "Signing in… continue in Settings.";
  }
  if (isProviderSignInInFlight(view)) {
    return view.lastLine.trim().length > 0
      ? `Signing in… ${view.lastLine}`
      : "Signing in… finish it in your browser.";
  }
  if (view.hasFailed) {
    const reason = view.failureDetail?.trim() || view.lastLine.trim();
    return reason.length > 0 ? `Sign-in failed. ${reason}` : "Sign-in failed.";
  }
  return null;
}

interface ProviderSignInButtonProps {
  readonly view: ProviderSignInFlowView;
  readonly label?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly variant?: "default" | "outline" | "ghost" | undefined;
  readonly className?: string | undefined;
}

/**
 * The primary action: start the flow, retry a failed one, or step aside for
 * the hand-off once the run needs more room than the row has.
 */
export function ProviderSignInButton(props: ProviderSignInButtonProps): ReactNode {
  return props.view.elsewhere ? (
    <ProviderSignInElsewhereButton {...props} elsewhere={props.view.elsewhere} />
  ) : (
    <ProviderSignInHereButton {...props} />
  );
}

/** A sign-in on the computer the app's settings talk to, which Settings finishes. */
function ProviderSignInHereButton({
  view,
  label = "Sign in",
  ariaLabel,
  variant,
  className,
}: ProviderSignInButtonProps): ReactNode {
  // Antigravity's and Grok's sign-in follow their method; a missing key or
  // project can only be fixed on the Account tab.
  const methodStep = useSignInNextStep(view.instanceId);
  // A community agent's sign-in may ask for a page to be opened, or be a
  // command to type into: both need the room its Account tab has.
  const isCommunityAgent = useIsCommunityAgent(view.instanceId);
  if (methodStep?.kind === "settings") {
    return (
      <ProviderSignInSettingsLink
        instanceId={view.instanceId}
        className={className}
        label={methodStep.label}
      />
    );
  }
  const buttonLabel = methodStep?.label ?? label;
  if (isCommunityAgent) {
    return <ProviderSignInSettingsLink instanceId={view.instanceId} className={className} />;
  }
  if (view.needsHandoff && !view.hasFailed) {
    return <ProviderSignInSettingsLink instanceId={view.instanceId} className={className} />;
  }
  if (isProviderSignInInFlight(view)) {
    return null;
  }
  return (
    <Button
      size="xs"
      variant={variant ?? "default"}
      className={className}
      disabled={view.instanceId === null}
      aria-label={ariaLabel ?? buttonLabel}
      onClick={view.start}
    >
      {buttonLabel}
    </Button>
  );
}

/**
 * A sign-in on another computer: the sign-in window starts it, and holds its
 * page, the address to paste back, its questions and its terminal; a run
 * already going reopens it. The window reads that computer's own account of
 * the agent; this computer's settings say nothing about it.
 */
function ProviderSignInElsewhereButton({
  view,
  elsewhere,
  label = "Sign in",
  ariaLabel,
  variant,
  className,
}: ProviderSignInButtonProps & { readonly elsewhere: ProviderSignInElsewhere }): ReactNode {
  const instanceId = view.instanceId;
  const inFlight = isProviderSignInInFlight(view);
  const buttonLabel = inFlight ? "Continue" : label;
  return (
    <Button
      size="xs"
      variant={inFlight ? "outline" : (variant ?? "default")}
      className={className}
      disabled={instanceId === null}
      aria-label={inFlight ? "Continue signing in" : (ariaLabel ?? buttonLabel)}
      onClick={() => {
        if (instanceId === null) return;
        // Unreachable, the row says why (the start fails there at once); an
        // empty window wouldn't.
        if (!view.canReachComputer) {
          view.start();
          return;
        }
        openProviderSignInDialog({ instanceId, ...elsewhere, start: !inFlight });
      }}
    >
      {buttonLabel}
    </Button>
  );
}

/**
 * The hand-off. Keeps the approved "Open Settings" label rather than minting
 * a third phrase for what is the same destination as every other settings
 * action in these rows.
 */
export function ProviderSignInSettingsLink({
  instanceId,
  className,
  label = "Open Settings",
}: {
  readonly instanceId: ProviderInstanceId | null;
  readonly className?: string | undefined;
  /** What the settings step is ("Add key"); "Open Settings" by default. */
  readonly label?: string;
}): ReactNode {
  return (
    <Button
      size="xs"
      variant="outline"
      className={className}
      aria-label={
        label === "Open Settings" ? "Open provider settings to finish signing in" : undefined
      }
      render={
        <Link
          to="/settings/providers"
          search={instanceId === null ? {} : { instance: String(instanceId) }}
        />
      }
    >
      {label}
    </Button>
  );
}

/**
 * The Sign in a usage meter offers once the provider's sign-in is confirmed
 * gone. It runs the provider's own sign-in right where it is shown, and
 * reports the run in the same spot. Mount it only while the offer is on
 * screen: it follows the instance's sign-in session for as long as it lives.
 */
export function ProviderUsageSignIn({
  instanceId,
  className,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly className?: string | undefined;
}): ReactNode {
  const controller = useProviderConnectFlow({ instanceId, flow: "login" });
  const view = toProviderSignInFlowView({ instanceId, controller });
  return (
    <>
      <ProviderSignInButton view={view} variant="outline" className={className} />
      <ProviderSignInInlineStatus view={view} />
    </>
  );
}

/**
 * Compact status for a list row: a spinner at the same size as every other
 * inline loader in the app, the state, and the last output line.
 */
export function ProviderSignInInlineStatus({
  view,
  className,
}: {
  readonly view: ProviderSignInFlowView;
  readonly className?: string | undefined;
}): ReactNode {
  const text = providerSignInStatusText(view);
  if (text === null) {
    return null;
  }
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[12px]",
        view.hasFailed ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      data-provider-sign-in-status={view.hasFailed ? "failed" : "running"}
    >
      {isProviderSignInInFlight(view) ? (
        <LoaderIcon className="size-3 shrink-0 animate-spin" aria-hidden />
      ) : null}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
