/**
 * A terminal drawer wired to the terminal store and its server stream: the
 * part a thread's drawer and the Terminals page share (docs/terminal.md). The
 * caller says where a new tab starts and what close and restart do (they ask
 * first while something runs); this keeps the layout, opens the thread's
 * output stream while it is mounted, and lazy-loads the xterm machinery.
 */
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@threadlines/contracts";
import { lazy, memo, Suspense, useCallback, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useSettings } from "../../hooks/useSettings";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { cn, randomUUID } from "../../lib/utils";
import {
  selectTerminalTabs,
  selectThreadTerminalState,
  terminalKey,
  useTerminalStateStore,
} from "../../terminalStateStore";
import { dropTerminalBuffer, useTerminalThreadStream } from "../../terminalStreams";
import type { TerminalLaunch } from "../ThreadTerminalDrawer";

// Lazy so @xterm/xterm (and the drawer's terminal machinery) stays out of
// the entry chunk; it only loads once a terminal is shown.
const ThreadTerminalDrawer = lazy(() => import("../ThreadTerminalDrawer"));

const EMPTY_TERMINAL_COMMANDS: ReadonlyMap<string, string> = new Map();

export interface ManagedTerminalDrawerProps {
  readonly threadRef: ScopedThreadRef;
  readonly layout: "drawer" | "page";
  /** Where a new tab starts unless `launchFor` says otherwise. */
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
  readonly launchFor?: ((terminalId: string) => TerminalLaunch | null) | undefined;
  readonly folderLabelFor?: ((terminalId: string, cwd: string | null) => string | null) | undefined;
  /** Hidden drawers stay mounted (their terminals keep their screens). */
  readonly visible: boolean;
  readonly focusRequestId: number;
  readonly findRequested: boolean;
  readonly onFindRequestHandled: () => void;
  readonly splitShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly hideShortcutLabel: string | undefined;
  readonly findShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Null where there is no chat to add a selection to. */
  readonly onAddTerminalContext: ((selection: TerminalContextSelection) => void) | null;
  /** Kill a tab (or forget one whose shell exited on an older server). */
  readonly onCloseTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { sessionExited?: boolean },
  ) => void;
  readonly onRestartTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  /** New tab and split ask for an id first; the default makes one up. */
  readonly onNewTerminal?: ((terminalId: string) => void) | undefined;
  readonly onSplitTerminal?: ((terminalId: string) => void) | undefined;
  readonly onHideTerminal?: (() => void) | undefined;
}

export const ManagedTerminalDrawer = memo(function ManagedTerminalDrawer({
  threadRef,
  layout,
  cwd,
  worktreePath,
  runtimeEnv,
  launchFor,
  folderLabelFor,
  visible,
  focusRequestId,
  findRequested,
  onFindRequestHandled,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  hideShortcutLabel,
  findShortcutLabel,
  keybindings,
  onAddTerminalContext,
  onCloseTerminal,
  onRestartTerminal,
  onNewTerminal,
  onSplitTerminal,
  onHideTerminal,
}: ManagedTerminalDrawerProps) {
  const threadId = threadRef.threadId;
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const terminalTabs = useTerminalStateStore((state) =>
    selectTerminalTabs(state.terminalTabsByThreadKey, threadRef),
  );
  const terminalActivityCommandByKey = useTerminalStateStore(
    (state) => state.terminalActivityCommandByKey,
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const terminalFontSize = useSettings((settings) => settings.terminalFontSize);
  const terminalScreenReaderMode = useSettings((settings) => settings.terminalScreenReaderMode);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const shown = terminalState.terminalOpen;
  // This thread's output comes only while its drawer is mounted.
  const stream = useTerminalThreadStream(threadRef.environmentId, threadId, shown);
  const commandByTerminalId = useMemo(() => {
    if (Object.keys(terminalActivityCommandByKey).length === 0) return EMPTY_TERMINAL_COMMANDS;
    const commands = new Map<string, string>();
    for (const terminalId of terminalState.terminalIds) {
      const command = terminalActivityCommandByKey[terminalKey(threadRef, terminalId)];
      if (command) commands.set(terminalId, command);
    }
    return commands;
  }, [terminalActivityCommandByKey, terminalState.terminalIds, threadRef]);

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) return;
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => storeSetTerminalHeight(threadRef, height),
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    const terminalId = `terminal-${randomUUID()}`;
    if (onSplitTerminal) onSplitTerminal(terminalId);
    else storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, onSplitTerminal, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    const terminalId = `terminal-${randomUUID()}`;
    if (onNewTerminal) onNewTerminal(terminalId);
    else storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, onNewTerminal, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string, options?: { sessionExited?: boolean }) => {
      onCloseTerminal(threadRef, terminalId, options);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, onCloseTerminal, threadRef],
  );

  const forgetTerminal = useCallback(
    (terminalId: string) => {
      storeCloseTerminal(threadRef, terminalId);
      dropTerminalBuffer(threadRef.environmentId, threadId, terminalId);
    },
    [storeCloseTerminal, threadId, threadRef],
  );

  const restartTerminal = useCallback(
    (terminalId: string) => onRestartTerminal(threadRef, terminalId),
    [onRestartTerminal, threadRef],
  );

  const clearTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      void api?.terminal.clear({ threadId, terminalId }).catch(() => undefined);
    },
    [threadId, threadRef],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) return;
      onAddTerminalContext?.(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!shown) return null;

  return (
    <div
      className={cn(
        !visible && "hidden",
        visible && layout === "page" && "flex min-h-0 flex-1 flex-col",
      )}
    >
      <Suspense fallback={null}>
        <ThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          layout={layout}
          cwd={cwd}
          worktreePath={worktreePath}
          runtimeEnv={runtimeEnv}
          launchFor={launchFor}
          folderLabelFor={folderLabelFor}
          visible={visible}
          height={terminalState.terminalHeight}
          terminalIds={terminalState.terminalIds}
          activeTerminalId={terminalState.activeTerminalId}
          terminalGroups={terminalState.terminalGroups}
          activeTerminalGroupId={terminalState.activeTerminalGroupId}
          tabs={terminalTabs}
          runningTerminalIds={terminalState.runningTerminalIds}
          commandByTerminalId={commandByTerminalId}
          stream={stream}
          focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
          findRequested={findRequested}
          onFindRequestHandled={onFindRequestHandled}
          fontSize={terminalFontSize}
          screenReaderMode={terminalScreenReaderMode}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
          onHideTerminal={onHideTerminal}
          splitShortcutLabel={visible ? splitShortcutLabel : undefined}
          newShortcutLabel={visible ? newShortcutLabel : undefined}
          closeShortcutLabel={visible ? closeShortcutLabel : undefined}
          hideShortcutLabel={visible ? hideShortcutLabel : undefined}
          findShortcutLabel={visible ? findShortcutLabel : undefined}
          keybindings={keybindings}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onForgetTerminal={forgetTerminal}
          onRestartTerminal={restartTerminal}
          onClearTerminal={clearTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={onAddTerminalContext === null ? null : handleAddTerminalContext}
        />
      </Suspense>
    </div>
  );
});
