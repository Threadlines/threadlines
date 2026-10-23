import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MessageCirclePlusIcon } from "lucide-react";
import { useCallback } from "react";

import { useThreadMenu } from "../../hooks/useThreadMenu";
import { type ThreadRowSwipeHandler, useThreadRowSwipes } from "../../hooks/useThreadRowSwipes";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import {
  isUnreadResultStatus,
  resolveSeenThreadStatus,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import { isThreadTurnRunning } from "../threadMenu.logic";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { SwipeableRow, threadRowSwipeAction } from "../sidebar/SwipeableRow";
import { SwipeUndoBar } from "../sidebar/SwipeUndoBar";
import { SidebarHoverCardGroup } from "../sidebar/hoverCard";
import { ThreadStatusText } from "../sidebar/InboxRows";
import { ThreadHoverCard, ThreadHoverCardProvider } from "../sidebar/ThreadHoverCard";
import { ChromeIconButton, ChromeTooltip } from "../sidebar/ChromeIconButton";
import { SidebarContent, useCloseSidebarSheet } from "../ui/sidebar";
import {
  CHAT_GROUP_LABELS,
  chatActivityAt,
  useGeneralChatGroups,
  useGeneralChats,
} from "./useGeneralChats";

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
              resting={formatRelativeTimeLabel(chatActivityAt(thread))}
              restingClassName="text-muted-foreground"
            />
          </button>
        </ThreadHoverCard>
      </SwipeableRow>
    </li>
  );
}

/**
 * The General Chats list beside the rail: every general chat, newest first in
 * the same buckets as the phone's chats page, what each is doing, and a New
 * chat button. The open chat shows in the main view beside it.
 */
export function GeneralChatsList() {
  const navigate = useNavigate();
  const seenSources = useThreadSeenSources();
  const threadMenu = useThreadMenu();
  // On a phone the list is a sheet over the page: opening a chat closes it.
  const closeSheet = useCloseSidebarSheet();
  const { chats, startChat } = useGeneralChats();
  const groups = useGeneralChatGroups(chats);
  const { handleRowSwipe, swipeUndo, dismissSwipeUndo } = useThreadRowSwipes();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

  return (
    <ThreadHoverCardProvider>
      <DestinationListHeader
        title="General chats"
        action={
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label="New chat"
            testId="chats-list-new-chat"
            disabled={startChat === null}
            tooltip={
              <ChromeTooltip
                label="New chat"
                detail={startChat === null ? "No computer is connected yet." : null}
              />
            }
            onClick={() => {
              if (startChat === null) return;
              closeSheet();
              startChat();
            }}
          >
            <MessageCirclePlusIcon aria-hidden="true" />
          </ChromeIconButton>
        }
      />
      {/* Positioned for the Undo bar a swipe leaves, which floats over the
          bottom of the list. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <SidebarContent className="px-2 pb-3">
          {chats.length === 0 ? (
            <div className="flex flex-col gap-1 px-2 py-2">
              <p className="text-[12.5px] text-muted-foreground">No general chats yet.</p>
              <p className="text-[12px] text-muted-foreground">
                Start one for anything that doesn&apos;t belong to a project.
              </p>
            </div>
          ) : (
            <SidebarHoverCardGroup>
              {groups.map((group) => (
                <section key={group.id} className="mt-3 first:mt-1">
                  <h3 className="px-2 pb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase select-none">
                    {CHAT_GROUP_LABELS[group.id]}
                  </h3>
                  <ul className="flex flex-col gap-px" data-testid="chats-list">
                    {group.chats.map((thread) => {
                      const threadKey = scopedThreadKey(
                        scopeThreadRef(thread.environmentId, thread.id),
                      );
                      return (
                        <GeneralChatRow
                          key={threadKey}
                          thread={thread}
                          threadKey={threadKey}
                          onSwipe={handleRowSwipe}
                          status={resolveSeenThreadStatus(thread, threadKey, seenSources).status}
                          active={threadKey === routeThreadKey}
                          onMenu={(position) =>
                            void threadMenu.open(
                              { threadRef: scopeThreadRef(thread.environmentId, thread.id) },
                              position,
                            )
                          }
                          onOpen={() => {
                            closeSheet();
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(thread.environmentId, thread.id),
                              ),
                            });
                          }}
                        />
                      );
                    })}
                  </ul>
                </section>
              ))}
            </SidebarHoverCardGroup>
          )}
        </SidebarContent>
        {swipeUndo ? (
          <SwipeUndoBar key={swipeUndo.id} undo={swipeUndo} onDismiss={dismissSwipeUndo} />
        ) : null}
      </div>
    </ThreadHoverCardProvider>
  );
}
