import type { DesktopQuitConfirmationRequest } from "@threadlines/contracts";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { describeAgentWorkElsewhere, describeRunningAgentSessions } from "./agentSessionCopy";
import { useRunningAgentWork } from "./useRunningAgentWork";

/**
 * The count is the one the app asked with: threads on this computer, the only
 * work quitting stops. Work on other computers is named so nobody keeps the
 * app open for threads that run fine without it.
 */
function QuitConfirmationDescription({ runningThreadCount }: { runningThreadCount: number }) {
  const { remoteMachineLabels } = useRunningAgentWork();
  const elsewhere = describeAgentWorkElsewhere(remoteMachineLabels);
  return (
    <AlertDialogDescription>
      {describeRunningAgentSessions(runningThreadCount, elsewhere !== null)} Quitting now will stop{" "}
      {runningThreadCount === 1 ? "it" : "them"} and the local Threadlines server.
      {elsewhere ? ` ${elsewhere}` : null}
    </AlertDialogDescription>
  );
}

export function QuitConfirmationDialog() {
  const [request, setRequest] = useState<DesktopQuitConfirmationRequest | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onQuitConfirmationRequested) return;
    return bridge.onQuitConfirmationRequested(setRequest);
  }, []);

  // Keep the last question rendered while the popup animates closed, so the
  // text doesn't vanish mid-fade.
  const [renderedRequest, setRenderedRequest] = useState(request);
  if (request !== null && request !== renderedRequest) {
    setRenderedRequest(request);
  }
  const shownRequest = request ?? renderedRequest;

  const respond = (confirmed: boolean) => {
    if (!request) return;
    setRequest(null);
    void window.desktopBridge?.resolveQuitConfirmation?.(confirmed).catch(() => undefined);
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) respond(false);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="text-destructive" />
            Quit Threadlines?
          </AlertDialogTitle>
          {shownRequest ? (
            <QuitConfirmationDescription runningThreadCount={shownRequest.runningThreadCount} />
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={
              <Button data-alert-dialog-primary-action="true" variant="outline">
                Keep Running
              </Button>
            }
          />
          <Button variant="destructive" onClick={() => respond(true)}>
            Quit Anyway
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
