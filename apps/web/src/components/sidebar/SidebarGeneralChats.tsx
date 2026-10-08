import { scopeThreadRef } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { MessageCirclePlusIcon, MessagesSquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import type { GeneralChatLineEntry, ThreadStatusPill } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadEnvironmentBadge, ThreadStatusText } from "./InboxRows";
import { ThreadHoverCard } from "./ThreadHoverCard";

/** One general chat as the lines read it, its status already seen-aware. */
export interface SidebarGeneralChatEntry extends GeneralChatLineEntry {
  readonly thread: SidebarThreadSummary;
}

/** What is drawn under the row: a chat's line, or the "N more" line (`entry: null`). */
interface DrawnLine {
  readonly key: string;
  readonly entry: SidebarGeneralChatEntry | null;
}

/** The "N more" line's place among the drawn lines, so it holds still with them. */
const MORE_LINE_KEY = "general-chats:more";

/** Work in flight lets its status speak; every other line keeps a bright title. */
const AT_WORK_LABELS: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Working",
  "Starting",
  "Answering",
  "Waiting",
]);

/**
 * The General Chats destination at the top of the sidebar, with a short line
 * under it for each live chat: one waiting on the user, one at work, one
 * finished and unread, and the one open in the main view. General chats never
 * join the inbox, so without these lines a chat could finish or stop to ask
 * something with nothing in the sidebar saying so. At rest it is one row.
 *
 * The sidebar picks the lines (`selectGeneralChatLines`), because its
 * previous/next shortcuts walk them too; this draws them, holding them still
 * under a pointer. `entries` is every unarchived general chat on every
 * connected machine: like the Pull Requests row beside it, this row sits
 * above the inbox's machine filter and answers for all of them.
 */
