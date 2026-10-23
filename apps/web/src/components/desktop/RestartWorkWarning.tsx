import type { ReactNode } from "react";

import { describeAgentWorkElsewhere, describeRunningAgentSessions } from "./agentSessionCopy";
import { BusyTerminalsSentence } from "./BusyTerminalsSentence";
import { useBusyLocalTerminalCommands } from "./useBusyLocalTerminals";
import { useRunningAgentWork } from "./useRunningAgentWork";

/** This computer's work a restart of Threadlines would stop, live. */
export interface LocalWorkAtRisk {
  readonly agentCount: number;
  /** What runs in each busy terminal, null where it isn't known. */
  readonly terminalCommands: ReadonlyArray<string | null>;
  /** Says work on other computers keeps running, or null when they have none. */
  readonly elsewhere: string | null;
  /** Agent sessions and terminals together. */
  readonly count: number;
}

/**
 * Mount only while a prompt is open: it reads every thread and terminal on
 * each store change. Live, so work that ends while the prompt shows turns the
 * warning off and nobody restarts against stale advice.
 */
export function useLocalWorkAtRisk(): LocalWorkAtRisk {
  const { localCount, remoteMachineLabels } = useRunningAgentWork();
  const terminalCommands = useBusyLocalTerminalCommands();
  return {
    agentCount: localCount,
    terminalCommands,
    elsewhere: describeAgentWorkElsewhere(remoteMachineLabels),
    count: localCount + terminalCommands.length,
  };
}

/** Hands a prompt's contents the work its restart would stop, read only while it shows. */
export function WithLocalWorkAtRisk({
  children,
}: {
  children: (work: LocalWorkAtRisk) => ReactNode;
}) {
  return <>{children(useLocalWorkAtRisk())}</>;
}

/**
 * What restarting Threadlines stops on this computer, for every prompt that
 * restarts the app (installing an update, changing how devices connect):
 * "An agent session is still running. `npm run dev` is still running in a
 * terminal. Restarting now will stop them." Says nothing when nothing runs,
 * unless `sayWhenIdle`.
 */
export function RestartWorkWarning({
  work,
  sayWhenIdle = false,
}: {
  work: LocalWorkAtRisk;
  sayWhenIdle?: boolean;
}) {
  if (work.count === 0 && !sayWhenIdle) return null;
  const onThisComputer = work.elsewhere !== null;
  const terminals = work.terminalCommands;
  return (
    <>
      {work.agentCount > 0 || terminals.length === 0
        ? describeRunningAgentSessions(work.agentCount, onThisComputer)
        : null}
      {terminals.length > 0 ? (
        <>
          {work.agentCount > 0 ? " " : null}
          <BusyTerminalsSentence commands={terminals} onThisComputer={onThisComputer} />
        </>
      ) : null}
      {work.count > 0 ? ` Restarting now will stop ${work.count === 1 ? "it" : "them"}.` : null}
      {work.elsewhere ? ` ${work.elsewhere}` : null}
    </>
  );
}
