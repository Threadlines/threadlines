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
  "snapshot",
  "navigate",
  "click",
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
  readonly onAgentPoint: (point: { x: number; y: number }) => void;
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
  resolveTarget: () => PreviewAutomationHostTarget,
): (request: PreviewAutomationRequest) => Promise<PreviewAutomationResponse> {
  return async (request: PreviewAutomationRequest): Promise<PreviewAutomationResponse> => {
    const target = resolveTarget();
    if (target.webContentsId === null) {
      return {
        requestId: request.requestId,
        error: "The browser panel is open but has no page loaded yet.",
      };
    }
    try {
      const result = await dispatch(bridge, target, target.webContentsId, request);
      // The key is omitted rather than set to undefined: an operation with
      // nothing to report should send nothing, not a hole.
      return result === undefined
        ? { requestId: request.requestId }
        : {
            requestId: request.requestId,
            result: result as Exclude<PreviewAutomationResponse["result"], undefined>,
          };
    } catch (cause) {
      return { requestId: request.requestId, error: describe(cause) };
    }
  };
}

async function dispatch(
  bridge: DesktopBridge,
  target: PreviewAutomationHostTarget,
  webContentsId: number,
  request: PreviewAutomationRequest,
): Promise<unknown> {
  const input = (request.input ?? {}) as Record<string, never>;
  const call = <T>(
    method: ((...args: never[]) => Promise<T>) | undefined,
    args: unknown,
  ): Promise<T> => {
    if (method === undefined) {
      // The bridge is built from the same contract as the operation list above,
      // so this means the two drifted rather than that the user did anything.
      throw new Error(`This build cannot perform ${request.operation}.`);
    }
    return (method as (arg: unknown) => Promise<T>)({ webContentsId, ...(args as object) });
  };

  switch (request.operation) {
    case "status":
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    case "snapshot": {
      const snapshot = await call(bridge.previewSnapshot, {});
      return {
        ...toStatus(snapshot, target.viewport()),
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
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    // Every action answers with where the page ended up. An action that
    // returned nothing failed MCP validation and was shown to the agent as an
    // error, which invited a retry -- and a retried click clicks twice.
    case "click": {
      const point = await call(bridge.previewClick, input);
      // Shown before the page is asked what changed, so the mark lands while
      // the click is still the most recent thing that happened.
      target.onAgentPoint(point);
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    }
    case "type":
      await call(bridge.previewType, input);
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    case "press":
      await call(bridge.previewPress, input);
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    case "scroll":
      await call(bridge.previewScroll, input);
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    case "waitFor":
      await call(bridge.previewWaitFor, input);
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
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
      return toStatus(await call(bridge.previewStatus, {}), target.viewport());
    case "setAppearance":
      return await call(bridge.previewSetColorScheme, input);
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
  status: { url: string; title: string; loading: boolean },
  size: { width: number; height: number },
): { url: string; title: string; loading: boolean; width: number; height: number } {
  // The size comes from the panel rather than from here: it is the one part of
  // a page's state that neither the main process nor this module can see, and
  // a question about layout is a question about it.
  return { url: status.url, title: status.title, loading: status.loading, ...size };
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
  readonly resolveTarget: () => PreviewAutomationHostTarget;
}): void {
  const { threadRef, enabled } = input;
  // Read through a ref so a re-render that changes which tab is active does not
  // tear the subscription down and put it back up.
  const target = useRef(input.resolveTarget);
  target.current = input.resolveTarget;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!enabled || bridge === undefined) {
      return;
    }
    const handle = createPreviewAutomationHandler(bridge, () => target.current());

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
        void handle(request).then((response) => api.previewAutomation.respond(response));
      },
    );
  }, [enabled, threadRef.environmentId, threadRef.threadId]);
}
