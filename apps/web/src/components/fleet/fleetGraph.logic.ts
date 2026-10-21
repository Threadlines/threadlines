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

function clampPoint(
  point: Point,
  width: number,
  height: number,
  paddingX: number = EDGE_PADDING_X,
): Point {
  return {
    x: Math.min(Math.max(point.x, paddingX), width - paddingX),
    y: Math.min(Math.max(point.y, EDGE_PADDING_TOP), height - EDGE_PADDING_BOTTOM),
  };
}

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

/** Points along the arc of computers when spacing them out. */
const ARC_SAMPLES = 240;
/** Clear space kept between any two nodes' edges. */
const NODE_GAP = 8;
/** The name and location line under a computer, roughly. */
const COMPUTER_LABEL = { halfWidth: 44, offset: 6, height: 32 } as const;
/** An agent's name, above or below it (see FleetGraph's ProviderNode). */
const PROVIDER_LABEL = { halfWidth: 28, offset: 2, height: 16 } as const;
/** An agent's name is shorter than a computer's, so agents may go nearer the sides. */
const PROVIDER_EDGE_PADDING_X = 36;
/** Directions tried around an agent's own spot, nearest first. */
const SEARCH_STEP_DEG = 15;
/** Distances tried, as shares of the agent's usual distance from its computer. */
const SEARCH_SCALES = [1, 0.8, 1.25, 1.5] as const;
/**
 * What a placement costs, in degrees off the agent's own spot: a pixel of a
 * node overlapping another, a pixel of a name or line covered, and moving
 * the whole usual distance nearer or further.
 */
const NODE_OVERLAP_COST = 1000;
const SOFT_OVERLAP_COST = 4;
const DISTANCE_CHANGE_COST = 40;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Circle {
  readonly center: Point;
  readonly radius: number;
}

/** What a placed node takes up: a circle nothing may touch, and a label nothing should. */
interface Footprint {
  readonly circle: Circle;
  readonly label: Box;
  /** Both, plus the gap: nothing outside it can touch either. */
  readonly bounds: Box;
}

function boxAround(point: Point, reach: number): Box {
  return {
    left: point.x - reach,
    top: point.y - reach,
    right: point.x + reach,
    bottom: point.y + reach,
  };
}

