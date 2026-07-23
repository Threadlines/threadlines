import { scopeProjectRef } from "@threadlines/client-runtime";
import {
  ChevronDownIcon,
  FolderPlusIcon,
  MessageCirclePlusIcon,
  MessagesSquareIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { useMemo } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewGeneralChatThread,
  startNewThreadFromContext,
  startNewThreadInProjectFromContext,
} from "../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../lib/generalChats";
import {
  selectGeneralChatsProjectAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { ProjectFavicon } from "./ProjectFavicon";
import { RecentThreadsList } from "./RecentThreadsList";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";
import { riseDelay, ThreadlinesFigure } from "./ThreadlinesFigure";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty";
import { Group } from "./ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { SidebarInset, SidebarOpenTrigger } from "./ui/sidebar";
import { useSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export function NoActiveThreadState() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, orderedProjects } =
    useHandleNewThread();
  const appSettings = useSettings();
  const setCommandPaletteOpen = useCommandPaletteStore((store) => store.setOpen);
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const hasRecentThreads = useStore((state) =>
    selectSidebarThreadsAcrossEnvironments(state).some((thread) => thread.archivedAt === null),
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const generalChatsRef = useMemo(
    () =>
      resolveGeneralChatsProjectRef({
        generalChatsProject,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    [activeEnvironmentId, generalChatsProject, primaryEnvironmentId],
  );

  const hasProject = defaultProjectRef !== null;
  const defaultProjectName = orderedProjects[0]?.name ?? null;

  const newThreadActionContext = {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
      defaultEnvMode: appSettings.defaultThreadEnvMode,
    }),
    handleNewThread,
  };
  const handleNewThreadClick = () => {
    void startNewThreadFromContext(newThreadActionContext);
  };
  const handleNewThreadInProject = (project: (typeof orderedProjects)[number]) => {
    void startNewThreadInProjectFromContext(
      newThreadActionContext,
      scopeProjectRef(project.environmentId, project.id),
    );
  };
  const handleNewGeneralChat = () => {
    if (!generalChatsRef) {
      return;
    }
    void startNewGeneralChatThread(handleNewThread, generalChatsRef);
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron
              ? cn(
                  "drag-region flex items-center wco:h-[env(titlebar-area-height)]",
                  ELECTRON_HEADER_HEIGHT_CLASS,
                )
              : "py-2 sm:py-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <div className="flex items-center gap-2">
              <SidebarOpenTrigger className="size-7 shrink-0" />
              <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
                No active thread
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarOpenTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1 gap-0 overflow-y-auto">
          <div className="flex w-full max-w-md flex-col items-center">
            <ThreadlinesFigure />

            <EmptyTitle
              className="no-thread-rise text-foreground text-xl tracking-tight"
              style={riseDelay("0.16s")}
            >
              {hasProject ? "Pick up a thread" : "Start your first thread"}
            </EmptyTitle>
            <EmptyDescription
              className="no-thread-rise mt-2 text-sm text-muted-foreground/78"
              style={riseDelay("0.24s")}
            >
              {hasProject
                ? hasRecentThreads
                  ? "Jump back in, or start something new."
                  : "Resume one from the sidebar, or start fresh."
                : generalChatsRef
                  ? "Start a general chat, or add a project for repo-aware work."
                  : "Add a project to begin."}
            </EmptyDescription>

            <div
              className="no-thread-rise mt-7 flex flex-wrap items-center justify-center gap-2.5"
              style={riseDelay("0.34s")}
            >
              {hasProject ? (
                <Group aria-label="New thread">
                  <Button
                    data-testid="no-thread-new-thread-button"
                    onClick={handleNewThreadClick}
                    size="sm"
                    variant="outline"
                  >
                    <SquarePenIcon />
                    <span className="flex items-baseline gap-1">
                      New thread
                      {defaultProjectName ? (
                        <span className="text-muted-foreground">
                          in{" "}
                          <span className="inline-block max-w-32 truncate align-bottom font-medium text-foreground">
                            {defaultProjectName}
                          </span>
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  {orderedProjects.length > 1 || generalChatsRef ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            aria-label="Choose where to start the new thread"
                            data-testid="no-thread-project-picker-trigger"
                            size="icon-sm"
                            variant="outline"
                          />
                        }
                      >
                        <ChevronDownIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {generalChatsRef ? (
                          <>
                            <MenuGroup>
                              <MenuItem
                                data-testid="no-thread-new-general-chat-item"
                                onClick={handleNewGeneralChat}
                              >
                                <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                                General chat
                              </MenuItem>
                            </MenuGroup>
                            <MenuSeparator />
                          </>
                        ) : null}
                        <MenuGroup>
                          <MenuGroupLabel>New thread in…</MenuGroupLabel>
                          {orderedProjects.map((project) => (
                            <MenuItem
                              key={`${project.environmentId}:${project.id}`}
                              onClick={() => handleNewThreadInProject(project)}
                              title={project.cwd}
                            >
                              <ProjectFavicon
                                cwd={project.cwd}
                                environmentId={project.environmentId}
                              />
                              <span className="max-w-56 truncate">{project.name}</span>
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </Group>
              ) : (
                <>
                  {generalChatsRef ? (
                    <Button
                      data-testid="no-thread-new-general-chat-button"
                      onClick={handleNewGeneralChat}
                      size="sm"
                      variant="outline"
                    >
                      <MessageCirclePlusIcon />
                      New general chat
                    </Button>
                  ) : null}
                  <Button
                    data-testid="no-thread-add-project-button"
                    onClick={openAddProject}
                    size="sm"
                    variant="outline"
                  >
                    <FolderPlusIcon />
                    Add a project
                  </Button>
                </>
              )}
              <Button
                className="text-muted-foreground hover:text-foreground"
                data-testid="no-thread-search-button"
                onClick={() => setCommandPaletteOpen(true)}
                size="sm"
                variant="ghost"
              >
                <SearchIcon />
                Search
              </Button>
            </div>

            <RecentThreadsList
              className="no-thread-rise mt-10 w-full max-w-sm [--no-thread-delay:0.46s]"
              limit={3}
              testId="no-thread-recent-thread"
            />
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
