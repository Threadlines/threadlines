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
  ProjectId,
  ScopedThreadRef,
} from "@threadlines/contracts";
import { PREVIEW_PARTITION } from "@threadlines/shared/preview";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  CheckIcon,
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
  callWhenReady,
  getPreviewWebview,
  registerPreviewWebview,
  selectActiveTab,
  selectPendingBrowserApproval,
  selectThreadAgentState,
  selectThreadBrowserOwnership,
  selectThreadBrowserState,
  steppedZoom,
  useBrowserPanelStore,
  type BrowserAppearance,
  type BrowserTab,
  type BrowserViewport,
} from "../../browserPanelStore";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { copyTextToClipboard } from "../../lib/clipboard";
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
import { MINI_HORIZONTAL_SCROLLBAR_CLASS, ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RotateDeviceIcon } from "../Icons";
import { pushNavigationPolicy, useBrowserApprovals } from "./browserApprovals";
import { resolveBrowserViewportLayout } from "./browserViewportLayout";
import { AgentPointer, POINTER_RETIRE_MS, type AgentPointerPosition } from "./AgentPointer";
import { completeUrl } from "./urlCompletion";
import { type AgentActivity } from "./previewAutomationHost";
import { hostOf, normalizePreviewUrl } from "./previewUrl";

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
  projectId = null,
  flexGrow,
  onClose,
  onPickElement,
  onScreenshot,
  onDrawing,
  pendingReveal,
  onRevealHandled,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's project, for approvals while the thread is still a local draft. */
  projectId?: ProjectId | null;
  /** Complement of the chat column's share, so the two honour one ratio. */
  flexGrow: number;
  onClose: () => void;
  /** Hands a picked element to the composer as context for the next message. */
  onPickElement?: ((element: DesktopPreviewPickedElement) => void) | undefined;
  /** Attaches a captured screenshot to the message being written. Returns
   *  whether it actually attached, so the panel confirms only what happened. */
  onScreenshot?: ((input: { dataUrl: string; name: string }) => boolean) | undefined;
  /** Attaches a drawing made on the page: one chip carrying its picture. */
  onDrawing?: ((context: DrawingContext) => void) | undefined;
  /** An element to show again, requested from a composer chip. */
  pendingReveal?: PickedElementContextDraft | null | undefined;
  onRevealHandled?: (() => void) | undefined;
}) {
  const browserState = useBrowserPanelStore((store) =>
    selectThreadBrowserState(store.browserStateByThreadKey, threadRef),
  );
  const browserOwnership = useBrowserPanelStore((store) =>
    selectThreadBrowserOwnership(store.browserOwnershipByThreadKey, threadRef),
  );
  const setTabUrl = useBrowserPanelStore((store) => store.setTabUrl);
  const setTabViewport = useBrowserPanelStore((store) => store.setTabViewport);
  const openTab = useBrowserPanelStore((store) => store.openTab);
  const closeTab = useBrowserPanelStore((store) => store.closeTab);
  const selectTab = useBrowserPanelStore((store) => store.selectTab);
  const markBrowserUserControlled = useBrowserPanelStore(
    (store) => store.markBrowserUserControlled,
  );
  const expanded = useBrowserPanelStore((store) => store.expanded);
  const toggleExpanded = useBrowserPanelStore((store) => store.toggleExpanded);
  const deviceToolbarOpen = useBrowserPanelStore((store) => store.deviceToolbarOpen);
  const toggleDeviceToolbar = useBrowserPanelStore((store) => store.toggleDeviceToolbar);
  const appearance = useBrowserPanelStore((store) => store.appearance);
  const setAppearance = useBrowserPanelStore((store) => store.setAppearance);
  const setTabZoom = useBrowserPanelStore((store) => store.setTabZoom);
  const pendingApproval = useBrowserPanelStore((store) =>
    selectPendingBrowserApproval(store.pendingApprovalByThreadKey, threadRef),
  );
  const setPendingBrowserApproval = useBrowserPanelStore(
    (store) => store.setPendingBrowserApproval,
  );
  const { approveHost } = useBrowserApprovals(threadRef, projectId);
  const { resolvedTheme } = useTheme();
  const guestColorScheme = appearance === "system" ? resolvedTheme : appearance;

  const activeTab = selectActiveTab(browserState);
  const activeTabId = activeTab?.id ?? "";

  // One element per tab, so switching tabs keeps every page alive -- along with
  // the CDP attachment collecting its console and network diagnostics. The
  // elements live in the store: the automation host outlives this panel and
  // needs to reach them when it is closed.
  const webviewFor = useCallback(
    (tabId: string) => getPreviewWebview(threadRef, tabId) as PreviewWebview | null,
    [threadRef],
  );
  const [navState, setNavState] = useState<NavState>(IDLE_NAV_STATE);
  const [addressDraft, setAddressDraft] = useState(activeTab?.url ?? "");
  const visitedUrls = useBrowserPanelStore((store) => store.visitedUrls);
  const activeUrl = activeTab?.url ?? null;

  // The address bar is an input the user types in, so it is only reset when the
  // page moves or the tab changes -- never on every keystroke.
  useEffect(() => {
    setAddressDraft(activeUrl ?? "");
    setNavState(IDLE_NAV_STATE);
  }, [activeUrl, activeTabId]);

  // The agent's last touch on the page, shown over the webview so it is
  // visible working rather than silently changing things. Produced by the
  // automation mount, which runs whether or not this panel is here.
  const agentState = useBrowserPanelStore((store) =>
    selectThreadAgentState(store.agentStateByThreadKey, threadRef),
  );
  const setAgentPoint = useBrowserPanelStore((store) => store.setAgentPoint);
  const setAgentTab = useBrowserPanelStore((store) => store.setAgentTab);
  const setAgentActivity = useBrowserPanelStore((store) => store.setAgentActivity);
  const agentPoint = agentState.point as AgentPointerPosition | null;
  const agentTabId = agentState.tabId;
  const agentActivity = agentState.activity as AgentActivity | null;

  const activeWebview = () => webviewFor(activeTabId) ?? null;

  // Host rather than hostname: on a dev box every page is localhost and the
  // port is the only thing telling two captures apart.
  const screenshotName = useCallback(() => {
    try {
      return new URL(activeUrl ?? "").host.replace(":", "-") || "page";
    } catch {
      return "page";
    }
  }, [activeUrl]);

  /*
   * The agent keeps its tab. Opening a tab, or switching to one, is yours to do
   * and does not move it.
   *
   * This was briefly the opposite -- an idle agent handed its tab over to
   * whichever one you were looking at -- and that was wrong twice over. "Idle"
   * was measured per operation rather than per turn, so opening a tab in the
   * gap between two of the agent's own actions stole the page mid-task. And it
   * was solving a problem that no longer exists: the agent could not see other
   * tabs when I wrote it, so following you was the only way it could ever end
   * up somewhere useful. It can see them now, and move itself, and say so when
   * it does.
   *
   * Which leaves the arrangement people expect from tabs. Yours are yours to
   * browse; its tab is marked in the strip and one click away from the activity
   * line, and it goes only where it decides to go.
   */

  useEffect(() => {
    // The agent's tab has been closed. Letting go here is what makes its next
    // action pick up the tab the user is actually looking at.
    if (agentTabId !== null && !browserState.tabs.some((tab) => tab.id === agentTabId)) {
      setAgentTab(threadRef, null);
      setAgentActivity(threadRef, null);
      setAgentPoint(threadRef, null);
    }
  }, [agentTabId, browserState.tabs, setAgentActivity, setAgentPoint, setAgentTab, threadRef]);

  /** Set while the mark is fading out, after the page it referred to has gone. */
  const [agentPointRetiring, setAgentPointRetiring] = useState(false);
  const agentPointRef = useRef<AgentPointerPosition | null>(null);
  agentPointRef.current = agentPoint;

  useEffect(() => {
    // The mark is in viewport coordinates, so it stops meaning anything the
    // moment the page under it changes: resting somewhere stale would point
    // confidently at whatever now occupies that spot.
    //
    // It fades rather than blinking out, though. Clicking a link is the most
    // common way to navigate, so cutting the mark on the same frame as the
    // click means the one action you most want confirmed is the one that
    // leaves nothing behind. Fading says "that happened, and then the page
    // changed", which is what did happen.
    if (agentPointRef.current === null) {
      return;
    }
    setAgentPointRetiring(true);
    const timer = window.setTimeout(() => {
      setAgentPoint(threadRef, null);
      setAgentPointRetiring(false);
    }, POINTER_RETIRE_MS);
    return () => window.clearTimeout(timer);
  }, [activeUrl, setAgentPoint, threadRef]);

  const viewportAreaRef = useRef<HTMLDivElement | null>(null);

  const addressRef = useRef<HTMLInputElement | null>(null);
  const deletingRef = useRef(false);

  const completeAddress = useCallback(
    (typed: string) => {
      setAddressDraft(typed);
      if (deletingRef.current) {
        return;
      }
      const completion = completeUrl(typed, visitedUrls);
      if (completion === null) {
        return;
      }
      // The completion goes in the field with the part you did not type
      // selected, so carrying on typing overwrites it and Enter accepts it.
      // This is what every address bar does, and the reason it never feels
      // like the field is arguing with you.
      setAddressDraft(completion);
      requestAnimationFrame(() => {
        addressRef.current?.setSelectionRange(typed.length, completion.length);
      });
    },
    [visitedUrls],
  );

  /**
   * Going somewhere yourself is approval.
   *
   * Typing an address, or picking a local server, is the user saying where the
   * browser should be -- so the site is recorded for the project without a
   * prompt. Being asked to approve the page you just asked for would read as
   * the app not listening.
   */
  const openAddress = useCallback(
    (tabId: string, url: string) => {
      const approved = approveHost(hostOf(url));
      setTabUrl(threadRef, tabId, url);
      const webview = webviewFor(tabId);
      // Armed before the page loads rather than on the next render: a site that
      // redirects on arrival would otherwise be judged against the allowlist as
      // it stood a moment before the user approved it.
      const webContentsId =
        webview === null ? null : callWhenReady(() => webview.getWebContentsId());
      if (webContentsId !== null) {
        pushNavigationPolicy(webContentsId, approved);
      }
      // Swallowed rather than surfaced: a page that redirects on arrival
      // aborts the load it interrupts, and a load the navigation guard refuses
      // already asks its question through the approval bar. Left unhandled,
      // either one dumps a GUEST_VIEW_MANAGER_CALL rejection on the console.
      callWhenReady(() => void webview?.loadURL(url).catch(() => {}));
    },
    [approveHost, setTabUrl, threadRef, webviewFor],
  );

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const normalized = normalizePreviewUrl(addressDraft);
      if (normalized === null || activeTabId === "") {
        return;
      }
      openAddress(activeTabId, normalized);
    },
    [activeTabId, addressDraft, openAddress],
  );

  /**
   * Allowing the site and going there are one act.
   *
   * An agent's request loads into the agent's own tab rather than whichever
   * one is in front, so the next thing the agent looks at is the page it asked
   * for instead of an approval it has no way to notice. A page's blocked
   * navigation resumes in the tab it happened in -- the user may have been
   * browsing that tab themselves, and their page landing in the agent's tab
   * would be the very mix-up this bar exists to avoid.
   */
  const allowPendingApproval = useCallback(() => {
    if (pendingApproval === null) {
      return;
    }
    setPendingBrowserApproval(threadRef, null);
    const blockedTabId =
      pendingApproval.tabId !== null &&
      browserState.tabs.some((tab) => tab.id === pendingApproval.tabId)
        ? pendingApproval.tabId
        : null;
    const targetTabId =
      blockedTabId ??
      (agentTabId !== null && browserState.tabs.some((tab) => tab.id === agentTabId)
        ? agentTabId
        : activeTabId);
    if (targetTabId === "") {
      approveHost(pendingApproval.host);
      return;
    }
    openAddress(targetTabId, pendingApproval.url);
  }, [
    activeTabId,
    agentTabId,
    approveHost,
    browserState.tabs,
    openAddress,
    pendingApproval,
    setPendingBrowserApproval,
    threadRef,
  ]);

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
      const webview = webviewFor(activeTabId);
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
      const webview = webviewFor(targetId);
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
   * Closing the last tab closes the panel rather than leaving a blank one:
   * clicking close and being handed a fresh tab reads as nothing having
   * happened. The tab is still closed in the store -- which replaces a last
   * tab with a blank one -- because tab state persists per thread, and a page
   * that was closed must not come back the next time the panel opens.
   */
  const closeBrowserTab = useCallback(
    (tabId: string) => {
      closeTab(threadRef, tabId);
      if (browserState.tabs.length <= 1) {
        onClose();
      }
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
  /** The camera button briefly becomes a check after a capture attaches.
   *  Deliberately the whole confirmation: a flash over the page read as an
   *  event, and a screenshot landing where you sent it only needs a nod. */
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const captureConfirmTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (captureConfirmTimerRef.current !== null) {
        window.clearTimeout(captureConfirmTimerRef.current);
      }
    };
  }, []);

  const confirmCapture = useCallback(() => {
    setCaptureConfirmed(true);
    if (captureConfirmTimerRef.current !== null) {
      window.clearTimeout(captureConfirmTimerRef.current);
    }
    captureConfirmTimerRef.current = window.setTimeout(() => setCaptureConfirmed(false), 1400);
  }, []);

  /**
   * Where the new-tab button sits: after the last tab while there is room --
   * next to what it acts on, and away from the close-panel control it is not
   * -- docking at the strip's right edge once the tabs overflow, where it
   * would otherwise scroll away with them. The comparison uses a constant for
   * the button's own slot and normalises the viewport to its undocked width,
   * because docking changes both real widths and measuring them would feed
   * the answer back into the question.
   */
  const [newTabDocked, setNewTabDocked] = useState(false);
  const newTabDockedRef = useRef(false);
  const tabsRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const tabsRow = tabsRowRef.current;
    const viewport = tabsRow?.closest('[data-slot="scroll-area-viewport"]') ?? null;
    if (tabsRow === null || viewport === null) {
      return;
    }
    const measure = () => {
      const available =
        viewport.clientWidth + (newTabDockedRef.current ? NEW_TAB_BUTTON_SLOT_PX : 0);
      const next = tabsRow.scrollWidth + NEW_TAB_BUTTON_SLOT_PX > available;
      newTabDockedRef.current = next;
      setNewTabDocked(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(tabsRow);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const captureScreenshot = useCallback(() => {
    const webview = webviewFor(activeTabId);
    if (webview === null || !isElectron) {
      return;
    }
    // Every way this can fail says so. This used to fall through silently on an
    // empty capture or a rejected IPC call, which looked exactly like success
    // until the composer turned out to be missing the image.
    const captureFailed = () => {
      toastManager.add({
        type: "error",
        title: "Screenshot capture failed.",
        description: "The page did not produce an image. Try again.",
      });
    };
    void window.desktopBridge
      ?.previewScreenshot?.({ webContentsId: webview.getWebContentsId() })
      .then((shot) => {
        // A payload-less data URL is still a non-empty string, so the emptiness
        // check has to look past the header.
        if (shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1) === "") {
          captureFailed();
          return;
        }
        const attached =
          onScreenshot?.({ dataUrl: shot.dataUrl, name: `${screenshotName()}.png` }) ?? false;
        // When the composer declines the image it explains itself (its own
        // toast or thread error), so the panel only confirms, never doubles up.
        if (attached) {
          confirmCapture();
        }
      })
      .catch(captureFailed);
  }, [activeTabId, confirmCapture, onScreenshot, screenshotName]);

  return (
    <section
      className="@container/browser flex min-w-0 flex-col border-l border-border bg-rail"
      style={{ flex: `${flexGrow} 1 0%` }}
      data-testid="browser-panel"
      aria-label="Browser preview"
      onPointerDownCapture={() => markBrowserUserControlled(threadRef)}
      onKeyDownCapture={() => markBrowserUserControlled(threadRef)}
      onWheelCapture={() => markBrowserUserControlled(threadRef)}
    >
      <div className="flex h-9 shrink-0 items-stretch border-b border-border px-1.5 pt-1.5">
        {/* Tabs scroll; everything after this stays put. ScrollArea keeps the
            strip's height honest: edge mask-fades mark hidden tabs and the
            overlay scrollbar takes no layout height, where a native bar would
            eat into the row and force a vertical one too. */}
        <ScrollArea
          scrollFade
          observeContentResize
          contentClassName="h-full"
          horizontalWheelScroll
          className={cn("min-w-0 flex-1 self-stretch", MINI_HORIZONTAL_SCROLLBAR_CLASS)}
        >
          <div className="flex h-full items-stretch">
            <div ref={tabsRowRef} className="flex h-full items-stretch gap-px">
              {browserState.tabs.map((tab) => (
                <TabStripItem
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  closable
                  agentState={
                    browserOwnership.agentOwnerByTabId[tab.id] === undefined
                      ? "none"
                      : tab.id === agentTabId && agentActivity?.phase === "running"
                        ? "working"
                        : "pinned"
                  }
                  onSelect={() => selectTab(threadRef, tab.id)}
                  onClose={() => closeBrowserTab(tab.id)}
                />
              ))}
            </div>
            {newTabDocked ? null : <NewTabButton onClick={() => openTab(threadRef)} />}
          </div>
        </ScrollArea>
        {newTabDocked ? <NewTabButton onClick={() => openTab(threadRef)} /> : null}

        {/* Panel-level controls only: where the browser sits and whether it is
            open. What acts on the page lives with the address it acts on. */}
        <div className="flex shrink-0 items-center gap-0.5 self-center">
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
            ref={addressRef}
            value={addressDraft}
            onChange={(event) => completeAddress(event.target.value)}
            onKeyDown={(event) => {
              // Deleting is a correction. Completing over it would put the
              // guess straight back and make the key look broken.
              deletingRef.current = event.key === "Backspace" || event.key === "Delete";
            }}
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
          label={captureConfirmed ? "Screenshot attached" : "Capture screenshot"}
          onClick={captureScreenshot}
          testId="browser-screenshot"
        >
          {captureConfirmed ? (
            <CheckIcon
              className="size-3.5 text-primary-readable"
              data-testid="browser-screenshot-confirmed"
            />
          ) : (
            <CameraIcon className="size-3.5" />
          )}
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
                const webview = webviewFor(activeTabId);
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
                  void copyTextToClipboard(activeUrl).catch(() => {});
                }
              }}
            >
              Copy address
            </MenuItem>
            <MenuItem
              data-testid="browser-open-devtools"
              onClick={() => {
                const webview = webviewFor(activeTabId);
                const id =
                  webview === null ? null : callWhenReady(() => webview.getWebContentsId());
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
                  callWhenReady(() => webviewFor(activeTabId)?.reloadIgnoringCache());
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
                  callWhenReady(() => webviewFor(activeTabId)?.reload());
                });
              }}
            >
              Clear cookies and storage
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {/* One agent line, whichever it has to say: a pending question replaces
          the activity that raised it, since "went to X" describes the very
          navigation that was just refused. */}
      {pendingApproval !== null ? (
        <AgentApprovalLine
          host={pendingApproval.host}
          source={pendingApproval.source}
          fromHost={pendingApproval.fromHost}
          onAllow={allowPendingApproval}
          onDismiss={() => setPendingBrowserApproval(threadRef, null)}
        />
      ) : agentTabId !== null && agentActivity !== null ? (
        <AgentActivityLine
          activity={agentActivity}
          isOnAgentTab={agentTabId === activeTabId}
          onGoToAgentTab={() => selectTab(threadRef, agentTabId)}
        />
      ) : null}

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
                  onSelect={(port) => openAddress(activeTab.id, `http://localhost:${port}`)}
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
                agentPoint={tab.id === agentTabId ? agentPoint : null}
                agentPointRetiring={agentPointRetiring}
                register={(element) => {
                  registerPreviewWebview(threadRef, tab.id, element);
                }}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** The new-tab button's footprint in the strip: its size-6 box plus lead-in
 *  margin. A constant rather than a measurement, so the docking decision never
 *  depends on where the button currently is. */
