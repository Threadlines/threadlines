import { type ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { analyzeSearchText } from "@threadlines/shared/searchRanking";
import { ChevronRightIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../keybindings";
import { splitSearchTextHighlightSegments } from "../lib/searchTextHighlight";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { cn } from "~/lib/utils";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  query: string;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ??
          (props.isActionsOnly
            ? "No matching actions."
            : "No matching commands, projects, or threads.")}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel>{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} query={props.query} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  query={props.query}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  query: string;
}) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      {props.item.icon}
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">
              <CommandPaletteResultTitle item={props.item} query={props.query} />
            </span>
          </span>
          <CommandPaletteResultDescription item={props.item} />
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">
            <CommandPaletteResultTitle item={props.item} query={props.query} />
          </span>
        </span>
      )}
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  query: string;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">
              <CommandPaletteResultTitle item={props.item} query={props.query} />
            </span>
          </span>
          <CommandPaletteResultDescription item={props.item} />
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">
            <CommandPaletteResultTitle item={props.item} query={props.query} />
          </span>
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground/50" />
      ) : null}
    </CommandItem>
  );
}

function CommandPaletteResultTitle(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  query: string;
}) {
  if (
    !props.item.threadRef ||
    typeof props.item.title !== "string" ||
    !analyzeSearchText(props.item.title, props.query)
  ) {
    return props.item.title;
  }

  return splitSearchTextHighlightSegments(props.item.title, props.query).map((segment) =>
    segment.highlighted ? (
      <mark key={`match:${segment.start}:${segment.end}`} className="thread-search-title-match">
        {segment.text}
      </mark>
    ) : (
      <span key={`text:${segment.start}:${segment.end}`}>{segment.text}</span>
    ),
  );
}

function CommandPaletteResultDescription(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  const match = props.item.threadContentMatch;
  return (
    <span className="truncate text-xs">
      {props.item.description ? (
        <span className="text-muted-foreground/60">{props.item.description}</span>
      ) : null}
      {props.item.description && match ? (
        <span aria-hidden="true" className="px-1 text-muted-foreground/35">
          —
        </span>
      ) : null}
      {match ? (
        <span className="text-muted-foreground/80">
          {splitSearchTextHighlightSegments(match.snippet, match.query).map((segment) =>
            segment.highlighted ? (
              <mark
                key={`match:${segment.start}:${segment.end}`}
                className="thread-search-palette-match"
              >
                {segment.text}
              </mark>
            ) : (
              <span key={`text:${segment.start}:${segment.end}`}>{segment.text}</span>
            ),
          )}
        </span>
      ) : null}
    </span>
  );
}
