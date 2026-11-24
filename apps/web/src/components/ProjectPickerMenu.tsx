import { DEFAULT_SIDEBAR_PROJECT_SORT_ORDER } from "@threadlines/contracts/settings";
import type { EnvironmentId } from "@threadlines/contracts";
import { GripVerticalIcon, PinIcon, PinOffIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { dragReorderVisual, usePointerDragReorder } from "../hooks/usePointerDragReorder";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { isProjectPinned, moveAmongPeers } from "../projectPickerOrder";
import { useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
  Menu,
  MenuFilterInput,
  MenuFilterProvider,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuList,
  MenuPopup,
  MenuSeparator,
} from "./ui/menu";

/**
 * Past this many projects a project menu gets a search line. Fewer fit on
 * screen at once, where a search box would only be one more row to look past.
 */
export const PROJECT_SEARCH_MIN_PROJECTS = 9;

/** One project in a ProjectPickerMenu. */
export interface ProjectPickerRow {
  readonly key: string;
  readonly name: string;
  /** The folder shown on hover, and matched by a search. */
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  /** The project's checkouts as keys of the saved order (`UiProjectState.projectOrder`). */
  readonly orderKeys: readonly string[];
  /** The project's checkouts' folders, which is what a pin holds. */
  readonly cwds: readonly string[];
  readonly selected: boolean;
  /** Drawn at the row's end, such as which computers the project is on. */
  readonly trailing?: ReactNode;
}

/**
 * For a button inside a menu row: Enter and Space press the button itself.
 * Left to bubble, the menu would read them as picking the row (or, while a
 * search holds focus, the highlighted match) instead.
 */
export function keepActivationKeys(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
  }
}

function normalized(text: string): string {
  return text.toLocaleLowerCase();
}

