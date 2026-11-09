/**
 * "Same theme on all my devices" (docs/design/custom-themes.md, "Storage and
 * devices"). With the device's switch on, it shows the shared pick, the theme
 * last picked on any device with the switch on, and the themes the user
 * picks here become it.
 *
 * - The pick lives on every computer beside the library and is merged by
 *   revision order, like entries (themeLibraryState reconciles both).
 * - One window a device runs this (a Web Lock; every window where there are
 *   none). The device's notes are a storage key each with one writer: any
 *   window writes `pending` (the theme the user just picked in it) and
 *   nothing else; the runner writes the rest and never `pending`. It marks a
 *   pending pick finished by id (`done`) instead of removing it, so it can't
 *   erase a newer one another window wrote meanwhile.
 * - Following: a pick newer than the one this device last took is applied
 *   (applyPick), except while a trial runs in the runner's window (it waits)
 *   or under `?theme=default` (such a window never runs this). An older one
 *   never is. The pick last taken is remembered whole (`seen`): a computer
 *   that falls behind it is brought it, so a computer dropping off can
 *   neither roll the theme back nor leave this device apart from the others;
 *   and if the device shows another theme with nothing waiting to be shared
 *   (two windows crossed), it takes the pick again.
 * - Sharing: a theme the user commits (not a pick applied, not another
 *   window's commit) becomes the pending pick, with an id of its own, until a
 *   computer takes it, above every pick revision the device has been shown.
 *   The pick is sent carrying `<device>.<id>`: it has landed when the shared
 *   pick carries that, and a pick carrying the device's id is its own, never
 *   one that overtook it. It is dropped, and the newer pick followed, only
 *   when someone else's overtook it. A send that fails is tried again a
 *   little later. A theme kept on this device only isn't shared, and puts
 *   aside one waiting to be.
 * - The switch: turning it on joins the others, once every computer the
 *   device follows has reported. The device takes the shared pick; when
 *   there is none, its own theme becomes it, which the computer refuses if a
 *   pick got there first (`onlyIfNone`, on servers that know it). A pick made
 *   after turning it on goes instead. Turning it off puts aside what was
 *   waiting.
 * - Nothing happens until the client settings have loaded, so a device with
 *   the switch saved off never follows under the default.
 *
 * `createThemePickSync` is the logic, apart from the browser so every case
 * can be tested; `startThemePickSync` builds the one the app runs.
 */
import {
  type EnvironmentId,
  type ThemeBase,
  type ThemeLibrarySnapshot,
  type ThemeManifest,
  type ThemeMergePickInput,
  THEME_PICK_VERSION,
  type ThemePick,
  type ThemePickInput,
  type ThemePickTheme,
} from "@threadlines/contracts";
import {
  compareThemeRevisions,
  sameThemePickTheme,
  winningThemePick,
} from "@threadlines/shared/themeLibrary";
import { useEffect } from "react";

import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import { parseStoredThemeChoice } from "../theme/themeChoice";
import {
  adoptStoredThemeChoice,
  applyThemePick,
  readThemeState,
  retryUnavailableTheme,
  subscribeTheme,
  subscribeUserThemeCommits,
} from "../theme/themeStore";
import type { ThemeChoice } from "../theme/themeTypes";

/** The device's notes, one storage key each. */
export const THEME_PICK_STORAGE_PREFIX = "threadlines:theme-pick:";
const KEY = {
  /** Names this device in the picks it sends. The runner's. */
  device: `${THEME_PICK_STORAGE_PREFIX}device`,
  /** The pick this device last took or shared, whole. The runner's. */
  seen: `${THEME_PICK_STORAGE_PREFIX}seen`,
  /** The newest pick any computer has shown it. The runner's. */
  observed: `${THEME_PICK_STORAGE_PREFIX}observed`,
  /** The theme the user last picked, in whichever window. Any window's, and their only one. */
  pending: `${THEME_PICK_STORAGE_PREFIX}pending`,
  /** The switch turned on and the device hasn't joined the others yet. The runner's. */
  join: `${THEME_PICK_STORAGE_PREFIX}join`,
  /** Ids of pending picks and joins that are finished. The runner's. */
  done: `${THEME_PICK_STORAGE_PREFIX}done`,
  /** The switch as the runner last handled it, to tell it turning. The runner's. */
  on: `${THEME_PICK_STORAGE_PREFIX}on`,
} as const;
/** The first build kept all of it under one key; what it held is carried over once. */
const LEGACY_STORAGE_KEY = "threadlines:theme-pick";
const DONE_LIMIT = 64;
/** A send that failed is tried again after this long, or at the user's next pick. */
export const THEME_PICK_RETRY_MS = 30_000;
/** The Web Lock the device's one runner holds. */
const LEAD_LOCK = "threadlines:theme-pick-sync";

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

