import { ChevronDownIcon, EllipsisIcon, FolderIcon, FolderPlusIcon } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import type { ContextMenuItem, SidebarProjectGroupingMode } from "@threadlines/contracts";
import { scopeProjectRef } from "@threadlines/client-runtime";

import { cn, newCommandId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { readEnvironmentApi } from "../../environmentApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectSidebarThreadsForProjectRefs, useStore } from "../../store";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

const SCOPE_ITEM_CLASS_NAME = "gap-2 data-highlighted:bg-foreground/12";
/**
 * Selection is a resting fill; hover is a stronger one. Both are neutral
 * alphas of the foreground, so "which is selected" and "which is under the
 * cursor" never read as the same state.
 */
const SCOPE_ITEM_SELECTED = "bg-foreground/6 text-foreground";

export interface ProjectScopeMenuProps {
  options: readonly ProjectScopeOption[];
  projectByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  scopedProjectKey: string | null;
  onScopeChange: (projectKey: string | null) => void;
  onAddProject: () => void;
}

/**
 * The scope filter: one quiet line naming what the list is showing.
 *
 * Projects stopped being a tree, so this is where a project is addressed.
 * Picking one narrows the list; right-clicking it opens what the project
 * header used to hold (rename, grouping, path, removal), which keeps those
 * off the menu itself. A menu scales with the pane where a chip row could
 * not, so only "Add project" stays out here as a visible button.
 */
export const ProjectScopeMenu = memo(function ProjectScopeMenu(props: ProjectScopeMenuProps) {
  const { options, projectByKey, scopedProjectKey, onScopeChange, onAddProject } = props;
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const { updateSettings } = useUpdateSettings();
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

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename project"),
            buildTargetedItem("grouping", "Project grouping…"),
            buildTargetedItem("copy-path", "Copy Project Path"),
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

  const scopedProject =
    scopedProjectKey === null ? null : (projectByKey.get(scopedProjectKey) ?? null);

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1">
        <Menu>
          <MenuTrigger
            data-testid="inbox-scope-trigger"
            className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs text-muted-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-ring"
            // Right-clicking the trigger addresses the project you are already
            // scoped to, so the menu is not the only way in.
            onContextMenu={(event: React.MouseEvent) => {
              if (scopedProject) {
                handleProjectContextMenu(event, scopedProject.projectKey);
              }
            }}
          >
            {scopedProject ? (
              <ProjectFavicon
                cwd={scopedProject.cwd}
                environmentId={scopedProject.environmentId}
                className="size-3.5 shrink-0"
              />
            ) : (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">
              {scopedProject?.displayName ?? "All projects"}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/50" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" className="min-w-56">
            <MenuItem
              data-testid="inbox-scope-all"
              className={cn(
                SCOPE_ITEM_CLASS_NAME,
                scopedProjectKey === null && SCOPE_ITEM_SELECTED,
              )}
              onClick={() => {
                onScopeChange(null);
              }}
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate">All projects</span>
            </MenuItem>
            {options.map((option) => {
              const project = projectByKey.get(option.key);
              return (
                <MenuItem
                  key={option.key}
                  data-testid={`inbox-scope-${option.key}`}
                  className={cn(
                    SCOPE_ITEM_CLASS_NAME,
                    "group/scope-item",
                    scopedProjectKey === option.key && SCOPE_ITEM_SELECTED,
                  )}
                  onClick={() => {
                    onScopeChange(option.key);
                  }}
                  // Right-click keeps working; the button is the discoverable half.
                  onContextMenu={(event: React.MouseEvent) => {
                    handleProjectContextMenu(event, option.key);
                  }}
                >
                  {project ? (
                    <ProjectFavicon
                      cwd={project.cwd}
                      environmentId={project.environmentId}
                      className="size-3.5 shrink-0"
                    />
                  ) : (
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.needsYouCount > 0 ? (
                    <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-300/90">
                      {option.needsYouCount}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`inbox-scope-actions-${option.key}`}
                    aria-label={`Manage ${option.label}`}
                    className="-mr-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-ring group-hover/scope-item:opacity-100 group-focus-within/scope-item:opacity-100 pointer-coarse:opacity-100"
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
                </MenuItem>
              );
            })}
            <MenuSeparator />
            <MenuItem onClick={onAddProject}>
              <FolderPlusIcon />
              <span className="min-w-0 flex-1 truncate">Add project…</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
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
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
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
