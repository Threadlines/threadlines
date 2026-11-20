import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { ChatsDestinationView } from "../components/ChatsDestinationView";
import {
  requestSidebarListReveal,
  useGeneralChatsInThreads,
} from "../components/chats/generalChatsPlacement";
import { threadsViewHref } from "../components/sidebar/NavigationRail";
import { useSidebar } from "../components/ui/sidebar";
import { useUiStateStore } from "../uiStateStore";

/**
 * General Chats' own address. Where the chats have their own page it shows
 * it. Where this device lists them in a section of Threads, every way here
 * (an old link, the command palette, the desktop menu, a place link) lands on
 * Threads instead, with the list showing and the section open.
 */
function ChatsRoute() {
  const inThreads = useGeneralChatsInThreads();
  return inThreads ? <OpenGeneralChatsInThreads /> : <ChatsDestinationView />;
}

function OpenGeneralChatsInThreads() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    const target = threadsViewHref();
    useUiStateStore.getState().setInboxGeneralChatsOpen(true);
    if (isMobile) {
      // A phone's list is its sheet, which a page change leaves as it is.
      setOpenMobile(true);
    } else {
      // The shell hides a floating list when the page changes; across this
      // redirect it shows it instead.
      requestSidebarListReveal(router.state.location.pathname, target);
      useUiStateStore.getState().setSidebarListShown(true);
    }
    void router.navigate({ href: target, replace: true });
  }, [isMobile, router, setOpenMobile]);
  return null;
}

export const Route = createFileRoute("/_chat/chats")({
  component: ChatsRoute,
});
