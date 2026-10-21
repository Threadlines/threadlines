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
 * one. The General Chats list beside the rail, the phone's chats page and
 * previous/next read the same order.
 */
export function useGeneralChats(): {
  readonly chats: readonly SidebarThreadSummary[];
  /** Null while no computer has a General Chats project to start one in. */
  readonly startChat: (() => void) | null;
} {
  const { handleNewThread } = useHandleNewThread();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const generalChatsProject = useStore(selectGeneralChatsProjectAcrossEnvironments);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

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

  const startChatInProject = useCallback(() => {
    if (generalChatsProjectRef) {
      void startNewGeneralChatThread(handleNewThread, generalChatsProjectRef);
    }
  }, [generalChatsProjectRef, handleNewThread]);

  return {
    chats,
    startChat: generalChatsProjectRef === null ? null : startChatInProject,
  };
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
