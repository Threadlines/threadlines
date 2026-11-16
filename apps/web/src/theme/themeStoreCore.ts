/**
 * The theme store's state machine, apart from the DOM and the network so it
 * can be tested anywhere (docs/design/custom-themes.md, "Applying a theme"
 * and "Trying"). `themeStore.ts` builds the one instance the app uses, with
 * the browser's storage, timers and library reads, and applies its active
 * theme to the document.
 *
 * - The committed choice is this device's: every window reads it from
 *   storage and a `storage` event from another window adopts it. A choice
 *   made here by the user (chooseTheme, Keep) is announced to
 *   `subscribeUserCommits` before it is written, which shares it with the
 *   user's other devices;
 *   one applied from another device (applyPickedChoice) or adopted from
 *   another window is not, so a pick never echoes back.
 * - A trial lives in one window's memory. It ends by Keep, Undo, its own
 *   countdown (which carries its id, so it can only end itself), another
 *   window committing a choice, or the window going away.
 * - Custom content resolves from memory, the device cache, then the entry's
 *   computer. Until it does, the pre-paint record's tokens stand in; if it is
 *   nowhere, the device shows the theme's base built-in and says so.
 * - System with a theme for each mode (a pair) resolves both sides when it is
 *   committed, so the computer switching modes switches the theme at once.
 *   Each side keeps its own pre-paint record, and one that is nowhere shows
 *   the built-in of its mode. The last pair is remembered apart from the
 *   choice, so going back to System brings it back.
 * - Turning content into tokens takes the token code, which loads the first
 *   time a custom theme is shown or tried. A choice or trial made before it
 *   lands applies when it does; the window keeps what it showed meanwhile.
 */
import { BACKDROP_MAX_SLOWDOWN, type ThemeBase, type ThemeManifest } from "@threadlines/contracts";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

import type { ThemeBackdropStatus } from "../components/theme/backdrop/ThemeBackdropHost";
import {
  pairSideFor,
  parseStoredThemeChoice,
  parseThemePaintRecord,
  readKeptThemeHashes,
  readStoredThemeChoice,
  readSystemPair,
  sameThemeChoice,
  serializeThemeChoice,
  THEME_KEPT_STORAGE_KEY,
  THEME_PAINT_STORAGE_KEY,
  THEME_PAIR_PAINT_STORAGE_KEYS,
  THEME_STORAGE_KEY,
  THEME_SYSTEM_PAIR_STORAGE_KEY,
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
  /** A theme's tokens, or null while the token code isn't loaded. */
  readonly deriveTokens: (manifest: ThemeManifest) => ThemeTokens | null;
  /** Loads the token code (the color math, a chunk of its own). */
  readonly loadTokenCode: () => Promise<unknown>;
}

/** A custom theme with its content in hand. */
export interface ResolvedTheme {
  readonly manifest: ThemeManifest;
  readonly tokens: ThemeTokens;
  readonly hash: string | null;
  readonly base: ThemeBase;
  readonly name: string;
}

/** Where one theme's content stands: the committed theme's, or one side of a pair's. */
export type ThemeSideState =
  | { readonly status: "builtin" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly theme: ResolvedTheme }
  | { readonly status: "unavailable"; readonly reason: "missing" | "offline" };

export type CommittedThemeState =
  | ThemeSideState
  | {
      readonly status: "pair";
      readonly light: ThemeSideState;
      readonly dark: ThemeSideState;
    };

type PairChoice = Extract<ThemeChoice, { kind: "pair" }>;

/** A pair's sides' content, as a caller has it. */
export type ThemeTrialSides = { readonly [Mode in ThemeBase]?: ThemeManifest | null | undefined };

/** Content handed in with a choice: a theme's manifest, or a pair's sides'. */
export interface ThemeContentInHand {
  readonly manifest?: ThemeManifest | null | undefined;
  readonly sides?: { readonly [Mode in ThemeBase]?: ThemeManifest | undefined } | undefined;
}

const modeOf = (dark: boolean): ThemeBase => (dark ? "dark" : "light");

/** No trial: the committed theme shows. */
const NO_TRIAL = { trial: null, trialTheme: null, trialSides: null } as const;

