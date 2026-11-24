"use client";

import { lazy, Suspense, useEffect } from "react";

import { CommandDialog } from "../ui/command";
import { useCodexImportStore } from "./codexImportStore";

const OpenCodexSessionImportDialog = lazy(() =>
  import("./OpenCodexSessionImportDialog").then((module) => ({
    default: module.OpenCodexSessionImportDialog,
  })),
);

/**
 * The "Bring in Codex conversation" dialog. It loads at startup but its body
 * only on first open, and it mounts the body once per session.
 */
export function CodexSessionImportDialog() {
  const session = useCodexImportStore((store) => store.session);
  const close = useCodexImportStore((store) => store.close);

  // The store outlives this tree: a dialog left open when the shell goes away
  // must not greet the next mount already open.
  useEffect(() => {
    return () => {
      if (useCodexImportStore.getState().session !== null) {
        close();
      }
    };
  }, [close]);

  return (
    <CommandDialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {session ? (
        <Suspense fallback={null}>
          <OpenCodexSessionImportDialog key={session.id} session={session} />
        </Suspense>
      ) : null}
    </CommandDialog>
  );
}
