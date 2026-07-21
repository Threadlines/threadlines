import { describe, expect, it } from "vite-plus/test";

import { formatGoalElapsed, formatGoalTokensCompact } from "./ComposerGoalBar";

describe("formatGoalTokensCompact", () => {
  it("keeps small counts verbatim and compacts thousands and millions", () => {
    expect(formatGoalTokensCompact(0)).toBe("0");
    expect(formatGoalTokensCompact(950)).toBe("950");
    expect(formatGoalTokensCompact(1_200)).toBe("1.2k");
    expect(formatGoalTokensCompact(48_500)).toBe("49k");
    expect(formatGoalTokensCompact(1_250_000)).toBe("1.3M");
    expect(formatGoalTokensCompact(12_000_000)).toBe("12M");
  });
});

describe("formatGoalElapsed", () => {
  it("scales seconds through minutes to hours", () => {
    expect(formatGoalElapsed(42)).toBe("42s");
    expect(formatGoalElapsed(90)).toBe("1m");
    expect(formatGoalElapsed(3_600)).toBe("1h 0m");
    expect(formatGoalElapsed(11_520)).toBe("3h 12m");
  });
});
