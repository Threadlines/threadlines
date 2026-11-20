import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export function withLegacyFallbackStorage<R = unknown>(
  baseStorage: StateStorage<R>,
  key: string,
  legacyKeys: readonly string[],
): StateStorage<R> {
  return {
    getItem: (name) => {
      const current = baseStorage.getItem(name);
      if (current instanceof Promise) {
        return current.then((value) => {
          if (value !== null || name !== key) return value;
          return readLegacyStorageValue(baseStorage, key, legacyKeys);
        });
      }
      if (current !== null || name !== key) return current;
      return readLegacyStorageValue(baseStorage, key, legacyKeys);
    },
    setItem: (name, value) => baseStorage.setItem(name, value),
    removeItem: (name) => baseStorage.removeItem(name),
  };
}

function readLegacyStorageValue<R>(
  storage: StateStorage<R>,
  key: string,
  legacyKeys: readonly string[],
): string | null | Promise<string | null> {
  for (const legacyKey of legacyKeys) {
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue instanceof Promise) {
      return legacyValue.then((resolvedLegacyValue) => {
        if (resolvedLegacyValue === null) return null;
        storage.setItem(key, resolvedLegacyValue);
        return resolvedLegacyValue;
      });
    }
    if (legacyValue === null) continue;
    storage.setItem(key, legacyValue);
    return legacyValue;
  }
  return null;
}

function parseStorageValue<S>(raw: string | null): StorageValue<S> | null {
  return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
}

/**
 * How a store shares its storage key with other tabs. Every tab holds the
 * whole persisted state and writes all of it, so without this a tab writes
 * its stale copy of what another tab changed. See `createDebouncedJSONStorage`.
 */
export interface StoredValueMerge<S> {
  /**
   * What to write, given what this tab wants stored and what storage holds
   * now. `stored` is read once another tab has written the key while this
   * tab was open (this tab's copy of the rest may be stale from then on);
   * before that it is null and `next` can go as is.
   */
  readonly mergeWithStored: (
    next: StorageValue<S>,
    stored: StorageValue<S> | null,
  ) => StorageValue<S>;
  /** The write landed: whatever the store tracks since its last write starts over. */
  readonly onWritten: () => void;
}

/**
 * A zustand persist storage that serializes and writes at most once per
 * `debounceMs`. Use it in place of `createJSONStorage` for stores that change
 * on every keystroke: that helper runs `JSON.stringify` on every state change
 * before its storage sees the value, so debouncing only the write still pays
 * for serializing the whole persisted state, pasted images included, per key.
 *
 * With `merge`, once another tab has written the same key (seen through the
 * window's `storage` event) every write reads storage first and lets the
 * store keep the other tab's changes; with one tab open nothing extra is read.
 */
export function createDebouncedJSONStorage<S>(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
  merge?: StoredValueMerge<S>,
): DebouncedPersistStorage<S> {
  const resolvedStorage = resolveStorage(baseStorage);
  // Keys another tab has written while this one was open: this tab's copy of
  // them may be stale from then on, so every later write merges.
  const sharedKeys = new Set<string>();
  if (merge && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key !== null) sharedKeys.add(event.key);
    });
  }
  const readStored = (name: string): StorageValue<S> | null => {
    try {
      const raw = resolvedStorage.getItem(name);
      return typeof raw === "string" ? parseStorageValue<S>(raw) : null;
    } catch {
      return null;
    }
  };
  const debouncedSetItem = new Debouncer(
    (name: string, value: StorageValue<S>) => {
      if (!merge) {
        resolvedStorage.setItem(name, JSON.stringify(value));
        return;
      }
      const stored = sharedKeys.has(name) ? readStored(name) : null;
      resolvedStorage.setItem(name, JSON.stringify(merge.mergeWithStored(value, stored)));
      merge.onWritten();
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => {
      const raw = resolvedStorage.getItem(name);
      return raw instanceof Promise
        ? raw.then((value) => parseStorageValue<S>(value))
        : parseStorageValue<S>(raw);
    },
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
