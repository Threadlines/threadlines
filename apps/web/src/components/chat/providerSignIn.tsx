/**
 * "Sign in" outside the settings page.
 *
 * The setup card and the composer notices used to open the thread's terminal
 * and type the provider's login command into it, which put a raw shell in
 * front of someone who had asked for one button. They now drive the same
 * server-side flow the Providers settings panel uses
 * (`useProviderConnectFlow`), and report it as one line of text on the row
 * they already occupy.
 *
 * Neither surface has room for the interactive terminal that settings can
 * open, so a run that stalls past the auto-expand threshold hands off: the
 * action becomes "Open Settings", deep-linked to this instance's card, where
 * the same live session is waiting with its terminal and copy fallback.
 *
 * @module providerSignIn
 */
import type { ProviderInstanceId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { LoaderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { ProviderConnectFlowController } from "../settings/useProviderConnectFlow";
import { Button } from "../ui/button";

/**
 * The slice of a `ProviderConnectFlowController` the chat surfaces read.
 * Declared structurally so a controller passes through unchanged and the
 * notice builders stay free of hooks.
 */
export interface ProviderSignInFlowView {
  readonly instanceId: ProviderInstanceId | null;
  readonly isActive: boolean;
  readonly isStarting: boolean;
  readonly hasRun: boolean;
  readonly hasFailed: boolean;
  /** True once the run has earned the terminal only settings can show. */
  readonly needsTerminal: boolean;
  /** Last visible output line, already stripped of control sequences. */
  readonly lastLine: string;
  /** The server's plain-language failure reason, when it gave one. */
  readonly failureDetail: string | null;
  readonly start: () => void;
}

export function toProviderSignInFlowView(input: {
  readonly instanceId: ProviderInstanceId | null;
  readonly controller: ProviderConnectFlowController;
}): ProviderSignInFlowView {
  const { controller, instanceId } = input;
  return {
    instanceId,
    isActive: controller.isActive,
    isStarting: controller.isStarting,
    hasRun: controller.hasRun,
    hasFailed: controller.hasRun && controller.state.status === "failed",
    needsTerminal: controller.hasRun && controller.needsTerminal,
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

/**
 * The primary action: start the flow, retry a failed one, or step aside for
 * the settings hand-off once the run needs a terminal.
 */
export function ProviderSignInButton({
  view,
  label = "Sign in",
  ariaLabel,
  variant,
  className,
}: {
  readonly view: ProviderSignInFlowView;
  readonly label?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly variant?: "default" | "outline" | "ghost" | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  if (view.needsTerminal && !view.hasFailed) {
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
      aria-label={ariaLabel ?? label}
      onClick={view.start}
    >
      {label}
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
}: {
  readonly instanceId: ProviderInstanceId | null;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <Button
      size="xs"
      variant="outline"
      className={className}
      aria-label="Open provider settings to finish signing in"
      render={
        <Link
          to="/settings/providers"
          search={instanceId === null ? {} : { instance: String(instanceId) }}
        />
      }
    >
      Open Settings
    </Button>
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
