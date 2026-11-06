/**
 * Runs a theme's live art behind the window (docs/design/custom-themes.md,
 * "The backdrop runtime" and "Performance"), from the app's side: it mounts
 * the backdrop host while the active theme has art, and feeds it what it
 * needs, all computed here from the live app:
 *
 * - zones: the calm areas to frost, from the layout (backdropZones.ts),
 *   remeasured when it changes, at most every 100 ms;
 * - conditions: motion (the Motion setting, Reduce Motion, the desktop
 *   watchdog), visibility (the window, and whether a chat is on screen),
 *   busy (scrolling, typing, resizing, dragging, a reply streaming into the
 *   open thread), idle (two minutes without input or agent work), power and
 *   heat (desktop, else the Battery API);
 * - activity: working and waiting agents across every computer, and a
 *   `turn-done` pulse whenever a thread stops working.
 *
 * It also sets the glass tints index.css paints when the art isn't running
 * (glass.ts), and keeps the host's status in the theme store.
 */
import type {
  BackdropActivity,
  BackdropConditions,
  DesktopPowerState,
  EnvironmentId,
  ThemeBase,
  ThemeManifest,
  ThreadId,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";
import { useMatches } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  ThemeBackdropHost,
  type ThemeBackdropHostHandle,
} from "../components/theme/backdrop/ThemeBackdropHost";
import { useIsMobile, useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import {
  selectRunningSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import { resolveThreadRouteRef } from "../threadRoutes";
import {
  measureBackdropZones,
  type MeasuredBackdropLayout,
  sameBackdropZones,
} from "./backdropZones";
import { cssGlassTints, glassFloors, glassTintCss } from "./glass";
import { applyGlassTints } from "./themeApply";
import {
  chooseTheme,
  readThemeState,
  reportBackdropTooHeavy,
  setBackdropStatus,
  subscribeTheme,
  useActiveTheme,
  useBackdropGeneration,
  useBackdropTooHeavy,
} from "./themeStore";

const ZONE_MIN_INTERVAL_MS = 100;
/** Remeasure once more after this, for layout that moves by transition (the list's slide). */
const ZONE_SETTLE_MS = 300;
/** Input this recent counts as busy; the runtime adds its own 400 ms hold. */
const BUSY_QUIET_MS = 150;
const IDLE_AFTER_MS = 2 * 60 * 1000;
const IDLE_CHECK_MS = 15_000;

let hostHandle: ThemeBackdropHostHandle | null = null;

/** A PNG data URL of the running art at this size, or null when no art runs. */
export function captureActiveBackdropStill(width: number, height: number): Promise<string> | null {
  return hostHandle ? hostHandle.captureStill(width, height) : null;
}

/**
 * Mounted in the app shell's root: the backdrop while the active theme has
 * art.
 */
export function ThemeRuntime() {
  const active = useActiveTheme();
  const generation = useBackdropGeneration();
  const manifest = active.manifest;
  const hasArt = manifest?.backdrop !== undefined && manifest.glass !== undefined;

  useEffect(() => {
    if (!hasArt) applyGlassTints(null);
  }, [hasArt]);

  if (!hasArt || !manifest || !active.tokens || !active.hash) return null;
  return (
    <ThemeBackdropLayer
      key={`${active.hash}:${generation}`}
      manifest={manifest}
      tokens={active.tokens}
      base={active.base}
      hash={active.hash}
    />
  );
}

/**
 * The desktop's theme events, for the app root on every page (sign-in and
 * setup included): View › Reset Theme, and the CPU watchdog's verdict.
 */
export function useDesktopThemeEvents(): void {
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Not a menu action: those wait for the shell to listen, and the escape
    // hatch must reach a page whose shell never got that far.
    const stopReset = bridge.onThemeReset?.(() => chooseTheme({ kind: "builtin", id: "system" }));
    const stopWatchdog = bridge.onBackdropTooHeavy?.(() => reportBackdropTooHeavy());
    return () => {
      stopReset?.();
      stopWatchdog?.();
    };
  }, []);
}

