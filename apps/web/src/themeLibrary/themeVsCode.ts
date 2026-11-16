/**
 * VS Code themes in the app (docs/design/custom-themes.md, "VS Code themes"):
 * searching the Open VSX store and reading an extension's themes, through a
 * computer whose server reports `themeVsCode` (this one first); trying one,
 * and adding several to the library at once.
 */
import type {
  EnvironmentId,
  ThemeVsCodeExtension,
  ThemeVsCodePackage,
  ThemeVsCodeSearchResult,
  ThemeVsCodeSort,
  ThemeVsCodeTheme,
} from "@threadlines/contracts";
import { themeContentHash } from "@threadlines/shared/themeManifestHash";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { readEnvironmentConnection } from "../environments/runtime";
import { startThemeTrial } from "../theme/themeStore";
import { keepThemeInLibrary, useThemeEnvironments } from "./themeLibraryState";

const clientOf = (environmentId: EnvironmentId) => {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new Error("That computer isn't connected right now.");
  return connection.client.themeVsCode;
};

/** The computers that search the store, this one first. */
export function useVsCodeEnvironments() {
  const environments = useThemeEnvironments();
  return useMemo(
    () => environments.filter((environment) => environment.capabilities.themeVsCode === true),
    [environments],
  );
}

export const vsCodeExtensionKey = (
  extension: Pick<ThemeVsCodeExtension, "namespace" | "name" | "version">,
) => `${extension.namespace}.${extension.name}@${extension.version}`;

type PackageState = ThemeVsCodePackage | { readonly failed: string };

interface VsCodeState {
  /** Each extension read so far, or why it couldn't be. */
  readonly packages: Readonly<Record<string, PackageState>>;
}

const useVsCodeStore = create<VsCodeState>(() => ({ packages: {} }));
/** Reads on their way, so a tile drawn twice asks once. */
const asked = new Set<string>();
/**
 * Extensions kept read in this window: the oldest that no tile shows go
 * first, and are read again if shown again.
 */
const PACKAGES_KEPT = 80;
/** How many tiles and dialogs show each extension right now. */
const shown = new Map<string, number>();

/** Reads an extension's themes once; a failure can be asked again. */
export function loadVsCodePackage(
  environmentId: EnvironmentId,
  extension: ThemeVsCodeExtension,
): Promise<PackageState> {
  const key = vsCodeExtensionKey(extension);
  asked.add(key);
  const { namespace, name, version } = extension;
  // Inside the promise: a connection gone since render fails like any other read.
  return Promise.resolve()
    .then(() => clientOf(environmentId).read({ namespace, name, version }))
    .catch((error: unknown) => ({
      failed: error instanceof Error ? error.message : "That extension couldn't be read.",
    }))
    .then((value) => {
      asked.delete(key);
      useVsCodeStore.setState((state) => {
        const others = Object.entries(state.packages).filter(([other]) => other !== key);
        // One on screen stays, or its tile would read it again and push out another.
        let spare = others.length + 1 - PACKAGES_KEPT;
        const kept = others.filter(([other]) => {
          if (spare <= 0 || shown.has(other)) return true;
          spare -= 1;
          return false;
        });
        return { packages: Object.fromEntries([...kept, [key, value]]) };
      });
      return value;
    });
}

/** An extension's themes as read, fetched when first asked for; null until then. */
export function useVsCodePackage(
  environmentId: EnvironmentId | null,
  extension: ThemeVsCodeExtension,
): PackageState | null {
  const key = vsCodeExtensionKey(extension);
  const value = useVsCodeStore((state) => state.packages[key] ?? null);
  useEffect(() => {
    shown.set(key, (shown.get(key) ?? 0) + 1);
    return () => {
      const count = (shown.get(key) ?? 1) - 1;
      if (count > 0) shown.set(key, count);
      else shown.delete(key);
    };
  }, [key]);
  useEffect(() => {
    if (environmentId === null || value !== null || asked.has(key)) return;
    void loadVsCodePackage(environmentId, extension);
  }, [environmentId, extension, key, value]);
  return value;
}

export interface VsCodeSearch {
  readonly extensions: ReadonlyArray<ThemeVsCodeExtension>;
  readonly loading: boolean;
  readonly error: string | null;
  /** Some extensions couldn't be checked, so a few may be missing. */
  readonly incomplete: boolean;
  /** Fetches the next page; null when there is none. */
  readonly more: (() => void) | null;
  readonly retry: () => void;
}

