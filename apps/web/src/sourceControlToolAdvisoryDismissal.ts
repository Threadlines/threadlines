import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";

export const SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEY =
  "threadlines:source-control-tool-advisory-dismissals:v1";
const LEGACY_SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEYS = [] as const;

const SourceControlToolAdvisoryDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type SourceControlToolAdvisoryDismissals = typeof SourceControlToolAdvisoryDismissalsSchema.Type;

function readDismissals(): SourceControlToolAdvisoryDismissals {
  try {
    return (
      getLocalStorageItemWithLegacyKeys(
        SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEY,
        LEGACY_SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEYS,
        SourceControlToolAdvisoryDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch {
    return { keys: [] };
  }
}

function writeDismissals(document: SourceControlToolAdvisoryDismissals): void {
  try {
    setLocalStorageItem(
      SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEY,
      document,
      SourceControlToolAdvisoryDismissalsSchema,
    );
  } catch {
    // Best-effort UI state; storage failure should not block advisory display.
  }
}

export function sourceControlToolAdvisoryDismissalKey(input: {
  readonly environmentKey: string;
  readonly notificationKey: string | null | undefined;
}): string | null {
  const notificationKey = input.notificationKey?.trim();
  const environmentKey = input.environmentKey.trim();
  if (!notificationKey || !environmentKey) {
    return null;
  }
  return `${environmentKey}:${notificationKey}`;
}

export function isSourceControlToolAdvisoryDismissed(
  dismissalKey: string | null | undefined,
): boolean {
  if (!dismissalKey) return false;
  return readDismissals().keys.includes(dismissalKey);
}

export function dismissSourceControlToolAdvisory(dismissalKey: string | null | undefined): void {
  const trimmedKey = dismissalKey?.trim();
  if (!trimmedKey) return;
  const document = readDismissals();
  if (document.keys.includes(trimmedKey)) return;
  writeDismissals({ keys: [...document.keys, trimmedKey] });
}

export function useDismissedSourceControlToolAdvisoryKeys() {
  const [dismissals, setDismissals] = useLocalStorage(
    SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    SourceControlToolAdvisoryDismissalsSchema,
    { legacyKeys: LEGACY_SOURCE_CONTROL_TOOL_ADVISORY_DISMISSALS_STORAGE_KEYS },
  );
  const dismissedKeys = dismissals.keys;
  const dismissedKeySet = useMemo(() => new Set(dismissedKeys), [dismissedKeys]);

  const dismissNotificationKeys = useCallback(
    (keys: ReadonlyArray<string | null | undefined>) => {
      const newKeys = keys
        .map((key) => key?.trim())
        .filter(
          (key): key is string => key !== undefined && key.length > 0 && !dismissedKeySet.has(key),
        );
      if (newKeys.length === 0) {
        return;
      }
      setDismissals({ keys: [...new Set([...dismissedKeys, ...newKeys])] });
    },
    [dismissedKeySet, dismissedKeys, setDismissals],
  );

  const dismissNotificationKey = useCallback(
    (key: string | null | undefined) => dismissNotificationKeys([key]),
    [dismissNotificationKeys],
  );

  return {
    dismissedNotificationKeys: dismissedKeySet,
    dismissNotificationKey,
    dismissNotificationKeys,
  };
}
