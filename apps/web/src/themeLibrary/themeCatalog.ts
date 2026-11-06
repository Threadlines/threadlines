/**
 * Every theme a device can pick, as the pickers show them: the built-ins, the
 * starters that ship with Threadlines, and the library across computers
 * (docs/design/custom-themes.md, "Switching"). The /theme strip, Settings ›
 * Appearance and the command palette all list from here and switch through
 * `switchToTheme`, so a theme behaves the same wherever it is picked.
 */
import type { EnvironmentId, ThemeBase, ThemeManifest } from "@threadlines/contracts";
import { themeContentHash } from "@threadlines/shared/themeManifestHash";
import { STARTER_SUMMARIES } from "@threadlines/shared/themeStarterSummaries";
import { useMemo } from "react";

import {
  chooseTheme,
  hasKeptTheme,
  loadStarterThemeManifest,
  preloadThemeTokenCode,
  startThemeTrial,
  type ThemeChoice,
} from "../theme/themeStore";
import {
  type LibraryTheme,
  readLibraryTheme,
  useLibraryThemes,
  useThemeEnvironments,
} from "./themeLibraryState";

export interface ThemeTile {
  /** Unique among tiles: "builtin:dark", "starter:aurora", "library:<entryId>". */
  readonly key: string;
  readonly name: string;
  /** One short line under the name. */
  readonly detail: string;
  readonly group: "builtin" | "starter" | "library";
  readonly choice: ThemeChoice;
  /** What the tile draws when it has no picture. */
  readonly swatch: {
    readonly base: ThemeBase | "system";
    readonly background: string;
    readonly foreground: string;
    readonly accent: string;
  };
  /** A picture of the theme, when there is one. */
  readonly thumbnail: string | null;
  /** The library entry behind a library tile. */
  readonly library?: LibraryTheme;
}

const BUILTIN_TILES: readonly ThemeTile[] = [
  {
    key: "builtin:system",
    name: "System",
    detail: "Light or dark with your computer",
    group: "builtin",
    choice: { kind: "builtin", id: "system" },
    swatch: { base: "system", background: "#f7f7f7", foreground: "#3a3a3a", accent: "#00347d" },
    thumbnail: null,
  },
  {
    key: "builtin:light",
    name: "Light",
    detail: "Built in",
    group: "builtin",
    choice: { kind: "builtin", id: "light" },
    swatch: { base: "light", background: "#f7f7f7", foreground: "#3a3a3a", accent: "#00347d" },
    thumbnail: null,
  },
  {
    key: "builtin:dark",
    name: "Dark",
    detail: "Built in",
    group: "builtin",
    choice: { kind: "builtin", id: "dark" },
    swatch: { base: "dark", background: "#212121", foreground: "#e8e8e8", accent: "#1855c1" },
    thumbnail: null,
  },
];

const baseWord = (base: ThemeBase) => (base === "dark" ? "dark" : "light");

/** "Live art · dark", "Dark, no art": what a theme is, in a few words. */
export function describeTheme(input: {
  readonly base: ThemeBase;
  readonly hasArt: boolean;
}): string {
  return input.hasArt
    ? `Live art · ${baseWord(input.base)}`
    : `${input.base === "dark" ? "Dark" : "Light"}, no art`;
}

// From the summaries: listing the starters never loads their art.
export const STARTER_TILES: readonly ThemeTile[] = STARTER_SUMMARIES.map(
  ({ id, name, base, hasArt, colors }) => ({
    key: `starter:${id}`,
    name,
    detail: describeTheme({ base, hasArt }),
    group: "starter",
    choice: { kind: "starter", id },
    swatch: { base, ...colors },
    thumbnail: `/themes/${id}.png`,
  }),
);

export function libraryTile(
  theme: LibraryTheme,
  primaryEnvironmentId: EnvironmentId | null,
  labelOf: (environmentId: EnvironmentId) => string,
): ThemeTile {
  const { entry } = theme;
  const holder = theme.holders[0] ?? null;
  const elsewhere =
    holder !== null &&
    primaryEnvironmentId !== null &&
    !theme.holders.includes(primaryEnvironmentId);
  const what = describeTheme({ base: entry.base, hasArt: entry.backdropMode !== null });
  return {
    key: `library:${entry.entryId}`,
    name: entry.name,
    detail: elsewhere && holder !== null ? `${what} · on ${labelOf(holder)}` : what,
    group: "library",
    choice: {
      kind: "library",
      entryId: entry.entryId,
      hash: entry.hash,
      name: entry.name,
      environmentId: holder,
    },
    swatch: {
      base: entry.base,
      background: entry.background,
      foreground: entry.foreground,
      accent: entry.accent,
    },
    thumbnail: entry.thumbnail,
    library: theme,
  };
}

