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
   * now. `stored` is read once another tab has written the key since this tab
   * loaded it (this tab's copy of the rest may be stale from then on); before
   * that it is null and `next` can go as is.
   */
  readonly mergeWithStored: (
    next: StorageValue<S>,
    stored: StorageValue<S> | null,
  ) => StorageValue<S>;
  /** The write landed: whatever the store tracks since its last write starts over. */
  readonly onWritten: () => void;
}

/** A random id for this tab's writes, so it can tell another tab's apart. */
const tabWriterId = (() => {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") || "tab";
})();

/**
 * A zustand persist storage that serializes and writes at most once per
 * `debounceMs`. Use it in place of `createJSONStorage` for stores that change
 * on every keystroke: that helper runs `JSON.stringify` on every state change
 * before its storage sees the value, so debouncing only the write still pays
 * for serializing the whole persisted state, pasted images included, per key.
 *
 * With `merge`, every write also leaves a small stamp (`<key>:writer`) saying
 * which tab wrote last. Before each write the tab reads that stamp (a few
 * bytes); once it is another tab's, this tab's copy may be stale, and from
 * then on every write reads storage first and lets the store keep the other
 * tab's changes. With one tab open nothing large is read.
 */
export function createDebouncedJSONStorage<S>(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
  merge?: StoredValueMerge<S>,
): DebouncedPersistStorage<S> {
  const resolvedStorage = resolveStorage(baseStorage);
  const stampKey = (name: string) => `${name}:writer`;
  const readStamp = (name: string): string | null => {
    try {
      const stamp = resolvedStorage.getItem(stampKey(name));
      return typeof stamp === "string" ? stamp : null;
    } catch {
      return null;
    }
  };
  // The stamp this tab last saw or wrote, per key: storage matched this tab then.
  const knownStamps = new Map<string, string | null>();
  // Keys another tab wrote after this tab loaded them: every later write merges.
  const sharedKeys = new Set<string>();
  let writes = 0;
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
      if (knownStamps.has(name) && readStamp(name) !== knownStamps.get(name)) {
        sharedKeys.add(name);
      }
      const stored = sharedKeys.has(name) ? readStored(name) : null;
      resolvedStorage.setItem(name, JSON.stringify(merge.mergeWithStored(value, stored)));
      const stamp = `${tabWriterId}:${++writes}`;
      try {
        resolvedStorage.setItem(stampKey(name), stamp);
      } catch {
        // The stamp is small; if even it can't be written, the next write merges.
      }
      knownStamps.set(name, stamp);
      merge.onWritten();
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => {
      // What this tab loads is what storage holds: in step with the last writer.
      if (merge) knownStamps.set(name, readStamp(name));
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