function unionBox(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function boxesMeet(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function footprint(center: Point, radius: number, label: Box): Footprint {
  return {
    circle: { center, radius },
    label,
    bounds: unionBox(boxAround(center, radius + NODE_GAP), label),
  };
}

function computerFootprint(point: Point): Footprint {
  const top = point.y + FLEET_COMPUTER_NODE_RADIUS + COMPUTER_LABEL.offset;
  return footprint(point, FLEET_COMPUTER_NODE_RADIUS, {
    left: point.x - COMPUTER_LABEL.halfWidth,
    right: point.x + COMPUTER_LABEL.halfWidth,
    top,
    bottom: top + COMPUTER_LABEL.height,
  });
}

/** An agent's label sits above it when the agent is above its computer, as the graph draws it. */
function providerFootprint(point: Point, computer: Point): Footprint {
  const edge = FLEET_PROVIDER_NODE_RADIUS + PROVIDER_LABEL.offset;
  const top = point.y < computer.y ? point.y - edge - PROVIDER_LABEL.height : point.y + edge;
  return footprint(point, FLEET_PROVIDER_NODE_RADIUS, {
    left: point.x - PROVIDER_LABEL.halfWidth,
    right: point.x + PROVIDER_LABEL.halfWidth,
    top,
    bottom: top + PROVIDER_LABEL.height,
  });
}

function distanceToBox(point: Point, box: Box): number {
  const dx = Math.max(box.left - point.x, 0, point.x - box.right);
  const dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return Math.hypot(dx, dy);
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
        );
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function boxOverlap(a: Box, b: Box): number {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? Math.min(x, y) : 0;
}

/** A drawn line, as a few straight pieces along its curve. */
interface Line {
  readonly points: readonly Point[];
  readonly bounds: Box;
}

const LINE_PIECES = 4;

function lineBetween(from: Point, to: Point): Line {
  const control = curveControlPoint(from, to);
  const points = Array.from({ length: LINE_PIECES + 1 }, (_, index) =>
    pointOnCurve(from, control, to, index / LINE_PIECES),
  );
  return {
    points,
    bounds: {
      left: Math.min(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      right: Math.max(...points.map((point) => point.x)),
      bottom: Math.max(...points.map((point) => point.y)),
    },
  };
}

/** Roughly how many pixels of `line` run through `box`. */
function lengthInBox(line: Line, box: Box): number {
  if (!boxesMeet(line.bounds, box)) return 0;
  const steps = 4;
  let inside = 0;
  const { points } = line;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const stepLength = Math.hypot(to.x - from.x, to.y - from.y) / steps;
    for (let step = 0; step < steps; step += 1) {
      const t = (step + 0.5) / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      if (x > box.left && x < box.right && y > box.top && y < box.bottom) inside += stepLength;
    }
  }
  return inside;
}

function distanceToLine(point: Point, line: Line): number {
  const { points } = line;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    nearest = Math.min(nearest, distanceToSegment(point, points[index - 1]!, points[index]!));
  }
  return nearest;
}

/** Everything already on the stage, which the next agent has to keep clear of. */
interface Stage {
  readonly width: number;
  readonly height: number;
  readonly footprints: Footprint[];
  readonly lines: Line[];
}

/**
 * How bad it is to put an agent of `computer` at `point`: touching a node
 * costs far more than covering a label or sitting on a line, and both cost
 * more than drifting from the agent's own spot.
 */
function placementCost(stage: Stage, computer: Point, point: Point): number {
  const candidate = providerFootprint(point, computer);
  const ownLine = lineBetween(computer, point);
  // Anything that can touch the candidate meets this box; the rest is skipped.
  const reach = unionBox(candidate.bounds, ownLine.bounds);
  const near = boxAround(point, FLEET_PROVIDER_NODE_RADIUS);
  let nodeOverlap = 0;
  let softOverlap = 0;
  for (const placed of stage.footprints) {
    if (!boxesMeet(reach, placed.bounds)) continue;
    const { center, radius } = placed.circle;
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    nodeOverlap += Math.max(0, FLEET_PROVIDER_NODE_RADIUS + radius + NODE_GAP - distance);
    softOverlap += Math.max(0, FLEET_PROVIDER_NODE_RADIUS - distanceToBox(point, placed.label));
    softOverlap += Math.max(0, radius - distanceToBox(center, candidate.label));
    softOverlap += boxOverlap(candidate.label, placed.label);
    // This agent's own line running through another node, or through any name
    // (its own computer's included: an agent straight below it would cross it).
    if (center !== computer) {
      softOverlap += Math.max(0, radius - distanceToLine(center, ownLine));
    }
    softOverlap += lengthInBox(ownLine, placed.label);
  }
  for (const line of stage.lines) {
    if (!boxesMeet(near, line.bounds)) continue;
    softOverlap += Math.max(0, FLEET_PROVIDER_NODE_RADIUS - distanceToLine(point, line));
  }
  return nodeOverlap * NODE_OVERLAP_COST + softOverlap * SOFT_OVERLAP_COST;
}

/**
 * Places `count` agents around `computer`, fanned `stepDeg` apart on an
 * ellipse of `distance` centered on `directionDeg`. Each agent takes its own
 * spot when that is clear; otherwise the clear spot nearest to it, trying
 * other directions and distances. Every placed agent joins `stage`.
 */
function placeProviders(
  stage: Stage,
  computer: Point,
  count: number,
  directionDeg: number,
  distance: { readonly x: number; readonly y: number },
  stepDeg: number,
): Point[] {
  const placed: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const ownDeg = directionDeg + (index - (count - 1) / 2) * stepDeg;
    let best: Point | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn * SEARCH_STEP_DEG <= 180; turn += 1) {
      for (const side of turn === 0 ? [1] : [1, -1]) {
        const offsetDeg = side * turn * SEARCH_STEP_DEG;
        for (const scale of SEARCH_SCALES) {
          const angle = degrees(ownDeg + offsetDeg);
          const point = clampPoint(
            {
              x: computer.x + Math.cos(angle) * distance.x * scale,
              y: computer.y + Math.sin(angle) * distance.y * scale,
            },
            stage.width,
            stage.height,
            PROVIDER_EDGE_PADDING_X,
          );
          const cost =
            placementCost(stage, computer, point) +
            Math.abs(offsetDeg) +
            Math.abs(scale - 1) * DISTANCE_CHANGE_COST;
          if (cost < bestCost) {
            best = point;
            bestCost = cost;
          }
        }
      }
      // A clear spot this close to its own beats any further round.
      if (bestCost <= (turn + 1) * SEARCH_STEP_DEG) break;
    }
    const point = best!;
    placed.push(point);
    stage.footprints.push(providerFootprint(point, computer));
    stage.lines.push(lineBetween(computer, point));
  }
  return placed;
}