function ThemeBackdropLayer(props: {
  readonly manifest: ThemeManifest;
  readonly tokens: ThemeTokens;
  readonly base: ThemeBase;
  readonly hash: string;
}) {
  const { manifest, tokens, base } = props;
  const backdrop = manifest.backdrop!;
  const glass = manifest.glass!;
  const artInThreads = useSettings((settings) => settings.themeArtInThreads);
  const motionSetting = useSettings((settings) => settings.themeMotion);
  const floors = useMemo(() => glassFloors(glass, artInThreads), [glass, artInThreads]);
  const status = useSyncExternalStore(subscribeTheme, () => readThemeState().backdropStatus);
  const tooHeavy = useBackdropTooHeavy();
  const stillOnly = useIsMobile();

  // The tints the surfaces paint themselves while the art isn't running.
  const tintCss = glassTintCss(cssGlassTints(floors, status, tooHeavy));
  useLayoutEffect(() => {
    applyGlassTints(tintCss);
  }, [tintCss]);
  // A layout cleanup: a theme switch unmounts this layer and mounts the next
  // in one commit, and this must run before the next one's setup, not after.
  // (The store clears the host's status itself whenever the theme changes.)
  useLayoutEffect(() => () => applyGlassTints(null), []);

  const layout = useBackdropLayout(tokens, floors);
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-glass-page", layout.chatShown ? "chat" : "page");
    return () => document.documentElement.removeAttribute("data-glass-page");
  }, [layout.chatShown]);

  const { activity, pulse } = useBackdropActivity();
  const conditions = useBackdropConditions({
    motionSetting,
    tooHeavy,
    chatShown: layout.chatShown,
    working: activity.working,
  });

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.setBackdropActive) return;
    void bridge.setBackdropActive(true).catch(() => {});
    return () => {
      void bridge.setBackdropActive?.(false).catch(() => {});
    };
  }, []);

  const hostRef = useRef<ThemeBackdropHostHandle | null>(null);
  useEffect(() => {
    hostHandle = hostRef.current;
    return () => {
      if (hostHandle === hostRef.current) hostHandle = null;
    };
  });

  return createPortal(
    // Behind everything: body is clear under glass, and nothing above this
    // stacking level is positioned below zero.
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
      <ThemeBackdropHost
        ref={hostRef}
        themeKey={props.hash}
        backdrop={backdrop}
        base={base}
        tokens={tokens}
        blur={glass.blur}
        zones={layout.zones}
        conditions={conditions}
        activity={activity}
        pulse={pulse}
        stillOnly={stillOnly}
        onStatus={setBackdropStatus}
      />
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Zones

const EMPTY_LAYOUT: MeasuredBackdropLayout = { zones: [], chatShown: true };

const MEASURED_SELECTORS = [
  '[data-slot="app-titlebar"]',
  '[data-slot="navigation-rail"]',
  '[data-slot="app-panel"]',
  '[data-slot="sidebar-inner"]',
  "[data-chat-column]",
  "[data-chat-composer-form]",
  "[data-draft-hero]",
  "[data-empty-home]",
  "[data-chat-right-panel]",
  '[data-testid="browser-panel"]',
  ".thread-terminal-drawer",
].join(", ");

function useBackdropLayout(
  tokens: ThemeTokens,
  floors: ReturnType<typeof glassFloors>,
): MeasuredBackdropLayout {
  const [layout, setLayout] = useState<MeasuredBackdropLayout>(EMPTY_LAYOUT);

  useEffect(() => {
    let frame = 0;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let lastRun = -Infinity;
    const observed = new Set<Element>();

    const measure = () => {
      frame = 0;
      lastRun = performance.now();
      const next = measureBackdropZones(
        document,
        { width: window.innerWidth, height: window.innerHeight },
        tokens,
        floors,
      );
      setLayout((previous) =>
        previous.chatShown === next.chatShown && sameBackdropZones(previous.zones, next.zones)
          ? previous
          : next,
      );
      // Watch the boxes the zones come from; only new ones, since observing
      // reports each element once.
      const current = new Set(document.querySelectorAll(MEASURED_SELECTORS));
      for (const element of observed) {
        if (!current.has(element)) {
          resizeObserver.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of current) {
        if (!observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
    };
    const run = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const schedule = () => {
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        run();
      }, ZONE_SETTLE_MS);
      if (frame !== 0 || waiting !== null) return;
      const wait = ZONE_MIN_INTERVAL_MS - (performance.now() - lastRun);
      if (wait <= 0) {
        run();
        return;
      }
      waiting = setTimeout(() => {
        waiting = null;
        run();
      }, wait);
    };

    const resizeObserver = new ResizeObserver(schedule);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "data-sidebar-state",
        "data-draft-hero",
        "data-chat-composer-mobile-collapsed",
        "hidden",
      ],
    });
    window.addEventListener("resize", schedule);
    // The new-thread screen scrolls as one, carrying its patch with it.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    // Text that rises into place (the home screen's) settles where its patch belongs.
    document.addEventListener("animationend", schedule);
    measure();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (waiting !== null) clearTimeout(waiting);
      if (settle !== null) clearTimeout(settle);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("animationend", schedule);
    };
  }, [tokens, floors]);

  return layout;
}

