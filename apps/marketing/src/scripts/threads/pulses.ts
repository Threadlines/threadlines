/**
 * The heartbeat. A pulse is one round dot with a soft glow, travelling along
 * a lane. A lane shares its thread's
 * geometry (and is given the new points while a string is pulled), so a pulse
 * stays on a bent string and is hidden by the same masks where its band
 * passes under.
 *
 * A pulse is drawn on a short stretch of its lane (STRETCH px) cut from the
 * lane's own points and moved along it by its dash offset; the stretch is cut
 * again only when the pulse runs off its end, about twice a second. So each
 * frame is a cheap offset change, and repaints only the stretch, not the
 * whole length of the line. (Measured both ways: an offset on the full line
 * repaints many screens a second; cutting the dashes every frame costs more
 * style work.)
 *
 * One loop moves every pulse, at most 30 frames a second, from one shared
 * clock: a lane's position is a function of the time, so lanes that were off
 * screen, or a tab that was hidden, come back in step. A lane draws only
 * while its stretch of the page is on screen; the loop stops under reduced
 * motion and while the tab is hidden.
 */
import { type Pt, smooth, stretch } from "./geometry";
import { mk, motion, reducedMotion } from "./dom";

/** The dot is a 1px dash with round caps, so it is as wide as its stroke. */
const DOT = 1;
const HEAD = DOT;
/** The dot's width for a lane's line width: a bead on the thread, never smaller than 3.4px or larger than 5.4px. */
const dotWidth = (line: number) => Math.min(5.4, Math.max(3.4, line * 1.8));
/** How much of a lane a pulse is drawn on at once. */
const STRETCH = 160;
/** At most 30 drawn frames a second, on any display. */
const FRAME_MS = 1000 / 30;

export interface LaneHook {
  /** Distance along the lane where the hook fires as the pulse passes. */
  readonly at: number;
  readonly fn: () => void;
}

export interface LaneOptions {
  readonly parent: Element;
  readonly pts: ReadonlyArray<Pt>;
  readonly color: string;
  /** Clock time (ms) when the pulse leaves the lane's start, in some period. */
  readonly start: number;
  readonly period: number;
  /** px a second. */
  readonly speed: number;
  /** The coordinate space its y values are in, for visibility. */
  readonly space: "hero" | "page";
  /** Fades out between these distances. */
  readonly fade?: readonly [number, number];
  /** The width of the line the pulse rides; the dot is sized from it. */
  readonly width?: number;
  readonly hooks?: ReadonlyArray<LaneHook>;
  /** Added to every y for visibility (a lane drawn inside a panel's own SVG). */
  readonly yOffset?: number;
  readonly className?: string;
  readonly dataS?: string | number;
}

export interface Lane {
  readonly options: LaneOptions;
  readonly group: SVGGElement;
  readonly paths: SVGPathElement[];
  /** The points the pulse travels, and the distance along them at each. */
  pts: ReadonlyArray<Pt>;
  dist: number[];
  L: number;
  /** [distance, y] samples at rest, for visibility and the draw-in limit. */
  ys: [number, number][];
  yMin: number;
  yMax: number;
  last: number;
  /** How much longer than at rest the lane is now (a pulled string): its hooks move by this. */
  stretched: number;
  restL: number;
  shown: boolean;
  /** What the loop last wrote, so an unchanged value isn't written again. */
  opacity: string;
  d: string;
  /** The stretch the paths hold now, by distance along the lane; `from` is -1 when none. */
  from: number;
  to: number;
  offset: string;
}

/** The pulse paths' core: the thread's own color, deeper on light paper and paler on dark, so it reads as that color. */
const coreColor = (color: string) =>
  `light-dark(color-mix(in oklch, ${color}, black 22%), color-mix(in oklch, ${color}, white 70%))`;

export interface Heartbeat {
  /** The shared clock's zero: lanes are timed from it. */
  readonly t0: number;
  lane(options: LaneOptions): Lane;
  /** Points a lane at a new shape (a string being pulled), keeping its timing. */
  reshape(lane: Lane, pts: ReadonlyArray<Pt>): void;
  remove(filter: (lane: Lane) => boolean): void;
  /** Lanes in page space draw only above this y (the trunk's draw-in). */
  setReach(y: number): void;
}