/**
 * This computer sits in the middle with its agents fanned above it. The other
 * computers go around it on an arc through the bottom (leaving the top to
 * those agents), evenly spaced along it in the order given, which the model
 * keeps by name. Each one's agents fan outward, away from the middle, and sideways when
 * outward would run off the bottom. No agent lands on a node, and none covers
 * a name or a line when there is room elsewhere: a narrow stage moves an agent
 * to the nearest clear spot.
 */
export function layoutFleetGraph(input: FleetGraphLayoutInput): FleetGraphLayout {
  const { width, height } = input;
  // Alone, this computer sits low with its agents above it; with company it
  // sits higher, leaving the bottom of the arc to the others.
  const alone = input.otherProviderCounts.length === 0;
  const center = { x: width / 2, y: height * (alone ? 0.6 : 0.42) };

  const count = Math.min(input.otherProviderCounts.length, FLEET_GRAPH_MAX_COMPUTERS);
  // From a little above the right, through the bottom, to a little above the left.
  const startDeg = -14;
  const endDeg = 194;
  const radius = { x: Math.min(width * 0.36, 340), y: height * 0.36 };
  // The arc as drawn (the stage's edges flatten it), finely sampled, so the
  // computers can be spaced evenly along it: even angles would bunch them up
  // the steep sides of a wide ellipse, each name under the next one.
  const arc = Array.from({ length: ARC_SAMPLES + 1 }, (_, sample) => {
    const angle = degrees(startDeg + ((endDeg - startDeg) * sample) / ARC_SAMPLES);
    return clampPoint(
      {
        x: center.x + Math.cos(angle) * radius.x,
        y: center.y + Math.sin(angle) * radius.y,
      },
      width,
      height,
    );
  });
  const travelled = [0];
  for (let sample = 1; sample < arc.length; sample += 1) {
    const from = arc[sample - 1]!;
    const to = arc[sample]!;
    travelled.push(travelled[sample - 1]! + Math.hypot(to.x - from.x, to.y - from.y));
  }
  const arcLength = travelled.at(-1)!;
  const others: Point[] = [];
  let sample = 0;
  for (let index = 0; index < count; index += 1) {
    const target = count === 1 ? 0 : (arcLength * index) / (count - 1);
    while (sample < ARC_SAMPLES && travelled[sample]! < target - 1e-9) sample += 1;
    others.push(arc[sample]!);
  }

  // Every computer is on the stage before any agent, so agents keep clear of all of them.
  const stage: Stage = {
    width,
    height,
    footprints: [center, ...others].map(computerFootprint),
    lines: others.map((position) => lineBetween(center, position)),
  };
  const centerProviderCount = Math.min(input.centerProviderCount, FLEET_GRAPH_MAX_PROVIDERS);
  const centerProviders = placeProviders(
    stage,
    center,
    centerProviderCount,
    -90,
    { x: Math.min(alone ? 170 : 130, width * 0.18), y: height * (alone ? 0.42 : 0.3) },
    centerProviderCount > 2 ? 34 : 46,
  );
  const otherProviders = others.map((position, index) => {
    const outward = Math.atan2(position.y - center.y, position.x - center.x);
    // Pointing down would put the agents under the stage's edge: turn them
    // to the side the computer is on, slightly up.
    const directionDeg =
      Math.sin(outward) > 0.35 ? (Math.cos(outward) >= 0 ? -24 : 204) : (outward * 180) / Math.PI;
    return placeProviders(
      stage,
      position,
      Math.min(input.otherProviderCounts[index] ?? 0, FLEET_GRAPH_MAX_PROVIDERS),
      directionDeg,
      { x: 74, y: 62 },
      40,
    );
  });
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
