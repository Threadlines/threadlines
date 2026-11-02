/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ServerSettings, type ServerSettingsPatch } from "@threadlines/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  UnifiedSettings,
} from "@threadlines/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import * as Equal from "effect/Equal";
import * as Struct from "effect/Struct";
import { applyServerSettingsPatch } from "@threadlines/shared/serverSettings";
import { applySettingsUpdated, getServerConfig, useServerSettings } from "~/rpc/serverState";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const { persistence } = ensureLocalApi();
      // Before the read, so a change made while it runs isn't missed.
      stopFollowingStoredClientSettings ??=
        persistence.subscribeClientSettings(takeStoredClientSettings);
      const persistedSettings = await persistence.getClientSettings();
      if (persistedSettings) {
        takeStoredClientSettings(persistedSettings);
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, error);
    } finally {
      setClientSettingsHydrated(true);
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

/** The save in flight, so the next one starts only after it. */
let clientSettingsSaveChain: Promise<void> = Promise.resolve();
/**
 * The settings as storage last gave them, with every window's changes in them:
 * what a failed write's setting goes back to.
 */
let savedClientSettings = DEFAULT_CLIENT_SETTINGS;
/** Numbers writes in the order they were made, and which one last set each setting. */
let clientSettingsWriteCount = 0;
const clientSettingsLastWrite = new Map<keyof ClientSettings, number>();
/**
 * The settings changed here since a save last stored them. The next save carries
 * them, a failed save's included, and a change from another window leaves them be.
 */
const unsavedClientSettings = new Set<keyof ClientSettings>();
let stopFollowingStoredClientSettings: (() => void) | null = null;

/**
 * Takes in the settings as storage holds them: this window's copy follows for
 * every setting it has no unsaved write for. A value that already matches keeps
 * its object, so nothing re-renders for a change that changes nothing here.
 */
function takeStoredClientSettings(stored: ClientSettings): void {
  savedClientSettings = stored;
  const current = getClientSettingsSnapshot();
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(stored) as Array<keyof ClientSettings>) {
    if (!unsavedClientSettings.has(key) && !Equal.equals(current[key], stored[key])) {
      changes[key] = stored[key];
    }
  }
  if (Object.keys(changes).length > 0) {
    replaceClientSettingsSnapshot({ ...current, ...changes });
  }
}

/**
 * Saves what changed here, after every save before it. Saves land in order, and
 * each carries every setting changed since the last one that stored it, at its
 * value when the save runs, so nothing is dropped and an older value never lands
 * over a newer one. Settings it doesn't name stay as storage has them, so a stale
 * copy here can't overwrite another window's change.
 */
function saveClientSettingsInOrder(): Promise<void> {
  const { persistence } = ensureLocalApi();
  const save = clientSettingsSaveChain.then(async () => {
    if (unsavedClientSettings.size === 0) return;
    const savedThroughWrite = clientSettingsWriteCount;
    const settings = getClientSettingsSnapshot();
    const keys = [...unsavedClientSettings];
    const patch = Object.fromEntries(keys.map((key) => [key, settings[key]]));
    savedClientSettings = await persistence.updateClientSettings(patch as ClientSettingsPatch);
    for (const key of keys) {
      if ((clientSettingsLastWrite.get(key) ?? 0) <= savedThroughWrite) {
        unsavedClientSettings.delete(key);
      }
    }
  });
  clientSettingsSaveChain = save.catch(() => undefined);
  return save;
}

/** Changes memory at once, so the last write made is the one that stands. Returns its number. */
function applyClientPatch(patch: ClientSettingsPatch): number {
  clientSettingsWriteCount += 1;
  for (const key of Object.keys(patch) as Array<keyof ClientSettings>) {
    clientSettingsLastWrite.set(key, clientSettingsWriteCount);
    unsavedClientSettings.add(key);
  }
  replaceClientSettingsSnapshot({ ...getClientSettingsSnapshot(), ...patch });
  return clientSettingsWriteCount;
}

function persistClientPatch(patch: ClientSettingsPatch): void {
  applyClientPatch(patch);
  void saveClientSettingsInOrder().catch((error) => {
    console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, error);
  });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const serverSettings = useServerSettings();
  const clientSettings = useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );

  const merged = useMemo<UnifiedSettings>(
    () => ({
      ...serverSettings,
      ...clientSettings,
    }),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

/**
 * Routes each key of a patch to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 *
 * A plain function rather than a hook body so imperative code paths -- a click
 * handler that writes an approval on its way to somewhere else -- can settle a
 * setting without first being a component.
 */
export function updateSettings(patch: Partial<UnifiedSettings>): void {
  // Fire-and-forget: the server's push reconciles on success.
  void writeSettings(patch);
}

/**
 * `updateSettings` for callers whose next step needs the server to have the
 * change: it resolves once the server stored it, and rejects if it refused.
 * Setup waits on this before installing an agent it just turned on.
 */
export function updateSettingsAndPersist(patch: Partial<UnifiedSettings>): Promise<void> {
  return writeSettings(patch);
}

/**
 * Writes this device's settings and resolves only once they are saved,
 * rejecting when the save fails, where `updateSettings` only logs it. For
 * callers that must say truthfully whether a change landed: an agent's
 * settings change reports each device setting it made. Waits for the saved
 * settings to load before saving.
 *
 * A failed save puts back only the settings no later write has set, to what
 * was last stored, before the next save runs. Those match storage again, so no
 * save owes them; the rest stay owed and the next save carries them.
 */
export async function updateClientSettingsAndPersist(patch: ClientSettingsPatch): Promise<void> {
  // At once, so a write made right after this one follows it. Loading the saved
  // settings can't undo it, and a failed save needs them to go back to.
  const write = applyClientPatch(patch);
  try {
    await hydrateClientSettings();
    await saveClientSettingsInOrder();
  } catch (error) {
    const restored: Record<string, unknown> = { ...getClientSettingsSnapshot() };
    for (const key of Object.keys(patch) as Array<keyof ClientSettings>) {
      if (clientSettingsLastWrite.get(key) === write) {
        restored[key] = savedClientSettings[key];
        unsavedClientSettings.delete(key);
      }
    }
    replaceClientSettingsSnapshot(restored as ClientSettings);
    throw error;
  }
}

function writeSettings(patch: Partial<UnifiedSettings>): Promise<void> {
  const { serverPatch, clientPatch } = splitPatch(patch);
  let serverWrite: Promise<unknown> = Promise.resolve();

  if (Object.keys(serverPatch).length > 0) {
    const currentServerConfig = getServerConfig();
    if (currentServerConfig) {
      applySettingsUpdated(applyServerSettingsPatch(currentServerConfig.settings, serverPatch));
    }
    serverWrite = ensureLocalApi().server.updateSettings(serverPatch);
  }

  if (Object.keys(clientPatch).length > 0) {
    persistClientPatch(clientPatch);
  }

  return serverWrite.then(() => undefined);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 */
export function useUpdateSettings() {
  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_UNIFIED_SETTINGS);
  }, []);

  return {
    updateSettings,
    resetSettings,
  };
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsSaveChain = Promise.resolve();
  savedClientSettings = DEFAULT_CLIENT_SETTINGS;
  clientSettingsWriteCount = 0;
  clientSettingsLastWrite.clear();
  unsavedClientSettings.clear();
  stopFollowingStoredClientSettings?.();
  stopFollowingStoredClientSettings = null;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}
