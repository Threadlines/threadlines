/**
 * "Same theme on all my devices" (docs/design/custom-themes.md, "Storage and
 * devices"). With the device's switch on, it shows the shared pick, the theme
 * last picked on any device with the switch on, and the themes the user
 * picks here become it.
 *
 * - The pick lives on every computer beside the library and is merged by
 *   revision order, like entries (themeLibraryState reconciles both).
 * - One window a device runs this (a Web Lock; every window where there are
 *   none). The others only write down what the user picks in them; the
 *   runner hears it through storage, and they see its picks through the theme
 *   they share. So the device's notes below have one writer, bar two small
 *   ones any window may make (a new pending pick, a join).
 * - Following: a pick newer than the newest this device applied or shared is
 *   applied (applyPick), except while a trial runs in the runner's window (it
 *   waits) or under `?theme=default` (such a window never runs this). An
 *   older one never is, so a computer dropping off can't roll the theme back.
 * - Sharing: a theme the user commits (not a pick applied, not another
 *   window's commit) becomes the device's pending pick, with an id of its
 *   own, kept in storage until a computer that keeps picks takes it, above
 *   every pick revision the device has been shown. It is done when the
 *   computer answers for that very pick, or when the pick comes back carrying
 *   its id. It is dropped, and the newer pick followed, only when a pick this
 *   device didn't send overtook it; the ids of the picks it sent say which
 *   are its own. A send that fails is tried again a little later. A theme
 *   kept on this device only isn't shared, and puts aside one waiting to be.
 * - Joining (the switch turning on, however it happens): once every computer
 *   the device follows has reported, it takes the shared pick; when there is
 *   none, its own theme becomes it, which the computer refuses if a pick got
 *   there first.
 * - Nothing happens until the client settings have loaded, so a device with
 *   the switch saved off never follows under the default.
 *
 * `createThemePickSync` is the logic, apart from the browser so every case
 * can be tested; `startThemePickSync` builds the one the app runs.
 */
import type {
  EnvironmentId,
  ThemeBase,
  ThemeLibrarySnapshot,
  ThemePick,
  ThemePickInput,
  ThemePickTheme,
} from "@threadlines/contracts";
import {
  compareThemeRevisions,
  sameThemePickTheme,
  winningThemePick,
} from "@threadlines/shared/themeLibrary";
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

/** The device's notes, one storage key each so two windows never rewrite each other's. */
export const THEME_PICK_STORAGE_PREFIX = "threadlines:theme-pick:";
const KEY = {
  /** The newest pick this device has applied or shared. */
  seen: `${THEME_PICK_STORAGE_PREFIX}seen`,
  /** The newest pick any computer has shown it, kept when that computer drops off. */
  observed: `${THEME_PICK_STORAGE_PREFIX}observed`,
  /** The pick made here that no computer has taken yet. */
  pending: `${THEME_PICK_STORAGE_PREFIX}pending`,
  /** Ids of the picks this device sent: a pick carrying one is its own. */
  mine: `${THEME_PICK_STORAGE_PREFIX}mine`,
} as const;
/** The first build kept all of it under one key; its `seen` is carried over once. */
const LEGACY_STORAGE_KEY = "threadlines:theme-pick";
const MINE_LIMIT = 16;
/** A send that failed is tried again after this long, or at the user's next pick. */
export const THEME_PICK_RETRY_MS = 30_000;
/** The Web Lock the device's one runner holds. */
const LEAD_LOCK = "threadlines:theme-pick-sync";

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

/** A theme picked here, not yet taken by a computer. */
export interface PendingThemePick {
  /** Names this one choice: the pick sent for it carries it as `pickId`. */
  readonly id: string;
  /** Null only for a join by a device whose own theme can't be shared. */
  readonly theme: ThemePickTheme | null;
  /** The newest pick this device had been shown when the user picked; a newer one may overtake this. */
  readonly known: Revision | null;
  /** The switch turned on: the device takes the shared pick, or offers its own when there is none. */
  readonly join?: boolean;
}

