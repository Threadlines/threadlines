import type { MouseEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A plain icon button for the window's frame: the rail (34px) and the title
 * row (30px). No fill until hover; pressed is a step darker than hover and
 * selected a full soft fill, so the three never look alike. A disabled button
 * stays focusable and keeps its tooltip, which says why. Tooltips show with no
 * delay.
 */
export function ChromeIconButton({
  label,
  tooltip,
  size,
  selected = false,
  expanded,
  glide = false,
  disabled = false,
  side,
  keepTooltipOnClick = false,
  tooltipFollowsContent = false,
  onClick,
  children,
  testId,
  className,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly size: "rail" | "titlebar";
  readonly selected?: boolean;
  /** For a button that also shows and hides something: whether it is showing. */
  readonly expanded?: boolean | undefined;
  /**
   * Selection is drawn by a highlight its container slides between buttons
   * (the rail), so a selected button paints no fill of its own.
   */
  readonly glide?: boolean;
  readonly disabled?: boolean;
  readonly side: "right" | "bottom";
  /**
   * Keep the tooltip up through a click, for a button whose tooltip reports
   * what the click started. Others close it: the click took the user on.
   */
  readonly keepTooltipOnClick?: boolean;
  /**
   * The tooltip follows its content's size while open, for a tooltip whose
   * words change in place. Others keep the size they opened at.
   */
  readonly tooltipFollowsContent?: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        // Labels come up at once: the rail is icons only, so its names are
        // read by hovering, often across several buttons in a row.
        delay={0}
        closeDelay={0}
        closeOnClick={!keepTooltipOnClick}
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            aria-expanded={expanded}
            aria-disabled={disabled ? true : undefined}
            data-testid={testId}
            data-selected={selected ? "" : undefined}
            data-glide={glide ? "" : undefined}
            className={cn(
              "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors select-none focus-ring [-webkit-app-region:no-drag]",
              size === "rail" ? "size-[34px] [&_svg]:size-4" : "size-[30px] [&_svg]:size-4",
              disabled
                ? "cursor-default text-muted-foreground opacity-64"
                : selected
                  ? cn("text-foreground", !glide && "bg-sidebar-accent")
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground active:bg-sidebar-accent/80",
              className,
            )}
            onClick={(event) => {
              if (!disabled) onClick(event);
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup
        side={side}
        sideOffset={6}
        className="duration-[80ms]"
        // The positioner holds the size it measured on opening; max-content
        // lets it widen with the words instead of clipping them.
        positionerClassName={tooltipFollowsContent ? "w-max h-max" : undefined}
      >
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A frame button's tooltip: its name, then its shortcut when it has one. */
export function ChromeTooltip({
  label,
  shortcut,
  detail,
}: {
  readonly label: string;
  readonly shortcut?: string | null;
  /** A second line, quieter: why a disabled button does nothing. */
  readonly detail?: string | null;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2 whitespace-nowrap">
        {label}
        {shortcut ? (
          <span className="font-mono text-[10.5px] text-muted-foreground">{shortcut}</span>
        ) : null}
      </span>
      {detail ? <span className="text-[11px] text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
