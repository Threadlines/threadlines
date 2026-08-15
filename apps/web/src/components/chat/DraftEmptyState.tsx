import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import type { ScopedProjectRef } from "@threadlines/contracts";
import { CheckIcon, CloudIcon, MessagesSquareIcon, MonitorIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSidebarProjectSnapshots } from "../../hooks/useSidebarProjectSnapshots";
import { startNewGeneralChatThread } from "../../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../../lib/generalChats";
import { orderSnapshotsByProjectRefs } from "../../sidebarProjectGrouping";
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
  // The menu lists projects, not checkouts: a repo cloned on this machine and
  // on a remote one is one entry here, exactly as it is in the sidebar. Which
  // machine a thread runs on is the Run on selector's question, not this one's.
  const projectSnapshots = useSidebarProjectSnapshots();
  const menuSnapshots = useMemo(
    () =>
      orderSnapshotsByProjectRefs({
        snapshots: projectSnapshots,
        orderedProjectRefs: orderedProjects.map((project) =>
          scopeProjectRef(project.environmentId, project.id),
        ),
      }),
    [orderedProjects, projectSnapshots],
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
                  name={currentProjectName ?? currentProject.name}
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
              {menuSnapshots.map((snapshot) => {
                const projectRef = scopeProjectRef(snapshot.environmentId, snapshot.id);
                const isCurrentProject =
                  currentProjectKey !== null &&
                  snapshot.memberProjectRefs.some(
                    (memberRef) => scopedProjectKey(memberRef) === currentProjectKey,
                  );
                // Where the project lives, in the glyph vocabulary the rest of
                // the app speaks: a cloud for another machine, monitor+cloud
                // for a repo on both. Glyphs instead of the machine's name —
                // the name truncated to nothing at this row width, and hover
                // still spells it out. Local-only rows stay unmarked.
                const remoteNames = snapshot.remoteEnvironmentLabels.join(", ");
                return (
                  <MenuItem
                    key={snapshot.projectKey}
                    onClick={() => {
                      void handleNewThread(projectRef);
                    }}
                    title={snapshot.cwd}
                  >
                    <ProjectFavicon
                      cwd={snapshot.cwd}
                      environmentId={snapshot.environmentId}
                      name={snapshot.displayName}
                    />
                    <span className="max-w-56 flex-1 truncate">{snapshot.displayName}</span>
                    {snapshot.environmentPresence === "remote-only" ? (
                      <span
                        title={`On ${remoteNames}`}
                        className="inline-flex shrink-0 items-center"
                      >
                        <CloudIcon className="size-3 text-muted-foreground/50" />
                      </span>
                    ) : snapshot.environmentPresence === "mixed" ? (
                      <span
                        title={`On this device and ${remoteNames}`}
                        className="inline-flex shrink-0 items-center gap-0.5"
                      >
                        <MonitorIcon className="size-3 text-muted-foreground/50" />
                        <CloudIcon className="size-3 text-muted-foreground/50" />
                      </span>
                    ) : null}
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