const NEW_TAB_BUTTON_SLOT_PX = 26;

function NewTabButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="New tab"
      data-testid="browser-new-tab"
      className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
      onClick={onClick}
    >
      <PlusIcon className="size-3.5" />
    </button>
  );
}

function TabStripItem({
  tab,
  isActive,
  closable,
  agentState,
  onSelect,
  onClose,
}: {
  tab: BrowserTab;
  isActive: boolean;
  closable: boolean;
  /** Whether the agent is working in this tab, and whether right now. */
  agentState: "none" | "pinned" | "working";
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = tab.title ?? (tab.url === null ? "New tab" : tab.url.replace(/^https?:\/\//, ""));
  // Tabs rehydrated from storage predating the field arrive without it.
  const faviconUrl = tab.faviconUrl ?? null;
  // A favicon that fails to load falls back to the globe rather than a broken
  // image. Keyed by URL so a later navigation gets to try again.
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const favicon = faviconUrl !== null && faviconUrl !== failedFaviconUrl ? faviconUrl : null;
  return (
    <div
      className={cn(
        "group/tab flex min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-t-md px-2 text-xs",
        // A hairline under the agent's tab, so it is findable at a glance
        // without competing with which tab is selected.
        agentState !== "none" && "border-b-2 border-primary-readable",
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
        {/* A dot rather than a badge: the tab still has to read as a tab, and
            this only needs to answer "is the agent in here". It pulses while a
            call is in flight and holds steady between them. */}
        {agentState === "none" ? (
          favicon !== null ? (
            <img
              src={favicon}
              alt=""
              aria-hidden
              className="size-3 shrink-0"
              onError={() => setFailedFaviconUrl(favicon)}
            />
          ) : (
            <GlobeIcon className="size-3 shrink-0 opacity-70" />
          )
        ) : (
          <span
            aria-label={agentState === "working" ? "Agent working here" : "The agent's tab"}
            data-testid={`browser-tab-agent-${tab.id}`}
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-primary-readable",
              agentState === "working" && "animate-pulse",
            )}
          />
        )}
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
  agentPointRetiring,
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
        onNavState({
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
  }, [onNavState, setTabFavicon, setTabTitle, setTabUrl, tab.id, threadRef]);

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
          src={initialSrc}
        />
        {isActive ? (
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
                variant="fill"
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

/**
 * The one question the browser ever asks you, in the agent's own line.
 *
 * An agent may reach any private address it likes -- your dev server is the
 * whole point of the panel -- but the open internet is somewhere you decide it
 * goes. The question wears the activity line's grammar ("Agent wants to visit"
 * beside "Agent went to") because it is the same narration, paused: an amber
 * dot instead of a second bar, and the two answers where "show" would sit.
 *
 * The subject is whoever actually navigated. Saying "Agent" for a page's own
 * redirect or link would accuse it of something the user did -- the exact
 * confusion between your browsing and the agent's this bar is meant to keep
 * straight.
 *
 * "for this project" is load-bearing: it says the click is remembered and says
 * how far it reaches, so allowing a docs site once does not quietly allow it
 * everywhere you work.
 */
export function AgentApprovalLine({
  host,
  source,
  fromHost,
  onAllow,
  onDismiss,
}: {
  host: string;
  source: "agent" | "page";
  fromHost: string | null;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  const subject = source === "agent" ? "Agent" : (fromHost ?? "This page");
  return (
    <div
      className="flex h-[22px] w-full shrink-0 items-center gap-1.5 border-b border-border px-2 font-mono text-[11px] text-muted-foreground"
      data-testid="browser-approval-bar"
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">{subject}</span> wants to visit {host}
      </span>
      <button
        type="button"
        data-testid="browser-approval-allow"
        className="ms-auto shrink-0 text-amber-600/70 hover:text-amber-600 dark:text-amber-400/70 dark:hover:text-amber-400"
        onClick={onAllow}
      >
        Allow for this project
      </button>
      <button
        type="button"
        data-testid="browser-approval-dismiss"
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={onDismiss}
      >
        Not now
      </button>
    </div>
  );
}

/**
 * What the agent is doing, in one line under the toolbar.
 *
 * The tab dot says where; this says what. Without it the only evidence an
 * agent is working is the page changing on its own, which reads the same as
 * the page being broken.
 *
 * Clicking it goes to the agent's tab, which is the whole follow affordance --
 * a mode that moved your selection for you would be the yanking this was built
 * to stop.
 */
export function AgentActivityLine({
  activity,
  isOnAgentTab,
  onGoToAgentTab,
}: {
  activity: AgentActivity;
  isOnAgentTab: boolean;
  onGoToAgentTab: () => void;
}) {
  const body = (
    <>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-primary-readable",
          activity.phase === "running" && "animate-pulse",
        )}
      />
      <span className="shrink-0 text-foreground">Agent</span>
      <span className="min-w-0 truncate">
        {activity.verb}
        {activity.detail === null ? "" : ` ${activity.detail}`}
      </span>
    </>
  );
  const className =
    "flex h-[22px] w-full shrink-0 items-center gap-1.5 border-b border-border px-2 font-mono text-[11px] text-muted-foreground";

  if (isOnAgentTab) {
    return (
      <div className={className} data-testid="agent-activity-line">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onGoToAgentTab}
      title="Go to the tab the agent is working in"
      data-testid="agent-activity-line"
      className={cn(className, "text-left hover:bg-accent hover:text-foreground")}
    >
      {body}
      <span className="ms-auto shrink-0 text-muted-foreground/60">show</span>
    </button>
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
  const matchingPreset = BROWSER_VIEWPORT_PRESETS.find(
    (entry) => entry.width === viewport.width && entry.height === viewport.height,
  );
  const selectedMode = matchingPreset?.label ?? "Custom";

  return (
    <div
      className="flex h-9 shrink-0 items-center justify-center gap-1.5 overflow-x-auto border-b border-border px-2"
      data-testid="browser-device-toolbar"
    >
      <select
        aria-label="Device"
        data-testid="browser-device-preset"
        className="min-w-0 max-w-28 shrink rounded-md border border-border bg-background px-1 py-1 text-[11px] text-muted-foreground outline-none focus:border-ring"
        value={selectedMode}
        onChange={(event) => {
          const preset = BROWSER_VIEWPORT_PRESETS.find((p) => p.label === event.target.value);
          if (preset !== undefined) {
            onViewportChange({ width: preset.width, height: preset.height });
          }
        }}
      >
        {matchingPreset === undefined ? (
          <option value="Custom" disabled>
            Custom
          </option>
        ) : null}
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
