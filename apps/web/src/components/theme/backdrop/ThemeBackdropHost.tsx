/**
 * Hosts a theme's live backdrop behind the window (docs/design/custom-themes.md,
 * "The backdrop runtime"): the sandboxed frame, the still-image fallback, and
 * the bridge messages. The app computes zones, conditions and activity and
 * passes them in; this component only relays them and reports status.
 *
 * Both layers are portaled to the end of `document.body` at `z-index: -1`,
 * so they paint above the page's own background and under everything in the
 * app's root. Glass mode makes the root's surfaces transparent.
 *
 * Who paints the tint follows the status: while `running`, the frame tints
 * each zone itself; while `still` or `failed`, the still (or nothing) is
 * shown and the app tints glass surfaces with `minimumTint`.
 */
import {
  BackdropFrameMessage,
  type BackdropActivity,
  type BackdropConditions,
  type BackdropEnergy,
  type BackdropFailureReason,
  type BackdropHostMessage,
  type BackdropZone,
  type ThemeBackdrop,
  type ThemeBase,
} from "@threadlines/contracts";
import {
  BACKDROP_FRAME_SANDBOX,
  buildBackdropFrameDocument,
} from "@threadlines/shared/themeBackdropFrame";
import { GLASS_TEXT_RATIO, glassTextColors } from "@threadlines/shared/themeContrast";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";
import * as Schema from "effect/Schema";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { measureStillTint } from "./backdropStillTint";

export type ThemeBackdropStatus =
  | {
      readonly kind: "running";
      readonly fps: number;
      readonly msPerSecond: number;
      readonly energy: BackdropEnergy;
      readonly throttled: boolean;
    }
  | {
      /**
       * Not moving: Motion is Still or Reduce Motion ("motion"), a phone,
       * which always draws one frame and stands ("phone"), or the art hasn't
       * drawn its first frame yet, because it is starting or paused before
       * it drew one ("paused").
       */
      readonly kind: "still";
      readonly reason: "motion" | "paused" | "phone";
      /** The tint every glass text surface needs over the still (layout-independent). */
      readonly minimumTint: number;
      /**
       * The frame shows one frame of the art, drawn for this screen, frosted
       * and tinted patch by patch like the live art, so the surfaces stay
       * clear (Motion: Still, and phones). Otherwise the app shows the still
       * image under CSS tints.
       */
      readonly framed?: boolean;
    }
  | {
      readonly kind: "failed";
      readonly reason: BackdropFailureReason | "heartbeat";
      readonly detail?: string;
      /** As for `still`; 1 when there is no still to show. */
      readonly minimumTint: number;
    };

export interface ThemeBackdropHostProps {
  /** Remounts the frame when it changes: the theme's content hash. */
  readonly themeKey: string;
  readonly backdrop: ThemeBackdrop;
  readonly base: ThemeBase;
  readonly tokens: ThemeTokens;
  readonly blur: number;
  /**
   * The contrast text over the art keeps, 3 to 4.5 (glass.ts glassTextRatio).
   * Default 4.5. It changes live: the frame keeps running.
   */
  readonly textRatio?: number;
  /**
   * How far the frost and the tint readability adds have faded toward Clear,
   * 0 to 1 (glass.ts glassClarity). Default 0. It changes live too.
   */
  readonly clarity?: number;
  readonly zones: ReadonlyArray<BackdropZone>;
  readonly conditions: BackdropConditions;
  readonly activity: BackdropActivity;
  /** Counts up on every finished turn; each change is one `turn-done` pulse. */
  readonly pulse: number;
  /**
   * A phone: its conditions say Motion: Still, so the art draws one frame at
   * the phone's own size and stands on it; the status says it is the phone.
   */
  readonly phone?: boolean;
  /**
   * Motion is Still (the user's choice, Reduce Motion, or a phone): the frame
   * stays and stands on one frame. Art the computer found too heavy is still
   * too, but its frame goes, and the still image shows.
   */
  readonly framedStill?: boolean;
  readonly onStatus?: (status: ThemeBackdropStatus) => void;
}

export interface ThemeBackdropHostHandle {
  /** A PNG data URL of the art at this size, from the running frame. */
  readonly captureStill: (width: number, height: number) => Promise<string>;
  /** Starts the art again after a failure ("Try again"). */
  readonly retry: () => void;
}

/** No heartbeat, or no new frame while the art should be drawing, for this long fails the frame. */
export const BACKDROP_WATCHDOG_MS = 3_000;
/** How long `captureStill` waits for the frame's answer. */
export const BACKDROP_STILL_TIMEOUT_MS = 5_000;

