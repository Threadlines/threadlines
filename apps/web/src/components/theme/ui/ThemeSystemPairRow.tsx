/**
 * Settings › Appearance, "System themes" (docs/design/custom-themes.md,
 * "Light and dark with your computer"): which theme System shows while the
 * computer is light and which while it is dark. Each side lists the themes
 * of its mode: the built-in (the default), the starters, then the user's
 * own. Picking one switches the device to System with that pair
 * (systemPairPick.ts); Reset forgets the pair, so System is plain Light and
 * Dark again.
 */
import type { ThemeBase } from "@threadlines/contracts";
import { MoonIcon, SunIcon } from "lucide-react";

import {
  type ThemeChoice,
  type ThemePairSide,
  useSystemPair,
  useThemeChoice,
} from "~/theme/themeStore";
import {
  pairSideName,
  pairSideTile,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { BUILTIN_SIDE, pickSystemSide, resetSystemPair, systemSides } from "./systemPairPick";
import { ThemePicture } from "./ThemeTileView";

type PairChoice = Extract<ThemeChoice, { kind: "pair" }>;

/** The row's words while System is plain Light and Dark. */
const DEFAULT_DESCRIPTION =
  "Plain Light and Dark for now. Pick any of your light or dark themes instead.";

/** A tile's theme as a side of the pair; null for a tile that can't be one. */
function sideOf(tile: ThemeTile, mode: ThemeBase): ThemePairSide | null {
  const { choice } = tile;
  switch (choice.kind) {
    case "builtin":
      return choice.id === mode ? BUILTIN_SIDE[mode] : null;
    case "starter":
    case "library":
      return choice;
    default:
      return null;
  }
}

const sideKey = (side: ThemePairSide) =>
  side.kind === "library" ? `library:${side.entryId}` : `${side.kind}:${side.id}`;

function SideOption({
  picture,
  name,
  isDefault,
}: {
  readonly picture: ThemeTile;
  readonly name: string;
  /** The built-in: marked Default, the option to go back to. */
  readonly isDefault: boolean;
}) {
  // Everything centers on the row. "Default" is trimmed to its capitals, so
  // its letters (not its smaller line box) sit on the name's center line.
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="aspect-[5/3] h-4 shrink-0 overflow-hidden rounded-[3px] ring-1 ring-border">
        <ThemePicture picture={picture} tiny />
      </span>
      <span className="min-w-0 truncate">{name}</span>
      {isDefault ? (
        <span className="ml-auto shrink-0 text-[11px] leading-none text-muted-foreground [text-box:trim-both_cap_alphabetic]">
          Default
        </span>
      ) : null}
    </span>
  );
}

/** One side's dropdown: the themes of that mode, the one in use first in its group. */
function SidePicker({
  mode,
  side,
  onPick,
}: {
  readonly mode: ThemeBase;
  readonly side: ThemePairSide;
  readonly onPick: (side: ThemePairSide) => void;
}) {
  const { builtins, starters, library } = useThemeTiles();
  const ofMode = (tiles: readonly ThemeTile[]) =>
    tiles.filter((tile) => tile.swatch.base === mode && sideOf(tile, mode) !== null);
  // The built-in heads the list unlabelled, as Default; Your themes shows even
  // empty, so a first visit learns its own themes can go here too.
  const groups = [
    { label: null, tiles: ofMode(builtins) },
    { label: "Starters", tiles: ofMode(starters) },
    { label: "Your themes", tiles: ofMode(library) },
  ].filter((group) => group.tiles.length > 0 || group.label === "Your themes");
  const current = sideKey(side);
  const currentTile = pairSideTile(side, library);
  const label = mode === "dark" ? "Dark" : "Light";
  const Icon = mode === "dark" ? MoonIcon : SunIcon;
  return (
    <Select
      value={current}
      onValueChange={(value) => {
        const tile = groups
          .flatMap((group) => group.tiles)
          .find((candidate) => candidate.key === value);
        const next = tile ? sideOf(tile, mode) : null;
        if (next) onPick(next);
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-full min-w-0 sm:w-48"
        aria-label={`${label} theme for System`}
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue className="min-w-0">
          {currentTile ? (
            <SideOption
              picture={currentTile}
              name={currentTile.name}
              isDefault={side.kind === "builtin"}
            />
          ) : (
            // Gone from every list (deleted): named as it was picked.
            pairSideName(side, library)
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} popupClassName="max-h-80 max-w-72">
        {groups.map((group) => (
          <SelectGroup key={group.label ?? "builtin"}>
            {group.label ? <SelectGroupLabel>{group.label}</SelectGroupLabel> : null}
            {group.tiles.map((tile) => (
              <SelectItem key={tile.key} value={tile.key}>
                <SideOption picture={tile} name={tile.name} isDefault={tile.group === "builtin"} />
              </SelectItem>
            ))}
            {group.tiles.length === 0 ? (
              <div className="px-2 py-1 text-[12.5px] text-muted-foreground">
                Themes you keep show up here
              </div>
            ) : null}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ThemeSystemPairRow() {
  const remembered = useSystemPair();
  const committed = useThemeChoice();
  const pair: PairChoice | null = remembered ?? (committed.kind === "pair" ? committed : null);
  const { light, dark } = systemSides(pair);
  return (
    <SettingsRow
      place="appearance.systemThemes"
      // On the defaults, say outright that any theme of the mode can go here.
      {...(pair ? {} : { description: DEFAULT_DESCRIPTION })}
      resetAction={
        pair ? <SettingResetButton label="System themes" onClick={resetSystemPair} /> : null
      }
      control={
        <div className="flex w-full min-w-0 gap-2 sm:w-auto">
          <SidePicker mode="light" side={light} onPick={(side) => pickSystemSide("light", side)} />
          <SidePicker mode="dark" side={dark} onPick={(side) => pickSystemSide("dark", side)} />
        </div>
      }
    />
  );
}