// ---------------------------------------------------------------------------
// Conditions

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    () => document.visibilityState === "visible",
  );
}

/** The window is the one in front (the art runs at the theme's own rate). */
function useWindowFocused(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("focus", listener);
      window.addEventListener("blur", listener);
      return () => {
        window.removeEventListener("focus", listener);
        window.removeEventListener("blur", listener);
      };
    },
    () => document.hasFocus(),
  );
}

/** Raw busy: input or layout work within the last moment, or a reply streaming in the open thread. */
function useBusy(): boolean {
  const [inputBusy, setInputBusy] = useState(false);
  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    const mark = () => {
      if (!busy) {
        busy = true;
        setInputBusy(true);
      }
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(() => {
        quiet = null;
        busy = false;
        setInputBusy(false);
      }, BUSY_QUIET_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      // Dragging: a divider, the list's edge, a selection.
      if (event.buttons !== 0) mark();
    };
    const options = { capture: true, passive: true } as const;
    document.addEventListener("scroll", mark, options);
    document.addEventListener("wheel", mark, options);
    document.addEventListener("keydown", mark, options);
    document.addEventListener("input", mark, options);
    document.addEventListener("pointermove", onPointerMove, options);
    window.addEventListener("resize", mark);
    return () => {
      if (quiet !== null) clearTimeout(quiet);
      document.removeEventListener("scroll", mark, options);
      document.removeEventListener("wheel", mark, options);
      document.removeEventListener("keydown", mark, options);
      document.removeEventListener("input", mark, options);
      document.removeEventListener("pointermove", onPointerMove, options);
      window.removeEventListener("resize", mark);
    };
  }, []);

  const openThreadKey = useMatches({
    select: (matches) => {
      const leaf = matches.at(-1);
      if (leaf?.routeId !== "/_chat/$environmentId/$threadId") return null;
      const ref = resolveThreadRouteRef(leaf.params);
      return ref ? `${ref.environmentId}\u0000${ref.threadId}` : null;
    },
  });
  const openThreadRef = useMemo(() => {
    if (openThreadKey === null) return null;
    const [environmentId, threadId] = openThreadKey.split("\u0000");
    return environmentId && threadId
      ? scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId)
      : null;
  }, [openThreadKey]);
  const streaming = useStore((state) =>
    openThreadRef === null
      ? false
      : selectThreadByRef(state, openThreadRef)?.messages.at(-1)?.streaming === true,
  );
  return inputBusy || streaming;
}

