/**
 * "Same theme on all my devices" (docs/design/custom-themes.md, "Storage and
 * devices"). With the device's switch on, it shows the shared pick, the theme
 * last picked on any device with the switch on, and the themes the user
 * picks here become it.
 *
 * The pick lives on every computer beside the library and is merged by
 * revision order, like entries (themeLibraryState reconciles both). What a
 * device knows of it is one note in storage, shared by its windows, always in
 * one of four states:
 *
 * - `taken`: the device shows this pick. A newer one is taken when it comes.
 * - `unsent`: the user picked a theme here with the switch on, and no
 *   computer has it yet. Its window sends it, above every pick it knew, one
 *   send at a time, and tries again after a failure. If that window is gone
 *   (15 seconds without an attempt), any other sends it, also after a reload.
 *   The pick is done when the shared pick carries its id. It gives way only
 *   when it couldn't be sent for a minute and someone else picked meanwhile.
 * - `local`: the user's own theme with the switch on, not shared: one kept on
 *   this device only, or picked before the settings had loaded. A pick newer
 *   than what was known then is still taken, except the device's own earlier
 *   pick landing late (`past`).
 * - `off`: the switch is off. Nothing is sent or taken.
 *
 * The note is written before the device's theme whenever the user picks, so
 * no window sees the new theme under the old note. Every window runs the same
 * rules on the same note and comes to the same step, so none is in charge and
 * a step taken twice changes nothing.
 *
 * A window that sees the switch off writes `off`. A window that sees it turn
 * on joins, if the note still says `off`: it takes the shared pick once every
 * computer has reported, or stays as it is when there is none. It never
 * offers the device's own theme, which is shared the next time the user
 * picks. A note another window has already moved on from `off` is left alone,
 * so a window that hears of the switch late undoes nothing. Nothing happens
 * until the client settings have loaded, or in a window under `?theme=default`.
 *
 * Left as they are, on purpose:
 * - A device that took a pick from a computer which dropped off before the
 *   other computers had it ignores their older picks until that computer is
 *   back or someone picks again.
 * - Two windows writing the note in the same instant (the user picks in one
 *   as a pick from elsewhere arrives in the other) leave one of the two
 *   standing, whichever wrote last. Storage has no way to write both in
 *   order, and the next pick anywhere puts it right.
 * - A window still holding the old value of the switch for the moment after
 *   it changed in another acts on that value until it hears.
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
import { randomUUID } from "../lib/utils";
import { parseStoredThemeChoice, sameThemeChoice } from "../theme/themeChoice";
import {
  adoptStoredThemeChoice,
  applyThemePick,
  readThemeState,
  retryUnavailableTheme,
  subscribeTheme,
  subscribeUserThemeCommits,
} from "../theme/themeStore";
import type { ThemeChoice } from "../theme/themeTypes";

/** The device's note. */
export const THEME_PICK_NOTE_KEY = "threadlines:theme-pick:note";
/** The first build's key: the pick it showed is carried over once. */
const LEGACY_STORAGE_KEY = "threadlines:theme-pick";
/** A send that failed is tried again after this long, or at the user's next pick. */
export const THEME_PICK_RETRY_MS = 30_000;
/** A window sending a pick is left to it this long after each attempt before another takes over. */
export const THEME_PICK_CLAIM_MS = 15_000;
/** A pick that couldn't be sent for this long gives way to one made elsewhere since. */
export const THEME_PICK_FRESH_MS = 60_000;

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

export type ThemePickNote =
  | ({ readonly state: "taken" } & Revision)
  | {
      readonly state: "local";
      /** The newest pick the device knew when the user chose this theme. */
      readonly known: Revision | null;
      /** The pick this device still had on its way then: no news when it lands. */
      readonly past?: string;
    }
  | { readonly state: "off" }
  | {
      readonly state: "unsent";
      /** Names this one choice: the pick sent for it carries it as `pickId`. */
      readonly id: string;
      readonly theme: ThemePickTheme;
      /** The newest pick the device knew when the user picked. */
      readonly known: Revision | null;
      /** When the user picked (epoch ms). */
      readonly since: number;
      /** When a window last set about sending it. */
      readonly at: number;
    };

type UnsentNote = Extract<ThemePickNote, { readonly state: "unsent" }>;

