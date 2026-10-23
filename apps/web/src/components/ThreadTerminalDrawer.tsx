import {
  CheckIcon,
  ChevronDown,
  CopyIcon,
  Ellipsis,
  Plus,
  Search,
  SquareSplitHorizontal,
  XIcon,
} from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalTab,
  type ThreadId,
} from "@threadlines/contracts";
import type { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { isElectron } from "../env";
import { openInPreferredEditor } from "../editorPreferences";
import {
  canOpenInBrowserPanel,
  openUrlInBrowserPanel,
  readLinkOpenTarget,
} from "./browser/openInBrowserPanel";
import { createXtermSurface, terminalThemeFromApp } from "./terminal/xtermSurface";
import { TerminalFindBar } from "./terminal/TerminalFindBar";
import { controlCodeFor, TerminalKeyRow } from "./terminal/TerminalKeyRow";
import { type TerminalStripTab, TerminalTabStrip } from "./terminal/TerminalTabStrip";
import { copyTextWithToast } from "./chat/copyTextWithToast";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
  type TerminalLinkMatch,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalFindShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import {
  noteTerminalLineEntered,
  shouldMakeTerminal,
  terminalTabNumbers,
} from "../terminalStateStore";
import {
  readTerminalBuffer,
  readTerminalProtocol,
  subscribeTerminalBuffer,
  type TerminalThreadStreamState,
} from "../terminalStreams";

const MIN_DRAWER_HEIGHT = DEFAULT_THREAD_TERMINAL_HEIGHT;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
// Below this viewport width (Tailwind `sm`) the drawer floors at a viewport
// fraction instead: the desktop pixel minimum leaves a few terminal rows on a
// phone, and the on-screen keyboard would claim most of those.
const NARROW_VIEWPORT_WIDTH = 640;
const NARROW_MIN_DRAWER_HEIGHT_RATIO = 0.4;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const TERMINAL_SELECTION_ACTION_POPOVER_WIDTH_PX = 148;
const TERMINAL_SELECTION_ACTION_POPOVER_HEIGHT_PX = 34;
const TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX = 8;
/** How far one arrow key moves the drawer's edge. */
const DRAWER_KEYBOARD_RESIZE_STEP_PX = 24;
/**
 * How long a tab waits for its thread's stream to say nothing can be missed
 * before opening anyway, while nothing says whether the server keeps tab
 * lists (one from before them never says so; when a newer one says it later,
 * the tab is drawn again then).
 */
const STREAM_READY_FALLBACK_MS = 1_500;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function minDrawerHeight(): number {
  if (typeof window === "undefined" || window.innerWidth >= NARROW_VIEWPORT_WIDTH) {
    return MIN_DRAWER_HEIGHT;
  }
  return Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(window.innerHeight * NARROW_MIN_DRAWER_HEIGHT_RATIO),
  );
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), minDrawerHeight()), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function revealTerminalViewport(terminal: Terminal): void {
  terminal.scrollToBottom();
  if (terminal.rows > 0) {
    terminal.refresh(0, terminal.rows - 1);
  }
}

function isScrolledToBottom(terminal: Terminal): boolean {
  return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
}

function writeTerminalOutput(
  terminal: Terminal,
  data: string,
  shouldReveal: () => boolean = () => true,
): void {
  const wasAtBottom = isScrolledToBottom(terminal);
  terminal.write(data, () => {
    if (wasAtBottom && shouldReveal()) {
      revealTerminalViewport(terminal);
    }
  });
}

/**
 * Redraws a terminal from a snapshot. The reset and the history go in one
 * write: output written after this call must land after the history, and a
 * history queued from the reset's callback would land after it instead.
 */
function writeTerminalSnapshot(
  terminal: Terminal,
  snapshot: TerminalSessionSnapshot,
  shouldReveal: () => boolean = () => true,
): void {
  terminal.write(`\u001bc${snapshot.history}`, () => {
    if (shouldReveal()) {
      revealTerminalViewport(terminal);
    }
  });
}

// Built from the escape and bell characters so the pattern itself holds no
// control codes: cursor position and device attribute requests (`ESC[6n`,
// `ESC[c`) and color queries (`ESC]11;?`).
const QUERY_ESC = String.fromCharCode(0x1b);
const QUERY_BEL = String.fromCharCode(0x07);
const TERMINAL_QUERY_PATTERN = new RegExp(
  `${QUERY_ESC}\\[[0-9;?>]*[nc]|${QUERY_ESC}\\](?:10|11|12);\\?(?:${QUERY_BEL}|${QUERY_ESC}\\\\)`,
  "g",
);

/**
 * The queries in terminal output that the terminal answers: the server keeps
 * them out of history, so they reach a terminal only through live output.
 */
export function terminalQueriesIn(data: string): string {
  return (data.match(TERMINAL_QUERY_PATTERN) ?? []).join("");
}

export function selectTerminalEventEntriesAfterSnapshot(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  snapshotUpdatedAt: string,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.event.createdAt > snapshotUpdatedAt);
}

export function selectPendingTerminalEventEntries(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
}

/** Whether an RPC failure is the given terminal error (the server's tagged class). */
function isTerminalError(
  error: unknown,
  tag: "TerminalSessionLookupError" | "TerminalNotRunningError",
): boolean {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;
}

function trimTrailingSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** The last part of a path, for a short label. */
function folderName(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** What a tab's shell is, as the viewport last heard. */
interface TerminalSessionView {
  readonly cwd: string;
  readonly status: TerminalSessionSnapshot["status"];
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
}

function sessionViewOf(snapshot: TerminalSessionSnapshot): TerminalSessionView {
  return {
    cwd: snapshot.cwd,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function resolveTerminalSelectionActionPopoverPosition(options: {
  position: { x: number; y: number };
  viewport?: { width: number; height: number } | null;
  width?: number;
  height?: number;
}): { left: number; top: number } {
  const width = options.width ?? TERMINAL_SELECTION_ACTION_POPOVER_WIDTH_PX;
  const height = options.height ?? TERMINAL_SELECTION_ACTION_POPOVER_HEIGHT_PX;
  const viewportWidth =
    options.viewport?.width ??
    (typeof window === "undefined" ? options.position.x + width : window.innerWidth);
  const viewportHeight =
    options.viewport?.height ??
    (typeof window === "undefined" ? options.position.y + height : window.innerHeight);
  const maxLeft = Math.max(
    TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
    viewportWidth - width - TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
  );
  const maxTop = Math.max(
    TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
    viewportHeight - height - TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
  );

  return {
    left: Math.max(
      TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
      Math.min(Math.round(options.position.x - width), maxLeft),
    ),
    top: Math.max(
      TERMINAL_SELECTION_ACTION_POPOVER_MARGIN_PX,
      Math.min(Math.round(options.position.y), maxTop),
    ),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalSelectionActionState {
  position: { x: number; y: number };
  selection: TerminalContextSelection;
}

function TerminalSelectionActionPopover({
  action,
  onAddToChat,
  onDismiss,
}: {
  action: TerminalSelectionActionState;
  onAddToChat: (selection: TerminalContextSelection) => void;
  onDismiss: (options?: { clearTerminalSelection?: boolean }) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    timeout: 1000,
    onCopy: () => onDismiss({ clearTerminalSelection: true }),
  });
  const position = resolveTerminalSelectionActionPopoverPosition({ position: action.position });

  return (
    <div
      className="fixed z-50 inline-flex items-center gap-1 rounded-lg border border-border/75 bg-popover/96 px-1.5 py-1 text-popover-foreground shadow-lg shadow-black/10 backdrop-blur"
      data-terminal-selection-popover="true"
      style={{
        left: position.left,
        top: position.top,
        width: TERMINAL_SELECTION_ACTION_POPOVER_WIDTH_PX,
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy selected terminal text"
              onClick={() => copyToClipboard(action.selection.text, undefined)}
            />
          }
        >
          {isCopied ? (
            <CheckIcon className="size-3 text-success" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">Copy selected terminal text</TooltipPopup>
      </Tooltip>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onAddToChat(action.selection)}
        className="h-6 flex-1 px-2 text-xs"
      >
        <Plus className="size-3" />
        Add to chat
      </Button>
    </div>
  );
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  /** The thread's folder: where a tab that has no shell yet starts one. */
  cwd: string;
  /** Where this tab's shell last started, when the server keeps tab lists. */
  launchCwd: string | null;
  /** The command a restart stopped in this tab, offered to run again. */
  interruptedCommand: string | null;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  stream: TerminalThreadStreamState;
  /** Older servers: the shell ended, so the tab closes (it would restart empty). */
  onSessionExited: () => void;
  /** The server no longer has this tab (closed on another device). */
  onGone: () => void;
  onRestart: () => void;
  onClose: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  findOpen: boolean;
  onFindOpen: () => void;
  onFindClose: () => void;
  showKeyRow: boolean;
  fontSize: number;
  screenReaderMode: boolean;
  keybindings: ResolvedKeybindingsConfig;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  launchCwd,
  interruptedCommand,
  worktreePath,
  runtimeEnv,
  stream,
  onSessionExited,
  onGone,
  onRestart,
  onClose,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  findOpen,
  onFindOpen,
  onFindClose,
  showKeyRow,
  fontSize,
  screenReaderMode,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalMountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const [selectionAction, setSelectionAction] = useState<TerminalSelectionActionState | null>(null);
  const [session, setSession] = useState<TerminalSessionView | null>(null);
  // Bumped to open the tab again and redraw it from the server's copy.
  const [reopenNonce, setReopenNonce] = useState(0);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  const environmentId = threadRef.environmentId;
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const keybindingsRef = useRef(keybindings);
  // The link under the pointer right now, so a right click knows what it is on.
  const hoveredLinkRef = useRef<Pick<TerminalLinkMatch, "kind" | "text"> | null>(null);
  // Drawing from the server: events are applied only once a snapshot is
  // drawn, and output the snapshot already holds is skipped.
  const hydratedRef = useRef(false);
  const hydratedSnapshotAtRef = useRef<string | null>(null);
  const lastAppliedEntryIdRef = useRef(0);
  const openRequestIdRef = useRef(0);
  const reopeningRef = useRef(false);
  const exitHandledRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const sessionCwdRef = useRef<string | null>(null);

  const handleSessionExited = useEffectEvent(() => onSessionExited());
  const handleGone = useEffectEvent(() => onGone());
  const handleFindOpen = useEffectEvent(() => onFindOpen());
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const readAutoFocus = useEffectEvent(() => autoFocus);
  const readThreadRef = useEffectEvent(() => threadRef);
  const readSurfaceOptions = useEffectEvent(() => ({ fontSize, screenReaderMode }));
  // Read when the tab opens; a change is never a reason to rebuild it.
  const readOpenContext = useEffectEvent(() => ({
    cwd,
    launchCwd,
    worktreePath,
    runtimeEnv,
  }));

  const dismissSelectionAction = useCallback((options?: { clearTerminalSelection?: boolean }) => {
    selectionActionRequestIdRef.current += 1;
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
    setSelectionAction(null);
    selectionActionOpenRef.current = false;
    if (options?.clearTerminalSelection) {
      terminalRef.current?.clearSelection();
      terminalRef.current?.focus();
    }
  }, []);
  const addSelectionActionToChat = useCallback(
    (selection: TerminalContextSelection) => {
      handleAddTerminalContext(selection);
      dismissSelectionAction({ clearTerminalSelection: true });
    },
    [dismissSelectionAction],
  );

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  /**
   * Sends this tab's size. `claim` says the person is using it here: the
   * server then takes this device's size over another's.
   */
  const sendSize = useEffectEvent((claim: boolean) => {
    const terminal = terminalRef.current;
    const api = readEnvironmentApi(environmentId);
    if (!terminal || !api || !hydratedRef.current) return;
    const size = { cols: terminal.cols, rows: terminal.rows };
    const last = lastSentSizeRef.current;
    if (!claim && last !== null && last.cols === size.cols && last.rows === size.rows) return;
    lastSentSizeRef.current = size;
    void api.terminal
      .resize({ threadId, terminalId, ...size, ...(claim ? { claim: true } : {}) })
      .catch(() => undefined);
  });

  const requestReopen = useEffectEvent(() => {
    if (reopeningRef.current) return;
    reopeningRef.current = true;
    hydratedRef.current = false;
    setReopenNonce((value) => value + 1);
  });

  const applyTerminalEvent = useEffectEvent((event: TerminalEvent) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const isActive = () => terminalRef.current === terminal;
    switch (event.type) {
      case "activity":
        return;
      case "output":
        writeTerminalOutput(terminal, event.data, isActive);
        return;
      case "started":
      case "restarted":
        exitHandledRef.current = false;
        dismissSelectionAction();
        writeTerminalSnapshot(terminal, event.snapshot, isActive);
        // Redrawn from this snapshot (a shell started in a tab that is
        // showing): output it holds that arrives after it is not drawn again.
        hydratedSnapshotAtRef.current = event.snapshot.updatedAt;
        sessionCwdRef.current = event.snapshot.cwd;
        setSession(sessionViewOf(event.snapshot));
        // A new shell starts at whatever size it was asked for: tell it this one.
        lastSentSizeRef.current = null;
        sendSize(false);
        return;
      case "cleared":
        dismissSelectionAction();
        terminal.clear();
        terminal.write("\u001bc", () => {
          if (isActive()) revealTerminalViewport(terminal);
        });
        return;
      case "error":
        writeSystemMessage(terminal, event.message);
        setSession((current) => (current ? { ...current, status: "error" } : current));
        return;
      case "exited": {
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          event.exitSignal ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          terminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        setSession((current) =>
          current
            ? {
                ...current,
                status: "exited",
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
              }
            : current,
        );
        // A server with tab lists closes a tab whose shell ended cleanly
        // itself and keeps one that failed; an older one would restart an
        // ended tab empty, so it closes here as it always did.
        if (readTerminalProtocol(environmentId) !== "catalog" && !exitHandledRef.current) {
          exitHandledRef.current = true;
          window.setTimeout(() => handleSessionExited(), 0);
        }
        return;
      }
    }
  });

  const applyPendingEntries = useEffectEvent(() => {
    const terminal = terminalRef.current;
    if (!terminal || !hydratedRef.current) return;
    const buffer = readTerminalBuffer(environmentId, threadId, terminalId);
    // Events dropped for room before this tab drew them: draw it again.
    if (
      buffer.droppedThrough !== null &&
      buffer.droppedThrough.id > lastAppliedEntryIdRef.current
    ) {
      requestReopen();
      return;
    }
    for (const entry of selectPendingTerminalEventEntries(
      buffer.entries,
      lastAppliedEntryIdRef.current,
    )) {
      lastAppliedEntryIdRef.current = entry.id;
      // Output the shell printed before the snapshot was taken can reach
      // this client after the snapshot did; the snapshot already shows it.
      // Only what the terminal must still answer (a cursor or color query,
      // which never goes into history) is passed on.
      const snapshotAt = hydratedSnapshotAtRef.current;
      if (
        snapshotAt !== null &&
        entry.event.type === "output" &&
        entry.event.createdAt <= snapshotAt
      ) {
        const queries = terminalQueriesIn(entry.event.data);
        if (queries.length > 0) terminal.write(queries);
        continue;
      }
      applyTerminalEvent(entry.event);
    }
  });

  /** Opens the tab on the server and draws it from the snapshot. */
  const openTerminal = useEffectEvent(async () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const api = readEnvironmentApi(environmentId);
    if (!terminal || !fitAddon || !api) return;
    const requestId = ++openRequestIdRef.current;
    hydratedRef.current = false;
    const context = readOpenContext();
    // Only a tab this device asked for is made; any other is shown as the
    // server has it, or found gone. Servers from before tab lists ignore it.
    const attach = !shouldMakeTerminal(readThreadRef(), terminalId);
    fitIfShown(fitAddon, containerRef.current);
    try {
      const snapshot = await api.terminal.open({
        threadId,
        terminalId,
        // A tab stays where its shell started; only a new one follows the thread.
        cwd: context.launchCwd ?? sessionCwdRef.current ?? context.cwd,
        ...(context.worktreePath !== undefined ? { worktreePath: context.worktreePath } : {}),
        cols: terminal.cols,
        rows: terminal.rows,
        ...(context.runtimeEnv ? { env: context.runtimeEnv } : {}),
        ...(attach ? { attach: true } : {}),
      });
      if (requestId !== openRequestIdRef.current || terminalRef.current !== terminal) return;
      reopeningRef.current = false;
      const isActive = () => terminalRef.current === terminal;
      writeTerminalSnapshot(terminal, snapshot, isActive);
      hydratedSnapshotAtRef.current = snapshot.updatedAt;
      sessionCwdRef.current = snapshot.cwd;
      exitHandledRef.current = snapshot.status === "exited";
      setSession(sessionViewOf(snapshot));
      const buffer = readTerminalBuffer(environmentId, threadId, terminalId);
      if (buffer.droppedThrough !== null && buffer.droppedThrough.createdAt > snapshot.updatedAt) {
        requestReopen();
        return;
      }
      // What came before the snapshot is in it (old queries were answered
      // then); what came after is drawn on top.
      lastAppliedEntryIdRef.current = 0;
      for (const entry of buffer.entries) {
        if (entry.event.createdAt > snapshot.updatedAt) break;
        lastAppliedEntryIdRef.current = entry.id;
      }
      hydratedRef.current = true;
      applyPendingEntries();
      sendSize(readAutoFocus() && document.hasFocus());
      if (readAutoFocus()) {
        window.requestAnimationFrame(() => {
          if (terminalRef.current === terminal) terminal.focus();
        });
      }
    } catch (error) {
      if (requestId !== openRequestIdRef.current || terminalRef.current !== terminal) return;
      reopeningRef.current = false;
      if (attach && isTerminalError(error, "TerminalSessionLookupError")) {
        handleGone();
        return;
      }
      writeSystemMessage(
        terminal,
        error instanceof Error ? error.message : "Failed to open terminal",
      );
    }
  });

  /** A write the server refused because the tab's shell is gone: open it again. */
  const handleWriteFailure = useEffectEvent((error: unknown, fallback: string) => {
    if (
      isTerminalError(error, "TerminalSessionLookupError") ||
      isTerminalError(error, "TerminalNotRunningError")
    ) {
      requestReopen();
      return;
    }
    const terminal = terminalRef.current;
    if (terminal) writeSystemMessage(terminal, error instanceof Error ? error.message : fallback);
  });

  const writeInput = useEffectEvent((data: string, fallbackError: string) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void api.terminal
      .write({ threadId, terminalId, data })
      .catch((error: unknown) => handleWriteFailure(error, fallbackError));
  });

  useEffect(() => {
    const mount = terminalMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    let disposed = false;
    const localApi = readLocalApi();
    if (!readEnvironmentApi(environmentId) || !localApi) return;

    const { terminal, fitAddon } = createXtermSurface({
      mount,
      themeSource: container,
      ...readSurfaceOptions(),
      allowProposedApi: true,
    });
    const search = new SearchAddon();
    terminal.loadAddon(search);
    setSearchAddon(search);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const isTerminalActive = (activeTerminal: Terminal) =>
      !disposed && terminalRef.current === activeTerminal;

    const clearSelectionAction = () => dismissSelectionAction();

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      const terminalMountElement = terminalMountRef.current;
      if (
        !activeTerminal ||
        !mountElement ||
        !terminalMountElement ||
        !activeTerminal.hasSelection()
      ) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      // Numbered within the selection ("lines 1-18"): where it sat in the
      // scrollback means nothing to the reader or the agent.
      const lineStart = 1;
      const lineEnd = normalizedText.split("\n").length;
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(terminalMountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      if (requestId !== selectionActionRequestIdRef.current) {
        return;
      }
      setSelectionAction(nextAction);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (isTerminalFindShortcut(event, currentKeybindings, options)) {
        if (event.type === "keydown") {
          event.preventDefault();
          handleFindOpen();
        }
        return false;
      }
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        writeInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        writeInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      writeInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const openLinkExternally = (url: string) =>
      localApi.shell.openExternal(url).catch((error: unknown) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        writeSystemMessage(
          activeTerminal,
          error instanceof Error ? error.message : "Unable to open link",
        );
      });

    // Same choice as a chat link (Settings › General › Open links in). Threads
    // without a panel (general chat, plain web) always go to the external
    // browser; the right-click menu offers the other place.
    const openWebLink = (url: string) => {
      if (
        isElectron &&
        readLinkOpenTarget() === "browser-panel" &&
        openUrlInBrowserPanel(readThreadRef(), url)
      ) {
        return;
      }
      void openLinkExternally(url);
    };

    // Relative paths are read from the folder the tab's shell started in.
    const linkBaseFolder = () => sessionCwdRef.current ?? readOpenContext().cwd;

    // Links a program marks up itself (OSC 8, as `ls --hyperlink` prints) open
    // like the addresses found in the text. xterm's own handler would confirm
    // and then open a blank window, which the desktop refuses. xterm passes
    // only http and https links here.
    terminal.options.linkHandler = {
      activate: (event, text) => {
        if (isTerminalLinkActivation(event)) {
          openWebLink(text);
        }
      },
      hover: (_event, text) => {
        hoveredLinkRef.current = { kind: "url", text };
      },
      leave: (_event, text) => {
        if (hoveredLinkRef.current?.kind === "url" && hoveredLinkRef.current.text === text) {
          hoveredLinkRef.current = null;
        }
      },
    };

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            hover: () => {
              hoveredLinkRef.current = match;
            },
            leave: () => {
              if (hoveredLinkRef.current === match) {
                hoveredLinkRef.current = null;
              }
            },
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                openWebLink(match.text);
                return;
              }

              const base = linkBaseFolder();
              const target = resolvePathLinkTarget(match.text, base);
              void openInPreferredEditor(localApi, target, base).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      // The phone key row's sticky Ctrl turns the next key typed into its
      // control code.
      let input = data;
      if (ctrlArmedRef.current) {
        ctrlArmedRef.current = false;
        setCtrlArmed(false);
        input = controlCodeFor(data);
      }
      // A line entered may start something: stopping the tab asks first
      // until the server says what it did.
      if (input.includes("\r")) noteTerminalLineEntered(readThreadRef(), terminalId);
      writeInput(input, "Terminal write failed");
    });

    // Someone is using the tab on this device: its size wins.
    const onTerminalFocus = () => sendSize(true);
    terminal.textarea?.addEventListener("focus", onTerminalFocus);

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    const handleLinkContextMenu = (event: MouseEvent) => {
      const link = hoveredLinkRef.current;
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const position = { x: event.clientX, y: event.clientY };
      void (async () => {
        if (link.kind === "url") {
          // As in chat: the panel is offered only when the click goes elsewhere.
          const offersBrowserPanel =
            readLinkOpenTarget() !== "browser-panel" && canOpenInBrowserPanel(readThreadRef());
          const clicked = await localApi.contextMenu.show(
            [
              ...(offersBrowserPanel
                ? [{ id: "open-browser-panel", label: "Open in browser panel" } as const]
                : []),
              { id: "open-external", label: "Open in external browser" },
              { id: "copy-link", label: "Copy link address" },
            ] as const,
            position,
          );
          if (clicked === "open-browser-panel") {
            openUrlInBrowserPanel(readThreadRef(), link.text);
            return;
          }
          if (clicked === "open-external") {
            await openLinkExternally(link.text);
            return;
          }
          if (clicked === "copy-link") {
            copyTextWithToast(link.text, "Link address");
          }
          return;
        }

        const base = linkBaseFolder();
        const target = resolvePathLinkTarget(link.text, base);
        const clicked = await localApi.contextMenu.show(
          [
            { id: "open-editor", label: "Open in editor" },
            { id: "copy-path", label: "Copy path" },
          ] as const,
          position,
        );
        if (clicked === "open-editor") {
          await openInPreferredEditor(localApi, target, base).catch((error) => {
            const activeTerminal = terminalRef.current;
            if (!activeTerminal) return;
            writeSystemMessage(
              activeTerminal,
              error instanceof Error ? error.message : "Unable to open path",
            );
          });
          return;
        }
        if (clicked === "copy-path") {
          copyTextWithToast(target, "Path");
        }
      })();
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    mount.addEventListener("contextmenu", handleLinkContextMenu);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // The terminal follows its box, whatever changed it: the drawer's
    // height, the window, the app sidebar, a notice above it, a split.
    let fitFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon || !isTerminalActive(activeTerminal)) return;
        const wasAtBottom = isScrolledToBottom(activeTerminal);
        if (!fitIfShown(activeFitAddon, mount)) return;
        if (wasAtBottom) activeTerminal.scrollToBottom();
        sendSize(false);
      });
    });
    resizeObserver.observe(mount);

    const unsubscribeBuffer = subscribeTerminalBuffer(environmentId, threadId, terminalId, () =>
      applyPendingEntries(),
    );

    return () => {
      disposed = true;
      hydratedRef.current = false;
      lastAppliedEntryIdRef.current = 0;
      openRequestIdRef.current += 1;
      reopeningRef.current = false;
      unsubscribeBuffer();
      resizeObserver.disconnect();
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      terminal.textarea?.removeEventListener("focus", onTerminalFocus);
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("contextmenu", handleLinkContextMenu);
      hoveredLinkRef.current = null;
      themeObserver.disconnect();
      setSelectionAction(null);
      setSearchAddon(null);
      selectionActionOpenRef.current = false;
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [dismissSelectionAction, environmentId, terminalId, threadId]);

  // Opens the tab once its thread's stream can't miss its output, and again
  // whenever it must be drawn from the server: a reconnect, a restarted
  // server, a stream that fell behind, a write the server refused.
  useEffect(() => {
    if (stream.ready) {
      void openTerminal();
      return;
    }
    if (!stream.unsure) return;
    const timer = window.setTimeout(() => void openTerminal(), STREAM_READY_FALLBACK_MS);
    return () => window.clearTimeout(timer);
    // `openTerminal` reads the latest props itself; these say when to open.
  }, [environmentId, reopenNonce, stream.epoch, stream.ready, stream.unsure, terminalId, threadId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
      if (fitAddonRef.current && fitIfShown(fitAddonRef.current, terminalMountRef.current)) {
        sendSize(false);
      }
    }
    if (terminal.options.screenReaderMode !== screenReaderMode) {
      terminal.options.screenReaderMode = screenReaderMode;
    }
  }, [fontSize, screenReaderMode]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  const sendKey = useCallback(
    (data: string) => {
      const api = readEnvironmentApi(environmentId);
      if (api) {
        void api.terminal.write({ threadId, terminalId, data }).catch(() => undefined);
      }
      terminalRef.current?.focus();
    },
    [environmentId, terminalId, threadId],
  );
  const toggleCtrl = useCallback(() => {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
    terminalRef.current?.focus();
  }, []);

  // Hidden here at once; the server forgets it for every device (entering
  // the line does that too) and the tab list catches up. Once it has, the
  // next command a restart stops is news again, even the same one.
  const [settledInterrupted, setSettledInterrupted] = useState<string | null>(null);
  if (interruptedCommand === null && settledInterrupted !== null) {
    setSettledInterrupted(null);
  }
  // The server types it only onto an empty line with nothing running, and
  // says why not otherwise. A request that fails brings the offer back.
  const resolveInterrupted = useCallback(
    (command: string, run: boolean) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      setSettledInterrupted(command);
      if (run) noteTerminalLineEntered(threadRef, terminalId);
      void api.terminal
        .resolveInterrupted({ threadId, terminalId, run })
        .catch((error: unknown) => {
          setSettledInterrupted(null);
          const terminal = terminalRef.current;
          if (run && terminal) {
            writeSystemMessage(
              terminal,
              error instanceof Error ? error.message : "Couldn't run it again",
            );
          }
        });
      if (run) terminalRef.current?.focus();
    },
    [environmentId, terminalId, threadId, threadRef],
  );

  const ended = session !== null && (session.status === "exited" || session.status === "error");
  const movedFrom =
    session !== null &&
    !ended &&
    trimTrailingSeparators(session.cwd) !== trimTrailingSeparators(cwd)
      ? session.cwd
      : null;
  const stoppedCommand =
    session?.status === "running" &&
    interruptedCommand !== null &&
    interruptedCommand !== settledInterrupted
      ? interruptedCommand
      : null;

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
      data-terminal-viewport={terminalId}
    >
      {ended && session ? (
        <TerminalNotice
          message={describeShellEnd(session)}
          actions={
            <>
              <Button size="xs" variant="outline" onClick={onRestart}>
                Restart
              </Button>
              <Button size="xs" variant="ghost" onClick={onClose}>
                Close tab
              </Button>
            </>
          }
        />
      ) : (
        <>
          {stoppedCommand !== null ? (
            <TerminalNotice
              message={
                <>
                  <code className="font-mono whitespace-pre text-foreground">{stoppedCommand}</code>{" "}
                  stopped when Threadlines restarted.
                </>
              }
              title={stoppedCommand}
              actions={
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => resolveInterrupted(stoppedCommand, true)}
                  >
                    Run again
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Dismiss"
                    onClick={() => resolveInterrupted(stoppedCommand, false)}
                  >
                    <XIcon />
                  </Button>
                </>
              }
            />
          ) : null}
          {movedFrom !== null ? (
            <TerminalNotice
              message={`Started in ${folderName(movedFrom)}. The thread is now in ${folderName(cwd)}.`}
              title={`Started in ${movedFrom}`}
              actions={
                <Button size="xs" variant="outline" onClick={onRestart}>
                  Restart here
                </Button>
              }
            />
          ) : null}
        </>
      )}
      <div className="relative min-h-0 flex-1 px-1 pt-1">
        <div ref={terminalMountRef} className="h-full w-full" data-terminal-viewport-mount="true" />
        {findOpen && searchAddon ? (
          <TerminalFindBar searchAddon={searchAddon} onClose={onFindClose} />
        ) : null}
      </div>
      {showKeyRow ? (
        <TerminalKeyRow ctrlArmed={ctrlArmed} onKey={sendKey} onToggleCtrl={toggleCtrl} />
      ) : null}
      {selectionAction ? (
        <TerminalSelectionActionPopover
          action={selectionAction}
          onAddToChat={addSelectionActionToChat}
          onDismiss={dismissSelectionAction}
        />
      ) : null}
    </div>
  );
}

