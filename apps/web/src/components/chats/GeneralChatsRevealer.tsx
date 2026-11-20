import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { isLaunchVisitConsumed } from "../../launchVisit";
import { useUiStateStore } from "../../uiStateStore";
import { threadsViewHref, useSelectedDestination } from "../sidebar/NavigationRail";
import { useSidebar } from "../ui/sidebar";
import {
  readGeneralChatsRevealRequests,
  requestSidebarListReveal,
  useGeneralChatsRevealRequests,
} from "./generalChatsPlacement";

/**
 * Opens General Chats where they are a section of Threads, on each request
 * (requestGeneralChatsReveal): the section unfolds, the list beside the rail
 * shows (a phone opens its sheet), and the page becomes Threads, where the
 * Threads button goes, unless a Threads view is already on screen. From the
 * old /chats address that last step replaces it, so Back skips it. Mounted
 * once, inside the shell's sidebar.
 */
export function GeneralChatsRevealer() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const requests = useGeneralChatsRevealRequests();
  // Requests made before this mounted (the /chats page asks as it mounts,
  // beside the shell) count; none from an earlier shell would.
  const [requestsAtMount] = useState(readGeneralChatsRevealRequests);
  const selected = useSelectedDestination();

  const reveal = useEffectEvent(() => {
    const ui = useUiStateStore.getState();
    ui.setInboxGeneralChatsOpen(true);
    if (isMobile) setOpenMobile(true);
    else ui.setSidebarListShown(true);
    const pathname = router.state.location.pathname;
    const onChatsAddress = pathname === "/chats" || pathname.startsWith("/chats/");
    if (!onChatsAddress && selected === "threads") return;
    const target = threadsViewHref(true);
    if (!isMobile) {
      // Home on a launch goes on to the last thread: one more page change.
      requestSidebarListReveal(pathname, target, {
        thenAny: target === "/" && !isLaunchVisitConsumed(),
      });
    }
    void router.navigate({ href: target, replace: onChatsAddress });
  });

  useEffect(() => {
    if (requests !== requestsAtMount) reveal();
  }, [requests, requestsAtMount]);

  return null;
}
