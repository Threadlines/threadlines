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

import { preloadThemeArtCode } from "../theme/ThemeRuntime";
import { pairSideFor, systemThemeChoice } from "../theme/themeChoice";
import {
  chooseTheme,
  hasKeptTheme,
  loadStarterThemeManifest,
  preloadThemeTokenCode,
  readThemeState,
  startThemeTrial,
  systemChoice,
  type ThemeChoice,
  type ThemePairSide,
  useSystemPair,
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
  /** System's tile with a pair: the two themes, drawn split corner to corner. */
  readonly sides?: { readonly [Mode in ThemeBase]: ThemeTilePicture };
}

/** What a tile draws of a theme. */
export type ThemeTilePicture = Pick<ThemeTile, "swatch" | "thumbnail">;

type PairChoice = Extract<ThemeChoice, { kind: "pair" }>;

/** The tile a side of System's pair is: a built-in, a starter, or one of `library`'s tiles. */
export function pairSideTile(side: ThemePairSide, library: readonly ThemeTile[]): ThemeTile | null {
  const key = side.kind === "library" ? `library:${side.entryId}` : `${side.kind}:${side.id}`;
  return [...BUILTIN_TILES, ...STARTER_TILES, ...library].find((tile) => tile.key === key) ?? null;
}

/** A side of System's pair by name: as its tile is called now, else as it was picked. */
export function pairSideName(side: ThemePairSide, library: readonly ThemeTile[] = []): string {
  const tile = pairSideTile(side, library);
  if (tile) return tile.name;
  return side.kind === "library" ? side.name : side.id;
}

/** The System tile: it switches to the device's pair when there is one, and draws both. */
export function systemTile(pair: PairChoice | null, library: readonly ThemeTile[] = []): ThemeTile {
  const pictureOf = (mode: ThemeBase): ThemeTilePicture => {
    const tile = pair ? pairSideTile(pair[mode], library) : null;
    // A theme the device can't list anymore draws as its mode's built-in.
    return tile ?? (mode === "dark" ? DARK_TILE : LIGHT_TILE);
  };
  return {
    key: "builtin:system",
    name: "System",
    detail: pair
      ? `${pairSideName(pair.light, library)} and ${pairSideName(pair.dark, library)}`
      : "Light or dark with your computer",
    group: "builtin",
    choice: pair ?? { kind: "builtin", id: "system" },
    swatch: { base: "system", background: "#f7f7f7", foreground: "#3a3a3a", accent: "#00347d" },
    thumbnail: null,
    ...(pair ? { sides: { light: pictureOf("light"), dark: pictureOf("dark") } } : {}),
  };
}

const LIGHT_TILE: ThemeTile = {
  key: "builtin:light",
  name: "Light",
  detail: "Built in",
  group: "builtin",
  choice: { kind: "builtin", id: "light" },
  swatch: { base: "light", background: "#f7f7f7", foreground: "#3a3a3a", accent: "#00347d" },
  thumbnail: null,
};

const DARK_TILE: ThemeTile = {
  key: "builtin:dark",
  name: "Dark",
  detail: "Built in",
  group: "builtin",
  choice: { kind: "builtin", id: "dark" },
  swatch: { base: "dark", background: "#212121", foreground: "#e8e8e8", accent: "#1855c1" },
  thumbnail: null,
};

const BUILTIN_TILES: readonly ThemeTile[] = [systemTile(null), LIGHT_TILE, DARK_TILE];

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
  const pair = useSystemPair();
  return useMemo(() => {
    const primary =
      environments.find((environment) => environment.isPrimary)?.environmentId ?? null;
    const labelOf = (environmentId: EnvironmentId) =>
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      "another computer";
    const libraryTiles = library.map((theme) => libraryTile(theme, primary, labelOf));
    return {
      builtins: [systemTile(pair, libraryTiles), LIGHT_TILE, DARK_TILE],
      starters: STARTER_TILES,
      library: libraryTiles,
    };
  }, [environments, library, pair]);
}

/** Whether two choices name the same theme (a library theme by its entry, whatever its version). */
export function sameThemeChoice(first: ThemeChoice, second: ThemeChoice): boolean {
  if (first.kind === "builtin" && second.kind === "builtin") return first.id === second.id;
  if (first.kind === "starter" && second.kind === "starter") return first.id === second.id;
  if (first.kind === "library" && second.kind === "library")
    return first.entryId === second.entryId;
  if (first.kind === "unsaved" && second.kind === "unsaved") return first.hash === second.hash;
  if (first.kind === "pair" && second.kind === "pair") {
    return sameThemeChoice(first.light, second.light) && sameThemeChoice(first.dark, second.dark);
  }
  return false;
}

const isSystem = (choice: ThemeChoice) =>
  choice.kind === "pair" || (choice.kind === "builtin" && choice.id === "system");

/**
 * Whether a tile shows as the device's theme: System's for plain System and
 * any pair (a pair from another device may not be the one this device
 * remembers), else the tile's own theme.
 */
