"use client";

import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { CommandDialog } from "./ui/command";

const loadCommandPaletteDialog = () => import("./CommandPaletteDialog");

const OpenCommandPaletteDialog = lazy(() =>
  loadCommandPaletteDialog().then((module) => ({ default: module.OpenCommandPaletteDialog })),
);

/**
 * Fetches the palette's body ahead of its first use. The app calls this once
 * the first paint is done, so the first shortcut press opens it at once while
 * startup never waits for its code.
 */
export function preloadCommandPaletteDialog(): void {
  void loadCommandPaletteDialog().catch(() => undefined);
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useServerKeybindings();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  // The store outlives this tree, so a palette left open when the shell goes
  // away (auth gate, pairing route, a test harness unmounting) must not greet
  // the next mount already open. This wrapper mounts once with the shell, so
  // its cleanup is the real teardown -- unlike the open dialog's, which
  // StrictMode also runs right after mount.
  useEffect(() => {
    return () => {
      if (useCommandPaletteStore.getState().open) {
        setOpen(false);
      }
    };
  }, [setOpen]);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {children}
        <CommandPaletteDialog />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog() {
  const open = useCommandPaletteStore((store) => store.open);

  if (!open) {
    return null;
  }

  // Normally preloaded already; until it arrives the palette stays closed.
  return (
    <Suspense fallback={null}>
      <OpenCommandPaletteDialog />
    </Suspense>
  );
}
