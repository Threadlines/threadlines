/**
 * "Same theme on all my devices" (docs/design/custom-themes.md, "Storage and
 * devices"). With the device's switch on, it shows the shared pick, the theme
 * last picked on any device with the switch on, and the themes the user
 * picks here become it.
 *
 * - The pick lives on every computer beside the library and is merged by
 *   revision order, like entries (themeLibraryState reconciles both).
 * - Following: a pick newer than the newest this device has seen is applied
 *   (applyThemePick), except while a trial runs in this window (it waits) or
 *   under `?theme=default`. A pick no newer than one seen never is, so a
 *   computer dropping off can't roll the theme back.
 * - Sharing: a theme the user commits here (subscribeUserThemeCommits: not a
 *   pick applied, not another window's commit) becomes this device's pending
 *   pick, kept in storage until a computer that keeps picks takes it, above
 *   every pick revision this device has seen. A pending pick overtaken by a
 *   newer one (someone picked elsewhere since) is dropped and the newer one
 *   followed. Themes kept on this device only aren't shared.
 * - Nothing happens until the client settings have loaded, so a device with
 *   the switch saved off never follows under the default.
 *
 * Mounted once, by ThemeLibrarySync (ThemePickSync).
 */
import type {
  EnvironmentId,
  ThemeBase,
  ThemeLibrarySnapshot,
  ThemePick,
  ThemePickTheme,
} from "@threadlines/contracts";
import { compareThemeRevisions, winningThemePick } from "@threadlines/shared/themeLibrary";
import { useEffect } from "react";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { parseStoredThemeChoice, sameThemeChoice } from "../theme/themeChoice";
import {
  applyThemePick,
  readThemeState,
  retryUnavailableTheme,
  subscribeTheme,
  subscribeUserThemeCommits,
} from "../theme/themeStore";
import type { ThemeChoice } from "../theme/themeTypes";

/** Where this device keeps what it has seen and what it still has to share. */
export const THEME_PICK_STORAGE_KEY = "threadlines:theme-pick";

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

/** A theme picked here, not yet taken by a computer. */
export interface PendingThemePick {
  readonly theme: ThemePickTheme;
  /** The newest pick this device knew when the user picked; a newer one overtakes this. */
  readonly known: Revision | null;
}

export interface ThemePickSyncState {
  /** The newest pick this device has applied or shared. */
  readonly seen: Revision | null;
  readonly pending: PendingThemePick | null;
}

/** What to do next, given where the device and its computers are. */
export type ThemePickStep =
  | { readonly kind: "wait" }
  | { readonly kind: "drop-pending" }
  | { readonly kind: "publish"; readonly pending: PendingThemePick }
  | { readonly kind: "apply"; readonly pick: ThemePick };

/** The newer of two revisions (either may be a whole pick), as a bare revision. */
const newer = (first: Revision | null, second: Revision | null): Revision | null => {
  const winner =
    first === null
      ? second
      : second === null || compareThemeRevisions(first, second) >= 0
        ? first
        : second;
  return winner === null ? null : { revision: winner.revision, revisedBy: winner.revisedBy };
};

/** The next step: pure, so every case is testable apart from the stores. */
export function nextThemePickStep(input: {
  /** Settings loaded; until then nothing happens. */
  readonly hydrated: boolean;
  /** The device's switch. */
  readonly on: boolean;
  /** `?theme=default`: this load shows System and must not change anything. */
  readonly bypass: boolean;
  readonly trialRunning: boolean;
  /** The winning pick across the computers this app follows that keep one. */
  readonly winning: ThemePick | null;
  /** Whether any followed computer keeps picks (a newer server). */
  readonly canPublish: boolean;
  readonly state: ThemePickSyncState;
}): ThemePickStep {
  const { state, winning } = input;
  if (!input.hydrated || input.bypass) return { kind: "wait" };
  if (!input.on) return state.pending === null ? { kind: "wait" } : { kind: "drop-pending" };
  if (state.pending !== null) {
    const known = state.pending.known;
    if (winning !== null && (known === null || compareThemeRevisions(winning, known) > 0)) {
      return { kind: "drop-pending" };
    }
    return input.canPublish ? { kind: "publish", pending: state.pending } : { kind: "wait" };
  }
  if (winning !== null && (state.seen === null || compareThemeRevisions(winning, state.seen) > 0)) {
    return input.trialRunning ? { kind: "wait" } : { kind: "apply", pick: winning };
  }
  return { kind: "wait" };
}