const decodeFrameMessage = Schema.decodeUnknownOption(BackdropFrameMessage);

/** Every text color drawn on glass, each needing `ratio` (default 4.5) over the art. */
function textsFor(tokens: ThemeTokens, ratio = GLASS_TEXT_RATIO.standard) {
  return glassTextColors(tokens).map((text) => ({ color: text.color, ratio }));
}

const LAYER_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100%",
  height: "100%",
  border: 0,
  margin: 0,
  padding: 0,
  zIndex: -1,
  pointerEvents: "none",
};

/** The art should be drawing frames under these conditions; any hold or pause exempts it. */
/** The frame's runtime pauses the art under these whatever Motion says (its runState). */
const mayRun = (conditions: BackdropConditions) =>
  conditions.visible &&
  !conditions.idle &&
  conditions.thermal !== "serious" &&
  conditions.thermal !== "critical";

const shouldDraw = (conditions: BackdropConditions) =>
  conditions.motion === "live" && mayRun(conditions) && !conditions.busy;

export const ThemeBackdropHost = forwardRef<ThemeBackdropHostHandle, ThemeBackdropHostProps>(
  function ThemeBackdropHost(props, ref) {
    // A new theme is a new session: fresh frame, fresh failure state.
    return <BackdropSession key={props.themeKey} {...props} ref={ref} />;
  },
);

type Failure = { readonly reason: BackdropFailureReason | "heartbeat"; readonly detail?: string };
type Stats = Extract<BackdropFrameMessage, { type: "stats" }>;

/** What the mounted frame has shown so far: nothing yet, a first frame, then its stats. */
type FrameProgress = null | "drawing" | Stats;

interface FrameApi {
  readonly captureStill: (width: number, height: number) => Promise<string>;
}

/**
 * One theme's backdrop: decides between the live frame and the still, and
 * reports status. The frame itself is `BackdropFrame`, remounted for each
 * attempt.
 */
const BackdropSession = forwardRef<ThemeBackdropHostHandle, ThemeBackdropHostProps>(
  function BackdropSession(props, ref) {
    const { backdrop, conditions, phone = false, framedStill = false, tokens, textRatio } = props;
    const [attempt, setAttempt] = useState(0);
    const [failure, setFailure] = useState<Failure | null>(null);
    const [progress, setProgress] = useState<FrameProgress>(null);
    const [measured, setMeasured] = useState<{ still: string; tint: number } | null>(null);
    const frameApi = useRef<FrameApi | null>(null);
    // The frame stays for Motion: Still too (phones included): it draws one
    // frame for this screen and stands, with the same glass. A failed frame
    // and art found too heavy show the still image.
    const showFrame = failure === null && (conditions.motion === "live" || framedStill);

    // A frame shown again is a new frame: it hasn't drawn anything yet.
    const [shownBefore, setShownBefore] = useState(showFrame);
    if (shownBefore !== showFrame) {
      setShownBefore(showFrame);
      setProgress(null);
    }

    // The tint glass text needs over the still, for whenever the still shows.
    const still = backdrop.still;
    useEffect(() => {
      if (!still) return;
      let cancelled = false;
      measureStillTint(still, tokens, textRatio).then(
        (tint) => {
          if (!cancelled) setMeasured({ still, tint });
        },
        () => {
          if (!cancelled) setMeasured({ still, tint: 1 });
        },
      );
      return () => {
        cancelled = true;
      };
    }, [still, tokens, textRatio]);
    const minimumTint = still && measured?.still === still ? measured.tint : 1;

    const status: ThemeBackdropStatus = failure
      ? { kind: "failed", ...failure, minimumTint }
      : conditions.motion === "still"
        ? {
            kind: "still",
            reason: phone ? "phone" : "motion",
            minimumTint,
            framed: progress !== null,
          }
        : progress === null
          ? { kind: "still", reason: "paused", minimumTint }
          : {
              kind: "running",
              fps: progress === "drawing" ? 0 : progress.fps,
              msPerSecond: progress === "drawing" ? 0 : progress.msPerSecond,
              energy: progress === "drawing" ? "light" : progress.energy,
              throttled: progress === "drawing" ? false : progress.throttled,
            };
    // Reported when it changes, by value.
    const statusKey = JSON.stringify(status);
    const onStatus = useRef(props.onStatus);
    useEffect(() => {
      onStatus.current = props.onStatus;
    });
    useEffect(() => {
      onStatus.current?.(JSON.parse(statusKey) as ThemeBackdropStatus);
    }, [statusKey]);

    useImperativeHandle(
      ref,
      () => ({
        captureStill: (width, height) =>
          frameApi.current
            ? frameApi.current.captureStill(width, height)
            : Promise.reject(new Error("The backdrop isn't running.")),
        retry: () => {
          setFailure(null);
          setProgress(null);
          setAttempt((value) => value + 1);
        },
      }),
      [],
    );

    const onApi = useCallback((api: FrameApi | null) => {
      frameApi.current = api;
    }, []);
    const onDrawing = useCallback(() => {
      setProgress((current) => current ?? "drawing");
    }, []);
    const onFailure = useCallback((next: Failure) => {
      setFailure((current) => current ?? next);
    }, []);

    const showStill = Boolean(still) && (!showFrame || progress === null);
    return createPortal(
      <>
        {showStill ? (
          <img
            src={still}
            alt=""
            aria-hidden
            draggable={false}
            data-slot="theme-backdrop-still"
            style={{ ...LAYER_STYLE, objectFit: "cover" }}
          />
        ) : null}
        {showFrame ? (
          <BackdropFrame
            key={attempt}
            {...props}
            drawing={progress !== null}
            onApi={onApi}
            onDrawing={onDrawing}
            onStats={setProgress}
            onFailure={onFailure}
          />
        ) : null}
      </>,
      document.body,
    );
  },
);

