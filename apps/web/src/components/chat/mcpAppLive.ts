/**
 * Running MCP apps (docs/mcp-apps.md): each one's frame, its bridge
 * (mcpAppHost) and what its card and the side panel show about it.
 *
 * Held outside React. The timeline unmounts a card that scrolls away, and an
 * app open beside the chat keeps running then; the side panel
 * (McpAppSidePanel) lives outside the timeline for the same reason. An app
 * lives while its card is mounted or it is open beside the chat, and when
 * neither holds it any more it asks its view to clean up, waits a moment for
 * the answer, and goes.
 *
 * The frame is made once and moved, never drawn by React: between the card
 * and the side panel it moves with `moveBefore` where the browser has it
 * (Chromium), so the view keeps running and keeps what the reader did in it.
 * Elsewhere a move reloads the view, which starts again from the call.
 */
import type {
  EnvironmentId,
  McpAppLoadResult,
  McpAppToolResult,
  ThreadId,
} from "@threadlines/contracts";
import type { AgentPageTheme } from "@threadlines/shared/agentPages";
import { buildMcpAppDocument } from "@threadlines/shared/mcpAppDocument";
import {
  MCP_APP_FRAME_SANDBOX,
  mcpAppFrameAllow,
  mcpAppStyleVariables,
} from "@threadlines/shared/mcpApps";
import { useSyncExternalStore } from "react";

import { isElectron } from "../../env";
import { readEnvironmentApi } from "../../environmentApi";
import { openExternalUrl } from "../../lib/externalLinks";
import { MCP_APP_INLINE_MAX_HEIGHT, readMcpAppFailure } from "./mcpAppClient";
import { McpAppHost, type McpAppDisplayMode } from "./mcpAppHost";

/** How long a view gets to clean up before its frame goes. */
const TEARDOWN_WAIT_MS = 500;

/** A tool call the view made that waits for the reader's say-so. */
export interface PendingMcpAppCall {
  readonly tool: string;
  readonly decide: (answer: "once" | "always" | "deny") => void;
}

export interface McpAppLiveState {
  /** The view's own height as it reported it, CSS px. */
  readonly contentHeight: number | undefined;
  /** The view navigated itself away and was stopped. */
  readonly stopped: boolean;
  /** Open beside the chat. */
  readonly expanded: boolean;
  readonly pending: ReadonlyArray<PendingMcpAppCall>;
}

export interface LiveMcpAppInit {
  readonly key: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly app: McpAppLoadResult;
  readonly theme: AgentPageTheme;
}

type NodeWithMoveBefore = Node & { moveBefore?: (node: Node, child: Node | null) => void };

const canMoveInPlace = () =>
  typeof document !== "undefined" &&
  typeof (document.body as NodeWithMoveBefore).moveBefore === "function";

/** Puts the frame under `parent`, keeping it running where the browser can. */
function placeFrame(frame: HTMLIFrameElement, parent: HTMLElement) {
  if (frame.parentElement === parent) return;
  const moveBefore = (parent as NodeWithMoveBefore).moveBefore;
  if (moveBefore && frame.isConnected) {
    try {
      moveBefore.call(parent, frame, null);
      return;
    } catch {
      // Not movable in place here: a plain move reloads it.
    }
  }
  parent.appendChild(frame);
}

/** A hidden home for frames between places and on their way out. */
function frameLimbo(): HTMLElement {
  const existing = document.getElementById("tl-mcp-app-limbo");
  if (existing) return existing;
  const limbo = document.createElement("div");
  limbo.id = "tl-mcp-app-limbo";
  limbo.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;visibility:hidden";
  document.body.appendChild(limbo);
  return limbo;
}

const live = new Map<string, LiveMcpApp>();
// Cards whose app the reader let run every call, for this app session.
const allowedEveryCall = new Set<string>();
// The key of the app open beside the chat, if any.
let expandedKey: string | null = null;
const expandedListeners = new Set<() => void>();
const notifyExpanded = () => {
  for (const listener of expandedListeners) listener();
};

export class LiveMcpApp {
  readonly key: string;
  readonly title: string;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly app: McpAppLoadResult;

  private readonly toolCallId: string;
  private readonly frame: HTMLIFrameElement;
  /** Where a message the view asks to send goes (the composer). */
  private putMessage: ((text: string) => void) | undefined;
  private host: McpAppHost | null = null;
  private theme: AgentPageTheme;
  private state: McpAppLiveState = {
    contentHeight: undefined,
    stopped: false,
    expanded: false,
    pending: [],
  };
  private readonly listeners = new Set<() => void>();
  private inlineSlot: HTMLElement | null = null;
  private sideSlot: HTMLElement | null = null;
  private cards = 0;
  private loaded = false;
  private disposed = false;
  // The window the view last loaded in: kept through its own navigations,
  // new once the frame was moved where a browser could not keep it running.
  private loadedWindow: Window | null = null;

