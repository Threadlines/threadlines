/**
 * The command palette's theme commands (docs/design/custom-themes.md,
 * "Switching"): "Change theme…" lists every theme a device can wear and
 * switches the way Settings does; "Use default theme" is the escape hatch,
 * always there, whatever the theme looks like.
 */
import { useMemo } from "react";

import { useCommandHandlers, type CommandListItem } from "~/commands/commandHandlers";
import { chooseTheme, useThemeChoice } from "~/theme/themeStore";
import {
  sameThemeChoice,
  shownThemeChoice,
  switchToTheme,
  tileIsChosen,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import { ITEM_ICON_CLASS } from "../../CommandPalette.logic";
import { failureNotice, toastManager } from "../../ui/toast";
import { openThemeEditor } from "./themeEditorState";

export function useThemeCommands(): void {
  const { builtins, starters, library } = useThemeTiles();
  const committed = useThemeChoice();
  const items = useMemo<ReadonlyArray<CommandListItem>>(() => {
    const itemOf = (tile: ThemeTile, group: string): CommandListItem => ({
      id: tile.key,
      title: tile.name,
      description: tileIsChosen(tile, committed) ? `${tile.detail} · in use` : tile.detail,
      keywords: [tile.detail],
      group,
      icon: (
        <span
          aria-hidden
          className={`${ITEM_ICON_CLASS} inline-block rounded-full ring-1 ring-border`}
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
    return [
      ...builtins.map((tile) => itemOf(tile, "Built in")),
      ...starters.map((tile) => itemOf(tile, "Starters")),
      ...library.map((tile) => itemOf(tile, "Your themes")),
    ];
  }, [builtins, committed, library, starters]);

  useCommandHandlers({
    "theme.change": { items, placeholder: "Search themes..." },
    "theme.editColors": {
      run: () => {
        const tiles = [...builtins, ...starters, ...library];
        // System, and its pair, show one theme at a time: the one the computer's mode picks.
        const shown = shownThemeChoice(committed);
        const tile = tiles.find((candidate) => sameThemeChoice(candidate.choice, shown));
        if (tile !== undefined) openThemeEditor(tile);
        else
          toastManager.add({
            type: "info",
            title: "This theme can't be edited here",
            description: "Keep it first, then edit it from Appearance.",
          });
      },
    },
    "theme.useDefault": { run: () => chooseTheme({ kind: "builtin", id: "system" }) },
  });
}
