/**
 * The hero threads behave like strings: a quick pass of the pointer flicks
 * one, a press pulls one like a short rubber band, and it eases back. Only the
 * stretch from the logo to the twist moves; both ends stay put.
 *
 * A path's shape is rewritten only while a thread is displaced, by one loop
 * that stops as soon as every thread is back at rest (its exact rest shape).
 * Touch gets a small flick on a tap and nothing else, so scrolling and pinch
 * zoom are untouched.
 */
import { type Pt, ribbonOf } from "./geometry";
import { motion } from "./dom";
import type { Heartbeat, Lane } from "./pulses";
import {
  bumpAt,
  FLICK_MIN_SPEED,
  FLICK_REACH,
  FLICK_REST_MS,
  flickVelocity,
  HOLD_REACH,
  holdOffset,
  NEIGHBOUR_DELAY_MS,
  NEIGHBOUR_SHARE,
  type Spring,
  stepSpring,
  TAP_REACH,
} from "./spring";

export interface StringThread {
  readonly j: number;
  readonly band: 0 | 1;
  readonly head: ReadonlyArray<Pt>;
  readonly tail: ReadonlyArray<Pt>;
  readonly width: (distance: number, total: number) => number;
  readonly el: SVGPathElement;
  readonly restD: string;
  readonly lane: Lane | null;
}

interface StringState extends StringThread, Spring {
  /** 0..1 along `head` for each point. */
  readonly ts: number[];
  /** Points to test the pointer against. */
  readonly hit: { x: number; y: number; t: number }[];
  /** Where the bump is centred. */
  tg: number;
  /** The offset last drawn. */
  drawnX: number;
  drawnY: number;
  held: boolean;
  moving: boolean;
}

interface Pending {
  readonly s: StringState;
  readonly vx: number;
  readonly vy: number;
  readonly t: number;
  readonly at: number;
}

export interface Strings {
  /** Replaces the threads (after the hero is measured again). */
  set(threads: ReadonlyArray<StringThread>): void;
  /** True while the loop runs. */
  running(): boolean;
}

const HIT_SAMPLES = 48;
/** Never a pull from here: links, buttons, form controls, text that can be selected, the window. */
const NOT_A_STRING =
  "a, button, input, label, select, textarea, h1, h2, h3, p, li, [data-hero-window], .hw-wrap, .hw-pick";