/** A device's choice as a pick's theme; null for one kept on this device only. */
export function pickThemeOf(choice: ThemeChoice, base: ThemeBase | null): ThemePickTheme | null {
  const withBase = base === null ? {} : { base };
  switch (choice.kind) {
    case "builtin":
      return { kind: "builtin", id: choice.id };
    case "starter":
      return { kind: "starter", id: choice.id, ...withBase };
    case "library":
      return {
        kind: "library",
        entryId: choice.entryId,
        hash: choice.hash,
        name: choice.name,
        ...withBase,
      };
    case "unsaved":
      return null;
  }
}

/** A pick's theme as a choice this build can show; null for a kind or value it doesn't know. */
export function choiceOfPickTheme(
  theme: ThemePickTheme,
): { readonly choice: ThemeChoice; readonly base: ThemeBase | null } | null {
  if (theme.kind === "unsaved") return null;
  // The stored-choice parser already validates every field of every kind.
  const { kind, id, entryId, hash, name, base } = theme;
  return parseStoredThemeChoice(JSON.stringify({ v: 1, kind, id, entryId, hash, name, base }));
}

// ---------------------------------------------------------------------------
// Storage

const isRevision = (value: unknown): value is Revision =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Revision).revision === "number" &&
  typeof (value as Revision).revisedBy === "string";

export function readThemePickSyncState(
  storage: Pick<Storage, "getItem"> | null,
): ThemePickSyncState {
  try {
    const raw = storage?.getItem(THEME_PICK_STORAGE_KEY);
    if (!raw) return { seen: null, pending: null };
    const value = JSON.parse(raw) as Record<string, unknown>;
    const seen = isRevision(value.seen)
      ? { revision: value.seen.revision, revisedBy: value.seen.revisedBy }
      : null;
    const pending = value.pending as Record<string, unknown> | null | undefined;
    const theme = pending?.theme as ThemePickTheme | undefined;
    return {
      seen,
      pending:
        pending && typeof theme === "object" && theme !== null && typeof theme.kind === "string"
          ? { theme, known: isRevision(pending.known) ? pending.known : null }
          : null,
    };
  } catch {
    return { seen: null, pending: null };
  }
}