  constructor(init: LiveMcpAppInit) {
    this.key = init.key;
    this.title = init.title;
    this.threadId = init.threadId;
    this.environmentId = init.environmentId;
    this.toolCallId = init.toolCallId;
    this.app = init.app;
    this.theme = init.theme;
    const frame = document.createElement("iframe");
    frame.title = init.title;
    frame.setAttribute("sandbox", MCP_APP_FRAME_SANDBOX);
    frame.referrerPolicy = "no-referrer";
    const allow = mcpAppFrameAllow(init.app.view.permissions);
    if (allow) frame.allow = allow;
    frame.className = "block size-full border-0 bg-transparent";
    frame.addEventListener("load", this.onLoad);
    window.addEventListener("message", this.onMessage);
    this.frame = frame;
  }

  // ------------------------------------------------------------------
  // What the card and the side panel read

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = () => this.state;

  private update(patch: Partial<McpAppLiveState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------
  // Where it is

  /** A card showing this app mounted; the returned function unmounts it. */
  retainCard(): () => void {
    this.cards += 1;
    return () => {
      this.cards -= 1;
      if (this.cards === 0 && !this.state.expanded) this.dispose();
    };
  }

  setInlineSlot(slot: HTMLElement | null) {
    this.inlineSlot = slot;
    this.place();
  }

  setSideSlot(slot: HTMLElement | null) {
    this.sideSlot = slot;
    this.place();
  }

  /** Opens it beside the chat (closing any other app there), or brings it
   *  back to its card. With no card to come back to, it goes. */
  setExpanded(open: boolean) {
    if (this.disposed || this.state.expanded === open) return;
    if (open) {
      const previous = expandedKey === null ? undefined : live.get(expandedKey);
      if (previous !== undefined && previous.key !== this.key) previous.setExpanded(false);
      expandedKey = this.key;
    } else if (expandedKey === this.key) {
      expandedKey = null;
    }
    this.update({ expanded: open });
    notifyExpanded();
    if (!open && this.cards === 0) {
      this.dispose();
      return;
    }
    this.place();
    this.host?.notifyContext({
      displayMode: open ? "fullscreen" : "inline",
      containerDimensions: open ? {} : { maxHeight: MCP_APP_INLINE_MAX_HEIGHT },
    });
  }

  setPutMessage(put: ((text: string) => void) | undefined) {
    this.putMessage = put;
  }

  setTheme(theme: AgentPageTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.host?.notifyContext({
      theme: theme.appearance,
      styles: { variables: mcpAppStyleVariables(theme) },
    });
  }

  private place() {
    if (this.disposed) return;
    const slot = this.state.expanded ? this.sideSlot : this.inlineSlot;
    if (slot === null) {
      // Between places: kept running out of sight.
      if (this.loaded) placeFrame(this.frame, frameLimbo());
      return;
    }
    if (!this.loaded) {
      // Loaded where it is shown, so a browser that can't move a frame in
      // place doesn't load it twice. The document is set before the frame
      // goes in: a frame put in empty loads a blank page first, and a second
      // load in the same window would read as the view navigating away.
      this.loaded = true;
      this.frame.srcdoc = buildMcpAppDocument({
        html: this.app.view.html,
        csp: this.app.view.csp,
        appearance: this.theme.appearance,
      });
    }
    placeFrame(this.frame, slot);
  }

  /** Asks the view to clean up (its bridge stays open for the answer), then
   *  removes the frame. */
  private dispose() {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this.key);
    if (expandedKey === this.key) {
      expandedKey = null;
      notifyExpanded();
    }
    // Calls still waiting for the reader are refused: nobody is asked any more.
    for (const call of this.state.pending) call.decide("deny");
    const host = this.host;
    const finish = () => {
      host?.dispose();
      this.host = null;
      window.removeEventListener("message", this.onMessage);
      this.frame.removeEventListener("load", this.onLoad);
      this.frame.remove();
    };
    if (host === null || !this.frame.isConnected || !canMoveInPlace()) {
      finish();
      return;
    }
    // Out of the card's way (which may be leaving the document right now),
    // still running.
    placeFrame(this.frame, frameLimbo());
    void host.teardown(TEARDOWN_WAIT_MS).finally(finish);
  }

  // ------------------------------------------------------------------
  // The bridge

  private readonly onLoad = () => {
    const loaded = this.frame.contentWindow;
    if (loaded !== null && loaded === this.loadedWindow) {
      // The view left its document for another: stopped.
      this.update({ stopped: true });
      if (this.state.expanded) this.setExpanded(false);
      return;
    }
    this.loadedWindow = loaded;
  };

  private readonly onMessage = (event: MessageEvent) => {
    const target = this.frame.contentWindow;
    if (target === null || event.source !== target) return;
    this.hostFor(target).handle(event.data);
  };

