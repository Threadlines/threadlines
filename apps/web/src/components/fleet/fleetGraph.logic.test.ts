import { describe, expect, it } from "vite-plus/test";

import {
  buildTravelingDotKeyframes,
  curveControlPoint,
  FLEET_COMPUTER_NODE_RADIUS,
  FLEET_GRAPH_MAX_COMPUTERS,
  FLEET_PROVIDER_NODE_RADIUS,
  layoutFleetGraph,
  travelingDotDelaySeconds,
} from "./fleetGraph.logic";

describe("layoutFleetGraph", () => {
  it("keeps every node on the stage, the same way every time", () => {
    const input = {
      width: 880,
      height: 300,
      centerProviderCount: 3,
      otherProviderCounts: Array.from({ length: 12 }, () => 4),
    };
    const layout = layoutFleetGraph(input);
    expect(layoutFleetGraph(input)).toEqual(layout);
    // Past eight computers, the rest are in the list only.
    expect(layout.others).toHaveLength(FLEET_GRAPH_MAX_COMPUTERS);
    const points = [
      layout.center,
      ...layout.centerProviders,
      ...layout.others,
      ...layout.otherProviders.flat(),
    ];
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(input.width);
      expect(point.y).toBeGreaterThan(0);
      // Room for a label under the lowest node.
      expect(point.y).toBeLessThanOrEqual(input.height - 44);
    }
    // This computer's agents sit above it, clear of the arc of computers.
    for (const provider of layout.centerProviders) {
      expect(provider.y).toBeLessThan(layout.center.y);
    }
  });

  it("keeps two agents of another computer apart on a phone-width stage", () => {
    // The stage's edge used to push both onto the same spot above their computer.
    const layout = layoutFleetGraph({
      width: 300,
      height: 270,
      centerProviderCount: 2,
      otherProviderCounts: [2],
    });
    expect(touchingNodes(layout)).toEqual([]);
  });

  it("keeps every node apart with eight computers of four agents each", () => {
    const layout = layoutFleetGraph({
      width: 880,
      height: 300,
      centerProviderCount: 4,
      otherProviderCounts: Array.from({ length: FLEET_GRAPH_MAX_COMPUTERS }, () => 4),
    });
    expect(layout.otherProviders.flat()).toHaveLength(FLEET_GRAPH_MAX_COMPUTERS * 4);
    expect(touchingNodes(layout)).toEqual([]);
  });
});

/** Every pair of nodes whose circles overlap, as readable labels. */
function touchingNodes(layout: ReturnType<typeof layoutFleetGraph>): string[] {
  const nodes = [
    { name: "this computer", point: layout.center, radius: FLEET_COMPUTER_NODE_RADIUS },
    ...layout.others.map((point, index) => ({
      name: `computer ${index}`,
      point,
      radius: FLEET_COMPUTER_NODE_RADIUS,
    })),
    ...layout.centerProviders.map((point, index) => ({
      name: `this computer's agent ${index}`,
      point,
      radius: FLEET_PROVIDER_NODE_RADIUS,
    })),
    ...layout.otherProviders.flatMap((points, computer) =>
      points.map((point, index) => ({
        name: `computer ${computer}'s agent ${index}`,
        point,
        radius: FLEET_PROVIDER_NODE_RADIUS,
      })),
    ),
  ];
  return nodes.flatMap((a, index) =>
    nodes
      .slice(index + 1)
      .filter((b) => Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < a.radius + b.radius)
      .map((b) => `${a.name} / ${b.name}`),
  );
}

describe("buildTravelingDotKeyframes", () => {
  it("moves the dot with transform and opacity only, edge to edge, in half the cycle", () => {
    const { dot, ring } = buildTravelingDotKeyframes("fleet-test-0", {
      from: { x: 100, y: 100 },
      to: { x: 400, y: 100 },
      fromRadius: 21,
      toRadius: 14,
    });
    const properties = new Set(
      [...`${dot}${ring}`.matchAll(/([a-z-]+):/g)].map((match) => match[1]),
    );
    expect([...properties].toSorted()).toEqual(["opacity", "transform"]);
    // It leaves the asking node's edge and stops at the working node's edge.
    expect(dot).toContain("0.00%{transform:translate(121.0px,");
    expect(dot).toContain("50.00%{transform:translate(386.0px,");
    expect(ring).toContain("translate(400.0px,100.0px)");
    // Lines take turns: no two of the first four start together.
    const delays = [0, 1, 2, 3].map(travelingDotDelaySeconds);
    expect(new Set(delays).size).toBe(4);
  });

  it("bows a line between two other computers away from this one, whichever way it runs", () => {
    const center = { x: 300, y: 100 };
    const left = { x: 100, y: 200 };
    const right = { x: 500, y: 200 };
    for (const [from, to] of [
      [left, right],
      [right, left],
    ] as const) {
      // This computer is above the line: it bows below.
      expect(curveControlPoint(from, to, center).y).toBeGreaterThan(200);
    }
  });
});
