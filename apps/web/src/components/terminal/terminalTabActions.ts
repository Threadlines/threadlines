/**
 * Killing a terminal tab, the same from a thread's drawer and the Terminals
 * page: the server stops its shell and deletes its history. The tab leaves
 * this device's layout at once and the server's list once the server says it
 * is gone; when the kill fails, the tab comes back and a toast says so, since
 * its shell still runs (and may hold a port). False when the computer's
 * connection is gone.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import {
  selectTerminalTabs,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../../terminalStateStore";
import { dropTerminalBuffer } from "../../terminalStreams";
import { failureNotice, toastManager } from "../ui/toast";

export function killTerminalTab(threadRef: ScopedThreadRef, terminalId: string): boolean {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return false;
  const { threadId } = threadRef;
  const isFinalTerminal =
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadKey, threadRef)
      .terminalIds.length <= 1;
  useTerminalStateStore.getState().closeTerminal(threadRef, terminalId);
  dropTerminalBuffer(threadRef.environmentId, threadId, terminalId);
  if (!("close" in api.terminal) || typeof api.terminal.close !== "function") {
    // A server from before `close`: ending the shell is all it offers.
    void api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
    return true;
  }
  void (async () => {
    if (isFinalTerminal) {
      await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
    }
    await api.terminal.close({ threadId, terminalId, deleteHistory: true });
  })().then(
    () => useTerminalStateStore.getState().forgetListedTerminal(threadRef, terminalId),
    (error: unknown) => {
      restoreTerminalTab(threadRef, terminalId);
      toastManager.add(failureNotice({ title: "Couldn't kill the terminal", error }));
    },
  );
  return true;
}

/** Shows a tab again whose kill failed: its shell still runs. */
function restoreTerminalTab(threadRef: ScopedThreadRef, terminalId: string): void {
  const store = useTerminalStateStore.getState();
  const layout = selectThreadTerminalState(store.terminalStateByThreadKey, threadRef);
  // Killing the last tab left only the closed drawer's placeholder, which
  // must not come back as a tab of its own.
  const placeholder = layout.terminalOpen ? null : layout.activeTerminalId;
  store.ensureTerminal(threadRef, terminalId, { open: true, active: true });
  const listed = selectTerminalTabs(
    useTerminalStateStore.getState().terminalTabsByThreadKey,
    threadRef,
  );
  if (
    placeholder !== null &&
    placeholder !== terminalId &&
    !listed.some((tab) => tab.terminalId === placeholder)
  ) {
    useTerminalStateStore.getState().closeTerminal(threadRef, placeholder);
  }
}