  /** A click inside the view just now: the frame holds focus and the page
   *  was just used. A view cannot open tabs or grow by itself. */
  private readerActed() {
    return document.activeElement === this.frame && navigator.userActivation?.isActive !== false;
  }

  private hostFor(target: Window): McpAppHost {
    const current = this.host;
    if (current?.target === target) return current;
    current?.dispose();
    const { app } = this;
    const host = new McpAppHost({
      target,
      toolCallId: this.toolCallId,
      tool: app.tool,
      arguments: app.arguments,
      result: app.result,
      csp: app.view.csp,
      permissions: app.view.permissions,
      context: () => ({
        theme: this.theme.appearance,
        styles: { variables: mcpAppStyleVariables(this.theme) },
        displayMode: this.state.expanded ? "fullscreen" : "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: this.state.expanded ? {} : { maxHeight: MCP_APP_INLINE_MAX_HEIGHT },
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: isElectron ? "desktop" : "web",
      }),
      handlers: {
        callTool: (tool, args) => this.callTool(tool, args),
        openLink: (url) => {
          if (!this.readerActed()) return false;
          openExternalUrl(url);
          return true;
        },
        putMessage: (text) => {
          if (!this.putMessage) return false;
          this.putMessage(text);
          return true;
        },
        requestDisplayMode: (mode) => {
          const next: McpAppDisplayMode =
            mode === "fullscreen" && (this.state.expanded || this.readerActed())
              ? "fullscreen"
              : "inline";
          this.setExpanded(next === "fullscreen");
          return next;
        },
        sizeChanged: (height) => this.update({ contentHeight: height }),
        requestTeardown: () => this.setExpanded(false),
        viewLeft: () => {
          this.update({ stopped: true });
          if (this.state.expanded) this.setExpanded(false);
        },
      },
    });
    this.host = host;
    return host;
  }

  /** The reader's say-so for one call: the strip under the view asks. */
  private askReader(tool: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const call: PendingMcpAppCall = {
        tool,
        decide: (answer) => {
          if (answer === "always") allowedEveryCall.add(this.key);
          this.update({ pending: this.state.pending.filter((candidate) => candidate !== call) });
          resolve(answer !== "deny");
        },
      };
      this.update({ pending: [...this.state.pending, call] });
    });
  }

  /**
   * A tool the view calls on its own server, through the agent that ran it.
   * Unless the agent runs without asking (or the reader allowed every call),
   * the reader allows it first; the server may still ask for that.
   */
  private async callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpAppToolResult> {
    const api = readEnvironmentApi(this.environmentId)?.mcpApps;
    if (api === undefined) throw new Error("This Threadlines server can't run app tool calls.");
    const run = (confirmed: boolean) =>
      api.callTool({
        threadId: this.threadId,
        toolCallId: this.toolCallId,
        tool,
        arguments: { ...args },
        confirmed,
      });
    let confirmed = allowedEveryCall.has(this.key);
    if (!this.app.callsAllowed && !confirmed) {
      if (!(await this.askReader(tool))) throw new Error("The user didn't allow this call.");
      confirmed = true;
    }
    try {
      return await run(confirmed);
    } catch (error) {
      // The server's say-so: the reader confirms below, then it runs.
      if (readMcpAppFailure(error).reason !== "needs-confirmation") {
        throw new Error(readMcpAppFailure(error).message, { cause: error });
      }
    }
    if (!(await this.askReader(tool))) throw new Error("The user didn't allow this call.");
    try {
      return await run(true);
    } catch (error) {
      throw new Error(readMcpAppFailure(error).message, { cause: error });
    }
  }
}

/** The running app for a card, made the first time a card asks. */
export function acquireLiveMcpApp(init: LiveMcpAppInit): LiveMcpApp {
  const existing = live.get(init.key);
  if (existing) return existing;
  const created = new LiveMcpApp(init);
  live.set(init.key, created);
  return created;
}

const noApp = () => () => undefined;
const NO_STATE: McpAppLiveState = {
  contentHeight: undefined,
  stopped: false,
  expanded: false,
  pending: [],
};

export function useLiveMcpAppState(app: LiveMcpApp | null): McpAppLiveState {
  return useSyncExternalStore(app?.subscribe ?? noApp, app?.getState ?? (() => NO_STATE));
}

const subscribeExpanded = (listener: () => void) => {
  expandedListeners.add(listener);
  return () => expandedListeners.delete(listener);
};

/** Brings the app open beside the chat back to its card (or ends it, with
 *  no card to go back to): the chat that showed it is going. */
export function closeMcpAppBesideChat() {
  const open = expandedKey === null ? undefined : live.get(expandedKey);
  open?.setExpanded(false);
}

/** The app open beside the chat, if any. */
export function useExpandedMcpApp(): LiveMcpApp | null {
  return useSyncExternalStore(subscribeExpanded, () =>
    expandedKey === null ? null : (live.get(expandedKey) ?? null),
  );
}
