"use client";

import type {
  ProviderAuthEvent,
  ProviderAuthFlow,
  ProviderInstanceId,
} from "@threadlines/contracts";
import type { Terminal } from "@xterm/xterm";
import { CheckIcon, ChevronDownIcon, CopyIcon, LoaderIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { createXtermSurface } from "../terminal/xtermSurface";
import {
  applyProviderAuthEvent,
  initialProviderConnectFlowState,
  isProviderConnectFlowActive,
  providerConnectStatusLine,
  shouldAutoExpandTerminal,
  type ProviderConnectFlowState,
} from "./providerConnectFlow.logic";

const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 20;
const AUTO_EXPAND_TICK_MS = 1_000;

interface ProviderConnectTerminalProps {
  readonly instanceId: ProviderInstanceId;
  readonly bufferRef: { current: string };
  readonly writeRef: { current: ((data: string) => void) | null };
}

/**
 * The real interactive terminal behind "Show details". Mounted only while
 * expanded; it replays the buffered output the panel has seen so far, then
 * receives live chunks through `writeRef`.
 */
function ProviderConnectTerminal({
  instanceId,
  bufferRef,
  writeRef,
}: ProviderConnectTerminalProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const client = getPrimaryEnvironmentConnection().client;
    const { terminal, fitAddon } = createXtermSurface({ mount, fontSize: 11, scrollback: 2_000 });
    let disposed = false;

    if (bufferRef.current.length > 0) {
      terminal.write(bufferRef.current);
    }
    writeRef.current = (data: string) => {
      if (!disposed) terminal.write(data);
    };

    const dataSubscription = terminal.onData((data) => {
      void client.providerAuth.write({ instanceId, data }).catch(() => {
        // The panel's status line already reports a dead session.
      });
    });

    const pushSize = (activeTerminal: Terminal) => {
      void client.providerAuth
        .resize({ instanceId, cols: activeTerminal.cols, rows: activeTerminal.rows })
        .catch(() => {});
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
  }, [bufferRef, instanceId, writeRef]);

  return (
    <div
      ref={mountRef}
      className="h-56 w-full overflow-hidden rounded-sm bg-background"
      data-provider-card-toggle-ignore
    />
  );
}

export interface ProviderConnectFlowProps {
  readonly instanceId: ProviderInstanceId;
  readonly flow: ProviderAuthFlow;
  readonly displayName: string;
  /** Label for the idle button, e.g. "Sign in" / "Reconnect" / "Generate token". */
  readonly actionLabel: string;
  /** Command shown under the copy fallback before the server reports one. */
  readonly command: string;
  readonly description?: string | undefined;
  /**
   * Status content (badges) rendered inline before the action, so the row
   * reads as one statement: state first, then what you can do about it.
   * Without it the button leads the row.
   */
  readonly statusRow?: React.ReactNode;
  /**
   * `default` when the action is needed now, `outline` for a secondary
   * standalone button, `ghost` for a rare maintenance action sitting next to
   * a healthy status ("Sign in again").
   */
  readonly buttonVariant?: "default" | "outline" | "ghost";
}

/**
 * Settings-owned provider sign-in.
 *
 * The whole flow stays on this page: the server runs the provider's auth
 * command in an ephemeral PTY, the panel shows the last output line, and a
 * "Show details" toggle reveals the real terminal for flows that need a
 * pasted code or a menu choice.
 */
