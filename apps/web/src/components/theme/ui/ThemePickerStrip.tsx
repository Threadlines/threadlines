/**
 * The strip `/theme` opens above the message box (docs/design/custom-themes.md,
 * "Switching"): every theme as a tile. Arrow keys and clicks preview a theme
 * as a trial; Keep, Enter or clicking the previewed tile again keeps it; Esc
 * or the ✕ puts the old one back and closes. While a theme with art shows,
 * the Glass slider beside the title sets how much of it shows through.
 * "New theme" hands the message box a prompt for an agent to make one
 * (NewThemeHint.tsx explains it).
 */
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  endThemeTrial,
  holdThemeTrial,
  useActiveTheme,
  useThemeChoice,
  useThemeTrial,
} from "~/theme/themeStore";
import {
  sameThemeChoice,
  switchToTheme,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import { ThemeGlassSlider } from "./ThemeGlassSlider";
import { useThemePickerOpenStore } from "./themePickerOpen";
import { keepThemeTrial } from "./themeTrialState";
import { ThemeTileView } from "./ThemeTileView";

export function ThemePickerStrip({
  onClose,
  onNewTheme,
}: {
  readonly onClose: () => void;
  readonly onNewTheme: () => void;
}) {
  const { builtins, starters, library } = useThemeTiles();
  // Your own first, as in Settings.
  const tiles = useMemo(
    () => [...library, ...builtins, ...starters],
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
  const [trialIdBeforeOpening] = useState(() => trial?.id ?? null);
  // A preview the strip started: Esc and ✕ put the old theme back.
  const previewing = trial !== null && trial.id !== trialIdBeforeOpening;
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

  // A preview doesn't count down while the strip shows it (Esc and ✕ are
  // its way back); one still running when the strip closes starts counting.
  const latestTrialId = useRef<string | null>(null);
  useEffect(() => {
    latestTrialId.current = trial?.id ?? null;
    if (trial !== null && trial.id !== trialBeforeOpening.current) {
      previewTrialIds.current.add(trial.id);
      holdThemeTrial(trial.id, true);
    }
  }, [trial]);
  useEffect(
    () => () => {
      const id = latestTrialId.current;
      if (id !== null && previewTrialIds.current.has(id)) holdThemeTrial(id, false);
    },
    [],
  );

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

  /** Keep and Enter: whatever theme shows on trial, even one tried before the strip opened. */
  const keepShown = () => {
    if (trial !== null) void keepThemeTrial(trial);
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
        // The Glass slider takes its own arrow keys.
        const inSlider =
          event.target instanceof Element && event.target.closest('[data-slot="slider"]') !== null;
        if (inSlider && event.key !== "Escape") return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          preview(Math.min(tiles.length - 1, highlighted + 1));
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          preview(Math.max(0, highlighted - 1));
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          // Only with the strip itself focused: Enter on a button in it (✕,
          // New theme) is that button's own.
          event.preventDefault();
          keepShown();
        } else if (event.key === "Escape") {
          event.preventDefault();
          back();
        }
      }}
    >
      <div className="mb-1 flex min-h-6 items-center gap-2 px-0.5">
        <span className="text-[12px] font-medium text-foreground">Themes</span>
        {active.manifest?.backdrop ? (
          <span className="ml-2 flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">Glass</span>
            <ThemeGlassSlider size="sm" className="w-28" />
          </span>
        ) : null}
        <span className="flex-1" />
        {trial !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            tooltip="Keep this theme (Enter)"
            onClick={keepShown}
          >
            <CheckIcon aria-hidden />
            Keep
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          tooltip="Ask an agent to make one"
          onClick={() => {
            back();
            onNewTheme();
          }}
        >
          <PlusIcon aria-hidden />
          New theme
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close themes"
          tooltip={previewing ? "Put your theme back (Esc)" : "Close (Esc)"}
          onClick={back}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
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
      </div>
    </div>
  );
}
