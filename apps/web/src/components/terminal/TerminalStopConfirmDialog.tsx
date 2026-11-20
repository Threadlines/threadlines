/**
 * The question before killing or restarting a tab that is running something,
 * shared by a thread's drawer and the Terminals page.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";

import {
  selectThreadTerminalState,
  terminalKey,
  terminalLineRecentlyEntered,
  useTerminalStateStore,
} from "../../terminalStateStore";
import { shouldConfirmTerminalKill } from "../ChatView.logic";
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

/** Whether stopping this tab's shell would stop something, so it asks first. */
export function terminalStopNeedsConfirm(threadRef: ScopedThreadRef, terminalId: string): boolean {
  const store = useTerminalStateStore.getState();
  return shouldConfirmTerminalKill({
    runningTerminalIds: selectThreadTerminalState(store.terminalStateByThreadKey, threadRef)
      .runningTerminalIds,
    terminalId,
    commandPending:
      store.terminalCommandPendingByKey[terminalKey(threadRef, terminalId)] === true ||
      terminalLineRecentlyEntered(threadRef, terminalId),
    sessionExited: false,
  });
}

const RESTART_DESCRIPTION = {
  thread:
    "Something is still running in this terminal. Restarting stops it and starts a new shell in the thread's folder, below what it printed.",
  page: "Something is still running in this terminal. Restarting stops it and starts a new shell in the same folder, below what it printed.",
} as const;

const KILL_DESCRIPTION = {
  thread:
    "A process is still running in this terminal. Killing the terminal stops the process and discards the terminal history. To keep it running, hide the terminal instead.",
  page: "A process is still running in this terminal. Killing the terminal stops the process and discards the terminal history. To keep it running, leave the tab open.",
} as const;

export function TerminalStopConfirmDialog({
  kind,
  host,
  onConfirm,
  onCancel,
}: {
  /** The action waiting for an answer; null while none is. */
  readonly kind: "kill" | "restart" | null;
  /** Where the tab is: under a thread's chat, or on the Terminals page. */
  readonly host: "thread" | "page";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {kind === "restart" ? "Restart terminal?" : "Kill terminal?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {kind === "restart" ? RESTART_DESCRIPTION[host] : KILL_DESCRIPTION[host]}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={onConfirm}>
            {kind === "restart" ? "Restart terminal" : "Kill terminal"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
