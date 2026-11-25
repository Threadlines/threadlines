"use client";

import { useParams } from "@tanstack/react-router";
import { lazy, Profiler, Suspense, useEffect, useRef, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { isPaletteLaunchedDialogOpen } from "../commands/shortcutBlock";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { AddProjectDialog } from "./addProject/AddProjectDialog";
import { CodexSessionImportDialog } from "./codexImport/CodexSessionImportDialog";
import { CommandDialog } from "./ui/commandDialog";

const loadCommandPaletteDialog = () => import("./CommandPaletteDialog");

const OpenCommandPaletteDialog = lazy(() =>
  loadCommandPaletteDialog().then((module) => ({ default: module.OpenCommandPaletteDialog })),
);
const PaletteInboxCommandSource = lazy(() =>
  loadCommandPaletteDialog().then((module) => ({ default: module.PaletteInboxCommandSource })),
);

/**
 * Fetches the palette's body ahead of its first use. The app calls this once
 * the first paint is done, so the first shortcut press opens it at once while
 * startup never waits for its code.
 */
export function preloadCommandPaletteDialog(): void {
  void loadCommandPaletteDialog().catch(() => undefined);
}

type PaletteCommitListener = (phase: "mount" | "update" | "nested-update") => void;
let paletteCommitListener: PaletteCommitListener | null = null;

/**
 * Tests only: hears every React commit inside the open palette, so a test can
 * check that a streaming reply behind it commits nothing there. Counted with a
 * Profiler, since frame sampling can't see commits.
 */
export function setCommandPaletteCommitListenerForTests(
  listener: PaletteCommitListener | null,
): void {
  paletteCommitListener = listener;
}

function reportPaletteCommit(_id: string, phase: "mount" | "update" | "nested-update"): void {
  paletteCommitListener?.(phase);
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
      // Never over Add project or a Codex import: they own the keyboard.
      if (isPaletteLaunchedDialogOpen()) return;
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
      {/* Siblings, not children, of the palette's dialog: the palette hands
          over to them and closes, so they must not count as nested in it. */}
      <AddProjectDialog />
      <CodexSessionImportDialog />
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
      <Profiler id="command-palette" onRender={reportPaletteCommit}>
        <OpenCommandPaletteDialog />
      </Profiler>
      {/* Outside the Profiler on purpose: its rule reads the inbox, which
          re-derives on every streamed token (see PaletteInboxCommandSource). */}
      <PaletteInboxCommandSource />
    </Suspense>
  );
}
