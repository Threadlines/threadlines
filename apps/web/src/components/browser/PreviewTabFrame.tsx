import type { ScopedThreadRef } from "@threadlines/contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  callWhenReady,
  registerPreviewWebview,
  useBrowserPanelStore,
  type BrowserTab,
  type BrowserViewport,
} from "../../browserPanelStore";
import { useBrowserLiveStore } from "../../browserLiveStore";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { AgentPointer, type AgentPointerPosition } from "./AgentPointer";
import { resolveBrowserViewportLayout } from "./browserViewportLayout";
import { hostOf } from "./previewUrl";

/**
 * Electron's <webview> is a custom element, so React needs to be told it exists.
 * It is deliberately the renderer's own element rather than a native view over
 * the window: that keeps it inside normal CSS layout, so dialogs, popovers and
 * the source control sheet stack above it without any bounds bookkeeping.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}

export interface PreviewWebview extends HTMLElement {
  getWebContentsId: () => number;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  isLoading: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  setZoomFactor: (factor: number) => void;
  loadURL: (url: string) => Promise<void>;
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) => number;
  stopFindInPage: (action: "clearSelection" | "keepSelection" | "activateSelection") => void;
}

/**
 * How a page is shown. Never `display: none`, so the guest keeps its layout: a
 * page collapsed to zero size would report a meaningless viewport to a
 * screenshot or to an agent measuring an element.
 *
 * - visible: on screen.
 * - drawn: invisible but still painted, for a page an agent is using. Chromium
 *   produces no picture of a hidden page, so a screenshot of one never returns.
 * - hidden: not painted; Chromium also slows its timers.
 */
export type PreviewFrameMode = "visible" | "drawn" | "hidden";

const FRAME_MODE_STYLES: Record<PreviewFrameMode, CSSProperties> = {
  visible: { visibility: "visible" },
  drawn: { visibility: "visible", opacity: 0, pointerEvents: "none" },
  hidden: { visibility: "hidden" },
};

