/**
 * Commands about the project in scope (the open thread's or draft's), for
 * the palette. Registered while the palette is open (PaletteCommandSources).
 */
import { scopedProjectKey, scopedThreadKey, scopeProjectRef } from "@threadlines/client-runtime";
import { DEFAULT_NEW_THREAD_RUNTIME_MODE } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  openAddProject,
  waitForAddProjectSessionEnd,
} from "../components/addProject/addProjectStore";
import {
  openCodexImport,
  waitForCodexImportSessionEnd,
} from "../components/codexImport/codexImportStore";
import { ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { openProjectSetupDialog } from "../components/ProjectSetupDialog";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { useComposerHandleContext } from "../composerHandleContext";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useProjectSetupTargets } from "../environments/projectSetups/projectSetupTargets";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useWorktreePickup } from "../hooks/useWorktreePickup";
import {
  createLeadChat,
  environmentSupportsProjectLead,
  leadSettingRefusal,
  projectLeadRef,
} from "../leadChat";
import {
  resolveThreadActionProjectRef,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  startNewThreadInProjectFromContext,
} from "../lib/chatThreadActions";
import { readComputerConfig } from "../newThreadDefaults";
import { projectBriefLocation, useProjectBriefSupport } from "../projectBrief";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { useServerProviders } from "../rpc/serverState";
import { selectProjectsAcrossEnvironments, selectThreadByRef, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useWorktreePickupStore } from "../worktreePickup";
import { useCommandHandlers, type CommandListItem } from "./commandHandlers";

