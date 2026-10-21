/**
 * Where the Fleet graph puts things, and the keyframes its traveling dots run
 * on. Pure geometry: given the stage's size and how many computers and agents
 * there are, the same input always lands in the same place, so the graph
 * holds still between renders.
 *
 * The dots are built for zero repaints (docs/design/fleet.md, "Traveling
 * dots"): HTML elements over the SVG that animate only `transform` and
 * `opacity`, with each curve sampled into a short list of translate
 * keyframes. Nothing here animates an SVG attribute.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Most computers the graph draws; the rest are in the list below it only. */
export const FLEET_GRAPH_MAX_COMPUTERS = 8;
/** Most agents drawn around one computer. */
export const FLEET_GRAPH_MAX_PROVIDERS = 4;
/** Most lines with a dot moving at once. */
export const FLEET_GRAPH_MAX_MOVING_LINES = 8;
export const FLEET_COMPUTER_NODE_RADIUS = 21;
export const FLEET_PROVIDER_NODE_RADIUS = 14;
/** One trip and the rest that follows it; lines take turns within it. */
export const FLEET_DOT_CYCLE_SECONDS = 3.2;
/** The share of the cycle a dot spends travelling. */
const DOT_TRAVEL_SHARE = 0.5;
const DOT_SAMPLES = 16;
/** Keeps nodes and their labels inside the stage. */
const EDGE_PADDING_X = 56;
const EDGE_PADDING_TOP = 34;
const EDGE_PADDING_BOTTOM = 44;

export interface FleetGraphLayoutInput {
  readonly width: number;
  readonly height: number;
  /** Agents around this computer. */
  readonly centerProviderCount: number;
  /** Agents around each other computer, in the order they are drawn. */
  readonly otherProviderCounts: readonly number[];
}

export interface FleetGraphLayout {
  readonly center: Point;
  readonly centerProviders: readonly Point[];
  readonly others: readonly Point[];
  readonly otherProviders: readonly (readonly Point[])[];
}

function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, EDGE_PADDING_X), width - EDGE_PADDING_X),
    y: Math.min(Math.max(point.y, EDGE_PADDING_TOP), height - EDGE_PADDING_BOTTOM),
  };
}

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

/** Points fanned around `origin` at `distance`, centered on `directionDeg`. */
function fan(
  origin: Point,
  count: number,
  directionDeg: number,
  distance: { readonly x: number; readonly y: number },
  stepDeg: number,
): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = degrees(directionDeg + (index - (count - 1) / 2) * stepDeg);
    return {
      x: origin.x + Math.cos(angle) * distance.x,
      y: origin.y + Math.sin(angle) * distance.y,
    };
  });
}

/**
 * This computer sits in the middle with its agents fanned above it. The other
 * computers go around it on an arc through the bottom (leaving the top to
 * those agents), evenly spaced in the order given, which the model keeps by
 * name. Each one's agents fan outward, away from the middle, and sideways when
 * outward would run off the bottom.
 */
export function layoutFleetGraph(input: FleetGraphLayoutInput): FleetGraphLayout {
  const { width, height } = input;
  // Alone, this computer sits low with its agents above it; with company it
  // sits higher, leaving the bottom of the arc to the others.
  const alone = input.otherProviderCounts.length === 0;
  const center = { x: width / 2, y: height * (alone ? 0.6 : 0.42) };
  const centerProviders = fan(
    center,
    Math.min(input.centerProviderCount, FLEET_GRAPH_MAX_PROVIDERS),
    -90,
    { x: Math.min(alone ? 170 : 130, width * 0.18), y: height * (alone ? 0.42 : 0.3) },
    input.centerProviderCount > 2 ? 34 : 46,
  ).map((point) => clampPoint(point, width, height));

  const count = Math.min(input.otherProviderCounts.length, FLEET_GRAPH_MAX_COMPUTERS);
  // From a little above the right, through the bottom, to a little above the left.
  const startDeg = -14;
  const endDeg = 194;
  const radius = { x: Math.min(width * 0.36, 340), y: height * 0.36 };
  const others: Point[] = [];
  const otherProviders: Point[][] = [];
  for (let index = 0; index < count; index += 1) {
    const angleDeg =
      count === 1 ? startDeg : startDeg + ((endDeg - startDeg) * index) / (count - 1);
    const position = clampPoint(
      {
        x: center.x + Math.cos(degrees(angleDeg)) * radius.x,
        y: center.y + Math.sin(degrees(angleDeg)) * radius.y,
      },
      width,
      height,
    );
    others.push(position);
    const outward = Math.atan2(position.y - center.y, position.x - center.x);
    const outwardDeg = (outward * 180) / Math.PI;
    // Pointing down would put the agents under the stage's edge: turn them
    // to the side the computer is on, slightly up.
    const directionDeg =
      Math.sin(outward) > 0.35 ? (Math.cos(outward) >= 0 ? -24 : 204) : outwardDeg;
    const providerCount = Math.min(
      input.otherProviderCounts[index] ?? 0,
      FLEET_GRAPH_MAX_PROVIDERS,
    );
    const fanToward = (towardDeg: number) =>
      fan(position, providerCount, towardDeg, { x: 74, y: 62 }, 40).map((point) =>
        clampPoint(point, width, height),
      );
    const outwardFan = fanToward(directionDeg);
    // On a narrow stage the edge can push an agent back onto its computer:
    // fan those upward instead, where the arc leaves room.
    otherProviders.push(
      outwardFan.some(
        (point) =>
          Math.hypot(point.x - position.x, point.y - position.y) <
          FLEET_COMPUTER_NODE_RADIUS + FLEET_PROVIDER_NODE_RADIUS + 16,
      )
        ? fanToward(-90)
        : outwardFan,
    );
  }
  return { center, centerProviders, others, otherProviders };
}

