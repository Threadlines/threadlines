/**
 * Bridge between the chat view, which knows what the current turn is doing,
 * and the route, which owns the right-panel slot the agents panel renders in.
 *
 * The panel needs live subagent progress and the agents' stop handles — all
 * chat-view state — but it mounts as a sibling of the chat column, next to
 * source control. ChatView publishes here; the route reads. Same shape as the
 * file viewer's store, for the same reason. Background command runs are not
 * part of this source: the header's activity chip is their surface.
 */
import { create } from "zustand";

import type { EnvironmentId, ThreadId } from "@threadlines/contracts";

import type {
  SubagentProgressItem,
  ThreadSubagentHistoryEntry,
  WorkLogEntry,
} from "./session-logic";
import type { ThreadBackgroundRunItem } from "./components/chat/threadActivity";

export interface AgentsPanelSource {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagents: ReadonlyArray<SubagentProgressItem>;
  /** Runs the panel lists as subagents rather than as runs, keyed by the tool
   *  call that launched them. They carry the stop handle those agent rows use. */
  subagentRuns: ReadonlyMap<string, ThreadBackgroundRunItem>;
  /** Every agent the thread has run, live or long finished. Published alongside
   *  the live items so the panel and the conversation's receipts resolve the
   *  same set of agents. */
  history: ReadonlyArray<ThreadSubagentHistoryEntry>;
  /** Provider driver label, e.g. `codex`; drives the trunk hue and run chips. */
  providerLabel: string | null;
  /** True from the moment a turn is dispatched until it settles. Lets the panel
   *  say it is waiting rather than claim the thread has never run an agent
   *  while the provider handoff is still in flight. */
  turnInFlight: boolean;
  /** Whether the thread's detail snapshot has synced. Until it has, empty
   *  agent state only means the data has not arrived — consumers that react
   *  to idle→running transitions (the Agents tab auto-open) must not read an
   *  unhydrated publish as observed idleness. */
  hydrated: boolean;
  threadCwd: string | null;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
}

export interface AgentsPanelActivitySource {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Child-owned work remains in this durable log even though the main
   *  conversation suppresses it. Only a drilled-in inspector subscribes. */
  workEntries: ReadonlyArray<WorkLogEntry>;
}

const EMPTY_WORK_ENTRIES: ReadonlyArray<WorkLogEntry> = [];

interface AgentsPanelStoreState {
  source: AgentsPanelSource | null;
  activitySource: AgentsPanelActivitySource | null;
  /**
   * The agent whose transcript the panel is drilled into. It lives here rather
   * than inside the panel because the drill-in is reachable from outside it:
   * a finished agent's receipt in the conversation opens the rail already
   * pointed at that agent.
   */
  selectedAgentId: string | null;
  publishSource: (source: AgentsPanelSource | null) => void;
  publishActivitySource: (source: AgentsPanelActivitySource | null) => void;
  selectAgent: (agentId: string | null) => void;
}

export const useAgentsPanelStore = create<AgentsPanelStoreState>((set) => ({
  source: null,
  activitySource: null,
  selectedAgentId: null,
  publishSource: (source) => {
    set((state) => ({
      source,
      // A drill-in belongs to the thread it was opened from; leaving the
      // thread drops it rather than pointing the panel at a stale agent.
      selectedAgentId: state.source?.threadId === source?.threadId ? state.selectedAgentId : null,
    }));
  },
  publishActivitySource: (activitySource) => {
    set({ activitySource });
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

/** Detailed child activity changes much more often than the tree. Keep it out
 * of the route subscription and wake only the inspector that can render it. */
export function useAgentsPanelWorkEntries(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  enabled?: boolean;
}): ReadonlyArray<WorkLogEntry> {
  return useAgentsPanelStore((state) => {
    if (input.enabled === false) {
      return EMPTY_WORK_ENTRIES;
    }
    const source = state.activitySource;
    return source?.environmentId === input.environmentId && source.threadId === input.threadId
      ? source.workEntries
      : EMPTY_WORK_ENTRIES;
  });
}

export function publishAgentsPanelSource(source: AgentsPanelSource | null): void {
  useAgentsPanelStore.getState().publishSource(source);
}

export function publishAgentsPanelActivitySource(source: AgentsPanelActivitySource | null): void {
  useAgentsPanelStore.getState().publishActivitySource(source);
}

export function selectAgentsPanelAgent(agentId: string | null): void {
  useAgentsPanelStore.getState().selectAgent(agentId);
}

export function resetAgentsPanelSourceForTests(): void {
  useAgentsPanelStore.setState({ source: null, activitySource: null, selectedAgentId: null });
}
