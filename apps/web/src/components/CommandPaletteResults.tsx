import { type ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { analyzeSearchText } from "@threadlines/shared/searchRanking";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode } from "react";
import { shortcutLabelForCommand } from "../keybindings";
import { splitSearchTextHighlightSegments } from "../lib/searchTextHighlight";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  COMMAND_GROUP_CLASS,
  COMMAND_RESULT_LIST_CLASS,
  COMMAND_ROW_CLASS,
  COMMAND_SECTION_LABEL_CLASS,
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { RelativeTimeLabel } from "./RelativeTimeLabel";
import { Skeleton } from "./ui/skeleton";
import { cn } from "~/lib/utils";

type ResultItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  /** Lines under the list about the search itself ("Searching messages", a computer that failed). */
  statusLines?: ReadonlyArray<string>;
  groups: ReadonlyArray<CommandPaletteGroup>;
  isLoading?: boolean | undefined;
  keybindings: ResolvedKeybindingsConfig;
  query: string;
  onExecuteItem: (item: ResultItem) => void;
}

const COMMAND_PALETTE_LOADING_ROWS = ["w-36", "w-44", "w-32", "w-40"] as const;

function StatusLines(props: { lines: ReadonlyArray<string> | undefined }) {
  if (!props.lines || props.lines.length === 0) return null;
  // Under the last group, outside any group.
  return (
    <div className="px-4 pt-0.5 pb-3" data-testid="command-palette-status">
      {props.lines.map((line) => (
        <p key={line} className="py-0.5 text-[12.5px] text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function EmptyState(props: { message: string }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{props.message}</div>;
}

/**
 * The results of Add project and the Codex import: grouped rows that the
 * dialog's own list part (`Command`) moves through. The palette draws the same
 * rows with `PaletteResultList`.
 */
export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    if (props.isLoading) {
      return <CommandPaletteResultsSkeleton />;
    }
    if (props.emptyStateMessage === "" && props.statusLines?.length) {
      return <StatusLines lines={props.statusLines} />;
    }
    return (
      <>
        <EmptyState message={props.emptyStateMessage ?? "No matches."} />
        <StatusLines lines={props.statusLines} />
      </>
    );
  }

  return (
    <>
      <CommandList
        className={cn(COMMAND_RESULT_LIST_CLASS, "not-empty:px-3 not-empty:pt-0 not-empty:pb-3")}
      >
        {props.groups.map((group) => (
          <CommandGroup items={group.items} key={group.value}>
            <CommandGroupLabel className={COMMAND_SECTION_LABEL_CLASS}>
              {group.label}
            </CommandGroupLabel>
            <div className={COMMAND_GROUP_CLASS}>
              <CommandCollection>
                {(item: ResultItem) =>
                  item.disabled ? (
                    <div
                      key={item.value}
                      className={cn(COMMAND_ROW_CLASS, "cursor-default")}
                      data-slot="command-item"
                      data-disabled=""
                    >
                      <PaletteRowContent
                        item={item}
                        keybindings={props.keybindings}
                        query={props.query}
                      />
                    </div>
                  ) : (
                    <CommandItem
                      key={item.value}
                      value={item.value}
                      className={COMMAND_ROW_CLASS}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        props.onExecuteItem(item);
                      }}
                    >
                      <PaletteRowContent
                        item={item}
                        keybindings={props.keybindings}
                        query={props.query}
                      />
                    </CommandItem>
                  )
                }
              </CommandCollection>
            </div>
          </CommandGroup>
        ))}
      </CommandList>
      <StatusLines lines={props.statusLines} />
    </>
  );
}

/** A palette row's DOM id, for the field's `aria-activedescendant`. */
export function paletteRowId(listId: string, index: number): string {
  return `${listId}-row-${index}`;
}

/**
 * The palette's results. The palette moves the highlight itself (it follows a
 * row the user chose when rows arrive above it, which a list part that tracks
 * a position can't), so this draws a plain listbox the field points into with
 * `aria-activedescendant`. Rows are the same as the dialogs'.
 */
