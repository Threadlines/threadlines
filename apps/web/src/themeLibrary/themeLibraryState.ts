/**
 * The theme library across computers (docs/design/custom-themes.md, "Storage
 * and devices"). Each computer's server keeps entries; this follows every
 * connected computer whose server reports `themes`, shows their union (one
 * row per entry, the winning copy by revision order), and keeps the computers
 * in step: whenever two followed computers disagree about an entry, the
 * winning copy is merged into the other, content included when it lacks it.
 * A change goes to one computer and spreads from there. The shared theme
 * pick ("Same theme on all my devices", themePickSync.ts) rides along: the
 * winning pick is merged into computers holding an older one, with its
 * theme's content when they lack it.
 *
 * One subscription per computer, mounted once at the root (ThemeLibrarySync).
 */
import type {
  EnvironmentId,
  ThemeContent,
  ThemeEntry,
  ThemeEntrySummary,
  ThemeLibrarySnapshot,
  ThemeManifest,
  ThemePick,
} from "@threadlines/contracts";
import {
  compareThemeRevisions,
  reconcileThemeLibraries,
  themeOfferKey,
  themeWithoutOffer,
  winningThemePick,
} from "@threadlines/shared/themeLibrary";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { type CapableEnvironment, capableEnvironmentsOf } from "../lib/capableEnvironments";
import type { WsRpcClient } from "../rpc/wsRpcClient";
import { startThemePickSync, useThemePickSyncSettings } from "./themePickSync";

interface ThemeLibraryState {
  /** Each computer's latest snapshot; absent until its first one arrives. */
  readonly byEnvironment: Readonly<Record<string, ThemeLibrarySnapshot>>;
  readonly put: (environmentId: EnvironmentId, snapshot: ThemeLibrarySnapshot) => void;
  readonly keepOnly: (environmentIds: ReadonlySet<string>) => void;
}

export const useThemeLibraryStore = create<ThemeLibraryState>()((set) => ({
  byEnvironment: {},
  put: (environmentId, snapshot) =>
    set((state) => ({ byEnvironment: { ...state.byEnvironment, [environmentId]: snapshot } })),
  keepOnly: (environmentIds) =>
    set((state) => {
      const kept = Object.fromEntries(
        Object.entries(state.byEnvironment).filter(([id]) => environmentIds.has(id)),
      );
      return Object.keys(kept).length === Object.keys(state.byEnvironment).length
        ? state
        : { byEnvironment: kept };
    }),
}));

/** The computers ThemeLibrarySync follows, this one first. */
let followedEnvironmentIds: EnvironmentId[] = [];

/** The computers whose servers keep a theme library, this one first. */
export function useThemeEnvironments(): readonly CapableEnvironment[] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(
    () =>
      capableEnvironmentsOf("themes", {
        primaryEnvironmentId,
        primaryDescriptor,
        runtimeById,
        savedLabelOf: (environmentId) => savedById[environmentId]?.label ?? null,
      }),
    [primaryDescriptor, primaryEnvironmentId, runtimeById, savedById],
  );
}

/** One entry as the app shows it: the winning copy, and where it can be read from. */
export interface LibraryTheme {
  readonly entry: ThemeEntrySummary;
  /** Computers holding the winning revision, the order of `environments` (this one first). */
  readonly holders: readonly EnvironmentId[];
}

/**
 * The union of the computers' libraries: one row per entry with its winning
 * copy, tombstones left out, by name.
 */
export function libraryThemesOf(
  byEnvironment: Readonly<Record<string, ThemeLibrarySnapshot>>,
  environments: readonly Pick<CapableEnvironment, "environmentId">[],
): LibraryTheme[] {
  const winners = new Map<string, { entry: ThemeEntrySummary; holders: EnvironmentId[] }>();
  for (const { environmentId } of environments) {
    for (const entry of byEnvironment[environmentId]?.entries ?? []) {
      const current = winners.get(entry.entryId);
      const order = current === undefined ? 1 : compareThemeRevisions(entry, current.entry);
      if (order > 0) winners.set(entry.entryId, { entry, holders: [environmentId] });
      else if (order === 0 && current !== undefined) {
        current.holders.push(environmentId);
        // An entry's offer never changes; a computer on an older build may just not know it.
        if (current.entry.offerKey == null && entry.offerKey != null) {
          current.entry = { ...current.entry, offerKey: entry.offerKey };
        }
      }
    }
  }
  return [...winners.values()]
    .filter(({ entry }) => !entry.deleted)
    .toSorted((first, second) => first.entry.name.localeCompare(second.entry.name));
}

