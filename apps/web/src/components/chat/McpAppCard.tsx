import type { EnvironmentId, McpAppLoadResult, ThreadId } from "@threadlines/contracts";
import { AppWindowIcon, Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

import { cn } from "../../lib/utils";
import type { McpAppEntry } from "../../session-logic";
import { RightPanelSheet } from "../RightPanelSheet";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAgentPageTheme } from "./agentPageClient";
import {
  cachedMcpApp,
  loadMcpApp,
  MCP_APP_INITIAL_HEIGHT,
  MCP_APP_INLINE_MAX_HEIGHT,
  MCP_APP_MIN_HEIGHT,
  type McpAppFailure,
  readMcpAppFailure,
} from "./mcpAppClient";
import {
  acquireLiveMcpApp,
  closeMcpAppBesideChat,
  type LiveMcpApp,
  type PendingMcpAppCall,
  useExpandedMcpApp,
  useLiveMcpAppState,
} from "./mcpAppLive";

// The card's actions are plain until the card is hovered, as row actions are.
const ROW_ACTION_CLASS =
  "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/app:opacity-100 pointer-coarse:opacity-100";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly app: McpAppLoadResult }
  | { readonly status: "failed"; readonly failure: McpAppFailure };

/** `show_counter` → "Show counter". */
function toolTitle(tool: string): string {
  const words = tool.replace(/[_-]+/gu, " ").trim();
  return words.length > 0 ? `${words[0]!.toUpperCase()}${words.slice(1)}` : tool;
}

/**
 * An MCP app in the chat (docs/mcp-apps.md): the small screen a tool ships,
 * under the step that ran the tool, in a quiet panel like an agent page's.
 * The view runs sealed off in a frame with an opaque origin, under a content
 * policy built from the hosts it declared, and talks to Threadlines over the
 * MCP Apps bridge. Its tool calls go to its own server through the agent that
 * ran it; unless that agent works with full access, the reader allows each
 * one in the card first.
 *
 * The running app (frame, bridge, state) lives in mcpAppLive, not here: the
 * card shows it, and opening it beside the chat moves the same running view
 * into McpAppSidePanel.
 */
