import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { useParams } from "@tanstack/react-router";
import { MessageCirclePlusIcon } from "lucide-react";
import { useMemo } from "react";

import type { ThreadRowSwipeHandler } from "../../hooks/useThreadRowSwipes";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { cn } from "../../lib/utils";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import {
  countThreadAttention,
  isUnreadResultStatus,
  resolveSeenThreadStatus,
  resolveThreadAttention,
  THREAD_STATUS_DOT_CLASSES,
} from "../Sidebar.logic";
import { AttentionCounts } from "../sidebar/AttentionCounts";
import { InboxShelfHeader } from "../sidebar/InboxShelfHeader";
import { ScrollArea } from "../ui/scroll-area";
import { useCloseSidebarSheet } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GeneralChatRows } from "./GeneralChatRows";
import { useGeneralChatGroups, useGeneralChats } from "./useGeneralChats";

/**
 * The General chats section at the foot of the Threads list, on a device that
 * lists the chats there instead of on their own page (useGeneralChatsInThreads).
 * Parked under Wrapped with the same header line, plus a New chat button at
 * its end, so starting a chat never needs the section open.
 *
 * Open, it is as tall as its rows, up to `maxHeight`, and scrolls inside.
 * Closed, it keeps the row of a chat open beside it, and its header says what
 * the hidden chats are doing (needs you, working, an unread answer), since the
 * rail leaves that to the list beside it.
 */
export function GeneralChatsShelf({
  environmentId,
  maxHeight,
  shelfRef,
  onSwipe,
}: {
  /** The computer the Threads list is narrowed to, if any: the section follows it. */
  readonly environmentId: string | null;
  /** The open section's cap, as a CSS length. */
  readonly maxHeight: string;
  readonly shelfRef: (element: HTMLElement | null) => void;
  /** The inbox's swipe handler, so its one Undo bar covers chats too. */
  readonly onSwipe: ThreadRowSwipeHandler;
}) {
  const open = useUiStateStore((state) => state.inboxGeneralChatsOpen);
  const setOpen = useUiStateStore((state) => state.setInboxGeneralChatsOpen);
  const closeSheet = useCloseSidebarSheet();
  const seenSources = useThreadSeenSources();
  const { chats, startChat } = useGeneralChats({ environmentId });
  const groups = useGeneralChatGroups(chats);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

  // Counted as the rail counts them (useDestinationAttention).
  const attention = useMemo(() => {
    const seen = chats.map((thread) => ({
      thread,
      ...resolveSeenThreadStatus(
        thread,
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        seenSources,
      ),
    }));
    const counts = countThreadAttention(
      seen.map(({ thread, lastVisitedAt, status }) =>
        resolveThreadAttention(
          { ...thread, ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}) },
          status,
        ),
      ),
    );
    return { ...counts, unread: seen.some(({ status }) => isUnreadResultStatus(status)) };
  }, [chats, seenSources]);

  const rows = (
    <GeneralChatRows
      groups={groups}
      activeThreadKey={routeThreadKey}
      {...(open ? {} : { onlyThreadKey: routeThreadKey })}
      onSwipe={onSwipe}
      onBeforeOpen={closeSheet}
    />
  );

  return (
    <section
      ref={shelfRef}
      aria-label="General chats"
      data-testid="inbox-chats-shelf"
      className="flex min-h-0 shrink-0 flex-col"
      style={open ? { maxHeight } : undefined}
    >
      <InboxShelfHeader
        label={`General chats (${chats.length})`}
        open={open}
        onToggle={() => setOpen(!open)}
        testId="inbox-chats-toggle"
        detail={
          open ? null : (
            <span className="flex shrink-0 items-center gap-2" data-testid="inbox-chats-folded">
              <AttentionCounts needsYou={attention.needsYou} working={attention.working} />
              {attention.unread ? (
                <span
                  title="Unread"
                  data-testid="inbox-chats-unread"
                  className={cn("size-1.5 rounded-full", THREAD_STATUS_DOT_CLASSES.blue)}
                >
                  <span className="sr-only">Unread</span>
                </span>
              ) : null}
            </span>
          )
        }
        action={
          <Tooltip>
            <TooltipTrigger
              delay={0}
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  aria-label="New chat"
                  data-testid="inbox-chats-new-chat"
                  disabled={startChat === null}
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-ring disabled:cursor-default disabled:opacity-50"
                  onClick={() => {
                    if (startChat === null) return;
                    closeSheet();
                    startChat();
                  }}
                />
              }
            >
              <MessageCirclePlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {startChat === null
                ? environmentId === null
                  ? "New chat · No computer is connected yet."
                  : "New chat · This computer can't start one yet."
                : "New chat"}
            </TooltipPopup>
          </Tooltip>
        }
      />
      {open ? (
        <ScrollArea hideScrollbars className="h-auto min-h-0 flex-initial">
          <div className="px-2 pb-2">
            {chats.length === 0 ? (
              <p className="px-2 pb-1 text-[12px] text-muted-foreground">
                No general chats yet. Start one for anything that doesn&apos;t belong to a project.
              </p>
            ) : (
              rows
            )}
          </div>
        </ScrollArea>
      ) : routeThreadKey !== null ? (
        <div className="px-2 pb-2 empty:hidden">{rows}</div>
      ) : null}
    </section>
  );
}
