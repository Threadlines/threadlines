/**
 * Signing in an agent that runs on a computer the app's Settings doesn't
 * show: a thread on another computer than the one Settings talks to.
 *
 * The sign-in runs where the agent does, but the user can't see that
 * computer's screen: its page opens here, a page that ends on that computer's
 * loopback address needs the address pasted back, and a terminal or a
 * question needs room. Settings can't hold it and a composer row is too
 * small, so this window does. The composer opens it, and the window starts
 * the run (or attaches to the one already going) on that computer, so the
 * window owns the run's page and says itself when the run can't start.
 * Mounted once at the root.
 */
import type { EnvironmentId, ProviderInstanceId } from "@threadlines/contracts";
import {
  BROWSER_SIGN_IN_DRIVERS,
  GUIDED_SIGN_IN_DRIVERS,
} from "@threadlines/shared/providerAuthCommands";
import { create } from "zustand";

import { ProviderConnectFlow } from "../settings/ProviderConnectFlow";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The sign-in a window shows: which agent, on which computer. */
export interface ProviderSignInDialogTarget {
  /** Start a run as the window opens; false attaches to the one already going. */
  readonly start: boolean;
  readonly instanceId: ProviderInstanceId;
  /** The computer that runs the agent; null is the app's own backend. */
  readonly environmentId: EnvironmentId | null;
  readonly displayName: string;
  /** What the user calls that computer, or null when the app doesn't know. */
  readonly computerLabel: string | null;
  /** The agent's driver kind, as that computer reports it. */
  readonly driver: string | null;
}

interface ProviderSignInDialogRequest extends ProviderSignInDialogTarget {
  /** Each ask starts fresh, even for the same agent twice. */
  readonly id: number;
}

const useProviderSignInDialogStore = create<{ request: ProviderSignInDialogRequest | null }>(
  () => ({ request: null }),
);

/** Opens the sign-in window for an agent on another computer. */
export function openProviderSignInDialog(target: ProviderSignInDialogTarget): void {
  const previous = useProviderSignInDialogStore.getState().request;
  useProviderSignInDialogStore.setState({ request: { ...target, id: (previous?.id ?? 0) + 1 } });
}

/** Closes the window; with `requestId`, only if it still shows that ask. */
export function closeProviderSignInDialog(requestId?: number): void {
  const { request } = useProviderSignInDialogStore.getState();
  if (requestId !== undefined && request?.id !== requestId) return;
  useProviderSignInDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openProviderSignInDialog asks. */
export function ProviderSignInDialogHost() {
  const request = useProviderSignInDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeProviderSignInDialog();
      }}
    >
      {request ? <ProviderSignInDialogContent key={request.id} request={request} /> : null}
    </Dialog>
  );
}

function ProviderSignInDialogContent({
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