export interface ThemePickSyncState {
  readonly seen: Revision | null;
  readonly observed: Revision | null;
  readonly pending: PendingThemePick | null;
  readonly mine: ReadonlyArray<string>;
}

/** What to do next, given where the device and its computers are. */
export type ThemePickStep =
  | { readonly kind: "wait" }
  | { readonly kind: "drop-pending" }
  /** The pending pick is the shared pick now: it came back carrying its id. */
  | { readonly kind: "landed"; readonly pick: ThemePick }
  | {
      readonly kind: "publish";
      readonly pending: PendingThemePick & { readonly theme: ThemePickTheme };
      readonly onlyIfNone: boolean;
    }
  | { readonly kind: "apply"; readonly pick: ThemePick; readonly clearPending: boolean };

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
  readonly state: Pick<ThemePickSyncState, "seen" | "pending" | "mine">;
}): ThemePickStep {
  const { state, winning } = input;
  if (!input.hydrated || input.bypass) return { kind: "wait" };
  if (!input.on) return state.pending === null ? { kind: "wait" } : { kind: "drop-pending" };
  const pending = state.pending;
  if (pending !== null && pending.join === true) {
    // Joining: the others' pick if they have one, else this device's own theme.
    if (!input.allReported) return { kind: "wait" };
    if (winning !== null) {
      return input.trialRunning
        ? { kind: "wait" }
        : { kind: "apply", pick: winning, clearPending: true };
    }
    if (pending.theme === null) return { kind: "drop-pending" };
    return input.canPublish
      ? { kind: "publish", pending: { ...pending, theme: pending.theme }, onlyIfNone: true }
      : { kind: "wait" };
  }
  if (pending !== null) {
    if (pending.theme === null) return { kind: "drop-pending" };
    if (winning !== null && winning.theme.pickId === pending.id) {
      return { kind: "landed", pick: winning };
    }
    const overtaken =
      winning !== null &&
      (pending.known === null || compareThemeRevisions(winning, pending.known) > 0) &&
      !(winning.theme.pickId !== undefined && state.mine.includes(winning.theme.pickId));
    if (overtaken) return { kind: "drop-pending" };
    return input.canPublish
      ? { kind: "publish", pending: { ...pending, theme: pending.theme }, onlyIfNone: false }
      : { kind: "wait" };
  }
  if (winning !== null && (state.seen === null || compareThemeRevisions(winning, state.seen) > 0)) {
    return input.trialRunning
      ? { kind: "wait" }
      : { kind: "apply", pick: winning, clearPending: false };
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
// The device's notes

type PickStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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

const pendingFrom = (value: unknown): PendingThemePick | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;
  const theme = pickThemeFrom(record.theme);
  const join = record.join === true;
  if (theme === null && !join) return null;
  return { id: record.id, theme, known: revisionOf(record.known), ...(join ? { join } : {}) };
};

function readJson(storage: PickStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** A full or refused storage loses the note; the sync carries on from what storage holds. */
function writeJson(storage: PickStorage | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing more to do here.
  }
}

export function readThemePickSyncState(storage: PickStorage | null): ThemePickSyncState {
  const mine = readJson(storage, KEY.mine);
  return {
    seen: revisionOf(readJson(storage, KEY.seen)),
    observed: revisionOf(readJson(storage, KEY.observed)),
    pending: pendingFrom(readJson(storage, KEY.pending)),
    mine: Array.isArray(mine) ? mine.filter((id): id is string => typeof id === "string") : [],
  };
}

// ---------------------------------------------------------------------------
// The logic

/** What the sync reads from the library: each followed computer's snapshot, and a way to pick on one. */
export interface ThemePickSyncLibrary {
  readonly followed: () => ReadonlyArray<EnvironmentId>;
  readonly snapshots: () => Readonly<Record<string, ThemeLibrarySnapshot>>;
  readonly pick: (environmentId: EnvironmentId, input: ThemePickInput) => Promise<ThemePick>;
}

export interface ThemePickSyncEnv {
  readonly storage: PickStorage | null;
  readonly now: () => number;
  /** Runs `callback` after `ms`; returns a cancel. */
  readonly setTimer: (callback: () => void, ms: number) => () => void;
  readonly randomId: () => string;
  /**
   * Asks to be the device's one runner; `lead` is called when this window is
   * (at once where windows can't take turns). Returns a way to give it up.
   */
  readonly requestLead: (lead: () => void) => () => void;
  readonly theme: {
    readonly state: () => {
      readonly bypass: boolean;
      readonly trialRunning: boolean;
      readonly committed: ThemeChoice;
      readonly committedBase: ThemeBase | null;
    };
    /** Commits another device's pick here; not announced as this device's own. */
    readonly applyPick: (choice: ThemeChoice, base: ThemeBase | null) => void;
  };
  readonly library: ThemePickSyncLibrary;
  readonly warn: (message: string, error: unknown) => void;
}

export interface ThemePickSync {
  /** Something changed (the library, the device's notes, a trial, the bypass): take the next steps. */
  readonly run: () => void;
  /** The user committed a theme in this window. */
  readonly userCommitted: (choice: ThemeChoice, base: ThemeBase | null) => void;
  /** The device's switch and whether settings have loaded; the switch turning on joins the others. */
  readonly setSettings: (settings: { readonly hydrated: boolean; readonly on: boolean }) => void;
  readonly stop: () => void;
}

export function createThemePickSync(env: ThemePickSyncEnv): ThemePickSync {
  const { storage } = env;
  let settings = { hydrated: false, on: true };
  /** The switch as it was when settings last loaded, to tell it turning on. */
  let loadedOn: boolean | null = null;
  let leader = false;
  /** Asked once: being given the lead runs the sync, which must not ask again. */
  let leadRequested = false;
  let releaseLead: (() => void) | null = null;
  let stopped = false;
  /** This window is sending a pick; one at a time. */
  let publishing = false;
  /** After a failed send, the next waits until then (epoch ms). */
  let publishAfter = 0;
  let cancelRetry: (() => void) | null = null;

  // The first build's single key: its `seen` carries over, so the pick this
  // device already shows isn't applied again.
  const legacy = readJson(storage, LEGACY_STORAGE_KEY) as Record<string, unknown> | null;
  if (legacy !== null) {
    const state = readThemePickSyncState(storage);
    if (state.seen === null) writeJson(storage, KEY.seen, revisionOf(legacy.seen));
    if (state.observed === null) writeJson(storage, KEY.observed, revisionOf(legacy.observed));
    writeJson(storage, LEGACY_STORAGE_KEY, null);
  }

  /** The winning pick, the computer to send to, and whether every followed computer has reported. */
  const picks = () => {
    const snapshots = env.library.snapshots();
    const followed = env.library.followed();
    const keeping = followed.filter((id) => snapshots[id]?.pick !== undefined);
    return {
      winning: winningThemePick(keeping.map((id) => snapshots[id]?.pick)),
      home: keeping[0] ?? null,
      allReported: followed.every((id) => snapshots[id] !== undefined),
    };
  };

  /** Clears the pending pick, unless another window has replaced it since it was read. */
  const clearPending = (id: string) => {
    if (pendingFrom(readJson(storage, KEY.pending))?.id === id) {
      writeJson(storage, KEY.pending, null);
    }
  };

  const noteObserved = (revision: Revision | null) => {
    const observed = revisionOf(readJson(storage, KEY.observed));
    const next = newerThemeRevision(observed, revision);
    if (JSON.stringify(next) !== JSON.stringify(observed)) writeJson(storage, KEY.observed, next);
  };

  const noteSeen = (revision: Revision) => {
    const seen = revisionOf(readJson(storage, KEY.seen));
    writeJson(storage, KEY.seen, newerThemeRevision(seen, revision));
  };

  /** Tries the pending send again once the wait after a failure is over. */
  const retryLater = () => {
    cancelRetry?.();
    cancelRetry = env.setTimer(
      () => {
        cancelRetry = null;
        run();
      },
      Math.max(0, publishAfter - env.now()),
    );
  };

  /** Sends a pending pick to the computer that keeps picks; one at a time. */
  const publish = (
    home: EnvironmentId,
    pending: PendingThemePick & { readonly theme: ThemePickTheme },
    onlyIfNone: boolean,
  ) => {
    if (publishing) return;
    if (env.now() < publishAfter) {
      if (cancelRetry === null) retryLater();
      return;
    }
    publishing = true;
    const state = readThemePickSyncState(storage);
    // Written down before it goes: when it comes back, even to another run, it is known as ours.
    if (!state.mine.includes(pending.id)) {
      writeJson(storage, KEY.mine, [...state.mine, pending.id].slice(-MINE_LIMIT));
    }
    const atLeast = Math.max(
      state.observed?.revision ?? 0,
      state.seen?.revision ?? 0,
      pending.known?.revision ?? 0,
    );
    // Inside a promise, so a send that throws at once (no connection) fails like any other.
    void Promise.resolve()
      .then(() =>
        env.library.pick(home, {
          theme: { ...pending.theme, pickId: pending.id },
          atLeast,
          ...(onlyIfNone ? { onlyIfNone: true } : {}),
        }),
      )
      .then(
        (picked) => {
          noteObserved(picked);
          // Dropped or replaced while it was out: the pick's own arrival decides what shows.
          if (pendingFrom(readJson(storage, KEY.pending))?.id !== pending.id) return;
          clearPending(pending.id);
          // The computer kept another pick (a join that found one): the next run takes that.
          if (sameThemePickTheme(picked.theme, pending.theme)) noteSeen(picked);
        },
        (error: unknown) => {
          publishAfter = env.now() + THEME_PICK_RETRY_MS;
          retryLater();
          env.warn("[themes] couldn't share the theme with your other devices", error);
        },
      )
      .finally(() => {
        publishing = false;
        run();
      });
  };

  function run(): void {
    if (stopped) return;
    // A window under `?theme=default` never runs the sync; one that leaves it asks to.
    if (!env.theme.state().bypass && !leadRequested) {
      leadRequested = true;
      releaseLead = env.requestLead(() => {
        leader = true;
        run();
      });
    }
    if (!leader) return;
    // At most a few steps a pass (drop, then apply); each changes the notes it reads.
    for (let pass = 0; pass < 4; pass++) {
      const { winning, home, allReported } = picks();
      // Remember the newest pick ever shown, even if its computer drops off before it counts.
      noteObserved(winning);
      const state = readThemePickSyncState(storage);
      const theme = env.theme.state();
      const step = nextThemePickStep({
        hydrated: settings.hydrated,
        on: settings.on,
        bypass: theme.bypass,
        trialRunning: theme.trialRunning,
        winning,
        canPublish: home !== null,
        allReported,
        state,
      });
      switch (step.kind) {
        case "wait":
          return;
        case "drop-pending":
          if (state.pending) clearPending(state.pending.id);
          continue;
        case "landed":
          if (state.pending) clearPending(state.pending.id);
          noteSeen(step.pick);
          continue;
        case "apply": {
          const shown = choiceOfPickTheme(step.pick.theme);
          if (shown && !sameThemeChoice(shown.choice, theme.committed)) {
            env.theme.applyPick(shown.choice, shown.base);
          }
          // A kind this build can't show is passed over, not retried forever.
          if (step.clearPending && state.pending) clearPending(state.pending.id);
          noteSeen(step.pick);
          continue;
        }
        case "publish":
          if (home !== null) publish(home, step.pending, step.onlyIfNone);
          return;
      }
    }
  }

  return {
    run,
    userCommitted: (choice, base) => {
      const theme = pickThemeOf(choice, base);
      const state = readThemePickSyncState(storage);
      if (theme === null) {
        // Kept on this device only: a pick still waiting to be shared is one the user moved on from.
        if (state.pending && state.pending.join !== true) clearPending(state.pending.id);
        return;
      }
      writeJson(storage, KEY.pending, {
        id: env.randomId(),
        theme,
        known: newerThemeRevision(state.observed, picks().winning),
      } satisfies PendingThemePick);
      // The user's pick goes at once, whatever an earlier failure is waiting out.
      publishAfter = 0;
      run();
    },
    setSettings: (next) => {
      settings = next;
      if (!next.hydrated) return;
      const before = loadedOn;
      loadedOn = next.on;
      if (before === false && next.on) {
        // The switch turned on: this device joins the others.
        const { committed, committedBase } = env.theme.state();
        writeJson(storage, KEY.pending, {
          id: env.randomId(),
          theme: pickThemeOf(committed, committedBase),
          known: null,
          join: true,
        } satisfies PendingThemePick);
      }
      run();
    },
    stop: () => {
      stopped = true;
      cancelRetry?.();
      cancelRetry = null;
      releaseLead?.();
      releaseLead = null;
      leader = false;
    },
  };
}

// ---------------------------------------------------------------------------
// The app's one

let active: ThemePickSync | null = null;
let currentSettings = { hydrated: false, on: true };

/** One window a device runs the sync: the holder of a Web Lock, or every window without them. */
function requestLead(lead: () => void): () => void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) {
    lead();
    return () => {};
  }
  let release: (() => void) | null = null;
  let given = false;
  void locks
    .request(LEAD_LOCK, () => {
      if (given) return undefined;
      lead();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => {
      // Locks refused (a private window): this window runs it alone.
      if (!given) lead();
    });
  return () => {
    given = true;
    release?.();
  };
}

