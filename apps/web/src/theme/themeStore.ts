/**
 * Which theme this device shows, and trying one (docs/design/custom-themes.md,
 * "Applying a theme" and "What the user sees"). The committed choice is this
 * device's own (all its windows share it); a trial lives in one window's
 * memory, applies at once, and ends by Keep, Undo, its countdown, a reload, or
 * another window committing a choice.
 *
 * The state machine is `themeStoreCore.ts`; this module runs the one instance
 * with the browser's storage and the theme library, applies the active theme
 * to the document (themeApply.ts), tells the desktop window, and exposes the
 * hooks components subscribe to. Components never infer the theme from the
 * DOM.
 *
 * Stored shape: `threadlines:theme` keeps `system`, `light` and `dark` as
 * bare words (today's values load unchanged); other choices are JSON (see
 * themeChoice.ts). `threadlines:theme-paint` is the pre-paint record
 * index.html reads; `threadlines:theme-kept` the hashes this device kept.
 */
import type { ThemeManifest } from "@threadlines/contracts";
import type { StarterTheme } from "@threadlines/shared/themeStarters";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";
import { useMemo, useSyncExternalStore } from "react";

import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";
import { applyThemeToDocument, desktopThemeAppearance, loadActiveThemeFonts } from "./themeApply";
import {
  committedThemeHash,
  createThemeStoreCore,
  type ThemeContentLookup,
  type ThemeStoreCore,
  type ThemeStoreState,
} from "./themeStoreCore";
import type { ActiveTheme, ThemeChoice, ThemeTrial } from "./themeTypes";

export type { ActiveTheme, ThemeChoice, ThemeTrial } from "./themeTypes";
export { THEME_TRIAL_MS } from "./themeStoreCore";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Code the store loads the first time it needs it, never at startup. A
 * failed load is forgotten, so the next call tries again.
 */
function loadedOnDemand<T>(load: () => Promise<T>) {
  let value: T | null = null;
  let loading: Promise<T> | null = null;
  return {
    current: () => value,
    load: (): Promise<T> =>
      (loading ??= load().then(
        (loaded) => (value = loaded),
        (error: unknown) => {
          loading = null;
          throw error;
        },
      )),
  };
}

// The starters carry their art scripts, loaded the first time one is tried
// or used. Retired ones too: a device that chose one keeps it.
const starterCode = loadedOnDemand<ReadonlyArray<StarterTheme>>(() =>
  import("@threadlines/shared/themeStarters").then((module) => [
    ...module.STARTER_THEMES,
    ...module.RETIRED_STARTER_THEMES,
  ]),
);

// The color math that turns a theme's seeds into its tokens, loaded the
// first time a custom theme is shown or tried. At startup the pre-paint
// record's tokens stand in until it lands.
const tokenCode = loadedOnDemand<(manifest: ThemeManifest) => ThemeTokens>(() =>
  import("@threadlines/shared/themeTokens").then((module) => module.resolveThemeTokens),
);

// Where custom content comes from (this device's cache, then the
// computers), loaded the first time a custom theme needs content.
const contentSource = loadedOnDemand(() => import("./themeContentSource"));

// Content to keep on this device that the cache's code hasn't taken yet: it
// answers lookups meanwhile and is written once the code loads (the next
// use tries again after a failed load).
const pendingContent = new Map<string, { manifest: ThemeManifest; keep: string | undefined }>();

function loadContentSource() {
  return contentSource.load().then((source) => {
    for (const [hash, { manifest, keep }] of pendingContent) {
      source.rememberThemeContent(hash, manifest, keep);
    }
    pendingContent.clear();
    return source;
  });
}

/** Starts loading the token code before a custom theme needs it (a failed load retries later). */
export function preloadThemeTokenCode(): void {
  void tokenCode.load().catch(() => {});
}

/** Loads the starter themes' code. */
export function loadStarterThemes(): Promise<ReadonlyArray<StarterTheme>> {
  return starterCode.load();
}

