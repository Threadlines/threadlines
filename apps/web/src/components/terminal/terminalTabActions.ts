/**
 * Killing a terminal tab, the same from a thread's drawer and the Terminals
 * page: the server stops its shell and deletes its history, and this device
 * forgets the tab at once. False when the computer's connection is gone.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { dropTerminalBuffer } from "../../terminalStreams";

export function killTerminalTab(threadRef: ScopedThreadRef, terminalId: string): boolean {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return false;
  const { threadId } = threadRef;
  const isFinalTerminal =
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadKey, threadRef)
      .terminalIds.length <= 1;
  const fallbackExitWrite = () =>
    api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
  if ("close" in api.terminal && typeof api.terminal.close === "function") {
    void (async () => {
      if (isFinalTerminal) {
        await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
      }
      await api.terminal.close({ threadId, terminalId, deleteHistory: true });
    })().catch(() => fallbackExitWrite());
  } else {
    void fallbackExitWrite();
  }
  useTerminalStateStore.getState().closeTerminal(threadRef, terminalId);
  dropTerminalBuffer(threadRef.environmentId, threadId, terminalId);
  return true;
}
