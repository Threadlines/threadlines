/**
 * "Same theme on all my devices" (docs/design/custom-themes.md, "Storage and
 * devices"). With the device's switch on, it shows the shared pick, the theme
 * last picked on any device with the switch on, and the themes the user
 * picks here become it.
 *
 * - The pick lives on every computer beside the library and is merged by
 *   revision order, like entries (themeLibraryState reconciles both).
 * - Following: a pick newer than the newest this device applied or shared is
 *   applied (applyThemePick), except while a trial runs in this window (it
 *   waits) or under `?theme=default`. An older one never is, so a computer
 *   dropping off can't roll the theme back.
 * - Sharing: a theme the user commits here (subscribeUserThemeCommits: not a
 *   pick applied, not another window's commit) becomes this device's pending
 *   pick, kept in storage until a computer that keeps picks takes it, above
 *   every pick revision this device has ever been shown. A pending pick is
 *   dropped, and the newer pick followed, only when a pick it didn't send
 *   overtook it (someone picked elsewhere since); its own picks still on
 *   their way (`outgoing`, shared by the device's windows) don't count. A
 *   send that fails is tried again a little later. Themes kept on this device
 *   only aren't shared.
 * - Joining (the switch turning on, however it happens): the device takes the
 *   shared pick once every computer it follows has reported, or, when none
 *   has one, shares its own theme.
 * - Nothing happens until the client settings have loaded, so a device with
 *   the switch saved off never follows under the default.
 *
 * Mounted once, by ThemeLibrarySync.
 */
import type {
  EnvironmentId,
  ThemeBase,
  ThemeLibrarySnapshot,
  ThemePick,
  ThemePickTheme,
} from "@threadlines/contracts";
import {
  compareThemeRevisions,
  sameThemePickTheme,
  winningThemePick,
} from "@threadlines/shared/themeLibrary";
import { useEffect, useRef } from "react";

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
/** A send that failed is tried again after this long, or sooner if the library changes after it. */
const PUBLISH_RETRY_MS = 30_000;

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

/** A theme picked here, not yet taken by a computer. */
export interface PendingThemePick {
  readonly theme: ThemePickTheme;
  /** The newest pick this device had been shown when the user picked; a newer one may overtake this. */
  readonly known: Revision | null;
  /** Shared because the switch turned on: it waits until every followed computer has reported. */
  readonly join?: boolean;
}

export interface ThemePickSyncState {
  /** The newest pick this device has applied or shared. */
  readonly seen: Revision | null;
  /** The newest pick any computer has shown this device, kept when that computer drops off. */
  readonly observed: Revision | null;
  readonly pending: PendingThemePick | null;
  /** Themes this device sent that haven't come back yet: a pick of one of these is its own. */
  readonly outgoing: ReadonlyArray<ThemePickTheme>;
}

const EMPTY_STATE: ThemePickSyncState = { seen: null, observed: null, pending: null, outgoing: [] };

/** What to do next, given where the device and its computers are. */
export type ThemePickStep =
  | { readonly kind: "wait" }
  | { readonly kind: "drop-pending" }
  | { readonly kind: "publish"; readonly pending: PendingThemePick }
  | { readonly kind: "apply"; readonly pick: ThemePick };

