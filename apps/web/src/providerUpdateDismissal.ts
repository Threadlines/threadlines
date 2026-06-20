import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";

export const PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY = "threadlines:provider-update-dismissals:v1";
const LEGACY_PROVIDER_UPDATE_DISMISSALS_STORAGE_KEYS = [
  "t3code:provider-update-dismissals:v1",
] as const;

const ProviderUpdateDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type ProviderUpdateDismissals = typeof ProviderUpdateDismissalsSchema.Type;

function readProviderUpdateDismissals(): ProviderUpdateDismissals {
  try {
    return (
      getLocalStorageItemWithLegacyKeys(
        PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
        LEGACY_PROVIDER_UPDATE_DISMISSALS_STORAGE_KEYS,
        ProviderUpdateDismissalsSchema,
      ) ?? {
        keys: [],
      }
    );
  } catch {
    return { keys: [] };
  }
}

function writeProviderUpdateDismissals(document: ProviderUpdateDismissals): void {
  try {
    setLocalStorageItem(
      PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
      document,
      ProviderUpdateDismissalsSchema,
    );
  } catch {
    // Dismissal state is best-effort UI state; a storage failure should not block the toast.
  }
}

export function isProviderUpdateNotificationDismissed(
  dismissalKey: string | null | undefined,
): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readProviderUpdateDismissals().keys.includes(dismissalKey);
}

export function dismissProviderUpdateNotification(dismissalKey: string | null | undefined): void {
  const trimmedKey = dismissalKey?.trim();
  if (!trimmedKey) {
    return;
  }
  const document = readProviderUpdateDismissals();
  if (document.keys.includes(trimmedKey)) {
    return;
  }
  writeProviderUpdateDismissals({
    keys: [...document.keys, trimmedKey],
  });
}

export function useDismissedProviderUpdateNotificationKeys() {
  const [dismissals, setDismissals] = useLocalStorage(
    PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    ProviderUpdateDismissalsSchema,
    { legacyKeys: LEGACY_PROVIDER_UPDATE_DISMISSALS_STORAGE_KEYS },
  );
  const dismissedKeys = dismissals.keys;

  const dismissedKeySet = useMemo(() => new Set(dismissedKeys), [dismissedKeys]);

  const dismissNotificationKey = useCallback(
    (key: string) => {
      const trimmedKey = key.trim();
      if (trimmedKey.length === 0 || dismissedKeySet.has(trimmedKey)) {
        return;
      }

      setDismissals({
        keys: [...dismissedKeys, trimmedKey],
      });
    },
    [dismissedKeySet, dismissedKeys, setDismissals],
  );

  return {
    dismissedNotificationKeys: dismissedKeySet,
    dismissNotificationKey,
  };
}
