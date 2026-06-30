import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isMacPlatform } from "../lib/utils";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger } from "./ui/sidebar";
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
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "88px";

function SidebarControl() {
  return (
    <div
      className="pointer-events-none fixed top-[var(--workspace-controls-top)] left-[var(--workspace-controls-left)] z-50 hidden h-[var(--workspace-topbar-height)] items-center md:flex"
      data-sidebar-control=""
    >
      <SidebarTrigger
        aria-label="Toggle main sidebar"
        className="pointer-events-auto text-muted-foreground/60 hover:text-foreground"
      />
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const appSettings = useSettings();
  const sidebarStyle = {
    "--sidebar-width": THREAD_SIDEBAR_DEFAULT_WIDTH,
    ...(isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
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

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
        return;
      }

      if (action === "new-thread") {
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    activeDraftThread,
    activeThread,
    appSettings.defaultThreadEnvMode,
    defaultProjectRef,
    handleNewThread,
    navigate,
  ]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarStyle}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-rail text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
