import type { DesktopLocalServer, ScopedThreadRef } from "@threadlines/contracts";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreVerticalIcon,
  PanelBottomIcon,
  PanelRightIcon,
  PlusIcon,
  RadioTowerIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BROWSER_VIEWPORT_PRESETS,
  selectActiveTab,
  selectThreadBrowserState,
  useBrowserPanelStore,
  type BrowserTab,
  type BrowserViewportPresetId,
} from "../../browserPanelStore";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

/**
 * A <webview> rejects imperative calls until its guest has attached and fired
 * dom-ready. Navigation still happens: `src` is bound to the tab's url, so a
 * tab created and immediately pointed somewhere loads from the attribute once
 * it is ready. These helpers keep that race from surfacing as an error.
 */
function callWhenReady<T>(action: () => T): T | null {
  try {
    return action();
  } catch {
    return null;
  }
}

export interface PreviewWebview extends HTMLElement {
  getWebContentsId: () => number;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void>;
}

interface NavState {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

const IDLE_NAV_STATE: NavState = { canGoBack: false, canGoForward: false, loading: false };

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
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabViewport = useBrowserPanelStore((store) => store.setTabViewport);
  const openTab = useBrowserPanelStore((store) => store.openTab);
  const closeTab = useBrowserPanelStore((store) => store.closeTab);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const dockSide = useBrowserPanelStore((store) => store.dockSide);
  const expanded = useBrowserPanelStore((store) => store.expanded);
  const setDockSide = useBrowserPanelStore((store) => store.setDockSide);
  const toggleExpanded = useBrowserPanelStore((store) => store.toggleExpanded);

  const activeTab = selectActiveTab(browserState);
  const activeTabId = activeTab?.id ?? "";

  // One element per tab, so switching tabs keeps every page alive -- along with
  // the CDP attachment collecting its console and network diagnostics.
  const webviewsRef = useRef(new Map<string, PreviewWebview>());
  const [navState, setNavState] = useState<NavState>(IDLE_NAV_STATE);
  const [addressDraft, setAddressDraft] = useState(activeTab?.url ?? "");
  const activeUrl = activeTab?.url ?? null;

  // The address bar is an input the user types in, so it is only reset when the
  // page moves or the tab changes -- never on every keystroke.
  useEffect(() => {
    setAddressDraft(activeUrl ?? "");
    setNavState(IDLE_NAV_STATE);
  }, [activeUrl, activeTabId]);