/** What a window does next, given the note and what the computers hold. */
export type ThemePickStep =
  /** Nothing now; `until` is when to look again without being told (a claim or a wait running out). */
  | { readonly kind: "wait"; readonly until?: number }
  /** Show this pick and note it as taken. */
  | { readonly kind: "take"; readonly pick: ThemePick }
  /** Set about sending the unsent pick. */
  | { readonly kind: "send"; readonly note: UnsentNote }
  /** The switch turned on and there is no shared pick to take: joined as it is. */
  | { readonly kind: "joined" };

const revisionOf = (value: unknown): Revision | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Revision).revision === "number" &&
  typeof (value as Revision).revisedBy === "string"
    ? { revision: (value as Revision).revision, revisedBy: (value as Revision).revisedBy }
    : null;

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

/** The newest pick a note says the device knew: one newer than this is news. */
const knownBy = (note: ThemePickNote | null): Revision | null =>
  note === null || note.state === "off"
    ? null
    : note.state === "taken"
      ? revisionOf(note)
      : note.known;

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
  /** Whether every followed computer has sent its library yet. */
  readonly allReported: boolean;
  /** What the device shows, as a pick's theme; null for a theme kept on this device only. */
  readonly shown: ThemePickTheme | null;
  readonly note: ThemePickNote | null;
  /** This window saw the switch turn on and the note still says `off`. */
  readonly joining: boolean;
  /** The unsent pick made in this window, which it sends without waiting on anyone. */
  readonly mine: string | null;
  /** The pick this window is sending right now; the next goes after its answer. */
  readonly sending: string | null;
  /** When this window may send again after a failure (epoch ms). */
  readonly retryAt: number;
  readonly now: number;
}): ThemePickStep {
  const { note, winning, now } = input;
  if (!input.hydrated || input.bypass || !input.on) return { kind: "wait" };
  /** Showing a pick ends a trial, so it waits for one; noting a pick the device already shows doesn't. */
  const take = (pick: ThemePick): ThemePickStep =>
    input.trialRunning && (input.shown === null || !sameThemePickTheme(input.shown, pick.theme))
      ? { kind: "wait" }
      : { kind: "take", pick };
  if (note !== null && note.state === "off") {
    // Only a window that saw the switch turn on joins, and only once every computer has reported.
    if (!input.joining || !input.allReported) return { kind: "wait" };
    return winning === null ? { kind: "joined" } : take(winning);
  }
  if (note !== null && note.state === "unsent") {
    if (winning !== null && winning.theme.pickId === note.id) return take(winning);
    // One send at a time from a window, so its picks reach the computer in the order they were made.
    if (input.sending !== null) return { kind: "wait" };
    // Another window set about it lately: it is left to it.
    if (input.mine !== note.id && now < note.at + THEME_PICK_CLAIM_MS) {
      return { kind: "wait", until: note.at + THEME_PICK_CLAIM_MS };
    }
    const overtaken =
      winning !== null &&
      (note.known === null || compareThemeRevisions(winning, note.known) > 0) &&
      now - note.since > THEME_PICK_FRESH_MS;
    if (overtaken) return take(winning);
    if (!input.canPublish) return { kind: "wait" };
    if (now < input.retryAt) return { kind: "wait", until: input.retryAt };
    return { kind: "send", note };
  }
  const known = knownBy(note);
  if (winning !== null && (known === null || compareThemeRevisions(winning, known) > 0)) {
    // The device's own earlier pick, landing after the user chose a theme to keep here.
    if (note?.state === "local" && note.past !== undefined && winning.theme.pickId === note.past) {
      return { kind: "wait" };
    }
    return take(winning);
  }
  return { kind: "wait" };
}

// ---------------------------------------------------------------------------
// The note

type PickStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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

export function readThemePickNote(storage: PickStorage | null): ThemePickNote | null {
  const value = readJson(storage, THEME_PICK_NOTE_KEY);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.state === "taken") {
    const revision = revisionOf(record);
    return revision === null ? null : { state: "taken", ...revision };
  }
  if (record.state === "off") return { state: "off" };
  if (record.state === "local") {
    return {
      state: "local",
      known: revisionOf(record.known),
      ...(typeof record.past === "string" && record.past !== "" ? { past: record.past } : {}),
    };
  }
  if (record.state === "unsent") {
    const theme = record.theme as ThemePickTheme | null | undefined;
    if (
      typeof record.id !== "string" ||
      record.id === "" ||
      typeof theme !== "object" ||
      theme === null ||
      typeof theme.kind !== "string" ||
      typeof record.since !== "number" ||
      typeof record.at !== "number"
    ) {
      return null;
    }
    return {
      state: "unsent",
      id: record.id,
      theme,
      known: revisionOf(record.known),
      since: record.since,
      at: record.at,
    };
  }
  return null;
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
  };
  readonly library: ThemePickSyncLibrary;
  readonly warn: (message: string, error: unknown) => void;
}

