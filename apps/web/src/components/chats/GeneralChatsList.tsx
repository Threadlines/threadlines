import { scopedThreadKey } from "@threadlines/client-runtime";
import { useParams } from "@tanstack/react-router";
import { MessageCirclePlusIcon } from "lucide-react";

import { useThreadRowSwipes } from "../../hooks/useThreadRowSwipes";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { SwipeUndoBar } from "../sidebar/SwipeUndoBar";
import { SidebarHoverCardGroup } from "../sidebar/hoverCard";
import { ThreadHoverCardProvider } from "../sidebar/ThreadHoverCard";
import { ChromeIconButton, ChromeTooltip } from "../sidebar/ChromeIconButton";
import { SidebarContent, useCloseSidebarSheet } from "../ui/sidebar";
import { GeneralChatRows } from "./GeneralChatRows";
import { useGeneralChatGroups, useGeneralChats } from "./useGeneralChats";

/**
 * The General Chats list beside the rail: every general chat, newest first in
 * the same buckets as the phone's chats page, what each is doing, and a New
 * chat button. The open chat shows in the main view beside it.
 */
export function GeneralChatsList() {
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
              <GeneralChatRows
                groups={groups}
                activeThreadKey={routeThreadKey}
                onSwipe={handleRowSwipe}
                onBeforeOpen={closeSheet}
              />
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
