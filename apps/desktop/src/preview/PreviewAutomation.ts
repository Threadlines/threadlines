/**
 * CDP control of preview tabs.
 *
 * Attaches Chrome DevTools Protocol to a preview <webview>'s WebContents. CDP
 * rather than `executeJavaScript` because it operates at the browser level
 * instead of inside the page's JavaScript sandbox: it is unaffected by
 * same-origin policy, and its input events are real ones, so hover, focus and
 * blur behave as they would for a person. Synthetic DOM events would not.
 *
 * Console and failed requests are collected here rather than on demand,
 * because by the time anyone asks, the interesting message has already been
 * printed. The buffers reset on navigation so they describe the current page.
 */

import type {
  DesktopPreviewAnnotationMode,
  DesktopPreviewDrawing,
  DesktopPreviewClickInput,
  DesktopPreviewDragInput,
  DesktopPreviewDragResult,
  DesktopPreviewPickedElement,
  DesktopPreviewPoint,
  DesktopPreviewPickMode,
  DesktopPreviewConsoleEntry,
  DesktopPreviewEvaluateInput,
  DesktopPreviewNetworkFailure,
  DesktopPreviewMoveInput,
  DesktopPreviewCertificateUntrusted,
  DesktopPreviewNavigationBlocked,
  DesktopPreviewUserControl,
  DesktopPreviewPressInput,
  DesktopPreviewScrollInput,
  DesktopPreviewSnapshot,
  DesktopPreviewScreenshot,
  DesktopPreviewScreenshotInput,
  DesktopPreviewStatus,
  DesktopPreviewTypeInput,
  DesktopPreviewLifecycleState,
  DesktopPreviewMemory,
  DesktopPreviewWaitForInput,
  PreviewAutomationTarget,
} from "@threadlines/contracts";
import {
  isBrowserCertificateTrusted,
  isBrowserHostAllowed,
  isPrivateNetworkHost,
  normalizePreviewWaitForTimeoutMs,
  PREVIEW_AGENT_KEYBOARD_HOLD_MS,
  PREVIEW_AGENT_KEYS_DEADLINE_MS,
  withBrowserApproval,
  type BrowserSiteAccess,
} from "@threadlines/shared/preview";
import {
  app,
  BrowserWindow,
  nativeImage,
  powerMonitor,
  session,
  webContents,
  type NativeImage,
  type Session,
  type WebContents,
} from "electron";

import { isAppWindow } from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import {
  AGENT_SCREENSHOT_BUDGET_BYTES,
  AGENT_SCREENSHOT_ENCODINGS,
  AGENT_SCREENSHOT_LEGACY_BUDGET_BYTES,
  AGENT_SCREENSHOT_MAX_EDGE,
  AGENT_SCREENSHOT_PNG_ENCODINGS,
  fitScreenshot,
} from "./screenshotFit.ts";
import { toCdpKeyDefinition, toCdpModifierBitmask } from "./keyEvents.ts";
import {
  buildAriaSnapshotScript,
  buildInjectedRuntimeScript,
  buildLocatorQueryScript,
  INJECTED_WORLD_NAME,
  injectedRuntimeReadyExpression,
} from "./injectedRuntime.ts";
import {
  type Affine,
  applyAffine,
  composeAffine,
  frameAffine,
  frameToParentAffine,
  IDENTITY_AFFINE,
} from "./frameAffine.ts";
import { isHostInjectedConsoleEntry } from "./previewConsoleNoise.ts";
import {
  buildDrawOverlayScript,
  DRAW_OVERLAY_BINDING,
  DRAW_OVERLAY_STASH,
  DRAW_OVERLAY_TEARDOWN_SCRIPT,
} from "./drawOverlayScript.ts";
import { buildRevealElementScript } from "./revealElementScript.ts";
import {
  buildPickOverlayScript,
  PICK_OVERLAY_BINDING,
  PICK_OVERLAY_STASH,
  PICK_OVERLAY_TEARDOWN_SCRIPT,
} from "./pickOverlayScript.ts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** Enough to explain a failure without letting a chatty page grow unboundedly. */
const MAX_CONSOLE_ENTRIES = 200;
/** Drag-and-drop and text selection depend on held movement between press and release. */
const DRAG_MOVE_STEPS = 10;

const MAX_NETWORK_FAILURES = 100;
/** See `sendCommand`: comfortably inside the broker's twenty second deadline. */
const CDP_COMMAND_TIMEOUT = "15 seconds";
const PAGE_DID_NOT_ANSWER = "the page did not answer in time";
/**
 * How long a capture may take while the screen is locked. A capture normally
 * answers in well under a second, and a locked Mac's waits until the user is
 * back, so this is only long enough to take a picture on a system that does
 * paint while locked, if there is one, or after a missed unlock notice.
 */
const LOCKED_CAPTURE_TIMEOUT = "3 seconds";
/** Said to the agent as the reason; it reads as "screenshot failed: ...". */
const SCREEN_LOCKED =
  "the screen is locked, so the page is not being painted and cannot be captured. browser_snapshot and browser_evaluate still work, and screenshots work again once the screen is unlocked";
/**
 * How long an agent's keys wait for the page to take focus. The renderer
 * focuses it straight after sending them, so this is normally one poll.
 */
const PAGE_FOCUS_WAIT_MS = 250;
const PAGE_FOCUS_POLL = "4 millis";
/**
 * An agent's script may wait on purpose (a promise that settles after an
 * animation, a fetch), so it gets nearly all of the broker's deadline.
 */
const AGENT_SCRIPT_TIMEOUT = "18 seconds";
/**
 * CDP sessions of their own for a page's frames that run in other processes
 * (another site's, or a sandboxed one), and for theirs in turn: agent input
 * goes straight into them (`routePoint`). Nothing is enabled in them.
 */
const FRAME_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }],
};
/** How deep `routePoint` and `snapshot` follow frames inside frames. */
const MAX_FRAME_DEPTH = 8;
/** A snapshot ref in a frame: `f2e7` is element 7 in frame 2. */
const FRAME_REF = /^f(\d+)e\d+$/;
/**
 * A frame's line in a snapshot: indent, the line up to its attributes' end, and
 * its ref. Fallback text an `<iframe>` carries (`: Loading…`) is dropped when
 * the frame's own content goes under it; a browser never shows that text.
 */
const SNAPSHOT_FRAME_LINE = /^(\s*)(- iframe\b[^\n]*?\[ref=([^\]\s]+)\][^:\n]*)(?::.*)?$/;
/** How many frames a snapshot reads, how long each may take, and how long they may take in all. */
const MAX_SNAPSHOT_FRAMES = 40;
const SNAPSHOT_FRAME_TIMEOUT = "2 seconds";
const SNAPSHOT_FRAMES_BUDGET_MS = 8_000;
/** Elements whose content is a frame of its own. */
const FRAME_OWNER_NODE_NAMES = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED", "FENCEDFRAME"]);
/** The world `frameViewportSize` reads in. */
const FRAME_METRICS_WORLD_NAME = "threadlines-frame-metrics";
/** How long one frame gets to answer `routePoint`, and how long it may take in all. */
const FRAME_ROUTE_TIMEOUT = "1 second";
const FRAME_ROUTE_BUDGET = "3 seconds";

/** The session agent input goes to (the page's when undefined) and the page→frame mapping. */
interface FrameRoute {
  readonly sessionId: string | undefined;
  readonly toFrame: Affine;
}

const pageRoute: FrameRoute = { sessionId: undefined, toFrame: IDENTITY_AFFINE };

export class PreviewTargetMissingError extends Schema.TaggedError<PreviewTargetMissingError>()(
  "PreviewTargetMissingError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `No live preview tab with webContents id ${this.webContentsId}.`;
  }
}

export class PreviewCommandError extends Schema.TaggedError<PreviewCommandError>()(
  "PreviewCommandError",
  { webContentsId: Schema.Number, method: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const detail =
      this.cause instanceof Error
        ? this.cause.message
        : typeof this.cause === "string"
          ? this.cause
          : String(this.cause);
    return `Preview command ${this.method} failed for webContents ${this.webContentsId}: ${detail}`;
  }
}

export type PreviewAutomationError = PreviewTargetMissingError | PreviewCommandError;

interface AttachedTab {
  contents: WebContents;
  console: DesktopPreviewConsoleEntry[];
  networkFailures: DesktopPreviewNetworkFailure[];
  /**
   * requestId -> url, because `Network.loadingFailed` reports only the id.
   * Without this a request that fails below HTTP -- DNS, connection refused,
   * blocked -- would be reported as an opaque id instead of an address.
   */
  requestUrls: Map<string, string>;
  controlEpoch: number;
  expectedAgentInputs: Array<{ kind: "mouseDown" | "mouseWheel"; expiresAt: number }>;
  /** Until when the user's keys are kept out of the page; see `agentKeys`. */
  holdUserKeysUntil: number;
  /** Frame id -> its own CDP session, for frames in other processes; see `routePoint`. */
  frameSessions: Map<string, string>;
  /**
   * For each such session, the frame it is for and that frame's element in
   * the session around it: how a point in the frame maps out to the page.
   */
  sessionOwners: Map<string, SessionOwner>;
  /**
   * The page's frames by the number their snapshot refs carry (`f2e7` is in
   * frame 2), as the last snapshot found them; see `frameNumberingOf` for how
   * numbers are given.
   */
  framesByOrdinal: Map<number, InjectedFrame>;
  dispose: () => void;
}

/**
 * A frame the element engine runs in: its id, the session that reaches it (the
 * page's when undefined), and the number its snapshot refs carry.
 */
interface InjectedFrame {
  readonly sessionId: string | undefined;
  readonly frameId: string;
  readonly ordinal: number;
}

interface SessionOwner {
  readonly frameId: string;
  readonly parentSessionId: string | undefined;
  readonly ownerBackendNodeId: number;
}

/** What one snapshot may still spend on frames: until when, and how many it has read. */
interface SnapshotBudget {
  readonly deadline: number;
  frames: number;
}

/** An element, and the session its node id belongs to (the page's when undefined). */
interface NodeRef {
  readonly backendNodeId: number;
  readonly sessionId: string | undefined;
}

/**
 * The sites one guest's own pages may navigate to.
 *
 * Deliberately not part of `AttachedTab`: that record comes and goes with the
 * CDP attachment -- opening DevTools on the page is enough to drop it -- and a
 * navigation guard that lapsed whenever the debugger did would be no guard at
 * all. This one lives as long as the guest does.
 */
interface NavigationGuard {
  access: BrowserSiteAccess;
}

