/**
 * Theme content kept on this device by hash (docs/design/custom-themes.md,
 * "No flash"): the active theme and the last few used, in IndexedDB, so a
 * device paints its theme with no server connected. Content never changes
 * for a hash, so a cached copy is always right. Every failure reads as "not
 * cached"; the store then asks the theme's computer.
 */
import type { ThemeManifest } from "@threadlines/contracts";

const DATABASE_NAME = "threadlines-themes";
const STORE_NAME = "contents";
/** Kept besides the active theme. */
export const THEME_CACHE_RECENT_LIMIT = 5;

interface CachedThemeRecord {
  readonly hash: string;
  readonly manifest: ThemeManifest;
  readonly usedAt: number;
}

const memory = new Map<string, ThemeManifest>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: "hash" });
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => resolve(null));
      request.addEventListener("blocked", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
  });
}

/** The cached content for `hash`, or null. */
export async function readCachedTheme(hash: string): Promise<ThemeManifest | null> {
  const known = memory.get(hash);
  if (known) return known;
  const database = await openDatabase();
  if (!database) return null;
  try {
    const record = (await requestResult(
      database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(hash),
    )) as CachedThemeRecord | undefined | null;
    if (!record?.manifest) return null;
    memory.set(hash, record.manifest);
    return record.manifest;
  } catch {
    return null;
  }
}

/** The content for `hash` if this window already holds it. */
export function peekCachedTheme(hash: string): ThemeManifest | null {
  return memory.get(hash) ?? null;
}

/**
 * Keeps `manifest` under `hash` as the most recently used, then drops all but
 * the newest few; `keep` (the committed theme) is never dropped.
 */
export function rememberThemeContent(hash: string, manifest: ThemeManifest, keep?: string): void {
  memory.set(hash, manifest);
  void (async () => {
    const database = await openDatabase();
    if (!database) return;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const record: CachedThemeRecord = { hash, manifest, usedAt: Date.now() };
      store.put(record);
      const all = ((await requestResult(store.getAll())) ?? []) as CachedThemeRecord[];
      const stale = all
        .filter((entry) => entry.hash !== hash && entry.hash !== keep)
        .toSorted((first, second) => second.usedAt - first.usedAt)
        .slice(THEME_CACHE_RECENT_LIMIT);
      for (const entry of stale) {
        store.delete(entry.hash);
        memory.delete(entry.hash);
      }
    } catch {
      // A cache that can't write only costs a server read next time.
    }
  })();
}