export interface ThemeStoreState {
  readonly committed: ThemeChoice;
  /** The committed theme's base as stored, for falling back when its content is nowhere. */
  readonly committedBase: ThemeBase | null;
  readonly committedState: CommittedThemeState;
  readonly trial: ThemeTrial | null;
  /** The trial's theme; null for a built-in trial, and for a pair's. */
  readonly trialTheme: ResolvedTheme | null;
  /** A pair's trial: each side's theme (null for a built-in side, or one not resolved). */
  readonly trialSides: { readonly [Mode in ThemeBase]: ResolvedTheme | null } | null;
  readonly systemDark: boolean;
  /** `?theme=default` is in effect for this load. */
  readonly bypass: boolean;
  /**
   * What the pre-paint script can paint for the committed choice (a pair has
   * one per side), standing in while its content loads.
   */
  readonly provisional: ReadonlyArray<ThemePaintRecord>;
  /** The pair going back to System brings back; null for plain System. */
  readonly systemPair: PairChoice | null;
  readonly backdropStatus: ThemeBackdropStatus | null;
  /** Bumped by "Try again"; the backdrop host remounts on a new value. */
  readonly backdropGeneration: number;
  /** The desktop CPU watchdog found the art too heavy; it stays still until "Try again". */
  readonly backdropTooHeavy: boolean;
  /**
   * Times the desktop CPU watchdog halved the art's rate; a verdict past
   * BACKDROP_MAX_SLOWDOWN makes it still (backdropTooHeavy).
   */
  readonly backdropSlowdown: number;
  readonly active: ActiveTheme;
}

const BUILTIN_NAMES = { system: "System", light: "Light", dark: "Dark" } as const;

export function choiceName(choice: ThemeChoice, starterName?: string): string {
  switch (choice.kind) {
    case "builtin":
      return BUILTIN_NAMES[choice.id];
    case "starter":
      // Before the starters' code loads, the name is its id's words
      // ("night-rain" is Night Rain); a test holds every starter to that.
      return (
        starterName ??
        choice.id
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ")
      );
    case "library":
    case "unsaved":
      return choice.name;
    case "pair":
      return BUILTIN_NAMES.system;
  }
}