function useIdle(working: number): boolean {
  const [idle, setIdle] = useState(false);
  const lastInputRef = useRef(0);
  useEffect(() => {
    lastInputRef.current = Date.now();
    const note = () => {
      lastInputRef.current = Date.now();
      setIdle(false);
    };
    const options = { capture: true, passive: true } as const;
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const type of events) document.addEventListener(type, note, options);
    const timer = setInterval(() => {
      setIdle(Date.now() - lastInputRef.current >= IDLE_AFTER_MS);
    }, IDLE_CHECK_MS);
    return () => {
      for (const type of events) document.removeEventListener(type, note, options);
      clearInterval(timer);
    };
  }, []);
  return idle && working === 0;
}

const UNKNOWN_POWER: DesktopPowerState = {
  power: "unknown",
  thermal: "unknown",
  speedLimited: false,
};

interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
}

function usePowerState(): DesktopPowerState {
  const [state, setState] = useState<DesktopPowerState>(UNKNOWN_POWER);
  useEffect(() => {
    let cancelled = false;
    const bridge = window.desktopBridge;
    if (bridge?.getPowerState) {
      void bridge.getPowerState().then(
        (next) => {
          if (!cancelled) setState(next);
        },
        () => {},
      );
      const stop = bridge.onPowerStateChange?.((next) => setState(next));
      return () => {
        cancelled = true;
        stop?.();
      };
    }
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> })
      .getBattery;
    if (typeof getBattery !== "function") return;
    let battery: BatteryManagerLike | null = null;
    const read = () => {
      if (battery && !cancelled) {
        setState({ ...UNKNOWN_POWER, power: battery.charging ? "ac" : "battery" });
      }
    };
    void getBattery.call(navigator).then(
      (manager) => {
        if (cancelled) return;
        battery = manager;
        manager.addEventListener("chargingchange", read);
        read();
      },
      () => {},
    );
    return () => {
      cancelled = true;
      battery?.removeEventListener("chargingchange", read);
    };
  }, []);
  return state;
}

function useBackdropConditions(input: {
  readonly motionSetting: "live" | "still";
  readonly tooHeavy: boolean;
  readonly chatShown: boolean;
  readonly working: number;
}): BackdropConditions {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const documentVisible = useDocumentVisible();
  const focused = useWindowFocused();
  const busy = useBusy();
  const idle = useIdle(input.working);
  const power = usePowerState();
  const motion =
    input.motionSetting === "still" || reducedMotion || input.tooHeavy ? "still" : "live";
  // A lowered CPU speed limit stills the art like a serious thermal state does.
  const thermal =
    power.speedLimited &&
    (power.thermal === "nominal" || power.thermal === "fair" || power.thermal === "unknown")
      ? "serious"
      : power.thermal;
  const visible = documentVisible && input.chatShown;
  return useMemo(
    () => ({ motion, visible, busy, idle, focused, power: power.power, thermal }),
    [motion, visible, busy, idle, focused, power.power, thermal],
  );
}

// ---------------------------------------------------------------------------
// Activity

/**
 * Agents working and waiting across every connected computer, and a pulse
 * that counts up whenever a thread stops working: the same running set the
 * desktop's Dock badge watches for finished work (routes/__root.tsx).
 */
function useBackdropActivity(): { activity: BackdropActivity; pulse: number } {
  const runningKeys = useStore((state) =>
    selectRunningSidebarThreadsAcrossEnvironments(state)
      .map((thread) => `${thread.environmentId}:${thread.id}`)
      .toSorted()
      .join("|"),
  );
  const waiting = useStore(
    (state) =>
      selectSidebarThreadsAcrossEnvironments(state).filter(
        (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
      ).length,
  );
  const [pulse, setPulse] = useState(0);
  const previousRef = useRef(runningKeys);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = runningKeys;
    if (previous === runningKeys || previous === "") return;
    const now = new Set(runningKeys === "" ? [] : runningKeys.split("|"));
    if (previous.split("|").some((key) => !now.has(key))) setPulse((count) => count + 1);
  }, [runningKeys]);
  const working = runningKeys === "" ? 0 : runningKeys.split("|").length;
  const activity = useMemo(() => ({ working, waiting }), [working, waiting]);
  return { activity, pulse };
}
