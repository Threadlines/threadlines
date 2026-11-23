import { type EnvironmentId, type KeybindingCommand, type MessageId } from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { AppCommandId } from "@threadlines/shared/appCommands";
import {
  analyzeSearchText,
  parseSearchQuery,
  type ParsedSearchQuery,
} from "@threadlines/shared/searchRanking";
import { type ReactNode } from "react";
import { sortThreads } from "../lib/threadSort";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";

/** The opening list's recent threads. */
export const RECENT_THREAD_LIMIT = 5;
/** The opening list's suggested commands. */
export const SUGGESTED_COMMAND_LIMIT = 4;
export const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";
export const ADDON_ICON_CLASS = "size-4";

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: string;
  /** When the item last moved, shown as a relative age ("5m ago") that keeps itself current. */
  readonly timestampAt?: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly threadRef?: Pick<SidebarThreadSummary, "environmentId" | "id">;
  readonly threadContentMatch?: ThreadContentSearchMatch & { readonly query: string };
  /** A registered command (or one item of a list command), resolved again by id when it runs. */
  readonly command?: { readonly id: AppCommandId; readonly itemId?: string };
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  /** Closes the palette and opens another dialog, which then owns where focus returns. */
  readonly opensDialog?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
  readonly inputPlaceholder?: string;
  readonly threadSearchProjectIdsByEnvironment?: ReadonlyMap<
    EnvironmentId,
    ReadonlyArray<Project["id"]>
  >;
  /** A list command's page: its rows are drawn from the command's current items. */
  readonly listCommandId?: AppCommandId;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
    searchTerms: [project.name, project.cwd],
    title: project.name,
    description: project.cwd,
    icon: input.icon(project),
    run: async () => {
      await input.runProject(project);
    },
  }));
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "environmentId"
  | "id"
  | "pinnedAt"
  | "projectId"
  | "title"
> & {
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  icon: ReactNode | ((thread: TThread) => ReactNode);
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(input.threads.filter((thread) => thread.archivedAt === null));
  const visibleThreads =
    input.limit === undefined ? sortedThreads : sortedThreads.slice(0, input.limit);

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.id}`,
        threadRef: { environmentId: thread.environmentId, id: thread.id },
        searchTerms: [thread.title, projectTitle ?? ``, thread.branch ?? ``],
        title: thread.title,
        description: descriptionParts.join(` · `),
        timestampAt: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        icon: typeof input.icon === "function" ? input.icon(thread) : input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

/**
 * The scoped key of the thread the highlighted result opens, or null when the
 * highlight is on anything else.
 */
export function highlightedThreadKeyOf(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): string | null {
  if (highlightedItemValue === null) {
    return null;
  }
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.value === highlightedItemValue);
    if (item) {
      return item.threadRef && !item.disabled
        ? scopedThreadKey(scopeThreadRef(item.threadRef.environmentId, item.threadRef.id))
        : null;
    }
  }
  return null;
}

export interface ThreadContentSearchMatch {
  readonly environmentId: EnvironmentId;
  readonly threadId: Thread["id"];
  readonly messageId: MessageId;
  readonly snippet: string;
  readonly score: number;
}

function threadContentSearchKey(environmentId: EnvironmentId, threadId: Thread["id"]): string {
  return `${environmentId}\u0000${threadId}`;
}

export function applyThreadContentSearchMatches<TItem extends CommandPaletteItem>(input: {
  items: ReadonlyArray<TItem>;
  matches: ReadonlyArray<ThreadContentSearchMatch>;
  query: string;
}): TItem[] {
  const matchByThread = new Map(
    input.matches.map((match) => [
      threadContentSearchKey(match.environmentId, match.threadId),
      match,
    ]),
  );

  return input.items.map((item) => {
    if (!item.threadRef) {
      return item;
    }
    const match = matchByThread.get(
      threadContentSearchKey(item.threadRef.environmentId, item.threadRef.id),
    );
    if (!match) {
      return item;
    }

    return {
      ...item,
      threadContentMatch: { ...match, query: input.query },
    };
  });
}

const SEARCH_FIELD_RANK_BASE = 3_000_000_000;
const SEARCH_FIELD_RANK_PENALTY = 400_000_000;
const SEARCH_COMBINED_FIELD_RANK_BASE = 1_400_000_000;
const SEARCH_THREAD_BODY_RANK_BASE = 1_000_000_000;

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  query: ParsedSearchQuery,
): number {
  // The visible title is always searchable, and outranks the hidden
  // searchTerms: typing exactly what an item says on screen must find it.
  // Titles can be arbitrary nodes; only plain-string ones can be ranked.
  const terms = [typeof item.title === "string" ? item.title : "", ...item.searchTerms].filter(
    (term) => term.length > 0,
  );
  let bestRank = Number.NEGATIVE_INFINITY;

  for (const [index, field] of terms.entries()) {
    const analysis = analyzeSearchText(field, query);
    if (analysis) {
      bestRank = Math.max(
        bestRank,
        SEARCH_FIELD_RANK_BASE - index * SEARCH_FIELD_RANK_PENALTY - analysis.score,
      );
    }
  }

  const combinedAnalysis = analyzeSearchText(terms.join(" "), query);
  if (combinedAnalysis) {
    bestRank = Math.max(bestRank, SEARCH_COMBINED_FIELD_RANK_BASE - combinedAnalysis.score);
  }

  if (item.threadContentMatch) {
    bestRank = Math.max(bestRank, SEARCH_THREAD_BODY_RANK_BASE - item.threadContentMatch.score);
  }

  return bestRank;
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const parsedQuery = parseSearchQuery(searchQuery);

  if (parsedQuery.clauses.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const rank = rankCommandPaletteItemMatch(item, parsedQuery);
        if (rank === Number.NEGATIVE_INFINITY) {
          return null;
        }

        return {
          item,
          index,
          rank,
        };
      })
      .filter(
        (entry): entry is { item: (typeof group.items)[number]; index: number; rank: number } =>
          entry !== null,
      )
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

/**
 * What the palette shows before anything is typed: where you'd go (the
 * threads you were in), then the commands you use most, then a way into
 * every command.
 */
export function buildOpeningGroups(input: {
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
  suggestedItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  allCommandsItem: CommandPaletteActionItem;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent threads",
      items: input.recentThreadItems,
    });
  }
  if (input.suggestedItems.length > 0) {
    groups.push({ value: "suggested", label: "Suggested", items: input.suggestedItems });
  }
  groups.push({ value: "all-commands", label: "Commands", items: [input.allCommandsItem] });
  return groups;
}

export function getCommandPaletteInputPlaceholder(isSubmenu: boolean): string {
  return isSubmenu ? "Search..." : "Search commands, projects, and threads...";
}
