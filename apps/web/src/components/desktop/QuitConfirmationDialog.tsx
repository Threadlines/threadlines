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

export function QuitConfirmationDialog() {
  const [request, setRequest] = useState<DesktopQuitConfirmationRequest | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onQuitConfirmationRequested) return;
    return bridge.onQuitConfirmationRequested(setRequest);
  }, []);

  const respond = (confirmed: boolean) => {
    if (!request) return;
    setRequest(null);
    void window.desktopBridge?.resolveQuitConfirmation?.(confirmed).catch(() => undefined);
  };

  const sessionLabel =
    request?.runningThreadCount === 1
      ? "An agent session is still running."
      : `${request?.runningThreadCount ?? 0} agent sessions are still running.`;

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
          <AlertDialogDescription>
            {sessionLabel} Quitting now will stop the local Threadlines server and any running agent
            work.
          </AlertDialogDescription>
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
