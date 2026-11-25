"use client";

import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import {
  type EnvironmentId,
  type ScopedProjectRef,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
} from "@threadlines/contracts";
import { deriveRepositoryDirectoryName, normalizeGitRemoteUrl } from "@threadlines/shared/git";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  CornerLeftUpIcon,
  DeleteIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  hasSavedEnvironmentRegistryHydrated,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
} from "../../environments/runtime";
import { isHostedStaticApp } from "../../hostedPairing";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { resolveDialogReturnFocus } from "../../lib/dialogReturnFocus";
import { gitCloneRepositoryMutationOptions, runGitMutation } from "../../lib/gitReactQuery";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  resolveCloneDestinationPathForDispatch,
  resolveProjectPathForDispatch,
} from "../../lib/projectPaths";
import {
  getSourceControlDiscoverySnapshot,
  refreshSourceControlDiscovery,
} from "../../lib/sourceControlDiscoveryState";
import { getLatestThreadForProject } from "../../lib/threadSort";
import { cn, isMacPlatform, newCommandId, newProjectId } from "../../lib/utils";
import { waitForProjectInStore } from "../../lib/waitForProject";
import { readLocalApi } from "../../localApi";
import { useServerKeybindings } from "../../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useWorktreePickupStore } from "../../worktreePickup";
import {
  ADDON_ICON_CLASS,
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
} from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";
import { editorLabel } from "../../editorLabels";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  COMMAND_GROUP_CLASS,
  COMMAND_ROW_CLASS,
  COMMAND_SECTION_LABEL_CLASS,
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
  CommandTitle,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { failureNotice, stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ADD_PROJECT_PATH_PLACEHOLDER,
  buildBrowseGroups,
  filterBrowseEntries,
  resolveAddProjectUnavailableGuidance,
} from "./addProject.logic";
import {
  useAddProjectEnvironmentOptions,
  useEnvironmentBrowsePlatform,
} from "./addProjectComputers";
import { finishAddProject, useAddProjectStore, type AddProjectSession } from "./addProjectStore";

const EMPTY_BROWSE_ENTRIES: never[] = [];
const BROWSE_STALE_TIME_MS = 30_000;
const GITHUB_REPOSITORY_LIST_LIMIT = 100;
const GITHUB_REPOSITORY_LIST_STALE_TIME_MS = 60_000;

/** A step of the dialog, and the computer it is adding on (null: the default one). */
interface AddProjectView extends CommandPaletteView {
  readonly environmentId: EnvironmentId | null;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  switch (source) {
    case "github":
      return <GitHubIcon className={className} />;
    case "gitlab":
      return <GitLabIcon className={className} />;
    case "bitbucket":
      return <BitbucketIcon className={className} />;
    case "azure-devops":
      return <AzureDevOpsIcon className={className} />;
    case "url":
      return <LinkIcon className={className} />;
  }
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`;
}

function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = remoteProjectSourceProvider(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

function sourceControlRepositoryComparisonKeys(
  repository: SourceControlRepositoryInfo,
): ReadonlyArray<string> {
  return [repository.sshUrl, repository.url]
    .map((remoteUrl) => normalizeGitRemoteUrl(remoteUrl))
    .filter((key) => key.length > 0);
}

function getAddProjectCloneDirectoryName(
  input: Extract<AddProjectCloneFlow, { readonly step: "confirm" }>,
): string | null {
  return (
    deriveRepositoryDirectoryName(input.repository?.nameWithOwner) ??
    deriveRepositoryDirectoryName(input.remoteUrl) ??
    deriveRepositoryDirectoryName(input.repositoryInput)
  );
}

/**
 * Says a project was added after the dialog that started it went away, with
 * a button that opens it.
 */
function announceProjectAdded(title: string, openProject: () => Promise<void>): void {
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Added ${title}`,
      actionProps: {
        children: "Open",
        onClick: () => {
          void openProject();
        },
      },
      actionVariant: "outline",
    }),
  );
}

/**
 * The open Add project dialog: pick a computer and a source, then browse to a
 * folder or clone a repository. Loaded on demand by AddProjectDialog, which
 * owns the session; mounted once per session.
 */
