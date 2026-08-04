"use client";

import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

/**
 * The inline `(i)` affordance for detail blurbs next to a label.
 *
 * Built on Popover rather than Tooltip on purpose. A tooltip is hover-only and
 * closes on press, so clicking the icon dismisses the panel and it cannot be
 * reopened until the pointer leaves and returns -- and a touch user, who never
 * hovers, gets nothing at all. Here hover still opens the panel, and a press
 * pins it open until Escape, an outside click, or another press on the icon.
 */
export function InfoPopover({
  label,
  children,
  side = "top",
  align = "center",
  className,
  triggerClassName,
}: {
  /** Accessible name for the trigger, e.g. `Details for Claude Opus 5`. */
  readonly label: string;
  readonly children: ReactNode;
  readonly side?: Parameters<typeof PopoverPopup>[0]["side"];
  readonly align?: Parameters<typeof PopoverPopup>[0]["align"];
  /** Extra classes for the popup, typically a width clamp. */
  readonly className?: string;
  readonly triggerClassName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        closeDelay={100}
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(
              "size-5 shrink-0 rounded-sm p-0 text-muted-foreground/60 hover:text-muted-foreground data-popup-open:text-muted-foreground",
              triggerClassName,
            )}
            aria-label={label}
          >
            <InfoIcon className="size-3" />
          </Button>
        }
      />
      <PopoverPopup
        align={align}
        side={side}
        tooltipStyle
        className={cn("max-w-56 text-left", className)}
      >
        {children}
      </PopoverPopup>
    </Popover>
  );
}
