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

import type { SubagentProgressItem, ThreadSubagentHistoryEntry } from "./session-logic";
import type { ThreadBackgroundRunItem } from "./components/chat/threadActivity";

export interface AgentsPanelSource {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagents: ReadonlyArray<SubagentProgressItem>;
  backgroundRuns: ReadonlyArray<ThreadBackgroundRunItem>;
  /** Every agent the thread has run, live or long finished. Published alongside
   *  the live items so the panel and the conversation's receipts resolve the
   *  same set of agents. */
  history: ReadonlyArray<ThreadSubagentHistoryEntry>;
  /** Provider driver label, e.g. `codex`; drives the trunk hue and run chips. */
  providerLabel: string | null;
  threadCwd: string | null;
  onToggleBackgroundRunTerminal: (terminalId: string) => void;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}

interface AgentsPanelStoreState {
  source: AgentsPanelSource | null;
  /**
   * The agent whose transcript the panel is drilled into. It lives here rather
   * than inside the panel because the drill-in is reachable from outside it:
   * a finished agent's receipt in the conversation opens the rail already
   * pointed at that agent.
   */
  selectedAgentId: string | null;
  publishSource: (source: AgentsPanelSource | null) => void;
  selectAgent: (agentId: string | null) => void;
}

export const useAgentsPanelStore = create<AgentsPanelStoreState>((set) => ({
  source: null,
  selectedAgentId: null,
  publishSource: (source) => {
    set((state) => ({
      source,
      // A drill-in belongs to the thread it was opened from; leaving the
      // thread drops it rather than pointing the panel at a stale agent.
      selectedAgentId: state.source?.threadId === source?.threadId ? state.selectedAgentId : null,
    }));
  },
  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId });
  },
}));

export function useAgentsPanelSource(): AgentsPanelSource | null {
  return useAgentsPanelStore((state) => state.source);
}

export function useSelectedAgentId(): string | null {
  return useAgentsPanelStore((state) => state.selectedAgentId);
}

export function publishAgentsPanelSource(source: AgentsPanelSource | null): void {
  useAgentsPanelStore.getState().publishSource(source);
}

export function selectAgentsPanelAgent(agentId: string | null): void {
  useAgentsPanelStore.getState().selectAgent(agentId);
}

export function resetAgentsPanelSourceForTests(): void {
  useAgentsPanelStore.setState({ source: null, selectedAgentId: null });
}
