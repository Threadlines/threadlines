import type { AgentPageReadResult } from "@threadlines/contracts";
import {
  AGENT_PAGE_FRAME_SANDBOX,
  type AgentPageContentSize,
  type AgentPageScrollEdges,
  type AgentPageTheme,
  agentPageResult,
  agentPageThemeMessage,
  isAgentPageLeftMessage,
  readAgentPageContentSize,
  readAgentPageImageRequest,
  readAgentPageLinkRequest,
  readAgentPageScrollEdges,
} from "@threadlines/shared/agentPages";
import { buildAgentPageDocument } from "@threadlines/shared/agentPageDocument";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/externalLinks";
import { cn } from "../../lib/utils";
import {
  type AgentPageVersionRef,
  cachedAgentPageContent,
  readAgentPageContent,
  useAgentPageTheme,
} from "./agentPageClient";
import { openExpandedImagePreview } from "./ExpandedImagePreview";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | {
      readonly status: "loaded";
      readonly page: AgentPageReadResult;
      /** The theme the document was built with. */
      readonly theme: AgentPageTheme;
    };

// A key the reader pressed in the app, with when: focus that lands in a page
// right after typing elsewhere was taken, not given (see useFocusGuard).
let lastAppKey: { readonly key: string; readonly at: number } | null = null;
let lastAppFocus: HTMLElement | null = null;
let appInputListeners = 0;
const onAppKeyDown = (event: KeyboardEvent) => {
  lastAppKey = { key: event.key, at: performance.now() };
};
const onAppFocusIn = (event: FocusEvent) => {
  if (event.target instanceof HTMLElement && !(event.target instanceof HTMLIFrameElement)) {
    lastAppFocus = event.target;
  }
};
const TYPING_WINDOW_MS = 1500;

// Something a page waits for may never come: one still loading this long after
// its last report is taken at its word.
const LOADING_GRACE_MS = 2_000;

const NO_SCROLL_EDGES: AgentPageScrollEdges = { above: false, below: false };
// How far in from its edge a frame fades where its page scrolls on past it.
const SCROLL_FADE = "min(48px, 20%)";

/**
 * The frame's mask: the edge a page scrolls on past fades out, so a page
 * cut off by its frame reads as one that goes on, not as one that ends there.
 * The page hides its scrollbar (agentPageDocument.ts), so this is the cue.
 */
function scrollEdgeMask(edges: AgentPageScrollEdges): string | undefined {
  if (!edges.above && !edges.below) return undefined;
  const top = edges.above ? `transparent, #000 ${SCROLL_FADE}` : "#000";
  const bottom = edges.below ? `#000 calc(100% - ${SCROLL_FADE}), transparent` : "#000";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

/**
 * Hands focus back when a page takes it by script. A page can focus itself
 * and read what the reader types next; focus is the reader's to give, by
 * clicking into the page (which marks the app as just used, since activation
 * reaches every frame above the one clicked) or by tabbing into it. Best
 * effort: a page that steals focus during a click inside itself is still in.
 */
function useFocusGuard(frameRef: React.RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    if (appInputListeners++ === 0) {
      document.addEventListener("keydown", onAppKeyDown, true);
      document.addEventListener("focusin", onAppFocusIn, true);
    }
    const onWindowBlur = () => {
      // The frame is the active element only once the blur has settled.
      window.setTimeout(() => {
        const frame = frameRef.current;
        if (frame === null || document.activeElement !== frame) return;
        const typedJustNow =
          lastAppKey !== null &&
          lastAppKey.key !== "Tab" &&
          performance.now() - lastAppKey.at < TYPING_WINDOW_MS;
        const userActed = navigator.userActivation?.isActive ?? true;
        if (userActed && !typedJustNow) return;
        frame.blur();
        if (lastAppFocus?.isConnected) lastAppFocus.focus({ preventScroll: true });
      }, 0);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      if (--appInputListeners === 0) {
        document.removeEventListener("keydown", onAppKeyDown, true);
        document.removeEventListener("focusin", onAppFocusIn, true);
      }
    };
  }, [frameRef]);
}

/**
 * One agent page in its sandboxed frame (docs/agent-pages.md). The page
 * runs with an opaque origin under the content policy the shared wrapper puts
 * ahead of it; it gets the app's theme as it loads and every change after,
 * reports its height, and asks the app to open links and show its pictures
 * bigger, each only on the reader's own click. A page that navigates
 * itself away is stopped: that would be a way to carry what it shows to a
 * server of its own. The desktop app refuses the navigation outright
 * (DesktopWindow). A browser cannot, and here the frame goes on the load
 * that follows: a page that leaves once it has loaded is stopped, one that
 * leaves before its first load finished is not (docs/agent-pages.md).
 *
 * A frame whose element is moved in the document is another matter: the
 * timeline re-sorts its rows, and a browser that cannot move a frame in place
 * loads its page again from scratch, in a new window. That is the same page
 * under the same policy, so it stays.
 *
 * A page taller than its frame scrolls inside it, and the frame's edge fades
 * on each side the page goes on past.
 */
