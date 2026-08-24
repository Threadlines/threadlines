import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import type { ScopedProjectRef } from "@threadlines/contracts";
import { CloudIcon, MessagesSquareIcon, MonitorIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSidebarProjectSnapshots } from "../../hooks/useSidebarProjectSnapshots";
import { startNewGeneralChatThread } from "../../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../../lib/generalChats";
import { orderSnapshotsByProjectRefs } from "../../sidebarProjectGrouping";
import { selectGeneralChatsProjectAcrossEnvironments, useStore } from "../../store";
import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { RecentThreadsList } from "../RecentThreadsList";
import { OpenSourceSupportLinks } from "../OpenSourceSupportLinks";
import { riseDelay, ThreadlinesFigure } from "../ThreadlinesFigure";
import { TooltipWrapper } from "../ui/tooltip";
import {
  Menu,
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
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
  // "Where does this project live?" only exists once a second machine does.
  const hasRemoteMachines = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length > 0,
  );
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
    <div className="flex w-full min-w-0 max-w-xl flex-col items-center">
      <ThreadlinesFigure />

      <h2
        className="no-thread-rise max-w-full text-center text-xl tracking-tight text-foreground"
        style={riseDelay("0.16s")}
      >
        What's next in{" "}
        <Menu>
          <MenuTrigger
            render={
              <button
                className="group inline-flex max-w-full min-w-0 cursor-pointer font-medium text-foreground"
                type="button"
              />
            }
          >
            {/* Chrome never paints text-decoration under a replaced element, so
                the dotted rule is a border on a flex wrapper — that's what keeps
                the icon inside the underline instead of beside it. */}
            <span className="inline-flex max-w-full min-w-0 items-center gap-1 border-b border-dotted border-muted-foreground/50 pb-0.5 align-middle leading-none transition-colors group-hover:border-foreground">
              {isGeneralChat ? (
                <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              ) : currentProject ? (
                <ProjectFavicon
                  cwd={currentProject.cwd}
                  environmentId={currentProject.environmentId}
                  name={currentProjectName ?? currentProject.name}
                />
              ) : null}
              <span className="min-w-0 truncate">{targetName}</span>
            </span>
          </MenuTrigger>
          <MenuPopup align="center">
            {generalChatsRef ? (
              <>
                <MenuGroup>
                  <MenuItem
                    className={cn(
                      MENU_PICK_ITEM_CLASS_NAME,
                      isGeneralChat && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
                    )}
                    onClick={() => {
                      void startNewGeneralChatThread(handleNewThread, generalChatsRef);
                    }}
                  >
                    <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="flex-1">General chat</span>
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
                // the app speaks: monitor for this device, cloud for another
                // machine, both for a repo on both, and a count when it spans
                // several remotes. Glyphs instead of the machine's name — the
                // name truncated to nothing at this row width, and hover still
                // spells it out. With no remote machine connected the question
                // does not exist, so no row carries a glyph at all.
                const remoteNames = snapshot.remoteEnvironmentLabels.join(", ");
                const remoteCount = snapshot.remoteEnvironmentLabels.length;
                const hasLocal = snapshot.environmentPresence !== "remote-only";
                const hasRemote = snapshot.environmentPresence !== "local-only";
                return (
                  <MenuItem
                    key={snapshot.projectKey}
                    className={cn(
                      MENU_PICK_ITEM_CLASS_NAME,
                      isCurrentProject && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
                    )}
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
                    {hasRemoteMachines ? (
                      // Instant tooltip: the glyphs are the only thing naming
                      // the machines, so a hover dwell reads as unlabelled.
                      <TooltipWrapper
                        delay={0}
                        side="right"
                        tooltip={
                          hasLocal && hasRemote
                            ? `On this device and ${remoteNames}`
                            : hasRemote
                              ? `On ${remoteNames}`
                              : "On this device"
                        }
                      >
                        <span className="inline-flex shrink-0 items-center gap-0.5">
                          {hasLocal ? (
                            <MonitorIcon className="size-3 text-muted-foreground/50" />
                          ) : null}
                          {hasRemote ? (
                            <CloudIcon className="size-3 text-muted-foreground/50" />
                          ) : null}
                          {remoteCount > 1 ? (
                            <span className="font-mono text-[10px] leading-none text-muted-foreground/50">
                              {remoteCount}
                            </span>
                          ) : null}
                        </span>
                      </TooltipWrapper>
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

      <OpenSourceSupportLinks />
    </div>
  );
}
