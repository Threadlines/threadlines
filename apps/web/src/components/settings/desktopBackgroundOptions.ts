import type {
  DesktopBackgroundOptions,
  DesktopBackgroundOptionsPatch,
} from "@threadlines/contracts";
import { useEffect, useSyncExternalStore } from "react";

/**
 * The desktop app's background-running options (Settings › General › This
 * computer), shared by every row that shows them: the page and a settings
 * search can draw the same switch at once, and both must show what it is now.
 * Loaded from the desktop app whenever something starts showing them; null
 * until then, and always in a browser or a desktop app that predates them.
 */
let current: DesktopBackgroundOptions | null = null;
const listeners = new Set<() => void>();

const publish = (next: DesktopBackgroundOptions) => {
  current = next;
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => current;

/** Whether this desktop app can change them at all. */
export const canSetDesktopBackgroundOptions = (): boolean =>
  typeof window !== "undefined" && typeof window.desktopBridge?.setBackgroundOptions === "function";

let loading: Promise<void> | null = null;

/** Reads them again from the desktop app; one read at a time. */
function refresh(): void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge?.getBackgroundOptions === undefined || loading !== null) return;
  loading = bridge
    .getBackgroundOptions()
    .then(publish, () => undefined)
    .finally(() => {
      loading = null;
    });
}

export function useDesktopBackgroundOptions(): DesktopBackgroundOptions | null {
  // Each screen that starts showing them reads them fresh: the tray can change them too.
  useEffect(refresh, []);
  return useSyncExternalStore(subscribe, read, read);
}

/** Saves a change and shows the desktop app's answer everywhere; rejects when it fails. */
export async function setDesktopBackgroundOptions(
  patch: DesktopBackgroundOptionsPatch,
): Promise<void> {
  const bridge = window.desktopBridge;
  if (bridge?.setBackgroundOptions === undefined) return;
  publish(await bridge.setBackgroundOptions(patch));
}