export function SidebarGeneralChats({
  entries,
  lines,
  hiddenCount,
  activeThreadKey,
  isOnChatsPage,
  onOpenChats,
  onNewChat,
  onOpenChat,
}: {
  readonly entries: readonly SidebarGeneralChatEntry[];
  readonly lines: readonly SidebarGeneralChatEntry[];
  readonly hiddenCount: number;
  readonly activeThreadKey: string | null;
  readonly isOnChatsPage: boolean;
  readonly onOpenChats: () => void;
  readonly onNewChat: () => void;
  readonly onOpenChat: (threadRef: ScopedThreadRef) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.threadKey, entry] as const)),
    [entries],
  );
  const nextLines = useMemo(
    (): readonly DrawnLine[] => [
      ...lines.map((entry) => ({ key: entry.threadKey, entry })),
      ...(hiddenCount > 0 ? [{ key: MORE_LINE_KEY, entry: null }] : []),
    ],
    [hiddenCount, lines],
  );
  const drawnLines = useHeldList(nextLines, useSidebarPointerHold(rootRef));

  return (
    <div ref={rootRef} data-testid="sidebar-general-chats-block">
      <div className="group/chats-row relative mt-1 px-2 pt-1 pb-0.5">
        <button
          type="button"
          data-testid="sidebar-general-chats"
          aria-current={isOnChatsPage ? "page" : undefined}
          className={cn(
            "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-xs transition-colors select-none focus-ring",
            // The fill answers to the wrapper, not to this button: reaching
            // for the new-chat icon leaves the row element, and the row
            // should not go dark under your cursor.
            isOnChatsPage
              ? "bg-sidebar-accent text-foreground"
              : "text-foreground/85 group-hover/chats-row:bg-sidebar-accent/60 group-hover/chats-row:text-foreground",
          )}
          onClick={onOpenChats}
        >
          <MessagesSquareIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">General Chats</span>
        </button>
        {/* A sibling, not a child: a button inside a button is invalid, and
            starting a chat should not first walk you to the page. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-new-general-chat"
                aria-label="New general chat"
                className="absolute top-1/2 right-3 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-ring group-hover/chats-row:opacity-100 group-focus-within/chats-row:opacity-100 pointer-coarse:opacity-100"
                onClick={onNewChat}
              />
            }
          >
            <MessageCirclePlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">New general chat</TooltipPopup>
        </Tooltip>
      </div>
      {drawnLines.length > 0 ? (
        <ul aria-label="Live general chats" className="flex flex-col gap-px px-2 pb-0.5">
          {drawnLines.map(({ key, entry }) => (
            <li key={key}>
              {entry === null ? (
                <button
                  type="button"
                  data-testid="sidebar-general-chats-more"
                  className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-[11px] text-muted-foreground transition-colors select-none hover:bg-sidebar-accent/60 hover:text-foreground focus-ring"
                  onClick={onOpenChats}
                >
                  <span aria-hidden="true" className="size-3.5 shrink-0" />
                  {/* Held in place, the line can outlive the chats it
                      counted; it still leads to all of them. */}
                  <span className="min-w-0 truncate">
                    {hiddenCount > 0 ? `${hiddenCount} more` : "All chats"}
                  </span>
                </button>
              ) : (
                <GeneralChatLineButton
                  // A chat archived or deleted while held keeps its place,
                  // inert, until the hold lets go.
                  entry={entryByKey.get(key) ?? null}
                  heldEntry={entry}
                  isActive={key === activeThreadKey}
                  onOpen={onOpenChat}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GeneralChatLineButton({
  entry,
  heldEntry,
  isActive,
  onOpen,
}: {
  /** The chat as it is now; null once it is archived or deleted. */
  readonly entry: SidebarGeneralChatEntry | null;
  /** The chat as it was when its line was drawn. */
  readonly heldEntry: SidebarGeneralChatEntry;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gone = entry === null;
  const thread = (entry ?? heldEntry).thread;
  const status = entry?.status ?? null;
  const quietTitle = !isActive && (status === null || AT_WORK_LABELS.has(status.label));
  const button = (
    <button
      type="button"
      data-testid={`sidebar-general-chat-${thread.id}`}
      aria-current={isActive ? "page" : undefined}
      disabled={gone}
      className={cn(
        "flex h-6 w-full min-w-0 items-center gap-2 rounded-md px-1 text-xs transition-colors select-none focus-ring",
        gone ? "cursor-default" : "cursor-pointer",
        isActive ? "bg-sidebar-accent" : !gone && "hover:bg-sidebar-accent/60",
      )}
      onClick={() => onOpen(scopeThreadRef(thread.environmentId, thread.id))}
    >
      {/* The dot sits under the row's icon and the title under its label,
          so the lines read as the row's own. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {status ? (
          <span
            aria-label={status.label}
            className={cn("size-[7px] rounded-full", status.dotClass)}
          />
        ) : null}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left",
          quietTitle ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {thread.title}
      </span>
      <span className="me-1 flex shrink-0 items-center gap-1.5">
        <ThreadEnvironmentBadge thread={thread} />
        {gone ? null : (
          <ThreadStatusText
            thread={thread}
            status={status}
            restingClassName="text-muted-foreground"
            testId={`sidebar-general-chat-status-${thread.id}`}
          />
        )}
      </span>
    </button>
  );
  return gone ? (
    button
  ) : (
    <ThreadHoverCard thread={thread} status={status}>
      {button}
    </ThreadHoverCard>
  );
}

/**
 * The list to draw: the live one, except while `holding`, when the items
 * drawn as the hold began keep their places and newcomers wait.
 */
function useHeldList<T>(next: readonly T[], holding: boolean): readonly T[] {
  const [held, setHeld] = useState<readonly T[] | null>(null);
  if (!holding) {
    if (held !== null) setHeld(null);
    return next;
  }
  if (held === null) {
    setHeld(next);
    return next;
  }
  return held;
}

/**
 * True while a mouse is over the sidebar. The lines under General Chats hold
 * still then, because one arriving or leaving moves every row below it, and
 * a row should not jump out from under a pointer about to click it. A key
 * press or the window losing focus lets go (whoever is typing is not aiming),
 * and the next mouse move over the sidebar takes hold again. Touch never
 * holds: a tap has already landed by the time anything could move.
 */
function useSidebarPointerHold(ref: RefObject<HTMLElement | null>): boolean {
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    const element = ref.current;
    const container = element?.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? element;
    if (!container) return;
    let current = false;
    const update = (next: boolean) => {
      if (next === current) return;
      current = next;
      setHolding(next);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") update(true);
    };
    const release = () => update(false);
    // Mounted under a resting pointer: hold from the start.
    update(container.matches(":hover"));
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", release);
    window.addEventListener("keydown", release, true);
    window.addEventListener("blur", release);
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", release);
      window.removeEventListener("keydown", release, true);
      window.removeEventListener("blur", release);
    };
  }, [ref]);
  return holding;
}