/**
 * The kept copy a later version of an agent's offer would update: of the
 * entries kept from the same chat offer, the one changed last (revision order,
 * the same on every computer). Null when the theme is already kept as it is
 * (its hash), or no agent offered it, or none was kept.
 */
export function keptCopyOfOffer(
  library: ReadonlyArray<LibraryTheme>,
  manifest: ThemeManifest,
  hash: string,
): LibraryTheme | null {
  if (library.some((theme) => theme.entry.hash === hash)) return null;
  const key = themeOfferKey(manifest);
  if (key === null) return null;
  let newest: LibraryTheme | null = null;
  for (const theme of library) {
    if (theme.entry.offerKey !== key) continue;
    if (newest === null || compareThemeRevisions(theme.entry, newest.entry) > 0) newest = theme;
  }
  return newest;
}

/** The library as `useLibraryThemes` shows it, read once outside React. */
export function currentLibraryThemes(): LibraryTheme[] {
  return libraryThemesOf(
    useThemeLibraryStore.getState().byEnvironment,
    followedEnvironmentIds.map((environmentId) => ({ environmentId })),
  );
}

/** Every entry in the theme library, across computers. */
export function useLibraryThemes(): readonly LibraryTheme[] {
  const environments = useThemeEnvironments();
  const byEnvironment = useThemeLibraryStore((state) => state.byEnvironment);
  return useMemo(() => libraryThemesOf(byEnvironment, environments), [byEnvironment, environments]);
}

/** The entry with this id as the library shows it, tombstoned or not; null if no computer has it. */
export function useLibraryEntry(entryId: string | null): ThemeEntrySummary | null {
  const environments = useThemeEnvironments();
  const byEnvironment = useThemeLibraryStore((state) => state.byEnvironment);
  return useMemo(() => {
    if (entryId === null) return null;
    let winner: ThemeEntrySummary | null = null;
    for (const { environmentId } of environments) {
      const entry = byEnvironment[environmentId]?.entries.find((item) => item.entryId === entryId);
      if (entry && (winner === null || compareThemeRevisions(entry, winner) > 0)) winner = entry;
    }
    return winner;
  }, [byEnvironment, entryId, environments]);
}

const entryOf = (summary: ThemeEntry): ThemeEntry => ({
  entryId: summary.entryId,
  name: summary.name,
  hash: summary.hash,
  revision: summary.revision,
  revisedBy: summary.revisedBy,
  deleted: summary.deleted,
  createdAt: summary.createdAt,
  updatedAt: summary.updatedAt,
  offerKey: summary.offerKey ?? null,
});

type ThemesClient = WsRpcClient["themes"];

const clientOf = (environmentId: EnvironmentId): ThemesClient => {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new Error("That computer isn't connected right now.");
  return connection.client.themes;
};

/** The first followed computer: this one when it keeps a library. */
const homeEnvironment = (): EnvironmentId => {
  const home = followedEnvironmentIds[0];
  if (!home) throw new Error("No computer with a theme library is connected.");
  return home;
};

/**
 * Where to change an entry: the first followed computer holding its winning
 * copy (tombstoned too, so a deleted theme can be restored).
 */
const holderOf = (entryId: string): EnvironmentId => {
  const { byEnvironment } = useThemeLibraryStore.getState();
  let holder: { environmentId: EnvironmentId; entry: ThemeEntry } | null = null;
  for (const environmentId of followedEnvironmentIds) {
    const entry = byEnvironment[environmentId]?.entries.find((item) => item.entryId === entryId);
    if (entry && (holder === null || compareThemeRevisions(entry, holder.entry) > 0)) {
      holder = { environmentId, entry };
    }
  }
  if (!holder) throw new Error("That theme isn't in a connected computer's library.");
  return holder.environmentId;
};