export function ProviderConnectFlow({
  instanceId,
  flow,
  displayName,
  actionLabel,
  command,
  description,
  statusRow,
  buttonVariant = "default",
}: ProviderConnectFlowProps) {
  const [state, setState] = useState<ProviderConnectFlowState>(initialProviderConnectFlowState);
  const [isStarting, setIsStarting] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [runningForMs, setRunningForMs] = useState(0);
  const outputBufferRef = useRef("");
  const terminalWriteRef = useRef<((data: string) => void) | null>(null);
  // An instance has one auth session but can render two panels (sign-in and
  // token setup). Sessions announce their flow in the "command" event; a
  // panel ignores sessions that belong to the other flow.
  const sessionFlowRef = useRef<ProviderAuthFlow | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<"provider-auth-command">({
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy the command",
          description: error.message,
        }),
      );
    },
  });

  const handleEvent = useEffectEvent((event: ProviderAuthEvent) => {
    if (event.type === "command") {
      sessionFlowRef.current = event.flow;
      if (event.flow !== flow) {
        outputBufferRef.current = "";
        setShowTerminal(false);
        setState(initialProviderConnectFlowState);
        return;
      }
    } else if (sessionFlowRef.current !== flow) {
      // The server announces a session's command (and flow) before any output
      // or status, so anything arriving unclaimed belongs to the other panel.
      return;
    }
    if (event.type === "output") {
      outputBufferRef.current = `${outputBufferRef.current}${event.data}`.slice(-64_000);
      terminalWriteRef.current?.(event.data);
    }
    setState((previous) => applyProviderAuthEvent(previous, event));
  });

  // Subscribed for the component's whole lifetime, not just after a click:
  // the server replays the command, buffered output, and status on attach, so
  // a flow started before a tab switch or remount lands back on the panel.
  useEffect(() => {
    let cancelled = false;
    const client = getPrimaryEnvironmentConnection().client;
    const unsubscribe = client.providerAuth.subscribe({ instanceId }, (event) => {
      if (cancelled) return;
      handleEvent(event);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [instanceId]);

  const isActive = isProviderConnectFlowActive(state.status);

  useEffect(() => {
    if (!isActive) {
      setRunningForMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setRunningForMs(Date.now() - startedAt),
      AUTO_EXPAND_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [isActive]);

  useEffect(() => {
    if (state.status === "succeeded") {
      // The job is done and, for token flows, the transcript is no longer
      // interesting — the panel collapses to its success line.
      setShowTerminal(false);
      return;
    }
    if (shouldAutoExpandTerminal({ status: state.status, runningForMs })) {
      setShowTerminal(true);
    }
  }, [runningForMs, state.status]);

  const startFlow = () => {
    outputBufferRef.current = "";
    setState(initialProviderConnectFlowState);
    setShowTerminal(false);
    setIsStarting(true);
    void getPrimaryEnvironmentConnection()
      .client.providerAuth.start({ instanceId, flow, cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not start ${displayName} sign-in`,
            description:
              error instanceof Error ? error.message : "The command could not be started.",
          }),
        );
      })
      .finally(() => {
        setIsStarting(false);
      });
  };

  // Cancel and Dismiss both clear the server-side session too, so a finished
  // run doesn't replay a stale success/failure panel on the next visit.
  const dismissFlow = () => {
    void getPrimaryEnvironmentConnection()
      .client.providerAuth.stop({ instanceId })
      .catch(() => {});
    outputBufferRef.current = "";
    setState(initialProviderConnectFlowState);
    setShowTerminal(false);
  };

  const statusLine = providerConnectStatusLine({ flow, state, displayName });
  const displayCommand = state.command ?? command;
  const panelOpen = state.status !== "idle" || isStarting;

  const actionButton = (
    <Button
      type="button"
      size="xs"
      variant={buttonVariant}
      className={cn(
        "h-6 shrink-0 gap-1 px-2 text-xs",
        buttonVariant === "ghost" && "text-muted-foreground hover:text-foreground",
      )}
      disabled={isActive || isStarting}
      onClick={startFlow}
    >
      {isActive || isStarting ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
      {state.status === "failed" ? "Try again" : actionLabel}
    </Button>
  );

  return (
    <div className="grid gap-2">
      {statusRow ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          {statusRow}
          {actionButton}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {actionButton}
          {description && !panelOpen ? (
            <span className="min-w-0 text-xs text-muted-foreground">{description}</span>
          ) : null}
        </div>
      )}
      {statusRow && description && !panelOpen ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}

      {panelOpen ? (
        <div className="grid gap-2 border-t border-border/60 pt-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span
              className={cn(
                "min-w-0 text-xs",
                state.status === "failed"
                  ? "text-destructive"
                  : state.status === "succeeded"
                    ? "text-success"
                    : "text-foreground",
              )}
            >
              {state.status === "succeeded" ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckIcon className="size-3" aria-hidden />
                  {statusLine}
                </span>
              ) : (
                statusLine
              )}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={dismissFlow}
              >
                {isActive ? "Cancel" : "Dismiss"}
              </Button>
              {state.status === "succeeded" ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => setShowTerminal((open) => !open)}
                  aria-expanded={showTerminal}
                >
                  <ChevronDownIcon
                    className={cn("size-3 transition-transform", showTerminal && "rotate-180")}
                    aria-hidden
                  />
                  {showTerminal ? "Hide details" : "Show details"}
                </Button>
              )}
            </div>
          </div>

          {!showTerminal && state.lastLine.length > 0 && state.status !== "succeeded" ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{state.lastLine}</p>
          ) : null}

          {showTerminal ? (
            <ProviderConnectTerminal
              instanceId={instanceId}
              bufferRef={outputBufferRef}
              writeRef={terminalWriteRef}
            />
          ) : null}
        </div>
      ) : null}

      <details
        className="group"
        open={showFallback}
        onToggle={(event) => setShowFallback(event.currentTarget.open)}
      >
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground marker:hidden">
          <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
          Prefer your own terminal?
        </summary>
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm border border-border/60 bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground/85">
            {displayCommand}
          </code>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            onClick={() => copyToClipboard(displayCommand, "provider-auth-command")}
          >
            <CopyIcon className="size-2.5" />
            {isCopied ? "Copied" : "Copy"}
          </Button>
        </div>
      </details>
    </div>
  );
}