export interface ThemePickSync {
  /** Something changed (the library, the note, the device's theme, a trial): take the next steps. */
  readonly run: () => void;
  /**
   * The user is committing a theme in this window. Called before the theme is
   * written, so the note for it is there first; `run` follows once it is.
   */
  readonly userCommitted: (choice: ThemeChoice, base: ThemeBase | null) => void;
  /** The device's switch and whether settings have loaded. */
  readonly setSettings: (settings: { readonly hydrated: boolean; readonly on: boolean }) => void;
  readonly stop: () => void;
}

export function createThemePickSync(env: ThemePickSyncEnv): ThemePickSync {
  const { storage } = env;
  let settings = { hydrated: false, on: true };
  let stopped = false;
  let joining = false;
  let mine: string | null = null;
  let sending: string | null = null;
  let retryAt = 0;
  let cancelWake: (() => void) | null = null;
  /** What each computer last answered with: its pick then, at least as new as its snapshot's. */
  const answers = new Map<EnvironmentId, ThemePick>();

  // The first build's key: the pick the device took then isn't taken again.
  // A pick it had not sent yet is not carried over.
  const legacy = readJson(storage, LEGACY_STORAGE_KEY) as Record<string, unknown> | null;
  if (legacy !== null) {
    const seen = revisionOf(legacy.seen);
    if (seen !== null && readThemePickNote(storage) === null) {
      writeJson(storage, THEME_PICK_NOTE_KEY, { state: "taken", ...seen } satisfies ThemePickNote);
    }
    writeJson(storage, LEGACY_STORAGE_KEY, null);
  }

  /** The newest pick the followed computers hold, and where to send one. */
  const picks = () => {
    const snapshots = env.library.snapshots();
    const followed = env.library.followed();
    const keeping = followed.filter((id) => snapshots[id]?.pick !== undefined);
    return {
      winning: winningThemePick([
        ...keeping.map((id) => snapshots[id]?.pick),
        ...keeping.map((id) => answers.get(id)),
      ]),
      home: keeping[0] ?? null,
      allReported: followed.every((id) => snapshots[id] !== undefined),
    };
  };

  const note = (value: ThemePickNote) => writeJson(storage, THEME_PICK_NOTE_KEY, value);

  /** Looks again at `until`, for a step no event will announce. */
  const wakeAt = (until: number) => {
    cancelWake?.();
    cancelWake = env.setTimer(
      () => {
        cancelWake = null;
        run();
      },
      Math.max(0, until - env.now()),
    );
  };

  /** Sends the unsent pick. Its answer is that computer's pick now, read like its snapshot. */
  const send = (home: EnvironmentId, unsent: UnsentNote, winning: ThemePick | null) => {
    sending = unsent.id;
    // Claimed: other windows leave it to this one for a while.
    note({ ...unsent, at: env.now() });
    const atLeast = Math.max(unsent.known?.revision ?? 0, winning?.revision ?? 0);
    // Inside a promise, so a send that throws at once (no connection) fails like any other.
    void Promise.resolve()
      .then(() =>
        env.library.pick(home, { theme: { ...unsent.theme, pickId: unsent.id }, atLeast }),
      )
      .then(
        (picked) => {
          const before = answers.get(home);
          if (before === undefined || compareThemeRevisions(picked, before) > 0) {
            answers.set(home, picked);
          }
          // The computer already held that theme, picked above what this device knew: taken as it is.
          const current = readThemePickNote(storage);
          if (
            current?.state === "unsent" &&
            current.id === unsent.id &&
            picked.theme.pickId !== unsent.id &&
            sameThemePickTheme(picked.theme, unsent.theme)
          ) {
            note({ state: "taken", revision: picked.revision, revisedBy: picked.revisedBy });
          }
        },
        (error: unknown) => {
          // Only this pick waits: one the user made since goes at once.
          const current = readThemePickNote(storage);
          if (current?.state === "unsent" && current.id === unsent.id) {
            retryAt = env.now() + THEME_PICK_RETRY_MS;
          }
          env.warn("[themes] couldn't share the theme with your other devices", error);
        },
      )
      .finally(() => {
        sending = null;
        run();
      });
  };

  function run(): void {
    if (stopped) return;
    // At most a few steps a pass; each changes what the next reads.
    for (let pass = 0; pass < 4; pass++) {
      const theme = env.theme.state();
      const held = picks();
      const current = readThemePickNote(storage);
      // Another window joined already, or the user picked since: nothing left to join.
      if (current?.state !== "off") joining = false;
      const step = nextThemePickStep({
        hydrated: settings.hydrated,
        on: settings.on,
        bypass: theme.bypass,
        trialRunning: theme.trialRunning,
        winning: held.winning,
        canPublish: held.home !== null,
        allReported: held.allReported,
        shown: pickThemeOf(theme.committed, theme.committedBase),
        note: current,
        joining,
        mine,
        sending,
        retryAt,
        now: env.now(),
      });
      switch (step.kind) {
        case "wait":
          if (step.until !== undefined) wakeAt(step.until);
          return;
        case "joined":
          joining = false;
          // No shared pick: the device's theme stays, and the first pick from anywhere is news.
          note({ state: "local", known: null });
          continue;
        case "take": {
          joining = false;
          // The note first, then the theme: a window between the two sees the pick already taken.
          note({
            state: "taken",
            revision: step.pick.revision,
            revisedBy: step.pick.revisedBy,
          });
          const next = choiceOfPickTheme(step.pick.theme);
          // A kind this build can't show is noted and passed over, not retried forever.
          if (next !== null && !sameThemeChoice(next.choice, theme.committed)) {
            env.theme.applyPick(next.choice, next.base);
          }
          continue;
        }
        case "send":
          if (held.home !== null) send(held.home, step.note, held.winning);
          return;
      }
    }
  }

  return {
    run,
    userCommitted: (choice, base) => {
      const before = readThemePickNote(storage);
      mine = null;
      if (settings.hydrated && !settings.on) {
        note({ state: "off" });
        return;
      }
      const theme = pickThemeOf(choice, base);
      const known = newerThemeRevision(knownBy(before), picks().winning);
      if (theme === null || !settings.hydrated) {
        // Kept on this device, or picked before the switch is known: not shared.
        const past =
          before?.state === "unsent"
            ? before.id
            : before?.state === "local"
              ? before.past
              : undefined;
        note({ state: "local", known, ...(past === undefined ? {} : { past }) });
        return;
      }
      const id = env.randomId();
      const now = env.now();
      note({ state: "unsent", id, theme, known, since: now, at: now });
      mine = id;
      // The user's pick goes at once, whatever an earlier failure is waiting out.
      retryAt = 0;
    },
    setSettings: (next) => {
      const was = settings;
      settings = next;
      if (next.hydrated && !next.on) {
        // The switch is off, as this window sees for itself: the device leaves the shared pick.
        joining = false;
        if (readThemePickNote(storage)?.state !== "off") note({ state: "off" });
      } else if (next.hydrated && !(was.hydrated && was.on)) {
        // It turned on, or this window is new: it joins if the note still says off.
        joining = true;
      }
      run();
    },
    stop: () => {
      stopped = true;
      cancelWake?.();
      cancelWake = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The app's one

let active: ThemePickSync | null = null;
let currentSettings = { hydrated: false, on: true };

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
    },
    library,
    warn: (message, error) => console.warn(message, error),
  });
  active = sync;
  sync.setSettings(currentSettings);
  // The store announces a commit before it writes the theme: the note goes
  // first, and the run waits for the store's own update to land.
  const stopCommits = subscribeUserThemeCommits((choice, base) => {
    sync.userCommitted(choice, base);
    queueMicrotask(sync.run);
  });
  const stopLibrary = library.subscribe(() => {
    // New content may have reached a computer: a theme that was nowhere may be there now.
    if (readThemeState().committedState.status === "unavailable") retryUnavailableTheme();
    sync.run();
  });
  // A trial ending or `?theme=default` ending may let a waiting pick be taken:
  // after the change's own listeners.
  let last = readThemeState();
  const stopTheme = subscribeTheme(() => {
    const state = readThemeState();
    const same = state.trial === last.trial && state.bypass === last.bypass;
    last = state;
    if (!same) queueMicrotask(sync.run);
  });
  // Another window wrote the note (a pick the user made there, or one it took).
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_PICK_NOTE_KEY) sync.run();
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
