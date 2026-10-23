import type { DesktopUpdateState } from "@threadlines/contracts";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import {
  resolveDesktopUpdateInstallConfirmation,
  useDesktopUpdateInstallConfirmationRequest,
} from "../../lib/desktopUpdateInstallConfirmation";
import { fullVersionLabel } from "../desktopUpdate.logic";
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
import { BusyTerminalsSentence } from "./BusyTerminalsSentence";
import { useBusyLocalTerminalCommands } from "./useBusyLocalTerminals";
import { useRunningAgentWork } from "./useRunningAgentWork";

function DesktopUpdateInstallDialogBody({
  state,
  onConfirm,
}: {
  state: DesktopUpdateState;
  onConfirm: () => void;
}) {
  // Live counts: work that finishes while the prompt is open turns the
  // warning off, so the user never restarts against stale advice. Only this
  // computer's threads and terminals count; the restart leaves other
  // computers' work alone.
  const { localCount: runningCount, remoteMachineLabels } = useRunningAgentWork();
  const busyTerminals = useBusyLocalTerminalCommands();
  const stoppedCount = runningCount + busyTerminals.length;
  const hasRunningSessions = stoppedCount > 0;
  const elsewhere = describeAgentWorkElsewhere(remoteMachineLabels);
  const version = state.downloadedVersion ?? state.availableVersion;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2">
          {hasRunningSessions ? <TriangleAlert aria-hidden className="text-destructive" /> : null}
          Install update and restart?
        </AlertDialogTitle>
        <AlertDialogDescription>
          Threadlines will close to install{" "}
          {version ? (
            <code className="text-foreground/90">{fullVersionLabel(version)}</code>
          ) : (
            "the downloaded update"
          )}{" "}
          and reopen when it's done.{" "}
          {runningCount > 0 || busyTerminals.length === 0
            ? describeRunningAgentSessions(runningCount, elsewhere !== null)
            : null}
          {busyTerminals.length > 0 ? (
            <>
              {runningCount > 0 ? " " : null}
              <BusyTerminalsSentence commands={busyTerminals} onThisComputer={elsewhere !== null} />
            </>
          ) : null}
          {hasRunningSessions
            ? ` Restarting now will stop ${stoppedCount === 1 ? "it" : "them"}.`
            : null}
          {elsewhere ? ` ${elsewhere}` : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        {/* With work in flight, Enter must not be the key that kills it:
            Cancel takes the initial focus and Restart turns destructive. */}
        <AlertDialogClose
          render={
            <Button
              data-alert-dialog-primary-action={hasRunningSessions ? "true" : undefined}
              variant="outline"
            />
          }
        >
          Cancel
        </AlertDialogClose>
        <Button onClick={onConfirm} variant={hasRunningSessions ? "destructive" : "default"}>
          {hasRunningSessions ? "Restart Anyway" : "Restart"}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/**
 * In-app confirmation for restart-to-install, mounted once at the root and
 * driven by `confirmDesktopUpdateInstall` (sidebar version card, Settings
 * About row). Replaces the bare OS confirm so the prompt can name the
 * incoming version and say whether agent sessions are still running.
 */
export function DesktopUpdateInstallDialog() {
  const request = useDesktopUpdateInstallConfirmationRequest();
  // Keep the last request rendered while the popup animates closed, so the
  // card doesn't collapse to an empty shell mid-fade.
  const [renderedRequest, setRenderedRequest] = useState(request);
  if (request !== null && request !== renderedRequest) {
    setRenderedRequest(request);
  }
  const shownRequest = request ?? renderedRequest;

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) resolveDesktopUpdateInstallConfirmation(false);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        {shownRequest ? (
          <DesktopUpdateInstallDialogBody
            onConfirm={() => resolveDesktopUpdateInstallConfirmation(true)}
            state={shownRequest.state}
          />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
