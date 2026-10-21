import { useEffect, type CSSProperties, type ReactNode } from "react";
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";

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
import {
  NAVIGATION_RAIL_WIDTH_PX,
  NavigationRail,
  useRememberThreadsView,
} from "./sidebar/NavigationRail";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
// Chat is the main focus: the sidebar starts at its minimum width and only
// grows if the user drags it wider (which is then persisted).
const THREAD_SIDEBAR_DEFAULT_WIDTH = `${THREAD_SIDEBAR_MIN_WIDTH}px`;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

/**
 * The shell's own commands, wherever they come from: the sidebar and Fleet
 * shortcuts, and the desktop app's menus (application menu and tray). Sits
 * inside the sidebar provider, so hiding the list goes through the same
 * toggle the rail's button uses.
 */
function AppShellCommands() {
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
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
        toggleSidebar();
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
  }, [keybindings, navigate, routeThreadRef, toggleSidebar]);

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
          toggleSidebar();
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
    handleNewThread,
    navigate,
    toggleSidebar,
  ]);

  return null;
}

/**
 * The app shell on every page but setup: the navigation rail at the window's
 * left edge, the thread list beside it (hidden and shown from the rail, and
 * remembered across launches), then the page.
 */
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const sidebarListOpen = useUiStateStore((store) => store.sidebarListOpen);
  const setSidebarListOpen = useUiStateStore((store) => store.setSidebarListOpen);
  const sidebarStyle = {
    "--sidebar-width": THREAD_SIDEBAR_DEFAULT_WIDTH,
    // The rail shows on wide screens only (below `md` the list is a sheet),
    // so the room left for it follows the same breakpoint: see the provider's
    // class, which sets it to NAVIGATION_RAIL_WIDTH_PX from `md` up.
    "--sidebar-rail-width": "var(--app-navigation-rail-width)",
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
      className="h-dvh! min-h-0! [--app-navigation-rail-width:0px] md:[--app-navigation-rail-width:52px]"
      open={sidebarListOpen}
      onOpenChange={setSidebarListOpen}
      style={sidebarStyle}
    >
      <AppShellCommands />
      <NavigationRail />
      <Sidebar
        side="left"
        // Hiding slides the list away beneath the rail; the rail stays and
        // keeps every destination, and the counts that need the user.
        collapsible="offcanvas"
        className="border-r border-border bg-rail text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          // The main pane keeps its minimum beside both the rail and the list.
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - NAVIGATION_RAIL_WIDTH_PX - nextWidth >=
            THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        {/* The drag handle on the pane's edge; it resizes while open. */}
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  );
}
