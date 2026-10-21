import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A plain icon button for the window's frame: the rail (34px) and the title
 * row (30px). No fill until hover; pressed is a step darker than hover and
 * selected a full soft fill, so the three never look alike. A disabled button
 * stays focusable and keeps its tooltip, which says why.
 */
export function ChromeIconButton({
  label,
  tooltip,
  size,
  selected = false,
  disabled = false,
  side,
  onClick,
  children,
  testId,
  className,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly size: "rail" | "titlebar";
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly side: "right" | "bottom";
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            aria-disabled={disabled ? true : undefined}
            data-testid={testId}
            data-selected={selected ? "" : undefined}
            className={cn(
              "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors select-none focus-ring [-webkit-app-region:no-drag]",
              size === "rail" ? "size-[34px] [&_svg]:size-4" : "size-[30px] [&_svg]:size-4",
              disabled
                ? "cursor-default text-muted-foreground opacity-64"
                : selected
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground active:bg-sidebar-accent/80",
              className,
            )}
            onClick={() => {
              if (!disabled) onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side={side} sideOffset={6}>
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
