/**
 * The theme store's state machine, apart from the DOM and the network so it
 * can be tested anywhere (docs/design/custom-themes.md, "Applying a theme"
 * and "Trying"). `themeStore.ts` builds the one instance the app uses, with
 * the browser's storage, timers and library reads, and applies its active
 * theme to the document.
 *
 * - The committed choice is this device's: every window reads it from
 *   storage and a `storage` event from another window adopts it.
 * - A trial lives in one window's memory. It ends by Keep, Undo, its own
 *   countdown (which carries its id, so it can only end itself), another
 *   window committing a choice, or the window going away.
 * - Custom content resolves from memory, the device cache, then the entry's
 *   computer. Until it does, the pre-paint record's tokens stand in; if it is
 *   nowhere, the device shows the theme's base built-in and says so.
 */
import type { ThemeBase, ThemeManifest } from "@threadlines/contracts";
import { STARTER_SUMMARIES } from "@threadlines/shared/themeStarterSummaries";
import { resolveThemeTokens, type ThemeTokens } from "@threadlines/shared/themeTokens";

import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";
import {
  parseStoredThemeChoice,
  parseThemePaintRecord,
  readKeptThemeHashes,
  readStoredThemeChoice,
  sameThemeChoice,
  serializeThemeChoice,
  THEME_KEPT_STORAGE_KEY,
  THEME_PAINT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  themeChoiceKey,
  type ThemePaintRecord,
  withKeptThemeHash,
} from "./themeChoice";
import type { ActiveTheme, ThemeChoice, ThemeTrial } from "./themeTypes";

/** How long a trial runs before it switches back by itself. */
export const THEME_TRIAL_MS = 15_000;

export type ThemeContentLookup =
  | { readonly kind: "found"; readonly manifest: ThemeManifest }
  /** In no cache, and no computer asked has it. */
  | { readonly kind: "missing" }
  /** Not cached, and the computer that has it isn't connected (yet). */
  | { readonly kind: "offline" };

export interface ThemeStoreEnv {
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly now: () => number;
  /** Runs `callback` after `ms`; returns a cancel. */
  readonly setTimer: (callback: () => void, ms: number) => () => void;
  readonly randomId: () => string;
  readonly systemDark: () => boolean;
  /** `?theme=default`: this load shows System whatever was saved. */
  readonly bypassSavedChoice: boolean;
  readonly hashManifest: (manifest: ThemeManifest) => Promise<string>;
  readonly lookupContent: (
    choice: Extract<ThemeChoice, { kind: "library" | "unsaved" }>,
  ) => Promise<ThemeContentLookup>;
  /** Keeps content by hash on the device (the active theme and the last few used). */
  readonly rememberContent: (hash: string, manifest: ThemeManifest) => void;
  /** A starter's manifest when the starters' code is loaded; null until then. */
  readonly starterManifest: (id: string) => ThemeManifest | null;
  /** Loads the starters' code (their art is a chunk of its own) and returns one. */
  readonly loadStarter: (id: string) => Promise<ThemeManifest | null>;
}

/** A custom theme with its content in hand. */
export interface ResolvedTheme {
  readonly manifest: ThemeManifest;
  readonly tokens: ThemeTokens;
  readonly hash: string | null;
  readonly base: ThemeBase;
  readonly name: string;
}

export type CommittedThemeState =
  | { readonly status: "builtin" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly theme: ResolvedTheme }
  | { readonly status: "unavailable"; readonly reason: "missing" | "offline" };

export interface ThemeStoreState {
  readonly committed: ThemeChoice;
  /** The committed theme's base as stored, for falling back when its content is nowhere. */
  readonly committedBase: ThemeBase | null;
  readonly committedState: CommittedThemeState;
  readonly trial: ThemeTrial | null;
  /** The trial's theme; null for a built-in trial. */
  readonly trialTheme: ResolvedTheme | null;
  readonly systemDark: boolean;
  /** `?theme=default` is in effect for this load. */
  readonly bypass: boolean;
  /** What the pre-paint script painted, standing in while the committed content loads. */
  readonly provisional: ThemePaintRecord | null;
  readonly backdropStatus: ThemeBackdropStatus | null;
  /** Bumped by "Try again"; the backdrop host remounts on a new value. */
  readonly backdropGeneration: number;
  /** The desktop CPU watchdog found the art too heavy; it stays still until "Try again". */
  readonly backdropTooHeavy: boolean;
  readonly active: ActiveTheme;
}

