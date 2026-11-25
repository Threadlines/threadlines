"use client";

import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteSeparator,
} from "~/components/ui/autocomplete";
import {
  CommandCreateHandle,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
} from "~/components/ui/commandDialog";

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  wrapperClassName,
  placeholder = undefined,
  ...props
}: React.ComponentProps<typeof AutocompleteInput> & {
  wrapperClassName?: string | undefined;
}) {
  return (
    <div className={cn("px-1.5 pt-1.5", wrapperClassName)}>
      <AutocompleteInput
        autoFocus
        className={cn(
          "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0! *:data-[slot=autocomplete-input]:text-[15px]",
          className,
        )}
        placeholder={placeholder}
        size="lg"
        startAddon={<SearchIcon />}
        {...props}
      />
    </div>
  );
}

/**
 * A dialog's name above its field ("Add project · Choose a folder"), for the
 * dialogs built from these parts. The palette has none: its field says it.
 */
function CommandTitle({
  title,
  step,
  className,
}: {
  title: string;
  step?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn("flex min-w-0 items-baseline gap-1.5 px-4 pt-3 text-[13px]", className)}
      data-slot="command-title"
    >
      <span className="shrink-0 font-semibold text-foreground">{title}</span>
      {step ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="truncate text-muted-foreground">{step}</span>
        </>
      ) : null}
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof AutocompleteEmpty>) {
  return (
    <AutocompleteEmpty
      className={cn("not-empty:py-6", className)}
      data-slot="command-empty"
      {...props}
    />
  );
}

/** The list's area: no box of its own, the groups inside carry the structure. */
function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex min-h-0 flex-col [touch-action:pan-y]", className)}
      data-slot="command-panel"
      {...props}
    />
  );
}

/**
 * The parts of a grouped result list (docs/design/command-palette.md, section
 * 8): a section label above its group, outside it, aligned with the row text;
 * the group, a quiet filled block (`surface-group`); and its rows, one line
 * each, with an inset hairline above every row but the first that starts at
 * the row's text (past the 16px icon and its 10px gap, the first column). The highlighted row takes the soft
 * accent fill edge to edge and hides the hairlines beside it, which
 * `SETTINGS_GROUP_ROW_CLASS` can't, since a group there never highlights.
 */
const COMMAND_RESULT_LIST_CLASS = "flex flex-col px-3 pb-3";
const COMMAND_SECTION_LABEL_CLASS =
  "px-1 pt-2.5 pb-1.5 text-[11.5px] leading-4 text-muted-foreground first:pt-1";
const COMMAND_GROUP_CLASS = "surface-group overflow-hidden";
const COMMAND_ROW_CLASS =
  "relative grid min-h-[34px] cursor-pointer select-none grid-cols-[26px_minmax(0,1fr)_auto_auto] items-center rounded-none px-3 py-[7px] text-[13.5px] leading-[19px] outline-none sm:min-h-[34px] sm:text-[13.5px] " +
  "not-first:before:pointer-events-none not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[38px] not-first:before:h-px not-first:before:bg-group-divider " +
  "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:before:hidden [[data-highlighted]+&]:before:hidden " +
  "max-sm:py-[9px]";

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) {
  return (
    <AutocompleteItem className={cn("py-1.5", className)} data-slot="command-item" {...props} />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteSeparator>) {
  return (
    <AutocompleteSeparator
      className={cn("my-2", className)}
      data-slot="command-separator"
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "shrink-0 font-mono text-[10.5px] text-muted-foreground tracking-[0.08em]",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // A key group is a <kbd>: its words keep the app's type, not the browser's mono.
        "flex items-center gap-3.5 border-t px-3.5 py-2 text-muted-foreground text-xs *:data-[slot=kbd-group]:font-sans",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

export {
  COMMAND_GROUP_CLASS,
  COMMAND_RESULT_LIST_CLASS,
  COMMAND_ROW_CLASS,
  COMMAND_SECTION_LABEL_CLASS,
  CommandCreateHandle,
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
  CommandTitle,
};
