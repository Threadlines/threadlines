import type { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FleetComputer } from "./fleet.logic";
import type { FleetDirectoryEntry } from "./fleetLinks.logic";
import { describeFleetComputerMenu } from "./useFleetComputerMenu";

function entry(kind: FleetDirectoryEntry["kind"]): FleetDirectoryEntry {
  return {
    key: `env-${kind}`,
    kind,
    environmentId: `env-${kind}` as EnvironmentId,
    label: "Wilfredo",
    displayLabel: "Wilfredo",
  } as FleetDirectoryEntry;
}

const labels = (items: ReturnType<typeof describeFleetComputerMenu>) =>
  items.map((item) => `${item.label}${item.disabled ? " (off)" : ""}`);

describe("describeFleetComputerMenu", () => {
  it("offers Rename for computers this app reaches, off while one can't take a name", () => {
    expect(
      labels(
        describeFleetComputerMenu({
          target: { kind: "computer", entry: entry("saved") },
          canRename: true,
        }),
      ),
    ).toEqual(["Open", "Rename…"]);
    // Offline, or a version too old for names: still there, so it can be found.
    expect(
      labels(
        describeFleetComputerMenu({
          target: { kind: "computer", entry: entry("this") },
          canRename: false,
        }),
      ),
    ).toEqual(["Open", "Rename… (off)"]);
    // Linked through another computer: renamed where it is reached.
    expect(
      labels(
        describeFleetComputerMenu({
          target: { kind: "computer", entry: entry("linked") },
          canRename: true,
        }),
      ),
    ).toEqual(["Open"]);
  });

  it("renames a phone on the map, or opens its Connections settings", () => {
    const phone = { id: "device:session-1", kind: "device", label: "iPhone" } as FleetComputer;
    expect(
      labels(
        describeFleetComputerMenu({ target: { kind: "device", computer: phone }, canRename: true }),
      ),
    ).toEqual(["Rename…", "Connections settings"]);
  });
});