/** A starter theme by id, once the starters are loaded (null until then). */
export function starterThemeManifest(id: string): ThemeManifest | null {
  return starterCode.current()?.find((starter) => starter.id === id)?.manifest ?? null;
}

/** A starter theme by id, loading the starters first if need be. */
export async function loadStarterThemeManifest(id: string): Promise<ThemeManifest | null> {
  return (await loadStarterThemes()).find((starter) => starter.id === id)?.manifest ?? null;
}

let core: ThemeStoreCore | null = null;

function systemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MEDIA_QUERY).matches
    : false;
}

function getCore(): ThemeStoreCore {
  if (core) return core;
  const bypass =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location?.search ?? "").get("theme") === "default";
  core = createThemeStoreCore({
    storage: browserStorage(),
    now: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
    randomId: () =>
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    systemDark,
    bypassSavedChoice: bypass,
    hashManifest: (manifest) =>
      import("@threadlines/shared/themeManifestHash").then((module) =>
        module.themeContentHash(manifest),
      ),
    lookupContent: (choice) => {
      const pending = pendingContent.get(choice.hash);
      if (pending) {
        return Promise.resolve<ThemeContentLookup>({ kind: "found", manifest: pending.manifest });
      }
      return loadContentSource().then((source) => source.lookupLibraryContent(choice));
    },
    rememberContent: (hash, manifest) => {
      const keep = core ? (committedThemeHash(core.getState()) ?? undefined) : undefined;
      pendingContent.set(hash, { manifest, keep });
      void loadContentSource().catch(() => {});
    },
    starterManifest: starterThemeManifest,
    loadStarter: loadStarterThemeManifest,
    deriveTokens: (manifest) => tokenCode.current()?.(manifest) ?? null,
    loadTokenCode: tokenCode.load,
  });
  // A saved custom theme needs the token code next; fetch it alongside its content.
  if (core.getState().committed.kind !== "builtin") preloadThemeTokenCode();
  startDocumentSync(core);
  return core;
}

// ---------------------------------------------------------------------------
// Keeping the document, the desktop window and other windows in step

const fontListeners = new Set<() => void>();
let lastDesktopAppearanceKey: string | null = null;
let connectionWatch: (() => void) | null = null;

function syncDesktopAppearance(theme: ActiveTheme): void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return;
  const appearance = desktopThemeAppearance(theme);
  const key = JSON.stringify(appearance);
  if (key === lastDesktopAppearanceKey) return;
  lastDesktopAppearanceKey = key;
  void bridge.setTheme(appearance).catch(() => {
    if (lastDesktopAppearanceKey === key) lastDesktopAppearanceKey = null;
  });
}

/** While the committed theme is nowhere, look again whenever a computer connects. */
function watchConnectionsWhileUnavailable(store: ThemeStoreCore): void {
  const unavailable = store.getState().committedState.status === "unavailable";
  if (unavailable && connectionWatch === null) {
    let stopped = false;
    let stop: (() => void) | null = null;
    connectionWatch = () => {
      stopped = true;
      stop?.();
    };
    void import("../environments/runtime").then((runtime) => {
      if (stopped) return;
      stop = runtime.subscribeEnvironmentConnections(() => store.retryUnavailable());
      store.retryUnavailable();
    });
  } else if (!unavailable && connectionWatch !== null) {
    connectionWatch();
    connectionWatch = null;
  }
}

