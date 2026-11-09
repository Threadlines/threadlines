/**
 * Runs a theme's live art behind the window (docs/design/custom-themes.md,
 * "The backdrop runtime" and "Performance"), from the app's side: it mounts
 * the backdrop host (ThemeRuntime.tsx mounts this while the active theme has
 * art, so its code loads only then) and feeds it what it needs, all
 * computed here from the live app:
 *
 * - zones: the calm areas to frost, from the layout (backdropZones.ts),
 *   remeasured when it changes, at most every 100 ms;
 * - conditions: motion (the Motion setting, Reduce Motion, the desktop
 *   watchdog, and phones, which always draw one frame at their own size and
 *   stand on it), visibility (the window, and whether a chat is on screen),
 *   busy (resizing the window, dragging a divider: the art holds), idle
 *   (two minutes without input or agent work), power and heat (desktop, else
 *   the Battery API);
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
  ThemeBase,
  ThemeManifest,
} from "@threadlines/contracts";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";
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
  useStore,
} from "../store";
import {
  measureBackdropZones,
  type MeasuredBackdropLayout,
  sameBackdropZones,
} from "./backdropZones";
import { cssGlassTints, glassClarity, glassFloors, glassTextRatio, glassTintCss } from "./glass";
import { useGlassLevel } from "./glassLevel";
import { GLASS_PAGE_SELECTOR } from "./glassPage";
import { applyGlassTints } from "./themeApply";
import { useLayoutBusy } from "./layoutBusy";
import {
  readThemeState,
  setBackdropStatus,
  subscribeTheme,
  useBackdropSlowdown,
  useBackdropTooHeavy,
} from "./themeStore";

const ZONE_MIN_INTERVAL_MS = 100;
/** Remeasure once more after this, for layout that moves by transition (the list's slide). */
const ZONE_SETTLE_MS = 300;
const IDLE_AFTER_MS = 2 * 60 * 1000;
const IDLE_CHECK_MS = 15_000;

let hostHandle: ThemeBackdropHostHandle | null = null;

/** A PNG data URL of the running art at this size, or null when no art runs. */
export function captureActiveBackdropStill(width: number, height: number): Promise<string> | null {
  return hostHandle ? hostHandle.captureStill(width, height) : null;
}

/** The backdrop for a theme with art (ThemeRuntime.tsx mounts it, fetching this module then). */
export function ThemeBackdropLayer(props: {
  readonly manifest: ThemeManifest;
  readonly tokens: ThemeTokens;
  readonly base: ThemeBase;
  readonly hash: string;
}) {
  const { manifest, tokens, base } = props;
  const backdrop = manifest.backdrop!;
  const glass = manifest.glass!;
  const glassLevel = useGlassLevel();
  const motionSetting = useSettings((settings) => settings.themeMotion);
  const floors = useMemo(() => glassFloors(glass, glassLevel), [glass, glassLevel]);
  const clarity = glassClarity(glassLevel);
  const status = useSyncExternalStore(subscribeTheme, () => readThemeState().backdropStatus);
  const tooHeavy = useBackdropTooHeavy();
  const slowdown = useBackdropSlowdown();
  const phone = useIsMobile();

  // The tints the surfaces paint themselves while the art isn't running.
  const tintCss = glassTintCss(cssGlassTints(floors, status, tooHeavy, clarity));
  useLayoutEffect(() => {
    applyGlassTints(tintCss);
  }, [tintCss]);
  // A layout cleanup: a theme switch unmounts this layer and mounts the next
  // in one commit, and this must run before the next one's setup, not after.
  // (The store clears the host's status itself whenever the theme changes.)
  useLayoutEffect(() => () => applyGlassTints(null), []);

  const layout = useBackdropLayout(tokens, floors);
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-glass-page", layout.artShown ? "art" : "page");
    return () => document.documentElement.removeAttribute("data-glass-page");
  }, [layout.artShown]);

  const { activity, pulse } = useBackdropActivity();
  const conditions = useBackdropConditions({
    motionSetting,
    tooHeavy,
    slowdown,
    artShown: layout.artShown,
    working: activity.working,
    phone,
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
        textRatio={glassTextRatio(glass, glassLevel)}
        clarity={clarity}
        zones={layout.zones}
        conditions={conditions}
        activity={activity}
        pulse={pulse}
        phone={phone}
        framedStill={!tooHeavy}
        onStatus={setBackdropStatus}
      />
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Zones

const EMPTY_LAYOUT: MeasuredBackdropLayout = { zones: [], artShown: true };

const MEASURED_SELECTORS = [
  '[data-slot="app-titlebar"]',
  '[data-slot="navigation-rail"]',
  '[data-slot="app-panel"]',
  '[data-slot="sidebar-inner"]',
  "[data-chat-column]",
  "[data-chat-composer-form]",
  "[data-glass-surface]",
  "[data-draft-hero]",
  "[data-empty-home]",
  GLASS_PAGE_SELECTOR.content,
  GLASS_PAGE_SELECTOR.column,
  GLASS_PAGE_SELECTOR.header,

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
        previous.artShown === next.artShown && sameBackdropZones(previous.zones, next.zones)
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
    // A phone's keyboard shrinks and pans the visible page without resizing the window.
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
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
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
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
  readonly slowdown: number;
  readonly artShown: boolean;
  readonly working: number;
  /** Phones never animate the art (battery): one frame, drawn for the phone's screen. */
  readonly phone: boolean;
}): BackdropConditions {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const documentVisible = useDocumentVisible();
  const focused = useWindowFocused();
  const busy = useLayoutBusy();
  const idle = useIdle(input.working);
  const power = usePowerState();
  const motion =
    input.motionSetting === "still" || reducedMotion || input.tooHeavy || input.phone
      ? "still"
      : "live";
  // A lowered CPU speed limit stills the art like a serious thermal state does.
  const thermal =
    power.speedLimited &&
    (power.thermal === "nominal" || power.thermal === "fair" || power.thermal === "unknown")
      ? "serious"
      : power.thermal;
  const visible = documentVisible && input.artShown;
  const { slowdown } = input;
  return useMemo(
    () => ({
      motion,
      visible,
      busy,
      idle,
      focused,
      power: power.power,
      thermal,
      slowdown,
    }),
    [motion, visible, busy, idle, focused, power.power, thermal, slowdown],
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
