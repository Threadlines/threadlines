/**
 * The hero window's theme strip and live art (components/HeroWindow.astro).
 *
 * The strip: the app's own row of theme tiles, placed over the window just
 * above its message box. Pointing at a tile previews that theme at once (its
 * art after a short dwell); moving off the strip goes back to the kept theme
 * after a short grace; clicking, the arrow keys or a tap keep it. A preview
 * is never stored and never counts as the visitor's pick. "Yours" types an
 * example ask into the message box and leaves the theme alone.
 *
 * The art runs in the app's own backdrop frame (a sandboxed iframe, scripts
 * only), driven the way the app's host drives it
 * (apps/web/src/components/theme/backdrop/ThemeBackdropHost.tsx):
 *
 * - The frame takes one `init` per life, so every theme change removes the
 *   frame and makes a new one. While it starts, the window's panels are
 *   solid; they clear only after a heartbeat reports a drawn frame.
 * - Only the current pick's JSON and frame messages count, so a slow
 *   response can't paint over a later pick.
 * - A frame that never says `ready`, reports a failure (no WebGL2, a script
 *   error, too heavy) or stops answering is removed, and the window stays
 *   solid.
 * - Viewport and zones are the iframe's own box, re-sent as it resizes.
 * - Conditions: visible on screen and in a visible tab; focused with the
 *   window; on battery unless the Battery API says it's charging; still
 *   under reduced motion and on phones (one frame, then it stands).
 *
 * Nothing loads until the page is idle. Imports from the shared packages are
 * types only, so none of the theme code reaches the browser.
 */
import type {
  BackdropActivity,
  BackdropConditions,
  BackdropHostMessage,
  BackdropZone,
} from "@threadlines/contracts";

import type { HeroArtPayload } from "../lib/heroThemes";

/** No heartbeat, or no new frame while the art should draw, for this long removes the frame (the app's value). */
const WATCHDOG_MS = 3_000;
/** The frame must say `ready` within this. */
const READY_TIMEOUT_MS = 8_000;
/** How far the reading column's frost reaches past its text on each side (the app's value). */
const COLUMN_MARGIN_PX = 48;
const PICK_KEY = "tl-hero-theme";
/** A previewed theme's art starts once the pointer stays this long. */
const PREVIEW_ART_DWELL_MS = 200;
/** Leaving the strip goes back to the kept theme after this, so sliding along the row doesn't flicker. */
const PREVIEW_LEAVE_GRACE_MS = 150;
/** The gap between the strip and the message box, and between the thread and the strip. */
const STRIP_GAP_PX = 10;
/** How long the strip's entrance runs, the last tile's delay included (see .hw-strip[data-entrance] in HeroWindow.astro). */
const STRIP_ENTRANCE_MS = 520;
/** A message whose top is this close to the thread's top edge would show cut off under its fade. */
const THREAD_EDGE_PX = 16;
const ACTIVITY: BackdropActivity = { working: 1, waiting: 0 };

type Power = BackdropConditions["power"];

interface Session {
  readonly sendConditions: () => void;
  readonly dispose: () => void;
}

