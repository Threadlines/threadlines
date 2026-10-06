"use client";

import type { ProviderAuthFlow, ProviderInstanceId } from "@threadlines/contracts";
import type { Terminal } from "@xterm/xterm";
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { createXtermSurface } from "../terminal/xtermSurface";
import {
  isProviderConnectFlowActive,
  providerConnectStatusLine,
} from "./providerConnectFlow.logic";
import { useIsCommunityAgent } from "./communityAgents";
import type { ProviderConnectFlowState } from "./providerConnectFlow.logic";
import { useProviderConnectFlow } from "./useProviderConnectFlow";

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
      data-agent-row-toggle-ignore
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
  /**
   * Open the terminal as soon as the flow is active instead of waiting out
   * the stall threshold. Set when the user arrived via a sign-in hand-off
   * (`?instance=`): another surface already waited the threshold out, and
   * making them wait it out twice is the bug the hand-off exists to fix.
   */
  readonly autoShowTerminal?: boolean;
  /** Replaces the "finish in your browser" line while the flow runs. */
  readonly runningHint?: string | undefined;
  /**
   * `browser`: the flow signs in through a web page with no terminal
   * (Antigravity). No terminal or command fallback; a field takes the
   * page's final address when the browser ran on another device.
   */
  readonly surface?: "terminal" | "browser";
}

/**
 * Finishes a browser sign-in started on another device: the browser ends on a
 * loopback address that only this computer can reach, so the user pastes it
 * here. Settings and the setup screen both show it while such a sign-in runs.
 */