/** A search's pages so far, and the page being fetched or that failed. */
interface SearchState {
  readonly pages: ReadonlyArray<ThemeVsCodeSearchResult>;
  /** When its first page came (epoch ms); an old search is asked again, as the server's goes stale. */
  readonly at: number;
  readonly loadingOffset: number | null;
  readonly failed: { readonly offset: number; readonly error: string } | null;
}

const SEARCHES_KEPT = 20;
const SEARCH_FRESH_MS = 10 * 60_000;
const useSearchStore = create<{ readonly searches: Readonly<Record<string, SearchState>> }>(() => ({
  searches: {},
}));

const setSearch = (key: string, update: (state: SearchState) => SearchState) =>
  useSearchStore.setState(({ searches }) => {
    const current = searches[key] ?? { pages: [], at: 0, loadingOffset: null, failed: null };
    const kept = Object.entries(searches).filter(([other]) => other !== key);
    return {
      searches: Object.fromEntries([
        ...kept.slice(Math.max(0, kept.length - SEARCHES_KEPT + 1)),
        [key, update(current)],
      ]),
    };
  });

/** Fetches one page of a search into the store, after the pages before it. */
function fetchSearchPage(
  environmentId: EnvironmentId,
  key: string,
  input: { readonly query: string; readonly sort: ThemeVsCodeSort; readonly offset: number },
): void {
  setSearch(key, (state) => ({ ...state, loadingOffset: input.offset, failed: null }));
  void Promise.resolve()
    .then(() =>
      clientOf(environmentId).search({
        query: input.query,
        sort: input.sort,
        ...(input.offset === 0 ? {} : { offset: input.offset }),
      }),
    )
    .then(
      (result) =>
        setSearch(key, (state) => ({
          pages: input.offset === 0 ? [result] : [...state.pages, result],
          at: input.offset === 0 ? Date.now() : state.at,
          loadingOffset: null,
          failed: null,
        })),
      (error: unknown) =>
        setSearch(key, (state) => ({
          ...state,
          loadingOffset: null,
          failed: {
            offset: input.offset,
            error: error instanceof Error ? error.message : "Try again.",
          },
        })),
    );
}

/** One search, its pages added as they're asked for; each query and sort is its own. */
export function useVsCodeSearch(
  environmentId: EnvironmentId | null,
  query: string,
  sort: ThemeVsCodeSort,
): VsCodeSearch {
  const key = JSON.stringify([environmentId, query.toLowerCase(), sort]);
  const state = useSearchStore((store) => store.searches[key]);
  useEffect(() => {
    if (environmentId === null) return;
    // A refresh that failed waits for Try again, so a computer that's down isn't asked in a loop.
    const stale =
      state !== undefined &&
      state.loadingOffset === null &&
      state.failed === null &&
      state.pages.length > 0 &&
      Date.now() - state.at > SEARCH_FRESH_MS;
    if (state !== undefined && !stale) return;
    fetchSearchPage(environmentId, key, { query, sort, offset: 0 });
  }, [environmentId, key, query, sort, state]);

  const pages = state?.pages ?? [];
  // A page can list the same extension as an earlier one when the store's order moved.
  const extensions = useMemo(() => {
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.extensions)
      .filter((extension) => {
        const id = `${extension.namespace}.${extension.name}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }, [pages]);
  const loading = state === undefined || state.loadingOffset !== null;
  const nextOffset = pages.at(-1)?.nextOffset ?? null;
  return {
    extensions,
    loading: environmentId !== null && loading,
    error: state?.failed?.error ?? null,
    incomplete: pages.some((page) => page.incomplete === true),
    more:
      environmentId === null || loading || nextOffset === null || state?.failed != null
        ? null
        : () => fetchSearchPage(environmentId, key, { query, sort, offset: nextOffset }),
    // The page that failed, else the search from the start (a page missing some extensions).
    retry: () => {
      if (environmentId === null) return;
      fetchSearchPage(environmentId, key, { query, sort, offset: state?.failed?.offset ?? 0 });
    },
  };
}

/** Starts a trial of one VS Code theme; Keep then saves it to the library like any theme. */
export async function tryVsCodeTheme(theme: ThemeVsCodeTheme): Promise<void> {
  const hash = await themeContentHash(theme.manifest);
  startThemeTrial({
    choice: { kind: "unsaved", hash, name: theme.manifest.name },
    manifest: theme.manifest,
  });
}

/** Adds themes to the library without switching to any; how many were added. */
export async function addVsCodeThemes(themes: ReadonlyArray<ThemeVsCodeTheme>): Promise<number> {
  let added = 0;
  for (const theme of themes) {
    const hash = await themeContentHash(theme.manifest);
    await keepThemeInLibrary({ manifest: theme.manifest, name: theme.manifest.name, hash });
    added += 1;
  }
  return added;
}
