"use client";

import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { type EnvironmentId, KeybindingCommand, type ProjectId } from "@threadlines/contracts";
import {
  APP_COMMAND_GROUP_TITLES,
  APP_COMMANDS,
  type AppCommandGroup,
  type AppCommandId,
} from "@threadlines/shared/appCommands";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useOfferedCommands, type OfferedCommand } from "../commands/commandHandlers";
import { COMMAND_ICONS } from "../commands/commandIcons";
import { suggestCommands, useCommandUsageStore } from "../commands/commandUsageStore";
import { PaletteCommandSources } from "../commands/PaletteCommandSources";
import { paletteSettingsSurface } from "../commands/paletteSettingsSurface";

export { PaletteInboxCommandSource } from "../commands/PaletteCommandSources";
import {
  filterPaletteSearch,
  PALETTE_FILTERS,
  type PaletteFilter,
  paletteFilterCounts,
  stepPaletteFilter,
} from "../commands/paletteFilters";
import {
  paletteSearch,
  paletteSearchStatus,
  type PaletteSource,
  type PlaceSearchEntry,
  type ThreadSearchEntry,
} from "../commands/paletteSearch";
import { runCommand } from "../commands/runCommand";
import { useComposerHandleContext } from "../composerHandleContext";
import { closeRightPanelSearchParams } from "../diffRouteSearch";
import { holdThreadDetailForOpen, prewarmHighlightedThread } from "../environments/runtime/service";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isFilesystemBrowseQuery } from "../lib/projectPaths";
import {
  canSearchThreadContent,
  threadSearchQueryOptions,
  type ThreadSearchTarget,
} from "../lib/threadSearchReactQuery";
import { readRecentThreadVisits } from "../lastVisitedThreadRoute";
import { getLatestThreadForProject } from "../lib/threadSort";
import { cn, newCommandId } from "../lib/utils";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  sidebarThreadSummariesListEqual,
  useStore,
} from "../store";
import type { SidebarThreadSummary } from "../types";
import { buildThreadRouteParams } from "../threadRoutes";
import { openAddProject } from "./addProject/addProjectStore";
import {
  useAddProjectEnvironmentOptions,
  useEnvironmentBrowsePlatform,
} from "./addProject/addProjectComputers";
import {
  ADDON_ICON_CLASS,
  applyThreadContentSearchMatches,
  buildOpeningGroups,
  buildProjectActionItems,
  buildThreadActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  highlightedThreadKeyOf,
  ITEM_ICON_CLASS,
  normalizeSearchText,
  paletteRowVerb,
  RECENT_THREAD_LIMIT,
  SUGGESTED_COMMAND_LIMIT,
} from "./CommandPalette.logic";
import { PaletteResultList, paletteRowId } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { SETTINGS_NAV_ITEMS } from "./settings/settingsNavigation";
import { useSettingsAvailability } from "./settings/settingsPlaceAvailability";
import { settingsSearchItems } from "./settings/settingsSearchIndex";
import {
  settingsSearchItemTarget,
  settingsSearchItemWhere,
  useOpenSettingsResult,
} from "./settings/settingsSearchNavigation";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { CommandDialogPopup, CommandFooter, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { failureNotice, toastManager } from "./ui/toast";

const THREAD_CONTENT_SEARCH_DEBOUNCE_MS = 180;
const EMPTY_THREAD_CONTENT_MATCHES = [] as const;
const COMMAND_IDS = Object.keys(APP_COMMANDS) as AppCommandId[];
/** Suggested before this device has used any command, as far as each is offered. */
const FIRST_SUGGESTIONS: ReadonlyArray<AppCommandId> = [
  "chat.new",
  "terminal.toggle",
  "diff.toggle",
  "project.add",
];
const isKeybindingCommand = Schema.is(KeybindingCommand);
/** How each source's section is headed, and what its "Show all" row counts. */
const SECTION_GROUPS: Readonly<
  Record<PaletteSource, { value: string; label: string; noun: string }>
> = {
  threads: { value: "threads-search", label: "Threads", noun: "threads" },
  commands: { value: "actions", label: "Commands", noun: "commands" },
  settings: { value: "settings-search", label: "Settings", noun: "settings" },
  projects: { value: "projects-search", label: "Projects", noun: "projects" },
};
/** The Commands filter with nothing typed lists every command under its catalog group, in this order. */
const COMMAND_GROUP_ORDER: ReadonlyArray<AppCommandGroup> = [
  "thread",
  "panels",
  "project",
  "goTo",
  "app",
];
/** Each Settings page's glyph, which its settings carry in the palette. */
const SETTINGS_PAGE_ICONS: ReadonlyMap<string, ComponentType<{ className?: string }>> = new Map<
  string,
  ComponentType<{ className?: string }>
>(SETTINGS_NAV_ITEMS.map((item) => [item.place, item.icon]));

/**
 * Every thread, as the palette lists them. Kept as the same array while a
 * reply streams, which moves only a thread's last-activity time on every
 * token, so the open palette doesn't redraw for it.
 */
function usePaletteThreads(): ReadonlyArray<SidebarThreadSummary> {
  const previous = useRef<ReadonlyArray<SidebarThreadSummary>>([]);
  return useStore((state) => {
    const next = selectSidebarThreadsAcrossEnvironments(state);
    const last = previous.current;
    if (
      last.length === next.length &&
      next.every((thread, index) => sidebarThreadSummariesListEqual(last[index]!, thread))
    ) {
      return last;
    }
    previous.current = next;
    return next;
  });
}

interface PaletteHighlight {
  readonly value: string | null;
  /** The user moved to `value` (keys or pointer); until then the first row is highlighted. */
  readonly moved: boolean;
}
const NO_HIGHLIGHT: PaletteHighlight = { value: null, moved: false };

/**
 * While searching All, a command row says which group it belongs to (a list
 * item, which list), unless its owner already says something there.
 */
function withCommandGroup(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
): CommandPaletteActionItem | CommandPaletteSubmenuItem {
  if (!item.command || item.description || item.whereLabel) return item;
  const whereLabel =
    item.command.itemId === undefined
      ? APP_COMMAND_GROUP_TITLES[APP_COMMANDS[item.command.id].group]
      : listHeading(item.command.id);
  return { ...item, whereLabel };
}

function commandIcon(id: AppCommandId, className: string) {
  const Icon = COMMAND_ICONS[id];
  return <Icon className={className} />;
}

/** A list page's own heading when its items don't name one: the command's title, unpunctuated. */
function listHeading(id: AppCommandId): string {
  return APP_COMMANDS[id].title.replace(/(…|\.\.\.)$/, "");
}

/** The palette row for an offered command: its words from the catalog, unless its owner says otherwise. */
function commandRow(command: OfferedCommand): CommandPaletteActionItem | CommandPaletteSubmenuItem {
  const spec = APP_COMMANDS[command.id];
  const titleText = command.title ?? spec.title;
  const title =
    command.titleEmphasis === undefined ? (
      titleText
    ) : (
      <>
        {titleText} <span className="font-semibold">{command.titleEmphasis}</span>
      </>
    );
  // One line: what the owner says now (why it's unavailable, a project's
  // name) shows on the right; the catalog's sentence only helps find it.
  const description = command.disabledReason ?? command.description;
  const common = {
    value: `command:${command.id}`,
    searchTerms: [...("keywords" in spec ? spec.keywords : []), ...(command.keywords ?? [])],
    title,
    ...(description ? { description } : {}),
    icon: commandIcon(command.id, ITEM_ICON_CLASS),
    ...(command.disabledReason !== undefined ? { disabled: true } : {}),
    ...(isKeybindingCommand(command.id) ? { shortcutCommand: command.id } : {}),
    command: { id: command.id },
  };
  if (command.items !== null) {
    return {
      ...common,
      kind: "submenu",
      addonIcon: commandIcon(command.id, ADDON_ICON_CLASS),
      groups: [],
    };
  }
  return { ...common, kind: "action", run: async () => undefined };
}

/**
 * The rows of a list command's items, in the list's order. An item is found
 * by its own words only, so "theme" finds the theme commands, not every theme.
 */
function listItemRows(command: OfferedCommand): CommandPaletteActionItem[] {
  return (command.items ?? []).map((item) => ({
    kind: "action",
    value: `command:${command.id}:${item.id}`,
    searchTerms: [...(item.keywords ?? [])],
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    icon: item.icon ?? commandIcon(command.id, ITEM_ICON_CLASS),
    ...(item.disabled ? { disabled: true } : {}),
    command: { id: command.id, itemId: item.id },
    run: async () => undefined,
  }));
}

function listPageGroups(command: OfferedCommand | undefined): CommandPaletteGroup[] {
  if (!command?.items) return [];
  const rows = listItemRows(command);
  const groups: CommandPaletteGroup[] = [];
  command.items.forEach((item, index) => {
    const label = item.group ?? listHeading(command.id);
    const last = groups.at(-1);
    if (last && last.label === label) {
      (last.items as CommandPaletteActionItem[]).push(rows[index]!);
    } else {
      groups.push({ value: `list:${command.id}:${label}`, label, items: [rows[index]!] });
    }
  });
  return groups;
}

/**
 * The open palette: search over commands, projects and threads. Commands are
 * whatever their owners register now (commands/commandHandlers.ts); loaded on
 * demand by CommandPalette, which owns the open state and the shortcut.
 */
export function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const openIntent = useCommandPaletteStore((store) => store.openIntent);
  const clearOpenIntent = useCommandPaletteStore((store) => store.clearOpenIntent);
  const composerHandleRef = useComposerHandleContext();
  // Set when a command hands over to another dialog (Add project, Codex
  // import), which then owns where focus returns.
  const handingOverToDialogRef = useRef(false);
  const focusComposer = useCallback(() => {
    composerHandleRef?.current?.focusAtEnd();
  }, [composerHandleRef]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  // The root's filter. Typing ">" first switches to Commands (handleQueryChange).
  const [filter, setFilter] = useState<PaletteFilter>("all");
  // The highlight is a row, not a position: once the user moves to a row it
  // stays on it while rows arrive above it; until then it is the first row.
  const [highlight, setHighlight] = useState<PaletteHighlight>(NO_HIGHLIGHT);
  const { handleNewThread, routeThreadRef } = useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = usePaletteThreads();
  const keybindings = useServerKeybindings();
  const offeredCommands = useOfferedCommands();
  const commandUsage = useCommandUsageStore((store) => store.byKey);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;

  const addProjectEnvironmentOptions = useAddProjectEnvironmentOptions();
  // A typed path offers "Add project at <path>" for the computer Add project
  // starts on, read with that computer's idea of a path.
  const defaultAddProjectEnvironmentId = addProjectEnvironmentOptions[0]?.environmentId ?? null;
  const addProjectPathPlatform = useEnvironmentBrowsePlatform(defaultAddProjectEnvironmentId);

  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectByScopedKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [projects],
  );

  const activeThreadId = routeThreadRef?.threadId;
  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === project.environmentId),
        project.id,
      );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [handleNewThread, navigate, threads],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "project",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            name={project.name}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }).map((row) => ({ ...row, verb: "Open project" })),
    [openProjectFromSearch, projects],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        icon: (thread) => {
          const project = projectByScopedKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          if (!project) {
            return <MessageSquareIcon className={ITEM_ICON_CLASS} />;
          }
          if (project.kind === "general-chat") {
            return <MessagesSquareIcon className={ITEM_ICON_CLASS} />;
          }
          return (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.cwd}
              name={project.name}
              className={ITEM_ICON_CLASS}
            />
          );
        },
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [activeThreadId, navigate, projectByScopedKey, projectTitleById, threads],
  );
  // Where you'd go: the threads last opened on this device, newest first,
  // then the latest activity (pinned or not) to fill the rest; the one on
  // screen left out, and a thread that no longer exists skipped.
  const activeThreadEnvironmentId = routeThreadRef?.environmentId;
  const [recentVisitKeys] = useState(readRecentThreadVisits);
  // Every thread in that order: the Threads filter with nothing typed.
  const threadsByVisit = useMemo(() => {
    const candidates = allThreadItems.filter(
      (item) =>
        !(
          item.threadRef?.id === activeThreadId &&
          item.threadRef?.environmentId === activeThreadEnvironmentId
        ),
    );
    const byKey = new Map(
      candidates.map((item) => [
        scopedThreadKey(scopeThreadRef(item.threadRef!.environmentId, item.threadRef!.id)),
        item,
      ]),
    );
    const visited = recentVisitKeys.flatMap((key) => {
      const item = byKey.get(key);
      return item ? [item] : [];
    });
    const byActivity = candidates
      .filter((item) => !visited.includes(item))
      .toSorted(
        (left, right) =>
          Date.parse(right.timestampAt ?? "") - Date.parse(left.timestampAt ?? "") || 0,
      );
    return [...visited, ...byActivity];
  }, [activeThreadEnvironmentId, activeThreadId, allThreadItems, recentVisitKeys]);
  const threadContentSearchTargets = useMemo<ReadonlyArray<ThreadSearchTarget>>(() => {
    const scopedProjectIds = currentView?.threadSearchProjectIdsByEnvironment;
    if (currentView && !scopedProjectIds) {
      return [];
    }
    if (scopedProjectIds) {
      return [...scopedProjectIds].map(([environmentId, projectIds]) => ({
        environmentId,
        projectIds,
      }));
    }

    return [...new Set(threads.map((thread) => thread.environmentId))].map((environmentId) => ({
      environmentId,
    }));
  }, [currentView, threads]);
  const [debouncedThreadContentQuery] = useDebouncedValue(
    deferredQuery,
    { wait: THREAD_CONTENT_SEARCH_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const threadContentSearchQuery = useQuery(
    threadSearchQueryOptions({
      query: debouncedThreadContentQuery,
      // Every filter counts threads while there is text, so the search runs in each.
      targets: threadContentSearchTargets,
    }),
  );
  const threadContentMatches =
    normalizeSearchText(debouncedThreadContentQuery) === normalizeSearchText(deferredQuery)
      ? (threadContentSearchQuery.data?.matches ?? EMPTY_THREAD_CONTENT_MATCHES)
      : EMPTY_THREAD_CONTENT_MATCHES;
  const allThreadSearchItems = useMemo(
    () =>
      applyThreadContentSearchMatches({
        items: allThreadItems,
        matches: threadContentMatches,
        query: deferredQuery,
      }),
    [allThreadItems, deferredQuery, threadContentMatches],
  );

  // Every offered command, in the catalog's order.
  const commandRows = useMemo(
    () =>
      COMMAND_IDS.flatMap((id) => {
        const command = offeredCommands.get(id);
        return command ? [commandRow(command)] : [];
      }),
    [offeredCommands],
  );
  // The items of lists that the main search finds too (a computer, a theme, a script).
  const searchableListItemRows = useMemo(
    () =>
      COMMAND_IDS.flatMap((id) => {
        const command = offeredCommands.get(id);
        return command && "itemsSearchable" in APP_COMMANDS[id] ? listItemRows(command) : [];
      }),
    [offeredCommands],
  );
  const suggestedRows = useMemo(() => {
    const offeredIds = COMMAND_IDS.filter((id) => {
      const command = offeredCommands.get(id);
      return command !== undefined && command.disabledReason === undefined;
    });
    const rowById = new Map(commandRows.map((row) => [row.command!.id, row]));
    return suggestCommands({
      candidates: offeredIds,
      usage: commandUsage,
      fallback: FIRST_SUGGESTIONS,
      limit: SUGGESTED_COMMAND_LIMIT,
    }).flatMap((id) => {
      const row = rowById.get(id);
      return row ? [{ ...row, value: `suggested:${id}` }] : [];
    });
  }, [commandRows, commandUsage, offeredCommands]);

  const searchText = deferredQuery.trim();
  // A list page or a project's thread search has no filters: it is "all" of its own rows.
  const activeFilter: PaletteFilter = currentView === null ? filter : "all";

  // The Settings source asks what exists here exactly as Settings does, with
  // the palette's opening as the search a fact is read for.
  const [paletteSession] = useState(() => useCommandPaletteStore.getState().openGeneration);
  const settingsSurface = paletteSettingsSurface();
  const { shown: settingShown } = useSettingsAvailability(settingsSurface, {
    // Every filter counts settings while there is text, so it is read in each.
    searchActive: currentView === null && (activeFilter === "settings" || searchText.length > 0),
    searchSession: paletteSession,
  });
  const providers = useServerProviders();
  const openSettingsResult = useOpenSettingsResult({ replace: false });
  const settingEntries = useMemo<ReadonlyArray<PlaceSearchEntry<CommandPaletteActionItem>>>(
    () =>
      settingsSearchItems({
        surface: settingsSurface,
        shown: settingShown,
        providers,
        keybindings,
      })
        // Shortcuts are commands here: they are found as themselves.
        .filter((item) => item.type !== "shortcut")
        .map((item) => {
          const PageIcon = SETTINGS_PAGE_ICONS.get(item.page) ?? SettingsIcon;
          return {
            fields: item.fields,
            order: item.kindRank * 100_000 + item.order,
            value: {
              kind: "action",
              value: `setting:${item.key}`,
              searchTerms: [],
              title: item.fields.title,
              icon: <PageIcon className={ITEM_ICON_CLASS} />,
              whereLabel: settingsSearchItemWhere(item),
              verb: "Go to setting",
              run: async () => openSettingsResult(settingsSearchItemTarget(item)),
            },
          };
        }),
    [keybindings, openSettingsResult, providers, settingShown, settingsSurface],
  );
  // Commands and the items of lists the main search finds, by their own words.
  const commandEntries = useMemo<
    ReadonlyArray<PlaceSearchEntry<CommandPaletteActionItem | CommandPaletteSubmenuItem>>
  >(() => {
    const rowById = new Map(commandRows.map((row) => [row.command!.id, row]));
    const itemRowByValue = new Map(searchableListItemRows.map((row) => [row.value, row]));
    const entries: PlaceSearchEntry<CommandPaletteActionItem | CommandPaletteSubmenuItem>[] = [];
    COMMAND_IDS.forEach((id, order) => {
      const command = offeredCommands.get(id);
      const row = rowById.get(id);
      if (!command || !row) return;
      const spec = APP_COMMANDS[id];
      const title = [command.title ?? spec.title, command.titleEmphasis]
        .filter((part) => part !== undefined)
        .join(" ");
      const about =
        command.disabledReason ?? command.description ?? ("about" in spec ? spec.about : undefined);
      entries.push({
        fields: {
          title,
          keywords: row.searchTerms,
          ...(about ? { about } : {}),
        },
        order,
        usage: commandUsage[id]?.count ?? 0,
        value: row,
      });
      if (!("itemsSearchable" in spec)) return;
      for (const item of command.items ?? []) {
        const itemRow = itemRowByValue.get(`command:${id}:${item.id}`);
        if (!itemRow) continue;
        entries.push({
          fields: {
            title: item.title,
            keywords: item.keywords ?? [],
            ...(item.description ? { about: item.description } : {}),
          },
          order,
          usage: commandUsage[`${id}:${item.id}`]?.count ?? 0,
          value: itemRow,
        });
      }
    });
    return entries;
  }, [commandRows, commandUsage, offeredCommands, searchableListItemRows]);
  const threadEntries = useMemo<ReadonlyArray<ThreadSearchEntry<CommandPaletteActionItem>>>(
    () =>
      allThreadSearchItems.map((item) => ({
        title: item.searchTerms[0] ?? "",
        projectName: item.searchTerms[1] ?? "",
        branch: item.searchTerms[2] ?? "",
        messageScore: item.threadContentMatch?.score ?? null,
        value: item,
      })),
    [allThreadSearchItems],
  );
  const projectEntries = useMemo<ReadonlyArray<PlaceSearchEntry<CommandPaletteActionItem>>>(
    () =>
      projectSearchItems.map((row, order) => ({
        fields: { title: projects[order]?.name ?? "", about: projects[order]?.cwd ?? "" },
        order,
        value: row,
      })),
    [projectSearchItems, projects],
  );
  const searching = currentView === null && searchText.length > 0;
  const searchResult = useMemo(
    () =>
      searching
        ? paletteSearch({
            query: searchText,
            threads: threadEntries,
            commands: commandEntries,
            settings: settingEntries,
            projects: projectEntries,
          })
        : null,
    [commandEntries, projectEntries, searchText, searching, settingEntries, threadEntries],
  );
  const filterCounts = useMemo(
    () => (searchResult ? paletteFilterCounts(searchResult) : null),
    [searchResult],
  );

  function pushPaletteView(view: CommandPaletteView): void {
    setViewStack((previousViews) => [...previousViews, view]);
    setHighlight(NO_HIGHLIGHT);
    setQuery(view.initialQuery ?? "");
  }

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function pushListView(id: AppCommandId): void {
    const placeholder = offeredCommands.get(id)?.placeholder;
    pushPaletteView({
      addonIcon: commandIcon(id, ADDON_ICON_CLASS),
      groups: [],
      listCommandId: id,
      ...(placeholder ? { inputPlaceholder: placeholder } : {}),
    });
  }

  function popView(): void {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlight(NO_HIGHLIGHT);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlight(NO_HIGHLIGHT);
    // ">" first is the Commands filter, and leaves the field: one state, not two.
    if (currentView === null && nextQuery.startsWith(">")) {
      setFilter("commands");
      setQuery(nextQuery.slice(1).trimStart());
      return;
    }
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  function chooseFilter(next: PaletteFilter): void {
    setFilter(next);
    setHighlight(NO_HIGHLIGHT);
  }

  // Sidebar "Search all N threads" hands off here: a submenu view scoped to
  // one logical project's threads, searchable with the usual palette ranking.
  useLayoutEffect(() => {
    if (openIntent?.kind !== "search-threads") {
      return;
    }
    clearOpenIntent();
    const memberProjectKeys = new Set(openIntent.memberProjectKeys);
    const projectThreads = threads.filter((thread) =>
      memberProjectKeys.has(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      ),
    );
    const projectIdsByEnvironment = new Map<EnvironmentId, ProjectId[]>();
    for (const thread of projectThreads) {
      const projectIds = projectIdsByEnvironment.get(thread.environmentId) ?? [];
      if (!projectIds.includes(thread.projectId)) {
        projectIds.push(thread.projectId);
        projectIdsByEnvironment.set(thread.environmentId, projectIds);
      }
    }
    pushPaletteView({
      addonIcon: <MessageSquareIcon className={ADDON_ICON_CLASS} />,
      inputPlaceholder: `Search threads in ${openIntent.projectName}...`,
      threadSearchProjectIdsByEnvironment: projectIdsByEnvironment,
      groups: [
        {
          value: "project-threads",
          label: `Threads in ${openIntent.projectName}`,
          items: buildThreadActionItems({
            threads: projectThreads,
            ...(activeThreadId ? { activeThreadId } : {}),
            projectTitleById,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
            renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          }),
        },
      ],
    });
  }, [activeThreadId, clearOpenIntent, navigate, openIntent, projectTitleById, threads]);

  const allCommandsItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:all-commands",
    searchTerms: [],
    title: "All commands",
    icon: null,
    more: true,
    keepOpen: true,
    run: async () => {
      chooseFilter("commands");
      setQuery("");
    },
  };
  // Each kind's rows with nothing typed, as its filter lists them.
  const unfilteredGroups = (kind: PaletteFilter): ReadonlyArray<CommandPaletteGroup> => {
    switch (kind) {
      case "all":
        return buildOpeningGroups({
          recentThreadItems: threadsByVisit.slice(0, RECENT_THREAD_LIMIT),
          suggestedItems: suggestedRows,
          allCommandsItem,
        });
      case "threads":
        return [{ value: "recent-threads", label: "Recent", items: threadsByVisit }];
      case "commands":
        return COMMAND_GROUP_ORDER.flatMap((group) => {
          const items = commandRows.filter(
            (row) => row.command && APP_COMMANDS[row.command.id].group === group,
          );
          return items.length > 0
            ? [{ value: `commands:${group}`, label: APP_COMMAND_GROUP_TITLES[group], items }]
            : [];
        });
      case "settings":
        return [
          {
            value: "settings-search",
            label: "Settings",
            items: settingEntries.map((entry) => entry.value),
          },
        ];
      case "projects":
        return [{ value: "projects-search", label: "Projects", items: projectSearchItems }];
    }
  };
  // A list page draws from the command's items now, not a copy from when it
  // opened, so a script renamed while its list is open shows its new name.
  const activeGroups: ReadonlyArray<CommandPaletteGroup> = currentView
    ? currentView.listCommandId !== undefined
      ? listPageGroups(offeredCommands.get(currentView.listCommandId))
      : currentView.groups.map((group) => ({
          ...group,
          items: applyThreadContentSearchMatches({
            items: group.items,
            matches: threadContentMatches,
            query: deferredQuery,
          }),
        }))
    : // A kind with nothing in it says so (emptyStateMessage) instead of a bare heading.
      unfilteredGroups(activeFilter).filter((group) => group.items.length > 0);

  const archivedThreadsItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:archived-threads",
    searchTerms: [],
    title: "Look in archived threads",
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
    whereLabel: "Settings › Archived threads",
    run: async () => openSettingsResult({ placeId: "settings.archived" }),
  };
  // A "Show all N" row: the rest of a kind's group, under its own filter.
  const showAllItem = (source: PaletteSource, total: number): CommandPaletteActionItem => ({
    kind: "action",
    value: `more:${source}`,
    searchTerms: [],
    title: `Show all ${total} ${SECTION_GROUPS[source].noun}`,
    icon: null,
    more: true,
    keepOpen: true,
    run: async () => chooseFilter(source),
  });
  // The root's search: four sources in one ordering (commands/paletteSearch),
  // shown through the filter. List pages and a project's thread search keep
  // filtering their own rows.
  const listGroups = searchResult
    ? null
    : searchText.length === 0 && currentView === null
      ? activeGroups
      : filterCommandPaletteGroups({
          activeGroups,
          query: deferredQuery,
          isInSubmenu: currentView !== null,
          projectSearchItems: projectSearchItems,
          threadSearchItems: allThreadSearchItems,
        });
  const filteredSearch = useMemo(
    () => (searchResult ? filterPaletteSearch(searchResult, activeFilter) : null),
    [activeFilter, searchResult],
  );
  // What the palette says about a search over messages (the root's, or a
  // project's thread search): still searching, a computer that couldn't
  // answer or stopped early, and No matches only once the answer for the
  // text in the field is in. Only where threads are shown.
  const searchesThreadsHere =
    currentView === null
      ? activeFilter === "all" || activeFilter === "threads"
      : currentView.threadSearchProjectIdsByEnvironment !== undefined;
  const messageSearch = searchesThreadsHere && searchText.length > 0;
  const computerNames = new Map(
    addProjectEnvironmentOptions.map((option) => [option.environmentId, option.label]),
  );
  const shownRowCount = filteredSearch
    ? filteredSearch.sections.reduce((total, section) => total + section.total, 0) +
      filteredSearch.closeMatches.length
    : (listGroups ?? []).reduce((total, group) => total + group.items.length, 0);
  const searchStatus = messageSearch
    ? paletteSearchStatus({
        searchesMessages:
          threadContentSearchTargets.length > 0 && canSearchThreadContent(searchText),
        // The field's own text, not only the deferred one the list was drawn
        // for, so a keystroke never inherits the last text's answer.
        answeredCurrentText:
          query === deferredQuery &&
          normalizeSearchText(debouncedThreadContentQuery) === normalizeSearchText(deferredQuery) &&
          threadContentSearchQuery.data !== undefined,
        outcomes: (threadContentSearchQuery.data?.outcomes ?? []).map((entry) => ({
          computerName: computerNames.get(entry.environmentId) ?? "a linked computer",
          outcome: entry.outcome,
        })),
        rowCount: shownRowCount,
      })
    : null;
  const filteredGroups: ReadonlyArray<CommandPaletteGroup> = [
    ...(filteredSearch
      ? [
          ...filteredSearch.sections.map((section) => ({
            value: SECTION_GROUPS[section.source].value,
            label: SECTION_GROUPS[section.source].label,
            items: [
              ...(section.source === "commands" && activeFilter === "all"
                ? section.rows.map(withCommandGroup)
                : section.rows),
              ...(section.total > section.rows.length
                ? [showAllItem(section.source, section.total)]
                : []),
            ],
          })),
          // Only once messages are searched too: a message match would end them.
          ...(filteredSearch.closeMatches.length > 0 && !searchStatus?.searching
            ? [
                {
                  value: "close-matches",
                  label: "Close matches",
                  items: filteredSearch.closeMatches.map((row) => ({
                    ...row,
                    value: `close:${row.value}`,
                  })),
                },
              ]
            : []),
        ]
      : (listGroups ?? [])),
    ...(searchStatus?.noMatches
      ? [{ value: "no-matches", label: "No matches", items: [archivedThreadsItem] }]
      : []),
  ];

  // A typed path adds one row above the results that opens Add project there.
  // The search itself carries on underneath, so the field never turns into a
  // form.
  const addProjectPathItem: CommandPaletteActionItem | null =
    currentView === null &&
    activeFilter === "all" &&
    isFilesystemBrowseQuery(deferredQuery, addProjectPathPlatform)
      ? {
          kind: "action",
          value: "action:add-project-at-path",
          searchTerms: [],
          title: `Add project at ${deferredQuery.trim()}`,
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          verb: "Add project",
          opensDialog: true,
          run: async () => {
            openAddProject({ initialPath: deferredQuery.trim(), returnFocus: focusComposer });
          },
        }
      : null;
  const displayedGroups: CommandPaletteView["groups"] = addProjectPathItem
    ? [
        { value: "add-project-path", label: "Add project", items: [addProjectPathItem] },
        ...filteredGroups,
      ]
    : filteredGroups;
  const emptyStateMessage =
    displayedGroups.length > 0 || searchStatus
      ? null
      : searchText.length > 0
        ? `No matching ${currentView === null && activeFilter !== "all" ? SECTION_GROUPS[activeFilter].noun : "results"}`
        : currentView === null && activeFilter === "projects"
          ? "No projects yet"
          : currentView === null && activeFilter === "threads"
            ? "No other threads yet"
            : "Nothing here";

  // The highlighted row: the one the user moved to while it is still listed,
  // else the first. A chosen row that went away hands the highlight back to
  // the first row for good.
  const selectableRows = displayedGroups.flatMap((group) =>
    group.items.filter((item) => !item.disabled),
  );
  const chosenRowListed =
    highlight.moved && selectableRows.some((item) => item.value === highlight.value);
  if (highlight.moved && !chosenRowListed) {
    setHighlight(NO_HIGHLIGHT);
  }
  const activeItem =
    (chosenRowListed
      ? selectableRows.find((item) => item.value === highlight.value)
      : selectableRows[0]) ?? null;
  const activeValue = activeItem?.value ?? null;
  const listId = useId();
  const allRows = displayedGroups.flatMap((group) => group.items);
  const activeRowIndex =
    activeValue === null ? -1 : allRows.findIndex((item) => item.value === activeValue);
  const listRef = useRef<HTMLDivElement | null>(null);
  // A different list (another filter, page or text) starts at its top, even
  // when its first row has the same place as the last list's.
  const shownList = `${activeFilter}\u0000${viewStack.length}\u0000${deferredQuery}`;
  const lastShownListRef = useRef(shownList);
  useLayoutEffect(() => {
    if (lastShownListRef.current === shownList) return;
    lastShownListRef.current = shownList;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [shownList]);
  // Keep the highlighted row in view: a row the user moved to scrolls just
  // into view; the first row (nothing chosen yet) brings the list to its top.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!highlight.moved) {
      list.scrollTop = 0;
      return;
    }
    if (activeRowIndex < 0) return;
    document
      .getElementById(paletteRowId(listId, activeRowIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeRowIndex, highlight.moved, listId]);

  // The thread a highlighted result opens starts loading once the highlight
  // rests on it, as a pointer resting on a sidebar row does, so choosing it
  // opens a chat that is ready or already on its way.
  const highlightedThreadKey = highlightedThreadKeyOf(displayedGroups, activeValue);
  useEffect(() => {
    const ref = highlightedThreadKey ? parseScopedThreadKey(highlightedThreadKey) : null;
    return ref ? prewarmHighlightedThread(ref) : undefined;
  }, [highlightedThreadKey]);

  const isSubmenu = currentView !== null;
  const inputPlaceholder =
    currentView?.inputPlaceholder ?? getCommandPaletteInputPlaceholder(isSubmenu);

  function moveHighlight(step: 1 | -1): void {
    if (selectableRows.length === 0) return;
    const index = selectableRows.findIndex((item) => item.value === activeValue);
    const next = selectableRows[Math.min(Math.max(index + step, 0), selectableRows.length - 1)];
    if (next) setHighlight({ value: next.value, moved: true });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // An input method's Enter confirms its text (Safari reports it as key 229).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        moveHighlight(event.key === "ArrowDown" ? 1 : -1);
        return;
      case "Enter":
        event.preventDefault();
        if (activeItem) executeItem(activeItem);
        return;
      case "Tab":
        // Focus stays in the field; at the root Tab moves between the filters.
        event.preventDefault();
        if (!isSubmenu) chooseFilter(stepPaletteFilter(filter, event.shiftKey ? -1 : 1));
        return;
      case "Escape":
        // In stages: the text, then the filter, then (left to the dialog) close.
        if (query !== "") {
          event.preventDefault();
          event.stopPropagation();
          handleQueryChange("");
        } else if (!isSubmenu && filter !== "all") {
          event.preventDefault();
          event.stopPropagation();
          chooseFilter("all");
        }
        return;
      case "Backspace":
        if (query === "" && isSubmenu) {
          event.preventDefault();
          popView();
        }
        return;
    }
  }

  function reportFailure(error: unknown): void {
    toastManager.add(
      failureNotice({
        title: "Couldn't run the command",
        error,
      }),
    );
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    // A command runs what its owner registered now, looked up again by id.
    if (item.command) {
      const outcome = runCommand({
        id: item.command.id,
        itemId: item.command.itemId,
        close: ({ handingOver }) => {
          // A dialog taking over decides where focus goes when it closes, so
          // the palette leaves the composer alone on its way out.
          if (handingOver) handingOverToDialogRef.current = true;
          setOpen(false);
        },
        recordUse: (key) => useCommandUsageStore.getState().recordUse(key),
        onError: reportFailure,
      });
      if (outcome === "list") pushListView(item.command.id);
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      if (item.opensDialog) handingOverToDialogRef.current = true;
      setOpen(false);
    }
    // Every result naming a thread opens it: start its load now, so closing
    // the palette (which ends the highlight's prewarm) does not drop it.
    if (item.threadRef) {
      holdThreadDetailForOpen(scopeThreadRef(item.threadRef.environmentId, item.threadRef.id));
    }

    const execution =
      item.threadRef && item.threadContentMatch
        ? navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(item.threadRef.environmentId, item.threadRef.id),
            ),
            search: (current) => ({
              ...closeRightPanelSearchParams(current),
              focusMessageId: item.threadContentMatch?.messageId,
              focusQuery: item.threadContentMatch?.query,
              focusRequest: newCommandId(),
            }),
          })
        : item.run();

    void execution.catch(reportFailure);
  }

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="p-0"
      data-testid="command-palette"
      finalFocus={() => {
        if (handingOverToDialogRef.current) return false;
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      {/* Commands that need only stores and navigation register while the palette is open. */}
      <PaletteCommandSources />
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        {isSubmenu ? (
          <button
            type="button"
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Back"
            onClick={popView}
          >
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : (
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          // A new page of the palette starts its field afresh.
          key={viewStack.length}
          aria-activedescendant={
            activeRowIndex >= 0 ? paletteRowId(listId, activeRowIndex) : undefined
          }
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-label="Command palette"
          autoComplete="off"
          autoFocus
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={inputPlaceholder}
          role="combobox"
          spellCheck={false}
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {isSubmenu ? null : (
        <div
          aria-label="Show"
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]"
          role="toolbar"
        >
          {PALETTE_FILTERS.map((option) => {
            const count = searchText.length > 0 ? filterCounts?.[option.id] : undefined;
            const chosen = option.id === filter;
            return (
              <button
                aria-pressed={chosen}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-baseline gap-1.5 rounded-lg px-2 py-[3px] text-[12.5px] whitespace-nowrap",
                  chosen
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-slot="command-filter"
                key={option.id}
                // Clicking a filter leaves the field focused.
                tabIndex={-1}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseFilter(option.id)}
              >
                {option.label}
                {count !== undefined ? (
                  <span className="font-mono text-[10.5px] font-normal text-muted-foreground">
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <CommandPanel>
        <div
          className="max-h-[min(480px,62vh)] overflow-y-auto overscroll-contain pt-0.5"
          ref={listRef}
        >
          <PaletteResultList
            activeValue={activeValue}
            emptyStateMessage={emptyStateMessage}
            groups={displayedGroups}
            keybindings={keybindings}
            listId={listId}
            query={deferredQuery}
            statusLines={
              searchStatus
                ? [
                    ...(searchStatus.searching ? ["Searching messages…"] : []),
                    ...searchStatus.lines,
                  ]
                : []
            }
            onExecuteItem={executeItem}
            onHighlight={(value) => setHighlight({ value, moved: true })}
          />
        </div>
      </CommandPanel>
      {/* Keys only help with a keyboard: no footer on touch. */}
      <CommandFooter className="pointer-coarse:hidden">
        <KbdGroup className="items-center gap-1.5">
          <Kbd>
            <ArrowUpIcon />
            <ArrowDownIcon />
          </Kbd>
          <span>Move</span>
        </KbdGroup>
        {activeItem ? (
          <KbdGroup className="items-center gap-1.5">
            <Kbd>
              <CornerDownLeftIcon />
            </Kbd>
            <span>{paletteRowVerb(activeItem)}</span>
          </KbdGroup>
        ) : null}
        {isSubmenu ? (
          <KbdGroup className="items-center gap-1.5">
            <Kbd>
              <DeleteIcon />
            </Kbd>
            <span>Back</span>
          </KbdGroup>
        ) : (
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Tab</Kbd>
            <span>Filter</span>
          </KbdGroup>
        )}
      </CommandFooter>
    </CommandDialogPopup>
  );
}