function describeShellEnd(session: TerminalSessionView): string {
  if (session.status === "error") return "The shell couldn't start.";
  if (session.exitSignal) return `The shell was stopped by signal ${session.exitSignal}.`;
  if (session.exitCode !== null) return `The shell exited with code ${session.exitCode}.`;
  return "The shell exited.";
}

/** Fits the terminal to its box unless the box is hidden; whether it did. */
function fitIfShown(fitAddon: FitAddon, box: HTMLElement | null): boolean {
  if (!box || box.clientWidth === 0 || box.clientHeight === 0) return false;
  fitAddon.fit();
  return true;
}

/** A line above a tab's output about the tab itself, with what to do about it. */
function TerminalNotice({
  message,
  title,
  actions,
}: {
  message: ReactNode;
  title?: string;
  actions: ReactNode;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs text-muted-foreground"
      data-terminal-notice="true"
    >
      <span className="min-w-0 flex-1 truncate" title={title}>
        {message}
      </span>
      {actions}
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  /** The server's tabs of this thread (empty when it keeps no list). */
  tabs: ReadonlyArray<TerminalTab>;
  runningTerminalIds: ReadonlyArray<string>;
  /** What runs in each tab, when that is known. */
  commandByTerminalId: ReadonlyMap<string, string>;
  stream: TerminalThreadStreamState;
  focusRequestId: number;
  /** Find was asked for (a shortcut, the palette): open it in the active tab. */
  findRequested: boolean;
  onFindRequestHandled: () => void;
  fontSize: number;
  screenReaderMode: boolean;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  onHideTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  hideShortcutLabel?: string | undefined;
  findShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, options?: { sessionExited?: boolean }) => void;
  /** Forget a tab the server no longer has. */
  onForgetTerminal: (terminalId: string) => void;
  onRestartTerminal: (terminalId: string) => void;
  onClearTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
}

