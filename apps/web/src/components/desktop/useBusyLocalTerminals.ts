import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { selectBusyTerminals, useTerminalStateStore } from "../../terminalStateStore";

/**
 * What runs in this computer's terminals, live (null for a tab whose command
 * isn't known), for the prompts that warn before the desktop app closes:
 * closing it stops the server those terminals run on. Terminals on other
 * computers keep running and never count.
 */
export function useBusyLocalTerminalCommands(): ReadonlyArray<string | null> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useTerminalStateStore(
    useShallow((state) =>
      selectBusyTerminals(state, primaryEnvironmentId).map((terminal) => terminal.command),
    ),
  );
}
