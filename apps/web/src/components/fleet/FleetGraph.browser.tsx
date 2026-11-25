import "../../index.css";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { buildFleetModel, type FleetComputerInput, type FleetThreadInput } from "./fleet.logic";
import { FleetGraph } from "./FleetGraph";
import type { FleetGraphEdge } from "./fleetLinks.logic";

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

  it("keeps three computers and active agents clear of each other on a phone", async () => {
    const mac = EnvironmentId.make("env-mac");
    const desktopA = EnvironmentId.make("env-desktop-a");
    const desktopB = EnvironmentId.make("env-desktop-b");
    const workThread = (
      id: string,
      instanceId: string,
      driverKind: "antigravity" | "claudeAgent",
    ): FleetThreadInput => ({
      threadKey: `${mac}:${id}`,
      environmentId: mac,
      threadId: ThreadId.make(id),
      title: id,
      projectLabel: "threadlines",
      status: null,
      attention: "working",
      sessionLive: true,
      provider: { instanceId: ProviderInstanceId.make(instanceId), driverKind },
      modelSelection: null,
      startedByTitle: null,
      startedByComputer: null,
    });
    const model = buildFleetModel({
      center: computer({
        id: "this-phone",
        environmentId: null,
        label: "This phone",
        kind: "this",
        glyph: "phone",
        route: null,
      }),
      others: [
        computer({
          id: desktopA,
          label: "DESKTOP-PSHNIVI",
          kind: "linked",
          connection: "offline",
          linkedWith: "M5 Pro MacBook Pro",
          route: null,
          lastSeenAt: "2026-10-25T20:00:00.000Z",
        }),
        computer({ id: mac, label: "M5 Pro MacBook Pro", glyph: "laptop", route: "relay" }),
        computer({
          id: desktopB,
          label: "Will's Windows Desktop",
          kind: "linked",
          connection: "offline",
          linkedWith: "M5 Pro MacBook Pro",
          route: null,
          lastSeenAt: "2026-10-26T02:00:00.000Z",
        }),
      ],
      threads: [
        workThread("t1", "antigravity", "antigravity"),
        workThread("t2", "claude", "claudeAgent"),
      ],
    });
    const edges: FleetGraphEdge[] = [
      { key: `connection:${mac}`, fromId: "this-phone", toId: mac, state: "working" },
      { key: `link:${mac}:${desktopA}`, fromId: mac, toId: desktopA, state: "offline" },
      { key: `link:${mac}:${desktopB}`, fromId: mac, toId: desktopB, state: "offline" },
    ];
    mounted = await render(
      <div style={{ width: 358 }}>
        <FleetGraph
          model={model}
          edges={edges}
          nowMs={Date.parse("2026-10-26T08:25:00.000Z")}
          height={374}
          onOpenComputer={() => {}}
          providerLabel={(provider) =>
            provider.driverKind === "antigravity" ? "Antigravity" : "Claude"
          }
        />
      </div>,
    );

    const stage = page.getByTestId("fleet-graph").element().getBoundingClientRect();
    const labelIds = ["this-phone", desktopA, mac, desktopB];
    await expect
      .poll(() => {
        const boxes = [
          ...labelIds.map((id) =>
            page.getByTestId(`fleet-node-label-${id}`).element().getBoundingClientRect(),
          ),
          ...["antigravity", "claude"].map((key) =>
            page
              .getByTestId(`fleet-provider-${key}`)
              .element()
              .querySelector("span:last-child")!
              .getBoundingClientRect(),
          ),
        ];
        const allInside = boxes.every(
          (box) =>
            box.left >= stage.left - 1 &&
            box.right <= stage.right + 1 &&
            box.top >= stage.top - 1 &&
            box.bottom <= stage.bottom + 1,
        );
        if (!allInside) return false;
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i]!;
            const b = boxes[j]!;
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
              return false;
            }
          }
        }
        return true;
      })
      .toBe(true);
  });

  it("opens a computer's or a phone's menu where it is right-clicked", async () => {
    const model = buildFleetModel({
      center: computer({ id: "env-mac", label: "Studio Mac", kind: "this", glyph: "laptop" }),
      others: [
        computer({ id: "env-windows", label: "Wilfredo" }),
        {
          ...computer({
            id: "device:session-phone",
            label: "iPhone",
            kind: "device",
            glyph: "phone",
          }),
          environmentId: null,
          device: { sessionId: "session-phone", name: "iPhone", ownName: "iPhone" },
        },
      ],
      threads: [],
    });
    const opened: Array<string> = [];
    const menus: Array<{ readonly id: string; readonly x: number; readonly y: number }> = [];
    mounted = await render(
      <div style={{ width: 720 }}>
        <FleetGraph
          model={model}
          edges={[]}
          nowMs={Date.parse("2026-10-26T08:25:00.000Z")}
          height={320}
          onOpenComputer={(target) => opened.push(target.id)}
          onComputerMenu={(target, position) => menus.push({ id: target.id, ...position })}
          providerLabel={() => "Claude"}
        />
      </div>,
    );

    for (const id of ["env-windows", "device:session-phone"]) {
      const node = page.getByTestId(`fleet-node-${id}`);
      await expect.element(node).toBeInTheDocument();
      await node.click({ button: "right" });
    }
    expect(menus.map((menu) => menu.id)).toEqual(["env-windows", "device:session-phone"]);
    expect(menus.every((menu) => menu.x > 0 && menu.y > 0)).toBe(true);
    // A right-click never also opens the computer.
    expect(opened).toEqual([]);

    // A finger held well past the menu opening: lifting it opens nothing more.
    const windows = page.getByTestId("fleet-node-env-windows").element();
    const box = windows.getBoundingClientRect();
    const at = { clientX: box.left + box.width / 2, clientY: box.top + 20 };
    const touch = { ...at, bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 7 };
    windows.dispatchEvent(new PointerEvent("pointerdown", touch));
    await expect.poll(() => menus.length, { timeout: 2000 }).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    windows.dispatchEvent(new PointerEvent("pointerup", touch));
    windows.dispatchEvent(new MouseEvent("click", { ...at, bubbles: true }));
    expect(opened).toEqual([]);
  });
});