export function useProjectCommands(): void {
  const navigate = useNavigate();
  const composerHandleRef = useComposerHandleContext();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerProviders = useServerProviders();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  // The one fact about the open thread these commands read, not the thread.
  const openThreadRuntimeMode = useStore((state) =>
    routeThreadRef ? (selectThreadByRef(state, routeThreadRef)?.runtimeMode ?? null) : null,
  );

  const focusComposer = () => composerHandleRef?.current?.focusAtEnd();
  const context = { activeDraftThread, activeThread, defaultProjectRef, handleNewThread };
  // The list's items are memoized on the projects; they read the context
  // when they run, so a list left open still starts from the thread on screen.
  const contextRef = useRef(context);
  useLayoutEffect(() => {
    contextRef.current = context;
  });

  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProject =
    currentProjectId && currentProjectEnvironmentId
      ? (projects.find(
          (project) =>
            project.id === currentProjectId &&
            project.environmentId === currentProjectEnvironmentId,
        ) ?? null)
      : null;
  const currentProjectCwd = currentProject?.cwd ?? null;
  const supportsProjectBrief = useProjectBriefSupport();
  // The project's worktrees made outside Threadlines, asked for while the
  // palette is open: the command shows only when there is one to add.
  const currentProjectRef = useMemo(
    () =>
      currentProject?.kind === "workspace"
        ? scopeProjectRef(currentProject.environmentId, currentProject.id)
        : null,
    [currentProject?.environmentId, currentProject?.id, currentProject?.kind],
  );
  const worktreePickup = useWorktreePickup({
    projectRef: currentProjectRef,
    projectCwd: currentProjectRef === null ? null : currentProjectCwd,
  });
  const currentEnvironmentProviders =
    currentProjectEnvironmentId && currentProjectEnvironmentId === primaryEnvironmentId
      ? primaryServerProviders
      : currentProjectEnvironmentId
        ? (savedEnvironmentRuntimeById[currentProjectEnvironmentId]?.serverConfig?.providers ?? [])
        : [];
  const availableCodexInstances = deriveProviderInstanceEntries(currentEnvironmentProviders).filter(
    (entry) =>
      entry.driverKind === "codex" &&
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.models.length > 0,
  );
  // The open thread's project, where another computer could take a copy of it.
  const openThreadProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : null;
  const projectSetupTargets = useProjectSetupTargets(openThreadProjectRef);

  const newThreadInItems = useMemo<ReadonlyArray<CommandListItem>>(
    () =>
      projects.map((project) => ({
        id: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        title: project.name,
        description: project.cwd,
        keywords: [project.cwd],
        group: "Projects",
        icon: (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            name={project.name}
            className={ITEM_ICON_CLASS}
          />
        ),
        run: async () => {
          await startNewThreadInProjectFromContext(
            contextRef.current,
            scopeProjectRef(project.environmentId, project.id),
          );
        },
      })),
    [projects],
  );

  // Lead chats (docs/design/lead-chat.md): one "Go to" per project that has
  // one, and "New lead chat" for the project in scope when it has none.
  const leadChatItems: CommandListItem[] = [];
  for (const project of projects) {
    const leadRef = projectLeadRef(useStore.getState(), project);
    if (leadRef === null) continue;
    leadChatItems.push({
      id: scopedThreadKey(leadRef),
      title: "Go to lead chat",
      description: project.name,
      keywords: [project.name],
      run: () =>
        navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(leadRef) }),
    });
  }
  // The open thread's or draft's project (none until its computer's projects
  // load); the first project only when neither is open.
  const leadScopeProject =
    currentProjectId !== null
      ? (currentProject ?? undefined)
      : defaultProjectRef
        ? projects.find(
            (project) =>
              project.environmentId === defaultProjectRef.environmentId &&
              project.id === defaultProjectRef.projectId,
          )
        : undefined;
  const offersNewLeadChat =
    leadScopeProject !== undefined &&
    leadScopeProject.kind === "workspace" &&
    environmentSupportsProjectLead(leadScopeProject.environmentId) &&
    leadSettingRefusal(leadScopeProject.environmentId) === null &&
    projectLeadRef(useStore.getState(), leadScopeProject) === null;

  const hasProjects = projects.length > 0;
  const projectTitle = hasProjects ? (currentProject?.name ?? null) : null;

  useCommandHandlers({
    "chat.new": projectTitle !== null && {
      title: "New thread in",
      titleEmphasis: projectTitle,
      run: async () => {
        await startNewThreadFromContext(context);
      },
    },
    // As its shortcut, where New thread is offered.
    // As its shortcut: wherever there is a project to start in, Home included.
    "chat.newLocal": resolveThreadActionProjectRef(context) !== null && {
      run: async () => {
        await startNewLocalThreadFromContext(context);
      },
    },
    "codex.import": projectTitle !== null &&
      currentProject?.kind === "workspace" &&
      currentProjectCwd !== null &&
      availableCodexInstances.length > 0 && {
        opensDialog: true,
        // Takes the project, its accounts and the open thread's mode as they are now.
        run: async () => {
          const sessionId = openCodexImport({
            project: {
              environmentId: currentProject.environmentId,
              projectId: currentProject.id,
              projectName: currentProject.name,
              cwd: currentProject.cwd,
            },
            accounts: availableCodexInstances.map((instance) => ({
              instanceId: instance.instanceId,
              displayName: instance.displayName,
            })),
            runtimeMode:
              openThreadRuntimeMode ??
              activeDraftThread?.runtimeMode ??
              readComputerConfig(currentProject.environmentId)?.settings.newThreadRuntimeMode ??
              DEFAULT_NEW_THREAD_RUNTIME_MODE,
            returnFocus: focusComposer,
          });
          // Closing the dialog without bringing one in isn't a use.
          return (await waitForCodexImportSessionEnd(sessionId)) === "imported"
            ? undefined
            : "cancelled";
        },
      },
    "worktrees.pickUp": projectTitle !== null &&
      currentProjectRef !== null &&
      worktreePickup.candidates.length > 0 && {
        // Lays the list out on the new-thread screen, where each worktree
        // can be ticked; it also brings a hidden count back.
        run: async () => {
          useWorktreePickupStore.getState().offer(scopedProjectKey(currentProjectRef));
          await handleNewThread(currentProjectRef, { continueActiveCheckout: false });
        },
      },
    "project.brief": hasProjects &&
      currentProject?.kind === "workspace" &&
      supportsProjectBrief(currentProject.environmentId) && {
        description: currentProject.name,
        keywords: [currentProject.name],
        run: () => navigate(projectBriefLocation(currentProject)),
      },
    "chat.newIn": hasProjects && { items: newThreadInItems, placeholder: "Search..." },
    "project.add": {
      opensDialog: true,
      run: async () => {
        const sessionId = openAddProject({ returnFocus: focusComposer });
        // Closing the dialog without adding one isn't a use.
        return (await waitForAddProjectSessionEnd(sessionId)) === "added" ? undefined : "cancelled";
      },
    },
    "project.setUpElsewhere": openThreadProjectRef !== null &&
      projectSetupTargets.length > 0 && {
        run: () => openProjectSetupDialog({ project: openThreadProjectRef }),
      },
    "leadChat.goTo": leadChatItems.length > 0 && { items: leadChatItems },
    "leadChat.new": offersNewLeadChat &&
      leadScopeProject !== undefined && {
        description: leadScopeProject.name,
        run: async () => {
          const leadRef = await createLeadChat(leadScopeProject);
          if (leadRef !== null) {
            await navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(leadRef),
            });
          }
        },
      },
  });
}
