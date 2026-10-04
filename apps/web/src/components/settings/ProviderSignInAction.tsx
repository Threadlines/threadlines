import type { ProviderInstanceId } from "@threadlines/contracts";
import { LoaderIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useProviderConnectFlow } from "./useProviderConnectFlow";

/**
 * The row-level "Sign in" for an installed provider that is signed out, in the
 * spot Install occupies before that. It starts the same server-run sign-in the
 * card's Account section shows, then asks the card to open that section so the
 * progress, the sign-in link, and any terminal prompt are in view.
 *
 * `autoStart` starts it once on mount, for an account the user just added:
 * they already asked to sign in when they submitted the form.
 */
export function ProviderSignInAction(props: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly onStarted: () => void;
  readonly autoStart?: boolean;
  /** The button's words; "Sign in" unless the sign-in is something else (a key check). */
  readonly label?: string;
}) {
  const { start, isStarting, isActive } = useProviderConnectFlow({
    instanceId: props.instanceId,
    flow: "login",
    onStartError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not start ${props.displayName} sign-in`,
          description: error instanceof Error ? error.message : "The command could not be started.",
        }),
      );
    },
  });
  const busy = isActive || isStarting;
  const autoStartedRef = useRef(false);
  const { autoStart, onStarted } = props;
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    autoStartedRef.current = true;
    start();
    onStarted();
  }, [autoStart, onStarted, start]);

  return (
    <Button
      size="xs"
      aria-label={`Sign in to ${props.displayName}`}
      disabled={busy}
      onClick={() => {
        start();
        props.onStarted();
      }}
    >
      {busy ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
      {props.label ?? "Sign in"}
    </Button>
  );
}