/** One tab's guest page, rendered by the browser layer whichever thread it belongs to. */
export function PreviewTabFrame({
  tab,
  threadRef,
  partition,
  isActive,
  mode,
  viewport,
  zoomFactor,
  colorScheme,
  onResize,
  agentPoint,
  agentPointRetiring,
}: {
  tab: BrowserTab;
  threadRef: ScopedThreadRef;
  /** The project's browser profile, as handed out by the desktop. */
  partition: string;
  /** The thread's current tab, whose state the panel's toolbar shows. */
  isActive: boolean;
  mode: PreviewFrameMode;
  viewport: BrowserViewport;
  zoomFactor: number;
  colorScheme: "light" | "dark";
  onResize?: ((viewport: BrowserViewport) => void) | undefined;
  /** The agent's last touch, drawn over this tab when it is the visible one. */
  agentPoint: AgentPointerPosition | null;
  /** Whether that touch is fading out, its page having been navigated away. */
  agentPointRetiring: boolean;
}) {
  const elementRef = useRef<PreviewWebview | null>(null);
  // Fixed at mount and never rewritten: navigation goes through `loadURL`, and
  // a `src` that tracked the tab's URL would re-load pages React re-rendered.
  // `about:blank` rather than no `src` because a webview with no `src` never
  // attaches a guest at all, leaving a tab the agent can see but nothing --
  // not even `navigate` -- can act on.
  const [initialSrc] = useState(() => tab.url ?? "about:blank");
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabTitle = useBrowserPanelStore((store) => store.setTabTitle);
  const setTabFavicon = useBrowserPanelStore((store) => store.setTabFavicon);
  const setNavState = useBrowserLiveStore((store) => store.setNavState);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;
  const zoomFactorRef = useRef(zoomFactor);
  zoomFactorRef.current = zoomFactor;

  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    const id = callWhenReady(() => webview.getWebContentsId());
    if (id !== null) {
      void window.desktopBridge?.previewSetColorScheme?.({ webContentsId: id, colorScheme });
    }
  }, [colorScheme]);

  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    callWhenReady(() => webview.setZoomFactor(zoomFactor));
  }, [zoomFactor]);

  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    const id = callWhenReady(() => webview.getWebContentsId());
    if (id !== null) {
      void window.desktopBridge?.previewSetViewport?.({
        webContentsId: id,
        width: viewport.width,
        height: viewport.height,
      });
    }
  }, [viewport.width, viewport.height]);

  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    let attachedId: number | null = null;
    const onAttached = () => {
      attachedId = webview.getWebContentsId();
      // Re-announced now that the guest exists: registration happened at
      // mount, before attach, and an agent waiting on this webview is waiting
      // for the moment it can actually be driven.
      registerPreviewWebview(threadRef, tab.id, webview);
      callWhenReady(() => webview.setZoomFactor(zoomFactorRef.current));
      void window.desktopBridge?.previewAttach?.({ webContentsId: attachedId }).then(() => {
        // A page that respects prefers-color-scheme should follow the app
        // rather than the OS: a dark app hosting a stubbornly light page is
        // the jarring part, and it is the app the page is embedded in.
        void window.desktopBridge?.previewSetColorScheme?.({
          webContentsId: attachedId as number,
          colorScheme: colorSchemeRef.current,
        });
      });
    };
    const publishNav = (loading: boolean) => {
      // Only the visible tab drives the toolbar; a background tab finishing a
      // load must not repaint controls that describe a different page.
      if (isActiveRef.current) {
        setNavState(threadRef, {
          canGoBack: callWhenReady(() => webview.canGoBack()) ?? false,
          canGoForward: callWhenReady(() => webview.canGoForward()) ?? false,
          loading,
        });
      }
    };
    // Tracked so the favicon only resets when the page actually moved to a
    // different site: a site without one would otherwise wear the previous
    // site's icon forever, while clearing on every navigation would flash the
    // globe on each same-site reload.
    let lastHost: string | null = null;
    const onNavigated = () => {
      // Electron remembers zoom per origin inside the session, so a page
      // visited at 125% comes back at 125% while our control still reads
      // 100%. Reasserting on every navigation keeps the two from drifting.
      callWhenReady(() => webview.setZoomFactor(zoomFactorRef.current));
      const url = callWhenReady(() => webview.getURL());
      // `about:blank` is the seed of an empty tab, not somewhere the user went:
      // written back it would dismiss the new-tab view under a fake address.
      if (url !== null && url !== "" && url !== "about:blank") {
        setTabUrl(threadRef, tab.id, url);
        const host = hostOf(url);
        if (lastHost !== null && host !== lastHost) {
          setTabFavicon(threadRef, tab.id, null);
        }
        lastHost = host;
      }
      publishNav(false);
    };
    const onTitle = () => setTabTitle(threadRef, tab.id, webview.getTitle());
    const onFavicon = (event: Event) => {
      const favicons = (event as Event & { favicons?: string[] }).favicons;
      setTabFavicon(threadRef, tab.id, favicons?.[0] ?? null);
    };
    const onStart = () => publishNav(true);
    const onStop = () => publishNav(false);

    webview.addEventListener("did-attach", onAttached);
    webview.addEventListener("did-navigate", onNavigated);
    webview.addEventListener("did-navigate-in-page", onNavigated);
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("page-favicon-updated", onFavicon);
    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-stop-loading", onStop);
    return () => {
      webview.removeEventListener("did-attach", onAttached);
      webview.removeEventListener("did-navigate", onNavigated);
      webview.removeEventListener("did-navigate-in-page", onNavigated);
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("page-favicon-updated", onFavicon);
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-stop-loading", onStop);
      if (attachedId !== null) {
        void window.desktopBridge?.previewDetach?.({ webContentsId: attachedId });
      }
    };
  }, [setNavState, setTabFavicon, setTabTitle, setTabUrl, tab.id, threadRef]);

  // Coming on screen -- the thread shown again, or this tab chosen -- raises no
  // navigation event, so the toolbar is told where this page stands now.
  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron || mode !== "visible" || !isActive) {
      return;
    }
    setNavState(threadRef, {
      canGoBack: callWhenReady(() => webview.canGoBack()) ?? false,
      canGoForward: callWhenReady(() => webview.canGoForward()) ?? false,
      loading: callWhenReady(() => webview.isLoading()) ?? false,
    });
  }, [isActive, mode, setNavState, threadRef]);

  // The container is measured so the frame can be placed at computed
  // coordinates: Electron positions the guest's surface from the element's own
  // box, and a flex-centred element sits where its unscaled size says while
  // painting somewhere else.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = canvasRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setContainer({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = resolveBrowserViewportLayout({ container, viewport, zoomFactor });

  return (
    <div
      ref={canvasRef}
      className="absolute inset-0 overflow-hidden"
      // Inline rather than utility classes: which of the three a page is in
      // decides whether a screenshot of it can ever return.
      style={FRAME_MODE_STYLES[mode]}
      data-testid={`browser-frame-${tab.id}`}
      data-frame-mode={mode}
      data-fit-scale={layout.scale}
    >
      <div
        className="relative"
        style={{ width: `${layout.canvasWidth}px`, height: `${layout.canvasHeight}px` }}
      >
        <webview
          ref={(element) => {
            elementRef.current = element as PreviewWebview | null;
            registerPreviewWebview(threadRef, tab.id, element as PreviewWebview | null);
          }}
          {...(mode === "visible" ? { "data-testid": "browser-panel-webview" } : {})}
          // `flex` is deliberate: Electron's webview uses its own display value
          // to size the guest, and replacing it breaks painting.
          className={cn("absolute flex bg-background", !layout.fills && "ring-1 ring-border")}
          style={{
            left: `${layout.x}px`,
            top: `${layout.y}px`,
            // Laid out unscaled and shrunk by a transform on the element, so
            // the guest keeps the CSS viewport it was asked for.
            width: `${layout.width / layout.scale}px`,
            height: `${layout.height / layout.scale}px`,
            ...(layout.scale < 1
              ? { transform: `scale(${layout.scale})`, transformOrigin: "top left" }
              : {}),
          }}
          partition={partition}
          src={initialSrc}
        />
        {mode === "visible" ? (
          // Positioned in the same frame as the guest, so a page pixel and a
          // panel pixel mean the same thing to it.
          <div
            className="pointer-events-none absolute"
            style={{ left: `${layout.x}px`, top: `${layout.y}px` }}
          >
            <AgentPointer
              position={agentPoint}
              scale={layout.scale}
              retiring={agentPointRetiring}
            />
          </div>
        ) : null}
        {!layout.fills && mode === "visible" && onResize !== undefined ? (
          <div
            className="pointer-events-none absolute"
            style={{
              left: `${layout.x}px`,
              top: `${layout.y}px`,
              width: `${layout.width}px`,
              height: `${layout.height}px`,
            }}
          >
            <ViewportResizeHandle
              edge="right"
              viewport={viewport}
              scale={layout.scale}
              onResize={onResize}
            />
            <ViewportResizeHandle
              edge="bottom"
              viewport={viewport}
              scale={layout.scale}
              onResize={onResize}
            />
            <ViewportResizeHandle
              edge="corner"
              viewport={viewport}
              scale={layout.scale}
              onResize={onResize}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Drag handles on the page's own edges.
 *
 * Resizing the device by dragging is the natural gesture, and it means finding
 * a breakpoint does not require resizing the whole app around it. A shield is
 * raised while dragging because the pointer crosses the guest, which is a
 * separate process and would otherwise swallow the events.
 */
function ViewportResizeHandle({
  edge,
  viewport,
  scale,
  onResize,
}: {
  edge: "right" | "bottom" | "corner";
  viewport: BrowserViewport;
  /** Pointer travel is in screen pixels; the device is measured in its own. */
  scale: number;
  onResize: (viewport: BrowserViewport) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const originRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    originRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: viewport.width ?? 0,
      height: viewport.height ?? 0,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) {
      return;
    }
    const origin = originRef.current;
    const ratio = scale > 0 ? scale : 1;
    const width =
      edge === "bottom"
        ? origin.width
        : Math.max(160, origin.width + (event.clientX - origin.x) / ratio);
    const height =
      edge === "right"
        ? origin.height
        : Math.max(160, origin.height + (event.clientY - origin.y) / ratio);
    onResize({ width: Math.round(width), height: Math.round(height) });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const position =
    edge === "right"
      ? "-right-1.5 inset-y-0 w-3 cursor-col-resize"
      : edge === "bottom"
        ? "-bottom-1.5 inset-x-0 h-3 cursor-row-resize"
        : "-bottom-1.5 -right-1.5 size-3 cursor-nwse-resize";

  return (
    <>
      {/* pointer-events-auto throughout: these live inside the overlay that
          sets pointer-events-none to stay out of the page's way, and the
          value inherits -- without the override the handles are decoration. */}
      {dragging ? <div className="pointer-events-auto fixed inset-0 z-40 cursor-inherit" /> : null}
      <div
        role="separator"
        aria-label={`Resize ${edge === "corner" ? "viewport" : edge + " edge"}`}
        data-testid={`browser-resize-${edge}`}
        className={cn(
          "pointer-events-auto absolute z-50 flex items-center justify-center",
          position,
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span
          className={cn(
            "rounded-full bg-border transition-colors hover:bg-muted-foreground/60",
            edge === "right" ? "h-8 w-1" : edge === "bottom" ? "h-1 w-8" : "size-2",
            dragging && "bg-muted-foreground/70",
          )}
        />
      </div>
    </>
  );
}