/** Saves a theme as a new entry on this computer; the others get it from there. */
export async function saveThemeToLibrary(
  manifest: ThemeManifest,
  name?: string,
): Promise<{ readonly entry: ThemeEntrySummary; readonly environmentId: EnvironmentId }> {
  const environmentId = homeEnvironment();
  const entry = await clientOf(environmentId).save(
    name === undefined ? { manifest } : { manifest, name },
  );
  return { entry, environmentId };
}

/**
 * Gives an entry a later version of its theme, on the computer holding it:
 * the same entry and name, new content, which spreads to the others.
 */
export async function replaceLibraryTheme(
  entryId: string,
  manifest: ThemeManifest,
): Promise<{ readonly entry: ThemeEntrySummary; readonly environmentId: EnvironmentId }> {
  const environmentId = holderOf(entryId);
  const entry = await clientOf(environmentId).replace({ entryId, manifest });
  return { entry, environmentId };
}

/**
 * Keeps a theme in the library: the entry that already has it (the one kept
 * from the same chat offer first), else an update of the copy kept from an
 * earlier version of its offer (keptCopyOfOffer), else a new entry. `asCopy`
 * (Keep both, Save as new) adds a new entry instead of updating.
 */
export async function keepThemeInLibrary(
  theme: { readonly manifest: ThemeManifest; readonly name: string; readonly hash: string },
  options: { readonly asCopy?: boolean } = {},
): Promise<{ readonly entry: ThemeEntrySummary; readonly environmentId: EnvironmentId | null }> {
  const library = currentLibraryThemes();
  const offerKey = themeOfferKey(theme.manifest);
  const sameContent = library.filter((kept) => kept.entry.hash === theme.hash);
  const existing =
    sameContent.find((kept) => offerKey !== null && kept.entry.offerKey === offerKey) ??
    sameContent[0];
  if (existing) return { entry: existing.entry, environmentId: existing.holders[0] ?? null };
  const target =
    options.asCopy === true ? null : keptCopyOfOffer(library, theme.manifest, theme.hash);
  return target === null
    ? saveThemeToLibrary(theme.manifest, theme.name)
    : replaceLibraryTheme(target.entry.entryId, theme.manifest);
}

export async function renameLibraryTheme(entryId: string, name: string): Promise<void> {
  await clientOf(holderOf(entryId)).rename({ entryId, name });
}

export async function deleteLibraryTheme(entryId: string): Promise<void> {
  await clientOf(holderOf(entryId)).remove({ entryId });
}

export async function restoreLibraryTheme(entryId: string): Promise<void> {
  await clientOf(holderOf(entryId)).restore({ entryId });
}

