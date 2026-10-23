import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_STALL_RECENT_MS,
  describeComputerStall,
  describeComputerStallNote,
  formatStallDuration,
  isComputerStallRecent,
  receiveComputerStall,
} from "./computerStall.ts";

const macMini = { name: "Mac mini", thisComputer: false };
const here = { name: "MacBook Pro", thisComputer: true };

describe("describeComputerStall", () => {
  it("says what stopped the computer, in its own words for each cause", () => {
    expect(
      describeComputerStall(
        {
          id: "a-1",
          cause: "overloaded",
          durationMs: 12_400,
          agoMs: 0,
          load: { average1m: 219.4, cpuCount: 18 },
        },
        macMini,
      ),
    ).toEqual({
      title: "Mac mini froze for 12s",
      description: "Its CPU was overloaded (load 219.4 on 18 cores).",
    });
    expect(
      describeComputerStall({ id: "a-2", cause: "busy", durationMs: 7_000, agoMs: 0 }, here),
    ).toEqual({
      title: "Threadlines froze for 7s",
      description: "It was busy with its own work, so it couldn't answer.",
    });
    expect(
      describeComputerStall({ id: "a-3", cause: "unknown", durationMs: 95_000, agoMs: 0 }, macMini),
    ).toEqual({
      title: "Threadlines on Mac mini stopped answering for 2 min",
      description: "It's answering again.",
    });
  });
});

describe("a received stall", () => {
  it("is timed on this app's clock and fades after ten minutes", () => {
    const received = receiveComputerStall(
      { id: "a-6", cause: "busy", durationMs: 6_000, agoMs: 90_000 },
      1_000_000,
    );
    expect(received.endedAtMs).toBe(910_000);
    expect(describeComputerStallNote(received, 1_000_000)).toBe("Froze 1 min ago");
    expect(isComputerStallRecent(received, 910_000 + COMPUTER_STALL_RECENT_MS)).toBe(true);
    expect(isComputerStallRecent(received, 910_001 + COMPUTER_STALL_RECENT_MS)).toBe(false);
    // This device's clock set back an hour: an old freeze is not a new one.
    expect(isComputerStallRecent(received, 910_000 - 3_600_000)).toBe(false);
  });

  it("formats how long it lasted", () => {
    expect(formatStallDuration(400)).toBe("1s");
    expect(formatStallDuration(59_400)).toBe("59s");
    expect(formatStallDuration(3_600_000)).toBe("1 hour");
    expect(formatStallDuration(3 * 86_400_000)).toBe("3 days");
  });
});
