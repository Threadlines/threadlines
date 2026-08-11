/**
 * Bridge between the chat view, which knows what the current turn is doing,
 * and the route, which owns the right-panel slot the agents panel renders in.
 *
 * The panel needs live subagent progress, background runs and the terminal
 * toggle — all of which are chat-view state — but it mounts as a sibling of
 * the chat column, next to source control. ChatView publishes here; the route
 * reads. Same shape as the file viewer's store, for the same reason.
 */
import { create } from "zustand";

import type { EnvironmentId, ThreadId } from "@threadlines/contracts";

import type { SubagentProgressItem } from "./session-logic";
import type { ThreadBackgroundRunItem } from "./components/chat/threadActivity";

export interface AgentsPanelSource {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagents: ReadonlyArray<SubagentProgressItem>;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** Provider driver label, e.g. `codex`; drives the trunk hue and run chips. */
  providerLabel: string | null;
  threadCwd: string | null;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}

interface AgentsPanelStoreState {
  source: AgentsPanelSource | null;
  publishSource: (source: AgentsPanelSource | null) => void;
}

export const useAgentsPanelStore = create<AgentsPanelStoreState>((set) => ({
  source: null,
  publishSource: (source) => {
    set({ source });
  },
}));

export function useAgentsPanelSource(): AgentsPanelSource | null {
  return useAgentsPanelStore((state) => state.source);
}

export function publishAgentsPanelSource(source: AgentsPanelSource | null): void {
  useAgentsPanelStore.getState().publishSource(source);
}

export function resetAgentsPanelSourceForTests(): void {
  useAgentsPanelStore.setState({ source: null });
}
