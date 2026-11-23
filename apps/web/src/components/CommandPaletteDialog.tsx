"use client";

import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { type EnvironmentId, KeybindingCommand, type ProjectId } from "@threadlines/contracts";
import { APP_COMMANDS, type AppCommandId } from "@threadlines/shared/appCommands";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CommandIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  SettingsIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
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
  RECENT_THREAD_LIMIT,
  SUGGESTED_COMMAND_LIMIT,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
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
import {
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
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
/** How each source's section is headed. */
const SECTION_GROUPS: Readonly<Record<PaletteSource, { value: string; label: string }>> = {
  threads: { value: "threads-search", label: "Threads" },
  commands: { value: "actions", label: "Commands" },
  settings: { value: "settings-search", label: "Settings" },
  projects: { value: "projects-search", label: "Projects" },
};
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
  const description =
    command.disabledReason ?? command.description ?? ("about" in spec ? spec.about : undefined);
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
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
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
      }),
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
  const recentThreadItems = useMemo(() => {
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
    return [...visited, ...byActivity].slice(0, RECENT_THREAD_LIMIT);
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
      targets: threadContentSearchTargets,
      enabled: !isActionsOnly,
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

  const searchText = (isActionsOnly ? deferredQuery.slice(1) : deferredQuery).trim();

  // The Settings source asks what exists here exactly as Settings does, with
  // the palette's opening as the search a fact is read for.
  const [paletteSession] = useState(() => useCommandPaletteStore.getState().openGeneration);
  const settingsSurface = paletteSettingsSurface();
  const { shown: settingShown } = useSettingsAvailability(settingsSurface, {
    searchActive: searchText.length > 0 && !isActionsOnly,
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
      entries.push({
        fields: {
          title,
          keywords: row.searchTerms,
          ...(row.description ? { about: row.description } : {}),
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
            filter: isActionsOnly ? "commands" : "all",
            threads: threadEntries,
            commands: commandEntries,
            settings: settingEntries,
            projects: projectEntries,
          })
        : null,
    [
      commandEntries,
      isActionsOnly,
      projectEntries,
      searchText,
      searching,
      settingEntries,
      threadEntries,
    ],
  );

  function pushPaletteView(view: CommandPaletteView): void {
    setViewStack((previousViews) => [...previousViews, view]);
    setHighlightedItemValue(null);
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
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
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
    description: "Type > to search only commands",
    icon: <CommandIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      setHighlightedItemValue(null);
      setQuery(">");
    },
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
    : deferredQuery.length === 0
      ? buildOpeningGroups({ recentThreadItems, suggestedItems: suggestedRows, allCommandsItem })
      : // ">" alone: every command, in the catalog's order.
        [{ value: "actions", label: "Commands", items: commandRows }];

  const archivedThreadsItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:archived-threads",
    searchTerms: [],
    title: "Look in archived threads",
    description: "Archived threads aren't searched here",
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
    whereLabel: "Settings › Archived threads",
    run: async () => openSettingsResult({ placeId: "settings.archived" }),
  };
  // The root's search: four sources in one ordering (commands/paletteSearch).
  // List pages and a project's thread search keep filtering their own rows.
  const listGroups = searchResult
    ? null
    : filterCommandPaletteGroups({
        activeGroups,
        query: deferredQuery,
        isInSubmenu: currentView !== null,
        projectSearchItems: projectSearchItems,
        threadSearchItems: allThreadSearchItems,
      });
  // What the palette says about a search over messages (the root's, or a
  // project's thread search): still searching, a computer that couldn't
  // answer or stopped early, and No matches only once the answer for the
  // text in the field is in.
  const searchesThreadsHere =
    currentView === null || currentView.threadSearchProjectIdsByEnvironment !== undefined;
  const messageSearch = searchesThreadsHere && searchText.length > 0;
  const computerNames = new Map(
    addProjectEnvironmentOptions.map((option) => [option.environmentId, option.label]),
  );
  const searchStatus = messageSearch
    ? paletteSearchStatus({
        searchesMessages:
          !isActionsOnly &&
          threadContentSearchTargets.length > 0 &&
          canSearchThreadContent(searchText),
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
        rowCount: searchResult
          ? searchResult.sections.reduce((total, section) => total + section.rows.length, 0) +
            searchResult.closeMatches.length
          : (listGroups ?? []).reduce((total, group) => total + group.items.length, 0),
      })
    : null;
  const filteredGroups: ReadonlyArray<CommandPaletteGroup> = [
    ...(searchResult
      ? [
          ...searchResult.sections.map((section) => ({
            value: SECTION_GROUPS[section.source].value,
            label: SECTION_GROUPS[section.source].label,
            items: section.rows.map((row) => row.value),
          })),
          // Only once messages are searched too: a message match would end them.
          ...(searchResult.closeMatches.length > 0 && !searchStatus?.searching
            ? [
                {
                  value: "close-matches",
                  label: "Close matches",
                  items: searchResult.closeMatches.map((row) => ({
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
    currentView === null && isFilesystemBrowseQuery(deferredQuery, addProjectPathPlatform)
      ? {
          kind: "action",
          value: "action:add-project-at-path",
          searchTerms: [],
          title: `Add project at ${deferredQuery.trim()}`,
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
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

  // The thread a highlighted result opens starts loading once the highlight
  // rests on it, as a pointer resting on a sidebar row does, so choosing it
  // opens a chat that is ready or already on its way.
  const highlightedThreadKey = highlightedThreadKeyOf(displayedGroups, highlightedItemValue);
  useEffect(() => {
    const ref = highlightedThreadKey ? parseScopedThreadKey(highlightedThreadKey) : null;
    return ref ? prewarmHighlightedThread(ref) : undefined;
  }, [highlightedThreadKey]);

  const isSubmenu = currentView !== null;
  const inputPlaceholder =
    currentView?.inputPlaceholder ?? getCommandPaletteInputPlaceholder(isSubmenu);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
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
      className="overflow-hidden p-0"
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
      <Command
        key={viewStack.length}
        aria-label="Command palette"
        autoHighlight="always"
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <CommandInput
          placeholder={inputPlaceholder}
          wrapperClassName={
            isSubmenu ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
          }
          {...(isSubmenu
            ? {
                startAddon: (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center"
                    aria-label="Back"
                    onClick={popView}
                  >
                    <ArrowLeftIcon />
                  </button>
                ),
              }
            : {})}
          onKeyDown={handleKeyDown}
        />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            groups={displayedGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={isActionsOnly}
            {...(searchStatus
              ? {
                  statusLines: [
                    ...(searchStatus.searching ? ["Searching messages…"] : []),
                    ...searchStatus.lines,
                  ],
                  emptyStateMessage: "",
                }
              : {})}
            keybindings={keybindings}
            query={deferredQuery}
            onExecuteItem={executeItem}
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Select</span>
            </KbdGroup>
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
