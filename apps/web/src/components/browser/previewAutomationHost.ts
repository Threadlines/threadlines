import { scopeThreadRef } from "@threadlines/client-runtime";
import type {
  DesktopBridge,
  EnvironmentId,
  PreviewAutomationHostFeature,
  PreviewAutomationHostMessage,
  PreviewAutomationOperation,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  ScopedThreadRef,
  ThreadId,
} from "@threadlines/contracts";

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

/** Protocol features this build understands; see the contract for each. */
export const PREVIEW_AUTOMATION_HOST_FEATURES = [
  "cancel",
] as const satisfies ReadonlyArray<PreviewAutomationHostFeature>;

/**
 * The server stopped waiting for this request. Thrown inside the handler to
 * unwind it; never sent anywhere, since nobody is listening for the answer.
 */
class PreviewAutomationCancelled extends Error {
  constructor() {
    super("The browser request was cancelled.");
  }
}

/** Read through a call: the answer changes across awaits, which narrowing misses. */
function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (isCancelled(signal)) {
    throw new PreviewAutomationCancelled();
  }
}

/**
 * Settles when the signal aborts; never, without one. The listener is removed
 * by `dispose`, so a request that finishes normally leaves nothing behind.
 */
function whenCancelled(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>;
  readonly dispose: () => void;
} {
  let dispose = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(new PreviewAutomationCancelled());
      return;
    }
    const onAbort = () => reject(new PreviewAutomationCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  // Observed here so an abort nothing is racing is not an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, dispose };
}

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
  readonly navigate: (url: string, signal?: AbortSignal) => Promise<void>;
  /** How big the page is right now, in its own CSS pixels: the size it was
   *  given, or the panel's when it fills it. The panel is the only one that
   *  knows: the main process cannot see the element and this module should not
   *  reach for it. A question about layout is a question about this. */
  readonly viewport: () => { width: number; height: number };
  /**
   * Records the CSS viewport the agent asked for on the tab, the same as a drag
   * on the frame's edges: the panel scales the frame to fit and the device
   * toolbar shows the size. The guest is told separately, by this module, so
   * the answer read straight afterwards does not race a render.
   */
  readonly setViewport: (viewport: { width: number | null; height: number | null }) => void;
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
  readonly openTab?: (
    input: {
      url?: string | undefined;
      background?: boolean | undefined;
    },
    signal?: AbortSignal,
  ) => Promise<PreviewAutomationHostTarget>;
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
  /**
   * Readies the page for the agent's action -- awake, and painted if it is
   * off screen -- and returns the call that marks the action finished.
   */
  readonly beginWork?: (() => Promise<() => void>) | undefined;
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
  if (operation === "resize") {
    // The size is the whole story of a resize; "resized" alone reads as a
    // panel that changed shape for no reason.
    return typeof value.width === "number" && typeof value.height === "number"
      ? `${Math.round(value.width)}×${Math.round(value.height)}`
      : "to fit the panel";
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
 *
 * Answers null for a request the server cancelled, which is not sent: the
 * agent was already told it timed out. A cancelled request still waiting its
 * turn on a tab never runs. One that has started is left to finish, holding
 * its place in the tab's queue: the desktop cannot stop an action halfway, and
 * letting the next one start alongside it would interleave two actions on one
 * page. The desktop bounds every step, so a stuck action still gives way.
 */
export function createPreviewAutomationHandler(
  bridge: DesktopBridge,
  resolveTarget: (request: PreviewAutomationRequest) => PreviewAutomationHostTarget,
  /** Makes a page exist before the target is read; see `prepare` on the hook. */
  prepare?: (request: PreviewAutomationRequest) => Promise<void>,
): (
  request: PreviewAutomationRequest,
  signal?: AbortSignal,
) => Promise<PreviewAutomationResponse | null> {
  let sequence = 0;
  const tabTails = new Map<number, Promise<void>>();
  const serialize = async <T>(
    key: number | null,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> => {
    throwIfCancelled(signal);
    if (key === null) return task();
    const previous = tabTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tabTails.set(key, tail);
    // Forgotten only once everything ahead of it has also finished. A request
    // cancelled while queued releases its own turn at once, but the tab is not
    // free until the one it was waiting on is done.
    void tail.then(() => {
      if (tabTails.get(key) === tail) tabTails.delete(key);
    });
    const cancelled = whenCancelled(signal);
    try {
      // Only the wait for a turn is raced. Once started, the task runs out.
      await Promise.race([previous, cancelled.promise]);
      return await task();
    } finally {
      cancelled.dispose();
      release();
    }
  };
  return async (
    request: PreviewAutomationRequest,
    signal?: AbortSignal,
  ): Promise<PreviewAutomationResponse | null> => {
    if (prepare !== undefined) {
      // Never fatal: whatever state preparing leaves behind, the target below
      // describes it, and a target with no page has its own answer.
      await prepare(request).catch(() => undefined);
    }
    if (isCancelled(signal)) {
      return null;
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
      const result = await serialize(target.webContentsId, signal, async () => {
        const controlled =
          target.webContentsId !== null && CONTROLLED_OPERATIONS.has(request.operation);
        const before =
          controlled && bridge.previewStatus !== undefined
            ? await bridge.previewStatus({ webContentsId: target.webContentsId as number })
            : null;
        // The last moment to back out before the page is touched.
        throwIfCancelled(signal);
        const endWork = (await target.beginWork?.()) ?? (() => {});
        const dispatched = await dispatch(
          bridge,
          target,
          target.webContentsId,
          request,
          signal,
        ).finally(endWork);
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
      const response = settle(
        result === undefined
          ? { requestId: request.requestId }
          : {
              requestId: request.requestId,
              result: result as Exclude<PreviewAutomationResponse["result"], undefined>,
            },
      );
      // Cancelled while it ran: it finished, but nobody is waiting to hear.
      return isCancelled(signal) ? null : response;
    } catch (cause) {
      // Settled on the way out too: an action that failed has still stopped,
      // and a line left saying "clicking" would claim it never did.
      const response = settle({ requestId: request.requestId, error: describe(cause) });
      return cause instanceof PreviewAutomationCancelled ? null : response;
    }
  };
}

async function dispatch(
  bridge: DesktopBridge,
  target: PreviewAutomationHostTarget,
  webContentsId: number | null,
  request: PreviewAutomationRequest,
  /** Reaches the operations that can wait on the user, so a cancel stops the wait. */
  signal: AbortSignal | undefined,
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
      await target.navigate(String((input as { url?: unknown }).url ?? ""), signal);
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
      const opened = await target.openTab(input, signal);
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
    case "resize": {
      await call(bridge.previewSetViewport, input);
      // Recorded on the tab only once the guest has taken it, so a frame never
      // shows a size the page was not given.
      const size = input as { width?: number | null; height?: number | null };
      target.setViewport({ width: size.width ?? null, height: size.height ?? null });
      return toStatus(target.tabId ?? "", await call(bridge.previewStatus, {}), target.viewport());
    }
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
 * Makes this client the browser for one environment's threads, for as long as
 * the returned call has not been made.
 *
 * With a server that routes to client-wide hosts, one subscription serves
 * every thread: each request names its thread, and the server picks which
 * client holds which thread (see `PreviewAutomationClientHostSchema`). An
 * older server only reaches a thread a client is showing, one subscription
 * per thread, so then this follows the thread on screen.
 *
 * Registration is the subscription: while it is open the agent's calls land
 * here, and when it closes -- socket dropped, app closing -- the broker forgets
 * the host and tells anything still waiting that the browser went away.
 */
export function connectEnvironmentBrowserHost(input: {
  readonly environmentId: EnvironmentId;
  /** The client runs on the server's machine, so its `localhost` is the agent's. */
  readonly machineLocal: boolean;
  /** Whether the server routes to client-wide hosts; read when connecting. */
  readonly clientHosts: boolean;
  readonly resolveTarget: (
    threadRef: ScopedThreadRef,
    request: PreviewAutomationRequest,
  ) => PreviewAutomationHostTarget;
  readonly prepare: (
    threadRef: ScopedThreadRef,
    request: PreviewAutomationRequest,
  ) => Promise<void>;
  /** Another client took this thread's browser. */
  readonly onRelease: (threadRef: ScopedThreadRef) => void;
  /**
   * The connection came back after dropping. The server forgot which threads
   * this client held; the caller claims back the one the user is looking at.
   */
  readonly onReconnect: () => void;
  /** For an older server: the thread on screen in this environment, and its changes. */
  readonly shownThread: {
    readonly current: () => ThreadId | null;
    readonly subscribe: (listener: () => void) => () => void;
  };
}): { readonly hostId: string; readonly disconnect: () => void } {
  const bridge = window.desktopBridge;
  const hostId = `client:${Math.random().toString(36).slice(2)}`;
  if (bridge === undefined) {
    return { hostId, disconnect: () => {} };
  }
  const api = ensureEnvironmentApi(input.environmentId);
  // Requests still being worked on, so a cancel can reach the one it names and
  // a release every one for its thread.
  const inFlight = new Map<string, { controller: AbortController; threadId: ThreadId | null }>();

  const listen = (fallbackThreadId: ThreadId | null) => {
    const handle = createPreviewAutomationHandler(
      bridge,
      (request) => input.resolveTarget(threadRefOf(request, fallbackThreadId), request),
      (request) => input.prepare(threadRefOf(request, fallbackThreadId), request),
    );
    return (message: PreviewAutomationHostMessage) => {
      if ("_tag" in message) {
        if (message._tag === "cancel") {
          inFlight.get(message.requestId)?.controller.abort();
        } else {
          // The server has already failed these for the agent; work still
          // going here -- a question waiting on the user, a page loading --
          // must stop, not land on pages nobody is routed to any more.
          for (const entry of inFlight.values()) {
            if (entry.threadId === message.threadId) entry.controller.abort();
          }
          input.onRelease(scopeThreadRef(input.environmentId, message.threadId));
        }
        return;
      }
      const request = message;
      const controller = new AbortController();
      inFlight.set(request.requestId, {
        controller,
        threadId: request.threadId ?? fallbackThreadId,
      });
      // The handler promises never to reject, but a request that slips
      // through anyway must still answer: an unhandled rejection here is
      // twenty seconds of silence for the agent, with nothing logged.
      void handle(request, controller.signal)
        .catch((cause): PreviewAutomationResponse => ({
          requestId: request.requestId,
          error: describe(cause),
        }))
        .then((response) => {
          inFlight.delete(request.requestId);
          return response === null ? undefined : api.previewAutomation.respond(response);
        })
        // An answer that cannot be delivered means the connection is gone,
        // and the broker has already failed the request for the agent.
        .catch(() => undefined);
    };
  };
  const threadRefOf = (request: PreviewAutomationRequest, fallback: ThreadId | null) => {
    const threadId = request.threadId ?? fallback;
    if (threadId === null || threadId === undefined) {
      throw new Error("The browser request did not say which thread it was for.");
    }
    return scopeThreadRef(input.environmentId, threadId);
  };
  const abortAll = () => {
    // The broker has already failed these for the agent; stop the work too.
    for (const entry of inFlight.values()) entry.controller.abort();
    inFlight.clear();
  };

  if (input.clientHosts) {
    const unsubscribe = api.previewAutomation.connectClient(
      {
        hostId,
        operations: PREVIEW_AUTOMATION_HOST_OPERATIONS,
        features: PREVIEW_AUTOMATION_HOST_FEATURES,
        machineLocal: input.machineLocal,
      },
      listen(null),
      { onResubscribe: input.onReconnect },
    );
    return {
      hostId,
      disconnect: () => {
        abortAll();
        unsubscribe();
      },
    };
  }

  // An older server: one registration for the thread on screen, moved as it changes.
  let current: { threadId: ThreadId; unsubscribe: () => void } | null = null;
  const follow = () => {
    const threadId = input.shownThread.current();
    if (current?.threadId === threadId) return;
    abortAll();
    current?.unsubscribe();
    current =
      threadId === null
        ? null
        : {
            threadId,
            unsubscribe: api.previewAutomation.connect(
              {
                threadId,
                hostId: `${threadId}:${Math.random().toString(36).slice(2)}`,
                operations: PREVIEW_AUTOMATION_HOST_OPERATIONS,
                features: PREVIEW_AUTOMATION_HOST_FEATURES,
              },
              listen(threadId),
            ),
          };
  };
  follow();
  const stopFollowing = input.shownThread.subscribe(follow);
  return {
    hostId,
    disconnect: () => {
      stopFollowing();
      abortAll();
      current?.unsubscribe();
      current = null;
    },
  };
}