export function PaletteResultList(props: {
  listId: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  activeValue: string | null;
  emptyStateMessage: string | null;
  statusLines: ReadonlyArray<string>;
  keybindings: ResolvedKeybindingsConfig;
  query: string;
  onHighlight: (value: string) => void;
  onExecuteItem: (item: ResultItem) => void;
}) {
  let index = 0;
  return (
    <>
      {props.groups.length === 0 && props.emptyStateMessage ? (
        <EmptyState message={props.emptyStateMessage} />
      ) : null}
      <div
        aria-label="Results"
        className={cn(COMMAND_RESULT_LIST_CLASS, props.groups.length === 0 && "hidden")}
        data-slot="command-list"
        id={props.listId}
        role="listbox"
      >
        {props.groups.map((group) => {
          const labelId = `${props.listId}-group-${group.value}`;
          return (
            <div aria-labelledby={labelId} key={group.value} role="group">
              <div
                className={COMMAND_SECTION_LABEL_CLASS}
                data-slot="command-group-label"
                id={labelId}
              >
                {group.label}
              </div>
              <div className={COMMAND_GROUP_CLASS}>
                {group.items.map((item) => {
                  const rowIndex = index++;
                  const active = !item.disabled && item.value === props.activeValue;
                  return (
                    <div
                      aria-disabled={item.disabled ? true : undefined}
                      aria-selected={active}
                      className={cn(COMMAND_ROW_CLASS, item.disabled && "cursor-default")}
                      data-highlighted={active ? "" : undefined}
                      data-slot="command-item"
                      data-value={item.value}
                      id={paletteRowId(props.listId, rowIndex)}
                      key={item.value}
                      role="option"
                      onClick={() => {
                        if (!item.disabled) props.onExecuteItem(item);
                      }}
                      onMouseDown={(event) => {
                        // The field keeps focus, so typing goes on.
                        event.preventDefault();
                      }}
                      onMouseMove={() => {
                        if (!item.disabled && !active) props.onHighlight(item.value);
                      }}
                    >
                      <PaletteRowContent
                        item={item}
                        keybindings={props.keybindings}
                        query={props.query}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <StatusLines lines={props.statusLines} />
    </>
  );
}

function CommandPaletteResultsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading command results"
      data-testid="command-palette-results-skeleton"
      className={COMMAND_RESULT_LIST_CLASS}
    >
      <Skeleton
        className={cn(COMMAND_SECTION_LABEL_CLASS, "mx-1 mt-2.5 mb-1.5 h-3 w-20 rounded-full p-0")}
      />
      <div className={COMMAND_GROUP_CLASS}>
        {COMMAND_PALETTE_LOADING_ROWS.map((width) => (
          <div key={width} className={cn(COMMAND_ROW_CLASS, "cursor-default")}>
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className={cn("h-3.5 rounded-full", width)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One row, one line: the icon, the title (a thread's status marks around it),
 * what it belongs to, then its age or shortcut. A message match adds its
 * snippet as a second line. On a phone what it belongs to moves under the
 * title, so rows are finger-sized.
 */
function PaletteRowContent(props: {
  item: ResultItem;
  keybindings: ResolvedKeybindingsConfig;
  query: string;
}) {
  const { item } = props;
  const shortcutLabel = item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, item.shortcutCommand)
    : null;
  const meta = item.whereLabel ?? item.description;
  const match = item.threadContentMatch;
  const tail: ReactNode[] = [];
  if (item.titleTrailingContent) tail.push(item.titleTrailingContent);
  if (item.timestampAt) {
    tail.push(
      <span
        key="age"
        className="min-w-6 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums"
      >
        <RelativeTimeLabel at={item.timestampAt} compact />
      </span>,
    );
  }
  if (shortcutLabel) tail.push(<CommandShortcut key="shortcut">{shortcutLabel}</CommandShortcut>);
  if (item.kind === "submenu") {
    tail.push(<ChevronRightIcon key="more" className="size-4 text-muted-foreground" />);
  }

  return (
    <>
      <span className="col-start-1 row-start-1 flex size-4 items-center justify-center [&>svg]:size-4">
        {item.more ? null : item.icon}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-1 flex min-w-0 items-center gap-1.5",
          item.more || item.disabled ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {item.titleLeadingContent}
        <span className="truncate">
          <CommandPaletteResultTitle item={item} query={props.query} />
        </span>
      </span>
      {meta ? (
        <span className="col-start-3 row-start-1 ml-3 max-w-64 truncate text-right text-[12.5px] text-muted-foreground max-sm:col-start-2 max-sm:col-end-5 max-sm:row-start-2 max-sm:ml-0 max-sm:max-w-none max-sm:text-left max-sm:text-xs">
          {meta}
        </span>
      ) : null}
      {tail.length > 0 ? (
        <span className="col-start-4 row-start-1 ml-2.5 flex items-center gap-2">{tail}</span>
      ) : null}
      {match ? (
        <span className="col-start-2 col-end-5 row-start-2 truncate text-[12.5px] text-muted-foreground max-sm:row-start-3">
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
    </>
  );
}

function CommandPaletteResultTitle(props: { item: ResultItem; query: string }) {
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
