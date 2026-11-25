import { useEffect, useSyncExternalStore } from "react";

type VscodeIconsModule = typeof import("../vscode-icons");

let loadedVscodeIcons: VscodeIconsModule | null = null;
let pendingVscodeIcons: Promise<VscodeIconsModule> | null = null;
let waitingForOnlineRetry = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): VscodeIconsModule | null {
  return loadedVscodeIcons;
}

function scheduleOnlineRetry(): void {
  if (waitingForOnlineRetry || typeof window === "undefined") {
    return;
  }
  waitingForOnlineRetry = true;
  window.addEventListener(
    "online",
    () => {
      waitingForOnlineRetry = false;
      if (loadedVscodeIcons === null && listeners.size > 0) {
        void loadVscodeIcons().catch(() => {
          // Keep generic file/folder fallback until another retry succeeds.
        });
      }
    },
    { once: true },
  );
}

function loadVscodeIcons(): Promise<VscodeIconsModule> {
  if (loadedVscodeIcons !== null) {
    return Promise.resolve(loadedVscodeIcons);
  }
  if (pendingVscodeIcons === null) {
    pendingVscodeIcons = import("../vscode-icons")
      .then((mod) => {
        loadedVscodeIcons = mod;
        pendingVscodeIcons = null;
        for (const listener of listeners) {
          listener();
        }
        return mod;
      })
      .catch((error: unknown) => {
        pendingVscodeIcons = null;
        scheduleOnlineRetry();
        throw error;
      });
  }
  return pendingVscodeIcons;
}

/**
 * Resolves a VS Code file/folder icon URL on demand so the 329 KB manifest
 * stays out of the initial chat bundle. Returns null while the manifest chunk
 * loads; callers render the generic file/folder icon until it resolves.
 */
export function useVscodeIconUrl(
  pathValue: string,
  kind: "file" | "directory",
  theme: "light" | "dark",
): string | null {
  const mod = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (mod !== null) {
      return;
    }
    void loadVscodeIcons().catch(() => {
      // Keep generic file/folder fallback if the icon manifest chunk fails to load.
    });
  }, [mod]);

  return mod ? mod.getVscodeIconUrlForEntry(pathValue, kind, theme) : null;
}