export function createStrings(hero: HTMLElement, heartbeat: Heartbeat): Strings {
  let strings: StringState[] = [];
  const pending: Pending[] = [];
  let frame = 0;
  let lastStep = 0;

  const shapeOf = (s: StringState): Pt[] => [
    ...s.head.map(([x, y], i): Pt => {
      const b = bumpAt(s.ts[i]!, s.tg);
      return [x + s.ox * b, y + s.oy * b];
    }),
    ...s.tail,
  ];

  function draw(s: StringState, rest: boolean) {
    if (rest) {
      s.el.setAttribute("d", s.restD);
      if (s.lane) heartbeat.reshape(s.lane, [...s.head, ...s.tail]);
      return;
    }
    const pts = shapeOf(s);
    s.el.setAttribute("d", ribbonOf(pts, s.width));
    if (s.lane) heartbeat.reshape(s.lane, pts);
  }

  function nearest(x: number, y: number) {
    let best: { s: StringState | null; d: number; t: number } = { s: null, d: Infinity, t: 0.5 };
    for (const s of strings) {
      for (const h of s.hit) {
        const b = bumpAt(h.t, s.tg);
        const d = Math.hypot(h.x + s.ox * b - x, h.y + s.oy * b - y);
        if (d < best.d) best = { s, d, t: h.t };
      }
    }
    return best;
  }

  const start = () => {
    if (!frame) {
      lastStep = performance.now();
      frame = requestAnimationFrame(step);
    }
  };

  function step(now: number) {
    frame = 0;
    const dt = Math.min(0.032, (now - lastStep) / 1000);
    lastStep = now;
    for (let i = pending.length - 1; i >= 0; i--) {
      const k = pending[i]!;
      if (k.at > now) continue;
      pending.splice(i, 1);
      if (k.s.held) continue;
      if (!k.s.moving) k.s.tg = k.t;
      k.s.vx += k.vx;
      k.s.vy += k.vy;
      k.s.moving = true;
    }
    let any = pending.length > 0;
    for (const s of strings) {
      if (!s.moving && !s.held) continue;
      if (s.held) {
        // A held string is drawn when the pointer moves it, and costs nothing while it stays put.
        if (s.ox !== s.drawnX || s.oy !== s.drawnY) {
          s.drawnX = s.ox;
          s.drawnY = s.oy;
          draw(s, false);
        }
        continue;
      }
      any = true;
      if (stepSpring(s, dt, !motion())) {
        s.moving = false;
        draw(s, true);
      } else draw(s, false);
      s.drawnX = s.ox;
      s.drawnY = s.oy;
    }
    if (any) frame = requestAnimationFrame(step);
  }

  function kick(s: StringState, vx: number, vy: number, t: number, delay = 0) {
    pending.push({ s, vx, vy, t, at: performance.now() + delay });
    start();
  }

  function flick(s: StringState, t: number, dx: number, dy: number, speed: number) {
    const [vx, vy] = flickVelocity(dx, dy, speed);
    kick(s, vx, vy, t);
    // The curtain ripples: the thread on each side follows, smaller and a moment later.
    for (const nj of [s.j - 1, s.j + 1]) {
      const n = strings.find((other) => other.j === nj);
      if (n && n.band === s.band)
        kick(n, vx * NEIGHBOUR_SHARE, vy * NEIGHBOUR_SHARE, t, NEIGHBOUR_DELAY_MS);
    }
  }

  // ---- pointer
  const toHero = (e: PointerEvent): [number, number] => {
    const r = hero.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  let last: { x: number; y: number; t: number } | null = null;
  let held: { s: StringState; ax: number; ay: number; pointerId: number } | null = null;
  let savedSelect: string | null = null;
  let tap: {
    s: StringState;
    t: number;
    x: number;
    y: number;
    at: number;
    pointerId: number;
  } | null = null;
  const recent = new Map<number, number>();

  hero.addEventListener("pointermove", (e) => {
    if (!strings.length) return;
    const [x, y] = toHero(e);
    const now = performance.now();
    if (held) {
      if (e.pointerId !== held.pointerId) return;
      [held.s.ox, held.s.oy] = holdOffset(x - held.ax, y - held.ay);
      start();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const near = nearest(x, y);
    if (e.pointerType === "mouse") {
      hero.style.cursor = near.d <= HOLD_REACH && !target?.closest(NOT_A_STRING) ? "grab" : "";
    }
    if (last && motion() && near.s && near.d <= FLICK_REACH && e.pointerType === "mouse") {
      const dx = x - last.x;
      const dy = y - last.y;
      const dt = Math.max(8, now - last.t);
      const speed = (Math.hypot(dx, dy) / dt) * 1000;
      const prevAt = recent.get(near.s.j) ?? 0;
      if (speed > FLICK_MIN_SPEED && now - prevAt > FLICK_REST_MS && !near.s.held) {
        recent.set(near.s.j, now);
        flick(near.s, near.t, dx, dy, speed);
      }
    }
    last = { x, y, t: now };
  });
  hero.addEventListener("pointerleave", () => {
    last = null;
    hero.style.cursor = "";
  });

  hero.addEventListener("pointerdown", (e) => {
    if (!strings.length || !e.isPrimary || held) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(NOT_A_STRING)) return;
    const [x, y] = toHero(e);
    const near = nearest(x, y);
    if (!near.s) return;
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") {
      // Touch: a tap on a thread flicks it, once the finger lifts without scrolling or a second finger.
      // No pull, and the page still scrolls and zooms.
      if (near.d <= TAP_REACH && motion())
        tap = { s: near.s, t: near.t, x, y, at: performance.now(), pointerId: e.pointerId };
      return;
    }
    if (e.button !== 0 || near.d > HOLD_REACH) return;
    e.preventDefault();
    const s = near.s;
    s.held = true;
    s.moving = true;
    s.tg = near.t;
    s.vx = 0;
    s.vy = 0;
    const i = s.ts.findIndex((t) => t >= near.t);
    const p = s.head[Math.max(0, i)]!;
    held = { s, ax: p[0], ay: p[1], pointerId: e.pointerId };
    hero.setPointerCapture(e.pointerId);
    hero.style.cursor = "grabbing";
    savedSelect = document.documentElement.style.userSelect;
    document.documentElement.style.userSelect = "none";
    start();
  });

  const release = () => {
    if (savedSelect !== null) {
      document.documentElement.style.userSelect = savedSelect;
      savedSelect = null;
    }
    if (!held) return;
    held.s.held = false;
    held = null;
    hero.style.cursor = "";
    start();
  };
  // Only the pointer holding a string lets it go; another finger or pen lifting elsewhere doesn't.
  const releaseFrom = (e: PointerEvent) => {
    if (held && e.pointerId === held.pointerId) release();
  };
  hero.addEventListener("pointerup", (e) => {
    releaseFrom(e);
    if (tap && e.pointerId === tap.pointerId) {
      const [x, y] = toHero(e);
      const still = Math.hypot(x - tap.x, y - tap.y) < 10 && performance.now() - tap.at < 400;
      if (still) flick(tap.s, tap.t, 1, 0, 420);
      tap = null;
    }
  });
  hero.addEventListener("pointercancel", (e) => {
    releaseFrom(e);
    // The browser took the touch for a scroll or a pinch: no flick.
    tap = null;
  });
  hero.addEventListener("lostpointercapture", releaseFrom);
  // A second finger means a pinch, not a tap.
  hero.addEventListener("pointerdown", (e) => {
    if (tap && e.pointerId !== tap.pointerId) tap = null;
  });
  window.addEventListener("blur", () => {
    release();
    tap = null;
  });

  return {
    set(threads) {
      release();
      pending.length = 0;
      strings = threads.map((thread) => {
        const lens = [0];
        for (let i = 1; i < thread.head.length; i++) {
          const a = thread.head[i - 1]!;
          const b = thread.head[i]!;
          lens.push(lens[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
        }
        const total = lens[lens.length - 1] || 1;
        const ts = lens.map((l) => l / total);
        const hit: StringState["hit"] = [];
        for (let k = 0; k < HIT_SAMPLES; k++) {
          const want = (k + 0.5) / HIT_SAMPLES;
          let i = 0;
          while (i < ts.length - 1 && ts[i]! < want) i++;
          hit.push({ x: thread.head[i]![0], y: thread.head[i]![1], t: ts[i]! });
        }
        return {
          ...thread,
          ts,
          hit,
          ox: 0,
          oy: 0,
          vx: 0,
          vy: 0,
          tg: 0.5,
          drawnX: 0,
          drawnY: 0,
          held: false,
          moving: false,
        };
      });
    },
    running: () => frame !== 0,
  };
}