interface BackdropFrameProps extends ThemeBackdropHostProps {
  /** The frame has drawn: show it over the still. */
  readonly drawing: boolean;
  /** Hands the session the frame's still capture while it is mounted, then null. */
  readonly onApi: (api: FrameApi | null) => void;
  readonly onDrawing: () => void;
  readonly onStats: (stats: Stats) => void;
  readonly onFailure: (failure: Failure) => void;
}

/**
 * The sandboxed frame and its side of the bridge: sends the theme once the
 * frame says `ready`, relays what changes, takes only its own frame's
 * messages, and watches its heartbeat.
 */
function BackdropFrame(props: BackdropFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The latest props, for message handlers and timers that outlive a render.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const session = useRef({
    started: false,
    lastHeartbeatAt: 0,
    lastFrame: 0,
    lastProgressAt: 0,
    pulse: props.pulse,
    stills: new Map<string, { resolve: (url: string) => void; reject: (error: Error) => void }>(),
  });

  const post = useCallback((message: BackdropHostMessage) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  /** Sends the theme and the current state once the frame is listening. */
  const start = useCallback(() => {
    const state = session.current;
    if (state.started) return;
    state.started = true;
    const current = latest.current;
    const texts = textsFor(current.tokens, current.textRatio);
    post({
      type: "init",
      mode: current.backdrop.mode,
      script: current.backdrop.script,
      maxFps: current.backdrop.maxFps,
      base: current.base,
      palette: { ...current.tokens },
      textColors: texts.map((text) => text.color),
      textRatios: texts.map((text) => text.ratio),
      blur: current.blur,
      clarity: current.clarity ?? 0,
      // Shown until the first frame: the art fades in from it.
      ...(current.backdrop.still ? { still: current.backdrop.still } : {}),
    });
    post(viewportMessage());
    post({ type: "zones", zones: current.zones });
    post({ type: "activity", activity: current.activity });
    post({ type: "conditions", conditions: current.conditions });
    state.pulse = current.pulse;
    state.lastHeartbeatAt = performance.now();
    state.lastProgressAt = performance.now();
  }, [post]);

  // Messages from the frame: only from its own window, only shapes the bridge allows.
  useEffect(() => {
    const state = session.current;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const decoded = decodeFrameMessage(event.data);
      if (decoded._tag === "None") return;
      const message = decoded.value;
      switch (message.type) {
        case "ready":
          start();
          return;
        case "heartbeat":
          state.lastHeartbeatAt = performance.now();
          if (message.frame > state.lastFrame) {
            state.lastFrame = message.frame;
            state.lastProgressAt = state.lastHeartbeatAt;
            latest.current.onDrawing();
          }
          return;
        case "stats":
          if (state.lastFrame > 0) latest.current.onStats(message);
          return;
        case "still": {
          const pending = state.stills.get(message.requestId);
          state.stills.delete(message.requestId);
          pending?.resolve(message.dataUrl);
          return;
        }
        case "failure":
          latest.current.onFailure(
            message.detail === undefined
              ? { reason: message.reason }
              : { reason: message.reason, detail: message.detail },
          );
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const pending of state.stills.values())
        pending.reject(new Error("The backdrop closed."));
      state.stills.clear();
    };
  }, [start]);

  // Stills, through the session's handle.
  const { onApi } = props;
  useEffect(() => {
    onApi({
      captureStill: (width, height) =>
        new Promise<string>((resolve, reject) => {
          const state = session.current;
          if (!state.started) {
            reject(new Error("The backdrop isn't running."));
            return;
          }
          const requestId = crypto.randomUUID();
          const timer = window.setTimeout(() => {
            state.stills.delete(requestId);
            reject(new Error("The backdrop didn't send a still in time."));
          }, BACKDROP_STILL_TIMEOUT_MS);
          state.stills.set(requestId, {
            resolve: (url) => {
              window.clearTimeout(timer);
              resolve(url);
            },
            reject: (error) => {
              window.clearTimeout(timer);
              reject(error);
            },
          });
          post({ type: "capture-still", requestId, width, height });
        }),
    });
    return () => onApi(null);
  }, [onApi, post]);

  // The window's size and pixel ratio.
  useEffect(() => {
    const send = () => {
      if (session.current.started) post(viewportMessage());
    };
    window.addEventListener("resize", send);
    const ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    ratio.addEventListener("change", send);
    return () => {
      window.removeEventListener("resize", send);
      ratio.removeEventListener("change", send);
    };
  }, [post]);

  // Layout, activity, conditions and pulses as they change (by value: callers
  // may pass equal objects on every render).
  const zonesKey = JSON.stringify(props.zones);
  const activityKey = JSON.stringify(props.activity);
  const conditionsKey = JSON.stringify(props.conditions);
  const { pulse } = props;
  useEffect(() => {
    if (!session.current.started) return;
    post({ type: "zones", zones: JSON.parse(zonesKey) as BackdropZone[] });
  }, [zonesKey, post]);
  useEffect(() => {
    if (!session.current.started) return;
    post({ type: "activity", activity: JSON.parse(activityKey) as BackdropActivity });
  }, [activityKey, post]);
  useEffect(() => {
    const state = session.current;
    if (!state.started) return;
    post({ type: "conditions", conditions: JSON.parse(conditionsKey) as BackdropConditions });
    // Coming back to drawing gets a fresh grace period before the watchdog judges it.
    state.lastProgressAt = performance.now();
    state.lastHeartbeatAt = performance.now();
  }, [conditionsKey, post]);
  // The Glass slider moving, or new theme colors: new text bounds and clarity, same frame.
  const textsKey = JSON.stringify(textsFor(props.tokens, props.textRatio));
  const clarity = props.clarity ?? 0;
  useEffect(() => {
    if (!session.current.started) return;
    const texts = JSON.parse(textsKey) as ReturnType<typeof textsFor>;
    post({
      type: "glass",
      textColors: texts.map((text) => text.color),
      textRatios: texts.map((text) => text.ratio),
      clarity,
    });
  }, [textsKey, clarity, post]);
  useEffect(() => {
    const state = session.current;
    if (!state.started || pulse === state.pulse) return;
    state.pulse = pulse;
    post({ type: "pulse", kind: "turn-done" });
  }, [pulse, post]);

  // The watchdog: a frame that stops answering, or answers but stops drawing, is removed.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = session.current;
      const conditions = latest.current.conditions;
      const now = performance.now();
      // Hidden pages get their timers throttled, the frame's too: judge only what can be seen.
      if (!state.started || !conditions.visible || document.visibilityState !== "visible") {
        state.lastHeartbeatAt = now;
        state.lastProgressAt = now;
        return;
      }
      const silent = now - state.lastHeartbeatAt > BACKDROP_WATCHDOG_MS;
      // Still draws one frame: until it has, the frame must show progress too,
      // unless it is paused (an idle phone tab hasn't drawn yet, and needn't).
      const expecting =
        shouldDraw(conditions) ||
        (conditions.motion === "still" && state.lastFrame === 0 && mayRun(conditions));
      const stalled = expecting && now - state.lastProgressAt > BACKDROP_WATCHDOG_MS;
      if (silent || stalled) {
        latest.current.onFailure({
          reason: "heartbeat",
          detail: silent ? "The backdrop stopped answering." : "The backdrop stopped drawing.",
        });
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <iframe
      ref={frameRef}
      name="threadlines-backdrop"
      title="Theme backdrop"
      data-slot="theme-backdrop-frame"
      srcDoc={buildBackdropFrameDocument()}
      sandbox={BACKDROP_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      inert
      aria-hidden
      tabIndex={-1}
      onLoad={start}
      style={{ ...LAYER_STYLE, colorScheme: props.base, opacity: props.drawing ? 1 : 0 }}
    />
  );
}

const viewportMessage = (): BackdropHostMessage => ({
  type: "viewport",
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: window.devicePixelRatio || 1,
});
