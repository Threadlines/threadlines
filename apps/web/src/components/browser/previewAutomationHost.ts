import type {
  DesktopBridge,
  PreviewAutomationOperation,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  ScopedThreadRef,
} from "@threadlines/contracts";
import { useEffect, useRef } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";

/**
 * The end of the wire that can actually touch the page.
 *
 * The broker in the server holds the agent's call; this turns it into a call on
 * the desktop bridge and sends the answer back. It lives in the renderer
 * because that is where the `<webview>` is -- the server has no route to a page
 * at all, and the main process has no idea which tab the user is looking at.
 *
 * Kept apart from the React that drives it so the mapping can be tested without
 * an Electron window: every interesting thing here is which bridge call an
 * operation becomes and what happens when it throws.
 */

/**
 * What this build can service.
 *
 * Sent to the broker on connect and checked there before anything is
 * dispatched, so an older client is told it cannot do something rather than
 * being handed a command it would silently drop.
 */
export const PREVIEW_AUTOMATION_HOST_OPERATIONS = [
  "status",
  "tabs",
  "openTab",
  "closeTab",
  "selectTab",
  "snapshot",
  "navigate",
  "click",
  "move",
  "drag",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "screenshot",
  "resize",
  "setAppearance",
] as const satisfies ReadonlyArray<PreviewAutomationOperation>;

export interface PreviewAutomationHostTarget {
  /** Stable browser tab identity used by the agent-facing contract. */
  readonly tabId?: string | null;
  /** The tab the agent acts on: the one the user is looking at. Null when the
   *  panel is open but has no live tab yet. */
  readonly webContentsId: number | null;
  /**
   * Navigating is the one operation the main process cannot do for us: the
   * address belongs to the `<webview>` element, which only the renderer holds.
   * Everything else is a CDP command and goes over the bridge.
   */
  readonly navigate: (url: string) => Promise<void>;
  /** How big the page is right now. The panel is the only one that knows: the
   *  main process cannot see the element and this module should not reach for
   *  it. A question about layout is a question about this. */
  readonly viewport: () => { width: number; height: number };
  /** Where the agent just acted, so the panel can show it happening. */
  readonly onAgentPoint: (point: {
    x: number;
    y: number;
    /** Where a drag began, when this point is the end of one. */
    from?: { x: number; y: number };
  }) => void;
  /** Every page the panel has open. Renderer state, like the viewport: the
   *  main process cannot see the tab strip. */
  readonly tabs: () => ReadonlyArray<{
    id: string;
    title: string;
    url: string;
    active: boolean;
    agent: boolean;
  }>;
  /** Whether the panel is still visible after a tab lifecycle operation. */
  readonly panelOpen?: (() => boolean) | undefined;
  /** Create and resolve a tab for this agent session. */
  readonly openTab?: (input: {
    url?: string | undefined;
    background?: boolean | undefined;
  }) => Promise<PreviewAutomationHostTarget>;
  /** Close a tab and return the listing that remains. */
  readonly closeTab?: (
    tabId: string | null,
  ) => Promise<{ id: string; title: string; url: string } | void>;
  /** Pin this agent to a tab, optionally without moving the user's view. */
  readonly selectTab: (input: {
    tabId?: string | undefined;
    index?: number | undefined;
    background?: boolean | undefined;
  }) => Promise<PreviewAutomationHostTarget> | PreviewAutomationHostTarget | void;
  /** What the agent is doing, in words, for the line under the toolbar. */
  readonly onAgentActivity: (activity: AgentActivity) => void;
  /** The tab changed under the agent because the user acted while it was running. */
  readonly onUserTakeover?: (() => void) | undefined;
}

/**
 * One line of what the agent just did.
 *
 * Emitted here because this is the only place that knows both the operation and
 * what it was aimed at. Without it the only evidence an agent is working is the
 * page changing by itself, which is indistinguishable from the page being
 * broken.
 */
export interface AgentActivity {
  /** Present tense while it runs, past tense once it has answered. */
  readonly phase: "running" | "done";
  /** "clicked", "typed into", "went to" -- a verb, not a tool name. */
  readonly verb: string;
  /** What it acted on, when that is nameable. */
  readonly detail: string | null;
  /** Distinguishes two identical actions in a row. */
  readonly sequence: number;
}

/** The agent's own vocabulary, turned into a person's. */
const ACTIVITY_VERBS: Record<PreviewAutomationOperation, string> = {
  status: "checked",
  tabs: "looked at the tabs",
  openTab: "opened",
  closeTab: "closed",
  selectTab: "switched to",
  snapshot: "read the page",
  navigate: "went to",
  click: "clicked",
  move: "moved to",
  drag: "dragged",
  type: "typed into",
  press: "pressed",
  scroll: "scrolled",
  evaluate: "ran script on",
  waitFor: "waited on",
  screenshot: "looked at the page",
  resize: "resized",
  setAppearance: "restyled",
};

