import "../../index.css";

import type { EnvironmentId } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { buildFleetModel, type FleetComputerInput } from "./fleet.logic";
import { FleetGraph } from "./FleetGraph";

function computer(
  overrides: Partial<FleetComputerInput> & Pick<FleetComputerInput, "id" | "label">,
): FleetComputerInput {
  return {
    environmentId: overrides.id as EnvironmentId,
    kind: "computer",
    glyph: "monitor",
    connection: "connected",
    route: "relay",
    lastSeenAt: null,
    ...overrides,
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe("FleetGraph", () => {
  it("keeps every computer's name and status inside the graph on a phone", async () => {
    // The phone app's graph: the phone in the middle, a computer on each side.
    const model = buildFleetModel({
      center: computer({ id: "this-phone", label: "This phone", kind: "this", glyph: "phone" }),
      others: [
        computer({
          id: "env-windows",
          label: "Wilfredo",
          kind: "linked",
          linkedWith: "Denys's MacBook Pro",
          route: null,
        }),
        computer({ id: "env-mac", label: "Denys's MacBook Pro", glyph: "laptop" }),
      ],
      threads: [],
    });
    mounted = await render(
      <div style={{ width: 358 }}>
        <FleetGraph
          model={model}
          edges={[]}
          nowMs={Date.parse("2026-10-26T08:25:00.000Z")}
          height={300}
          onOpenComputer={() => {}}
          providerLabel={() => "Claude"}
        />
      </div>,
    );

    await expect.element(page.getByText("Linked with Denys's MacBook Pro")).toBeInTheDocument();
    const stage = page.getByTestId("fleet-graph").element().getBoundingClientRect();
    for (const id of ["env-windows", "env-mac", "this-phone"]) {
      await expect
        .poll(() => {
          const label = page.getByTestId(`fleet-node-label-${id}`).element();
          const box = label.getBoundingClientRect();
          return box.left >= stage.left && box.right <= stage.right;
        })
        .toBe(true);
    }
  });
});