export function startHeroWindow(): void {
  const win = document.querySelector<HTMLElement>("[data-hero-window]");
  const stage = win?.querySelector<HTMLElement>(".hw-art");
  const wrap = win?.parentElement;
  if (!win || !stage || !wrap) return;
  const strip = wrap.querySelector<HTMLFieldSetElement>(".hw-strip");
  const root = document.documentElement;
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="hero-theme"]')];
  const ids = new Set(radios.map((radio) => radio.value));
  const frameUrl = win.dataset.frame ?? "";
  const first = { light: win.dataset.firstLight ?? "", dark: win.dataset.firstDark ?? "" };
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phone = window.matchMedia("(max-width: 640px)");

  const storedPick = (): string | null => {
    try {
      const value = localStorage.getItem(PICK_KEY);
      return value && ids.has(value) ? value : null;
    } catch {
      return null;
    }
  };
  let picked = storedPick();
  const darkPage = () =>
    root.dataset.theme === "dark" || (root.dataset.theme !== "light" && systemDark.matches);

  // ---- Running conditions, shared by every session ----
  let onScreen = false;
  let power: Power = "battery";
  let session: Session | null = null;
  const conditions = (): BackdropConditions => ({
    motion: reducedMotion.matches || phone.matches ? "still" : "live",
    visible: onScreen && document.visibilityState === "visible",
    busy: false,
    idle: false,
    focused: document.hasFocus(),
    power,
    thermal: "unknown",
    slowdown: 0,
  });
  const resend = () => session?.sendConditions();
  new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? false;
    resend();
  }).observe(win);
  document.addEventListener("visibilitychange", resend);
  window.addEventListener("focus", resend);
  window.addEventListener("blur", resend);
  reducedMotion.addEventListener("change", resend);
  phone.addEventListener("change", resend);
  const battery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  battery
    ?.call(navigator)
    .then((state) => {
      const read = () => {
        power = state.charging ? "ac" : "battery";
        resend();
      };
      read();
      state.addEventListener("chargingchange", read);
    })
    .catch(() => {});

  // ---- Art payloads: fetched once each, only for the current pick ----
  const payloads = new Map<string, Promise<HeroArtPayload>>();
  const loadPayload = (url: string) => {
    let pending = payloads.get(url);
    if (!pending) {
      pending = fetch(url).then((response) =>
        response.ok
          ? (response.json() as Promise<HeroArtPayload>)
          : Promise.reject(new Error(String(response.status))),
      );
      pending.catch(() => payloads.delete(url));
      payloads.set(url, pending);
    }
    return pending;
  };
  // The page's CSS declares every theme font (heroThemeCss); this only waits for the picked theme's.
  const loadFonts = (payload: HeroArtPayload) =>
    Promise.allSettled(payload.fonts.map((font) => document.fonts.load(`1em "${font.family}"`)));

  const setLive = (live: boolean) => {
    if (live) win.dataset.art = "live";
    else delete win.dataset.art;
  };

  let idle = false;
  let generation = 0;
  let artTimer = 0;
  /** Stops the art; anything still loading for it is ignored (the generation moves on). */
  const stopArt = () => {
    clearTimeout(artTimer);
    generation += 1;
    session?.dispose();
    session = null;
    setLive(false);
  };
  const startArt = () => {
    stopArt();
    const id = root.dataset.heroTheme ?? "";
    const url = radios.find((radio) => radio.value === id)?.dataset.art;
    if (!idle || !url || !frameUrl) return;
    const mine = generation;
    loadPayload(url)
      .then((payload) => {
        if (mine !== generation) return;
        void loadFonts(payload);
        session = createSession({
          payload,
          stage,
          win,
          strip,
          frameUrl,
          conditions,
          onDrawing: () => {
            if (mine === generation) setLive(true);
          },
          onFailure: () => {
            if (mine !== generation) return;
            session?.dispose();
            session = null;
            setLive(false);
          },
        });
      })
      .catch(() => {});
  };

  // "Yours" typing (below): declared before the first theme is shown, which clears it.
  let askIndex = -1;
  let typing = 0;

  // ---- Picking ----
  /** The theme kept: the checked tile, whether the visitor picked it or the page's scheme did. */
  const kept = () => radios.find((radio) => radio.checked)?.value ?? "";
  let previewing: string | null = null;
  let leaveTimer = 0;
  const show = (id: string) => {
    if (!ids.has(id)) return;
    clearTimeout(leaveTimer);
    previewing = null;
    clearYours();
    for (const radio of radios) radio.checked = radio.value === id;
    if (root.dataset.heroTheme === id && (session || !idle)) {
      // Kept while its preview's art was still waiting for the dwell: start it now.
      if (!session && idle) startArt();
      return;
    }
    root.dataset.heroTheme = id;
    startArt();
  };
  const choose = (id: string) => {
    picked = id;
    try {
      localStorage.setItem(PICK_KEY, id);
    } catch {}
    show(id);
  };
  /**
   * Shows a theme without keeping it: colors, fonts and words switch at once (the ring and the
   * threads follow through the same measuring as any theme change), its art after a short dwell.
   */
  const preview = (id: string) => {
    clearTimeout(leaveTimer);
    if (!ids.has(id) || previewing === id) return;
    if (id === kept()) {
      // Back on the kept tile: nothing to preview, and nothing to undo when the pointer leaves.
      if (previewing === null) return;
      previewing = null;
      clearYours();
      root.dataset.heroTheme = id;
      stopArt();
      if (idle) artTimer = window.setTimeout(startArt, PREVIEW_ART_DWELL_MS);
      return;
    }
    previewing = id;
    clearYours();
    root.dataset.heroTheme = id;
    stopArt();
    if (idle) artTimer = window.setTimeout(startArt, PREVIEW_ART_DWELL_MS);
  };
  /** Back to the kept theme, once the pointer has really left. */
  const endPreview = () => {
    clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      if (previewing === null) return;
      previewing = null;
      root.dataset.heroTheme = kept();
      startArt();
    }, PREVIEW_LEAVE_GRACE_MS);
  };
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.checked) choose(radio.value);
    });
    // A mouse or pen pointing at a tile previews it; touch keeps on a tap instead.
    radio.closest("label")?.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") preview(radio.value);
    });
    // Picking the theme already checked keeps it through scheme changes too, and ends any preview
    // (a tap on a touchscreen laptop after the mouse left a preview showing).
    radio.addEventListener("click", () => {
      if (radio.checked && (picked !== radio.value || previewing !== null)) choose(radio.value);
    });
  }
  // Restored from the back/forward cache: another page may have changed the pick.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    picked = storedPick();
    if (picked) show(picked);
    else followScheme();
  });
  strip?.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") endPreview();
  });
  // Until the visitor picks, the window follows the page's light or dark. (A preview isn't a pick.)
  const followScheme = () => {
    if (!picked) show(darkPage() ? first.dark : first.light);
  };
  document.addEventListener("tl-themechange", followScheme);
  systemDark.addEventListener("change", followScheme);
  show(
    root.dataset.heroTheme && ids.has(root.dataset.heroTheme)
      ? root.dataset.heroTheme
      : (picked ?? (darkPage() ? first.dark : first.light)),
  );

  // ---- "Yours": an example ask typed into the message box; the theme stays as it is ----
  const yoursText = win.querySelector<HTMLElement>(".hw-yours-text");
  const yoursSaid = wrap.querySelector<HTMLElement>(".hw-yours-said");
  const asks: string[] = (() => {
    try {
      return JSON.parse(strip?.dataset.yoursAsks ?? "[]") as string[];
    } catch {
      return [];
    }
  })();
  function clearYours() {
    clearInterval(typing);
    delete win!.dataset.yours;
  }
  strip?.querySelector<HTMLButtonElement>("[data-yours]")?.addEventListener("click", () => {
    if (!yoursText || asks.length === 0) return;
    askIndex = (askIndex + 1) % asks.length;
    const ask = asks[askIndex]!;
    clearInterval(typing);
    win.dataset.yours = "";
    // The window is a picture to screen readers: the ask is read out here instead.
    if (yoursSaid) yoursSaid.textContent = ask;
    if (reducedMotion.matches) {
      yoursText.textContent = ask;
      return;
    }
    let shown = 0;
    yoursText.textContent = "";
    typing = window.setInterval(() => {
      shown = Math.min(ask.length, shown + 2);
      yoursText.textContent = ask.slice(0, shown);
      if (shown >= ask.length) clearInterval(typing);
    }, 16);
  });

  // ---- The strip's place: over the thread pane, just above the message box ----
  const composer = win.querySelector<HTMLElement>(".hw-composer");
  const thread = win.querySelector<HTMLElement>(".hw-thread");
  /**
   * Messages the strip would push under the thread's top edge are left out whole, as if scrolled
   * past, so none shows cut off. The newest one always stays; on a screen too short for all of
   * it, its own first lines are left out the same way.
   */
  let leftOut: HTMLElement[] = [];
  const fitThread = () => {
    if (!thread) return;
    for (const item of leftOut) item.style.display = "";
    leftOut = [];
    const edge = thread.getBoundingClientRect().top + THREAD_EDGE_PX;
    // The thread sits at its bottom, so leaving out a message moves nothing below it.
    const fit = (parent: Element) => {
      const items = Array.from(parent.children, (item) => item as HTMLElement);
      const newest = items.pop();
      for (const item of items) {
        if (item.getBoundingClientRect().top >= edge) return;
        item.style.display = "none";
        leftOut.push(item);
      }
      if (newest && newest.getBoundingClientRect().top < edge) fit(newest);
    };
    fit(thread);
  };
  const placeStrip = () => {
    if (!strip || !composer) return;
    strip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const message = composer.getBoundingClientRect();
    // As wide as the message box it sits on, so the two read as one piece.
    strip.style.left = `${message.left - box.left}px`;
    strip.style.width = `${message.width}px`;
    strip.style.top = `${message.top - box.top - STRIP_GAP_PX - strip.offsetHeight}px`;
    win.style.setProperty("--hw-strip-space", `${strip.offsetHeight + STRIP_GAP_PX}px`);
    fitThread();
    // The art frosts behind the strip: tell it where the strip is now.
    strip.dispatchEvent(new Event("tl-strip-placed"));
  };
  if (strip && composer) {
    // Waiting for its entrance, unless motion is off.
    if (!reducedMotion.matches) strip.dataset.entrance = "waiting";
    placeStrip();
    const watch = new ResizeObserver(placeStrip);
    for (const el of [win, composer, strip]) watch.observe(el);
    document.fonts.addEventListener("loadingdone", placeStrip);
    // The first time the window is well on screen (or the strip gets focus), it rises into place.
    const enter = () => {
      if (strip.dataset.entrance !== "waiting") return;
      strip.dataset.entrance = "playing";
      // The strip only fades in where it stands, so its frost can come with it.
      strip.dispatchEvent(new Event("tl-strip-placed"));
      // Once every tile has risen, the strip's box is final: the art measures it again.
      window.setTimeout(() => {
        delete strip.dataset.entrance;
        strip.dispatchEvent(new Event("tl-strip-placed"));
      }, STRIP_ENTRANCE_MS);
    };
    const seen = new IntersectionObserver(
      ([entry]) => {
        // The first report comes on observing, at any ratio: wait for the real 60%.
        if (!entry?.isIntersecting || entry.intersectionRatio < 0.59) return;
        enter();
        seen.disconnect();
      },
      { threshold: 0.6 },
    );
    seen.observe(win);
    strip.addEventListener("focusin", enter);
    // The tiles' pictures load only as the strip nears the screen.
    const pictures = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        for (const img of strip.querySelectorAll<HTMLImageElement>("img[data-src]")) {
          img.src = img.dataset.src ?? "";
          img.removeAttribute("data-src");
        }
        pictures.disconnect();
      },
      { rootMargin: "200px 0px" },
    );
    pictures.observe(strip);
  }

  // The art waits for the page to finish loading and go idle.
  const begin = () => {
    const go = () => {
      idle = true;
      // Mid-preview, the art still waits out the dwell.
      if (previewing === null) startArt();
      else artTimer = window.setTimeout(startArt, PREVIEW_ART_DWELL_MS);
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(go, { timeout: 2_500 });
    else setTimeout(go, 600);
  };
  if (document.readyState === "complete") begin();
  else window.addEventListener("load", begin, { once: true });
}

