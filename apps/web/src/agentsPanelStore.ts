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

import type {
  EnvironmentId,
  OrchestrationWorkflowRun,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";

import type {
  SubagentProgressItem,
  ThreadSubagentHistoryEntry,
  WorkLogEntry,
} from "./session-logic";
import type { ThreadBackgroundRunItem } from "./components/chat/threadActivity";
import type { WorkflowRunViewTab } from "./components/chat/WorkflowRunCard";

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
  /** The instance the thread runs on; a spawned agent's row carries its glyph. */
  providerInstanceId: ProviderInstanceId | null;
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
  /** The thread's workflow runs, newest last (see OrchestrationWorkflowRun). */
  workflowRuns: ReadonlyArray<OrchestrationWorkflowRun>;
  onStopBackgroundRun: (run: ThreadBackgroundRunItem) => void;
  onStopWorkflowRun: (taskId: string) => void;
}

/** A workflow run the panel shows, and where in it. */
export interface WorkflowRunSelection {
  readonly taskId: string;
  readonly tab: WorkflowRunViewTab;
  /** The agent whose detail the Agents view shows. */
  readonly agentId: string | null;
  /** Opened to save the run's script as a command. */
  readonly saving: boolean;
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
  /** The workflow run the panel is drilled into; reachable from the chat's
   *  run card like an agent's receipt. */
  selectedWorkflow: WorkflowRunSelection | null;
  publishSource: (source: AgentsPanelSource | null) => void;
  publishActivitySource: (source: AgentsPanelActivitySource | null) => void;
  selectAgent: (agentId: string | null) => void;
  selectWorkflow: (selection: WorkflowRunSelection | null) => void;
}

export const useAgentsPanelStore = create<AgentsPanelStoreState>((set) => ({
  source: null,
  activitySource: null,
  selectedAgentId: null,
  selectedWorkflow: null,
  publishSource: (source) => {
    set((state) => {
      // A drill-in belongs to the thread it was opened from; leaving the
      // thread drops it rather than pointing the panel at a stale agent.
      const sameThread = state.source?.threadId === source?.threadId;
      return {
        source,
        selectedAgentId: sameThread ? state.selectedAgentId : null,
        selectedWorkflow: sameThread ? state.selectedWorkflow : null,
      };
    });
  },
  publishActivitySource: (activitySource) => {
    set({ activitySource });
  },
  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId, ...(agentId !== null ? { selectedWorkflow: null } : {}) });
  },
  selectWorkflow: (selection) => {
    set({ selectedWorkflow: selection, ...(selection !== null ? { selectedAgentId: null } : {}) });
  },
}));

export function useSelectedWorkflow(): WorkflowRunSelection | null {
  return useAgentsPanelStore((state) => state.selectedWorkflow);
}

export function selectAgentsPanelWorkflow(selection: WorkflowRunSelection | null): void {
  useAgentsPanelStore.getState().selectWorkflow(selection);
}

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
  useAgentsPanelStore.setState({
    source: null,
    activitySource: null,
    selectedAgentId: null,
    selectedWorkflow: null,
  });
}