  const activeWebview = () => webviewsRef.current.get(activeTabId) ?? null;

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const normalized = normalizePreviewUrl(addressDraft);
      if (normalized === null || activeTabId === "") {
        return;
      }
      setTabUrl(threadRef, activeTabId, normalized);
      const webview = webviewsRef.current.get(activeTabId);
      callWhenReady(() => void webview?.loadURL(normalized));
    },
    [activeTabId, addressDraft, setTabUrl, threadRef],
  );

  const captureScreenshot = useCallback(() => {
    const webview = webviewsRef.current.get(activeTabId);
    if (webview === undefined || !isElectron) {
      return;
    }
    void window.desktopBridge
      ?.previewScreenshot?.({ webContentsId: webview.getWebContentsId() })
      .then((shot) => {
        if (shot.dataUrl !== "") {
          void navigator.clipboard.writeText(shot.dataUrl).catch(() => {});
        }
      });
  }, [activeTabId]);

  const preset =
    BROWSER_VIEWPORT_PRESETS.find((entry) => entry.id === activeTab?.viewportPresetId) ??
    BROWSER_VIEWPORT_PRESETS[0];

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col bg-rail",
        // The rule belongs on the edge the chat is actually on.
        dockSide === "bottom" ? "border-t border-border" : "border-l border-border",
      )}
      style={{ flex: `${flexGrow} 1 0%` }}
      data-testid="browser-panel"
      aria-label="Browser preview"
    >
      <div className="flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border px-1.5 pt-1.5">
        {browserState.tabs.map((tab) => (
          <TabStripItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            closable={browserState.tabs.length > 1}
            onSelect={() => selectTab(threadRef, tab.id)}
            onClose={() => closeTab(threadRef, tab.id)}
          />
        ))}
        <button
          type="button"
          aria-label="New tab"
          data-testid="browser-new-tab"
          className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          onClick={() => openTab(threadRef)}
        >
          <PlusIcon className="size-3.5" />
        </button>

        {/* Where the panel lives belongs with the tabs, not with the controls
            that act on the page. */}
        <div className="ms-auto flex shrink-0 items-center gap-0.5 self-center">
          <NavButton
            label={expanded ? "Restore chat" : "Expand browser"}
            onClick={toggleExpanded}
            active={expanded}
          >
            {expanded ? (
              <MinimizeIcon className="size-3.5" />
            ) : (
              <MaximizeIcon className="size-3.5" />
            )}
          </NavButton>
          <NavButton
            label="Dock to bottom"
            onClick={() => setDockSide("bottom")}
            active={dockSide === "bottom"}
          >
            <PanelBottomIcon className="size-3.5" />
          </NavButton>
          <NavButton
            label="Dock to right"
            onClick={() => setDockSide("right")}
            active={dockSide === "right"}
          >
            <PanelRightIcon className="size-3.5" />
          </NavButton>
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <NavButton
          label="Back"
          disabled={!navState.canGoBack}
          onClick={() => activeWebview()?.goBack()}
        >
          <ArrowLeftIcon className="size-3.5" />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!navState.canGoForward}
          onClick={() => activeWebview()?.goForward()}
        >
          <ArrowRightIcon className="size-3.5" />
        </NavButton>
        <NavButton label="Reload" onClick={() => activeWebview()?.reload()}>
          <RotateCwIcon className={cn("size-3.5", navState.loading && "animate-spin")} />
        </NavButton>

        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            aria-label="Address"
            data-testid="browser-panel-address"
            className="w-full truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground outline-none focus:border-ring focus:text-foreground"
            placeholder="Search or enter URL"
            value={addressDraft}
            onChange={(event) => setAddressDraft(event.target.value)}
          />
        </form>

        <select
          aria-label="Viewport"
          data-testid="browser-panel-viewport"
          className="shrink-0 rounded-md border border-border bg-background px-1.5 py-1 font-mono text-[10px] text-muted-foreground outline-none focus:border-ring"
          value={activeTab?.viewportPresetId ?? "fill"}
          onChange={(event) => {
            if (activeTabId !== "") {
              setTabViewport(threadRef, activeTabId, event.target.value as BrowserViewportPresetId);
            }
          }}
        >
          {BROWSER_VIEWPORT_PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>

        <NavButton label="Capture screenshot" onClick={captureScreenshot}>
          <CameraIcon className="size-3.5" />
        </NavButton>

        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Browser options"
                data-testid="browser-overflow"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              />
            }
          >
            <MoreVerticalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={activeUrl === null}
              onClick={() => {
                if (activeUrl !== null) {
                  void window.desktopBridge?.openExternal?.(activeUrl);
                }
              }}
            >
              Open in default browser
            </MenuItem>
            <MenuItem
              disabled={activeUrl === null}
              onClick={() => {
                if (activeUrl !== null) {
                  void navigator.clipboard.writeText(activeUrl).catch(() => {});
                }
              }}
            >
              Copy address
            </MenuItem>
            <MenuItem
              data-testid="browser-open-devtools"
              onClick={() => {
                const webview = webviewsRef.current.get(activeTabId);
                const id =
                  webview === undefined ? null : callWhenReady(() => webview.getWebContentsId());
                if (id !== null) {
                  void window.desktopBridge?.previewOpenDevTools?.({ webContentsId: id });
                }
              }}
            >
              Open developer tools
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              data-testid="browser-clear-data"
              onClick={() => {
                // Signing out of the preview is the point, so reload after: the
                // page on screen would otherwise still look signed in.
                void window.desktopBridge?.previewClearBrowsingData?.().then(() => {
                  callWhenReady(() => webviewsRef.current.get(activeTabId)?.reload());
                });
              }}
            >
              Clear cookies and storage
            </MenuItem>
          </MenuPopup>
        </Menu>

        <NavButton label="Close browser" onClick={onClose}>
          <XIcon className="size-3.5" />
        </NavButton>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {!isElectron ? (
          <BrowserUnavailableNotice />
        ) : (
          <>
            {activeTab !== null && activeTab.url === null ? (
              <div className="absolute inset-0 z-10 overflow-auto px-3">
                <LocalServerPicker
                  onSelect={(port) => {
                    const url = `http://localhost:${port}`;
                    setTabUrl(threadRef, activeTab.id, url);
                    const webview = webviewsRef.current.get(activeTab.id);
                    callWhenReady(() => void webview?.loadURL(url));
                  }}
                />
              </div>
            ) : null}
            {browserState.tabs.map((tab) => (
              <PreviewTabFrame
                key={tab.id}
                tab={tab}
                threadRef={threadRef}
                isActive={tab.id === activeTabId}
                preset={preset}
                onNavState={setNavState}
                register={(element) => {
                  if (element === null) {
                    webviewsRef.current.delete(tab.id);
                  } else {
                    webviewsRef.current.set(tab.id, element);
                  }
                }}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function TabStripItem({
  tab,
  isActive,
  closable,
  onSelect,
  onClose,
}: {
  tab: BrowserTab;
  isActive: boolean;
  closable: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = tab.title ?? (tab.url === null ? "New tab" : tab.url.replace(/^https?:\/\//, ""));
  return (
    <div
      className={cn(
        "group/tab flex min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-t-md px-2 text-xs",
        isActive
          ? "bg-background text-foreground"
          : "text-muted-foreground/80 hover:bg-accent hover:text-foreground",
      )}
      data-testid={`browser-tab-${tab.id}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1"
        onClick={onSelect}
        title={label}
      >
        <GlobeIcon className="size-3 shrink-0 opacity-70" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {closable ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          data-testid="browser-close-tab"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-accent hover:text-foreground group-hover/tab:opacity-100"
          onClick={onClose}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * One tab's guest page. Kept mounted while inactive and hidden with
 * `visibility` rather than `display`, so the guest keeps its layout: a page
 * collapsed to zero size would report a meaningless viewport to a screenshot
 * or to an agent measuring an element.
 */
function PreviewTabFrame({
  tab,
  threadRef,
  isActive,
  preset,
  onNavState,
  register,
}: {
  tab: BrowserTab;
  threadRef: ScopedThreadRef;
  isActive: boolean;
  preset: (typeof BROWSER_VIEWPORT_PRESETS)[number];
  onNavState: (state: NavState) => void;
  register: (element: PreviewWebview | null) => void;
}) {
  const elementRef = useRef<PreviewWebview | null>(null);
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabTitle = useBrowserPanelStore((store) => store.setTabTitle);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    const webview = elementRef.current;
    if (webview === null || !isElectron) {
      return;
    }
    let attachedId: number | null = null;
    const onAttached = () => {
      attachedId = webview.getWebContentsId();
      void window.desktopBridge?.previewAttach?.({ webContentsId: attachedId });
    };
    const publishNav = (loading: boolean) => {
      // Only the visible tab drives the toolbar; a background tab finishing a
      // load must not repaint controls that describe a different page.
      if (isActiveRef.current) {
        onNavState({
          canGoBack: callWhenReady(() => webview.canGoBack()) ?? false,
          canGoForward: callWhenReady(() => webview.canGoForward()) ?? false,
          loading,
        });
      }
    };
    const onNavigated = () => {
      const url = callWhenReady(() => webview.getURL());
      if (url !== null && url !== "") {
        setTabUrl(threadRef, tab.id, url);
      }
      publishNav(false);
    };
    const onTitle = () => setTabTitle(threadRef, tab.id, webview.getTitle());
    const onStart = () => publishNav(true);
    const onStop = () => publishNav(false);

    webview.addEventListener("did-attach", onAttached);
    webview.addEventListener("did-navigate", onNavigated);
    webview.addEventListener("did-navigate-in-page", onNavigated);
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-stop-loading", onStop);
    return () => {
      webview.removeEventListener("did-attach", onAttached);
      webview.removeEventListener("did-navigate", onNavigated);
      webview.removeEventListener("did-navigate-in-page", onNavigated);
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-stop-loading", onStop);
      if (attachedId !== null) {
        void window.desktopBridge?.previewDetach?.({ webContentsId: attachedId });
      }
    };
  }, [onNavState, setTabTitle, setTabUrl, tab.id, threadRef]);

  return (
    <div
      className={cn(
        "absolute inset-0 flex items-start justify-center overflow-auto p-3",
        isActive ? "visible" : "invisible",
      )}
      data-testid={`browser-frame-${tab.id}`}
    >
      <webview
        ref={(element) => {
          elementRef.current = element as PreviewWebview | null;
          register(element as PreviewWebview | null);
        }}
        {...(isActive ? { "data-testid": "browser-panel-webview" } : {})}
        className="h-full w-full border border-border bg-white"
        style={
          preset.width === null
            ? undefined
            : { width: `${preset.width}px`, height: `${preset.height}px`, flex: "none" }
        }
        partition={PREVIEW_PARTITION}
        {...(tab.url ? { src: tab.url } : {})}
      />
    </div>
  );
}

function NavButton({
  label,
  disabled,
  active,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
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
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              active === true ? "bg-accent text-foreground" : "text-muted-foreground/70",
            )}
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
 * What is listening right now, offered as destinations.
 *
 * A blank address bar is a worse starting point than it looks: the port a dev
 * server picked is exactly the thing nobody remembers. Rows rather than tiles,
 * separated by rules, so it reads as a list of facts.
 */
function LocalServerPicker({ onSelect }: { onSelect: (port: number) => void }) {
  const [servers, setServers] = useState<ReadonlyArray<DesktopLocalServer>>([]);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const scan = () => {
      void window.desktopBridge?.previewLocalServers?.().then((found) => {
        if (!cancelled) {
          setServers(found);
          setScanned(true);
        }
      });
    };
    scan();
    // Servers start and stop while the panel is open; a stale list would send
    // the user to a port that has since died.
    const interval = window.setInterval(scan, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-2 flex items-center gap-2 px-1 text-muted-foreground">
        <RadioTowerIcon className="size-4" />
        <span className="text-sm">Local servers</span>
      </div>
      {servers.length === 0 ? (
        <p className="px-1 py-6 text-xs text-muted-foreground/70">
          {scanned ? "Nothing is listening right now." : "Looking for local servers…"}
        </p>
      ) : (
        <div className="flex flex-col border-t border-border/60">
          {servers.map((server) => (
            <button
              key={server.port}
              type="button"
              data-testid={`local-server-${server.port}`}
              className="flex items-center gap-3 border-b border-border/60 px-1 py-2.5 text-left hover:bg-accent"
              onClick={() => onSelect(server.port)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {server.processName === "" ? "Unknown process" : server.processName}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground/70">
                  localhost:{server.port}
                </span>
              </span>
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
            </button>
          ))}
        </div>
      )}
      <p className="px-1 pt-3 text-xs text-muted-foreground/60">
        Select a listening port to open it here.
      </p>
    </div>
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
