import {
  CheckIcon,
  ChevronsUpDownIcon,
  EllipsisIcon,
  FolderIcon,
  FolderPlusIcon,
  SquarePenIcon,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import type {
  ContextMenuItem,
  SidebarGrouping,
  SidebarProjectGroupingMode,
} from "@threadlines/contracts";
import { scopeProjectRef } from "@threadlines/client-runtime";

import { cn, newCommandId } from "../../lib/utils";
import { SIDEBAR_LIST_FIELD_CLASS } from "./sidebarListField";
import { readLocalApi } from "../../localApi";
import { readEnvironmentApi } from "../../environmentApi";
import { readProjectSetupSourceAmong } from "../../environments/projectSetups/projectSetupTargets";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectSidebarThreadsForProjectRefs, useStore } from "../../store";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { ProjectScopeOption } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { openProjectSetupDialog } from "../ProjectSetupDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
  MenuCheckboxItem,
  MenuEmpty,
  MenuFilterInput,
  MenuFilterProvider,
  MenuItem,
  MenuList,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxViewMenu, type EnvironmentScopeOption } from "./InboxViewMenu";

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.name;
  }

  return member.environmentLabel ? `${member.environmentLabel} — ${member.cwd}` : member.cwd;
}

const SET_UP_ELSEWHERE_ITEM_ID = "set-up-elsewhere";

const SCOPE_ITEM_CLASS_NAME = MENU_PICK_ITEM_CLASS_NAME;
const SCOPE_ITEM_SELECTED = MENU_PICK_ITEM_SELECTED_CLASS_NAME;

/**
 * For a button inside a menu row: Enter and Space press the button itself.
 * Left to bubble, the menu would read them as picking the row (or, while a
 * search holds focus, the highlighted match) instead.
 */
function keepActivationKeys(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
  }
}

/** How many picked projects the trigger draws an icon for. */
const TRIGGER_FAVICON_LIMIT = 3;

/**
 * Past this many projects the menu gets a search line. Fewer fit on screen at
 * once, where a search box would only be one more row to look past.
 */
const PROJECT_SEARCH_MIN_PROJECTS = 9;

/**
 * What the trigger calls the picked projects: their names while two fit, a
 * count past that -- at sidebar widths a third name is only ever an ellipsis.
 */
function describeScopedProjects(projects: readonly SidebarProjectSnapshot[]): string {
  return projects.length <= 2
    ? projects.map((project) => project.displayName).join(", ")
    : `${projects.length} projects`;
}

export interface ProjectScopeMenuProps {
  options: readonly ProjectScopeOption[];
  projectByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  /** The projects the list is narrowed to, in the order they were picked; empty is All. */
  scopedProjectKeys: readonly string[];
  /** Replaces the whole scope: empty for All projects, one key for "Only". */
  onScopeChange: (projectKeys: readonly string[]) => void;
  /** Adds a project to the scope, or takes it out. */
  onToggleScopeProject: (projectKey: string) => void;
  /** The View button's settings; see {@link InboxViewMenu}. */
  environmentOptions: readonly EnvironmentScopeOption[];
  scopedEnvironmentId: string | null;
  onEnvironmentScopeChange: (environmentId: string | null) => void;
  roomsOnly: boolean | null;
  onRoomsOnlyChange: (roomsOnly: boolean) => void;
  grouping: SidebarGrouping;
  onGroupingChange: (grouping: SidebarGrouping) => void;
  onAddProject: () => void;
  /**
   * A new-thread button at the row's end, on a phone. Null on a wide screen,
   * where the rail's New thread is the one.
   */
  onNewThread: (() => void) | null;
  newThreadShortcutLabel: string | null;
}

/**
 * The scope filter: one quiet line naming what the list is showing.
 *
 * Projects stopped being a tree, so this is where a project is addressed.
 * Clicking one adds it to the list's scope or takes it out, and the menu stays
 * open for the next; "Only" on a row narrows straight to that one project.
 * Right-clicking a project opens what the project header used to hold
 * (rename, grouping, path, removal), which keeps those off the menu itself. A
 * menu scales with the pane where a chip row could not, and a long one gets a
 * search line on a mouse (on a phone, focusing it would raise the keyboard
 * every time the menu opened).
 *
 * The menu holds projects only. Which computer, which kind of thread and how
 * rows group are set once and left, so they sit behind the View button beside
 * it rather than lengthening a menu used all day.
 */
