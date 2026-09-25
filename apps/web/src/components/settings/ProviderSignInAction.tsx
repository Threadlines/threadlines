import type { ProviderInstanceId } from "@threadlines/contracts";
import { LoaderIcon } from "lucide-react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useProviderConnectFlow } from "./useProviderConnectFlow";

/**
 * The row-level "Sign in" for an installed provider that is signed out, in the
 * spot Install occupies before that. It starts the same server-run sign-in the
 * card's Account section shows, then asks the card to open that section so the
 * progress, the sign-in link, and any terminal prompt are in view.
 */
export function ProviderSignInAction(props: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly onStarted: () => void;
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
      Sign in
    </Button>
  );
}