function startDocumentSync(store: ThemeStoreCore): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let applied: ActiveTheme | null = null;
  // The theme whose fonts were last asked for. A theme's content can arrive
  // after its hash (from this device's cache at startup, or from its
  // computer), so this follows the content, not the switch.
  let fontsFor: string | null = null;
  const apply = (animate: boolean) => {
    const state = store.getState();
    watchConnectionsWhileUnavailable(store);
    if (state.active === applied) return;
    applied = state.active;
    applyThemeToDocument(state.active, { animate });
    syncBrowserChromeColor();
    syncDesktopAppearance(state.active);
    if (state.active.manifest?.fonts && state.active.hash !== fontsFor) {
      fontsFor = state.active.hash;
      const theme = state.active;
      void loadActiveThemeFonts(theme).then(
        (loaded) => {
          if (!loaded || store.getState().active.hash !== theme.hash) return;
          for (const listener of fontListeners) listener();
        },
        () => {
          // The font code didn't download: the next time this theme shows, try again.
          if (fontsFor === theme.hash) fontsFor = null;
        },
      );
    }
  };
  apply(true);
  store.subscribe(() => apply(false));
  const systemQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  if (typeof systemQuery?.addEventListener === "function") {
    systemQuery.addEventListener("change", (event) => {
      store.setSystemDark(event.matches);
    });
  }
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== null && event.storageArea !== browserStorage()) return;
    store.handleStorageChange(event.key);
  });
}

// ---------------------------------------------------------------------------
// Browser chrome (theme-color meta, the page behind overscroll)

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) return element;
  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }
  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

/**
 * The browser's chrome (the theme-color meta, iPhone's status bar, the page
 * behind overscroll) takes the page's color. A custom theme gives it
 * `--surface-solid`, its opaque base, never a see-through glass surface;
 * under glass the body stays clear for the art behind it. The built-ins keep
 * reading the page's own surface.
 */