export const ProjectScopeMenu = memo(function ProjectScopeMenu(props: ProjectScopeMenuProps) {
  const {
    options,
    projectByKey,
    scopedProjectKeys,
    onScopeChange,
    onToggleScopeProject,
    environmentOptions,
    scopedEnvironmentId,
    onEnvironmentScopeChange,
    roomsOnly,
    onRoomsOnlyChange,
    grouping,
    onGroupingChange,
    onAddProject,
    onNewThread,
    newThreadShortcutLabel,
  } = props;
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const { updateSettings } = useUpdateSettings();
  // Controlled so "Only" can close it: toggling a project leaves it open.
  const [menuOpen, setMenuOpen] = useState(false);
  // The row of controls the menu drops from. The menu takes the row's width
  // rather than its widest name, so a long project name truncates instead of
  // stretching the menu past the sidebar.
  const [controlsRow, setControlsRow] = useState<HTMLDivElement | null>(null);
  // Controlled so the rows that are not projects can step aside while a
  // search is typed; the menu clears it as it closes.
  const [projectQuery, setProjectQuery] = useState("");
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const showProjectSearch = !isCoarsePointer && options.length >= PROJECT_SEARCH_MIN_PROJECTS;
  const searching = showProjectSearch && projectQuery.trim().length > 0;
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.name);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember, options: { force?: boolean } = {}): Promise<void> => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const draftStore = useComposerDraftStore.getState();
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);

      const projectApi = readEnvironmentApi(member.environmentId);
      if (!projectApi) {
        throw new Error("Project API unavailable.");
      }

      await projectApi.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: member.id,
        ...(options.force === true ? { force: true } : {}),
      });
    },
    [],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreads = selectSidebarThreadsForProjectRefs(useStore.getState(), [
        memberProjectRef,
      ]);
      if (memberThreads.length > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });

                  const latestProjectThreads = selectSidebarThreadsForProjectRefs(
                    useStore.getState(),
                    [memberProjectRef],
                  );
                  const confirmed = await api.dialogs.confirm(
                    latestProjectThreads.length > 0
                      ? [
                          `Remove project "${member.name}" and delete its ${latestProjectThreads.length} thread${
                            latestProjectThreads.length === 1 ? "" : "s"
                          }?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears conversation history for those threads.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.name}"?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This removes only this project entry.",
                        ].join("\n"),
                  );
                  if (!confirmed) {
                    return;
                  }

                  await removeProject(member, { force: true });
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    error,
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.name}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = [
        `Remove project "${member.name}"?`,
        `Path: ${member.cwd}`,
        ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message);
      if (!confirmed) {
        return;
      }

      try {
        await removeProject(member);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.name}"`,
            description: message,
          }),
        );
      }
    },
    [removeProject],
  );

  const showProjectContextMenu = useCallback(
    (project: SidebarProjectSnapshot, position: { x: number; y: number }) => {
      // The General Chats system project is server-managed: rename, grouping,
      // path, and removal do not apply (the server rejects them anyway).
      if (project.kind === "general-chat") {
        return;
      }
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const makeLeaf = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: { destructive?: boolean },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.cwd, { path: member.cwd });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            ...(options?.destructive ? { destructive: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: { destructive?: boolean },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, options),
              label,
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            children: project.memberProjects.map((member) => makeLeaf(action, member, options)),
          };
        };

        // Offered only where another computer could take a copy; the copy
        // it starts from is the one on this app's own computer when it can.
        const setupSource = readProjectSetupSourceAmong(project.memberProjects);
        if (setupSource !== null) {
          actionHandlers.set(SET_UP_ELSEWHERE_ITEM_ID, () =>
            openProjectSetupDialog({ project: setupSource }),
          );
        }

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename project"),
            buildTargetedItem("grouping", "Project grouping…"),
            buildTargetedItem("copy-path", "Copy Project Path"),
            ...(setupSource !== null
              ? [{ id: SET_UP_ELSEWHERE_ITEM_ID, label: "Set up on another computer…" }]
              : []),
            buildTargetedItem("delete", "Remove project", { destructive: true }),
          ],
          position,
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [copyPathToClipboard, handleRemoveProject, openProjectGroupingDialog, openProjectRenameDialog],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }

    if (trimmed === projectRenameTarget.name) {
      closeProjectRenameDialog();
      return;
    }

    const api = readEnvironmentApi(projectRenameTarget.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: "Project API unavailable.",
        }),
      );
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: projectRenameTarget.id,
        title: trimmed,
      });
      closeProjectRenameDialog();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  const showProjectContextMenuAt = useCallback(
    (projectKey: string, position: { x: number; y: number }) => {
      const project = projectByKey.get(projectKey);
      if (!project) return;
      showProjectContextMenu(project, position);
    },
    [projectByKey, showProjectContextMenu],
  );
  const handleProjectContextMenu = useCallback(
    (event: React.MouseEvent, projectKey: string) => {
      event.preventDefault();
      showProjectContextMenuAt(projectKey, { x: event.clientX, y: event.clientY });
    },
    [showProjectContextMenuAt],
  );

  const scopedProjects = useMemo(
    () =>
      scopedProjectKeys.flatMap((key) => {
        const project = projectByKey.get(key);
        return project ? [project] : [];
      }),
    [projectByKey, scopedProjectKeys],
  );
  const soleScopedProject = scopedProjects.length === 1 ? scopedProjects[0]! : null;

  const projectMenu = (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        data-testid="inbox-scope-trigger"
        // The same quiet surface as the search bar above it (paired
        // chevrons say it is a picker), unlike the flat icon buttons beside it.
        className={cn(SIDEBAR_LIST_FIELD_CLASS, "flex-1 text-xs")}
        // Right-clicking the trigger addresses the project you are scoped
        // to, so the menu is not the only way in. With several picked
        // there is no one project it could mean.
        onContextMenu={(event: React.MouseEvent) => {
          if (soleScopedProject) {
            handleProjectContextMenu(event, soleScopedProject.projectKey);
          }
        }}
      >
        {scopedProjects.length > 0 ? (
          // Side by side rather than overlapped: a project icon is a logo,
          // and a stack would clip all but the first.
          <span className="flex shrink-0 items-center gap-0.5">
            {scopedProjects.slice(0, TRIGGER_FAVICON_LIMIT).map((project) => (
              <ProjectFavicon
                key={project.projectKey}
                cwd={project.cwd}
                environmentId={project.environmentId}
                name={project.displayName}
                className="size-3.5 shrink-0"
              />
            ))}
          </span>
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        {/* Projects only: the View button beside it says when a computer
            or the rooms filter narrows the list too. */}
        <span data-testid="inbox-scope-label" className="min-w-0 flex-1 truncate text-left">
          {scopedProjects.length > 0 ? describeScopedProjects(scopedProjects) : "All projects"}
        </span>
        <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground/60" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" anchor={controlsRow} className="w-(--anchor-width)">
        {showProjectSearch ? (
          <MenuFilterInput
            data-testid="inbox-scope-search"
            aria-label="Find a project"
            placeholder="Find a project"
          />
        ) : null}
        <MenuList>
          {/* A search finds projects, never these two: "all" must not land on
              All projects ahead of a project named Alloy. They step aside
              while one is typed. */}
          {searching ? null : (
            <MenuItem
              data-testid="inbox-scope-all"
              className={cn(
                SCOPE_ITEM_CLASS_NAME,
                scopedProjectKeys.length === 0 && SCOPE_ITEM_SELECTED,
              )}
              onClick={() => {
                onScopeChange([]);
              }}
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate">All projects</span>
            </MenuItem>
          )}
          {options.map((option) => {
            const project = projectByKey.get(option.key);
            const picked = scopedProjectKeys.includes(option.key);
            return (
              <MenuCheckboxItem
                key={option.key}
                variant="fill"
                // The name alone is what a search matches, not "Only" or the count.
                label={option.label}
                checked={picked}
                onCheckedChange={() => {
                  onToggleScopeProject(option.key);
                }}
                data-testid={`inbox-scope-${option.key}`}
                className="group/scope-item"
                // Right-click keeps working; the button is the discoverable half.
                onContextMenu={(event: React.MouseEvent) => {
                  handleProjectContextMenu(event, option.key);
                }}
              >
                {project ? (
                  <ProjectFavicon
                    cwd={project.cwd}
                    environmentId={project.environmentId}
                    name={project.displayName}
                    className="size-3.5 shrink-0"
                  />
                ) : (
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                )}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {picked ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
                </span>
                {/* The fast switch: toggling is the click, so jumping to one
                    project is its own small button. It and the manage button
                    show on the highlighted row only (always, on touch), so the
                    other rows keep their width for names. Absent on the one
                    project already showing alone, where it would do nothing. */}
                {picked && scopedProjectKeys.length === 1 ? null : (
                  <button
                    type="button"
                    data-testid={`inbox-scope-only-${option.key}`}
                    aria-label={`Show only ${option.label}`}
                    className="hidden h-5 shrink-0 cursor-pointer items-center rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-ring group-data-highlighted/scope-item:inline-flex pointer-coarse:inline-flex"
                    onKeyDown={keepActivationKeys}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onScopeChange([option.key]);
                      setMenuOpen(false);
                    }}
                  >
                    Only
                  </button>
                )}
                {option.needsYouCount > 0 ? (
                  <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-300/90">
                    {option.needsYouCount}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={`inbox-scope-actions-${option.key}`}
                  aria-label={`Manage ${option.label}`}
                  className="-mr-1 hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground focus-ring group-data-highlighted/scope-item:inline-flex pointer-coarse:inline-flex"
                  onKeyDown={keepActivationKeys}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    showProjectContextMenuAt(option.key, {
                      x: Math.round(rect.right),
                      y: Math.round(rect.bottom),
                    });
                  }}
                >
                  <EllipsisIcon className="size-3.5" />
                </button>
              </MenuCheckboxItem>
            );
          })}
          {searching ? null : (
            <>
              <MenuSeparator />
              <MenuItem onClick={onAddProject}>
                <FolderPlusIcon />
                <span className="min-w-0 flex-1 truncate">Add project…</span>
              </MenuItem>
            </>
          )}
        </MenuList>
        {showProjectSearch ? <MenuEmpty>No matching projects</MenuEmpty> : null}
      </MenuPopup>
    </Menu>
  );

  return (
    <>
      <div className="px-3 pt-2 pb-2">
        <div ref={setControlsRow} className="flex items-center gap-1">
          {showProjectSearch ? (
            <MenuFilterProvider autoHighlight value={projectQuery} onValueChange={setProjectQuery}>
              {projectMenu}
            </MenuFilterProvider>
          ) : (
            projectMenu
          )}
          <InboxViewMenu
            environmentOptions={environmentOptions}
            scopedEnvironmentId={scopedEnvironmentId}
            onEnvironmentScopeChange={onEnvironmentScopeChange}
            roomsOnly={roomsOnly}
            onRoomsOnlyChange={onRoomsOnlyChange}
            grouping={grouping}
            onGroupingChange={onGroupingChange}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Add project"
                  data-testid="sidebar-add-project-trigger"
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-ring"
                  onClick={onAddProject}
                />
              }
            >
              <FolderPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Add project</TooltipPopup>
          </Tooltip>
          {onNewThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="New thread"
                    data-testid="new-thread-button"
                    className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-ring"
                    onClick={onNewThread}
                  />
                }
              >
                <SquarePenIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? `Update the title for ${projectRenameTarget.cwd}.`
                : "Update the project title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                Environment: {projectRenameTarget.environmentLabel}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitProjectRename()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project grouping</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? `Choose how ${projectGroupingTarget.cwd} should be grouped in the sidebar.`
                : "Choose how this project should be grouped in the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Grouping rule</span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">Use global default</SelectItem>
                  <SelectItem value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem value="separate">{PROJECT_GROUPING_MODE_LABELS.separate}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
                : projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              Cancel
            </Button>
            <Button onClick={saveProjectGroupingPreference}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