function writeThemePickSyncState(state: ThemePickSyncState): void {
  try {
    window.localStorage.setItem(THEME_PICK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or refused storage keeps the state for this window only.
  }
}

// ---------------------------------------------------------------------------
// Running it

/** What the sync reads from the library: each followed computer's snapshot, and a client for each. */
export interface ThemePickSyncLibrary {
  readonly followed: () => ReadonlyArray<EnvironmentId>;
  readonly snapshots: () => Readonly<Record<string, ThemeLibrarySnapshot>>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly pick: (
    environmentId: EnvironmentId,
    input: { readonly theme: ThemePickTheme; readonly atLeast: number },
  ) => Promise<ThemePick>;
}

let settings = { hydrated: false, on: true };
let library: ThemePickSyncLibrary | null = null;
let publishing = false;

/** The winning pick, and whether a followed computer keeps picks at all. */
function picksOf(source: ThemePickSyncLibrary) {
  const snapshots = source.snapshots();
  const keeping = source
    .followed()
    .filter((environmentId) => snapshots[environmentId]?.pick !== undefined);
  return {
    winning: winningThemePick(keeping.map((environmentId) => snapshots[environmentId]?.pick)),
    home: keeping[0] ?? null,
  };
}

/** Takes the next step, and the next, until there is nothing to do now. */
function run(): void {
  const source = library;
  if (source === null) return;
  for (let guard = 0; guard < 4; guard++) {
    const state = readThemePickSyncState(window.localStorage);
    const theme = readThemeState();
    const { winning, home } = picksOf(source);
    const step = nextThemePickStep({
      hydrated: settings.hydrated,
      on: settings.on,
      bypass: theme.bypass,
      trialRunning: theme.trial !== null,
      winning,
      canPublish: home !== null,
      state,
    });
    switch (step.kind) {
      case "wait":
        return;
      case "drop-pending":
        writeThemePickSyncState({ ...state, pending: null });
        continue;
      case "apply": {
        const shown = choiceOfPickTheme(step.pick.theme);
        if (shown && !sameThemeChoice(shown.choice, theme.committed)) {
          applyThemePick(shown.choice, shown.base);
        }
        // A kind this build can't show is passed over, not retried forever.
        writeThemePickSyncState({ ...state, seen: newer(state.seen, step.pick) });
        return;
      }
      case "publish": {
        if (publishing || home === null) return;
        publishing = true;
        const atLeast = Math.max(
          winning?.revision ?? 0,
          state.seen?.revision ?? 0,
          step.pending.known?.revision ?? 0,
        );
        void source
          .pick(home, { theme: step.pending.theme, atLeast })
          .then(
            (picked) => {
              const now = readThemePickSyncState(window.localStorage);
              // Picked again while this went out: that newer pending pick still has to go.
              const sent =
                now.pending !== null &&
                JSON.stringify(now.pending.theme) === JSON.stringify(step.pending.theme);
              writeThemePickSyncState({
                seen: newer(now.seen, picked),
                pending: sent ? null : now.pending,
              });
            },
            (error: unknown) => {
              // Kept pending: the next change in the library tries again.
              console.warn("[themes] couldn't share the theme with your other devices", error);
            },
          )
          .finally(() => {
            publishing = false;
            run();
          });
        return;
      }
    }
  }
}

/** The theme the user just committed here becomes this device's pick to share. */
function onUserCommit(choice: ThemeChoice, base: ThemeBase | null): void {
  const theme = pickThemeOf(choice, base);
  if (theme === null || readThemeState().bypass) return;
  const state = readThemePickSyncState(window.localStorage);
  const source = library;
  const winning = source ? picksOf(source).winning : null;
  writeThemePickSyncState({ ...state, pending: { theme, known: newer(state.seen, winning) } });
  run();
}

/**
 * The switch turned on: this device joins the others. It takes the shared
 * pick if there is one; if none turns up, its own theme becomes it.
 */
export function joinSameThemeEverywhere(): void {
  // Ahead of the settings hook, which hears of the switch a render later.
  settings = { ...settings, on: true };
  const committed = readThemeState().committed;
  const theme = pickThemeOf(committed, readThemeState().committedBase);
  writeThemePickSyncState({ seen: null, pending: theme === null ? null : { theme, known: null } });
  run();
}

/** Starts the sync over the given library; returns the way to stop it. */
export function startThemePickSync(source: ThemePickSyncLibrary): () => void {
  library = source;
  const stopCommits = subscribeUserThemeCommits(onUserCommit);
  const stopLibrary = source.subscribe(() => {
    // New content may have reached a computer: a theme that was nowhere may be there now.
    if (readThemeState().committedState.status === "unavailable") retryUnavailableTheme();
    run();
  });
  // A trial ending (or `?theme=default` ending) may let a waiting pick apply.
  let lastTrial = readThemeState().trial;
  const stopTheme = subscribeTheme(() => {
    const trial = readThemeState().trial;
    if (trial === lastTrial) return;
    lastTrial = trial;
    if (trial === null) run();
  });
  run();
  return () => {
    stopCommits();
    stopLibrary();
    stopTheme();
    if (library === source) library = null;
  };
}

/** Keeps the sync told about the device's switch and whether settings have loaded. */
export function useThemePickSyncSettings(): void {
  const hydrated = useClientSettingsHydrated();
  const on = useSettings((value) => value.themeSameEverywhere);
  useEffect(() => {
    settings = { hydrated, on };
    run();
  }, [hydrated, on]);
}