const BUILTIN_NAMES = { system: "System", light: "Light", dark: "Dark" } as const;

export function choiceName(choice: ThemeChoice, starterName?: string): string {
  switch (choice.kind) {
    case "builtin":
      return BUILTIN_NAMES[choice.id];
    case "starter":
      return (
        starterName ??
        STARTER_SUMMARIES.find((starter) => starter.id === choice.id)?.name ??
        choice.id
      );
    case "library":
    case "unsaved":
      return choice.name;
  }
}

function resolveTheme(manifest: ThemeManifest, hash: string | null, name: string): ResolvedTheme {
  return { manifest, tokens: resolveThemeTokens(manifest), hash, base: manifest.base, name };
}

function choiceHash(choice: ThemeChoice): string | null {
  return choice.kind === "library" || choice.kind === "unsaved" ? choice.hash : null;
}

function builtinActive(
  choice: ThemeChoice,
  id: "system" | "light" | "dark",
  systemDark: boolean,
  name: string = BUILTIN_NAMES[id],
): ActiveTheme {
  return {
    choice,
    manifest: null,
    tokens: null,
    base: id === "system" ? (systemDark ? "dark" : "light") : id,
    hash: null,
    name,
  };
}

function resolvedActive(choice: ThemeChoice, theme: ResolvedTheme): ActiveTheme {
  return {
    choice,
    manifest: theme.manifest,
    tokens: theme.tokens,
    base: theme.base,
    hash: theme.hash,
    name: theme.name,
  };
}

/**
 * What the window shows. While a committed theme's content loads, the
 * pre-paint record stands in when it matches; otherwise the window keeps
 * what it showed (`previous`), so switching to a cached theme never flashes
 * the base built-in.
 */
function computeActive(
  state: Omit<ThemeStoreState, "active">,
  previous: ActiveTheme | null,
): ActiveTheme {
  const { trial, trialTheme, committed, committedState, systemDark } = state;
  if (trial) {
    if (trial.choice.kind === "builtin") {
      return builtinActive(trial.choice, trial.choice.id, systemDark);
    }
    if (trialTheme) return resolvedActive(trial.choice, trialTheme);
  }
  if (state.bypass) return builtinActive({ kind: "builtin", id: "system" }, "system", systemDark);
  switch (committedState.status) {
    case "builtin":
      return committed.kind === "builtin"
        ? builtinActive(committed, committed.id, systemDark)
        : builtinActive(committed, "system", systemDark);
    case "ready":
      return resolvedActive(committed, committedState.theme);
    case "loading": {
      const record = state.provisional;
      if (record && record.key === themeChoiceKey(committed)) {
        return {
          choice: committed,
          manifest: null,
          tokens: record.tokens,
          base: record.base,
          hash: record.hash,
          name: choiceName(committed),
        };
      }
      return (
        previous ??
        builtinActive(committed, state.committedBase ?? "system", systemDark, choiceName(committed))
      );
    }
    case "unavailable":
      return builtinActive(
        committed,
        state.committedBase ?? "system",
        systemDark,
        choiceName(committed),
      );
  }
}

function sameActive(first: ActiveTheme, second: ActiveTheme): boolean {
  return (
    sameThemeChoice(first.choice, second.choice) &&
    first.manifest === second.manifest &&
    first.tokens === second.tokens &&
    first.base === second.base &&
    first.hash === second.hash &&
    first.name === second.name
  );
}

