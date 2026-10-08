import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { MessageCirclePlusIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewGeneralChatThread } from "../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../lib/generalChats";
import { useThreadSeenSources } from "../lib/threadInboxSync";
import { sortThreads } from "../lib/threadSort";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  selectGeneralChatsProjectAcrossEnvironments,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { PageTitlebar } from "./PageTitlebar";
import { ProviderGlyph } from "./chat/ProviderInstanceIcon";
import { PROVIDER_OPTIONS } from "../session-logic";
import { resolveSeenThreadStatus, type ThreadStatusPill } from "./Sidebar.logic";
import { ThreadEnvironmentBadge, ThreadStatusText } from "./sidebar/InboxRows";
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
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const seenSources = useThreadSeenSources();

  const generalChatsProjectRef = useMemo(
    () =>
      resolveGeneralChatsProjectRef({
        generalChatsProject,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    [activeEnvironmentId, generalChatsProject, primaryEnvironmentId],
  );

  // Every connected machine's general chats, like the sidebar's lines that
  // lead here: a chat folded behind "N more" must be on this page.
  const chats = useMemo(() => {
    const generalChatProjectKeys = new Set(
      projects
        .filter((project) => project.kind === "general-chat")
        .map((project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
    );
    return sortThreads(
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          generalChatProjectKeys.has(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          ),
      ),
    );
  }, [projects, threads]);

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
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="chats-view">
        <PageTitlebar label="General chats" />
        {/* The pane-wide element scrolls so the scrollbar hugs the pane's edge
            (like Settings); the reading column centers inside it. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-8">
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
                          status={
                            resolveSeenThreadStatus(
                              thread,
                              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                              seenSources,
                            ).status
                          }
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
        </div>
      </div>
    </ThreadHoverCardProvider>
  );
}

/**
 * One chat: its title and what it is doing now, in the words and colours the
 * sidebar uses ("input", "working · 4m"), or when it was last active.
 */
function ChatRow({
  thread,
  status,
  onOpen,
}: {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  onOpen: () => void;
}) {
  const provider = thread.session?.provider ?? null;
  // The listing carries no message text and this page adds no fetching of its
  // own, so the provider is what the second line can honestly say.
  const providerLabel = provider
    ? (PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider)
    : null;

  return (
    <ThreadHoverCard thread={thread} status={status}>
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
          <span className="flex shrink-0 items-center gap-1.5 self-center">
            {status ? (
              <span
                aria-label={status.label}
                className={cn("size-[7px] shrink-0 rounded-full", status.dotClass)}
              />
            ) : null}
            <ThreadStatusText
              thread={thread}
              status={status}
              testId="chats-view-row-status"
              resting={formatRelativeTimeLabel(chatActivityAt(thread))}
              restingClassName="text-muted-foreground"
            />
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/55">
            {providerLabel}
          </span>
          <ThreadEnvironmentBadge thread={thread} />
          {provider ? (
            <ProviderGlyph
              instanceId={thread.session?.providerInstanceId}
              driverKind={provider}
              className="size-3 shrink-0 text-muted-foreground/45"
            />
          ) : null}
        </span>
      </button>
    </ThreadHoverCard>
  );
}
