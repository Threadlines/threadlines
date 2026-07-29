import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import type { ScopedProjectRef } from "@threadlines/contracts";
import { CheckIcon, MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewGeneralChatThread } from "../../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../../lib/generalChats";
import { selectGeneralChatsProjectAcrossEnvironments, useStore } from "../../store";
import { ProjectFavicon } from "../ProjectFavicon";
import { RecentThreadsList } from "../RecentThreadsList";
import { riseDelay, ThreadlinesFigure } from "../ThreadlinesFigure";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

interface DraftEmptyStateProps {
  currentProjectRef: ScopedProjectRef | null;
  currentProjectName: string | null;
  isGeneralChat: boolean;
}

export function DraftEmptyState({
  currentProjectRef,
  currentProjectName,
  isGeneralChat,
}: DraftEmptyStateProps) {
  const { handleNewThread, orderedProjects } = useHandleNewThread();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const generalChatsRef = useMemo(
    () =>
      resolveGeneralChatsProjectRef({
        generalChatsProject,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    [activeEnvironmentId, generalChatsProject, primaryEnvironmentId],
  );
  const currentProjectKey = currentProjectRef ? scopedProjectKey(currentProjectRef) : null;
  const targetName = isGeneralChat ? "general chat" : (currentProjectName ?? "this project");
  // Show the selected project's icon in the heading so the active project is
  // recognizable at a glance, not just by reading the name.
  const currentProject = useMemo(
    () =>
      currentProjectKey === null
        ? null
        : (orderedProjects.find(
            (project) =>
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) ===
              currentProjectKey,
          ) ?? null),
    [currentProjectKey, orderedProjects],
  );

  return (
    <div className="flex w-full max-w-xl flex-col items-center">
      <ThreadlinesFigure />

      <h2
        className="no-thread-rise text-xl tracking-tight text-foreground"
        style={riseDelay("0.16s")}
      >
        What's next in{" "}
        <Menu>
          <MenuTrigger
            render={
              <button className="group cursor-pointer font-medium text-foreground" type="button" />
            }
          >
            {/* Chrome never paints text-decoration under a replaced element, so
                the dotted rule is a border on a flex wrapper — that's what keeps
                the icon inside the underline instead of beside it. */}
            <span className="inline-flex items-center gap-1 border-b border-dotted border-muted-foreground/50 pb-0.5 align-middle leading-none transition-colors group-hover:border-foreground">
              {isGeneralChat ? (
                <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              ) : currentProject ? (
                <ProjectFavicon
                  cwd={currentProject.cwd}
                  environmentId={currentProject.environmentId}
                />
              ) : null}
              {targetName}
            </span>
          </MenuTrigger>
          <MenuPopup align="center">
            {generalChatsRef ? (
              <>
                <MenuGroup>
                  <MenuItem
                    onClick={() => {
                      void startNewGeneralChatThread(handleNewThread, generalChatsRef);
                    }}
                  >
                    <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="flex-1">General chat</span>
                    {isGeneralChat ? (
                      <CheckIcon className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </MenuItem>
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            <MenuGroup>
              <MenuGroupLabel>Switch project</MenuGroupLabel>
              {orderedProjects.map((project) => {
                const projectRef = scopeProjectRef(project.environmentId, project.id);
                const isCurrentProject =
                  currentProjectKey !== null && scopedProjectKey(projectRef) === currentProjectKey;
                return (
                  <MenuItem
                    key={`${project.environmentId}:${project.id}`}
                    onClick={() => {
                      void handleNewThread(projectRef);
                    }}
                    title={project.cwd}
                  >
                    <ProjectFavicon cwd={project.cwd} environmentId={project.environmentId} />
                    <span className="max-w-56 flex-1 truncate">{project.name}</span>
                    {isCurrentProject ? (
                      <CheckIcon className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        ?
      </h2>

      <RecentThreadsList
        className="no-thread-rise mt-10 w-full [--no-thread-delay:0.26s]"
        limit={5}
        scope={isGeneralChat ? "chats" : "projects"}
        testId="draft-empty-recent-thread"
      />
    </div>
  );
}
