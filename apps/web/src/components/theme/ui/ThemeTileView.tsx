/**
 * One theme as the pickers draw it: a picture of the theme (its thumbnail,
 * or a small drawing of the app in its colors), its name, and a short line.
 * System with a pair draws its two themes split corner to corner, light
 * above. Clickable, so it's a tile; the selected one gets the accent ring and
 * a check.
 */
import { CheckIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import type { ThemeTile, ThemeTilePicture } from "~/themeLibrary/themeCatalog";

/**
 * A small drawing of the app in a theme's colors, for a theme with no
 * picture: a sidebar, two lines of text and the accent's send button.
 * `tiny` (a dropdown's 16px preview) keeps the button in proportion instead
 * of at the size a tile needs to show it.
 */
export function ThemeSwatch({
  swatch,
  tiny = false,
}: {
  readonly swatch: ThemeTile["swatch"];
  readonly tiny?: boolean;
}) {
  if (swatch.base === "system") {
    return (
      <div className="relative size-full">
        <div className="absolute inset-0" style={{ background: "#f7f7f7" }} />
        <div
          className="absolute inset-0"
          style={{ background: "#212121", clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
        />
      </div>
    );
  }
  return (
    <div className="flex size-full" style={{ background: swatch.background }}>
      <div className="h-full w-[22%]" style={{ background: swatch.foreground, opacity: 0.06 }} />
      <div className="flex flex-1 flex-col justify-center gap-[9%] px-[10%]">
        <div
          className="h-[7%] w-[70%] rounded-full"
          style={{ background: swatch.foreground, opacity: 0.55 }}
        />
        <div
          className="h-[7%] w-[45%] rounded-full"
          style={{ background: swatch.foreground, opacity: 0.3 }}
        />
        <div className="flex items-center justify-end">
          <div
            className={cn(
              "rounded-full",
              tiny ? "aspect-square w-[14%]" : "size-[14%] min-h-2 min-w-2",
            )}
            style={{ background: swatch.accent }}
          />
        </div>
      </div>
    </div>
  );
}

/** A theme's thumbnail, or its swatch when it has none (or the picture won't load). */
export function ThemePicture({
  picture,
  tiny = false,
}: {
  readonly picture: ThemeTilePicture;
  /** A dropdown's 16px preview (see ThemeSwatch). */
  readonly tiny?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (picture.thumbnail === null || failed) {
    return <ThemeSwatch swatch={picture.swatch} tiny={tiny} />;
  }
  return (
    <img
      src={picture.thumbnail}
      alt=""
      className="size-full object-cover"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** System's pair: the light theme above the diagonal, the dark one below, as System's own swatch. */
function PairPicture({ sides }: { readonly sides: NonNullable<ThemeTile["sides"]> }) {
  return (
    <div className="relative size-full">
      <div className="absolute inset-0">
        <ThemePicture picture={sides.light} />
      </div>
      <div className="absolute inset-0" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}>
        <ThemePicture picture={sides.dark} />
      </div>
    </div>
  );
}

export function ThemeTileView({
  tile,
  selected,
  highlighted = false,
  compact = false,
  badge,
  onSelect,
  className,
}: {
  /** What the tile draws; the Showcase passes its entries' the same way. */
  readonly tile: Pick<ThemeTile, "key" | "name" | "detail" | "swatch" | "thumbnail" | "sides">;
  readonly selected: boolean;
  /** Keyboard focus in a strip that moves it with the arrow keys. */
  readonly highlighted?: boolean;
  /** The /theme strip's size: a short picture and the name alone (its line shows as a tooltip). */
  readonly compact?: boolean;
  /** A small label on the picture's corner (the gallery marks the themes System uses). */
  readonly badge?: ReactNode;
  readonly onSelect: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-theme-tile={tile.key}
      title={compact ? `${tile.name} · ${tile.detail}` : undefined}
      className={cn(
        "group flex min-w-0 flex-col rounded-[var(--app-radius-large)] text-left outline-none",
        compact ? "gap-1 p-0.5" : "gap-1.5 p-1",
        "focus-visible:ring-2 focus-visible:ring-ring",
        highlighted && "bg-accent",
        className,
      )}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden ring-1 ring-border transition-shadow",
          compact
            ? "aspect-[16/9] rounded-[var(--app-radius-control)]"
            : "aspect-[5/3] rounded-[var(--app-radius-surface)]",
          selected && "ring-2 ring-primary",
        )}
      >
        {tile.sides ? <PairPicture sides={tile.sides} /> : <ThemePicture picture={tile} />}
        {badge ? (
          <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded-[5px] bg-popover/90 px-1.5 text-[10.5px] leading-4 text-foreground">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 px-0.5">
        <div
          className={cn(
            "flex min-w-0 items-center gap-1 font-medium text-foreground",
            compact ? "text-[11.5px] leading-[14px]" : "text-[12.5px] leading-4",
          )}
        >
          <span className="truncate">{tile.name}</span>
          {selected ? (
            <CheckIcon
              aria-label="In use"
              className={cn("shrink-0 text-primary-readable", compact ? "size-3" : "size-3.5")}
            />
          ) : null}
        </div>
        {compact ? null : (
          <div className="truncate text-[11px] leading-4 text-muted-foreground">{tile.detail}</div>
        )}
      </div>
    </button>
  );
}