export function tileIsChosen(tile: ThemeTile, chosen: ThemeChoice): boolean {
  return tile.key === "builtin:system" ? isSystem(chosen) : sameThemeChoice(tile.choice, chosen);
}

/** Whether `chosen` shows a tile's theme: as itself, or as a side of System's pair. */
export function choiceUsesTile(chosen: ThemeChoice, tile: ThemeTile): boolean {
  if (tileIsChosen(tile, chosen)) return true;
  return (
    chosen.kind === "pair" &&
    (sameThemeChoice(chosen.light, tile.choice) || sameThemeChoice(chosen.dark, tile.choice))
  );
}

/**
 * System's pair with every side that shows `theme` put back to its mode's
 * built-in (plain System when neither side is left).
 */
export function pairWithout(pair: PairChoice, theme: ThemeChoice): ThemeChoice {
  const keep = (side: ThemePairSide, mode: "light" | "dark"): ThemePairSide =>
    sameThemeChoice(side, theme) ? { kind: "builtin", id: mode } : side;
  return systemThemeChoice(keep(pair.light, "light"), keep(pair.dark, "dark"));
}

/**
 * System's pair with every side showing `theme` swapped for `next` (its new
 * version, or the copy the user saved of it), and the modes swapped.
 */
export function pairWithReplaced(
  pair: PairChoice,
  theme: ThemeChoice,
  next: ThemePairSide,
): { readonly pair: PairChoice; readonly modes: ReadonlyArray<ThemeBase> } {
  const modes = (["light", "dark"] as const).filter((mode) => sameThemeChoice(pair[mode], theme));
  return {
    pair: {
      kind: "pair",
      light: modes.includes("light") ? next : pair.light,
      dark: modes.includes("dark") ? next : pair.dark,
    },
    modes,
  };
}

/** The theme a choice shows now: System's Light or Dark, or its pair's side, by the computer's mode. */
export function shownThemeChoice(choice: ThemeChoice): ThemeChoice {
  const dark = readThemeState().systemDark;
  if (choice.kind === "pair") return pairSideFor(choice, dark);
  if (choice.kind === "builtin" && choice.id === "system") {
    return { kind: "builtin", id: dark ? "dark" : "light" };
  }
  return choice;
}

/** A side's content: null for a built-in, and for one that couldn't be read. */
async function loadSideManifest(side: ThemePairSide): Promise<ThemeManifest | null> {
  switch (side.kind) {
    case "builtin":
      return null;
    case "starter":
      return loadStarterThemeManifest(side.id);
    case "library":
      return (await readLibraryTheme(side.hash, side.environmentId)).manifest;
  }
}

/**
 * Both sides' content, so a pair applies with both pre-paint records
 * written (a reload in the other mode paints right). A side that can't be
 * read now is left out: the store looks for it (this device's cache first)
 * and shows its mode's built-in until it turns up.
 */
export async function loadPairManifests(
  pair: PairChoice,
): Promise<{ readonly light?: ThemeManifest; readonly dark?: ThemeManifest }> {
  preloadThemeTokenCode();
  preloadThemeArtCode();
  const [light, dark] = await Promise.all(
    (["light", "dark"] as const).map((mode) => loadSideManifest(pair[mode]).catch(() => null)),
  );
  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
}

/**
 * A tile's theme file, read from wherever it lives; null for the built-ins.
 * System's pair gives the side the computer shows now.
 */
export async function loadTileManifest(tile: ThemeTile): Promise<ThemeManifest | null> {
  const choice = shownThemeChoice(tile.choice);
  // Showing it takes the token code and, for art, the art's code: fetch them
  // alongside the theme.
  if (choice.kind !== "builtin") {
    preloadThemeTokenCode();
    preloadThemeArtCode();
  }
  switch (choice.kind) {
    case "builtin":
      return null;
    case "starter":
      return loadStarterThemeManifest(choice.id);
    case "library":
      return (await readLibraryTheme(choice.hash, choice.environmentId)).manifest;
    case "unsaved":
    case "pair":
      return null;
  }
}

/**
 * Switches this device to a tile's theme. Built-ins switch at once, and so
 * does a theme this device kept before, and System's pair (both its themes
 * were picked on purpose); any other theme starts a trial (the Keep bar),
 * unless `preview` asks for a trial outright.
 */
export async function switchToTheme(
  tile: ThemeTile,
  options: { readonly preview?: boolean } = {},
): Promise<void> {
  if (tile.choice.kind === "pair") {
    const pair = tile.choice;
    const sides = await loadPairManifests(pair);
    if (options.preview) startThemeTrial({ choice: pair, manifest: null, sides });
    else chooseTheme(pair, undefined, sides);
    return;
  }
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
  if (wanted === "system") {
    const system = systemChoice();
    return systemTile(system.kind === "pair" ? system : null);
  }
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
    case "pair":
      return "system";
    case "starter":
      return STARTER_TILES.find((tile) => tile.key === `starter:${choice.id}`)?.name ?? choice.id;
    case "library":
    case "unsaved":
      return choice.name;
  }
}