/** A theme's content, from the first followed computer that has it (`prefer` first). */
export async function readLibraryTheme(
  hash: string,
  prefer?: EnvironmentId | null,
): Promise<ThemeContent> {
  const { byEnvironment } = useThemeLibraryStore.getState();
  const holders = followedEnvironmentIds.filter((environmentId) =>
    byEnvironment[environmentId]?.entries.some((entry) => entry.hash === hash),
  );
  const order =
    prefer && holders.includes(prefer)
      ? [prefer, ...holders.filter((id) => id !== prefer)]
      : holders;
  let lastError: unknown = new Error("No connected computer has that theme.");
  for (const environmentId of order) {
    try {
      return await clientOf(environmentId).read({ hash });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Saves a copy of an entry under a new name: a new entry with the same content.
 * The copy is the user's own, not kept from an agent's offer, so a later
 * version of that offer never updates it.
 */
export async function duplicateLibraryTheme(theme: LibraryTheme, name: string): Promise<void> {
  const content = await readLibraryTheme(theme.entry.hash, theme.holders[0] ?? null);
  await saveThemeToLibrary(themeWithoutOffer(content.manifest), name);
}

// ---------------------------------------------------------------------------
// Keeping computers in step

/** Merges sent or landed, so one disagreement is sent once: target, entry and revision. */
const sentMerges = new Map<string, "sending" | "done">();
/** A failed merge is tried again after this long, by a reconcile of its own. */
const MERGE_RETRY_MS = 60_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Every computer a failed merge involved since the retry was scheduled, with its last snapshot. */
const retryEnvironments = new Map<EnvironmentId, ThemeLibrarySnapshot | undefined>();

/**
 * Reconciles again later, once, so a failed merge is retried even if no
 * snapshot changes: every computer any failed merge involved meanwhile, and
 * the ones followed then, with their newest snapshots. An older one
 * standing in for a computer that sent none is harmless, since a merge
 * keeps whichever copy wins.
 */
type MergeClients = (
  environmentId: EnvironmentId,
) => Pick<ThemesClient, "read" | "merge" | "mergePick">;

function scheduleMergeRetry(
  byEnvironment: Readonly<Record<string, ThemeLibrarySnapshot>>,
  environmentIds: readonly EnvironmentId[],
  clients: MergeClients,
): void {
  for (const id of environmentIds) retryEnvironments.set(id, byEnvironment[id]);
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const pending = new Map(retryEnvironments);
    retryEnvironments.clear();
    const ids = [...new Set([...pending.keys(), ...followedEnvironmentIds])];
    const snapshots: Record<string, ThemeLibrarySnapshot> = {};
    for (const [id, snapshot] of pending) if (snapshot) snapshots[id] = snapshot;
    reconcileFollowedLibraries(
      { ...snapshots, ...useThemeLibraryStore.getState().byEnvironment },
      ids,
      clients,
    );
  }, MERGE_RETRY_MS);
}

async function sendMerge(
  source: EnvironmentId,
  target: EnvironmentId,
  entry: ThemeEntry,
  targetHasContent: boolean,
  clients: MergeClients,
  retry: () => void,
): Promise<void> {
  const key = `${target}\0${entry.entryId}\0${entry.revision}\0${entry.revisedBy}`;
  if (sentMerges.has(key)) return;
  sentMerges.set(key, "sending");
  try {
    const manifest = targetHasContent
      ? undefined
      : (await clients(source).read({ hash: entry.hash })).manifest;
    await clients(target).merge(
      manifest === undefined ? { entry: entryOf(entry) } : { entry: entryOf(entry), manifest },
    );
    sentMerges.set(key, "done");
  } catch (error) {
    sentMerges.delete(key);
    retry();
    console.warn("[themes] couldn't bring a theme to another computer", error);
  }
}

/**
 * Brings the winning shared pick to a computer holding an older one (or
 * none), or holding it without its theme's content (`contentOnly`). A library
 * pick's content goes with it when the computer lacks it, read from whichever
 * followed computer has it. When none can give it now, the pick still lands,
 * the computer says it is missing the content, and this is tried again later.
 */
async function sendPickMerge(
  target: EnvironmentId,
  pick: ThemePick,
  contentOnly: boolean,
  byEnvironment: Readonly<Record<string, ThemeLibrarySnapshot>>,
  readyIds: readonly EnvironmentId[],
  clients: MergeClients,
  retry: () => void,
): Promise<void> {
  const key = `pick${contentOnly ? "-content" : ""}\0${target}\0${pick.revision}\0${pick.revisedBy}`;
  if (sentMerges.has(key)) return;
  sentMerges.set(key, "sending");
  try {
    const hash = pick.theme.kind === "library" ? pick.theme.hash : undefined;
    // The computer's own word where it gives it; else whether an entry of its names the content.
    const needsContent =
      hash !== undefined &&
      (contentOnly || !byEnvironment[target]?.entries.some((entry) => entry.hash === hash));
    let manifest: ThemeManifest | undefined;
    if (hash !== undefined && needsContent) {
      for (const source of readyIds) {
        if (source === target) continue;
        try {
          manifest = (await clients(source).read({ hash })).manifest;
          break;
        } catch {
          // Not on that computer: try the next.
        }
      }
    }
    if (!contentOnly || manifest !== undefined) {
      await clients(target).mergePick(manifest === undefined ? { pick } : { pick, manifest });
    }
    if (needsContent && manifest === undefined) {
      // No computer could give the content now: again later, when one may.
      sentMerges.delete(key);
      retry();
    } else {
      sentMerges.set(key, "done");
    }
  } catch (error) {
    sentMerges.delete(key);
    retry();
    console.warn("[themes] couldn't bring the shared theme pick to another computer", error);
  }
}

/**
 * Sends every entry two followed computers disagree about to the one holding
 * the older copy, and the winning shared pick to every computer that keeps
 * picks and holds an older one.
 */
export function reconcileFollowedLibraries(
  byEnvironment: Readonly<Record<string, ThemeLibrarySnapshot>>,
  environmentIds: readonly EnvironmentId[],
  clients: MergeClients = clientOf,
): void {
  const ready = environmentIds.filter((id) => byEnvironment[id] !== undefined);
  const retry = () => scheduleMergeRetry(byEnvironment, environmentIds, clients);
  for (let first = 0; first < ready.length; first++) {
    for (let second = first + 1; second < ready.length; second++) {
      const a = ready[first]!;
      const b = ready[second]!;
      const entriesA = byEnvironment[a]!.entries;
      const entriesB = byEnvironment[b]!.entries;
      const hashesA = new Set(entriesA.map((entry) => entry.hash));
      const hashesB = new Set(entriesB.map((entry) => entry.hash));
      const plan = reconcileThemeLibraries(entriesA, entriesB);
      for (const entry of plan.sendToOther) {
        void sendMerge(a, b, entry, hashesB.has(entry.hash), clients, retry);
      }
      for (const entry of plan.takeFromOther) {
        void sendMerge(b, a, entry, hashesA.has(entry.hash), clients, retry);
      }
    }
  }
  // Only computers whose snapshot carries `pick` keep one; older ones never see a pick.
  const keeping = ready.filter((id) => byEnvironment[id]!.pick !== undefined);
  const winning = winningThemePick(keeping.map((id) => byEnvironment[id]!.pick));
  if (winning === null) return;
  for (const id of keeping) {
    const held = byEnvironment[id]!.pick ?? null;
    const order = held === null ? -1 : compareThemeRevisions(held, winning);
    if (order < 0) {
      void sendPickMerge(id, winning, false, byEnvironment, ready, clients, retry);
    } else if (order === 0 && byEnvironment[id]!.pickHasContent === false) {
      // It holds the pick but not the theme's content: that alone goes again.
      void sendPickMerge(id, winning, true, byEnvironment, ready, clients, retry);
    }
  }
}

/**
 * Keeps one subscription to each computer's library, replaced only when its
 * connection is (a reconnect with a new session), and keeps the libraries in
 * step. Mount once.
 */
export function ThemeLibrarySync() {
  const environments = useThemeEnvironments();
  const environmentKey = environments.map((environment) => environment.environmentId).join("\0");
  const byEnvironment = useThemeLibraryStore((state) => state.byEnvironment);

  useEffect(() => {
    const ids = (environmentKey === "" ? [] : environmentKey.split("\0")) as EnvironmentId[];
    followedEnvironmentIds = ids;
    useThemeLibraryStore.getState().keepOnly(new Set(ids));
    const active = new Map<
      EnvironmentId,
      { readonly connection: object; readonly unsubscribe: () => void }
    >();
    const sync = () => {
      for (const environmentId of ids) {
        const connection = readEnvironmentConnection(environmentId);
        const current = active.get(environmentId);
        if (current?.connection === connection) continue;
        current?.unsubscribe();
        active.delete(environmentId);
        if (!connection) continue;
        active.set(environmentId, {
          connection,
          unsubscribe: connection.client.themes.subscribe((snapshot) =>
            useThemeLibraryStore.getState().put(environmentId, snapshot),
          ),
        });
      }
    };
    sync();
    const stopWatching = subscribeEnvironmentConnections(sync);
    return () => {
      stopWatching();
      for (const entry of active.values()) entry.unsubscribe();
    };
  }, [environmentKey]);

  useEffect(() => {
    if (environments.length < 2) return;
    reconcileFollowedLibraries(
      byEnvironment,
      environments.map((environment) => environment.environmentId),
    );
  }, [byEnvironment, environments]);

  // "Same theme on all my devices": follows the shared pick and shares this device's.
  useThemePickSyncSettings();
  useEffect(
    () =>
      startThemePickSync({
        followed: () => followedEnvironmentIds,
        snapshots: () => useThemeLibraryStore.getState().byEnvironment,
        subscribe: (listener) => useThemeLibraryStore.subscribe(listener),
        pick: (environmentId, input) => clientOf(environmentId).pick(input),
        mergePick: (environmentId, input) => clientOf(environmentId).mergePick(input),
      }),
    [],
  );

  return null;
}
