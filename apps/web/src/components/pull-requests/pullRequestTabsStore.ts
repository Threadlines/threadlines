/**
 * The pull requests the page has open at once, as a strip of tabs.
 *
 * The route's `pr` param stays the source of truth for which one is on screen;
 * this store only holds the set and the order they were opened in. It is not
 * persisted: tabs are a working set for one sitting, and a reload that restored
 * six of them would be restoring someone else's afternoon.
 */
import type { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { create } from "zustand";

export interface PullRequestTab {
  /** `environment:project:repository:number`, from {@link pullRequestTabId}. */
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}

export type PullRequestTabTarget = Omit<PullRequestTab, "id">;

/**
 * One pull request across environments and checkouts. The repository is in the
 * key as well as the project, because one project can read more than one
 * remote and the same number means a different pull request on each.
 */
export function pullRequestTabId(target: PullRequestTabTarget): string {
  return `${target.environmentId}:${target.projectId}:${target.repository.toLowerCase()}:${target.number}`;
}

interface PullRequestTabsState {
  readonly tabs: readonly PullRequestTab[];
  readonly activeId: string | null;
  /** Adds the tab if it is new, and makes it the active one either way. */
  readonly open: (target: PullRequestTabTarget) => PullRequestTab;
  /**
   * Drops one tab and answers with whichever is active afterwards: the tab now
   * at the closed one's index (its right neighbour), else the last one left,
   * else null. Closing a background tab leaves the active one alone.
   */
  readonly close: (id: string) => PullRequestTab | null;
}

export const usePullRequestTabsStore = create<PullRequestTabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  open: (target) => {
    const id = pullRequestTabId(target);
    const { tabs, activeId } = get();
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      if (activeId !== id) {
        set({ activeId: id });
      }
      return existing;
    }
    const tab: PullRequestTab = { id, ...target };
    set({ tabs: [...tabs, tab], activeId: id });
    return tab;
  },
  close: (id) => {
    const { tabs, activeId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    const active = tabs.find((tab) => tab.id === activeId) ?? null;
    if (index < 0) {
      return active;
    }
    const remaining = tabs.filter((tab) => tab.id !== id);
    const next =
      id === activeId
        ? (remaining[index] ?? remaining[remaining.length - 1] ?? null)
        : (remaining.find((tab) => tab.id === activeId) ?? null);
    set({ tabs: remaining, activeId: next?.id ?? null });
    return next;
  },
}));

/** Empties the strip, for a test that must not inherit the last one's tabs. */
export function resetPullRequestTabsForTests(): void {
  usePullRequestTabsStore.setState({ tabs: [], activeId: null });
}
