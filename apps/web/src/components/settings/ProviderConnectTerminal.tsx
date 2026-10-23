/**
 * The sign-in panel's terminal (ProviderConnectFlow.tsx). Its own chunk, so
 * xterm loads only when a sign-in shows its details, never at startup.
 */
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { createXtermSurface } from "../terminal/xtermSurface";
import { PROVIDER_CONNECT_TERMINAL_CLASS } from "./providerConnectFlow.logic";

interface ProviderConnectTerminalProps {
  readonly bufferRef: { current: string };
  readonly writeRef: { current: ((data: string) => void) | null };
  /** Typing, sent to the run on the computer that runs it. */
  readonly onInput: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
}

/**
 * The real interactive terminal behind "Show details". Mounted only while
 * expanded; it replays the buffered output the panel has seen so far, then
 * receives live chunks through `writeRef`.
 */
export function ProviderConnectTerminal({
  bufferRef,
  writeRef,
  onInput,
  onResize,
}: ProviderConnectTerminalProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Read through refs: a new callback (the computer reconnected) must not
  // rebuild the terminal and lose what it shows.
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
  }, [onInput, onResize]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const { terminal, fitAddon } = createXtermSurface({ mount, fontSize: 11, scrollback: 2_000 });
    let disposed = false;

    if (bufferRef.current.length > 0) {
      terminal.write(bufferRef.current);
    }
    writeRef.current = (data: string) => {
      if (!disposed) terminal.write(data);
    };

    const dataSubscription = terminal.onData((data) => onInputRef.current(data));

    const pushSize = (activeTerminal: Terminal) => {
      onResizeRef.current(activeTerminal.cols, activeTerminal.rows);
    };

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      pushSize(terminal);
    });
    resizeObserver.observe(mount);
    pushSize(terminal);
    terminal.focus();

    return () => {
      disposed = true;
      writeRef.current = null;
      resizeObserver.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
    };
  }, [bufferRef, writeRef]);

  return (
    <div ref={mountRef} className={PROVIDER_CONNECT_TERMINAL_CLASS} data-agent-row-toggle-ignore />
  );
}
