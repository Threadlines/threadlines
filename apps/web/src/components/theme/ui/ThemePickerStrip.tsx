/**
 * The strip `/theme` opens above the message box (docs/design/custom-themes.md,
 * "Switching"): every theme as a tile. Arrow keys and clicks preview a theme
 * as a trial; Enter (or clicking the previewed tile again) keeps it; Esc puts
 * the old one back and closes. "New theme" hands the message box a prompt
 * for an agent to make one.
 */
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { endThemeTrial, useActiveTheme, useThemeChoice, useThemeTrial } from "~/theme/themeStore";
import {
  sameThemeChoice,
  switchToTheme,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import { keepThemeTrial, useThemePickerOpenStore } from "./ThemeTrialBar";
import { ThemeTileView } from "./ThemeTileView";

/** What "New theme" puts in the message box, for the user to finish. */
export const NEW_THEME_PROMPT = "Make me a Threadlines theme that feels like ";

export function ThemePickerStrip({
  onClose,
  onNewTheme,
}: {
  readonly onClose: () => void;
  readonly onNewTheme: () => void;
}) {
  const { builtins, starters, library } = useThemeTiles();
  const tiles = useMemo(
    () => [...builtins, ...starters, ...library],
    [builtins, library, starters],
  );
  const committed = useThemeChoice();
  const active = useActiveTheme();
  const trial = useThemeTrial();
  const [highlighted, setHighlighted] = useState(() =>
    Math.max(
      0,
      tiles.findIndex((tile) => sameThemeChoice(tile.choice, committed)),
    ),
  );
  const previewTrialIds = useRef(new Set<string>());
  // A trial already running when the strip opened isn't the strip's to undo.
  const trialBeforeOpening = useRef(trial?.id ?? null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useThemePickerOpenStore.getState().setOpen(true);
    // After the message box settles from the command: it takes focus back once more.
    const frame = requestAnimationFrame(() => rootRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      useThemePickerOpenStore.getState().setOpen(false);
    };
  }, []);

  useEffect(() => {
    if (trial !== null && trial.id !== trialBeforeOpening.current) {
      previewTrialIds.current.add(trial.id);
    }
  }, [trial]);

  useEffect(() => {
    rootRef.current
      ?.querySelector(`[data-theme-tile="${CSS.escape(tiles[highlighted]?.key ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlighted, tiles]);

  const preview = (index: number) => {
    const tile = tiles[index];
    if (!tile) return;
    setHighlighted(index);
    if (sameThemeChoice(tile.choice, active.choice)) return;
    void switchToTheme(tile, { preview: true });
  };

  const keep = (tile: ThemeTile | undefined) => {
    if (trial !== null && tile && sameThemeChoice(tile.choice, trial.choice)) {
      void keepThemeTrial(trial);
    }
    onClose();
  };

  const back = () => {
    if (trial !== null && previewTrialIds.current.has(trial.id)) endThemeTrial(trial.id);
    onClose();
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="listbox"
      aria-label="Themes"
      aria-activedescendant={tiles[highlighted]?.key}
      className="px-2.5 pt-2 pb-1.5 outline-none"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          preview(Math.min(tiles.length - 1, highlighted + 1));
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          preview(Math.max(0, highlighted - 1));
        } else if (event.key === "Enter") {
          event.preventDefault();
          keep(tiles[highlighted]);
        } else if (event.key === "Escape") {
          event.preventDefault();
          back();
        }
      }}
    >
      <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
        <span className="text-[12px] font-medium text-foreground">Themes</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-muted-foreground">
          ← → preview · ↵ keep · esc back
        </span>
      </div>
      <div className="flex snap-x gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
        {tiles.map((tile, index) => (
          <ThemeTileView
            key={tile.key}
            tile={tile}
            selected={sameThemeChoice(tile.choice, committed)}
            highlighted={index === highlighted}
            compact
            className="w-[92px] shrink-0 snap-start"
            onSelect={() => (index === highlighted && trial !== null ? keep(tile) : preview(index))}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            back();
            onNewTheme();
          }}
          title="New theme · ask an agent to make one"
          className={cn(
            "flex w-[92px] shrink-0 snap-start flex-col gap-1 rounded-[var(--app-radius-large)] p-0.5 text-left outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <div className="grid aspect-[16/9] w-full place-items-center rounded-[var(--app-radius-control)] border border-dashed border-border text-muted-foreground">
            <PlusIcon className="size-3.5" aria-hidden />
          </div>
          <div className="px-0.5 text-[11.5px] leading-[14px] font-medium text-foreground">
            New theme
          </div>
        </button>
      </div>
    </div>
  );
}
