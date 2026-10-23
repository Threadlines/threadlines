import { useEffect, useSyncExternalStore, type ComponentPropsWithRef } from "react";

/**
 * Notices sit below the app's overlay layer so a menu that opens into their
 * corner keeps its clicks. A dimmed backdrop is different: the user is in a
 * dialog or a sheet, and a notice raised then (a failed save, a bad path typed
 * into the command palette) has to stay readable and clickable above it.
 *
 * Every backdrop wrapper in `components/ui` renders through `CoveringBackdrop`,
 * which counts itself while open; the notice viewport rises while the count is
 * above zero. Clicking a raised notice doesn't close the dialog: a modal only
 * closes on a press that lands on its own backdrop.
 */
let openBackdropCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changeOpenBackdropCount(delta: number) {
  openBackdropCount += delta;
  for (const listener of listeners) listener();
}

/** True while any dialog, sheet or drawer backdrop is open. */
export function useNoticesRaisedAboveBackdrops(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openBackdropCount > 0,
    () => false,
  );
}

/**
 * The element a backdrop renders, for its `render` prop:
 * `render={(props, state) => <CoveringBackdrop {...props} open={state.open} />}`.
 */
export function CoveringBackdrop({
  open,
  ...props
}: ComponentPropsWithRef<"div"> & { open: boolean }) {
  useEffect(() => {
    if (!open) return;
    changeOpenBackdropCount(1);
    return () => changeOpenBackdropCount(-1);
  }, [open]);
  return <div {...props} />;
}
