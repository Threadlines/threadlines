import type { ScopedThreadRef } from "@threadlines/contracts";
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BROWSER_VIEWPORT_PRESETS,
  selectThreadBrowserState,
  useBrowserPanelStore,
  type BrowserViewportPresetId,
} from "../../browserPanelStore";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";

import { normalizePreviewUrl } from "./previewUrl";

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

interface PreviewWebview extends HTMLElement {
  getWebContentsId: () => number;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void>;
}

export function BrowserPanel({
  threadRef,
  flexGrow,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  /** Complement of the chat column's share, so the two honour one ratio. */
  flexGrow: number;
  onClose: () => void;
}) {
  const browserState = useBrowserPanelStore((store) =>
    selectThreadBrowserState(store.browserStateByThreadKey, threadRef),
  );
  const setBrowserUrl = useBrowserPanelStore((store) => store.setBrowserUrl);
  const setViewportPreset = useBrowserPanelStore((store) => store.setViewportPreset);

  const webviewRef = useRef<PreviewWebview | null>(null);
  const [addressDraft, setAddressDraft] = useState(browserState.url ?? "");
  const [isLoading, setIsLoading] = useState(false);
  const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false });

  // The address bar is an input the user types in, so it must not be yanked
  // back to the store on every keystroke -- only when the page itself moves.
  useEffect(() => {
    setAddressDraft(browserState.url ?? "");
  }, [browserState.url]);

  // Attach CDP once the guest exists. Done here rather than on first tool call
  // so console output and failed requests are being collected from the first
  // page load: by the time anyone asks what went wrong, it has already printed.
  useEffect(() => {
    const webview = webviewRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    let attachedId: number | null = null;
    const onAttached = () => {
      attachedId = webview.getWebContentsId();
      void window.desktopBridge?.previewAttach?.({ webContentsId: attachedId });
    };
    webview.addEventListener("did-attach", onAttached);
    return () => {
      webview.removeEventListener("did-attach", onAttached);
      if (attachedId !== null) {
        void window.desktopBridge?.previewDetach?.({ webContentsId: attachedId });
      }
    };
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (webview === null) {
      return;
    }
    const syncNav = () => {
      setNavState({ canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() });
    };
    const onNavigated = () => {
      syncNav();
      setBrowserUrl(threadRef, webview.getURL());
    };
    const onStart = () => setIsLoading(true);
    const onStop = () => {
      setIsLoading(false);
      syncNav();
    };
    webview.addEventListener("did-navigate", onNavigated);
    webview.addEventListener("did-navigate-in-page", onNavigated);
    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-stop-loading", onStop);
    return () => {
      webview.removeEventListener("did-navigate", onNavigated);
      webview.removeEventListener("did-navigate-in-page", onNavigated);
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-stop-loading", onStop);
    };
  }, [setBrowserUrl, threadRef]);

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const normalized = normalizePreviewUrl(addressDraft);
      if (normalized === null) {
        return;
      }
      setBrowserUrl(threadRef, normalized);
      void webviewRef.current?.loadURL(normalized);
    },
    [addressDraft, setBrowserUrl, threadRef],
  );

  const preset =
    BROWSER_VIEWPORT_PRESETS.find((entry) => entry.id === browserState.viewportPresetId) ??
    BROWSER_VIEWPORT_PRESETS[0];

  return (
    <section
      className="flex min-w-0 flex-col border-l border-border bg-rail"
      style={{ flex: `${flexGrow} 1 0%` }}
      data-testid="browser-panel"
      aria-label="Browser preview"
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <NavButton
          label="Back"
          disabled={!navState.canGoBack}
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeftIcon className="size-3.5" />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!navState.canGoForward}
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRightIcon className="size-3.5" />
        </NavButton>
        <NavButton label="Reload" onClick={() => webviewRef.current?.reload()}>
          <RotateCwIcon className={cn("size-3.5", isLoading && "animate-spin")} />
        </NavButton>

        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            aria-label="Address"
            data-testid="browser-panel-address"
            className="w-full truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground outline-none focus:border-ring focus:text-foreground"
            placeholder="localhost:5173"
            value={addressDraft}
            onChange={(event) => setAddressDraft(event.target.value)}
          />
        </form>

        <select
          aria-label="Viewport"
          data-testid="browser-panel-viewport"
          className="shrink-0 rounded-md border border-border bg-background px-1.5 py-1 font-mono text-[10px] text-muted-foreground outline-none focus:border-ring"
          value={browserState.viewportPresetId}
          onChange={(event) =>
            setViewportPreset(threadRef, event.target.value as BrowserViewportPresetId)
          }
        >
          {BROWSER_VIEWPORT_PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>

        <NavButton label="Close browser" onClick={onClose}>
          <XIcon className="size-3.5" />
        </NavButton>
      </div>

      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-background p-3">
        {isElectron ? (
          <webview
            ref={webviewRef as never}
            data-testid="browser-panel-webview"
            className="h-full w-full border border-border bg-white"
            style={
              preset.width === null
                ? undefined
                : { width: `${preset.width}px`, height: `${preset.height}px`, flex: "none" }
            }
            partition={PREVIEW_PARTITION}
            {...(browserState.url ? { src: browserState.url } : {})}
          />
        ) : (
          <BrowserUnavailableNotice />
        )}
      </div>
    </section>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The preview is a Chromium <webview>, which only exists in the desktop app.
 * Rather than degrade to an iframe -- which cannot be driven, inspected, or
 * navigated cross-origin -- the web build says so plainly.
 */
function BrowserUnavailableNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <ExternalLinkIcon className="size-5 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">The browser preview needs the desktop app.</p>
      <p className="max-w-xs text-xs text-muted-foreground/70">
        It runs a real Chromium tab so pages can be inspected and driven, which a browser tab cannot
        host.
      </p>
    </div>
  );
}
