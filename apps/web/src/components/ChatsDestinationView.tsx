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
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import { PROVIDER_OPTIONS } from "../session-logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadHoverCard, ThreadHoverCardProvider } from "./sidebar/ThreadHoverCard";
import { SidebarHoverCardGroup } from "./sidebar/hoverCard";
import type { SidebarThreadSummary } from "../types";

const DAY_MS = 24 * 60 * 60 * 1_000;

type ChatGroupId = "today" | "week" | "earlier";

const CHAT_GROUP_LABELS: Record<ChatGroupId, string> = {
  today: "Today",
  week: "This week",
  earlier: "Earlier",
};

function chatActivityAt(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

/** Recency buckets, read off the same clock as the row's relative time. */
function resolveChatGroup(activityAt: string, nowMs: number): ChatGroupId {
  const at = Date.parse(activityAt);
  if (Number.isNaN(at)) return "earlier";
  const startOfToday = new Date(nowMs).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return "today";
  if (at >= startOfToday - 6 * DAY_MS) return "week";
  return "earlier";
}

/**
 * The Chats destination: general chats are threads with no project, so they get
 * a place of their own rather than a project-shaped group in the sidebar.
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

  const groups = useMemo(() => {
    const nowMs = Date.now();
    const byGroup = new Map<ChatGroupId, SidebarThreadSummary[]>();
    for (const thread of chats) {
      const group = resolveChatGroup(chatActivityAt(thread), nowMs);
      const existing = byGroup.get(group);
      if (existing) {
        existing.push(thread);
      } else {
        byGroup.set(group, [thread]);
      }
    }
    // Empty buckets are simply absent: a label with nothing under it is a
    // heading for a list that does not exist.
    return (["today", "week", "earlier"] as const).flatMap((group) => {
      const groupChats = byGroup.get(group);
      return groupChats ? [{ id: group, chats: groupChats }] : [];
    });
  }, [chats]);

  const startChat = () => {
    if (generalChatsProjectRef) {
      void startNewGeneralChatThread(handleNewThread, generalChatsProjectRef);
    }
  };

  const newChatButton = (
    <button
      type="button"
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-ring"
      data-testid="chats-view-new-chat"
      disabled={generalChatsProjectRef === null}
      onClick={startChat}
    >
      <MessageCirclePlusIcon className="size-3.5" />
      New chat
    </button>
  );

  return (
    <ThreadHoverCardProvider side="bottom">
      <div
        className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-8"
        data-testid="chats-view"
      >
        <div className="mb-1 flex items-center gap-3">
          <h1 className="flex-1 text-lg font-medium tracking-tight">General chats</h1>
          {newChatButton}
        </div>
        <p className="text-sm text-muted-foreground/70">
          Conversations that aren&apos;t tied to a project.
        </p>

        {chats.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground/70">No general chats yet</p>
              <p className="text-xs text-muted-foreground/50">
                Start one for anything that doesn&apos;t belong to a project.
              </p>
            </div>
            {newChatButton}
          </div>
        ) : (
          <SidebarHoverCardGroup>
            {groups.map((group) => (
              <section key={group.id} className="mt-8 first:mt-10">
                <h2 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none">
                  {CHAT_GROUP_LABELS[group.id]}
                </h2>
                <div className="flex flex-col divide-y divide-border/50">
                  {group.chats.map((thread) => (
                    <ChatRow
                      key={`${thread.environmentId}:${thread.id}`}
                      thread={thread}
                      onOpen={() => {
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(thread.environmentId, thread.id),
                          ),
                        });
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </SidebarHoverCardGroup>
        )}
      </div>
    </ThreadHoverCardProvider>
  );
}

function ChatRow({ thread, onOpen }: { thread: SidebarThreadSummary; onOpen: () => void }) {
  const provider = thread.session?.provider ?? null;
  const ProviderIcon = provider ? (PROVIDER_ICON_BY_PROVIDER[provider] ?? null) : null;
  // The listing carries no message text and this page adds no fetching of its
  // own, so the provider is what the second line can honestly say.
  const providerLabel = provider
    ? (PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider)
    : null;

  return (
    <ThreadHoverCard thread={thread} status={resolveThreadStatusPill({ thread })}>
      <button
        type="button"
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-2.5 text-left transition-colors select-none hover:bg-muted focus-ring"
        data-testid="chats-view-row"
        onClick={onOpen}
      >
        <span className="flex w-full min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
            {thread.title}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/50">
            {formatRelativeTimeLabel(chatActivityAt(thread))}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/55">
            {providerLabel}
          </span>
          {ProviderIcon ? (
            <ProviderIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/45" />
          ) : null}
        </span>
      </button>
    </ThreadHoverCard>
  );
}