/** The last two parts of a folder, which is what tells most checkouts apart. */
function folderTail(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

/**
 * The project list for starting a thread somewhere: the new-thread screen's
 * "What's next in …?" and the empty home screen's "New thread in…". Pinned
 * projects sit in their own group on top. A long list gets a search line that
 * matches names and folders. Rows drag to reorder within their group, by mouse
 * or pen anywhere on the row, by finger on the grip, or with Alt and the arrow
 * keys; Alt+P pins the highlighted row. The first drag switches the order from
 * activity to the user's own; "Reset to automatic order" switches it back.
 * Pins and order are kept on this device and shared by every project picker
 * that reads `useHandleNewThread().orderedProjects`.
 */
export function ProjectPickerMenu(props: {
  /** A MenuTrigger. */
  readonly trigger: ReactNode;
  readonly align: "start" | "center" | "end";
  /** Every project, already in picker order (`useHandleNewThread().orderedProjects`). */
  readonly rows: readonly ProjectPickerRow[];
  /** Names the list while nothing is pinned. */
  readonly label: string;
  /** Rows above the projects, such as General chat. Hidden while a search is typed. */
  readonly header?: ReactNode;
  readonly onPick: (row: ProjectPickerRow) => void;
}) {
  const { rows } = props;
  const [query, setQuery] = useState("");
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const canHoverPin = useMediaQuery("(hover: hover) and (pointer: fine)");
  const showSearch = !isCoarsePointer && rows.length >= PROJECT_SEARCH_MIN_PROJECTS;
  const searching = showSearch && query.trim().length > 0;

  const pinnedProjectCwds = useUiStateStore((store) => store.pinnedProjectCwds);
  const setProjectPinned = useUiStateStore((store) => store.setProjectPinned);
  const setProjectOrder = useUiStateStore((store) => store.setProjectOrder);
  const sortOrder = useSettings((settings) => settings.sidebarProjectSortOrder);
  const { updateSettings } = useUpdateSettings();

  const needle = normalized(query.trim());
  const matchesName = (row: ProjectPickerRow) => normalized(row.name).includes(needle);
  const shown = searching
    ? rows.filter(
        (row) =>
          matchesName(row) ||
          [row.cwd, ...row.cwds].some((cwd) => normalized(cwd).includes(needle)),
      )
    : rows;
  const pinnedRows = shown.filter((row) => isProjectPinned(row.cwds, pinnedProjectCwds));
  const otherRows = shown.filter((row) => !isProjectPinned(row.cwds, pinnedProjectCwds));
  /** The rows a row swaps with: its own group, as shown. */
  const peersOf = (key: string) =>
    pinnedRows.some((row) => row.key === key) ? pinnedRows : otherRows;

  // Fresh each render: the drag hook reads its latest `onReorder` and `measure`.
  const move = (key: string, toIndex: number) => {
    const peers = peersOf(key);
    const from = peers.findIndex((row) => row.key === key);
    if (from === -1 || toIndex === from || toIndex < 0 || toIndex >= peers.length) return;
    // The whole list as shown, with only the shown rows of this group trading
    // places: a row a search hid, or one in the other group, keeps its slot,
    // and a project's checkouts stay together.
    setProjectOrder(moveAmongPeers(rows, peers, from, toIndex).flatMap((row) => row.orderKeys));
    if (sortOrder !== "manual") {
      updateSettings({ sidebarProjectSortOrder: "manual" });
    }
  };

  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollContainer = () =>
    listRef.current?.closest<HTMLElement>('[data-slot="menu-popup"]')
      ?.firstElementChild as HTMLElement | null;
  const { drag, beginDrag, suppressDragClick } = usePointerDragReorder<string>({
    axis: "y",
    measure: (key) => {
      const list = listRef.current;
      const scroller = scrollContainer();
      if (list === null) return null;
      const origin = scroller?.getBoundingClientRect().top ?? 0;
      const scrolled = scroller?.scrollTop ?? 0;
      const order = peersOf(key).map((row) => row.key);
      const bounds = order.map((rowKey) => {
        const box = list
          .querySelector<HTMLElement>(`[data-project-picker-row="${CSS.escape(rowKey)}"]`)
          ?.getBoundingClientRect();
        return { start: (box?.top ?? 0) - origin + scrolled, size: box?.height ?? 0 };
      });
      return { order, bounds };
    },
    onReorder: move,
    layoutKey: `${shown.map((row) => row.key).join("\n")}|${pinnedProjectCwds.join("\n")}`,
    scrollContainer,
  });

  const highlightedKey = (event: React.KeyboardEvent) =>
    (event.currentTarget as HTMLElement)
      .querySelector<HTMLElement>("[data-project-picker-row][data-highlighted]")
      ?.getAttribute("data-project-picker-row") ?? null;

  // The menu drops or resets its highlight when rows change places, by design.
  // Once it has, a pointer move puts it back on the row the keyboard moved or
  // pinned, so the next key carries on with it.
  const keepHighlight = (key: string) => {
    const list = listRef.current;
    requestAnimationFrame(() => {
      list
        ?.querySelector(`[data-project-picker-row="${CSS.escape(key)}"]`)
        // Some movement: WebKit's menus ignore a pointer that didn't move.
        ?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 1 }));
    });
  };

  // Capture: read the highlighted row before the menu moves its highlight.
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    const key = highlightedKey(event);
    if (key === null) return;
    if (event.code === "KeyP") {
      event.preventDefault();
      event.stopPropagation();
      const row = rows.find((candidate) => candidate.key === key);
      if (row) {
        setProjectPinned(row.cwds, !isProjectPinned(row.cwds, pinnedProjectCwds));
        keepHighlight(key);
      }
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const peers = peersOf(key);
    const from = peers.findIndex((row) => row.key === key);
    const to = from + (event.key === "ArrowUp" ? -1 : 1);
    // The arrow is the move's alone: left to go on, it would move the highlight.
    event.preventDefault();
    event.stopPropagation();
    if (from === -1 || to < 0 || to >= peers.length) return;
    move(key, to);
    keepHighlight(key);
  };

  const renderRow = (row: ProjectPickerRow) => {
    const pinned = isProjectPinned(row.cwds, pinnedProjectCwds);
    const visual = dragReorderVisual(drag, row.key);
    const folderHint = searching && !matchesName(row) ? folderTail(row.cwd) : null;
    const pinButton = (placement: "overlay" | "trailing") => (
      <button
        type="button"
        data-testid={`project-picker-pin-${row.key}`}
        aria-label={pinned ? `Unpin ${row.name}` : `Pin ${row.name} to the top`}
        aria-pressed={pinned}
        title={pinned ? "Unpin (⌥P)" : "Pin to the top (⌥P)"}
        className={cn(
          "size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-ring",
          placement === "overlay"
            ? // Swaps into the project icon's footprint on row hover so the menu
              // width and trailing glyphs never shift. Keyboard users have ⌥P.
              "absolute inset-1/2 hidden -translate-x-1/2 -translate-y-1/2 group-hover/project-row:inline-flex"
            : "-me-1 inline-flex shrink-0",
        )}
        onKeyDown={keepActivationKeys}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setProjectPinned(row.cwds, !pinned);
        }}
      >
        {pinned ? (
          placement === "overlay" ? (
            <PinOffIcon className="size-3.5" />
          ) : (
            <PinIcon className="size-3 text-foreground" />
          )
        ) : (
          <PinIcon className={placement === "overlay" ? "size-3.5" : "size-3"} />
        )}
      </button>
    );

    return (
      <MenuItem
        key={row.key}
        label={row.name}
        data-project-picker-row={row.key}
        data-dragging={visual?.kind === "dragged" ? "true" : undefined}
        className={cn(
          "group/project-row relative",
          MENU_PICK_ITEM_CLASS_NAME,
          row.selected && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
          // The held row rides over its neighbours on an opaque fill; the rest
          // slide. Only a settling row transitions: under the pointer it tracks.
          visual?.kind === "dragged" &&
            "z-10 bg-popover text-foreground shadow-md inset-ring inset-ring-border",
          visual !== null &&
            (visual.kind === "shifted" || visual.settling) &&
            "transition-transform duration-150 ease-out",
        )}
        {...(visual ? { style: { transform: `translateY(${visual.offset}px)` } } : {})}
        title={row.cwd}
        onClick={() => props.onPick(row)}
        onClickCapture={suppressDragClick}
        onPointerDown={(event) => {
          // A finger on a row is scrolling; fingers drag by the grip.
          if (event.pointerType === "touch") return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if ((event.target as Element).closest("button")) return;
          beginDrag(row.key, event);
        }}
        // A project's picture would otherwise start the browser's own image drag.
        onDragStart={(event) => event.preventDefault()}
      >
        {isCoarsePointer && peersOf(row.key).length > 1 ? (
          <span
            aria-hidden
            data-project-picker-grip
            className="-ms-1 flex shrink-0 touch-none items-center self-stretch text-muted-foreground/60"
            onPointerDown={(event) => {
              event.stopPropagation();
              beginDrag(row.key, event);
            }}
          >
            <GripVerticalIcon className="size-3.5" />
          </span>
        ) : null}
        <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
          <ProjectFavicon
            cwd={row.cwd}
            environmentId={row.environmentId}
            name={row.name}
            className={cn(canHoverPin && "group-hover/project-row:opacity-0")}
          />
          {canHoverPin ? pinButton("overlay") : null}
        </span>
        <span className="max-w-56 min-w-0 flex-1 truncate">{row.name}</span>
        {folderHint ? (
          <span className="max-w-32 shrink truncate font-mono text-[10px] text-muted-foreground">
            {folderHint}
          </span>
        ) : null}
        {row.trailing}
        {!canHoverPin ? pinButton("trailing") : null}
      </MenuItem>
    );
  };

  const popup = (
    <MenuPopup align={props.align} onKeyDownCapture={onKeyDownCapture}>
      {showSearch ? (
        <MenuFilterInput
          data-testid="project-picker-search"
          aria-label="Find a project"
          placeholder="Find a project"
        />
      ) : null}
      <MenuList
        ref={listRef}
        // Rows ignore the pointer while one rides it: no hover fills underneath.
        className={cn(
          drag !== null && "cursor-grabbing [&_[data-project-picker-row]]:pointer-events-none",
        )}
      >
        {searching || props.header === undefined ? null : (
          <>
            {props.header}
            <MenuSeparator />
          </>
        )}
        {pinnedRows.length > 0 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Pinned</MenuGroupLabel>
              {pinnedRows.map(renderRow)}
            </MenuGroup>
            {otherRows.length > 0 ? <MenuSeparator /> : null}
          </>
        ) : null}
        {otherRows.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>{pinnedRows.length > 0 ? "Projects" : props.label}</MenuGroupLabel>
            {otherRows.map(renderRow)}
          </MenuGroup>
        ) : null}
        {sortOrder === "manual" && !searching ? (
          <>
            <MenuSeparator />
            <MenuItem
              data-testid="project-picker-reset-order"
              className={MENU_PICK_ITEM_CLASS_NAME}
              closeOnClick={false}
              onClick={() =>
                updateSettings({ sidebarProjectSortOrder: DEFAULT_SIDEBAR_PROJECT_SORT_ORDER })
              }
            >
              <RotateCcwIcon className="size-3.5" />
              Reset to automatic order
            </MenuItem>
          </>
        ) : null}
      </MenuList>
      {searching && shown.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching projects</div>
      ) : null}
    </MenuPopup>
  );

  const menu = (
    <Menu>
      {props.trigger}
      {popup}
    </Menu>
  );
  return showSearch ? (
    <MenuFilterProvider autoHighlight filter={null} value={query} onValueChange={setQuery}>
      {menu}
    </MenuFilterProvider>
  ) : (
    menu
  );
}
