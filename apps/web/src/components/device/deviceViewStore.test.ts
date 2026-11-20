import { ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orderDeviceChips } from "./deviceViewStore";

const session = (deviceId: string, openedAt: string) => ({
  threadId: ThreadId.make("thread"),
  deviceId,
  platform: "ios" as const,
  openedAt,
  bootedByThreadlines: true,
  openedBy: "user" as const,
});

describe("orderDeviceChips", () => {
  const a = session("A", "2026-11-20T10:00:00.000Z");
  const b = session("B", "2026-11-20T10:01:00.000Z");
  const c = session("C", "2026-11-20T10:02:00.000Z");
  const ids = (order: ReadonlyArray<string>) =>
    orderDeviceChips({ order, names: {}, selected: null }, [c, a, b]).map(
      (entry) => entry.deviceId,
    );

  it("keeps opening order when only some chips are remembered", () => {
    // A fresh client remembers only the chip it selected.
    expect(ids(["B"])).toEqual(["A", "B", "C"]);
    expect(ids(["C"])).toEqual(["A", "B", "C"]);
  });

  it("keeps the remembered order among the remembered chips", () => {
    expect(ids(["C", "A"])).toEqual(["C", "B", "A"]);
  });
});
