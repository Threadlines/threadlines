/**
 * How a device's theme choice is written down (docs/design/custom-themes.md,
 * "Applying a theme"). Pure, so the store, its tests and the pre-paint script
 * in index.html agree on one shape.
 *
 * `threadlines:theme` keeps today's bare values for the built-ins (`system`,
 * `light`, `dark`), so older builds and the pre-paint script read them as
 * before. Any other theme is a JSON object `{ "v": 1, "kind": ..., "base":
 * ... }` with the choice's fields; an older build reads that as an unknown
 * value and falls back to System.
 */
import type { EnvironmentId, ThemeBase } from "@threadlines/contracts";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

import type { ThemeChoice } from "./themeTypes";

export const THEME_STORAGE_KEY = "threadlines:theme";
export const LEGACY_THEME_STORAGE_KEYS = ["t3code:theme"] as const;
/** The small record the pre-paint script in index.html paints before React loads. */
export const THEME_PAINT_STORAGE_KEY = "threadlines:theme-paint";
/** Content hashes this device has kept (switching back to one skips the trial). */
export const THEME_KEPT_STORAGE_KEY = "threadlines:theme-kept";
/** The most kept hashes remembered; the oldest drop first. */
export const THEME_KEPT_LIMIT = 200;

export type BuiltinThemeId = "system" | "light" | "dark";

export interface StoredThemeChoice {
  readonly choice: ThemeChoice;
  /** The theme's base, kept so a device can fall back to it when the content is nowhere. */
  readonly base: ThemeBase | null;
}

const isBuiltinId = (value: unknown): value is BuiltinThemeId =>
  value === "system" || value === "light" || value === "dark";

const isBase = (value: unknown): value is ThemeBase => value === "light" || value === "dark";

const isText = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const HASH = /^[0-9a-f]{64}$/;

/** Reads a stored choice; null for anything unrecognised (the caller falls back to System). */
export function parseStoredThemeChoice(raw: string | null | undefined): StoredThemeChoice | null {
  if (raw === null || raw === undefined) return null;
  if (isBuiltinId(raw)) return { choice: { kind: "builtin", id: raw }, base: null };
  if (!raw.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const base = isBase(record.base) ? record.base : null;
  switch (record.kind) {
    case "builtin":
      return isBuiltinId(record.id) ? { choice: { kind: "builtin", id: record.id }, base } : null;
    case "starter":
      return isText(record.id, 80) ? { choice: { kind: "starter", id: record.id }, base } : null;
    case "library": {
      if (!isText(record.entryId, 64) || !isText(record.hash) || !HASH.test(record.hash)) {
        return null;
      }
      const environmentId = isText(record.environmentId, 200)
        ? (record.environmentId as EnvironmentId)
        : null;
      return {
        choice: {
          kind: "library",
          entryId: record.entryId,
          hash: record.hash,
          name: isText(record.name, 60) ? record.name : "Custom theme",
          environmentId,
        },
        base,
      };
    }
    case "unsaved":
      return isText(record.hash) && HASH.test(record.hash)
        ? {
            choice: {
              kind: "unsaved",
              hash: record.hash,
              name: isText(record.name, 60) ? record.name : "Custom theme",
            },
            base,
          }
        : null;
    default:
      return null;
  }
}

/** The stored form of a choice: bare words for the built-ins, JSON otherwise. */
export function serializeThemeChoice(choice: ThemeChoice, base: ThemeBase | null): string {
  if (choice.kind === "builtin") return choice.id;
  return JSON.stringify({ v: 1, ...choice, ...(base ? { base } : {}) });
}

/** Reads the device's choice from storage, migrating the legacy key as today's build does. */
export function readStoredThemeChoice(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): StoredThemeChoice {
  const fallback: StoredThemeChoice = { choice: { kind: "builtin", id: "system" }, base: null };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw !== null) return parseStoredThemeChoice(raw) ?? fallback;
    for (const legacyKey of LEGACY_THEME_STORAGE_KEYS) {
      const legacy = storage.getItem(legacyKey);
      if (!isBuiltinId(legacy)) continue;
      storage.setItem(THEME_STORAGE_KEY, legacy);
      return { choice: { kind: "builtin", id: legacy }, base: null };
    }
  } catch {
    // Storage that throws (private mode, quota) reads as no choice.
  }
  return fallback;
}

/** A key that names a choice: equal keys show the same theme. */
export function themeChoiceKey(choice: ThemeChoice): string {
  switch (choice.kind) {
    case "builtin":
      return `builtin:${choice.id}`;
    case "starter":
      return `starter:${choice.id}`;
    case "library":
      return `library:${choice.entryId}:${choice.hash}`;
    case "unsaved":
      return `unsaved:${choice.hash}`;
  }
}

export function sameThemeChoice(first: ThemeChoice, second: ThemeChoice): boolean {
  return themeChoiceKey(first) === themeChoiceKey(second);
}

/**
 * What index.html's pre-paint script reads for a committed custom theme: the
 * base, the opaque surface color and the token set, so the first paint is
 * already the theme's. `key` ties it to the stored choice; a stale record is
 * ignored.
 */
export interface ThemePaintRecord {
  readonly v: 1;
  readonly key: string;
  readonly hash: string | null;
  readonly base: ThemeBase;
  readonly surface: string;
  readonly tokens: ThemeTokens;
  /** The theme has art, so the app draws glass once it loads. */
  readonly glass: boolean;
}

export function parseThemePaintRecord(raw: string | null | undefined): ThemePaintRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ThemePaintRecord> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      value.v !== 1 ||
      typeof value.key !== "string" ||
      !isBase(value.base) ||
      typeof value.surface !== "string" ||
      typeof value.tokens !== "object" ||
      value.tokens === null
    ) {
      return null;
    }
    return {
      v: 1,
      key: value.key,
      hash: typeof value.hash === "string" ? value.hash : null,
      base: value.base,
      surface: value.surface,
      tokens: value.tokens,
      glass: value.glass === true,
    };
  } catch {
    return null;
  }
}

export function readKeptThemeHashes(storage: Pick<Storage, "getItem"> | null): string[] {
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(THEME_KEPT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** The kept list with `hash` moved to the end (most recent), capped. */
export function withKeptThemeHash(hashes: ReadonlyArray<string>, hash: string): string[] {
  return [...hashes.filter((entry) => entry !== hash), hash].slice(-THEME_KEPT_LIMIT);
}