export interface ThemeStoreCore {
  readonly getState: () => ThemeStoreState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly chooseTheme: (choice: ThemeChoice, manifest?: ThemeManifest) => void;
  readonly startThemeTrial: (input: {
    readonly choice: ThemeChoice;
    readonly manifest: ThemeManifest | null;
  }) => ThemeTrial;
  readonly commitThemeTrial: (id: string, choice?: ThemeChoice) => void;
  readonly endThemeTrial: (id: string) => void;
  readonly hasKeptTheme: (hash: string) => boolean;
  /** Another window wrote `key` (a `storage` event). */
  readonly handleStorageChange: (key: string | null) => void;
  /**
   * Adopts the stored choice if storage changed since this window last saw
   * it (another window's write whose event hasn't arrived yet).
   */
  readonly adoptStoredChoiceIfChanged: () => void;
  readonly setSystemDark: (dark: boolean) => void;
  readonly setBackdropStatus: (status: ThemeBackdropStatus | null) => void;
  readonly reportBackdropTooHeavy: () => void;
  readonly retryBackdrop: () => void;
  /** Where content can come from changed (a computer connected): look again for what was missing. */
  readonly retryUnavailable: () => void;
}

export function createThemeStoreCore(env: ThemeStoreEnv): ThemeStoreCore {
  const listeners = new Set<() => void>();
  const stored = readStoredThemeChoice(env.storage);
  let cancelTrialTimer: (() => void) | null = null;
  // Each commit gets a number; content that resolves for an older one is dropped.
  let commitSequence = 0;

  const readPaintRecord = (): ThemePaintRecord | null => {
    try {
      return parseThemePaintRecord(env.storage?.getItem(THEME_PAINT_STORAGE_KEY));
    } catch {
      return null;
    }
  };

  const initial: Omit<ThemeStoreState, "active"> = {
    committed: stored.choice,
    committedBase: stored.base,
    committedState:
      stored.choice.kind === "builtin" ? { status: "builtin" } : { status: "loading" },
    trial: null,
    trialTheme: null,
    systemDark: env.systemDark(),
    bypass: env.bypassSavedChoice,
    provisional: stored.choice.kind === "builtin" ? null : readPaintRecord(),
    backdropStatus: null,
    backdropGeneration: 0,
    backdropTooHeavy: false,
  };
  let state: ThemeStoreState = { ...initial, active: computeActive(initial, null) };

  /**
   * Applies a change. When the content on screen changes (its hash), the
   * backdrop's status and the watchdog's verdict belonged to the old art and
   * are dropped; Keep on a theme already showing keeps its running art's.
   */
  const update = (patch: Partial<Omit<ThemeStoreState, "active">>) => {
    const next = { ...state, ...patch };
    const computed = computeActive(next, state.active);
    const active = sameActive(computed, state.active) ? state.active : computed;
    const artChanged = active.hash !== state.active.hash;
    state = {
      ...next,
      ...(artChanged ? { backdropStatus: null, backdropTooHeavy: false } : {}),
      active,
    };
    for (const listener of listeners) listener();
  };

  const readStoredRaw = (): string | null => {
    try {
      return env.storage?.getItem(THEME_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };
  // The stored choice as this window last saw it, so a write this window
  // could not make (a full storage) is never mistaken for another window's.
  let lastSeenRaw = readStoredRaw();

  const writeStorage = (key: string, value: string | null) => {
    try {
      if (value === null) env.storage?.removeItem(key);
      else env.storage?.setItem(key, value);
    } catch {
      // A full or refused storage keeps the choice for this window only.
    }
    if (key === THEME_STORAGE_KEY) lastSeenRaw = readStoredRaw();
  };

  const markKept = (hash: string | null) => {
    if (!hash) return;
    writeStorage(
      THEME_KEPT_STORAGE_KEY,
      JSON.stringify(withKeptThemeHash(readKeptThemeHashes(env.storage), hash)),
    );
  };

  /** The pre-paint record follows the committed theme; built-ins need none. */
  const writePaintRecord = (choice: ThemeChoice, theme: ResolvedTheme | null) => {
    if (!theme) {
      writeStorage(THEME_PAINT_STORAGE_KEY, null);
      return;
    }
    const record: ThemePaintRecord = {
      v: 1,
      key: themeChoiceKey(choice),
      hash: theme.hash,
      base: theme.base,
      surface: theme.tokens["surface-solid"],
      tokens: theme.tokens,
      glass: theme.manifest.backdrop !== undefined,
    };
    writeStorage(THEME_PAINT_STORAGE_KEY, JSON.stringify(record));
  };

  /** Fills in a starter's hash once computed, wherever that starter still shows. */
  const fillStarterHash = (choice: ThemeChoice, manifest: ThemeManifest) => {
    void env.hashManifest(manifest).then(
      (hash) => {
        const key = themeChoiceKey(choice);
        const patch: { -readonly [K in keyof ThemeStoreState]?: ThemeStoreState[K] } = {};
        if (state.trial && themeChoiceKey(state.trial.choice) === key && state.trialTheme) {
          patch.trialTheme = { ...state.trialTheme, hash };
        }
        if (
          themeChoiceKey(state.committed) === key &&
          state.committedState.status === "ready" &&
          state.committedState.theme.hash === null
        ) {
          const theme = { ...state.committedState.theme, hash };
          patch.committedState = { status: "ready", theme };
          writePaintRecord(state.committed, theme);
          markKept(hash);
        }
        if (Object.keys(patch).length > 0) update(patch);
      },
      () => {},
    );
  };

  const resolveImmediately = (
    choice: ThemeChoice,
    manifest: ThemeManifest | undefined | null,
  ): ResolvedTheme | null => {
    switch (choice.kind) {
      case "builtin":
        return null;
      case "starter": {
        const starter = manifest ?? env.starterManifest(choice.id);
        return starter ? resolveTheme(starter, null, starter.name) : null;
      }
      case "library":
      case "unsaved":
        return manifest ? resolveTheme(manifest, choice.hash, choice.name) : null;
    }
  };

  /** Finds the committed theme's content when it wasn't handed in. */
  const lookupCommitted = (choice: ThemeChoice, sequence: number) => {
    if (choice.kind === "builtin") return;
    if (choice.kind === "starter") {
      const settle = (manifest: ThemeManifest | null) => {
        if (sequence !== commitSequence) return;
        if (!manifest) {
          update({ committedState: { status: "unavailable", reason: "missing" } });
          return;
        }
        const theme = resolveTheme(manifest, null, manifest.name);
        update({ committedState: { status: "ready", theme }, committedBase: theme.base });
        writePaintRecord(choice, theme);
        fillStarterHash(choice, manifest);
      };
      // Loaded already, or its code is on the way (the paint record covers the wait).
      const loaded = env.starterManifest(choice.id);
      if (loaded) settle(loaded);
      else void env.loadStarter(choice.id).then(settle, () => settle(null));
      return;
    }
    void env.lookupContent(choice).then(
      (lookup) => {
        if (sequence !== commitSequence) return;
        if (lookup.kind !== "found") {
          update({ committedState: { status: "unavailable", reason: lookup.kind } });
          return;
        }
        const theme = resolveTheme(lookup.manifest, choice.hash, choice.name);
        env.rememberContent(choice.hash, lookup.manifest);
        update({ committedState: { status: "ready", theme }, committedBase: theme.base });
        writePaintRecord(choice, theme);
      },
      () => {
        if (sequence !== commitSequence) return;
        update({ committedState: { status: "unavailable", reason: "missing" } });
      },
    );
  };

  const clearTrialTimer = () => {
    cancelTrialTimer?.();
    cancelTrialTimer = null;
  };

  /** Makes `choice` this device's theme, in storage and in this window. */
  const commit = (choice: ThemeChoice, manifest: ThemeManifest | null | undefined) => {
    commitSequence += 1;
    const sequence = commitSequence;
    clearTrialTimer();
    const theme = resolveImmediately(choice, manifest);
    const base = theme?.base ?? null;
    writeStorage(THEME_STORAGE_KEY, serializeThemeChoice(choice, base));
    if (choice.kind !== "builtin" && theme) {
      if (theme.hash) env.rememberContent(theme.hash, theme.manifest);
      markKept(theme.hash);
    }
    writePaintRecord(choice, theme);
    update({
      committed: choice,
      committedBase: base,
      committedState:
        choice.kind === "builtin"
          ? { status: "builtin" }
          : theme
            ? { status: "ready", theme }
            : { status: "loading" },
      trial: null,
      trialTheme: null,
      bypass: false,
      provisional: null,
    });
    if (choice.kind === "starter" && theme) fillStarterHash(choice, theme.manifest);
    if (choice.kind !== "builtin" && !theme) lookupCommitted(choice, sequence);
  };

  // The saved choice on load: built-ins are ready, the rest resolve.
  if (stored.choice.kind !== "builtin") lookupCommitted(stored.choice, commitSequence);

  const api: ThemeStoreCore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chooseTheme: (choice, manifest) => commit(choice, manifest),
    startThemeTrial: ({ choice, manifest }) => {
      if (choice.kind !== "builtin" && manifest === null) {
        throw new Error("A trial of a custom theme needs its manifest.");
      }
      clearTrialTimer();
      const theme = choice.kind === "builtin" ? null : resolveImmediately(choice, manifest);
      const trial: ThemeTrial = {
        id: env.randomId(),
        choice,
        name: theme?.name ?? choiceName(choice),
        expiresAt: env.now() + THEME_TRIAL_MS,
        manifest: choice.kind === "builtin" ? null : manifest,
      };
      cancelTrialTimer = env.setTimer(() => {
        if (state.trial?.id === trial.id) {
          cancelTrialTimer = null;
          update({ trial: null, trialTheme: null });
        }
      }, THEME_TRIAL_MS);
      update({ trial, trialTheme: theme });
      if (choice.kind === "starter" && theme && manifest) fillStarterHash(choice, manifest);
      return trial;
    },
    commitThemeTrial: (id, choice) => {
      const trial = state.trial;
      if (!trial || trial.id !== id) return;
      const finalChoice = choice ?? trial.choice;
      commit(finalChoice, trial.manifest ?? undefined);
    },
    endThemeTrial: (id) => {
      if (state.trial?.id !== id) return;
      clearTrialTimer();
      update({ trial: null, trialTheme: null });
    },
    hasKeptTheme: (hash) => readKeptThemeHashes(env.storage).includes(hash),
    handleStorageChange: (key) => {
      if (key !== THEME_STORAGE_KEY && key !== null) return;
      // Another window committed a choice: this window's trial ends and the
      // choice is adopted. (`null` means storage was cleared.)
      const raw = readStoredRaw();
      lastSeenRaw = raw;
      const next = parseStoredThemeChoice(raw) ?? {
        choice: { kind: "builtin", id: "system" } as const,
        base: null,
      };
      clearTrialTimer();
      commitSequence += 1;
      const sequence = commitSequence;
      const same = sameThemeChoice(next.choice, state.committed);
      update({
        committed: next.choice,
        committedBase: next.base ?? (same ? state.committedBase : null),
        committedState:
          next.choice.kind === "builtin"
            ? { status: "builtin" }
            : same && state.committedState.status === "ready"
              ? state.committedState
              : { status: "loading" },
        trial: null,
        trialTheme: null,
        bypass: false,
        provisional: next.choice.kind === "builtin" ? null : readPaintRecord(),
      });
      if (next.choice.kind !== "builtin" && state.committedState.status !== "ready") {
        lookupCommitted(next.choice, sequence);
      }
    },
    adoptStoredChoiceIfChanged: () => {
      if (readStoredRaw() !== lastSeenRaw) api.handleStorageChange(THEME_STORAGE_KEY);
    },
    setSystemDark: (dark) => {
      if (dark !== state.systemDark) update({ systemDark: dark });
    },
    setBackdropStatus: (status) => update({ backdropStatus: status }),
    reportBackdropTooHeavy: () => {
      if (!state.backdropTooHeavy) update({ backdropTooHeavy: true });
    },
    retryBackdrop: () =>
      update({
        backdropGeneration: state.backdropGeneration + 1,
        backdropStatus: null,
        backdropTooHeavy: false,
      }),
    retryUnavailable: () => {
      if (state.committedState.status !== "unavailable") return;
      commitSequence += 1;
      lookupCommitted(state.committed, commitSequence);
    },
  };
  return api;
}

/** The committed theme's own hash, when it has one (the content it names). */
export function committedThemeHash(state: ThemeStoreState): string | null {
  return state.committedState.status === "ready"
    ? state.committedState.theme.hash
    : choiceHash(state.committed);
}