function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** A plain icon button in the drawer's header, named by its tooltip. */
function HeaderIconButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipWrapper delay={0} side="bottom" tooltip={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-8"
        onClick={onClick}
      >
        {children}
      </button>
    </TooltipWrapper>
  );
}

export default function ThreadTerminalDrawer({
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  tabs,
  runningTerminalIds,
  commandByTerminalId,
  stream,
  focusRequestId,
  findRequested,
  onFindRequestHandled,
  fontSize,
  screenReaderMode,
  onSplitTerminal,
  onNewTerminal,
  onHideTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  hideShortcutLabel,
  findShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onForgetTerminal,
  onRestartTerminal,
  onClearTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const [findTerminalId, setFindTerminalId] = useState<string | null>(null);
  const coarsePointer = useMediaQuery({ pointer: "coarse" });

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const isSplitView = visibleTerminalIds.length > 1;
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;

  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.terminalId, tab])), [tabs]);
  const stripGroups = useMemo(() => {
    const labelById = terminalTabLabels(normalizedTerminalIds, tabs);
    const running = new Set(runningTerminalIds);
    return resolvedTerminalGroups.map((group) =>
      group.terminalIds.map((terminalId): TerminalStripTab => {
        const tab = tabById.get(terminalId);
        const ended = tab !== undefined && (tab.status === "exited" || tab.status === "error");
        return {
          terminalId,
          label: labelById.get(terminalId) ?? "Terminal",
          running: running.has(terminalId),
          command: running.has(terminalId) ? (commandByTerminalId.get(terminalId) ?? null) : null,
          exit: ended ? { code: tab.exitCode, signal: tab.exitSignal } : null,
          cwd: tab?.cwd ?? null,
        };
      }),
    );
  }, [
    commandByTerminalId,
    normalizedTerminalIds,
    resolvedTerminalGroups,
    runningTerminalIds,
    tabById,
    tabs,
  ]);
  const labelById = useMemo(
    () => new Map(stripGroups.flat().map((tab) => [tab.terminalId, tab.label] as const)),
    [stripGroups],
  );

  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split terminal (max ${MAX_TERMINALS_PER_GROUP} side by side)`
    : withShortcut("Split terminal", splitShortcutLabel);
  const newTerminalActionLabel = withShortcut("New terminal tab", newShortcutLabel);
  const killTerminalActionLabel = withShortcut("Kill terminal", closeShortcutLabel);
  const hideTerminalActionLabel = withShortcut("Hide terminal", hideShortcutLabel);
  const findTerminalActionLabel = withShortcut("Find in terminal", findShortcutLabel);

  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);

  // Find opens in the active tab, from the button, a shortcut or the palette.
  const handleFindRequest = useEffectEvent(() => {
    setFindTerminalId(resolvedActiveTerminalId);
    onFindRequestHandled();
  });
  useEffect(() => {
    if (findRequested && visible) handleFindRequest();
  }, [findRequested, visible]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
    },
    [syncHeight],
  );

  // The edge is also a keyboard control: arrows move it, Home and End jump.
  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === "ArrowUp"
          ? DRAWER_KEYBOARD_RESIZE_STEP_PX
          : event.key === "ArrowDown"
            ? -DRAWER_KEYBOARD_RESIZE_STEP_PX
            : null;
      let next: number | null = null;
      if (step !== null) next = drawerHeightRef.current + step;
      if (event.key === "Home") next = minDrawerHeight();
      if (event.key === "End") next = maxDrawerHeight();
      if (next === null) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(next);
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
      syncHeight(clampedHeight);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  const renderViewport = (terminalId: string, autoFocus: boolean) => {
    const tab = tabById.get(terminalId);
    return (
      <TerminalViewport
        threadRef={threadRef}
        threadId={threadId}
        terminalId={terminalId}
        terminalLabel={labelById.get(terminalId) ?? "Terminal"}
        cwd={cwd}
        launchCwd={tab?.cwd ?? null}
        interruptedCommand={tab?.interruptedCommand ?? null}
        {...(worktreePath !== undefined ? { worktreePath } : {})}
        {...(runtimeEnv ? { runtimeEnv } : {})}
        stream={stream}
        onSessionExited={() => onCloseTerminal(terminalId, { sessionExited: true })}
        onGone={() => onForgetTerminal(terminalId)}
        onRestart={() => onRestartTerminal(terminalId)}
        onClose={() => onCloseTerminal(terminalId)}
        onAddTerminalContext={onAddTerminalContext}
        focusRequestId={focusRequestId}
        autoFocus={autoFocus}
        findOpen={findTerminalId === terminalId}
        onFindOpen={() => setFindTerminalId(terminalId)}
        onFindClose={() => setFindTerminalId(null)}
        showKeyRow={coarsePointer && terminalId === resolvedActiveTerminalId}
        fontSize={fontSize}
        screenReaderMode={screenReaderMode}
        keybindings={keybindings}
      />
    );
  };

  return (
    <aside
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border bg-background"
      style={{ height: `${drawerHeight}px`, minHeight: `${MIN_DRAWER_HEIGHT}px` }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Terminal height"
        aria-valuemin={minDrawerHeight()}
        aria-valuemax={maxDrawerHeight()}
        aria-valuenow={drawerHeight}
        tabIndex={0}
        className="group/terminal-edge absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize outline-none"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onKeyDown={handleResizeKeyDown}
      >
        <div className="h-px w-full bg-transparent transition-colors group-hover/terminal-edge:bg-ring group-focus-visible/terminal-edge:bg-ring" />
      </div>

      <div className="flex h-8 shrink-0 items-stretch gap-1 bg-rail pt-1 pr-1.5 pl-1.5">
        <TerminalTabStrip
          groups={stripGroups}
          activeTerminalId={resolvedActiveTerminalId}
          onSelect={onActiveTerminalChange}
          onClose={(terminalId) => onCloseTerminal(terminalId)}
          onNew={onNewTerminal}
          newLabel={newTerminalActionLabel}
        />
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          <HeaderIconButton
            label={findTerminalActionLabel}
            onClick={() => setFindTerminalId(resolvedActiveTerminalId)}
          >
            <Search className="size-3.5" aria-hidden="true" />
          </HeaderIconButton>
          <HeaderIconButton
            label={splitTerminalActionLabel}
            disabled={hasReachedSplitLimit}
            onClick={onSplitTerminalAction}
          >
            <SquareSplitHorizontal className="size-3.5" aria-hidden="true" />
          </HeaderIconButton>
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More terminal actions"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring data-popup-open:bg-accent data-popup-open:text-foreground pointer-coarse:size-8"
                />
              }
            >
              <Ellipsis className="size-3.5" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              <MenuItem onClick={() => onRestartTerminal(resolvedActiveTerminalId)}>
                Restart terminal
              </MenuItem>
              <MenuItem onClick={() => onClearTerminal(resolvedActiveTerminalId)}>
                Clear output
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              >
                {killTerminalActionLabel}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
          <HeaderIconButton label={hideTerminalActionLabel} onClick={onHideTerminal}>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </HeaderIconButton>
        </div>
      </div>

      <div className="min-h-0 w-full flex-1">
        {isSplitView ? (
          <div
            className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
            style={{
              gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
            }}
          >
            {visibleTerminalIds.map((terminalId) => (
              <div
                key={terminalId}
                className="min-h-0 min-w-0 border-l border-border first:border-l-0"
                onMouseDown={() => {
                  if (terminalId !== resolvedActiveTerminalId) {
                    onActiveTerminalChange(terminalId);
                  }
                }}
              >
                {renderViewport(terminalId, terminalId === resolvedActiveTerminalId)}
              </div>
            ))}
          </div>
        ) : (
          <div key={resolvedActiveTerminalId} className="h-full">
            {renderViewport(resolvedActiveTerminalId, true)}
          </div>
        )}
      </div>
    </aside>
  );
}

/** "Terminal N" for each tab: the server's number, or the lowest free one. */
function terminalTabLabels(
  terminalIds: ReadonlyArray<string>,
  tabs: ReadonlyArray<TerminalTab>,
): Map<string, string> {
  const numbers = terminalTabNumbers(terminalIds, tabs);
  return new Map(
    terminalIds.map((terminalId) => [terminalId, `Terminal ${numbers.get(terminalId) ?? 1}`]),
  );
}