export function BrowserRedirectField(props: { readonly onSubmit: (url: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = () => {
    const url = value.trim();
    if (!url) return;
    setPending(true);
    setError(null);
    props
      .onSubmit(url)
      .then(() => setValue(""))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "That address didn't work."),
      )
      .finally(() => setPending(false));
  };
  return (
    <div className="grid gap-1.5" data-agent-row-toggle-ignore>
      <p className="text-xs text-muted-foreground">
        Signing in on another device? When the browser ends on a page that can't be reached, copy
        that page's address and paste it here.
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          type="url"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="http://127.0.0.1:…"
          aria-label="Address the browser ended on"
          className="h-6 min-w-0 flex-1 rounded-sm border border-group-divider bg-background/80 px-2 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={pending || value.trim().length === 0}
          onClick={submit}
        >
          {pending ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
          Finish sign-in
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Settings-owned provider sign-in.
 *
 * The whole flow stays on this page: the server runs the provider's auth
 * command in an ephemeral PTY, the panel shows the last output line, and a
 * "Show details" toggle reveals the real terminal for flows that need a
 * pasted code or a menu choice.
 */
/**
 * A page the agent asked to have opened, shown as text until the user opens
 * it. Opening it is also the answer the agent is waiting for.
 */
function ProviderPageRequest(props: {
  readonly displayName: string;
  readonly request: NonNullable<ProviderConnectFlowState["pageRequest"]>;
  readonly onAnswer: (accept: boolean) => Promise<void>;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<"provider-auth-page">();
  const { url, message } = props.request;
  return (
    <div className="grid gap-1.5 rounded-sm border border-group-divider px-2.5 py-2">
      <p className="text-xs text-foreground">
        {message ?? `${props.displayName} wants you to open a page to sign in.`}
      </p>
      <code className="block overflow-x-auto whitespace-nowrap font-mono text-[11px] text-muted-foreground">
        {url}
      </code>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => {
            void ensureLocalApi()
              .shell.openExternal(url)
              .catch(() => {});
            void props.onAnswer(true).catch(() => {});
          }}
        >
          <ExternalLinkIcon className="size-3" aria-hidden />
          Open sign-in page
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => copyToClipboard(url, "provider-auth-page")}
        >
          <CopyIcon className="size-2.5" />
          {isCopied ? "Copied" : "Copy link"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={() => void props.onAnswer(false).catch(() => {})}
        >
          Don't open
        </Button>
      </div>
    </div>
  );
}

export function ProviderConnectFlow({
  instanceId,
  flow,
  displayName,
  actionLabel,
  command,
  description,
  statusRow,
  buttonVariant = "default",
  autoShowTerminal = false,
  runningHint,
  surface = "terminal",
}: ProviderConnectFlowProps) {
  const [showFallback, setShowFallback] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
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

  const {
    state,
    isStarting,
    isActive,
    needsTerminal,
    outputBufferRef,
    terminalWriteRef,
    start,
    reset,
    submitRedirect,
    answerPageRequest,
  } = useProviderConnectFlow({
    instanceId,
    flow,
    onStartError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not start ${displayName} sign-in`,
          description: error instanceof Error ? error.message : "The command could not be started.",
        }),
      );
    },
  });

  const isBrowserFlow = surface === "browser" || state.surface === "browser";
  // A community agent's links wait for a click: Threadlines hasn't tested
  // the agent, and the address is the agent's own.
  const isCommunityAgent = useIsCommunityAgent(instanceId);

  useEffect(() => {
    if (isBrowserFlow) return;
    if (state.status === "succeeded") {
      // The job is done and, for token flows, the transcript is no longer
      // interesting — the panel collapses to its success line.
      setShowTerminal(false);
      return;
    }
    if (needsTerminal || (autoShowTerminal && isProviderConnectFlowActive(state.status))) {
      setShowTerminal(true);
    }
  }, [autoShowTerminal, isBrowserFlow, needsTerminal, state.status]);

  // Open the printed sign-in page once per run. Most CLIs open the browser
  // themselves; the ones that cannot (fx inside WSL) print a device-code URL
  // and wait, which would otherwise time out silently. A browser sign-in's
  // page is opened by the flow hook, for whichever surface started it.
  const openedSignInUrlRef = useRef<string | null>(null);
  const openSignInUrl = (url: string) => {
    openedSignInUrlRef.current = url;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => {
        // The link button below stays available as the manual path.
      });
  };
  useEffect(() => {
    const url = state.signInUrl;
    if (
      isBrowserFlow ||
      isCommunityAgent ||
      !url ||
      !isProviderConnectFlowActive(state.status) ||
      openedSignInUrlRef.current === url
    ) {
      return;
    }
    openSignInUrl(url);
  }, [isBrowserFlow, isCommunityAgent, state.signInUrl, state.status]);

  const startFlow = () => {
    setShowTerminal(false);
    openedSignInUrlRef.current = null;
    start();
  };

  // Cancel and Dismiss both clear the server-side session too, so a finished
  // run doesn't replay a stale success/failure panel on the next visit.
  const dismissFlow = () => {
    reset();
    setShowTerminal(false);
  };

  const statusLine = providerConnectStatusLine({ flow, state, displayName, runningHint });
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
        <div className="grid gap-2 border-t border-group-divider pt-2">
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
              {/* A page the agent asked for has its own box below, and its own
                  button: not a second one here for a different address. */}
              {state.signInUrl && isActive && !state.pageRequest ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => openSignInUrl(state.signInUrl!)}
                >
                  <ExternalLinkIcon className="size-3" aria-hidden />
                  Open sign-in page
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={dismissFlow}
              >
                {isActive ? "Cancel" : "Dismiss"}
              </Button>
              {state.status === "succeeded" || isBrowserFlow ? null : (
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

          {showTerminal && !isBrowserFlow ? (
            <ProviderConnectTerminal
              instanceId={instanceId}
              bufferRef={outputBufferRef}
              writeRef={terminalWriteRef}
            />
          ) : null}

          {isActive && state.pageRequest ? (
            <ProviderPageRequest
              displayName={displayName}
              request={state.pageRequest}
              onAnswer={answerPageRequest}
            />
          ) : null}

          {isBrowserFlow && !isCommunityAgent && isActive && state.signInUrl ? (
            <BrowserRedirectField onSubmit={submitRedirect} />
          ) : null}
        </div>
      ) : null}

      {isBrowserFlow ? null : (
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
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm border border-group-divider bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground/85">
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
      )}
    </div>
  );
}