interface BatteryLike extends EventTarget {
  readonly charging: boolean;
}

/** One frame's life: made for one theme, removed on the next change or a failure. */
function createSession(input: {
  readonly payload: HeroArtPayload;
  readonly stage: HTMLElement;
  readonly win: HTMLElement;
  /** The theme strip over the window: frosted like the message box. */
  readonly strip: HTMLElement | null;
  readonly frameUrl: string;
  readonly conditions: () => BackdropConditions;
  readonly onDrawing: () => void;
  readonly onFailure: () => void;
}): Session {
  const { payload, stage, win, strip } = input;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "Theme art");
  frame.inert = true;
  frame.style.colorScheme = payload.init.base;

  const now = () => performance.now();
  const state = {
    started: false,
    lastFrame: 0,
    lastBeat: now(),
    lastProgress: now(),
    createdAt: now(),
    disposed: false,
  };
  const post = (message: BackdropHostMessage) => frame.contentWindow?.postMessage(message, "*");

  const viewport = (): BackdropHostMessage => ({
    type: "viewport",
    width: frame.clientWidth,
    height: frame.clientHeight,
    dpr: window.devicePixelRatio || 1,
  });

  const zones = (): BackdropZone[] => {
    const origin = frame.getBoundingClientRect();
    const local = (rect: DOMRect) => ({
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height,
    });
    const visible = (rect: DOMRect) => rect.width >= 1 && rect.height >= 1;
    const list: BackdropZone[] = [];
    const hard = (
      id: string,
      element: Element,
      tint: { tint: number; color: string },
      rounded = false,
    ) => {
      const rect = element.getBoundingClientRect();
      if (!visible(rect)) return;
      const inner = local(rect);
      const box = { x: inner.x - 1, y: inner.y - 1, w: inner.w + 2, h: inner.h + 2 };
      const zone: BackdropZone = {
        id,
        edge: "hard",
        shape: "rect",
        rect: box,
        core: box,
        tint: tint.tint,
        tintColor: tint.color,
      };
      if (rounded) {
        const style = getComputedStyle(element);
        const radius = (value: string) => {
          const px = Number.parseFloat(value);
          return px > 0 ? px + 1 : 0;
        };
        list.push({
          ...zone,
          radii: [
            radius(style.borderTopLeftRadius),
            radius(style.borderTopRightRadius),
            radius(style.borderBottomRightRadius),
            radius(style.borderBottomLeftRadius),
          ],
        });
      } else list.push(zone);
    };
    win
      .querySelectorAll('[data-zone="frame"]')
      .forEach((element, index) => hard(`frame-${index}`, element, payload.zones.frame));
    win
      .querySelectorAll('[data-zone="list"]')
      .forEach((element, index) => hard(`list-${index}`, element, payload.zones.list));
    for (const column of win.querySelectorAll('[data-zone="column"]')) {
      const rect = column.getBoundingClientRect();
      const bounds = column.parentElement?.getBoundingClientRect();
      if (!visible(rect) || !bounds) continue;
      const core = local(rect);
      const left = Math.max(rect.left - COLUMN_MARGIN_PX, bounds.left);
      const right = Math.min(rect.right + COLUMN_MARGIN_PX, bounds.right);
      list.push({
        id: "column",
        edge: "soft",
        shape: "rect",
        rect: { x: left - origin.left, y: core.y, w: right - left, h: core.h },
        core,
        tint: payload.zones.column.tint,
        tintColor: payload.zones.column.color,
      });
    }
    win
      .querySelectorAll('[data-zone="composer"]')
      .forEach((element, index) =>
        hard(`composer-${index}`, element, payload.zones.composer, true),
      );
    // No frost under the strip while it waits, unseen, for its entrance.
    if (strip && !strip.hidden && strip.dataset.entrance !== "waiting") {
      hard("strip", strip, payload.zones.composer, true);
    }
    return list;
  };

  let layoutFrame = 0;
  const sendLayout = () => {
    if (!state.started || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (state.disposed) return;
      post(viewport());
      post({ type: "zones", zones: zones() });
    });
  };
  const resize = new ResizeObserver(sendLayout);
  resize.observe(win);
  // A zone can change size inside an unchanged window: the message box when it shows a hovered agent.
  for (const zone of win.querySelectorAll("[data-zone]")) resize.observe(zone);
  if (strip) {
    resize.observe(strip);
    strip.addEventListener("tl-strip-placed", sendLayout);
  }
  void document.fonts.ready.then(sendLayout);
  document.fonts.addEventListener("loadingdone", sendLayout);
  const ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  ratio.addEventListener("change", sendLayout);

  const sendConditions = () => {
    if (!state.started) return;
    post({ type: "conditions", conditions: input.conditions() });
    // Coming back to drawing gets a fresh grace period before the watchdog judges it.
    state.lastBeat = now();
    state.lastProgress = now();
  };

  const start = () => {
    if (state.started) return;
    state.started = true;
    post(payload.init as BackdropHostMessage);
    post(viewport());
    post({ type: "zones", zones: zones() });
    post({ type: "activity", activity: ACTIVITY });
    post({ type: "conditions", conditions: input.conditions() });
    state.lastBeat = now();
    state.lastProgress = now();
  };

  const fail = () => {
    if (state.disposed) return;
    dispose();
    input.onFailure();
  };

  const onMessage = (event: MessageEvent) => {
    if (state.disposed || !frame.contentWindow || event.source !== frame.contentWindow) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || !("type" in data)) return;
    switch ((data as { type: unknown }).type) {
      case "ready":
        start();
        return;
      case "heartbeat": {
        const drawn = (data as { frame?: unknown }).frame;
        state.lastBeat = now();
        if (typeof drawn === "number" && drawn > state.lastFrame) {
          state.lastFrame = drawn;
          state.lastProgress = state.lastBeat;
          input.onDrawing();
        }
        return;
      }
      case "failure":
        fail();
        return;
    }
  };
  window.addEventListener("message", onMessage);

  // The watchdog, as the app's: judged only while the window can be seen.
  const watchdog = window.setInterval(() => {
    const current = input.conditions();
    const time = now();
    if (!current.visible) {
      state.lastBeat = time;
      state.lastProgress = time;
      if (!state.started) state.createdAt = time;
      return;
    }
    if (!state.started) {
      if (time - state.createdAt > READY_TIMEOUT_MS) fail();
      return;
    }
    const silent = time - state.lastBeat > WATCHDOG_MS;
    const expecting = current.motion === "live" || state.lastFrame === 0;
    const stalled = expecting && time - state.lastProgress > WATCHDOG_MS;
    if (silent || stalled) fail();
  }, 1_000);

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    window.removeEventListener("message", onMessage);
    window.clearInterval(watchdog);
    resize.disconnect();
    document.fonts.removeEventListener("loadingdone", sendLayout);
    strip?.removeEventListener("tl-strip-placed", sendLayout);
    ratio.removeEventListener("change", sendLayout);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    frame.remove();
  }

  frame.addEventListener("load", () => {
    // The runtime says `ready` itself; `load` covers a ready sent before this listener ran.
    if (!state.disposed) start();
  });
  frame.src = input.frameUrl;
  stage.append(frame);
  return { sendConditions, dispose };
}
