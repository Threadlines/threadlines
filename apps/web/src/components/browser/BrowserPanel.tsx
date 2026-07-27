import type { DrawingContext } from "../../lib/drawingContext";
import {
  pickedElementFromPreview,
  type PickedElementContextDraft,
} from "../../lib/pickedElementContext";
import type {
  DesktopLocalServer,
  DesktopPreviewAnnotationMode,
  DesktopPreviewPickedElement,
  DesktopPreviewPickMode,
  ScopedThreadRef,
} from "@threadlines/contracts";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MaximizeIcon,
  MinimizeIcon,
  ChevronDownIcon,
  EraserIcon,
  MousePointerClickIcon,
  PencilIcon,
  SquareDashedMousePointerIcon,
  MoreVerticalIcon,
  PlusIcon,
  RadioTowerIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BROWSER_VIEWPORT_PRESETS,
  RESPONSIVE_VIEWPORT,
  selectActiveTab,
  selectThreadBrowserState,
  steppedZoom,
  useBrowserPanelStore,
  type BrowserAppearance,
  type BrowserTab,
  type BrowserViewport,
} from "../../browserPanelStore";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RotateDeviceIcon } from "../Icons";
import { resolveBrowserViewportLayout } from "./browserViewportLayout";
import { AgentPointer, type AgentPointerPosition } from "./AgentPointer";
import { usePreviewAutomationHost } from "./previewAutomationHost";
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
  reloadIgnoringCache: () => void;
  setZoomFactor: (factor: number) => void;
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
  onPickElement,
  onScreenshot,
  onDrawing,
  pendingReveal,
  onRevealHandled,
}: {
  threadRef: ScopedThreadRef;
  /** Complement of the chat column's share, so the two honour one ratio. */
  flexGrow: number;
  onClose: () => void;
  /** Hands a picked element to the composer as context for the next message. */
  onPickElement?: ((element: DesktopPreviewPickedElement) => void) | undefined;
  /** Attaches a captured screenshot to the message being written. */
  onScreenshot?: ((input: { dataUrl: string; name: string }) => void) | undefined;
  /** Attaches a drawing made on the page: one chip carrying its picture. */
  onDrawing?: ((context: DrawingContext) => void) | undefined;
  /** An element to show again, requested from a composer chip. */
  pendingReveal?: PickedElementContextDraft | null | undefined;
  onRevealHandled?: (() => void) | undefined;
}) {
  const browserState = useBrowserPanelStore((store) =>
    selectThreadBrowserState(store.browserStateByThreadKey, threadRef),
  );
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabViewport = useBrowserPanelStore((store) => store.setTabViewport);
  const openTab = useBrowserPanelStore((store) => store.openTab);
  const closeTab = useBrowserPanelStore((store) => store.closeTab);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const expanded = useBrowserPanelStore((store) => store.expanded);
  const toggleExpanded = useBrowserPanelStore((store) => store.toggleExpanded);
  const deviceToolbarOpen = useBrowserPanelStore((store) => store.deviceToolbarOpen);
  const toggleDeviceToolbar = useBrowserPanelStore((store) => store.toggleDeviceToolbar);
  const appearance = useBrowserPanelStore((store) => store.appearance);
  const setAppearance = useBrowserPanelStore((store) => store.setAppearance);
  const setTabZoom = useBrowserPanelStore((store) => store.setTabZoom);
  const { resolvedTheme } = useTheme();
  const guestColorScheme = appearance === "system" ? resolvedTheme : appearance;

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

  // The agent's last touch on the page, shown over the webview so it is
  // visible working rather than silently changing things.
  const [agentPoint, setAgentPoint] = useState<AgentPointerPosition | null>(null);

  const activeWebview = () => webviewsRef.current.get(activeTabId) ?? null;

  // Host rather than hostname: on a dev box every page is localhost and the
  // port is the only thing telling two captures apart.
  const screenshotName = useCallback(() => {
    try {
      return new URL(activeUrl ?? "").host.replace(":", "-") || "page";
    } catch {
      return "page";
    }
  }, [activeUrl]);

  // Offers this panel as the page the agent acts on, for as long as it is here.
  usePreviewAutomationHost({
    threadRef,
    enabled: isElectron,
    resolveTarget: () => {
      const webview = activeWebview();
      return {
        webContentsId: webview === null ? null : webview.getWebContentsId(),
        onAgentPoint: (point) => {
          setAgentPoint((previous) => ({
            ...point,
            sequence: (previous?.sequence ?? 0) + 1,
          }));
        },
        viewport: () => {
          const rect = webview?.getBoundingClientRect();
          return {
            width: Math.round(rect?.width ?? 0),
            height: Math.round(rect?.height ?? 0),
          };
        },
        // The address belongs to the element, so this is the one operation the
        // main process cannot do on the agent's behalf.
        navigate: async (url) => {
          const normalized = normalizePreviewUrl(url);
          // Refused rather than silently doing nothing: the agent gave an
          // address, and it needs to know if that address was not one.
          if (normalized === null) {
            throw new Error(`${JSON.stringify(url)} is not a URL this browser can open.`);
          }
          setTabUrl(threadRef, activeTabId, normalized);
          await webview?.loadURL(normalized);
        },
      };
    },
  });

  // Opening the device row on a responsive tab seeds concrete dimensions from
  // whatever the page currently occupies. Without them there is nothing to drag
  // and nothing to type over, so the row would open showing "auto" and do
  // nothing until a preset was chosen.
  const viewportAreaRef = useRef<HTMLDivElement | null>(null);
  const measurePanelViewport = useCallback((): BrowserViewport | null => {
    const area = viewportAreaRef.current;
    if (area === null) {
      return null;
    }
    const width = Math.max(160, Math.round(area.clientWidth - 24));
    const height = Math.max(160, Math.round(area.clientHeight - 24));
    return { width, height };
  }, []);

  useEffect(() => {
    if (!deviceToolbarOpen || activeTab === null || activeTab.viewport.width !== null) {
      return;
    }
    const measured = measurePanelViewport();
    if (measured !== null) {
      setTabViewport(threadRef, activeTab.id, measured);
    }
  }, [activeTab, deviceToolbarOpen, measurePanelViewport, setTabViewport, threadRef]);

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

  /**
   * Which page tool is armed, or null when the pointer belongs to the page.
   *
   * One piece of state for all four: they are the same act of pointing at the
   * page, they all want the pointer, and only one can be live. Kept here rather
   * than in the store because what they act on -- the guest document, and any
   * ink on it -- dies with the page, so a remembered mode would light the
   * control up over nothing.
   */
  const [armedTool, setArmedTool] = useState<PageTool | null>(null);
  // Read inside the pick round trip, which outlives the render that started it.
  const armedToolRef = useRef<PageTool | null>(null);
  const [selectedTool, setSelectedTool] = useState<PageTool>("element");

  const armTool = useCallback(
    async (requested: PageTool | null, options?: { readonly toggle?: boolean }) => {
      const webview = webviewsRef.current.get(activeTabId);
      if (webview === null || webview === undefined || !isElectron) {
        return;
      }
      const webContentsId = webview.getWebContentsId();
      const previous = armedToolRef.current;
      // Pressing the lit control puts the tool away, which for ink is also how
      // you clear it: putting the pen down and being done are the same moment.
      // Reaching into the menu does not toggle, though -- choosing a tool from
      // a list means use this one, and having it turn the tool off because it
      // happened to already be on reads as the menu being broken.
      const next = options?.toggle !== false && previous === requested ? null : requested;

      if (isInkTool(previous) && !isInkTool(next)) {
        // Parked, not binned. A drawing you have not attached yet is unsent
        // work, and reaching for the picker to name something inside what you
        // just circled should not throw the circle away. Pressing the lit pen
        // is how you clear it, and that comes through here as next === null.
        await window.desktopBridge?.previewSetAnnotationMode?.({
          webContentsId,
          mode: next === null ? null : "idle",
        });
      } else if (previous !== null && !isInkTool(previous)) {
        await window.desktopBridge?.previewCancelPick?.({ webContentsId });
      }

      armedToolRef.current = next;
      setArmedTool(next);
      if (next === null) {
        return;
      }
      if (isInkTool(next)) {
        // Straight to the new mode when moving between the pen and the eraser:
        // the eraser exists to fix the stroke you just drew, and clearing on
        // the way there would leave nothing to fix.
        await window.desktopBridge?.previewSetAnnotationMode?.({ webContentsId, mode: next });
        // One wait covers a stretch with the pen, including trips to the
        // eraser. Coming back after using another tool starts a fresh one,
        // because parking the ink settled the last.
        if (isInkTool(previous)) {
          return;
        }
        const drawing = await window.desktopBridge?.previewAwaitDrawing?.({ webContentsId });
        if (drawing === null || drawing === undefined) {
          return;
        }
        // Photographed before the marks come down, because the ink is half of
        // what the drawing says.
        const shot = await window.desktopBridge?.previewScreenshot?.({ webContentsId });
        if (shot !== undefined && shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1) !== "") {
          // One thing, because it was one act. The picture and whatever the
          // closed strokes went round travel together behind a single chip
          // rather than scattering across the composer.
          onDrawing?.({
            note: drawing.note,
            imageDataUrl: shot.dataUrl,
            url: activeUrl ?? "",
            elements: drawing.elements.map(pickedElementFromPreview),
          });
        }
        await window.desktopBridge?.previewSetAnnotationMode?.({ webContentsId, mode: null });
        armedToolRef.current = null;
        setArmedTool(null);
        return;
      }
      try {
        const elements = await window.desktopBridge?.previewPickElement?.({
          webContentsId,
          colorScheme: guestColorScheme,
          mode: next,
        });
        for (const element of elements ?? []) {
          onPickElement?.(element);
        }
      } finally {
        // Only if nothing else took the pointer while this was waiting: arming
        // another tool cancels this pick, and its resolution must not then
        // disarm the tool that replaced it.
        if (armedToolRef.current === next) {
          armedToolRef.current = null;
          setArmedTool(null);
        }
      }
    },
    [activeTabId, activeUrl, guestColorScheme, onDrawing, onPickElement],
  );

  // Everything these tools act on lives in the guest document, which a new
  // address replaces. Switching tabs is the same story: the tool was armed on
  // the other one.
  const activeTabUrl = activeTab?.url ?? null;
  useEffect(() => {
    armedToolRef.current = null;
    setArmedTool(null);
  }, [activeTabUrl, activeTabId]);

  // A reveal request arrives from the composer, which cannot know which tab is
  // showing the page it came from -- or whether the panel was even open. The
  // panel resolves that here: it prefers a tab already on that URL, falls back
  // to the active one, and reports when the element has since gone.
  const [revealMissing, setRevealMissing] = useState<string | null>(null);
  useEffect(() => {
    if (pendingReveal === null || pendingReveal === undefined || !isElectron) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      const onSameUrl = browserState.tabs.find((tab) => tab.url === pendingReveal.url);
      if (onSameUrl !== undefined && onSameUrl.id !== activeTabId) {
        selectTab(threadRef, onSameUrl.id);
        // Let the newly active tab mount before asking it for anything.
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (cancelled) return;
      const targetId = onSameUrl?.id ?? activeTabId;
      const webview = webviewsRef.current.get(targetId);
      if (webview === null || webview === undefined) {
        onRevealHandled?.();
        return;
      }
      const found = await window.desktopBridge?.previewRevealElement?.({
        webContentsId: webview.getWebContentsId(),
        selector: pendingReveal.selector,
      });
      if (cancelled) return;
      setRevealMissing(found === true ? null : pendingReveal.id);
      onRevealHandled?.();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeTabId, browserState.tabs, onRevealHandled, pendingReveal, selectTab, threadRef]);

  // The notice clears itself: it answers a question the user just asked and
  // has no meaning a moment later.
  useEffect(() => {
    if (revealMissing === null) {
      return;
    }
    const timer = setTimeout(() => setRevealMissing(null), 4000);
    return () => clearTimeout(timer);
  }, [revealMissing]);

  /**
   * Closing the last tab closes the panel rather than leaving a blank one.
   * Clicking close and being handed a fresh tab reads as nothing having
   * happened, and reopening the panel provides one anyway.
   */
  const closeBrowserTab = useCallback(
    (tabId: string) => {
      if (browserState.tabs.length <= 1) {
        onClose();
        return;
      }
      closeTab(threadRef, tabId);
    },
    [browserState.tabs.length, closeTab, onClose, threadRef],
  );

  /**
   * Straight into the composer rather than onto the clipboard.
   *
   * It used to write the data URL to the clipboard as text, which looked like
   * nothing happening and pasted a wall of base64. A screenshot is evidence for
   * the message being written, and everything else picked from the page already
   * attaches itself -- making this one a copy-then-paste errand would be the
   * odd one out.
   */
  const captureScreenshot = useCallback(() => {
    const webview = webviewsRef.current.get(activeTabId);
    if (webview === undefined || !isElectron) {
      return;
    }
    void window.desktopBridge
      ?.previewScreenshot?.({ webContentsId: webview.getWebContentsId() })
      .then((shot) => {
        // A payload-less data URL is still a non-empty string, so the emptiness
        // check has to look past the header.
        if (shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1) === "") {
          return;
        }
        onScreenshot?.({ dataUrl: shot.dataUrl, name: `${screenshotName()}.png` });
      });
  }, [activeTabId, onScreenshot, screenshotName]);

  return (
    <section
      className="@container/browser flex min-w-0 flex-col border-l border-border bg-rail"
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
            closable
            onSelect={() => selectTab(threadRef, tab.id)}
            onClose={() => closeBrowserTab(tab.id)}
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

        {/* Panel-level controls only: where the browser sits and whether it is
            open. What acts on the page lives with the address it acts on. */}
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
          <NavButton label="Close browser" onClick={onClose}>
            <XIcon className="size-3.5" />
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

        <form className="relative min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            aria-label="Address"
            data-testid="browser-panel-address"
            className="w-full truncate rounded-md border border-border bg-background py-1 ps-2 pe-7 font-mono text-[11px] text-muted-foreground outline-none focus:border-ring focus:text-foreground"
            placeholder="Search or enter URL"
            value={addressDraft}
            onChange={(event) => setAddressDraft(event.target.value)}
          />
          {/* Inside the field, where it reads as "this address, elsewhere"
              rather than as another page control. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Open in default browser"
                  data-testid="browser-open-external"
                  disabled={activeUrl === null}
                  className="absolute inset-y-0 end-1 my-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => {
                    if (activeUrl !== null) {
                      void window.desktopBridge?.openExternal?.(activeUrl);
                    }
                  }}
                />
              }
            >
              <ExternalLinkIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open in default browser</TooltipPopup>
          </Tooltip>
        </form>

        {/* Beside the address they act on, which is also where both reference
            browsers put them. */}
        <PageToolControl
          armed={armedTool}
          selected={selectedTool}
          onArm={(tool) => void armTool(tool)}
          onSelect={(tool) => {
            setSelectedTool(tool);
            void armTool(tool, { toggle: false });
          }}
        />
        <NavButton
          label="Capture screenshot"
          onClick={captureScreenshot}
          testId="browser-screenshot"
        >
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
              onClick={() => {
                const webview = webviewsRef.current.get(activeTabId);
                callWhenReady(() => webview?.reloadIgnoringCache());
              }}
            >
              Hard reload
            </MenuItem>
            <MenuItem data-testid="browser-toggle-device-bar" onClick={toggleDeviceToolbar}>
              {deviceToolbarOpen ? "Hide device toolbar" : "Show device toolbar"}
            </MenuItem>
            <MenuSeparator />
            <MenuRadioGroup
              value={appearance}
              onValueChange={(value) => setAppearance(value as BrowserAppearance)}
            >
              {/* The label belongs to the group: Base UI reads its context, and
                  outside one it throws and takes the whole menu with it. */}
              <MenuGroupLabel>Appearance</MenuGroupLabel>
              {(["system", "light", "dark"] as const).map((value) => (
                <MenuRadioItem key={value} value={value} closeOnClick>
                  {value === "system" ? "Follow app" : value === "light" ? "Light" : "Dark"}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
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
              data-testid="browser-clear-cache"
              onClick={() => {
                void window.desktopBridge?.previewClearCache?.().then(() => {
                  callWhenReady(() => webviewsRef.current.get(activeTabId)?.reloadIgnoringCache());
                });
              }}
            >
              Clear cache
            </MenuItem>
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
      </div>

      {deviceToolbarOpen && activeTab !== null ? (
        <DeviceToolbar
          viewport={activeTab.viewport}
          zoomFactor={activeTab.zoomFactor}
          onViewportChange={(viewport) => setTabViewport(threadRef, activeTab.id, viewport)}
          onZoomChange={(factor) => setTabZoom(threadRef, activeTab.id, factor)}
          onClose={toggleDeviceToolbar}
        />
      ) : null}

      {revealMissing === null ? null : (
        <div
          className="shrink-0 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="browser-reveal-missing"
        >
          That element is not on this page any more.
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background" ref={viewportAreaRef}>
        {!isElectron ? (
          <BrowserUnavailableNotice />
        ) : (
          <>
            {activeTab !== null && activeTab.url === null ? (
              <div className="absolute inset-0 z-10 overflow-auto bg-background px-3">
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
                viewport={tab.viewport}
                zoomFactor={tab.zoomFactor}
                colorScheme={guestColorScheme}
                onResize={
                  tab.id === activeTabId
                    ? (next) => setTabViewport(threadRef, tab.id, next)
                    : undefined
                }
                onNavState={setNavState}
                agentPoint={agentPoint}
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
  viewport,
  zoomFactor,
  colorScheme,
  onResize,
  onNavState,
  register,
  agentPoint,
}: {
  tab: BrowserTab;
  threadRef: ScopedThreadRef;
  isActive: boolean;
  viewport: BrowserViewport;
  zoomFactor: number;
  colorScheme: "light" | "dark";
  onResize?: ((viewport: BrowserViewport) => void) | undefined;
  onNavState: (state: NavState) => void;
  register: (element: PreviewWebview | null) => void;
  /** The agent's last touch, drawn over this tab when it is the visible one. */
  agentPoint: AgentPointerPosition | null;
}) {
  const elementRef = useRef<PreviewWebview | null>(null);
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabTitle = useBrowserPanelStore((store) => store.setTabTitle);
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
        onNavState({
          canGoBack: callWhenReady(() => webview.canGoBack()) ?? false,
          canGoForward: callWhenReady(() => webview.canGoForward()) ?? false,
          loading,
        });
      }
    };
    const onNavigated = () => {
      // Electron remembers zoom per origin inside the session, so a page
      // visited at 125% comes back at 125% while our control still reads
      // 100%. Reasserting on every navigation keeps the two from drifting.
      callWhenReady(() => webview.setZoomFactor(zoomFactorRef.current));
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
      className={cn("absolute inset-0 overflow-hidden", isActive ? "visible" : "invisible")}
      data-testid={`browser-frame-${tab.id}`}
      data-fit-scale={layout.scale}
    >
      <div
        className="relative"
        style={{ width: `${layout.canvasWidth}px`, height: `${layout.canvasHeight}px` }}
      >
        <webview
          ref={(element) => {
            elementRef.current = element as PreviewWebview | null;
            register(element as PreviewWebview | null);
          }}
          {...(isActive ? { "data-testid": "browser-panel-webview" } : {})}
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
          partition={PREVIEW_PARTITION}
          {...(tab.url ? { src: tab.url } : {})}
        />
        {isActive ? (
          // Positioned in the same frame as the guest, so a page pixel and a
          // panel pixel mean the same thing to it.
          <div
            className="pointer-events-none absolute"
            style={{ left: `${layout.x}px`, top: `${layout.y}px` }}
          >
            <AgentPointer position={agentPoint} scale={layout.scale} />
          </div>
        ) : null}
        {!layout.fills && isActive && onResize !== undefined ? (
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
      {dragging ? <div className="fixed inset-0 z-40 cursor-inherit" /> : null}
      <div
        role="separator"
        aria-label={`Resize ${edge === "corner" ? "viewport" : edge + " edge"}`}
        data-testid={`browser-resize-${edge}`}
        className={cn("absolute z-50 flex items-center justify-center", position)}
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

/**
 * The four ways of pointing at the page, behind one control.
 *
 * Four buttons in a row read as four unrelated things and crowd the address
 * out of a panel that is often narrow. They are one gesture aimed differently,
 * so they get one slot: the tool you last chose, and a caret to change it.
 * Choosing from the menu arms it too -- reaching for a tool is the same act as
 * picking it up.
 */
// One word each. The menu is a list of four things that differ only in what
// they point at, and a sentence apiece made the card wider than the panel it
// hangs off without saying more than the icon already does.
const PAGE_TOOLS = [
  { tool: "element", label: "Annotate", Icon: MousePointerClickIcon },
  { tool: "region", label: "Region", Icon: SquareDashedMousePointerIcon },
  { tool: "draw", label: "Draw", Icon: PencilIcon },
  { tool: "erase", label: "Erase", Icon: EraserIcon },
] as const satisfies ReadonlyArray<{ tool: PageTool; label: string; Icon: typeof PencilIcon }>;

type PageTool = DesktopPreviewPickMode | DesktopPreviewAnnotationMode;

/** Ink is armed and cleared differently from a pick, and survives the swap. */
function isInkTool(tool: PageTool | null): tool is DesktopPreviewAnnotationMode {
  return tool === "draw" || tool === "erase";
}

function PageToolControl({
  armed,
  selected,
  onArm,
  onSelect,
}: {
  armed: PageTool | null;
  selected: PageTool;
  onArm: (tool: PageTool) => void;
  onSelect: (tool: PageTool) => void;
}) {
  // The armed tool wins over the selected one: while something is live the
  // control has to show what the pointer is actually doing.
  const shown = PAGE_TOOLS.find((entry) => entry.tool === (armed ?? selected)) ?? PAGE_TOOLS[0];
  const isArmed = armed !== null;
  const label = isArmed ? (isInkTool(armed) ? "Clear drawing" : "Cancel") : shown.label;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border",
        isArmed ? "border-transparent bg-accent text-foreground" : "border-border",
      )}
      data-testid="browser-page-tool"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              data-testid="browser-page-tool-arm"
              onClick={() => onArm(shown.tool)}
              className={cn(
                "inline-flex size-6 items-center justify-center rounded-l-md hover:bg-accent hover:text-foreground",
                isArmed ? "text-foreground" : "text-muted-foreground/70",
              )}
            />
          }
        >
          <shown.Icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <span className={cn("h-3.5 w-px", isArmed ? "bg-border/60" : "bg-border")} />
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Choose a page tool"
              data-testid="browser-page-tool-menu"
              className={cn(
                "inline-flex h-6 w-4 items-center justify-center rounded-r-md hover:bg-accent hover:text-foreground",
                isArmed ? "text-foreground" : "text-muted-foreground/70",
              )}
            />
          }
        >
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup value={selected} onValueChange={(value) => onSelect(value as PageTool)}>
            {PAGE_TOOLS.map((entry) => (
              <MenuRadioItem
                key={entry.tool}
                value={entry.tool}
                data-testid={`browser-page-tool-${entry.tool}`}
              >
                {/* Flexed because the reset makes an svg a block, which would
                    otherwise drop the label onto its own line. */}
                <span className="flex items-center gap-2">
                  <entry.Icon className="size-3.5 text-muted-foreground/70" />
                  {entry.label}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </span>
  );
}

function NavButton({
  label,
  disabled,
  active,
  onClick,
  testId,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...(testId === undefined ? {} : { "data-testid": testId })}
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
      <div className="mb-2 flex items-center gap-2 px-2 text-muted-foreground">
        <RadioTowerIcon className="size-4" />
        <span className="text-sm">Local servers</span>
      </div>
      {servers.length === 0 ? (
        <p className="px-2 py-6 text-xs text-muted-foreground/70">
          {scanned ? "Nothing is listening right now." : "Looking for local servers…"}
        </p>
      ) : (
        <div className="flex flex-col border-t border-border/60">
          {servers.map((server) => (
            <button
              key={server.port}
              type="button"
              data-testid={`local-server-${server.port}`}
              className="flex items-center gap-3 rounded-md border-b border-border/60 px-2 py-2.5 text-left hover:bg-accent"
              onClick={() => onSelect(server.port)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {server.title ??
                    (server.processName === "" ? "Unknown server" : server.processName)}
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
      <p className="px-2 pt-3 text-xs text-muted-foreground/60">
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

/**
 * Size and zoom for the page under test.
 *
 * Hidden until asked for, because sizing is an occasional task and a permanent
 * control costs toolbar width on every page you ever look at. Width and height
 * are editable rather than a fixed menu of devices: the presets fill them in,
 * and any other size is reachable by typing it.
 */
function DeviceToolbar({
  viewport,
  zoomFactor,
  onViewportChange,
  onZoomChange,
  onClose,
}: {
  viewport: BrowserViewport;
  zoomFactor: number;
  onViewportChange: (viewport: BrowserViewport) => void;
  onZoomChange: (factor: number) => void;
  onClose: () => void;
}) {
  // "Responsive" is the label for a size nobody named, which is what dragging
  // produces; a matching preset takes precedence over it.
  const matchingPreset = BROWSER_VIEWPORT_PRESETS.find(
    (entry) =>
      entry.width !== null && entry.width === viewport.width && entry.height === viewport.height,
  );

  return (
    <div
      className="flex h-9 shrink-0 items-center justify-center gap-1.5 overflow-x-auto border-b border-border px-2"
      data-testid="browser-device-toolbar"
    >
      <select
        aria-label="Device"
        data-testid="browser-device-preset"
        className="min-w-0 max-w-28 shrink rounded-md border border-border bg-background px-1 py-1 text-[11px] text-muted-foreground outline-none focus:border-ring"
        value={matchingPreset?.label ?? "Responsive"}
        onChange={(event) => {
          const preset = BROWSER_VIEWPORT_PRESETS.find((p) => p.label === event.target.value);
          onViewportChange(
            preset === undefined ? viewport : { width: preset.width, height: preset.height },
          );
        }}
      >
        {BROWSER_VIEWPORT_PRESETS.map((preset) => (
          <option key={preset.label} value={preset.label}>
            {preset.label}
          </option>
        ))}
      </select>

      <DimensionInput
        label="Width"
        value={viewport.width}
        onCommit={(width) =>
          onViewportChange(
            width === null ? RESPONSIVE_VIEWPORT : { width, height: viewport.height ?? 800 },
          )
        }
      />
      <span className="text-muted-foreground/50">×</span>
      <DimensionInput
        label="Height"
        value={viewport.height}
        onCommit={(height) =>
          onViewportChange(
            height === null ? RESPONSIVE_VIEWPORT : { width: viewport.width ?? 1280, height },
          )
        }
      />

      <button
        type="button"
        aria-label="Rotate"
        data-testid="browser-device-rotate"
        disabled={viewport.width === null}
        className="hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 @xs/browser:inline-flex"
        onClick={() => onViewportChange({ width: viewport.height, height: viewport.width })}
      >
        <RotateDeviceIcon className="size-3.5" />
      </button>

      <div className="hidden shrink-0 items-center gap-1 @sm/browser:flex">
        <button
          type="button"
          aria-label="Zoom out"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          onClick={() => onZoomChange(steppedZoom(zoomFactor, -1))}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          data-testid="browser-zoom-value"
          className="min-w-9 shrink-0 rounded-md px-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onZoomChange(1)}
        >
          {Math.round(zoomFactor * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          onClick={() => onZoomChange(steppedZoom(zoomFactor, 1))}
        >
          +
        </button>
      </div>

      <button
        type="button"
        aria-label="Hide device toolbar"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** Empty means "let it fill", which is how you get back to responsive by typing. */
function DimensionInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onCommit(null);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    onCommit(Number.isNaN(parsed) || parsed < 1 ? value : Math.min(parsed, 9999));
  };

  return (
    <input
      aria-label={label}
      data-testid={`browser-device-${label.toLowerCase()}`}
      inputMode="numeric"
      className="w-12 shrink-0 rounded-md border border-border bg-background px-1 py-1 text-center font-mono text-[11px] text-muted-foreground outline-none focus:border-ring focus:text-foreground"
      placeholder="auto"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
      }}
    />
  );
}
