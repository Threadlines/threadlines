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
 *   computer has it yet. Its window sends it, above every pick it has heard
 *   of, one send at a time, and tries again after a failure. If that window
 *   is gone (15 seconds without an attempt), any other sends it, also after a
 *   reload. The pick is done when a computer answers for it or the shared
 *   pick carries its id. It gives way only when it couldn't be sent for a
 *   minute and someone else picked meanwhile.
 * - `local`: the user's own theme with the switch on, not shared: one kept on
 *   this device only, or picked before the settings had loaded. A pick newer
 *   than what was known then is still taken.
 * - `off`: the switch is off. Nothing is sent or taken.
 *
 * Every note also carries `past`, the ids of the last 32 picks this device
 * made. A send can land late (a slow connection, a second attempt, another
 * window's), so one of them can come back as the newest shared pick. That is
 * never news: the device sends what it shows again, above it, or just keeps a
 * theme that is its own. So every pick needs an id of its own on the
 * computer: one answered with someone else's pick of the same theme goes
 * again, above that.
 *
 * The note is written before the device's theme whenever the user picks, so
 * no window sees the new theme under the old note. Every window runs the same
 * rules on the same note and comes to the same step, so none is in charge and
 * a step taken twice changes nothing.
 *
 * A window that sees the switch off writes `off`. With the switch on, a note
 * that says `off` means the device joins: it takes the shared pick once every
 * computer has reported, or stays as it is when there is none. It never
 * offers the device's own theme, which is shared the next time the user
 * picks. A note that went `off` in the last few seconds waits first, since a
 * window that hadn't heard of the switch yet may have written it. Nothing
 * happens until the client settings have loaded, or in a window under
 * `?theme=default`.
 *
 * Left as they are, on purpose:
 * - A device that took a pick from a computer which dropped off before the
 *   other computers had it ignores their older picks until that computer is
 *   back or someone picks again.
 * - A send that failed may still have landed. Sent again within the minute,
 *   it goes above a pick someone made elsewhere in between.
 * - Two windows writing the note in the same instant (the user picks in one
 *   as a pick from elsewhere arrives in the other) leave one of the two
 *   standing, whichever wrote last. Storage can't write both in order. A
 *   window showing a pick looks again before it notes it, which leaves only
 *   the instant between that look and the write.
 * - A window acts on the switch as it has it. In the moment before it hears
 *   of a change made in another window, a theme picked in it is shared or
 *   kept by the old value.
 * - What the device shows again over its own late pick is a pick like any
 *   other: it also goes above one made elsewhere in that same moment.
 * - A send still out after more than 32 later picks is no longer known as
 *   the device's own when it lands.
 * - A trial is one window's. A pick from elsewhere waits for a trial in the
 *   window that would apply it; applied by another window of the device, it
 *   ends the trial like any theme change there does.
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
/** The first build's key: what it held is carried over once. */
const LEGACY_STORAGE_KEY = "threadlines:theme-pick";
/** A send that failed is tried again after this long, or at the user's next pick. */
export const THEME_PICK_RETRY_MS = 30_000;
/**
 * A send is given this long: its window sends nothing else meanwhile, and
 * other windows leave the pick to it. After it, the send counts as lost.
 */
export const THEME_PICK_CLAIM_MS = 15_000;
/** A pick that couldn't be sent for this long gives way to one made elsewhere since. */
export const THEME_PICK_FRESH_MS = 60_000;
/** A note that went `off` this recently may be from a window behind on the switch: joining waits it out. */
export const THEME_PICK_SETTLE_MS = 5_000;
/** How many of the device's earlier pick ids a note remembers. */
const PAST_PICKS = 32;

type Revision = Pick<ThemePick, "revision" | "revisedBy">;

export type ThemePickNote = (
  | ({ readonly state: "taken" } & Revision)
  | {
      readonly state: "local";
      /** The newest pick the device knew when the user chose this theme. */
      readonly known: Revision | null;
    }
  | {
      readonly state: "off";
      /** When a window wrote it (epoch ms). */
      readonly at: number;
    }
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
    }
) & {
  /** The ids of picks this device made before, newest last. */
  readonly past?: ReadonlyArray<string>;
};

type UnsentNote = Extract<ThemePickNote, { readonly state: "unsent" }>;