const CONTROLLED_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "navigate",
  "click",
  "move",
  "drag",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "resize",
  "setAppearance",
]);

/** What the action was aimed at, said the way the user would say it. */
function describeSubject(operation: PreviewAutomationOperation, input: unknown): string | null {
  const value = (input ?? {}) as Record<string, unknown>;
  if (operation === "navigate") {
    return typeof value.url === "string" ? value.url : null;
  }
  if (operation === "press") {
    return typeof value.key === "string" ? value.key : null;
  }
  if (operation === "selectTab") {
    if (typeof value.tabId === "string") return value.tabId;
    return typeof value.index === "number" ? `tab ${value.index + 1}` : null;
  }
  if (operation === "openTab") {
    return typeof value.url === "string" ? value.url : "a new tab";
  }
  if (operation === "closeTab") {
    return typeof value.tabId === "string" ? value.tabId : "its tab";
  }
  if (operation === "drag") {
    // Both ends, because "dragged" on its own says nothing about what moved.
    const from = nameTarget(value.from);
    const to = nameTarget(value.to);
    if (from === null || to === null) {
      return from ?? to;
    }
    return `${from} \u2192 ${to}`;
  }
  return nameTarget(value.target);
}

function nameTarget(candidate: unknown): string | null {
  const target = candidate as Record<string, unknown> | undefined;
  if (target === undefined) {
    return null;
  }
  // A locator or a selector is machinery; the text on a thing is its name.
  if (typeof target.text === "string") return `"${target.text}"`;
  if (typeof target.ref === "string") return target.ref;
  if (typeof target.selector === "string") return target.selector;
  if (typeof target.locator === "string") return target.locator;
  // A place rather than a thing, so there is no name to give: the coordinates
  // are all there is, and they are what the pointer is about to do.
  const point = target.point as { x?: unknown; y?: unknown } | undefined;
  if (typeof point?.x === "number" && typeof point.y === "number") {
    return `${Math.round(point.x)}, ${Math.round(point.y)}`;
  }
  return null;
}

/**
 * Turns one request into one response.
 *
 * Never rejects. A failure here is an answer -- the agent needs to be told the
 * selector matched nothing so it can re-snapshot and try again, and a rejected
 * promise would instead leave the broker waiting out its timeout for something
 * we already know.
 */
export function createPreviewAutomationHandler(
  bridge: DesktopBridge,
  resolveTarget: (request: PreviewAutomationRequest) => PreviewAutomationHostTarget,
  /** Makes a page exist before the target is read; see `prepare` on the hook. */
  prepare?: (request: PreviewAutomationRequest) => Promise<void>,
): (request: PreviewAutomationRequest) => Promise<PreviewAutomationResponse> {
  let sequence = 0;
  const tabTails = new Map<number, Promise<void>>();
  const serialize = async <T>(key: number | null, task: () => Promise<T>): Promise<T> => {
    if (key === null) return task();
    const previous = tabTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tabTails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tabTails.get(key) === tail) tabTails.delete(key);
    }
  };
  return async (request: PreviewAutomationRequest): Promise<PreviewAutomationResponse> => {
    if (prepare !== undefined) {
      // Never fatal: whatever state preparing leaves behind, the target below
      // describes it, and a target with no page has its own answer.
      await prepare(request).catch(() => undefined);
    }
    let target: PreviewAutomationHostTarget;
    try {
      target = resolveTarget(request);
    } catch (cause) {
      // A target that cannot even be read is the same conversation as a page
      // that is not there: an answer, never a rejection the broker waits out.
      return { requestId: request.requestId, error: describe(cause) };
    }
    sequence += 1;
    const verb = ACTIVITY_VERBS[request.operation];
    const detail = describeSubject(request.operation, request.input);
    target.onAgentActivity({ phase: "running", verb, detail, sequence });
    const settle = <T>(response: T): T => {
      target.onAgentActivity({ phase: "done", verb, detail, sequence });
      return response;
    };
    if (
      target.webContentsId === null &&
      request.operation !== "openTab" &&
      request.operation !== "tabs"
    ) {
      return settle({
        requestId: request.requestId,
        error: "The browser panel is open but has no page loaded yet.",
      });
    }
    try {
      const result = await serialize(target.webContentsId, async () => {
        const controlled =
          target.webContentsId !== null && CONTROLLED_OPERATIONS.has(request.operation);
        const before =
          controlled && bridge.previewStatus !== undefined
            ? await bridge.previewStatus({ webContentsId: target.webContentsId as number })
            : null;
        const dispatched = await dispatch(bridge, target, target.webContentsId, request);
        const after =
          controlled && bridge.previewStatus !== undefined
            ? await bridge.previewStatus({ webContentsId: target.webContentsId as number })
            : null;
        if (before !== null && after !== null && before.controlEpoch !== after.controlEpoch) {
          target.onUserTakeover?.();
          throw new Error(
            "The browser action was interrupted because the user took control of this tab.",
          );
        }
        return dispatched;
      });
      // The key is omitted rather than set to undefined: an operation with
      // nothing to report should send nothing, not a hole.
      return settle(
        result === undefined
          ? { requestId: request.requestId }
          : {
              requestId: request.requestId,
              result: result as Exclude<PreviewAutomationResponse["result"], undefined>,
            },
      );
    } catch (cause) {
      // Settled on the way out too: an action that failed has still stopped,
      // and a line left saying "clicking" would claim it never did.
      return settle({ requestId: request.requestId, error: describe(cause) });
    }
  };
}

