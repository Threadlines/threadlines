/**
 * The thread's title in the chat header, as the way to its menu: a click (or
 * Enter, Space, a tap) opens under the title the same menu its sidebar row
 * opens on a right-click (useThreadMenu), with Rename, Pin, Move to another
 * computer, Archive and the rest. Wherever the header sits: its own row, the
 * window's title row (titleBarSlot), or a phone. In the desktop app a press
 * that drags moves the window instead (useWindowDragPress).
 *
 * @module ThreadTitleMenu
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useInboxThreads } from "../../hooks/useInboxThreads";
import { useThreadMenu } from "../../hooks/useThreadMenu";
import { useWindowDragPress } from "../../hooks/useWindowDragPress";

type MenuPosition = { readonly x: number; readonly y: number };

export const ThreadTitleMenu = memo(function ThreadTitleMenu({
  threadRef,
  title,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}) {
  const [openAt, setOpenAt] = useState<MenuPosition | null>(null);
  const closed = useCallback(() => setOpenAt(null), []);
  // In the desktop app, press and drag moves the window instead.
  const dragPress = useWindowDragPress();
  return (
    <>
      <button
        {...(dragPress ?? {})}
        type="button"
        aria-label={`${title}, thread menu`}
        aria-haspopup="menu"
        aria-expanded={openAt !== null}
        title={title}
        data-testid="chat-header-thread-menu"
        className="-ms-1 inline-flex min-w-0 cursor-pointer items-center gap-0.5 rounded-md px-1 py-0.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent"
        onClick={(event) => {
          if (openAt !== null) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setOpenAt({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {openAt !== null ? (
        <ThreadTitleMenuOpener threadRef={threadRef} position={openAt} onClosed={closed} />
      ) : null}
    </>
  );
});

/**
 * Opens the menu once, then reports it closed. Mounted only while the menu is
 * asked for, so the header doesn't follow the inbox the rest of the time: the
 * inbox says whether the menu offers Wrap up or Reopen, as it does on the row.
 */
function ThreadTitleMenuOpener({
  threadRef,
  position,
  onClosed,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly position: MenuPosition;
  readonly onClosed: () => void;
}) {
  const threadMenu = useThreadMenu();
  const { entries } = useInboxThreads();
  const threadKey = scopedThreadKey(threadRef);
  const entry = entries.find((candidate) => candidate.threadKey === threadKey) ?? null;
  const isDone = entry?.isDone ?? null;
  const canMarkDone = entry?.canMarkDone ?? null;
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const inbox = isDone === null || canMarkDone === null ? null : { isDone, canMarkDone };
    void threadMenu.open({ threadRef, inbox }, position).finally(onClosed);
  }, [canMarkDone, isDone, onClosed, position, threadMenu, threadRef]);
  return null;
}