/** The newer of two revisions (either may be a whole pick), as a bare revision. */
export function newerThemeRevision(
  first: Revision | null,
  second: Revision | null,
): Revision | null {
  const winner =
    first === null
      ? second
      : second === null || compareThemeRevisions(first, second) >= 0
        ? first
        : second;
  return winner === null ? null : { revision: winner.revision, revisedBy: winner.revisedBy };
}

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
  /** Whether every followed computer has sent its library yet. */
  readonly allReported: boolean;
  readonly state: ThemePickSyncState;
}): ThemePickStep {
  const { state, winning } = input;
  if (!input.hydrated || input.bypass) return { kind: "wait" };
  if (!input.on) return state.pending === null ? { kind: "wait" } : { kind: "drop-pending" };
  const pending = state.pending;
  if (pending !== null) {
    const overtaken =
      winning !== null &&
      (pending.known === null || compareThemeRevisions(winning, pending.known) > 0) &&
      !state.outgoing.some((theme) => sameThemePickTheme(theme, winning.theme));
    if (overtaken) return { kind: "drop-pending" };
    if (pending.join === true && !input.allReported) return { kind: "wait" };
    return input.canPublish ? { kind: "publish", pending } : { kind: "wait" };
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

const revisionOf = (value: unknown): Revision | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Revision).revision === "number" &&
  typeof (value as Revision).revisedBy === "string"
    ? { revision: (value as Revision).revision, revisedBy: (value as Revision).revisedBy }
    : null;

const pickThemeFrom = (value: unknown): ThemePickTheme | null =>
  typeof value === "object" && value !== null && typeof (value as ThemePickTheme).kind === "string"
    ? (value as ThemePickTheme)
    : null;

export function readThemePickSyncState(
  storage: Pick<Storage, "getItem"> | null,
): ThemePickSyncState {
  try {
    const raw = storage?.getItem(THEME_PICK_STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pending = value.pending as Record<string, unknown> | null | undefined;
    const theme = pickThemeFrom(pending?.theme);
    return {
      seen: revisionOf(value.seen),
      observed: revisionOf(value.observed),
      pending:
        pending && theme
          ? {
              theme,
              known: revisionOf(pending.known),
              ...(pending.join === true ? { join: true } : {}),
            }
          : null,
      outgoing: Array.isArray(value.outgoing)
        ? value.outgoing.flatMap((item) => pickThemeFrom(item) ?? [])
        : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeThemePickSyncState(state: ThemePickSyncState): void {
  try {
    window.localStorage.setItem(THEME_PICK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or refused storage keeps the state for this window only.
  }
}

/** The state with one theme taken off the outgoing list. */
const withoutOutgoing = (state: ThemePickSyncState, theme: ThemePickTheme): ThemePickSyncState => {
  const index = state.outgoing.findIndex((item) => sameThemePickTheme(item, theme));
  return index < 0
    ? state
    : { ...state, outgoing: state.outgoing.filter((_, position) => position !== index) };
};

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
/** This window is sending a pick; one at a time. */
let publishing = false;
/** After a failed send, the next waits until then (epoch ms). */
let publishAfter = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** The winning pick, the computer to send to, and whether every followed computer has reported. */
function picksOf(source: ThemePickSyncLibrary) {
  const snapshots = source.snapshots();
  const followed = source.followed();
  const keeping = followed.filter((environmentId) => snapshots[environmentId]?.pick !== undefined);
  return {
    winning: winningThemePick(keeping.map((environmentId) => snapshots[environmentId]?.pick)),
    home: keeping[0] ?? null,
    allReported: followed.every((environmentId) => snapshots[environmentId] !== undefined),
  };
}

/** Takes the next step, and the next, until there is nothing to do now. */
function run(): void {
  const source = library;
  if (source === null) return;
  // At most a few steps a pass (drop, then apply); each changes the state it reads.
  for (let pass = 0; pass < 4; pass++) {
    let state = readThemePickSyncState(window.localStorage);
    const { winning, home, allReported } = picksOf(source);
    // Remember the newest pick ever shown, even if its computer drops off before it counts.
    const observed = newerThemeRevision(state.observed, winning);
    if (JSON.stringify(observed) !== JSON.stringify(state.observed)) {
      state = { ...state, observed };
      writeThemePickSyncState(state);
    }
    const theme = readThemeState();
    const step = nextThemePickStep({
      hydrated: settings.hydrated,
      on: settings.on,
      bypass: theme.bypass,
      trialRunning: theme.trial !== null,
      winning,
      canPublish: home !== null,
      allReported,
      state,
    });
    switch (step.kind) {
      case "wait":
        return;
      case "drop-pending":
        writeThemePickSyncState({ ...state, pending: null, outgoing: [] });
        continue;
      case "apply": {
        const shown = choiceOfPickTheme(step.pick.theme);
        if (shown && !sameThemeChoice(shown.choice, theme.committed)) {
          applyThemePick(shown.choice, shown.base);
        }
        // A kind this build can't show is passed over, not retried forever.
        writeThemePickSyncState({ ...state, seen: newerThemeRevision(state.seen, step.pick) });
        return;
      }
      case "publish":
        if (home !== null) publish(source, home, step.pending, state);
        return;
    }
  }
}

/** Sends a pending pick to the computer that keeps picks; one at a time, spaced out after a failure. */
function publish(
  source: ThemePickSyncLibrary,
  home: EnvironmentId,
  pending: PendingThemePick,
  state: ThemePickSyncState,
): void {
  if (publishing || Date.now() < publishAfter) return;
  publishing = true;
  const atLeast = Math.max(
    state.observed?.revision ?? 0,
    state.seen?.revision ?? 0,
    pending.known?.revision ?? 0,
  );
  writeThemePickSyncState({ ...state, outgoing: [...state.outgoing, pending.theme] });
  void source
    .pick(home, { theme: pending.theme, atLeast })
    .then(
      (picked) => {
        const now = withoutOutgoing(readThemePickSyncState(window.localStorage), pending.theme);
        const sent = now.pending !== null && sameThemePickTheme(now.pending.theme, pending.theme);
        writeThemePickSyncState({
          ...now,
          seen: newerThemeRevision(now.seen, picked),
          observed: newerThemeRevision(now.observed, picked),
          // Picked again while this went out: the newer pick still has to go, above this one.
          pending:
            sent || now.pending === null
              ? null
              : { ...now.pending, known: newerThemeRevision(now.pending.known, picked) },
        });
      },
      (error: unknown) => {
        const now = readThemePickSyncState(window.localStorage);
        writeThemePickSyncState(withoutOutgoing(now, pending.theme));
        publishAfter = Date.now() + PUBLISH_RETRY_MS;
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            run();
          }, PUBLISH_RETRY_MS);
        }
        console.warn("[themes] couldn't share the theme with your other devices", error);
      },
    )
    .finally(() => {
      publishing = false;
      run();
    });
}

/** The theme the user just committed here becomes this device's pick to share. */
function onUserCommit(choice: ThemeChoice, base: ThemeBase | null): void {
  const theme = pickThemeOf(choice, base);
  if (theme === null || readThemeState().bypass) return;
  const state = readThemePickSyncState(window.localStorage);
  const winning = library ? picksOf(library).winning : null;
  writeThemePickSyncState({
    ...state,
    pending: { theme, known: newerThemeRevision(state.observed, winning) },
  });
  publishAfter = 0;
  run();
}

/**
 * The switch turned on: this device joins the others. Once every followed
 * computer has reported, it takes the shared pick if there is one, or shares
 * its own theme when there is none.
 */
function join(): void {
  const { committed, committedBase } = readThemeState();
  const theme = pickThemeOf(committed, committedBase);
  const state = readThemePickSyncState(window.localStorage);
  writeThemePickSyncState({
    ...state,
    seen: null,
    pending: theme === null ? null : { theme, known: null, join: true },
    outgoing: [],
  });
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
  // A trial ending may let a waiting pick apply: after this commit's own
  // listeners, so a Keep is shared before anything else is applied over it.
  let lastTrial = readThemeState().trial;
  const stopTheme = subscribeTheme(() => {
    const trial = readThemeState().trial;
    if (trial === lastTrial) return;
    lastTrial = trial;
    if (trial === null) queueMicrotask(run);
  });
  run();
  return () => {
    stopCommits();
    stopLibrary();
    stopTheme();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (library === source) library = null;
  };
}

/**
 * Keeps the sync told about the device's switch and whether settings have
 * loaded, and joins the other devices whenever the switch turns on after
 * loading (in Appearance, by an agent's settings change, by Restore defaults).
 */
export function useThemePickSyncSettings(): void {
  const hydrated = useClientSettingsHydrated();
  const on = useSettings((value) => value.themeSameEverywhere);
  const loadedOn = useRef<boolean | null>(null);
  useEffect(() => {
    settings = { hydrated, on };
    if (!hydrated) return;
    const before = loadedOn.current;
    loadedOn.current = on;
    if (before === false && on) join();
    else run();
  }, [hydrated, on]);
}