async function dispatch(
  bridge: DesktopBridge,
  target: PreviewAutomationHostTarget,
  webContentsId: number | null,
  request: PreviewAutomationRequest,
): Promise<unknown> {
  const input = (request.input ?? {}) as Record<string, never>;
  const callOn = <T>(
    targetWebContentsId: number,
    method: ((...args: never[]) => Promise<T>) | undefined,
    args: unknown,
  ): Promise<T> => {
    if (method === undefined) {
      // The bridge is built from the same contract as the operation list above,
      // so this means the two drifted rather than that the user did anything.
      throw new Error(`This build cannot perform ${request.operation}.`);
    }
    return (method as (arg: unknown) => Promise<T>)({
      webContentsId: targetWebContentsId,
      ...(args as object),
    });
  };
  const call = <T>(method: ((...args: never[]) => Promise<T>) | undefined, args: unknown) => {
    if (webContentsId === null) throw new Error("The browser tab is not attached yet.");
    return callOn(webContentsId, method, args);
  };

  switch (request.operation) {
    case "status":
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    case "snapshot": {
      const snapshot = await call(bridge.previewSnapshot, {});
      return {
        ...toStatus(target.tabId ?? "", snapshot, target.viewport()),
        page: snapshot.page,
        console: snapshot.console.map((entry) => ({ level: entry.level, text: entry.text })),
        networkFailures: snapshot.networkFailures.map((failure) => ({
          url: failure.url,
          detail: failure.errorText ?? `HTTP ${failure.status ?? "error"}`,
        })),
      };
    }
    case "navigate":
      await target.navigate(String((input as { url?: unknown }).url ?? ""));
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    // Every action answers with where the page ended up. An action that
    // returned nothing failed MCP validation and was shown to the agent as an
    // error, which invited a retry -- and a retried click clicks twice.
    case "click": {
      const point = await call(bridge.previewClick, input);
      // Shown before the page is asked what changed, so the mark lands while
      // the click is still the most recent thing that happened.
      target.onAgentPoint(point);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    }
    case "move": {
      const point = await call(bridge.previewMove, input);
      target.onAgentPoint(point);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    }
    case "drag": {
      const gesture = await call(bridge.previewDrag, input);
      // The whole drag has already happened by the time we hear about it, so
      // the pointer replays it: pressed at one end, travelling, released at the
      // other. Sending only the result would show the destination and lose the
      // gesture, which is the part worth seeing.
      target.onAgentPoint({ ...gesture.to, from: gesture.from });
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    }
    case "tabs":
      return { tabs: target.tabs(), panelOpen: target.panelOpen?.() ?? true };
    case "openTab": {
      if (target.openTab === undefined) throw new Error("This build cannot open browser tabs.");
      const opened = await target.openTab(input);
      if (opened.webContentsId === null) throw new Error("The new browser tab did not attach.");
      return toStatus(
        opened.tabId ?? "",
        await callOn(opened.webContentsId, bridge.previewStatus, {}),
        opened.viewport(),
      );
    }
    case "closeTab": {
      if (target.closeTab === undefined) throw new Error("This build cannot close browser tabs.");
      const closingTabId = typeof input.tabId === "string" ? input.tabId : (target.tabId ?? null);
      const beforeClose = target.tabs().find((tab) => tab.id === closingTabId);
      const reportedClosedTab = await target.closeTab(closingTabId);
      const closedTab =
        reportedClosedTab ??
        (beforeClose === undefined
          ? undefined
          : { id: beforeClose.id, title: beforeClose.title, url: beforeClose.url });
      return {
        tabs: target.tabs(),
        panelOpen: target.panelOpen?.() ?? true,
        ...(closedTab === undefined ? {} : { closedTab }),
      };
    }
    case "selectTab": {
      const selected = await target.selectTab(input);
      if (selected === undefined) throw new Error("The browser tab could not be selected.");
      if (selected.webContentsId === null)
        throw new Error("The selected browser tab did not attach.");
      return toStatus(
        selected.tabId ?? "",
        await callOn(selected.webContentsId, bridge.previewStatus, {}),
        selected.viewport(),
      );
    }
    case "type": {
      const point = await call(bridge.previewType, input);
      target.onAgentPoint(point);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    }
    case "press":
      await call(bridge.previewPress, input);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    case "scroll":
      await call(bridge.previewScroll, input);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    case "waitFor":
      await call(bridge.previewWaitFor, input);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    case "evaluate":
      // Wrapped, because an expression that returns an array or a number is a
      // perfectly good answer and used to fail validation *after* running.
      return { result: await call(bridge.previewEvaluate, input) };
    case "screenshot": {
      const shot = await call(bridge.previewScreenshot, {});
      // Base64 without the data-url header: the tool hands this to the model as
      // an image block, which wants the bytes rather than a URL.
      return {
        data: shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1),
        width: shot.width,
        height: shot.height,
      };
    }
    case "resize":
      await call(bridge.previewSetViewport, input);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    case "setAppearance":
      await call(bridge.previewSetColorScheme, input);
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
  }
}

