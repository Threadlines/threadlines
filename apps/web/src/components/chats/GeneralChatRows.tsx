import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadMenu } from "../../hooks/useThreadMenu";
import type { ThreadRowSwipeHandler } from "../../hooks/useThreadRowSwipes";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { RelativeTimeLabel } from "../RelativeTimeLabel";
import {
  isUnreadResultStatus,
  resolveSeenThreadStatus,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import { ThreadStatusText } from "../sidebar/InboxRows";
import { SwipeableRow, threadRowSwipeAction } from "../sidebar/SwipeableRow";
import { ThreadHoverCard } from "../sidebar/ThreadHoverCard";
import { isThreadTurnRunning } from "../threadMenu.logic";
import { CHAT_GROUP_LABELS, chatActivityAt, type useGeneralChatGroups } from "./useGeneralChats";

function GeneralChatRow({
  thread,
  threadKey,
  status,
  active,
  onOpen,
  onMenu,
  onSwipe,
}: {
  readonly thread: SidebarThreadSummary;
  readonly threadKey: string;
  readonly status: ThreadStatusPill | null;
  readonly active: boolean;
  readonly onOpen: () => void;
  /** The thread menu (right-click, or a held finger). */
  readonly onMenu: (position: { readonly x: number; readonly y: number }) => void;
  /** Runs a touch swipe's action: right pins or unpins, left archives. */
  readonly onSwipe: ThreadRowSwipeHandler;
}) {
  // An answer nobody has read keeps the title bright, as in the inbox.
  const unread = isUnreadResultStatus(status);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      onMenu({ x: event.clientX, y: event.clientY });
    },
    [onMenu],
  );
  const touchHold = useTouchHoldMenu<HTMLButtonElement>({
    open: onMenu,
    onContextMenu: handleContextMenu,
  });
  const swipeTarget = { threadKey, title: thread.title };
  return (
    <li>
      {/* Its menu's Pin and Archive as swipes; Archive waits, as in the menu,
          while its agent is mid-turn. */}
      <SwipeableRow
        className="rounded-lg"
        leading={threadRowSwipeAction(
          onSwipe,
          swipeTarget,
          thread.pinnedAt !== null ? "unpin" : "pin",
        )}
        trailing={
          isThreadTurnRunning(thread.session)
            ? null
            : threadRowSwipeAction(onSwipe, swipeTarget, "archive")
        }
      >
        <ThreadHoverCard thread={thread} status={status}>
          <button
            type="button"
            data-testid="chats-list-row"
            data-unread={unread ? "" : undefined}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring [-webkit-touch-callout:none]",
              active
                ? "bg-sidebar-accent"
                : "hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80",
            )}
            onClick={onOpen}
            {...touchHold}
          >
            <span
              aria-label={status?.label}
              className={cn("size-[7px] shrink-0 rounded-full", status?.dotClass)}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium",
                unread || active ? "text-foreground" : "text-foreground/90",
              )}
            >
              {thread.title}
            </span>
            <ThreadStatusText
              thread={thread}
              status={status}
              testId="chats-list-row-status"
              resting={<RelativeTimeLabel at={chatActivityAt(thread)} compact />}
              restingClassName="text-muted-foreground"
            />
          </button>
        </ThreadHoverCard>
      </SwipeableRow>
    </li>
  );
}

/**
 * General chats as rows, newest first under their recency labels (Today, This
 * week, Earlier): the General Chats page's list and the General chats section
 * of Threads both draw them. `onlyThreadKey` draws just that chat's row and no
 * labels, for a folded section that still shows the chat open beside it.
 */
export function GeneralChatRows({
  groups,
  activeThreadKey,
  onlyThreadKey,
  onSwipe,
  onBeforeOpen,
}: {
  readonly groups: ReturnType<typeof useGeneralChatGroups>;
  readonly activeThreadKey: string | null;
  readonly onlyThreadKey?: string | null;
  readonly onSwipe: ThreadRowSwipeHandler;
  /** Runs before a row opens its chat: a phone's sheet closes. */
  readonly onBeforeOpen: () => void;
}) {
  const navigate = useNavigate();
  const seenSources = useThreadSeenSources();
  const threadMenu = useThreadMenu();
  const folded = onlyThreadKey !== undefined;
  return groups.map((group) => {
    const rows = group.chats.flatMap((thread) => {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (folded && threadKey !== onlyThreadKey) return [];
      return [
        <GeneralChatRow
          key={threadKey}
          thread={thread}
          threadKey={threadKey}
          onSwipe={onSwipe}
          status={resolveSeenThreadStatus(thread, threadKey, seenSources).status}
          active={threadKey === activeThreadKey}
          onMenu={(position) =>
            void threadMenu.open(
              { threadRef: scopeThreadRef(thread.environmentId, thread.id) },
              position,
            )
          }
          onOpen={() => {
            onBeforeOpen();
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
            });
          }}
        />,
      ];
    });
    if (rows.length === 0) return null;
    return (
      <section key={group.id} className={folded ? undefined : "mt-3 first:mt-1"}>
        {folded ? null : (
          <h3 className="px-2 pb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase select-none">
            {CHAT_GROUP_LABELS[group.id]}
          </h3>
        )}
        <ul className="flex flex-col gap-px" data-testid="chats-list">
          {rows}
        </ul>
      </section>
    );
  });
}
