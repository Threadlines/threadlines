import { scopeThreadRef } from "@threadlines/client-runtime";
import { Outlet, createFileRoute, redirect, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { recordLastVisitedThreadRoute } from "../lastVisitedThreadRoute";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useStore } from "../store";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
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
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

/**
 * Remembers the thread or draft on screen so the next launch can reopen it.
 *
 * Sits on the chat layout rather than in each route because both chat routes
 * count and the record has to look the same either way; a draft carries its
 * environment on the draft session instead of in the URL.
 */
function LastVisitedThreadRouteRecorder() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // Kept as primitives: this component sits above the composer, so anything
  // that changes identity per render would rewrite storage on every keystroke.
  const routeThreadEnvironmentId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null;
  const routeThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const draftEnvironmentId = useComposerDraftStore((store) =>
    routeDraftId ? (store.getDraftSession(routeDraftId)?.environmentId ?? null) : null,
  );
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);

  useEffect(() => {
    if (routeThreadEnvironmentId && routeThreadId) {
      recordLastVisitedThreadRoute(routeThreadEnvironmentId, {
        kind: "server",
        threadRef: scopeThreadRef(routeThreadEnvironmentId, routeThreadId),
      });
      return;
    }
    if (routeDraftId) {
      recordLastVisitedThreadRoute(draftEnvironmentId ?? activeEnvironmentId, {
        kind: "draft",
        draftId: routeDraftId,
      });
    }
  }, [
    activeEnvironmentId,
    draftEnvironmentId,
    routeDraftId,
    routeThreadEnvironmentId,
    routeThreadId,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <LastVisitedThreadRouteRecorder />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