const distances = (pts: ReadonlyArray<Pt>) => {
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    dist.push(dist[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  }
  return dist;
};

export function createHeartbeat(input: {
  /** Where the hero and the page start, relative to the viewport's top. */
  readonly heroTop: () => number;
  readonly pageTop: () => number;
}): Heartbeat {
  const t0 = performance.now();
  let lanes: Lane[] = [];
  let reach = 0;
  let frame = 0;
  let lastFrame = 0;
  let nextFrame = 0;

  const yAt = (lane: Lane, pos: number) => {
    const s = lane.ys;
    if (pos <= 0) return s[0]![1];
    if (pos >= s[s.length - 1]![0]) return s[s.length - 1]![1];
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]![0] <= pos) lo = mid;
      else hi = mid;
    }
    return s[lo]![1];
  };

  const hide = (lane: Lane) => {
    if (!lane.shown) return;
    lane.group.setAttribute("opacity", "0");
    lane.opacity = "0";
    lane.shown = false;
  };

  function tick(now: number) {
    frame = 0;
    if (!running()) return;
    frame = requestAnimationFrame(tick);
    // A schedule, not a minimum gap, so no display's refresh rate gets more than 30 a second.
    if (now + 1 < nextFrame) return;
    nextFrame = nextFrame + FRAME_MS < now ? now + FRAME_MS : nextFrame + FRAME_MS;
    const gap = now - lastFrame;
    lastFrame = now;
    // After a pause (a hidden tab, a long frame), positions jump: no flashes for what was skipped.
    const resumed = gap > 250;
    const viewH = innerHeight;
    const tops = { hero: input.heroTop(), page: input.pageTop() };
    for (const lane of lanes) {
      const o = lane.options;
      const top = -tops[o.space];
      const local = (((now - o.start) % o.period) + o.period) % o.period;
      const pos = (local / 1000) * o.speed;
      // Hooks fire as the pulse passes their point, timed by the clock whether or not the lane shows.
      if (!resumed && lane.last >= 0) {
        for (const hook of o.hooks ?? []) {
          const at = hook.at + lane.stretched;
          if (lane.last < at && pos >= at) hook.fn();
        }
      }
      lane.last = pos;
      if (pos > lane.L + HEAD + 4) {
        hide(lane);
        continue;
      }
      // Drawn only while the pulse itself is near the screen, not just some part of its line.
      const y = yAt(lane, Math.min(pos, lane.restL));
      if (y < top - 120 || y > top + viewH + 120) {
        hide(lane);
        continue;
      }
      let alpha = 1;
      if (o.fade) alpha = 1 - smooth((pos - o.fade[0]) / (o.fade[1] - o.fade[0]));
      if (o.space === "page" && reach && yAt(lane, pos) > reach + 4) alpha = 0;
      // A faded pulse costs nothing: no writes until it shows again.
      if (alpha <= 0) {
        hide(lane);
        continue;
      }
      // Cut a new stretch when the pulse runs off the one the paths hold (or the string moved).
      if (lane.from < 0 || pos - HEAD < lane.from || pos > lane.to) {
        lane.from = Math.max(0, pos - HEAD - 2);
        lane.to = Math.min(lane.L, lane.from + STRETCH);
        const d = stretch(lane.pts, lane.dist, lane.from, lane.to);
        if (d !== lane.d) {
          lane.d = d;
          for (const path of lane.paths) path.setAttribute("d", d);
        }
      }
      const offset = (HEAD - (pos - lane.from)).toFixed(1);
      if (offset !== lane.offset) {
        lane.offset = offset;
        for (const path of lane.paths) path.style.strokeDashoffset = offset;
      }
      const opacity = alpha.toFixed(2);
      if (opacity !== lane.opacity) {
        lane.group.setAttribute("opacity", opacity);
        lane.opacity = opacity;
      }
      lane.shown = true;
    }
  }

  const running = () => motion() && document.visibilityState === "visible" && lanes.length > 0;
  const kick = () => {
    if (!frame && running()) {
      lastFrame = 0;
      nextFrame = 0;
      frame = requestAnimationFrame(tick);
    }
    if (!motion()) for (const lane of lanes) hide(lane);
  };
  document.addEventListener("visibilitychange", kick);
  reducedMotion.addEventListener("change", kick);

  return {
    t0,
    lane(options) {
      const group = mk(
        "g",
        { class: options.className ?? "", "data-s": options.dataS ?? "", opacity: 0 },
        options.parent,
      );
      // One dot as a dash pattern on the stretch, then nothing to its end.
      const dash = `${DOT} ${STRETCH + 600}`;
      const width = dotWidth(options.width ?? 2.6);
      const glow = mk(
        "path",
        {
          "stroke-width": width * 2.3,
          "stroke-dasharray": dash,
          fill: "none",
          "stroke-linecap": "round",
        },
        group,
      );
      glow.style.stroke = `color-mix(in oklch, ${options.color} 62%, transparent)`;
      const core = mk(
        "path",
        {
          "stroke-width": width,
          "stroke-dasharray": dash,
          fill: "none",
          "stroke-linecap": "round",
        },
        group,
      );
      core.style.stroke = coreColor(options.color);
      const dist = distances(options.pts);
      const offset = options.yOffset ?? 0;
      const ys = options.pts.map((p, i): [number, number] => [dist[i]!, p[1] + offset]);
      const lane: Lane = {
        options,
        group,
        paths: [glow, core],
        pts: options.pts,
        dist,
        L: dist[dist.length - 1] ?? 0,
        ys,
        yMin: Math.min(...ys.map((s) => s[1])),
        yMax: Math.max(...ys.map((s) => s[1])),
        last: -1,
        stretched: 0,
        restL: dist[dist.length - 1] ?? 0,
        shown: false,
        opacity: "0",
        d: "",
        from: -1,
        to: -1,
        offset: "",
      };
      lanes.push(lane);
      kick();
      return lane;
    },
    reshape(lane, pts) {
      lane.pts = pts;
      lane.dist = distances(pts);
      lane.L = lane.dist[lane.dist.length - 1] ?? 0;
      lane.stretched = lane.L - lane.restL;
      // The next frame cuts the pulse's stretch from the new shape, even if it hasn't moved.
      lane.d = "";
      lane.from = -1;
    },
    remove(filter) {
      lanes = lanes.filter((lane) => {
        if (!filter(lane)) return true;
        lane.group.remove();
        return false;
      });
    },
    setReach(y) {
      reach = y;
    },
  };
}