export function OpenAddProjectDialog({ session }: { session: AddProjectSession }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const keybindings = useServerKeybindings();
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const addProjectEnvironmentOptions = useAddProjectEnvironmentOptions();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [viewStack, setViewStack] = useState<AddProjectView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  // The clone step on screen now, for a lookup that answers after the user
  // went Back or picked another computer.
  const cloneFlowRef = useRef<AddProjectCloneFlow | null>(null);
  useEffect(() => {
    cloneFlowRef.current = addProjectCloneFlow;
  }, [addProjectCloneFlow]);
  const closeDialog = useCallback(() => {
    useAddProjectStore.getState().closeSession(session.id);
  }, [session.id]);

  const defaultAddProjectEnvironmentId = addProjectEnvironmentOptions[0]?.environmentId ?? null;
  const browseEnvironmentId = currentView?.environmentId ?? defaultAddProjectEnvironmentId;
  const browseEnvironmentPlatform = useEnvironmentBrowsePlatform(browseEnvironmentId);
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  const isBrowsing =
    !isRemoteProjectRepositoryStep && isFilesystemBrowseQuery(query, browseEnvironmentPlatform);
  // The first step has no step before it to go back to.
  const isSubmenu = viewStack.length > 1;
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environmentSettings =
        environmentId && primaryEnvironmentId && environmentId === primaryEnvironmentId
          ? settings
          : environmentId
            ? savedEnvironmentRuntimeById[environmentId]?.serverConfig?.settings
            : null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [primaryEnvironmentId, savedEnvironmentRuntimeById, settings],
  );

  const existingGitHubRepositoryKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const project of projects) {
      const canonicalKey = project.repositoryIdentity?.canonicalKey?.trim().toLowerCase() ?? "";
      if (canonicalKey.startsWith("github.com/")) {
        keys.add(canonicalKey);
      }
      const remoteUrl = project.repositoryIdentity?.locator.remoteUrl;
      if (remoteUrl) {
        const remoteKey = normalizeGitRemoteUrl(remoteUrl);
        if (remoteKey.startsWith("github.com/")) {
          keys.add(remoteKey);
        }
      }
    }
    return keys;
  }, [projects]);

  // A relative path resolves against the open project's folder, and only on
  // that project's computer.
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const openProjectCwd =
    currentProjectId && currentProjectEnvironmentId
      ? (projects.find(
          (project) =>
            project.id === currentProjectId &&
            project.environmentId === currentProjectEnvironmentId,
        )?.cwd ?? null)
      : null;
  // Taken when the dialog opens, so a route change behind it (the desktop
  // menu's Back) cannot move where a relative path lands.
  const [relativeBase] = useState(() =>
    currentProjectEnvironmentId && openProjectCwd
      ? { environmentId: currentProjectEnvironmentId, cwd: openProjectCwd }
      : null,
  );
  const currentProjectCwdForBrowse =
    relativeBase && browseEnvironmentId === relativeBase.environmentId ? relativeBase.cwd : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseDirectoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const browseFilterQuery =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";

  const fetchBrowseResult = useCallback(
    async (partialPath: string) => {
      if (!browseEnvironmentId) return null;
      const api = readEnvironmentApi(browseEnvironmentId);
      if (!api) return null;
      return api.filesystem.browse({
        partialPath,
        ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse],
  );

  const { data: browseResult, isPending: isBrowsePending } = useQuery({
    queryKey: [
      "filesystemBrowse",
      browseEnvironmentId,
      browseDirectoryPath,
      currentProjectCwdForBrowse,
    ],
    queryFn: () => fetchBrowseResult(browseDirectoryPath),
    staleTime: BROWSE_STALE_TIME_MS,
    enabled:
      isBrowsing &&
      browseDirectoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject,
  });
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const {
    filteredEntries: filteredBrowseEntries,
    highlightedEntry: highlightedBrowseEntry,
    exactEntry: exactBrowseEntry,
  } = useMemo(
    () => filterBrowseEntries({ browseEntries, browseFilterQuery, highlightedItemValue }),
    [browseEntries, browseFilterQuery, highlightedItemValue],
  );
  const isGitHubRepositorySelectionStep =
    addProjectCloneFlow?.step === "repository" && addProjectCloneFlow.source === "github";
  const gitHubRepositorySelectionEnvironmentId = isGitHubRepositorySelectionStep
    ? addProjectCloneFlow.environmentId
    : null;
  const gitHubRepositoriesQuery = useQuery({
    queryKey: [
      "sourceControlRepositories",
      gitHubRepositorySelectionEnvironmentId,
      "github",
      GITHUB_REPOSITORY_LIST_LIMIT,
    ],
    queryFn: async () => {
      if (!gitHubRepositorySelectionEnvironmentId) {
        return { repositories: [] };
      }
      const api = readEnvironmentApi(gitHubRepositorySelectionEnvironmentId);
      if (!api) {
        return { repositories: [] };
      }
      return api.sourceControl.listRepositories({
        provider: "github",
        limit: GITHUB_REPOSITORY_LIST_LIMIT,
      });
    },
    staleTime: GITHUB_REPOSITORY_LIST_STALE_TIME_MS,
    enabled: gitHubRepositorySelectionEnvironmentId !== null,
  });

  const prefetchBrowsePath = useCallback(
    (partialPath: string) => {
      void queryClient.prefetchQuery({
        queryKey: [
          "filesystemBrowse",
          browseEnvironmentId,
          partialPath,
          currentProjectCwdForBrowse,
        ],
        queryFn: () => fetchBrowseResult(partialPath),
        staleTime: BROWSE_STALE_TIME_MS,
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, fetchBrowseResult, queryClient],
  );

  // Prefetch the parent and the most likely next child so browse navigation
  // stays warm without scanning every child directory in large trees.
  useEffect(() => {
    if (!isBrowsing || filteredBrowseEntries.length === 0) return;

    if (canNavigateUp(query)) {
      prefetchBrowsePath(getBrowseParentPath(query)!);
    }

    const nextChild = highlightedBrowseEntry ?? exactBrowseEntry;
    if (nextChild) {
      prefetchBrowsePath(appendBrowsePathSegment(query, nextChild.name));
    }
  }, [
    exactBrowseEntry,
    filteredBrowseEntries.length,
    highlightedBrowseEntry,
    isBrowsing,
    prefetchBrowsePath,
    query,
  ]);

  const pushView = useCallback((view: AddProjectView): void => {
    setViewStack((previousViews) => [...previousViews, view]);
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  }, []);

  function popView(): void {
    if (viewStack.length <= 1) {
      return;
    }
    setAddProjectCloneFlow(null);
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery && isSubmenu) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectCloneFlow(null);
      const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
          groups: [],
          initialQuery,
          environmentId,
        },
      ]);
      setHighlightedItemValue(null);
      setQuery(initialQuery);
    },
    [getAddProjectInitialQueryForEnvironment],
  );

  const startAddProjectClone = useCallback(
    (environmentId: EnvironmentId, source: AddProjectRemoteSource): void => {
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
          groups: [],
          initialQuery: "",
          environmentId,
        },
      ]);
      setHighlightedItemValue(null);
      setQuery("");
    },
    [],
  );

  const openSourceControlSettings = useCallback(() => {
    closeDialog();
    void navigate({ to: "/settings/source-control" });
  }, [closeDialog, navigate]);

  const buildAddProjectSourceGroups = useCallback(
    (
      environmentId: EnvironmentId,
      readinessBySource: AddProjectRemoteSourceReadiness,
    ): CommandPaletteView["groups"] => {
      const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
        {
          kind: "action",
          value: `action:add-project:${environmentId}:local`,
          searchTerms: ["local", "folder", "directory", "browse"],
          title: "Local folder",
          description: "Browse a folder on disk",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            startAddProjectBrowse(environmentId);
          },
        },
      ];

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = remoteProjectSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${remoteProjectSourcePathHint(source)}`;
        const readiness = readinessBySource[source];
        const disabledHint = readiness.hint;

        const titleTrailingContent = readiness.ready ? undefined : (
          <span className="ml-auto">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-5 rounded-[var(--app-radius-badge)] px-1.5 text-[10px] text-warning-foreground"
                    onClick={() => {
                      openSourceControlSettings();
                    }}
                  >
                    Setup Required
                  </Button>
                }
              />
              <TooltipPopup align="end" side="left">
                {disabledHint ?? "Open Settings -> Source Control to configure this provider."}
              </TooltipPopup>
            </Tooltip>
          </span>
        );

        if (!readiness.ready) {
          sourceItems.push({
            kind: "action",
            value: `action:add-project:${environmentId}:${source}:not-ready`,
            searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
            title,
            description,
            disabled: true,
            icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
            ...(titleTrailingContent ? { titleTrailingContent } : {}),
            run: async () => {},
          });
          continue;
        }

        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label],
          title,
          description,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          keepOpen: true,
          run: async () => {
            startAddProjectClone(environmentId, source);
          },
        });
      }

      return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
    },
    [openSourceControlSettings, startAddProjectBrowse, startAddProjectClone],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectCloneFlow(null);
      const target = { environmentId };
      const initialDiscovery = getSourceControlDiscoverySnapshot(target).data;
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
          groups: buildAddProjectSourceGroups(
            environmentId,
            buildAddProjectRemoteSourceReadiness(initialDiscovery),
          ),
          environmentId,
        },
      ]);
      setHighlightedItemValue(null);
      setQuery("");

      if (initialDiscovery) {
        return;
      }

      void refreshSourceControlDiscovery(target).then((discovery) => {
        if (!discovery) {
          return;
        }
        setViewStack((previousViews) => {
          const currentTopView = previousViews.at(-1);
          if (currentTopView?.groups[0]?.value !== `sources:${environmentId}`) {
            return previousViews;
          }
          return [
            ...previousViews.slice(0, -1),
            {
              ...currentTopView,
              groups: buildAddProjectSourceGroups(
                environmentId,
                buildAddProjectRemoteSourceReadiness(discovery),
              ),
            },
          ];
        });
      });
    },
    [buildAddProjectSourceGroups],
  );

  // The first step, once the computer list is in: straight to browsing for a
  // path from the palette, the sources for a computer the caller chose or the
  // only one there is, or the list of computers. Computers arrive a beat after
  // the app can open this dialog, so it waits for them instead of dead-ending
  // on an empty list. A hosted page knows at once that none is coming and
  // shows the pairing guidance instead.
  const [savedComputersLoaded, setSavedComputersLoaded] = useState(
    hasSavedEnvironmentRegistryHydrated,
  );
  useEffect(() => {
    if (savedComputersLoaded) return;
    let cancelled = false;
    const markLoaded = () => {
      if (!cancelled) setSavedComputersLoaded(true);
    };
    void waitForSavedEnvironmentRegistryHydration().then(markLoaded, markLoaded);
    return () => {
      cancelled = true;
    };
  }, [savedComputersLoaded]);
  const startedRef = useRef(false);
  useLayoutEffect(() => {
    if (startedRef.current || !savedComputersLoaded) {
      return;
    }
    if (addProjectEnvironmentOptions.length === 0 && !isHostedStaticApp()) {
      return;
    }
    startedRef.current = true;

    const lockedEnvironmentId = session.selection?.environmentId ?? null;
    if (session.initialPath !== null && defaultAddProjectEnvironmentId) {
      pushView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery: session.initialPath,
        environmentId: lockedEnvironmentId,
      });
      return;
    }
    if (lockedEnvironmentId) {
      startAddProjectSourceSelection(lockedEnvironmentId);
      return;
    }
    if (addProjectEnvironmentOptions.length > 1) {
      pushView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "environments",
            label: "Environments",
            items: addProjectEnvironmentOptions.map((option) => ({
              kind: "action",
              value: `action:add-project:environment:${option.environmentId}`,
              searchTerms: [
                option.label,
                option.environmentId,
                option.isPrimary ? "this device" : "",
              ],
              title: option.label,
              description: option.isPrimary ? "This device" : option.environmentId,
              icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
              keepOpen: true,
              run: async () => {
                startAddProjectSourceSelection(option.environmentId);
              },
            })),
          },
        ],
        environmentId: null,
      });
      return;
    }
    if (defaultAddProjectEnvironmentId) {
      startAddProjectSourceSelection(defaultAddProjectEnvironmentId);
      return;
    }

    const guidance = resolveAddProjectUnavailableGuidance({ isHostedStatic: isHostedStaticApp() });
    const guidanceAction = guidance.action;
    closeDialog();
    toastManager.add(
      stackedThreadToast({
        type: guidance.type,
        title: guidance.title,
        description: guidance.description,
        ...(guidanceAction
          ? {
              actionProps: {
                children: guidanceAction.label,
                onClick: () => {
                  void navigate({ to: guidanceAction.to });
                },
              },
              actionVariant: "outline" as const,
            }
          : {}),
      }),
    );
  }, [
    addProjectEnvironmentOptions,
    closeDialog,
    defaultAddProjectEnvironmentId,
    navigate,
    pushView,
    savedComputersLoaded,
    session,
    startAddProjectSourceSelection,
  ]);

  // Opens a project: its latest thread, or a new one. Read when it runs, so
  // the button on a late "Added" notice still finds the newest thread.
  const openProject = useCallback(
    async (projectRef: ScopedProjectRef): Promise<void> => {
      const latestThread = getLatestThreadForProject(
        selectSidebarThreadsAcrossEnvironments(useStore.getState()).filter(
          (thread) => thread.environmentId === projectRef.environmentId,
        ),
        projectRef.projectId,
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
      await handleNewThread(projectRef).catch(() => undefined);
    },
    [handleNewThread, navigate],
  );

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      const api = readEnvironmentApi(browseEnvironmentId);
      if (!api) return;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), browseEnvironmentPlatform)) {
        toastManager.add(
          failureNotice({
            title: "Couldn't add the project",
            reason: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !currentProjectCwdForBrowse) {
        toastManager.add(
          failureNotice({
            title: "Couldn't add the project",
            reason: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, currentProjectCwdForBrowse);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === browseEnvironmentId),
        cwd,
      );
      if (existing) {
        const existingRef = scopeProjectRef(existing.environmentId, existing.id);
        await finishAddProject({
          session,
          projectRef: existingRef,
          openProject: () => openProject(existingRef),
          announce: (open) => announceProjectAdded(existing.name, open),
        });
        return;
      }

      try {
        const projectId = newProjectId();
        const title = inferProjectTitleFromPath(cwd);
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          // Keep newly added projects on the provider's live default until
          // the user explicitly chooses a project/thread model.
          defaultModelSelection: null,
          createdAt: new Date().toISOString(),
        });
        const createdProjectRef = scopeProjectRef(browseEnvironmentId, projectId);
        // A repository added with worktrees already in it lays them out for
        // picking on the screen that opens next (worktree pickup).
        useWorktreePickupStore.getState().offer(scopedProjectKey(createdProjectRef));
        // Let the created project reach the store first so the draft is keyed
        // to the project's real identity. If it does not arrive in time the
        // draft is adopted (re-keyed) on the next new-thread call instead.
        await waitForProjectInStore(createdProjectRef);
        await finishAddProject({
          session,
          projectRef: createdProjectRef,
          openProject: () => openProject(createdProjectRef),
          announce: (open) => announceProjectAdded(title, open),
        });
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: "Couldn't add the project",
            error,
          }),
        );
      }
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      currentProjectCwdForBrowse,
      openProject,
      projects,
      session,
    ],
  );

  const continueAddProjectCloneFlowWithRepository = useCallback(
    (
      flow: Extract<AddProjectCloneFlow, { readonly step: "repository" }>,
      input: {
        readonly repositoryInput: string;
        readonly repository: SourceControlRepositoryInfo | null;
        readonly remoteUrl: string;
      },
    ): void => {
      const destinationPath = getAddProjectInitialQueryForEnvironment(flow.environmentId);
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: flow.environmentId,
        source: flow.source,
        repositoryInput: input.repositoryInput,
        repository: input.repository,
        remoteUrl: input.remoteUrl,
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
    },
    [getAddProjectInitialQueryForEnvironment],
  );

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }

    const api = readEnvironmentApi(addProjectCloneFlow.environmentId);
    if (!api) {
      addComputerNotConnectedNotice({
        environmentId: addProjectCloneFlow.environmentId,
        failure: "Couldn't clone the project",
      });
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        continueAddProjectCloneFlowWithRepository(addProjectCloneFlow, {
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: rawRepository,
        });
        return;
      }

      setIsRemoteProjectLookingUp(true);
      try {
        const repository = await api.sourceControl.lookupRepository({
          provider,
          repository: rawRepository,
        });
        if (cloneFlowRef.current !== addProjectCloneFlow) {
          return;
        }
        continueAddProjectCloneFlowWithRepository(addProjectCloneFlow, {
          repositoryInput: rawRepository,
          repository,
          remoteUrl: repository.url,
        });
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: "Couldn't find the repository",
            reason: errorMessage(error),
          }),
        );
      } finally {
        setIsRemoteProjectLookingUp(false);
      }
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (rawDestination.length === 0 || isRemoteProjectCloning) {
      return;
    }

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        failureNotice({
          title: "Couldn't clone the project",
          reason: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        failureNotice({
          title: "Couldn't clone the project",
          reason: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const cloneDirectoryName = getAddProjectCloneDirectoryName(addProjectCloneFlow);
    const destinationPath = resolveCloneDestinationPathForDispatch({
      destinationPath: rawDestination,
      repositoryDirectoryName: cloneDirectoryName,
      cwd: currentProjectCwdForBrowse,
    });
    if (destinationPath.length === 0) {
      return;
    }

    setIsRemoteProjectCloning(true);
    try {
      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      // As a mutation, so the new folder reads as busy until the clone lands.
      const result = await runGitMutation(
        queryClient,
        gitCloneRepositoryMutationOptions({ environmentId: addProjectCloneFlow.environmentId }),
        {
          remoteUrl: addProjectCloneFlow.remoteUrl,
          destinationPath,
          ...(provider ? { provider } : {}),
        },
      );
      // This session's handler: the clone's result belongs to the session
      // that started it, even if the dialog closed or reopened meanwhile.
      await handleAddProject(result.cwd);
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: "Couldn't clone the project",
          reason: errorMessage(error),
        }),
      );
    } finally {
      setIsRemoteProjectCloning(false);
    }
  }

  function browseTo(name: string): void {
    const nextQuery = appendBrowsePathSegment(query, name);
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    setBrowseGeneration((generation) => generation + 1);
  }

  function browseUp(): void {
    const parentPath = getBrowseParentPath(query);
    if (parentPath === null) {
      return;
    }

    setHighlightedItemValue(null);
    setQuery(parentPath);
    setBrowseGeneration((generation) => generation + 1);
  }

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp =
    isBrowsing && !relativePathNeedsActiveProject && canNavigateUp(browseDirectoryPath);

  const browseGroups = buildBrowseGroups({
    browseEntries: filteredBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = useMemo(
    () =>
      browseGroups.map((group) =>
        group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
      ),
    [browseGroups],
  );
  const gitHubRepositorySuggestionGroups = useMemo<CommandPaletteView["groups"]>(() => {
    if (!isGitHubRepositorySelectionStep || addProjectCloneFlow?.step !== "repository") {
      return [];
    }

    const repositories = gitHubRepositoriesQuery.data?.repositories ?? [];
    const items: CommandPaletteActionItem[] = repositories
      .filter((repository) =>
        sourceControlRepositoryComparisonKeys(repository).every(
          (key) => !existingGitHubRepositoryKeys.has(key),
        ),
      )
      .map((repository) => ({
        kind: "action",
        value: `github-repository:${repository.nameWithOwner}`,
        searchTerms: [repository.nameWithOwner, repository.url, repository.sshUrl, "github"],
        title: repository.nameWithOwner,
        description: repository.url,
        icon: <GitHubIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          if (addProjectCloneFlow?.step !== "repository") {
            return;
          }
          continueAddProjectCloneFlowWithRepository(addProjectCloneFlow, {
            repositoryInput: repository.nameWithOwner,
            repository,
            remoteUrl: repository.url,
          });
        },
      }));

    return items.length > 0
      ? [{ value: "github-repositories", label: "GitHub repositories", items }]
      : [];
  }, [
    addProjectCloneFlow,
    continueAddProjectCloneFlowWithRepository,
    existingGitHubRepositoryKeys,
    gitHubRepositoriesQuery.data?.repositories,
    isGitHubRepositorySelectionStep,
  ]);
  const filteredGitHubRepositorySuggestionGroups = useMemo(
    () =>
      filterCommandPaletteGroups({
        activeGroups: gitHubRepositorySuggestionGroups,
        query: deferredQuery,
        isInSubmenu: true,
        projectSearchItems: [],
        threadSearchItems: [],
      }),
    [deferredQuery, gitHubRepositorySuggestionGroups],
  );
  const filteredViewGroups = useMemo(
    () =>
      filterCommandPaletteGroups({
        activeGroups: currentView?.groups ?? [],
        query: deferredQuery,
        isInSubmenu: true,
        projectSearchItems: [],
        threadSearchItems: [],
      }),
    [currentView?.groups, deferredQuery],
  );

  const remoteProjectContext = useMemo(() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  }, [addProjectCloneFlow]);

  let displayedGroups: CommandPaletteView["groups"] = filteredViewGroups;
  if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = isGitHubRepositorySelectionStep
      ? filteredGitHubRepositorySuggestionGroups
      : [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const inputPlaceholder =
    remoteProjectInputPlaceholder(addProjectCloneFlow) ??
    currentView?.inputPlaceholder ??
    (isBrowsing || currentView?.initialQuery ? ADD_PROJECT_PATH_PLACEHOLDER : "Search...");
  const commandResultsLoading =
    viewStack.length === 0 ||
    (isGitHubRepositorySelectionStep && gitHubRepositoriesQuery.isPending);
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const hasHighlightedRemoteRepositoryItem =
    highlightedItemValue?.startsWith("github-repository:") ?? false;
  const canSubmitBrowsePath = isBrowsing && !relativePathNeedsActiveProject;
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "⌘" : "Ctrl";
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    !isRemoteProjectPending;
  const remoteProjectRepositoryEmptyStateMessage =
    addProjectCloneFlow?.step === "repository"
      ? addProjectCloneFlow.source === "url"
        ? "Enter a Git clone URL and press Enter to continue."
        : isGitHubRepositorySelectionStep
          ? gitHubRepositoriesQuery.isPending
            ? "Loading GitHub repositories..."
            : gitHubRepositoriesQuery.isError
              ? "Could not load GitHub repositories. Enter owner/repo and press Enter to look it up."
              : query.trim().length > 0
                ? "No matching GitHub repositories. Press Enter to look up owner/repo."
                : "No unadded GitHub repositories found. Enter owner/repo and press Enter to look it up."
          : "Enter a repository path and press Enter to look it up."
      : null;
  // Only the desktop app offers its folder picker, and only for the primary
  // computer, so the shared file manager name (that computer's) is this one's.
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    primaryEnvironmentId !== null &&
    browseEnvironmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = useMemo(() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  }, [
    browseDirectoryPath,
    browseResult?.parentPath,
    canOpenProjectFromFileManager,
    currentProjectCwdForBrowse,
    query,
  ]);

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      if (hasHighlightedRemoteRepositoryItem) {
        return;
      }
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }
    if (item.kind === "submenu") {
      pushView({
        addonIcon: item.addonIcon,
        groups: item.groups,
        ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
        environmentId: currentView?.environmentId ?? null,
      });
      return;
    }
    if (!item.keepOpen) {
      closeDialog();
    }
    void item.run().catch((error: unknown) => {
      toastManager.add(
        failureNotice({
          title: "Couldn't run the command",
          error,
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = useCallback(async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder(
        fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : undefined,
      );
    } catch {
      // Ignore picker failures and leave the dialog open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    await handleAddProject(pickedPath);
  }, [
    canOpenProjectFromFileManager,
    fileManagerInitialPath,
    handleAddProject,
    isPickingProjectFolder,
  ]);

  // Where the user is in Add project, for the title row.
  const stepTitle =
    addProjectCloneFlow?.step === "repository"
      ? "Choose a repository"
      : addProjectCloneFlow?.step === "confirm"
        ? "Choose where to clone"
        : isBrowsing
          ? "Choose a folder"
          : currentView?.groups[0]?.value === "environments"
            ? "Choose a computer"
            : currentView?.groups[0]?.value.startsWith("sources:")
              ? "Choose a source"
              : undefined;

  return (
    <CommandDialogPopup
      aria-label="Add project"
      className="p-0"
      data-testid="add-project-dialog"
      finalFocus={() => resolveDialogReturnFocus(session.returnFocus)}
      onBackdropPointerDown={closeDialog}
    >
      <Command
        key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${addProjectCloneFlow?.step ?? "none"}`}
        aria-label="Add project"
        autoHighlight={isBrowsing || isRemoteProjectCloneFlow ? false : "always"}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <CommandTitle title="Add project" step={stepTitle} />
        <div className="relative">
          <CommandInput
            className={
              addProjectCloneFlow?.step === "repository"
                ? "pe-32"
                : isBrowsing
                  ? willCreateProjectPath
                    ? "pe-36"
                    : "pe-16"
                  : undefined
            }
            placeholder={inputPlaceholder}
            wrapperClassName={
              isSubmenu ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto" : undefined
            }
            startAddon={
              isSubmenu ? (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ) : (
                <FolderPlusIcon />
              )
            }
            onKeyDown={handleKeyDown}
          />
          {addProjectCloneFlow?.step === "repository" ? (
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 gap-1.5 pe-1 ps-2 -translate-y-1/2"
              aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
              disabled={!canSubmitRemoteProjectFlow}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitAddProjectCloneFlow();
              }}
            >
              <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
              <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                <Kbd>Enter</Kbd>
              </KbdGroup>
            </Button>
          ) : isBrowsing ? (
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className={cn(
                "absolute inset-e-2.5 top-1/2 pe-1 ps-2 -translate-y-1/2",
                hasHighlightedBrowseItem ? "gap-1" : "gap-1.5",
              )}
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={
                relativePathNeedsActiveProject || (isCloneDestinationStep && isRemoteProjectPending)
              }
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                if (isCloneDestinationStep) {
                  void submitAddProjectCloneFlow(resolvedAddProjectPath);
                } else {
                  void handleAddProject(resolvedAddProjectPath);
                }
              }}
            >
              <span>
                {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
              </span>
              <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
              </KbdGroup>
            </Button>
          ) : null}
        </div>
        <CommandPanel className="max-h-[min(480px,62vh)]">
          {remoteProjectContext ? (
            <div className="px-3">
              <div className={COMMAND_SECTION_LABEL_CLASS}>Repository</div>
              <div className={COMMAND_GROUP_CLASS}>
                <div className={cn(COMMAND_ROW_CLASS, "cursor-default")}>
                  <span className="flex size-4 items-center justify-center [&>svg]:size-4">
                    {remoteProjectContext.icon}
                  </span>
                  <span className="truncate font-medium text-foreground">
                    {remoteProjectContext.title}
                  </span>
                  <span className="ml-3 max-w-64 truncate text-[12.5px] text-muted-foreground">
                    {remoteProjectContext.description}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          <CommandPaletteResults
            groups={displayedGroups}
            isLoading={commandResultsLoading}
            keybindings={keybindings}
            query={deferredQuery}
            onExecuteItem={executeItem}
            emptyStateMessage={
              addProjectCloneFlow?.step === "repository"
                ? (remoteProjectRepositoryEmptyStateMessage ??
                  "Enter a repository path and press Enter to look it up.")
                : addProjectCloneFlow?.step === "confirm"
                  ? "Choose a destination path and press Enter to clone."
                  : relativePathNeedsActiveProject
                    ? "Relative paths require an active project."
                    : willCreateProjectPath
                      ? "Press Enter to create this folder and add it as a project."
                      : "No matches."
            }
          />
        </CommandPanel>
        {/* Key hints only help with a keyboard; on touch the footer stays only for its button. */}
        <CommandFooter
          className={cn(
            "pointer-coarse:*:data-[slot=kbd-group]:hidden",
            !canOpenProjectFromFileManager && "pointer-coarse:hidden",
          )}
        >
          <KbdGroup className="items-center gap-1.5">
            <Kbd>
              <ArrowUpIcon />
              <ArrowDownIcon />
            </Kbd>
            <span>Move</span>
          </KbdGroup>
          {addProjectCloneFlow?.step === "repository" ? (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
              <span>{remoteProjectButtonLabel ?? "Continue"}</span>
            </KbdGroup>
          ) : !canSubmitBrowsePath || hasHighlightedBrowseItem ? (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
              <span>Select</span>
            </KbdGroup>
          ) : null}
          {isSubmenu ? (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <DeleteIcon />
              </Kbd>
              <span>Back</span>
            </KbdGroup>
          ) : null}
          <span className="flex-1" />
          {canOpenProjectFromFileManager ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-auto px-2 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
              disabled={isPickingProjectFolder}
              onClick={() => {
                void handleOpenProjectFromFileManager();
              }}
            >
              {`Open in ${editorLabel("file-manager")}`}
            </Button>
          ) : null}
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
