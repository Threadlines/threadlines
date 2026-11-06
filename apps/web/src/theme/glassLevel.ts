/**
 * The Glass level the app shows (docs/design/custom-themes.md, "Glass in the
 * app"): a Glass slider being dragged, else the saved setting. Dragging
 * moves the glass live; the setting is saved once, when the drag ends.
 */
import { themeGlassLevel } from "@threadlines/shared/themeGlassLevel";
import { useSyncExternalStore } from "react";

import { useSettings } from "../hooks/useSettings";

let dragging: number | null = null;
/** The slider whose drag the preview is, so another can't end it. */
let owner: symbol | null = null;
const listeners = new Set<() => void>();

function publish(level: number | null) {
  if (dragging === level) return;
  dragging = level;
  for (const listener of listeners) listener();
}

/** The level the slider `by` is being dragged to. */
export function setGlassLevelPreview(by: symbol, level: number): void {
  owner = by;
  publish(level);
}

/** The slider `by` let go (or went away): the glass shows the saved level, unless another slider holds it now. */
export function clearGlassLevelPreview(by: symbol): void {
  if (owner !== by) return;
  owner = null;
  publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The saved Glass level, 0 to 100. */
export function useSavedGlassLevel(): number {
  return useSettings((settings) => themeGlassLevel(settings));
}

/** The Glass level to show, 0 to 100: a drag in progress, else the saved one. */
export function useGlassLevel(): number {
  const saved = useSavedGlassLevel();
  const preview = useSyncExternalStore(subscribe, () => dragging);
  return preview ?? saved;
}