export function syncBrowserChromeColor(): void {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const root = document.documentElement;
  if (root.hasAttribute("data-theme")) {
    const surface = normalizeThemeColor(getComputedStyle(root).getPropertyValue("--surface-solid"));
    if (!surface) return;
    root.style.backgroundColor = surface;
    document.body.style.backgroundColor = root.hasAttribute("data-glass") ? "" : surface;
    ensureThemeColorMetaTag().setAttribute("content", surface);
    return;
  }
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;
  root.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

// ---------------------------------------------------------------------------
// Reading and changing the theme

function subscribe(listener: () => void): () => void {
  const unsubscribe = getCore().subscribe(listener);
  // A component that starts watching sees the device's choice as stored now.
  adoptStoredThemeChoice();
  return unsubscribe;
}

function getState(): ThemeStoreState {
  return getCore().getState();
}

/** The store's whole state, for non-React readers (the terminal, the backdrop layer). */
export function readThemeState(): ThemeStoreState {
  return getState();
}

/** Subscribes to every theme change; for code outside React. */
export function subscribeTheme(listener: () => void): () => void {
  return subscribe(listener);
}

/** Calls `listener` when the active theme's embedded fonts finish loading (text measures change). */
export function subscribeThemeFontsLoaded(listener: () => void): () => void {
  fontListeners.add(listener);
  return () => {
    fontListeners.delete(listener);
  };
}

/** The active theme now, outside React. */
export function readActiveTheme(): ActiveTheme {
  return getState().active;
}

/**
 * Adopts the stored choice when storage holds a different one than this
 * window committed (another window's write whose `storage` event hasn't
 * arrived yet), so a read of the device's choice is never stale.
 */
export function adoptStoredThemeChoice(): void {
  getCore().adoptStoredChoiceIfChanged();
}

/**
 * One slice of the store, kept current. The server snapshot is the same
 * read: pages rendered to markup (tests, previews) see this device's theme.
 */
function useThemeSelector<T>(select: (state: ThemeStoreState) => T): T {
  const read = () => select(getState());
  return useSyncExternalStore(subscribe, read, read);
}

/** The committed choice of this device. */
export function useThemeChoice(): ThemeChoice {
  return useThemeSelector((state) => state.committed);
}

export function useActiveTheme(): ActiveTheme {
  return useThemeSelector((state) => state.active);
}

export function useThemeTrial(): ThemeTrial | null {
  return useThemeSelector((state) => state.trial);
}

/** The running backdrop's last status, for Appearance's energy label and notices. */
export function useBackdropStatus(): ThemeBackdropStatus | null {
  const status = useThemeSelector((state) => state.backdropStatus);
  const tooHeavy = useThemeSelector((state) => state.backdropTooHeavy);
  return useMemo(() => {
    if (!tooHeavy) return status;
    return {
      kind: "failed",
      reason: "too-heavy",
      detail: "The art used more of this computer than a theme may.",
      minimumTint: status && status.kind !== "running" ? status.minimumTint : 1,
    };
  }, [status, tooHeavy]);
}

/** Bumped by `retryBackdrop`; the backdrop host remounts on a new value. */
export function useBackdropGeneration(): number {
  return useThemeSelector((state) => state.backdropGeneration);
}

/** Whether the desktop watchdog paused the art as too heavy (until "Try again"). */
export function useBackdropTooHeavy(): boolean {
  return useThemeSelector((state) => state.backdropTooHeavy);
}

/** Times the desktop watchdog halved the art's rate before pausing it. */
export function useBackdropSlowdown(): number {
  return useThemeSelector((state) => state.backdropSlowdown);
}

let lastUnavailable: { readonly name: string } | null = null;

/**
 * The committed theme's content is in no cache and no connected computer has
 * it, so the device shows its base built-in; null otherwise.
 */
export function useThemeUnavailable(): { readonly name: string } | null {
  return useThemeSelector((state) => {
    if (state.bypass || state.committedState.status !== "unavailable") return null;
    const name = state.active.name;
    if (lastUnavailable?.name !== name) lastUnavailable = { name };
    return lastUnavailable;
  });
}

/**
 * Whether this device has kept this theme before (by content hash), so
 * switching back to it skips the trial.
 */
export function hasKeptTheme(hash: string): boolean {
  return getCore().hasKeptTheme(hash);
}

/**
 * Applies a theme now as a trial in this window, replacing any trial running.
 * `manifest` is null only for a built-in choice.
 */
export function startThemeTrial(input: {
  readonly choice: ThemeChoice;
  readonly manifest: ThemeManifest | null;
}): ThemeTrial {
  return getCore().startThemeTrial(input);
}

/**
 * Ends the trial with `id` and commits its theme as this device's choice.
 * `choice` replaces the trial's own (Keep saves an unsaved theme to the
 * library first and commits the new library entry). No-op if that trial
 * already ended.
 */
export function commitThemeTrial(id: string, choice?: ThemeChoice): void {
  getCore().commitThemeTrial(id, choice);
}

/** Ends the trial with `id`, putting the committed theme back. No-op if it already ended. */
export function endThemeTrial(id: string): void {
  getCore().endThemeTrial(id);
}

/** Holds the trial's countdown while the /theme picker shows it; letting go starts it over. */
export function holdThemeTrial(id: string, held: boolean): void {
  getCore().holdThemeTrial(id, held);
}

/** Commits a choice directly: built-ins, and themes this device kept before. */
export function chooseTheme(choice: ThemeChoice, manifest?: ThemeManifest): void {
  const known =
    manifest ??
    (choice.kind === "library"
      ? (pendingContent.get(choice.hash)?.manifest ??
        contentSource.current()?.peekCachedTheme(choice.hash))
      : null);
  getCore().chooseTheme(choice, known ?? undefined);
}

/**
 * Appearance's "Try again" after the art was paused as too heavy or failed:
 * remounts the backdrop for the active theme and clears the failure.
 */
export function retryBackdrop(): void {
  getCore().retryBackdrop();
}

/** The backdrop host's status, as it reports it. */
export function setBackdropStatus(status: ThemeBackdropStatus | null): void {
  getCore().setBackdropStatus(status);
}

/** The desktop CPU watchdog's verdict: the art slows down, then goes still until "Try again". */
export function reportBackdropTooHeavy(): void {
  getCore().reportBackdropTooHeavy();
}

// Apply the saved theme as soon as this module loads, before React renders.
if (typeof window !== "undefined") getCore();
