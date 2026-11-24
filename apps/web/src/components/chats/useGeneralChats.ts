import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { startNewGeneralChatThread } from "../../lib/chatThreadActions";
import { resolveGeneralChatsProjectRef } from "../../lib/generalChats";
import { sortThreads } from "../../lib/threadSort";
import {
  selectGeneralChatsProjectAcrossEnvironments,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import type { SidebarThreadSummary } from "../../types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ChatGroupId = "today" | "week" | "earlier";

export const CHAT_GROUP_LABELS: Record<ChatGroupId, string> = {
  today: "Today",
  week: "This week",
  earlier: "Earlier",
};

/** When a chat was last active: its last message, else its last change. */
export function chatActivityAt(thread: SidebarThreadSummary): string {
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
 * Every connected computer's general chats, newest first, and a way to start
 * one. The General Chats list beside the rail, the phone's chats page, the
 * General chats section of Threads and previous/next read the same order.
 * `environmentId` narrows both to one computer, as the Threads list's
 * computer filter does: only its chats, and new ones start there.
 */
/**
 * Starts a new general chat (`initialPrompt` opens it with words to finish),
 * or null while no computer has a General Chats project to start one in. It
 * reads no threads, so a streamed reply doesn't re-render its caller.
 */
export function useStartGeneralChat(options?: {
  readonly environmentId: string | null;
}): ((initialPrompt?: string) => void) | null {
  const { handleNewThread } = useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const onlyEnvironmentId = options?.environmentId ?? null;
  const generalChatsProjectRef = useMemo(() => {
    if (onlyEnvironmentId !== null) {
      const project = projects.find(
        (candidate) =>
          candidate.kind === "general-chat" && candidate.environmentId === onlyEnvironmentId,
      );
      return project ? scopeProjectRef(project.environmentId, project.id) : null;
    }
    return resolveGeneralChatsProjectRef({
      generalChatsProject,
      activeEnvironmentId,
      primaryEnvironmentId,
    });
  }, [activeEnvironmentId, generalChatsProject, onlyEnvironmentId, primaryEnvironmentId, projects]);

  const startChatInProject = useCallback(
    (initialPrompt?: string) => {
      if (generalChatsProjectRef) {
        void startNewGeneralChatThread(handleNewThread, generalChatsProjectRef, initialPrompt);
      }
    },
    [generalChatsProjectRef, handleNewThread],
  );
  return generalChatsProjectRef === null ? null : startChatInProject;
}

export function useGeneralChats(options?: { readonly environmentId: string | null }): {
  readonly chats: readonly SidebarThreadSummary[];
  /**
   * Null while no computer has a General Chats project to start one in.
   * `initialPrompt` opens the chat with words to finish.
   */
  readonly startChat: ((initialPrompt?: string) => void) | null;
} {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const startChat = useStartGeneralChat(options);
  const onlyEnvironmentId = options?.environmentId ?? null;

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
          (onlyEnvironmentId === null || thread.environmentId === onlyEnvironmentId) &&
          generalChatProjectKeys.has(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          ),
      ),
    );
  }, [onlyEnvironmentId, projects, threads]);

  return { chats, startChat };
}

/**
 * The chats in recency buckets (Today, This week, Earlier), as the chats
 * list and the phone's page head them. Empty buckets are left out.
 */
export function useGeneralChatGroups(chats: readonly SidebarThreadSummary[]): ReadonlyArray<{
  readonly id: ChatGroupId;
  readonly chats: readonly SidebarThreadSummary[];
}> {
  // A day's change moves chats between buckets without anything else changing.
  const nowMs = useRelativeTimeTick(60_000);
  return useMemo(() => {
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
    return (["today", "week", "earlier"] as const).flatMap((group) => {
      const groupChats = byGroup.get(group);
      return groupChats ? [{ id: group, chats: groupChats }] : [];
    });
  }, [chats, nowMs]);
}