/** What a window does next, given the note and what the computers hold. */
export type ThemePickStep =
  /** Nothing now; `until` is when to look again without being told (a wait running out). */
  | { readonly kind: "wait"; readonly until?: number }
  /** Show this pick and note it as taken. */
  | { readonly kind: "take"; readonly pick: ThemePick }
  /** Set about sending the unsent pick. */
  | { readonly kind: "send"; readonly note: UnsentNote }
  /** The device's own earlier pick came back as the newest: what it shows goes out again, above it. */
  | { readonly kind: "again"; readonly over: ThemePick }
  /** The switch is on and there is no shared pick to take: joined as it is. */
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

/** What the note replacing `note` remembers of the device's earlier picks: `note`'s, and its own id. */
function pastAfter(note: ThemePickNote | null): { readonly past?: ReadonlyArray<string> } {
  const ids = note?.state === "unsent" ? [...(note.past ?? []), note.id] : (note?.past ?? []);
  return ids.length === 0 ? {} : { past: ids.slice(-PAST_PICKS) };
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

/** The next step: pure, so every case is testable apart from the stores. */
export function nextThemePickStep(input: {
  /** Settings loaded; until then nothing happens. */
  readonly hydrated: boolean;
  /** The device's switch, as this window has it. */
  readonly on: boolean;
  /** `?theme=default`: this load shows System and must not change anything. */
  readonly bypass: boolean;
  /** A trial runs in this window. */
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
  /** The unsent pick made in this window, which it sends without waiting on anyone. */
  readonly mine: string | null;
  /** While this window has a send out, when that send counts as lost (epoch ms); else null. */
  readonly sendingUntil: number | null;
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
  /** One of this device's earlier picks, landed late. */
  const ownAgain = (pick: ThemePick) =>
    pick.theme.pickId !== undefined && (note?.past ?? []).includes(pick.theme.pickId);
  if (note !== null && note.state === "off") {
    // The switch is on here: the device joins. A window behind on the switch may have just written this.
    const settled = note.at + THEME_PICK_SETTLE_MS;
    if (now < settled) return { kind: "wait", until: settled };
    if (!input.allReported) return { kind: "wait" };
    return winning === null ? { kind: "joined" } : take(winning);
  }
  if (note !== null && note.state === "unsent") {
    if (winning !== null && winning.theme.pickId === note.id) return take(winning);
    // One send at a time from a window, so its picks reach the computer in the order they were made.
    if (input.sendingUntil !== null && now < input.sendingUntil) {
      return { kind: "wait", until: input.sendingUntil };
    }
    // Another window set about it lately: it is left to it.
    if (input.mine !== note.id && now < note.at + THEME_PICK_CLAIM_MS) {
      return { kind: "wait", until: note.at + THEME_PICK_CLAIM_MS };
    }
    const overtaken =
      winning !== null &&
      !ownAgain(winning) &&
      (note.known === null || compareThemeRevisions(winning, note.known) > 0) &&
      now - note.since > THEME_PICK_FRESH_MS;
    if (overtaken) return take(winning);
    if (!input.canPublish) return { kind: "wait" };
    if (now < input.retryAt) return { kind: "wait", until: input.retryAt };
    return { kind: "send", note };
  }
  const known = knownBy(note);
  if (winning !== null && (known === null || compareThemeRevisions(winning, known) > 0)) {
    if (ownAgain(winning)) {
      // Not news. A pick the device shows goes out again above it; a theme of its own just stays.
      return note?.state === "taken" && input.shown !== null && input.canPublish
        ? { kind: "again", over: winning }
        : { kind: "wait" };
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

/** A stored pick's theme, as far as this needs to know it: an object with a kind. */
const pickThemeIn = (value: unknown): ThemePickTheme | null =>
  typeof value === "object" && value !== null && typeof (value as ThemePickTheme).kind === "string"
    ? (value as ThemePickTheme)
    : null;

export function readThemePickNote(storage: PickStorage | null): ThemePickNote | null {
  const value = readJson(storage, THEME_PICK_NOTE_KEY);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const ids = Array.isArray(record.past)
    ? record.past.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  const past = ids.length === 0 ? {} : { past: ids.slice(-PAST_PICKS) };
  if (record.state === "taken") {
    const revision = revisionOf(record);
    return revision === null ? null : { state: "taken", ...revision, ...past };
  }
  if (record.state === "local") {
    return { state: "local", known: revisionOf(record.known), ...past };
  }
  if (record.state === "off") {
    return { state: "off", at: typeof record.at === "number" ? record.at : 0, ...past };
  }
  if (record.state === "unsent") {
    const theme = pickThemeIn(record.theme);
    if (
      typeof record.id !== "string" ||
      record.id === "" ||
      theme === null ||
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
      ...past,
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
  /** The device's switch and whether settings have loaded, as this window has them. */
  readonly setSettings: (settings: { readonly hydrated: boolean; readonly on: boolean }) => void;
  readonly stop: () => void;
}

export function createThemePickSync(env: ThemePickSyncEnv): ThemePickSync {
  const { storage } = env;
  let settings = { hydrated: false, on: true };
  let stopped = false;
  let mine: string | null = null;
  /** This window's send that is out, and when it went. */
  let sending: { readonly id: string; readonly at: number } | null = null;
  let retryAt = 0;
  let cancelWake: (() => void) | null = null;
  /** What each computer last answered with: its pick then, at least as new as its snapshot's. */
  const answers = new Map<EnvironmentId, ThemePick>();
  /**
   * The newest pick this window has heard of from any computer, kept when that
   * computer drops off: the user's next pick still goes above it.
   */
  let heard: Revision | null = null;

  const note = (value: ThemePickNote) => writeJson(storage, THEME_PICK_NOTE_KEY, value);
  /** The note as storage holds it, to tell whether another window has written it since. */
  const noteText = () => {
    try {
      return storage?.getItem(THEME_PICK_NOTE_KEY) ?? null;
    } catch {
      return null;
    }
  };

  // The first build's key. The pick the device took then isn't taken again. A
  // pick it hadn't sent yet goes on from here, for any window to send: its age
  // isn't known, so a pick newer than it knew comes first. (Its own theme
  // waiting to be offered on joining is dropped: joining offers none now.)
  const legacy = readJson(storage, LEGACY_STORAGE_KEY) as Record<string, unknown> | null;
  if (legacy !== null) {
    if (readThemePickNote(storage) === null) {
      const seen = revisionOf(legacy.seen);
      const pending = legacy.pending as Record<string, unknown> | null | undefined;
      const theme = pending && pending.join !== true ? pickThemeIn(pending.theme) : null;
      if (pending && theme !== null) {
        const known = revisionOf(pending.known);
        note({ state: "unsent", id: env.randomId(), theme, known, since: 0, at: 0 });
      } else if (seen !== null) {
        note({ state: "taken", ...seen });
      }
    }
    writeJson(storage, LEGACY_STORAGE_KEY, null);
  }

  /** The newest pick the followed computers hold, and where to send one. */
  const picks = () => {
    const snapshots = env.library.snapshots();
    const followed = env.library.followed();
    const keeping = followed.filter((id) => snapshots[id]?.pick !== undefined);
    const winning = winningThemePick([
      ...keeping.map((id) => snapshots[id]?.pick),
      ...keeping.map((id) => answers.get(id)),
    ]);
    heard = newerThemeRevision(heard, winning);
    return {
      winning,
      home: keeping[0] ?? null,
      allReported: followed.every((id) => snapshots[id] !== undefined),
    };
  };

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

  /** The pick of this window's that a computer has answered once with another pick of its theme. */
  let answeredWithAnother: string | null = null;

  /** Sends the unsent pick. Its answer is that computer's pick now, read like its snapshot. */
  const send = (home: EnvironmentId, unsent: UnsentNote) => {
    const out = { id: unsent.id, at: env.now() };
    sending = out;
    // Claimed: other windows leave it to this one for a while.
    note({ ...unsent, at: out.at });
    const atLeast = Math.max(unsent.known?.revision ?? 0, heard?.revision ?? 0);
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
          const current = readThemePickNote(storage);
          if (current?.state !== "unsent" || current.id !== unsent.id) return;
          // The computer answers with another pick when it already held that theme, picked by
          // someone else above what the device knew. This pick goes again, above that, for an id
          // of its own: taken as theirs, a late send of theirs could pass for this choice. Once
          // only, so a computer that keeps no ids is still done with.
          if (picked.theme.pickId !== unsent.id && answeredWithAnother !== unsent.id) {
            answeredWithAnother = unsent.id;
            return;
          }
          // The computer took it. Done, whatever is newest by now: a newer pick is then taken
          // like any other.
          note({
            state: "taken",
            revision: picked.revision,
            revisedBy: picked.revisedBy,
            ...pastAfter(current),
          });
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
        // Unless it was given up on and another send is out.
        if (sending === out) sending = null;
        run();
      });
  };

  function run(): void {
    if (stopped) return;
    // At most a few steps a pass; each changes what the next reads.
    for (let pass = 0; pass < 4; pass++) {
      const theme = env.theme.state();
      const held = picks();
      const read = noteText();
      const current = readThemePickNote(storage);
      const now = env.now();
      const shown = pickThemeOf(theme.committed, theme.committedBase);
      const step = nextThemePickStep({
        hydrated: settings.hydrated,
        on: settings.on,
        bypass: theme.bypass,
        trialRunning: theme.trialRunning,
        winning: held.winning,
        canPublish: held.home !== null,
        allReported: held.allReported,
        shown,
        note: current,
        mine,
        sendingUntil: sending === null ? null : sending.at + THEME_PICK_CLAIM_MS,
        retryAt,
        now,
      });
      switch (step.kind) {
        case "wait":
          if (step.until !== undefined) wakeAt(step.until);
          return;
        case "joined":
          // No shared pick: the device's theme stays, and the first pick from anywhere is news.
          note({ state: "local", known: null, ...pastAfter(current) });
          continue;
        case "take": {
          // Its send is done with, answered or not: the next pick needn't wait for it.
          if (sending !== null && sending.id === step.pick.theme.pickId) sending = null;
          // The theme first, then the note. A window closed between the two leaves the pick still
          // to be noted, which the next one does; the other way round it would never be shown.
          // Another window in between finds the theme there already and only notes it.
          const next = choiceOfPickTheme(step.pick.theme);
          // A kind this build can't show is noted and passed over, not retried forever.
          if (next !== null && !sameThemeChoice(next.choice, theme.committed)) {
            env.theme.applyPick(next.choice, next.base);
          }
          // Showing it takes a moment. A note another window wrote meanwhile (the user picked
          // there) stands, and the next pass goes by it.
          if (noteText() === read) {
            note({
              state: "taken",
              revision: step.pick.revision,
              revisedBy: step.pick.revisedBy,
              ...pastAfter(current),
            });
          }
          continue;
        }
        case "again": {
          if (shown === null) return;
          const id = env.randomId();
          note({
            state: "unsent",
            id,
            theme: shown,
            known: revisionOf(step.over),
            since: now,
            at: now,
            ...pastAfter(current),
          });
          mine = id;
          continue;
        }
        case "send":
          if (held.home !== null) {
            send(held.home, step.note);
            // An answer that never comes announces nothing: looked at again when it counts as lost.
            wakeAt(now + THEME_PICK_CLAIM_MS);
          }
          return;
      }
    }
  }

  return {
    run,
    userCommitted: (choice, base) => {
      const before = readThemePickNote(storage);
      const now = env.now();
      mine = null;
      if (settings.hydrated && !settings.on) {
        note({
          state: "off",
          at: before?.state === "off" ? before.at : now,
          ...pastAfter(before),
        });
        return;
      }
      const theme = pickThemeOf(choice, base);
      picks();
      const known = newerThemeRevision(knownBy(before), heard);
      if (theme === null || !settings.hydrated) {
        // Kept on this device, or picked before the switch is known: not shared.
        note({ state: "local", known, ...pastAfter(before) });
        return;
      }
      const id = env.randomId();
      note({ state: "unsent", id, theme, known, since: now, at: now, ...pastAfter(before) });
      mine = id;
      // The user's pick goes at once, whatever an earlier failure is waiting out.
      retryAt = 0;
    },
    setSettings: (next) => {
      settings = next;
      if (next.hydrated && !next.on) {
        // The switch is off, as this window sees for itself: the device leaves the shared pick.
        const current = readThemePickNote(storage);
        if (current?.state !== "off") {
          note({ state: "off", at: env.now(), ...pastAfter(current) });
        }
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