/** A gentle quadratic curve from one node to another: its control point. */
export function curveControlPoint(from: Point, to: Point): Point {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // A fixed share of the length, to one side, so every line bends the same way.
  return { x: midX - dy * 0.16, y: midY + dx * 0.16 };
}

export function curvePath(from: Point, to: Point): string {
  const control = curveControlPoint(from, to);
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)}Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function pointOnCurve(from: Point, control: Point, to: Point, t: number): Point {
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const c = t * t;
  return {
    x: a * from.x + b * control.x + c * to.x,
    y: a * from.y + b * control.y + c * to.y,
  };
}

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** One moving line: from the node that asks to the node that works. */
export interface TravelingLine {
  readonly from: Point;
  readonly to: Point;
  readonly fromRadius: number;
  readonly toRadius: number;
}

/**
 * Keyframes for a dot travelling `line`, and for the ring it leaves on
 * arrival. The trip runs between the two nodes' edges, eased in and out, in
 * the first half of the cycle; the dot then fades and waits. Only translate,
 * scale and opacity change.
 */
export function buildTravelingDotKeyframes(
  name: string,
  line: TravelingLine,
): { readonly dot: string; readonly ring: string } {
  const control = curveControlPoint(line.from, line.to);
  const length = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y) || 1;
  // Close enough to where the curve crosses each node's edge for a short line.
  const startT = Math.min(0.45, line.fromRadius / length);
  const endT = Math.max(0.55, 1 - line.toRadius / length);
  const frames: string[] = [];
  for (let sample = 0; sample <= DOT_SAMPLES; sample += 1) {
    const progress = sample / DOT_SAMPLES;
    const t = startT + (endT - startT) * easeInOut(progress);
    const point = pointOnCurve(line.from, control, line.to, t);
    const opacity = sample === 0 ? 0 : sample === DOT_SAMPLES ? 0.9 : 1;
    frames.push(
      `${percent(progress * DOT_TRAVEL_SHARE)}{transform:translate(${point.x.toFixed(1)}px,${point.y.toFixed(1)}px);opacity:${opacity}}`,
    );
  }
  const end = pointOnCurve(line.from, control, line.to, endT);
  const endTransform = `translate(${end.x.toFixed(1)}px,${end.y.toFixed(1)}px)`;
  frames.push(`${percent(DOT_TRAVEL_SHARE + 0.04)},100%{transform:${endTransform};opacity:0}`);
  const target = `translate(${line.to.x.toFixed(1)}px,${line.to.y.toFixed(1)}px)`;
  const ring = [
    `0%,${percent(DOT_TRAVEL_SHARE - 0.02)}{transform:${target} scale(.75);opacity:0}`,
    `${percent(DOT_TRAVEL_SHARE + 0.02)}{transform:${target} scale(1);opacity:.75}`,
    `${percent(DOT_TRAVEL_SHARE + 0.3)},100%{transform:${target} scale(1.6);opacity:0}`,
  ];
  return {
    dot: `@keyframes ${name}{${frames.join("")}}`,
    ring: `@keyframes ${name}-ring{${ring.join("")}}`,
  };
}

/**
 * When a moving line starts its cycle, so lines take turns rather than
 * firing together. Negative, so a dot is already on its way when the page
 * opens.
 */
export function travelingDotDelaySeconds(index: number): number {
  const step = FLEET_DOT_CYCLE_SECONDS / 4;
  return -((index * step) % FLEET_DOT_CYCLE_SECONDS);
}
