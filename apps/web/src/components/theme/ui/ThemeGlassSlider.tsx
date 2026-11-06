/**
 * The Glass slider (docs/design/custom-themes.md, "Glass in the app"), in
 * Settings › Appearance and the `/theme` picker: how much of a theme's art
 * shows through the glass on every page, Solid to Clear, the theme's own in
 * the middle. Dragging moves the glass live; the setting changes once, when
 * the drag ends (or with each key press). A device setting changes in memory
 * at once and is saved behind it, so the knob never jumps back.
 */
import { THEME_GLASS_LEVEL_DEFAULT } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { Slider } from "~/components/ui/slider";
import { useUpdateSettings } from "~/hooks/useSettings";
import {
  clearGlassLevelPreview,
  setGlassLevelPreview,
  useSavedGlassLevel,
} from "~/theme/glassLevel";

/** Steps of 5: fine enough to tune, and the theme's own (50) is always a stop. */
const GLASS_STEP = 5;

/** How a level reads aloud. */
function glassValueText(level: number): string {
  if (level === 0) return "Solid";
  if (level === 100) return "Clear";
  if (level === THEME_GLASS_LEVEL_DEFAULT) return "The theme's own";
  return `${level} of 100`;
}

export function ThemeGlassSlider({
  size,
  className,
}: {
  readonly size?: "default" | "sm";
  readonly className?: string;
}) {
  const saved = useSavedGlassLevel();
  const { updateSettings } = useUpdateSettings();
  const [self] = useState(() => Symbol("glass slider"));
  // Where the knob is while dragged.
  const [dragged, setDragged] = useState<number | null>(null);
  // Unmounted mid-drag (the picker closed): the glass goes back to the saved level.
  useEffect(() => () => clearGlassLevelPreview(self), [self]);

  return (
    <Slider
      size={size}
      className={className}
      min={0}
      max={100}
      step={GLASS_STEP}
      mark={THEME_GLASS_LEVEL_DEFAULT}
      value={dragged ?? saved}
      aria-label="Glass"
      getAriaValueText={(_, level) => glassValueText(level)}
      onValueChange={(level) => {
        setDragged(level);
        setGlassLevelPreview(self, level);
      }}
      onValueCommitted={(level) => {
        if (level !== saved) updateSettings({ themeGlass: level });
        setDragged(null);
        clearGlassLevelPreview(self);
      }}
    />
  );
}
