import { scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { MessageCirclePlusIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { startNewGeneralChatThread } from "../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../lib/generalChats";
import { sortThreads } from "../lib/threadSort";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  selectGeneralChatsProjectAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadHoverCard } from "./sidebar/ThreadHoverCard";
import { SidebarHoverCardGroup } from "./sidebar/hoverCard";

/**
 * The Chats destination: general chats are threads with no project, so they get
 * a place of their own rather than a project-shaped group in the sidebar tree.
 */
export function ChatsDestinationView() {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);

  const generalChatsProjectRef = useMemo(
    () =>
      resolveGeneralChatsProjectRef({
        generalChatsProject,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    [activeEnvironmentId, generalChatsProject, primaryEnvironmentId],
  );

  const chats = useMemo(() => {
    if (generalChatsProject === null) {
      return [];
    }
    return sortThreads(
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.environmentId === generalChatsProject.environmentId &&
          thread.projectId === generalChatsProject.id,
      ),
      threadSortOrder,
    );
  }, [generalChatsProject, threadSortOrder, threads]);

  const startChat = () => {
    if (generalChatsProjectRef) {
      void startNewGeneralChatThread(handleNewThread, generalChatsProjectRef);
    }
  };

  return (
    <div
      className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-8"
      data-testid="chats-view"
    >
      <div className="mb-1 flex items-center gap-3">
        <h1 className="flex-1 text-lg font-medium tracking-tight">General chats</h1>
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="chats-view-new-chat"
          disabled={generalChatsProjectRef === null}
          onClick={startChat}
        >
          <MessageCirclePlusIcon className="size-3.5" />
          New chat
        </button>
      </div>
      <p className="text-sm text-muted-foreground/70">
        Conversations that aren&apos;t tied to a project.
      </p>

      {chats.length === 0 ? (
        <p className="mt-10 border-t border-border/50 py-6 text-sm text-muted-foreground/60">
          No chats yet.
        </p>
      ) : (
        <SidebarHoverCardGroup>
          {/* The rows repeat the page title's shape closely enough that a rule
              alone read as more list. A label gives the list a head of its own. */}
          <div className="mt-10 mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
            {chats.length} {chats.length === 1 ? "chat" : "chats"}
          </div>
          <div className="flex flex-col divide-y divide-border/50 border-t border-border/50">
            {chats.map((thread) => (
              <ThreadHoverCard
                key={`${thread.environmentId}:${thread.id}`}
                thread={thread}
                status={resolveThreadStatusPill({ thread })}
                side="right"
              >
                <button
                  type="button"
                  className="group flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-1 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid="chats-view-row"
                  onClick={() => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.id),
                      ),
                    });
                  }}
                >
                  <ThreadRowLeadingStatus thread={thread} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                    {thread.title}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/50">
                    {formatRelativeTimeLabel(
                      thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                    )}
                  </span>
                </button>
              </ThreadHoverCard>
            ))}
          </div>
        </SidebarHoverCardGroup>
      )}
    </div>
  );
}
