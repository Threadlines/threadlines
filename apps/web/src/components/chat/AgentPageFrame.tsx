import type { AgentPageReadResult } from "@threadlines/contracts";
import {
  AGENT_PAGE_FRAME_SANDBOX,
  type AgentPageTheme,
  agentPageResult,
  agentPageThemeMessage,
  buildAgentPageDocument,
  isAgentPageLeftMessage,
  readAgentPageContentHeight,
  readAgentPageLinkRequest,
} from "@threadlines/shared/agentPages";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/externalLinks";
import { cn } from "../../lib/utils";
import {
  type AgentPageVersionRef,
  cachedAgentPageContent,
  readAgentPageContent,
  useAgentPageTheme,
} from "./agentPageClient";

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
 * reports its height, and asks the app to open links. A page that navigates
 * itself away is stopped: that would be a way to carry what it shows to a
 * server of its own. A browser cannot refuse that first request; the desktop
 * app does (DesktopWindow), and here the frame goes as soon as it is made.
 */
export function AgentPageFrame(props: {
  readonly version: AgentPageVersionRef;
  readonly title: string;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  /** The page's own height as it reports it, CSS px. */
  readonly onContentHeight?: (height: number) => void;
  /** Hands the loaded page up, for saving and viewing its source. */
  readonly onLoaded?: (page: AgentPageReadResult) => void;
}) {
  const { version, onContentHeight, onLoaded } = props;
  const theme = useAgentPageTheme();
  // The document is built with the theme current when the page loads; later
  // changes reach the running page as a message, so it keeps its state.
  const [load, setLoad] = useState<LoadState>(() => {
    const cached = cachedAgentPageContent(version);
    return cached ? { status: "loaded", page: cached, theme } : { status: "loading" };
  });
  const [stopped, setStopped] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const loadsRef = useRef(0);
  const latestThemeRef = useRef(theme);

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
      if (isAgentPageLeftMessage(event.data)) {
        setStopped(true);
        return;
      }
      const height = readAgentPageContentHeight(event.data);
      if (height !== undefined) {
        onContentHeight?.(height);
        return;
      }
      const link = readAgentPageLinkRequest(event.data);
      if (link === undefined) return;
      // Only a link the reader just clicked inside this page: the frame holds
      // focus and the app was just used. A page cannot open tabs by itself.
      if (document.activeElement === frame && navigator.userActivation?.isActive !== false) {
        openExternalUrl(link.url);
      }
      frame.contentWindow?.postMessage(agentPageResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onContentHeight]);

  useFocusGuard(frameRef);

  if (load.status === "failed" || stopped) {
    return (
      <div className={cn("flex items-center justify-center", props.className)} style={props.style}>
        <p className="text-xs text-muted-foreground">
          {stopped
            ? `${props.title} tried to open another page and was stopped.`
            : `Couldn't load ${props.title}.`}
        </p>
      </div>
    );
  }

  return (
    <div className={props.className} style={props.style}>
      {pageDocument !== null ? (
        <iframe
          ref={frameRef}
          title={props.title}
          srcDoc={pageDocument}
          sandbox={AGENT_PAGE_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="block size-full border-0 bg-transparent"
          onLoad={() => {
            // The page itself loads once; any later load is the frame leaving it.
            loadsRef.current += 1;
            if (loadsRef.current > 1) setStopped(true);
          }}
        />
      ) : null}
    </div>
  );
}
