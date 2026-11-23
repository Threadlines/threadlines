/**
 * The open thread's own commands for the palette: its menu's actions, run
 * through `useThreadMenu` with the menu's confirmations, and Move. Registered
 * while the palette is open (PaletteCommandSources).
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";
import type { AppCommandId } from "@threadlines/shared/appCommands";

import type { ThreadMenuAction } from "../components/threadMenu.logic";
import { openThreadMoveDialog } from "../components/ThreadMoveDialog";
import { useThreadMoveOffered } from "../environments/links/threadMoves";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useInboxThreads } from "../hooks/useInboxThreads";
import { useThreadMenu } from "../hooks/useThreadMenu";
import { selectThreadByRef, useStore } from "../store";
import { threadMoveStatus } from "../threadMove";
import {
  useCommandHandlers,
  type CommandActionHandler,
  type CommandHandlerMap,
} from "./commandHandlers";

/**
 * The menu's actions the palette offers, by their command. Mark unread,
 * separate, put back, stop children and move up or down stay in the menu;
 * Move is its own command below.
 */
const PALETTE_THREAD_ACTIONS: Partial<Record<ThreadMenuAction, AppCommandId>> = {
  rename: "thread.rename",
  pin: "thread.pin",
  unpin: "thread.unpin",
  "copy-path": "thread.copyPath",
  "copy-thread-id": "thread.copyId",
  archive: "thread.archive",
  delete: "thread.delete",
};

/**
 * The menu's actions that need the inbox's word on the thread: Wrap up or
 * Reopen, and making it the lead, which reopens a wrapped thread.
 */
const INBOX_THREAD_ACTIONS: Partial<Record<ThreadMenuAction, AppCommandId>> = {
  "make-lead": "thread.makeLead",
  "stop-lead": "thread.stopLead",
  "wrap-up": "thread.wrapUp",
  reopen: "thread.reopen",
};

/** The menu's words for these, which change with the thread; the rest use the catalog's. */
const ACTIONS_WITH_MENU_WORDS = new Set<ThreadMenuAction>(["make-lead", "stop-lead"]);

type InboxFacts = { readonly isDone: boolean; readonly canMarkDone: boolean } | null;

function menuCommandHandlers(input: {
  readonly threadMenu: ReturnType<typeof useThreadMenu>;
  readonly threadRef: ScopedThreadRef;
  readonly inbox: InboxFacts;
  readonly actions: Partial<Record<ThreadMenuAction, AppCommandId>>;
}): Partial<Record<AppCommandId, CommandActionHandler>> {
  const target = { threadRef: input.threadRef, inbox: input.inbox };
  const handlers: Partial<Record<AppCommandId, CommandActionHandler>> = {};
  for (const item of input.threadMenu.describe(target) ?? []) {
    const commandId = input.actions[item.id];
    if (!commandId || item.disabled) continue;
    handlers[commandId] = {
      ...(ACTIONS_WITH_MENU_WORDS.has(item.id) ? { title: item.label } : {}),
      run: () => input.threadMenu.run(item.id, target),
    };
  }
  return handlers;
}

/** The open thread's project, or null while no saved thread is open. */
function useOpenThreadProjectId(threadRef: ScopedThreadRef | null) {
  return useStore((state) =>
    threadRef ? (selectThreadByRef(state, threadRef)?.projectId ?? null) : null,
  );
}

/**
 * The open thread's menu actions that don't need the inbox, and Move. It
 * reads single facts about the thread, so a streamed reply re-renders none
 * of it.
 */
export function useThreadCommands(): void {
  const { routeThreadRef } = useHandleNewThread();
  // The facts these commands read about the open thread, not the thread:
  // its project (null while it isn't saved), whether it is pinned, and where
  // it is in a move.
  const threadProjectId = useOpenThreadProjectId(routeThreadRef);
  useStore((state) =>
    routeThreadRef ? (selectThreadByRef(state, routeThreadRef)?.pinnedAt ?? null) : null,
  );
  const moveStatus = useStore((state) => {
    const thread = routeThreadRef ? selectThreadByRef(state, routeThreadRef) : undefined;
    return thread ? threadMoveStatus(thread) : undefined;
  });
  const threadMenu = useThreadMenu();
  const moveOffered = useThreadMoveOffered(
    routeThreadRef && threadProjectId !== null
      ? { environmentId: routeThreadRef.environmentId, projectId: threadProjectId, moveStatus }
      : null,
  );

  let handlers: Partial<Record<AppCommandId, CommandActionHandler | false>> = {};
  if (routeThreadRef && threadProjectId !== null) {
    const threadRef = routeThreadRef;
    handlers = menuCommandHandlers({
      threadMenu,
      threadRef,
      inbox: null,
      actions: PALETTE_THREAD_ACTIONS,
    });
    // Where its computer can move it: one linked computer at least, and the
    // thread not already on its way. The dialog says why one can't go.
    // Its dialog returns focus to what had it when it opened, which the
    // palette's own focus return makes the composer: no hand-over here.
    handlers["thread.move"] = moveOffered && { run: () => openThreadMoveDialog(threadRef) };
  }
  useCommandHandlers(handlers as CommandHandlerMap);
}

/**
 * Wrap up, Reopen and the lead commands for the open thread. The inbox says
 * which apply, and reading it re-derives every thread's place on each change,
 * a streamed token included, so this source is kept apart from the rest.
 */
export function useThreadInboxCommands(): void {
  const { routeThreadRef } = useHandleNewThread();
  const threadProjectId = useOpenThreadProjectId(routeThreadRef);
  const threadMenu = useThreadMenu();
  const { entries } = useInboxThreads();
  let handlers: Partial<Record<AppCommandId, CommandActionHandler>> = {};
  if (routeThreadRef && threadProjectId !== null) {
    const threadKey = scopedThreadKey(routeThreadRef);
    const entry = entries.find((candidate) => candidate.threadKey === threadKey);
    handlers = menuCommandHandlers({
      threadMenu,
      threadRef: routeThreadRef,
      inbox: entry ? { isDone: entry.isDone, canMarkDone: entry.canMarkDone } : null,
      actions: INBOX_THREAD_ACTIONS,
    });
  }
  useCommandHandlers(handlers as CommandHandlerMap);
}