/** The pick this device last took: whole when this build took it, its revision alone from the first build. */
export type SeenThemePick = Revision & Partial<Pick<ThemePick, "theme" | "updatedAt">>;

/** The theme the user picked in some window, to be shared. */
export interface PendingThemePick {
  /** Names this one choice: the pick sent for it carries `<device>.<id>`. */
  readonly id: string;
  /** Null for a theme kept on this device only: nothing to share, and what was waiting is put aside. */
  readonly theme: ThemePickTheme | null;
  /** The newest pick this device had been shown when the user picked; a newer one may overtake this. */
  readonly known: Revision | null;
}

/** The switch turned on: the device is to take the shared pick, or offer its own theme when there is none. */
export interface ThemePickJoin {
  readonly id: string;
  /** Null when the device's own theme can't be shared. */
  readonly theme: ThemePickTheme | null;
}

export interface ThemePickSyncState {
  readonly device: string;
  readonly seen: SeenThemePick | null;
  /** The pending pick, unless it is finished. */
  readonly pending: PendingThemePick | null;
  /** The join, unless it is finished. */
  readonly join: ThemePickJoin | null;
}

/** What to do next, given where the device and its computers are. */
export type ThemePickStep =
  | { readonly kind: "wait" }
  /** A pending pick or a join is finished without anything to show for it. */
  | { readonly kind: "finish"; readonly id: string }
  /** The pending pick is the shared pick now: it came back carrying its id. */
  | { readonly kind: "landed"; readonly id: string; readonly pick: ThemePick }
  | {
      readonly kind: "publish";
      readonly id: string;
      readonly theme: ThemePickTheme;
      readonly known: Revision | null;
      readonly onlyIfNone: boolean;
    }
  /** Show this pick; `finish` names the join it completes. */
  | { readonly kind: "apply"; readonly pick: ThemePick; readonly finish?: string };

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

/** The pick this device remembers taking, when it remembers it whole. */
const wholeSeen = (seen: SeenThemePick | null): ThemePick | null =>
  seen !== null && seen.theme !== undefined
    ? {
        theme: seen.theme,
        revision: seen.revision,
        revisedBy: seen.revisedBy,
        updatedAt: seen.updatedAt ?? new Date(0).toISOString(),
      }
    : null;