export function McpAppCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly app: McpAppEntry;
  /** Puts a message the view asked to send into the composer. */
  readonly onPutMessage?: ((text: string) => void) | undefined;
}) {
  const { environmentId, threadId } = props;
  const { toolCallId, ref } = props.app;
  const title = toolTitle(ref.tool);
  const [load, setLoad] = useState<LoadState>(() => {
    const cached = cachedMcpApp(environmentId, threadId, toolCallId);
    return cached ? { status: "loaded", app: cached } : { status: "loading" };
  });
  const [attempt, setAttempt] = useState<{ readonly recover: boolean } | null>(
    load.status === "loading" ? { recover: false } : null,
  );
  useEffect(() => {
    if (attempt === null) return;
    let cancelled = false;
    loadMcpApp({ environmentId, threadId, toolCallId, recover: attempt.recover }).then(
      (app) => {
        if (!cancelled) setLoad({ status: "loaded", app });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: "failed", failure: readMcpAppFailure(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, environmentId, threadId, toolCallId]);

  const retry = (recover: boolean) => {
    setLoad({ status: "loading" });
    setAttempt({ recover });
  };

  return (
    <div className="group/app min-w-0 surface-group px-3.5 pt-2 pb-3.5" data-mcp-app={toolCallId}>
      {load.status === "loaded" ? (
        <LoadedApp
          appKey={`${environmentId}/${threadId}/${toolCallId}`}
          environmentId={environmentId}
          threadId={threadId}
          toolCallId={toolCallId}
          app={load.app}
          title={title}
          onPutMessage={props.onPutMessage}
        />
      ) : (
        <>
          <CardTitle title={title} server={ref.server} />
          <div
            className="mt-1 flex w-full flex-col items-center justify-center gap-2 text-center"
            style={{ height: MCP_APP_INITIAL_HEIGHT }}
          >
            {load.status === "loading" ? (
              <p className="text-xs text-muted-foreground">Loading the app…</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {load.failure.reason === "session-ended"
                    ? "The agent that ran this app has stopped."
                    : load.failure.message}
                </p>
                {load.failure.reason === "session-ended" || load.failure.reason === "failed" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => retry(load.failure.reason === "session-ended")}
                  >
                    {load.failure.reason === "session-ended"
                      ? "Start it and load the app"
                      : "Try again"}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CardTitle(props: {
  readonly title: string;
  readonly server: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AppWindowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate text-[13.5px] leading-5 font-medium text-foreground">
          {props.title}
        </span>
        <span className="shrink-0 truncate text-[12.5px] leading-5 text-muted-foreground">
          · {props.server} tool server
        </span>
      </div>
      {props.children}
    </div>
  );
}

function LoadedApp(props: {
  readonly appKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly app: McpAppLoadResult;
  readonly title: string;
  readonly onPutMessage?: ((text: string) => void) | undefined;
}) {
  const theme = useAgentPageTheme();
  const [live, setLive] = useState<LiveMcpApp | null>(null);
  const [inlineSlot, setInlineSlot] = useState<HTMLDivElement | null>(null);
  const state = useLiveMcpAppState(live);

  // The running app, held while this card is mounted (and by the side panel
  // while it is open there).
  useLayoutEffect(() => {
    const app = acquireLiveMcpApp({
      key: props.appKey,
      title: props.title,
      environmentId: props.environmentId,
      threadId: props.threadId,
      toolCallId: props.toolCallId,
      app: props.app,
      theme,
    });
    setLive(app);
    const release = app.retainCard();
    return () => {
      app.setInlineSlot(null);
      release();
    };
    // One running app per card key; what changes later reaches it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.appKey]);

  useLayoutEffect(() => {
    live?.setInlineSlot(inlineSlot);
  }, [inlineSlot, live]);

  useEffect(() => {
    live?.setTheme(theme);
  }, [live, theme]);

  useEffect(() => {
    live?.setPutMessage(props.onPutMessage);
  }, [live, props.onPutMessage]);

  const inlineHeight = Math.min(
    MCP_APP_INLINE_MAX_HEIGHT,
    Math.max(MCP_APP_MIN_HEIGHT, state.contentHeight ?? MCP_APP_INITIAL_HEIGHT),
  );
  const asking = state.pending[0];

  return (
    <>
      <CardTitle title={props.title} server={props.app.server}>
        {state.stopped || live === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    state.expanded
                      ? `Show ${props.title} here`
                      : `Open ${props.title} beside the chat`
                  }
                  className={ROW_ACTION_CLASS}
                  onClick={() => live.setExpanded(!state.expanded)}
                />
              }
            >
              <Maximize2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">
              {state.expanded ? "Show here" : "Open beside the chat"}
            </TooltipPopup>
          </Tooltip>
        )}
      </CardTitle>
      {state.stopped ? (
        <p
          className="mt-1 flex items-center justify-center text-xs text-muted-foreground"
          style={{ height: MCP_APP_MIN_HEIGHT }}
        >
          The app tried to open another page and was stopped.
        </p>
      ) : (
        <div
          ref={setInlineSlot}
          className={cn("mt-1 w-full", state.expanded && "flex items-center justify-center")}
          style={{ height: state.expanded ? MCP_APP_MIN_HEIGHT : inlineHeight }}
        >
          {state.expanded ? (
            <p className="text-xs text-muted-foreground">Open beside the chat.</p>
          ) : null}
        </div>
      )}
      {asking && !state.expanded ? <CallApproval call={asking} /> : null}
      {props.app.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The tool's answer was too large to give the app in full.
        </p>
      ) : null}
    </>
  );
}

/**
 * The app open beside the chat, in the chat's side panel. Rendered by the
 * chat outside its timeline, so the app keeps running when its card scrolls
 * away; an app of another thread closes when the chat moves on.
 */
export function McpAppSidePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** Puts a message the view asked to send into the composer. */
  readonly onPutMessage?: ((text: string) => void) | undefined;
}) {
  const live = useExpandedMcpApp();
  const state = useLiveMcpAppState(live);
  const theme = useAgentPageTheme();
  const [sideSlot, setSideSlot] = useState<HTMLDivElement | null>(null);
  const belongsHere =
    live !== null && live.threadId === props.threadId && live.environmentId === props.environmentId;

  useLayoutEffect(() => {
    if (live === null) return;
    if (!belongsHere) {
      live.setExpanded(false);
      return;
    }
    live.setSideSlot(sideSlot);
    return () => live.setSideSlot(null);
  }, [belongsHere, live, sideSlot]);

  useEffect(() => {
    live?.setTheme(theme);
  }, [live, theme]);

  useEffect(() => {
    if (belongsHere) live?.setPutMessage(props.onPutMessage);
  }, [belongsHere, live, props.onPutMessage]);

  // Leaving the chat (for Settings, say) closes the app beside it, rather
  // than keep it running out of sight.
  useEffect(() => closeMcpAppBesideChat, []);

  const asking = state.pending[0];
  return (
    <RightPanelSheet open={belongsHere} onClose={() => live?.setExpanded(false)}>
      <div className="flex min-w-0 items-center gap-1 py-2 ps-4 pe-2">
        <AppWindowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] leading-5 font-medium">
          {live?.title}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={live ? `Close ${live.title}` : "Close"}
          onClick={() => live?.setExpanded(false)}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div ref={setSideSlot} className="min-h-0 flex-1 px-4 pb-4" />
      {asking && belongsHere ? (
        <div className="px-4 pb-4">
          <CallApproval call={asking} />
        </div>
      ) : null}
    </RightPanelSheet>
  );
}

/** The strip that asks the reader whether the view may run a tool. */
function CallApproval(props: { readonly call: PendingMcpAppCall }) {
  const { call } = props;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">
        The app wants to run <span className="font-medium">{call.tool}</span>.
      </p>
      <Button size="xs" variant="outline" onClick={() => call.decide("deny")}>
        Don't allow
      </Button>
      <Button size="xs" variant="outline" onClick={() => call.decide("always")}>
        Allow every call
      </Button>
      <Button size="xs" variant="outline" onClick={() => call.decide("once")}>
        Allow once
      </Button>
    </div>
  );
}