/** Starts the sync over the given library; returns the way to stop it. */
export function startThemePickSync(
  library: ThemePickSyncLibrary & { readonly subscribe: (listener: () => void) => () => void },
): () => void {
  const sync = createThemePickSync({
    storage: typeof window === "undefined" ? null : window.localStorage,
    now: () => Date.now(),
    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    randomId: () => crypto.randomUUID(),
    requestLead,
    theme: {
      state: () => {
        const state = readThemeState();
        return {
          bypass: state.bypass,
          trialRunning: state.trial !== null,
          committed: state.committed,
          committedBase: state.committedBase,
        };
      },
      applyPick: applyThemePick,
    },
    library,
    warn: (message, error) => console.warn(message, error),
  });
  active = sync;
  sync.setSettings(currentSettings);
  // The store announces a commit before its own update lands: the sync reads it after.
  const stopCommits = subscribeUserThemeCommits((choice, base) =>
    queueMicrotask(() => sync.userCommitted(choice, base)),
  );
  const stopLibrary = library.subscribe(() => {
    // New content may have reached a computer: a theme that was nowhere may be there now.
    if (readThemeState().committedState.status === "unavailable") retryUnavailableTheme();
    sync.run();
  });
  // A trial ending lets a waiting pick apply, and leaving `?theme=default`
  // lets this window run the sync: after the commit's own listeners.
  let last = { trial: readThemeState().trial, bypass: readThemeState().bypass };
  const stopTheme = subscribeTheme(() => {
    const { trial, bypass } = readThemeState();
    if (trial === last.trial && bypass === last.bypass) return;
    last = { trial, bypass };
    queueMicrotask(sync.run);
  });
  // Another window wrote the device's notes (a pick the user made there, a join).
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(THEME_PICK_STORAGE_PREFIX)) sync.run();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    stopCommits();
    stopLibrary();
    stopTheme();
    window.removeEventListener("storage", onStorage);
    sync.stop();
    if (active === sync) active = null;
  };
}

/** Keeps the sync told about the device's switch and whether settings have loaded. */
export function useThemePickSyncSettings(): void {
  const hydrated = useClientSettingsHydrated();
  const on = useSettings((value) => value.themeSameEverywhere);
  useEffect(() => {
    currentSettings = { hydrated, on };
    active?.setSettings(currentSettings);
  }, [hydrated, on]);
}