export class PreviewAutomation extends Context.Service<
  PreviewAutomation,
  {
    readonly attach: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewStatus, PreviewAutomationError>;
    readonly detach: (webContentsId: number) => Effect.Effect<void>;
    /**
     * Replaces the sites this guest's own pages may navigate to. Until it is
     * called the guest is private-network-only, so an unpushed policy refuses
     * rather than allows.
     */
    readonly setNavigationPolicy: (
      webContentsId: number,
      access: BrowserSiteAccess,
    ) => Effect.Effect<void, PreviewAutomationError>;
    /**
     * Holds a page's sign-in pop-up to the page's own sites, live, so what the
     * project allows later reaches the pop-up too, and to web addresses only.
     * A refused navigation goes to `onRefused` rather than to the panel, which
     * cannot see the pop-up.
     */
    readonly guardPopup: (
      openerWebContentsId: number,
      popup: WebContents,
      onRefused: (url: string, host: string) => void,
    ) => Effect.Effect<void, PreviewAutomationError>;
    /**
     * Lets a page, and its pop-ups, go to a site now: the user allowed it from
     * a pop-up's question, and the renderer records the answer and pushes the
     * project's policy back only after a round trip.
     */
    readonly allowSite: (
      webContentsId: number,
      host: string,
      allowAll: boolean,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly status: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewStatus, PreviewAutomationError>;
    readonly evaluate: (
      input: DesktopPreviewEvaluateInput,
    ) => Effect.Effect<unknown, PreviewAutomationError>;
    readonly snapshot: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewSnapshot, PreviewAutomationError>;
    readonly openDevTools: (webContentsId: number) => Effect.Effect<void, PreviewAutomationError>;
    readonly setViewport: (
      webContentsId: number,
      size: { width: number | null; height: number | null },
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly pickElement: (
      webContentsId: number,
      colorScheme: "light" | "dark",
      mode: DesktopPreviewPickMode,
    ) => Effect.Effect<ReadonlyArray<DesktopPreviewPickedElement>, PreviewAutomationError>;
    readonly cancelPick: (webContentsId: number) => Effect.Effect<void, PreviewAutomationError>;
    readonly setAnnotationMode: (
      webContentsId: number,
      mode: DesktopPreviewAnnotationMode | null,
    ) => Effect.Effect<void, PreviewAutomationError>;
    /** Resolves when the user attaches a drawing, or empty if they discard it
     *  or the mode is turned off. */
    readonly awaitDrawing: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewDrawing | null, PreviewAutomationError>;
    readonly revealElement: (
      webContentsId: number,
      selector: string,
    ) => Effect.Effect<boolean, PreviewAutomationError>;
    readonly setColorScheme: (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) => Effect.Effect<void, PreviewAutomationError>;
    /**
     * Sets how a page runs; see `DesktopPreviewLifecycleInputSchema`. Changes
     * for one page apply in the order they were asked for, so a wake asked for
     * after a freeze always lands last; and every other command makes a page
     * active first, so nothing ever waits on a page that cannot answer.
     */
    readonly setLifecycle: (
      webContentsId: number,
      state: DesktopPreviewLifecycleState,
    ) => Effect.Effect<void, PreviewAutomationError>;
    /** Memory held by every browser page's process; see `DesktopPreviewMemorySchema`. */
    readonly memory: Effect.Effect<DesktopPreviewMemory>;
    readonly screenshot: (
      input: DesktopPreviewScreenshotInput,
    ) => Effect.Effect<DesktopPreviewScreenshot, PreviewAutomationError>;
    readonly click: (
      input: DesktopPreviewClickInput,
    ) => Effect.Effect<DesktopPreviewPoint, PreviewAutomationError>;
    readonly move: (
      input: DesktopPreviewMoveInput,
    ) => Effect.Effect<DesktopPreviewPoint, PreviewAutomationError>;
    readonly drag: (
      input: DesktopPreviewDragInput,
    ) => Effect.Effect<DesktopPreviewDragResult, PreviewAutomationError>;
    readonly type: (input: DesktopPreviewTypeInput) => Effect.Effect<void, PreviewAutomationError>;
    readonly press: (
      input: DesktopPreviewPressInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly scroll: (
      input: DesktopPreviewScrollInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly waitFor: (
      input: DesktopPreviewWaitForInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("@threadlines/desktop/preview/PreviewAutomation") {}

/** What the overlay reports: how many elements it left behind, and what the
 *  user said about them. */
interface PickResult {
  count: number;
  note: string | null;
  styleChanges: ReadonlyArray<{ property: string; from: string; to: string }>;
}

/**
 * A capture made fit for a model.
 *
 * At the page's CSS pixels rather than the display's -- half the width and a
 * quarter of the bytes on a Retina screen -- so a point in the picture is the
 * same point on the page, then encoded as the cheapest picture that fits (see
 * `fitScreenshot`). Resized here rather than by asking CDP for a scaled clip:
 * a clipped capture re-renders the page at the new scale, which the user sees
 * as the page flashing at half size.
 */
const encodeForAgent = (
  data: string,
  /**
   * The page's own `devicePixelRatio`: the display's scale times the page's
   * zoom. The capture is in device pixels and covers the whole page area,
   * scrollbars included, so this rather than the viewport's reported width
   * is what turns it back into CSS pixels without squeezing it.
   */
  devicePixelRatio: number,
  /** Whether the server can carry a JPEG; see `DesktopPreviewScreenshotInputSchema`. */
  jpeg: boolean,
): { readonly dataUrl: string; readonly scale?: number } => {
  const captured = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  if (captured.isEmpty() || !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    // Nothing to work with; passed on as it came, and the caller sees it empty.
    return { dataUrl: `data:image/png;base64,${data}` };
  }
  const capturedSize = captured.getSize();
  const width = capturedSize.width / devicePixelRatio;
  const height = capturedSize.height / devicePixelRatio;
  const toMaxEdge = Math.min(1, AGENT_SCREENSHOT_MAX_EDGE / Math.max(width, height));
  const sized = new Map<number, NativeImage>();
  const atScale = (scale: number) => {
    const existing = sized.get(scale);
    if (existing !== undefined) return existing;
    const target = {
      width: Math.max(1, Math.round(width * scale * toMaxEdge)),
      height: Math.max(1, Math.round(height * scale * toMaxEdge)),
    };
    const image =
      capturedSize.width === target.width && capturedSize.height === target.height
        ? captured
        : captured.resize({ ...target, quality: "good" });
    sized.set(scale, image);
    return image;
  };
  const fitted = fitScreenshot(
    (encoding) =>
      encoding.mimeType === "image/png"
        ? atScale(encoding.scale).toPNG()
        : atScale(encoding.scale).toJPEG(encoding.quality),
    // A server that cannot take a JPEG is older, and so is its result limit.
    jpeg ? AGENT_SCREENSHOT_BUDGET_BYTES : AGENT_SCREENSHOT_LEGACY_BUDGET_BYTES,
    jpeg ? AGENT_SCREENSHOT_ENCODINGS : AGENT_SCREENSHOT_PNG_ENCODINGS,
  );
  const scale = fitted.scale * toMaxEdge;
  return {
    dataUrl: `data:${fitted.mimeType};base64,${Buffer.from(fitted.bytes).toString("base64")}`,
    ...(scale === 1 ? {} : { scale }),
  };
};

export const make = Effect.sync(function PreviewAutomationMake() {
  const attached = new Map<number, AttachedTab>();
  /**
   * The pick a page is currently waiting on, if any.
   *
   * Only one can be armed at a time, so starting another -- or cancelling --
   * has to settle the previous one now. Left to time out on its own it would
   * eventually run its teardown, which by then would be tearing down the
   * overlay belonging to whatever replaced it.
   */
  const pendingPicks = new Map<number, { supersede: () => void }>();
  /** Whoever is waiting for a drawing to be attached, so turning the mode off
   *  can release them. */
  const drawWaiters = new Map<number, () => void>();
  const navigationGuards = new Map<number, NavigationGuard>();

  /**
   * Whether the screen is locked, from the system's own notices.
   *
   * Behind a locked screen the page is not painted, so a capture waits for a
   * frame that comes only once the user is back: every screenshot timeout
   * traced in the logs happened while the Mac was locked. Covered, minimised
   * and hidden windows are not the same -- tried on a real window, all three
   * captured a fresh picture in under a tenth of a second. `powerMonitor`
   * cannot be used before the app is ready, which is after this service is
   * built, hence the wait.
   */
  let screenLocked = false;
  // Asked of the system as well, at the moment of capture: the notices only
  // cover locks that began after the app was ready to hear them.
  const isScreenLocked = () => {
    if (screenLocked) return true;
    try {
      return powerMonitor.getSystemIdleState(1) === "locked";
    } catch {
      return false;
    }
  };
  void app.whenReady().then(() => {
    powerMonitor.on("lock-screen", () => {
      screenLocked = true;
    });
    powerMonitor.on("unlock-screen", () => {
      screenLocked = false;
    });
  });

  /**
   * The site a navigation is aimed at, or null when it is not aimed at one.
   *
   * Only http(s) has a host to approve. `about:`, `blob:` and `data:` name no
   * site, and Chromium already refuses the top-level navigations among them
   * that would matter -- refusing them here as "unapproved host" would instead
   * break `about:blank`, which is how every empty tab starts.
   */
  const navigationHost = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.hostname === "" ? null : parsed.hostname;
    } catch {
      return null;
    }
  };

  /**
   * Tells the renderer a page tried to go somewhere it may not.
   *
   * Sent to the window embedding the guest, because that is the renderer that
   * owns the tab and can put the question in front of the user. Every app
   * window is the fallback rather than silence: the notice is addressed by
   * webContents id, so a window that does not own this tab ignores it.
   */
  const reportBlockedNavigation = (contents: WebContents, url: string, blockedHost: string) => {
    const payload: DesktopPreviewNavigationBlocked = {
      webContentsId: contents.id,
      host: blockedHost,
      url,
      // Who was navigating. The agent's own navigations are refused in the
      // renderer before they start, so anything blocked here came from a page
      // -- a redirect or a link -- and the prompt should say which one.
      fromHost: navigationHost(contents.getURL()),
    };
    const embedder = contents.hostWebContents;
    if (embedder !== null && !embedder.isDestroyed()) {
      embedder.send(IpcChannels.PREVIEW_NAVIGATION_BLOCKED_CHANNEL, payload);
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (isAppWindow(window)) {
        window.webContents.send(IpcChannels.PREVIEW_NAVIGATION_BLOCKED_CHANNEL, payload);
      }
    }
  };

  const reportUserControl = (contents: WebContents, input: DesktopPreviewUserControl["input"]) => {
    const payload: DesktopPreviewUserControl = { webContentsId: contents.id, input };
    const embedder = contents.hostWebContents;
    if (embedder !== null && !embedder.isDestroyed()) {
      embedder.send(IpcChannels.PREVIEW_USER_CONTROL_CHANNEL, payload);
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (isAppWindow(window)) {
        window.webContents.send(IpcChannels.PREVIEW_USER_CONTROL_CHANNEL, payload);
      }
    }
  };

  /**
   * The sites each browser profile was last allowed, by its session.
   *
   * A project's pages share one profile and one policy, but the renderer hands
   * the policy to each page only once it has attached, and a new page starts
   * loading before that. A page could open a tab at an allowed address that
   * redirects at once, and the redirect would land before anything guarded
   * the new page. So a page born into a profile that already has a policy is
   * guarded with it from the start. The first page of a profile has nothing
   * to inherit and waits for its own, as before: holding it to private sites
   * meanwhile would ask about sites the project already allows.
   */
  const accessBySession = new WeakMap<Session, BrowserSiteAccess>();

  /**
   * Holds a page's own navigations to a guard's sites: a refused one is
   * stopped, and `onRefused` hears where it was going.
   *
   * `webOnly` is for sign-in pop-ups. A window outside the panel goes only to
   * web addresses, so a `blob:` or `data:` page its opener made cannot pose as
   * a site in it. Panel tabs keep those, since they name no site (see
   * `navigationHost`).
   */
  const armNavigationGuard = (
    contents: WebContents,
    guard: NavigationGuard,
    onRefused: (url: string, host: string) => void,
    webOnly: boolean,
  ) => {
    const refuse = (details: {
      readonly url: string;
      readonly isMainFrame: boolean;
      readonly preventDefault: () => void;
    }) => {
      // Only the top-level document. An iframe is the page's own composition,
      // not somewhere the browser went.
      if (!details.isMainFrame) {
        return;
      }
      const blockedHost = navigationHost(details.url);
      if (blockedHost === null) {
        if (webOnly) details.preventDefault();
        return;
      }
      if (isBrowserHostAllowed(blockedHost, guard.access)) {
        return;
      }
      details.preventDefault();
      onRefused(details.url, blockedHost);
    };
    // Both, because a link click and a 302 arriving mid-load are the same
    // event to the user: the page ended up somewhere nobody approved.
    contents.on("will-navigate", refuse);
    contents.on("will-redirect", refuse);
    contents.once("destroyed", () => {
      contents.off("will-navigate", refuse);
      contents.off("will-redirect", refuse);
    });
  };

  /**
   * Arms the guest's own navigations against the guest's allowlist.
   *
   * Registered at attach as well as when a policy arrives, so a tab whose
   * policy has not been pushed yet is still held to private-network-only rather
   * than being left open until the renderer gets round to it.
   */
  const ensureNavigationGuard = (contents: WebContents): NavigationGuard => {
    const existing = navigationGuards.get(contents.id);
    if (existing !== undefined) {
      return existing;
    }
    const guard: NavigationGuard = {
      access: accessBySession.get(contents.session) ?? { allowAll: false, approvedHosts: [] },
    };
    armNavigationGuard(
      contents,
      guard,
      (url, host) => reportBlockedNavigation(contents, url, host),
      false,
    );
    contents.once("destroyed", () => navigationGuards.delete(contents.id));
    navigationGuards.set(contents.id, guard);
    return guard;
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview" && accessBySession.has(contents.session)) {
      ensureNavigationGuard(contents);
    }
  });

  /**
   * The host a certificate was presented for. A page's own loads are `https:`,
   * and a dev server's live reload runs over `wss:` on the same host with the
   * same certificate, so both count.
   */
  const certificateHost = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "https:" || parsed.protocol === "wss:") && parsed.hostname !== ""
        ? parsed.hostname
        : null;
    } catch {
      return null;
    }
  };

  /**
   * Tells the panel a page on the user's own machine or network was refused
   * for its certificate, so it can offer to trust it. Sent like a blocked
   * navigation: to the window embedding the page, or every app window.
   */
  const reportUntrustedCertificate = (
    contents: WebContents,
    payload: DesktopPreviewCertificateUntrusted,
  ) => {
    const embedder = contents.hostWebContents;
    if (embedder !== null && !embedder.isDestroyed()) {
      embedder.send(IpcChannels.PREVIEW_CERTIFICATE_UNTRUSTED_CHANNEL, payload);
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (isAppWindow(window)) {
        window.webContents.send(IpcChannels.PREVIEW_CERTIFICATE_UNTRUSTED_CHANNEL, payload);
      }
    }
  };

  /**
   * A certificate the system does not trust, met by a browser page.
   *
   * A dev server on the user's own machine or network often serves HTTPS with
   * a certificate it made itself. One the user trusted for the project goes
   * through; any other is refused, as Chromium would, and when it is the
   * address of a page on a private host the panel is told so it can offer to
   * trust it. Chromium asks again for every new connection, which is what
   * lets taking trust back work (see `setNavigationPolicy`). The app's own
   * window, in the default session, is left to Chromium.
   */
  app.on("certificate-error", (event, contents, url, error, certificate, callback, isMainFrame) => {
    if (contents.isDestroyed() || contents.session === session.defaultSession) return;
    // The profile's latest policy rather than this page's copy: trust taken
    // back reaches the profile with the first page told, and a page told a
    // moment later must not let the certificate back in meanwhile.
    const access =
      accessBySession.get(contents.session) ?? navigationGuards.get(contents.id)?.access;
    const host = certificateHost(url);
    if (
      host !== null &&
      access !== undefined &&
      isBrowserCertificateTrusted(host, certificate.fingerprint, access)
    ) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
    if (
      isMainFrame &&
      host !== null &&
      isPrivateNetworkHost(host) &&
      contents.getType() === "webview"
    ) {
      reportUntrustedCertificate(contents, {
        webContentsId: contents.id,
        host,
        url,
        fingerprint: certificate.fingerprint,
        error,
      });
    }
  });

  const resolve = (webContentsId: number) =>
    Effect.suspend(() => {
      const contents = webContents.fromId(webContentsId);
      return contents === undefined || contents.isDestroyed()
        ? Effect.fail(new PreviewTargetMissingError({ webContentsId }))
        : Effect.succeed(contents);
    });

  /**
   * One DevTools command, bounded.
   *
   * A page that has stopped answering -- a busy loop, a renderer that hung --
   * would otherwise leave the call pending forever, and with it every action
   * queued behind it on that tab. Nothing here legitimately waits this long:
   * waits poll with short commands, and the element picker listens for events
   * rather than holding a command open. The agent's own script is the one
   * exception, and gets as long as its tool call can afford.
   */
  const sendCommand = (
    contents: WebContents,
    method: string,
    params?: Record<string, unknown>,
    options?: {
      readonly timeout?: Duration.Input | undefined;
      /** Asked in the same synchronous step as the send; a reason refuses it. */
      readonly refusal?: () => string | null;
      /** Why the page did not answer, when the caller knows better. */
      readonly timedOut?: () => string;
      /** A frame's own session (`routePoint`); the page's when absent. */
      readonly sessionId?: string | undefined;
    },
  ) =>
    Effect.tryPromise({
      try: () => {
        const reason = options?.refusal?.() ?? null;
        return reason === null
          ? contents.debugger.sendCommand(method, params ?? {}, options?.sessionId)
          : Promise.reject(reason);
      },
      catch: (cause) => new PreviewCommandError({ webContentsId: contents.id, method, cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: options?.timeout ?? CDP_COMMAND_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new PreviewCommandError({
              webContentsId: contents.id,
              method,
              cause: options?.timedOut?.() ?? PAGE_DID_NOT_ANSWER,
            }),
          ),
      }),
    );

  /**
   * One agent action's keystrokes into a page; `keys` sends them through the
   * `send` it is given.
   *
   * Chromium does not deliver a guest's keystrokes to the guest. It delivers
   * them to whatever holds keyboard focus in the window, and when that is the
   * app -- the composer the user is typing in -- the agent's text and its Enter
   * land there and send a message. So the renderer gives the page focus for
   * the length of the keys (`withPageKeyboard` in the focus guard), just
   * behind this request, and:
   *
   * - The user's keys are held out of the page from the moment the request
   *   arrives for as long as the renderer may hold the loan, or until they
   *   press in the page themselves: until then, focus is the page's only on
   *   loan, and the renderer may be too busy to have handed it back yet.
   * - Each key waits for the page to hold focus, and is refused if it does not,
   *   if the renderer may be taking focus back by now, or if the user has
   *   taken control of the page since the action began (`controlEpoch`): the
   *   field the agent clicked may no longer be the one with focus. A loan that
   *   failed or ran out is an error, never keys in the wrong place. The check
   *   rides inside the send because Chromium picks the receiver synchronously
   *   while the command is dispatched: nothing can move focus between the two.
   */
  const agentKeys = <A, E, R>(
    webContentsId: number,
    controlEpoch: number | undefined,
    keys: (
      send: (
        method: string,
        params: Record<string, unknown>,
      ) => Effect.Effect<unknown, PreviewCommandError>,
    ) => Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const startedAt = Date.now();
      const holdUserKeys = () => {
        const tab = attached.get(webContentsId);
        // Not for a page the user has taken over: these keys will be refused,
        // and the user's own are for the page.
        if (
          tab === undefined ||
          (controlEpoch !== undefined && tab.controlEpoch !== controlEpoch)
        ) {
          return;
        }
        tab.holdUserKeysUntil = startedAt + PREVIEW_AGENT_KEYBOARD_HOLD_MS;
      };
      // On arrival, before anything that waits: the focus is right behind.
      holdUserKeys();
      return resolveAttached(webContentsId).pipe(
        Effect.flatMap((contents) =>
          Effect.gen(function* () {
            // Again, in case attaching just made the tab's record.
            holdUserKeys();
            while (contents.focusedFrame === null && Date.now() - startedAt < PAGE_FOCUS_WAIT_MS) {
              yield* Effect.sleep(PAGE_FOCUS_POLL);
            }
            let sent = 0;
            const send = (method: string, params: Record<string, unknown>) =>
              sendCommand(contents, method, params, {
                refusal: () => {
                  const tab = attached.get(webContentsId);
                  const refusal =
                    controlEpoch !== undefined &&
                    tab !== undefined &&
                    tab.controlEpoch !== controlEpoch
                      ? "the user took control of this tab"
                      : contents.focusedFrame === null
                        ? "the page did not have keyboard focus"
                        : Date.now() - startedAt > PREVIEW_AGENT_KEYS_DEADLINE_MS
                          ? "the page took too long to take the keys"
                          : null;
                  if (refusal === null) {
                    sent += 1;
                    return null;
                  }
                  return sent === 0
                    ? `${refusal}, so nothing was typed; try again`
                    : `${refusal}, so only part of the input reached it; check the field before trying again`;
                },
              });
            return yield* keys(send);
          }),
        ),
      );
    });

  const failCommand = (contents: WebContents, method: string, cause: string) =>
    Effect.fail(new PreviewCommandError({ webContentsId: contents.id, method, cause }));

  const targetDescription = (target: PreviewAutomationTarget): string =>
    "ref" in target
      ? `ref ${target.ref}`
      : "locator" in target
        ? `locator ${JSON.stringify(target.locator)}`
        : "selector" in target
          ? `selector ${JSON.stringify(target.selector)}`
          : "text" in target
            ? `text ${JSON.stringify(target.text)}`
            : `${target.point.x},${target.point.y}`;

  /**
   * The isolated world our element engine lives in, created if it is not there.
   *
   * Asked for on every use rather than tracked: Chrome returns the existing
   * world for a name it already knows, and a navigation quietly destroys the
   * old one. Tracking it ourselves would mean holding an id that goes stale
   * exactly when a page changes, which is the moment this gets used.
   */
  /** The engine's world in a frame (the page's top one when none is given), built on first use. */
  const injectedWorld = Effect.fn("PreviewAutomation.injectedWorld")(function* (
    contents: WebContents,
    frame?: InjectedFrame,
    timeout?: Duration.Input,
  ) {
    const sessionId = frame?.sessionId;
    let frameId = frame?.frameId;
    if (frameId === undefined) {
      yield* sendCommand(contents, "Page.enable", {});
      const tree = (yield* sendCommand(contents, "Page.getFrameTree", {})) as {
        frameTree?: { frame?: { id?: string } };
      };
      frameId = tree.frameTree?.frame?.id;
      if (frameId === undefined) {
        return yield* failCommand(contents, "Page.getFrameTree", "the page has no main frame");
      }
    }
    const world = (yield* sendCommand(
      contents,
      "Page.createIsolatedWorld",
      { frameId, worldName: INJECTED_WORLD_NAME, grantUniveralAccess: false },
      { sessionId, timeout },
    )) as { executionContextId?: number };
    const contextId = world.executionContextId;
    if (contextId === undefined) {
      return yield* failCommand(
        contents,
        "Page.createIsolatedWorld",
        "could not create an isolated world for the element engine",
      );
    }
    // The engine's source is large; it is sent only to a world without it.
    const built = (yield* sendCommand(
      contents,
      "Runtime.evaluate",
      {
        expression: injectedRuntimeReadyExpression(frame?.ordinal ?? 0),
        contextId,
        returnByValue: true,
      },
      { sessionId, timeout },
    )) as { result?: { value?: unknown } };
    if (built.result?.value !== true) {
      yield* sendCommand(
        contents,
        "Runtime.evaluate",
        {
          expression: buildInjectedRuntimeScript(undefined, frame?.ordinal ?? 0),
          contextId,
          returnByValue: true,
        },
        { sessionId, timeout },
      );
    }
    return contextId;
  });

  /** Runs an expression in the engine's world, surfacing a page-side throw. */
  const evaluateInjected = Effect.fn("PreviewAutomation.evaluateInjected")(function* (
    contents: WebContents,
    expression: string,
    options?: {
      readonly returnByValue?: boolean;
      /** A frame inside the page; its top one when absent. */
      readonly frame?: InjectedFrame;
      readonly timeout?: Duration.Input;
    },
  ) {
    const sessionId = options?.frame?.sessionId;
    const contextId = yield* injectedWorld(contents, options?.frame, options?.timeout);
    const result = (yield* sendCommand(
      contents,
      "Runtime.evaluate",
      {
        expression,
        contextId,
        returnByValue: options?.returnByValue ?? false,
        awaitPromise: true,
      },
      { sessionId, timeout: options?.timeout },
    )) as {
      result?: { objectId?: string; value?: unknown };
      exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string };
    };
    if (result.exceptionDetails !== undefined) {
      const exception = result.exceptionDetails.exception;
      // The engine's own messages say what to do differently, so they are
      // carried through rather than replaced with something generic.
      const detail =
        (typeof exception?.value === "string" ? exception.value : undefined) ??
        exception?.description?.split("\n")[0] ??
        result.exceptionDetails.text ??
        "the element engine failed";
      return yield* failCommand(contents, "injected.evaluate", detail);
    }
    return result.result ?? {};
  });

  const resolveTarget = Effect.fn("PreviewAutomation.resolveTarget")(function* (
    contents: WebContents,
    target: PreviewAutomationTarget,
  ) {
    if ("point" in target) {
      // Deliberately not "whatever is at those coordinates". This operation
      // needs a specific node, and hit-testing a point would hand it a parent,
      // an overlay or the body -- wrong in a way that looks like it worked.
      return yield* failCommand(
        contents,
        "resolveTarget",
        "a point names a place, not an element; this needs a ref, locator, selector or text",
      );
    }
    if ("locator" in target) {
      const handle = yield* evaluateInjected(contents, buildLocatorQueryScript(target.locator));
      const objectId = handle.objectId;
      if (objectId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the locator ${JSON.stringify(target.locator)} did not resolve to an element`,
        );
      }
      const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the element matching ${JSON.stringify(target.locator)} disappeared; take a new snapshot`,
        );
      }
      return backendNodeId;
    }

    if ("ref" in target) {
      // A ref is the `eN` from the aria snapshot, and Playwright's own
      // `aria-ref=` engine is what resolves it against the tree that issued it.
      // Resolving it as anything else -- a node id, an index -- would work
      // right up until the page re-rendered.
      const handle = yield* evaluateInjected(
        contents,
        buildLocatorQueryScript(`aria-ref=${target.ref}`),
      );
      const objectId = handle.objectId;
      if (objectId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `ref ${target.ref} no longer resolves; take a new snapshot and use its refs`,
        );
      }
      const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the element at ref ${target.ref} disappeared; take a new snapshot and try again`,
        );
      }
      return backendNodeId;
    }

    if ("selector" in target) {
      const document = (yield* sendCommand(contents, "DOM.getDocument", {})) as {
        root?: { nodeId?: number };
      };
      const nodeId = document.root?.nodeId;
      if (nodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }

      const match = (yield* sendCommand(contents, "DOM.querySelector", {
        nodeId,
        selector: target.selector,
      }).pipe(
        Effect.catch(() =>
          failCommand(
            contents,
            "resolveTarget",
            `no element matches selector ${JSON.stringify(target.selector)}; use a valid selector or take a new snapshot`,
          ),
        ),
      )) as { nodeId?: number };
      if (match.nodeId === undefined || match.nodeId === 0) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }

      const described = (yield* sendCommand(contents, "DOM.describeNode", {
        nodeId: match.nodeId,
      }).pipe(
        Effect.catch(() =>
          failCommand(
            contents,
            "resolveTarget",
            `the element matching selector ${JSON.stringify(target.selector)} disappeared; take a new snapshot and try again`,
          ),
        ),
      )) as { node?: { backendNodeId?: number } };
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }
      return backendNodeId;
    }

    if (target.text.trim() === "") {
      return yield* failCommand(
        contents,
        "resolveTarget",
        "an empty text target cannot identify an element; provide visible text, a selector, or a snapshot ref",
      );
    }

    const evaluated = (yield* sendCommand(contents, "Runtime.evaluate", {
      expression: `(() => {
        const wanted = ${JSON.stringify(target.text)};
        const clickableSelector = 'button, a, [role="button"], input, summary';
        const depth = (element) => {
          let value = 0;
          for (let current = element; current.parentElement; current = current.parentElement) {
            value += 1;
          }
          return value;
        };
        const visible = (element) => {
          const style = getComputedStyle(element);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('*')]
          .filter(visible)
          .map((element) => ({ element, text: (element.innerText || '').trim() }))
          .filter((candidate) => candidate.text !== '');
        const rank = (left, right) => {
          const clickable =
            Number(right.element.matches(clickableSelector)) -
            Number(left.element.matches(clickableSelector));
          return clickable !== 0 ? clickable : depth(left.element) - depth(right.element);
        };
        const exact = candidates.filter((candidate) => candidate.text === wanted).sort(rank);
        if (exact.length > 0) {
          return exact[0].element;
        }
        const containing = candidates
          .filter((candidate) => candidate.text.includes(wanted))
          .sort(rank);
        return containing.length > 0 ? containing[0].element : null;
      })()`,
    })) as {
      result?: { objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const objectId = evaluated.result?.objectId;
    if (objectId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `no visible element has text ${JSON.stringify(target.text)}; take a new snapshot, use a selector, or try a shorter text`,
      );
    }

    const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId }).pipe(
      Effect.ensuring(
        sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore),
      ),
      Effect.catch(() =>
        failCommand(
          contents,
          "resolveTarget",
          `the element with text ${JSON.stringify(target.text)} disappeared; take a new snapshot and try again`,
        ),
      ),
    )) as { node?: { backendNodeId?: number } };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `no visible element has text ${JSON.stringify(target.text)}; take a new snapshot or use a selector`,
      );
    }
    return backendNodeId;
  });

  /**
   * The element a target names, with the session its node id belongs to. A
   * snapshot ref inside a frame (`f2e7`) resolves in that frame, through the
   * engine there that issued it; everything else resolves in the page's top
   * document, as `resolveTarget` does.
   */
  const resolveNode = Effect.fn("PreviewAutomation.resolveNode")(function* (
    contents: WebContents,
    target: PreviewAutomationTarget,
  ) {
    const frameRef = "ref" in target ? FRAME_REF.exec(target.ref) : null;
    if (frameRef === null || !("ref" in target)) {
      const backendNodeId = yield* resolveTarget(contents, target);
      return { backendNodeId, sessionId: undefined } satisfies NodeRef;
    }
    const frame = attached.get(contents.id)?.framesByOrdinal.get(Number(frameRef[1]));
    if (frame === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `ref ${target.ref} no longer resolves; take a new snapshot and use its refs`,
      );
    }
    const handle = yield* evaluateInjected(
      contents,
      buildLocatorQueryScript(`aria-ref=${target.ref}`),
      { frame },
    );
    const objectId = handle.objectId;
    if (objectId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `ref ${target.ref} no longer resolves; take a new snapshot and use its refs`,
      );
    }
    const described = (yield* sendCommand(
      contents,
      "DOM.describeNode",
      { objectId },
      { sessionId: frame.sessionId },
    ).pipe(Effect.ensuring(releaseInBackground(contents, objectId, frame.sessionId)))) as {
      node?: { backendNodeId?: number };
    };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `the element at ref ${target.ref} disappeared; take a new snapshot and try again`,
      );
    }
    return { backendNodeId, sessionId: frame.sessionId } satisfies NodeRef;
  });

  /**
   * The page's content as text with refs, and its frames' content nested
   * under each frame's line (see `snapshot`). Each frame is read in the
   * engine there, under the number its refs carry. A frame that does not
   * answer within what is left of the snapshot's budget, or past its frame
   * count, stays a bare line.
   */
  const snapshotFrame = (
    contents: WebContents,
    tab: AttachedTab,
    frame: InjectedFrame | undefined,
    depth: number,
    budget: SnapshotBudget,
  ): Effect.Effect<string, PreviewCommandError | PreviewTargetMissingError> =>
    Effect.gen(function* () {
      const result = yield* evaluateInjected(contents, buildAriaSnapshotScript(), {
        returnByValue: true,
        ...(frame === undefined ? {} : { frame, timeout: SNAPSHOT_FRAME_TIMEOUT }),
      });
      const text = typeof result.value === "string" ? result.value : "";
      if (depth >= MAX_FRAME_DEPTH) return text;
      const lines: string[] = [];
      for (const line of text.split("\n")) {
        const match = SNAPSHOT_FRAME_LINE.exec(line);
        const remaining = budget.deadline - Date.now();
        if (match === null || remaining <= 0 || budget.frames >= MAX_SNAPSHOT_FRAMES) {
          lines.push(line);
          continue;
        }
        budget.frames += 1;
        const [, indent = "", head = "", ref = ""] = match;
        const inner = yield* frameContents(contents, tab, frame, ref, depth, budget).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(remaining),
            orElse: () => Effect.succeed([] as ReadonlyArray<string>),
          }),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );
        if (inner.length === 0) {
          lines.push(line);
          continue;
        }
        lines.push(`${indent}${head}:`);
        for (const innerLine of inner) lines.push(`${indent}  ${innerLine}`);
      }
      return lines.join("\n");
    });

  /** The lines of the frame an `iframe` ref shows, numbered for its refs and recorded for them. */
  const frameContents = (
    contents: WebContents,
    tab: AttachedTab,
    frame: InjectedFrame | undefined,
    ref: string,
    depth: number,
    budget: SnapshotBudget,
  ): Effect.Effect<ReadonlyArray<string>, PreviewCommandError | PreviewTargetMissingError> =>
    Effect.gen(function* () {
      const child = yield* frameAtRef(contents, frame, ref);
      if (child === null) return [];
      const numbering = frameNumberingOf(contents.id);
      const ordinal = numbering.ordinals.get(child.frameId) ?? numbering.next++;
      const childFrame: InjectedFrame = {
        sessionId: child.sessionId,
        frameId: child.frameId,
        ordinal,
      };
      numbering.ordinals.set(child.frameId, ordinal);
      tab.framesByOrdinal.set(ordinal, childFrame);
      if (child.sessionId !== undefined && child.sessionId !== frame?.sessionId) {
        tab.sessionOwners.set(child.sessionId, {
          frameId: child.frameId,
          parentSessionId: frame?.sessionId,
          ownerBackendNodeId: child.ownerBackendNodeId,
        });
      }
      const inner = yield* snapshotFrame(contents, tab, childFrame, depth + 1, budget);
      return inner.split("\n").filter((line) => line.trim() !== "");
    });

  /**
   * Lets go of a page object without waiting on the page: a frame that stops
   * answering must not hold up a snapshot past its budget.
   */
  const releaseInBackground = (
    contents: WebContents,
    objectId: string,
    sessionId: string | undefined,
  ) =>
    Effect.sync(() => {
      if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
      contents.debugger
        .sendCommand("Runtime.releaseObject", { objectId }, sessionId)
        .catch(() => {});
    });

  /** The frame an `iframe` ref in a snapshot of `frame` shows, and that frame's element. */
  const frameAtRef = Effect.fn("PreviewAutomation.frameAtRef")(function* (
    contents: WebContents,
    frame: InjectedFrame | undefined,
    ref: string,
  ) {
    const sessionId = frame?.sessionId;
    const handle = yield* evaluateInjected(contents, buildLocatorQueryScript(`aria-ref=${ref}`), {
      ...(frame === undefined ? {} : { frame }),
      timeout: SNAPSHOT_FRAME_TIMEOUT,
    });
    const objectId = handle.objectId;
    if (objectId === undefined) return null;
    const described = (yield* sendCommand(
      contents,
      "DOM.describeNode",
      { objectId },
      { sessionId, timeout: SNAPSHOT_FRAME_TIMEOUT },
    ).pipe(Effect.ensuring(releaseInBackground(contents, objectId, sessionId)))) as {
      node?: { backendNodeId?: number; frameId?: string };
    };
    const frameId = described.node?.frameId;
    const ownerBackendNodeId = described.node?.backendNodeId;
    if (frameId === undefined || ownerBackendNodeId === undefined) return null;
    const tab = attached.get(contents.id);
    // A frame in a process of its own is reached through its own session;
    // one in the same process, through the session around it.
    const frameSession = tab?.frameSessions.get(frameId) ?? sessionId;
    return { sessionId: frameSession, frameId, ownerBackendNodeId };
  });

  /**
   * Turns a picked node into something that still means something later.
   *
   * Everything is read in one page-side evaluation so the description matches a
   * single moment: reading the tag, then the text, then the box across separate
   * round trips would let the page change underneath and produce a description
   * that never existed.
   */
  const describePickedNode = (send: typeof sendCommand) =>
    Effect.fn("PreviewAutomation.describePickedNode")(function* (
      contents: WebContents,
      backendNodeId: number,
    ) {
      const resolved = yield* send(contents, "DOM.resolveNode", { backendNodeId });
      const objectId = (resolved as { object?: { objectId?: string } }).object?.objectId;
      if (objectId === undefined) {
        return null;
      }

      const description = yield* send(contents, "Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function () {
      const element = this;
      const rect = element.getBoundingClientRect();
      // A path that a person could paste into the console: id when it is
      // unique, otherwise tag plus nth-of-type up to a sensible depth.
      const path = (node) => {
        const parts = [];
        let current = node;
        while (current && current.nodeType === 1 && parts.length < 5) {
          if (current.id) {
            parts.unshift('#' + CSS.escape(current.id));
            break;
          }
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = [...parent.children].filter((c) => c.tagName === current.tagName);
          parts.unshift(
            siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : tag,
          );
          current = parent;
        }
        return parts.join(' > ');
      };
      // Spaces collapse but line breaks survive: a heading and the paragraph
      // after it are different lines, and squashing them together reads as one
      // run-on sentence wherever this is shown.
      const text = (element.innerText || element.textContent || '')
        .replace(/[^\\S\\n]+/g, ' ')
        .replace(/\\n{2,}/g, '\\n')
        .trim();
      return {
        tagName: element.tagName.toLowerCase(),
        selector: path(element),
        text: text === '' ? null : text.slice(0, 200),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        url: location.href,
      };
    }`,
      });

      yield* send(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);

      const value = (description as { result?: { value?: Record<string, unknown> } }).result?.value;
      if (value === undefined) {
        return null;
      }

      // Role and name come from the accessibility tree, which is how the agent
      // identifies elements everywhere else in this feature.
      const axNode = yield* send(contents, "Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
      const nodes = (axNode as { nodes?: ReadonlyArray<Record<string, unknown>> }).nodes ?? [];
      const first = nodes[0];
      // An AX property is { type, value } -- the string sits one level down,
      // not two. Reading it a level too deep yielded undefined for every
      // element, which the fallback below then reported as "no role", silently.
      const readValue = (field: unknown): string | null => {
        const raw = (field as { value?: unknown } | undefined)?.value;
        return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      };

      return {
        // Both come from the user rather than the DOM; the caller attaches them.
        note: null,
        styleChanges: [],
        tagName: String(value.tagName ?? "element"),
        role: first === undefined ? null : readValue(first.role),
        name: first === undefined ? null : readValue(first.name),
        selector: String(value.selector ?? ""),
        text: (value.text as string | null) ?? null,
        rect: value.rect as { x: number; y: number; width: number; height: number },
        url: String(value.url ?? ""),
      } satisfies DesktopPreviewPickedElement;
    });

  /**
   * Describes the elements an overlay left behind for us.
   *
   * Read back by identity rather than by hit-testing a point again: the second
   * test can land on a different element than the one the user watched light
   * up, and for a region or a circled group no single point names the set at
   * all. Must run before the overlay is torn down, since the teardown is what
   * drops the handles.
   */
  const describeStashed = Effect.fn("PreviewAutomation.describeStashed")(function* (
    contents: WebContents,
    stash: string,
    count: number,
  ) {
    const described: DesktopPreviewPickedElement[] = [];
    for (let index = 0; index < count; index += 1) {
      const handle = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression: `window[${JSON.stringify(stash)}][${index}]`,
      })) as { result?: { objectId?: string } };
      const objectId = handle.result?.objectId;
      if (objectId === undefined) {
        continue;
      }
      const node = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = node.node?.backendNodeId;
      if (backendNodeId === undefined) {
        continue;
      }
      const element = yield* describePickedNode(sendCommand)(contents, backendNodeId);
      if (element !== null) {
        described.push(element);
      }
    }
    return described;
  });

  const buildStatus = (webContentsId: number, contents: WebContents): DesktopPreviewStatus => {
    const tab = attached.get(webContentsId);
    return {
      webContentsId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      attached: contents.debugger.isAttached(),
      controlEpoch: tab?.controlEpoch ?? 0,
      console: tab?.console ?? [],
      networkFailures: tab?.networkFailures ?? [],
    };
  };

  /**
   * Attaches the debugger, or re-attaches one that has gone.
   *
   * The bookkeeping map is not the question: it records that we set a tab up,
   * not that the debugger is still on it. Only one client may attach at a time,
   * so opening DevTools on the page takes it away from us, and a crashed or
   * reloaded guest drops it too. Asking the map alone meant that once the
   * attachment was lost it never came back, and every command after that failed
   * with "No target available" -- which reads as the whole browser being broken
   * rather than as one thing to redo.
   */
  const attach = Effect.fn("PreviewAutomation.attach")(function* (webContentsId: number) {
    const contents = yield* resolve(webContentsId);
    // Before anything else, and outside the debugger's lifecycle: a guest that
    // exists is a guest that can be sent somewhere by its own page.
    ensureNavigationGuard(contents);
    if (attached.has(webContentsId) && contents.debugger.isAttached()) {
      return buildStatus(webContentsId, contents);
    }
    // Set up once before, but not attached now: the old listeners belong to an
    // attachment that no longer exists, and leaving them would double every
    // console entry once a new one is made.
    const stale = attached.get(webContentsId);
    if (stale !== undefined) {
      stale.dispose();
      attached.delete(webContentsId);
    }

    const tab: AttachedTab = {
      contents,
      console: [],
      networkFailures: [],
      requestUrls: new Map(),
      controlEpoch: 0,
      expectedAgentInputs: [],
      holdUserKeysUntil: 0,
      frameSessions: new Map(),
      sessionOwners: new Map(),
      framesByOrdinal: new Map(),
      dispose: () => {},
    };

    if (!contents.debugger.isAttached()) {
      yield* Effect.try({
        try: () => contents.debugger.attach("1.3"),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "debugger.attach", cause }),
      });
    }

    const pushConsole = (entry: DesktopPreviewConsoleEntry) => {
      if (isHostInjectedConsoleEntry(entry)) {
        return;
      }
      tab.console.push(entry);
      if (tab.console.length > MAX_CONSOLE_ENTRIES) tab.console.shift();
    };

    const consumeExpectedAgentInput = (kind: "mouseDown" | "mouseWheel") => {
      const now = Date.now();
      tab.expectedAgentInputs = tab.expectedAgentInputs.filter((entry) => entry.expiresAt > now);
      const index = tab.expectedAgentInputs.findIndex((entry) => entry.kind === kind);
      if (index < 0) return false;
      tab.expectedAgentInputs.splice(index, 1);
      return true;
    };
    // Only the user's keys come through here: the agent's are CDP key events,
    // a kind Electron does not report.
    const onBeforeInput = (event: { preventDefault: () => void }, input: { type?: string }) => {
      // The page holds focus only so the agent's keys reach it; a key the user
      // typed meanwhile was meant for wherever they were typing, and in the
      // page it could fire a shortcut or land in the middle of the agent's text.
      // Releases too: a page may act on the keyup of an Enter pressed elsewhere.
      if (Date.now() < tab.holdUserKeysUntil) {
        event.preventDefault();
        return;
      }
      if (input.type !== "keyDown") return;
      tab.controlEpoch += 1;
      reportUserControl(contents, "keyboard");
    };
    const onBeforeMouse = (_event: unknown, input: { type?: string }) => {
      const kind =
        input.type === "mouseDown"
          ? "mouseDown"
          : input.type === "mouseWheel"
            ? "mouseWheel"
            : null;
      if (kind !== null && !consumeExpectedAgentInput(kind)) {
        // A press in the page is the user choosing it; their keys are for it.
        if (kind === "mouseDown") tab.holdUserKeysUntil = 0;
        tab.controlEpoch += 1;
        reportUserControl(contents, kind === "mouseDown" ? "pointer" : "wheel");
      }
    };
    contents.on("before-input-event", onBeforeInput);
    contents.on("before-mouse-event", onBeforeMouse);

    const onMessage = (
      _event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => {
      if (method === "Target.attachedToTarget") {
        const info = params.targetInfo as { targetId?: unknown; type?: unknown } | undefined;
        const frameSession = params.sessionId;
        if (
          info?.type === "iframe" &&
          typeof info.targetId === "string" &&
          typeof frameSession === "string"
        ) {
          // An iframe target's id is its frame's id, as DOM.describeNode names it.
          tab.frameSessions.set(info.targetId, frameSession);
          contents.debugger
            .sendCommand("Target.setAutoAttach", FRAME_AUTO_ATTACH, frameSession)
            .catch(() => {});
        }
        return;
      }
      if (method === "Target.detachedFromTarget") {
        for (const [frameId, frameSession] of tab.frameSessions) {
          if (frameSession === params.sessionId) tab.frameSessions.delete(frameId);
        }
        if (typeof params.sessionId === "string") tab.sessionOwners.delete(params.sessionId);
        return;
      }
      // A frame's own session reports nothing else this reads. The page's own
      // messages come with an empty session id, not a missing one.
      if (sessionId !== undefined && sessionId !== "") return;
      if (method === "Runtime.consoleAPICalled") {
        const args = (params.args as ReadonlyArray<{ value?: unknown }> | undefined) ?? [];
        pushConsole({
          level: String(params.type ?? "log"),
          text: args
            .map((arg) => (arg.value === undefined ? "" : String(arg.value)))
            .join(" ")
            .trim(),
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails as { text?: string } | undefined;
        pushConsole({
          level: "error",
          text: details?.text ?? "Uncaught exception",
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Network.requestWillBeSent") {
        const requestId = String(params.requestId ?? "");
        const request = params.request as { url?: string } | undefined;
        if (requestId !== "" && request?.url !== undefined) {
          tab.requestUrls.set(requestId, request.url);
        }
        return;
      }
      if (method === "Network.loadingFailed") {
        const requestId = String(params.requestId ?? "");
        tab.networkFailures.push({
          url: tab.requestUrls.get(requestId) ?? "",
          status: null,
          errorText: String(params.errorText ?? "request failed"),
          at: new Date().toISOString(),
        });
        tab.requestUrls.delete(requestId);
        if (tab.networkFailures.length > MAX_NETWORK_FAILURES) tab.networkFailures.shift();
        return;
      }
      if (method === "Log.entryAdded") {
        // Browser-level messages the page never printed itself: CSP violations,
        // CORS refusals, mixed content. Exactly the failures a developer asks
        // an agent about, and invisible to Runtime.consoleAPICalled.
        const entry = params.entry as { level?: string; text?: string } | undefined;
        pushConsole({
          level: entry?.level ?? "info",
          text: entry?.text ?? "",
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Network.responseReceived") {
        const response = params.response as { url?: string; status?: number } | undefined;
        if (response?.status !== undefined && response.status >= 400) {
          tab.networkFailures.push({
            url: response.url ?? "",
            status: response.status,
            errorText: null,
            at: new Date().toISOString(),
          });
          if (tab.networkFailures.length > MAX_NETWORK_FAILURES) tab.networkFailures.shift();
        }
        return;
      }
      if (method === "Page.frameNavigated") {
        const frame = params.frame as { parentId?: string } | undefined;
        // Only the main frame: an iframe navigating is not a new page, and
        // clearing on it would discard the diagnostics being asked about.
        if (frame?.parentId === undefined) {
          tab.console.length = 0;
          tab.networkFailures.length = 0;
          tab.requestUrls.clear();
          // A new page's frames: refs into the old ones' stop resolving. The
          // numbering runs on, so an old ref never matches a new frame.
          tab.framesByOrdinal.clear();
          frameNumbering.get(webContentsId)?.ordinals.clear();
        }
      }
    };

    contents.debugger.on("message", onMessage);
    const onDestroyed = () => {
      frameNumbering.delete(webContentsId);
      attached.delete(webContentsId);
      lifecycles.delete(webContentsId);
    };
    // Electron tells us when the attachment goes -- DevTools opening, the guest
    // crashing, someone calling detach. Dropping the record here is what lets
    // the next command notice and rebuild rather than fail.
    const onDetach = () => {
      attached.get(webContentsId)?.dispose();
      attached.delete(webContentsId);
    };
    contents.once("destroyed", onDestroyed);
    contents.debugger.on("detach", onDetach);
    tab.dispose = () => {
      contents.debugger.off("message", onMessage);
      contents.debugger.off("detach", onDetach);
      contents.off("destroyed", onDestroyed);
      contents.off("before-input-event", onBeforeInput);
      contents.off("before-mouse-event", onBeforeMouse);
    };
    attached.set(webContentsId, tab);

    for (const method of [
      "Runtime.enable",
      "Page.enable",
      "Network.enable",
      "Log.enable",
      "Accessibility.enable",
    ]) {
      yield* sendCommand(contents, method);
    }
    // Best effort: without it, input meant for such a frame lands as it did
    // before, on the frame's element.
    yield* sendCommand(contents, "Target.setAutoAttach", FRAME_AUTO_ATTACH).pipe(Effect.ignore);

    // The guest believes it is focused even while the user's caret is
    // elsewhere in the embedding window. Agent input pulls focus onto the
    // <webview> and the web client hands it straight back (browserFocusGuard);
    // without this, that hand-back would fire blur into the page and close
    // the menus and dropdowns the agent just opened. Not for a page set to
    // run in the background: see `setLifecycle`.
    const lifecycleState = lifecycles.get(webContentsId)?.state ?? "active";
    yield* sendCommand(contents, "Emulation.setFocusEmulationEnabled", {
      enabled: lifecycleState === "active",
    }).pipe(Effect.ignore);

    return buildStatus(webContentsId, contents);
  });

  /**
   * The tab, with a debugger certainly on it.
   *
   * Every operation goes through this rather than through `resolve`, because
   * the attachment can be taken away at any moment -- DevTools opening on the
   * page is enough -- and the alternative is a browser that works until it
   * quietly does not. Attaching is cheap when it is already attached.
   */
  /**
   * How each page runs, with a one-at-a-time lock per page so a freeze and a
   * wake asked for in quick succession land in that order.
   *
   * Focus emulation is what this turns on and off besides freezing. Chromium
   * implements it by counting the page as captured, and a captured page is a
   * visible one: it is never slowed when hidden, and a freeze is silently
   * ignored. So a page sent to the background loses it, and gets it back when
   * it is next shown or acted on.
   */
  /**
   * Each guest's frame numbers (the `2` in a ref `f2e7`), by frame id, and the
   * next number to give. Kept for the life of the guest, not of a debugger
   * attachment: DevTools opening and closing would otherwise start the count
   * again, and an old ref would name a new frame. A frame keeps its number
   * across snapshots; on a new page the numbers given so far are forgotten
   * and the count runs on.
   */
  const frameNumbering = new Map<
    number,
    { readonly ordinals: Map<string, number>; next: number }
  >();
  const frameNumberingOf = (webContentsId: number) => {
    let numbering = frameNumbering.get(webContentsId);
    if (numbering === undefined) {
      numbering = { ordinals: new Map(), next: 1 };
      frameNumbering.set(webContentsId, numbering);
    }
    return numbering;
  };

  const lifecycles = new Map<
    number,
    { state: DesktopPreviewLifecycleState; readonly lock: Semaphore.Semaphore }
  >();
  const lifecycleOf = (webContentsId: number) => {
    let entry = lifecycles.get(webContentsId);
    if (entry === undefined) {
      entry = { state: "active", lock: Semaphore.makeUnsafe(1) };
      lifecycles.set(webContentsId, entry);
    }
    return entry;
  };

  const setLifecycle = Effect.fn("PreviewAutomation.setLifecycle")(function* (
    webContentsId: number,
    state: DesktopPreviewLifecycleState,
  ) {
    yield* attach(webContentsId);
    const contents = yield* resolve(webContentsId);
    const entry = lifecycleOf(webContentsId);
    yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const from = entry.state;
        if (from === state) return;
        if (from === "frozen") {
          yield* sendCommand(contents, "Page.setWebLifecycleState", { state: "active" });
        }
        if ((from === "active") !== (state === "active")) {
          yield* sendCommand(contents, "Emulation.setFocusEmulationEnabled", {
            enabled: state === "active",
          });
        }
        if (state === "frozen") {
          yield* sendCommand(contents, "Page.setWebLifecycleState", { state: "frozen" });
        }
        entry.state = state;
      }),
    );
  });

  const resolveAttached = Effect.fn("PreviewAutomation.resolveAttached")(function* (
    webContentsId: number,
  ) {
    yield* attach(webContentsId);
    // A frozen page answers nothing, so a command for one would only time out,
    // and one without focus emulation can lose its menus to a blur. The panel
    // readies pages before acting on them; this is the backstop.
    if ((lifecycles.get(webContentsId)?.state ?? "active") !== "active") {
      yield* setLifecycle(webContentsId, "active");
    }
    return yield* resolve(webContentsId);
  });

  /** The centre of an element, in the page's top viewport. */
  const centerOf = Effect.fn("PreviewAutomation.centerOf")(function* (
    contents: WebContents,
    node: NodeRef,
  ) {
    const { backendNodeId, sessionId } = node;
    const box = (yield* sendCommand(
      contents,
      "DOM.getBoxModel",
      { backendNodeId },
      { sessionId },
    )) as {
      model?: { content?: ReadonlyArray<number> };
    };
    const quad = box.model?.content;
    if (quad === undefined || quad.length < 8) {
      return yield* Effect.fail(
        new PreviewCommandError({
          webContentsId: contents.id,
          method: "DOM.getBoxModel",
          cause: `element ${backendNodeId} has no layout box`,
        }),
      );
    }
    // Centre of the border box: the quad is four corner pairs, clockwise.
    const center = {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
    return yield* toPagePoint(contents, sessionId, center);
  });

  /**
   * A point in a frame's session out to the page's top viewport, frame by
   * frame through the elements the frames sit in (recorded by `snapshot`).
   * Input then goes through `routePoint`, as any point does, so it lands in
   * the frame the way a person's click would.
   */
  const toPagePoint = Effect.fn("PreviewAutomation.toPagePoint")(function* (
    contents: WebContents,
    sessionId: string | undefined,
    point: { readonly x: number; readonly y: number },
  ) {
    const owners = attached.get(contents.id)?.sessionOwners;
    let current = sessionId;
    let at = point;
    for (let depth = 0; current !== undefined; depth += 1) {
      const owner = owners?.get(current);
      if (owner === undefined || depth >= MAX_FRAME_DEPTH) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          "the frame this element is in has gone; take a new snapshot and try again",
        );
      }
      const box = (yield* sendCommand(
        contents,
        "DOM.getBoxModel",
        { backendNodeId: owner.ownerBackendNodeId },
        { sessionId: owner.parentSessionId },
      )) as { model?: { content?: ReadonlyArray<number> } };
      const quad = box.model?.content;
      const size = yield* frameViewportSize(contents, owner.frameId, current);
      if (quad === undefined || quad.length < 8 || size === null) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          "the frame this element is in did not say where it is; try again",
        );
      }
      at = applyAffine(frameToParentAffine(quad, size), at);
      current = owner.parentSessionId;
    }
    return at;
  });

  const targetPoint = Effect.fn("PreviewAutomation.targetPoint")(function* (
    contents: WebContents,
    target: PreviewAutomationTarget,
  ) {
    // A point is already the answer. Everything else has to be found first and
    // then reduced to its centre.
    if ("point" in target) {
      return target.point;
    }
    const node = yield* resolveNode(contents, target);
    return yield* centerOf(contents, node);
  });

  /**
   * A frame's own viewport size in its own CSS pixels, scrollbars included,
   * read in a world of the panel's own so the page cannot misreport it; null
   * when the frame does not answer promptly.
   */
  const frameViewportSize = Effect.fn("PreviewAutomation.frameViewportSize")(function* (
    contents: WebContents,
    frameId: string,
    sessionId: string,
  ) {
    const world = (yield* sendCommand(
      contents,
      "Page.createIsolatedWorld",
      { frameId, worldName: FRAME_METRICS_WORLD_NAME, grantUniveralAccess: false },
      { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
    ).pipe(Effect.orElseSucceed(() => null))) as { executionContextId?: number } | null;
    if (world?.executionContextId === undefined) return null;
    const read = (yield* sendCommand(
      contents,
      "Runtime.evaluate",
      {
        expression: "[innerWidth, innerHeight]",
        contextId: world.executionContextId,
        returnByValue: true,
      },
      { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
    ).pipe(Effect.orElseSucceed(() => null))) as { result?: { value?: unknown } } | null;
    const value = read?.result?.value;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [width, height] = value as ReadonlyArray<unknown>;
    return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
      ? { width, height }
      : null;
  });

  /**
   * Where agent mouse input at a point in the page goes: the session of the
   * frame under it, and how a page point maps into that frame.
   *
   * Chromium hands input sent to a page to the frame under the point by hit
   * testing the window, and the panel takes a page the user is not looking at
   * out of hit testing (`pointer-events: none` on its element, so the user's
   * own clicks pass through it to the app). A frame running in another
   * process is then out of reach: the input lands on the page's top document,
   * on the frame's element. So the point is followed down through such frames
   * here, and the input is sent straight into the innermost one through its
   * own session. Frames in the page's own process need nothing; the page's
   * input reaches them. Each frame's placement is followed whatever it is (an
   * offset, a CSS zoom, any transform), from the corners Chromium reports for
   * the frame's element and the frame's own size. Within a time budget: past
   * it the input goes to the page, as it did before frames were followed.
   */
  const routePoint = (contents: WebContents, point: { readonly x: number; readonly y: number }) => {
    // Hit test and input use the same pixel, so an overlay's edge cannot fall
    // between them.
    const at = { x: Math.round(point.x), y: Math.round(point.y) };
    return followFrames(contents, at).pipe(
      Effect.timeoutOrElse({
        duration: FRAME_ROUTE_BUDGET,
        orElse: () => Effect.succeed(pageRoute),
      }),
      Effect.map((route) => ({
        sessionId: route.sessionId,
        at: applyAffine(route.toFrame, at),
        toFrame: (page: { readonly x: number; readonly y: number }) =>
          applyAffine(route.toFrame, page),
      })),
    );
  };

  const followFrames = Effect.fn("PreviewAutomation.followFrames")(function* (
    contents: WebContents,
    point: { readonly x: number; readonly y: number },
  ) {
    const frameSessions = attached.get(contents.id)?.frameSessions;
    // A page with no such frames needs no looking.
    if (frameSessions === undefined || frameSessions.size === 0) return pageRoute;
    let route: FrameRoute = pageRoute;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
      const { sessionId } = route;
      const local = applyAffine(route.toFrame, point);
      // The hit test takes document coordinates: the viewport point plus how
      // far the frame is scrolled.
      const metrics = (yield* sendCommand(
        contents,
        "Page.getLayoutMetrics",
        {},
        { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
      ).pipe(Effect.orElseSucceed(() => null))) as {
        cssLayoutViewport?: { pageX?: number; pageY?: number };
      } | null;
      const hit = (yield* sendCommand(
        contents,
        "DOM.getNodeForLocation",
        {
          x: Math.round(local.x + (metrics?.cssLayoutViewport?.pageX ?? 0)),
          y: Math.round(local.y + (metrics?.cssLayoutViewport?.pageY ?? 0)),
        },
        { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
      ).pipe(Effect.orElseSucceed(() => null))) as { backendNodeId?: number } | null;
      if (hit?.backendNodeId === undefined) break;
      const backendNodeId = hit.backendNodeId;
      const described = (yield* sendCommand(
        contents,
        "DOM.describeNode",
        { backendNodeId },
        { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
      ).pipe(Effect.orElseSucceed(() => null))) as {
        node?: { nodeName?: string; frameId?: string };
      } | null;
      // Only a frame's element leads into it: a document's root element
      // carries its own frame's id too.
      const node = described?.node;
      if (node?.frameId === undefined || !FRAME_OWNER_NODE_NAMES.has(node.nodeName ?? "")) break;
      const frameId = node.frameId;
      const frameSession = frameSessions.get(frameId);
      if (frameSession === undefined || visited.has(frameSession)) break;
      const box = (yield* sendCommand(
        contents,
        "DOM.getBoxModel",
        { backendNodeId },
        { sessionId, timeout: FRAME_ROUTE_TIMEOUT },
      ).pipe(Effect.orElseSucceed(() => null))) as {
        model?: { content?: ReadonlyArray<number> };
      } | null;
      const quad = box?.model?.content;
      if (quad === undefined || quad.length < 8) break;
      // Without the frame's own size its placement is unknown: the input
      // stops at the frame mapped so far rather than guess.
      const size = yield* frameViewportSize(contents, frameId, frameSession);
      if (size === null) break;
      const into = frameAffine(quad, size);
      if (into === null) break;
      route = { sessionId: frameSession, toFrame: composeAffine(into, route.toFrame) };
      visited.add(frameSession);
    }
    return route;
  });

  const expectAgentInput = (webContentsId: number, kind: "mouseDown" | "mouseWheel") => {
    attached.get(webContentsId)?.expectedAgentInputs.push({ kind, expiresAt: Date.now() + 1_000 });
  };

  return PreviewAutomation.of({
    attach,
    detach: (webContentsId: number) =>
      Effect.sync(() => {
        const tab = attached.get(webContentsId);
        if (tab === undefined) return;
        tab.dispose();
        attached.delete(webContentsId);
        if (!tab.contents.isDestroyed() && tab.contents.debugger.isAttached()) {
          tab.contents.debugger.detach();
        }
      }),
    setNavigationPolicy: Effect.fn("PreviewAutomation.setNavigationPolicy")(function* (
      webContentsId: number,
      access: BrowserSiteAccess,
    ) {
      const contents = yield* resolve(webContentsId);
      const before = accessBySession.get(contents.session)?.trustedCertificates ?? [];
      ensureNavigationGuard(contents).access = access;
      accessBySession.set(contents.session, access);
      // Trust taken back. Connections made under it stay open and Chromium
      // reuses them without asking again, so the profile's connections close
      // and the next load is asked about afresh.
      if (
        before.some((entry) => !isBrowserCertificateTrusted(entry.host, entry.fingerprint, access))
      ) {
        yield* Effect.promise(() => contents.session.closeAllConnections());
      }
    }),
    guardPopup: Effect.fn("PreviewAutomation.guardPopup")(function* (
      openerWebContentsId: number,
      popup: WebContents,
      onRefused: (url: string, host: string) => void,
    ) {
      const opener = yield* resolve(openerWebContentsId);
      // The opener's own guard object, not a copy: a policy pushed to the page
      // later is the pop-up's policy too.
      armNavigationGuard(popup, ensureNavigationGuard(opener), onRefused, true);
    }),
    allowSite: Effect.fn("PreviewAutomation.allowSite")(function* (
      webContentsId: number,
      host: string,
      allowAll: boolean,
    ) {
      const contents = yield* resolve(webContentsId);
      const guard = ensureNavigationGuard(contents);
      const access: BrowserSiteAccess = allowAll
        ? { ...guard.access, allowAll: true }
        : { ...guard.access, approvedHosts: withBrowserApproval(guard.access.approvedHosts, host) };
      guard.access = access;
      accessBySession.set(contents.session, access);
    }),
    status: Effect.fn("PreviewAutomation.status")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      return buildStatus(webContentsId, contents);
    }),
    snapshot: Effect.fn("PreviewAutomation.snapshot")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      // Playwright's aria snapshot rather than our own walk of the CDP tree.
      // Ours kept actionable and landmark nodes that had an accessible name,
      // which meant an agent could see every button on a page and not one word
      // of what the page said -- asked what a paragraph read, it had to fall
      // back to running JavaScript. This carries the text, the structure and a
      // ref on everything, in one string that costs less than the array did.
      //
      // Frames are read too, each in the engine running inside it, and nested
      // under the frame's own line; their refs carry the frame's number.
      const tab = attached.get(contents.id);
      const page =
        tab === undefined
          ? ""
          : yield* snapshotFrame(contents, tab, undefined, 0, {
              deadline: Date.now() + SNAPSHOT_FRAMES_BUDGET_MS,
              frames: 0,
            });
      return { ...buildStatus(webContentsId, contents), page };
    }),
    setViewport: Effect.fn("PreviewAutomation.setViewport")(function* (
      webContentsId: number,
      size: { width: number | null; height: number | null },
    ) {
      const contents = yield* resolveAttached(webContentsId);
      // Resizing the element alone leaves the page believing it is still the
      // old size: media queries do not re-evaluate and innerWidth is unchanged,
      // so a narrow frame just clips a desktop layout instead of showing the
      // mobile one. Overriding the metrics is what device mode actually is.
      if (size.width === null || size.height === null) {
        yield* sendCommand(contents, "Emulation.clearDeviceMetricsOverride", {});
        return;
      }
      yield* sendCommand(contents, "Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        // Zero means "use the host's", which keeps text crisp on a retina
        // display rather than rendering the page at 1x.
        deviceScaleFactor: 0,
        mobile: false,
      });
    }),
    /**
     * Uses DevTools' own element picker rather than injecting a script into the
     * page. The guest keeps its preload stripped and context isolation intact,
     * and the highlight the user sees while choosing is Chromium's, so it
     * behaves exactly as it does in DevTools.
     */
    pickElement: Effect.fn("PreviewAutomation.pickElement")(function* (
      webContentsId: number,
      colorScheme: "light" | "dark",
      mode: DesktopPreviewPickMode,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      let supersede = () => {};
      const token = { supersede: () => supersede() };
      pendingPicks.get(webContentsId)?.supersede();
      pendingPicks.set(webContentsId, token);

      yield* sendCommand(contents, "DOM.enable", {});
      yield* sendCommand(contents, "Runtime.enable", {});
      // The binding is how the injected overlay reports back. Adding it twice
      // is harmless, and it must exist before the script that calls it runs.
      yield* sendCommand(contents, "Runtime.addBinding", {
        name: PICK_OVERLAY_BINDING,
      }).pipe(Effect.ignore);

      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: buildPickOverlayScript(colorScheme, mode),
      });

      // The wait is a loop rather than one promise, because the overlay now
      // speaks twice: once when elements are chosen -- so they can be described
      // while they still exist -- and once when the note is settled. Between
      // the two the page is free to die (a dev server reloading it, most
      // often), and the early description is what lets the annotation survive
      // that. No timeout: writing a note takes as long as it takes, and an
      // armed pick is settled by escape, by another tool, or by the page
      // itself navigating away before anything was chosen.
      type PickEvent =
        | { readonly kind: "chosen"; readonly count: number }
        | { readonly kind: "final"; readonly result: PickResult | null };
      const eventQueue: PickEvent[] = [];
      let closed = false;
      let notifyWaiter: (() => void) | null = null;
      const push = (event: PickEvent) => {
        if (closed) return;
        eventQueue.push(event);
        notifyWaiter?.();
      };
      const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
        if (method === "Page.frameNavigated") {
          const frame = params.frame as { parentId?: string } | undefined;
          // Main frame only. The document the overlay lived in is gone; any
          // last words it had (the pagehide auto-attach below) arrive on this
          // same ordered stream before this does, so a note in progress is
          // already in the queue and this settles only a truly idle pick.
          if (frame?.parentId === undefined) {
            push({ kind: "final", result: null });
          }
          return;
        }
        if (method !== "Runtime.bindingCalled" || params.name !== PICK_OVERLAY_BINDING) {
          return;
        }
        try {
          const payload = JSON.parse(String(params.payload ?? "{}")) as {
            chosen?: number;
            count?: number;
            note?: string | null;
            styleChanges?: ReadonlyArray<{ property: string; from: string; to: string }>;
            cancelled?: boolean;
          };
          if (typeof payload.chosen === "number") {
            push({ kind: "chosen", count: payload.chosen });
            return;
          }
          push({
            kind: "final",
            result:
              payload.cancelled === true || payload.count === undefined || payload.count < 1
                ? null
                : {
                    count: payload.count,
                    note: payload.note ?? null,
                    styleChanges: payload.styleChanges ?? [],
                  },
          });
        } catch {
          push({ kind: "final", result: null });
        }
      };
      contents.debugger.on("message", onMessage);
      // Reaching for another tool settles this one, rather than leaving it
      // waiting on a binding that will never be called.
      supersede = () => {
        pendingPicks.delete(webContentsId);
        push({ kind: "final", result: null });
      };
      const nextEvent = () =>
        new Promise<PickEvent>((resolve) => {
          const take = () => {
            const event = eventQueue.shift();
            if (event === undefined) {
              notifyWaiter = take;
              return;
            }
            notifyWaiter = null;
            resolve(event);
          };
          take();
        });

      let earlyDescribed: DesktopPreviewPickedElement[] = [];
      let picked: PickResult | null = null;
      for (;;) {
        const event = yield* Effect.promise(() => nextEvent());
        if (event.kind === "chosen") {
          earlyDescribed = yield* describeStashed(contents, PICK_OVERLAY_STASH, event.count).pipe(
            Effect.orElseSucceed(() => []),
          );
          continue;
        }
        picked = event.result;
        break;
      }
      closed = true;
      contents.debugger.off("message", onMessage);

      // A superseded pick owns nothing on the page any more: its overlay was
      // replaced, and tearing down would take its replacement with it.
      const current = pendingPicks.get(webContentsId) === token;
      if (current) {
        pendingPicks.delete(webContentsId);
      }

      // Described before the teardown runs, because the teardown is what drops
      // the overlay's handles on the elements it chose.
      const described: DesktopPreviewPickedElement[] = [];
      if (current && picked !== null) {
        let elements = yield* describeStashed(contents, PICK_OVERLAY_STASH, picked.count).pipe(
          Effect.orElseSucceed((): DesktopPreviewPickedElement[] => []),
        );
        // Fewer than were chosen means the document died with the stash --
        // the note arrived from pagehide -- and the descriptions taken at
        // choose time are the ones that still know the elements.
        if (elements.length < picked.count && earlyDescribed.length > elements.length) {
          elements = earlyDescribed;
        }
        for (const element of elements) {
          described.push({
            ...element,
            note: picked.note,
            // Attached to the element they were made on. A region shares one
            // note but tweaks only ever apply to a lone element, so this is
            // never spread across a set.
            styleChanges: picked.styleChanges,
          });
        }
      }

      if (current) {
        yield* sendCommand(contents, "Runtime.evaluate", {
          expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
        }).pipe(Effect.ignore);
      }

      return described;
    }),
    awaitDrawing: Effect.fn("PreviewAutomation.awaitDrawing")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      yield* sendCommand(contents, "DOM.enable", {});
      yield* sendCommand(contents, "Runtime.enable", {});
      yield* sendCommand(contents, "Runtime.addBinding", {
        name: DRAW_OVERLAY_BINDING,
      }).pipe(Effect.ignore);

      const attached = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ note: string | null; count: number } | null>((settle) => {
            let done = false;
            const finish = (value: { note: string | null; count: number } | null) => {
              if (done) return;
              done = true;
              contents.debugger.off("message", onMessage);
              settle(value);
            };
            const onMessage = (
              _event: unknown,
              method: string,
              params: Record<string, unknown>,
            ) => {
              if (method !== "Runtime.bindingCalled" || params.name !== DRAW_OVERLAY_BINDING) {
                return;
              }
              try {
                const payload = JSON.parse(String(params.payload ?? "{}")) as {
                  note?: string | null;
                  count?: number;
                  cancelled?: boolean;
                };
                finish(
                  payload.cancelled === true
                    ? null
                    : { note: payload.note ?? null, count: payload.count ?? 0 },
                );
              } catch {
                finish(null);
              }
            };
            contents.debugger.on("message", onMessage);
            // No timeout: unlike a pick, drawing is not a question waiting on an
            // answer. The mode stays armed until the user puts the pen down,
            // and turning it off is what cancels this.
            drawWaiters.set(webContentsId, () => finish(null));
          }),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "Runtime.bindingCalled", cause }),
      });
      drawWaiters.delete(webContentsId);
      if (attached === null) {
        return null;
      }

      // Described while the ink is still up, because the caller photographs the
      // page next and the strokes have to be in the picture.
      const elements = yield* describeStashed(contents, DRAW_OVERLAY_STASH, attached.count);
      return {
        note: attached.note,
        elements: elements.map((element) => ({ ...element, note: attached.note })),
      } satisfies DesktopPreviewDrawing;
    }),
    setAnnotationMode: Effect.fn("PreviewAutomation.setAnnotationMode")(function* (
      webContentsId: number,
      mode: DesktopPreviewAnnotationMode | null,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      if (mode === null || mode === "idle") {
        // Clearing the marks is how a drawing is abandoned and parking them is
        // how it is set aside; either way whoever is waiting on one has to stop
        // waiting rather than outlive the pen. Coming back to it starts a new
        // wait, and the ink is still there to attach.
        drawWaiters.get(webContentsId)?.();
      }
      // Nothing is read back, so this is a plain evaluation rather than the
      // binding round trip picking needs.
      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: mode === null ? DRAW_OVERLAY_TEARDOWN_SCRIPT : buildDrawOverlayScript(mode),
      });
    }),
    revealElement: Effect.fn("PreviewAutomation.revealElement")(function* (
      webContentsId: number,
      selector: string,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      const result = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression: buildRevealElementScript(selector),
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value === true;
    }),
    cancelPick: Effect.fn("PreviewAutomation.cancelPick")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      pendingPicks.get(webContentsId)?.supersede();
      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
      }).pipe(Effect.ignore);
    }),
    setLifecycle,
    memory: Effect.sync(() => {
      // Every guest here is a browser page: the window refuses any other
      // webview at attach.
      const byProcess = new Map<number, number[]>();
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed() || contents.getType() !== "webview") continue;
        const pid = contents.getOSProcessId();
        const ids = byProcess.get(pid) ?? [];
        ids.push(contents.id);
        byProcess.set(pid, ids);
      }
      const metrics = app.getAppMetrics();
      return {
        processes: [...byProcess].map(([pid, webContentsIds]) => ({
          pid,
          workingSetKb: metrics.find((metric) => metric.pid === pid)?.memory.workingSetSize ?? 0,
          webContentsIds,
        })),
      };
    }),
    setColorScheme: Effect.fn("PreviewAutomation.setColorScheme")(function* (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) {
      const contents = yield* resolveAttached(webContentsId);
      // Emulated rather than set on the guest: the page decides what to do with
      // prefers-color-scheme, and pages that ignore it are left alone.
      yield* sendCommand(contents, "Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    }),
    openDevTools: Effect.fn("PreviewAutomation.openDevTools")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      // Undocked: the guest is a small pane inside our layout, and devtools
      // docked into it would leave almost nothing of the page visible.
      yield* Effect.sync(() => {
        contents.openDevTools({ mode: "detach" });
      });
    }),
    screenshot: Effect.fn("PreviewAutomation.screenshot")(function* (
      input: DesktopPreviewScreenshotInput,
    ) {
      const contents = yield* resolveAttached(input.webContentsId);
      const forAgent = input.forAgent === true;
      // Captured through CDP rather than capturePage so the image is the page
      // itself, whether the window is covered, minimised or hidden. Not while
      // the screen is locked: nothing is painted, and the capture would wait
      // until the user is back. So then it gets a short wait, and an answer
      // that says why.
      const lockedAtStart = isScreenLocked();
      const shot = (yield* sendCommand(
        contents,
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false,
          // An agent's picture is decoded and re-encoded below, so a quicker,
          // larger PNG is the better trade: on a busy page it holds up the
          // main process for a fraction as long.
          ...(forAgent ? { optimizeForSpeed: true } : {}),
        },
        {
          timeout: lockedAtStart ? LOCKED_CAPTURE_TIMEOUT : CDP_COMMAND_TIMEOUT,
          timedOut: () => (lockedAtStart || isScreenLocked() ? SCREEN_LOCKED : PAGE_DID_NOT_ANSWER),
        },
      )) as { data?: string };
      const metrics = (yield* sendCommand(contents, "Page.getLayoutMetrics", {})) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      const width = Math.round(metrics.cssVisualViewport?.clientWidth ?? 0);
      const height = Math.round(metrics.cssVisualViewport?.clientHeight ?? 0);
      if (!forAgent) {
        return { dataUrl: `data:image/png;base64,${shot.data ?? ""}`, width, height };
      }
      // Read in the injected world, where the page cannot redefine it.
      const ratio = yield* evaluateInjected(contents, "window.devicePixelRatio", {
        returnByValue: true,
      });
      const devicePixelRatio = typeof ratio.value === "number" ? ratio.value : 0;
      return {
        ...encodeForAgent(shot.data ?? "", devicePixelRatio, input.jpeg === true),
        width,
        height,
      };
    }),
    click: Effect.fn("PreviewAutomation.click")(function* (input: DesktopPreviewClickInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const point = yield* targetPoint(contents, input.target);
      const route = yield* routePoint(contents, point);
      const at = route.at;
      const clickCount = input.doubleClick === true ? 2 : 1;
      expectAgentInput(contents.id, "mouseDown");
      // Real input events rather than element.click(): hover, focus and blur
      // fire as they would for a person, and a handler that checks isTrusted
      // behaves the same way too.
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount },
        { sessionId: route.sessionId },
      );
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount },
        { sessionId: route.sessionId },
      );
      return point;
    }),
    move: Effect.fn("PreviewAutomation.move")(function* (input: DesktopPreviewMoveInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const point = yield* targetPoint(contents, input.target);
      const route = yield* routePoint(contents, point);
      const at = route.at;
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: at.x, y: at.y },
        { sessionId: route.sessionId },
      );
      return point;
    }),
    drag: Effect.fn("PreviewAutomation.drag")(function* (input: DesktopPreviewDragInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const from = yield* targetPoint(contents, input.from);
      const to = yield* targetPoint(contents, input.to);
      // The whole drag goes to the frame it starts in, as a held button
      // keeps a person's drag there, even past its edge.
      const route = yield* routePoint(contents, from);
      const start = route.at;
      const end = route.toFrame(to);
      expectAgentInput(contents.id, "mouseDown");
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1 },
        { sessionId: route.sessionId },
      );
      for (let step = 1; step <= DRAG_MOVE_STEPS; step += 1) {
        const progress = step / DRAG_MOVE_STEPS;
        yield* sendCommand(
          contents,
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            button: "left",
            buttons: 1,
          },
          { sessionId: route.sessionId },
        );
      }
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 },
        { sessionId: route.sessionId },
      );
      return { from, to };
    }),
    // Into whatever the page has focused: the renderer clicks the field first,
    // as its own step, so the page needs the keyboard only for the keys.
    type: Effect.fn("PreviewAutomation.type")(function* (input: DesktopPreviewTypeInput) {
      yield* agentKeys(input.webContentsId, input.controlEpoch, (send) =>
        Effect.gen(function* () {
          if (input.clear === true) {
            // `commands` invokes the editing command directly, which is what a
            // modifier chord ultimately triggers. Dispatching Meta+A as a raw key
            // does not: the browser resolves shortcuts to editing commands above
            // the layer CDP injects at, so the keypress arrives and selects
            // nothing, and the insert below lands wherever the caret happened to
            // be -- mid-word, since a click centres it.
            yield* send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "a",
              code: "KeyA",
              windowsVirtualKeyCode: 65,
              commands: ["selectAll"],
            });
            yield* send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "a",
              code: "KeyA",
              windowsVirtualKeyCode: 65,
            });
          }
          yield* send("Input.insertText", { text: input.text });
          if (input.submit === true) {
            const enter = toCdpKeyDefinition("Enter");
            yield* send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
            const { text: _text, ...releasedEnter } = enter;
            yield* send("Input.dispatchKeyEvent", { type: "keyUp", ...releasedEnter });
          }
        }),
      );
    }),
    press: Effect.fn("PreviewAutomation.press")(function* (input: DesktopPreviewPressInput) {
      const definition = toCdpKeyDefinition(input.key);
      const modifiers = toCdpModifierBitmask(input.modifiers);
      yield* agentKeys(input.webContentsId, input.controlEpoch, (send) =>
        Effect.gen(function* () {
          yield* send("Input.dispatchKeyEvent", { type: "keyDown", ...definition, modifiers });
          const { text: _text, ...releasedDefinition } = definition;
          yield* send("Input.dispatchKeyEvent", {
            type: "keyUp",
            ...releasedDefinition,
            modifiers,
          });
        }),
      );
    }),
    scroll: Effect.fn("PreviewAutomation.scroll")(function* (input: DesktopPreviewScrollInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      if (input.target !== undefined) {
        const node = yield* resolveNode(contents, input.target);
        yield* sendCommand(
          contents,
          "DOM.scrollIntoViewIfNeeded",
          { backendNodeId: node.backendNodeId },
          { sessionId: node.sessionId },
        );
        return;
      }

      const metrics = (yield* sendCommand(contents, "Page.getLayoutMetrics", {})) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      const center = {
        x: (metrics.cssVisualViewport?.clientWidth ?? 0) / 2,
        y: (metrics.cssVisualViewport?.clientHeight ?? 0) / 2,
      };
      const route = yield* routePoint(contents, center);
      const at = route.at;
      expectAgentInput(contents.id, "mouseWheel");
      yield* sendCommand(
        contents,
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0,
        },
        { sessionId: route.sessionId },
      );
    }),
    evaluate: Effect.fn("PreviewAutomation.evaluate")(function* (
      input: DesktopPreviewEvaluateInput,
    ) {
      const contents = yield* resolveAttached(input.webContentsId);
      const result = (yield* sendCommand(
        contents,
        "Runtime.evaluate",
        {
          expression: input.expression,
          returnByValue: true,
          awaitPromise: true,
        },
        { timeout: AGENT_SCRIPT_TIMEOUT },
      )) as {
        result?: { value?: unknown };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string; value?: unknown };
        };
      };
      if (result.exceptionDetails !== undefined) {
        const exception = result.exceptionDetails.exception;
        const detail =
          exception?.description ??
          (exception?.value === undefined ? undefined : String(exception.value)) ??
          result.exceptionDetails.text ??
          "the expression threw an exception";
        return yield* failCommand(contents, "Runtime.evaluate", detail);
      }
      return result.result?.value;
    }),
    waitFor: Effect.fn("PreviewAutomation.waitFor")(function* (input: DesktopPreviewWaitForInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      // The same number the broker built this call's deadline from, so the
      // wait always gives up before the agent is told it timed out.
      const timeoutMs = normalizePreviewWaitForTimeoutMs(input.timeoutMs);
      const startedAt = Date.now();
      let unmet: string[] = [];

      while (true) {
        unmet = [];

        if (input.target !== undefined) {
          const found = yield* resolveNode(contents, input.target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!found) {
            unmet.push(`target ${targetDescription(input.target)}`);
          }
        }

        if (input.text !== undefined) {
          const textResult = (yield* sendCommand(contents, "Runtime.evaluate", {
            expression: `Boolean(document.body?.innerText.includes(${JSON.stringify(input.text)}))`,
            returnByValue: true,
          }).pipe(Effect.orElseSucceed(() => ({ result: { value: false } })))) as {
            result?: { value?: unknown };
          };
          if (textResult.result?.value !== true) {
            unmet.push(`page text ${JSON.stringify(input.text)}`);
          }
        }

        if (input.urlContains !== undefined && !contents.getURL().includes(input.urlContains)) {
          unmet.push(`URL containing ${JSON.stringify(input.urlContains)}`);
        }

        if (unmet.length === 0) {
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          return yield* failCommand(
            contents,
            "waitFor",
            `timed out after ${timeoutMs}ms; these conditions never became true together: ${unmet.join(", ")}`,
          );
        }

        yield* Effect.sleep("150 millis");
      }
    }),
  });
}).pipe(Effect.withSpan("PreviewAutomation.make"));

export const layer = Layer.effect(PreviewAutomation, make);
