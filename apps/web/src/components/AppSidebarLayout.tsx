import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useAppHistory } from "../appHistory";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand } from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import ThreadSidebar from "./Sidebar";
import { AppTitleBar } from "./sidebar/AppTitleBar";
import { destinationHasList } from "./sidebar/destinationLists";
import {
  NAVIGATION_RAIL_WIDTH_PX,
  NavigationRail,
  useRememberThreadsView,
  useSelectedDestination,
} from "./sidebar/NavigationRail";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
// Room for a row's project, branch and time beside the rail without cutting
// the project to a few letters; the user can drag it wider (then persisted).
const THREAD_SIDEBAR_MIN_WIDTH = 15 * 16;
const THREAD_SIDEBAR_DEFAULT_WIDTH = `${17 * 16}px`;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

/**
 * The shell's own commands, wherever they come from: the sidebar and Fleet
 * shortcuts, and the desktop app's menus (application menu and tray). Sits
 * inside the sidebar provider, so hiding the list goes through the same
 * toggle the rail's button uses.
 */
function AppShellCommands({ hasList }: { readonly hasList: boolean }) {
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const appHistory = useAppHistory();
  // A page with no list (Pull Requests, Usage) has nothing to show or hide.
  const toggleList = useCallback(() => {
    if (hasList) toggleSidebar();
  }, [hasList, toggleSidebar]);
  const keybindings = useServerKeybindings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  useRememberThreadsView();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (useCommandPaletteStore.getState().open) return;
      // Read when the key lands, like the sidebar's own shortcuts: a rule
      // the user scoped to an open terminal must see the terminal as it is.
      const terminalOpen = routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), terminalOpen },
      });
      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleList();
        return;
      }
      if (command === "navigate.back" || command === "navigate.forward") {
        event.preventDefault();
        event.stopPropagation();
        if (command === "navigate.back") appHistory.back();
        else appHistory.forward();
        return;
      }
      if (command === "navigate.fleet") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({ to: "/fleet" });
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [appHistory, keybindings, navigate, routeThreadRef, toggleList]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action, payload) => {
      switch (action) {
        case "open-settings":
          void navigate({ to: "/settings" });
          return;
        case "open-fleet":
          void navigate({ to: "/fleet" });
          return;
        case "open-general-chats":
          void navigate({ to: "/chats" });
          return;
        case "open-usage":
          void navigate({ to: "/usage" });
          return;
        case "toggle-sidebar":
          toggleList();
          return;
        case "navigate-back":
          appHistory.back();
          return;
        case "navigate-forward":
          appHistory.forward();
          return;
        case "toggle-command-palette":
          useCommandPaletteStore.getState().toggleOpen();
          return;
        case "new-thread":
          void startNewThreadFromContext({
            activeDraftThread,
            activeThread,
            defaultProjectRef,
            handleNewThread,
          });
          return;
        case "open-thread": {
          const environmentId = payload?.environmentId;
          const threadId = payload?.threadId;
          if (!environmentId || !threadId) {
            return;
          }
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId),
            ),
          });
          return;
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    appHistory,
    handleNewThread,
    navigate,
    toggleList,
  ]);

  return null;
}

/**
 * The app shell on every page but setup. A frame in one color wraps the
 * window's top-left: the title row (window controls, the list toggle, back
 * and forward, the app's name) and the navigation rail under it. Beside the
 * rail, one work panel with a rounded top-left corner holds the page's list
 * (the thread inbox, General chats, Computers, Settings; see destinationLists)
 * and the page. Hiding the list moves only the page's left edge; the list's
 * state is remembered across launches, and pages without a list ignore it.
 */
/**
 * A quick cross-fade (0.14s, opacity only) when the rail's destination
 * changes: Threads to Fleet, say. Moving between threads, or anything else
 * inside one destination, never fades. Nothing runs under reduced motion.
 */
function usePageCrossFade(panelRef: RefObject<HTMLDivElement | null>, destination: string) {
  const previous = useRef(destination);
  useLayoutEffect(() => {
    if (previous.current === destination) return;
    previous.current = destination;
    const panel = panelRef.current;
    if (!panel || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const child of panel.children) {
      if (child instanceof HTMLElement && typeof child.animate === "function") {
        child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
      }
    }
  }, [destination, panelRef]);
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const sidebarListOpen = useUiStateStore((store) => store.sidebarListOpen);
  const setSidebarListOpen = useUiStateStore((store) => store.setSidebarListOpen);
  const selectedDestination = useSelectedDestination();
  const hasList = destinationHasList(selectedDestination);
  const panelRef = useRef<HTMLDivElement>(null);
  usePageCrossFade(panelRef, selectedDestination);
  const setListOpen = useCallback(
    (open: boolean) => {
      if (hasList) setSidebarListOpen(open);
    },
    [hasList, setSidebarListOpen],
  );
  const sidebarStyle = {
    "--sidebar-width": THREAD_SIDEBAR_DEFAULT_WIDTH,
  } as CSSProperties;

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  return (
    <SidebarProvider
      className="h-dvh! min-h-0! flex-col bg-frame"
      open={sidebarListOpen && hasList}
      onOpenChange={setListOpen}
      style={sidebarStyle}
    >
      <AppShellCommands hasList={hasList} />
      <AppTitleBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <div
          ref={panelRef}
          data-slot="app-panel"
          data-testid="app-panel"
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:rounded-tl-3xl md:border-t md:border-l md:border-border"
        >
          <Sidebar
            side="left"
            // Hiding slides the list away inside the panel; the rail and the
            // title row stay where they are.
            collapsible="offcanvas"
            // The list shares the panel's canvas, split from the page by a hairline.
            className="border-r border-border bg-background text-foreground [--sidebar:var(--background)]"
            resizable={{
              minWidth: THREAD_SIDEBAR_MIN_WIDTH,
              // The page keeps its minimum beside the list.
              shouldAcceptWidth: ({ nextWidth, sidebarRoot, wrapper }) =>
                (sidebarRoot.parentElement?.clientWidth ??
                  wrapper.clientWidth - NAVIGATION_RAIL_WIDTH_PX) -
                  nextWidth >=
                THREAD_MAIN_CONTENT_MIN_WIDTH,
              storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            }}
          >
            <ThreadSidebar />
            {/* The drag handle on the pane's edge; it resizes while open. */}
            <SidebarRail />
          </Sidebar>
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}
