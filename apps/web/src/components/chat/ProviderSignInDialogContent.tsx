/**
 * The sign-in window's body: the run on the agent's computer, with room for its
 * page, a pasted address, a terminal or a question. Its own chunk, loaded the
 * first time ProviderSignInDialogHost shows a request (ProviderSignInDialog.tsx).
 */
import {
  BROWSER_SIGN_IN_DRIVERS,
  GUIDED_SIGN_IN_DRIVERS,
} from "@threadlines/shared/providerAuthCommands";

import { ProviderConnectFlow } from "../settings/ProviderConnectFlow";
import { Button } from "../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  closeProviderSignInDialog,
  type ProviderSignInDialogRequest,
} from "./ProviderSignInDialog";

export function ProviderSignInDialogContent({
  request,
}: {
  readonly request: ProviderSignInDialogRequest;
}) {
  const { displayName, computerLabel, driver } = request;
  const browserSignIn =
    driver !== null && (BROWSER_SIGN_IN_DRIVERS.has(driver) || GUIDED_SIGN_IN_DRIVERS.has(driver));
  return (
    <DialogPopup className="max-w-lg" data-testid="provider-sign-in-dialog">
      <DialogHeader>
        <DialogTitle>
          {computerLabel
            ? `Sign in to ${displayName} on ${computerLabel}`
            : `Sign in to ${displayName}`}
        </DialogTitle>
        <DialogDescription>
          {computerLabel
            ? `${displayName} runs on ${computerLabel}, so that's where it signs in. Follow the steps here.`
            : `${displayName} runs on another computer, so that's where it signs in. Follow the steps here.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ProviderConnectFlow
          instanceId={request.instanceId}
          environmentId={request.environmentId}
          flow="login"
          displayName={displayName}
          actionLabel="Sign in"
          command=""
          surface={browserSignIn ? "browser" : "terminal"}
          // Pi asks for the address in its own question.
          acceptsRedirect={driver === null || !GUIDED_SIGN_IN_DRIVERS.has(driver)}
          // That computer's terminal output is the only view of what its
          // command printed: show it from the start.
          autoShowTerminal
          // "Your own terminal" would be on a computer the user isn't at.
          offerCommandFallback={false}
          autoStart={request.start}
          startErrorInline
          onSucceeded={() => closeProviderSignInDialog(request.id)}
        />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => closeProviderSignInDialog()}>
          Close
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
