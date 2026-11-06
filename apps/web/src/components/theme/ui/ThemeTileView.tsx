/**
 * One theme as the pickers draw it: a picture of the theme (its thumbnail,
 * or a small drawing of the app in its colors), its name, and a short line.
 * Clickable, so it's a tile; the selected one gets the accent ring and a check.
 */
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { ThemeTile } from "~/themeLibrary/themeCatalog";

function Swatch({ swatch }: { readonly swatch: ThemeTile["swatch"] }) {
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
            className="size-[14%] min-h-2 min-w-2 rounded-full"
            style={{ background: swatch.accent }}
          />
        </div>
      </div>
    </div>
  );
}

export function ThemeTileView({
  tile,
  selected,
  highlighted = false,
  compact = false,
  onSelect,
  className,
}: {
  readonly tile: ThemeTile;
  readonly selected: boolean;
  /** Keyboard focus in a strip that moves it with the arrow keys. */
  readonly highlighted?: boolean;
  /** The /theme strip's size: a short picture and the name alone (its line shows as a tooltip). */
  readonly compact?: boolean;
  readonly onSelect: () => void;
  readonly className?: string;
}) {
  const [pictureFailed, setPictureFailed] = useState(false);
  const picture = tile.thumbnail !== null && !pictureFailed ? tile.thumbnail : null;
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
          "w-full overflow-hidden ring-1 ring-border transition-shadow",
          compact
            ? "aspect-[16/9] rounded-[var(--app-radius-control)]"
            : "aspect-[5/3] rounded-[var(--app-radius-surface)]",
          selected && "ring-2 ring-primary",
        )}
      >
        {picture !== null ? (
          <img
            src={picture}
            alt=""
            className="size-full object-cover"
            draggable={false}
            onError={() => setPictureFailed(true)}
          />
        ) : (
          <Swatch swatch={tile.swatch} />
        )}
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
