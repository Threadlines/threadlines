"use client";

import { lazy, Suspense, useEffect } from "react";

import { CommandDialog } from "../ui/commandDialog";
import { useAddProjectStore } from "./addProjectStore";

const OpenAddProjectDialog = lazy(() =>
  import("./OpenAddProjectDialog").then((module) => ({ default: module.OpenAddProjectDialog })),
);

/**
 * The Add project dialog. It loads at startup but its body only on first
 * open, and it mounts the body once per session, so nothing from one opening
 * (a step, a half-typed path) carries into the next.
 */
export function AddProjectDialog() {
  const session = useAddProjectStore((store) => store.session);
  const close = useAddProjectStore((store) => store.close);

  // The store outlives this tree: a dialog left open when the shell goes away
  // must not greet the next mount already open.
  useEffect(() => {
    return () => {
      if (useAddProjectStore.getState().session !== null) {
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
          <OpenAddProjectDialog key={session.id} session={session} />
        </Suspense>
      ) : null}
    </CommandDialog>
  );
}
