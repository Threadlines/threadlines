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
 * A zustand persist storage that serializes and writes at most once per
 * `debounceMs`. Use it in place of `createJSONStorage` for stores that change
 * on every keystroke: that helper runs `JSON.stringify` on every state change
 * before its storage sees the value, so debouncing only the write still pays
 * for serializing the whole persisted state, pasted images included, per key.
 */
export function createDebouncedJSONStorage<S>(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedPersistStorage<S> {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: StorageValue<S>) => {
      resolvedStorage.setItem(name, JSON.stringify(value));
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