/** The next step: pure, so every case is testable apart from the stores. */
export function nextThemePickStep(input: {
  /** Settings loaded; until then nothing happens. */
  readonly hydrated: boolean;
  /** The device's switch. */
  readonly on: boolean;
  /** `?theme=default`: this load shows System and must not change anything. */
  readonly bypass: boolean;
  readonly trialRunning: boolean;
  /** The newest pick the followed computers hold or have answered with. */
  readonly winning: ThemePick | null;
  /** Whether any followed computer keeps picks (a newer server). */
  readonly canPublish: boolean;
  /** Whether that computer refuses a joining device's theme when a pick is there (`onlyIfNone`). */
  readonly canOffer: boolean;
  /** Whether every followed computer has sent its library yet. */
  readonly allReported: boolean;
  /** What the device shows, as a pick's theme; null for a theme kept on this device only. */
  readonly shown: ThemePickTheme | null;
  readonly state: ThemePickSyncState;
}): ThemePickStep {
  const { state, winning } = input;
  if (!input.hydrated || input.bypass || !input.on) return { kind: "wait" };
  const { pending, join, seen } = state;
  const own = (pick: ThemePick) => pick.theme.pickId?.startsWith(`${state.device}.`) === true;
  if (pending !== null) {
    // The user picked a theme: that is shared, whatever joining would have done.
    if (join !== null) return { kind: "finish", id: join.id };
    if (pending.theme === null) return { kind: "finish", id: pending.id };
    if (winning !== null && winning.theme.pickId === `${state.device}.${pending.id}`) {
      return { kind: "landed", id: pending.id, pick: winning };
    }
    const overtaken =
      winning !== null &&
      (pending.known === null || compareThemeRevisions(winning, pending.known) > 0) &&
      !own(winning);
    if (overtaken) return { kind: "finish", id: pending.id };
    return input.canPublish
      ? {
          kind: "publish",
          id: pending.id,
          theme: pending.theme,
          known: pending.known,
          onlyIfNone: false,
        }
      : { kind: "wait" };
  }
  const remembered = wholeSeen(seen);
  if (join !== null) {
    // Joining: the newest pick the others hold or this device remembers; else its own theme.
    if (!input.allReported) return { kind: "wait" };
    const theirs =
      winning !== null && (remembered === null || compareThemeRevisions(winning, remembered) >= 0)
        ? winning
        : remembered;
    if (theirs !== null) {
      return input.trialRunning
        ? { kind: "wait" }
        : { kind: "apply", pick: theirs, finish: join.id };
    }
    if (join.theme === null) return { kind: "finish", id: join.id };
    return input.canOffer
      ? { kind: "publish", id: join.id, theme: join.theme, known: null, onlyIfNone: true }
      : { kind: "wait" };
  }
  if (winning !== null && (seen === null || compareThemeRevisions(winning, seen) > 0)) {
    return input.trialRunning ? { kind: "wait" } : { kind: "apply", pick: winning };
  }
  // The device shows another shareable theme than the pick it last took, with
  // nothing waiting to be shared: two windows crossed. It takes the pick again.
  if (
    remembered !== null &&
    input.shown !== null &&
    !sameThemePickTheme(input.shown, remembered.theme) &&
    choiceOfPickTheme(remembered.theme) !== null
  ) {
    return input.trialRunning ? { kind: "wait" } : { kind: "apply", pick: remembered };
  }
  return { kind: "wait" };
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

const seenFrom = (value: unknown): SeenThemePick | null => {
  const revision = revisionOf(value);
  if (revision === null) return null;
  const record = value as Record<string, unknown>;
  const theme = pickThemeFrom(record.theme);
  return {
    ...revision,
    ...(theme === null ? {} : { theme }),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
};

const noteId = (value: unknown): string | null => {
  const id = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : null;
  return typeof id === "string" && id !== "" ? id : null;
};

const pendingFrom = (value: unknown): PendingThemePick | null => {
  const id = noteId(value);
  if (id === null) return null;
  const record = value as Record<string, unknown>;
  return { id, theme: pickThemeFrom(record.theme), known: revisionOf(record.known) };
};

const joinFrom = (value: unknown): ThemePickJoin | null => {
  const id = noteId(value);
  return id === null
    ? null
    : { id, theme: pickThemeFrom((value as Record<string, unknown>).theme) };
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

// ---------------------------------------------------------------------------
// The logic

/** What the sync reads from the library: each followed computer's snapshot, and its pick RPCs. */
export interface ThemePickSyncLibrary {
  readonly followed: () => ReadonlyArray<EnvironmentId>;
  readonly snapshots: () => Readonly<Record<string, ThemeLibrarySnapshot>>;
  readonly pick: (environmentId: EnvironmentId, input: ThemePickInput) => Promise<ThemePick>;
  readonly mergePick: (
    environmentId: EnvironmentId,
    input: ThemeMergePickInput,
  ) => Promise<ThemePick>;
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
    /** The device's theme as storage has it now, not as this window last heard. */
    readonly state: () => {
      readonly bypass: boolean;
      readonly trialRunning: boolean;
      readonly committed: ThemeChoice;
      readonly committedBase: ThemeBase | null;
    };
    /** Commits another device's pick here; not announced as this device's own. */
    readonly applyPick: (choice: ThemeChoice, base: ThemeBase | null) => void;
    /** The content of a library theme this window holds (the one it shows), to send along with a pick. */
    readonly manifestOf: (hash: string) => ThemeManifest | null;
  };
  readonly library: ThemePickSyncLibrary;
  readonly warn: (message: string, error: unknown) => void;
}

export interface ThemePickSync {
  /** Something changed (the library, the device's notes, its theme, a trial): take the next steps. */
  readonly run: () => void;
  /**
   * The user committed a theme in this window. Written down at once, so no
   * window sees the device's new theme without the pick that goes with it.
   */
  readonly userCommitted: (choice: ThemeChoice, base: ThemeBase | null) => void;
  /** The device's switch and whether settings have loaded. */
  readonly setSettings: (settings: { readonly hydrated: boolean; readonly on: boolean }) => void;
  readonly stop: () => void;
}

export function createThemePickSync(env: ThemePickSyncEnv): ThemePickSync {
  const { storage } = env;
  let settings = { hydrated: false, on: true };
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
  /** What each computer last answered with: its pick then, at least as new as its snapshot's. */
  const answers = new Map<EnvironmentId, ThemePick>();
  /** Computers being brought the pick this device remembers, and when a failed one may be tried again. */
  const carrying = new Map<string, number | "sending">();

  // The first build's single key: what it held is carried over, so the pick
  // this device already shows isn't applied again and one it never sent still goes.
  const legacy = readJson(storage, LEGACY_STORAGE_KEY) as Record<string, unknown> | null;
  if (legacy !== null) {
    if (readJson(storage, KEY.seen) === null) {
      writeJson(storage, KEY.seen, revisionOf(legacy.seen));
    }
    if (readJson(storage, KEY.observed) === null) {
      writeJson(storage, KEY.observed, revisionOf(legacy.observed));
    }
    const unsent = legacy.pending as Record<string, unknown> | null | undefined;
    const theme = pickThemeFrom(unsent?.theme);
    if (theme !== null && unsent?.join !== true && readJson(storage, KEY.pending) === null) {
      writeJson(storage, KEY.pending, {
        id: env.randomId(),
        theme,
        known: revisionOf(unsent?.known),
      } satisfies PendingThemePick);
    }
    writeJson(storage, LEGACY_STORAGE_KEY, null);
  }

  const doneIds = (): ReadonlyArray<string> => {
    const done = readJson(storage, KEY.done);
    return Array.isArray(done) ? done.filter((id): id is string => typeof id === "string") : [];
  };
  const finish = (id: string) => {
    const done = doneIds();
    if (!done.includes(id)) writeJson(storage, KEY.done, [...done, id].slice(-DONE_LIMIT));
  };

  /** The device's id, made by the runner the first time it is needed. */
  const deviceId = (): string => {
    const stored = readJson(storage, KEY.device);
    if (typeof stored === "string" && stored !== "") return stored;
    writeJson(storage, KEY.device, env.randomId());
    // Read back: where two windows run this (no locks), both use the one that stuck.
    const kept = readJson(storage, KEY.device);
    return typeof kept === "string" && kept !== "" ? kept : env.randomId();
  };

  const readState = (): ThemePickSyncState => {
    const done = doneIds();
    const pending = pendingFrom(readJson(storage, KEY.pending));
    const join = joinFrom(readJson(storage, KEY.join));
    return {
      device: deviceId(),
      seen: seenFrom(readJson(storage, KEY.seen)),
      pending: pending !== null && !done.includes(pending.id) ? pending : null,
      join: join !== null && !done.includes(join.id) ? join : null,
    };
  };

  /** The newest pick the followed computers hold, where to send one, and what that computer understands. */
  const picks = () => {
    const snapshots = env.library.snapshots();
    const followed = env.library.followed();
    const keeping = followed.filter((id) => snapshots[id]?.pick !== undefined);
    const home = keeping[0] ?? null;
    return {
      keeping,
      winning: winningThemePick([
        ...keeping.map((id) => snapshots[id]?.pick),
        ...keeping.map((id) => answers.get(id)),
      ]),
      home,
      canOffer: home !== null && (snapshots[home]?.pickVersion ?? 1) >= THEME_PICK_VERSION,
      allReported: followed.every((id) => snapshots[id] !== undefined),
    };
  };

  const noteObserved = (revision: Revision | null) => {
    const observed = revisionOf(readJson(storage, KEY.observed));
    const next = newerThemeRevision(observed, revision);
    if (JSON.stringify(next) !== JSON.stringify(observed)) writeJson(storage, KEY.observed, next);
  };

  /** Remembers the pick the device now shows; only ever a newer one, or the same one whole. */
  const noteSeen = (pick: ThemePick) => {
    const seen = seenFrom(readJson(storage, KEY.seen));
    const order = seen === null ? 1 : compareThemeRevisions(pick, seen);
    if (order > 0 || (order === 0 && seen?.theme === undefined)) {
      writeJson(storage, KEY.seen, {
        theme: pick.theme,
        revision: pick.revision,
        revisedBy: pick.revisedBy,
        updatedAt: pick.updatedAt,
      } satisfies SeenThemePick);
    }
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

  /**
   * Sends a pick to the computer that keeps picks; one at a time. Its answer
   * is that computer's pick now, which the next run reads like a snapshot's:
   * landed, refused for one that was there, or overtaken.
   */
  const publish = (
    home: EnvironmentId,
    step: Extract<ThemePickStep, { readonly kind: "publish" }>,
    state: ThemePickSyncState,
  ) => {
    if (publishing) return;
    if (env.now() < publishAfter) {
      if (cancelRetry === null) retryLater();
      return;
    }
    publishing = true;
    const observed = revisionOf(readJson(storage, KEY.observed));
    const atLeast = Math.max(
      observed?.revision ?? 0,
      state.seen?.revision ?? 0,
      step.known?.revision ?? 0,
    );
    // Inside a promise, so a send that throws at once (no connection) fails like any other.
    void Promise.resolve()
      .then(() =>
        env.library.pick(home, {
          theme: { ...step.theme, pickId: `${state.device}.${step.id}` },
          atLeast,
          ...(step.onlyIfNone ? { onlyIfNone: true } : {}),
        }),
      )
      .then(
        (picked) => {
          answers.set(home, picked);
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

  /**
   * Brings the pick this device remembers to the followed computers when none
   * of them holds it (the computer that did dropped off before the others had
   * it), so this device and the devices on those computers show the same
   * again. Between computers that are both followed, the library's own
   * reconcile does this. A library theme goes with its content, which this
   * window has while it shows the theme; without it the pick waits.
   */
  const carry = (remembered: ThemePick, held: ReturnType<typeof picks>) => {
    if (held.winning !== null && compareThemeRevisions(held.winning, remembered) >= 0) return;
    const hash = remembered.theme.kind === "library" ? remembered.theme.hash : undefined;
    const manifest = hash === undefined ? null : env.theme.manifestOf(hash);
    if (hash !== undefined && manifest === null) return;
    for (const id of held.keeping) {
      const key = `${id}\0${remembered.revision}\0${remembered.revisedBy}`;
      const state = carrying.get(key);
      if (state === "sending" || (state !== undefined && env.now() < state)) continue;
      carrying.set(key, "sending");
      void Promise.resolve()
        .then(() =>
          env.library.mergePick(
            id,
            manifest === null ? { pick: remembered } : { pick: remembered, manifest },
          ),
        )
        .then(
          (kept) => {
            carrying.delete(key);
            answers.set(id, kept);
          },
          (error: unknown) => {
            carrying.set(key, env.now() + THEME_PICK_RETRY_MS);
            env.warn("[themes] couldn't bring the shared theme pick to a computer", error);
          },
        )
        .finally(run);
    }
  };

  /** The switch turning, as the runner sees it: once per turn, whichever window made it. */
  const handleSwitch = (shown: ThemePickTheme | null) => {
    const handled = readJson(storage, KEY.on);
    if (handled === settings.on) return;
    if (typeof handled === "boolean") {
      const state = readState();
      if (settings.on) {
        // Off to on. A pick made since (in a window that already knew) is what
        // the device shows and goes as it is; anything else waiting is from before.
        const fresh =
          state.pending !== null &&
          state.pending.theme !== null &&
          shown !== null &&
          sameThemePickTheme(state.pending.theme, shown);
        if (state.pending !== null && !fresh) finish(state.pending.id);
        if (!fresh) {
          writeJson(storage, KEY.join, {
            id: env.randomId(),
            theme: shown,
          } satisfies ThemePickJoin);
        }
      } else {
        // On to off: nothing picked before is shared later.
        if (state.pending !== null) finish(state.pending.id);
        if (state.join !== null) finish(state.join.id);
      }
    }
    writeJson(storage, KEY.on, settings.on);
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
    if (!leader || !settings.hydrated) return;
    // At most a few steps a pass (finish, then apply); each changes the notes it reads.
    for (let pass = 0; pass < 5; pass++) {
      const theme = env.theme.state();
      if (theme.bypass) return;
      const shown = pickThemeOf(theme.committed, theme.committedBase);
      handleSwitch(shown);
      const held = picks();
      // Remember the newest pick ever shown, even if its computer drops off before it counts.
      noteObserved(held.winning);
      const state = readState();
      if (settings.on) {
        const remembered = wholeSeen(state.seen);
        if (remembered !== null) carry(remembered, held);
      }
      const step = nextThemePickStep({
        hydrated: settings.hydrated,
        on: settings.on,
        bypass: theme.bypass,
        trialRunning: theme.trialRunning,
        winning: held.winning,
        canPublish: held.home !== null,
        canOffer: held.canOffer,
        allReported: held.allReported,
        shown,
        state,
      });
      switch (step.kind) {
        case "wait":
          return;
        case "finish":
          finish(step.id);
          continue;
        case "landed":
          finish(step.id);
          noteSeen(step.pick);
          continue;
        case "apply": {
          const next = choiceOfPickTheme(step.pick.theme);
          // A kind this build can't show is passed over, not retried forever.
          if (next !== null && (shown === null || !sameThemePickTheme(shown, step.pick.theme))) {
            env.theme.applyPick(next.choice, next.base);
          }
          if (step.finish !== undefined) finish(step.finish);
          noteSeen(step.pick);
          continue;
        }
        case "publish":
          if (held.home !== null) publish(held.home, step, state);
          return;
      }
    }
  }

  return {
    run,
    userCommitted: (choice, base) => {
      // Not while the switch is off or unknown: nothing picked then is shared later.
      if (!settings.hydrated || !settings.on) return;
      writeJson(storage, KEY.pending, {
        id: env.randomId(),
        theme: pickThemeOf(choice, base),
        known: newerThemeRevision(revisionOf(readJson(storage, KEY.observed)), picks().winning),
      } satisfies PendingThemePick);
      // The user's pick goes at once, whatever an earlier failure is waiting out.
      publishAfter = 0;
    },
    setSettings: (next) => {
      settings = next;
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
    // Not crypto.randomUUID: a phone on plain http has none.
    randomId: randomUUID,
    requestLead,
    theme: {
      state: () => {
        // Another window's commit may be in storage with its event still on the way.
        adoptStoredThemeChoice();
        const state = readThemeState();
        return {
          bypass: state.bypass,
          trialRunning: state.trial !== null,
          committed: state.committed,
          committedBase: state.committedBase,
        };
      },
      applyPick: applyThemePick,
      manifestOf: (hash) => {
        const { active } = readThemeState();
        return active.hash === hash ? active.manifest : null;
      },
    },
    library,
    warn: (message, error) => console.warn(message, error),
  });
  active = sync;
  sync.setSettings(currentSettings);
  // Written down as the commit is announced, right after the store saved the
  // theme; the run waits for the store's own update to land.
  const stopCommits = subscribeUserThemeCommits((choice, base) => {
    sync.userCommitted(choice, base);
    queueMicrotask(sync.run);
  });
  const stopLibrary = library.subscribe(() => {
    // New content may have reached a computer: a theme that was nowhere may be there now.
    if (readThemeState().committedState.status === "unavailable") retryUnavailableTheme();
    sync.run();
  });
  // The device's theme changing (another window's commit), a trial ending or
  // `?theme=default` ending may each leave something to do: after the
  // change's own listeners.
  let last = readThemeState();
  const stopTheme = subscribeTheme(() => {
    const state = readThemeState();
    const same =
      state.trial === last.trial &&
      state.bypass === last.bypass &&
      state.committed === last.committed;
    last = state;
    if (!same) queueMicrotask(sync.run);
  });
  // Another window wrote the device's notes (a pick the user made there).
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