/** A custom theme's content and what it is called, before its tokens. */
interface ThemeContent {
  readonly manifest: ThemeManifest;
  readonly hash: string | null;
  readonly name: string;
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
 * What one committed theme shows: `choice` is what the window says it shows
 * (the pair, for a side), `content` the theme whose content `side` holds.
 * While the content loads, the pre-paint record stands in when it matches;
 * otherwise the window keeps what it showed (`previous`), so switching to a
 * cached theme never flashes the base built-in.
 */
function committedActive(input: {
  readonly choice: ThemeChoice;
  readonly content: ThemeChoice;
  readonly side: ThemeSideState;
  /** The built-in shown when the content is nowhere. */
  readonly fallback: ThemeBase | "system";
  readonly state: Omit<ThemeStoreState, "active">;
  readonly previous: ActiveTheme | null;
}): ActiveTheme {
  const { choice, content, side, fallback, state, previous } = input;
  const { systemDark } = state;
  switch (side.status) {
    case "builtin":
      return content.kind === "builtin"
        ? builtinActive(choice, content.id, systemDark)
        : builtinActive(choice, "system", systemDark);
    case "ready":
      return resolvedActive(choice, side.theme);
    case "loading": {
      const key = themeChoiceKey(content);
      const record = state.provisional.find((candidate) => candidate.key === key);
      if (record) {
        return {
          choice,
          manifest: null,
          tokens: record.tokens,
          base: record.base,
          hash: record.hash,
          name: choiceName(content),
        };
      }
      return previous ?? builtinActive(choice, fallback, systemDark, choiceName(content));
    }
    case "unavailable":
      return builtinActive(choice, fallback, systemDark, choiceName(content));
  }
}

/** What the window shows: the trial when there is one, else the committed choice. */
function computeActive(
  state: Omit<ThemeStoreState, "active">,
  previous: ActiveTheme | null,
): ActiveTheme {
  const { trial, trialTheme, committed, committedState, systemDark } = state;
  if (trial) {
    if (trial.choice.kind === "builtin") {
      return builtinActive(trial.choice, trial.choice.id, systemDark);
    }
    if (trial.choice.kind === "pair") {
      // The side for the computer's mode, as it switches; its mode's built-in
      // while that side's theme isn't resolved (or couldn't be read).
      const mode = modeOf(systemDark);
      const side = pairSideFor(trial.choice, systemDark);
      const resolved = side.kind === "builtin" ? null : (state.trialSides?.[mode] ?? null);
      return resolved
        ? resolvedActive(trial.choice, resolved)
        : builtinActive(trial.choice, mode, systemDark);
    }
    if (trialTheme) {
      return resolvedActive(trial.choice, trialTheme);
    }
  }
  if (state.bypass) return builtinActive({ kind: "builtin", id: "system" }, "system", systemDark);
  if (committedState.status === "pair") {
    const mode = modeOf(systemDark);
    return committedActive({
      choice: committed,
      content:
        committed.kind === "pair"
          ? pairSideFor(committed, systemDark)
          : { kind: "builtin", id: mode },
      side: committedState[mode],
      fallback: mode,
      state,
      // While a side loads, what showed stands in only if it is that mode's:
      // the other side's theme would be the wrong mode.
      previous: previous?.base === mode ? previous : null,
    });
  }
  return committedActive({
    choice: committed,
    content: committed,
    side: committedState,
    fallback: state.committedBase ?? "system",
    state,
    previous,
  });
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
  /** Commits a choice; `inHand` is content the caller already holds, so it applies without a wait. */
  readonly chooseTheme: (choice: ThemeChoice, inHand?: ThemeContentInHand) => void;
  /**
   * Commits the theme another device picked ("Same theme on all my devices"),
   * with its base for when the content is nowhere. Not a user commit.
   */
  readonly applyPickedChoice: (
    choice: ThemeChoice,
    base: ThemeBase | null,
    inHand?: ThemeContentInHand,
  ) => void;
  /** Calls `listener` after each choice the user commits in this window (not picks applied, not other windows'). */
  readonly subscribeUserCommits: (
    listener: (choice: ThemeChoice, base: ThemeBase | null) => void,
  ) => () => void;
  /** A pair's trial takes its sides' content in `sides`; `manifest` is for any other theme. */
  readonly startThemeTrial: (input: {
    readonly choice: ThemeChoice;
    readonly manifest: ThemeManifest | null;
    /** A pair's trial: its sides' content (a side left out shows its mode's built-in). */
    readonly sides?: ThemeTrialSides;
  }) => ThemeTrial;
  readonly commitThemeTrial: (id: string, choice?: ThemeChoice) => void;
  readonly endThemeTrial: (id: string) => void;
  /**
   * Holds the trial's countdown while something else shows it (the /theme
   * picker, which has its own way back); letting go starts it over.
   */
  readonly holdThemeTrial: (id: string, held: boolean) => void;
  readonly hasKeptTheme: (hash: string) => boolean;
  /** Another window wrote `key` (a `storage` event). */
  readonly handleStorageChange: (key: string | null) => void;
  /**
   * Adopts the stored choice if storage changed since this window last saw
   * it (another window's write whose event hasn't arrived yet).
   */
  readonly adoptStoredChoiceIfChanged: () => void;
  /**
   * Sets the pair going back to System brings back; null forgets it, so
   * System is plain Light and Dark again. The theme shown stays.
   */
  readonly rememberSystemPair: (pair: PairChoice | null) => void;
  readonly setSystemDark: (dark: boolean) => void;
  readonly setBackdropStatus: (status: ThemeBackdropStatus | null) => void;
  /** The desktop CPU watchdog's verdict: the art halves its rate, and goes still past the last step. */
  readonly reportBackdropTooHeavy: () => void;
  readonly retryBackdrop: () => void;
  /** Where content can come from changed (a computer connected): look again for what was missing. */
  readonly retryUnavailable: () => void;
}

const MODES = ["light", "dark"] as const satisfies ReadonlyArray<ThemeBase>;

/** Which committed theme a lookup fills: the single one, or one side of a pair. */
type CommitTarget = "single" | ThemeBase;

const paintKeyOf = (target: CommitTarget) =>
  target === "single" ? THEME_PAINT_STORAGE_KEY : THEME_PAIR_PAINT_STORAGE_KEYS[target];

/** One committed theme's state as a commit sets it, and the content still to find. */
interface SidePlan {
  readonly target: CommitTarget;
  readonly choice: ThemeChoice;
  readonly side: ThemeSideState;
  /** Content this commit resolved (not reused): a starter's hash is filled in from it. */
  readonly content: ThemeContent | null;
  /** Still to find: lookupCommitted runs with what was in hand. */
  readonly lookup: { readonly inHand: ThemeManifest | null } | null;
}

interface CommitPlan {
  readonly committedState: CommittedThemeState;
  readonly sides: ReadonlyArray<SidePlan>;
}

export function createThemeStoreCore(env: ThemeStoreEnv): ThemeStoreCore {
  const listeners = new Set<() => void>();
  const userCommitListeners = new Set<(choice: ThemeChoice, base: ThemeBase | null) => void>();
  const stored = readStoredThemeChoice(env.storage);
  let cancelTrialTimer: (() => void) | null = null;
  // Each commit gets a number; content that resolves for an older one is dropped.
  let commitSequence = 0;

  const readPaintRecord = (key: string): ThemePaintRecord | null => {
    try {
      return parseThemePaintRecord(env.storage?.getItem(key));
    } catch {
      return null;
    }
  };

  /** The pre-paint records that can stand in for a choice's content (a pair's are per side). */
  const readPaintRecords = (choice: ThemeChoice): ThemePaintRecord[] => {
    const keys =
      choice.kind === "builtin"
        ? []
        : choice.kind === "pair"
          ? MODES.map((mode) => THEME_PAIR_PAINT_STORAGE_KEYS[mode])
          : [THEME_PAINT_STORAGE_KEY];
    return keys
      .map(readPaintRecord)
      .filter((record): record is ThemePaintRecord => record !== null);
  };

  /** A custom choice's content, when its manifest is in hand (or a loaded starter). */
  const contentFor = (
    choice: ThemeChoice,
    manifest: ThemeManifest | undefined | null,
  ): ThemeContent | null => {
    switch (choice.kind) {
      case "builtin":
      case "pair":
        return null;
      case "starter": {
        const starter = manifest ?? env.starterManifest(choice.id);
        return starter ? { manifest: starter, hash: null, name: starter.name } : null;
      }
      case "library":
      case "unsaved":
        return manifest ? { manifest, hash: choice.hash, name: choice.name } : null;
    }
  };

  /** The theme now, or null while the token code isn't loaded. */
  const resolveNow = (content: ThemeContent): ResolvedTheme | null => {
    const tokens = env.deriveTokens(content.manifest);
    return tokens ? { ...content, tokens, base: content.manifest.base } : null;
  };

  /**
   * How a commit sets one committed theme. `reuse` takes content this window
   * already resolved for it (the theme showing, a side of the pair, the
   * trial), so changing one side of a pair leaves the other as it is. At
   * load nothing is resolved yet, and every custom theme is looked up.
   */
  const planSide = (
    target: CommitTarget,
    choice: ThemeChoice,
    manifest: ThemeManifest | null | undefined,
    how: "commit" | "load",
  ): SidePlan => {
    if (choice.kind === "builtin" || choice.kind === "pair") {
      return { target, choice, side: { status: "builtin" }, content: null, lookup: null };
    }
    if (how === "load") {
      return {
        target,
        choice,
        side: { status: "loading" },
        content: null,
        lookup: { inHand: null },
      };
    }
    const reused = readyFor(themeChoiceKey(choice));
    if (reused) {
      return {
        target,
        choice,
        side: { status: "ready", theme: reused },
        content: null,
        lookup: null,
      };
    }
    const content = contentFor(choice, manifest);
    const theme = content ? resolveNow(content) : null;
    return theme
      ? { target, choice, side: { status: "ready", theme }, content, lookup: null }
      : {
          target,
          choice,
          side: { status: "loading" },
          content,
          lookup: { inHand: content?.manifest ?? null },
        };
  };

  const planCommit = (
    choice: ThemeChoice,
    inHand: ThemeContentInHand,
    how: "commit" | "load",
  ): CommitPlan => {
    if (choice.kind === "pair") {
      const light = planSide("light", choice.light, inHand.sides?.light, how);
      const dark = planSide("dark", choice.dark, inHand.sides?.dark, how);
      return {
        committedState: { status: "pair", light: light.side, dark: dark.side },
        sides: [light, dark],
      };
    }
    const single = planSide("single", choice, inHand.manifest, how);
    return { committedState: single.side, sides: [single] };
  };

  const initialPlan = planCommit(stored.choice, {}, "load");
  const initial: Omit<ThemeStoreState, "active"> = {
    committed: stored.choice,
    committedBase: stored.base,
    committedState: initialPlan.committedState,
    trial: null,
    trialTheme: null,
    trialSides: null,
    systemDark: env.systemDark(),
    bypass: env.bypassSavedChoice,
    provisional: readPaintRecords(stored.choice),
    systemPair:
      readSystemPair(env.storage) ?? (stored.choice.kind === "pair" ? stored.choice : null),
    backdropStatus: null,
    backdropGeneration: 0,
    backdropTooHeavy: false,
    backdropSlowdown: 0,
  };
  let state: ThemeStoreState = { ...initial, active: computeActive(initial, null) };

  /** What the trial resolved, by the key of the theme it is (each side's, for a pair). */
  const trialResolved = (): Array<readonly [string, ResolvedTheme]> => {
    const { trial, trialTheme, trialSides } = state;
    if (!trial) return [];
    if (trial.choice.kind === "pair") {
      const pair = trial.choice;
      return MODES.flatMap((mode) => {
        const theme = trialSides?.[mode] ?? null;
        return theme ? [[themeChoiceKey(pair[mode]), theme] as const] : [];
      });
    }
    return trialTheme ? [[themeChoiceKey(trial.choice), trialTheme] as const] : [];
  };

  /** Content this window already resolved under `key`: the committed theme, a side of the pair, the trial. */
  function readyFor(key: string): ResolvedTheme | null {
    const { committed, committedState } = state;
    if (committedState.status === "pair" && committed.kind === "pair") {
      for (const mode of MODES) {
        const side = committedState[mode];
        if (side.status === "ready" && themeChoiceKey(committed[mode]) === key) return side.theme;
      }
    } else if (committedState.status === "ready" && themeChoiceKey(committed) === key) {
      return committedState.theme;
    }
    return trialResolved().find(([candidate]) => candidate === key)?.[1] ?? null;
  }

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
      ...(artChanged ? { backdropStatus: null, backdropTooHeavy: false, backdropSlowdown: 0 } : {}),
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

  /** A committed theme's pre-paint record follows it; built-ins need none. */
  const writePaintRecord = (
    target: CommitTarget,
    choice: ThemeChoice,
    theme: ResolvedTheme | null,
  ) => {
    if (!theme) {
      writeStorage(paintKeyOf(target), null);
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
    writeStorage(paintKeyOf(target), JSON.stringify(record));
  };

  /** Sets one committed theme's state: the single one, or a side of the pair. */
  const setCommittedSide = (target: CommitTarget, side: ThemeSideState) => {
    if (target === "single") {
      update({
        committedState: side,
        ...(side.status === "ready" ? { committedBase: side.theme.base } : {}),
      });
      return;
    }
    const current = state.committedState;
    if (current.status !== "pair") return;
    update({
      committedState: target === "light" ? { ...current, light: side } : { ...current, dark: side },
    });
  };

  /** Fills in a starter's hash once computed, wherever that starter still shows. */
  const fillStarterHash = (choice: ThemeChoice, manifest: ThemeManifest) => {
    void env.hashManifest(manifest).then(
      (hash) => {
        const key = themeChoiceKey(choice);
        const patch: { -readonly [K in keyof ThemeStoreState]?: ThemeStoreState[K] } = {};
        const { trial, trialTheme, trialSides } = state;
        if (trial?.choice.kind === "pair" && trialSides) {
          const pair = trial.choice;
          const fill = (mode: ThemeBase) => {
            const theme = trialSides[mode];
            return theme && theme.hash === null && themeChoiceKey(pair[mode]) === key
              ? { ...theme, hash }
              : theme;
          };
          const light = fill("light");
          const dark = fill("dark");
          if (light !== trialSides.light || dark !== trialSides.dark) {
            patch.trialSides = { light, dark };
          }
        } else if (trial && trialTheme && themeChoiceKey(trial.choice) === key) {
          patch.trialTheme = { ...trialTheme, hash };
        }
        const { committed, committedState } = state;
        const filled = (target: CommitTarget, side: ThemeSideState, sideChoice: ThemeChoice) => {
          if (themeChoiceKey(sideChoice) !== key || side.status !== "ready") return side;
          if (side.theme.hash !== null) return side;
          const theme = { ...side.theme, hash };
          writePaintRecord(target, sideChoice, theme);
          markKept(hash);
          return { status: "ready", theme } as const;
        };
        if (committedState.status === "pair" && committed.kind === "pair") {
          const light = filled("light", committedState.light, committed.light);
          const dark = filled("dark", committedState.dark, committed.dark);
          if (light !== committedState.light || dark !== committedState.dark) {
            patch.committedState = { status: "pair", light, dark };
          }
        } else if (committedState.status !== "pair") {
          const single = filled("single", committedState, committed);
          if (single !== committedState) patch.committedState = single;
        }
        if (Object.keys(patch).length > 0) update(patch);
      },
      () => {},
    );
  };

  /** The theme now when the token code is loaded, else once it loads (null if it can't). */
  const resolveWhenReady = (content: ThemeContent, then: (theme: ResolvedTheme | null) => void) => {
    const now = resolveNow(content);
    if (now) {
      then(now);
      return;
    }
    void env.loadTokenCode().then(
      () => then(resolveNow(content)),
      () => then(null),
    );
  };

  /**
   * Resolves one committed theme (the single one, or a side of the pair)
   * when it couldn't be at once: finds its content when it wasn't handed in
   * (`inHand`), then its tokens.
   */
  const lookupCommitted = (
    target: CommitTarget,
    choice: ThemeChoice,
    sequence: number,
    inHand?: ThemeManifest | null,
  ) => {
    if (choice.kind === "builtin" || choice.kind === "pair") return;
    const unavailable = (reason: "missing" | "offline") => {
      if (sequence === commitSequence) setCommittedSide(target, { status: "unavailable", reason });
    };
    const settle = (theme: ResolvedTheme | null) => {
      if (sequence !== commitSequence) return;
      if (!theme) {
        unavailable("missing");
        return;
      }
      setCommittedSide(target, { status: "ready", theme });
      writePaintRecord(target, choice, theme);
      if (choice.kind === "starter") fillStarterHash(choice, theme.manifest);
    };
    const found = (manifest: ThemeManifest | null) => {
      if (sequence !== commitSequence) return;
      const content = manifest ? contentFor(choice, manifest) : null;
      if (content) resolveWhenReady(content, settle);
      else unavailable("missing");
    };
    if (inHand) {
      found(inHand);
      return;
    }
    if (choice.kind === "starter") {
      // Loaded already, or its code is on the way (the paint record covers the wait).
      const loaded = env.starterManifest(choice.id);
      if (loaded) found(loaded);
      else void env.loadStarter(choice.id).then(found, () => found(null));
      return;
    }
    void env.lookupContent(choice).then(
      (lookup) => {
        if (sequence !== commitSequence) return;
        if (lookup.kind !== "found") {
          unavailable(lookup.kind);
          return;
        }
        env.rememberContent(choice.hash, lookup.manifest);
        found(lookup.manifest);
      },
      () => unavailable("missing"),
    );
  };

  /** After a plan is in the state: starters get their hash, and what is still missing is looked up. */
  const followPlan = (plan: CommitPlan, sequence: number) => {
    for (const side of plan.sides) {
      if (side.content && side.side.status === "ready" && side.choice.kind === "starter") {
        fillStarterHash(side.choice, side.content.manifest);
      }
      if (side.lookup) lookupCommitted(side.target, side.choice, sequence, side.lookup.inHand);
    }
  };

  const clearTrialTimer = () => {
    cancelTrialTimer?.();
    cancelTrialTimer = null;
  };

  /** The trial's countdown: it ends the trial with `id` only (never a later one). */
  const startTrialCountdown = (id: string) => {
    clearTrialTimer();
    cancelTrialTimer = env.setTimer(() => {
      if (state.trial?.id === id) {
        cancelTrialTimer = null;
        update(NO_TRIAL);
      }
    }, THEME_TRIAL_MS);
  };

  /**
   * A trial of System's pair: both sides resolve, so the computer switching
   * modes during it shows the other side, as the pair will once kept. A side
   * whose content isn't in hand shows its mode's built-in.
   */
  const startPairTrial = (pair: PairChoice, sides: ThemeTrialSides): ThemeTrial => {
    clearTrialTimer();
    const trial: ThemeTrial = {
      id: env.randomId(),
      choice: pair,
      name: choiceName(pair),
      expiresAt: env.now() + THEME_TRIAL_MS,
      manifest: null,
      sides: { light: sides.light ?? null, dark: sides.dark ?? null },
    };
    const contents = MODES.map((mode) => {
      const side = pair[mode];
      const reused = side.kind === "builtin" ? null : readyFor(themeChoiceKey(side));
      const content = reused ? null : contentFor(side, sides[mode] ?? null);
      return { mode, side, content, theme: reused ?? (content ? resolveNow(content) : null) };
    });
    startTrialCountdown(trial.id);
    update({
      trial,
      trialTheme: null,
      trialSides: {
        light: contents[0]?.theme ?? null,
        dark: contents[1]?.theme ?? null,
      },
    });
    for (const { mode, side, content, theme } of contents) {
      if (content && !theme) {
        // The token code is on its way: the side shows when it lands.
        resolveWhenReady(content, (resolved) => {
          const current = state.trialSides;
          if (state.trial?.id !== trial.id || !resolved || !current) return;
          update({
            trialSides:
              mode === "light" ? { ...current, light: resolved } : { ...current, dark: resolved },
          });
          if (side.kind === "starter") fillStarterHash(side, resolved.manifest);
        });
      } else if (content && theme && side.kind === "starter") {
        fillStarterHash(side, theme.manifest);
      }
    }
    return trial;
  };

  /**
   * Makes `choice` this device's theme, in storage and in this window. `by`
   * says whose choice it is: the user's here, or a pick from another device
   * (which carries the base to fall back to while its content is nowhere).
   */
  const commit = (
    choice: ThemeChoice,
    inHand: ThemeContentInHand,
    by: { readonly user: true } | { readonly user: false; readonly base: ThemeBase | null },
  ) => {
    commitSequence += 1;
    const sequence = commitSequence;
    clearTrialTimer();
    const plan = planCommit(choice, inHand, "commit");
    const single = choice.kind === "pair" ? null : (plan.sides[0] ?? null);
    const base =
      single === null
        ? null
        : (single.content?.manifest.base ??
          (single.side.status === "ready" ? single.side.theme.base : null) ??
          (by.user ? null : by.base));
    // Announced before the device's theme is written and before subscribers
    // hear the trial end: what shares the user's pick writes it down first,
    // so no window sees the new theme without it, or applies a pick from
    // elsewhere over a Keep.
    if (by.user) for (const listener of userCommitListeners) listener(choice, base);
    writeStorage(THEME_STORAGE_KEY, serializeThemeChoice(choice, base));
    if (choice.kind === "pair") {
      writeStorage(THEME_SYSTEM_PAIR_STORAGE_KEY, serializeThemeChoice(choice, null));
    }
    for (const side of plan.sides) {
      // Content in hand or already resolved here (a Keep's trial) is kept on the device.
      const kept =
        side.side.status === "ready" ? side.side.theme : side.content?.hash ? side.content : null;
      if (kept?.hash) {
        env.rememberContent(kept.hash, kept.manifest);
        markKept(kept.hash);
      }
      // A side still loading keeps the record it has: one for the same theme still paints it.
      if (side.side.status === "ready") writePaintRecord(side.target, side.choice, side.side.theme);
      else if (side.side.status === "builtin") writePaintRecord(side.target, side.choice, null);
    }
    // The other shape's records name no theme this device shows now.
    const stale = choice.kind === "pair" ? (["single"] as const) : MODES;
    for (const target of stale) writeStorage(paintKeyOf(target), null);
    update({
      committed: choice,
      committedBase: base,
      committedState: plan.committedState,
      ...NO_TRIAL,
      bypass: false,
      provisional: readPaintRecords(choice),
      ...(choice.kind === "pair" ? { systemPair: choice } : {}),
    });
    followPlan(plan, sequence);
  };

  // The saved choice on load: built-ins are ready, the rest resolve.
  followPlan(initialPlan, commitSequence);

  const api: ThemeStoreCore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chooseTheme: (choice, inHand) => commit(choice, inHand ?? {}, { user: true }),
    applyPickedChoice: (choice, base, inHand) =>
      commit(choice, inHand ?? {}, { user: false, base }),
    subscribeUserCommits: (listener) => {
      userCommitListeners.add(listener);
      return () => {
        userCommitListeners.delete(listener);
      };
    },
    startThemeTrial: ({ choice, manifest, sides }) => {
      if (choice.kind === "pair") return startPairTrial(choice, sides ?? {});
      if (choice.kind !== "builtin" && manifest === null) {
        throw new Error("A trial of a custom theme needs its manifest.");
      }
      clearTrialTimer();
      const content = contentFor(choice, manifest);
      const theme = content ? resolveNow(content) : null;
      const trial: ThemeTrial = {
        id: env.randomId(),
        choice,
        name: content?.name ?? choiceName(choice),
        expiresAt: env.now() + THEME_TRIAL_MS,
        manifest: choice.kind === "builtin" ? null : manifest,
      };
      startTrialCountdown(trial.id);
      update({ trial, trialTheme: theme, trialSides: null });
      if (content && !theme) {
        // The token code is on its way: the trial shows when it lands, or
        // ends if it can't.
        resolveWhenReady(content, (resolved) => {
          if (state.trial?.id !== trial.id) return;
          if (!resolved) {
            clearTrialTimer();
            update(NO_TRIAL);
            return;
          }
          update({ trialTheme: resolved });
          if (choice.kind === "starter") fillStarterHash(choice, resolved.manifest);
        });
      } else if (choice.kind === "starter" && theme) {
        fillStarterHash(choice, theme.manifest);
      }
      return trial;
    },
    commitThemeTrial: (id, choice) => {
      const trial = state.trial;
      if (!trial || trial.id !== id) return;
      const finalChoice = choice ?? trial.choice;
      const inHand: ThemeContentInHand =
        finalChoice.kind === "pair"
          ? {
              sides: {
                light: trial.sides?.light ?? undefined,
                dark: trial.sides?.dark ?? undefined,
              },
            }
          : { manifest: trial.manifest ?? undefined };
      commit(finalChoice, inHand, { user: true });
    },
    endThemeTrial: (id) => {
      if (state.trial?.id !== id) return;
      clearTrialTimer();
      update(NO_TRIAL);
    },
    holdThemeTrial: (id, held) => {
      const trial = state.trial;
      if (!trial || trial.id !== id || (trial.expiresAt === null) === held) return;
      if (held) {
        clearTrialTimer();
        update({ trial: { ...trial, expiresAt: null } });
      } else {
        update({ trial: { ...trial, expiresAt: env.now() + THEME_TRIAL_MS } });
        startTrialCountdown(id);
      }
    },
    hasKeptTheme: (hash) => readKeptThemeHashes(env.storage).includes(hash),
    handleStorageChange: (key) => {
      if (key === THEME_SYSTEM_PAIR_STORAGE_KEY || key === null) {
        const pair = readSystemPair(env.storage);
        const same =
          pair === null || state.systemPair === null
            ? pair === state.systemPair
            : sameThemeChoice(pair, state.systemPair);
        if (!same) update({ systemPair: pair });
      }
      if (key !== THEME_STORAGE_KEY && key !== null) return;
      // Another window committed a choice: this window's trial ends and the
      // choice is adopted. (`null` means storage was cleared.) A load under
      // `?theme=default` keeps showing System whatever is saved meanwhile.
      const raw = readStoredRaw();
      lastSeenRaw = raw;
      if (state.bypass) return;
      const next = parseStoredThemeChoice(raw) ?? {
        choice: { kind: "builtin", id: "system" } as const,
        base: null,
      };
      clearTrialTimer();
      commitSequence += 1;
      const sequence = commitSequence;
      const same = sameThemeChoice(next.choice, state.committed);
      // What this window already resolved for the same theme (or a side) stays.
      const plan = planCommit(next.choice, {}, "commit");
      update({
        committed: next.choice,
        committedBase: next.base ?? (same ? state.committedBase : null),
        committedState: plan.committedState,
        ...NO_TRIAL,
        bypass: false,
        provisional: readPaintRecords(next.choice),
        ...(next.choice.kind === "pair" ? { systemPair: next.choice } : {}),
      });
      followPlan(plan, sequence);
    },
    adoptStoredChoiceIfChanged: () => {
      if (readStoredRaw() !== lastSeenRaw) api.handleStorageChange(THEME_STORAGE_KEY);
    },
    rememberSystemPair: (pair) => {
      writeStorage(
        THEME_SYSTEM_PAIR_STORAGE_KEY,
        pair === null ? null : serializeThemeChoice(pair, null),
      );
      const same =
        pair === null || state.systemPair === null
          ? pair === state.systemPair
          : sameThemeChoice(pair, state.systemPair);
      if (!same) update({ systemPair: pair });
    },
    setSystemDark: (dark) => {
      if (dark !== state.systemDark) update({ systemDark: dark });
    },
    setBackdropStatus: (status) => update({ backdropStatus: status }),
    reportBackdropTooHeavy: () => {
      if (state.backdropTooHeavy) return;
      // Slower first, as the art's own budget does; still only past the last step.
      if (state.backdropSlowdown < BACKDROP_MAX_SLOWDOWN) {
        update({ backdropSlowdown: state.backdropSlowdown + 1 });
      } else {
        update({ backdropTooHeavy: true });
      }
    },
    retryBackdrop: () =>
      update({
        backdropGeneration: state.backdropGeneration + 1,
        backdropStatus: null,
        backdropTooHeavy: false,
        backdropSlowdown: 0,
      }),
    retryUnavailable: () => {
      const { committed, committedState } = state;
      if (committedState.status === "unavailable") {
        commitSequence += 1;
        lookupCommitted("single", committed, commitSequence);
        return;
      }
      if (committedState.status !== "pair" || committed.kind !== "pair") return;
      if (MODES.every((mode) => committedState[mode].status !== "unavailable")) return;
      // A new sequence drops the lookups still out, so every side not ready goes again.
      commitSequence += 1;
      for (const mode of MODES) {
        const status = committedState[mode].status;
        if (status === "unavailable" || status === "loading") {
          lookupCommitted(mode, committed[mode], commitSequence);
        }
      }
    },
  };
  return api;
}

/** The state of the committed theme the window shows: the shown side's, for a pair. */
export function shownCommittedState(state: ThemeStoreState): ThemeSideState {
  const { committedState } = state;
  return committedState.status === "pair"
    ? committedState[modeOf(state.systemDark)]
    : committedState;
}

/** Whether any committed theme (either side of a pair) is nowhere to be found. */
export function hasUnavailableContent(state: ThemeStoreState): boolean {
  const { committedState } = state;
  return committedState.status === "pair"
    ? MODES.some((mode) => committedState[mode].status === "unavailable")
    : committedState.status === "unavailable";
}

/** The content hashes the committed choice shows (both sides of a pair), to keep on the device. */
export function committedThemeHashes(state: ThemeStoreState): string[] {
  const { committed, committedState } = state;
  const hashOf = (choice: ThemeChoice, side: ThemeSideState) =>
    side.status === "ready" ? side.theme.hash : choiceHash(choice);
  const hashes =
    committedState.status === "pair"
      ? committed.kind === "pair"
        ? MODES.map((mode) => hashOf(committed[mode], committedState[mode]))
        : []
      : [hashOf(committed, committedState)];
  return hashes.filter((hash): hash is string => hash !== null);
}