/**
 * The desktop's status, in the shape the agent was promised.
 *
 * These are two different vocabularies and the host is where they meet: the
 * bridge speaks of webContents and attachment, the contract speaks of a page
 * and its size. Passing one through as the other is what made every snapshot
 * fail on a missing key.
 */
function toStatus(
  tabId: string,
  status: { url: string; title: string; loading: boolean },
  size: { width: number; height: number },
): { tabId: string; url: string; title: string; loading: boolean; width: number; height: number } {
  // The size comes from the panel rather than from here: it is the one part of
  // a page's state that neither the main process nor this module can see, and
  // a question about layout is a question about it.
  return { tabId, url: status.url, title: status.title, loading: status.loading, ...size };
}

/**
 * Whatever came back, as a sentence the agent can act on.
 *
 * Electron wraps a main-process throw in its own prefix, which turns a useful
 * "no element matches ..." into something that reads like the tool is broken.
 * The original message is the part worth keeping.
 */
function describe(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
  const marker = "Error invoking remote method";
  if (!message.startsWith(marker)) {
    return message;
  }
  const lastColon = message.lastIndexOf(": ");
  return lastColon < 0 ? message : message.slice(lastColon + 2);
}

/**
 * Keeps this client registered as the browser for a thread while the panel is
 * showing it.
 *
 * Registration is the subscription: while it is open the agent's calls land
 * here, and when it closes -- panel dismissed, thread switched, socket dropped
 * -- the broker forgets the host and tells anything still waiting that the
 * browser went away. That is the whole lifecycle, and it is why there is no
 * unregister call to forget to make.
 */
export function usePreviewAutomationHost(input: {
  readonly threadRef: ScopedThreadRef;
  readonly enabled: boolean;
  readonly resolveTarget: (request: PreviewAutomationRequest) => PreviewAutomationHostTarget;
  /**
   * Run before the target is resolved, to make one exist. This is where a
   * closed panel is opened and waited for; it must settle within the broker's
   * timeout, and it may settle without succeeding -- a target with no page is
   * an answer the host already knows how to give.
   */
  readonly prepare?: (request: PreviewAutomationRequest) => Promise<void>;
}): void {
  const { threadRef, enabled } = input;
  // Read through a ref so a re-render that changes which tab is active does not
  // tear the subscription down and put it back up.
  const target = useRef(input.resolveTarget);
  target.current = input.resolveTarget;
  const prepare = useRef(input.prepare);
  prepare.current = input.prepare;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!enabled || bridge === undefined) {
      return;
    }
    const handle = createPreviewAutomationHandler(
      bridge,
      (request) => target.current(request),
      (request) => (prepare.current === undefined ? Promise.resolve() : prepare.current(request)),
    );

    const api = ensureEnvironmentApi(threadRef.environmentId);
    return api.previewAutomation.connect(
      {
        threadId: threadRef.threadId,
        // Identifies this connection to the broker, so a reconnect displaces
        // its own earlier registration rather than racing it.
        hostId: `${threadRef.threadId}:${Math.random().toString(36).slice(2)}`,
        operations: PREVIEW_AUTOMATION_HOST_OPERATIONS,
      },
      (request) => {
        // The handler promises never to reject, but a request that slips
        // through anyway must still answer: an unhandled rejection here is
        // twenty seconds of silence for the agent, with nothing logged.
        void handle(request)
          .catch((cause): PreviewAutomationResponse => ({
            requestId: request.requestId,
            error: describe(cause),
          }))
          .then((response) => api.previewAutomation.respond(response));
      },
    );
  }, [enabled, threadRef.environmentId, threadRef.threadId]);
}
