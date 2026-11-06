/**
 * The command palette's theme entries (docs/design/custom-themes.md,
 * "Switching"): "Change theme…" lists every theme a device can wear and
 * switches the way Settings does; "Use default theme" is the escape hatch,
 * always there, whatever the theme looks like.
 */
import { PaletteIcon, RotateCcwIcon } from "lucide-react";
import { useMemo } from "react";

import { chooseTheme, useThemeChoice } from "~/theme/themeStore";
import {
  sameThemeChoice,
  switchToTheme,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import type {
  CommandPaletteActionItem,
  CommandPaletteSubmenuItem,
} from "../../CommandPalette.logic";
import { failureNotice, toastManager } from "../../ui/toast";

export function useThemePaletteItems(classes: {
  readonly item: string;
  readonly addon: string;
}): ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const { builtins, starters, library } = useThemeTiles();
  const committed = useThemeChoice();
  return useMemo(() => {
    const itemOf = (tile: ThemeTile): CommandPaletteActionItem => ({
      kind: "action",
      value: `theme:${tile.key}`,
      searchTerms: [tile.name, tile.detail, "theme"],
      title: tile.name,
      description: sameThemeChoice(tile.choice, committed)
        ? `${tile.detail} · in use`
        : tile.detail,
      icon: (
        <span
          aria-hidden
          className={`${classes.item} inline-block rounded-full ring-1 ring-border`}
          style={{ background: tile.swatch.accent }}
        />
      ),
      run: async () => {
        await switchToTheme(tile).catch((error: unknown) =>
          toastManager.add(
            failureNotice({
              title: `Couldn't switch to ${tile.name}`,
              reason: error instanceof Error ? error.message : "Try again.",
            }),
          ),
        );
      },
    });
    const groups = [
      { value: "theme-builtin", label: "Built in", items: builtins.map(itemOf) },
      { value: "theme-starters", label: "Starters", items: starters.map(itemOf) },
      ...(library.length > 0
        ? [{ value: "theme-library", label: "Your themes", items: library.map(itemOf) }]
        : []),
    ];
    return [
      {
        kind: "submenu",
        value: "action:change-theme",
        searchTerms: ["theme", "appearance", "dark mode", "light mode", "colors", "wallpaper"],
        title: "Change theme…",
        icon: <PaletteIcon className={classes.item} />,
        addonIcon: <PaletteIcon className={classes.addon} />,
        groups,
      },
      {
        kind: "action",
        value: "action:default-theme",
        searchTerms: ["default theme", "reset theme", "system theme", "can't read"],
        title: "Use default theme",
        icon: <RotateCcwIcon className={classes.item} />,
        run: async () => chooseTheme({ kind: "builtin", id: "system" }),
      },
    ];
  }, [builtins, classes.addon, classes.item, committed, library, starters]);
}