/** The built-ins, the starters and the library, in that order. */
export function useThemeTiles(): {
  readonly builtins: readonly ThemeTile[];
  readonly starters: readonly ThemeTile[];
  readonly library: readonly ThemeTile[];
} {
  const library = useLibraryThemes();
  const environments = useThemeEnvironments();
  return useMemo(() => {
    const primary =
      environments.find((environment) => environment.isPrimary)?.environmentId ?? null;
    const labelOf = (environmentId: EnvironmentId) =>
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      "another computer";
    return {
      builtins: BUILTIN_TILES,
      starters: STARTER_TILES,
      library: library.map((theme) => libraryTile(theme, primary, labelOf)),
    };
  }, [environments, library]);
}

/** Whether two choices name the same theme. */
export function sameThemeChoice(first: ThemeChoice, second: ThemeChoice): boolean {
  if (first.kind === "builtin" && second.kind === "builtin") return first.id === second.id;
  if (first.kind === "starter" && second.kind === "starter") return first.id === second.id;
  if (first.kind === "library" && second.kind === "library")
    return first.entryId === second.entryId;
  if (first.kind === "unsaved" && second.kind === "unsaved") return first.hash === second.hash;
  return false;
}

/** A tile's theme file, read from wherever it lives; null for the built-ins. */
export async function loadTileManifest(tile: ThemeTile): Promise<ThemeManifest | null> {
  const { choice } = tile;
  // Showing it takes the token code too: fetch both at once.
  if (choice.kind !== "builtin") preloadThemeTokenCode();
  switch (choice.kind) {
    case "builtin":
      return null;
    case "starter":
      return loadStarterThemeManifest(choice.id);
    case "library":
      return (await readLibraryTheme(choice.hash, choice.environmentId)).manifest;
    case "unsaved":
      return null;
  }
}

/**
 * Switches this device to a tile's theme. Built-ins switch at once, and so
 * does a theme this device kept before; any other theme starts a trial
 * (the Keep bar), unless `preview` asks for a trial outright.
 */
export async function switchToTheme(
  tile: ThemeTile,
  options: { readonly preview?: boolean } = {},
): Promise<void> {
  const manifest = await loadTileManifest(tile);
  if (manifest === null) {
    if (options.preview) startThemeTrial({ choice: tile.choice, manifest: null });
    else chooseTheme(tile.choice);
    return;
  }
  const hash =
    tile.choice.kind === "library" || tile.choice.kind === "unsaved"
      ? tile.choice.hash
      : await themeContentHash(manifest);
  if (!options.preview && hasKeptTheme(hash)) {
    chooseTheme(tile.choice, manifest);
    return;
  }
  startThemeTrial({ choice: tile.choice, manifest });
}

/**
 * The theme an agent's settings change names: "system", "light", "dark", a
 * starter's id or name, or a library theme's name (any case). Null when
 * nothing on the followed computers goes by that name.
 */
export function themeTileByName(value: string, library: readonly LibraryTheme[]): ThemeTile | null {
  const wanted = value.trim().toLowerCase();
  const builtin = BUILTIN_TILES.find(
    (tile) => tile.choice.kind === "builtin" && tile.choice.id === wanted,
  );
  if (builtin) return builtin;
  const starter = STARTER_TILES.find(
    (tile) =>
      tile.name.toLowerCase() === wanted ||
      (tile.choice.kind === "starter" && tile.choice.id === wanted),
  );
  if (starter) return starter;
  const entry = library.find((theme) => theme.entry.name.toLowerCase() === wanted);
  return entry ? libraryTile(entry, null, () => "another computer") : null;
}

/** A choice as an agent's settings change names it: a built-in's id, else the theme's name. */
export function themeChoiceName(choice: ThemeChoice): string {
  switch (choice.kind) {
    case "builtin":
      return choice.id;
    case "starter":
      return STARTER_TILES.find((tile) => tile.key === `starter:${choice.id}`)?.name ?? choice.id;
    case "library":
    case "unsaved":
      return choice.name;
  }
}