export function AgentPageFrame(props: {
  readonly version: AgentPageVersionRef;
  readonly title: string;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  /**
   * The page's own height as it reports it, CSS px, and whether it had
   * loaded. A page still loading a while after its last report counts as loaded.
   */
  readonly onContentSize?: (size: AgentPageContentSize) => void;
  /** Hands the loaded page up, for saving and viewing its source. */
  readonly onLoaded?: (page: AgentPageReadResult) => void;
  /** Draws the page bigger or smaller, laid out at the frame's width over this. */
  readonly zoom?: number;
}) {
  const { version, title, onContentSize, onLoaded } = props;
  const theme = useAgentPageTheme();
  // The document is built with the theme current when the page loads; later
  // changes reach the running page as a message, so it keeps its state.
  const [load, setLoad] = useState<LoadState>(() => {
    const cached = cachedAgentPageContent(version);
    return cached ? { status: "loaded", page: cached, theme } : { status: "loading" };
  });
  const [stopped, setStopped] = useState(false);
  const [scrollEdges, setScrollEdges] = useState(NO_SCROLL_EDGES);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The window the page last loaded in: kept through a page's own
  // navigations, new once the frame's element was put back into the document.
  const loadedWindowRef = useRef<Window | null>(null);
  const latestThemeRef = useRef(theme);
  const loadingGraceRef = useRef<number | undefined>(undefined);

  const { environmentId, threadId, pageId, versionId } = version;
  useEffect(() => {
    if (load.status !== "loading") return;
    let cancelled = false;
    readAgentPageContent({ environmentId, threadId, pageId, versionId }).then(
      (page) => {
        if (!cancelled) setLoad({ status: "loaded", page, theme: latestThemeRef.current });
      },
      () => {
        if (!cancelled) setLoad({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, load.status, pageId, threadId, versionId]);

  useEffect(() => {
    if (load.status === "loaded") onLoaded?.(load.page);
  }, [load, onLoaded]);

  const pageDocument = useMemo(
    () =>
      load.status === "loaded"
        ? buildAgentPageDocument({
            content: load.page.content,
            kind: load.page.kind,
            theme: load.theme,
          })
        : null,
    [load],
  );

  useEffect(() => {
    latestThemeRef.current = theme;
    frameRef.current?.contentWindow?.postMessage(agentPageThemeMessage(theme), "*");
  }, [theme]);

  // Listening from the first commit, before the frame can report anything.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      // Seldom reached for a page that navigates: in Chromium the leaving
      // document's message arrives with no source once the frame holds the
      // next document (measured on 151), and is dropped by the check above.
      // The load rule below is what stops a page there.
      if (isAgentPageLeftMessage(event.data)) {
        setStopped(true);
        return;
      }
      const size = readAgentPageContentSize(event.data);
      if (size !== undefined) {
        window.clearTimeout(loadingGraceRef.current);
        if (!size.loaded) {
          loadingGraceRef.current = window.setTimeout(
            () => onContentSize?.({ ...size, loaded: true }),
            LOADING_GRACE_MS,
          );
        }
        onContentSize?.(size);
        return;
      }
      const edges = readAgentPageScrollEdges(event.data);
      if (edges !== undefined) {
        setScrollEdges(edges);
        return;
      }
      // Only what the reader just clicked inside this page: the frame holds
      // focus and the app was just used. Best effort, as for focus: a page
      // that holds focus can still ask in the moments after the reader used
      // the app anywhere, since the app cannot see clicks inside the frame.
      const clickedInPage =
        document.activeElement === frame && navigator.userActivation?.isActive !== false;
      const image = readAgentPageImageRequest(event.data);
      if (image !== undefined) {
        if (!clickedInPage) return;
        openExpandedImagePreview({
          images: image.images.map(({ src, alt }) => ({ src, name: alt || title })),
          index: image.index,
        });
        return;
      }
      const link = readAgentPageLinkRequest(event.data);
      if (link === undefined) return;
      if (clickedInPage) openExternalUrl(link.url);
      frame.contentWindow?.postMessage(agentPageResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onContentSize, title]);

  useEffect(() => () => window.clearTimeout(loadingGraceRef.current), []);

  useFocusGuard(frameRef);

  if (load.status === "failed" || stopped) {
    return (
      <div className={cn("flex items-center justify-center", props.className)} style={props.style}>
        <p className="text-xs text-muted-foreground">
          {stopped
            ? `${title} tried to open another page and was stopped.`
            : `Couldn't load ${title}.`}
        </p>
      </div>
    );
  }

  return (
    <div className={props.className} style={props.style}>
      {pageDocument !== null ? (
        <iframe
          ref={frameRef}
          title={title}
          srcDoc={pageDocument}
          sandbox={AGENT_PAGE_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="block size-full border-0 bg-transparent"
          style={{
            // The frame's zoom reaches the page inside, which lays itself out
            // at the frame's width over the zoom, as a browser's zoom does.
            ...(props.zoom === undefined || props.zoom === 1 ? {} : { zoom: props.zoom }),
            maskImage: scrollEdgeMask(scrollEdges),
          }}
          onLoad={(event) => {
            const loaded = event.currentTarget.contentWindow;
            // The page loads once in a window; a second load in the same
            // window is the page leaving for another document.
            if (loaded !== null && loaded === loadedWindowRef.current) {
              setStopped(true);
              return;
            }
            const movedInDocument = loadedWindowRef.current !== null;
            loadedWindowRef.current = loaded;
            // Loaded again after a move, the document carries the theme it was
            // first built with.
            if (movedInDocument) {
              loaded?.postMessage(agentPageThemeMessage(latestThemeRef.current), "*");
            }
          }}
        />
      ) : null}
    </div>
  );
}
