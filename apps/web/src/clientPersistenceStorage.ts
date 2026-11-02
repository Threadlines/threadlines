import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type ClientSettings,
  type ClientSettingsPatch,
  type EnvironmentId as EnvironmentIdValue,
  PersistedRelayLinkV1Schema,
  PersistedRelayLinkV2Schema,
  type PersistedSavedEnvironmentRecord,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItemWithLegacyKeys, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "threadlines:client-settings:v1";
export const LEGACY_CLIENT_SETTINGS_STORAGE_KEYS = ["t3code:client-settings:v1"] as const;
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "threadlines:saved-environment-registry:v1";
export const LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEYS = [
  "t3code:saved-environment-registry:v1",
] as const;

const BrowserSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(
    Schema.Struct({
      alias: Schema.String,
      hostname: Schema.String,
      username: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Schema.Number),
    }),
  ),
  relay: Schema.optionalKey(Schema.Union([PersistedRelayLinkV2Schema, PersistedRelayLinkV1Schema])),
  bearerToken: Schema.optionalKey(Schema.String),
});
type BrowserSavedEnvironmentRecord = typeof BrowserSavedEnvironmentRecordSchema.Type;

const BrowserSavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(BrowserSavedEnvironmentRecordSchema)),
});
type BrowserSavedEnvironmentRegistryDocument =
  typeof BrowserSavedEnvironmentRegistryDocumentSchema.Type;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return {
    ...nextRecord,
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
    ...(record.relay ? { relay: record.relay } : {}),
  };
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return getLocalStorageItemWithLegacyKeys(
      CLIENT_SETTINGS_STORAGE_KEY,
      LEGACY_CLIENT_SETTINGS_STORAGE_KEYS,
      ClientSettingsSchema,
    );
  } catch {
    return null;
  }
}

function mergeBrowserClientSettings(patch: ClientSettingsPatch): ClientSettings {
  const settings: ClientSettings = {
    ...(readBrowserClientSettings() ?? DEFAULT_CLIENT_SETTINGS),
    ...patch,
  };
  if (hasWindow()) {
    setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
  }
  return settings;
}

/**
 * Stores the patch over what this browser holds now and returns the result, so
 * a tab only ever changes the settings it names. Tabs can run at once and
 * localStorage has no transactions, so the read and write hold the browser's
 * cross-tab lock. Without one (Web Locks needs a secure address) it runs as is,
 * and only two tabs saving within the same moment could lose a change.
 */
export function updateBrowserClientSettings(patch: ClientSettingsPatch): Promise<ClientSettings> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks === undefined
    ? Promise.resolve().then(() => mergeBrowserClientSettings(patch))
    : locks.request(CLIENT_SETTINGS_STORAGE_KEY, () => mergeBrowserClientSettings(patch));
}

/**
 * Calls the listener with the stored settings when another tab has changed them.
 * Phones freeze background tabs, and a frozen tab can miss the storage event, so
 * a tab also looks again when it comes back into view.
 */
export function subscribeBrowserClientSettings(
  listener: (settings: ClientSettings) => void,
): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }

  const lookAgain = () => {
    const settings = readBrowserClientSettings();
    if (settings) listener(settings);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLIENT_SETTINGS_STORAGE_KEY) lookAgain();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) lookAgain();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") lookAgain();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

function readBrowserSavedEnvironmentRegistryDocument(): BrowserSavedEnvironmentRegistryDocument {
  if (!hasWindow()) {
    return {};
  }

  try {
    const parsed = getLocalStorageItemWithLegacyKeys(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEYS,
      BrowserSavedEnvironmentRegistryDocumentSchema,
    );
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeBrowserSavedEnvironmentRegistryDocument(
  document: BrowserSavedEnvironmentRegistryDocument,
): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(
    SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
    document,
    BrowserSavedEnvironmentRegistryDocumentSchema,
  );
}

function readBrowserSavedEnvironmentRecordsWithSecrets(): ReadonlyArray<BrowserSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRegistryDocument().records ?? [];
}

function writeBrowserSavedEnvironmentRecords(
  records: ReadonlyArray<BrowserSavedEnvironmentRecord>,
): void {
  writeBrowserSavedEnvironmentRegistryDocument({
    version: 1,
    records,
  });
}

export function readBrowserSavedEnvironmentRegistry(): ReadonlyArray<PersistedSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRecordsWithSecrets().map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeBrowserSavedEnvironmentRegistry(
  records: ReadonlyArray<PersistedSavedEnvironmentRecord>,
): void {
  const existing = new Map(
    readBrowserSavedEnvironmentRecordsWithSecrets().map(
      (record) => [record.environmentId, record] as const,
    ),
  );
  writeBrowserSavedEnvironmentRecords(
    records.map((record) => {
      const bearerToken = existing.get(record.environmentId)?.bearerToken;
      return bearerToken
        ? {
            environmentId: record.environmentId,
            label: record.label,
            httpBaseUrl: record.httpBaseUrl,
            wsBaseUrl: record.wsBaseUrl,
            createdAt: record.createdAt,
            lastConnectedAt: record.lastConnectedAt,
            ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
            ...(record.relay ? { relay: record.relay } : {}),
            bearerToken,
          }
        : toPersistedSavedEnvironmentRecord(record);
    }),
  );
}

export function readBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
): string | null {
  return (
    readBrowserSavedEnvironmentRecordsWithSecrets().find(
      (record) => record.environmentId === environmentId,
    )?.bearerToken ?? null
  );
}

export function writeBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
  secret: string,
): boolean {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const records = document.records ?? [];
  let found = false;
  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    records: records.map((record) => {
      if (record.environmentId !== environmentId) {
        return record;
      }
      found = true;
      const nextRecord = {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
        bearerToken: secret,
      };
      if (record.desktopSsh) {
        Object.assign(nextRecord, { desktopSsh: record.desktopSsh });
      }
      if (record.relay) {
        Object.assign(nextRecord, { relay: record.relay });
      }
      return nextRecord;
    }),
  });
  return found;
}

export function removeBrowserSavedEnvironmentSecret(environmentId: EnvironmentIdValue): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    records: (document.records ?? []).map((record) => {
      if (record.environmentId !== environmentId) {
        return record;
      }
      return toPersistedSavedEnvironmentRecord(record);
    }),
  });
}
