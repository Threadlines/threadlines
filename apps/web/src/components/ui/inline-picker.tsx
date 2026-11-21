import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { MenuTrigger } from "./menu";

/**
 * A choice inside a sentence, drawn as its words with a dotted underline that
 * darkens on hover and while its menu is open: the project in the new-thread
 * screen's "What's next in web?", or where a scheduled task's runs go. Opens
 * the `Menu` it sits in.
 */
export function InlinePickerTrigger({
  children,
  className,
  labelClassName,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  /** Classes for the underlined words (gap, size). */
  readonly labelClassName?: string;
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
}) {
  return (
    <MenuTrigger
      render={
        <button
          className={cn(
            "group inline-flex max-w-full min-w-0 cursor-pointer rounded-sm font-medium text-foreground focus-ring",
            className,
          )}
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
        />
      }
    >
      {/* Chrome never paints text-decoration under a replaced element, so
          the dotted rule is a border on a flex wrapper — that's what keeps
          the icon inside the underline instead of beside it. */}
      <span
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-1 border-b border-dotted border-muted-foreground/50 pb-0.5 align-middle leading-none transition-colors group-hover:border-foreground group-data-popup-open:border-foreground",
          labelClassName,
        )}
      >
        {children}
      </span>
    </MenuTrigger>
  );
}
