import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useAppHistory } from "../appHistory";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isKnownEnvironment } from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand } from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useIsMobile } from "../hooks/useMediaQuery";
import { usePublishMainAreaStart } from "../mainAreaLayout";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { selectSidebarListShown, useUiStateStore } from "../uiStateStore";
import ThreadSidebar from "./Sidebar";
import { AppTitleBar } from "./sidebar/AppTitleBar";
import { TitleBarSlotContext } from "./sidebar/titleBarSlot";
import { destinationHasList } from "./sidebar/destinationLists";
import {
  NAVIGATION_RAIL_WIDTH_PX,
  NavigationRail,
  useRememberThreadsView,
  useSelectedDestination,
} from "./sidebar/NavigationRail";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { openWhatsNewDialog } from "./WhatsNewDialog";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
// Narrow enough to give the page the room, wide enough that a row's title
// still reads beside its change count; any narrower and titles lose the words
// that matter. The user can drag it wider (then persisted).
const THREAD_SIDEBAR_MIN_WIDTH = 14 * 16;
const THREAD_SIDEBAR_DEFAULT_WIDTH = `${15 * 16}px`;
// The page keeps at least this much beside the list: dragging the list wider
// stops there, and a window too narrow for both floats the list over the
// page instead (about 850px wide with the list at its default width).
const PAGE_MIN_WIDTH_BESIDE_LIST = 35 * 16;

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
      if (command === "navigate.scheduled") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({ to: "/scheduled" });
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
        case "open-scheduled":
          void navigate({ to: "/scheduled" });
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
        case "open-whats-new":
          openWhatsNewDialog();
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
          const threadRef = scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId);
          // A link from outside can name any computer. One this app doesn't
          // connect to would open a page that never loads.
          void isKnownEnvironment(threadRef.environmentId).then((known) => {
            if (!known) {
              toastManager.add({
                type: "warning",
                title: "Can't open that thread",
                description: "It's on a computer this app isn't connected to.",
              });
              return;
            }
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            });
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

/** A width variable's value in px ("240px", or "15rem" at the root font size). */
function readCssLength(element: Element, name: string): number {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  if (value.endsWith("rem")) {
    return amount * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }
  return amount;
}

/**
 * Keeps `sidebarListFloats` in the UI store true while the work panel is too
 * narrow for the list beside a page of at least PAGE_MIN_WIDTH_BESIDE_LIST.
 * It reads the list's own width (its variable, which a floating list's capped
 * box doesn't show), so floating never changes the answer. Measured before the
 * first paint and on every resize of the panel or the docked list. A phone
 * has its sheet instead, and never floats.
 */
function useSidebarListFloats(panelRef: RefObject<HTMLDivElement | null>, isMobile: boolean) {
  useLayoutEffect(() => {
    const { setSidebarListFloats } = useUiStateStore.getState();
    const panel = panelRef.current;
    if (isMobile || !panel || typeof ResizeObserver === "undefined") {
      setSidebarListFloats(false);
      return undefined;
    }
    const measure = () => {
      const listWidth = readCssLength(panel, "--sidebar-width");
      setSidebarListFloats(panel.clientWidth - listWidth < PAGE_MIN_WIDTH_BESIDE_LIST);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    // Beside the page the list's box follows its variable: a drag, a restored width.
    const list = panel.querySelector(
      ":scope > [data-slot='sidebar'] [data-slot='sidebar-container']",
    );
    if (list) observer.observe(list);
    measure();
    return () => observer.disconnect();
  }, [isMobile, panelRef]);
}

/**
 * The app shell on every page but setup. A frame in one color wraps the
 * window's top-left: the title row (window controls, the list toggle, back
 * and forward, the app's name) and the navigation rail under it. Beside the
 * rail, one work panel with a rounded top-left corner holds the page's list
 * (the thread inbox, General chats, Computers, Settings; see destinationLists)
 * and the page. Hiding the list moves only the page's left edge; the list's
 * state is remembered across launches, and pages without a list ignore it.
 * In a window too narrow for both, the list floats over the page instead,
 * starting closed, and its remembered state waits for a wider window.
 */
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const listShown = useUiStateStore(selectSidebarListShown);
  const listFloats = useUiStateStore((store) => store.sidebarListFloats);
  const setSidebarListShown = useUiStateStore((store) => store.setSidebarListShown);
  const selectedDestination = useSelectedDestination();
  const hasList = destinationHasList(selectedDestination);
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  useSidebarListFloats(panelRef, isMobile);
  // A floating list gets out of the way of whatever page opens next.
  const pathname = useLocation({ select: (location) => location.pathname });
  const shownPathname = useRef(pathname);
  useEffect(() => {
    if (shownPathname.current === pathname) return;
    shownPathname.current = pathname;
    const state = useUiStateStore.getState();
    if (state.sidebarListFloats) state.setSidebarListShown(false);
  }, [pathname]);
  usePageCrossFade(panelRef, selectedDestination);
  // Dialogs and other window-wide layers center over the page beside the list.
  usePublishMainAreaStart(panelRef);
  // The title row's slot for the open page; null without a title row.
  const [titleBarSlot, setTitleBarSlot] = useState<HTMLElement | null>(null);
  const setListOpen = useCallback(
    (open: boolean) => {
      if (hasList) setSidebarListShown(open);
    },
    [hasList, setSidebarListShown],
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
      open={listShown && hasList}
      onOpenChange={setListOpen}
      overlay={listFloats}
      style={sidebarStyle}
    >
      <AppShellCommands hasList={hasList} />
      <AppTitleBar slotRef={setTitleBarSlot} />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <div
          ref={panelRef}
          data-slot="app-panel"
          data-testid="app-panel"
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background desktop:rounded-tl-3xl desktop:border-t desktop:border-l desktop:border-border"
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
                PAGE_MIN_WIDTH_BESIDE_LIST,
              storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            }}
          >
            <ThreadSidebar />
            {/* The drag handle on the pane's edge; it resizes while open. */}
            <SidebarRail />
          </Sidebar>
          <TitleBarSlotContext value={titleBarSlot}>{children}</TitleBarSlotContext>
        </div>
      </div>
    </SidebarProvider>
  );
}
